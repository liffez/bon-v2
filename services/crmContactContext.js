// services/crmContactContext.js
// ============================================================
// Kontakt-kontekst til ringelisterne: "har vi talt med dem før, hvordan gik
// det, og hvor langt er der derud?" — svaret på det man spørger sig selv om
// før man trykker Ring.
//
// ÉN kilde for service-kald (routes/crm.js /service-calls) og alle fire
// ringelister (/season, /rytme, /cold-offers, /api/rfm/reactivation). Skrevet
// pr. liste ville de fem drive fra hinanden — samme lære som _buildMailVars.
//
// Kollegaer tæller med: på et firma med flere kontaktpersoner er det ofte en
// ANDEN der sidst var glad eller sur. Et personligt firma (is_personal) har
// ingen kolleger. Kundens EGEN stemning vinder altid; kollegaens leveres kun
// separat og med navn, så frontenden aldrig kan give indtryk af at det var
// kunden selv.
// ============================================================

'use strict';

const co2Transport = require('./co2Transport');

function colleagueIds(db, customerId) {
    const row = db.prepare(`
        SELECT c.company_id, COALESCE(co.is_personal, 0) AS is_personal
        FROM customers c LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.id = ?
    `).get(customerId);
    if (!row || !row.company_id || row.is_personal) return [];
    return db.prepare('SELECT id FROM customers WHERE company_id = ? AND id != ?')
        .all(row.company_id, customerId).map(r => r.id);
}

// En aktivitet kan hænge på kunden direkte ELLER kun på en bon (customer_id NULL,
// jf. CHECK-constraintet). Begge veje skal med, ellers forsvinder den.
const ACT_OWNER_SQL = `(a.customer_id IN (%IDS%)
    OR (a.customer_id IS NULL AND a.bon_id IN (SELECT id FROM bons WHERE customer_id IN (%IDS%))))`;

function actOwnerSql(ids) {
    const ph = ids.map(() => '?').join(',');
    return { sql: ACT_OWNER_SQL.replace(/%IDS%/g, ph), args: [...ids, ...ids] };
}

// Kun det der ER sket — en planlagt opfølgning er ikke en samtale.
const DONE_SQL = '(a.done_at IS NOT NULL OR a.due_at IS NULL)';
const WHEN_SQL = 'COALESCE(a.done_at, a.created_at)';

function contactContext(db, customerId) {
    const out = {
        last_sentiment: null, last_sentiment_at: null,
        activity_count: 0, last_contact_at: null, last_contact_type: null,
        colleague_activity_count: 0,
        colleague_sentiment: null, colleague_sentiment_at: null, colleague_sentiment_by: null,
    };
    if (!customerId) return out;
    const own = actOwnerSql([customerId]);
    const agg = db.prepare(`
        SELECT COUNT(*) AS n, MAX(${WHEN_SQL}) AS last_at
        FROM crm_activities a WHERE ${own.sql} AND ${DONE_SQL}
    `).get(...own.args);
    out.activity_count = agg.n || 0;
    out.last_contact_at = agg.last_at || null;
    if (out.last_contact_at) {
        const t = db.prepare(`
            SELECT a.type FROM crm_activities a WHERE ${own.sql} AND ${DONE_SQL}
            ORDER BY ${WHEN_SQL} DESC, a.id DESC LIMIT 1
        `).get(...own.args);
        out.last_contact_type = t ? t.type : null;
        const s = db.prepare(`
            SELECT a.sentiment, ${WHEN_SQL} AS at FROM crm_activities a
            WHERE ${own.sql} AND a.sentiment IS NOT NULL
            ORDER BY ${WHEN_SQL} DESC, a.id DESC LIMIT 1
        `).get(...own.args);
        if (s) { out.last_sentiment = s.sentiment; out.last_sentiment_at = s.at; }
    }
    const col = colleagueIds(db, customerId);
    if (col.length) {
        const c = actOwnerSql(col);
        out.colleague_activity_count = db.prepare(`
            SELECT COUNT(*) AS n FROM crm_activities a WHERE ${c.sql} AND ${DONE_SQL}
        `).get(...c.args).n || 0;
        const s = db.prepare(`
            SELECT a.sentiment, ${WHEN_SQL} AS at,
                   TRIM(cu.first_name || ' ' || COALESCE(cu.last_name, '')) AS who
            FROM crm_activities a
            LEFT JOIN bons b ON b.id = a.bon_id
            LEFT JOIN customers cu ON cu.id = COALESCE(a.customer_id, b.customer_id)
            WHERE ${c.sql} AND a.sentiment IS NOT NULL
            ORDER BY ${WHEN_SQL} DESC, a.id DESC LIMIT 1
        `).get(...c.args);
        if (s) {
            out.colleague_sentiment = s.sentiment;
            out.colleague_sentiment_at = s.at;
            out.colleague_sentiment_by = s.who || null;
        }
    }
    return out;
}

const isPickup = (r) => r && (r.delivery_type === 'pickup' || r.delivery_method === 'pickup');

// Kundens seneste leveringsadresse — dér de plejer at få maden hen.
function latestAddressId(db, customerId) {
    if (!customerId) return null;
    const r = db.prepare(`
        SELECT delivery_address_id FROM bons
        WHERE customer_id = ? AND delivery_address_id IS NOT NULL
          AND COALESCE(delivery_type, '') != 'pickup' AND COALESCE(delivery_method, '') != 'pickup'
        ORDER BY delivery_date DESC, id DESC LIMIT 1
    `).get(customerId);
    return r ? r.delivery_address_id : null;
}

