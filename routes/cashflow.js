/**
 * routes/cashflow.js
 * ════════════════════════════════════════════════════════════
 * Cashflow-modul — admin-only pengestrøms-overblik.
 *
 * POST /api/cashflow/upload            — CSV-upload (Bankdata-format)
 * GET  /api/cashflow/transactions      — Transaktioner med filtre
 * GET  /api/cashflow/invoices          — Fakturaliste med tabs
 * POST /api/cashflow/invoices          — Opret faktura
 * PATCH /api/cashflow/invoices/:id     — Opdater faktura
 * DELETE /api/cashflow/invoices/:id    — Slet faktura
 * GET  /api/cashflow/stats             — Aggregerede nøgletal
 * GET  /api/cashflow/weekly            — 8-ugers chart-data
 * POST /api/cashflow/match/:txId       — Manuel match
 * DELETE /api/cashflow/match/:txId     — Fjern match
 * GET  /api/cashflow/analyse           — YTD + heatmap data
 * GET  /api/cashflow/payment-behavior  — Betalingsadfærd per kunde
 * ════════════════════════════════════════════════════════════
 */

const express       = require('express');
const router        = express.Router();
const Busboy        = require('busboy');
const { getDb }     = require('../db/database');
const { handle, inclToExcl, momsOfIncl } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');

/** Round to 2 decimals */
function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

// Admin-only
router.use(requireAuth('admin'));

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Decode bank-CSV buffer til streng.
 * Nykredit/Fælles Kassen leverer Windows-1252 (Ø/Æ/Å som single-byte 0xD8/0xC6/0xC5).
 * Prøv UTF-8 først (med fatal: true) og fald tilbage til windows-1252 ved fejl.
 */
function decodeCsvBuffer(buffer) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
        return new TextDecoder('windows-1252').decode(buffer);
    }
}

/** Parse Bankdata CSV: Dato;Tekst;Beløb;Saldo */
function parseCSV(buffer) {
    const text = decodeCsvBuffer(buffer);
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return [];

    // Find header — skip BOM
    const header = lines[0].replace(/^\uFEFF/, '').toLowerCase();
    const sep = header.includes('\t') ? '\t' : ';';
    const cols = header.split(sep).map(c => c.trim());

    const iDato  = cols.findIndex(c => c === 'dato' || c === 'date');
    const iTekst = cols.findIndex(c => c === 'tekst' || c === 'text');
    const iBeloeb = cols.findIndex(c => c.includes('bel') || c === 'amount');
    const iSaldo = cols.findIndex(c => c.includes('saldo') || c === 'balance');

    if (iDato < 0 || iTekst < 0 || iBeloeb < 0) return [];

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(sep);
        if (parts.length < 3) continue;

        const rawDato = (parts[iDato] || '').trim();
        const tekst   = (parts[iTekst] || '').trim();
        const rawBel  = (parts[iBeloeb] || '').trim();
        const rawSaldo = iSaldo >= 0 ? (parts[iSaldo] || '').trim() : null;

        if (!rawDato || !tekst || !rawBel) continue;

        // Parse dato: dd-mm-yyyy or dd/mm/yyyy or yyyy-mm-dd
        let dato;
        const dmMatch = rawDato.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})$/);
        if (dmMatch) {
            dato = `${dmMatch[3]}-${dmMatch[2].padStart(2, '0')}-${dmMatch[1].padStart(2, '0')}`;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(rawDato)) {
            dato = rawDato;
        } else {
            continue; // skip unparseable
        }

        // Parse beløb: "1.234,56" → 1234.56
        const beloeb = parseFloat(rawBel.replace(/\./g, '').replace(',', '.'));
        if (isNaN(beloeb)) continue;

        let saldo = null;
        if (rawSaldo) {
            saldo = parseFloat(rawSaldo.replace(/\./g, '').replace(',', '.'));
            if (isNaN(saldo)) saldo = null;
        }

        rows.push({ dato, tekst, beloeb, saldo });
    }
    return rows;
}

/** Hent match-tolerance-settings (relativ % + absolut max ekstra over faktura) */
function getMatchTolerance(db) {
    const pctRow = db.prepare(`SELECT value FROM settings WHERE key = 'cf_match_relative_tolerance_pct'`).get();
    const extraRow = db.prepare(`SELECT value FROM settings WHERE key = 'cf_match_extra_tolerance_max'`).get();
    const pct = parseFloat(pctRow?.value);
    const extra = parseFloat(extraRow?.value);
    return {
        relativePct: Number.isFinite(pct) && pct >= 0 ? pct : 2.0,
        extraMax: Number.isFinite(extra) && extra >= 0 ? extra : 350,
    };
}

