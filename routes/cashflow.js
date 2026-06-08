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
 * GET  /api/cashflow/suggest-matches   — Forslag: forfaldne ↔ umatchede bankposteringer
 * POST /api/cashflow/invoices/:id/confirm-paid  — Bekræft som betalt (sync bon-status)
 * POST /api/cashflow/invoices/:id/reject-match  — Forkast match (fakturaen tilbage til forfaldne)
 * POST /api/cashflow/invoices/bulk-confirm-paid — Bulk-bekræft forfaldne ældre end N dage
 * GET  /api/cashflow/analyse           — YTD + heatmap data
 * GET  /api/cashflow/payment-behavior  — Betalingsadfærd per kunde
 * ════════════════════════════════════════════════════════════
 */

const express       = require('express');
const router        = express.Router();
const Busboy        = require('busboy');
const { getDb }     = require('../db/database');
const { handle, inclToExcl, momsOfIncl, logChange, todayISO, offsetISO } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');
const { transaction } = require('../db/compat');

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

        // Confidence-cutoff:
        //   conf=40 = "samme beløb-størrelse, dage-diff > 14" — ren støj,
        //   registrér ikke (det forurener "Sandsynlig betalt"-listen og
        //   forhindrer korrekt re-matching mod nyere bankposteringer).
        //   conf 50-69 = sandsynlig-zone, registrér men marker ikke betalt.
        //   conf >= 70 = auto-mark betalt.
        if (bestMatch && bestConf >= 50) {
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
        where += ' AND t.matched_invoice_id IS NULL AND t.beloeb > 0 AND t.ignored = 0';
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
    const today = todayISO();

    // Kolonner kvalificeres med i.* (cf_invoices) for at undgå ambiguity
    // når vi LEFT JOIN'er bons (b.id) og status_definitions nedenfor.
    switch (tab) {
        case 'udestaaende':
            where = 'i.betalt = 0 AND i.forfald >= ?';
            break;
        case 'forfaldne':
            where = 'i.betalt = 0 AND i.forfald < ?';
            break;
        case 'sandsynlig':
            // Alle ubetalte fakturaer med et bank-match (any confidence).
            // Matcher summary-tælleren på linje 352 så tab og badge er enige.
            // Fakturaer med conf ≥ 70 markeres normalt automatisk betalt af
            // runMatchLogic, men kan også havne her hvis de blev manuelt
            // un-mark'et senere — også de skal kunne ses og bekræftes.
            where = `i.betalt = 0 AND i.id IN (
                SELECT matched_invoice_id FROM cf_transactions
                WHERE matched_invoice_id IS NOT NULL AND match_confidence > 0
            )`;
            break;
        case 'betalt':
            where = 'i.betalt = 1';
            break;
    }

    const params = [];
    if (tab === 'udestaaende' || tab === 'forfaldne') params.push(today);

    const rows = db.prepare(`
        SELECT
            i.*,
            b.bon_number       AS bon_number,
            b.delivery_date    AS bon_delivery_date,
            sd.code            AS bon_status_code,
            sd.label           AS bon_status_label
        FROM cf_invoices i
        LEFT JOIN bons b              ON i.bon_id = b.id
        LEFT JOIN status_definitions sd ON b.status_id = sd.id
        WHERE ${where}
        ORDER BY i.forfald ASC
        LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    // N+1-undgåelse: hent ALLE matches for de viste fakturaer i ét bulk-kald
    // og fold dem ind på hver række. Tom for 'betalt'-tab (de er per definition
    // markeret betalt af et match med conf=100), men frontenden kan vise den
    // matchende tx alligevel for kontekst.
    if (rows.length > 0) {
        const invoiceIds = rows.map(r => r.id);
        const placeholders = invoiceIds.map(() => '?').join(',');
        const matches = db.prepare(`
            SELECT id, dato, tekst, beloeb, matched_invoice_id, match_confidence
            FROM cf_transactions
            WHERE matched_invoice_id IN (${placeholders})
            ORDER BY match_confidence DESC, dato DESC
        `).all(...invoiceIds);
        const byInvoice = new Map();
        for (const m of matches) {
            if (!byInvoice.has(m.matched_invoice_id)) byInvoice.set(m.matched_invoice_id, []);
            byInvoice.get(m.matched_invoice_id).push({
                tx_id: m.id,
                dato: m.dato,
                tekst: m.tekst,
                beloeb: m.beloeb,
                confidence: m.match_confidence
            });
        }
        for (const r of rows) {
            r.matches = byInvoice.get(r.id) || [];
        }
    }

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
    const today = todayISO();
    const in30 = offsetISO(30);

    // Bankindestående = saldo (løbende balance) på den NYESTE postering.
    // Bank-CSV'en er nyeste-først og indsættes i fil-rækkefølge, så inden for
    // den nyeste dato har den nyeste postering det LAVESTE id. Derfor id ASC
    // (ikke DESC — det gav den ÆLDSTE postering den dag → forkert/halv saldo).
    const latestTx = db.prepare(`
        SELECT saldo FROM cf_transactions WHERE saldo IS NOT NULL
        ORDER BY dato DESC, id ASC LIMIT 1
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

// ─── PATCH /transactions/:txId — Ignorér + note ──────────────
//
// Sætter `ignored` (skjuler posteringen fra "kan ikke matches"-listen) og/eller
// `note` (fri tekst). Bruges til afvisninger/overførsler/gebyrer der aldrig får
// en faktura. Begge felter er valgfrie — kun de medsendte opdateres.

router.patch('/transactions/:txId', handle(async (req, res) => {
    const db = getDb();

    const tx = db.prepare('SELECT * FROM cf_transactions WHERE id = ?').get(req.params.txId);
    if (!tx) return res.status(404).json({ error: 'Transaktion ikke fundet' });

    const sets = [];
    const params = [];
    if (req.body.ignored !== undefined) {
        sets.push('ignored = ?');
        params.push(req.body.ignored ? 1 : 0);
    }
    if (req.body.note !== undefined) {
        sets.push('note = ?');
        params.push(req.body.note === null ? null : String(req.body.note).trim() || null);
    }

    if (sets.length === 0) return res.status(400).json({ error: 'Intet at opdatere' });

    params.push(req.params.txId);
    db.prepare(`UPDATE cf_transactions SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    res.json({ ok: true });
}));

// ─── GET /suggest-matches — Forslag til forfaldne fakturaer ──────────────
//
// For hver FORFALDEN, ubetalt faktura: find den bedste umatchede, indgående
// bankpostering med et beløb der passer (samme asymmetriske tolerance som
// runMatchLogic). FORSKELLEN fra auto-matchet: ingen 14-dages dato-vinduescutoff
// — overskredne fakturaer er PER DEFINITION betalt sent (eller tidligt, men
// aldrig matchet), så det er præcis den hale auto-matchet kasserer som "støj".
//
// Resultatet hjælper kontoret med at dobbelttjekke forfaldne mod banken uden at
// have banken åben ved siden af. Greedy dedup: hver tx foreslås til højst én
// faktura (den med stærkest signal), så samme betaling ikke dukker op to gange.
//
// Returnerer { suggestions: { [invoice_id]: { tx_id, dato, tekst, beloeb,
// has_invoice_nr, amount_exact } } } — nøglet på faktura-id for nem opslag.

router.get('/suggest-matches', handle(async (req, res) => {
    const db = getDb();
    const today = todayISO();

    const overdue = db.prepare(`
        SELECT id, beloeb, forfald FROM cf_invoices
        WHERE betalt = 0 AND forfald < ?
        ORDER BY forfald ASC
    `).all(today);

    if (overdue.length === 0) return res.json({ suggestions: {} });

    const unmatched = db.prepare(`
        SELECT id, dato, tekst, beloeb FROM cf_transactions
        WHERE matched_invoice_id IS NULL AND beloeb > 0 AND COALESCE(ignored, 0) = 0
    `).all();

    const { relativePct, extraMax } = getMatchTolerance(db);
    const relativeRatio = relativePct / 100;
    const usedTx = new Set();
    const suggestions = {};

    // Forfald ASC → ældste (mest presserende) faktura får først lov at "tage"
    // en passende postering.
    for (const inv of overdue) {
        let best = null;
        let bestScore = -Infinity;

        for (const tx of unmatched) {
            if (usedTx.has(tx.id)) continue;

            const diff = tx.beloeb - inv.beloeb;
            const ratio = Math.abs(diff) / Math.abs(inv.beloeb);
            const withinRelative = ratio <= relativeRatio;
            const withinExtraAbove = diff > 0 && diff <= extraMax;
            if (!withinRelative && !withinExtraAbove) continue;

            const nums = (tx.tekst || '').match(/\d{4,}/g) || [];
            const hasInvNr = nums.some(n => n === String(inv.id));
            const amountExact = Math.abs(diff) < 0.01;
            const daysDiff = Math.abs(
                (new Date(tx.dato) - new Date(inv.forfald)) / 86400000
            );

            // Rangering: fakturanr i tekst > eksakt beløb > tættest på forfald.
            const score = (hasInvNr ? 100000 : 0)
                + (amountExact ? 10000 : 0)
                - daysDiff;

            if (score > bestScore) {
                bestScore = score;
                best = { tx, hasInvNr, amountExact };
            }
        }

        if (best) {
            usedTx.add(best.tx.id);
            suggestions[inv.id] = {
                tx_id: best.tx.id,
                dato: best.tx.dato,
                tekst: best.tx.tekst,
                beloeb: best.tx.beloeb,
                has_invoice_nr: best.hasInvNr,
                amount_exact: best.amountExact,
            };
        }
    }

    res.json({ suggestions });
}));

// ─── POST /invoices/:id/confirm-paid — Bekræft betalt + sync bon ──────────
//
// Bruges fra "Sandsynlig betalt"-fanen når brugeren har verificeret at
// bank-matchet er korrekt. Idempotent — kan kaldes flere gange.
//
// Effekter (alle i én transaction):
//   1. cf_invoices.betalt = 1, betalt_dato = i dag
//   2. Alle tilknyttede cf_transactions → match_confidence = 100
//   3. Hvis cf_invoices.bon_id er sat: bons.status_id → BETALT
//      + logChange + SSE broadcast (bon_status + bon_updated)
//
// Manuelt oprettede fakturaer (uden bon_id) opdaterer kun cashflow-tabellen.

router.post('/invoices/:id/confirm-paid', handle(async (req, res) => {
    const db = getDb();
    const invoiceId = req.params.id;
    const today = todayISO();

    const inv = db.prepare(`SELECT * FROM cf_invoices WHERE id = ?`).get(invoiceId);
    if (!inv) return res.status(404).json({ error: 'Faktura ikke fundet' });

    const result = transaction(db, () => {
        // 1. Marker faktura betalt (idempotent — overskriver evt. eksisterende dato).
        db.prepare(`
            UPDATE cf_invoices SET betalt = 1, betalt_dato = ? WHERE id = ?
        `).run(inv.betalt_dato || today, invoiceId);

        // 2. Boost alle tilknyttede tx'er til conf=100.
        db.prepare(`
            UPDATE cf_transactions SET match_confidence = 100
            WHERE matched_invoice_id = ?
        `).run(invoiceId);

        // 3. Sync bon-status hvis bon_id er sat og bonen ikke allerede er BETALT.
        let bonChanged = false;
        let bonStatusOld = null;
        if (inv.bon_id) {
            const bon = db.prepare(`
                SELECT b.id, sd.code AS status_code
                FROM bons b JOIN status_definitions sd ON b.status_id = sd.id
                WHERE b.id = ?
            `).get(inv.bon_id);

            if (bon && bon.status_code !== 'BETALT') {
                const betalt = db.prepare(`SELECT id FROM status_definitions WHERE code = 'BETALT'`).get();
                if (betalt) {
                    db.prepare(`
                        UPDATE bons SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
                    `).run(betalt.id, inv.bon_id);

                    logChange({
                        entityType: 'bon',
                        entityId: inv.bon_id,
                        action: 'status_change',
                        fieldName: 'status_id',
                        oldValue: bon.status_code,
                        newValue: 'BETALT',
                        userId: req.session?.userId ?? null,
                        wasForced: false
                    });

                    bonChanged = true;
                    bonStatusOld = bon.status_code;
                }
            }
        }

        return { bonChanged, bonStatusOld };
    });

    // SSE-broadcast efter commit så lyttere ikke ser stale data.
    if (result.bonChanged) {
        broadcast('bon_status', { id: inv.bon_id, old: result.bonStatusOld, new: 'BETALT' });
        broadcast('bon_updated', { id: inv.bon_id });
    }

    res.json({
        ok: true,
        invoice_id: invoiceId,
        bon_status_changed: result.bonChanged,
        bon_id: inv.bon_id ?? null
    });
}));

// ─── POST /invoices/:id/reject-match — Forkast match ──────────
//
// Bruges fra "Sandsynlig betalt"-fanen når brugeren har set at matchet
// IKKE er korrekt (samme beløb fra anden kunde, tilfældigt match osv.).
// Fakturaen forbliver ubetalt og falder ud af "Sandsynlig betalt".
// Bank-transaktionen flyttes tilbage i "umatchede"-poolen så den kan
// matches mod en anden faktura ved næste run.

router.post('/invoices/:id/reject-match', handle(async (req, res) => {
    const db = getDb();
    const invoiceId = req.params.id;

    const inv = db.prepare(`SELECT id FROM cf_invoices WHERE id = ?`).get(invoiceId);
    if (!inv) return res.status(404).json({ error: 'Faktura ikke fundet' });

    const result = db.prepare(`
        UPDATE cf_transactions SET matched_invoice_id = NULL, match_confidence = 0
        WHERE matched_invoice_id = ?
    `).run(invoiceId);

    res.json({ ok: true, invoice_id: invoiceId, matches_removed: result.changes });
}));

// ─── POST /invoices/bulk-confirm-paid — Marker mange forfaldne som betalt ───
//
// Bruges til at rydde bagudrettet: når Bon v2 ikke er synkroniseret med
// e-conomic, vil mange forfaldne fakturaer reelt være betalt. I stedet for
// 60 individuelle klik kan brugeren angive et alders-cutoff (fx 45 dage)
// og masseopdatere alle ældre fakturaer.
//
// Body: { older_than_days: N, dry_run: true|false }
//   - dry_run=true  → returnerer liste + sum uden at ændre noget
//   - dry_run=false → udfører + returnerer count + total + bon_sync_count
//
// For hver faktura: samme effekt som POST /invoices/:id/confirm-paid
//   - cf_invoices.betalt=1, betalt_dato=i dag
//   - Alle tilknyttede cf_transactions → match_confidence=100
//   - Hvis bon_id sat: bons.status_id→BETALT + changelog + SSE

router.post('/invoices/bulk-confirm-paid', handle(async (req, res) => {
    const db = getDb();
    const olderThanDays = parseInt(req.body?.older_than_days);
    const dryRun = req.body?.dry_run !== false;  // default true (sikrest)

    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
        return res.status(400).json({ error: 'older_than_days skal være ≥ 0' });
    }

    // Dansk kalenderdato N dage tilbage (UTC-slice ramte forkert dag nær midnat).
    const cutoffDate = offsetISO(-olderThanDays);

    // Find forfaldne fakturaer ældre end cutoff (forfald < cutoff_date)
    const candidates = db.prepare(`
        SELECT i.id, i.kunde, i.beloeb, i.forfald, i.bon_id,
               b.bon_number, sd.code AS bon_status_code
        FROM cf_invoices i
        LEFT JOIN bons b ON i.bon_id = b.id
        LEFT JOIN status_definitions sd ON b.status_id = sd.id
        WHERE i.betalt = 0 AND i.forfald < ?
        ORDER BY i.forfald ASC
    `).all(cutoffDate);

    const total = candidates.reduce((sum, c) => sum + (c.beloeb || 0), 0);

    if (dryRun) {
        return res.json({
            dry_run: true,
            cutoff_date: cutoffDate,
            count: candidates.length,
            total: total,
            invoices: candidates.map(c => ({
                id: c.id,
                kunde: c.kunde,
                beloeb: c.beloeb,
                forfald: c.forfald,
                bon_number: c.bon_number,
                has_bon: !!c.bon_id
            }))
        });
    }

    // Live-run: udfør i én transaction.
    const today = todayISO();
    const userId = req.session?.userId ?? null;
    const betaltStatus = db.prepare(`SELECT id FROM status_definitions WHERE code = 'BETALT'`).get();

    const result = transaction(db, () => {
        const markPaid = db.prepare(`
            UPDATE cf_invoices SET betalt = 1, betalt_dato = ?
            WHERE id = ? AND betalt = 0
        `);
        const boostMatches = db.prepare(`
            UPDATE cf_transactions SET match_confidence = 100
            WHERE matched_invoice_id = ?
        `);
        const updateBonStatus = db.prepare(`
            UPDATE bons SET status_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
        `);

        const bonsToBroadcast = [];
        let invoicesMarked = 0;
        let bonStatusChanged = 0;

        for (const c of candidates) {
            markPaid.run(today, c.id);
            invoicesMarked++;
            boostMatches.run(c.id);

            if (c.bon_id && c.bon_status_code && c.bon_status_code !== 'BETALT' && betaltStatus) {
                updateBonStatus.run(betaltStatus.id, c.bon_id);
                logChange({
                    entityType: 'bon',
                    entityId: c.bon_id,
                    action: 'status_change',
                    fieldName: 'status_id',
                    oldValue: c.bon_status_code,
                    newValue: 'BETALT',
                    userId: userId,
                    notes: `Bulk-bekræftet fra cashflow (>${olderThanDays} dage forfalden)`,
                    wasForced: false
                });
                bonsToBroadcast.push({ id: c.bon_id, old: c.bon_status_code });
                bonStatusChanged++;
            }
        }

        return { invoicesMarked, bonStatusChanged, bonsToBroadcast };
    });

    // SSE-broadcast efter commit.
    for (const b of result.bonsToBroadcast) {
        broadcast('bon_status', { id: b.id, old: b.old, new: 'BETALT' });
        broadcast('bon_updated', { id: b.id });
    }

    res.json({
        ok: true,
        dry_run: false,
        cutoff_date: cutoffDate,
        invoices_marked: result.invoicesMarked,
        bon_status_changed: result.bonStatusChanged,
        total: total
    });
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
    const today = todayISO();
    const in14 = offsetISO(14);

    const rows = db.prepare(`
        SELECT * FROM cf_invoices
        WHERE betalt = 0 AND forfald BETWEEN ? AND ?
        ORDER BY forfald ASC
        LIMIT 10
    `).all(today, in14);

    res.json({ rows });
}));

module.exports = router;
