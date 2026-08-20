// scripts/test-receipt-schema-e2e.js
// ============================================================
// Integrationstest: FVST-skemaet hele vejen fra tavlen til registreringen.
//
// Kæden vi låser fast:
//   Whiteboard (attrap)  →  GET /api/goods-receipts/schema
//                        →  POST /api/goods-receipts
//                        →  goods_receipts-rækken i databasen
//                        →  payloaden der sendes tilbage til FVST-loggen
//
// Hvorfor en integrationstest ud over unit-testen: hvert led kan være rigtigt
// hver for sig og alligevel tabe et felt på vejen. Produktnavnet skulle
// gennem en destructuring, en INSERT med 20 kolonner og en webhook-payload —
// tre steder hvor et felt kan falde ud uden at nogen opdager det.
//
// Attrappen står for tavlen, så testen kan køre uden netværk og uden at
// afhænge af hvad der tilfældigvis står i whiteboards skema i dag.
//
// Kør:  node --experimental-sqlite scripts/test-receipt-schema-e2e.js
// ============================================================

const path = require('path');
const os   = require('os');
const http = require('http');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-schema-${Date.now()}.db`);
const PORT       = 4337;
const TAVLE_PORT = 4338;
const BASE  = `http://localhost:${PORT}`;
const SECRET = 'e2e-hemmelighed';

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}

// ── Attrap-tavle: leverer skemaet OG tager imod webhooken ──
let receivedWebhook = null;
let schemaHits = 0;

const TAVLE_FIELDS = [
    { id: 'temperature', type: 'number', label: '🧊 Kølevarer', hint: 'max. 5°C',
      warn_above: 4, action_above: 5, default_value: 4.5, optional_toggle: true, unit: '°C' },
    { id: 'temp_product', type: 'text', label: 'Målt på (kølevare)', hint: 'Hvilken vare blev målt?' },
    { id: 'temperature_freezer', type: 'number', label: '❄️ Frysvarer', hint: 'max. -18°C',
      warn_above: -19, action_above: -18, default_value: -20, optional_toggle: true, toggle_default_off: true },
    { id: 'temp_product_freezer', type: 'text', label: 'Målt på (frostvare)' },
    { id: 'date_ok', type: 'checkbox', label: 'Dato/holdbarhed kontrolleret', required: true },
    { id: 'label_ok', type: 'checkbox', label: 'Mærkning kontrolleret', required: true },
    { id: 'packaging_ok', type: 'checkbox', label: 'Emballage kontrolleret', required: true },
    { id: 'deviation', type: 'select', label: 'Afvigelse — handling', options: [
        { value: 'none', label: 'Ingen afvigelse' },
        { value: 'returned', label: 'Varen er returneret' },
        { value: 'accepted_no_risk', label: 'Vurderet — ingen risiko' },
    ]},
    // Et felt tavlen har tilføjet EFTER Bon v2 blev bygget. Hele pointen:
    // det skal virke uden en kodeændring i Bon v2.
    { id: 'chauffor', type: 'text', label: 'Chauffør' },
];

const tavle = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/registration-types/schema') {
        schemaHits++;
        if (req.headers['x-webhook-secret'] !== SECRET) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end('{"error":"nej"}');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ key: 'varemodtagelse', name: 'Varemodtagelse', fields: TAVLE_FIELDS }));
    }
    if (url.pathname === '/api/events/webhook') {
        let body = '';
        req.on('data', c => body += c);
        return req.on('end', () => {
            try { receivedWebhook = JSON.parse(body); } catch { receivedWebhook = { _raw: body }; }
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end('{"id":1}');
        });
    }
    res.writeHead(404); res.end();
});

