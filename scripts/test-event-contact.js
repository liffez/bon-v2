// scripts/test-event-contact.js
// ============================================================
// Integration-test for eventets kontaktperson (migration 139).
//
// Spawner en frisk server mod isoleret test-DB i /tmp — prod røres ikke.
// Rammer de ÆGTE endpoints over HTTP, fordi arven ligger i route-handlerne
// (bon-generatoren + apply-contact), ikke i et lag man kan kalde direkte:
//   POST  /api/events            (opret med kontaktperson)
//   PATCH /api/events/:id        (sæt/ryd kontakt bagefter)
//   POST  /api/events/:id/bons   (bon arver kunde + dagskontakt)
//   GET   /api/events/:id/overview     (tæller bons uden kunde)
//   POST  /api/events/:id/apply-contact (udfyld eksisterende bons)
//
// Kør:
//   node --experimental-sqlite scripts/test-event-contact.js
// ============================================================

const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-eventcontact-${Date.now()}.db`);
const PORT = 4333;
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

const LINE = (name, qty = 1) => ({ product_name: name, quantity: qty, unit: 'stk', unit_price: 0 });

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

    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const companyId = Number(db.prepare(
        `INSERT INTO companies (name) VALUES ('Ungdomsbureauet')`
    ).run().lastInsertRowid);
    const customerId = Number(db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone, company_id)
        VALUES ('Mathias', 'Tingberg', 'mathias@example.invalid', '12345678', ?)
    `).run(companyId).lastInsertRowid);
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

        // ── 1) Event oprettet MED kontaktperson ───────────────────────────
        console.log('\n— Event med kontaktperson —');
        const c = await http('POST', '/api/events', {
            name: 'Kontakt-test', location_id: locId,
            start_date: '2026-09-02', end_date: '2026-09-03',
            customer_id: customerId, company_id: companyId,
        });
        assert(c.status === 201, 'event oprettes med kontaktperson');
        const ev = c.data;
        assert(ev.customer_id === customerId, 'customer_id gemmes på eventet');
        assert(ev.contact_name === 'Mathias Tingberg', `kundens navn joines med (${ev.contact_name})`);
        assert(ev.contact_company_name === 'Ungdomsbureauet', 'firmanavnet joines med');

        const prep = await http('POST', `/api/events/${ev.id}/bons`, {
            role: 'prep', delivery_date: '2026-09-02', lines: [LINE('Tunen', 133)],
        });
        assert(prep.status === 201 || prep.status === 200, 'prep-bon oprettes');
        const prepBon = (await http('GET', `/api/bons/${prep.data.bon_id ?? prep.data.id}`)).data;
        assert(prepBon.customer_id === customerId, 'prep-bon arver kunden');
        assert(prepBon.company_id === companyId, 'prep-bon arver firmaet');
        assert(prepBon.day_contact_name === 'Mathias Tingberg',
            'dagskontakt falder tilbage til kundens navn når den ikke er sat separat');
        assert(prepBon.day_contact_phone === '12345678', 'dagskontakt-telefon falder tilbage til kundens');

        // Separat dagskontakt (én bestiller, en anden står på pladsen)
        await http('PATCH', `/api/events/${ev.id}`, {
            day_contact_name: 'Anne på pladsen', day_contact_phone: '87654321',
        });
        const sales = await http('POST', `/api/events/${ev.id}/bons`, {
            role: 'sales', delivery_date: '2026-09-02',
            lines: [{ product_name: 'Tunen', quantity: 5, unit: 'stk', unit_price: 100 }],
        });
        const salesBon = (await http('GET', `/api/bons/${sales.data.bon_id ?? sales.data.id}`)).data;
        assert(salesBon.day_contact_name === 'Anne på pladsen', 'separat dagskontakt vinder over kundens navn');
        assert(salesBon.customer_id === customerId, 'salgsbonnen arver stadig kunden');

        // Eksplicit kunde i kaldet slår eventets
        const other = await http('POST', `/api/events/${ev.id}/bons`, {
            role: 'expense', delivery_date: '2026-09-02', customer_id: null,
            lines: [{ product_name: 'Stadeleje', quantity: 1, unit: 'stk', unit_price: 500 }],
        });
        const expBon = (await http('GET', `/api/bons/${other.data.bon_id ?? other.data.id}`)).data;
        assert(expBon.customer_id === customerId,
            'customer_id: null i payload betyder "ikke angivet" og arver stadig (?? -operatoren)');

        // ── 2) Event UDEN kontakt → kontakt tilføjet bagefter ─────────────
        console.log('\n— Kontakt tilføjet efter at bons er lavet —');
        const ev2 = (await http('POST', '/api/events', {
            name: 'Uden kontakt', location_id: locId, start_date: '2026-09-02',
        })).data;
        assert(ev2.customer_id == null, 'event uden kontakt gemmes uden kunde');

        const b1 = await http('POST', `/api/events/${ev2.id}/bons`, { role: 'prep', lines: [LINE('Kartoflen', 10)] });
        const b2 = await http('POST', `/api/events/${ev2.id}/bons`, { role: 'prep', lines: [LINE('Italieneren', 10)] });
        const id1 = b1.data.bon_id ?? b1.data.id, id2 = b2.data.bon_id ?? b2.data.id;
        assert((await http('GET', `/api/bons/${id1}`)).data.customer_id == null,
            'bon oprettet uden event-kontakt står uden kunde');

        // Bon 2 har fået en håndskrevet dagskontakt — den skal overleve
        await http('PATCH', `/api/bons/${id2}`, { day_contact_name: 'Rettet i hånden' });

        let ovw = (await http('GET', `/api/events/${ev2.id}/overview`)).data;
        assert(ovw.bons_missing_contact === 0,
            'ingen "mangler kunde"-tæller så længe eventet selv mangler kontakten');

        const applyTooEarly = await http('POST', `/api/events/${ev2.id}/apply-contact`);
        assert(applyTooEarly.status === 400, 'apply-contact afvises når eventet ingen kontakt har');

        await http('PATCH', `/api/events/${ev2.id}`, { customer_id: customerId, company_id: companyId });
        ovw = (await http('GET', `/api/events/${ev2.id}/overview`)).data;
        assert(ovw.bons_missing_contact === 2, `2 bons mangler kunde (fik ${ovw.bons_missing_contact})`);

        const applied = await http('POST', `/api/events/${ev2.id}/apply-contact`);
        assert(applied.data.updated === 2, `apply-contact udfylder 2 bons (fik ${applied.data.updated})`);
        const a1 = (await http('GET', `/api/bons/${id1}`)).data;
        const a2 = (await http('GET', `/api/bons/${id2}`)).data;
        assert(a1.customer_id === customerId && a1.company_id === companyId, 'bon 1 fik kunde + firma');
        assert(a1.day_contact_name === 'Mathias Tingberg', 'bon 1 fik dagskontakt');
        assert(a2.customer_id === customerId, 'bon 2 fik kunden');
        assert(a2.day_contact_name === 'Rettet i hånden', 'bon 2 beholder sin håndskrevne dagskontakt');
        assert((await http('GET', `/api/events/${ev2.id}/overview`)).data.bons_missing_contact === 0,
            'tælleren er nul bagefter');
        assert((await http('POST', `/api/events/${ev2.id}/apply-contact`)).data.updated === 0,
            'anden kørsel rører intet (idempotent)');

        // ── 3) Kontakten kan ryddes igen ──────────────────────────────────
        console.log('\n— Kontakten kan ryddes —');
        await http('PATCH', `/api/events/${ev2.id}`, { customer_id: null, company_id: null });
        assert((await http('GET', `/api/events/${ev2.id}`)).data.customer_id == null,
            'customer_id kan sættes til null igen');
        const b3 = await http('POST', `/api/events/${ev2.id}/bons`, { role: 'prep', lines: [LINE('X')] });
        assert((await http('GET', `/api/bons/${b3.data.bon_id ?? b3.data.id}`)).data.customer_id == null,
            'ny bon arver ikke den ryddede kontakt');

    } finally {
        if (serverProc) serverProc.kill();
        try { require('fs').unlinkSync(TEST_DB); } catch {}
        for (const suf of ['-wal', '-shm']) { try { require('fs').unlinkSync(TEST_DB + suf); } catch {} }
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
