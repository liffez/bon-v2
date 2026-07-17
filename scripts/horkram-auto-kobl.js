// scripts/horkram-auto-kobl.js
// ==========================================
// Auto-kobl Hørkram-favoritter til eksisterende Grocy-produkter.
//
// Bruger samme felter som "Ny kobling"-fanen i Settings → Indkøb → Hørkram:
//   - POST /api/grocy/product-barcodes  { product_id, barcode, shopping_location_id, note }
//   - PUT  /api/grocy/userfields/product_barcodes/:id  { is_agreement_item, supplier_unit_code, supplier_unit_qty }
//
// Default = dry-run. Brug --apply for at udføre. Eksisterende koblinger springes over.
//
// Brug:
//   node --experimental-sqlite scripts/horkram-auto-kobl.js              # dry-run
//   node --experimental-sqlite scripts/horkram-auto-kobl.js --apply      # udfør
//   SERVER_URL=http://localhost:4321 node ... --apply
// ==========================================

'use strict';

const path = require('path');
const fs   = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:4321';
const APPLY      = process.argv.includes('--apply');

// ── KOBLINGER ──────────────────────────────────────────────
// Sikre matches fra horkram-favorit-status.json (Gruppe A + B).
// Tjek listen igennem inden du kører med --apply.
const MAPPINGS = [
    // GRUPPE A — Høj confidence (🟢 70%+)
    { varenr: '16467798', product_id: 136, hk_name: 'Hvidløgspulver 500g',         grocy_name: 'Hvidløgs Pulver' },
    { varenr: '60041683', product_id: 13,  hk_name: 'Mozzarella 125g',             grocy_name: 'Mozzarella' },
    { varenr: '16661592', product_id: 47,  hk_name: 'Mayonnaise 5kg Øko Culinar',  grocy_name: 'Mayonaise' },

    // GRUPPE B — Sandsynlige matches (🟡 50–69%)
    { varenr: '14799778', product_id: 192, hk_name: 'Peber sort stødt 500g Kryta', grocy_name: 'pebber - stødt' },
    { varenr: '13889074', product_id: 132, hk_name: 'Spidskommen stødt 450g',      grocy_name: 'Spidskommen' },
    { varenr: '60155788', product_id: 131, hk_name: 'Tahini 2,5kg Darna',          grocy_name: 'Tahini' },
    { varenr: '18039207', product_id: 48,  hk_name: 'Mayonnaise Vegansk 5kg',      grocy_name: 'Mayo - Vegansk' },
    { varenr: '18096712', product_id: 139, hk_name: 'Rosiner lyse 1kg',            grocy_name: 'Rosiner' },
    { varenr: '18766745', product_id: 169, hk_name: 'Ingrid ærter 5kg',            grocy_name: 'Ingrid Ærter' },
    { varenr: '15561664', product_id: 20,  hk_name: 'Cherry tomater 3kg Spanien',  grocy_name: 'Cherry Tomater' },
    { varenr: '34280027', product_id: 20,  hk_name: 'Cherry tomater 250g',         grocy_name: 'Cherry Tomater' },
    { varenr: '14954047', product_id: 37,  hk_name: 'Cornichons 4kg',              grocy_name: 'Cornichoner' },
    { varenr: '15284730', product_id: 67,  hk_name: 'Hvidkål Holland stk',         grocy_name: 'Hvidkål' },
    { varenr: '17121668', product_id: 67,  hk_name: 'Hvidkål Danmark stk',         grocy_name: 'Hvidkål' },
];

// ── HTTP helpers ───────────────────────────────────────────

async function httpGet(pathname) {
    const res = await fetch(`${SERVER_URL}${pathname}`);
    if (!res.ok) throw new Error(`GET ${pathname} → HTTP ${res.status}`);
    return res.json();
}

