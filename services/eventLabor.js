/**
 * services/eventLabor.js
 * ════════════════════════════════════════════════════════════
 * Løn på et event — "den billige model" (docs/CLAUDE_EVENT.md §18.3–§18.5).
 *
 * Timerne registreres ikke, de KONTERES. Smartplan bærer dem allerede,
 * wage_rates prissætter dem, og lokations-splittet (migration 122) skiller HQ
 * fra Festival & Events. To kilder:
 *
 *   1. Smartplan  — betalte vagter på event-lokationen i eventets datospænd.
 *                   Målt fremmøde. Udledes, gemmes ikke.
 *   2. Standard   — transport, op- og nedtagning, trailer. Står ikke i
 *                   vagtplanen (det er som regel Leif og Anne), så de kommer
 *                   fra settings × antal personer.
 *
 * Alt beregnes live ved visning, som top-up-forslaget og event-menuen — så et
 * event ingen har rørt alligevel har et tal. Manuelle rækker (frivillige, folk
 * uden for Smartplan) og frys ved 'done' er næste skridt; se §18.6.
 *
 * TIMER OG KRONER ER TO TAL. En frivillig koster 0 kr men fylder på pladsen.
 * Kalderen får begge og må ikke smelte dem sammen.
 *
 * ALT ER EX MOMS (løn har ingen moms). Overhead lægges på begge kilder med
 * samme faktor som driftsregnskabet, så de to tal kan sammenlignes.
 *
 * AFGRÆNSNING: HQ-prep bliver i driftsregnskabet (§18.7). Det her er lønnen
 * PÅ PLADSEN — derfor hedder resultatet "Resultat på pladsen", ikke "Resultat".
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');
const labor     = require('./laborAdapter');

function r2(n) { return Math.round(((n || 0) + Number.EPSILON) * 100) / 100; }

function _setting(db, key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row && row.value != null ? String(row.value).trim() : '';
}
function _num(db, key, fallback) {
    const raw = _setting(db, key);
    if (raw === '') return fallback;
    const n = parseFloat(raw.replace(',', '.'));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Timesatsen for de standard-timer der ikke står i Smartplan.
 * Tom setting → gennemsnittet af de registrerede timelønninger. Det er et
 * ledelsestal, ikke en lønseddel: bedre et beløb i den rigtige størrelsesorden
 * end at lade op- og nedtagning stå til 0 kr og se gratis ud.
 */
function _standardRate(db, dato) {
    const explicit = _setting(db, 'event_labor_owner_rate');
    if (explicit !== '') {
        const n = parseFloat(explicit.replace(',', '.'));
        if (Number.isFinite(n) && n >= 0) return { rate: n, source: 'setting' };
    }
    const avg = labor.getStandardHourlyRate(dato);
    if (avg.rate != null) return { rate: r2(avg.rate), source: 'snit', count: avg.count };
    return { rate: null, source: 'ukendt' };
}

/**
 * Køretid HQ ↔ eventets adresse, ÉN vej, i timer.
 * Udledes via ruteberegning (samme ORS-kald og samme adresse-cache som
 * leveringsmodulet). Kan den ikke udledes, bruges nødplans-settingen — og
 * findes den heller ikke, returneres null, så kalderen kan SIGE at transporten
 * ikke er talt med frem for at lade den stå som 0 timer.
 */
async function _transportHoursOneWay(db, event) {
    const fallback = _setting(db, 'event_labor_transport_hours');
    const fallbackH = fallback === '' ? null : parseFloat(fallback.replace(',', '.'));

    if (!event.event_address_id) {
        return { hours: Number.isFinite(fallbackH) ? fallbackH : null, source: fallback === '' ? 'ukendt' : 'setting' };
    }
    try {
        const addr = db.prepare('SELECT lat, lon FROM addresses WHERE id = ?').get(event.event_address_id);
        const hqLat = parseFloat(_setting(db, 'delivery_hq_lat'));
        const hqLon = parseFloat(_setting(db, 'delivery_hq_lon'));
        if (!addr || !Number.isFinite(addr.lat) || !Number.isFinite(addr.lon)
            || !Number.isFinite(hqLat) || !Number.isFinite(hqLon)) {
            throw new Error('mangler koordinater');
        }
        const routing = require('./routing');
        const res = await routing.getDistance(
            { lat: hqLat, lon: hqLon }, { lat: addr.lat, lon: addr.lon },
            { addressId: event.event_address_id }
        );
        return { hours: r2(res.duration_s / 3600), source: 'beregnet', distance_m: res.distance_m };
    } catch (err) {
        return {
            hours: Number.isFinite(fallbackH) ? fallbackH : null,
            source: fallback === '' ? 'ukendt' : 'setting',
            error: err.message,
        };
    }
}

/**
 * Beregn eventets løn.
 * @param {object} event  række fra events (id, start_date, end_date, event_address_id)
 * @returns {Promise<object>} { hours_total, cost_total, sources[], warnings[], ... }
 */
