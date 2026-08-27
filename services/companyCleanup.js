/**
 * services/companyCleanup.js
 * ════════════════════════════════════════════════════════════
 * Hvilke firma-rækker bærer ikke noget?
 *
 * Bestillingsformularens Firma-felt er fri tekst, og webhooken oprettede indtil
 * migration 167 et firma for hver skrivemåde. Sammen med v1-importen, der tog
 * fire varianter af samme firma med over, har det efterladt et kartotek hvor
 * knap en tredjedel af rækkerne er tomme.
 *
 * REGLEN (fra drift, 28. august 2026): en række beholdes hvis der er en bon, en
 * kontaktperson eller en mail på den. Er der intet af delene, er den et artefakt.
 *
 * Reglen bor HER, ikke i scriptet og heller ikke i routen, fordi begge bruger
 * den. To kopier ville uundgåeligt skride fra hinanden, og så ville siden vise
 * noget andet end kommandolinjen fjerner.
 * ════════════════════════════════════════════════════════════
 */

'use strict';

// Værn — alle fredede rækker skal passere dem. Hvert enkelt dækker en måde en
// "tom" række kan vise sig at bære noget alligevel:
//
//   e-conomic-nummer   rækken er koblet til regnskabet
//   is_internal        Ristet Rug selv
//   note               nogen har skrevet noget på den
//   påmindelse         en flag der skal hejses på fremtidige bons
//   vedhæftning        en fil lagt på firmaet
//   custom-felt        et CRM-felt nogen har udfyldt
//   fremmednøgler      event, kampagne eller booking-token peger på rækken
//
// ⚠️ `rfm_scores` er BEVIDST ikke et værn. Tabellen er beregnet og har en række
// for stort set hvert firma (1.346 af 1.452 i drift). Bruges den som bevis på
// en relation, freder den alt, og reglen bliver tom: 377 kandidater → 0.
const EMPTY_PREDICATE = `
    c.is_active = 1
    AND COALESCE(c.is_internal, 0) = 0
    AND COALESCE(c.economic_customer_id, '') = ''
    AND TRIM(COALESCE(c.notes, '')) = ''
    AND NOT EXISTS (SELECT 1 FROM bons b       WHERE b.company_id  = c.id)
    AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.company_id = c.id AND cu.is_active = 1)
    AND NOT EXISTS (SELECT 1 FROM mail_threads mt
                      JOIN customers cu2 ON cu2.id = mt.customer_id
                     WHERE cu2.company_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM entity_flags ef
                     WHERE ef.entity_type = 'company' AND ef.entity_id = c.id
                       AND ef.dismissed_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM attachments a
                     WHERE a.entity_type = 'company' AND a.entity_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM crm_custom_values v
                     WHERE v.entity_type = 'company' AND v.entity_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM events e          WHERE e.company_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM campaign_members m WHERE m.company_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM booking_tokens t   WHERE t.company_id = c.id)
`;

// Den række der handler under samme CVR. Det er den mest brugbare oplysning når
// hundredvis af navne skal skimmes: "Akademisk Arkitektforening" ser ud som en
// rigtig kunde man ikke må røre — indtil man ser at "Arkitektforeningen" (samme
// CVR) står med 112 bons ved siden af.
const TWIN = `
    SELECT o.id FROM companies o
     WHERE o.cvr = c.cvr AND COALESCE(c.cvr,'') <> '' AND o.id <> c.id AND o.is_active = 1
       AND EXISTS (SELECT 1 FROM bons b WHERE b.company_id = o.id)
     ORDER BY (SELECT COUNT(*) FROM bons b WHERE b.company_id = o.id) DESC LIMIT 1
`;

const GROUPS = {
    duplicate: 'Dublet af et firma der handler',
    dormant:   'Har CVR, men ingen anden række med bons',
    unknown:   'Uden CVR og uden spor',
};

/**
 * Alle kandidater, med tvilling-oplysning og gruppe.
 * @param {object} db
 * @param {object} [opts]  { keepCvr } — fred også rækker der har et CVR-nummer
 */
