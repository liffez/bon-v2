/**
 * services/paymentRhythm.js
 * ════════════════════════════════════════════════════════════════════════
 * "Hvornår plejer DENNE kunde at betale?" — lært af historikken, ikke indtastet.
 *
 * Fakturaens forfaldsdato bliver stående som den er (14 dage eller mindre, nogle
 * straksbetaling) — det er hvad vi fakturerer med, og det skal ikke laves om.
 * Men en kommune der altid betaler et stykke efter fristen skal ikke råbe
 * "FORFALDEN" i triagen på dag 15. Derfor beregner vi en FORVENTET betalingsdag
 * oven i forfaldsdatoen, ud fra hvad kunden plejer at gøre.
 *
 * Ingen felter at vedligeholde. Rytmen genberegnes af sig selv efterhånden som
 * flere indbetalinger kobles.
 *
 * ── HVILKE OBSERVATIONER MÅ TÆLLE MED (vigtigt) ────────────────────────────
 * Kun links der er lagt UDEN at kigge på datoen:
 *   • conf ≥ 95  — fakturanummer stod i bankteksten
 *   • allokering — et menneske har koblet den
 *
 * Auto-matcherens 50-80-tier scorer netop PÅ nærhed til forfaldsdatoen
 * (`daysDiff <= 5` → 80, `<= 14` → 55, derover → 40 = registreres slet ikke).
 * At lære om timing af et link der selv blev valgt ud fra timing er cirkulært —
 * og værre: en sen betaling uden fakturanummer i teksten får conf 40 og bliver
 * aldrig registreret. Netop de langsomme betalere ville altså være usynlige, og
 * gennemsnittet ville pænt fortælle os at alle betaler til tiden.
 *
 * ── HVOR TYNDT GRUNDLAGET ER (målt 10. august 2026) ────────────────────────
 * 2.842 betalte fakturaer, men kun 303 har en ægte betalingsdato. Resten fik
 * `betalt_dato = delivery_date` af `cashflowSync` da bonnen blev sat til BETALT
 * — det er en leveringsdato, ikke en betalingsdato, og den må ALDRIG bruges her.
 * Rytmen slår derfor kun til for en håndfuld kunder i dag. Det er med vilje: et
 * gæt på to observationer er værre end ingen justering.
 * ════════════════════════════════════════════════════════════════════════
 */
'use strict';

/** Mindste antal observationer før vi tør flytte datoen. */
const MIN_OBSERVATIONS = 3;
/** Loft — en enkelt bizar historik må ikke parkere en faktura et halvt år ude. */
const MAX_SHIFT_DAYS = 45;
/** Cache-levetid; rytmen ændrer sig i ugetempo, ikke i sekundtempo. */
const CACHE_MS = 5 * 60 * 1000;

let _cache = null, _cacheAt = 0;

/** Median — robust mod den ene faktura der blev betalt 90 dage for sent. */
function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Lær hver kundes typiske forsinkelse i dage (median), kun fra tidsuafhængige links.
 * @returns {Map<string, {days:number, n:number}>} kundenavn → rytme
 */
function learnDelays(db) {
    const rows = db.prepare(`
        SELECT kunde, dage FROM (
            SELECT i.kunde AS kunde, JULIANDAY(t.dato) - JULIANDAY(i.forfald) AS dage, i.id AS iid
            FROM cf_invoices i
            JOIN cf_transactions t ON t.matched_invoice_id = i.id AND t.match_confidence >= 95
            WHERE i.betalt = 1
            UNION
            SELECT i.kunde, JULIANDAY(t.dato) - JULIANDAY(i.forfald), i.id
            FROM cf_invoices i
            JOIN cf_allocations a ON a.target_type = 'invoice' AND a.target_id = i.id
            JOIN cf_transactions t ON t.id = a.transaction_id
            WHERE i.betalt = 1
        )
    `).all();

    const byCustomer = new Map();
    for (const r of rows) {
        if (r.kunde == null || r.dage == null) continue;
        if (!byCustomer.has(r.kunde)) byCustomer.set(r.kunde, []);
        byCustomer.get(r.kunde).push(r.dage);
    }

    const out = new Map();
    for (const [kunde, days] of byCustomer) {
        if (days.length < MIN_OBSERVATIONS) continue;
        // Kun SENERE, aldrig tidligere: en kunde der plejer at betale før tid
        // gør ikke fakturaen mindre forfalden når fristen først er sprunget.
        const shift = Math.min(MAX_SHIFT_DAYS, Math.max(0, Math.round(median(days))));
        if (shift <= 0) continue;                     // betaler til tiden → ingen justering
        out.set(kunde, { days: shift, n: days.length });
    }
    return out;
}

/** Cachet udgave — kaldes pr. request på lister der kan have hundredvis af rækker. */
function getDelays(db, { fresh = false } = {}) {
    const now = Date.now();
    if (!fresh && _cache && now - _cacheAt < CACHE_MS) return _cache;
    _cache = learnDelays(db);
    _cacheAt = now;
    return _cache;
}

function invalidate() { _cache = null; }

/** Læg N dage til en ISO-dato (ren kalender-aritmetik). */
function addDays(iso, n) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); // utc-ok: ren kalender
}

/**
 * Berig fakturarækker med forventet betalingsdag.
 * Rører ALDRIG `forfald` — den er fakturaens juridiske frist og bliver stående.
 *
 * @param {Array} rows  rækker med { kunde, forfald, betalt }
 * @param {string} today
 * @returns samme rækker, med expected_date / days_past_expected / rhythm_days / rhythm_n
 */
function annotate(db, rows, today) {
    const delays = getDelays(db);
    for (const r of rows) {
        const rh = delays.get(r.kunde);
        r.rhythm_days = rh ? rh.days : 0;
        r.rhythm_n = rh ? rh.n : 0;
        r.expected_date = rh ? addDays(r.forfald, rh.days) : r.forfald;
        r.days_past_expected = r.betalt ? 0
            : Math.round((Date.parse(today) - Date.parse(r.expected_date)) / 86400000);
        // Sen for DENNE kunde = forbi det tidspunkt hvor selv de plejer at have betalt.
        r.late_for_customer = !r.betalt && r.days_past_expected > 0 ? 1 : 0;
    }
    return rows;
}

module.exports = { learnDelays, getDelays, invalidate, annotate, addDays, median,
                   MIN_OBSERVATIONS, MAX_SHIFT_DAYS };
