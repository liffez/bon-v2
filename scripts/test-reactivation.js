// scripts/test-reactivation.js
// ==========================================
// Tests for justerbare re-aktiverings-tærskler (min. ordrer + karantæne).
// Isoleret temp-DB. Verificerer getReactivationConfig + getReactivationCandidates.
//
//   node --experimental-sqlite scripts/test-reactivation.js
// ==========================================

const path = require('path');
const os = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-reak-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const { getReactivationConfig, getReactivationCandidates } = require('../services/rfm');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}

const db = getDb();

function company(name) {
    return Number(db.prepare(
        'INSERT INTO companies (name, is_active, is_personal) VALUES (?,1,0)'
    ).run(name).lastInsertRowid);
}
function customer(companyId, name) {
    return Number(db.prepare(
        'INSERT INTO customers (company_id, first_name, is_active, is_primary_contact) VALUES (?,?,1,1)'
    ).run(companyId, name).lastInsertRowid);
}
function dormantScore(companyId, orderCount, daysSince) {
    db.prepare(`INSERT INTO rfm_scores (company_id, stage, order_count, days_since_last, f_score, m_score, computed_at)
                VALUES (?, 'dormant', ?, ?, 70, 60, datetime('now'))`).run(companyId, orderCount, daysSince);
}
function recentActivity(customerId, daysAgo) {
    db.prepare(`INSERT INTO crm_activities (customer_id, type, text, created_at)
                VALUES (?, 'call', 'kontakt', datetime('now', ?))`).run(customerId, '-' + daysAgo + ' days');
}

// Seed: alle sovende (days_since_last 200 > recency 180)
const C1 = company('ZZ Mange ordrer');     customer(C1, 'A'); dormantScore(C1, 5, 200);  // kandidat
const C2 = company('ZZ Faa ordrer');       customer(C2, 'B'); dormantScore(C2, 1, 200);  // < min 2 → ude
const C3 = company('ZZ Lige kontaktet');   const c3cust = customer(C3, 'C'); dormantScore(C3, 4, 200);
recentActivity(c3cust, 5);                 // kontaktet for 5 dage siden → karantæne udelukker
const C4 = company('ZZ Tre ordrer');       customer(C4, 'D'); dormantScore(C4, 3, 200);  // kandidat ved min 2

const names = r => r.rows.map(x => x.name);

// ─── Default (min 2, karantæne 30) ──────────────────────────
console.log('\ndefault-tærskler');
{
    const cfg = getReactivationConfig(db);
    assert(cfg.min_orders === 2, 'default min_orders = 2');
    assert(cfg.quarantine_days === 30, 'default karantæne = 30 dage');
    assert(cfg.recency_days === 180, 'recency fra rfm_config = 180');

    const res = getReactivationCandidates(db);
    const n = names(res);
    assert(n.includes('ZZ Mange ordrer'), '5 ordrer → med');
    assert(!n.includes('ZZ Faa ordrer'), '1 ordre (< min 2) → ude');
    assert(!n.includes('ZZ Lige kontaktet'), 'kontaktet for 5 dage siden → ude (karantæne)');
    assert(n.includes('ZZ Tre ordrer'), '3 ordrer, ikke kontaktet → med');
    assert(res.config.min_orders === 2, 'config følger med i svaret');
    // last_order_detail-felt er til stede (null her — ingen bons seedet)
    assert('last_order_detail' in res.rows[0], 'last_order_detail-felt sat på rækker');
}

// ─── Hævet min_orders = 4 ───────────────────────────────────
console.log('\nmin_orders = 4');
{
    db.prepare("UPDATE settings SET value='4' WHERE key='reactivation_min_orders'").run();
    const res = getReactivationCandidates(db);
    const n = names(res);
    assert(res.config.min_orders === 4, 'settings-ændring respekteres');
    assert(n.includes('ZZ Mange ordrer'), '5 ordrer ≥ 4 → med');
    assert(!n.includes('ZZ Tre ordrer'), '3 ordrer < 4 → nu ude');
    db.prepare("UPDATE settings SET value='2' WHERE key='reactivation_min_orders'").run();
}

// ─── Karantæne = 0 (vis alle uanset seneste kontakt) ────────
console.log('\nkarantæne = 0');
{
    db.prepare("UPDATE settings SET value='0' WHERE key='reactivation_quarantine_days'").run();
    const res = getReactivationCandidates(db);
    assert(res.config.quarantine_days === 0, 'karantæne 0 respekteres');
    assert(names(res).includes('ZZ Lige kontaktet'), 'med karantæne 0 vises nyligt kontaktet firma igen');
    db.prepare("UPDATE settings SET value='30' WHERE key='reactivation_quarantine_days'").run();
}

// ─── Ugyldig værdi → fallback ───────────────────────────────
console.log('\nfallback ved ugyldig værdi');
{
    db.prepare("UPDATE settings SET value='' WHERE key='reactivation_min_orders'").run();
    assert(getReactivationConfig(db).min_orders === 2, 'tom værdi → fallback 2');
    db.prepare("UPDATE settings SET value='2' WHERE key='reactivation_min_orders'").run();
}

// ─── Snooze fra Ringeliste-Sovende ("🙈 Skjul", type 'reaktivering') ───
console.log('\nsnooze-filter (Ringeliste Sovende)');
{
    const C5 = company('ZZ Snooze-kandidat');
    const c5cust = customer(C5, 'E');
    dormantScore(C5, 5, 200);
    assert(names(getReactivationCandidates(db)).includes('ZZ Snooze-kandidat'), 'kandidat før snooze → med');

    db.prepare(`INSERT INTO crm_suggestion_snoozes (customer_id, type, snoozed_until)
                VALUES (?, 'reaktivering', datetime('now','+14 days'))`).run(c5cust);
    assert(!names(getReactivationCandidates(db)).includes('ZZ Snooze-kandidat'), 'snoozet (reaktivering) → ude');

    // Anden snooze-type må ikke påvirke reaktiverings-listen (type-isoleret)
    const C6 = company('ZZ Anden-snooze');
    const c6cust = customer(C6, 'F');
    dormantScore(C6, 5, 200);
    db.prepare(`INSERT INTO crm_suggestion_snoozes (customer_id, type, snoozed_until)
                VALUES (?, 'season', datetime('now','+14 days'))`).run(c6cust);
    assert(names(getReactivationCandidates(db)).includes('ZZ Anden-snooze'), 'season-snooze påvirker ikke reaktivering');

    // Udløbet snooze tæller ikke
    db.prepare(`UPDATE crm_suggestion_snoozes SET snoozed_until=datetime('now','-1 days')
                WHERE customer_id=? AND type='reaktivering'`).run(c5cust);
    assert(names(getReactivationCandidates(db)).includes('ZZ Snooze-kandidat'), 'udløbet snooze → med igen');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
