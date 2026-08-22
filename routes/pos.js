/**
 * routes/pos.js — POS-salg (Zettle) · /api/pos
 * ════════════════════════════════════════════════════════════
 * Spec: docs/CLAUDE_ZETTLE_POS.md §12 (synlighed) · Fase 2 (#509).
 *
 * Fladen er bygget om ét princip: **intet må forsvinde stille.** En dag der
 * ikke kunne kobles til et event, en POS-vare uden Grocy-kobling og en synk
 * der fejlede skal alle kunne SES — huset har en dokumenteret fejlklasse hvor
 * bivirkningen aldrig fyrede og intet sted opdagede det (#305, #319).
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, todayISO, offsetISO, logChange } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const grocyAdapter = require('../services/grocyAdapter');
const { getZettleAdapter } = require('../services/zettleAdapter');
const {
    SOURCE, getPosSettings, rebuildDay, syncPos, syncFinance, assignDay, matchPayout, suggestBankMatch,
} = require('../services/posSync');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const parse = (v, fb = null) => { try { return v ? JSON.parse(v) : fb; } catch { return fb; } };

/** Grocy-opskrifter, men aldrig som blokering: uden dem bygges bonnen bare ikke. */
async function recipesOrNull() {
    try { return await grocyAdapter.getRecipes(); }
    catch (err) { console.warn('[pos] Grocy utilgængelig:', err.message); return null; }
}

/* ── GET /api/pos/days ─────────────────────────────────────────────────── */
router.get('/days', requireAuth(), handle((req, res) => {
    const db = getDb();
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : offsetISO(-90);
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : todayISO();

    const rows = db.prepare(`
        SELECT d.*, e.name AS event_name, b.bon_number,
               sd.code AS bon_status
        FROM pos_sales_days d
        LEFT JOIN events e ON e.id = d.event_id
        LEFT JOIN bons b ON b.id = d.bon_id
        LEFT JOIN status_definitions sd ON sd.id = b.status_id
        WHERE d.source = ? AND d.business_date BETWEEN ? AND ?
        ORDER BY d.business_date DESC
    `).all(SOURCE, from, to);

    res.json({
        from, to,
        days: rows.map(r => ({
            business_date: r.business_date,
            event_id: r.event_id, event_name: r.event_name,
            assign_status: r.assign_status,
            bon_id: r.bon_id, bon_number: r.bon_number, bon_status: r.bon_status,
            gross_incl: r.gross_incl,
            card_gross_incl: r.card_gross_incl,
            fee_incl: r.fee_incl,
            fee_bon_id: r.fee_bon_id,
            by_payment: parse(r.by_payment_json, {}),
            purchase_count: r.purchase_count, refund_count: r.refund_count,
            unmatched: parse(r.unmatched_json, []),
            flags: parse(r.flags_json, []),
            last_synced_at: r.last_synced_at, last_error: r.last_error,
        })),
    });
}));

/* ── GET /api/pos/days/:date ───────────────────────────────────────────── */
router.get('/days/:date', requireAuth(), handle((req, res) => {
    const db = getDb();
    const date = req.params.date;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date skal være YYYY-MM-DD' });

    const day = db.prepare(`
        SELECT d.*, e.name AS event_name, b.bon_number
        FROM pos_sales_days d
        LEFT JOIN events e ON e.id = d.event_id
        LEFT JOIN bons b ON b.id = d.bon_id
        WHERE d.source = ? AND d.business_date = ?
    `).get(SOURCE, date);
    if (!day) return res.status(404).json({ error: 'Ingen POS-dag for ' + date });

    // Kandidat-events til manuel kobling: dem der dækker datoen, uanset flueben
    // — mangler det, er det som regel netop dét der skal rettes.
    const candidates = db.prepare(`
        SELECT id, name, pos_enabled, start_date, end_date
        FROM events
        WHERE status != 'cancelled' AND ? BETWEEN start_date AND COALESCE(end_date, start_date)
        ORDER BY id
    `).all(date);

    const hours = db.prepare(`
        SELECT occurred_at, amount_incl FROM pos_purchases
        WHERE source = ? AND business_date = ? ORDER BY occurred_at
    `).all(SOURCE, date);

    res.json({
        business_date: day.business_date,
        event_id: day.event_id, event_name: day.event_name,
        assign_status: day.assign_status,
        bon_id: day.bon_id, bon_number: day.bon_number,
        gross_incl: day.gross_incl,
        by_payment: parse(day.by_payment_json, {}),
        purchase_count: day.purchase_count, refund_count: day.refund_count,
        unmatched: parse(day.unmatched_json, []),
        flags: parse(day.flags_json, []),
        last_synced_at: day.last_synced_at, last_error: day.last_error,
        candidate_events: candidates,
        purchases: hours,
    });
}));