// Afstand HQ → adresse. Kun det vi VED i forvejen: routing-cachen (vejafstand
// fra ORS) og ellers luftlinje × vejfaktor fra adressens koordinater — samme to
// kilder og samme faktor som transport-CO₂ (services/bonTransportCo2.js).
// Vi ringer ALDRIG til ORS her: en liste med 50 rækker må ikke blive til 50
// eksterne kald. Et skøn markeres (distance_estimated), så "ca." kan stå foran.
function distancesForAddresses(db, addrIds) {
    const out = new Map();
    const ids = [...new Set(addrIds.filter(x => x != null))];
    if (!ids.length) return out;
    const ph = ids.map(() => '?').join(',');
    const road = new Map();
    for (const g of db.prepare(`
        SELECT address_id, distance_meters FROM geo_calculations
        WHERE distance_meters IS NOT NULL AND address_id IN (${ph})
        ORDER BY calculated_at DESC, id DESC
    `).all(...ids)) {
        if (!road.has(g.address_id)) road.set(g.address_id, g.distance_meters);
    }
    const addr = new Map();
    for (const a of db.prepare(`SELECT id, lat, lon, postal_code, city FROM addresses WHERE id IN (${ph})`).all(...ids)) {
        addr.set(a.id, a);
    }
    const hq = {};
    for (const r of db.prepare(
        "SELECT key, value FROM settings WHERE key IN ('delivery_hq_lat','delivery_hq_lon')"
    ).all()) hq[r.key] = Number(r.value);
    const hqOk = Number.isFinite(hq.delivery_hq_lat) && Number.isFinite(hq.delivery_hq_lon);

    for (const id of ids) {
        const a = addr.get(id);
        const place = { delivery_postal_code: a ? a.postal_code : null, delivery_city: a ? a.city : null };
        if (road.has(id)) {
            out.set(id, { ...place, distance_km: Math.round(road.get(id) / 100) / 10, distance_estimated: false });
            continue;
        }
        const lat = a ? Number(a.lat) : NaN, lon = a ? Number(a.lon) : NaN;
        if (hqOk && a && a.lat != null && a.lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
            const km = co2Transport.haversineKm(hq.delivery_hq_lat, hq.delivery_hq_lon, lat, lon)
                * co2Transport.ROAD_FACTOR;
            out.set(id, { ...place, distance_km: Math.round(km * 10) / 10, distance_estimated: true });
        } else {
            out.set(id, { ...place, distance_km: null, distance_estimated: false });
        }
    }
    return out;
}

/**
 * Hænger kontakt-kontekst på hver række (muterer).
 *   customerKey    — feltet der bærer kunde-id'et (default 'customer_id')
 *   useRowAddress  — brug rækkens egen delivery_address_id (en bestemt levering /
 *                    et tilbud). Mangler den, bruges kundens seneste
 *                    leveringsadresse. Er rækken en afhentning, er der ingen afstand.
 *   fallbackAddressKey — sidste udvej når kunden ingen leveringer har (fx et
 *                    kampagne-medlem der er et firma uden kontaktperson): firmaets
 *                    egen adresse.
 */
function enrichContactContext(db, rows, { customerKey = 'customer_id', useRowAddress = false, fallbackAddressKey = null } = {}) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const addrFor = rows.map(r => {
        if (useRowAddress && isPickup(r)) return null;
        if (useRowAddress && r.delivery_address_id != null) return r.delivery_address_id;
        const latest = latestAddressId(db, r[customerKey]);
        if (latest != null) return latest;
        return fallbackAddressKey ? (r[fallbackAddressKey] ?? null) : null;
    });
    const dist = distancesForAddresses(db, addrFor);
    rows.forEach((r, i) => {
        const ctx = contactContext(db, r[customerKey]);
        // Rækkens egne stemnings-felter (fx /service-calls' subquery) må ikke
        // overskrives med null — kun udfyldes hvis de mangler.
        if (r.last_sentiment != null) { delete ctx.last_sentiment; delete ctx.last_sentiment_at; }
        Object.assign(r, ctx);
        const d = addrFor[i] != null ? dist.get(addrFor[i]) : null;
        Object.assign(r, {
            distance_km: d ? d.distance_km : null,
            distance_estimated: d ? d.distance_estimated : false,
            distance_is_pickup: useRowAddress && isPickup(r),
        });
        if (d && r.delivery_postal_code == null) {
            r.delivery_postal_code = d.delivery_postal_code;
            r.delivery_city = d.delivery_city;
        }
    });
    return rows;
}

// Felterne enrichContactContext lægger på en række — til endpoints der bygger
// deres eget svar-objekt i stedet for at sende rækken videre.
const CONTEXT_FIELDS = [
    'last_sentiment', 'last_sentiment_at',
    'activity_count', 'last_contact_at', 'last_contact_type',
    'colleague_activity_count', 'colleague_sentiment', 'colleague_sentiment_at', 'colleague_sentiment_by',
    'distance_km', 'distance_estimated', 'distance_is_pickup', 'delivery_postal_code', 'delivery_city',
];

module.exports = { CONTEXT_FIELDS, enrichContactContext, contactContext, colleagueIds, actOwnerSql, distancesForAddresses };
