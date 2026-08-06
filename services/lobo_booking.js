// services/lobo_booking.js
// ==========================================
// Booking-orchestrering for Byekspressen/Lobo (Fase B).
//
// Holder route-laget tyndt og gør logikken unit-testbar: adapter + DB-write-deps
// injiceres, så hele flowet kan testes uden netværk eller DB.
//
// - quoteForBon: pris-tilbud via orderdraft (opretter + sletter kladde — INGEN ordre).
// - bookForBon:  rigtig booking via POST /orders + skriv bon/delivery_events.
//
// Spec: docs/CLAUDE_LEVERING_LOBO.md §7-9.
// ==========================================

const { extractCostEx, bonToOrderInput } = require('./byExpressenAdapter');
const { estimateCost } = require('./booking_template');
const { exclToIncl } = require('../shared/moms');

// Default antal transportkasser for en bon:
//   1) bons.boxes hvis sat (>0) — det manuelt indtastede antal,
//   2) ellers udledt: ceil(arbejdsmængde / pax_per_box), hvor arbejdsmængde =
//      total_units (hvis >0) ellers pax — samme basis som resten af appen.
// Returnerer mindst 1 hvis der er en arbejdsmængde, ellers 0.
function defaultBoxesForBon(bon, paxPerBox = 16) {
    if (bon && bon.boxes != null && Number(bon.boxes) > 0) return Number(bon.boxes);
    const ppb = Number(paxPerBox) > 0 ? Number(paxPerBox) : 16;
    const workload = Number(bon && bon.total_units) > 0 ? Number(bon.total_units) : (Number(bon && bon.pax) || 0);
    if (workload <= 0) return 0;
    return Math.max(1, Math.ceil(workload / ppb));
}

// Ekstra-kasse-tillæg → ordersurchargequantities. cfg fra vognens booking_api_config.
function buildSurcharges(bon, cfg = {}) {
    const boxes = Number(bon.boxes) || 0;
    const out = [];
    if (cfg.extra_box_surcharge_id) {
        const included = Number(cfg.included_boxes) || 0;
        const extra = Math.max(0, boxes - included);
        if (extra > 0) out.push({ fksurcharge: cfg.extra_box_surcharge_id, quantity: extra });
    }
    return out;
}

// included_boxes for surcharge-beregning: cfg har forrang, ellers vognens
// cost_formula (By-expressen: 2 kasser inkluderet).
function resolveIncludedBoxes(cfg, vehicle) {
    if (cfg.included_boxes != null) return Number(cfg.included_boxes) || 0;
    if (vehicle && vehicle.cost_formula_json) {
        try { const f = JSON.parse(vehicle.cost_formula_json); if (f.included_boxes != null) return Number(f.included_boxes) || 0; } catch { /* ignore */ }
    }
    return 0;
}

// Pris pr. ekstra kasse (det By-ex tager pr. kasse over de inkluderede).
// cfg har forrang, ellers vognens cost_formula.extra_box_cost.
function resolveExtraBoxCost(cfg, vehicle) {
    if (cfg.extra_box_cost != null) return Number(cfg.extra_box_cost) || 0;
    if (vehicle && vehicle.cost_formula_json) {
        try { const f = JSON.parse(vehicle.cost_formula_json); if (f.extra_box_cost != null) return Number(f.extra_box_cost) || 0; } catch { /* ignore */ }
    }
    return 0;
}

// Kostpris ex moms = Lobos GRUNDpris (uden tillæg) + det By-ex tager pr. ekstra
// kasse over de inkluderede. Vi lægger selv kasse-tillægget til frem for at
// stole på Lobos `costtotal_net` — dens størrelsestillæg er fladt (samme beløb
// uanset antal ekstra kasser), mens By-ex reelt opkræver pr. kasse.
// Foreslået kundepris (ex moms) på lange ture hvor standardprisen ikke dækker
// buddet: kostpris × (1 + markup%), rundet op til nærmeste `roundTo` kr, aldrig
// under standardprisen. Returnerer null når standardprisen allerede dækker
// kostprisen (så vises ingen anbefaling). Ren funktion — testbar.
function suggestCustomerPrice(costEx, customerEx, markupPct = 10, roundTo = 25) {
    if (costEx == null) return null;
    if (customerEx != null && customerEx > costEx) return null;   // margin allerede positiv
    const raw = costEx * (1 + (Number(markupPct) || 0) / 100);
    const step = Number(roundTo) > 0 ? Number(roundTo) : 25;
    const rounded = Math.ceil(raw / step) * step;
    return Math.max(rounded, Number(customerEx) || 0);
}

