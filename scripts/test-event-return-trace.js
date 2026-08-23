// scripts/test-event-return-trace.js
// ============================================================
// Integration-test for spor på bogført retur (migration 157, issue #536).
//
// Før: POST /events/:id/return lagde varerne på HQ-lageret og skrev en
// changelog-linje der aldrig blev vist. computeReturnSuggestion vidste intet
// om tidligere retur, så et tryk mere foreslog de SAMME mængder og lagde dem
// på lageret igen — lageret blev for højt, og fejlen dukkede først op ved
// næste optælling.
//
// Testen rammer de ægte endpoints over HTTP mod en isoleret temp-DB. Grocy
// stubbes IKKE væk — i stedet bruges resultatet fra serveren som det er, og
// vi asserterer mod DATABASEN (event_returns) og mod hvad forslaget siger
// næste gang. Det er dér fejlen sad.
//
// Kør:
//   node --experimental-sqlite scripts/test-event-return-trace.js
// ============================================================

const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-returtrace-${Date.now()}.db`);
const PORT = 4337;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}

async function waitForServer(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

let _cookies = [];
async function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, {
        method, headers, body: body == null ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

function unitTests(dbPath) {
    const { openDb } = require('../db/compat');
    const { getReturnedByProduct, getReturnBookings } = require('../routes/events');
    const db = openDb(dbPath);
    const evId = Number(db.prepare(
        `INSERT INTO events (name, location_id, start_date, status) VALUES ('Unit', 1, '2026-09-01', 'done')`
    ).run().lastInsertRowid);

    console.log('\n— getReturnedByProduct —');
    assert(getReturnedByProduct(evId).size === 0, 'intet returneret endnu → tom map');

    const ins = db.prepare(`INSERT INTO event_returns
        (event_id, product_id, product_name, amount, unit, booked_at) VALUES (?,?,?,?,?,?)`);
    ins.run(evId, 10, 'Kål', 2.5, 'Kilo', '2026-09-02 10:00:00');
    ins.run(evId, 11, 'Brød', 4,   'Antal', '2026-09-02 10:00:00');
    assert(getReturnedByProduct(evId).get(10) === 2.5, 'summen pr. produkt læses');

    // Flere bogføringer af SAMME produkt skal lægges sammen — hver række er en
    // hændelse, ikke en tilstand.
    ins.run(evId, 10, 'Kål', 1.5, 'Kilo', '2026-09-03 08:00:00');
    assert(getReturnedByProduct(evId).get(10) === 4, 'to bogføringer af samme produkt summeres (2,5 + 1,5)');

    console.log('\n— getReturnBookings —');
    const bk = getReturnBookings(evId);
    assert(bk.length === 2,
        'rækker uden booking_ref grupperes på tidsstempel (bagudkompatibelt)');
    assert(bk[0].booked_at === '2026-09-03 08:00:00', 'nyeste først');
    assert(bk[1].product_count === 2, 'første bogføring talte to produkter');

    // Et andet events retur må ikke lække ind.
    const other = Number(db.prepare(
        `INSERT INTO events (name, location_id, start_date, status) VALUES ('Andet', 1, '2026-09-01', 'done')`
    ).run().lastInsertRowid);
    ins.run(other, 10, 'Kål', 99, 'Kilo', '2026-09-02 10:00:00');
    assert(getReturnedByProduct(evId).get(10) === 4, 'et andet events retur tælles ikke med');
    assert(getReturnBookings(other).length === 1, 'bogføringer er scoped til eventet');

    // CASCADE: sletter man eventet, følger sporet med.
    db.prepare(`PRAGMA foreign_keys = ON`).run();
    db.prepare(`DELETE FROM events WHERE id = ?`).run(other);
    assert(getReturnBookings(other).length === 0, 'sporet slettes med eventet (CASCADE)');

    db.prepare(`DELETE FROM event_returns`).run();
    db.prepare(`DELETE FROM events WHERE id = ?`).run(evId);
    db.close();
}

// ── Den ægte route-handler med STUBBET Grocy ────────────────────────────────
// Uden dette blev den vigtigste gren — "vellykket bogføring skriver sporet" —
// sprunget over hver gang Grocy ikke var nåelig, og testen bestod af den
// forkerte grund. Her kaldes den RIGTIGE handler (validering, parent-resolve,
// insert) over HTTP; kun `services/grocyAdapter` er byttet ud.
async function routeTestsWithStub(dbPath) {
    const express = require('express');
    const { openDb } = require('../db/compat');

    // Mock FØR routeren loades — routes/events.js holder samme modul-objekt.
    const grocy = require('../services/grocyAdapter');
    const added = [];
    let failNext = null;   // sæt til et product_id for at få addToStock til at kaste
    grocy.getProducts = async () => ([
        { id: 10, name: 'Kål',  qu_id_stock: 1, no_own_stock: '1' },
        { id: 20, name: 'Spidskål', qu_id_stock: 1, parent_product_id: 10, active: '1' },
        { id: 11, name: 'Brød', qu_id_stock: 2 },
    ]);
    grocy.getStock = async () => ([{ product_id: 20, amount: '7' }]);
    grocy.getQuantityUnits = async () => ([{ id: 1, name: 'Kilo' }, { id: 2, name: 'Antal' }]);
    grocy.addToStock = async (pid, amt) => {
        if (failNext != null && pid === failNext) throw new Error('Grocy 500 (stub)');
        added.push({ pid, amt });
        return { ok: true };
    };
    // Deterministisk BOM, så computeReturnSuggestion kan køres uden Grocy.
    // Uden dette kunne forslaget aldrig beregnes i testen — og netop dét led
    // (rest = pakket − solgt − returneret) er kernen i #536.
    const ir = require('../services/ingredientResolver');
    ir.resolveConsumeItems = async (lines) => {
        const agg = new Map();
        for (const l of lines) {
            if (l.grocy_recipe_id !== 101) continue;
            const q = Number(l.quantity) || 0;
            const cur = agg.get(11) || { product_id: 11, product_name: 'Brød', amount_stock: 0 };
            cur.amount_stock += q;                            // 1 brød pr. styk
            agg.set(11, cur);
            // Kål med i BOM'en, så parent-omdirigeringen nedenfor returnerer
            // noget der FAKTISK blev pakket. Uden det ville værnet (§18.9)
            // afvise den — med rette: en kål der aldrig kom med ud, kan ikke
            // komme hjem.
            const k = agg.get(10) || { product_id: 10, product_name: 'Kål', amount_stock: 0 };
            k.amount_stock += q * 0.2;                        // 0,2 kg kål pr. styk
            agg.set(10, k);
        }
        return Array.from(agg.values());
    };

    const eventsRouter = require('../routes/events');
    const db = openDb(dbPath);
    const userId = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get().id;
    const evId = Number(db.prepare(
        `INSERT INTO events (name, location_id, start_date, status) VALUES ('Stub', 1, '2026-09-20', 'done')`
    ).run().lastInsertRowid);

    // Prep-bon på eventet: 30 stk → 30 brød + 6 kg kål i BOM'en. Uden den er
    // den beregnede rest 0, og værnet fra §18.9 afviser bogføringerne nedenfor
    // — korrekt, men det er ikke dét denne test handler om. Med bonnen kører
    // testen den normale vej, ikke en tilsidesat.
    {
        const stId = db.prepare(`SELECT id FROM status_definitions WHERE code='GODKENDT'`).get().id;
        const pcId = db.prepare(`SELECT id FROM price_categories WHERE code='produktion'`).get().id;
        const bId = Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, price_category_id, price_category,
                              event_id, event_role, order_date, delivery_date, total_price)
            VALUES ('T-RET-STUB', ?, 1, ?, 'produktion', ?, 'prep', '2026-09-19', '2026-09-20', 0)
        `).run(stId, pcId, evId).lastInsertRowid);
        db.prepare(`
            INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                                   unit_price, line_total)
            VALUES (?, 101, 'Falaflen', '01 Sandwich', 30, 'stk', 0, 0)
        `).run(bId);
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { userId, userRole: 'admin' }; next(); });
    app.use('/api/events', eventsRouter);
    const server = await new Promise(res => { const s = app.listen(0, () => res(s)); });
    const base = `http://localhost:${server.address().port}`;
    const post = async (url, body) => {
        const r = await fetch(base + url, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, data: await r.json().catch(() => null) };
    };

    try {
        console.log('\n— Vellykket bogføring skriver sporet —');
        const r1 = await post(`/api/events/${evId}/return`, { items: [
            { product_id: 11, amount: 4, product_name: 'Brød', unit: 'Antal' },
        ]});
        assert(r1.status === 200 && r1.data.returned_count === 1, 'retur bogført');
        assert(added.some(a => a.pid === 11 && a.amt === 4), 'Grocy fik mængden');
        let rows = db.prepare(`SELECT * FROM event_returns WHERE event_id = ?`).all(evId);
        assert(rows.length === 1, 'præcis én række i sporet');
        assert(rows[0].product_name === 'Brød' && rows[0].unit === 'Antal',
            'navn og enhed gemmes som snapshot');
        assert(rows[0].booked_by_user_id === userId, 'brugeren registreres');
        assert(r1.data.booked_at, 'svaret bærer tidsstemplet');

        console.log('\n— Sporet må IKKE skrives når Grocy afviser —');
        failNext = 11;
        const r2 = await post(`/api/events/${evId}/return`, { items: [
            { product_id: 11, amount: 2, product_name: 'Brød', unit: 'Antal' },
        ]});
        failNext = null;
        assert(r2.data.returned_count === 0, 'fejlet kald tæller ikke som returneret');
        rows = db.prepare(`SELECT * FROM event_returns WHERE event_id = ?`).all(evId);
        assert(rows.length === 1,
            'ingen ny række — ellers ville varerne blive trukket fra næste forslag uden at være hjemme');
        assert(r2.data.booked_at === null, 'intet tidsstempel når intet lykkedes');

        console.log('\n— Parent uden eget lager omdirigeres, og sporet siger hvorhen —');
        const r3 = await post(`/api/events/${evId}/return`, { items: [
            { product_id: 10, amount: 2.5, product_name: 'Kål', unit: 'Kilo' },
        ]});
        assert(r3.data.returned_count === 1, 'kål bogført');
        assert(added.some(a => a.pid === 20 && a.amt === 2.5),
            'Grocy fik barnet (Spidskål), ikke parenten');
        const kaal = db.prepare(
            `SELECT * FROM event_returns WHERE event_id = ? AND product_id = 10`).get(evId);
        assert(kaal.added_to_product_id === 20,
            'sporet peger på det produkt Grocy faktisk rørte');

        console.log('\n— Anden bogføring foreslår ikke det samme igen —');
        const { getReturnedByProduct, getReturnBookings } = require('../routes/events');
        assert(getReturnedByProduct(evId).get(11) === 4,
            'det returnerede kan trækkes fra forslaget (kernen i #536)');
        assert(getReturnBookings(evId).length === 2,
            'to adskilte bogføringer i historikken — også i samme sekund (den fejlede tæller ikke med)');

        // Bogfør mere af samme vare — summen skal vokse, ikke erstattes.
        await post(`/api/events/${evId}/return`, { items: [
            { product_id: 11, amount: 1.5, product_name: 'Brød', unit: 'Antal' },
        ]});
        assert(getReturnedByProduct(evId).get(11) === 5.5,
            'en ekstra bogføring lægges til (4 + 1,5) — hver række er en hændelse');

        console.log('\n— Forslaget trækker det returnerede fra (kernen i #536) —');
        // Frisk event med en prep-bon, så `prepped` kommer fra den ægte sti
        // (getBonLines → resolveConsumeItems), ikke fra et opdigtet tal.
        const ev2 = Number(db.prepare(
            `INSERT INTO events (name, location_id, start_date, status) VALUES ('Forslag', 1, '2026-09-25', 'done')`
        ).run().lastInsertRowid);
        const statusId = db.prepare(`SELECT id FROM status_definitions WHERE code = 'GODKENDT'`).get().id;
        const pcId = db.prepare(`SELECT id FROM price_categories WHERE code = 'produktion'`).get().id;
        const bonId = Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, price_category_id, price_category,
                              event_id, event_role, order_date, delivery_date, total_price)
            VALUES ('T-RET-1', ?, 1, ?, 'produktion', ?, 'prep', '2026-09-24', '2026-09-25', 0)
        `).run(statusId, pcId, ev2).lastInsertRowid);
        db.prepare(`
            INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                                   unit_price, line_total)
            VALUES (?, 101, 'Falaflen', '01 Sandwich', 20, 'stk', 0, 0)
        `).run(bonId);

        const { computeReturnSuggestion } = require('../routes/events');
        const evRow2 = db.prepare(`SELECT * FROM events WHERE id = ?`).get(ev2);

        const før = await computeReturnSuggestion(evRow2);
        const brødFør = (før.items || []).find(i => i.product_id === 11);
        assert(brødFør && brødFør.suggested_rest === 20,
            'uden retur foreslås hele resten (20 brød)');
        assert(før.bookings.length === 0, 'ingen bogføringer endnu');

        await post(`/api/events/${ev2}/return`, { items: [
            { product_id: 11, amount: 8, product_name: 'Brød', unit: 'Antal' },
        ]});

        const efter = await computeReturnSuggestion(evRow2);
        const brødEfter = (efter.items || []).find(i => i.product_id === 11);
        assert(brødEfter.returned === 8, 'forslaget viser hvad der allerede er returneret');
        assert(brødEfter.suggested_rest === 12,
            'resten er reduceret til 12 — en anden bogføring dobbelt-lægger IKKE de 8 på HQ');
        assert(efter.bookings.length === 1, 'forslaget bærer bogførings-historikken med');

        // Returnér MERE end resten, og forslaget skal gå i nul — ikke negativt.
        // 20 mod en rest på 12 er en bevidst over-returnering, og værnet fra
        // §18.9 fanger den nu — derfor `force`. Klampningen der testes herunder
        // er uændret.
        await post(`/api/events/${ev2}/return`, { force: true, items: [
            { product_id: 11, amount: 20, product_name: 'Brød', unit: 'Antal' },
        ]});
        const tredje = await computeReturnSuggestion(evRow2);
        const brødTredje = (tredje.items || []).find(i => i.product_id === 11);
        assert(brødTredje.suggested_rest === 0,
            'over-returnering klampes til 0 frem for at foreslå en negativ mængde');
        assert(brødTredje.returned === 28, 'det samlede returnerede vises stadig ærligt');

        db.prepare(`DELETE FROM bon_lines WHERE bon_id = ?`).run(bonId);
        db.prepare(`DELETE FROM bons WHERE id = ?`).run(bonId);
        // Prep-bonnen på stub-eventet skal også væk, ellers spærrer FK'en for
        // at eventet kan slettes nedenfor.
        db.prepare(`DELETE FROM bon_lines WHERE bon_id IN (SELECT id FROM bons WHERE event_id = ?)`).run(evId);
        db.prepare(`DELETE FROM bons WHERE event_id = ?`).run(evId);
        db.prepare(`DELETE FROM event_returns WHERE event_id IN (?, ?)`).run(evId, ev2);
        db.prepare(`DELETE FROM events WHERE id IN (?, ?)`).run(evId, ev2);
    } finally {
        server.close();
        db.close();
    }
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    unitTests(TEST_DB);
    await routeTestsWithStub(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);
    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN);
    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    db.close();

    let serverProc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT}`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        serverProc.stdout.on('data', () => {});
        serverProc.stderr.on('data', d => {
            const s = d.toString();
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) {
                process.stderr.write('  [server-err] ' + s);
            }
        });
        if (!await waitForServer()) throw new Error('Server startede ikke');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        if (login.status !== 200) throw new Error('Login fejlede: ' + login.status);

        const ev = (await http('POST', '/api/events', {
            name: 'Retur-spor', location_id: locId, start_date: '2026-09-10', status: 'done',
        })).data;

        // ── Før første bogføring ──────────────────────────────────────────
        console.log('\n— Før nogen har bogført —');
        const ov0 = await http('GET', `/api/events/${ev.id}/overview`);
        assert(ov0.status === 200, 'overview svarer');
        assert(Array.isArray(ov0.data.return_bookings), 'overview bærer return_bookings');
        assert(ov0.data.return_bookings.length === 0, 'ingen bogføringer endnu');

        // ── Bogfør ────────────────────────────────────────────────────────
        console.log('\n— Bogføring efterlader et spor —');
        const r1 = await http('POST', `/api/events/${ev.id}/return`, {
            items: [{ product_id: 10, amount: 2.5, product_name: 'Kål', unit: 'Kilo' }],
        });
        assert(r1.status === 200, 'retur bogføres');

        const db2 = openDb(TEST_DB);
        const rows = db2.prepare(`SELECT * FROM event_returns WHERE event_id = ?`).all(ev.id);
        const lykkedes = (r1.data.results || []).filter(x => x.success).length;

        // Grocy er ikke nødvendigvis nåelig i testmiljøet. Lykkedes kaldet, SKAL
        // der stå en række; fejlede det, må der IKKE stå en — netop dét er
        // reglen (#359: sporet skrives kun når bivirkningen lykkedes).
        if (lykkedes > 0) {
            assert(rows.length === 1, 'vellykket retur skriver præcis én række');
            assert(rows[0].product_name === 'Kål' && rows[0].unit === 'Kilo',
                'navn og enhed gemmes som snapshot');
            assert(rows[0].booked_by_user_id != null, 'brugeren registreres');
            assert(r1.data.booked_at, 'svaret bærer tidsstemplet for bogføringen');

            const ov1 = await http('GET', `/api/events/${ev.id}/overview`);
            assert(ov1.data.return_bookings.length === 1,
                'overview viser nu at returen er bogført — uden at man trykker "beregn"');
            assert(ov1.data.return_bookings[0].product_count === 1, 'antal produkter med i sporet');
            assert(ov1.data.return_bookings[0].booked_by_name, 'navnet på den der bogførte er med');

            // Kernen i #536: anden kørsel må ikke foreslå det samme igen.
            const { getReturnedByProduct } = require('../routes/events');
            assert(getReturnedByProduct(ev.id).get(10) === 2.5,
                'det returnerede kan trækkes fra næste forslag');
        } else {
            assert(rows.length === 0,
                'fejlet Grocy-kald skriver INTET spor — ellers ville varerne aldrig komme hjem');
            console.log('     (Grocy ikke nåelig — den positive gren dækkes af unit-testene ovenfor)');
        }
        db2.close();

        // ── Validering ────────────────────────────────────────────────────
        console.log('\n— Validering —');
        assert((await http('POST', `/api/events/${ev.id}/return`, {})).status === 400,
            'manglende items afvises');
        const r0 = await http('POST', `/api/events/${ev.id}/return`, {
            items: [{ product_id: 10, amount: 0 }, { product_id: 11, amount: -5 }],
        });
        assert(r0.status === 200 && r0.data.returned_count === 0,
            'nul og negative mængder springes over');
        assert(r0.data.booked_at === null,
            'en bogføring der ikke flyttede noget får intet tidsstempel');

        assert((await http('POST', `/api/events/99999/return`, { items: [] })).status === 404,
            'ukendt event giver 404');

    } finally {
        if (serverProc) serverProc.kill();
        try { require('fs').unlinkSync(TEST_DB); } catch {}
        for (const suf of ['-wal', '-shm']) { try { require('fs').unlinkSync(TEST_DB + suf); } catch {} }
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
