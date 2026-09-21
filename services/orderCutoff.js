// services/orderCutoff.js
// ==========================================
// Cut-off for offentlige bestillinger — reglen bor HER, ét sted.
//
// Indtil september 2026 blev deadline kun håndhævet i browseren
// (public/embed/bestilling.html). Knappens `disabled`-attribut var hele værnet,
// og den blev sat i det øjeblik kunden valgte datoen: vælger man leveringsdagen
// kl. 11.30 — fuldt lovligt — og trykker send kl. 20.54, blev der aldrig tjekket
// igen. Serveren spurgte ikke om noget. Et direkte POST gik lige igennem.
//
// Modulet bruges tre steder:
//   routes/embed.js      — fortæller browseren hvad reglen er
//   routes/web-orders.js — håndhæver den på den nuværende formular
//   routes/webhooks.js   — håndhæver den på den gamle f-felt-formular
// Standardværdierne stod før skrevet af i hver af dem. Nu står de kun her.
//
// ⚠️ MODULET FEJLER ÅBENT. Kan deadline ikke beregnes troværdigt — ulæselig
// indstilling, tom liste over tælle-dage, uforståelig leveringsdato — så
// ACCEPTERES bestillingen, og årsagen logges. En for sen ordre kan office nå at
// ringe om; en tabt ordre opdager ingen. Modulet siger derfor kun nej når det er
// sikkert på at deadline ER passeret.
// ==========================================

// Ugedagsnøgler i JS' egen rækkefølge (getUTCDay 0..6) — samme nøgler som
// settings og formularen bruger.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const TZ = 'Europe/Copenhagen';

// Standardværdier. Ændres de, ændres de her — `/embed/config` og begge
// webhooks henter dem fra denne konstant.
const CUTOFF_DEFAULTS = Object.freeze({
    time: 12,
    leadDays: 1,
    cutoffDays: Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
    deliveryDays: Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Leveringstidspunktets format. Begge offentlige bestillings-webhooks skal
// kende reglen, og de importerer i forvejen checkOrderTiming herfra — så den
// bor her, og modulet forbliver afhængighedsfrit (kan testes uden database).
const DELIVERY_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Er strengen en rigtig kalenderdag i YYYY-MM-DD?
 *
 * Et regex alene er IKKE nok: `2026-02-31` matcher, og JavaScript ruller den
 * stille over til 2. marts — så deadline ville blive beregnet for en dato der
 * ikke findes. Derfor et round-trip: byg datoen af delene og se om den stadig
 * bærer de samme tal.
 */
function isValidDeliveryDate(value) {
    const m = ISO_DATE.exec(String(value || '').trim());
    if (!m) return false;
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(d.getTime())) return false;
    return d.getUTCFullYear() === year
        && d.getUTCMonth() === month - 1
        && d.getUTCDate() === day;
}

/** Er strengen et klokkeslæt i HH:MM (00:00–23:59)? */
function isValidDeliveryTime(value) {
    return DELIVERY_TIME.test(String(value || '').trim());
}

// ─── Indstillinger ──────────────────────────────────────────────────────────

// Heltal i et interval, ellers standardværdien. Browseren havde her en fælde
// der er værd at kende: `parseInt('noget') != null` er SANDT, fordi NaN ikke er
// null — så NaN blev skrevet ind i konfigurationen, `while (NaN > 0)` kørte
// aldrig, og deadline blev selve leveringsdagen. Altså: cut-off slået helt fra,
// uden at nogen kunne se det. Derfor Number.isInteger her.
function intOr(raw, fallback, min, max, key, problems) {
    if (raw == null || String(raw).trim() === '') return fallback;
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n < min || n > max) {
        problems.push(`${key}="${raw}" kan ikke bruges — bruger standarden ${fallback}`);
        return fallback;
    }
    return n;
}

// Ugedagsliste. ALT eller intet: er bare ét led ukendt, bruges standarden.
// Frafiltrering ville fjerne tælle-dage, og færre tælle-dage rykker deadline
// LÆNGERE tilbage — altså flere afviste ordrer. Den vej må en tastefejl ikke gå.
function dayListOr(raw, fallback, key, problems) {
    if (raw == null || String(raw).trim() === '') return fallback;
    const days = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const ukendt = days.filter(d => !DAY_KEYS.includes(d));
    if (!days.length || ukendt.length) {
        problems.push(`${key}="${raw}" kan ikke bruges (${ukendt.join(', ') || 'tom'}) — bruger standarden`);
        return fallback;
    }
    return days;
}

/**
 * Læs cut-off-indstillingerne. Returnerer altid en brugbar konfiguration;
 * `problems[]` rummer det der måtte erstattes af en standardværdi.
 *
 * @param {object} db
 * @param {string} [todayIso] dagens danske dato — kun til override-tjekket
 */