/* ── POST /api/pos/sync ────────────────────────────────────────────────── */
router.post('/sync', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const { from, to } = req.body || {};
    if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'from skal være YYYY-MM-DD' });
    if (to && !DATE_RE.test(to)) return res.status(400).json({ error: 'to skal være YYYY-MM-DD' });
    const out = await syncPos(db, { from: from || null, to: to || null, userId: req.session?.userId ?? null });
    res.json(out);
}));

/* ── POST /api/pos/days/:date/assign ───────────────────────────────────── */
router.post('/days/:date/assign', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const date = req.params.date;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date skal være YYYY-MM-DD' });
    const eventId = req.body?.event_id === null ? null : Number(req.body?.event_id);
    if (eventId !== null && !Number.isInteger(eventId)) {
        return res.status(400).json({ error: 'event_id skal være et tal eller null' });
    }
    try {
        const out = assignDay(db, date, eventId, {
            userId: req.session?.userId ?? null,
            recipes: await recipesOrNull(),
        });
        res.json({ ok: true, ...out });
    } catch (err) {
        const status = { unknown_day: 404, unknown_event: 404, bon_exists: 409, bon_frozen: 409 }[err.code] || 500;
        if (status === 500) throw err;
        res.status(status).json({ error: err.message, code: err.code });
    }
}));

/* ── POST /api/pos/days/:date/rebuild ──────────────────────────────────── */
router.post('/days/:date/rebuild', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const date = req.params.date;
    if (!DATE_RE.test(date)) return res.status(400).json({ error: 'date skal være YYYY-MM-DD' });
    res.json(rebuildDay(db, date, { recipes: await recipesOrNull(), userId: req.session?.userId ?? null }));
}));

/* ── GET /api/pos/unmatched ────────────────────────────────────────────── */
// POS-varer uden Grocy-kobling, samlet på tværs af dage. Ikke en fejlliste —
// der SÆLGES ting der ikke ligger i Grocy (Luxus hotdog er 20 % af en
// festivals omsætning). Listen findes for at man kan tage stilling.
router.get('/unmatched', requireAuth(), handle((req, res) => {
    const db = getDb();
    const rows = db.prepare(`
        SELECT business_date, unmatched_json FROM pos_sales_days
        WHERE source = ? AND unmatched_json IS NOT NULL AND unmatched_json != '[]'
        ORDER BY business_date DESC
    `).all(SOURCE);

    const agg = new Map();
    for (const r of rows) {
        for (const u of parse(r.unmatched_json, [])) {
            const key = u.product_uuid || ('adhoc:' + u.name);
            const e = agg.get(key) || {
                product_uuid: u.product_uuid || null, name: u.name,
                quantity: 0, amount_incl: 0, days: 0, last_seen: r.business_date,
            };
            e.quantity += Number(u.quantity) || 0;
            e.amount_incl = Math.round((e.amount_incl + (Number(u.amount_incl) || 0)) * 100) / 100;
            e.days++;
            agg.set(key, e);
        }
    }
    const decided = new Map(db.prepare(
        'SELECT pos_product_uuid, grocy_recipe_id FROM pos_product_map WHERE source = ?'
    ).all(SOURCE).map(r => [r.pos_product_uuid, r.grocy_recipe_id]));

    res.json({
        products: [...agg.values()]
            .filter(p => !(p.product_uuid && decided.has(p.product_uuid)))
            .sort((a, b) => b.amount_incl - a.amount_incl),
    });
}));