// applyBoxSurcharge: kun for Food (39) lægger By-expressen 50/ekstra-kasse oveni
// Lobos grundpris. For ikke-Food-produkter (Medium/Large til lange ture) er Lobos
// pris allerede komplet (pr. km) — så returnér den uændret.
function composeCostEx(loboBaseEx, boxes, cfg, vehicle, applyBoxSurcharge = true) {
    if (loboBaseEx == null) return null;
    if (!applyBoxSurcharge) return Math.round(loboBaseEx * 100) / 100;
    const included = cfg.included_boxes != null ? Number(cfg.included_boxes) : resolveIncludedBoxes(cfg, vehicle);
    const extra = Math.max(0, (Number(boxes) || 0) - included);
    return Math.round((loboBaseEx + resolveExtraBoxCost(cfg, vehicle) * extra) * 100) / 100;
}

// Pris-tilbud: opret orderdraft → læs Lobos kostpris → slet kladden igen.
// Returnerer kostpris (ex/incl), kundepris (fra vognens cost_formula) + margin.
// `boxes` (valgfri) overstyrer bonens kasse-antal — ekstra kasser koster mere
// (surcharge hos Lobo + extra_box_cost i kundeprisen).
async function quoteForBon({ bon, vehicle, adapter, boxes = null, paxPerBox = 16, pricing = {} }) {
    const cfg = { ...(adapter.config || {}) };
    if (cfg.included_boxes == null) cfg.included_boxes = resolveIncludedBoxes(cfg, vehicle);

    const effectiveBoxes = boxes != null && boxes !== '' ? Math.max(0, parseInt(boxes, 10) || 0) : defaultBoxesForBon(bon, paxPerBox);
    const bonForCalc = { ...bon, boxes: effectiveBoxes };

    // Send INGEN kasse-tillæg til Lobo — vi vil have den rene GRUNDpris og lægger
    // selv 50/kasse til (composeCostEx), da Lobos eget tillæg er fladt.
    const input = bonToOrderInput(bonForCalc, { pickupNote: 'pris-tjek' });
    const payload = adapter.buildOrderPayload(input);

    const quote = await adapter.priceQuote(payload);
    if (quote && quote.uuid) {
        try { await adapter.deleteOrderDraft(quote.uuid); } catch { /* kladden udløber selv efter 5 min */ }
    }

    const costEx = composeCostEx(quote.cost_ex, effectiveBoxes, cfg, vehicle);
    const costIncl = costEx != null ? exclToIncl(costEx) : null;
    const maxKm = vehicle && vehicle.max_distance_km != null ? Number(vehicle.max_distance_km) : null;
    const distKm = quote.routedistance != null ? quote.routedistance / 1000 : null;

    // Kundeprisen regnes med Lobos EGEN målte afstand, så trappe-taksten rammer
    // det rigtige trin. Uden afstand falder estimateCost tilbage til trin 1.
    const customerEx = vehicle
        ? (estimateCost(vehicle, bonForCalc, distKm != null ? { distance_km: distKm } : {}) ?? null)
        : null;

    // Food dækker kun forsyningsområdet. Ligger turen udenfor, er KOSTprisen
    // upålidelig — vi spørger altid om Food, og Lobos kladde afviser ikke
    // out-of-area (kun den rigtige booking gør). Kundeprisen er derimod fin:
    // trappen har et trin for lange ture. Så: ingen margin (den ene halvdel af
    // regnestykket er fiktion), men prisen kan vi stadig oplyse.
    const outOfArea = !!(maxKm && distKm && distKm > maxKm);

    const margin = (!outOfArea && customerEx != null && costEx != null)
        ? Math.round((customerEx - costEx) * 100) / 100
        : null;

    // Hvad turen BØR koste kunden: kostpris + markup, rundet op.
    //
    // Uden for forsyningsområdet foreslår vi INTET. Ikke fordi By-expressen ikke
    // kører derud — det gør de, med egne produkter (Small/Medium/Large) og et
    // zone-tillæg — men fordi vi altid spørger om FOOD, og Lobos kladde afviser
    // ikke out-of-area (kun den rigtige booking gør). Kostprisen her er altså en
    // Food-pris for en tur Food ikke kan købes til. At gange den med en markup
    // ville give en kundepris bygget på et tal der ikke findes. Office henter den
    // rigtige pris i By-ex booking-panelet, hvor produktet kan vælges — dér
    // beregner previewBooking forslaget på det rigtige grundlag.
    const suggestedEx = outOfArea
        ? null
        : suggestCustomerPrice(costEx, customerEx, pricing.markup_pct, pricing.round_to);
    const suggestedMargin = (suggestedEx != null && costEx != null)
        ? Math.round((suggestedEx - costEx) * 100) / 100
        : null;

    return {
        cost_ex: costEx,                 // Lobo grundpris + 50/kasse over inkluderede
        cost_incl: costIncl,
        customer_ex: customerEx,
        standard_price_applies: !outOfArea,
        supply_warning: outOfArea,       // Food dækker ikke turen — kostprisen er
                                         // en Food-pris for noget vi ikke kan købe
        max_distance_km: maxKm,
        margin,                          // advarsel-grundlag (negativ = vi taber) — blokerer ALDRIG.
                                         // null når der ingen bypris er at måle mod.
        suggested_customer_ex: suggestedEx,
        suggested_margin: suggestedMargin,
        routedistance: quote.routedistance,
        co2saving: quote.co2saving,
        boxes: effectiveBoxes,
        included_boxes: cfg.included_boxes,
        extra_box_cost: resolveExtraBoxCost(cfg, vehicle),
    };
}

