/**
 * routes/drift.js
 * ════════════════════════════════════════════════════════════
 * Driftsregnskab — dagsbaseret resultatanalyse.
 * Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §1/§4/§6/§6a/§7/§8.
 *
 * GET  /api/drift/day?date=&mode=  Dagsresultat (live el. frosset snapshot)
 * GET  /api/drift/day/bons?date=&mode=  Per-bon nedbrydning, altid live
 *                                  (fallback for snapshots fra før bons-feltet)
 * GET  /api/drift/items?from=&to=&mode=  Produktions-sammentælling pr. kategori
 *                                  (dag = from/to samme dato), altid live
 * POST /api/drift/refreeze {date}  Admin: genberegn frosset dag fra live data
 *
 * MOMS (§3): ALT ex moms. line_total er INCL → Moms.inclToExcl; cost_price +
 *   delivery_cost er allerede ex moms; løn ingen moms.
 * ROLLER (§6a): bud (delivery) ekskluderet fra driftens løn-/rate-tal.
 * FRYS (§7): afsluttede dage (dato < i dag, realiseret) snapshottes ved første
 *   visning → immune over for senere Smartplan-ændringer. Kun admin kan
 *   genberegne (overskrive snapshot fra aktuelle tal).
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();

const { getDb }       = require('../db/database');
const { handle, logChange, getDefaultLocationId, todayISO, bonUnitsExpr, revenueFactorSQL, bonOwnsStockCostSql, driftLocationSql } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { inclToExcl }  = require('../shared/moms');
const labor           = require('../services/laborAdapter');

const ALL   = requireAuth('admin', 'office');

// Lokations-snit (§18.7). Default 'all' — uændret adfærd for enhver kalder der
// ikke beder om noget andet.
const LOCATIONS = ['all', 'hq', 'events'];
const parseLocation = (v) => (LOCATIONS.includes(v) ? v : 'all');
const ADMIN = requireAuth('admin');

const REALISERET_STATUS = ['LEVERET', 'FAKTURERET', 'BETALT', 'AFSLUTTET'];

function r2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

/* ── Per-bon nedbrydning (drill-down fra KPI-pills) ──────── */
// Samme filtre som computeDay's aggregater, så summen af rækkerne stemmer
// krone for krone med pills'ene. Subqueries (ikke JOIN bon_lines) så bons
// uden linjer stadig tæller med i levering/enheder — som i bonAgg.

function computeDayBons(db, date, mode, location) {
    const locSql = driftLocationSql(location, 'b');
    const statusClause = mode === 'realiseret'
        ? `AND sd.code IN (${REALISERET_STATUS.map(() => '?').join(',')})`
        : `AND sd.code <> 'AFLYST'`;
    const statusArgs = mode === 'realiseret' ? REALISERET_STATUS : [];
    const unitsExpr = bonUnitsExpr();

    const rows = db.prepare(`
        SELECT b.id, b.bon_number,
               sd.code AS status_code,
               c.first_name || ' ' || COALESCE(c.last_name, '') AS contact_name_full,
               co.name AS company_name,
               COALESCE(b.delivery_cost, 0) AS delivery_ex,
               COALESCE((SELECT SUM(${unitsExpr.contrib}) FROM bon_lines bl ${unitsExpr.join}
                          WHERE bl.bon_id = b.id AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)), 0) AS units,
               COALESCE((SELECT SUM(bl.line_total${revenueFactorSQL('b')}) FROM bon_lines bl WHERE bl.bon_id = b.id), 0) AS revenue_incl,
               CASE WHEN ${bonOwnsStockCostSql('b')} THEN
                    COALESCE((SELECT SUM(bl.quantity * bl.cost_price) FROM bon_lines bl WHERE bl.bon_id = b.id), 0)
               ELSE 0 END AS cost_ex
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
          LEFT JOIN customers c  ON c.id  = b.customer_id
          LEFT JOIN companies co ON co.id = b.company_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0
           AND ${locSql} ${statusClause}
         ORDER BY revenue_incl DESC, b.bon_number
    `).all(...unitsExpr.args, date, ...statusArgs);

    return rows.map(r => ({
        id: r.id,
        bon_number: r.bon_number,
        status_code: r.status_code,
        customer: (r.company_name || (r.contact_name_full || '').trim() || null),
        contact: (r.contact_name_full || '').trim() || null,
        revenue_ex_moms: r2(inclToExcl(r.revenue_incl)),
        cost_ex_moms: r2(r.cost_ex),
        delivery_ex_moms: r2(r.delivery_ex),
        units: Number(r.units) || 0,
    }));
}

