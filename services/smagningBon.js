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
        status_code: 'NY',
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

    if (warning) console.warn(`[smagning] bon ${bonNumber}: ${warning}`);
    console.log(`[smagning] Bon ${bonNumber} oprettet til activity #${activityId} (${lines.length} linjer)`);

    return { created: true, bonId, bonNumber, warning: warning || undefined, lineCount: lines.length };
}

module.exports = { createSmagningBon, readMenu };