/* ── POST /api/pos/products/map ────────────────────────────────────────── */
// grocy_recipe_id: null = "besluttet: findes ikke i Grocy". Det er en gyldig
// beslutning og skal kunne skelnes fra "ingen har kigget på den endnu".
router.post('/products/map', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const uuid = String(req.body?.pos_product_uuid || '').trim();
    if (!uuid) return res.status(400).json({ error: 'pos_product_uuid er påkrævet' });
    const recipeId = req.body?.grocy_recipe_id === null || req.body?.grocy_recipe_id === undefined
        ? null : Number(req.body.grocy_recipe_id);
    if (recipeId !== null && !Number.isInteger(recipeId)) {
        return res.status(400).json({ error: 'grocy_recipe_id skal være et tal eller null' });
    }

    db.prepare(`
        INSERT INTO pos_product_map (source, pos_product_uuid, grocy_recipe_id, name_seen, decided_at, decided_by_user_id)
        VALUES (?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(source, pos_product_uuid) DO UPDATE SET
            grocy_recipe_id = excluded.grocy_recipe_id,
            name_seen = COALESCE(excluded.name_seen, pos_product_map.name_seen),
            decided_at = datetime('now'),
            decided_by_user_id = excluded.decided_by_user_id
    `).run(SOURCE, uuid, recipeId, req.body?.name || null, req.session?.userId ?? null);

    // changelog.entity_id er NOT NULL — koblingens egen række er det rigtige id.
    // (Uden den fejlede kaldet EFTER at koblingen var skrevet: gemt, men ikke
    //  slået igennem på bonnen. Halvt udført er værre end slet ikke udført.)
    const mapRow = db.prepare('SELECT id FROM pos_product_map WHERE source = ? AND pos_product_uuid = ?')
        .get(SOURCE, uuid);
    logChange({
        entityType: 'pos_product', entityId: mapRow.id, action: 'update', fieldName: 'grocy_recipe_id',
        newValue: recipeId === null ? '(findes ikke i Grocy)' : String(recipeId),
        notes: `POS-vare ${req.body?.name || uuid}`, userId: req.session?.userId ?? null,
    });

    // Koblingen skal slå igennem med det samme på de dage varen er solgt.
    const recipes = await recipesOrNull();
    const rebuilt = [];
    if (recipes) {
        const days = db.prepare(`
            SELECT DISTINCT business_date FROM pos_purchases
            WHERE source = ? AND raw_json LIKE ? ORDER BY business_date DESC LIMIT 60
        `).all(SOURCE, `%${uuid}%`);
        for (const d of days) {
            try { rebuildDay(db, d.business_date, { recipes, userId: req.session?.userId ?? null }); rebuilt.push(d.business_date); }
            catch (err) { console.error('[pos] genopbygning af', d.business_date, 'fejlede:', err.message); }
        }
    }
    res.json({ ok: true, pos_product_uuid: uuid, grocy_recipe_id: recipeId, rebuilt_days: rebuilt });
}));

