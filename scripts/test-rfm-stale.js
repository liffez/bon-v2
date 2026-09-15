// scripts/test-rfm-stale.js
// ==========================================
// RFM-genberegning: en score må ikke overleve de bons den er regnet på.
//
// Drifts-fund 15/9 2026: Scalepoint Technologies Denmark A/S stod som VIP nr. 1
// med 56 ordrer og "Sidst ordre 2027-03-04 · -317d" — men havde 0 bons. De 56
// var flyttet til Able (formidler) i april, og rfm_scores-rækken blev aldrig
// rørt igen: upsertet rammer kun firmaer MED ordrer, lead-fallbacken kun
// firmaer der slet ikke står i tabellen. Og "-317d" var en bon med tastefejl
// i året (2027), som gav negativ recency.
//
// Isoleret temp-DB af de rigtige migrations. Ingen server, ingen Grocy.
//
//   node --experimental-sqlite scripts/test-rfm-stale.js
// ==========================================

const path = require('path');
const os = require('os');
const fs = require('fs');

const TEST_DB = path.join(os.tmpdir(), `bon-test-rfm-stale-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const { offsetISO } = require('../db/helpers');
const { computeRfmScores } = require('../services/rfm');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}

const db = getDb();
const STATUS_LEVERET = db.prepare("SELECT id FROM status_definitions WHERE code='LEVERET'").get().id;
const CAT_ID = db.prepare("SELECT id FROM price_categories WHERE code='catering'").get()?.id ?? null;
let bonSeq = 0;

function company(name) {
    return Number(db.prepare(
        'INSERT INTO companies (name, is_active, is_personal) VALUES (?,1,0)'
    ).run(name).lastInsertRowid);
}
function bon(companyId, deliveryDate, { pax = 20, price = 2000 } = {}) {
    return Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, price_category_id, company_id,
                          order_date, delivery_date, delivery_type, pax, total_price,
                          is_offer, is_internal)
        VALUES (?,?,1,?,?,date('now'),?,'delivery',?,?,0,0)
    `).run(`T_RFM_${++bonSeq}`, STATUS_LEVERET, CAT_ID, companyId, deliveryDate, pax, price).lastInsertRowid);
}
const score = id => db.prepare('SELECT * FROM rfm_scores WHERE company_id = ?').get(id);

// ─── Seed ───────────────────────────────────────────────────
const ABLE       = company('T_RFM Able');
const SCALEPOINT = company('T_RFM Scalepoint');
const LOCKED     = company('T_RFM Låst VIP');
const OLD        = company('T_RFM Gammel kunde');    // ordre for 30 mdr siden → uden for lookback (24)
const FUTURE     = company('T_RFM Fremtidsbon');
const NEVER      = company('T_RFM Aldrig ordret');

for (let i = 1; i <= 3; i++) bon(ABLE, offsetISO(-10 * i));
const spBons = [bon(SCALEPOINT, offsetISO(-5)), bon(SCALEPOINT, offsetISO(-40))];
const lockedBons = [bon(LOCKED, offsetISO(-3))];
bon(OLD, offsetISO(-30 * 30));
bon(FUTURE, offsetISO(200));

// ─── Første kørsel: alle med ordrer får en score ────────────
console.log('\nførste kørsel');
{
    const r = computeRfmScores();
    assert(r.computed === 4, `4 firmaer med ordrer i vinduet (Gammel kunde ligger uden for lookback) (fik ${r.computed})`);
    assert(r.reset === 0, 'intet at nulstille i en frisk tabel');
    assert(score(SCALEPOINT).order_count === 2, 'Scalepoint: 2 ordrer');
    assert(score(ABLE).order_count === 3, 'Able: 3 ordrer');
    assert(score(NEVER).stage === 'lead' && score(NEVER).order_count === 0, 'firma uden ordrer → lead');
    assert(score(OLD) && score(OLD).stage === 'lead' && score(OLD).order_count === 0,
        'ordre uden for lookback → ikke talt (lead-fallback, som hidtil)');
}

