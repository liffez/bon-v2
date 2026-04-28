// scripts/test-m11-live.js
// ==========================================
// LIVE UI-test for M11 (CRM mail-compose med booking-link).
//
//   - Spawner server på PORT=4323 (begrænset levetid, default 7 min)
//   - Sætter booking_public_url_base til http://localhost:4323
//   - Logger admin-credentials du kan bruge
//   - User åbner browseren, logger ind, navigerer til CRM Kunde 360°,
//     vælger en kunde, klikker mail-tab → "📅 Indsæt booking-link"
//
// Kør: TIMEOUT_SEC=420 node --experimental-sqlite scripts/test-m11-live.js
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

function setSetting(db, k, v) {
    const ex = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(k);
    if (ex) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(v, k);
    else    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
}
function getSetting(db, k) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
}

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
    if (!admin) throw new Error('Ingen admin-bruger');

    const savedPublicUrlBase = getSetting(db, 'booking_public_url_base');
    setSetting(db, 'booking_public_url_base', BASE);

    // Sæt et midlertidigt admin-password til UI-login
    const TEST_PW = 'm11test';
    const savedHash = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(admin.id).password_hash;
    const newHash = await hashPassword(TEST_PW);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, admin.id);

    let serverProc = null;
    let timeoutHandle = null;
    let cleanupRan = false;

    const cleanup = () => {
        if (cleanupRan) return;
        cleanupRan = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
        try {
            db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(savedHash, admin.id);
            if (savedPublicUrlBase === null) db.prepare('DELETE FROM settings WHERE key = ?').run('booking_public_url_base');
            else setSetting(db, 'booking_public_url_base', savedPublicUrlBase);
            console.log('\n🧹 Settings + admin-password rullet tilbage');
        } catch (err) {
            console.error('Cleanup-fejl:', err.message);
        }
    };

    process.on('SIGINT',  () => { console.log('\n[live] SIGINT → cleanup'); cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });

    try {
        console.log(`\n📡 Starter test-server på ${BASE}...`);
        serverProc = spawn(
            'node', ['--experimental-sqlite', 'server.js'],
            { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        serverProc.stdout.on('data', d => {
            const s = d.toString();
            if (s.includes('SERVER KØRER') || s.includes('booking') || s.includes('mail')) {
                process.stdout.write('  [srv] ' + s.split('\n').filter(l => l.trim()).join('\n  [srv] ') + '\n');
            }
        });
        serverProc.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d.toString()));

        if (!await waitForServer()) throw new Error('Server startede ikke');
        console.log('  ✓ server klar\n');

        console.log('═══════════════════════════════════════════════════════════════');
        console.log('  Åbn browseren på:');
        console.log(`    ${BASE}/login.html`);
        console.log('');
        console.log('  Login som admin:');
        console.log(`    Email:    ${admin.email}`);
        console.log(`    Password: ${TEST_PW}`);
        console.log('');
        console.log('  Test M11:');
        console.log(`    1. Naviger til "Kunder" → vælg en kunde`);
        console.log(`    2. Klik "Mail"-tab`);
        console.log(`    3. Skriv en besked, klik "📅 Indsæt booking-link"`);
        console.log(`    4. Vælg flow + intent → "Indsæt"`);
        console.log(`       → {{booking_link}} indsættes ved cursor`);
        console.log(`       → Info-strip ved siden af knappen viser valg`);
        console.log(`    5. (Valgfrit) Send mail til test-recipient`);
        console.log(`       → URL i mailen er: ${BASE}/b/TOKEN`);
        console.log('═══════════════════════════════════════════════════════════════');
        console.log(`\n⏳ Serveren kører i op til ${TIMEOUT_SEC} sek. Tryk Ctrl-C for at stoppe nu.`);

        await new Promise(r => { timeoutHandle = setTimeout(r, TIMEOUT_SEC * 1000); });
        console.log('\n⏰ Timeout — stopper test-server');
    } finally {
        cleanup();
    }
}

main().catch(err => {
    console.error('❌ FEJL:', err.message);
    console.error(err.stack);
    process.exit(1);
});