async function computeEventLabor(event) {
    const db = getDb();
    const warnings = [];
    const sources = [];

    const fra = event.start_date;
    const til = event.end_date || event.start_date;

    // Overhead: samme faktor som driftsregnskabet, ellers kan de to tal ikke
    // sammenlignes. Satserne i wage_rates er bruttoløn; den reelle
    // arbejdsgiveromkostning er højere (feriepenge, ATP, evt. pension).
    const overheadPct = _num(db, 'labor_overhead_pct', 0);
    const overhead = 1 + overheadPct / 100;

    /* ── 1) Smartplan: betalte vagter på event-lokationen ────── */
    let smartplanRows = [];
    let smartplanError = null;
    try {
        const map = await labor.getLaborMap(fra, til, 'realiseret');
        for (const dato of Object.keys(map)) {
            for (const row of map[dato]) {
                // location_class kommer fra Smartplans egen lokation (migr. 122).
                // Bud afregnes separat og hører ikke til i eventets lønandel —
                // samme afgrænsning som driftsregnskabet (§6a).
                if (row.location_class !== 'events') continue;
                if (row.role_class === 'delivery') continue;
                smartplanRows.push({ ...row, date: dato });
            }
        }
    } catch (err) {
        smartplanError = err.message;
        warnings.push(`Vagtplanen kunne ikke hentes (${err.message}) — timerne på pladsen er ikke talt med.`);
    }

    const spHours = r2(smartplanRows.reduce((s, r) => s + (r.timer || 0), 0));
    const spCost  = r2(smartplanRows.reduce((s, r) => s + (r.kostpris || 0), 0) * overhead);
    const rateMissing = smartplanRows.filter(r => r.rate_missing);
    const fallbackHours = smartplanRows.filter(r => r.used_fallback_hours);

    if (rateMissing.length) {
        const navne = [...new Set(rateMissing.map(r => r.employee_name || '?'))];
        warnings.push(
            `${rateMissing.length} vagt(er) mangler en timeløn (${navne.join(', ')}) — timerne tæller med, kronerne gør ikke. Udfyld satser i Settings → Løn & jobtyper.`
        );
    }
    if (fallbackHours.length) {
        warnings.push(`${fallbackHours.length} vagt(er) har endnu ikke registreret fremmøde — planlagte timer bruges indtil videre.`);
    }

    sources.push({
        kind: 'onsite',
        label: 'På pladsen (vagtplan)',
        hours: spHours,
        cost: spCost,
        rows: smartplanRows.length,
        estimated: false,
        // De enkelte vagter med, så tallet kan efterprøves: HVEM stod der, og
        // hvornår. Et samlet timetal kan man ikke se en fejl i — er der en vagt
        // for meget eller for lidt, opdages det kun ved at kigge på listen.
        // Sorteret som en vagtplan læses: dag, så mødetid, så navn.
        shifts: smartplanRows
            .map(r => ({
                date: r.date,
                employee_name: r.employee_name,
                jobtype_title: r.jobtype_title,
                role_class: r.role_class,
                start: r.start, slut: r.slut,
                hours: r2(r.timer || 0),
                cost: r.kostpris != null ? r2(r.kostpris * overhead) : null,
                rate_missing: !!r.rate_missing,
                role_unmapped: !!r.role_unmapped,
                // Fremmøde er endnu ikke registreret — timerne er de PLANLAGTE.
                planned_only: !!r.used_fallback_hours,
            }))
            .sort((a, b) => (a.date || '').localeCompare(b.date || '')
                || (a.start || '').localeCompare(b.start || '')
                || (a.employee_name || '').localeCompare(b.employee_name || '', 'da')),
    });

    /* ── 2) Standard-timer: det vagtplanen ikke dækker ───────── */
    const persons  = _num(db, 'event_labor_default_persons', 2);
    const rateInfo = _standardRate(db, fra);
    if (rateInfo.rate == null) {
        warnings.push('Ingen timeløn kendt — transport og op-/nedtagning står med timer men 0 kr. Sæt en sats i Settings.');
    }

    const std = (kind, label, hoursPerPerson, note) => {
        const hours = r2((hoursPerPerson || 0) * persons);
        if (hours <= 0) return;
        sources.push({
            kind, label, hours,
            cost: rateInfo.rate == null ? 0 : r2(hours * rateInfo.rate * overhead),
            persons,
            estimated: true,
            note,
        });
    };

    const setupH    = _num(db, 'event_labor_setup_hours', 0);
    const teardownH = _num(db, 'event_labor_teardown_hours', 0);
    const trailerH  = _num(db, 'event_labor_trailer_hours', 0);

    std('setup',    'Opsætning',        setupH,        `${setupH} t × ${persons} pers.`);
    std('teardown', 'Nedtagning',       teardownH,     `${teardownH} t × ${persons} pers.`);
    // Traileren hentes OG sættes på plads igen — derfor to gange.
    std('trailer',  'Trailer frem/tilbage', trailerH * 2, `2 × ${trailerH} t × ${persons} pers.`);

    const tp = await _transportHoursOneWay(db, event);
    if (tp.hours == null) {
        warnings.push('Køretiden kunne ikke udledes (eventet mangler en geokodet adresse) — transporten er IKKE talt med. Sæt en adresse på eventet, eller udfyld nødplanen i Settings.');
    } else {
        std('transport', 'Transport frem/tilbage', tp.hours * 2,
            tp.source === 'beregnet'
                ? `2 × ${tp.hours} t kørsel × ${persons} pers.${tp.distance_m ? ` · ${Math.round(tp.distance_m / 1000)} km hver vej` : ''}`
                : `2 × ${tp.hours} t (fast tal fra Settings) × ${persons} pers.`);
    }

    const hoursTotal = r2(sources.reduce((s, x) => s + x.hours, 0));
    const costTotal  = r2(sources.reduce((s, x) => s + x.cost, 0));

    return {
        hours_total: hoursTotal,
        cost_total: costTotal,
        sources,
        warnings,
        // Det her er et ESTIMAT, ikke en lønopgørelse. Frivillige og folk uden
        // for vagtplanen er ikke med, og HQ-prep hører til i driftsregnskabet.
        is_estimate: true,
        rate: rateInfo.rate,
        rate_source: rateInfo.source,
        persons,
        overhead_pct: overheadPct,
        smartplan_error: smartplanError,
        transport_source: tp.source,
        from: fra, to: til,
    };
}

module.exports = { computeEventLabor };
