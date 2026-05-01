// FASE 3 — Pris-konsistens
// Gruppe-aware: SALG kræver Catering-pris, HALVFABRIKATA/SERVICE/EMBALLAGE må mangle.
//
// Tjek:
// 1. SALG-opskrifter uden Catering-pris (= reel mangel)
// 2. Catering vs Festival ratio outliers
// 3. Cost > Sales (fra Grocy API — kører på alle SALG)
// 4. Inkonsistent format (decimaler / øre)
// 5. Manuel `costprice`-userfield konsistens med Grocy API

const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDb } = require('./lib/db');
const { writeReport, formatTable } = require('./lib/report');
const { classifyGroup } = require('./lib/groups');

const KEY_FILE = path.join(os.homedir(), 'grocy-audit-2026-05-02', '.api-key');
const API_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();

async function fetchFulfillment(recipeId) {
    const res = await fetch(`http://localhost:9283/api/recipes/${recipeId}/fulfillment`, {
        headers: { 'GROCY-API-KEY': API_KEY }
    });
    return res.ok ? await res.json() : null;
}

async function main() {
    const db = openDb();
    const sections = [];

    // Hent alle sellable opskrifter med gruppe + priser
    const sellable = db.prepare(`
        SELECT r.id, r.name,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='grupper' AND uv.object_id=CAST(r.id AS TEXT)) AS gruppe,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='SalespriceCatering' AND uv.object_id=CAST(r.id AS TEXT)) AS catering,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='SalespriceFestival' AND uv.object_id=CAST(r.id AS TEXT)) AS festival,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='SalespriceStore' AND uv.object_id=CAST(r.id AS TEXT)) AS store,
            (SELECT value FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
             WHERE uf.entity='recipes' AND uf.name='costprice' AND uv.object_id=CAST(r.id AS TEXT)) AS manual_cost
        FROM recipes r
        WHERE r.id IN (
            SELECT object_id FROM userfield_values uv JOIN userfields uf ON uf.id=uv.field_id
            WHERE uf.entity='recipes' AND uf.name='sellable' AND uv.value='1'
        )
        ORDER BY r.name
    `).all().map(r => ({
        ...r,
        klasse: classifyGroup(r.gruppe),
        catering: parseFloat(r.catering) || 0,
        festival: parseFloat(r.festival) || 0,
        store: parseFloat(r.store) || 0,
        manual_cost: parseFloat(r.manual_cost) || 0
    }));

    // 3.1 SALG opskrifter uden Catering-pris
    const salgNoCatering = sellable.filter(r => r.klasse === 'SALG' && r.catering <= 0);
    sections.push({ title: '3.1 SALG-opskrifter uden Catering-pris (= reelt manglende)',
        body: salgNoCatering.length ? formatTable(salgNoCatering.map(r => ({
            id: r.id, name: r.name, gruppe: r.gruppe, catering: r.catering, store: r.store
        }))) : '_(alle SALG har Catering-pris)_' });

    // 3.2 SALG opskrifter uden Store-pris
    const salgNoStore = sellable.filter(r => r.klasse === 'SALG' && r.store <= 0);
    sections.push({ title: '3.2 SALG-opskrifter uden Store-pris',
        body: salgNoStore.length ? formatTable(salgNoStore.map(r => ({
            id: r.id, name: r.name, gruppe: r.gruppe, catering: r.catering, store: r.store
        }))) : '_(alle SALG har Store-pris)_' });

    // 3.3 SALG opskrifter hvor Catering ≠ Store (typisk skal de være ens)
    const cateringStoreDiff = sellable
        .filter(r => r.klasse === 'SALG' && r.catering > 0 && r.store > 0 && r.catering !== r.store)
        .map(r => ({
            id: r.id, name: r.name, gruppe: r.gruppe, catering: r.catering, store: r.store,
            diff: Math.round((r.catering - r.store) * 100) / 100
        }));
    sections.push({ title: '3.3 SALG-opskrifter hvor Catering ≠ Store',
        body: cateringStoreDiff.length ? formatTable(cateringStoreDiff) : '_(alle ens)_' });

    // 3.4 Festival pris outliers
    const festivalAnomalies = sellable
        .filter(r => r.klasse === 'SALG' && r.catering > 0 && r.festival > 0)
        .map(r => ({
            id: r.id, name: r.name, gruppe: r.gruppe,
            catering: r.catering, festival: r.festival,
            ratio: Math.round((r.festival / r.catering) * 100) / 100
        }))
        .filter(r => r.ratio < 0.7 || r.ratio > 1.5)
        .sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1));
    sections.push({ title: '3.4 Festival/Catering ratio outliers (< 0.7 eller > 1.5)',
        body: festivalAnomalies.length ? formatTable(festivalAnomalies) : '_(alle inden for 0.7-1.5x)_' });

    // 3.5 Pris-format: øre (decimal) vs hele kroner
    const decimalPrices = sellable
        .filter(r => r.catering > 0 && r.catering !== Math.round(r.catering))
        .map(r => ({ id: r.id, name: r.name, gruppe: r.gruppe, catering: r.catering }));
    sections.push({ title: '3.5 SALG med øre i Catering-pris (ikke hele kroner)',
        body: decimalPrices.length ? formatTable(decimalPrices.slice(0, 30)) +
            (decimalPrices.length > 30 ? `\n\n_... og ${decimalPrices.length - 30} mere_` : '') : '_(alle hele kroner)_' });

    // 3.6 Cost > Sales fra Grocy API (kun ægte SALG)
    console.log('Henter Grocy API costs for SALG-opskrifter...');
    const salgRecipes = sellable.filter(r => r.klasse === 'SALG' && r.catering > 0);
    const inverted = [];
    const lowMargin = [];
    let n = 0;
    for (const r of salgRecipes) {
        n++;
        process.stdout.write(`\r  ${n}/${salgRecipes.length}`);
        const f = await fetchFulfillment(r.id);
        if (!f) continue;
        const cost = f.costs_per_serving || 0;
        const salesEx = r.catering / 1.25;
        const ratio = salesEx > 0 ? cost / salesEx : null;
        if (ratio === null) continue;
        const row = {
            id: r.id, name: r.name, gruppe: r.gruppe,
            catering: r.catering, salesEx: Math.round(salesEx * 100) / 100,
            cost: Math.round(cost * 100) / 100,
            ratio: Math.round(ratio * 100) / 100,
            missing: f.missing_products_count
        };
        if (ratio > 1) inverted.push(row);
        else if (ratio > 0.5) lowMargin.push(row);
    }
    console.log('');
    sections.push({ title: '3.6 SALG-opskrifter med Cost > Sales (ægte data-fejl)',
        body: inverted.length ? formatTable(inverted.sort((a, b) => b.ratio - a.ratio)) : '_(ingen)_' });
    sections.push({ title: '3.7 SALG-opskrifter med lav margin (cost 50-100% af sales)',
        body: lowMargin.length ? formatTable(lowMargin.sort((a, b) => b.ratio - a.ratio)) : '_(ingen)_' });

    // 3.8 Manuel costprice vs Grocy API
    console.log('Sammenligner manuel costprice vs Grocy API...');
    const costMismatch = [];
    for (const r of sellable.filter(s => s.manual_cost > 0)) {
        const f = await fetchFulfillment(r.id);
        if (!f) continue;
        const grocyCost = Math.round((f.costs_per_serving || 0) * 100) / 100;
        const diff = Math.abs(r.manual_cost - grocyCost);
        if (grocyCost > 0 && diff / grocyCost > 0.1) {  // >10% afvigelse
            costMismatch.push({
                id: r.id, name: r.name, gruppe: r.gruppe,
                manual: r.manual_cost, grocy: grocyCost, diff: Math.round(diff * 100) / 100
            });
        }
    }
    sections.push({ title: '3.8 Manuel costprice vs Grocy API (>10% afvigelse)',
        body: costMismatch.length ? formatTable(costMismatch.sort((a, b) => b.diff - a.diff)) : '_(ingen større afvigelser)_' });

    writeReport('03_priser', sections);
    db.close();

    console.log('');
    console.log('Fase 3 fund:');
    console.log(`  SALG uden Catering:     ${salgNoCatering.length}`);
    console.log(`  SALG uden Store:        ${salgNoStore.length}`);
    console.log(`  Catering ≠ Store:       ${cateringStoreDiff.length}`);
    console.log(`  Festival ratio outliers:${festivalAnomalies.length}`);
    console.log(`  Øre-priser:             ${decimalPrices.length}`);
    console.log(`  Cost > Sales (SALG):    ${inverted.length}`);
    console.log(`  Lav margin (SALG):      ${lowMargin.length}`);
    console.log(`  Manuel cost mismatch:   ${costMismatch.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
