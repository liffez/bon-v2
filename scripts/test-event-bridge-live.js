// scripts/test-event-bridge-live.js
// ============================================================
// Fase 5 — LIVE smoke for event-broen. Spawner en frisk bon-v2-server mod en
// isoleret temp-DB (prod urørt) og rammer de ÆGTE HTTP-endpoints mod grocytest:
//   GET  /webhook/event-menu   (Grocy-shaping over HTTP + secret-gate)
//   POST /webhook/event-prep   (opret/reconcile prep-bon over HTTP + secret-gate)
// Verificerer resultatet gennem den rigtige API (/api/events/:id/overview).
//
// Kræver grocytest (som andre Grocy-tracks). Kør:
//   node --experimental-sqlite scripts/test-event-bridge-live.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { spawn } = require('child_process');

// Worktree'ets .env er gitignored og findes kun i hoved-repoet. Injicér dets
// GROCY_*-nøgler så den spawnede server kan nå grocytest (kun nøgle-navne løftes,
// intet printes). Uden dette svarer Grocy "mangler api_key" og smoken kan ikke køre.
function loadGrocyEnvFromMainRepo() {
    const mainRoot = __dirname.split('/.claude/worktrees/')[0];
    const envPath = path.join(mainRoot, '.env');
    if (!fs.existsSync(envPath)) return false;
    let loaded = 0;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = /^\s*(GROCY_[A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const val = m[2].trim().replace(/^["']|["']$/g, '');
        if (!process.env[m[1]]) { process.env[m[1]] = val; loaded++; }
    }
    return loaded > 0;
}

const TEST_DB = path.join(os.tmpdir(), `bon-test-bridge-live-${Date.now()}.db`);
const PORT = 4332;
const BASE = `http://localhost:${PORT}`;
const SECRET = 'smoke-secret';
const TEST_PIN = '9999';

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
async function http(method, url, body, headers = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (_cookies.length) h.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

async function main() {
    if (!loadGrocyEnvFromMainRepo()) console.warn('  ⚠ ingen GROCY_*-nøgler fundet i hoved-repoets .env — Grocy-delen vil fejle');
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    // Test-admin PIN (til overview-verifikationen) + bro-secret + syntetisk event.
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Smoke Admin','smoke@local','admin',?,1)`).run(TEST_PIN);

    db.prepare(`INSERT INTO settings (key, value) VALUES ('event_bridge_secret', ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(SECRET);

    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const eventId = Number(db.prepare(`
        INSERT INTO events (name, location_id, model, start_date, end_date, status)
        VALUES ('Smoke-event', ?, 'light', '2026-09-01', '2026-09-02', 'planning')
    `).run(locId).lastInsertRowid);
    // Kurateret event-menu: kun 2 varer med event-priser (≠ festival)
    db.prepare(`INSERT INTO event_menu_items (event_id, grocy_recipe_id, product_name, category, unit_price, sort_order) VALUES (?,?,?,?,?,?)`).run(eventId, 91, 'Kurateret A', 'Menu', 111, 1);
    db.prepare(`INSERT INTO event_menu_items (event_id, grocy_recipe_id, product_name, category, unit_price, sort_order) VALUES (?,?,?,?,?,?)`).run(eventId, 92, 'Kurateret B', 'Menu', 222, 2);
    db.close(); // undgå samtidige handles med serveren

    let proc = null;
    try {
        console.log(`\nStarter bon-v2 test-server på :${PORT} (grocytest)`);
        proc = spawn('node', ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, PORT: String(PORT), DB_PATH: TEST_DB },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.stderr.on('data', d => {
            const s = d.toString();
            if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write('  [server] ' + s);
        });
        if (!await waitForServer()) throw new Error('Server startede ikke');

        // ── MENU-endpoint ────────────────────────────────────────────────────
        console.log('\n— GET /webhook/event-menu —');
        let r = await http('GET', '/webhook/event-menu');
        assert(r.status === 401, 'menu uden secret → 401');

        r = await http('GET', '/webhook/event-menu', null, { 'x-webhook-secret': SECRET });
        assert(r.status === 200, 'menu med secret → 200');
        assert(r.data && Array.isArray(r.data.items), 'menu har items-array');
        assert(Array.isArray(r.data.categories), 'menu har categories-array');
        console.log(`    (grocytest gav ${r.data?.items?.length ?? 0} varer)`);

        const rItems = (r.data.items || []).filter(it => /^r\d+$/.test(it.id));
        assert(rItems.length > 0, 'mindst én vare med gyldig r<id> fra Grocy');
        if (rItems.length) {
            assert(typeof rItems[0].price === 'number', 'vare har numerisk pris (øre)');
        }

        // Event-menu: ?event=<id> giver KUN de kuraterede varer (ikke hele Grocy)
        r = await http('GET', `/webhook/event-menu?event=${eventId}`, null, { 'x-webhook-secret': SECRET });
        assert(r.status === 200 && r.data.source === 'event-menu', 'event-menu: ?event → source=event-menu');
        assert(Array.isArray(r.data.items) && r.data.items.length === 2, 'event-menu: kun de 2 kuraterede varer (ikke 118)');
        assert(r.data.items[0].id === 'r91' && r.data.items[0].price === 11100, 'event-menu: r-id + event-pris i øre (111 kr)');

        // Vælg op til 2 ægte opskrift-id'er til prep-push
        const realIds = rItems.slice(0, 2).map((it, i) => ({ grocy_recipe_id: Number(it.id.slice(1)), antal: (i + 1) * 4 }));

        // ── PREP-endpoint: gate + validering ─────────────────────────────────
        console.log('\n— POST /webhook/event-prep (gate + validering) —');
        r = await http('POST', '/webhook/event-prep', { event_id: eventId, date: '2026-09-01', lines: realIds });
        assert(r.status === 401, 'prep uden secret → 401');

        const H = { 'x-webhook-secret': SECRET };
        r = await http('POST', '/webhook/event-prep', { event_id: eventId, date: '2026-09-01', lines: [] }, H);
        assert(r.status === 400, 'prep med tomme lines → 400');

        r = await http('POST', '/webhook/event-prep', { event_id: 999999, date: '2026-09-01', lines: realIds }, H);
        assert(r.status === 404, 'prep med ukendt event → 404');

        // ── PREP-endpoint: opret + reconcile ─────────────────────────────────
        console.log('\n— POST /webhook/event-prep (opret + reconcile) —');
        r = await http('POST', '/webhook/event-prep', { event_id: eventId, date: '2026-09-01', lines: realIds }, H);
        assert(r.status === 201 && r.data.action === 'created', 'første push → 201 created');
        assert(typeof r.data.bon_number === 'string', 'created → bon_number');
        const created = r.data;
        console.log(`    (matchede ${created.lines} linjer, ${created.unmatched?.length ?? 0} unmatched)`);

        r = await http('POST', '/webhook/event-prep', { event_id: eventId, date: '2026-09-01', lines: [realIds[0]] }, H);
        assert(r.status === 200 && r.data.action === 'updated', 'andet push samme dag → 200 updated');
        assert(r.data.bon_id === created.bon_id, 'updated → SAMME bon (ingen dublet)');

        // Dag 2 → ny prep-bon
        r = await http('POST', '/webhook/event-prep', { event_id: eventId, date: '2026-09-02', lines: realIds }, H);
        assert(r.status === 201 && r.data.action === 'created', 'dag 2 push → 201 created (ny bon)');
        assert(r.data.bon_id !== created.bon_id, 'dag 2 → anden bon end dag 1');

        // ── Verificér gennem den rigtige API ─────────────────────────────────
        console.log('\n— Verifikation via /api/events/:id/overview —');
        const login = await http('POST', '/api/auth/pin', { pin: TEST_PIN });
        assert(login.status === 200, 'login OK');
        r = await http('GET', `/api/events/${eventId}/overview`);
        assert(r.status === 200, 'overview 200');
        const bons = (r.data.bons || r.data.roles?.prep || []);
        const prepBons = (r.data.bons || []).filter(b => b.event_role === 'prep');
        assert(prepBons.length === 2, `2 prep-bons under eventet (fik ${prepBons.length})`);
        assert(prepBons.every(b => b.price_category_code === 'produktion'), 'prep-bons er priskategori produktion');

        console.log(`\nFase 5 (live smoke): ${pass} PASS · ${fail} FAIL`);
    } finally {
        if (proc) proc.kill('SIGTERM');
    }
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
