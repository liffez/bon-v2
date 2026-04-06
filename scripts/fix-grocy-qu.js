#!/usr/bin/env node
/**
 * fix-grocy-qu.js
 * ═══════════════════════════════════════════════════════════
 * Retter recipes_pos.amount og qu_id i Grocy's SQLite database.
 *
 * Problem: stock-enheder blev ændret til Kilo/Liter, men
 *          recipes_pos.amount blev konverteret til stock-units
 *          mens qu_id IKKE blev opdateret → amounts er i Kilo
 *          men qu_id siger Antal/Gram/ml.
 *
 * Fix:     Konvertér amount TILBAGE til recipe-enhed (qu_id)
 *          via quantity_unit_conversions.
 *
 * Brug:    node scripts/fix-grocy-qu.js <path-to-grocy.db> [--apply]
 *          Uden --apply: dry run (kun rapport)
 *          Med --apply: skriver ændringer til databasen
 * ═══════════════════════════════════════════════════════════
 */

const { openDb } = require('../db/compat');
const path = require('path');

const dbPath = process.argv[2];
const apply = process.argv.includes('--apply');

if (!dbPath) {
    console.error('Brug: node scripts/fix-grocy-qu.js <path-to-grocy.db> [--apply]');
    process.exit(1);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`  Grocy QU Migration ${apply ? '🔧 APPLY MODE' : '👁  DRY RUN'}`);
console.log(`  Database: ${path.basename(dbPath)}`);
console.log(`${'═'.repeat(60)}\n`);

const db = openDb(dbPath);

// ── Hent data ────────────────────────────────────────────────

const units = {};
db.prepare('SELECT id, name FROM quantity_units').all()
    .forEach(u => units[u.id] = u.name);

const products = {};
db.prepare('SELECT id, name, qu_id_stock, qu_id_consume, qu_id_purchase FROM products').all()
    .forEach(p => products[p.id] = p);

// Product-specific conversions: { "pid:from:to" → factor }
const conversions = {};
db.prepare('SELECT product_id, from_qu_id, to_qu_id, factor FROM quantity_unit_conversions WHERE product_id IS NOT NULL').all()
    .forEach(c => {
        conversions[`${c.product_id}:${c.from_qu_id}:${c.to_qu_id}`] = c.factor;
    });

// Implicit conversions (metric)
const IMPLICIT = {
    '4:5': 1000,      // Kilo → Gram
    '5:4': 0.001,     // Gram → Kilo
    '6:7': 1000,      // Liter → ml
    '7:6': 0.001,     // ml → Liter
};

function getConversion(productId, fromQu, toQu) {
    if (fromQu === toQu) return 1;
    // Product-specific first
    const key = `${productId}:${fromQu}:${toQu}`;
    if (conversions[key]) return conversions[key];
    // Implicit metric
    const implKey = `${fromQu}:${toQu}`;
    if (IMPLICIT[implKey]) return IMPLICIT[implKey];
    return null;
}

// ── Find alle mismatches ─────────────────────────────────────

const mismatches = db.prepare(`
    SELECT rp.id, rp.recipe_id, rp.product_id, rp.amount, rp.qu_id,
           r.name as recipe_name
    FROM recipes_pos rp
    JOIN recipes r ON r.id = rp.recipe_id
    WHERE rp.qu_id != (SELECT qu_id_stock FROM products WHERE id = rp.product_id)
`).all();

console.log(`Fandt ${mismatches.length} recipes_pos med qu_id ≠ stock unit\n`);

// ── Klassificér og beregn ────────────────────────────────────

const fixed = [];
const orphans = [];
const GRAM_ID = 5;
const ML_ID = 7;

for (const row of mismatches) {
    const product = products[row.product_id];
    if (!product) { orphans.push({ ...row, reason: 'product not found' }); continue; }

    const stockQu = product.qu_id_stock;
    const recipeQu = row.qu_id;
    const factor = getConversion(product.id, stockQu, recipeQu);

    if (factor !== null) {
        const newAmount = row.amount * factor;
        fixed.push({
            id: row.id,
            recipe: row.recipe_name,
            product: product.name,
            oldAmount: row.amount,
            oldQu: units[recipeQu],
            stockQu: units[stockQu],
            newAmount,
            newQu: units[recipeQu],  // qu_id stays the same
            quId: recipeQu,
            factor,
        });
    } else {
        // Orphan: no conversion available
        // Strategy: change qu_id to Gram (if stock=Kilo) or ml (if stock=Liter)
        let fallbackQu, fallbackFactor;
        if (stockQu === 4) { // Kilo
            fallbackQu = GRAM_ID; fallbackFactor = 1000;
        } else if (stockQu === 6) { // Liter
            fallbackQu = ML_ID; fallbackFactor = 1000;
        } else {
            orphans.push({ ...row, product: product.name, reason: `no conversion ${units[stockQu]}→${units[recipeQu]}` });
            continue;
        }

        const newAmount = row.amount * fallbackFactor;
        fixed.push({
            id: row.id,
            recipe: row.recipe_name,
            product: product.name,
            oldAmount: row.amount,
            oldQu: units[recipeQu],
            stockQu: units[stockQu],
            newAmount,
            newQu: units[fallbackQu],
            quId: fallbackQu,  // qu_id CHANGES to Gram/ml
            factor: fallbackFactor,
            quChanged: true,
        });
    }
}

