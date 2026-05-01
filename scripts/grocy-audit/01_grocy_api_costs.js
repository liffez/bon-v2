// Hent Grocy's egen kostpris-beregning (via /api/recipes/:id/fulfillment) for
// ALLE sellable opskrifter. Sammenlign med SalespriceCatering.
//
// Fortæller os: er Grocy's NUVÆRENDE kostpris sund? Eller er der opskrifter
// hvor Grocy's egen formel returnerer cost ≥ sales?

const fs = require('fs');
const path = require('path');
const os = require('os');
const { openDb } = require('./lib/db');
const { writeReport, formatTable } = require('./lib/report');

const KEY_FILE = path.join(os.homedir(), 'grocy-audit-2026-05-02', '.api-key');
if (!fs.existsSync(KEY_FILE)) {
    console.error(`API-key mangler: ${KEY_FILE}`);
    process.exit(1);
}
const API_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
const BASE = 'http://localhost:9283';

async function fetchFulfillment(recipeId) {
    const res = await fetch(`${BASE}/api/recipes/${recipeId}/fulfillment`, {
        headers: { 'GROCY-API-KEY': API_KEY, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function main() {
    const db = openDb();

    // Find alle sellable opskrifter (sellable userfield = '1')
    const sellable = db.prepare(`
        SELECT r.id, r.name, r.base_servings, r.desired_servings, r.type
        FROM recipes r
        JOIN userfield_values uv ON uv.object_id = CAST(r.id AS TEXT)
        JOIN userfields uf ON uf.id = uv.field_id
        WHERE uf.entity = 'recipes' AND uf.name = 'sellable' AND uv.value = '1'
        ORDER BY r.name
    `).all();

    console.log(`Sellable opskrifter: ${sellable.length}`);

    // Hent Catering-pris for hver
    const cateringPrices = Object.fromEntries(
        db.prepare(`
            SELECT uv.object_id, uv.value
            FROM userfield_values uv
            JOIN userfields uf ON uf.id = uv.field_id
            WHERE uf.entity = 'recipes' AND uf.name = 'SalespriceCatering'
        `).all().map(r => [r.object_id, parseFloat(r.value)])
    );
    const storePrices = Object.fromEntries(
        db.prepare(`
            SELECT uv.object_id, uv.value FROM userfield_values uv
            JOIN userfields uf ON uf.id = uv.field_id
            WHERE uf.entity = 'recipes' AND uf.name = 'SalespriceStore'
        `).all().map(r => [r.object_id, parseFloat(r.value)])
    );

    db.close();

    const results = [];
    let n = 0;
    for (const r of sellable) {
        n++;
        process.stdout.write(`\r  ${n}/${sellable.length} ${r.name.slice(0, 40).padEnd(40)}`);
        try {
            const f = await fetchFulfillment(r.id);
            const sales = cateringPrices[String(r.id)] || storePrices[String(r.id)] || 0;
            const salesEx = sales / 1.25;
            const cost = f.costs_per_serving || 0;
            const ratio = salesEx > 0 ? cost / salesEx : null;
            const inverted = cost > salesEx;
            results.push({
                id: r.id,
                name: r.name,
                base: r.base_servings,
                desired: r.desired_servings,
                cost: Math.round(cost * 100) / 100,
                sales_incl: sales,
                sales_ex: Math.round(salesEx * 100) / 100,
                ratio: ratio !== null ? Math.round(ratio * 100) / 100 : null,
                inverted: inverted ? 'X' : '',
                missing_products: f.missing_products_count,
                prices_incomplete: f.prices_incomplete
            });
        } catch (e) {
            results.push({ id: r.id, name: r.name, error: e.message });
        }
    }
    console.log('');

    const ok = results.filter(r => !r.error);
    const inverted = ok.filter(r => r.inverted);
    const veryHigh = ok.filter(r => r.ratio !== null && r.ratio > 0.5 && r.ratio <= 1);
    const noPrice = ok.filter(r => r.sales_incl === 0);

    console.log('');
    console.log('═'.repeat(78));
    console.log('SAMMENFATNING');
    console.log('═'.repeat(78));
    console.log(`Sellable opskrifter:        ${ok.length}`);
    console.log(`  Cost > Sales (inverted):  ${inverted.length}  ← skal undersøges`);
    console.log(`  Cost 50-100% af Sales:    ${veryHigh.length}  ← lav margin`);
    console.log(`  Mangler salgspris:        ${noPrice.length}`);
    console.log(`  Errors:                   ${results.filter(r => r.error).length}`);

    if (inverted.length) {
        console.log('');
        console.log('Inverterede (cost ≥ sales ex moms):');
        for (const r of inverted.sort((a, b) => b.ratio - a.ratio)) {
            console.log(`  ${String(r.id).padStart(4)} ${r.name.padEnd(40)} cost=${String(r.cost).padStart(8)} sales_ex=${String(r.sales_ex).padStart(7)} ratio=${r.ratio}`);
        }
    }

    // Skriv rapport
    const sections = [
        { title: 'Sammenfatning', body:
            `- Sellable opskrifter: ${ok.length}\n` +
            `- Cost > Sales (inverted): **${inverted.length}**\n` +
            `- Cost 50-100% af Sales: ${veryHigh.length}\n` +
            `- Mangler salgspris: ${noPrice.length}\n` +
            `- Errors: ${results.filter(r => r.error).length}`
        },
        { title: 'Inverterede opskrifter (cost ≥ sales ex moms)', body:
            inverted.length ? formatTable(inverted.sort((a, b) => b.ratio - a.ratio)) : '_(ingen)_'
        },
        { title: 'Lav margin (cost 50-100% af sales)', body:
            veryHigh.length ? formatTable(veryHigh.sort((a, b) => b.ratio - a.ratio)) : '_(ingen)_'
        },
        { title: 'Mangler salgspris', body:
            noPrice.length ? formatTable(noPrice) : '_(alle har salgspris)_'
        },
        { title: 'Alle sellable (sorteret efter ratio)', body:
            formatTable(ok.filter(r => r.ratio !== null).sort((a, b) => (b.ratio || 0) - (a.ratio || 0)))
        }
    ];
    writeReport('01_grocy_api_costs', sections);
}

main().catch(e => { console.error(e); process.exit(1); });
