// scripts/test-event-prep-covers.js
// ============================================================
// Integration-test for flerdags-pakning (migration 156).
//
// Køkkenet pakker ofte ALT til et flerdags-event på én gang og topper først
// op dagen efter. Fysisk er det ÉN udlevering fra HQ — og fordi pakkelisten
// er kilden til lagertrækket (prep_packing_* er nøglet på bon_id), skal det
// være ÉN bon. `event_covers_until` siger hvor langt den rækker.
//
// Testen rammer de ÆGTE endpoints over HTTP mod en isoleret temp-DB, fordi
// valideringen og covered_days-beregningen sidder i route-laget. De to rene
// helpers kaldes derudover direkte, så randtilfældene kan efterprøves uden
// at bygge et event pr. tilfælde.
//
// Kør:
//   node --experimental-sqlite scripts/test-event-prep-covers.js
// ============================================================

const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-prepcovers-${Date.now()}.db`);
const PORT = 4336;
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

const LINE = (name, qty = 1, cat = '01 Sandwich') =>
    ({ product_name: name, quantity: qty, unit: 'stk', unit_price: 0, category: cat });

// ── Rene helpers (ingen server, ingen DB) ────────────────────────────────
function unitTests() {
    const { resolveCoversUntil, computeCoveredDays } = require('../routes/events');

    console.log('\n— resolveCoversUntil —');
    assert(resolveCoversUntil('2026-09-04', 'prep', '2026-09-03') === '2026-09-04',
        'senere dato på en prep-bon accepteres');
    assert(resolveCoversUntil('2026-09-03', 'prep', '2026-09-03') === null,
        'samme dag som pakkedagen dækker intet ekstra → null');
    assert(resolveCoversUntil('2026-09-02', 'prep', '2026-09-03') === null,
        'dato FØR pakkedagen giver null, ikke et bagudrettet interval');
    assert(resolveCoversUntil('2026-09-04', 'topup', '2026-09-03') === null,
        'top-up dækker aldrig andres dage');
    assert(resolveCoversUntil('2026-09-04', 'sales', '2026-09-03') === null,
        'salgsbon dækker aldrig andres dage');
    assert(resolveCoversUntil(null, 'prep', '2026-09-03') === null, 'null → null');
    assert(resolveCoversUntil('', 'prep', '2026-09-03') === null, 'tom streng → null');
    assert(resolveCoversUntil('4. september', 'prep', '2026-09-03') === false,
        'ugyldigt format afvises (kalderen svarer 400)');
    assert(resolveCoversUntil(20260904, 'prep', '2026-09-03') === false,
        'tal afvises — vi parser ikke gæt om til datoer');

    console.log('\n— computeCoveredDays —');
    const days = ['2026-09-03', '2026-09-04', '2026-09-05'];
    const prepBon = { id: 1, bon_number: 'B-1', delivery_date: '2026-09-03',
                      event_covers_until: '2026-09-05', status_code: 'GODKENDT' };
    let cov = computeCoveredDays([prepBon], days);
    assert(cov['2026-09-03'] === undefined,
        'pakkedagen er IKKE "dækket af en anden" — det er dagen mængderne står på');
    assert(cov['2026-09-04']?.bon_number === 'B-1', 'dag 2 er dækket');
    assert(cov['2026-09-05']?.bon_number === 'B-1', 'dag 3 er dækket (til og med)');
    assert(cov['2026-09-04']?.from === '2026-09-03', 'dækningen navngiver pakkedagen');

    assert(Object.keys(computeCoveredDays([{ ...prepBon, status_code: 'AFLYST' }], days)).length === 0,
        'en AFLYST prep-bon dækker ingenting — den forlod aldrig huset');
    assert(Object.keys(computeCoveredDays([{ ...prepBon, event_covers_until: null }], days)).length === 0,
        'bon uden covers_until dækker kun sig selv');
    assert(Object.keys(computeCoveredDays([prepBon], [])).length === 0, 'ingen dage → intet dækket');

    // To bons der overlapper: den tidligste vinder, deterministisk.
    const senere = { id: 2, bon_number: 'B-2', delivery_date: '2026-09-04',
                     event_covers_until: '2026-09-05', status_code: 'GODKENDT' };
    cov = computeCoveredDays([senere, prepBon], days);
    assert(cov['2026-09-05']?.bon_number === 'B-1',
        'ved overlap vinder den tidligste pakkedag uanset input-rækkefølge');
    // Dage uden for eventet må ikke dukke op.
    cov = computeCoveredDays([prepBon], ['2026-09-03', '2026-09-04']);
    assert(cov['2026-09-05'] === undefined, 'kun dage der findes i eventet markeres');
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    unitTests();

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);
    const TEST_PIN = '9999';
    const existingAdmin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (existingAdmin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, existingAdmin.id);
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

        // ── To-dages event ────────────────────────────────────────────────
        console.log('\n— Prep-bon der dækker begge dage —');
        const ev = (await http('POST', '/api/events', {
            name: 'Flerdags-pakning', location_id: locId,
            start_date: '2026-09-03', end_date: '2026-09-04',
        })).data;

        const created = await http('POST', `/api/events/${ev.id}/bons`, {
            role: 'prep', delivery_date: '2026-09-03', event_covers_until: '2026-09-04',
            lines: [LINE('Kyllingen', 120), LINE('Falaflen', 80)],
        });
        assert(created.status === 201, 'prep-bon oprettes');
        const bonId = created.data.id;
        assert(created.data.event_covers_until === '2026-09-04',
            'event_covers_until gemmes på bonnen');

        const ov = await http('GET', `/api/events/${ev.id}/overview`);
        assert(ov.status === 200, 'overview svarer');
        assert(ov.data.covered_days?.['2026-09-04']?.bon_number === created.data.bon_number,
            'dag 2 rapporteres som dækket af prep-bonnen');
        assert(ov.data.covered_days?.['2026-09-03'] === undefined,
            'pakkedagen står ikke som dækket af en anden');
        assert(ov.data.bons.find(b => b.id === bonId)?.event_covers_until === '2026-09-04',
            'bon-listen bærer feltet med (så perioden kan vises)');

        // Kernen: ÉT sted at pakke, ÉT lagertræk. Linjerne må ikke være delt
        // over to bons — det var hele grunden til at bygge feltet.
        const bon = (await http('GET', `/api/bons/${bonId}`)).data;
        assert(bon.lines.length === 2, 'begge dages varer ligger på samme bon');
        assert(ov.data.bons.filter(b => b.role === 'prep').length === 1,
            'der er præcis ÉN prep-bon for hele eventet');

        // ── Pakkelisten er dermed samlet af sig selv ──────────────────────
        console.log('\n— Pakkeliste og buffer hører til den ene bon —');
        const put = await http('PUT', `/api/bons/${bonId}/packing`, {
            overrides: [{ product_id: 42, product_name: 'Brød Rug', packed_amount: 30, unit: 'Kilo' }],
        });
        assert(put.status === 200, 'pakke-override kan gemmes på den samlede bon');
        const packing = (await http('GET', `/api/bons/${bonId}/packing`)).data;
        assert(packing.overrides.length === 1 && packing.overrides[0].packed_amount === 30,
            'overriden ligger ét sted — ikke fordelt over to bons');

        // ── Validering ────────────────────────────────────────────────────
        console.log('\n— Validering —');
        const bad = await http('POST', `/api/events/${ev.id}/bons`, {
            role: 'prep', delivery_date: '2026-09-03', event_covers_until: 'i overmorgen',
            lines: [LINE('X')],
        });
        assert(bad.status === 400, 'ugyldig dato afvises med 400');

        const sameDay = await http('POST', `/api/events/${ev.id}/bons`, {
            role: 'prep', delivery_date: '2026-09-03', event_covers_until: '2026-09-03',
            lines: [LINE('Y')],
        });
        assert(sameDay.status === 201 && sameDay.data.event_covers_until == null,
            'dækning på egen dag gemmes som NULL frem for en tom påstand');

        const asTopup = await http('POST', `/api/events/${ev.id}/bons`, {
            role: 'topup', delivery_date: '2026-09-04', event_covers_until: '2026-09-05',
            lines: [LINE('Z')],
        });
        assert(asTopup.status === 201 && asTopup.data.event_covers_until == null,
            'en top-up kan ikke gøre krav på andre dage');

        // ── Bagudkompatibilitet ───────────────────────────────────────────
        console.log('\n— Bagudkompatibilitet —');
        const ev2 = (await http('POST', '/api/events', {
            name: 'Dag-for-dag', location_id: locId,
            start_date: '2026-10-01', end_date: '2026-10-02',
        })).data;
        await http('POST', `/api/events/${ev2.id}/bons`, {
            role: 'prep', delivery_date: '2026-10-01', lines: [LINE('A', 50)],
        });
        await http('POST', `/api/events/${ev2.id}/bons`, {
            role: 'prep', delivery_date: '2026-10-02', lines: [LINE('B', 50)],
        });
        const ov2 = await http('GET', `/api/events/${ev2.id}/overview`);
        assert(Object.keys(ov2.data.covered_days || {}).length === 0,
            'to almindelige prep-bons markerer ingen dage som dækket');
        assert(ov2.data.bons.filter(b => b.role === 'prep').length === 2,
            'dag-for-dag-flowet er uændret');

    } finally {
        if (serverProc) serverProc.kill();
        try { require('fs').unlinkSync(TEST_DB); } catch {}
        for (const suf of ['-wal', '-shm']) { try { require('fs').unlinkSync(TEST_DB + suf); } catch {} }
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