// ── Rapport ──────────────────────────────────────────────────

console.log(`✅ Kan fikses: ${fixed.length}`);
console.log(`⚠️  Orphans (uløselige): ${orphans.length}`);

if (orphans.length) {
    console.log('\n── Orphans ──');
    orphans.forEach(o => console.log(`  ${o.product}: ${o.reason}`));
}

// Vis stikprøver
console.log('\n── Stikprøver (første 20) ──');
console.log(`${'Opskrift'.padEnd(30)} ${'Produkt'.padEnd(22)} ${'Før'.padEnd(18)} ${'Efter'.padEnd(18)} ${' Qu ændret?'}`);
console.log('─'.repeat(100));

for (const f of fixed.slice(0, 20)) {
    const before = `${f.oldAmount} ${f.oldQu}`;
    const after = `${Number.isInteger(f.newAmount) ? f.newAmount : parseFloat(f.newAmount.toFixed(4))} ${f.newQu}`;
    const changed = f.quChanged ? `⚠ ${f.oldQu}→${f.newQu}` : '';
    console.log(`${f.recipe.padEnd(30)} ${f.product.padEnd(22)} ${before.padEnd(18)} ${after.padEnd(18)} ${changed}`);
}

// Sanity checks
console.log('\n── Sanity checks ──');
const suspicious = fixed.filter(f => {
    if (f.newAmount <= 0) return true;
    if (f.newAmount > 10000) return true;
    // Antal should be reasonable (< 200)
    if (f.newQu === 'Antal' && f.newAmount > 200) return true;
    return false;
});

if (suspicious.length) {
    console.log(`⚠️  ${suspicious.length} mistænkelige værdier:`);
    suspicious.forEach(s => console.log(`  ${s.product} i ${s.recipe}: ${s.newAmount} ${s.newQu}`));
} else {
    console.log('✅ Alle værdier ser fornuftige ud');
}

// Statistik per unit-type
console.log('\n── Konverteringstyper ──');
const typeStats = {};
fixed.forEach(f => {
    const key = `${f.stockQu}→${f.newQu}`;
    typeStats[key] = (typeStats[key] || 0) + 1;
});
Object.entries(typeStats).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k}: ${v} positioner`));

// ── Apply ────────────────────────────────────────────────────

if (apply) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log('  APPLYING CHANGES...');
    console.log(`${'═'.repeat(60)}\n`);

    const stmt = db.prepare('UPDATE recipes_pos SET amount = ?, qu_id = ? WHERE id = ?');
    const { transaction: txn } = require('../db/compat');
    const count = txn(db, () => {
        let updated = 0;
        for (const f of fixed) {
            stmt.run(f.newAmount, f.quId, f.id);
            updated++;
        }
        return updated;
    });
    console.log(`✅ ${count} recipes_pos rækker opdateret\n`);

    // Verify
    const remaining = db.prepare(`
        SELECT COUNT(*) as cnt FROM recipes_pos rp
        WHERE rp.qu_id != (SELECT qu_id_stock FROM products WHERE id = rp.product_id)
    `).get();
    console.log(`Resterende mismatches: ${remaining.cnt} (forventet: ${fixed.filter(f => !f.quChanged).length + fixed.filter(f => f.quChanged).length})`);

    // Verify Falaflen specifically
    console.log('\n── Verifikation: Falaflen (recipe 91) ──');
    db.prepare(`
        SELECT p.name, rp.amount, qu.name as unit
        FROM recipes_pos rp
        JOIN products p ON p.id = rp.product_id
        JOIN quantity_units qu ON qu.id = rp.qu_id
        WHERE rp.recipe_id = 91
        ORDER BY rp.ingredient_group NULLS FIRST, p.name
    `).all().forEach(r => {
        const amt = Number.isInteger(r.amount) ? r.amount : parseFloat(r.amount.toFixed(4));
        console.log(`  ${r.name}: ${amt} ${r.unit}`);
    });

} else {
    console.log(`\n💡 Kør med --apply for at gemme ændringer:`);
    console.log(`   node scripts/fix-grocy-qu.js ${dbPath} --apply\n`);
}

db.close();
