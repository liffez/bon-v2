/**
 * smagningBon — en booket smagning bliver til en bon køkkenet kan pakke.
 *
 * En smagning er ikke et møde hos os. Køkkenet pakker en fast smagsprøve
 * (sliderskinne, sandwich i boks, cookieknæk), og vi kører den ud til kunden på
 * dagen. Uden en bon findes den aftale kun som en CRM-aktivitet, og hverken
 * køkkenet eller Logistik ser den.
 *
 * ── Hvorfor det hele er best-effort ────────────────────────────────────────
 * Kunden må ALDRIG få en fejl på bookingformularen fordi Grocy er nede eller
 * menuen ikke er sat op. Bookingen er det vigtige; bonen er en afledt ting vi
 * kan lave igen. Derfor:
 *
 *   · Grocy utilgængelig  → bonen oprettes UDEN linjer, med grunden skrevet i
 *                           interne noter. Adressen og tidspunktet er dét
 *                           køkkenet og Logistik har brug for først.
 *   · Menuen ikke sat op  → samme. Et tomt menu-array er en opsætning der
 *                           mangler, ikke en fejl.
 *   · Bon-oprettelse dør  → kalderen logger og lader bookingen stå. Adressen
 *                           er gemt på aktiviteten (migration 172), så bonen
 *                           kan laves bagefter fra CRM.
 *   · Vognen kan ikke      → bonen bliver, uden vogn. Den står da som "Ikke
 *     bookes                 planlagt endnu" i Logistik, og grunden skrives i
 *                           interne noter.
 *
 * Det der ALDRIG er stille: hver af de tre efterlader et spor på bonen eller i
 * svaret, så ingen kan tro at der ligger en smagsprøve klar som ikke gør.
 */

const { getDb } = require('../db/database');
const { createBon, insertBonLines, logChange } = require('../db/helpers');

function getSetting(key) {
    return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

/** Menuen som menu_items[] — samme form som web-bestillingen sender. */
function readMenu() {
    const raw = getSetting('booking_smagning_menu');
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(i => i && i.id && Number(i.count) > 0);
    } catch {
        console.warn('[smagning] booking_smagning_menu er ikke gyldig JSON — ingen linjer');
        return [];
    }
}

/**
 * Hent linjerne til standard-smagsprøven.
 * Kaster ALDRIG — en fejl her må ikke koste bonen. Returnerer i stedet grunden.
 */
async function resolveMenuLines(priceCategory) {
    const menuItems = readMenu();
    if (!menuItems.length) {
        return { lines: [], warning: 'Smagsprøvens menu er ikke sat op (Settings → Booking — Smagsprøve).' };
    }
    try {
        const grocy = require('./grocyAdapter');
        const { resolveMenuItemLines } = require('./menuItemsToLines');
        const recipes = await grocy.getRecipes();
        const recipesById = new Map(recipes.map(r => [r.id, r]));
        const { lines, unmatched } = resolveMenuItemLines({ menuItems, recipesById, priceCategory });

        let warning = null;
        if (unmatched.length) {
            // Opskriften er slettet eller omdøbt i Grocy. Køkkenet skal vide at
            // der mangler noget — ikke opdage det når kassen skal pakkes.
            warning = `${unmatched.length} ret fra smagsprøve-menuen findes ikke i Grocy: `
                    + unmatched.map(u => u.id).join(', ')
                    + '. Ret menuen i Settings → Booking — Smagsprøve.';
        }
        return { lines, warning };
    } catch (err) {
        return { lines: [], warning: `Kunne ikke hente menuen fra Grocy (${err.message}). Linjerne skal lægges på i hånden.` };
    }
}

/**
 * Hvilken status bonen skal fødes med.
 *
 * NY betyder "nogen skal tage stilling". En booket smagning er afklaret i det
 * sekund kunden trykker book — menu, adresse og tidspunkt er alle givne — så
 * den hører ikke til i NY-bunken sammen med de bestillinger der faktisk
 * mangler noget. Standard er derfor GODKENDT (migration 175).
 *
 * Koden valideres mod status_definitions FØR den bruges: getStatusId()
 * returnerer undefined for en ukendt kode, og så ville INSERT'en kaste og
 * koste bonen. En tastefejl i Settings må ikke kunne slå auto-oprettelsen
 * ihjel for hver eneste booking — så hellere NY og en linje i loggen.
 */
function resolveBonStatus() {
    const wanted = (getSetting('booking_smagning_bon_status') || 'GODKENDT').trim().toUpperCase();
    const row = getDb().prepare(
        'SELECT code FROM status_definitions WHERE code = ? AND is_active = 1'
    ).get(wanted);
    if (row) return row.code;
    console.warn(`[smagning] Ukendt bon-status "${wanted}" i Settings \u2014 bruger NY i stedet`);
    return 'NY';
}

