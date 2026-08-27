// scripts/test-event-rest-prep-http.js
// ============================================================
// REST-PREP over HTTP (migration 166) — de ægte endpoints, ikke helperen:
//   POST /api/events/:id/bons                     (opret med flaget + genberegn)
//   POST /api/events/:id/bons/:bonId/rest-prep    (slå til/fra bagefter)
//   PUT  /api/events/:id/forecast                 (mål flytter sig ⇒ rest følger med)
//   GET  /api/events/:id/overview                 (bridge_prepped + original_qty)
//
// Spawner en frisk server mod isoleret test-DB i /tmp — drift røres ikke.
// Broens prep-bon lægges direkte i DB'en før serveren startes: den ægte
// webhook kalder Grocy, og det er ikke det der testes her.
//
// Kør:  node --experimental-sqlite scripts/test-event-rest-prep-http.js
// ============================================================

const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-restprep-http-${Date.now()}.db`);
const PORT = 4334;
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
    const res = await fetch(BASE + url, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

const DAY1 = '2026-09-02';
const DAY2 = '2026-09-03';
const SW   = '01 Sandwich';
const ACC  = 'Tilbehør & Bokse';
const L = (name, qty, cat) => ({ product_name: name, quantity: qty, unit: 'stk', unit_price: 0, category: cat });

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN);

    const locId  = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const prodPc = db.prepare(`SELECT id FROM price_categories WHERE code='produktion'`).get().id;
    const godkendt = db.prepare(`SELECT id FROM status_definitions WHERE code='GODKENDT'`).get().id;

    // Broens prep-bon for en event-dag: forudbestillinger, allerede solgt.
    let seq = 0;
    function seedEventWithBridge(name, bridgeLines) {
        const evId = Number(db.prepare(`
            INSERT INTO events (name, location_id, model, start_date, end_date, status)
            VALUES (?, ?, 'light', ?, ?, 'planning')
        `).run(name, locId, DAY1, DAY2).lastInsertRowid);
        db.prepare(`INSERT INTO event_forecast (event_id, forecast_date, category, expected_qty) VALUES (?,?,?,400)`)
          .run(evId, DAY1, SW);
        const bonId = Number(db.prepare(`
            INSERT INTO bons (bon_number, status_id, location_id, price_category_id, event_id, event_role,
                              order_date, delivery_date, delivery_type, pax, total_units, payment_type,
                              total_price, total_with_delivery)
            VALUES (?, ?, ?, ?, ?, 'prep', ?, ?, 'event', 0, 0, 'cash', 0, 0)
        `).run(`T_BR_${++seq}`, godkendt, locId, prodPc, evId, DAY1, DAY1).lastInsertRowid);
        const ins = db.prepare(`
            INSERT INTO bon_lines (bon_id, product_name, category, quantity, unit, unit_price, line_total, sort_order)
            VALUES (?, ?, ?, ?, 'stk', 0, 0, ?)`);
        bridgeLines.forEach((l, i) => ins.run(bonId, l.n, SW, l.q, i));
        const tot = bridgeLines.reduce((a, l) => a + l.q, 0);
        db.prepare(`UPDATE bons SET total_units = ? WHERE id = ?`).run(tot, bonId);
        db.prepare(`INSERT INTO event_bridge_bons (event_id, delivery_date, role, bon_id) VALUES (?,?,'prep',?)`)
          .run(evId, DAY1, bonId);
        return { evId, bridgeBonId: bonId, bridgeNumber: `T_BR_${seq}` };
    }

    // Drifts-tallene fra Ungdommens folkemøde 2. sep 2026.
    const A = seedEventWithBridge('RP-http uden flag', [{ n: '"Tunen"', q: 93 }, { n: 'Italieneren', q: 136 }, { n: 'Kartoflen', q: 103 }]);
    const B = seedEventWithBridge('RP-http med flag', [{ n: '"Tunen"', q: 93 }, { n: 'Italieneren', q: 136 }, { n: 'Kartoflen', q: 103 }]);
    db.close();

    const PREP_LINES = [L('"Tunen"', 133, SW), L('Italieneren', 133, SW), L('Kartoflen', 133, SW), L('Glutenfri Bolle', 20, ACC)];

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
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write('  [server-err] ' + s);
        });
        if (!await waitForServer()) throw new Error('Server startede ikke');
        if ((await http('POST', '/api/auth/pin', { pin: TEST_PIN })).status !== 200) throw new Error('Login fejlede');

        // ── 1) Uden flaget: bonnen står som office tastede den ────────────
        console.log('\n— Uden flaget (nuværende adfærd, uændret) —');
        const a1 = await http('POST', `/api/events/${A.evId}/bons`, { role: 'prep', delivery_date: DAY1, lines: PREP_LINES });
        assert(a1.status === 201, 'prep-bon oprettes');
        assert(a1.data.rest_prep == null, 'ingen genberegning uden flaget');
        // 399, ikke 400: total_units tæller kun kategorier i unit_count_categories,
        // så Glutenfri Bolle (Tilbehør & Bokse) tælles ikke som en solgt enhed.
        assert(a1.data.total_units === 399, `bonnen står uændret på 399 sandwich (fik ${a1.data.total_units})`);

        // ── 2) Med flaget: bonnen holder RESTEN ───────────────────────────
        console.log('\n— Med flaget: rest = mål − forudbestilt —');
        const b1 = await http('POST', `/api/events/${B.evId}/bons`, {
            role: 'prep', delivery_date: DAY1, lines: PREP_LINES, event_prep_auto_rest: 1,
        });
        assert(b1.status === 201, 'rest-bon oprettes');
        assert(b1.data.rest_prep?.action === 'updated', 'genberegnet med det samme');
        assert(b1.data.rest_prep?.rest_total === 68, `rest = 400 − 332 = 68 (fik ${b1.data.rest_prep?.rest_total})`);
        assert(b1.data.rest_prep?.bridge_total === 332, `forudbestilt rapporteret som 332 (fik ${b1.data.rest_prep?.bridge_total})`);
        const restId = b1.data.id;

        const bon1 = (await http('GET', `/api/bons/${restId}`)).data;
        assert(bon1.total_units === 68, `bonnens enheder er 68 (fik ${bon1.total_units})`);
        const swSum = bon1.lines.filter(l => l.category === SW).reduce((a, l) => a + l.quantity, 0);
        assert(swSum === 68, `sandwich-linjerne summer til 68 (fik ${swSum})`);
        assert(bon1.lines.find(l => l.category === ACC)?.quantity === 20, 'kategori uden forecast er urørt');
        assert(/Rest ud over det forudbestilte/.test(bon1.kitchen_info || ''), 'køkkentekst sat på bonnen');
        assert((bon1.kitchen_info || '').includes(B.bridgeNumber), 'køkkenteksten peger på bro-bonnen');

        // Summen af de to bons er dagens mål — det er hele pointen.
        const ov1 = (await http('GET', `/api/events/${B.evId}/overview`)).data;
        const dayUnits = ov1.bons.filter(x => x.delivery_date === DAY1 && x.price_category_code === 'produktion')
            .reduce((a, x) => a + (x.total_units || 0), 0);
        assert(dayUnits === 400, `de to prep-bons summer til 400, ikke 732 (fik ${dayUnits})`);

        // ── 3) Kun én rest-bon pr. dag ────────────────────────────────────
        console.log('\n— Kun én rest-bon pr. dag —');
        const dup = await http('POST', `/api/events/${B.evId}/bons`, {
            role: 'prep', delivery_date: DAY1, lines: [L('X', 5, SW)], event_prep_auto_rest: 1,
        });
        assert(dup.status === 409, `dublet afvises (fik ${dup.status})`);
        assert(dup.data?.error?.includes('holder allerede resten'), 'fejlbeskeden siger hvem der holder resten');
        const dayOther = await http('POST', `/api/events/${B.evId}/bons`, {
            role: 'prep', delivery_date: DAY2, lines: [L('X', 5, SW)], event_prep_auto_rest: 1,
        });
        assert(dayOther.status === 201, 'en anden dag er helt i orden');

        // ── 4) overview leverer regnestykket til tabellen ─────────────────
        console.log('\n— overview: forudbestilt kan ses ─');
        assert(ov1.bridge_prepped?.[`${DAY1}|${SW}`] === 332, 'bridge_prepped pr. (dag|kategori)');
        assert(ov1.bons.find(x => x.id === restId)?.event_prep_auto_rest === 1, 'bon-listen mærker rest-bonnen');
        assert(ov1.bons.find(x => x.id === B.bridgeBonId)?.is_bridge === 1, 'bon-listen mærker bro-bonnen');

        // ── 5) Forecasten rettes ⇒ resten følger med ──────────────────────
        console.log('\n— Forecasten rettes ⇒ resten følger med —');
        const fc = await http('PUT', `/api/events/${B.evId}/forecast`, {
            items: [{ forecast_date: DAY1, category: SW, expected_qty: 500 }],
        });
        assert(fc.status === 200, 'forecast gemt');
        assert(fc.data.rest_prep?.some(r => r.rest_total === 168), `rest = 500 − 332 = 168 (fik ${JSON.stringify(fc.data.rest_prep?.map(r => r.rest_total))})`);
        assert((await http('GET', `/api/bons/${restId}`)).data.total_units === 168, 'bonnen er fulgt med op');

        // ── 6) Den oprindelige forecast bevares ───────────────────────────
        console.log('\n— Den oprindelige forecast bevares —');
        const row = fc.data.forecast.find(f => f.forecast_date === DAY1 && f.category === SW);
        assert(row.expected_qty === 500, 'det nye tal står');
        assert(row.original_qty === 400, `det oprindelige gæt er bevaret (fik ${row.original_qty})`);
        const fc2 = await http('PUT', `/api/events/${B.evId}/forecast`, {
            items: [{ forecast_date: DAY1, category: SW, expected_qty: 550 }],
        });
        assert(fc2.data.forecast.find(f => f.forecast_date === DAY1).original_qty === 400,
            'anden rettelse overskriver ikke det oprindelige gæt');

        // ── 7) Ordrerne overhaler forecasten ─────────────────────────────
        console.log('\n— Ordrerne overhaler forecasten —');
        await http('PUT', `/api/events/${B.evId}/forecast`, {
            items: [{ forecast_date: DAY1, category: SW, expected_qty: 100 }],
        });
        const overtaken = (await http('GET', `/api/bons/${restId}`)).data;
        assert(overtaken.total_units === 0, `rest = 0 når 332 forudbestilte overhaler forecast 100 (fik ${overtaken.total_units})`);
        assert(/hele dagens mål er forudbestilt/.test(overtaken.kitchen_info || ''),
            'køkkenteksten forklarer hvorfor bonnen står med 0');
        assert(overtaken.lines.length === 4, 'bonnen står stadig med sine linjer — den forsvinder ikke');

        // ── 8) Til/fra på en bon der allerede findes ──────────────────────
        console.log('\n— Til/fra bagefter —');
        const off = await http('POST', `/api/events/${B.evId}/bons/${restId}/rest-prep`, { enabled: false });
        assert(off.status === 200 && off.data.enabled === false, 'kan slås fra');
        await http('PUT', `/api/events/${B.evId}/forecast`, { items: [{ forecast_date: DAY1, category: SW, expected_qty: 900 }] });
        assert((await http('GET', `/api/bons/${restId}`)).data.total_units === 0,
            'en frakoblet bon retter sig ikke længere selv');
        const on = await http('POST', `/api/events/${B.evId}/bons/${restId}/rest-prep`, { enabled: true });
        assert(on.status === 200 && on.data.rest_prep?.rest_total === 568, `slås til igen og genberegner straks (fik ${on.data.rest_prep?.rest_total})`);

        // Broens egen bon kan ikke også være resten.
        const bridgeToggle = await http('POST', `/api/events/${B.evId}/bons/${B.bridgeBonId}/rest-prep`, { enabled: true });
        assert(bridgeToggle.status === 400, `broens bon afvises (fik ${bridgeToggle.status})`);
        assert(/ER forudbestillingerne/.test(bridgeToggle.data?.error || ''), 'og får at vide hvorfor');

        // Salgs-/udgiftsbons har intet mål at holde.
        const sales = await http('POST', `/api/events/${B.evId}/bons`, { role: 'sales', delivery_date: DAY1, lines: [L('X', 1, SW)] });
        const salesToggle = await http('POST', `/api/events/${B.evId}/bons/${sales.data.id}/rest-prep`, { enabled: true });
        assert(salesToggle.status === 400, 'kun en prep-bon kan holde resten');

        // ── 9) Frysen gælder også over HTTP ───────────────────────────────
        console.log('\n— Frysen —');
        await http('PATCH', `/api/bons/${restId}/status`, { status_code: 'IGANG' });
        const frozen = await http('POST', `/api/events/${B.evId}/bons/${restId}/rest-prep`, { enabled: true });
        assert(frozen.data.rest_prep?.action === 'frozen', 'en bon køkkenet er i gang med genberegnes ikke');
        const before = (await http('GET', `/api/bons/${restId}`)).data.total_units;
        await http('PUT', `/api/events/${B.evId}/forecast`, { items: [{ forecast_date: DAY1, category: SW, expected_qty: 1200 }] });
        assert((await http('GET', `/api/bons/${restId}`)).data.total_units === before,
            'og bevæger sig ikke selvom målet flytter sig');

    } finally {
        if (serverProc) serverProc.kill();
        try { require('fs').unlinkSync(TEST_DB); } catch {}
        for (const suf of ['-wal', '-shm']) { try { require('fs').unlinkSync(TEST_DB + suf); } catch {} }
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