/* ── Produktions-sammentælling (hvad blev der lavet) ─────── */
// "Hvor mange sandwich, salater og slidere lavede vi den dag?" — pr. kategori,
// med varerne bag hver kategori. Samme filtre som computeDay, så tallene
// tilhører de samme bonner som resten af regnskabet.
//
// To tal pr. række, fordi de svarer på hver sit spørgsmål:
//   quantity = antal linjer-stk        → "hvor mange lavede vi"
//   units    = boks-aware enheds-bidrag → "hvad tæller det som" (samme udtryk
//              som Enheder-KPI'en, så en boks med 3 slidere tæller 3)
// De to er ens for almindelige varer og afviger kun hvor en vare tæller som
// flere enheder, eller hvor kategorien ikke tæller med i enheder (emballage,
// levering) — dem viser vi stadig, bare dæmpet. Ellers ville sammentællingen
// mangle noget køkkenet faktisk har pakket.
//
// Beregnes LIVE (ikke i snapshot): det er en optælling af bon-linjer, som
// ligger i basen i forvejen, og som ikke skrider når Smartplan ændrer sig.
function computeItems(db, from, to, mode, location) {
    const locSql = driftLocationSql(location, 'b');
    const statusClause = mode === 'realiseret'
        ? `AND sd.code IN (${REALISERET_STATUS.map(() => '?').join(',')})`
        : `AND sd.code <> 'AFLYST'`;
    const statusArgs = mode === 'realiseret' ? REALISERET_STATUS : [];
    const u = bonUnitsExpr();
    const notAccessory = `(bl.is_accessory = 0 OR bl.is_accessory IS NULL)`;

    // Slår ens varer sammen på tværs af bonner (og ignorerer special_request —
    // "Grisen uden tomat" er stadig en Gris når køkkenet tæller). Samme
    // sammenlægning som bon-kortets VARE-visning.
    const rows = db.prepare(`
        SELECT COALESCE(NULLIF(TRIM(bl.category), ''), '(uden kategori)') AS category,
               bl.product_name AS product,
               COALESCE(bl.unit, '')                        AS unit,
               SUM(bl.quantity)                             AS quantity,
               SUM(CASE WHEN ${notAccessory} THEN ${u.contrib} ELSE 0 END) AS units
          FROM bons b
          JOIN bon_lines bl ON bl.bon_id = b.id
          JOIN status_definitions sd ON sd.id = b.status_id
          ${u.join}
         WHERE b.delivery_date BETWEEN ? AND ?
           AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0
           AND ${locSql} ${statusClause}
         GROUP BY bl.category, bl.product_name, bl.unit
    `).all(...u.args, from, to, ...statusArgs);
    // GROUP BY på de RÅ kolonner, ikke på output-aliasset: `category` findes
    // både som alias og som kolonne, og SQLite kalder det tvetydigt. Det
    // betyder at NULL og '' bliver hver sin række — de samles i JS nedenfor,
    // hvor de begge lander under "(uden kategori)".

    const byCat = new Map();
    for (const r of rows) {
        if (!byCat.has(r.category)) byCat.set(r.category, { category: r.category, quantity: 0, units: 0, prod: new Map() });
        const c = byCat.get(r.category);
        const qty = Number(r.quantity) || 0;
        const un  = Number(r.units) || 0;
        c.quantity += qty;
        c.units    += un;
        const pkey = r.product + '|' + (r.unit || '');
        if (!c.prod.has(pkey)) c.prod.set(pkey, { name: r.product, unit: r.unit || null, quantity: 0, units: 0 });
        const p = c.prod.get(pkey);
        p.quantity += qty;
        p.units    += un;
    }

    const categories = [...byCat.values()].map(c => ({
        category: c.category,
        quantity: r2(c.quantity),
        units: r2(c.units),
        counts_as_unit: c.units > 0,
        products: [...c.prod.values()]
            .map(p => ({ ...p, quantity: r2(p.quantity), units: r2(p.units) }))
            .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, 'da')),
    })).sort((a, b) =>
        (b.counts_as_unit ? 1 : 0) - (a.counts_as_unit ? 1 : 0) ||   // tællende kategorier først
        b.units - a.units || b.quantity - a.quantity ||
        a.category.localeCompare(b.category, 'da'));

    return {
        categories,
        totals: {
            quantity: r2(categories.reduce((s, c) => s + c.quantity, 0)),
            units:    r2(categories.reduce((s, c) => s + c.units, 0)),
        },
    };
}

