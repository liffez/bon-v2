// scripts/test-event-menu.js
// ============================================================
// Integration-test for event-menuen (#314).
// Spec: docs/CLAUDE_EVENT.md §16.
//
// Spawner en frisk server mod isoleret test-DB i /tmp — prod røres ikke.
// Rammer de ÆGTE endpoints over HTTP (ikke omskrevet SQL), fordi både
// generate-logikken og PUT-valideringen bor i route-handlerne:
//   GET    /api/events/:id/menu
//   PUT    /api/events/:id/menu
//   POST   /api/events/:id/menu/generate
//   GET    /api/events/:id/sales-prefill
//
// Assertions er bevidst UAFHÆNGIGE af Grocys faktiske festivalpriser (Grocy
// kan være nede eller have andre tal i test) — vi tester at menuen bliver
// KILDEN til prisen, ikke hvilket tal Grocy gav. Prisen sættes derfor altid
// eksplicit via PUT før den verificeres.
//
// Kør:
//   node --experimental-sqlite scripts/test-event-menu.js
// ============================================================

const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-eventmenu-${Date.now()}.db`);
const PORT = 4331;
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

const byName = (items, name) => items.find(i => i.product_name === name);

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    const existingAdmin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (existingAdmin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, existingAdmin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','test-admin@local','admin',?,1)`).run(TEST_PIN);

    const locId  = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const pcId   = c => db.prepare(`SELECT id FROM price_categories WHERE code=?`).get(c).id;
    const stId   = c => db.prepare(`SELECT id FROM status_definitions WHERE code=?`).get(c).id;
    // Snapshot de id'er senere blokke skal bruge — de åbner deres egen
    // DB-handle, og closures over `db` er døde når den er lukket.
    const ID = { festival: pcId('festival'), betalt: stId('BETALT') };

    const eventId = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status)
        VALUES ('Menu-test', ?, 'light', '2026-07-30', '2026-07-31', 'planning')
    `).run(locId).lastInsertRowid);

    let n = 7100;
    function createBon(role, date, pc, statusCode = 'GODKENDT', total = 0) {
        const id = n++;
        db.prepare(`
            INSERT INTO bons (id, bon_number, status_id, location_id, price_category_id, price_category,
                              event_id, event_role, order_date, delivery_date, total_price,
                              inventory_deducted, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,'2026-07-01',?,?,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        `).run(id, 'T-' + id, stId(statusCode), locId, pcId(pc), pc, eventId, role, date, total);
        return id;
    }
    function addLine(bonId, recipeId, name, cat, qty, unitPrice = 0) {
        db.prepare(`
            INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                                   unit_price, line_total, sort_order)
            VALUES (?,?,?,?,?,'stk',?,?,0)
        `).run(bonId, recipeId, name, cat, qty, unitPrice, qty * unitPrice);
    }

    // Prep dag 1: to sandwich + en salat. Prep dag 2: én ekstra sandwich.
    const prep1 = createBon('prep', '2026-07-30', 'produktion');
    addLine(prep1, 101, 'Falaflen',    '01 Sandwich', 50);
    addLine(prep1, 102, 'Tunen',       '01 Sandwich', 30);
    addLine(prep1, 201, 'Græsk salat', '02 Salat',    20);
    const prep2 = createBon('prep', '2026-07-31', 'produktion');
    addLine(prep2, 103, 'Kyllingen',   '01 Sandwich', 25);
    // Top-up tæller IKKE som menu-kilde (kun prep-rollen).
    const topup1 = createBon('topup', '2026-07-30', 'produktion');
    addLine(topup1, 104, 'Kun-topup',  '01 Sandwich', 10);
    // Aflyst prep-bon må ikke bidrage til menuen (#303).
    const prepCancelled = createBon('prep', '2026-07-30', 'produktion', 'AFLYST');
    addLine(prepCancelled, 105, 'Aflyst-vare', '01 Sandwich', 99);
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

        const MENU = `/api/events/${eventId}/menu`;

        console.log('\n— Tom menu —');
        let r = await http('GET', MENU);
        assert(r.status === 200, 'GET /menu svarer 200');
        assert(Array.isArray(r.data.items) && r.data.items.length === 0, 'ny event har tom menu');

        console.log('\n— Generér fra prep-bons —');
        r = await http('POST', MENU + '/generate');
        assert(r.status === 200, 'POST /menu/generate svarer 200');
        let items = r.data.items;
        assert(r.data.added === 4, `4 linjer tilføjet (fik ${r.data.added})`);
        assert(!!byName(items, 'Falaflen') && !!byName(items, 'Tunen')
            && !!byName(items, 'Græsk salat') && !!byName(items, 'Kyllingen'),
            'alle fire prep-produkter er med (også fra dag 2)');
        assert(!byName(items, 'Kun-topup'), 'top-up-vare er IKKE med (kun prep-rollen)');
        assert(!byName(items, 'Aflyst-vare'), 'aflyst prep-bons vare er IKKE med (#303)');
        assert(byName(items, 'Falaflen').category === '01 Sandwich', 'kategori bæres med');
        assert(byName(items, 'Falaflen').grocy_recipe_id === 101, 'grocy_recipe_id bæres med');

        console.log('\n— Generér igen = idempotent —');
        r = await http('POST', MENU + '/generate');
        assert(r.data.added === 0, `intet tilføjet ved resync uden ændringer (fik ${r.data.added})`);
        assert(r.data.items.length === 4, 'stadig 4 linjer (ingen dubletter)');

        console.log('\n— Priser sættes og BEVARES ved resync —');
        // Dette er hele pointen: en pris justeret på pladsen må ikke nulstilles
        // tilbage til Grocys festivalpris næste gang nogen trykker "generér".
        items = r.data.items.map(it => ({ ...it, unit_price: it.product_name === 'Falaflen' ? 125 : 95 }));
        r = await http('PUT', MENU, { items });
        assert(r.status === 200, 'PUT /menu svarer 200');
        assert(byName(r.data.items, 'Falaflen').unit_price === 125, 'justeret pris gemt (125)');

        r = await http('POST', MENU + '/generate');
        assert(byName(r.data.items, 'Falaflen').unit_price === 125,
            'resync RØRER IKKE prisen på eksisterende linje (stadig 125)');
        assert(byName(r.data.items, 'Tunen').unit_price === 95, 'øvrige justerede priser bevaret');

        console.log('\n— Slettet prep-linje genskabes (reset-knappen) —');
        items = r.data.items.filter(it => it.product_name !== 'Tunen');
        await http('PUT', MENU, { items });
        r = await http('GET', MENU);
        assert(!byName(r.data.items, 'Tunen'), 'Tunen slettet fra menuen');
        r = await http('POST', MENU + '/generate');
        assert(!!byName(r.data.items, 'Tunen'), 'Tunen genskabt ved resync (den er prep-afledt)');
        assert(byName(r.data.items, 'Falaflen').unit_price === 125,
            'de øvrige priser overlevede genskabelsen');

        console.log('\n— Manuel linje (ret fundet på pladsen) overlever resync —');
        items = [...r.data.items, {
            grocy_recipe_id: null, product_name: 'Pandekage m. syltetøj',
            category: null, unit: 'stk', unit_price: 45, note: 'fundet på pladsen',
        }];
        r = await http('PUT', MENU, { items });
        assert(!!byName(r.data.items, 'Pandekage m. syltetøj'), 'manuel linje gemt');
        assert(byName(r.data.items, 'Pandekage m. syltetøj').grocy_recipe_id === null,
            'manuel linje har intet grocy_recipe_id (ingen BOM/kostpris/CO₂)');
        r = await http('POST', MENU + '/generate');
        assert(!!byName(r.data.items, 'Pandekage m. syltetøj'), 'manuel linje overlever resync');
        assert(byName(r.data.items, 'Pandekage m. syltetøj').unit_price === 45, 'manuel pris urørt');

        console.log('\n— PUT-validering —');
        r = await http('PUT', MENU, { items: 'ikke-array' });
        assert(r.status === 400, 'ikke-array afvises (400)');
        r = await http('PUT', MENU, { items: [{ product_name: '  ', unit_price: 10 }] });
        assert(r.status === 400, 'tomt produktnavn afvises (400)');
        r = await http('PUT', MENU, { items: [{ product_name: 'X', unit_price: -5 }] });
        assert(r.status === 400, 'negativ pris afvises (400)');
        r = await http('PUT', MENU, { items: [
            { product_name: 'Dublet', grocy_recipe_id: 101, unit_price: 10 },
            { product_name: 'Dublet', grocy_recipe_id: 101, unit_price: 20 },
        ]});
        assert(r.status === 400, 'dublet-linje afvises (400)');
        r = await http('GET', MENU);
        assert(r.data.items.length === 5,
            'menuen er UÆNDRET efter afviste PUTs (valideret før skrivning)');

        console.log('\n— Salgs-prefill bruger MENUENS pris, ikke Grocys —');
        let p = await http('GET', `/api/events/${eventId}/sales-prefill`);
        assert(p.status === 200, 'GET /sales-prefill svarer 200');
        assert(p.data.price_source === 'menu', 'prefill markerer menuen som priskilde');
        const pf = byName(p.data.lines, 'Falaflen');
        assert(pf.unit_price === 125, `Falaflen prissat fra menuen (fik ${pf.unit_price})`);
        assert(pf.quantity === 50, 'antal kommer stadig fra prep-bonnen (50)');
        const pm = byName(p.data.lines, 'Pandekage m. syltetøj');
        assert(!!pm, 'manuel menulinje er med i prefill');
        assert(pm.quantity === 0, 'manuel linje uden prep får antal 0 (skal ikke tastes hver dag)');
        assert(pm.unit_price === 45, 'manuel linje bærer sin menupris');

        console.log('\n— Afvigelses-markering (i stedet for prisversionering) —');
        // Salgsbon der sælger Falaflen til 110 mens menuen siger 125.
        const dbx = openDb(TEST_DB);
        const salesId = Number(dbx.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, price_category_id, price_category,
                              event_id, event_role, order_date, delivery_date, total_price,
                              inventory_deducted, created_at, updated_at)
            VALUES ('T-SALES', ?, ?, ?, 'festival', ?, 'sales', '2026-07-30','2026-07-30', 1100, 0,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(ID.betalt, locId, ID.festival, eventId).lastInsertRowid);
        dbx.prepare(`
            INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
                                   unit_price, line_total, sort_order)
            VALUES (?, 101, 'Falaflen', '01 Sandwich', 10, 'stk', 110, 1100, 0)
        `).run(salesId);
        dbx.close();

        r = await http('GET', MENU);
        const dev = byName(r.data.items, 'Falaflen');
        assert(dev.price_deviation === true, 'menurække markeret når salgspris afviger');
        assert(dev.sold_prices.includes(110), `solgte priser rapporteret (fik ${JSON.stringify(dev.sold_prices)})`);
        assert(byName(r.data.items, 'Græsk salat').price_deviation === false,
            'urørt vare er IKKE markeret');

        console.log('\n— Event uden menu falder tilbage til Grocy (bagudkompat) —');
        const dby = openDb(TEST_DB);
        const otherEvent = Number(dby.prepare(`
            INSERT INTO events (name, location_id, model, start_date, status)
            VALUES ('Uden menu', ?, 'light', '2026-09-01', 'planning')
        `).run(locId).lastInsertRowid);
        dby.close();
        p = await http('GET', `/api/events/${otherEvent}/sales-prefill`);
        assert(p.status === 200 && p.data.price_source === 'grocy',
            'event uden menu bruger stadig Grocy-prisen som før');

        console.log('\n— Cascade: menuen forsvinder med eventet —');
        const dbz = openDb(TEST_DB);
        const before = dbz.prepare(`SELECT COUNT(*) c FROM event_menu_items WHERE event_id=?`).get(eventId).c;
        dbz.prepare(`DELETE FROM bons WHERE event_id=?`).run(eventId);
        dbz.prepare(`DELETE FROM events WHERE id=?`).run(eventId);
        const after = dbz.prepare(`SELECT COUNT(*) c FROM event_menu_items WHERE event_id=?`).get(eventId).c;
        dbz.close();
        assert(before === 5 && after === 0, `ON DELETE CASCADE rydder menuen (${before} → ${after})`);

    } finally {
        if (serverProc) serverProc.kill();
        try { require('fs').unlinkSync(TEST_DB); } catch {}
        for (const suf of ['-wal', '-shm']) { try { require('fs').unlinkSync(TEST_DB + suf); } catch {} }
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