/** Run match logic on unmatched transactions */
function runMatchLogic(db) {
    const unmatched = db.prepare(`
        SELECT id, dato, tekst, beloeb FROM cf_transactions
        WHERE matched_invoice_id IS NULL
    `).all();

    const invoices = db.prepare(`
        SELECT id, beloeb, forfald FROM cf_invoices WHERE betalt = 0
    `).all();

    const { relativePct, extraMax } = getMatchTolerance(db);
    const relativeRatio = relativePct / 100;

    let matched = 0;
    const updateTx = db.prepare(`
        UPDATE cf_transactions SET matched_invoice_id = ?, match_confidence = ?
        WHERE id = ?
    `);
    const markPaid = db.prepare(`
        UPDATE cf_invoices SET betalt = 1, betalt_dato = ? WHERE id = ?
    `);

    for (const tx of unmatched) {
        if (tx.beloeb <= 0) continue; // only match positive (incoming)

        let bestMatch = null;
        let bestConf = 0;

        for (const inv of invoices) {
            const diff = tx.beloeb - inv.beloeb;
            const absDiff = Math.abs(diff);
            const ratio = absDiff / Math.abs(inv.beloeb);
            const withinRelative = ratio <= relativeRatio;
            // Asymmetrisk ekstra-tolerance: bank-amount må være OP TIL +extraMax
            // kr højere end faktura (miljøgebyr + variabel levering lægges til),
            // men ikke lavere. Bank > faktura er forventet, bank < faktura er ikke.
            const withinExtraAbove = diff > 0 && diff <= extraMax;
            if (!withinRelative && !withinExtraAbove) continue;

            // Check for invoice number in text
            const nums = tx.tekst.match(/\d{4,}/g) || [];
            const hasInvNr = nums.some(n => n === inv.id);

            // Days between tx and due date
            const txDate = new Date(tx.dato);
            const dueDate = new Date(inv.forfald);
            const daysDiff = Math.abs((txDate - dueDate) / 86400000);

            let conf = 0;
            if (hasInvNr) {
                conf = 95;
            } else if (daysDiff <= 5) {
                conf = withinRelative ? 80 : 70;
            } else if (daysDiff <= 14) {
                conf = withinRelative ? 55 : 50;
            } else {
                conf = 40;
            }

            if (conf > bestConf) {
                bestConf = conf;
                bestMatch = inv.id;
            }
        }

        if (bestMatch && bestConf > 0) {
            updateTx.run(bestMatch, bestConf, tx.id);
            if (bestConf >= 70) {
                markPaid.run(tx.dato, bestMatch);
                // Remove from invoice pool
                const idx = invoices.findIndex(i => i.id === bestMatch);
                if (idx >= 0) invoices.splice(idx, 1);
            }
            matched++;
        }
    }
    return matched;
}

// ─── POST /upload — CSV upload ──────────────────────────────

router.post('/upload', (req, res) => {
    const bb = Busboy({
        headers: req.headers,
        limits: { fileSize: 5 * 1024 * 1024, files: 1 }
    });

    let fileBuffer = null;
    let fileError = null;

    bb.on('file', (name, stream, info) => {
        const chunks = [];
        let truncated = false;

        stream.on('data', chunk => chunks.push(chunk));
        stream.on('limit', () => { truncated = true; });
        stream.on('end', () => {
            if (truncated) {
                fileError = 'Fil for stor (max 5 MB)';
            } else {
                fileBuffer = Buffer.concat(chunks);
            }
        });
    });

    bb.on('close', () => {
        if (fileError) return res.status(400).json({ error: fileError });
        if (!fileBuffer) return res.status(400).json({ error: 'Ingen fil uploadet' });

        const rows = parseCSV(fileBuffer);
        if (rows.length === 0) {
            return res.status(400).json({ error: 'Ingen gyldige rækker fundet. Forventet format: Dato;Tekst;Beløb;Saldo' });
        }

        const db = getDb();
        const insert = db.prepare(`
            INSERT OR IGNORE INTO cf_transactions (dato, tekst, beloeb, saldo)
            VALUES (?, ?, ?, ?)
        `);

        let inserted = 0;
        for (const r of rows) {
            const info = insert.run(r.dato, r.tekst, r.beloeb, r.saldo);
            if (info.changes > 0) inserted++;
        }

        // Update last_upload_at
        db.prepare(`INSERT OR REPLACE INTO cf_meta (key, value) VALUES ('last_upload_at', ?)`)
            .run(new Date().toISOString());

        // Run match logic
        const matched = runMatchLogic(db);

        res.json({
            total_rows: rows.length,
            inserted,
            duplicates: rows.length - inserted,
            matched
        });
    });

    bb.on('error', () => res.status(400).json({ error: 'Fejl ved upload' }));
    req.pipe(bb);
});