async function waitForServer(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

let _cookies = [];
async function http_(method, url, body) {
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

    db.prepare(`UPDATE settings SET value=? WHERE key='whiteboard_webhook_url'`)
      .run(`http://localhost:${TAVLE_PORT}/api/events/webhook`);
    db.close();

    await new Promise(r => tavle.listen(TAVLE_PORT, '127.0.0.1', r));

    let serverProc = null;
    try {
        console.log(`\nStarter test-server på port ${PORT} (attrap-tavle på ${TAVLE_PORT})`);
        serverProc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB,
                   GOODS_RECEIPT_WEBHOOK_SECRET: SECRET, NODE_ENV: 'development' },
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

        await http_('POST', '/api/auth/pin', { pin: TEST_PIN });

        console.log('\n— Skemaet kommer fra tavlen —');
        let r = await http_('GET', '/api/goods-receipts/schema');
        assert(r.status === 200, 'GET /api/goods-receipts/schema svarer 200');
        assert(r.data.source === 'whiteboard', `skemaet er hentet fra tavlen (fik '${r.data.source}')`);
        assert(schemaHits > 0, 'tavlen blev faktisk spurgt');

        const ids = r.data.fields.map(f => f.id);
        assert(ids.includes('temp_product'), 'produktfeltet er med');
        assert(ids.includes('chauffor'), 'et felt tavlen har tilføjet er med');
        assert(!r.data.known_field_ids.includes('chauffor'),
            'og det er markeret som et felt Bon v2 ikke selv håndterer');

        const temp = r.data.fields.find(f => f.id === 'temperature');
        assert(temp.action_above === 5 && temp.warn_above === 4,
            'grænseværdierne kommer med — det var dem der før stod skrevet af i JavaScript');

        const dev = r.data.fields.find(f => f.id === 'deviation');
        assert(dev.options.some(o => o.value === 'no_risk'),
            "tavlens 'accepted_no_risk' er oversat til Bon v2's 'no_risk'");
        assert(!dev.options.some(o => o.value === 'none'),
            "'Ingen afvigelse' er væk — den modsiger den sektion man står i");

        console.log('\n— Registrering med målt vare —');
        r = await http_('POST', '/api/goods-receipts', {
            supplier_name: 'Testleverandøren',
            received_by_name: 'Tester',
            temperature_cool_enabled: true,
            temperature_cool_value: 3.5,
            temperature_cool_ok: true,
            temperature_cool_product: '  Spidskål  ',
            temperature_frozen_enabled: false,
            temperature_frozen_value: null,
            temperature_frozen_product: 'Skal ikke gemmes',
            date_check_ok: true, labeling_check_ok: true, packaging_check_ok: true,
            has_deviation: false,
            extra_fields: { chauffor: 'Jens', findes_ikke: 'skal filtreres væk', temperature: 999 },
            items: [],
        });
        assert(r.status === 200 || r.status === 201, `registreringen gemmes (${r.status})`);
        const receiptId = r.data.receipt?.id ?? r.data.id;

        const db2 = openDb(TEST_DB);
        const row = db2.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(receiptId);

        assert(row.temperature_cool_product === 'Spidskål',
            `den målte vare er gemt og trimmet (fik '${row.temperature_cool_product}')`);
        assert(row.temperature_frozen_product === null,
            'frost-produktet gemmes IKKE når frost-toggle er slået fra — der er intet målt');

        const extra = JSON.parse(row.extra_fields_json || '{}');
        assert(extra.chauffor === 'Jens', 'tavlens eget felt er gemt');
        assert(!('findes_ikke' in extra), 'et felt der ikke står i skemaet blev filtreret væk');
        assert(!('temperature' in extra),
            'et felt med egen kolonne havner ikke også her — ellers stod tallet to steder');
        db2.close();

        console.log('\n— Videre til FVST-loggen —');
        for (let i = 0; i < 40 && !receivedWebhook; i++) await new Promise(r => setTimeout(r, 100));
        assert(!!receivedWebhook, 'webhooken nåede frem til tavlen');
        if (receivedWebhook) {
            const d = receivedWebhook.data || {};
            assert(d.temperature === 3.5, 'temperaturen er med');
            assert(d.temp_product === 'Spidskål',
                'den målte vare sendes under tavlens eget felt-id');
            assert(!('temp_product_freezer' in d),
                'frost-produktet sendes ikke når der ikke blev målt frost');
            assert(d.chauffor === 'Jens',
                'og tavlens eget felt kommer retur — hele vejen rundt uden kode i Bon v2');
        }

        console.log('\n— Tavlen går ned —');
        await new Promise(r => tavle.close(r));
        // Ryd server-cachen ved at bede om et friskt skema efter TTL... det kan
        // vi ikke fremtvinge udefra, så vi nøjes med at slå fast at endpointet
        // stadig svarer med et brugbart skema.
        r = await http_('GET', '/api/goods-receipts/schema');
        assert(r.status === 200, 'skemaet svarer stadig 200 når tavlen er væk');
        assert(Array.isArray(r.data.fields) && r.data.fields.length > 0,
            'og formularen kan stadig bygges — fødevarekontrol er lovpligtig');

    } finally {
        if (serverProc) serverProc.kill();
        try { tavle.close(); } catch {}
        try { require('fs').unlinkSync(TEST_DB); } catch {}
    }

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