/* ══════════════════════════════════════════════════════════════
   FELT-SAMMENSÆTNING — det By-expressen faktisk modtager
   ══════════════════════════════════════════════════════════════
   Gør hvad office ville skrive manuelt: navn+tlf i ét kontaktfelt,
   kort note med kundens leveringstid + speciel info, bonnr som synlig
   reference (customerreferenceorder), og afhentningstid som reftime
   (driver Lobos leveringsvindue). `overrides` lader office rette hvert
   felt før bestilling — det previewede er præcis det bookede.
   ══════════════════════════════════════════════════════════════ */

// '+02:00' / '+01:00' for en dansk kalenderdato (sommer/vinter).
function dkOffset(dateStr) {
    try {
        const d = new Date((dateStr || '2026-01-01') + 'T12:00:00Z');
        const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Copenhagen', timeZoneName: 'longOffset' })
            .formatToParts(d).find(x => x.type === 'timeZoneName');
        return ((p && p.value) || 'GMT+01:00').replace('GMT', '') || '+01:00';
    } catch { return '+01:00'; }
}

// HH:MM − minutter → HH:MM.
function subMinutesHHMM(hhmm, mins) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return null;
    let t = (+m[1]) * 60 + (+m[2]) - mins;
    t = ((t % 1440) + 1440) % 1440;
    return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
}

function hhmm(v) { return v ? String(v).slice(0, 5) : null; }

// Default afhentningstid: bonnens pickup_time, ellers leveringstid − 45 min.
function defaultPickupHHMM(bon) {
    if (bon.pickup_time) return hhmm(bon.pickup_time);
    const dl = hhmm(bon.delivery_time);
    return dl ? subMinutesHHMM(dl, 45) : null;
}

// Kontakt-på-dagen: navn + tlf i ét felt (Lobo har intet separat telefonfelt).
function defaultContact(bon) {
    const name = (bon.day_contact_name || bon.contact_name_full || '').trim();
    const phone = (bon.day_contact_phone || bon.contact_phone || '').trim();
    return [name, phone].filter(Boolean).join(' ').trim();
}

// Kort leverings-note: kundens leveringstid + (afkortet) speciel info.
function defaultDeliveryNote(bon) {
    const dl = hhmm(bon.delivery_time);
    const info = (bon.delivery_notes || '').trim();
    const parts = [];
    if (dl) parts.push('Leveres kl. ' + dl);
    if (info) parts.push(info.length > 60 ? info.slice(0, 57) + '…' : info);
    return parts.join(' · ');
}

