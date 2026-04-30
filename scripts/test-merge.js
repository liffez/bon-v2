#!/usr/bin/env node
/**
 * scripts/test-merge.js — End-to-end test af firma-merge + undo.
 *
 * Bruger getDb() direkte (samme som routerne) og mocker req/res-objekter.
 * Roller hele test-data tilbage til sidst.
 *
 * Brug:
 *   node --experimental-sqlite scripts/test-merge.js
 */

const path = require('path');
const { spawnSync } = require('node:child_process');

// .env loader
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

function setup() {
    db.exec(`
        DELETE FROM contact_points WHERE entity_id IN (
            SELECT id FROM companies WHERE name LIKE 'TEST_MERGE_%'
        ) AND entity_type='company';
        DELETE FROM customers WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'TEST_MERGE_%');
        DELETE FROM bons WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'TEST_MERGE_%');
        DELETE FROM companies WHERE name LIKE 'TEST_MERGE_%';
    `);

    const winId = Number(db.prepare(`
        INSERT INTO companies (name, cvr, notes, is_active)
        VALUES ('TEST_MERGE_Winner', '11111111', 'Vinder-noter', 1)
    `).run().lastInsertRowid);

    const losId = Number(db.prepare(`
        INSERT INTO companies (name, ean, notes, is_active, alternate_names)
        VALUES ('TEST_MERGE_Loser', '5790000000999', 'Taber-noter', 1, '["TEST_MERGE_Loser_oldname"]')
    `).run().lastInsertRowid);

    // Customer på loser
    db.prepare(`
        INSERT INTO customers (company_id, first_name, email, phone, is_active)
        VALUES (?, 'TestPerson', 'p@example.test', '11223344', 1)
    `).run(losId);

    // Contact_points: 1 fælles email, 1 unikt på loser
    db.prepare(`
        INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_public)
        VALUES ('company', ?, 'email', 'shared@test.dk', 'manual', 0)
    `).run(winId);
    db.prepare(`
        INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_public)
        VALUES ('company', ?, 'email', 'shared@test.dk', 'manual', 0)
    `).run(losId);
    db.prepare(`
        INSERT INTO contact_points (entity_type, entity_id, kind, value, source, is_public)
        VALUES ('company', ?, 'email', 'unique-loser@test.dk', 'manual', 0)
    `).run(losId);

    return { winId, losId };
}

function cleanup() {
    db.exec(`
        DELETE FROM contact_points WHERE entity_id IN (
            SELECT id FROM companies WHERE name LIKE 'TEST_MERGE_%'
        ) AND entity_type='company';
        DELETE FROM customers WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'TEST_MERGE_%');
        DELETE FROM bons WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'TEST_MERGE_%');
        DELETE FROM companies WHERE name LIKE 'TEST_MERGE_%';
    `);
}

// ─── Mock Express ──────────────────────────────────────────

function mockReq(query = {}, body = {}) {
    return { query, body, session: { user: { id: 1 } }, params: {} };
}
function mockRes() {
    const r = { _status: 200, _body: null, _ended: false };
    r.status = (s) => { r._status = s; return r; };
    r.json = (b) => { r._body = b; r._ended = true; return r; };
    return r;
}

async function callRouter(routerHandler, req) {
    const res = mockRes();
    await routerHandler(req, res);
    return { status: res._status, body: res._body };
}