/* ── Kerne-beregning (genbruges af /day + /refreeze) ─────── */

// skipBons: periode-visningen smider per-bon data væk — spring beregningen over
// dér (op til 366 dage). /day + /refreeze beregner den altid (ryger i snapshot).
async function computeDay(db, date, mode, prefetchedLabor, skipBons, location = 'all') {
    const locSql = driftLocationSql(location, 'b');
    const statusClause = mode === 'realiseret'
        ? `AND sd.code IN (${REALISERET_STATUS.map(() => '?').join(',')})`
        : `AND sd.code <> 'AFLYST'`;
    const statusArgs = mode === 'realiseret' ? REALISERET_STATUS : [];

    const lineAgg = db.prepare(`
        SELECT COALESCE(SUM(bl.line_total${revenueFactorSQL('b')}), 0) AS revenue_incl,
               COALESCE(SUM(CASE WHEN ${bonOwnsStockCostSql('b')}
                                 THEN bl.quantity * bl.cost_price ELSE 0 END), 0) AS cost_ex,
               -- Det vi IKKE tæller. Et vareforbrug der bare bliver mindre uden
               -- forklaring er værre end et der er for højt: så leder man efter
               -- fejlen i bonnerne i stedet for at kunne se hvad reglen gjorde.
               COALESCE(SUM(CASE WHEN ${bonOwnsStockCostSql('b')}
                                 THEN 0 ELSE bl.quantity * bl.cost_price END), 0) AS cost_excluded_ex
          FROM bons b
          JOIN bon_lines bl ON bl.bon_id = b.id
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0
           AND ${locSql} ${statusClause}
    `).get(date, ...statusArgs);

    const bonAgg = db.prepare(`
        SELECT COALESCE(SUM(b.delivery_cost),0) AS delivery_ex,
               COUNT(*)                         AS bon_count
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0
           AND ${locSql} ${statusClause}
    `).get(date, ...statusArgs);

    // Enheder beregnes LIVE fra bon_lines (boks-aware) — aldrig fra det cachede
    // bons.total_units, så et forældet felt ikke kan smitte driftsregnskabet.
    const unitsExpr = bonUnitsExpr();
    const unitsAgg = db.prepare(`
        SELECT COALESCE(SUM(${unitsExpr.contrib}), 0) AS units
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
          JOIN bon_lines bl ON bl.bon_id = b.id
          ${unitsExpr.join}
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0
           AND ${locSql} ${statusClause}
           AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
    `).get(...unitsExpr.args, date, ...statusArgs);

    const revenue  = r2(inclToExcl(lineAgg.revenue_incl));
    const cost     = r2(lineAgg.cost_ex);
    // Event-salgsbonner bærer en cost_price-snapshot uden at have trukket lager
    // (prep-bonnen ejer trækket). Beløbet holdes ude af vareforbruget, men
    // rapporteres, så forskellen er synlig frem for tavs.
    const costExcluded = r2(lineAgg.cost_excluded_ex);
    const delivery = r2(bonAgg.delivery_ex);
    const units    = Number(unitsAgg.units) || 0;

    // prefetchedLabor: forud-hentet løn for denne dato (periode-batch). Et array
    // (også tomt) betyder "allerede hentet" → spring per-dag Smartplan-kaldet over.
    let laborRows = [], laborError = null;
    if (Array.isArray(prefetchedLabor)) {
        laborRows = prefetchedLabor;
    } else {
        try { laborRows = await labor.getLabor(date, mode); }
        catch (e) { laborError = e.message; }
    }

    // Løntillæg (§3): satserne i wage_rates er medarbejderens BRUTTOLØN. Den
    // reelle arbejdsgiveromkostning er højere (feriepenge, ATP, evt. pension).
    // labor_overhead_pct ganges på den rå brutto-løn. Default 0 = ingen ændring.
    const overheadPct = Math.max(0,
        parseFloat(db.prepare(`SELECT value FROM settings WHERE key='labor_overhead_pct'`).get()?.value ?? '0') || 0);
    const overheadFactor = 1 + overheadPct / 100;

    // Lønnen snittes på VAGTENS lokation (Smartplan), ikke på bonnens rolle.
    // Det er to forskellige kilder til samme spørgsmål — hvor foregik arbejdet —
    // og de skal begge respektere valget, ellers ville HQ-visningen vise
    // festival-lønnen sammen med HQ's omsætning.
    if (location === 'hq')     laborRows = laborRows.filter(l => l.location_class !== 'events');
    if (location === 'events') laborRows = laborRows.filter(l => l.location_class === 'events');

    // Ledige vagter (udlagt, endnu ikke taget) er ikke udført arbejde. De talte
    // med i persontimerne og trak dermed kapacitetsraten ned — som om nogen
    // stod der. Ugeoversigten har altid ekskluderet dem; her manglede det.
    const manned = laborRows.filter(l => !l.is_open);
    const prod   = manned.filter(l => l.role_class === 'production');
    const nonBud = manned.filter(l => l.role_class !== 'delivery');
    const laborDriftRaw   = r2(nonBud.reduce((s, l) => s + (l.kostpris || 0), 0));
    const laborProdRaw    = r2(prod.reduce((s, l) => s + (l.kostpris || 0), 0));
    const laborDrift      = r2(laborDriftRaw * overheadFactor);   // reel omkostning (vist)
    const laborProduction = r2(laborProdRaw * overheadFactor);
    const hoursProduction = prod.reduce((s, l) => s + (l.timer || 0), 0);
    const driftsresultat  = r2(revenue - cost - delivery - laborDrift);

    // Belastnings-tidslinje (§8)
    const tlBons = db.prepare(`
        SELECT b.total_units AS units, b.delivery_time AS dtime, b.pickup_time AS ptime
          FROM bons b JOIN status_definitions sd ON sd.id = b.status_id
         WHERE b.delivery_date = ? AND COALESCE(b.is_offer,0)=0 AND COALESCE(b.is_internal,0)=0
           AND ${locSql} ${statusClause}
    `).all(date, ...statusArgs);
    const hourOf = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? parseInt(m[1], 10) : null; };
    const minOf  = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const unitsByHour = {};
    for (const b of tlBons) {
        const h = hourOf(b.dtime) ?? hourOf(b.ptime);
        if (h == null) continue;
        unitsByHour[h] = (unitsByHour[h] || 0) + (Number(b.units) || 0);
    }
    const manhoursByHour = {};
    for (const l of prod) {
        const s = minOf(l.start), e = minOf(l.slut);
        if (s == null || e == null || e <= s) continue;
        for (let h = Math.floor(s / 60); h < Math.ceil(e / 60); h++) {
            const overlap = (Math.min(e, (h + 1) * 60) - Math.max(s, h * 60)) / 60;
            if (overlap > 0) manhoursByHour[h] = (manhoursByHour[h] || 0) + overlap;
        }
    }
    const allHours = [...Object.keys(unitsByHour), ...Object.keys(manhoursByHour)].map(Number);
    const hMin = allHours.length ? Math.min(...allHours) : 8;
    const hMax = allHours.length ? Math.max(...allHours) : 16;
    const timeline = [];
    for (let h = hMin; h <= hMax; h++) timeline.push({ hour: h, units: r2(unitsByHour[h] || 0), manhours: r2(manhoursByHour[h] || 0) });

    return {
        date, mode,
        bon_count: bonAgg.bon_count,
        revenue_ex_moms: revenue, cost_ex_moms: cost, delivery_ex_moms: delivery,
        cost_excluded_ex_moms: costExcluded,
        labor_ex_moms: laborDrift, labor_raw_ex_moms: laborDriftRaw, labor_overhead_pct: overheadPct,
        driftsresultat_ex_moms: driftsresultat,
        db_pct: revenue > 0 ? r2(driftsresultat / revenue * 100) : null,
        units,
        kapacitetsrate: hoursProduction > 0 ? r2(units / hoursProduction) : null,
        loenandel_pct: revenue > 0 ? r2(laborProduction / revenue * 100) : null,
        vareforbrug_pr_enhed: units > 0 ? r2(cost / units) : null,
        labor_production_ex_moms: laborProduction,
        hours_production: r2(hoursProduction),
        labor_rows: laborRows,
        timeline,
        rate_missing_count:  laborRows.filter(l => l.rate_missing).length,
        role_unmapped_count: laborRows.filter(l => l.role_unmapped).length,
        // Vises frem for at forsvinde: en ledig vagt er et hul i bemandingen,
        // og det er værd at se når man kigger på dagen.
        open_shift_count:    laborRows.filter(l => l.is_open).length,
        labor_error: laborError,
        // Hvilket snit tallene er regnet på (§18.7). Med i svaret så frontenden
        // kan mærke visningen — og så et gemt/delt svar ikke kan forveksles med
        // hele driften. 'hq' + 'events' summerer til 'all'; de tre må aldrig
        // lægges sammen på tværs.
        location,
        // Per-bon nedbrydning til drill-down — med i frosne snapshots fremover,
        // så drill-down på en frosset dag viser præcis de tal der blev frosset.
        ...(skipBons ? {} : { bons: computeDayBons(db, date, mode, location) }),
    };
}

