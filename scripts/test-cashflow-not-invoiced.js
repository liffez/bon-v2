// scripts/test-cashflow-not-invoiced.js
// ============================================================
// Regressions-test for "Ikke faktureret" i Pengestrøm (#319 forslag 1+2).
//
// To ting har ligget i samme bunke under "Forfaldne":
//   • ægte forfalden  — regningen ER sendt, kunden har ikke betalt → ryk
//   • ikke faktureret — kunden fik aldrig en regning → send den
// Den anden ligner en dårlig betaler. KPIen målte to ting i ét tal.
//
// Testen kører mod de RIGTIGE endpoints over HTTP (spawned server, isoleret
// temp-DB), ikke mod omskrevet SQL — ellers beviser den ingenting om det
// office faktisk ser.
//
// Kør:
//   node --experimental-sqlite scripts/test-cashflow-not-invoiced.js
// ============================================================

'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openDb } = require('../db/compat');

let pass = 0, fail = 0;
function t(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FEJL ${name}\n         fik ${JSON.stringify(actual)}, ventede ${JSON.stringify(expected)}`); }
}

const TMP  = path.join(os.tmpdir(), `bon-cf-notinv-${process.pid}.db`);
const PORT = 4327 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;

// ── Byg en minimal DB via migrations, så skemaet er det ægte ──
process.env.DB_PATH = TMP;
process.env.NODE_ENV = 'test';
process.env.PORT = String(PORT);
process.env.SESSION_SECRET = 'test-not-invoiced';
process.env.SKIP_MAIL_POLLING = '1';

const { runMigrations } = require('../db/migrate');
runMigrations(TMP);

const db = openDb(TMP);
const bcrypt = require('bcryptjs');

// Testbruger (auth-gaten kræver en session for hele /api)
db.prepare(`INSERT INTO users (name, email, password_hash, role, is_active)
            VALUES ('CF Test','cf-test@example.com',?, 'admin', 1)`)
  .run(bcrypt.hashSync('cftest1234', 10));

const fakturaStatus = db.prepare(`SELECT id FROM status_definitions WHERE code='FAKTURERET'`).get().id;
const locationId    = db.prepare(`SELECT id FROM locations ORDER BY id LIMIT 1`).get().id;

// Fem fakturaer der dækker hver sin tilstand.
function seedBon(nr, draft) {
    const r = db.prepare(`INSERT INTO bons (bon_number, status_id, location_id, payment_type,
                                            order_date, delivery_date, economic_draft_number, total_price)
                          VALUES (?,?,?,'invoice','2026-05-20','2026-06-01',?,1000)`)
                .run(nr, fakturaStatus, locationId, draft);
    return r.lastInsertRowid;
}
function seedInv(id, bonId, opts) {
    db.prepare(`INSERT INTO cf_invoices (id, kunde, beloeb, forfald, betalt, bon_id, economic_number)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, opts.kunde, opts.beloeb, opts.forfald, opts.betalt ? 1 : 0, bonId, opts.econ ?? null);
}

const FORTID = '2026-06-15';   // forfalden
const FREMTID = '2099-01-01';  // ikke forfalden endnu

// A: ægte forfalden — bogført faktura findes
seedInv('A', seedBon('T_CF_A', null), { kunde: 'Ægte forfalden', beloeb: 1000, forfald: FORTID, econ: '4091' });
// B: ikke faktureret — hverken kladde eller nummer
seedInv('B', seedBon('T_CF_B', null), { kunde: 'Aldrig sendt', beloeb: 2000, forfald: FORTID });
// C: kladde findes → tæller som faktureret (regningen er undervejs)
seedInv('C', seedBon('T_CF_C', '9001'), { kunde: 'Kladde findes', beloeb: 3000, forfald: FORTID });
// D: betalt → uden for hele spørgsmålet
seedInv('D', seedBon('T_CF_D', null), { kunde: 'Betalt', beloeb: 4000, forfald: FORTID, betalt: true });
// E: ikke faktureret MEN ikke forfalden endnu — skal med i listen, ikke i forfaldne
seedInv('E', seedBon('T_CF_E', null), { kunde: 'Ikke sendt, ikke forfalden', beloeb: 500, forfald: FREMTID });
db.close();

// ── Start serveren ──
const server = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

let cookie = '';
async function api(pathPart) {
    const r = await fetch(BASE + pathPart, { headers: cookie ? { cookie } : {} });
    return { status: r.status, body: await r.json().catch(() => null) };
}

async function waitForServer(ms = 20000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        try {
            const r = await fetch(BASE + '/api/auth/me');
            if (r.status < 500) return true;
        } catch { /* endnu ikke oppe */ }
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

function cleanup() {
    try { server.kill('SIGKILL'); } catch {}
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP + s); } catch {} }
}

