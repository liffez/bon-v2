#!/usr/bin/env node
/**
 * tests/scripts/pick_disjoint_products.js
 * ════════════════════════════════════════════════════════════
 * Vælger 4 test-pids til T_INDKOB_*-tracksene og persisterer dem
 * i `tests/fixtures/T_INDKOB_pids.json`.
 *
 * Køres ved første T_INDKOB_LISTE-kørsel. Genbruges af SETUP og ADMIN
 * (med mindre de selv definerer egne specifikke par — fx ADMIN's
 * Spinat+Brød Rug).
 *
 * Strategi:
 *   - Hent alle aktive produkter fra Grocy
 *   - Ekskluder T_STOCK's pids (87, 89, 95, 205) og T_INVENTORY's pid=72
 *   - Ekskluder parent/child-produkter (undgår subtle substitutionsadfærd)
 *   - Vælg 4 med simple roller: primary, dedup, bulk, isolation
 *
 * Hvis fil eksisterer: verificér at pids stadig er aktive på Grocy.
 *   - Hvis OK → behold filen
 *   - Hvis ikke OK → log fejl, lad bruger slette filen manuelt
 *
 * Usage:
 *   node --env-file=.env.test --experimental-sqlite tests/scripts/pick_disjoint_products.js
 *   node tests/scripts/pick_disjoint_products.js --force   (regenerér selvom filen findes)
 *
 * Reference: tests/specs/T_INDKOB_LISTE.md §2.3
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const safetyCheck = require('./safety_check');

const SERVER_URL  = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures');
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'T_INDKOB_pids.json');

// Reserverede pids fra andre tracks
const RESERVED_PIDS = new Set([
    72,   // T_INVENTORY PARTIAL — Transport Kasser
    87,   // T_STOCK — Affaldsposer
    89,   // T_STOCK — Bagepapir
    95,   // T_STOCK — Engangshandsker
    205,  // T_STOCK — Cava
]);

const args  = process.argv.slice(2);
const FORCE = args.includes('--force');

async function api(method, pathPart) {
    const res  = await fetch(`${SERVER_URL}${pathPart}`, { method });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}

async function main() {
    // 1. Safety-check (kontrollér at vi peger på test-DB + test-Grocy)
    try {
        safetyCheck();
    } catch (err) {
        console.error('[pick_disjoint] safety-check fejlede:', err.message);
        process.exit(2);
    }

    // 2. Hvis fixture eksisterer og ikke --force: verificér at pids stadig er aktive
    if (!FORCE && fs.existsSync(FIXTURE_FILE)) {
        const existing = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'));
        const ok = await verifyExisting(existing);
        if (ok) {
            console.log(`[pick_disjoint] Eksisterende fixture er gyldig: ${FIXTURE_FILE}`);
            console.log(`  pids: primary=${existing.pids.primary.id}, dedup=${existing.pids.dedup.id}, bulk=${existing.pids.bulk.id}, isolation=${existing.pids.isolation.id}`);
            return;
        }
        console.warn('[pick_disjoint] Eksisterende fixture er stale — re-genererer.');
    }

    // 3. Hent alle produkter
    const res = await api('GET', '/api/grocy/products');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        console.error(`[pick_disjoint] GET /api/grocy/products fejlede: ${res.status}`);
        process.exit(1);
    }

    // 4. Filter: active=1, ingen parent (vi vælger kun "rene" produkter)
    const candidates = res.body.filter(p => {
        if (p.active !== 1 && p.active !== '1') return false;
        if (p.parent_product_id) return false;
        if (RESERVED_PIDS.has(parseInt(p.id))) return false;
        // Ekskluder også børn (har parent_product_id sat på dem)
        return true;
    });

    if (candidates.length < 4) {
        console.error(`[pick_disjoint] For få kandidater (${candidates.length}). Tjek Grocy.`);
        process.exit(1);
    }

    // 5. Vælg 4 — deterministisk: sortér efter id og tag de første 4 disjointe pids
    candidates.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    const chosen = candidates.slice(0, 4);

    // 6. Skriv fixture
    const fixture = {
        version: 1,
        selected_at: new Date().toISOString(),
        grocy_target: process.env.GROCY_API_URL || 'unknown',
        reserved_pids_excluded: Array.from(RESERVED_PIDS).sort((a, b) => a - b),
        pids: {
            primary:   describe(chosen[0]),
            dedup:     describe(chosen[1]),
            bulk:      describe(chosen[2]),
            isolation: describe(chosen[3]),
        }
    };

    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    fs.writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2));
    console.log(`[pick_disjoint] Skrev ${FIXTURE_FILE}`);
    console.log('  Valgte pids:');
    for (const [role, p] of Object.entries(fixture.pids)) {
        console.log(`    ${role.padEnd(10)} pid=${p.id} ${p.name} (qu_stock=${p.qu_id_stock}, qu_purchase=${p.qu_id_purchase})`);
    }
}

function describe(p) {
    return {
        id:              parseInt(p.id),
        name:            p.name,
        qu_id_stock:     parseInt(p.qu_id_stock),
        qu_id_purchase:  parseInt(p.qu_id_purchase),
    };
}

async function verifyExisting(existing) {
    const res = await api('GET', '/api/grocy/products');
    if (res.status !== 200 || !Array.isArray(res.body)) {
        console.warn(`[pick_disjoint] kunne ikke verificere: GET produkter status=${res.status}`);
        return false;
    }
    const byId = new Map(res.body.map(p => [parseInt(p.id), p]));
    for (const [role, p] of Object.entries(existing.pids)) {
        const found = byId.get(p.id);
        if (!found) {
            console.warn(`[pick_disjoint] pid=${p.id} (${role}) findes ikke længere på Grocy`);
            return false;
        }
        if (found.active !== 1 && found.active !== '1') {
            console.warn(`[pick_disjoint] pid=${p.id} (${role}) er deaktiveret`);
            return false;
        }
    }
    return true;
}

main().catch(err => {
    console.error('[pick_disjoint] uventet fejl:', err);
    process.exit(1);
});