/* ── Måltal til farvekodning (§6 pkt. 6+7) ────────────────── */
// Læses HVER gang og lægges på svaret UDEN OM data_json. Måltallet må ikke
// fryses ind i en dagsopgørelse: det er en målestok, ikke et regnskabstal, og
// et ændret måltal skal kunne bruges til at se på historiske dage. Tom værdi
// → null → frontenden farver ikke (ingen default — huset sætter selv sit mål).
function readTargets(db) {
    // `min` skiller de to slags tal ad: et MÅLTAL på 0 giver ingen mening (0 %
    // løn er ikke et mål) og betyder derfor "intet mål". En TOLERANCE på 0 er
    // derimod et gyldigt valg: "alt over målet er rødt, ingen gul zone". Uden
    // den skelnen ville tolerance 0 tavst blive lavet om til default 2.
    const num = (key, fallback, min) => {
        const raw = db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
        if (raw == null || String(raw).trim() === '') return fallback;
        const n = parseFloat(String(raw).replace(',', '.'));
        return Number.isFinite(n) && n >= min ? n : fallback;
    };
    return {
        labor_pct:     num('target_labor_pct', null, Number.MIN_VALUE),
        food_cost_pct: num('target_food_cost_pct', null, Number.MIN_VALUE),
        tolerance_pct: num('target_pct_tolerance', 2, 0),
    };
}