function findEmptyCompanies(db, opts = {}) {
    const extra = opts.keepCvr ? "AND COALESCE(c.cvr,'') = ''" : '';
    const rows = db.prepare(`
        SELECT c.id, c.name, COALESCE(c.cvr,'') cvr, COALESCE(c.created_at,'') created_at,
               (${TWIN}) AS dup_id
          FROM companies c
         WHERE ${EMPTY_PREDICATE} ${extra}
         ORDER BY c.id
    `).all();

    // Tvillingens navn og antal bons hentes i ét opslag pr. unikt id frem for
    // som tre korrelerede subqueries pr. række — listen kan være mange hundrede
    // rækker lang, og siden skal svare med det samme.
    const twinIds = [...new Set(rows.map(r => r.dup_id).filter(Boolean))];
    const twins = new Map();
    if (twinIds.length) {
        const q = twinIds.map(() => '?').join(',');
        for (const t of db.prepare(`
            SELECT o.id, o.name, (SELECT COUNT(*) FROM bons b WHERE b.company_id = o.id) bons
              FROM companies o WHERE o.id IN (${q})
        `).all(...twinIds)) twins.set(t.id, t);
    }

    return rows.map(r => {
        const t = r.dup_id ? twins.get(r.dup_id) : null;
        return {
            id: r.id,
            name: r.name,
            cvr: r.cvr,
            created_at: r.created_at ? r.created_at.slice(0, 10) : '',
            group: t ? 'duplicate' : (r.cvr ? 'dormant' : 'unknown'),
            twin: t ? { id: t.id, name: t.name, bons: t.bons } : null,
        };
    });
}

/** Hvad blev fredet selvom rækken var tom? Gør reglen bedømmelig. */
function countSpared(db) {
    return db.prepare(`
        SELECT
          SUM(CASE WHEN COALESCE(c.economic_customer_id,'') <> '' THEN 1 ELSE 0 END) economic,
          SUM(CASE WHEN TRIM(COALESCE(c.notes,'')) <> '' THEN 1 ELSE 0 END)          notes,
          SUM(CASE WHEN COALESCE(c.is_internal,0) = 1 THEN 1 ELSE 0 END)             internal
        FROM companies c
        WHERE c.is_active = 1
          AND NOT EXISTS (SELECT 1 FROM bons b       WHERE b.company_id  = c.id)
          AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.company_id = c.id AND cu.is_active = 1)
          AND NOT EXISTS (SELECT 1 FROM mail_threads mt
                            JOIN customers cu2 ON cu2.id = mt.customer_id
                           WHERE cu2.company_id = c.id)
    `).get();
}

/**
 * Deaktivér de valgte rækker.
 *
 * Hvert id kontrolleres mod reglen IGEN her. Listen i browseren kan være
 * minutter eller timer gammel, og i mellemtiden kan en bon være landet på
 * rækken — fx fordi nogen tastede firmanavnet i bestillingsformularen. Uden
 * gentjekket ville et gammelt faneblad kunne lægge et firma væk der er kommet
 * i brug siden. Rækker der ikke længere er kandidater springes over og
 * rapporteres tilbage, så brugeren kan se hvad der IKKE skete.
 *
 * Rækker deaktiveres — de slettes aldrig. En bon, en faktura eller en
 * changelog-linje kan pege på dem år efter.
 */
function deactivateCompanies(db, ids, userId = null) {
    const wanted = [...new Set((ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite))];
    if (!wanted.length) return { deactivated: [], skipped: [] };

    const q = wanted.map(() => '?').join(',');
    const stillEmpty = new Set(db.prepare(`
        SELECT c.id FROM companies c WHERE c.id IN (${q}) AND ${EMPTY_PREDICATE}
    `).all(...wanted).map(r => r.id));

    const deactivated = [];
    const skipped = [];
    const upd = db.prepare('UPDATE companies SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const log = db.prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
        VALUES ('company', ?, 'update', 'is_active', 1, 0, ?, ?)
    `);

    for (const id of wanted) {
        if (!stillEmpty.has(id)) { skipped.push(id); continue; }
        upd.run(id);
        log.run(id, userId, 'deaktiveret — ingen bon, kontaktperson eller mail på rækken');
        deactivated.push(id);
    }
    return { deactivated, skipped };
}

module.exports = { findEmptyCompanies, countSpared, deactivateCompanies, GROUPS };