// ─── GET /transactions ──────────────────────────────────────

router.get('/transactions', handle(async (req, res) => {
    const db = getDb();
    const { from, to, unmatched, limit = '200', offset = '0' } = req.query;

    let where = '1=1';
    const params = [];

    if (from) { where += ' AND t.dato >= ?'; params.push(from); }
    if (to)   { where += ' AND t.dato <= ?'; params.push(to); }
    if (unmatched === '1') {
        where += ' AND t.matched_invoice_id IS NULL AND t.beloeb > 0';
    }

    const rows = db.prepare(`
        SELECT t.*, i.kunde AS matched_kunde
        FROM cf_transactions t
        LEFT JOIN cf_invoices i ON t.matched_invoice_id = i.id
        WHERE ${where}
        ORDER BY t.dato DESC, t.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    const total = db.prepare(`
        SELECT COUNT(*) AS cnt FROM cf_transactions t WHERE ${where}
    `).get(...params);

    res.json({ rows, total: total.cnt });
}));

// ─── GET /invoices ──────────────────────────────────────────

router.get('/invoices', handle(async (req, res) => {
    const db = getDb();
    const { tab = 'alle', limit = '200', offset = '0' } = req.query;

    let where = '1=1';
    const today = new Date().toISOString().slice(0, 10);

    switch (tab) {
        case 'udestaaende':
            where = 'betalt = 0 AND forfald >= ?';
            break;
        case 'forfaldne':
            where = 'betalt = 0 AND forfald < ?';
            break;
        case 'sandsynlig':
            where = `betalt = 0 AND id IN (
                SELECT matched_invoice_id FROM cf_transactions
                WHERE matched_invoice_id IS NOT NULL AND match_confidence >= 70
            )`;
            break;
        case 'betalt':
            where = 'betalt = 1';
            break;
    }

    const params = [];
    if (tab === 'udestaaende' || tab === 'forfaldne') params.push(today);

    const rows = db.prepare(`
        SELECT * FROM cf_invoices
        WHERE ${where}
        ORDER BY forfald ASC
        LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    // Tab-summaries i ét kald, så frontenden kan vise count + sum
    // på hver tab-knap og som footer på den aktive liste.
    const summary = db.prepare(`
        SELECT
            COUNT(*) AS alle_count,
            COALESCE(SUM(beloeb), 0) AS alle_total,
            SUM(CASE WHEN betalt = 0 AND forfald >= ? THEN 1 ELSE 0 END) AS udestaaende_count,
            COALESCE(SUM(CASE WHEN betalt = 0 AND forfald >= ? THEN beloeb ELSE 0 END), 0) AS udestaaende_total,
            SUM(CASE WHEN betalt = 0 AND forfald < ? THEN 1 ELSE 0 END) AS forfaldne_count,
            COALESCE(SUM(CASE WHEN betalt = 0 AND forfald < ? THEN beloeb ELSE 0 END), 0) AS forfaldne_total,
            SUM(CASE WHEN betalt = 1 THEN 1 ELSE 0 END) AS betalt_count,
            COALESCE(SUM(CASE WHEN betalt = 1 THEN beloeb ELSE 0 END), 0) AS betalt_total
        FROM cf_invoices
    `).get(today, today, today, today);

    const sandsynlig = db.prepare(`
        SELECT COUNT(*) AS cnt, COALESCE(SUM(beloeb), 0) AS total
        FROM cf_invoices
        WHERE betalt = 0
          AND id IN (
              SELECT matched_invoice_id FROM cf_transactions
              WHERE matched_invoice_id IS NOT NULL AND match_confidence > 0
          )
    `).get();

    res.json({
        rows,
        summary: {
            alle:        { count: summary.alle_count,        total: summary.alle_total },
            udestaaende: { count: summary.udestaaende_count, total: summary.udestaaende_total },
            forfaldne:   { count: summary.forfaldne_count,   total: summary.forfaldne_total },
            sandsynlig:  { count: sandsynlig.cnt,            total: sandsynlig.total },
            betalt:      { count: summary.betalt_count,      total: summary.betalt_total },
        }
    });
}));

// ─── POST /invoices — Opret faktura ────────────────────────

router.post('/invoices', handle(async (req, res) => {
    const db = getDb();
    const { id, kunde, beloeb, forfald, betalingstype, noter } = req.body;

    if (!id || !kunde || beloeb == null || !forfald) {
        return res.status(400).json({ error: 'Mangler påkrævede felter: id, kunde, beloeb, forfald' });
    }

    // Check duplicate
    const existing = db.prepare('SELECT id FROM cf_invoices WHERE id = ?').get(id);
    if (existing) return res.status(409).json({ error: `Faktura ${id} eksisterer allerede` });

    db.prepare(`
        INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalingstype, noter)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, kunde, parseFloat(beloeb), forfald, betalingstype || null, noter || null);

    // Re-run match logic for new invoice
    runMatchLogic(db);

    res.json({ ok: true, id });
}));

// ─── PATCH /invoices/:id — Opdater faktura ──────────────────

router.patch('/invoices/:id', handle(async (req, res) => {
    const db = getDb();
    const inv = db.prepare('SELECT * FROM cf_invoices WHERE id = ?').get(req.params.id);
    if (!inv) return res.status(404).json({ error: 'Faktura ikke fundet' });

    const { kunde, beloeb, forfald, betalt, betalingstype, noter, betalt_dato } = req.body;

    const sets = [];
    const vals = [];

    if (kunde !== undefined)        { sets.push('kunde = ?');        vals.push(kunde); }
    if (beloeb !== undefined)       { sets.push('beloeb = ?');       vals.push(parseFloat(beloeb)); }
    if (forfald !== undefined)      { sets.push('forfald = ?');      vals.push(forfald); }
    if (betalt !== undefined)       { sets.push('betalt = ?');       vals.push(betalt ? 1 : 0); }
    if (betalt_dato !== undefined)  { sets.push('betalt_dato = ?');  vals.push(betalt_dato); }
    if (betalingstype !== undefined) { sets.push('betalingstype = ?'); vals.push(betalingstype); }
    if (noter !== undefined)        { sets.push('noter = ?');        vals.push(noter); }

    if (sets.length === 0) return res.json({ ok: true });

    vals.push(req.params.id);
    db.prepare(`UPDATE cf_invoices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    res.json({ ok: true });
}));

// ─── DELETE /invoices/:id ───────────────────────────────────

router.delete('/invoices/:id', handle(async (req, res) => {
    const db = getDb();

    // Clear matches first
    db.prepare(`
        UPDATE cf_transactions SET matched_invoice_id = NULL, match_confidence = 0
        WHERE matched_invoice_id = ?
    `).run(req.params.id);

    db.prepare('DELETE FROM cf_invoices WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
}));

// ─── GET /stats — Aggregerede nøgletal ──────────────────────

router.get('/stats', handle(async (req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);

    // Latest saldo
    const latestTx = db.prepare(`
        SELECT saldo FROM cf_transactions WHERE saldo IS NOT NULL
        ORDER BY dato DESC, id DESC LIMIT 1
    `).get();

    // Outstanding invoices
    const outstanding = db.prepare(`
        SELECT COALESCE(SUM(beloeb), 0) AS total, COUNT(*) AS count
        FROM cf_invoices WHERE betalt = 0
    `).get();

    // Overdue
    const overdue = db.prepare(`
        SELECT COALESCE(SUM(beloeb), 0) AS total, COUNT(*) AS count
        FROM cf_invoices WHERE betalt = 0 AND forfald < ?
    `).get(today);

    // Expected in 30 days
    const expected30 = db.prepare(`
        SELECT COALESCE(SUM(beloeb), 0) AS total, COUNT(*) AS count
        FROM cf_invoices WHERE betalt = 0 AND forfald <= ?
    `).get(in30);

    // Last upload
    const lastUpload = db.prepare(`SELECT value FROM cf_meta WHERE key = 'last_upload_at'`).get();

    // Unmatched count
    const unmatchedCount = db.prepare(`
        SELECT COUNT(*) AS cnt FROM cf_transactions
        WHERE matched_invoice_id IS NULL AND beloeb > 0
    `).get();

    // Cashflow-konvention: faktiske bankbevægelser er incl. moms.
    // Vi udstiller incl-moms-totaler som primær — plus heraf moms-forpligtelse
    // og ex-moms-tal (disponibelt for drift). Se BON_V2_PRINCIPPER.md sektion 6c.
    res.json({
        saldo: latestTx?.saldo ?? null,
        // Udestående fakturaer — kundens fakturabeløb (incl moms)
        outstanding_total: outstanding.total,
        outstanding_total_incl_moms: outstanding.total,
        outstanding_total_excl_moms: r2(inclToExcl(outstanding.total)),
        outstanding_vat_liability:   r2(momsOfIncl(outstanding.total)),
        outstanding_count: outstanding.count,
        overdue_total: overdue.total,
        overdue_total_incl_moms: overdue.total,
        overdue_total_excl_moms: r2(inclToExcl(overdue.total)),
        overdue_count: overdue.count,
        expected_30d_total: expected30.total,
        expected_30d_total_incl_moms: expected30.total,
        expected_30d_total_excl_moms: r2(inclToExcl(expected30.total)),
        expected_30d_vat_liability:   r2(momsOfIncl(expected30.total)),
        expected_30d_count: expected30.count,
        last_upload: lastUpload?.value ?? null,
        unmatched_count: unmatchedCount.cnt
    });
}));

// ─── GET /weekly — 8-ugers chart data ──────────────────────

router.get('/weekly', handle(async (req, res) => {
    const db = getDb();
    const today = new Date();
    const weeks = [];

    for (let w = -2; w < 6; w++) {
        const weekStart = new Date(today);
        weekStart.setDate(today.getDate() - today.getDay() + 1 + w * 7);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekStart.getDate() + 6);

        const from = weekStart.toISOString().slice(0, 10);
        const to   = weekEnd.toISOString().slice(0, 10);

        // ISO week number
        const jan1 = new Date(weekStart.getFullYear(), 0, 1);
        const weekNum = Math.ceil(((weekStart - jan1) / 86400000 + jan1.getDay() + 1) / 7);

        // Received = matched transactions in this week
        const received = db.prepare(`
            SELECT COALESCE(SUM(beloeb), 0) AS total
            FROM cf_transactions
            WHERE dato BETWEEN ? AND ? AND beloeb > 0 AND match_confidence >= 70
        `).get(from, to);

        // Expected = invoices due this week, not yet paid
        const expected = db.prepare(`
            SELECT COALESCE(SUM(beloeb), 0) AS total
            FROM cf_invoices
            WHERE forfald BETWEEN ? AND ? AND betalt = 0
        `).get(from, to);

        // Overdue = invoices that were due before this week's start and still unpaid
        const overdue = w <= 0 ? db.prepare(`
            SELECT COALESCE(SUM(beloeb), 0) AS total
            FROM cf_invoices
            WHERE forfald < ? AND betalt = 0
        `).get(from) : { total: 0 };

        weeks.push({
            label: `Uge ${weekNum}`,
            from, to,
            received: received.total,
            expected: expected.total,
            overdue: overdue.total
        });
    }

    res.json({ weeks });
}));

// ─── POST /match/:txId — Manuel match ──────────────────────

router.post('/match/:txId', handle(async (req, res) => {
    const db = getDb();
    const { invoice_id } = req.body;

    if (!invoice_id) return res.status(400).json({ error: 'Mangler invoice_id' });

    const tx = db.prepare('SELECT * FROM cf_transactions WHERE id = ?').get(req.params.txId);
    if (!tx) return res.status(404).json({ error: 'Transaktion ikke fundet' });

    db.prepare(`
        UPDATE cf_transactions SET matched_invoice_id = ?, match_confidence = 100
        WHERE id = ?
    `).run(invoice_id, req.params.txId);

    db.prepare(`
        UPDATE cf_invoices SET betalt = 1, betalt_dato = ? WHERE id = ?
    `).run(tx.dato, invoice_id);

    res.json({ ok: true });
}));

// ─── DELETE /match/:txId — Fjern match ──────────────────────

router.delete('/match/:txId', handle(async (req, res) => {
    const db = getDb();

    const tx = db.prepare('SELECT * FROM cf_transactions WHERE id = ?').get(req.params.txId);
    if (!tx) return res.status(404).json({ error: 'Transaktion ikke fundet' });

    if (tx.matched_invoice_id) {
        db.prepare(`UPDATE cf_invoices SET betalt = 0, betalt_dato = NULL WHERE id = ?`)
            .run(tx.matched_invoice_id);
    }

    db.prepare(`
        UPDATE cf_transactions SET matched_invoice_id = NULL, match_confidence = 0
        WHERE id = ?
    `).run(req.params.txId);

    res.json({ ok: true });
}));

// ─── GET /analyse — YTD + heatmap fra bons-data ────────────

router.get('/analyse', handle(async (req, res) => {
    const db = getDb();
    const thisYear = new Date().getFullYear();

    // Revenue by month for 3 years (cumulative YTD)
    const years = {};
    for (let y = thisYear - 2; y <= thisYear; y++) {
        const monthly = db.prepare(`
            SELECT
                CAST(strftime('%m', b.delivery_date) AS INTEGER) AS month,
                COALESCE(SUM(bl.quantity * bl.unit_price), 0) AS revenue
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            JOIN bon_lines bl ON bl.bon_id = b.id
            WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
              AND strftime('%Y', b.delivery_date) = ?
              AND COALESCE(b.is_offer, 0) = 0
              AND COALESCE(b.is_internal, 0) = 0
            GROUP BY month
            ORDER BY month
        `).all(String(y));

        // Build cumulative array (12 months) — convert incl→ex moms (regnskabskonvention)
        const cumul = new Array(12).fill(null);
        let running = 0;
        for (const m of monthly) {
            running += inclToExcl(m.revenue);
            cumul[m.month - 1] = Math.round(running / 1000); // i tusinder
        }
        // Fill forward (cumulative stays at last value)
        for (let i = 1; i < 12; i++) {
            if (cumul[i] === null && cumul[i - 1] !== null) {
                // Only fill if month has passed
                const monthDate = new Date(y, i, 1);
                if (monthDate <= new Date()) {
                    cumul[i] = cumul[i - 1];
                }
            }
        }
        years[y] = cumul;
    }

    // Heatmap: monthly relative performance (0-100)
    const heatmap = {};
    for (let y = thisYear - 1; y <= thisYear; y++) {
        const monthly = db.prepare(`
            SELECT
                CAST(strftime('%m', b.delivery_date) AS INTEGER) AS month,
                COALESCE(SUM(bl.quantity * bl.unit_price), 0) AS revenue
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            JOIN bon_lines bl ON bl.bon_id = b.id
            WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
              AND strftime('%Y', b.delivery_date) = ?
              AND COALESCE(b.is_offer, 0) = 0
              AND COALESCE(b.is_internal, 0) = 0
            GROUP BY month
        `).all(String(y));

        const vals = new Array(12).fill(null);
        const revArr = monthly.map(m => inclToExcl(m.revenue));
        const avg = revArr.length > 0 ? revArr.reduce((a, b) => a + b, 0) / revArr.length : 1;

        for (const m of monthly) {
            vals[m.month - 1] = Math.round(Math.min(100, (inclToExcl(m.revenue) / avg) * 50));
        }
        heatmap[y] = vals;
    }

    // Pax segments by period (monthly, last 8 months)
    const paxMonths = [];
    for (let i = 7; i >= 0; i--) {
        const d = new Date(thisYear, new Date().getMonth() - i, 1);
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        const from = `${y}-${String(m).padStart(2, '0')}-01`;
        const toD = new Date(y, m, 0);
        const to = `${y}-${String(m).padStart(2, '0')}-${String(toD.getDate()).padStart(2, '0')}`;

        const segments = db.prepare(`
            SELECT
                CASE
                    WHEN b.price_category = 'festival' THEN 'festival'
                    WHEN COALESCE(b.pax, 0) >= 150 THEN 'xl'
                    WHEN COALESCE(b.pax, 0) >= 70 THEN 'lg'
                    WHEN COALESCE(b.pax, 0) >= 20 THEN 'md'
                    ELSE 'sm'
                END AS seg,
                COALESCE(SUM(bl.quantity * bl.unit_price), 0) AS revenue,
                COUNT(DISTINCT b.id) AS orders
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            LEFT JOIN bon_lines bl ON bl.bon_id = b.id
            WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
              AND b.delivery_date BETWEEN ? AND ?
              AND COALESCE(b.is_offer, 0) = 0
              AND COALESCE(b.is_internal, 0) = 0
            GROUP BY seg
        `).all(from, to);

        const MONTHS = ['Jan','Feb','Mar','Apr','Maj','Jun','Jul','Aug','Sep','Okt','Nov','Dec'];
        const rev = { sm: 0, md: 0, lg: 0, xl: 0, festival: 0 };
        const ord = { sm: 0, md: 0, lg: 0, xl: 0, festival: 0 };
        for (const s of segments) {
            rev[s.seg] = r2(inclToExcl(s.revenue));
            ord[s.seg] = s.orders;
        }

        paxMonths.push({ label: `${MONTHS[m - 1]} ${y === thisYear ? '' : y}`.trim(), rev, ord });
    }

    // Same for previous year (reference)
    const paxMonthsRef = [];
    for (let i = 7; i >= 0; i--) {
        const d = new Date(thisYear - 1, new Date().getMonth() - i, 1);
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        const from = `${y}-${String(m).padStart(2, '0')}-01`;
        const toD = new Date(y, m, 0);
        const to = `${y}-${String(m).padStart(2, '0')}-${String(toD.getDate()).padStart(2, '0')}`;

        const segments = db.prepare(`
            SELECT
                CASE
                    WHEN b.price_category = 'festival' THEN 'festival'
                    WHEN COALESCE(b.pax, 0) >= 150 THEN 'xl'
                    WHEN COALESCE(b.pax, 0) >= 70 THEN 'lg'
                    WHEN COALESCE(b.pax, 0) >= 20 THEN 'md'
                    ELSE 'sm'
                END AS seg,
                COALESCE(SUM(bl.quantity * bl.unit_price), 0) AS revenue,
                COUNT(DISTINCT b.id) AS orders
            FROM bons b
            JOIN status_definitions sd ON b.status_id = sd.id
            LEFT JOIN bon_lines bl ON bl.bon_id = b.id
            WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
              AND b.delivery_date BETWEEN ? AND ?
              AND COALESCE(b.is_offer, 0) = 0
              AND COALESCE(b.is_internal, 0) = 0
            GROUP BY seg
        `).all(from, to);

        const rev = { sm: 0, md: 0, lg: 0, xl: 0, festival: 0 };
        const ord = { sm: 0, md: 0, lg: 0, xl: 0, festival: 0 };
        for (const s of segments) {
            rev[s.seg] = r2(inclToExcl(s.revenue));
            ord[s.seg] = s.orders;
        }

        paxMonthsRef.push({ rev, ord });
    }

    // Sandwich rate
    const sandwichRate = db.prepare(`SELECT value FROM cf_meta WHERE key = 'sandwich_rate'`).get();

    res.json({
        ytd: years,
        heatmap,
        pax: { months: paxMonths, monthsRef: paxMonthsRef },
        sandwich_rate: parseFloat(sandwichRate?.value) || 45
    });
}));

// ─── GET /payment-behavior — Betalingsadfærd per kunde ─────

router.get('/payment-behavior', handle(async (req, res) => {
    const db = getDb();

    const rows = db.prepare(`
        SELECT
            i.kunde,
            AVG(JULIANDAY(t.dato) - JULIANDAY(i.forfald)) AS avg_days_late,
            COUNT(*) AS invoice_count
        FROM cf_invoices i
        JOIN cf_transactions t ON t.matched_invoice_id = i.id AND t.match_confidence >= 70
        WHERE i.betalt = 1
        GROUP BY i.kunde
        HAVING COUNT(*) >= 1
        ORDER BY avg_days_late DESC
        LIMIT 15
    `).all();

    res.json({
        customers: rows.map(r => ({
            name: r.kunde,
            avg_days: Math.round(r.avg_days_late * 10) / 10,
            count: r.invoice_count,
            color: r.avg_days_late <= 0 ? 'green' : r.avg_days_late <= 14 ? 'orange' : 'red'
        }))
    });
}));

// ─── GET /upcoming — Forfalder snart ────────────────────────

router.get('/upcoming', handle(async (req, res) => {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

    const rows = db.prepare(`
        SELECT * FROM cf_invoices
        WHERE betalt = 0 AND forfald BETWEEN ? AND ?
        ORDER BY forfald ASC
        LIMIT 10
    `).all(today, in14);

    res.json({ rows });
}));

module.exports = router;