// ISO-datetime fra bonnens dato + et HH:MM-klokkeslæt (dansk offset).
function isoFor(bon, hhmmStr) {
    return (hhmmStr && bon.delivery_date)
        ? `${bon.delivery_date}T${hhmmStr}:00${dkOffset(bon.delivery_date)}`
        : null;
}

// Saml alle felter (med overrides) → { input til buildOrderPayload, preview, boxes }.
function composeLoboBooking(bon, vehicle, cfg, overrides = {}) {
    const boxes = overrides.boxes != null && overrides.boxes !== ''
        ? Math.max(0, parseInt(overrides.boxes, 10) || 0)
        : defaultBoxesForBon(bon, overrides.paxPerBox || 16);
    const pickupHHMM = overrides.pickup_time ? hhmm(overrides.pickup_time) : defaultPickupHHMM(bon);
    const reftime = isoFor(bon, pickupHHMM);
    const contact = overrides.contact != null ? String(overrides.contact) : defaultContact(bon);
    // Note = "Leveres kl. {bonnens leveringstid}" (auto fra LEVERING — ét sted) +
    // den redigerbare speciel-info. Office retter kun speciel-infoen.
    const noteExtra = overrides.note != null ? String(overrides.note) : (bon.delivery_notes || '').trim();
    const deliveryTimeStr = hhmm(bon.delivery_time);
    const note = [deliveryTimeStr ? ('Leveres kl. ' + deliveryTimeStr) : '', (noteExtra || '').trim()]
        .filter(Boolean).join(' · ');
    // Reference til By-expressen: bonnummer med #-præfiks (som i Bon v2's visning),
    // medmindre office har overstyret. Undgå dobbelt-# hvis bon_number allerede har et.
    const reference = overrides.reference != null
        ? String(overrides.reference)
        : (bon.bon_number ? (String(bon.bon_number).startsWith('#') ? String(bon.bon_number) : '#' + bon.bon_number) : '');
    const fkproduct = overrides.fkproduct != null && overrides.fkproduct !== ''
        ? parseInt(overrides.fkproduct, 10) : cfg.fkproduct;
    // Afhentnings-note: bonnummer + kasse-antal. customerreferenceorder vises kun
    // på kvitteringen, ikke i By-expressens ordre-/opgavevisning — så bonnummeret
    // gentages her, så det er synligt i Stop/Note-kolonnen ved afhentning.
    const pickupNote = [reference, boxes > 0 ? `${boxes} kasser` : null].filter(Boolean).join(' · ');

    // VIGTIGT: vi sender IKKE kasse-tillæg (ordersurchargequantity) til Lobo.
    // 1) Lobos størrelsestillæg er FLADT (samme uanset antal) — vi lægger selv
    //    50/kasse til via composeCostEx på Lobos GRUNDpris.
    // 2) Tillægget er produkt-specifikt (389 hører til Food) → INVALID_SURCHARGE
    //    ved andre produkter (fx Large på lange ture).
    // Buddet får kasse-antallet via afhentnings-noten ("N kasser") i stedet.
    const base = bonToOrderInput({ ...bon, boxes });   // adresse-split + external_api_*
    const input = {
        ...base,
        fkproduct,
        customerreferenceorder: reference,
        ...(reftime ? { reftime } : {}),
        ...(pickupNote ? { pickupNote } : {}),
        deliveryNote: note,
        delivery: { ...(base.delivery || {}), contactperson: contact || undefined },
    };
    const preview = { reference, fkproduct, contactperson: contact, pickup_time: pickupHHMM, pickup_note: pickupNote, delivery_note: note, note_extra: noteExtra, reftime, boxes };
    return { input, preview, boxes };
}

// Leveringsvindue (tw_estimated på leverings-stoppet) fra en draft/ordre.
function extractWindow(order) {
    if (!order || !Array.isArray(order.stops)) return null;
    const d = order.stops.find(s => s.position === 2) || order.stops[order.stops.length - 1];
    if (!d) return null;
    return { begin: d.tw_estimated_begin || null, end: d.tw_estimated_end || null };
}

