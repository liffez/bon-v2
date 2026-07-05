// services/co2Materials.js
// ==========================================
// CO₂ F3 — materiale-faktortabel + `co2e_material`-tildeler (emballage).
// Spec: docs/CLAUDE_CO2.md §6 + §8 + §12 trin 3.
//
// Ansvar:
//   • læse/vedligeholde den lille materiale-faktortabel (co2_material_factors)
//   • tildele ÉT materiale til en Grocy-emballagevare (skriver co2e_material)
//   • RESOLVE: slå faktoren op og skrive co2e_per_kg + co2e_source=material +
//     co2e_version tilbage på Grocy-produktet (kun når faktoren kendes)
//   • re-resolve: når en faktor udfyldes/ændres, gen-skriv den til ALLE varer
//     der peger på materialet — så "udfyld løbende" rammer hele bunken på én gang
//
// Grocy skrives KUN via adapteren (aldrig direkte i Grocy's DB). Alle skrivninger
// rammer den AKTIVE lokation (default_grocy_location_id) som resten af appen.
// ==========================================

'use strict';

const grocy = require('./grocyAdapter');

/* ---------- materiale-faktortabel (Bon v2's egen reference) ---------- */

/** Alle materialer, sorteret. include_inactive=false → kun aktive. */
function listMaterials(db, includeInactive = false) {
    const where = includeInactive ? '' : 'WHERE is_active = 1';
    return db.prepare(
        `SELECT id, key, label, factor_kg_co2e_per_kg AS factor, version,
                typical_items, sort_order, is_active, updated_at
           FROM co2_material_factors ${where}
          ORDER BY sort_order, label`
    ).all();
}

function getMaterialByKey(db, key) {
    return db.prepare(
        `SELECT id, key, label, factor_kg_co2e_per_kg AS factor, version,
                typical_items, sort_order, is_active, updated_at
           FROM co2_material_factors WHERE key = ?`
    ).get(key);
}

/**
 * Byg det userfield-objekt der skal skrives på et Grocy-produkt for et
 * givet materiale. Faktor ukendt → co2e_per_kg + co2e_version ryddes (''),
 * men co2e_material + co2e_source=material bevares (vi VED det er materiale,
 * mangler kun tallet).
 */
function fieldsForMaterial(mat) {
    const hasFactor = mat && mat.factor != null && Number.isFinite(Number(mat.factor));
    return {
        co2e_material: mat ? mat.key : '',
        co2e_source:   'material',
        co2e_per_kg:   hasFactor ? String(Number(mat.factor)) : '',
        co2e_version:  hasFactor && mat.version ? String(mat.version) : '',
        co2e_klima_id: '', // emballage er ikke en fødevare (§2)
    };
}

/* ---------- emballagevarer fra Grocy ---------- */

/** Er produktgruppen en emballage-gruppe? Matcher på navn (id'er varierer pr. instans). */
function isPackagingGroup(name) {
    return /emballage/i.test(name || '');
}

/**
 * Liste over emballagevarer med deres nuværende CO₂-materiale-status.
 * Bygges af Grocy /objects/products + /objects/product_groups.
 */
async function listPackagingProducts(db) {
    const [products, groups] = await Promise.all([
        grocy.getProducts(),
        grocy.getProductGroups(),
    ]);
    const groupName = new Map(groups.map(g => [String(g.id), g.name]));
    const packagingGroupIds = new Set(
        groups.filter(g => isPackagingGroup(g.name)).map(g => String(g.id))
    );

    const materials = listMaterials(db, true);
    const matByKey = new Map(materials.map(m => [m.key, m]));

    const out = [];
    for (const p of products) {
        const gid = String(p.product_group_id || '');
        if (!packagingGroupIds.has(gid)) continue;

        const uf = p.userfields || {};
        const matKey = (uf.co2e_material || '').trim();
        const mat = matKey ? matByKey.get(matKey) : null;
        const perKg = uf.co2e_per_kg != null && uf.co2e_per_kg !== ''
            ? Number(uf.co2e_per_kg) : null;

        let status;
        if (!matKey) status = 'unassigned';
        else if (!mat) status = 'unknown_material';       // peger på et materiale der ikke findes
        else if (mat.factor == null) status = 'pending_factor';
        else if (perKg == null) status = 'needs_resolve'; // faktor kendes, men ikke skrevet på varen endnu
        else status = 'ok';

        out.push({
            id: p.id,
            name: p.name,
            product_group_id: p.product_group_id,
            product_group: groupName.get(gid) || null,
            co2e_material: matKey || null,
            co2e_material_label: mat ? mat.label : (matKey || null),
            co2e_per_kg: perKg,
            co2e_source: (uf.co2e_source || '').trim() || null,
            co2e_version: (uf.co2e_version || '').trim() || null,
            packaging_g: uf.co2e_packaging_g != null && uf.co2e_packaging_g !== ''
                ? Number(uf.co2e_packaging_g) : null,
            status,
        });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'da'));
    return out;
}

/* ---------- tildel / ryd / re-resolve (skriver til Grocy) ---------- */

/** Tildel ét materiale til én vare. Skriver userfields + resolver faktor hvis kendt. */
async function assignMaterial(db, productId, key) {
    const mat = getMaterialByKey(db, key);
    if (!mat) { const e = new Error('Ukendt materiale: ' + key); e.status = 400; throw e; }
    const fields = fieldsForMaterial(mat);
    await grocy.updateProductUserfields(productId, fields);
    grocy.clearCache();
    return { product_id: Number(productId), material: mat.key, resolved: fields.co2e_per_kg !== '' , fields };
}

/** Ryd materiale-tildeling på en vare (kun hvis kilden var 'material'). */
async function clearMaterial(db, productId) {
    const fields = {
        co2e_material: '',
        co2e_source:   '',
        co2e_per_kg:   '',
        co2e_version:  '',
    };
    await grocy.updateProductUserfields(productId, fields);
    grocy.clearCache();
    return { product_id: Number(productId), cleared: true };
}

/**
 * Re-resolve ét materiale: skriv den nuværende faktor til ALLE emballagevarer
 * der peger på materialet. Bruges når en faktor lige er udfyldt/ændret.
 * Returnerer antal opdaterede varer.
 */
async function reresolveMaterial(db, key) {
    const mat = getMaterialByKey(db, key);
    if (!mat) { const e = new Error('Ukendt materiale: ' + key); e.status = 400; throw e; }
    const fields = fieldsForMaterial(mat);

    const products = await grocy.getProducts();
    const targets = products.filter(p => ((p.userfields || {}).co2e_material || '').trim() === key);
    for (const p of targets) {
        await grocy.updateProductUserfields(p.id, fields);
    }
    grocy.clearCache();
    return { material: key, updated: targets.length, resolved: fields.co2e_per_kg !== '' };
}

module.exports = {
    listMaterials,
    getMaterialByKey,
    fieldsForMaterial,
    isPackagingGroup,
    listPackagingProducts,
    assignMaterial,
    clearMaterial,
    reresolveMaterial,
};