// ─── Fremtidsdateret bon: recency må ikke blive negativ ─────
console.log('\nfremtidig leveringsdato');
{
    const f = score(FUTURE);
    assert(f.days_since_last === 0, `days_since_last klampes til 0 (fik ${f.days_since_last})`);
    assert(f.r_score === 100, `fremtidig ordre = maksimalt frisk, R=100 (fik ${f.r_score})`);
    assert(f.last_order_date === offsetISO(200), 'last_order_date er den bookede dato');
}

// Lås LOCKED som vip inden bons flyttes
db.prepare("UPDATE rfm_scores SET stage='vip', stage_locked=1 WHERE company_id=?").run(LOCKED);

// ─── Flyt bons væk (Scalepoint → Able, som i drift) ─────────
console.log('\nbons flyttet til et andet firma');
db.prepare('UPDATE bons SET company_id=? WHERE id IN (?,?)').run(ABLE, ...spBons);
db.prepare('UPDATE bons SET company_id=? WHERE id IN (?)').run(ABLE, ...lockedBons);
{
    const r = computeRfmScores();
    assert(r.computed === 2, `Able + Fremtidsbon har nu ordrer (fik ${r.computed})`);
    assert(r.reset === 2, `2 forældede scores nulstillet (fik ${r.reset})`);

    const sp = score(SCALEPOINT);
    assert(sp.order_count === 0, 'Scalepoint: order_count 0 efter flytning');
    assert(sp.total_revenue === 0 && sp.total_guests === 0, 'Scalepoint: omsætning og gæster 0');
    assert(sp.rfm_total === 0 && sp.r_score === 0 && sp.f_score === 0 && sp.m_score === 0,
        'Scalepoint: alle scores 0');
    assert(sp.last_order_date === null && sp.days_since_last === null, 'Scalepoint: ingen "sidst ordre"');
    assert(sp.stage === 'lead', `Scalepoint uden en eneste bon → lead (fik ${sp.stage})`);
    assert(score(ABLE).order_count === 6, 'Able: 3 + 2 + 1 = 6 ordrer');

    const lk = score(LOCKED);
    assert(lk.stage === 'vip', 'låst stage røres ikke');
    assert(lk.order_count === 0 && lk.rfm_total === 0, 'men tallene nulstilles også på et låst firma');
}

// ─── Idempotens ─────────────────────────────────────────────
console.log('\nanden kørsel uden ændringer');
{
    const r = computeRfmScores();
    assert(r.reset === 0, 'intet nulstilles igen — allerede 0');
    assert(score(SCALEPOINT).stage === 'lead', 'Scalepoint står stadig som lead');
}

// ─── Ordre falder ud af lookback-vinduet ────────────────────
console.log('\nordre glider ud af lookback');
{
    // OLD fik en ordre inden for vinduet → score → ordren "ældes" ud
    const b = bon(OLD, offsetISO(-20));
    computeRfmScores();
    assert(score(OLD).order_count === 1, 'gammel kunde talt med igen når ordren er i vinduet');
    db.prepare('UPDATE bons SET delivery_date=? WHERE id=?').run(offsetISO(-30 * 30), b);
    const r = computeRfmScores();
    assert(r.reset === 1, 'én score nulstillet');
    const o = score(OLD);
    assert(o.order_count === 0, 'gammel kunde: order_count 0');
    assert(o.stage === 'dormant', `gammel kunde har stadig bons → dormant, ikke lead (fik ${o.stage})`);
}

// ─── Ingen ordrer i vinduet overhovedet ─────────────────────
console.log('\ntomt vindue');
{
    db.prepare("UPDATE bons SET delivery_date=? WHERE bon_number LIKE 'T_RFM_%'").run(offsetISO(-30 * 30));
    const r = computeRfmScores();
    assert(r.computed === 0, 'ingen firmaer med ordrer');
    assert(r.reset === 2, `Able + Fremtidsbon nulstillet (de to der stadig havde tal) (fik ${r.reset})`);
    assert(score(ABLE).order_count === 0 && score(ABLE).stage === 'dormant', 'Able: 0 ordrer, dormant');
    assert(score(LOCKED).stage === 'vip', 'låst stage overlever også den tomme kørsel');
}

// ─── Resultat ───────────────────────────────────────────────
console.log(`\n${pass} PASS · ${fail} FAIL`);
try { fs.unlinkSync(TEST_DB); } catch {}
process.exit(fail ? 1 : 0);
