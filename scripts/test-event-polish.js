// scripts/test-event-polish.js
// ============================================================
// Test for event-polish (migration 100 + adresse-overførsel +
// åbningstider + NY→LEVERET fra pakkelisten):
//
//   1. events.open_hours_json kolonne findes + kan PATCHes
//   2. NY→LEVERET transition findes (requires_confirmation=1)
//   3. POST /:id/bons sætter delivery_address_id fra event_address
//      (find-eller-opret: to bons deler samme addresses-række)
//   4. cost_price/unit_price snapshot på prep-linjer (0 kr bon, kost ex)
//   5. PATCH /api/bons/:id/status NY→LEVERET virker (pakkeliste-knappen)
//
// In-process express med fake session + mocket Grocy/geocode.
// Isoleret temp-DB. Rører intet i prod.
//
// Kør:
//   node --experimental-sqlite scripts/test-event-polish.js
// ============================================================

'use strict';
const path = require('path');
const os   = require('os');

const TEST_DB = path.join(os.tmpdir(), `bon-event-polish-${Date.now()}.db`);
process.env.DB_PATH = TEST_DB;

const { runMigrations } = require('../db/migrate');
runMigrations(TEST_DB);

// Mock geocode FØR routes/events.js destructurer den
const geocode = require('../services/geocode');
const geocodeCalls = [];
geocode.geocodeAddress = async (id) => { geocodeCalls.push(id); return null; };

// Mock Grocy consume (LEVERET → autoConsumeBonInventory)
const grocyAdapter = require('../services/grocyAdapter');
grocyAdapter.consumeRecipes = (lines) => Promise.resolve(lines.map(() => ({ success: true })));

const { getDb } = require('../db/database');
const db = getDb();

// ── test-harness ───────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(msg)  { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
function bad(msg) { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
function check(cond, msg) { (cond ? ok : bad)(msg); }
function section(t) { console.log(`\n${t}`); }

// ── in-process server ──────────────────────────────────────────
const express = require('express');
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.session = { userId: 1, userRole: 'admin' }; next(); });
app.use('/api/events', require('../routes/events'));
app.use('/api/bons',   require('../routes/bons'));

