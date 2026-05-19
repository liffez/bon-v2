// scripts/horkram-favorit-status.js
// ==========================================
// Hørkram-favoritter → Grocy kobling status.
//
// Krydstjekker alle Hørkram-favoritter mod product_barcodes i Grocy
// og rapporterer hvor mange der mangler at blive koblet før launch.
//
// Forudsætter at Bon v2-serveren kører lokalt (default :4321) — den
// proxer Hørkram-kald med login/CSRF. Grocy hentes direkte via
// grocyAdapter (samme aktive lokation som UI'et bruger).
//
// Brug:
//   node scripts/horkram-favorit-status.js
//   node scripts/horkram-favorit-status.js --json data/horkram-status.json
//   node scripts/horkram-favorit-status.js --no-snapshots   (spring pris/pakke over → hurtigere)
//   SERVER_URL=http://localhost:4321 node scripts/horkram-favorit-status.js
// ==========================================

'use strict';

const path = require('path');
const fs   = require('fs');

// Load .env (Grocy-keys + Hørkram-kreds bruges af serveren, ikke direkte her)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}

process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const grocyAdapter = require('../services/grocyAdapter');

// ── Argumenter ─────────────────────────────────────────────
const args = process.argv.slice(2);
const SERVER_URL    = process.env.SERVER_URL || 'http://localhost:4321';
const WANT_SNAPSHOTS = !args.includes('--no-snapshots');
const JSON_OUT      = (() => {
    const i = args.indexOf('--json');
    return i >= 0 ? args[i + 1] : null;
})();
const INCLUDE_GENERATED = args.includes('--include-generated');

// ── Hjælpere ───────────────────────────────────────────────

