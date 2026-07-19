#!/usr/bin/env node
'use strict';
/*
 * Sæt `HverDag` (tjek-interval i dage) på Grocy-produkter i bulk.
 *
 * Baggrund: intervallet styrer hvor ofte en vare dukker op som forfalden i
 * lageroptællingen (shared/inventory_check.js → _icComputeCheckStatus).
 * Uden interval er varen "neutral" og bliver aldrig efterspurgt af sig selv.
 * At sætte 211 varer én ad gangen i UI'et er urealistisk — derfor dette script.
 *
 * Model: hver Grocy-varegruppe har et default-interval (GROUP_DEFAULTS), og
 * enkeltvarer der falder uden for gruppens rytme får en override (OVERRIDES).
 * Intervallerne holder sig til fire trin, så listen er til at overskue:
 *
 *     7  — kritisk fersk / bruges dagligt (brød, pålæg, grønt, kernemballage)
 *    14  — halvfabrikata + ugentlig produktion (sylt, dressinger, kager)
 *    30  — stabile varer med jævnt forbrug (drikkevarer, basis-tørvarer)
 *    90  — langtidsholdbart + non-food (krydderier, rengøring, engangsartikler)
 *
 * Idempotent: rører kun varer hvis værdi faktisk ændrer sig. Uden --force
 * springes varer over der allerede HAR et interval (så håndsatte værdier
 * ikke bliver trampet ned af en gruppe-default).
 *
 * Brug:
 *   node scripts/set-check-intervals.js --location=test           # dry-run
 *   node scripts/set-check-intervals.js --location=test --apply
 *   node scripts/set-check-intervals.js --location=hq --apply     # produktion
 *   node scripts/set-check-intervals.js --location=hq --apply --force
 *   node scripts/set-check-intervals.js --location=hq --clear     # ryd alle igen (fortryd)
 */

if (!process.env.GROCY_HQ_URL && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (_) { /* env kan være sat på anden vis */ }
}

// ── Argumenter ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const CLEAR = args.includes('--clear');
const LOC = ((args.find(a => a.startsWith('--location=')) || '').split('=')[1] || '').toLowerCase();

if (!['hq', 'test', 'cafe'].includes(LOC)) {
    console.error('Brug: --location=hq|test|cafe  [--apply] [--force] [--clear]');
    process.exit(1);
}

const BASE = (process.env[`GROCY_${LOC.toUpperCase()}_URL`] || '').replace(/\/$/, '');
const KEY = process.env[`GROCY_${LOC.toUpperCase()}_KEY`];
if (!BASE || !KEY) {
    console.error(`Mangler GROCY_${LOC.toUpperCase()}_URL / _KEY i .env`);
    process.exit(1);
}

// ── Default pr. varegruppe ──────────────────────────────────────────
const GROUP_DEFAULTS = {
    '01 Brød':          7,
    '02 Pålæg':         7,
    '03 Grønt':         7,
    '04 Syltede varer': 14,
    '05 Dressinger':    14,
    '06 Tilbehør':      21,
    '07 Kager':         14,
    '08 Drikkevarer':   30,
    '09 Frugt':         7,
    '10 Emballage':     30,
    '11 Oversigt':      null,   // ikke en fysisk vare — tælles ikke
    'Lager varer':      90,
    '(ingen)':          30,
};

// ── Undtagelser pr. vare (Grocy product-id) ─────────────────────────
// Kun varer der afviger fra deres gruppes rytme. Navnet står som kommentar
// så listen kan læses uden at slå id'er op.
const OVERRIDES = {
    // Emballage købes hjem i store partier (10.000 stk) og holder længe →
    // gruppens 30 dage er rigelig. Kun transportkasserne cirkulerer ud af
    // huset og forsvinder, så dem tæller vi ugentligt. Servietter går samme
    // vej — de ryger med ud til kunden og tømmes hurtigere end resten.
    72: 7,    // Transport Kasser
    75: 7,    // Servietter

    // Kølevarer — 14 dage uanset hvilken gruppe de ligger i.
    // (Pålæg og grønt er produktionsvarer og bliver på 7.)
    146: 14,  // Kylling - rå
    126: 14,  // Svinekam
    224: 14,  // Kefir
    211: 14,  // plante yougurt
    203: 14,  // vegansk yoghurt
    209: 14,  // Salatost tern
    161: 14,  // kikærter - udblødt
    186: 14,  // Ingrid ærter udblødt
    135: 14,  // Persille
    137: 14,  // Hvidløg - i tern
    63: 14,   // Mælk - Alm
    64: 14,   // Mælk - Plante (OAT)
    219: 14,  // Havredrik Barista
    159: 14,  // Creamfraice
    45: 14,   // Smør
    162: 14,  // Feta ost
    164: 14,  // Feta Ost Vegansk

    // Basis-tørvarer der bruges hver uge (ellers 90 i "Lager varer")
    102: 30,  // Olie
    129: 30,  // Olivien Olie
    113: 30,  // Salt - alm
    101: 30,  // Sukker
    131: 30,  // Tahini
    185: 30,  // honning
    98: 30,   // Hvedemel
    99: 30,   // Rugmel
    220: 30,  // Basilikum (tørret — hører til basis-tørvarerne)
    222: 30,  // Paprika rosen
    62: 30,   // Kaffe bønner
};