/**
 * Sæt vores egen vogn på bonen (Volvo Duett som standard).
 *
 * Vi kører selv smagsprøven ud, så vognen er kendt på forhånd. Uden den står
 * bonen som "Ikke planlagt endnu" i Logistik og på køkkenkortet, og nogen
 * skal huske at vælge den i hånden hver gang.
 *
 * logBookingEvent() ejer hele koblingen — delivery_events, delivery_method,
 * courier_provider, prisestimat, afhentningstid, changelog og SSE. Den kan
 * slå et ORS-opslag op undervejs; går dét galt, må det aldrig koste bonen.
 *
 * @returns {Promise<string|null>} advarsel hvis vognen ikke kunne sættes
 */
async function bookOwnDelivery(bonId, userId) {
    const raw = getSetting('booking_smagning_vehicle_id');
    const vehicleId = parseInt(raw, 10);
    // Tom værdi er et gyldigt valg: "book ikke automatisk".
    if (!Number.isInteger(vehicleId) || vehicleId <= 0) return null;

    try {
        const { logBookingEvent } = require('./delivery_log');
        await logBookingEvent({
            bonId,
            vehicleId,
            status: 'booked',
            userId,
            note: 'Sat automatisk fra booket smagning',
        });
        return null;
    } catch (err) {
        return `Leveringen kunne ikke sættes automatisk (${err.message}). Vælg vogn under BESTIL BUD på bonen.`;
    }
}

/**
 * Opret bonen for en booket smagning og kobl den til aktiviteten.
 *
 * @returns {Promise<{created:boolean, reason?:string, bonId?:number, bonNumber?:string, warning?:string}>}
 */
async function createSmagningBon({ activityId, customerId, companyId, date, time, addressId, guestCount, meetingTypeLabel, userId = null }) {
    if (getSetting('booking_smagning_create_bon') !== '1') {
        return { created: false, reason: 'disabled' };
    }
    if (!customerId || !date) {
        return { created: false, reason: 'missing_customer_or_date' };
    }

    const db = getDb();

    // Er der allerede en bon på aktiviteten, laver vi ikke en til. Webhooken
    // kan blive kaldt to gange (retry, dobbeltklik), og to smagsprøver til
    // samme aftale er en kasse mad for meget.
    const existing = activityId
        ? db.prepare('SELECT bon_id FROM crm_activities WHERE id = ?').get(activityId)?.bon_id
        : null;
    if (existing) {
        return { created: false, reason: 'already_exists', bonId: existing };
    }

    const priceCategory = getSetting('booking_smagning_price_category') || 'catering';
    const paymentType   = getSetting('booking_smagning_payment_type') || 'sponsorship';

    const { lines, warning } = await resolveMenuLines(priceCategory);

    const label = meetingTypeLabel || 'Smagning';
    const notes = [
        `${label} booket ${date}${time ? ' kl. ' + time : ''}.`,
        warning || null,
    ].filter(Boolean).join('\n');

    const { bonId, bonNumber } = createBon({
        customer_id: customerId,
        company_id:  companyId || null,
        delivery_date: date,
        delivery_time: time || null,
        delivery_type: 'delivery',
        delivery_address_id: addressId || null,
        pax: guestCount || null,
        price_category_code: priceCategory,
        price_category: priceCategory,
        payment_type: paymentType,
        status_code: resolveBonStatus(),
        kitchen_info: `${label} — standard smagsprøve`,
        internal_notes: notes,
        user_id: userId,
        changelog_message: `Oprettet automatisk fra booket ${label.toLowerCase()}`,
        broadcast_extra: { source: 'booking_smagning' },
    });

    if (lines.length) {
        insertBonLines(db, bonId, lines, {
            changelogMessage: `${lines.length} linje(r) fra standard-smagsprøven`,
            notes: 'Booking → smagsprøve-menu',
            userId,
        });
    }

    if (activityId) {
        db.prepare('UPDATE crm_activities SET bon_id = ? WHERE id = ?').run(bonId, activityId);
    }

    // Vognen sættes EFTER bonen findes — den skal have et bon-id at hænge på.
    // Fejler den, står advarslen på bonen ved siden af menu-advarslen, så den
    // ene ikke kan skjule den anden.
    const vehicleWarning = await bookOwnDelivery(bonId, userId);
    if (vehicleWarning) {
        db.prepare(`
            UPDATE bons
               SET internal_notes = TRIM(COALESCE(internal_notes, '') || char(10) || ?),
                   updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(vehicleWarning, bonId);
    }

    const warnings = [warning, vehicleWarning].filter(Boolean);
    warnings.forEach(w => console.warn(`[smagning] bon ${bonNumber}: ${w}`));
    console.log(`[smagning] Bon ${bonNumber} oprettet til activity #${activityId} (${lines.length} linjer)`);

    return {
        created: true,
        bonId,
        bonNumber,
        warning: warnings.length ? warnings.join(' ') : undefined,
        lineCount: lines.length,
    };
}

module.exports = { createSmagningBon, readMenu, resolveBonStatus };