async function http(pathname) {
    const res = await fetch(`${SERVER_URL}${pathname}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
    return res.json();
}

function pct(num, denom) {
    if (!denom) return '0%';
    return Math.round((num / denom) * 100) + '%';
}

function pad(s, w) {
    s = String(s ?? '');
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padLeft(s, w) {
    s = String(s ?? '');
    return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function trunc(s, w) {
    s = String(s ?? '');
    return s.length > w ? s.slice(0, w - 1) + '…' : s;
}

// Simple Dice coefficient på bigrams — samme algoritme som
// shared/indkob_settings.js _isStringSimilarity for konsistens.
function similarity(a, b) {
    if (!a || !b) return 0;
    a = a.toLowerCase().trim();
    b = b.toLowerCase().trim();
    if (a === b) return 1;
    const bigramsA = [];
    const bigramsB = [];
    for (let i = 0; i < a.length - 1; i++) bigramsA.push(a.substring(i, i + 2));
    for (let j = 0; j < b.length - 1; j++) bigramsB.push(b.substring(j, j + 2));
    if (!bigramsA.length || !bigramsB.length) return 0;
    let intersection = 0;
    const used = {};
    bigramsA.forEach(bg => {
        for (let k = 0; k < bigramsB.length; k++) {
            if (!used[k] && bigramsB[k] === bg) { intersection++; used[k] = true; break; }
        }
    });
    return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

function topMatches(name, products, n = 3, minSim = 0.35) {
    const scored = products.map(p => ({ id: p.id, name: p.name, sim: similarity(name, p.name) }));
    scored.sort((a, b) => b.sim - a.sim);
    return scored.filter(s => s.sim >= minSim).slice(0, n);
}

// ── Hovedflow ──────────────────────────────────────────────

async function main() {
    console.log('═'.repeat(70));
    console.log('HØRKRAM-FAVORITTER → GROCY KOBLING STATUS');
    console.log('═'.repeat(70));
    console.log(`Server:  ${SERVER_URL}`);
    console.log(`DB:      ${process.env.DB_PATH}`);
    console.log('');

    // 1. Tjek server kører
    try {
        await http('/api/horkram/health');
    } catch (err) {
        console.error('✗ Kan ikke nå Bon v2-serveren på ' + SERVER_URL);
        console.error('  Start serveren først:  npm run dev');
        console.error('  Eller sæt SERVER_URL=http://...');
        console.error('  Detail:', err.message);
        process.exit(2);
    }

    // 2. Hent alle favoritlister
    console.log('→ Henter favoritlister...');
    const { lists } = await http('/api/horkram/favorites');
    const filteredLists = lists.filter(l => INCLUDE_GENERATED || l.type === 'custom');
    console.log(`  ${lists.length} lister total, ${filteredLists.length} brugt`
        + (INCLUDE_GENERATED ? '' : ` (generated/autoliste ekskluderet — brug --include-generated for at medtage)`));

    // 3. Hent produkter pr. liste
    const perList = []; // { id, name, products: [{ varenummer, name, ... }] }
    for (const l of filteredLists) {
        process.stdout.write(`  ↳ ${l.name} (${l.id})... `);
        try {
            const data = await http(`/api/horkram/favorites/${encodeURIComponent(l.id)}/all`);
            perList.push({ id: l.id, name: l.name, type: l.type, products: data.products || [] });
            console.log(`${data.products?.length || 0} varer`);
        } catch (err) {
            console.log(`FEJL: ${err.message}`);
            perList.push({ id: l.id, name: l.name, type: l.type, products: [], error: err.message });
        }
    }

    // 4. Saml unik favorit-mappe (varenummer → { meta, lister[] })
    const uniqueFavs = new Map(); // varenummer → { varenummer, name, brand, isOrganic, baseUnitCode, lists: [] }
    for (const l of perList) {
        for (const p of l.products) {
            const key = String(p.varenummer);
            if (!uniqueFavs.has(key)) {
                uniqueFavs.set(key, {
                    varenummer: key,
                    name: p.name,
                    brand: p.brand || null,
                    isOrganic: !!p.isOrganic,
                    baseUnitCode: p.baseUnitCode || null,
                    pricePerUnit: p.pricePerUnit || null,
                    pricePerKg: p.pricePerKg || null,
                    lists: [],
                });
            }
            uniqueFavs.get(key).lists.push(l.name);
        }
    }
    console.log(`\n  ${uniqueFavs.size} unikke favoritter på tværs af alle lister`);

    // 5. Hent Grocy data direkte
    console.log('\n→ Henter Grocy product_barcodes + products...');
    const [barcodes, products] = await Promise.all([
        grocyAdapter.getProductBarcodes(),
        grocyAdapter.getProducts(),
    ]);
    console.log(`  ${barcodes.length} barcode-rækker, ${products.length} produkter`);

    const productMap = new Map(products.map(p => [Number(p.id), p]));

    // 6. Byg lookup: varenummer → array af { barcode_row, product }
    const barcodeIndex = new Map(); // varenummer → [{ barcodeRow, product }]
    for (const b of barcodes) {
        const key = String(b.barcode || '').trim();
        if (!key) continue;
        const prod = productMap.get(Number(b.product_id)) || null;
        if (!barcodeIndex.has(key)) barcodeIndex.set(key, []);
        barcodeIndex.get(key).push({ barcodeRow: b, product: prod });
    }

    // 7. Markér hver favorit som koblet/ukoblet
    const coupled   = [];
    const uncoupled = [];
    for (const fav of uniqueFavs.values()) {
        const hits = barcodeIndex.get(fav.varenummer) || [];
        if (hits.length) {
            coupled.push({ ...fav, grocyHits: hits });
        } else {
            uncoupled.push(fav);
        }
    }

    // 8. Snapshots for ukoblede (pris + pakkestørrelse)
    let snapshotMap = new Map();
    if (WANT_SNAPSHOTS && uncoupled.length) {
        console.log(`\n→ Henter Hørkram-snapshots for ${uncoupled.length} ukoblede (pris + pakkestørrelse)...`);
        const ids = uncoupled.map(f => f.varenummer);
        // /api/horkram/snapshots max 60 pr. kald
        for (let i = 0; i < ids.length; i += 60) {
            const chunk = ids.slice(i, i + 60);
            try {
                const res = await http(`/api/horkram/snapshots?ids=${chunk.join(',')}`);
                for (const s of (res.products || [])) snapshotMap.set(String(s.varenummer), s);
                process.stdout.write('.');
            } catch (err) {
                process.stdout.write('!');
            }
        }
        console.log(` ${snapshotMap.size}/${ids.length} OK`);
    }

    // 9. Pr. liste statistik
    const totalUnique = uniqueFavs.size;
    const totalCoupled = coupled.length;
    const totalUncoupled = uncoupled.length;

    console.log('\n');
    console.log('═'.repeat(70));
    console.log('OVERSIGT');
    console.log('═'.repeat(70));
    console.log(`  Unikke favoritter:    ${padLeft(totalUnique, 5)}`);
    console.log(`  ✓ Koblet til Grocy:   ${padLeft(totalCoupled, 5)}  (${pct(totalCoupled, totalUnique)})`);
    console.log(`  ✗ Mangler kobling:    ${padLeft(totalUncoupled, 5)}  (${pct(totalUncoupled, totalUnique)})`);

    console.log('\nPR. FAVORITLISTE');
    console.log(`  ${pad('Liste', 36)} ${padLeft('Total', 7)} ${padLeft('Koblet', 7)} ${padLeft('Mangler', 8)}`);
    console.log(`  ${'─'.repeat(36)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(8)}`);
    for (const l of perList) {
        if (l.error) {
            console.log(`  ${pad(trunc(l.name, 36), 36)} ${padLeft('FEJL', 7)} ${padLeft('-', 7)} ${padLeft('-', 8)}`);
            continue;
        }
        const totalInList = l.products.length;
        const coupledInList = l.products.filter(p => barcodeIndex.has(String(p.varenummer))).length;
        const missingInList = totalInList - coupledInList;
        console.log(
            `  ${pad(trunc(l.name, 36), 36)} ${padLeft(totalInList, 7)} ${padLeft(coupledInList, 7)} ${padLeft(missingInList, 8)}`
        );
    }

    // 10. Ukoblede varer — detaljeret
    if (totalUncoupled === 0) {
        console.log('\n🎉 Alle favoritter er koblet til Grocy — klar til launch!');
    } else {
        console.log('\n');
        console.log('═'.repeat(70));
        console.log(`${totalUncoupled} UKOBLEDE FAVORITTER`);
        console.log('═'.repeat(70));

        // Sorter dyreste pr. kg først (de mest "vigtige" mangler), fallback navn
        uncoupled.sort((a, b) => {
            const pa = (snapshotMap.get(a.varenummer)?.pricePerKg) ?? a.pricePerKg ?? -1;
            const pb = (snapshotMap.get(b.varenummer)?.pricePerKg) ?? b.pricePerKg ?? -1;
            if (pa !== pb) return pb - pa;
            return (a.name || '').localeCompare(b.name || '');
        });

        uncoupled.forEach((fav, i) => {
            const snap = snapshotMap.get(fav.varenummer);
            const organic = fav.isOrganic ? ' 🌿Ø' : '';
            console.log('');
            console.log(`[${i + 1}/${totalUncoupled}] Varenr ${fav.varenummer}${organic}`);
            console.log(`  Navn:         ${fav.name}`);
            if (fav.brand) console.log(`  Brand:        ${fav.brand}`);
            console.log(`  På lister:    ${fav.lists.join(', ')}`);

            if (snap) {
                // Pakkestørrelser (alle salesUnits)
                if (snap.salesUnits?.length) {
                    const units = snap.salesUnits.map(u => {
                        const qty = u.quantity ? ` ${u.quantity}` : '';
                        const price = u.salesPrice ?? u.listPrice;
                        return `${u.code}${qty} (${price != null ? price + ' kr' : 'pris?'})`;
                    }).join(' · ');
                    console.log(`  Salgsenheder: ${units}`);
                }
                if (snap.pricePerKg != null) {
                    console.log(`  Pris/kg:      ${snap.pricePerKg.toFixed(2)} kr`);
                }
                if (snap.isAgreementItem) console.log(`  💰 AFTALEPRIS`);
            } else if (fav.pricePerKg != null) {
                console.log(`  Pris/kg:      ${fav.pricePerKg.toFixed(2)} kr (fra liste, ikke snapshot)`);
            }

            // Fuzzy match
            const matches = topMatches(fav.name, products, 3, 0.35);
            if (matches.length) {
                console.log(`  Mulige Grocy-matches:`);
                matches.forEach(m => {
                    const tag = m.sim >= 0.7 ? '🟢' : m.sim >= 0.5 ? '🟡' : '⚪';
                    console.log(`    ${tag} ${Math.round(m.sim * 100)}%  ${trunc(m.name, 50)}  (id ${m.id})`);
                });
            } else {
                console.log(`  Ingen Grocy-matches over 35% — sandsynligvis NY vare`);
            }
        });
    }

    // 11. Mistænkelige: koblet flere gange (samme varenummer på flere Grocy-produkter)
    const dupes = [];
    for (const [varenr, hits] of barcodeIndex.entries()) {
        // skip dem der ikke er favoritter — vi rapporterer kun favorit-related
        if (!uniqueFavs.has(varenr)) continue;
        if (hits.length > 1) {
            dupes.push({ varenr, hits });
        }
    }
    if (dupes.length) {
        console.log('\n');
        console.log('═'.repeat(70));
        console.log(`⚠ ${dupes.length} FAVORITTER MED FLERE KOBLINGER (samme varenr på >1 Grocy-produkt)`);
        console.log('═'.repeat(70));
        for (const d of dupes) {
            const fav = uniqueFavs.get(d.varenr);
            console.log(`\n  Varenr ${d.varenr}: ${fav?.name}`);
            for (const h of d.hits) {
                console.log(`    → product_id ${h.barcodeRow.product_id} (${h.product?.name || 'ukendt'})`);
            }
        }
    }

    // 12. JSON-output (valgfri)
    if (JSON_OUT) {
        const outPath = path.isAbsolute(JSON_OUT) ? JSON_OUT : path.join(process.cwd(), JSON_OUT);
        const dir = path.dirname(outPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const json = {
            generated_at: new Date().toISOString(),
            summary: {
                total_unique: totalUnique,
                coupled: totalCoupled,
                uncoupled: totalUncoupled,
                coupled_pct: pct(totalCoupled, totalUnique),
            },
            per_list: perList.map(l => ({
                id: l.id,
                name: l.name,
                type: l.type,
                total: l.products.length,
                coupled: l.products.filter(p => barcodeIndex.has(String(p.varenummer))).length,
                error: l.error || null,
            })),
            uncoupled: uncoupled.map(f => ({
                varenummer: f.varenummer,
                name: f.name,
                brand: f.brand,
                is_organic: f.isOrganic,
                lists: f.lists,
                snapshot: snapshotMap.get(f.varenummer) || null,
                fuzzy_matches: topMatches(f.name, products, 5, 0.35),
            })),
            dupes: dupes.map(d => ({
                varenummer: d.varenr,
                hits: d.hits.map(h => ({ product_id: h.barcodeRow.product_id, product_name: h.product?.name })),
            })),
        };
        fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
        console.log(`\n📄 JSON-rapport skrevet til: ${outPath}`);
    }

    console.log('\n');
    process.exit(0);
}

main().catch(err => {
    console.error('\n✗ Fejl:', err);
    process.exit(1);
});
