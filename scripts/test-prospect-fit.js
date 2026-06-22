// scripts/test-prospect-fit.js
// ==========================================
// Tests for gradueret prospekt-fit (CRM Prospekter, Fase 1).
//   1) scoreProspect — ren funktion (branche/størrelse/afstand-math, renorm)
//   2) computeProspectScores — mod isoleret temp-DB med syntetiske VIP'er + leads:
//      spredning (ikke alle ens), rangering, blacklist, afstands-filter, manglende coords
//
// Kør med:
//   node --experimental-sqlite scripts/test-prospect-fit.js
// ==========================================

const path = require('path');
const os = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-test-prospect-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

const { getDb } = require('../db/database');
const {
    scoreProspect,
    computeProspectScores,
    getVipReference,
    haversineKm,
} = require('../services/rfm');

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  ✓', msg); pass++; }
    else      { console.error('  ✗', msg); fail++; }
}
function near(a, b, eps, msg) { assert(Math.abs(a - b) <= eps, `${msg} (≈${b}, fik ${a})`); }

// ─── 1) scoreProspect (ren funktion) ────────────────────────
console.log('\nscoreProspect — math');
{
    const cfg = { w_branch: 50, w_size: 20 };
    const ref = { shares: { A: 0.6, B: 0.2 }, maxShare: 0.6, avgEmployees: 1000 };
    const hq = { lat: 55.6934, lon: 12.5523 };

    // Branche: hyppigste VIP-branche → 100, rarere proportionalt, ukendt → 0
    const a = scoreProspect({ branch: 'A', employee_count: 1000, lat: 55.6934, lon: 12.5523 }, ref, hq, cfg);
    assert(a.branch === 100, 'hyppigste branche giver branch=100');
    const b = scoreProspect({ branch: 'B', employee_count: 1000, lat: 55.6934, lon: 12.5523 }, ref, hq, cfg);
    assert(b.branch === 33, 'rarere branche giver proportionalt mindre (0.2/0.6→33)');
    const x = scoreProspect({ branch: 'UKENDT', employee_count: 1000 }, ref, hq, cfg);
    assert(x.branch === 0, 'ikke-VIP-branche giver branch=0');

    // Størrelse: peak ved ratio=1, blød decay begge veje
    assert(a.size === 100, 'samme størrelse som VIP giver size=100');
    const big = scoreProspect({ branch: 'A', employee_count: 1000 * Math.E, lat: 55.6934, lon: 12.5523 }, ref, hq, cfg);
    assert(big.size === 50, 'faktor e større giver size=50 (1/(1+|ln e|))');

    // Afstand beregnes til visning, men indgår IKKE i fit
    assert(a.distance_km === 0, 'samme position som HQ giver distance_km=0');
    const far = scoreProspect({ branch: 'A', employee_count: 1000, lat: 55.6934 + 12.5 / 111, lon: 12.5523 }, ref, hq, cfg);
    near(far.distance_km, 12.5, 0.5, 'punkt ~12,5 km nord giver distance_km≈12,5');
    assert(far.fit === a.fit, 'afstand påvirker IKKE fit (samme branche+størrelse → samme fit)');

    // Manglende signaler renormaliseres (straffer ikke)
    const noGeo = scoreProspect({ branch: 'A', employee_count: 1000 }, ref, hq, cfg);
    assert(noGeo.distance_km === null, 'manglende coords → distance_km=null');
    assert(noGeo.fit === 100, 'fit = branche(100)+størrelse(100) → 100');
    const branchOnly = scoreProspect({ branch: 'A' }, ref, hq, cfg);
    assert(branchOnly.size === null, 'kun branche → size null');
    assert(branchOnly.fit === 100, 'kun branche-signal → fit fra branche alene');

    // Spredning: forskellige inputs giver forskellige fits
    const fits = [a.fit, b.fit, x.fit, big.fit];
    assert(new Set(fits).size >= 3, 'forskellige emner giver forskellige fit-scores (spredning)');
}

