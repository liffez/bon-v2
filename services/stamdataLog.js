/**
 * services/stamdataLog.js — spor på stamdata-ændringer (#666)
 * ════════════════════════════════════════════════════════════
 * Lageroversigtens ✎-dialog, optællingens ⋯-menu og "Opret produkt" skrev
 * direkte til Grocy. Der blev ikke skrevet en linje i Bon. Ændrede nogen en
 * vares placering, varegruppe eller aktiv-status, kunne man bagefter ikke se
 * hvem eller hvornår. Grocy har sin egen log, men det er ikke dér nogen
 * kigger, og den kender kun API-nøglen, ikke hvem der sad ved skærmen.
 *
 * Eksemplet der gør det konkret: «kål» blev sat inaktiv med optællingens
 * "Varen findes ikke mere". Dagen efter fik 13 bons `partial`, og det tog
 * tid at finde ud af at det var en stamdata-ændring, fordi intet i Bon sagde
 * det (#645).
 *
 * Det er forudsætningen for #667 (ret enheder fra Bon), hvor det bliver muligt
 * at skifte en vares lager-enhed. Det ændrer betydningen af al eksisterende
 * beholdning, og en sådan ændring skal kunne ses bagefter.
 *
 * TRE REGLER:
 *
 *   1. Brugeren kommer fra SESSIONEN, aldrig fra request-body (jf. Patch D og
 *      #316). Sporet er det eneste der peger på et menneske, så en afsender
 *      må ikke kunne skrive en anden ind.
 *
 *   2. Observationer logges IKKE, kun beslutninger. `LastCheckedAt` skrives ved
 *      hver optælling og hvert Gem (#613). Logges den, drukner sporet i støj og
 *      bliver ulæseligt — og så er vi tilbage ved Grocys egen log, som ingen
 *      læser.
 *
 *   3. Et spor der fejler må ikke vælte den ændring det skulle spore, men det
 *      må heller ikke fejle i stilhed. Det ville være præcis den fejlklasse
 *      #666 findes for (#305, #319). Kalderen får fejlen tilbage og sender den
 *      med i svaret.
 *
 * Ændringer lavet uden om Bon — i Grocys eget UI — ser vi ikke, og sporet
 * påstår ikke at det kan. Maskinernes egne skrivninger (CO₂-motoren,
 * varemodtagelsens stempling) går uden om ruterne og logges heller ikke. De
 * er ikke beslutninger et menneske har truffet.
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const { logChange } = require('../db/helpers');

/** Den entitet sporet hænger på. Grocy-produktets id, ikke et Bon-id. */
const ENTITY = 'grocy_product';

/**
 * Observationer, ikke beslutninger. De skrives af maskiner eller ved hvert
 * tjek, og ville drukne det et menneske faktisk har besluttet.
 */
const OBSERVATIONER = new Set([
    'LastCheckedAt', 'LastCheckedUnit',     // hvert tjek (#613)
    'price_updated_at', 'supplier_price_per_kg',
]);
const OBSERVATION_PRÆFIKS = ['hk_'];         // Hørkram-scraperen

/**
 * Hvilken skærm ændringen kom fra. Det er kun en etiket: den autoriserer
 * intet og påvirker ikke hvem der står i sporet. Men den er forskellen på
 * "nogen satte kål inaktiv" og "nogen satte kål inaktiv fra optællingen",
 * og den sidste kan man handle på. Ukendte værdier kasseres.
 */
const KILDER = new Map([
    // Nøglerne er ASCII: de rejser i en HTTP-header, og et æ/ø dér overlever
    // kun hvis browser og server er enige om tegnsættet.
    ['lageroversigt',   'lageroversigten'],
    ['optaelling',      'optællingen'],
    ['opret-produkt',   'Opret produkt'],
    ['indkob',          'indkøbsindstillinger'],
    ['varemodtagelse',  'varemodtagelsen'],
    ['opskrifter',      'Opskrifter & priser'],
    ['opskrift-editor', 'opskrift-editoren'],
    ['co2',             'CO₂-vejeværktøjet'],
]);

/** Felter hvis værdi er et id. Det gemte skal være NAVNET, ellers kan ingen læse sporet. */
const OPSLAG = {
    location_id: 'locations',
    default_consume_location_id: 'locations',
    shopping_location_id: 'shopping_locations',
    product_group_id: 'product_groups',
    qu_id_stock: 'quantity_units',
    qu_id_purchase: 'quantity_units',
    qu_id_consume: 'quantity_units',
    qu_id_price: 'quantity_units',
};

