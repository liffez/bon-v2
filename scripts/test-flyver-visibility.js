// scripts/test-flyver-visibility.js
// ============================================================
// #521: en ny skærm fik alle flyvere der nogensinde er sendt.
//
// To dele:
//   1. Migrationens backfill — kørt mod de RIGTIGE migrations-filer, hvor
//      153 anvendes efter at der ligger kvitteringer i basen. Ellers ville
//      testen aldrig se den kodesti (frisk DB har tom notification_reads).
//   2. Selve endpointet over HTTP mod en spawnet server — ikke omskrevet
//      SQL, for både nulpunktet og relevansfilteret bor i route-handleren.
//
// Kør:
//   node --experimental-sqlite scripts/test-flyver-visibility.js
// ============================================================

const path = require('path');
const os   = require('os');
const fs   = require('fs');
const { spawn } = require('child_process');

const STAMP   = Date.now();
const TEST_DB = path.join(os.tmpdir(), `bon-test-flyver-${STAMP}.db`);
const MIG_DB  = path.join(os.tmpdir(), `bon-test-flyvermig-${STAMP}.db`);
const MIG_DIR = path.join(os.tmpdir(), `bon-test-flyvermigdir-${STAMP}`);
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

const rmDb = p => ['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(p + s); } catch {} });

/* ═══════════════════════════════════════════════════════════
   DEL 1 — migrationens backfill
   ═══════════════════════════════════════════════════════════ */
function testMigrationBackfill() {
    console.log('\n— Migration 153: kendte skærme beholder deres nulpunkt —');

    const srcDir = path.join(__dirname, '..', 'db', 'migrations');
    fs.mkdirSync(MIG_DIR, { recursive: true });
    const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.sql'));
    const target = files.find(f => f.startsWith('153_'));
    if (!target) throw new Error('153-migrationen blev ikke fundet');

    // Kør alt UNDTAGEN 153, så basen ser ud som drift gjorde før rettelsen.
    for (const f of files) {
        if (f !== target) fs.copyFileSync(path.join(srcDir, f), path.join(MIG_DIR, f));
    }
    const { runMigrations } = require('../db/migrate');
    runMigrations(MIG_DB, MIG_DIR);

    const { openDb } = require('../db/compat');
    let db = openDb(MIG_DB);
    const bonId = db.prepare(`SELECT id FROM bons LIMIT 1`).get()?.id ?? null;
    const nId = Number(db.prepare(`
        INSERT INTO notifications (bon_id, type, message) VALUES (?, 'flyver', 'gammel')
    `).run(bonId).lastInsertRowid);
    db.prepare(`
        INSERT INTO notification_reads (notification_id, client_id, read_at)
        VALUES (?, 'skaerm-i-drift', datetime('now','-40 days'))
    `).run(nId);
    db.prepare(`
        INSERT INTO notification_reads (notification_id, client_id, read_at)
        VALUES (?, 'skaerm-i-drift', datetime('now','-10 days'))
    `).run(Number(db.prepare(`
        INSERT INTO notifications (bon_id, type, message) VALUES (?, 'flyver', 'nyere')
    `).run(bonId).lastInsertRowid));
    db.close();

    // Anvend nu 153 alene — runneren springer de allerede kørte over.
    fs.copyFileSync(path.join(srcDir, target), path.join(MIG_DIR, target));
    runMigrations(MIG_DB, MIG_DIR);

    db = openDb(MIG_DB);
    const row = db.prepare(`
        SELECT first_seen_at FROM notification_clients WHERE client_id = 'skaerm-i-drift'
    `).get();
    const expected = db.prepare(`
        SELECT MIN(read_at) m FROM notification_reads WHERE client_id = 'skaerm-i-drift'
    `).get().m;
    const grace = db.prepare(`SELECT value FROM settings WHERE key='flyver_grace_days'`).get();
    db.close();

    assert(!!row, 'kendt skærm får et nulpunkt af migrationen');
    assert(row && row.first_seen_at === expected,
        `nulpunktet er skærmens FØRSTE kvittering, ikke deploy-tidspunktet (${row?.first_seen_at})`);
    assert(grace && grace.value === '2', 'flyver_grace_days seedes med 2 dage');
}

/* ═══════════════════════════════════════════════════════════
   DEL 2 — endpointet
   ═══════════════════════════════════════════════════════════ */
async function main() {
    testMigrationBackfill();

    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const { offsetISO } = require('../db/helpers');
    const db = openDb(TEST_DB);

    const TEST_PIN = '9911';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','flyver@local','admin',?,1)`).run(TEST_PIN);

    const locId = db.prepare(`SELECT id FROM locations LIMIT 1`).get().id;
    const pcId  = db.prepare(`SELECT id FROM price_categories LIMIT 1`).get().id;
    const stId  = c => db.prepare(`SELECT id FROM status_definitions WHERE code=?`).get(c).id;

    let n = 8100;
    function bon(statusCode, deliveryDate) {
        const id = n++;
        db.prepare(`
            INSERT INTO bons (id, bon_number, status_id, location_id, price_category_id,
                              order_date, delivery_date, created_at, updated_at)
            VALUES (?,?,?,?,?,'2026-01-01',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        `).run(id, 'F-' + id, stId(statusCode), locId, pcId, deliveryDate);
        return id;
    }
    function flyver(bonId, message, daysAgo = 2) {
        return Number(db.prepare(`
            INSERT INTO notifications (bon_id, type, message, created_at)
            VALUES (?, 'flyver', ?, datetime('now', ?))
        `).run(bonId, message, `-${daysAgo} days`).lastInsertRowid);
    }

    // En bon pr. tilstand vi vil skelne. Alle flyvere er sendt for 2 dage
    // siden, så det kun er bonens tilstand der adskiller dem.
    const B = {
        aktiv:     bon('GODKENDT',   offsetISO(1)),
        leveret:   bon('LEVERET',    offsetISO(1)),
        faktureret:bon('FAKTURERET', offsetISO(1)),
        aflyst:    bon('AFLYST',     offsetISO(1)),
        igaar:     bon('IGANG',      offsetISO(-1)),
        gammel:    bon('IGANG',      offsetISO(-5)),
    };
    const F = {
        aktiv:      flyver(B.aktiv,      'aktiv bon'),
        leveret:    flyver(B.leveret,    'leveret bon'),
        faktureret: flyver(B.faktureret, 'faktureret bon'),
        aflyst:     flyver(B.aflyst,     'aflyst bon'),
        igaar:      flyver(B.igaar,      'bon fra i går'),
        gammel:     flyver(B.gammel,     'bon fra for 5 dage siden'),
    };
    // Erfaren skærm: nulpunkt 30 dage tilbage, altså før alle flyvere ovenfor.
    db.prepare(`
        INSERT INTO notification_clients (client_id, first_seen_at)
        VALUES ('skaerm-erfaren', datetime('now','-30 days'))
    `).run();
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

        const unread = async client => {
            const r = await http('GET', `/api/notifications/unread?client_id=${client}`);
            if (r.status !== 200) throw new Error('unread fejlede: ' + r.status);
            return r.data.map(x => x.id);
        };

        console.log('\n— Relevansfilter: en flyver følger bonens tilstand —');
        let ids = await unread('skaerm-erfaren');
        assert(ids.includes(F.aktiv), 'flyver på bon i arbejde vises');
        assert(!ids.includes(F.leveret),
            'flyver på LEVERET bon skjules — selv om is_terminal = 0');
        assert(!ids.includes(F.faktureret), 'flyver på FAKTURERET bon skjules');
        assert(!ids.includes(F.aflyst), 'flyver på AFLYST bon skjules');

        console.log('\n— Margin: en passeret leveringsdato må ikke tabe beskeden —');
        assert(ids.includes(F.igaar),
            'flyver på gårsdagens bon vises stadig (inden for marginen)');
        assert(!ids.includes(F.gammel),
            'flyver på bon fra for 5 dage siden er faldet ud');

        await http('PATCH', '/api/settings/flyver_grace_days', { value: '7' });
        ids = await unread('skaerm-erfaren');
        assert(ids.includes(F.gammel),
            'marginen kan justeres i settings uden kodeændring (7 dage → den gamle er med)');
        await http('PATCH', '/api/settings/flyver_grace_days', { value: '2' });
        ids = await unread('skaerm-erfaren');
        assert(!ids.includes(F.gammel), 'og tilbage igen ved 2 dage');

        console.log('\n— Nulpunkt: en ny skærm arver ikke historik —');
        const ny = await unread('skaerm-helt-ny');
        assert(ny.length === 0,
            `ny skærm får INTET selv om der ligger flyvere på bons i arbejde (fik ${ny.length})`);
        assert((await unread('skaerm-erfaren')).includes(F.aktiv),
            'den erfarne skærm er upåvirket af at en ny kom til');

        const db2 = openDb(TEST_DB);
        const t1 = db2.prepare(`SELECT first_seen_at FROM notification_clients WHERE client_id='skaerm-helt-ny'`).get().first_seen_at;
        db2.close();
        await unread('skaerm-helt-ny');
        const db3 = openDb(TEST_DB);
        const t2 = db3.prepare(`SELECT first_seen_at FROM notification_clients WHERE client_id='skaerm-helt-ny'`).get().first_seen_at;
        db3.close();
        assert(t1 === t2, 'nulpunktet flytter sig ikke ved næste kald');

        console.log('\n— En ny flyver når frem til begge skærme —');
        const sendt = await http('POST', `/api/bons/${B.aktiv}/notifications`, { message: 'ny besked' });
        assert(sendt.status === 201, 'flyver sendt');
        const nyId = sendt.data.id;
        assert((await unread('skaerm-helt-ny')).includes(nyId),
            'den nye skærm ser en flyver sendt EFTER den kom til');
        assert((await unread('skaerm-erfaren')).includes(nyId), 'og den erfarne gør også');

        console.log('\n— De gamle regler holder —');
        const egen = await http('POST', `/api/bons/${B.aktiv}/notifications`,
            { message: 'min egen', client_id: 'skaerm-erfaren' });
        assert(!(await unread('skaerm-erfaren')).includes(egen.data.id),
            'afsenderen ser ikke sin egen flyver');
        assert((await unread('skaerm-helt-ny')).includes(egen.data.id),
            'men alle andre gør');

        await http('POST', `/api/bons/${B.aktiv}/notifications/${F.aktiv}/read`,
            { client_id: 'skaerm-erfaren' });
        assert(!(await unread('skaerm-erfaren')).includes(F.aktiv),
            'en kvitteret flyver bliver væk');

        const uden = await http('GET', '/api/notifications/unread');
        assert(uden.status === 400, 'kald uden client_id afvises');

    } finally {
        if (serverProc) serverProc.kill();
        rmDb(TEST_DB); rmDb(MIG_DB);
        try { fs.rmSync(MIG_DIR, { recursive: true, force: true }); } catch {}
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