/* ── GET /api/pos/payouts ──────────────────────────────────────────────── */
// Zettle udbetaler netto og fejer saldoen, så en udbetaling dækker alt siden
// den forrige. Sammensætningen er udregnet, ikke gættet — se services/posFinance.js.
router.get('/payouts', requireAuth(), handle((req, res) => {
    const db = getDb();
    const rows = db.prepare(`
        SELECT p.*, t.dato AS tx_dato, t.tekst AS tx_tekst, t.beloeb AS tx_beloeb
        FROM pos_payouts p
        LEFT JOIN cf_transactions t ON t.id = p.cf_transaction_id
        WHERE p.source = ? ORDER BY p.occurred_at DESC
    `).all(SOURCE);

    // Kandidater til de umatchede: samme beløb, og datoen efter udbetalingen.
    const open = db.prepare(`
        SELECT t.id, t.dato, t.tekst, t.beloeb FROM cf_transactions t
        WHERE t.beloeb > 0 AND NOT EXISTS (SELECT 1 FROM cf_allocations a WHERE a.transaction_id = t.id)
    `).all();

    res.json({
        payouts: rows.map(r => {
            const meta = parse(r.covered_json, {});
            const p = {
                payout_uuid: r.payout_uuid,
                occurred_at: r.occurred_at,
                amount_incl: r.amount_incl,
                gross_incl: r.gross_incl,
                fee_incl: r.fee_incl,
                covered: meta.covered || [],
                partial: !!meta.partial,
                cf_transaction_id: r.cf_transaction_id,
                matched_at: r.matched_at,
                bank: r.cf_transaction_id ? { dato: r.tx_dato, tekst: r.tx_tekst, beloeb: r.tx_beloeb } : null,
            };
            if (!r.cf_transaction_id) p.candidates = suggestBankMatch(p, open);
            return p;
        }),
    });
}));

/* ── POST /api/pos/payouts/:uuid/match ─────────────────────────────────── */
router.post('/payouts/:uuid/match', requireAuth(), handle((req, res) => {
    const db = getDb();
    const transactionId = Number(req.body?.transaction_id);
    if (!Number.isInteger(transactionId)) {
        return res.status(400).json({ error: 'transaction_id skal være et tal' });
    }
    try {
        res.json(matchPayout(db, { payoutUuid: req.params.uuid, transactionId, userId: req.session?.userId ?? null }));
    } catch (err) {
        const status = {
            unknown_payout: 404, unknown_transaction: 404,
            already_matched: 409, already_allocated: 409,
            amount_mismatch: 400, allocation_mismatch: 409,
        }[err.code] || 500;
        if (status === 500) throw err;
        res.status(status).json({ error: err.message, code: err.code, ...(err.sum !== undefined ? { sum: err.sum, expected: err.expected } : {}) });
    }
}));

/* ── POST /api/pos/finance/sync ────────────────────────────────────────── */
router.post('/finance/sync', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const { from, to } = req.body || {};
    if (from && !DATE_RE.test(from)) return res.status(400).json({ error: 'from skal være YYYY-MM-DD' });
    if (to && !DATE_RE.test(to)) return res.status(400).json({ error: 'to skal være YYYY-MM-DD' });
    res.json(await syncFinance(db, { from: from || null, to: to || null, userId: req.session?.userId ?? null }));
}));

/* ── GET /api/pos/health ───────────────────────────────────────────────── */
// Til Settings-panelet. Kaster ikke: et panel der ikke kan vises, er præcis
// hvad der skjuler en død integration.
router.get('/health', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const cfg = getPosSettings(db);
    const zettle = getZettleAdapter();
    const health = cfg.enabled ? await zettle.healthCheck()
        : { ok: false, configured: zettle.isConfigured(), reason: 'Slukket i indstillinger (zettle_enabled)' };

    const stats = db.prepare(`
        SELECT COUNT(*) AS days,
               SUM(CASE WHEN assign_status IN ('unassigned','ambiguous') THEN 1 ELSE 0 END) AS unassigned,
               SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
               MAX(last_synced_at) AS last_synced_at
        FROM pos_sales_days WHERE source = ?
    `).get(SOURCE);

    const unmatchedCount = db.prepare(`
        SELECT COUNT(*) AS n FROM pos_sales_days
        WHERE source = ? AND unmatched_json IS NOT NULL AND unmatched_json NOT IN ('[]','')
    `).get(SOURCE).n;

    res.json({
        enabled: cfg.enabled,
        settings: { cutoff: cfg.cutoff, poll_minutes: cfg.pollMinutes, resync_days: cfg.resyncDays, price_category: cfg.priceCategory },
        connection: health,
        days: stats.days || 0,
        unassigned_days: stats.unassigned || 0,
        days_with_errors: stats.errors || 0,
        days_with_unmatched: unmatchedCount,
        last_synced_at: stats.last_synced_at,
    });
}));

module.exports = router;