// ── Grocy HTTP ──────────────────────────────────────────────────────
async function grocy(path, opts = {}) {
    const res = await fetch(BASE + path, {
        ...opts,
        headers: {
            'GROCY-API-KEY': KEY,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(opts.headers || {}),
        },
    });
    if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json().catch(() => null);
}

// ── Kør ─────────────────────────────────────────────────────────────
(async () => {
    const [products, groups] = await Promise.all([
        grocy('/objects/products'),
        grocy('/objects/product_groups'),
    ]);

    const groupName = new Map(groups.map(g => [String(g.id), g.name]));
    const active = products.filter(p => String(p.active) !== '0');

    const plan = [];
    for (const p of active) {
        const group = groupName.get(String(p.product_group_id)) || '(ingen)';
        const current = (p.userfields && p.userfields.HverDag) || '';

        let target;
        if (CLEAR) target = '';
        else if (Object.prototype.hasOwnProperty.call(OVERRIDES, Number(p.id))) target = OVERRIDES[Number(p.id)];
        else target = GROUP_DEFAULTS[group];

        // null = varen skal bevidst ikke tælles fast → lad den være tom
        const want = target == null ? '' : String(target);

        let action;
        if (want === current) action = 'uændret';
        else if (current && !FORCE && !CLEAR) action = 'springes over (har værdi)';
        else action = 'ændres';

        plan.push({ id: p.id, name: p.name, group, current, want, action });
    }

    const changes = plan.filter(r => r.action === 'ændres');
    const skipped = plan.filter(r => r.action.startsWith('springes'));

    // Udskrift grupperet
    plan.sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name, 'da'));
    let cur = null;
    for (const r of plan) {
        if (r.group !== cur) { cur = r.group; console.log(`\n## ${cur}`); }
        const mark = r.action === 'ændres' ? '→' : r.action === 'uændret' ? ' ' : '!';
        const val = r.want === '' ? '(intet)' : `${r.want} d`;
        const from = r.current ? ` (var ${r.current})` : '';
        console.log(`${mark} ${String(r.id).padStart(4)}  ${r.name.padEnd(38)} ${val}${from}`);
    }

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Aktive varer:      ${plan.length}`);
    console.log(`Ændres:            ${changes.length}`);
    console.log(`Uændret:           ${plan.filter(r => r.action === 'uændret').length}`);
    if (skipped.length) console.log(`Springes over:     ${skipped.length}  (har allerede værdi — brug --force)`);

    const fordeling = {};
    for (const r of plan) fordeling[r.want || '(intet)'] = (fordeling[r.want || '(intet)'] || 0) + 1;
    console.log(`Fordeling:         ${Object.entries(fordeling).map(([k, v]) => `${k}: ${v}`).join(' · ')}`);

    if (!APPLY) {
        console.log(`\nDRY-RUN — intet skrevet. Tilføj --apply for at udføre (lokation: ${LOC}).`);
        return;
    }

    console.log(`\nSkriver til Grocy (${LOC})...`);
    let ok = 0, fail = 0;
    for (const r of changes) {
        try {
            await grocy(`/userfields/products/${r.id}`, {
                method: 'PUT',
                body: JSON.stringify({ HverDag: r.want }),
            });
            ok++;
        } catch (err) {
            fail++;
            console.error(`  FEJL ${r.id} ${r.name}: ${err.message}`);
        }
    }
    console.log(`Færdig: ${ok} opdateret, ${fail} fejlede.`);
})().catch(err => {
    console.error(err.message);
    process.exit(1);
});
