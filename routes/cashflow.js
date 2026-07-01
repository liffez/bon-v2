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
const { handle, inclToExcl, momsOfIncl, logChange, todayISO, offsetISO,
        getStatusId, getDefaultLocationId, nextBonNumber, recalcBonTotalUnits } = require('../db/helpers');
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

        // Bankindestående: bank-CSV'en er nyeste-først, så den ØVERSTE række med
        // saldo er den aktuelle kontosaldo. Fang den eksplicit her (robust på tværs
        // af uploads — den gamle id-baserede heuristik brød pga. INSERT OR IGNORE,
        // der genbruger gamle id'er → fil-rækkefølgen kunne ikke udledes fra id).
        // Dato-guard: re-upload af et ÆLDRE kontoudtog må ikke rulle saldoen tilbage.
        const newestWithSaldo = rows.find(r => r.saldo != null);
        if (newestWithSaldo) {
            const prevDate = db.prepare(`SELECT value FROM cf_meta WHERE key = 'current_balance_date'`).get()?.value || '';
            if (!prevDate || newestWithSaldo.dato >= prevDate) {
                db.prepare(`INSERT OR REPLACE INTO cf_meta (key, value) VALUES ('current_balance', ?)`).run(String(newestWithSaldo.saldo));
                db.prepare(`INSERT OR REPLACE INTO cf_meta (key, value) VALUES ('current_balance_date', ?)`).run(newestWithSaldo.dato);
            }
        }

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

// Event-/direkte-salg-indbetalinger genkendes på bankteksten: de er ALDRIG
// faktura-afregnet i e-conomic (ingen bon at matche mod) og kræver at der laves
// en salgsbon. De løftes derfor OVER vandmærke-folden så de ikke begraves blandt
// de bogførte. Mønstret matcher t.tekst (LOWER). Udvid her hvis nye kanaler dukker op.
const EVENT_CASH_SQL = `(LOWER(t.tekst) LIKE '%zettle%' OR LOWER(t.tekst) LIKE '%mobilepay%' OR LOWER(t.tekst) LIKE '%kontant%' OR LOWER(t.tekst) LIKE '%vipps%')`;

// Kategorisering af "kan ikke matches"-listen (29. juni — Leifs model). Bankteksten +
// dato + beløb afgør om en postering KRÆVER en hånd, eller kan foldes som afregnet:
//   event_cash   — Zettle/MobilePay/kontant → kræver salgsbon (historik), ALLE år    → SURFACE 🎪
//   invoice_check— fakturanr i tekst, ÅBENT regnskabsår → tjek op mod e-conomic        → SURFACE 📄
//   large_check  — stort beløb UDEN fakturareference → muligt event uden bon           → SURFACE 🔍
//   invoice_paid — fakturanr i tekst, LUKKET regnskabsår → afregnet faktura            → FOLD
//   minor        — lille beløb, ingen reference → støj (typisk leverings-±)            → FOLD
// Lukket år + stor-grænse er settings (cf_accounts_closed_year, cf_check_large_threshold).
const FAKTURA_RE = /faktur|fakt|fak[\s.\-]|fa\.?nr|faknr|invoice/i;
/** Set af e-conomics bogførte fakturanumre (cf_economic_invoices) til genkendelse. */
function cfBookedSet(db) {
    try {
        return new Set(db.prepare('SELECT booked_no FROM cf_economic_invoices').all().map(r => String(r.booked_no)));
    } catch { return new Set(); }   // tabel findes evt. ikke endnu (før migration 119)
}
function cfCategorize(tx, closedYear, largeThreshold, bookedSet) {
    const t = String(tx.tekst || '');
    if (/zettle|mobilepay|vipps|kontant/i.test(t)) return 'event_cash';   // 🎪 alle år (historik-bon)
    const year = parseInt(String(tx.dato).slice(0, 4), 10) || 9999;
    const hasFaktura = FAKTURA_RE.test(t) || /^\s*\d{3,6}\s*$/.test(t);   // "FAKTURA 3957" / "Fa.nr. 3865" / bare "3898"
    if (hasFaktura) {
        // Findes nummeret som et RIGTIGT bogført e-conomic-fakturanr? → afregnet faktura → fold.
        // (Indbetalingen = fakturaens beløb, der kan dække flere bons — derfor genkender vi
        //  på fakturanummeret direkte, ikke på bon-beløbet.)
        if (bookedSet && bookedSet.size) {
            const nums = t.match(/\d{3,6}/g) || [];
            if (nums.some(n => bookedSet.has(n))) return 'invoice_paid';
        }
        // Ellers: lukket regnskabsår = afregnet (fold), åbent år = ÆGTE undtagelse → tjek
        // (nummer der ikke matcher nogen bogført faktura — fejl, kreditnota, fremtidig).
        return year <= closedYear ? 'invoice_paid' : 'invoice_check';
    }
    // INGEN fakturanr — inkl. "Overførsel"/kundenavn/"Leverandør". En sådan postering kan
    // godt VÆRE en faktura (overførsel uden nr), men også et event uden bon. Store beløb
    // løftes derfor til tjek UANSET år — også lukket 2025 ("SLUTAFREGNING RF25" = festival
    // der mangler en historik-bon). Småt foldes som støj (typisk leverings-±).
    if (Math.abs(tx.beloeb) >= largeThreshold) return 'large_check';
    return 'minor';
}
const CF_SURFACE_CATS = new Set(['event_cash', 'invoice_check', 'large_check']);
function cfTriageSettings(db) {
    const closedYear = parseInt(db.prepare(`SELECT value FROM settings WHERE key='cf_accounts_closed_year'`).get()?.value, 10);
    const large = parseFloat(db.prepare(`SELECT value FROM settings WHERE key='cf_check_large_threshold'`).get()?.value);
    return {
        closedYear: Number.isFinite(closedYear) ? closedYear : 2025,
        largeThreshold: Number.isFinite(large) && large > 0 ? large : 3000,
    };
}

// ─── GET /transactions ──────────────────────────────────────

