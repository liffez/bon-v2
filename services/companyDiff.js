// services/companyDiff.js
// ==========================================
// Bygger en struktureret diff mellem et eksisterende firma og resultatet
// af en CVR-berigelse. Bruges af /api/companies/:id/enrich-preview til
// at returnere et UI-klart objekt med felt-for-felt sammenligning.
//
// Bemærk: denne modul tager IKKE address-id i betragtning (vi rører ikke
// den normaliserede addresses-tabel her — adressefelter behandles som
// rene tekstfelter for diff-formålet, og adresse-skift håndteres af
// enrich-endpointet via et separat lookup/insert-flow).
// ==========================================

// Felter der mappes mellem enrichment-data (key fra parseVirkHit) og DB-kolonne på companies.
// `writable: false` = afledt info (vises kun, gemmes ikke).
//
// Adresse-felter (street/zipcode/city) håndteres IKKE her — companies bruger
// normaliseret address_id → addresses-tabellen. Adresse-enrichment kommer i
// Fase 6 (Firma 360°) hvor address-håndtering hører hjemme.
const FIELD_MAP = [
    { key: 'legal_name',     label: 'Juridisk navn', src: 'legal_name',    writable: true  },
    { key: 'cvr',            label: 'CVR',           src: 'cvr',           writable: true  },
    { key: 'ean',            label: 'EAN',           src: 'ean',           writable: true  },
    { key: 'branch',         label: 'Branche',       src: 'industry',      writable: true  },
    { key: 'company_type',   label: 'Selskabsform',  src: 'company_type',  writable: true  },
    { key: 'employee_count', label: 'Ansatte',       src: 'employees',     writable: true  },
    { key: 'status',         label: 'CVR-status',    src: 'status',        writable: false },
];

function normEmpty(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' && v.trim() === '') return null;
    return v;
}

function valuesEqual(a, b) {
    const na = normEmpty(a);
    const nb = normEmpty(b);
    if (na === nb) return true;
    if (na == null || nb == null) return false;
    return String(na).trim().toLowerCase() === String(nb).trim().toLowerCase();
}

/**
 * Byg diff mellem nuværende firma + nuværende contact_points og enrichment-resultat.
 *
 * @param {object} currentCompany   row fra companies-tabellen
 * @param {object} enrichmentResult fra cvrEnrichment.enrich()
 * @param {Array}  existingCps      array af contact_points for firmaet (entity_type='company')
 *
 * @returns {{
 *   fields: Array<{key,label,current,proposed,changed,writable}>,
 *   contact_points: Array<{kind,value,already_exists,existing_id?,existing_is_public?,proposed_source,proposed_is_public}>
 * }}
 */
function buildCompanyDiff(currentCompany, enrichmentResult, existingCps = []) {
    if (!enrichmentResult || enrichmentResult.found !== true) {
        return { fields: [], contact_points: [] };
    }
    const proposedData = enrichmentResult.data || {};

    // Felter
    const fields = FIELD_MAP.map(f => {
        const current  = currentCompany[f.key] ?? null;
        const proposed = proposedData[f.src] ?? null;
        const changed  = !valuesEqual(current, proposed) && normEmpty(proposed) != null;
        return {
            key: f.key,
            label: f.label,
            current,
            proposed,
            changed,
            writable: f.writable,
        };
    });

    // Kontaktpunkter — alle fra CVR markeres som offentlige
    const contact_points = [];
    const seen = new Set(); // dedup hvis samme værdi optræder flere gange

    function addCandidate(kind, value) {
        const norm = String(value || '').trim();
        if (!norm) return;
        const key = `${kind}:${norm.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);

        const existing = existingCps.find(cp =>
            cp.kind === kind && cp.value.toLowerCase() === norm.toLowerCase() && cp.is_active === 1
        );

        contact_points.push({
            kind,
            value: norm,
            already_exists: !!existing,
            existing_id: existing?.id,
            existing_is_public: existing?.is_public,
            proposed_source: 'cvr',
            proposed_is_public: 1,
        });
    }

    for (const e of (proposedData.public_emails || [])) addCandidate('email', e);
    for (const p of (proposedData.public_phones || [])) addCandidate('phone', p);

    return { fields, contact_points };
}

module.exports = { buildCompanyDiff, FIELD_MAP };
