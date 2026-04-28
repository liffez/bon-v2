// scripts/test-m10-live.js
// ==========================================
// LIVE UI-test for M10 (Settings UI til booking-modul).
//
//   - Spawner server på PORT=4323 (default 7 min)
//   - Sætter et midlertidigt admin-password
//   - User åbner browseren, logger ind som admin og prøver
//     "Booking — Smagsprøve" + "Booking — Kontakt" sektionerne
//
// Kør: node --experimental-sqlite scripts/test-m10-live.js
// ==========================================

const path = require('path');
const { spawn } = require('child_process');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/bon.db');

const fs = require('fs');
const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}

const { getDb } = require('../db/database');
const { hashPassword } = require('../db/helpers');

const PORT = 4323;
const BASE = `http://localhost:${PORT}`;
const TIMEOUT_SEC = parseInt(process.env.TIMEOUT_SEC || '420');

async function waitForServer(maxMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(BASE + '/api/sse', { method: 'HEAD' });
            if (r.status > 0) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

async function main() {
    const db = getDb();
    const admin = db.prepare("SELECT id, email FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1").get();
    if (!admin) throw new Error('Ingen admin');

    const TEST_PW = 'm10test';
    const savedHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(admin.id).password_hash;
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(TEST_PW), admin.id);

    let serverProc = null;
    let cleanupRan = false;
    let timeoutHandle = null;

    const cleanup = () => {
        if (cleanupRan) return;
        cleanupRan = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
        try {
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(savedHash, admin.id);
            console.log('\n🧹 Admin-password rullet tilbage');
        } catch (err) { console.error('Cleanup-fejl:', err.message); }
    };

    process.on('SIGINT',  () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    try {
        console.log(`\n📡 Starter test-server på ${BASE}...`);
        serverProc = spawn(
            'node', ['--experimental-sqlite', 'server.js'],
            { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        serverProc.stdout.on('data', d => {
            const s = d.toString();
            if (s.includes('SERVER KØRER')) process.stdout.write('  [srv] ' + s);
        });
        serverProc.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d.toString()));

        if (!await waitForServer()) throw new Error('Server startede ikke');
        console.log('  ✓ server klar\n');

        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  Login: ' + BASE + '/login.html');
        console.log(`    Email:    ${admin.email}`);
        console.log(`    Password: ${TEST_PW}`);
        console.log('');
        console.log('  Test M10:');
        console.log(`    1. Åbn ${BASE}/settings/`);
        console.log(`    2. Klik "Booking — Smagsprøve" i sidebar`);
        console.log(`       → Master-toggle, mødetyper-tabel (med CRUD), slot-logik,`);
        console.log(`         standardejer-dropdown, erindringsmail, page templates`);
        console.log(`    3. Prøv: opret ny mødetype, redigér label, toggle bookable`);
        console.log(`    4. Prøv: skift slot-grænser, spær ugedage, sæt buffer`);
        console.log(`    5. Prøv: redigér intro/thankyou-tekst og gem`);
        console.log(`    6. Klik "Booking — Kontakt" — tilsvarende UI uden kalender`);
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`\n⏳ Serveren kører i op til ${TIMEOUT_SEC} sek. Tryk Ctrl-C for at stoppe nu.`);

        await new Promise(r => { timeoutHandle = setTimeout(r, TIMEOUT_SEC * 1000); });
        console.log('\n⏰ Timeout — stopper test-server');
    } finally {
        cleanup();
    }
}

main().catch(err => { console.error('❌ FEJL:', err.message); process.exit(1); });