router.get('/transactions', handle(async (req, res) => {
    const db = getDb();
    const { from, to, unmatched, limit = '200', offset = '0' } = req.query;
    const q = String(req.query.q || '').trim();
    const includeFolded = req.query.include_folded === '1';

    // Fælles SQL for "kan ikke matches"-kandidater: indgående, ikke-ignoreret, ikke
    // 1:1-matchet, ikke fuldt allokeret.
    const UNMATCHED_WHERE = `t.beloeb > 0 AND t.ignored = 0 AND t.matched_invoice_id IS NULL
        AND ABS(t.beloeb - COALESCE((SELECT SUM(a.amount) FROM cf_allocations a WHERE a.transaction_id = t.id), 0)) >= 0.01`;

    // ── Kategoriseret "kan ikke matches"-liste (uden søgning) ──────────────────
    // Hent ALLE kandidater, kategorisér i JS (cfCategorize), og vis kun dem der
    // KRÆVER en hånd (event_cash/invoice_check/large_check). Resten foldes (findbar
    // via include_folded=1 eller søgning). Intet forsvinder.
    if (unmatched === '1' && !q) {
        const { closedYear, largeThreshold } = cfTriageSettings(db);
        const bookedSet = cfBookedSet(db);
        // Filtre (chips + dato/beløb): category = all|event_cash|invoice_check|large_check|folded
        const category = String(req.query.category || '').trim();
        const minAmount = Math.abs(parseFloat(req.query.min)) || 0;
        const fromD = req.query.from || null, toD = req.query.to || null;
        const sort = req.query.sort === 'date' ? 'date' : 'amount';
        const cands = db.prepare(`
            SELECT t.*, i.kunde AS matched_kunde,
                COALESCE((SELECT SUM(a.amount) FROM cf_allocations a WHERE a.transaction_id = t.id), 0) AS allocated
            FROM cf_transactions t
            LEFT JOIN cf_invoices i ON t.matched_invoice_id = i.id
            WHERE ${UNMATCHED_WHERE}
        `).all();
        for (const tx of cands) {
            tx.category = cfCategorize(tx, closedYear, largeThreshold, bookedSet);
            tx.is_event_cash = tx.category === 'event_cash' ? 1 : 0;
        }
        // Tællere over ALLE kandidater — så chip-tallene er faste uafhængigt af aktivt filter.
        const cntCat = (c) => cands.filter(t => t.category === c).length;
        const counts = {
            event_cash: cntCat('event_cash'),
            invoice_check: cntCat('invoice_check'),
            large_check: cntCat('large_check'),
            folded: cands.filter(t => !CF_SURFACE_CATS.has(t.category)).length,
        };
        counts.surface = counts.event_cash + counts.invoice_check + counts.large_check;
        // Kategori-filter. "Foldede" = de foldede (afregnet/støj); en surface-kategori = kun den;
        // "Alle"/default = alle surface-kategorier (event+faktura+store). Ingen chip viser
        // bogstaveligt ALT (det ville være tusindvis af afregnede posteringer).
        let filtered;
        if (category === 'folded') filtered = cands.filter(t => !CF_SURFACE_CATS.has(t.category));
        else if (['event_cash', 'invoice_check', 'large_check'].includes(category)) filtered = cands.filter(t => t.category === category);
        else filtered = cands.filter(t => CF_SURFACE_CATS.has(t.category)); // 'all' / default = surface
        // Dato + min-beløb (kombineres med kategori)
        if (fromD) filtered = filtered.filter(t => t.dato >= fromD);
        if (toD)   filtered = filtered.filter(t => t.dato <= toD);
        if (minAmount) filtered = filtered.filter(t => Math.abs(t.beloeb) >= minAmount);
        // Sortering: beløb (default) eller dato, begge faldende
        filtered.sort((a, b) => sort === 'date' ? String(b.dato).localeCompare(String(a.dato)) : b.beloeb - a.beloeb);
        return res.json({
            rows: filtered,
            total: filtered.length,
            folded_count: counts.folded,
            counts,
        });
    }

    // ── Øvrige tilfælde: søgning i umatchede, eller almindelig tx-liste ─────────
    let where = '1=1';
    const params = [];
    if (from) { where += ' AND t.dato >= ?'; params.push(from); }
    if (to)   { where += ' AND t.dato <= ?'; params.push(to); }
    if (unmatched === '1') {
        // SØGNING går på tværs af ALT — også foldede posteringer (sådan graves event-/
        // direkte-salg frem). Søg på tekst eller beløb.
        where += ` AND ${UNMATCHED_WHERE}`;
        const digits = q.replace(/\D/g, '');
        where += ' AND (t.tekst LIKE ?' + (digits ? ' OR CAST(t.beloeb AS TEXT) LIKE ?' : '') + ')';
        params.push(`%${q}%`);
        if (digits) params.push(`%${digits}%`);
    }

    const rows = db.prepare(`
        SELECT t.*, i.kunde AS matched_kunde,
            COALESCE((SELECT SUM(a.amount) FROM cf_allocations a WHERE a.transaction_id = t.id), 0) AS allocated
        FROM cf_transactions t
        LEFT JOIN cf_invoices i ON t.matched_invoice_id = i.id
        WHERE ${where}
        ORDER BY t.dato DESC, t.id DESC
        LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    // Tilføj kategori/flag til søgeresultater så frontend kan vise tags
    if (unmatched === '1') {
        const { closedYear, largeThreshold } = cfTriageSettings(db);
        const bookedSet = cfBookedSet(db);
        for (const tx of rows) {
            tx.category = cfCategorize(tx, closedYear, largeThreshold, bookedSet);
            tx.is_event_cash = tx.category === 'event_cash' ? 1 : 0;
        }
    }

    const total = db.prepare(`SELECT COUNT(*) AS cnt FROM cf_transactions t WHERE ${where}`).get(...params);
    res.json({ rows, total: total.cnt, folded_count: 0 });
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

    // Udestående/forfaldne sorteres ÆLDSTE først (mest presserende øverst). Alle
    // andre tabs (alle/betalt/sandsynlig) sorteres NYESTE først, så listen viser
    // de relevante, seneste fakturaer i stedet for de 200 ældste fra arkivet.
    const orderDir = (tab === 'udestaaende' || tab === 'forfaldne') ? 'ASC' : 'DESC';

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
        ORDER BY i.forfald ${orderDir}
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

    // Bankindestående = kontosaldoen fanget ved seneste CSV-upload (øverste/nyeste
    // række). Det er robust på tværs af uploads. Fallback til den gamle id-baserede
    // heuristik for DBs der ikke har gen-uploadet siden fixet (den er upålidelig
    // pga. INSERT OR IGNORE, men bedre end ingenting indtil næste upload).
    const metaBalance = db.prepare(`SELECT value FROM cf_meta WHERE key = 'current_balance'`).get();
    let bankBalance = metaBalance != null ? parseFloat(metaBalance.value) : null;
    if (!Number.isFinite(bankBalance)) {
        const latestTx = db.prepare(`
            SELECT saldo FROM cf_transactions WHERE saldo IS NOT NULL
            ORDER BY dato DESC, id ASC LIMIT 1
        `).get();
        bankBalance = latestTx?.saldo ?? null;
    }

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

    // Unmatched count — samme kategori-triage som "kan ikke matches"-listen.
    // unmatched_count = de ACTIONABLE (event_cash/invoice_check/large_check);
    // folded_count = de foldede (invoice_paid/minor — afregnet/støj, ikke skjult).
    const { closedYear: cfClosedYear, largeThreshold: cfLargeThreshold } = cfTriageSettings(db);
    const cfBooked = cfBookedSet(db);
    const unmatchedCands = db.prepare(`
        SELECT t.tekst, t.dato, t.beloeb FROM cf_transactions t
        WHERE t.matched_invoice_id IS NULL AND t.beloeb > 0 AND t.ignored = 0
          AND ABS(t.beloeb - COALESCE((SELECT SUM(a.amount) FROM cf_allocations a WHERE a.transaction_id = t.id), 0)) >= 0.01
    `).all();
    let unmatchedActionable = 0, foldedCount = 0;
    for (const tx of unmatchedCands) {
        if (CF_SURFACE_CATS.has(cfCategorize(tx, cfClosedYear, cfLargeThreshold, cfBooked))) unmatchedActionable++;
        else foldedCount++;
    }
    const unmatchedCount = { cnt: unmatchedActionable };

    // Cashflow-konvention: faktiske bankbevægelser er incl. moms.
    // Vi udstiller incl-moms-totaler som primær — plus heraf moms-forpligtelse
    // og ex-moms-tal (disponibelt for drift). Se BON_V2_PRINCIPPER.md sektion 6c.
    res.json({
        saldo: bankBalance,
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
        unmatched_count: unmatchedCount.cnt,
        folded_count: foldedCount,
        economic_booked_until: db.prepare(`SELECT value FROM cf_meta WHERE key = 'economic_booked_until'`).get()?.value || null
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

// ════════════════════════════════════════════════════════════
// §2.F — SPLIT-ALLOKERING + UNIVERSEL KOBLING
// Spec: docs/economics/CLAUDE_PENGESTROEM.md §2.F.
// cf_allocations kobler én banktransaktion til ét/flere mål MED beløb.
// Sandheden er allokeringerne; matched_invoice_id er en 1:1-hurtig-sti.
// betalt-flaget RØRES IKKE her — det er e-conomic-aksen (reconcile B).
// ════════════════════════════════════════════════════════════

const ALLOC_TYPES = new Set(['invoice', 'bon', 'event', 'fee']);

/** Genberegn 1:1-hurtig-sti (matched_invoice_id) + confidence ud fra allokeringer. */
function syncTxFromAllocations(db, txId) {
    const tx = db.prepare('SELECT beloeb FROM cf_transactions WHERE id = ?').get(txId);
    if (!tx) return;
    const allocs = db.prepare(
        'SELECT target_type, target_id, amount FROM cf_allocations WHERE transaction_id = ?'
    ).all(txId);
    const sum = allocs.reduce((s, a) => s + a.amount, 0);
    const fully = Math.abs(sum - tx.beloeb) < 0.01;
    // Hurtig-sti kun når der er PRÆCIS én allokering, den er til en faktura, og den dækker fuldt.
    const matched = (allocs.length === 1 && allocs[0].target_type === 'invoice' && fully)
        ? allocs[0].target_id : null;
    db.prepare('UPDATE cf_transactions SET matched_invoice_id = ?, match_confidence = ? WHERE id = ?')
        .run(matched, fully ? 100 : 0, txId);
}

/** Slå et alloker­ings-måls label op (til visning). target_amount = målets eget
 *  reference-beløb (IKKE allokeringens — den ligger på selve allocation-rækken). */
function resolveTargetLabel(db, type, id) {
    if (type === 'invoice') {
        const i = db.prepare('SELECT id, kunde, beloeb FROM cf_invoices WHERE id = ?').get(id);
        return i ? { label: `Faktura #${i.id}`, sublabel: i.kunde || '', target_amount: i.beloeb } : { label: `Faktura #${id}`, sublabel: '(slettet)' };
    }
    if (type === 'bon') {
        const b = db.prepare(`
            SELECT b.bon_number, b.delivery_date,
                   COALESCE(NULLIF(b.total_with_delivery,0), NULLIF(b.total_price,0),
                            (SELECT COALESCE(SUM(line_total),0) FROM bon_lines bl WHERE bl.bon_id = b.id)) AS bon_total,
                   c.first_name || ' ' || COALESCE(c.last_name,'') AS contact, co.name AS company
            FROM bons b LEFT JOIN customers c ON b.customer_id = c.id
            LEFT JOIN companies co ON b.company_id = co.id WHERE b.id = ?
        `).get(id);
        return b ? { label: `Bon #${b.bon_number}`, sublabel: (b.company || b.contact || '').trim(), target_amount: b.bon_total } : { label: `Bon ${id}`, sublabel: '(slettet)' };
    }
    if (type === 'event') {
        const e = db.prepare('SELECT name, start_date, end_date FROM events WHERE id = ?').get(id);
        return e ? { label: `🎪 ${e.name}`, sublabel: [e.start_date, e.end_date].filter(Boolean).join(' → ') } : { label: `Event ${id}`, sublabel: '(slettet)' };
    }
    // fee
    const FEE_LABELS = { zettle: 'Zettle-gebyr', mobilepay: 'MobilePay-gebyr', gebyr: 'Gebyr' };
    return { label: FEE_LABELS[id] || `Gebyr (${id})`, sublabel: '' };
}

// ─── GET /transactions/:txId/allocations — allokeringer for én tx ────────────
router.get('/transactions/:txId/allocations', handle(async (req, res) => {
    const db = getDb();
    const tx = db.prepare('SELECT * FROM cf_transactions WHERE id = ?').get(req.params.txId);
    if (!tx) return res.status(404).json({ error: 'Transaktion ikke fundet' });

    const rows = db.prepare(
        'SELECT * FROM cf_allocations WHERE transaction_id = ? ORDER BY id'
    ).all(req.params.txId);
    const allocations = rows.map(a => ({ ...a, ...resolveTargetLabel(db, a.target_type, a.target_id) }));

    const allocated = r2(rows.reduce((s, a) => s + a.amount, 0));
    res.json({
        transaction: { id: tx.id, dato: tx.dato, tekst: tx.tekst, beloeb: tx.beloeb },
        allocations,
        allocated,
        remaining: r2(tx.beloeb - allocated),
        fully_allocated: Math.abs(allocated - tx.beloeb) < 0.01,
    });
}));

// ─── POST /allocations — opret én eller flere allokeringer for en tx ─────────
//
// Body: { transaction_id, allocations: [{ target_type, target_id, amount, note? }] }
// (enkelt allokering kan også sendes fladt: { transaction_id, target_type, ... })
router.post('/allocations', handle(async (req, res) => {
    const db = getDb();
    const txId = req.body.transaction_id;
    let incoming = Array.isArray(req.body.allocations) ? req.body.allocations
        : (req.body.target_type ? [req.body] : null);
    if (!txId || !incoming || incoming.length === 0) {
        return res.status(400).json({ error: 'Mangler transaction_id eller allocations' });
    }

    const tx = db.prepare('SELECT * FROM cf_transactions WHERE id = ?').get(txId);
    if (!tx) return res.status(404).json({ error: 'Transaktion ikke fundet' });

    // Valider hver allokering
    const clean = [];
    for (const a of incoming) {
        if (!ALLOC_TYPES.has(a.target_type)) {
            return res.status(400).json({ error: `Ugyldig target_type: ${a.target_type}` });
        }
        const amount = r2(Number(a.amount));
        if (!Number.isFinite(amount) || amount === 0) {
            return res.status(400).json({ error: 'amount skal være et tal forskelligt fra 0' });
        }
        const targetId = String(a.target_id ?? '').trim();
        if (!targetId) return res.status(400).json({ error: 'Mangler target_id' });
        // Verificér at målet findes (fee er fri kategori)
        if (a.target_type === 'invoice' && !db.prepare('SELECT 1 FROM cf_invoices WHERE id = ?').get(targetId))
            return res.status(404).json({ error: `Faktura ${targetId} findes ikke` });
        if (a.target_type === 'bon' && !db.prepare('SELECT 1 FROM bons WHERE id = ?').get(targetId))
            return res.status(404).json({ error: `Bon ${targetId} findes ikke` });
        if (a.target_type === 'event' && !db.prepare('SELECT 1 FROM events WHERE id = ?').get(targetId))
            return res.status(404).json({ error: `Event ${targetId} findes ikke` });
        clean.push({ target_type: a.target_type, target_id: targetId, amount, note: a.note ? String(a.note).trim() : null });
    }

    // Invariant: |Σ(eksisterende + nye)| må ikke overstige |beloeb|, og må ikke vende fortegn.
    const existing = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM cf_allocations WHERE transaction_id = ?').get(txId).s;
    const total = r2(existing + clean.reduce((s, a) => s + a.amount, 0));
    if (Math.abs(total) - Math.abs(tx.beloeb) > 0.01) {
        return res.status(400).json({ error: `Σ allokeret (${total}) overstiger transaktionens beløb (${tx.beloeb})` });
    }
    if (total !== 0 && Math.sign(total) !== Math.sign(tx.beloeb)) {
        return res.status(400).json({ error: 'Allokering må ikke vende transaktionens fortegn' });
    }

    transaction(db, () => {
        const stmt = db.prepare(`
            INSERT INTO cf_allocations (transaction_id, target_type, target_id, amount, note, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const a of clean) stmt.run(txId, a.target_type, a.target_id, a.amount, a.note, req.session.userId || null);
        syncTxFromAllocations(db, txId);
    });

    broadcast('cashflow_allocation', { transaction_id: Number(txId) });
    res.json({ ok: true, count: clean.length });
}));

// ─── PATCH /allocations/:id — ret beløbet på en gemt allokering ──────────────
router.patch('/allocations/:id', handle(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM cf_allocations WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Allokering ikke fundet' });
    const amount = r2(Number(req.body.amount));
    if (!Number.isFinite(amount) || amount === 0) {
        return res.status(400).json({ error: 'amount skal være et tal forskelligt fra 0' });
    }
    const tx = db.prepare('SELECT beloeb FROM cf_transactions WHERE id = ?').get(row.transaction_id);
    // Invariant mod tx: Σ(andre allokeringer) + nyt beløb må ikke overstige |beloeb|
    // eller vende fortegn.
    const others = db.prepare(
        'SELECT COALESCE(SUM(amount),0) AS s FROM cf_allocations WHERE transaction_id = ? AND id != ?'
    ).get(row.transaction_id, row.id).s;
    const total = r2(others + amount);
    if (Math.abs(total) - Math.abs(tx.beloeb) > 0.01) {
        return res.status(400).json({ error: `Σ allokeret (${total}) overstiger transaktionens beløb (${tx.beloeb})` });
    }
    if (total !== 0 && Math.sign(total) !== Math.sign(tx.beloeb)) {
        return res.status(400).json({ error: 'Allokering må ikke vende transaktionens fortegn' });
    }

    transaction(db, () => {
        db.prepare('UPDATE cf_allocations SET amount = ? WHERE id = ?').run(amount, row.id);
        syncTxFromAllocations(db, row.transaction_id);
    });
    broadcast('cashflow_allocation', { transaction_id: row.transaction_id });
    res.json({ ok: true });
}));

// ─── DELETE /allocations/:id — fjern én allokering ───────────────────────────
router.delete('/allocations/:id', handle(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM cf_allocations WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Allokering ikke fundet' });

    transaction(db, () => {
        db.prepare('DELETE FROM cf_allocations WHERE id = ?').run(req.params.id);
        syncTxFromAllocations(db, row.transaction_id);
    });

    broadcast('cashflow_allocation', { transaction_id: row.transaction_id });
    res.json({ ok: true });
}));

// ─── GET /match-targets — universel koblings-søgning (bons + fakturaer + events)
//
// Løser bon 4001: den gamle søgning så kun udestaaende fakturaer. Her søges i
// HELE universet: enhver bon (uanset status), enhver faktura (betalt eller ej),
// ethvert event. ?q= fri tekst, ?date= valgfri (event-overlap-forslag i UI).
router.get('/match-targets', handle(async (req, res) => {
    const db = getDb();
    const q = String(req.query.q || '').trim();
    const lim = Math.min(parseInt(req.query.limit || '12'), 25);
    if (q.length < 1) return res.json({ targets: [] });
    const like = `%${q}%`;
    const digits = q.replace(/\D/g, '');

    // Bons: søg bon_number, kunde, firma. Tal → også direkte bon_number/id-match.
    // UDGIFTS-BONS (event_role='expense', fx kommission/afgift) MEDTAGES — de har
    // negativ total og kan vælges som FRADRAG i en netto-afregning (fx festival-
    // arrangør der trækker sin provision før udbetaling). Markeres med expense=true
    // så de indsættes som negativ allokering. Kun ægte data-anomalier (negativ total
    // UDEN expense-rolle) skjules.
    const bons = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.event_role,
               -- Rigtig bon-total: total_with_delivery → total_price → linje-sum.
               -- (Gamle cafe-bons har tom total_with_delivery, men total_price/linjer er sat.)
               COALESCE(NULLIF(b.total_with_delivery,0), NULLIF(b.total_price,0),
                        (SELECT COALESCE(SUM(line_total),0) FROM bon_lines bl WHERE bl.bon_id = b.id)) AS bon_total,
               c.first_name || ' ' || COALESCE(c.last_name,'') AS contact, co.name AS company,
               sd.label AS status_label
        FROM bons b
        LEFT JOIN customers c  ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id  = co.id
        LEFT JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.is_offer = 0
          AND (COALESCE(b.event_role,'') = 'expense' OR COALESCE(NULLIF(b.total_with_delivery,0), NULLIF(b.total_price,0), 0) >= 0)
          AND (
            CAST(b.bon_number AS TEXT) LIKE ? OR co.name LIKE ?
            OR (c.first_name || ' ' || COALESCE(c.last_name,'')) LIKE ?
            ${digits ? 'OR CAST(b.id AS TEXT) = ?' : ''}
        )
        ORDER BY b.delivery_date DESC LIMIT ?
    `).all(like, like, like, ...(digits ? [digits] : []), lim);

    // Fakturaer: betalt ELLER ej (modsat den gamle udestaaende-only).
    const invoices = db.prepare(`
        SELECT id, kunde, beloeb, forfald, betalt FROM cf_invoices
        WHERE CAST(id AS TEXT) LIKE ? OR kunde LIKE ?
        ORDER BY forfald DESC LIMIT ?
    `).all(like, like, lim);

    // Events er BEVIDST IKKE koblings-mål her: event-indtægt skal altid gå gennem en
    // salgsbon (besluttet — bons er sandheden for event-økonomi). Brug "Opret bon"
    // (target_type='bon') i stedet — den laver salgsbonnen + afstemmer i ét hug.
    const targets = [
        ...bons.map(b => {
            const expense = b.event_role === 'expense';
            return {
                type: 'bon', id: b.id, label: `Bon #${b.bon_number}${expense ? ' (udgift)' : ''}`,
                sublabel: [(b.company || b.contact || '').trim(), b.status_label].filter(Boolean).join(' · '),
                amount: b.bon_total, date: b.delivery_date, expense,
            };
        }),
        ...invoices.map(i => ({
            type: 'invoice', id: i.id, label: `Faktura #${i.id}`,
            sublabel: [i.kunde, i.betalt ? 'betalt' : 'udestående'].filter(Boolean).join(' · '),
            amount: i.beloeb, date: i.forfald,
        })),
    ];
    res.json({ targets });
}));

// ─── GET /events-on-date — auto-forslag: events der overlapper en dato ───────
//
// §2.E auto-forslag: en indbetaling med dato inden for (eller kort efter) et
// events periode er sandsynligvis direkte event-salg. Buffer efter end_date
// fanger afregninger der lander 1-få dage efter eventet (Zettle/MobilePay).
router.get('/events-on-date', handle(async (req, res) => {
    const db = getDb();
    const date = String(req.query.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ events: [] });
    const events = db.prepare(`
        SELECT id, name, start_date, end_date FROM events
        WHERE date(start_date) <= date(?)
          AND date(?) <= date(COALESCE(end_date, start_date), '+5 days')
        ORDER BY start_date DESC
    `).all(date, date);
    res.json({ events: events.map(e => ({
        type: 'event', id: e.id, label: `🎪 ${e.name}`,
        sublabel: [e.start_date, e.end_date].filter(Boolean).join(' → '),
    })) });
}));

// §2.E: "Find indbetaling" fra event-siden — ukoblede bank-poster NÆR event-datoen.
// Spejlet af /events-on-date: der finder vi events for en indbetaling; her finder vi
// indbetalinger for et event. ±14 dages buffer (Zettle-afregninger halter). Kategori-tag med.
router.get('/candidates-for-event', handle((req, res) => {
    const db = getDb();
    const eventId = parseInt(req.query.event_id, 10);
    if (!eventId) return res.status(400).json({ error: 'event_id kræves' });
    const ev = db.prepare('SELECT id, name, start_date, end_date FROM events WHERE id = ?').get(eventId);
    if (!ev) return res.status(404).json({ error: 'event findes ikke' });
    const end = ev.end_date || ev.start_date;
    const rows = db.prepare(`
        SELECT t.*, COALESCE((SELECT SUM(a.amount) FROM cf_allocations a WHERE a.transaction_id = t.id), 0) AS allocated
        FROM cf_transactions t
        WHERE t.beloeb > 0 AND t.ignored = 0 AND t.matched_invoice_id IS NULL
          AND ABS(t.beloeb - COALESCE((SELECT SUM(a.amount) FROM cf_allocations a WHERE a.transaction_id = t.id), 0)) >= 0.01
          AND date(t.dato) BETWEEN date(?, '-14 days') AND date(?, '+14 days')
        ORDER BY t.beloeb DESC
    `).all(ev.start_date, end);
    const { closedYear, largeThreshold } = cfTriageSettings(db);
    const bookedSet = cfBookedSet(db);
    for (const tx of rows) {
        tx.category = cfCategorize(tx, closedYear, largeThreshold, bookedSet);
        tx.is_event_cash = tx.category === 'event_cash' ? 1 : 0;
    }
    res.json({ event: ev, rows });
}));

// ─── GET /event-income — per-event-indtægtsoverblik (bank-afstemt) ───────────
//
// §2.E: "Festival X = Y kr ind". Brutto = Σ event-allokeringer. Gebyr = Σ fee-
// allokeringer på de SAMME transaktioner (Zettle/MobilePay-gebyr hører til samme
// indbetaling). Netto = brutto + gebyr (gebyr er negativt). Kun events med
// mindst én kobling vises, med mindre ?all=1.
router.get('/event-income', handle(async (req, res) => {
    const db = getDb();
    // Bank-afstemt indtægt pr. event = Σ allokeringer på eventets BONS (ikke bare
    // event-allokeringer — dem findes ikke længere; event-penge er altid salgsbons).
    // brutto = allokeringer til salgsbons, udgift = allokeringer til udgiftsbons (negativ)
    // + udbyder-gebyr (fee-allokeringer på de SAMME transaktioner). netto = brutto + udgift.
    const rows = db.prepare(`
        SELECT
            e.id, e.name, e.start_date, e.end_date,
            COALESCE(SUM(CASE WHEN COALESCE(b.event_role,'') <> 'expense' THEN a.amount ELSE 0 END), 0) AS gross,
            COALESCE(SUM(CASE WHEN COALESCE(b.event_role,'') =  'expense' THEN a.amount ELSE 0 END), 0) AS expenses,
            COUNT(DISTINCT a.transaction_id) AS tx_count,
            COALESCE((
                SELECT SUM(f.amount) FROM cf_allocations f
                WHERE f.target_type = 'fee' AND f.transaction_id IN (
                    SELECT a2.transaction_id FROM cf_allocations a2
                    JOIN bons b2 ON a2.target_type = 'bon' AND a2.target_id = CAST(b2.id AS TEXT)
                    WHERE b2.event_id = e.id
                )
            ), 0) AS fees
        FROM events e
        JOIN bons b ON b.event_id = e.id
        JOIN cf_allocations a ON a.target_type = 'bon' AND a.target_id = CAST(b.id AS TEXT)
        GROUP BY e.id
        ORDER BY e.start_date DESC
    `).all();
    const events = rows
        .filter(r => req.query.all === '1' || r.tx_count > 0)
        .map(r => ({
            id: r.id, name: r.name, start_date: r.start_date, end_date: r.end_date,
            gross: r2(r.gross), fees: r2(r.expenses + r.fees),
            net: r2(r.gross + r.expenses + r.fees),
            tx_count: r.tx_count,
        }));
    res.json({ events });
}));

// ─── POST /create-bon-from-tx — §2.E.3: opret salgsbon fra en indbetaling ────
//
// Direkte salg ved event (Zettle/MobilePay/kontant) uden faktura. Opretter en
// rigtig BETALT salgsbon (event_role='sales', price_category='festival') og
// allokerer transaktionen til den. Hvis eventet ALLEREDE har en salgsbon
// (besluttet: "hvis der ikke er en bon til eventet skal der oprettes en"),
// genbruges den — linjer tilføjes i stedet for at oprette en dublet.
//
// Linjer er fleksible: én samle-linje ("Direkte salg") ELLER salg pr. menu-linje.
// Valgfri gebyr-linje (Zettle/MobilePay) gør at brutto kan overstige netto.
// Σ(linjer) + gebyr må ikke overstige transaktionens (resterende) beløb.
//
// Body: { transaction_id, event_id?, payment_type,
//         lines:[{name, quantity?, amount, grocy_recipe_id?, category?, cost_price?, co2e?}],
//         fee?:{kind,amount} }
// En linje kan være fri-tekst (lump) ELLER en rigtig Grocy-menu (grocy_recipe_id +
// kategori) så salget er konsistent med resten af systemet. amount = linjens TOTAL;
// quantity = antal solgt (default 1) → unit_price = amount/quantity.
router.post('/create-bon-from-tx', handle(async (req, res) => {
    const db = getDb();
    const { transaction_id, event_id = null, payment_type = 'card', fee = null } = req.body;
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];

    const tx = db.prepare('SELECT * FROM cf_transactions WHERE id = ?').get(transaction_id);
    if (!tx) return res.status(404).json({ error: 'Transaktion ikke fundet' });
    if (!lines.length) return res.status(400).json({ error: 'Mindst én linje kræves' });

    // Valider + normaliser linjer
    const cleanLines = [];
    for (const l of lines) {
        const amount = r2(Number(l.amount));
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Linje-beløb skal være > 0' });
        const qty = Number(l.quantity) > 0 ? Number(l.quantity) : 1;
        cleanLines.push({
            name: String(l.name || 'Direkte salg').trim() || 'Direkte salg',
            amount, qty,
            unit_price: r2(amount / qty),
            grocy_recipe_id: l.grocy_recipe_id != null ? Number(l.grocy_recipe_id) : null,
            category: l.category ? String(l.category) : 'Event-salg',
            cost_price: l.cost_price != null ? r2(Number(l.cost_price)) : null,
            co2e: l.co2e != null ? Number(l.co2e) : null,
        });
    }
    const linesSum = r2(cleanLines.reduce((s, l) => s + l.amount, 0));

    // Valider event hvis angivet
    let event = null;
    if (event_id != null) {
        event = db.prepare('SELECT id, name, start_date, location_id, event_address_id FROM events WHERE id = ?').get(event_id);
        if (!event) return res.status(404).json({ error: `Event ${event_id} findes ikke` });
    }

    // Valider gebyr (negativ) + allokerings-invariant mod tx (inkl. eksisterende)
    const feeAmount = fee && fee.amount != null ? r2(Number(fee.amount)) : 0;
    if (feeAmount > 0) return res.status(400).json({ error: 'Gebyr skal være ≤ 0' });
    const existingAlloc = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM cf_allocations WHERE transaction_id = ?').get(transaction_id).s;
    const allocTotal = r2(existingAlloc + linesSum + feeAmount);
    if (Math.abs(allocTotal) - Math.abs(tx.beloeb) > 0.01) {
        return res.status(400).json({ error: `Σ allokeret (${allocTotal}) overstiger indbetalingen (${tx.beloeb})` });
    }
    if (allocTotal !== 0 && Math.sign(allocTotal) !== Math.sign(tx.beloeb)) {
        return res.status(400).json({ error: 'Allokering må ikke vende indbetalingens fortegn' });
    }

    const userId = req.session.userId || null;

    // Beslut bon-genbrug + hent nummer/status/lokation UDEN FOR transaction()
    // (nextBonNumber/getStatusId åbner selv transactions → nested = fejl).
    const existingBon = event ? db.prepare(
        "SELECT id, bon_number FROM bons WHERE event_id = ? AND event_role = 'sales' ORDER BY id LIMIT 1"
    ).get(event.id) : null;
    const betaltStatusId = getStatusId('BETALT');
    const defaultLocationId = getDefaultLocationId();
    const newBonNumber = existingBon ? null : nextBonNumber();

    // Event-arv: en salgs-/udgiftsbon oprettet fra et event overtager eventets
    // lokation, dato (event-datoen, ikke bankdatoen) og leveringsadresse.
    const bonLocationId = (event && event.location_id) ? event.location_id : defaultLocationId;
    const bonDeliveryDate = (event && event.start_date) ? event.start_date : tx.dato;
    const bonAddressId = event ? (event.event_address_id || null) : null;

    // Gebyr/afgift på et EVENT bogføres som en UDGIFTSBON (event_role='expense'),
    // så det tæller med i eventets P&L (besluttet 29. juni). Uden event (standalone)
    // bliver det blot en fee-allokering på banken. Hent udgiftsbon-nr uden for tx.
    const wantExpenseBon = !!(event && feeAmount < 0);
    const existingExpenseBon = wantExpenseBon ? db.prepare(
        "SELECT id, bon_number FROM bons WHERE event_id = ? AND event_role = 'expense' ORDER BY id LIMIT 1"
    ).get(event.id) : null;
    const newExpenseBonNumber = (wantExpenseBon && !existingExpenseBon) ? nextBonNumber() : null;

    const result = transaction(db, () => {
        let bonId = existingBon ? existingBon.id : null;
        let bonNumber = existingBon ? existingBon.bon_number : newBonNumber;
        let created = false;
        if (!bonId) {
            const ins = db.prepare(`
                INSERT INTO bons (
                    bon_number, status_id, location_id, order_date, delivery_date,
                    price_category, payment_type, event_id, event_role, delivery_address_id,
                    pax, total_units, total_price, total_with_delivery, created_by_user_id
                ) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,?)
            `).run(
                bonNumber, betaltStatusId, bonLocationId, todayISO(),
                bonDeliveryDate, 'festival', payment_type,
                event ? event.id : null, event ? 'sales' : null, bonAddressId,
                userId
            );
            bonId = ins.lastInsertRowid;
            created = true;
            logChange({ entityType: 'bon', entityId: bonId, action: 'create', newValue: bonNumber, userId });
        }

        // Tilføj linjer (priser er INCL moms per doktrin). Grocy-menu → grocy_recipe_id
        // + rigtig kategori; fri-tekst → kategori 'Event-salg'. line_total = amount.
        const sortBase = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM bon_lines WHERE bon_id = ?').get(bonId).m;
        const lineStmt = db.prepare(`
            INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit, unit_price, line_total, cost_price, co2e, sort_order, moms_included)
            VALUES (?, ?, ?, ?, ?, 'stk', ?, ?, ?, ?, ?, 1)
        `);
        cleanLines.forEach((l, i) => lineStmt.run(
            bonId, l.grocy_recipe_id, l.name, l.category, l.qty,
            l.unit_price, l.amount, l.cost_price, l.co2e, sortBase + i + 1
        ));

        // Server-autoritativ total
        recalcBonTotalUnits(db, bonId);
        const total = db.prepare('SELECT COALESCE(SUM(line_total),0) AS s FROM bon_lines WHERE bon_id = ?').get(bonId).s;
        db.prepare('UPDATE bons SET total_price = ?, total_with_delivery = ? WHERE id = ?').run(r2(total), r2(total), bonId);

        // Allokér transaktionen til bonen (+ evt. gebyr-linje)
        const allocStmt = db.prepare(`
            INSERT INTO cf_allocations (transaction_id, target_type, target_id, amount, note, created_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        allocStmt.run(transaction_id, 'bon', String(bonId), linesSum, 'Opret bon fra indbetaling', userId);

        let expenseBonId = null, expenseBonNumber = null, expenseCreated = false;
        if (feeAmount < 0) {
            if (wantExpenseBon) {
                // Bogfør afgift/gebyr som en UDGIFTSBON på eventet (event_role='expense'),
                // så det tæller i eventets P&L. Genbrug eventets udgiftsbon hvis den findes.
                expenseBonId = existingExpenseBon ? existingExpenseBon.id : null;
                expenseBonNumber = existingExpenseBon ? existingExpenseBon.bon_number : newExpenseBonNumber;
                if (!expenseBonId) {
                    const ei = db.prepare(`
                        INSERT INTO bons (
                            bon_number, status_id, location_id, order_date, delivery_date,
                            price_category, payment_type, event_id, event_role, delivery_address_id,
                            pax, total_units, total_price, total_with_delivery, created_by_user_id
                        ) VALUES (?,?,?,?,?,?,?,?,'expense',?,0,0,0,0,?)
                    `).run(
                        expenseBonNumber, betaltStatusId, bonLocationId, todayISO(),
                        bonDeliveryDate, 'festival', payment_type, event.id, bonAddressId, userId
                    );
                    expenseBonId = ei.lastInsertRowid;
                    expenseCreated = true;
                    logChange({ entityType: 'bon', entityId: expenseBonId, action: 'create', newValue: expenseBonNumber, userId });
                }
                const esort = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM bon_lines WHERE bon_id = ?').get(expenseBonId).m;
                db.prepare(`
                    INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, sort_order, moms_included)
                    VALUES (?, 'Afgift/gebyr', 'Udgift', 1, 'stk', ?, ?, ?, 1)
                `).run(expenseBonId, feeAmount, feeAmount, esort + 1);
                const etotal = db.prepare('SELECT COALESCE(SUM(line_total),0) AS s FROM bon_lines WHERE bon_id = ?').get(expenseBonId).s;
                db.prepare('UPDATE bons SET total_price = ?, total_with_delivery = ? WHERE id = ?').run(r2(etotal), r2(etotal), expenseBonId);
                allocStmt.run(transaction_id, 'bon', String(expenseBonId), feeAmount, 'Afgift/gebyr (event-udgift)', userId);
            } else {
                // standalone (ingen event): behold som fee-allokering på banken
                allocStmt.run(transaction_id, 'fee', String(fee.kind || 'gebyr'), feeAmount, null, userId);
            }
        }
        syncTxFromAllocations(db, transaction_id);

        return { bonId, bonNumber, created, expenseBonId, expenseBonNumber, expenseCreated };
    });

    broadcast(result.created ? 'bon_created' : 'bon_updated', { id: result.bonId, bon_number: result.bonNumber });
    if (result.expenseBonId) {
        broadcast(result.expenseCreated ? 'bon_created' : 'bon_updated', { id: result.expenseBonId, bon_number: result.expenseBonNumber });
    }
    broadcast('cashflow_allocation', { transaction_id: Number(transaction_id) });
    res.json({ ok: true, bon_id: result.bonId, bon_number: result.bonNumber, created: result.created, expense_bon_id: result.expenseBonId });
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

// ─── e-conomic-afstemning (Pengestrøm delta B) ──────────────────────────────
// POST /api/cashflow/reconcile  { dry_run?, since? }
// Læser e-conomics bogførte fakturaer → markér cf_invoices betalt via bon-nr i
// fakturaens overskrift. Skriver kun til vores egen cf_invoices + vandmærke.
const economicAdapter = require('../services/economicAdapter');
const { reconcile, matchByEconomicNumber } = require('../services/cashflowReconcile');

router.post('/reconcile', handle(async (req, res) => {
    if (!economicAdapter.isConfigured()) {
        return res.status(503).json({ error: 'e-conomic er ikke konfigureret (tokens mangler i .env)' });
    }
    const db = getDb();
    const dryRun = req.body?.dry_run === true;
    const since  = req.body?.since || undefined;
    let result;
    try {
        result = await reconcile(db, { dryRun, since });
        // Efter e-conomic-numrene er gemt: kobl umatchede bank-indbetalinger via
        // fakturanummeret i bankteksten (verificeret link, ikke dato-fold).
        const m = matchByEconomicNumber(db, { dryRun });
        result.linked = m.linked;
    } catch (e) {
        if (e instanceof economicAdapter.EconomicAuthError) return res.status(502).json({ error: 'e-conomic-adgang skal genetableres', detail: e.message });
        if (e instanceof economicAdapter.EconomicRateError) return res.status(503).json({ error: 'e-conomic rate limit ramt — prøv igen senere' });
        return res.status(502).json({ error: 'e-conomic-afstemning fejlede', detail: e.message });
    }
    if (!dryRun && (result.flipped > 0 || result.linked > 0)) {
        logChange({ entityType: 'cashflow', entityId: 0, action: 'economic_reconcile',
            fieldName: 'betalt', oldValue: null, newValue: String(result.flipped),
            userId: req.session?.userId ?? null, notes: `vandmærke → ${result.newWatermark} · ${result.numbered} nr · ${result.linked} koblet` });
        broadcast('cashflow_reconciled', { flipped: result.flipped, linked: result.linked, watermark: result.newWatermark });
    }
    res.json(result);
}));

// GET /api/cashflow/reconcile/status — vandmærke + om e-conomic er konfigureret
router.get('/reconcile/status', handle((req, res) => {
    const db = getDb();
    const watermark = db.prepare(`SELECT value FROM cf_meta WHERE key = 'economic_booked_until'`).get()?.value || null;
    res.json({ economic_booked_until: watermark || null, configured: economicAdapter.isConfigured() });
}));

// Eksportér kategoriserings-helperen til test (regressionssikring af triage-reglerne)
router.cfCategorize = cfCategorize;
module.exports = router;