function skalLogges(felt) {
    if (!felt) return false;
    if (OBSERVATIONER.has(felt)) return false;
    return !OBSERVATION_PRÆFIKS.some(p => String(felt).startsWith(p));
}

/**
 * Sammenlignelig form. Grocy svarer med tal som strenge ('1'), en tom
 * streng og null betyder begge "intet", og booleans kommer som 1/0.
 * Uden normalisering ville hvert Gem logge "Aktiv: 1 → 1".
 */
function norm(v) {
    if (v === undefined || v === null || v === '') return null;
    if (v === true) return '1';
    if (v === false) return '0';
    return String(v).trim();
}

/**
 * Hvilke af de sendte felter ændrer FAKTISK noget?
 *
 * Kun felter i `ændringer` betragtes — det er dem der blev sendt. Et felt
 * der ikke blev sendt, er ikke ændret, uanset hvad `før` siger.
 *
 * @param {object|null} før        varens værdier før skrivningen (null = ukendt)
 * @param {object}      ændringer  det der blev sendt til Grocy
 * @returns {Array<{felt, fra, til, fraUkendt}>}
 */
function forskelle(før, ændringer) {
    const ud = [];
    const kendt = før && typeof før === 'object';
    for (const felt of Object.keys(ændringer || {})) {
        if (!skalLogges(felt)) continue;
        const til = norm(ændringer[felt]);
        if (kendt) {
            const fra = norm(før[felt]);
            if (fra === til) continue;
            ud.push({ felt, fra, til, fraUkendt: false });
        } else {
            // Før-værdien kunne ikke hentes. Vi logger stadig — at ændringen
            // skete er vigtigere end hvad den erstattede — men siger det.
            ud.push({ felt, fra: null, til, fraUkendt: true });
        }
    }
    return ud;
}

/** id → navn via opslagstabellerne. Findes navnet ikke, bruges id'et — aldrig et gæt. */
function læsbar(felt, værdi, navne) {
    if (værdi === null) return null;
    const tabel = OPSLAG[felt];
    if (!tabel || !navne || !navne[tabel]) return værdi;
    const n = navne[tabel].get(String(værdi));
    return n ? n : `#${værdi}`;
}

function kildeFra(req) {
    const k = req && typeof req.get === 'function' ? req.get('X-Bon-Kilde') : null;
    return k && KILDER.has(k) ? KILDER.get(k) : null;
}

/**
 * Byg navne-opslagene. De er cachede i adapteren, så det koster ikke et kald
 * pr. ændring. Fejler et opslag, logger vi id'et i stedet for at springe
 * sporet over — et id kan man slå op, en manglende linje kan man ikke.
 */
async function hentNavne(grocy) {
    const navne = {};
    const kilder = {
        locations: grocy.getLocations,
        shopping_locations: grocy.getShoppingLocations,
        product_groups: grocy.getProductGroups,
        quantity_units: grocy.getQuantityUnits,
    };
    await Promise.all(Object.keys(kilder).map(async (k) => {
        try {
            const rækker = await kilder[k]();
            navne[k] = new Map((rækker || []).map(r => [String(r.id), r.name]));
        } catch (err) {
            navne[k] = null;
        }
    }));
    return navne;
}

/**
 * Skriv én linje pr. ændret felt.
 *
 * @returns {{logget:number}}  hvor mange linjer der blev skrevet
 * @throws  hvis skrivningen til changelog fejler — kalderen fanger og siger det
 */
function skriv({ productId, ændret, userId, kilde, navne, handling = 'update', notat = null }) {
    let logget = 0;
    for (const f of ændret) {
        logChange({
            entityType: ENTITY,
            entityId: Number(productId),
            action: handling,
            fieldName: f.felt,
            oldValue: læsbar(f.felt, f.fra, navne),
            newValue: læsbar(f.felt, f.til, navne),
            userId: userId ?? null,
            notes: [
                notat,
                kilde ? `fra ${kilde}` : null,
                f.fraUkendt ? 'før-værdien kunne ikke hentes' : null,
            ].filter(Boolean).join(' · ') || null,
        });
        logget++;
    }
    return { logget };
}

module.exports = {
    ENTITY, OBSERVATIONER, KILDER, OPSLAG,
    skalLogges, norm, forskelle, læsbar, kildeFra, hentNavne, skriv,
};