async function httpPost(pathname, body) {
    const res = await fetch(`${SERVER_URL}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
        const err = new Error(`POST ${pathname} → HTTP ${res.status} ${text.slice(0, 200)}`);
        err.status = res.status;
        err.body = json;
        throw err;
    }
    return json;
}

async function httpPut(pathname, body) {
    const res = await fetch(`${SERVER_URL}${pathname}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`PUT ${pathname} → HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json().catch(() => ({}));
}

// ── Hovedflow ──────────────────────────────────────────────

async function main() {
    console.log('═'.repeat(70));
    console.log('HØRKRAM AUTO-KOBL' + (APPLY ? ' — APPLY MODE' : ' — DRY-RUN'));
    console.log('═'.repeat(70));
    console.log(`Server:    ${SERVER_URL}`);
    console.log(`Mode:      ${APPLY ? '⚠ FAKTISK SKRIV' : '✓ Dry-run (ingen ændringer)'}`);
    console.log(`Koblinger: ${MAPPINGS.length}`);
    console.log('');

    // 1. Find Hørkram shopping_location_id (samme logik som UI'et)
    console.log('→ Finder Hørkram shopping_location_id...');
    const locsRes = await httpGet('/api/purchasing/suppliers/grocy-locations');
    const hkLocs = (locsRes.locations || []).filter(l =>
        l.linked_supplier_name && /hørkram|hoka/i.test(l.linked_supplier_name)
    );
    const shoppingLocationId = hkLocs.length ? hkLocs[0].grocy_location_id : null;
    if (!shoppingLocationId) {
        console.error('✗ Ingen Grocy-lokation er koblet til Hørkram. Gør det i Settings → Indkøb → Leverandører først.');
        process.exit(2);
    }
    console.log(`  ✓ shopping_location_id=${shoppingLocationId} (${hkLocs[0].linked_supplier_name})`);

    // 2. Hent eksisterende barcodes for at undgå dubletter
    console.log('→ Henter eksisterende product_barcodes...');
    const barcodes = await httpGet('/api/grocy/product-barcodes');
    const barcodesArr = Array.isArray(barcodes) ? barcodes : (barcodes.barcodes || barcodes.data || []);
    const existingByVarenr = new Map();
    for (const b of barcodesArr) {
        const key = String(b.barcode || '').trim();
        if (key) {
            if (!existingByVarenr.has(key)) existingByVarenr.set(key, []);
            existingByVarenr.get(key).push(b);
        }
    }
    console.log(`  ${barcodesArr.length} eksisterende barcode-rækker`);

    // 3. Hent snapshots for alle varer (pakkestørrelse + aftalepris-flag)
    console.log('→ Henter Hørkram-snapshots...');
    const allVarenrs = MAPPINGS.map(m => m.varenr);
    let snaps = [];
    for (let i = 0; i < allVarenrs.length; i += 60) {
        const chunk = allVarenrs.slice(i, i + 60);
        const res = await httpGet(`/api/horkram/snapshots?ids=${chunk.join(',')}`);
        snaps.push(...(res.products || []));
    }
    const snapByVarenr = new Map(snaps.map(s => [String(s.varenummer), s]));
    console.log(`  ${snaps.length}/${allVarenrs.length} snapshots hentet`);

    // 4. Plan
    console.log('\n' + '═'.repeat(70));
    console.log('PLAN');
    console.log('═'.repeat(70));

    const toProcess = [];
    for (const m of MAPPINGS) {
        const existing = existingByVarenr.get(m.varenr);
        const snap = snapByVarenr.get(m.varenr);

        // Vælg default sales unit (bruges til supplier_unit_code/qty)
        const su = snap?.salesUnits?.find(u => u.isDefault) || snap?.salesUnits?.[0] || null;
        const userfields = {};
        if (snap?.isAgreementItem) userfields.is_agreement_item = '1';
        if (su?.code) userfields.supplier_unit_code = su.code;
        if (su?.quantity) userfields.supplier_unit_qty = String(su.quantity);

        const status = existing
            ? (existing.some(e => Number(e.product_id) === m.product_id) ? 'SKIP_EXACT' : 'SKIP_OTHER')
            : 'CREATE';

        toProcess.push({ mapping: m, snap, su, userfields, existing, status });

        const tag = status === 'CREATE'      ? '➕ NY    '
                  : status === 'SKIP_EXACT'  ? '⏭  SKIP  '
                  : '⚠  KONFL ';
        const ufStr = Object.keys(userfields).length
            ? ` [${Object.entries(userfields).map(([k, v]) => `${k}=${v}`).join(', ')}]`
            : '';
        console.log(`${tag} ${m.varenr.padEnd(10)} → pid ${String(m.product_id).padStart(4)}  ${m.hk_name.padEnd(38)} → ${m.grocy_name}${ufStr}`);

        if (status === 'SKIP_OTHER') {
            for (const e of existing) {
                console.log(`         (allerede koblet til product_id=${e.product_id})`);
            }
        }
    }

    const summary = toProcess.reduce((acc, p) => {
        acc[p.status] = (acc[p.status] || 0) + 1;
        return acc;
    }, {});
    console.log('\nSAMMENFATNING:');
    console.log(`  Vil oprette:           ${summary.CREATE || 0}`);
    console.log(`  Allerede koblet (skip): ${summary.SKIP_EXACT || 0}`);
    console.log(`  Konflikt (skip):       ${summary.SKIP_OTHER || 0}`);

    if (!APPLY) {
        console.log('\n💡 Dry-run færdig. Kør med --apply for at udføre.');
        process.exit(0);
    }

    // 5. Apply
    console.log('\n' + '═'.repeat(70));
    console.log('UDFØRER...');
    console.log('═'.repeat(70));

    let ok = 0, failed = 0;
    for (const p of toProcess) {
        if (p.status !== 'CREATE') continue;
        const { mapping: m, userfields } = p;
        try {
            // POST barcode
            const bcRes = await httpPost('/api/grocy/product-barcodes', {
                product_id: m.product_id,
                barcode: m.varenr,
                shopping_location_id: shoppingLocationId,
                note: m.hk_name,
            });
            // Grocy returnerer { created_object_id: N } eller hele rækken
            const bcId = bcRes?.created_object_id || bcRes?.id || bcRes?.bc?.id;
            if (!bcId) {
                console.log(`⚠ ${m.varenr}: barcode oprettet men kunne ikke finde ID i svar`);
            }

            // PUT userfields
            if (bcId && Object.keys(userfields).length) {
                try {
                    await httpPut(`/api/grocy/userfields/product_barcodes/${bcId}`, userfields);
                } catch (e) {
                    console.log(`⚠ ${m.varenr}: barcode OK men userfields fejl: ${e.message}`);
                }
            }
            console.log(`✓ ${m.varenr.padEnd(10)} → pid ${m.product_id}  (bc_id=${bcId || '?'})`);
            ok++;
        } catch (err) {
            failed++;
            if (err.status === 409) {
                console.log(`⏭  ${m.varenr.padEnd(10)} → pid ${m.product_id}  (allerede koblet)`);
            } else {
                console.log(`✗ ${m.varenr.padEnd(10)} → pid ${m.product_id}  FEJL: ${err.message}`);
            }
        }
    }

    console.log('\n' + '═'.repeat(70));
    console.log(`FÆRDIG: ${ok} oprettet, ${failed} fejl`);
    console.log('═'.repeat(70));
    process.exit(failed ? 1 : 0);
}

main().catch(err => {
    console.error('\n✗ Fatal fejl:', err);
    process.exit(1);
});
