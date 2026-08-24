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
/* ── Hvilket event hører vagten til? ─────────────────────────
   Lønnen hentes på dato + lokation (§18.3). Kører to events samme weekend, ser
   de derfor BEGGE alle vagter på event-lokationen, og begge P&L'er tæller de
   samme kroner. Smartplan kan ikke svare på det — der er én event-lokation, og
   noten er fritekst til medarbejderen (målt: 366 af 417 vagter uden note).
   Derfor afgøres det her, hvor vi allerede har alle vagterne.

   Tre tilstande:
     ingen række      → alle overlappende events tæller vagten (uændret)
     event_id = N     → kun event N
     event_id = NULL  → intet event (fx en HQ-vagt der ligger forkert) */
function _assignmentMap(db) {
    const map = new Map();
    for (const r of db.prepare('SELECT shift_uuid, source, event_id FROM event_shift_assignments').all()) {
        map.set(r.shift_uuid + '|' + r.source, r.event_id);   // kan være null
    }
    return map;
}

/** Andre events der overlapper i datoer — dem der kan slås om de samme vagter. */
function _overlappingEvents(db, event, fra, til) {
    return db.prepare(`
        SELECT id, name, start_date, end_date
          FROM events
         WHERE id <> ?
           AND status <> 'cancelled'
           AND start_date <= ?
           AND COALESCE(end_date, start_date) >= ?
         ORDER BY start_date
    `).all(event.id, til, fra);
}

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
    const assignments = _assignmentMap(db);
    const overlapping  = _overlappingEvents(db, event, fra, til);

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

                // Tildeling: en vagt der er sat på ET event, hører kun til dér.
                // `null` betyder bevidst "intet event" og er ikke det samme som
                // "ikke taget stilling" — derfor has() og ikke sandhedsværdien.
                const key = (row.uuid || '') + '|' + (row.source || 'shift');
                const assigned = assignments.has(key) ? assignments.get(key) : undefined;
                const mine = assigned === undefined || assigned === event.id;
                smartplanRows.push({ ...row, date: dato, assigned_event_id: assigned ?? null,
                                     is_assigned: assigned !== undefined, counted: mine });
                if (!mine) continue;
                // (ledige vagter sorteres fra i tællingen nedenfor, men bliver i
                // listen — et hul i bemandingen er værd at se på et event)
            }
        }
    } catch (err) {
        smartplanError = err.message;
        warnings.push(`Vagtplanen kunne ikke hentes (${err.message}) — timerne på pladsen er ikke talt med.`);
    }

    // En ledig vagt er udlagt, men ikke taget af nogen. Ingen har arbejdet den,
    // så den er hverken mandetimer eller løn — og der er ingen person at sætte
    // en timeløn på, så den hører heller ikke i advarslen om manglende satser.
    const counted    = smartplanRows.filter(r => r.counted);
    const manned     = counted.filter(r => !r.is_open);
    const openShifts = counted.filter(r => r.is_open);

    const spHours = r2(manned.reduce((s, r) => s + (r.timer || 0), 0));
    const spCost  = r2(manned.reduce((s, r) => s + (r.kostpris || 0), 0) * overhead);
    const rateMissing = manned.filter(r => r.rate_missing);
    const fallbackHours = manned.filter(r => r.used_fallback_hours);

    if (rateMissing.length) {
        const navne = [...new Set(rateMissing.map(r => r.employee_name || '?'))];
        warnings.push(
            `${rateMissing.length} vagt(er) mangler en timeløn (${navne.join(', ')}) — timerne tæller med, kronerne gør ikke. Udfyld satser i Settings → Løn & jobtyper.`
        );
    }
    if (fallbackHours.length) {
        warnings.push(`${fallbackHours.length} vagt(er) har endnu ikke registreret fremmøde — planlagte timer bruges indtil videre.`);
    }
    // Kører et andet event samtidig, kan de samme vagter tælle to steder. Den
    // fejl er usynlig i tallet — begge P&L'er ser rigtige ud — så den skal siges.
    if (overlapping.length) {
        const uafklaret = smartplanRows.filter(r => !r.is_assigned);
        const navne = overlapping.map(e => e.name).join(', ');
        if (uafklaret.length) {
            const t = r2(uafklaret.filter(r => !r.is_open).reduce((s, r) => s + (r.timer || 0), 0));
            warnings.push(
                `${navne} kører samtidig. ${uafklaret.length} vagt(er) på ${t} timer er ikke fordelt `
                + 'og tæller derfor med på BEGGE events. Fordel dem nedenfor, så lønnen kun tælles ét sted.'
            );
        } else {
            warnings.push(`${navne} kører samtidig — alle vagter er fordelt.`);
        }
    }

    if (openShifts.length) {
        const t = r2(openShifts.reduce((s, r) => s + (r.timer || 0), 0));
        warnings.push(
            `${openShifts.length} ledig${openShifts.length === 1 ? ' vagt' : 'e vagter'} på ${t} timer er ikke taget af nogen — de tæller hverken som mandetimer eller løn.`
        );
    }

    sources.push({
        kind: 'onsite',
        label: 'På pladsen (vagtplan)',
        hours: spHours,
        cost: spCost,
        rows: manned.length,
        open_shifts: openShifts.length,
        estimated: false,
        // De enkelte vagter med, så tallet kan efterprøves: HVEM stod der, og
        // hvornår. Et samlet timetal kan man ikke se en fejl i — er der en vagt
        // for meget eller for lidt, opdages det kun ved at kigge på listen.
        // Sorteret som en vagtplan læses: dag, så mødetid, så navn.
        shifts: smartplanRows
            .map(r => ({
                // Identitet + fordelingsstatus, så vagten kan sættes på det
                // rigtige event når to kører samme weekend.
                uuid: r.uuid, source: r.source,
                counted: r.counted,
                is_assigned: r.is_assigned,
                assigned_event_id: r.assigned_event_id,
                date: r.date,
                employee_name: r.employee_name,
                jobtype_title: r.jobtype_title,
                role_class: r.role_class,
                is_open: !!r.is_open,
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

    // Rettelser for DETTE event. En række her erstatter sin egen standard-linje
    // — den lægges ikke ved siden af. Standarden er et udgangspunkt, ikke et
    // facit: kranen kan være i stykker, eller pladsen ligge fem minutter væk.
    const overrides = new Map();
    for (const o of db.prepare(
        `SELECT kind, label, persons, hours, rate, note FROM event_labor WHERE event_id = ?`
    ).all(event.id)) {
        overrides.set(o.kind, o);
    }

    const std = (kind, label, hoursPerPerson, note) => {
        const ov = overrides.get(kind);
        const pers  = ov ? Number(ov.persons) : persons;
        const perOne = ov ? Number(ov.hours) : (hoursPerPerson || 0);
        const hours = r2(perOne * pers);
        // En rettelse til 0 timer er et gyldigt svar ("vi hentede ikke traileren
        // denne gang"), så en RETTET linje vises også når den er nul — ellers
        // ser det ud som om rettelsen ikke blev gemt.
        if (hours <= 0 && !ov) return;

        const rate = ov && ov.rate != null ? Number(ov.rate) : rateInfo.rate;
        sources.push({
            kind,
            label: (ov && ov.label) || label,
            hours,
            cost: rate == null ? 0 : r2(hours * rate * overhead),
            persons: pers,
            estimated: true,
            overridden: !!ov,
            note: ov ? (ov.note || `${perOne} t × ${pers} pers. (rettet)`) : note,
            // Standarden med, så UI'et kan vise hvad der blev fraveget og
            // tilbyde at gå tilbage til den.
            default_hours: hoursPerPerson ?? null,
            default_persons: persons,
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
    if (tp.hours == null && overrides.has('transport')) {
        // Rettet i hånden — så er den manglende adresse ikke længere et problem.
        std('transport', 'Transport frem/tilbage', 0, null);
    } else if (tp.hours == null) {
        warnings.push('Køretiden kunne ikke udledes (eventet mangler en geokodet adresse) — transporten er IKKE talt med. Sæt en adresse på eventet, eller udfyld nødplanen i Settings.');
    } else {
        std('transport', 'Transport frem/tilbage', tp.hours * 2,
            tp.source === 'beregnet'
                ? `2 × ${tp.hours} t kørsel × ${persons} pers.${tp.distance_m ? ` · ${Math.round(tp.distance_m / 1000)} km hver vej` : ''}`
                : `2 × ${tp.hours} t (fast tal fra Settings) × ${persons} pers.`);
    }

    // Frie rækker: folk der slet ikke er i vagtplanen. Ikke en standard-linje,
    // så de lægges TIL frem for at erstatte noget.
    const manualRows = db.prepare(
        `SELECT id, kind, label, persons, hours, rate, note FROM event_labor
          WHERE event_id = ? AND kind IN ('onsite','other') ORDER BY id`
    ).all(event.id);
    for (const o of manualRows) {
        const hours = r2(Number(o.hours) * Number(o.persons));
        // rate NULL = brug eventets standardsats. 0 er en GYLDIG værdi og
        // betyder ulønnet — derfor `!= null` og ikke en sandhedstest.
        const rate = o.rate != null ? Number(o.rate) : rateInfo.rate;
        sources.push({
            id: o.id,
            kind: o.kind,
            label: o.label || 'Uden for vagtplanen',
            hours,
            cost: rate == null ? 0 : r2(hours * rate * overhead),
            persons: Number(o.persons),
            hours_per_person: r2(Number(o.hours)),
            rate: o.rate != null ? Number(o.rate) : null,
            // `manual`, ikke `estimated`: det er indtastede timer for rigtige
            // mennesker, ikke et skøn fra en standardtid. Panelet viser dem i
            // deres eget afsnit, så de to slags ikke blandes sammen.
            manual: true,
            rate_missing: rate == null,
            note: o.note || null,
        });
    }

    const hoursTotal = r2(sources.reduce((s, x) => s + x.hours, 0));
    const costTotal  = r2(sources.reduce((s, x) => s + x.cost, 0));

    return {
        hours_total: hoursTotal,
        cost_total: costTotal,
        sources,
        warnings,
        // Et estimat, ikke en lønopgørelse: standardtiderne er skøn, og HQ-prep
        // hører til i driftsregnskabet (§18.7). Frivillige og folk uden for
        // vagtplanen KAN nu være med — men kun hvis nogen har tastet dem, så
        // manual_rows siger om der faktisk er gjort noget ved det.
        is_estimate: true,
        manual_rows: manualRows.length,
        rate: rateInfo.rate,
        rate_source: rateInfo.source,
        persons,
        overhead_pct: overheadPct,
        smartplan_error: smartplanError,
        // Vagtlisten ligger på sources[kind='onsite'].shifts — ÉN liste, ikke to.
        // Andre events der kan slås om de samme vagter:
        overlapping_events: overlapping,
        transport_source: tp.source,
        from: fra, to: til,
    };
}

module.exports = { computeEventLabor };