async function main() {
    const server = await new Promise(resolve => {
        const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, p, body) => {
        const res = await fetch(base + p, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        let json = null;
        try { json = await res.json(); } catch {}
        return { status: res.status, json };
    };

    section('1. Migration 100');
    const cols = db.prepare(`PRAGMA table_info(events)`).all().map(c => c.name);
    check(cols.includes('open_hours_json'), 'events.open_hours_json findes');
    const trans = db.prepare(`
        SELECT st.requires_confirmation FROM status_transitions st
        JOIN status_definitions f ON st.from_status_id = f.id
        JOIN status_definitions t ON st.to_status_id   = t.id
        WHERE f.code = 'NY' AND t.code = 'LEVERET'
    `).get();
    check(!!trans, 'NY→LEVERET transition findes');
    check(trans && trans.requires_confirmation === 1, 'NY→LEVERET kræver bekræftelse');

    section('2. Event med adresse + åbningstider');
    const evRes = await api('POST', '/api/events', {
        name: 'Polish Test Event', start_date: '2026-07-01', end_date: '2026-07-03',
        event_address: 'Fælledparken Øster Allé, København',
    });
    check(evRes.status === 201, `event oprettet (${evRes.status})`);
    const evId = evRes.json.id;

    const ohJson = JSON.stringify({ '2026-07-01': '10-18', '2026-07-02': '12-22' });
    const patchRes = await api('PATCH', `/api/events/${evId}`, { open_hours_json: ohJson });
    check(patchRes.status === 200, 'PATCH open_hours_json accepteret');
    check(patchRes.json.open_hours_json === ohJson, 'open_hours_json persisteret og returneret');

    section('3. Prep-bon: adresse + pris-snapshot');
    const bon1 = await api('POST', `/api/events/${evId}/bons`, {
        role: 'prep',
        delivery_date: '2026-07-01',
        lines: [
            { product_name: 'Falaflen', quantity: 100, unit: 'stk', unit_price: 0, cost_price: 23.55, category: '01 Sandwich' },
            { product_name: 'Fisken',   quantity: 50,  unit: 'stk', unit_price: 0, cost_price: 31.10, category: '01 Sandwich' },
        ],
    });
    check(bon1.status === 201, `prep-bon oprettet (${bon1.status})`);
    check(bon1.json.delivery_address_id != null, 'delivery_address_id sat fra event_address');
    const addr = db.prepare(`SELECT * FROM addresses WHERE id = ?`).get(bon1.json.delivery_address_id);
    check(addr && addr.street_name === 'Fælledparken Øster Allé, København', 'addresses-række har eventets adresse');
    check(addr && addr.label === 'Polish Test Event', 'addresses-række labeled med event-navn');
    check(geocodeCalls.includes(bon1.json.delivery_address_id), 'geokodning affyret fire-and-forget');
    check(bon1.json.delivery_address && bon1.json.delivery_address.street_name, 'getBon returnerer delivery_address til draweren');
    check(bon1.json.total_price === 0, 'prep-bon total er 0 kr (produktion)');
    const l1 = bon1.json.lines.find(l => l.product_name === 'Falaflen');
    check(l1 && l1.unit_price === 0 && l1.cost_price === 23.55, 'linje: unit_price=0, cost_price snapshottet');

    section('4. Adresse genbruges (find-eller-opret)');
    const bon2 = await api('POST', `/api/events/${evId}/bons`, {
        role: 'topup', delivery_date: '2026-07-02',
        lines: [{ product_name: 'Falaflen', quantity: 20, unit_price: 0, cost_price: 23.55 }],
    });
    check(bon2.status === 201, 'top-up-bon oprettet');
    check(bon2.json.delivery_address_id === bon1.json.delivery_address_id, 'samme addresses-række genbruges');
    const addrCount = db.prepare(`SELECT COUNT(*) AS c FROM addresses WHERE label = 'Polish Test Event'`).get().c;
    check(addrCount === 1, 'kun én adresse-række for eventet');

    section('4b. DAWA-valgt adresse (event_address_id) bruges direkte');
    const dawaAddrId = Number(db.prepare(`
        INSERT INTO addresses (label, street_name, street_nr, postal_code, city, lat, lon)
        VALUES ('DAWA Event', 'Øster Allé', '5', '2100', 'København Ø', 55.7, 12.57)
    `).run().lastInsertRowid);
    const evDawa = await api('POST', '/api/events', {
        name: 'DAWA Event', start_date: '2026-09-01',
        event_address: 'Øster Allé 5, 2100 København Ø', event_address_id: dawaAddrId,
    });
    check(evDawa.json.event_address_id === dawaAddrId, 'event gemmer event_address_id');
    const geocodeCallsBefore = geocodeCalls.length;
    const bonDawa = await api('POST', `/api/events/${evDawa.json.id}/bons`, {
        role: 'prep', lines: [{ product_name: 'X', quantity: 1, unit_price: 0 }],
    });
    check(bonDawa.json.delivery_address_id === dawaAddrId, 'bon peger direkte på den DAWA-validerede adresse');
    check(bonDawa.json.delivery_address && bonDawa.json.delivery_address.lat === 55.7, 'koordinater følger med (BESTIL BUD-forslag kan beregnes)');
    check(geocodeCalls.length === geocodeCallsBefore, 'ingen ny geokodning — adressen er allerede struktureret');

    section('5. Event uden adresse → ingen address-kobling');
    const evNo = await api('POST', '/api/events', { name: 'Uden Adresse', start_date: '2026-08-01' });
    const bonNo = await api('POST', `/api/events/${evNo.json.id}/bons`, {
        role: 'prep', lines: [{ product_name: 'X', quantity: 1, unit_price: 0 }],
    });
    check(bonNo.status === 201 && bonNo.json.delivery_address_id == null, 'delivery_address_id er null uden event_address');

    section('6. Status: prep starter på GODKENDT (synlig på I dag-tavlen)');
    check(bon1.json.status_code === 'GODKENDT', `prep-bon starter på GODKENDT (fik ${bon1.json.status_code})`);

    section('7. LEVERET fra pakkelisten');
    const lev = await api('PATCH', `/api/bons/${bon1.json.id}/status`, { status_code: 'LEVERET' });
    check(lev.status === 200, `GODKENDT→LEVERET accepteret (${lev.status}${lev.json && lev.json.error ? ': ' + lev.json.error : ''})`);
    const after = db.prepare(`
        SELECT sd.code FROM bons b JOIN status_definitions sd ON b.status_id = sd.id WHERE b.id = ?
    `).get(bon1.json.id);
    check(after && after.code === 'LEVERET', 'bon står som LEVERET');

    // Gamle prep-bons (oprettet før status-skiftet) står på NY — pakkeliste-
    // knappen skal også kunne levere dem direkte (migration 100-transition).
    const bonNy = await api('POST', `/api/events/${evId}/bons`, {
        role: 'prep', status_code: 'NY', delivery_date: '2026-07-03',
        lines: [{ product_name: 'Falaflen', quantity: 5, unit_price: 0, cost_price: 23.55 }],
    });
    check(bonNy.json.status_code === 'NY', 'legacy-bon oprettet på NY (override)');
    const levNy = await api('PATCH', `/api/bons/${bonNy.json.id}/status`, { status_code: 'LEVERET' });
    check(levNy.status === 200, `NY→LEVERET accepteret for legacy-bon (${levNy.status})`);

    server.close();
    console.log(`\n${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