// Bon-felter til "tjek op imod"-kolonnen i sandkasse.
function bonControlFields(bon, boxes) {
    const a = bon.delivery_address || {};
    const addr = [
        [a.street_name, a.street_nr].filter(Boolean).join(' '),
        [a.postal_code, a.city].filter(Boolean).join(' '),
    ].filter(Boolean).join(', ');
    return {
        company: bon.company_name || null,
        address: addr || null,
        contact_name: bon.day_contact_name || bon.contact_name_full || null,
        contact_phone: bon.day_contact_phone || bon.contact_phone || null,
        boxes,
        delivery_time: hhmm(bon.delivery_time),
        delivery_notes: bon.delivery_notes || null,
    };
}

// Normalisér en Lobo-ordre (GET /orders/{uuid}?_embed=stops,downloadlinks,dispatchedto)
// til det status-panelet skal bruge. Ren funktion — testbar uden netværk.
function normalizeLoboOrder(order) {
    if (!order) return null;
    const stops = Array.isArray(order.stops) ? order.stops : [];
    const delivery = stops.find(s => s.position === 2) || stops[stops.length - 1] || null;
    const pickup = stops.find(s => s.position === 1) || null;
    const dl = order.downloadlinks || {};
    const dt = order.dispatchedto || null;
    const carrier = dt && (dt.name || dt.displayname || dt.fullname)
        ? (dt.name || dt.displayname || dt.fullname)
        : (order.fkcarrier ? ('Bud #' + order.fkcarrier) : null);
    const costEx = order.costtotal_net ?? (order.accounting && order.accounting.costtotal_net) ?? null;
    const costIncl = order.costtotal_gross ?? (order.accounting && order.accounting.costtotal_gross) ?? null;
    const status = order.status || null;
    // leveret = status 'finished' ELLER leverings-stop er signeret/besøgt/har faktisk sluttid
    const delivered = status === 'finished'
        || !!(delivery && (delivery.signed || delivery.visited || delivery.tw_real_end));
    const win = (s) => s ? { begin: s.tw_estimated_begin || null, end: s.tw_estimated_end || null } : null;
    return {
        uuid: order.uuid || null,
        number: order.numberformatted || null,
        status,
        carrier,
        delivered,
        eta: win(delivery),
        pickup_eta: win(pickup),
        has_pod: !!dl.download_pod,
        cost_ex: typeof costEx === 'number' ? costEx : null,
        cost_incl: typeof costIncl === 'number' ? costIncl : null,
        routedistance: order.routedistance ?? null,
    };
}

// Preview: opret kort draft → læs vindue + pris → slet draft. INGEN ordre/bud.
// Returnerer alt panelet skal bruge: felter der sendes, Lobos vindue, pris, bon-felter.
async function previewBooking({ bon, vehicle, adapter, overrides = {}, paxPerBox = 16, pricing = {} }) {
    const cfg = { ...(adapter.config || {}) };
    if (cfg.included_boxes == null) cfg.included_boxes = resolveIncludedBoxes(cfg, vehicle);
    const { input, preview, boxes } = composeLoboBooking(bon, vehicle, cfg, { ...overrides, paxPerBox });
    const payload = adapter.buildOrderPayload(input);

    const quote = await adapter.priceQuote(payload);
    if (quote && quote.uuid) { try { await adapter.deleteOrderDraft(quote.uuid); } catch { /* udløber selv */ } }

    // Food (= vognens default-produkt) får kasse-tillæg lokalt; andre produkter
    // (lange ture, pr. km) bruger Lobos pris direkte.
    const isFood = Number(preview.fkproduct) === Number(cfg.fkproduct);
    const win = extractWindow(quote.order);
    const costEx = composeCostEx(quote.cost_ex, boxes, cfg, vehicle, isFood);
    const costIncl = costEx != null ? exclToIncl(costEx) : null;
    // Kundepris med Lobos målte afstand, så trappe-taksten rammer rigtigt trin.
    const previewDistKm = quote.routedistance != null ? quote.routedistance / 1000 : null;
    const customerEx = vehicle
        ? (estimateCost(vehicle, { ...bon, boxes }, previewDistKm != null ? { distance_km: previewDistKm } : {}) ?? null)
        : null;
    const margin = (customerEx != null && costEx != null) ? Math.round((customerEx - costEx) * 100) / 100 : null;

    // Foreslået kundepris med lille positiv margin (lange ture). Regel fra settings.
    const suggestedEx = suggestCustomerPrice(costEx, customerEx, pricing.markup_pct, pricing.round_to);
    const suggestedMargin = (suggestedEx != null && costEx != null) ? Math.round((suggestedEx - costEx) * 100) / 100 : null;

    const deadlineIso = isoFor(bon, hhmm(bon.delivery_time));
    const isLate = (win && win.end && deadlineIso) ? (new Date(win.end) > new Date(deadlineIso)) : false;

    // Supply-area-advarsel: Food dækker kun bynært (vognens max_distance_km). Draften
    // afslører IKKE out-of-area (kun den rigtige booking gør) — så vi advarer proaktivt
    // når Food vælges til en tur længere end leveringsområdet.
    const maxKm = vehicle && vehicle.max_distance_km ? Number(vehicle.max_distance_km) : null;
    const distKm = quote.routedistance != null ? quote.routedistance / 1000 : null;
    const supplyWarning = !!(isFood && maxKm && distKm && distKm > maxKm);

    return {
        preview,
        window: win ? { begin: win.begin, end: win.end, deadline_iso: deadlineIso, is_late: isLate } : null,
        price: { cost_ex: costEx, cost_incl: costIncl, customer_ex: customerEx, margin, suggested_customer_ex: suggestedEx, suggested_margin: suggestedMargin },
        bon_fields: bonControlFields(bon, boxes),
        routedistance: quote.routedistance ?? null,
        supply_warning: supplyWarning,
        max_distance_km: maxKm,
        is_food: isFood,
    };
}