function readCutoffConfig(db, todayIso) {
    const rows = db.prepare(
        "SELECT key, value FROM settings WHERE key LIKE 'bestilling.cutoff%' OR key = 'bestilling.delivery_days'"
    ).all();
    const raw = {};
    for (const r of rows) raw[r.key] = r.value;

    const problems = [];
    const overrideDate = String(raw['bestilling.cutoff_override_date'] || '').trim();

    return {
        time:         intOr(raw['bestilling.cutoff_time'], CUTOFF_DEFAULTS.time, 0, 23, 'cutoff_time', problems),
        leadDays:     intOr(raw['bestilling.cutoff_lead_days'], CUTOFF_DEFAULTS.leadDays, 0, 365, 'cutoff_lead_days', problems),
        cutoffDays:   dayListOr(raw['bestilling.cutoff_days'], CUTOFF_DEFAULTS.cutoffDays, 'cutoff_days', problems),
        deliveryDays: dayListOr(raw['bestilling.delivery_days'], CUTOFF_DEFAULTS.deliveryDays, 'delivery_days', problems),
        // Hastebestilling: gælder KUN den dato den blev sat på, og nulstiller
        // dermed sig selv. Tom `todayIso` = spørg ikke, altså ingen override.
        overrideActive: !!todayIso && overrideDate === todayIso,
        overrideDate: overrideDate || null,
        problems,
    };
}

// ─── Beregning ──────────────────────────────────────────────────────────────

// Dansk væg-ur som to sammenlignelige strenge. Vi konstruerer ALDRIG en Date i
// serverens egen tidszone: står maskinen i UTC, ville deadline rykke sig to
// timer, og ordrer mellem kl. 12 og 14 ville blive afvist med urette.
// `YYYY-MM-DD` + `HH:MM` kan sammenlignes som tekst, så tidszonen behøver kun
// at være rigtig ét sted — her.
function danishWallClock(now = new Date()) {
    return {
        date: new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now),
        time: new Intl.DateTimeFormat('en-GB', {
            timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(now),
    };
}

/**
 * Hvornår var deadline for en given leveringsdato?
 * Tæller `leadDays` åbne dage baglæns gennem `cutoffDays`.
 *
 * @returns {{date: string, time: string}|null} null = kan ikke beregnes (fejl åbent)
 */
function cutoffMomentFor(deliveryIso, cfg) {
    const m = ISO_DATE.exec(String(deliveryIso || '').trim());
    if (!m) return null;
    // `2026-02-31` matcher regexen. Uden round-trippet ruller Date den til
    // 2. marts, og vi ville svare med en deadline for en dag der ikke findes.
    if (!isValidDeliveryDate(deliveryIso)) return null;

    // Ren dato-aritmetik, forankret i UTC så den ikke afhænger af serverens
    // tidszone. Samme mønster som offsetISO() i db/helpers.js.
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(d.getTime())) return null;

    // Er ingen af ugedagene en tælle-dag, løber løkken uendeligt. Det kan ikke
    // ske via readCutoffConfig (tom liste → standard), men denne funktion er
    // eksporteret og kan kaldes med hvad som helst — og en hængende
    // bestillings-webhook er værre end en manglende deadline.
    const maxSteps = (cfg.leadDays + 1) * 14;
    let remaining = cfg.leadDays;
    let steps = 0;
    while (remaining > 0) {
        if (++steps > maxSteps) return null;
        d.setUTCDate(d.getUTCDate() - 1);
        if (cfg.cutoffDays.includes(DAY_KEYS[d.getUTCDay()])) remaining--;
    }

    return {
        date: d.toISOString().slice(0, 10),
        time: String(cfg.time).padStart(2, '0') + ':00',
    };
}

/**
 * Må der stadig bestilles til denne leveringsdato?
 *
 * @param {object} db
 * @param {string} deliveryIso  YYYY-MM-DD
 * @param {object} [opts]
 * @param {Date}   [opts.now]
 * @param {string} [opts.todayIso] dagens danske dato (til hastebestilling)
 * @returns {{ok: true, reason?: string} | {ok: false, code: string, cutoff: object, message: string}}
 */
function checkOrderTiming(db, deliveryIso, opts = {}) {
    const now = opts.now || new Date();
    const cfg = readCutoffConfig(db, opts.todayIso);

    if (cfg.problems.length) {
        // Sig det højt. En indstilling der stille erstattes af en standardværdi
        // er præcis den slags der først opdages når nogen undrer sig over en
        // bestilling der slap igennem.
        console.warn('[cutoff] Ubrugelige indstillinger:', cfg.problems.join(' · '));
    }

    if (cfg.overrideActive) return { ok: true, reason: 'hastebestilling' };

    const cutoff = cutoffMomentFor(deliveryIso, cfg);
    if (!cutoff) {
        console.warn(`[cutoff] Kunne ikke beregne deadline for "${deliveryIso}" — bestillingen slipper igennem`);
        return { ok: true, reason: 'ukendt_deadline' };
    }

    const nu = danishWallClock(now);
    const passeret = `${nu.date} ${nu.time}` > `${cutoff.date} ${cutoff.time}`;
    if (!passeret) return { ok: true };

    return {
        ok: false,
        code: 'cutoff_passed',
        cutoff,
        message: `Deadline for levering ${deliveryIso} var ${cutoff.date} kl. ${cutoff.time}.`,
    };
}

module.exports = {
    CUTOFF_DEFAULTS,
    DAY_KEYS,
    readCutoffConfig,
    cutoffMomentFor,
    isValidDeliveryDate,
    isValidDeliveryTime,
    danishWallClock,
    checkOrderTiming,
};
