#!/usr/bin/env node
/**
 * scripts/test-crm-review.js
 * ════════════════════════════════════════════════════════════
 * CRM-trik Fase 1 — "anbefaling efter glad kunde" (review_ask).
 *
 * Hermetisk unit-test: opretter en frisk temp-DB via DB_PATH, kører
 * ALLE migrations (inkl. 108_anbefaling_purpose.sql), seeder fixtures
 * og kører detektions-query'en fra routes/crm.js §6 direkte.
 * Rører ALDRIG den rigtige data/bon.db (præcedens: scripts/test-delivery-*-unit.js).
 *
 * Query'en spejler GET /suggestions §6 — hold de to i sync ved ændringer.
 *
 * Dækker spec'ens T_CRM_REVIEW_01..05 (docs/CLAUDE_CRM_TRIKS.md §1.4)
 * + to revisionsforbedringer (privatkunde inkluderet, do_not_contact ekskluderet).
 *
 * Brug:
 *   node --experimental-sqlite scripts/test-crm-review.js
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

// Peg DB'en på en frisk temp-fil FØR db/database kræves ind.
const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-review-'));
const tmpDb   = path.join(tmpDir, 'test.db');
process.env.DB_PATH = tmpDb;

const { getDb } = require('../db/database');   // kører migrations mod tmpDb

const REVIEW_POSITIVE_WINDOW_DAYS = 21;
const REVIEW_DEDUPE_DAYS          = 180;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}

function cleanup() {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

try {
    const db = getDb();

    // ─── Setup ────────────────────────────────────────────────
    const anbefalingId = db.prepare(
        `SELECT id FROM activity_purposes WHERE key = 'anbefaling'`
    ).get()?.id;
    assert(!!anbefalingId, 'migration 108 seedede purpose \'anbefaling\'');

    const coNormal = Number(db.prepare(
        `INSERT INTO companies (name, is_internal) VALUES ('Normal A/S', 0)`
    ).run().lastInsertRowid);
    const coInternal = Number(db.prepare(
        `INSERT INTO companies (name, is_internal) VALUES ('RR Intern', 1)`
    ).run().lastInsertRowid);

    function mkCustomer(first, companyId, stage, opts = {}) {
        const cid = Number(db.prepare(
            `INSERT INTO customers (company_id, first_name, phone) VALUES (?, ?, '12345678')`
        ).run(companyId, first).lastInsertRowid);
        db.prepare(
            `INSERT INTO crm_customer_meta (customer_id, stage, do_not_contact) VALUES (?, ?, ?)`
        ).run(cid, stage, opts.dnc ? 1 : 0);
        return cid;
    }

    // type='note' er gyldigt; sentiment/purpose sættes eksplicit. created_at styres.
    function logActivity(customerId, { daysAgo, sentiment = null, purposeId = null, text = 'x' }) {
        db.prepare(`
            INSERT INTO crm_activities (customer_id, type, text, sentiment, purpose_id, created_at)
            VALUES (?, 'note', ?, ?, ?, datetime('now', ?))
        `).run(customerId, text, sentiment, purposeId, '-' + daysAgo + ' days');
    }

    // C01 — frisk positiv, active, ingen anbefaling → med
    const c01 = mkCustomer('C01', coNormal, 'active');
    logActivity(c01, { daysAgo: 5, sentiment: 'positive', text: 'Alt smagte skønt' });

    // C02 — frisk positiv MEN allerede spurgt for nylig → dedupe væk
    const c02 = mkCustomer('C02', coNormal, 'active');
    logActivity(c02, { daysAgo: 5, sentiment: 'positive' });
    logActivity(c02, { daysAgo: 5, purposeId: anbefalingId, text: 'Bedt om anbefaling' });

    // C03 — seneste stemning er neutral (ældre positiv findes) → IKKE med
    const c03 = mkCustomer('C03', coNormal, 'active');
    logActivity(c03, { daysAgo: 40, sentiment: 'positive' });
    logActivity(c03, { daysAgo: 3,  sentiment: 'neutral' });

    // C04 — frisk positiv + anbefaling for 200 dage siden → med igen (vindue udløbet)
    const c04 = mkCustomer('C04', coNormal, 'active');
    logActivity(c04, { daysAgo: 5,   sentiment: 'positive' });
    logActivity(c04, { daysAgo: 200, purposeId: anbefalingId, text: 'Bedt om anbefaling (gammel)' });

    // C05 — internt firma → ekskluderet
    const c05 = mkCustomer('C05', coInternal, 'active');
    logActivity(c05, { daysAgo: 5, sentiment: 'positive' });

    // C06 (revision) — privatkunde uden firma → med
    const c06 = mkCustomer('C06', null, 'active');
    logActivity(c06, { daysAgo: 5, sentiment: 'positive' });

    // C07 (revision) — do_not_contact → ekskluderet
    const c07 = mkCustomer('C07', coNormal, 'active', { dnc: true });
    logActivity(c07, { daysAgo: 5, sentiment: 'positive' });

    // C08 — positiv men uden for 21-dages-vinduet → IKKE med
    const c08 = mkCustomer('C08', coNormal, 'active');
    logActivity(c08, { daysAgo: 30, sentiment: 'positive' });

    // C09 — stage 'lead' (ikke active/vip) → IKKE med
    const c09 = mkCustomer('C09', coNormal, 'lead');
    logActivity(c09, { daysAgo: 5, sentiment: 'positive' });

    // ─── Kør detektions-query'en (spejl af routes/crm.js §6) ───
    const rows = db.prepare(`
        SELECT c.id AS customer_id
        FROM crm_activities a
        JOIN customers c ON c.id = a.customer_id
        LEFT JOIN companies co ON c.company_id = co.id
        JOIN crm_customer_meta cm ON cm.customer_id = c.id
        WHERE a.sentiment = 'positive'
            AND a.created_at > date('now', ?)
            AND cm.stage IN ('active', 'vip')
            AND (co.is_internal = 0 OR co.id IS NULL)
            AND a.id = (
                SELECT a2.id FROM crm_activities a2
                WHERE a2.customer_id = c.id AND a2.sentiment IS NOT NULL
                ORDER BY a2.created_at DESC LIMIT 1
            )
            AND NOT EXISTS (
                SELECT 1 FROM crm_activities a3
                JOIN activity_purposes ap ON ap.id = a3.purpose_id
                WHERE a3.customer_id = c.id
                    AND ap.key = 'anbefaling'
                    AND a3.created_at > date('now', ?)
            )
            AND COALESCE(cm.do_not_contact, 0) != 1
        ORDER BY a.created_at DESC
        LIMIT 6
    `).all('-' + REVIEW_POSITIVE_WINDOW_DAYS + ' days', '-' + REVIEW_DEDUPE_DAYS + ' days');

    const ids = new Set(rows.map(r => r.customer_id));

    // ─── Assertions ───────────────────────────────────────────
    console.log('\n=== T_CRM_REVIEW ===');
    assert(ids.has(c01),  'T_CRM_REVIEW_01 — frisk positiv kunde optræder');
    assert(!ids.has(c02), 'T_CRM_REVIEW_02 — allerede spurgt (dedupe) → forsvundet');
    assert(!ids.has(c03), 'T_CRM_REVIEW_03 — seneste stemning neutral → ekskluderet');
    assert(ids.has(c04),  'T_CRM_REVIEW_04 — anbefaling 200d siden → optræder igen');
    assert(!ids.has(c05), 'T_CRM_REVIEW_05 — internt firma → ekskluderet');
    assert(ids.has(c06),  'REV — privatkunde uden firma → optræder');
    assert(!ids.has(c07), 'REV — do_not_contact → ekskluderet');
    assert(!ids.has(c08), 'REV — positiv uden for 21-dages-vindue → ekskluderet');
    assert(!ids.has(c09), 'REV — stage \'lead\' → ekskluderet');

    // ─── interleaveSuggestions (round-robin feed-budget, revision idé ①) ───
    // Ren funktion — ingen DB. Sikrer at review_ask ikke begraves bag sæson/overdue.
    const { interleaveSuggestions } = require('../routes/crm');
    const fake = [
        { type: 'overdue_customer', priority: 2, id: 'o1' },
        ...Array.from({ length: 7 }, (_, i) => ({ type: 'season_reminder', priority: 2, id: 's' + i })),
        { type: 'review_ask', priority: 2, id: 'r1' },
        { type: 'review_ask', priority: 2, id: 'r2' },
    ];
    const out = interleaveSuggestions(fake);
    const top8 = out.slice(0, 8).map(s => s.type);

    console.log('\n=== interleaveSuggestions ===');
    assert(out.length === fake.length, 'RR — alle forslag bevares (intet tabt)');
    assert(out[0].type === 'overdue_customer', 'RR — overdue først (type-rækkefølge)');
    assert(out[1].type === 'review_ask', 'RR — review_ask i top, ikke begravet bag sæson');
    assert(top8.filter(t => t === 'review_ask').length === 2, 'RR — begge review-kort i top-8');
    assert(top8.filter(t => t === 'season_reminder').length <= 6, 'RR — sæson mætter ikke længere top-8');

    const pr = interleaveSuggestions([
        { type: 'review_ask', priority: 3, id: 'low' },
        { type: 'review_ask', priority: 1, id: 'high' },
    ]);
    assert(pr[0].id === 'high' && pr[1].id === 'low', 'RR — priority bevares inden for type');

    console.log(`\n${pass} passed · ${fail} failed`);
    cleanup();
    process.exit(fail ? 1 : 0);
} catch (err) {
    console.error('\nFEJL:', err);
    cleanup();
    process.exit(1);
}
