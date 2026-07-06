// services/co2Synonyms.js
// ==========================================
// CO₂ — synonym-par som DATA (ikke skjult kode). Bruges af CO₂-rapporten til at
// vise + redigere dublet-vare-reglerne (kål↔Hvidkål osv.), så de kan verificeres.
//
// Kanonisk = varen med faktoren. Synonym = dublet der arver samme faktor.
// Ved tilføjelse propageres faktoren straks til synonym-produktet i Grocy.
// Importen (co2Concito) læser de samme par via loadSynonymPairs().
// ==========================================

'use strict';

const grocy = require('./grocyAdapter');
const { normName } = require('./co2Concito');

/** Rå par fra DB (aktive). */
function listSynonyms(db) {
    return db.prepare(
        `SELECT id, canonical_name, synonym_name, note, is_active
           FROM co2_synonyms ORDER BY canonical_name, synonym_name`
    ).all();
}

/** Par som [canonicalNorm, synonymNorm]-tupler til co2Concito (kun aktive). */
function loadSynonymPairs(db) {
    return listSynonyms(db)
        .filter(r => r.is_active)
        .map(r => [normName(r.canonical_name), normName(r.synonym_name)]);
}

const factorOf = (p) => {
    const uf = (p && p.userfields) || {};
    return uf.co2e_per_kg != null && uf.co2e_per_kg !== '' ? Number(uf.co2e_per_kg) : null;
};

/**
 * Synonymer resolvet mod Grocy — så brugeren kan SE om de er rigtige:
 * canonical-produkt + faktor, synonym-produkt + faktor, status.
 */
async function listResolved(db) {
    const products = await grocy.getProducts();
    const byNorm = new Map();
    products.forEach(p => { const n = normName(p.name); if (!byNorm.has(n)) byNorm.set(n, p); });

    return listSynonyms(db).map(r => {
        const cp = byNorm.get(normName(r.canonical_name));
        const sp = byNorm.get(normName(r.synonym_name));
        const cf = factorOf(cp), sf = factorOf(sp);
        let status;
        if (!cp) status = 'canonical_missing';
        else if (!sp) status = 'synonym_missing';
        else if (cf == null) status = 'canonical_no_factor';
        else if (sf == null) status = 'not_applied';
        else if (Math.abs(sf - cf) > Math.max(1e-9, Math.abs(cf) * 0.001)) status = 'mismatch';
        else status = 'applied';
        return {
            id: r.id, canonical_name: r.canonical_name, synonym_name: r.synonym_name, note: r.note,
            canonical_factor: cf, synonym_factor: sf,
            canonical_source: cp && ((cp.userfields || {}).co2e_source || null),
            status,
        };
    });
}

/** Tilføj et par + propagér faktoren fra kanonisk → synonym-produkt (hvis muligt). */
async function addSynonym(db, canonicalName, synonymName) {
    canonicalName = String(canonicalName || '').trim();
    synonymName = String(synonymName || '').trim();
    if (!canonicalName || !synonymName) { const e = new Error('canonical + synonym kræves'); e.status = 400; throw e; }
    if (normName(canonicalName) === normName(synonymName)) { const e = new Error('Kanonisk og synonym er samme vare'); e.status = 400; throw e; }

    db.prepare(
        `INSERT INTO co2_synonyms (canonical_name, synonym_name)
         VALUES (?, ?) ON CONFLICT (canonical_name, synonym_name) DO NOTHING`
    ).run(canonicalName, synonymName);

    // Propagér: skriv kanonisk-produktets faktor til synonym-produktet.
    const products = await grocy.getProducts();
    const byNorm = new Map();
    products.forEach(p => { const n = normName(p.name); if (!byNorm.has(n)) byNorm.set(n, p); });
    const cp = byNorm.get(normName(canonicalName));
    const sp = byNorm.get(normName(synonymName));
    let propagated = false;
    if (cp && sp) {
        const uf = cp.userfields || {};
        if (uf.co2e_per_kg) {
            await grocy.updateProductUserfields(sp.id, {
                co2e_per_kg: String(uf.co2e_per_kg),
                co2e_source: uf.co2e_source || 'supplier',
                co2e_klima_id: uf.co2e_klima_id || '',
                co2e_version: uf.co2e_version || '',
            });
            grocy.clearCache();
            propagated = true;
        }
    }
    return {
        canonical: canonicalName, synonym: synonymName,
        propagated,
        warning: !cp ? 'Kanonisk vare ikke fundet i Grocy'
            : !sp ? 'Synonym-vare ikke fundet i Grocy'
            : !propagated ? 'Kanonisk vare har ingen faktor endnu' : null,
    };
}

/** Fjern et par (rører ikke faktoren på synonym-produktet — den bevares). */
function removeSynonym(db, id) {
    const row = db.prepare('SELECT * FROM co2_synonyms WHERE id = ?').get(id);
    if (!row) { const e = new Error('Synonym ikke fundet'); e.status = 404; throw e; }
    db.prepare('DELETE FROM co2_synonyms WHERE id = ?').run(id);
    return { removed: true };
}

module.exports = { listSynonyms, loadSynonymPairs, listResolved, addSynonym, removeSynonym };