// Rigtig booking: POST /orders → skriv delivery_events (booked + snapshot) +
// bons.delivery_cost (api) + SSE. Ved Lobo-fejl logges et 'failed'-event.
// `overrides` (samme som previewBooking) sikrer at det bookede = det previewede.
async function bookForBon({ bon, vehicle, adapter, userId = null, overrides = {}, boxes = null, paxPerBox = 16, deps = {} }) {
    const logBookingEvent = deps.logBookingEvent || require('./delivery_log').logBookingEvent;
    const setActualCost = deps.setActualCost || require('./delivery_log').setActualCost;
    const broadcast = deps.broadcast || require('../shared/sse').broadcast;

    const cfg = { ...(adapter.config || {}) };
    if (cfg.included_boxes == null) cfg.included_boxes = resolveIncludedBoxes(cfg, vehicle);
    // bagudkompat: ældre kald sendte boxes direkte; fold ind i overrides.
    const ov = { ...overrides, paxPerBox };
    if (ov.boxes == null && boxes != null) ov.boxes = boxes;
    const { input, preview, boxes: effectiveBoxes } = composeLoboBooking(bon, vehicle, cfg, ov);
    const isFood = Number(preview.fkproduct) === Number(cfg.fkproduct);
    const payload = adapter.buildOrderPayload(input);

    let order;
    try {
        order = await adapter.bookOrder(payload);
    } catch (e) {
        try {
            await logBookingEvent({ bonId: bon.id, vehicleId: vehicle.id, status: 'failed', userId, note: `Lobo-fejl: ${e.message}` });
        } catch { /* fejl-logning må ikke skygge for den oprindelige fejl */ }
        throw e;
    }

    const costEx = composeCostEx(extractCostEx(order), effectiveBoxes, cfg, vehicle, isFood);
    await logBookingEvent({
        bonId: bon.id, vehicleId: vehicle.id, reference: order.uuid,
        status: 'booked', userId, snapshot: order,
    });
    if (costEx != null) {
        setActualCost({ bonId: bon.id, amount: costEx, source: 'api', userId });
    }
    broadcast('delivery_event', { bon_id: bon.id, external_reference: order.uuid, status: 'booked' });

    return { uuid: order.uuid, cost_ex: costEx, order };
}

module.exports = {
    quoteForBon, bookForBon, previewBooking, composeLoboBooking,
    buildSurcharges, defaultBoxesForBon, composeCostEx, resolveExtraBoxCost,
    defaultPickupHHMM, defaultContact, defaultDeliveryNote, extractWindow, bonControlFields,
    normalizeLoboOrder, suggestCustomerPrice,
};
