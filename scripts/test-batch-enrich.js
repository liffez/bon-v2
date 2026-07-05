#!/usr/bin/env node
/**
 * scripts/test-batch-enrich.js — Dry-run integration-test af batch CVR.
 *
 * Tester routerne uden HTTP-laget (mocker req/res). Kører dry-run på et
 * lille batch af firmaer der har CVR/EAN allerede (så Virk ES rammes minimalt).
 *
 * Brug: node --experimental-sqlite scripts/test-batch-enrich.js
 */

const path = require('path');

try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
        }
    }
} catch {}

const { getDb } = require('../db/database');
const db = getDb();

let pass = 0, fail = 0;
function ok(label, cond, extra) {
    if (cond) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}` + (extra ? ` — ${extra}` : '')); fail++; }
}

function mockReq(body = {}) {
    return { body, query: {}, params: {}, session: { user: { id: 1 } } };
}
function mockRes() {
    const r = { _status: 200, _body: null, _ended: false };
    r.status = (s) => { r._status = s; return r; };
    r.json = (b) => { r._body = b; r._ended = true; return r; };
    return r;
}

function getHandler(router, method, p) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === p && layer.route.methods[method]) {
            const handlers = layer.route.stack.map(l => l.handle);
            return handlers[handlers.length - 1];
        }
    }
    throw new Error(`Handler ikke fundet: ${method.toUpperCase()} ${p}`);
}

(async () => {
    const router = require('../routes/admin-batch-enrich');
    const startHandler     = getHandler(router, 'post', '/');
    const statusHandler    = getHandler(router, 'get', '/status');
    const cancelHandler    = getHandler(router, 'post', '/cancel');
    const proposalsHandler = getHandler(router, 'get', '/proposals');
    const applyHandler     = getHandler(router, 'post', '/apply');

    console.log('=== Test 1: Status før job ===');
    const res0 = mockRes();
    statusHandler(mockReq(), res0);
    ok('status returnerer 200', res0._status === 200);
    ok('running=false initialt', res0._body.running === false);

    console.log('');
    console.log('=== Test 2: Start dry-run med limit=3 ===');
    // Reset enriched_at på 3 firmaer med CVR så de matcher kandidat-listen
    db.prepare(`
        UPDATE companies SET last_enriched_at = NULL
         WHERE id IN (SELECT id FROM companies WHERE cvr IS NOT NULL AND cvr != '' AND is_active = 1 ORDER BY id LIMIT 3)
    `).run();

    const res1 = mockRes();
    await startHandler(mockReq({ max_age_days: 90, limit: 3, dry_run: true }), res1);
    ok('start returnerer 200', res1._status === 200);
    ok('total > 0', (res1._body?.total || 0) > 0);
    ok('dry_run-flag', res1._body?.dry_run === true);

    // Vent indtil jobbet er færdigt
    console.log('  Venter på job...');
    let waited = 0;
    while (waited < 30000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
        const r = mockRes();
        statusHandler(mockReq(), r);
        if (!r._body.running) break;
    }

    const finalStatus = mockRes();
    statusHandler(mockReq(), finalStatus);
    ok('job ikke længere kørende', finalStatus._body.running === false);
    const sum = finalStatus._body.summary;
    ok('summary.processed === total', sum && sum.processed === sum.total);
    ok('summary.dry_run respekteret', sum && sum.dry_run === true);

    // I dry-run skal fields_updated og contact_points_created altid være 0
    ok('dry_run: ingen felter opdateret', sum && sum.fields_updated === 0);
    ok('dry_run: ingen kontaktpunkter oprettet', sum && sum.contact_points_created === 0);

    console.log('');
    console.log('=== Test 3: Concurrent start fejler med 409 ===');
    // Manuelt sæt running-flag for at simulere at et job kører
    db.prepare("UPDATE settings SET value = ? WHERE key = 'batch_enrich_running'").run(String(Date.now()));
    const res2 = mockRes();
    await startHandler(mockReq({ max_age_days: 90, limit: 1 }), res2);
    ok('concurrent start returnerer 409', res2._status === 409);
    db.prepare("UPDATE settings SET value = '' WHERE key = 'batch_enrich_running'").run();

    console.log('');
    console.log('=== Test 4: Stale lock auto-release efter 30 min ===');
    db.prepare("UPDATE settings SET value = ? WHERE key = 'batch_enrich_running'").run(String(Date.now() - 31 * 60 * 1000));
    const resStale = mockRes();
    statusHandler(mockReq(), resStale);
    ok('stale lock blev frigivet i status', resStale._body.lock_held === false);

    console.log('');
    console.log('=== Test 5: max_age_days=0 finder de samme 3 firmaer igen ===');
    db.prepare("UPDATE settings SET value = '' WHERE key = 'batch_enrich_running'").run();
    const res3 = mockRes();
    await startHandler(mockReq({ max_age_days: 0, limit: 3, dry_run: true }), res3);
    ok('start ok', res3._status === 200);
    ok('total > 0 med 0 dage cutoff', (res3._body?.total || 0) > 0);

    waited = 0;
    while (waited < 30000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
        const r = mockRes();
        statusHandler(mockReq(), r);
        if (!r._body.running) break;
    }

    console.log('');
    console.log('=== Test 6: Review-flow (proposals + apply) ===');
    // Vælg 2 firmaer uden CVR/branch til at teste apply
    db.prepare(`
        UPDATE companies SET branch = NULL, last_enriched_at = NULL
         WHERE id IN (SELECT id FROM companies WHERE cvr IS NOT NULL AND cvr != '' AND is_active = 1 ORDER BY id LIMIT 2)
    `).run();

    // Gem nuværende felter til verifikation
    const target = db.prepare(`SELECT id, branch, last_enriched_at FROM companies WHERE cvr IS NOT NULL AND cvr != '' AND is_active = 1 ORDER BY id LIMIT 2`).all();
    console.log(`  Test-firmaer: ${target.map(t => t.id).join(',')}`);

    // Start dry-run
    const resDry = mockRes();
    await startHandler(mockReq({ max_age_days: 0, limit: 2, dry_run: true }), resDry);
    waited = 0;
    while (waited < 30000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
        const r = mockRes();
        statusHandler(mockReq(), r);
        if (!r._body.running) break;
    }

    // Hent forslag
    const propRes = mockRes();
    proposalsHandler(mockReq(), propRes);
    ok('proposals returneret', Array.isArray(propRes._body.proposals));

    const props = propRes._body.proposals;

    // Graceful skip: Virk ES er en live tredjepart. Er den utilgængelig eller
    // returnerer den ingen match, er det et miljø-problem — ikke en produkt-bug.
    // Spring de forslag-afhængige asserts over i stedet for at crashe på props[0].
    if (props.length === 0) {
        console.log('  ⚠ Ingen forslag fra Virk ES (utilgængelig eller ingen match) — springer forslag-afhængige asserts over');
    } else {
        const firstProp = props[0];
        ok('første forslag har fields-array', Array.isArray(firstProp.fields));
        ok('første forslag har company_id', typeof firstProp.company_id === 'number');
        ok('første forslag har name', typeof firstProp.name === 'string');
        ok('første forslag har konfidens', typeof firstProp.konfidens === 'number');

        // Apply kun det første firma med kun ét felt (hvis der er flere)
        const sel = [{
            company_id: firstProp.company_id,
            fields: firstProp.fields.length > 0 ? [firstProp.fields[0].key] : [],
            contact_points: firstProp.contact_points || [],
        }];

        const applyRes = mockRes();
        await applyHandler(mockReq({ selections: sel }), applyRes);
        ok('apply returnerer 200', applyRes._status === 200);
        ok('apply.applied === 1', applyRes._body.applied === 1);

        // Verificér at firma 1 er opdateret, og firma 2 er IKKE
        const firma1After = db.prepare('SELECT branch, last_enriched_at FROM companies WHERE id = ?').get(firstProp.company_id);
        ok('firma 1 har last_enriched_at sat', !!firma1After.last_enriched_at);

        if (props.length >= 2) {
            const firma2 = props[1];
            const firma2After = db.prepare('SELECT last_enriched_at FROM companies WHERE id = ?').get(firma2.company_id);
            ok('firma 2 (ikke valgt) har IKKE last_enriched_at', !firma2After.last_enriched_at);
        }

        // Apply igen — proposals skulle være ryddet
        const applyRes2 = mockRes();
        await applyHandler(mockReq({ selections: sel }), applyRes2);
        ok('apply uden forslag returnerer 400', applyRes2._status === 400);
    }

    console.log('');
    console.log('═══════════════════════════════════════');
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log('═══════════════════════════════════════');
    process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
    console.error('Fatal:', err);
    process.exit(2);
});
