#!/usr/bin/env node
/**
 * scripts/test-crm-ringeliste.js
 * ════════════════════════════════════════════════════════════
 * CRM-triks (#230) — ringeliste-endpoints GET /api/crm/season + /rytme.
 *
 * Hermetisk unit-test: frisk temp-DB via DB_PATH, kører ALLE migrations
 * (inkl. 123_fast_rytme_purpose.sql), seeder fixtures og kører detektions-
 * queries'ne fra routes/crm.js (/season + /rytme) direkte. Rører ALDRIG den
 * rigtige data/bon.db (præcedens: scripts/test-crm-review.js).
 *
 * Queries'ne spejler routes/crm.js — hold de to i sync ved ændringer.
 *
 * Dækker T_CRM_SEASON_* + T_CRM_RYTME_* (docs/CLAUDE_CRM_TRIKS.md §2.3 + §3.3)
 * + snooze-filteret (type 'season' / 'rytme').
 *
 * Brug:  node --experimental-sqlite scripts/test-crm-ringeliste.js
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ringe-'));
const tmpDb  = path.join(tmpDir, 'test.db');
process.env.DB_PATH = tmpDb;

const { getDb } = require('../db/database');   // kører migrations mod tmpDb

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function cleanup() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

// ─── Query-spejle (identiske med routes/crm.js) ──────────────
const SEASON_SQL = `
    SELECT c.id AS customer_id
    FROM bons b1
    JOIN customers c ON b1.customer_id = c.id
    JOIN companies co ON b1.company_id = co.id
    WHERE b1.is_internal = 0
        AND co.is_internal = 0
        AND b1.delivery_date BETWEEN date('now', '-14 months') AND date('now', '-10 months')
        AND NOT EXISTS (
            SELECT 1 FROM bons b2
            WHERE b2.customer_id = c.id AND b2.delivery_date > date('now', '-60 days') AND b2.is_internal = 0
        )
        AND NOT EXISTS (
            SELECT 1 FROM crm_activities a
            WHERE a.customer_id = c.id AND a.created_at > date('now', '-30 days')
        )
        AND NOT EXISTS (
            SELECT 1 FROM crm_suggestion_snoozes sz
            WHERE sz.customer_id = c.id AND sz.type = 'season' AND sz.snoozed_until > datetime('now')
        )
    GROUP BY c.id`;

const RYTME_SQL = `
    SELECT c.id AS customer_id
    FROM customers c
    JOIN companies co ON c.company_id = co.id
    JOIN crm_customer_meta cm ON c.id = cm.customer_id
    JOIN (
        SELECT b1.customer_id,
               COUNT(*) AS order_count,
               MAX(b1.delivery_date) AS last_order,
               CAST(julianday('now') - julianday(MAX(b1.delivery_date)) AS INTEGER) AS days_since,
               ROUND(CAST(julianday(MAX(b1.delivery_date)) - julianday(MIN(b1.delivery_date)) AS REAL)
                     / NULLIF(COUNT(*) - 1, 0), 0) AS avg_interval_days
        FROM bons b1 WHERE b1.is_internal = 0 GROUP BY b1.customer_id HAVING COUNT(*) >= 5
    ) ostats ON ostats.customer_id = c.id
    WHERE co.is_internal = 0
        AND cm.stage IN ('active', 'vip')
        AND ostats.avg_interval_days > 0
        AND ostats.days_since > ostats.avg_interval_days * 1.3
        AND ostats.days_since < ostats.avg_interval_days * 3
        AND NOT EXISTS (
            SELECT 1 FROM crm_suggestion_snoozes sz
            WHERE sz.customer_id = c.id AND sz.type = 'rytme' AND sz.snoozed_until > datetime('now')
        )`;

const COLD_OFFER_SQL = `
    SELECT b.id AS bon_id, b.customer_id
    FROM bons b
    JOIN customers c ON b.customer_id = c.id
    LEFT JOIN companies co ON b.company_id = co.id
    WHERE b.is_offer = 1
        AND b.offer_status = 'sent'
        AND b.offer_valid_until < date('now')
        AND b.offer_valid_until > date('now', '-365 days')
        AND (co.is_internal = 0 OR co.id IS NULL)
        AND NOT EXISTS (
            SELECT 1 FROM crm_activities a
            JOIN activity_purposes ap ON ap.id = a.purpose_id
            WHERE a.bon_id = b.id AND ap.key = 'tilbud_opfoelgning'
                AND a.created_at > date('now', '-90 days')
        )
        AND NOT EXISTS (
            SELECT 1 FROM crm_suggestion_snoozes sz
            WHERE sz.customer_id = c.id AND sz.type = 'cold_offer' AND sz.snoozed_until > datetime('now')
        )
    ORDER BY b.offer_valid_until DESC`;

try {
    const db = getDb();

    // Bekræft migration 123
    const fastRytme = db.prepare(`SELECT id FROM activity_purposes WHERE key = 'fast_rytme'`).get()?.id;
    assert(!!fastRytme, 'migration 123 seedede purpose \'fast_rytme\'');
    const saeson = db.prepare(`SELECT id FROM activity_purposes WHERE key = 'saesonoutreach'`).get()?.id;
    assert(!!saeson, 'purpose \'saesonoutreach\' findes (migration 048)');
    const tilbudPurposeId = db.prepare(`SELECT id FROM activity_purposes WHERE key = 'tilbud_opfoelgning'`).get()?.id;
    assert(!!tilbudPurposeId, 'migration 124 seedede purpose \'tilbud_opfoelgning\'');

    // ─── Setup-helpers ────────────────────────────────────────
    const statusId = db.prepare(`SELECT id FROM status_definitions ORDER BY id LIMIT 1`).get()?.id;
    const coNormal   = Number(db.prepare(`INSERT INTO companies (name, is_internal) VALUES ('Normal A/S', 0)`).run().lastInsertRowid);
    const coInternal = Number(db.prepare(`INSERT INTO companies (name, is_internal) VALUES ('RR Intern', 1)`).run().lastInsertRowid);

    function mkCustomer(first, companyId, stage) {
        const cid = Number(db.prepare(
            `INSERT INTO customers (company_id, first_name, phone) VALUES (?, ?, '12345678')`
        ).run(companyId, first).lastInsertRowid);
        if (stage) db.prepare(`INSERT INTO crm_customer_meta (customer_id, stage) VALUES (?, ?)`).run(cid, stage);
        return cid;
    }
    let _bonSeq = 0;
    function mkBon(customerId, companyId, daysAgo, { pax = 20, price = 5000, internal = 0 } = {}) {
        db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id, order_date, delivery_date, pax, total_price, is_internal)
            VALUES (?, ?, 1, ?, ?, date('now', ?), date('now', ?), ?, ?, ?)
        `).run('T-RINGE-' + (++_bonSeq), statusId, customerId, companyId, '-' + daysAgo + ' days', '-' + daysAgo + ' days', pax, price, internal);
    }
    function logActivity(customerId, daysAgo) {
        db.prepare(`INSERT INTO crm_activities (customer_id, type, text, created_at)
                    VALUES (?, 'note', 'x', datetime('now', ?))`).run(customerId, '-' + daysAgo + ' days');
    }
    function snooze(customerId, type) {
        db.prepare(`INSERT INTO crm_suggestion_snoozes (customer_id, type, snoozed_until)
                    VALUES (?, ?, datetime('now', '+14 days'))`).run(customerId, type);
    }
    // Opret et tilbud (is_offer=1). validUntil = SQLite-modifier ift. 'now'
    // ('-30 days' = udløbet, '+30 days' = gyldigt). Returnerer bon_id.
    function mkOffer(customerId, companyId, { validUntil = '-30 days', status = 'sent', total = 12000 } = {}) {
        return Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, customer_id, company_id,
                              order_date, delivery_date, total_price, is_offer, offer_status, offer_valid_until)
            VALUES (?, ?, 1, ?, ?, date('now','-200 days'), date('now'), ?, 1, ?, date('now', ?))
        `).run('T-OFF-' + (++_bonSeq), statusId, customerId, companyId, total, status, validUntil).lastInsertRowid);
    }
    function logOfferFollowup(customerId, bonId, daysAgo) {
        db.prepare(`INSERT INTO crm_activities (customer_id, bon_id, type, text, purpose_id, created_at)
                    VALUES (?, ?, 'call', 'fulgte op', ?, datetime('now', ?))`)
            .run(customerId, bonId, tilbudPurposeId, '-' + daysAgo + ' days');
    }

    // ─── SÆSON-fixtures ───────────────────────────────────────
    // S01 — ordre ~365 dage siden, intet nyt, ingen aktivitet → med
    const s01 = mkCustomer('S01', coNormal, 'active');  mkBon(s01, coNormal, 365);
    // S02 — samme, MEN også en ordre inden for 60 dage → ekskluderet
    const s02 = mkCustomer('S02', coNormal, 'active');  mkBon(s02, coNormal, 365); mkBon(s02, coNormal, 20);
    // S03 — samme, MEN aktivitet inden for 30 dage → ekskluderet
    const s03 = mkCustomer('S03', coNormal, 'active');  mkBon(s03, coNormal, 365); logActivity(s03, 10);
    // S04 — internt firma → ekskluderet
    const s04 = mkCustomer('S04', coInternal, 'active'); mkBon(s04, coInternal, 365);
    // S05 — snoozet (type 'season') → ekskluderet
    const s05 = mkCustomer('S05', coNormal, 'active');  mkBon(s05, coNormal, 365); snooze(s05, 'season');
    // S06 — ordre for kun 5 mdr. siden (uden for 10-14 mdr.-vinduet) → ekskluderet
    const s06 = mkCustomer('S06', coNormal, 'active');  mkBon(s06, coNormal, 150);

    const seasonIds = new Set(db.prepare(SEASON_SQL).all().map(r => r.customer_id));
    console.log('\n=== T_CRM_SEASON ===');
    assert(seasonIds.has(s01),  'T_CRM_SEASON_01 — ordre i 10-14 mdr.-vinduet uden nyt → med');
    assert(!seasonIds.has(s02), 'T_CRM_SEASON_02 — ordre inden for 60 dage → ekskluderet');
    assert(!seasonIds.has(s03), 'T_CRM_SEASON_03 — aktivitet < 30 dage → ekskluderet');
    assert(!seasonIds.has(s04), 'T_CRM_SEASON_04 — internt firma → ekskluderet');
    assert(!seasonIds.has(s05), 'T_CRM_SEASON_05 — snoozet (season) → ekskluderet');
    assert(!seasonIds.has(s06), 'T_CRM_SEASON_06 — uden for 10-14 mdr.-vindue → ekskluderet');

    // ─── RYTME-fixtures ───────────────────────────────────────
    // R01 — 5 ordrer, days_since i (1.3×, 3×) snit, active → med
    // datoer: 400,340,280,220,160 → snit 60, days_since 160 ∈ (78,180)
    const r01 = mkCustomer('R01', coNormal, 'active');
    [400, 340, 280, 220, 160].forEach(d => mkBon(r01, coNormal, d));
    // R02 — kun 4 ordrer → HAVING >=5 fejler → ekskluderet
    const r02 = mkCustomer('R02', coNormal, 'active');
    [400, 300, 200, 100].forEach(d => mkBon(r02, coNormal, d));
    // R03 — 5 ordrer men reelt sovende (days_since > 3× snit) → ekskluderet (hører til dormant)
    // datoer: 800,740,680,620,560 → snit 60, days_since 560 > 180
    const r03 = mkCustomer('R03', coNormal, 'active');
    [800, 740, 680, 620, 560].forEach(d => mkBon(r03, coNormal, d));
    // R04 — 5 ordrer men på tid (days_since < 1.3× snit) → ekskluderet
    // datoer: 300,240,180,120,40 → snit 65, days_since 40 < 84.5
    const r04 = mkCustomer('R04', coNormal, 'active');
    [300, 240, 180, 120, 40].forEach(d => mkBon(r04, coNormal, d));
    // R05 — samme mønster som R01 men stage 'lead' → ekskluderet
    const r05 = mkCustomer('R05', coNormal, 'lead');
    [400, 340, 280, 220, 160].forEach(d => mkBon(r05, coNormal, d));
    // R06 — samme mønster som R01 men snoozet (type 'rytme') → ekskluderet
    const r06 = mkCustomer('R06', coNormal, 'active');
    [400, 340, 280, 220, 160].forEach(d => mkBon(r06, coNormal, d));
    snooze(r06, 'rytme');

    const rytmeIds = new Set(db.prepare(RYTME_SQL).all().map(r => r.customer_id));
    console.log('\n=== T_CRM_RYTME ===');
    assert(rytmeIds.has(r01),  'T_CRM_RYTME_01 — ≥5 ordrer, forsinket i (1.3×,3×) → med');
    assert(!rytmeIds.has(r02), 'T_CRM_RYTME_02 — kun 4 ordrer → ekskluderet');
    assert(!rytmeIds.has(r03), 'T_CRM_RYTME_03 — days_since > 3× snit (dormant) → ekskluderet');
    assert(!rytmeIds.has(r04), 'T_CRM_RYTME_04 — på tid (< 1.3× snit) → ekskluderet');
    assert(!rytmeIds.has(r05), 'T_CRM_RYTME_05 — stage \'lead\' → ekskluderet');
    assert(!rytmeIds.has(r06), 'T_CRM_RYTME_06 — snoozet (rytme) → ekskluderet');

    // ─── snooze-uafhængighed pr. type ─────────────────────────
    // En 'season'-snooze må IKKE skjule kunden i rytme-listen og omvendt.
    console.log('\n=== snooze pr. type ===');
    const x = mkCustomer('X', coNormal, 'active');
    [400, 340, 280, 220, 160].forEach(d => mkBon(x, coNormal, d));   // rytme-emne
    snooze(x, 'season');   // snooze KUN på season-typen
    const rytmeAfter = new Set(db.prepare(RYTME_SQL).all().map(r => r.customer_id));
    assert(rytmeAfter.has(x), 'SNOOZE — season-snooze påvirker ikke rytme-listen (type-isoleret)');

    // ─── COLD OFFER-fixtures (#228) ───────────────────────────
    const cco = mkCustomer('CO', coNormal, 'active');
    // CO01 — sendt tilbud udløbet for 30 dage siden, ingen opfølgning → med
    const o01 = mkOffer(cco, coNormal, { validUntil: '-30 days' });
    // CO02 — sendt+udløbet MEN fulgt op (bon_id + purpose) for 5 dage siden → ekskluderet
    const o02 = mkOffer(cco, coNormal, { validUntil: '-30 days' }); logOfferFollowup(cco, o02, 5);
    // CO03 — udløbet for 400 dage siden (> 365 max age) → ekskluderet
    const o03 = mkOffer(cco, coNormal, { validUntil: '-400 days' });
    // CO04 — status 'draft' (ikke sendt) → ekskluderet
    const o04 = mkOffer(cco, coNormal, { validUntil: '-30 days', status: 'draft' });
    // CO05 — gyldigt endnu (udløber om 30 dage) → ekskluderet
    const o05 = mkOffer(cco, coNormal, { validUntil: '+30 days' });
    // CO06 — sendt+udløbet men snoozet (cold_offer) → ekskluderet (kunde-niveau snooze)
    const ccoSnooze = mkCustomer('COsz', coNormal, 'active');
    const o06 = mkOffer(ccoSnooze, coNormal, { validUntil: '-30 days' }); snooze(ccoSnooze, 'cold_offer');
    // CO07 — internt firma → ekskluderet
    const ccoInt = mkCustomer('COint', coInternal, 'active');
    const o07 = mkOffer(ccoInt, coInternal, { validUntil: '-30 days' });

    const coldIds = new Set(db.prepare(COLD_OFFER_SQL).all().map(r => r.bon_id));
    console.log('\n=== T_CRM_COLD_OFFER ===');
    assert(coldIds.has(o01),  'T_CRM_COLD_01 — sendt+udløbet uden opfølgning → med');
    assert(!coldIds.has(o02), 'T_CRM_COLD_02 — allerede fulgt op (dedupe pr. tilbud) → ekskluderet');
    assert(!coldIds.has(o03), 'T_CRM_COLD_03 — udløbet > 365 dage → ekskluderet');
    assert(!coldIds.has(o04), 'T_CRM_COLD_04 — draft (ikke sendt) → ekskluderet');
    assert(!coldIds.has(o05), 'T_CRM_COLD_05 — endnu gyldigt → ekskluderet');
    assert(!coldIds.has(o06), 'T_CRM_COLD_06 — snoozet (cold_offer) → ekskluderet');
    assert(!coldIds.has(o07), 'T_CRM_COLD_07 — internt firma → ekskluderet');

    // Per-tilbud dedupe: samme kunde har to kolde tilbud; opfølgning på det ene (o02)
    // må IKKE skjule det andet (o01). o01 er stadig med, o02 væk — bevist ovenfor.
    assert(coldIds.has(o01) && !coldIds.has(o02),
        'T_CRM_COLD_08 — opfølgning er pr. tilbud, ikke pr. kunde (o01 bliver, o02 væk)');

    console.log(`\n${pass} passed · ${fail} failed`);
    cleanup();
    process.exit(fail ? 1 : 0);
} catch (err) {
    console.error('\nFEJL:', err);
    cleanup();
    process.exit(1);
}