(async () => {
    if (!await waitForServer()) {
        console.error('Serveren startede ikke:\n' + serverLog.slice(-1500));
        cleanup(); process.exit(1);
    }

    const login = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'cf-test@example.com', password: 'cftest1234' }),
    });
    cookie = (login.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    if (!cookie) { console.error('Login gav ingen cookie'); cleanup(); process.exit(1); }

    console.log('\n── Fanen "Ikke faktureret" ──');
    const ikke = await api('/api/cashflow/invoices?tab=ikke_faktureret');
    t('svarer 200', ikke.status, 200);
    const ids = ikke.body.rows.map(r => r.id).sort();
    t('indeholder præcis B og E', ids, ['B', 'E']);
    t('sorteret ældste først', ikke.body.rows[0].id, 'B');
    t('rækken er mærket', ikke.body.rows[0].ikke_faktureret, 1);

    console.log('\n── Forfaldne renses for dem ──');
    // A og C bliver: A er bogført, C har en kladde. En kladde betyder at nogen
    // HAR lavet regningen — samme regel som fakturavagtens 'draft_exists', og
    // #319's kriterium nævner den eksplicit. Kun B og E mangler helt.
    const forf = await api('/api/cashflow/invoices?tab=forfaldne');
    t('de fakturerede forfaldne (A + C)', forf.body.rows.map(r => r.id).sort(), ['A', 'C']);
    t('B (aldrig sendt) er væk fra forfaldne', forf.body.rows.some(r => r.id === 'B'), false);

    console.log('\n── Tællerne er enige med fanerne ──');
    const s = ikke.body.summary;
    t('forfaldne_count = 2',        s.forfaldne.count, 2);
    t('forfaldne_total = 4000',     s.forfaldne.total, 4000);
    t('ikke_faktureret count = 2',  s.ikke_faktureret.count, 2);
    t('ikke_faktureret total = 2500', s.ikke_faktureret.total, 2500);
    t('betalt uberørt',             s.betalt.count, 1);
    t('alle uberørt',               s.alle.count, 5);

    console.log('\n── /stats: KPIen måler én ting ──');
    const st = await api('/api/cashflow/stats');
    t('overdue_count = 2',        st.body.overdue_count, 2);
    t('overdue_total = 4000',     st.body.overdue_total, 4000);
    t('not_invoiced_count = 2',   st.body.not_invoiced_count, 2);
    t('not_invoiced_total = 2500', st.body.not_invoiced_total, 2500);
    t('outstanding uberørt (alle ubetalte)', st.body.outstanding_count, 4);

    console.log('\n── Chartet bruger samme "forfalden" som KPIen ──');
    // Ellers viser samme skærm to forskellige tal for det samme ord.
    // Hver uge er et SNAPSHOT ("alt forfaldent før denne uges start"), ikke et
    // bidrag der skal lægges sammen — derfor sammenlignes hver uge for sig.
    const wk = await api('/api/cashflow/weekly');
    const overdueValues = [...new Set(wk.body.weeks.map(w => w.overdue || 0))].sort((a, b) => a - b);
    t('hver uges forfaldne er enten 0 eller KPIens tal',
      overdueValues, [0, st.body.overdue_total]);
    t('B (2000) er aldrig talt med',
      wk.body.weeks.some(w => w.overdue === st.body.overdue_total + 2000), false);

    console.log('\n── Mærket findes i ALLE faner, ikke kun sin egen ──');
    const alle = await api('/api/cashflow/invoices?tab=alle');
    const byId = Object.fromEntries(alle.body.rows.map(r => [r.id, r.ikke_faktureret]));
    t('B mærket i "alle"',            byId.B, 1);
    t('E mærket i "alle"',            byId.E, 1);
    t('A (bogført) ikke mærket',      byId.A, 0);
    t('C (kladde) ikke mærket',       byId.C, 0);
    t('D (betalt) ikke mærket',       byId.D, 0);

    console.log('\n── Bulk "marker betalt" kan ikke ramme dem ──');
    const bulk = await fetch(BASE + '/api/cashflow/invoices/bulk-confirm-paid', {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ older_than_days: 0, dry_run: true }),
    });
    const bulkBody = await bulk.json();
    t('dry-run svarer 200', bulk.status, 200);
    t('kun de fakturerede er kandidater', bulkBody.invoices.map(i => i.id).sort(), ['A', 'C']);
    t('B er IKKE kandidat', bulkBody.invoices.some(i => i.id === 'B'), false);
    t('E er IKKE kandidat', bulkBody.invoices.some(i => i.id === 'E'), false);

    console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} PASS · ${fail} FAIL\n`);
    cleanup();
    process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
    console.error('Testen kastede:', err);
    console.error(serverLog.slice(-1500));
    cleanup();
    process.exit(1);
});