function saveSnapshot(db, date, mode, data, userId) {
    db.prepare(`
        INSERT INTO labor_day_snapshot (location_id, snapshot_date, mode, data_json, frozen_by_user_id)
        VALUES (?,?,?,?,?)
        ON CONFLICT(location_id, snapshot_date, mode)
        DO UPDATE SET data_json = excluded.data_json, frozen_at = datetime('now'), frozen_by_user_id = excluded.frozen_by_user_id
    `).run(getDefaultLocationId() || null, date, mode, JSON.stringify(data), userId || null);
}

/* ── GET /day/bons — per-bon nedbrydning, altid live ─────── */
// Fallback for frosne snapshots fra før `bons` kom med i computeDay-outputtet.
// Beregner live og kan derfor afvige fra et frosset aggregat — frontenden
// flager det. (Registreres FØR /day så Express ikke matcher den som /day.)

/* ── GET /items — produktions-sammentælling ──────────────── */
// Ét endpoint til både dag og periode: dagsvisningen kalder med from=to=dato.
// (Registreres FØR /day så Express ikke matcher den som noget andet.)

router.get('/items', ALL, handle(async (req, res) => {
    const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const from = iso(req.query.from) || iso(req.query.date);
    const to   = iso(req.query.to)   || from;
    if (!from || !to) return res.status(400).json({ error: 'from + to (eller date) i formatet YYYY-MM-DD kræves' });
    if (from > to)    return res.status(400).json({ error: 'from skal være ≤ to' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';
    const location = parseLocation(req.query.location);
    res.json({ from, to, mode, location, ...computeItems(getDb(), from, to, mode, location) });
}));

router.get('/day/bons', ALL, handle(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';
    const location = parseLocation(req.query.location);
    res.json({ date, mode, location, live: true, bons: computeDayBons(getDb(), date, mode, location) });
}));

/* ── GET /day ────────────────────────────────────────────── */

router.get('/day', ALL, handle(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';
    const location = parseLocation(req.query.location);
    const db = getDb();
    const isAdmin = req.session.userRole === 'admin';

    // Frys kun afsluttede dage i realiseret-mode (i dag/fremtid + forecast = altid live).
    const isPast = date < todayISO();
    if (isPast && mode === 'realiseret') {
        let snap = db.prepare('SELECT data_json, frozen_at FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, mode);
        if (!snap) {
            // Frys ALTID hele dagen, uanset hvilket snit der spørges. Snapshottet
            // bærer labor_rows med location_class, så snittene kan udledes af det
            // bagefter — ellers ville et snit-kald fryse en halv dag.
            const full = await computeDay(db, date, mode);

            // Vi fryser ALDRIG et tal vi ved er forkert. Kunne vagtplanen ikke
            // hentes (Smartplan nede, eller throttlet med 429), er lønnen 0 kr —
            // og et frosset 0 bliver stående for evigt uden at nogen kan se
            // hvorfor. Vis dagen live med fejlen på, og frys når kilden svarer
            // igen. Samme regel som eventets løn (CLAUDE_EVENT.md §18.6).
            if (full.labor_error) {
                // Snittet skal stadig respekteres — man bad om Event, ikke om
                // hele huset. Løn-rækkerne genbruges (de er tomme, men det er
                // netop pointen) så vi ikke rammer en throttlet Smartplan igen;
                // fejlen bæres eksplicit med, ellers ville snittet se rask ud.
                const live = location === 'all' ? full : {
                    ...(await computeDay(db, date, mode, full.labor_rows, false, location)),
                    labor_error: full.labor_error,
                };
                return res.json({ ...live, targets: readTargets(db), frozen: false, can_refreeze: false });
            }
            saveSnapshot(db, date, mode, full, req.session.userId);
            snap = db.prepare('SELECT data_json, frozen_at FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, mode);
        }
        const frozen = JSON.parse(snap.data_json);
        if (location === 'all') {
            return res.json({ ...frozen, targets: readTargets(db), frozen: true, frozen_at: snap.frozen_at, can_refreeze: isAdmin });
        }
        // Snit af en frosset dag: brug de FROSNE løn-rækker (det er dem der
        // skrider når Smartplan rettes), men regn bon-siden live — den ligger i
        // vores egen base og skrider ikke. Frontenden får bons_live, så et
        // afvigende tal kan forklares frem for at se ud som en fejl.
        const data = await computeDay(db, date, mode, frozen.labor_rows || [], false, location);
        return res.json({ ...data, targets: readTargets(db), frozen: true, frozen_at: snap.frozen_at,
                          can_refreeze: isAdmin, bons_live: true });
    }

    const data = await computeDay(db, date, mode, undefined, false, location);
    res.json({ ...data, targets: readTargets(db), frozen: false, can_refreeze: false });
}));

/* ── POST /refreeze — admin: genberegn frosset dag fra live ─ */

router.post('/refreeze', ADMIN, handle(async (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body && req.body.date) ? req.body.date : null;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) kræves' });
    const db = getDb();
    const data = await computeDay(db, date, 'realiseret');
    // Samme værn som /day: en genberegning må ikke kunne fryse "0 kr løn"
    // fordi Smartplan tilfældigvis var nede i det sekund der blev trykket.
    if (data.labor_error) {
        return res.status(503).json({ error: 'Vagtplanen kunne ikke hentes — dagen er ikke genberegnet.',
                                      code: 'labor_unavailable', detail: data.labor_error });
    }
    saveSnapshot(db, date, 'realiseret', data, req.session.userId);
    const snap = db.prepare('SELECT frozen_at FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, 'realiseret');
    logChange({ entityType: 'labor_day_snapshot', entityId: 0, action: 'refreeze',
        fieldName: date, newValue: String(data.driftsresultat_ex_moms), userId: req.session.userId });
    res.json({ ...data, targets: readTargets(db), frozen: true, frozen_at: snap.frozen_at, can_refreeze: true, refrozen: true });
}));

/* ── GET /period — trend over flere dage ─────────────────── */

// Læs én dag til periode-visning: frosset snapshot hvis det findes (afsluttet
// dag), ellers live beregning. Opretter IKKE snapshot (kun /day fryser).
// Ved et lokations-snit genbruges snapshottets FROSNE løn-rækker, mens bon-siden
// regnes live — samme regel som /day, så de to flader ikke kan svare forskelligt.
async function readDay(db, date, mode, prefetchedLabor, location = 'all') {
    if (date < todayISO() && mode === 'realiseret') {
        const snap = db.prepare('SELECT data_json FROM labor_day_snapshot WHERE snapshot_date=? AND mode=?').get(date, mode);
        if (snap) {
            const frozen = JSON.parse(snap.data_json);
            if (location === 'all') return { ...frozen, frozen: true };
            return { ...(await computeDay(db, date, mode, frozen.labor_rows || [], true, location)), frozen: true, bons_live: true };
        }
    }
    return { ...(await computeDay(db, date, mode, prefetchedLabor, true, location)), frozen: false };
}

router.get('/period', ALL, handle(async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
    const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)   ? req.query.to   : null;
    if (!from || !to) return res.status(400).json({ error: 'from + to (YYYY-MM-DD) kræves' });
    const mode = req.query.mode === 'forecast' ? 'forecast' : 'realiseret';
    const location = parseLocation(req.query.location);

    // Byg dagsliste. Hårdt loft = 1 år: AFVIS (fejl) frem for tavs afkortning,
    // så et urealistisk stort interval ikke ser ud som om hele perioden er med.
    const MAX_DAYS = 366;
    const dates = [];
    for (let d = new Date(from + 'T12:00:00'); ; d.setDate(d.getDate() + 1)) {
        const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(d);
        if (iso > to) break;
        if (dates.length >= MAX_DAYS) {
            return res.status(400).json({ error: `Vælg højst ${MAX_DAYS} dage (1 år) ad gangen.`, code: 'PERIOD_TOO_LONG', max_days: MAX_DAYS });
        }
        dates.push(iso);
    }

    const db = getDb();

    // Batch-hent løn for hele intervallet i ÉT Smartplan-kald (i stedet for ét
    // pr. dag). Frosne fortidsdage læses fra snapshot og rører ikke dette map.
    // Ét kald dækker HELE perioden. Fejler det, er lønnen 0 kr på hver eneste
    // dag i visningen — og det så indtil nu ud som om ingen havde arbejdet i en
    // hel uge. Fejlen bæres nu med ud, så ugen kan sige hvorfor.
    let laborMap = {}, laborError = null;
    try { laborMap = await labor.getLaborMap(from, to, mode); }
    catch (e) { laborMap = {}; laborError = e.message; }

    const days = [];
    for (const date of dates) {
        const d = await readDay(db, date, mode, laborMap[date] || [], location);
        days.push({
            date, frozen: d.frozen,
            revenue_ex_moms: d.revenue_ex_moms, cost_ex_moms: d.cost_ex_moms,
            delivery_ex_moms: d.delivery_ex_moms, labor_ex_moms: d.labor_ex_moms,
            labor_raw_ex_moms: d.labor_raw_ex_moms,
            driftsresultat_ex_moms: d.driftsresultat_ex_moms, db_pct: d.db_pct,
            units: d.units, bon_count: d.bon_count, kapacitetsrate: d.kapacitetsrate,
            // Frosne dage har deres løn fra snapshottet og er upåvirkede af at
            // kilden er nede lige nu — derfor pr. dag, ikke kun på toppen.
            labor_error: d.frozen ? (d.labor_error || null) : (laborError || d.labor_error || null),
        });
    }

    const sum = (k) => r2(days.reduce((s, x) => s + (x[k] || 0), 0));
    const revenue = sum('revenue_ex_moms');
    const driftsresultat = sum('driftsresultat_ex_moms');
    const totals = {
        from, to, mode, location, day_count: days.length,
        revenue_ex_moms: revenue, cost_ex_moms: sum('cost_ex_moms'),
        delivery_ex_moms: sum('delivery_ex_moms'), labor_ex_moms: sum('labor_ex_moms'),
        labor_raw_ex_moms: sum('labor_raw_ex_moms'),
        driftsresultat_ex_moms: driftsresultat,
        db_pct: revenue > 0 ? r2(driftsresultat / revenue * 100) : null,
        units: days.reduce((s, x) => s + (x.units || 0), 0),
        bon_count: days.reduce((s, x) => s + (x.bon_count || 0), 0),
    };
    res.json({
        days, totals, targets: readTargets(db),
        // Sandt hvis mindst én dag i visningen mangler sin løn.
        labor_error: days.some(d => d.labor_error) ? (laborError || days.find(d => d.labor_error).labor_error) : null,
        labor_missing_days: days.filter(d => d.labor_error).length,
    });
}));

module.exports = router;