console.log('\nhaversineKm');
{
    near(haversineKm(55.6934, 12.5523, 55.6934, 12.5523), 0, 0.01, 'samme punkt → 0 km');
    near(haversineKm(55.6934, 12.5523, 55.6934 + 1 / 111, 12.5523), 1, 0.05, '~1 grad/111 nord ≈ 1 km');
}

// ─── 2) computeProspectScores (integration mod temp-DB) ──────
console.log('\ncomputeProspectScores — integration');
{
    const db = getDb();
    const HQ = { lat: 55.6934, lon: 12.5523 };

    function addr(km) {
        const r = db.prepare(
            "INSERT INTO addresses (street_name, postal_code, city, lat, lon) VALUES ('Testvej','2200','KBH',?,?)"
        ).run(HQ.lat + km / 111, HQ.lon);
        return Number(r.lastInsertRowid);
    }
    function company(name, branch, emp, addressId) {
        const r = db.prepare(
            'INSERT INTO companies (name, branch, employee_count, address_id, is_active, is_personal) VALUES (?,?,?,?,1,0)'
        ).run(name, branch, emp, addressId);
        return Number(r.lastInsertRowid);
    }
    function score(companyId, stage, orderCount) {
        db.prepare(
            'INSERT INTO rfm_scores (company_id, stage, order_count, computed_at) VALUES (?,?,?,datetime(\'now\'))'
        ).run(companyId, stage, orderCount);
    }

    // VIP-reference: 3× Offentlig (dominant), 1× Universitet. avg emp = (5000*3+12000)/4 = 6750
    ['VIP A', 'VIP B', 'VIP C'].forEach(n => score(company(n, 'Offentlig forvaltning', 5000, null), 'vip', 30));
    score(company('VIP Uni', 'Universitet', 12000, null), 'vip', 25);

    const ref = getVipReference(db);
    near(ref.shares['Offentlig forvaltning'], 0.75, 0.001, 'VIP-andel: Offentlig = 0.75');
    near(ref.shares['Universitet'], 0.25, 0.001, 'VIP-andel: Universitet = 0.25');
    assert(Math.round(ref.avgEmployees) === 6750, 'VIP gns. ansatte = 6750');

    // Leads
    const L1 = company('Lead Naer Offentlig', 'Offentlig forvaltning', 5000, addr(2));    // tæt, dominant, matchende
    const L2 = company('Lead Naer Uni', 'Universitet', 12000, addr(2));                   // tæt, rarere branche
    const L3 = company('Lead Fjern Offentlig', 'Offentlig forvaltning', 5000, addr(40));  // fjern
    const L4 = company('Lead Restaurant', 'Restauranter', 10, null);                      // ikke-VIP, ingen coords
    const L5 = company('Lead Offentlig ukendt geo', 'Offentlig forvaltning', 5000, null); // dominant, ingen coords
    const L6 = company('Lead Blacklisted', 'Spam-branche', 200, addr(3));                 // blacklistes
    [L1, L2, L3, L4, L5, L6].forEach(id => score(id, 'lead', 0));

    // Uden filtre
    let res = computeProspectScores();
    const byName = Object.fromEntries(res.rows.map(r => [r.name, r]));

    assert(res.rows.length === 6, 'alle 6 leads scores uden filtre');
    const fits = res.rows.map(r => r.icp_fit);
    assert(new Set(fits).size >= 3, `fits spreder sig (ikke flad) — ${fits.length} leads, ${new Set(fits).size} unikke`);

    // Afstand påvirker IKKE fit: tæt og fjern med samme branche+størrelse scorer ens
    assert(byName['Lead Naer Offentlig'].icp_fit === byName['Lead Fjern Offentlig'].icp_fit,
        'tæt og fjern (samme branche+størrelse) får samme fit — afstand tæller ikke');
    assert(byName['Lead Naer Offentlig'].distance_km < byName['Lead Fjern Offentlig'].distance_km,
        'men distance_km beregnes stadig (tæt < fjern)');
    assert(byName['Lead Naer Offentlig'].icp_fit > byName['Lead Naer Uni'].icp_fit,
        'dominant-branche > rarere-branche (branche-andel tæller)');
    assert(byName['Lead Restaurant'].icp_fit === Math.min(...fits),
        'ikke-VIP-branche + lille firma = lavest fit');

    assert(byName['Lead Offentlig ukendt geo'].distance_km === null,
        'lead uden coords → distance_km null');
    assert(byName['Lead Naer Offentlig'].distance_km != null && byName['Lead Naer Offentlig'].distance_km < 5,
        'tæt lead → distance_km < 5');
    assert(res.rows[0].name === 'Lead Naer Offentlig' || res.rows[0].name === 'Lead Offentlig ukendt geo',
        'bedste fit ligger øverst');
    // lat/lon må ikke lække ud i API-svaret
    assert(!('lat' in res.rows[0]) && !('lon' in res.rows[0]), 'rå coords lækker ikke i svaret');

    // Søgning
    res = computeProspectScores({ q: 'Restaurant' });
    assert(res.rows.length === 1 && res.rows[0].name === 'Lead Restaurant', 'søgning filtrerer på navn');

    // Afstands-filter: 10 km → L3 (40km) ud (for langt), L4+L5 ud (ukendt geo)
    res = computeProspectScores({ maxKm: 10 });
    const names = res.rows.map(r => r.name);
    assert(!names.includes('Lead Fjern Offentlig'), 'afstands-filter 10km fjerner 40km-lead');
    assert(!names.includes('Lead Restaurant') && !names.includes('Lead Offentlig ukendt geo'),
        'afstands-filter fjerner leads uden coords');
    assert(res.meta.hidden_distance >= 1, 'meta.hidden_distance tæller for-fjerne leads');
    assert(res.meta.hidden_no_coords >= 2, 'meta.hidden_no_coords tæller leads uden coords');
    assert(names.includes('Lead Naer Offentlig') && names.includes('Lead Naer Uni'),
        'tætte leads (≤10km, ikke blacklistet) bevares');

    // Nedre grænse: ≥ 10 km → kun det fjerne lead (40km), tætte (2-3km) ud
    res = computeProspectScores({ minKm: 10 });
    const minNames = res.rows.map(r => r.name);
    assert(minNames.includes('Lead Fjern Offentlig'), 'minKm 10 beholder 40km-lead');
    assert(!minNames.includes('Lead Naer Offentlig') && !minNames.includes('Lead Naer Uni'),
        'minKm 10 fjerner tætte leads (for nær)');
    assert(res.meta.distance_min_km === 10, 'meta.distance_min_km sat');

    // Interval 10–50 km → kun 40km-leadet ligger i båndet
    res = computeProspectScores({ minKm: 10, maxKm: 50 });
    assert(res.rows.length === 1 && res.rows[0].name === 'Lead Fjern Offentlig',
        'interval 10–50 km giver kun leadet i båndet');

    // Interval 0–5 km → kun de tætte (2-3km), 40km ude
    res = computeProspectScores({ minKm: 0, maxKm: 5 });
    const bandNames = res.rows.map(r => r.name);
    assert(bandNames.includes('Lead Naer Offentlig') && !bandNames.includes('Lead Fjern Offentlig'),
        'interval 0–5 km giver tætte, ikke fjerne');

    // Blacklist
    db.prepare("UPDATE settings SET value = ? WHERE key = 'prospect_branch_blacklist'")
        .run(JSON.stringify(['Spam-branche']));
    res = computeProspectScores();
    assert(!res.rows.some(r => r.name === 'Lead Blacklisted'), 'blacklistet branche fjernes fra listen');
    assert(res.meta.hidden_blacklist === 1, 'meta.hidden_blacklist = 1');
    db.prepare("UPDATE settings SET value = '[]' WHERE key = 'prospect_branch_blacklist'").run();

    // Settings-default afstands-filter respekteres
    db.prepare("UPDATE settings SET value = '10' WHERE key = 'prospect_distance_max_km'").run();
    res = computeProspectScores();
    assert(res.meta.distance_max_km === 10, 'settings-default afstands-filter aktiveres');
    assert(!res.rows.some(r => r.name === 'Lead Fjern Offentlig'), 'settings-filter fjerner fjerne leads');
    db.prepare("UPDATE settings SET value = '' WHERE key = 'prospect_distance_max_km'").run();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