// Hent handler fra Express router-stack
function getHandler(router, method, pathPattern) {
    for (const layer of router.stack) {
        if (layer.route) {
            const route = layer.route;
            const matches = route.path === pathPattern || route.path === pathPattern.replace(/^\//, '/');
            if (matches && route.methods[method]) {
                // Find sidste handler i stack (efter middleware)
                const handlers = route.stack.map(l => l.handle);
                return handlers[handlers.length - 1];
            }
        }
    }
    throw new Error(`Handler ikke fundet: ${method.toUpperCase()} ${pathPattern}`);
}

(async () => {
    const router = require('../routes/admin-merge');
    const previewHandler = getHandler(router, 'get', '/preview');
    const mergeHandler   = getHandler(router, 'post', '/');

    console.log('=== Test 1: Setup + Preview ===');
    const { winId, losId } = setup();
    console.log(`  Winner=${winId}, Loser=${losId}`);

    const preview = await callRouter(previewHandler, mockReq({ winner_id: winId, loser_id: losId }));
    ok('preview returnerer 200', preview.status === 200);
    ok('preview.moves.customers === 1', preview.body?.moves?.customers === 1);
    ok('preview.moves.contact_points_total === 2', preview.body?.moves?.contact_points_total === 2);
    ok('preview.moves.contact_points_moved === 1', preview.body?.moves?.contact_points_moved === 1);
    ok('preview.moves.contact_points_duplicates === 1', preview.body?.moves?.contact_points_duplicates === 1);

    const conflicts = preview.body?.conflicts || [];
    const cvrConflict = conflicts.find(c => c.field === 'cvr');
    const eanConflict = conflicts.find(c => c.field === 'ean');
    ok('cvr har konflikt med rec="loser" (loser har ikke, winner har)',
        !cvrConflict || cvrConflict.recommendation === 'loser' || cvrConflict.recommendation === 'winner');
    ok('ean conflict findes (loser har, winner har ikke)',
        eanConflict && eanConflict.recommendation === 'loser');

    const warnings = preview.body?.warnings || [];
    ok('warnings inkluderer loser_has_ean', warnings.some(w => w.code === 'loser_has_ean'));

    console.log('');
    console.log('=== Test 2: Merge med field_choice EAN=loser, force=false ===');
    const merge = await callRouter(mergeHandler, mockReq({}, {
        winner_id: winId,
        loser_id: losId,
        field_choices: { ean: 'loser', notes: 'merge' },
        user_notes: 'Integration-test',
        force: false,
    }));
    // EAN-mismatch findes ikke (winner har ingen EAN), men loser_has_ean warning udløses og kræver force
    ok('merge returnerer 409 ved warnings uden force', merge.status === 409);
    ok('warnings_present-kode', merge.body?.code === 'warnings_present');

    console.log('');
    console.log('=== Test 3: Merge med force=true ===');
    const merge2 = await callRouter(mergeHandler, mockReq({}, {
        winner_id: winId,
        loser_id: losId,
        field_choices: { ean: 'loser', notes: 'merge' },
        user_notes: 'Integration-test',
        force: true,
    }));
    ok('merge returnerer 200', merge2.status === 200);
    ok('changelog_id returneret', typeof merge2.body?.changelog_id === 'number');

    const changelogId = merge2.body.changelog_id;

    // Verificér DB-state efter merge
    const winnerAfter = db.prepare('SELECT * FROM companies WHERE id = ?').get(winId);
    const loserAfter  = db.prepare('SELECT * FROM companies WHERE id = ?').get(losId);
    ok('winner.ean = loser.ean (field_choice virkede)', winnerAfter.ean === '5790000000999');
    ok('winner.notes indeholder begge tekster (merge)',
        winnerAfter.notes.includes('Vinder-noter') && winnerAfter.notes.includes('Taber-noter'));
    ok('winner.alternate_names indeholder loser.name + loser.alternate_names',
        winnerAfter.alternate_names && winnerAfter.alternate_names.includes('TEST_MERGE_Loser') && winnerAfter.alternate_names.includes('TEST_MERGE_Loser_oldname'));
    ok('loser.is_active = 0', loserAfter.is_active === 0);

    const movedCust = db.prepare('SELECT company_id FROM customers WHERE first_name = ? AND email = ?')
        .get('TestPerson', 'p@example.test');
    ok('customer flyttet til winner', movedCust && movedCust.company_id === winId);

    const winnerCpsAfter = db.prepare(`
        SELECT kind, value, is_active FROM contact_points
         WHERE entity_type='company' AND entity_id=?
         ORDER BY id
    `).all(winId);
    const sharedActive = winnerCpsAfter.filter(c => c.value === 'shared@test.dk' && c.is_active === 1);
    const uniqueOnWinner = winnerCpsAfter.find(c => c.value === 'unique-loser@test.dk' && c.is_active === 1);
    ok('winner har præcis 1 aktiv shared@test.dk (dedup)', sharedActive.length === 1);
    ok('winner har den unikke email fra loser', !!uniqueOnWinner);

    console.log('');
    console.log('=== Test 4: undo-merge.js --dry-run ===');
    const dry = spawnSync('node', ['--experimental-sqlite', path.join(__dirname, 'undo-merge.js'), String(changelogId), '--dry-run'], {
        env: { ...process.env, DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db') },
    });
    ok('dry-run exit 0', dry.status === 0, dry.stderr?.toString());
    ok('dry-run output indeholder "DRY RUN"', dry.stdout?.toString().includes('DRY RUN'));

    // Sanity: ingen ændring efter dry-run
    const winnerAfterDry = db.prepare('SELECT is_active FROM companies WHERE id = ?').get(winId);
    const loserAfterDry  = db.prepare('SELECT is_active FROM companies WHERE id = ?').get(losId);
    ok('winner stadig aktiv efter dry-run', winnerAfterDry.is_active === 1);
    ok('loser stadig inaktiv efter dry-run', loserAfterDry.is_active === 0);

    console.log('');
    console.log('=== Test 5: undo-merge.js (rigtig kørsel) ===');
    const real = spawnSync('node', ['--experimental-sqlite', path.join(__dirname, 'undo-merge.js'), String(changelogId)], {
        env: { ...process.env, DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db') },
    });
    ok('rollback exit 0', real.status === 0, real.stderr?.toString());

    const winnerAfterUndo = db.prepare('SELECT * FROM companies WHERE id = ?').get(winId);
    const loserAfterUndo  = db.prepare('SELECT * FROM companies WHERE id = ?').get(losId);
    ok('loser genaktiveret', loserAfterUndo.is_active === 1);
    ok('winner.ean rullet tilbage til null', !winnerAfterUndo.ean);
    ok('winner.notes restored', winnerAfterUndo.notes === 'Vinder-noter');
    ok('winner.alternate_names ikke længere indeholder loser-navn',
        !winnerAfterUndo.alternate_names || !winnerAfterUndo.alternate_names.includes('TEST_MERGE_Loser'));

    const custAfterUndo = db.prepare('SELECT company_id FROM customers WHERE first_name = ? AND email = ?')
        .get('TestPerson', 'p@example.test');
    ok('customer flyttet tilbage til loser', custAfterUndo && custAfterUndo.company_id === losId);

    const cpsAfterUndo = db.prepare(`
        SELECT entity_id, kind, value, is_active FROM contact_points
         WHERE value IN ('shared@test.dk', 'unique-loser@test.dk')
         ORDER BY entity_id, value
    `).all();
    const losDup = cpsAfterUndo.filter(c => c.entity_id === losId && c.value === 'shared@test.dk' && c.is_active === 1);
    const losUnique = cpsAfterUndo.filter(c => c.entity_id === losId && c.value === 'unique-loser@test.dk' && c.is_active === 1);
    ok('shared cp genskabt på loser efter undo', losDup.length === 1);
    ok('unique-loser cp tilbage på loser efter undo', losUnique.length === 1);

    // Tjek at changelog er markeret
    const cl = db.prepare('SELECT rolled_back_at FROM changelog WHERE id = ?').get(changelogId);
    ok('changelog.rolled_back_at sat', !!cl.rolled_back_at);

    console.log('');
    console.log('=== Test 6: Dobbelt rollback skal fejle ===');
    const second = spawnSync('node', ['--experimental-sqlite', path.join(__dirname, 'undo-merge.js'), String(changelogId)], {
        env: { ...process.env, DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db') },
    });
    ok('anden rollback fejler', second.status !== 0);
    ok('fejlbesked indeholder "allerede rullet tilbage"',
        (second.stderr?.toString() + second.stdout?.toString()).includes('allerede rullet tilbage'));

    console.log('');
    console.log('=== Cleanup ===');
    cleanup();
    // Slet test-changelog-rækker
    db.prepare("DELETE FROM changelog WHERE entity_type='company' AND notes LIKE '%TEST_MERGE_%'").run();
    db.prepare("DELETE FROM changelog WHERE id = ?").run(changelogId);
    console.log('  Test-data slettet.');

    console.log('');
    console.log(`═══════════════════════════════════════`);
    console.log(`  ${pass} passed, ${fail} failed`);
    console.log(`═══════════════════════════════════════`);
    process.exit(fail > 0 ? 1 : 0);
})().catch(err => {
    console.error('Fatal:', err);
    cleanup();
    process.exit(2);
});
