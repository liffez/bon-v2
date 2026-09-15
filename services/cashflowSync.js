/**
 * services/cashflowSync.js
 * ════════════════════════════════════════════════════════════
 * Holder cf_invoices i sync med bons-status. Kaldes fra
 * routes/bons.js efter status-skift og PATCH af invoice_info.
 *
 * Regler:
 *   - Kun bons med payment_type = 'invoice' kommer i cf_invoices.
 *     Kontant/kort/MobilePay/POS er allerede betalt på dagen — de er
 *     ikke kreditfakturaer der venter på bankoverførsel.
 *   - Tilbud (is_offer=1) og interne bons (is_internal=1) springes over.
 *   - Bons med total_price ≤ 0 springes over.
 *   - FAKTURERET / AFSLUTTET → opret/opdater cf_invoice (betalt=0 ved oprettelse).
 *   - BETALT                 → opret/opdater (betalt=1, betalt_dato=delivery_date).
 *   - En cf_invoice der allerede står betalt (bank-match / e-conomic-synk) rulles
 *     ALDRIG tilbage af en bon-opdatering. Bon-status kan kun flytte betalt OP.
 *     Før nulstillede enhver PATCH af en FAKTURERET bon (fx delivery_price) et
 *     bank-bekræftet betalt-flag — og fakturaen dukkede op som udestående igen.
 *   - Har fakturaen et e-conomic-nummer, er beløbet e-conomics (reconcile retter
 *     det til fakturaens bruttobeløb) og overskrives ikke fra bonens total.
 *   - AFLYST                 → slet cf_invoice (kun hvis ikke betalt).
 *   - Tilbagerul fra FAKTURERET (status < FAKTURERET) → slet cf_invoice
 *     (kun hvis ikke betalt).
 *
 * Faktura-ID-strategi:
 *   id = fakturanummer parset ud af invoice_info hvis findes, ellers
 *   bon_number ("B4053") som placeholder (eller "B"+id hvis bon_number mangler).
 *   Hvis brugeren indtaster fakturanummer
 *   senere, opdateres både cf_invoices.id og cf_transactions.matched_invoice_id
 *   i samme transaction.
 *
 * Helperen er idempotent: gentagne kald med samme state → ingen ændring.
 * ════════════════════════════════════════════════════════════
 */

const { transaction } = require('../db/compat');

// Status-koder der er "fakturerbare" — udløser oprettelse i cf_invoices.
const INVOICED_STATUSES = new Set(['FAKTURERET', 'AFSLUTTET', 'BETALT']);

/**
 * Parse fakturanummer ud af invoice_info (fri tekst).
 * Format: "Fakturanr: F-2026-0042" — case-insensitivt, accepterer både
 * "Fakturanr", "Faktura nr", "Faktura nr.", "Faktura #".
 * Returnerer null hvis intet match.
 */
function parseInvoiceNumber(invoiceInfo) {
    if (!invoiceInfo || typeof invoiceInfo !== 'string') return null;
    const m = invoiceInfo.match(/faktura(?:nr|\s*nr|\s*#)\.?\s*:?\s*([A-Z0-9][A-Z0-9\-_/]{1,30})/i);
    return m ? m[1].trim() : null;
}

/**
 * Hent default betalingsfrist (dage). Default 14 hvis setting mangler.
 */
function getDefaultTermsDays(db) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'cf_default_invoice_terms_days'`).get();
    const n = parseInt(row?.value, 10);
    return Number.isFinite(n) && n > 0 ? n : 14;
}

/**
 * Beregn forfaldsdato som ISO date (YYYY-MM-DD).
 */
function computeDueDate(deliveryDate, termsDays) {
    if (!deliveryDate) return null;
    const d = new Date(deliveryDate + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + termsDays);
    return d.toISOString().slice(0, 10);
}

/**
 * Antal dage hvor en FAKTURERET/AFSLUTTET-bon med delivery_date ældre
 * end dette antages betalt. 0 = deaktiveret.
 */
function getAssumePaidDays(db) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = 'cf_assume_paid_after_days'`).get();
    const n = parseInt(row?.value, 10);
    return Number.isFinite(n) && n >= 0 ? n : 90;
}

/**
 * Returnerer true hvis delivery_date er ældre end thresholdDays dage.
 */
function isBeyondAssumePaidThreshold(deliveryDate, thresholdDays) {
    if (!deliveryDate || thresholdDays <= 0) return false;
    const d = new Date(deliveryDate + 'T00:00:00Z');
    if (isNaN(d.getTime())) return false;
    const cutoff = new Date(Date.now() - thresholdDays * 86400000);
    return d < cutoff;
}

/**
 * Hent fuld bon-info inkl. kunde/firma-navn og status-kode.
 */
function loadBonForSync(db, bonId) {
    return db.prepare(`
        SELECT
            b.id,
            b.bon_number,
            b.delivery_date,
            b.total_price,
            b.total_with_delivery,
            b.payment_type,
            b.invoice_info,
            b.is_offer,
            b.is_internal,
            sd.code AS status_code,
            CASE
                WHEN co.name IS NOT NULL AND co.name != '' THEN co.name
                ELSE COALESCE(NULLIF(TRIM(cu.first_name || ' ' || COALESCE(cu.last_name, '')), ''), 'Ukendt kunde')
            END AS kunde_navn
        FROM bons b
        LEFT JOIN status_definitions sd ON b.status_id = sd.id
        LEFT JOIN customers cu ON b.customer_id = cu.id
        LEFT JOIN companies co ON b.company_id = co.id
        WHERE b.id = ?
    `).get(bonId);
}

/**
 * Find eksisterende cf_invoice for en bon (kan være null).
 */
function findInvoiceByBonId(db, bonId) {
    return db.prepare(`SELECT * FROM cf_invoices WHERE bon_id = ?`).get(bonId);
}

/**
 * Beslut hvilken id en cf_invoice skal have for en given bon.
 * Fakturanummer fra invoice_info hvis findes, ellers placeholder.
 */
function computeInvoiceId(bon) {
    const parsed = parseInvoiceNumber(bon.invoice_info);
    if (parsed) return parsed;
    return (bon.bon_number ? String(bon.bon_number) : `B${bon.id}`);
}

/**
 * UPDATE cf_invoices.id (skifter placeholder → rigtigt fakturanr eller
 * mellem to fakturanre). Opdaterer også matched_invoice_id på alle
 * cf_transactions så match-links bevares. Skal kaldes i transaction.
 *
 * Returnerer true hvis id blev skiftet, false hvis newId allerede er i brug
 * af en anden cf_invoice (konflikt — behold den gamle).
 */
function renameInvoiceId(db, oldId, newId) {
    if (oldId === newId) return true;
    const conflict = db.prepare(`SELECT 1 FROM cf_invoices WHERE id = ?`).get(newId);
    if (conflict) return false;
    // FK fra cf_transactions.matched_invoice_id forhindrer både direkte
    // UPDATE af cf_invoices.id og forhåndsopdatering af FK-kolonnen. Vi
    // kopierer rækken under nyt id, omdirigerer match-links og sletter
    // til sidst det gamle id. Alt sker i samme transaction.
    db.prepare(`
        INSERT INTO cf_invoices (id, bon_id, kunde, beloeb, forfald, betalt, betalt_dato, betalingstype, noter, created_at)
        SELECT ?, bon_id, kunde, beloeb, forfald, betalt, betalt_dato, betalingstype, noter, created_at
        FROM cf_invoices WHERE id = ?
    `).run(newId, oldId);
    db.prepare(`UPDATE cf_transactions SET matched_invoice_id = ? WHERE matched_invoice_id = ?`).run(newId, oldId);
    db.prepare(`DELETE FROM cf_invoices WHERE id = ?`).run(oldId);
    return true;
}

/**
 * Slet cf_invoice — kun hvis ikke betalt. Returnerer true hvis slettet.
 */
function deleteIfUnpaid(db, invoice) {
    if (!invoice) return false;
    if (invoice.betalt) return false;
    db.prepare(`UPDATE cf_transactions SET matched_invoice_id = NULL, match_confidence = 0 WHERE matched_invoice_id = ?`).run(invoice.id);
    db.prepare(`DELETE FROM cf_invoices WHERE id = ?`).run(invoice.id);
    return true;
}

/**
 * Hovedfunktion: synkroniser cf_invoices for en given bon.
 *
 * @returns {Object} { action: 'created'|'updated'|'deleted'|'renamed'|'skipped', invoice_id?: string, reason?: string }
 */
function syncCashflowInvoice(db, bonId) {
    const bon = loadBonForSync(db, bonId);
    if (!bon) return { action: 'skipped', reason: 'bon_not_found' };

    const existing = findInvoiceByBonId(db, bonId);

    // Bons der aldrig skal i cashflow uanset status.
    if (bon.is_offer === 1 || bon.is_internal === 1) {
        if (existing) {
            return transaction(db, () => {
                const deleted = deleteIfUnpaid(db, existing);
                return deleted
                    ? { action: 'deleted', invoice_id: existing.id, reason: 'is_offer_or_internal' }
                    : { action: 'skipped', reason: 'cannot_delete_paid_invoice' };
            });
        }
        return { action: 'skipped', reason: 'is_offer_or_internal' };
    }

    if (bon.payment_type !== 'invoice') {
        if (existing) {
            return transaction(db, () => {
                const deleted = deleteIfUnpaid(db, existing);
                return deleted
                    ? { action: 'deleted', invoice_id: existing.id, reason: 'payment_type_changed_from_invoice' }
                    : { action: 'skipped', reason: 'cannot_delete_paid_invoice' };
            });
        }
        return { action: 'skipped', reason: 'payment_type_not_invoice' };
    }

    // Status driver handling.
    if (bon.status_code === 'AFLYST') {
        if (existing) {
            return transaction(db, () => {
                const deleted = deleteIfUnpaid(db, existing);
                return deleted
                    ? { action: 'deleted', invoice_id: existing.id, reason: 'bon_cancelled' }
                    : { action: 'skipped', reason: 'cannot_delete_paid_invoice' };
            });
        }
        return { action: 'skipped', reason: 'bon_cancelled_no_invoice' };
    }

    if (!INVOICED_STATUSES.has(bon.status_code)) {
        // Status er rullet tilbage før FAKTURERET — fjern auto-genereret
        // cf_invoice hvis den ikke er betalt.
        if (existing) {
            return transaction(db, () => {
                const deleted = deleteIfUnpaid(db, existing);
                return deleted
                    ? { action: 'deleted', invoice_id: existing.id, reason: 'status_rolled_back' }
                    : { action: 'skipped', reason: 'cannot_delete_paid_invoice' };
            });
        }
        return { action: 'skipped', reason: 'status_not_invoiced' };
    }

    const amount = bon.total_with_delivery ?? bon.total_price ?? 0;
    if (!(amount > 0)) {
        return { action: 'skipped', reason: 'zero_amount' };
    }

    const termsDays = getDefaultTermsDays(db);
    const dueDate = computeDueDate(bon.delivery_date, termsDays);
    if (!dueDate) return { action: 'skipped', reason: 'invalid_delivery_date' };

    const targetId = computeInvoiceId(bon);

    // Betalingsstatus: BETALT-status er autoritativ. Ellers tjek om bonen
    // er ældre end "antaget betalt"-thresholdet — så markerer vi automatisk
    // (typisk for historiske FAKTURERET-bons hvor brugeren aldrig flyttede
    // status til BETALT). betalt_dato = delivery_date som bedste estimat.
    let isPaid = 0;
    let paidDate = null;
    if (bon.status_code === 'BETALT') {
        isPaid = 1;
        paidDate = bon.delivery_date;
    } else {
        const assumeDays = getAssumePaidDays(db);
        if (isBeyondAssumePaidThreshold(bon.delivery_date, assumeDays)) {
            isPaid = 1;
            paidDate = bon.delivery_date;
        }
    }

    return transaction(db, () => {
        if (!existing) {
            // Hvis target-id allerede er brugt af manuel cf_invoice (uden bon_id)
            // → tilføj suffix så vi ikke kollapser to fakturaer.
            let finalId = targetId;
            const clash = db.prepare(`SELECT bon_id FROM cf_invoices WHERE id = ?`).get(finalId);
            if (clash) {
                finalId = (bon.bon_number ? String(bon.bon_number) : `B${bon.id}`);
                const clash2 = db.prepare(`SELECT 1 FROM cf_invoices WHERE id = ?`).get(finalId);
                if (clash2) {
                    return { action: 'skipped', reason: 'id_conflict', invoice_id: targetId };
                }
            }
            db.prepare(`
                INSERT INTO cf_invoices (id, bon_id, kunde, beloeb, forfald, betalt, betalt_dato, betalingstype, noter)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'bank', ?)
            `).run(
                finalId, bonId, bon.kunde_navn, amount, dueDate, isPaid, paidDate,
                `Auto-oprettet fra bon #${bon.bon_number ?? bon.id}`
            );
            return { action: 'created', invoice_id: finalId };
        }

        // Eksisterende: opdater felter + evt. id-rename.
        let invoiceId = existing.id;
        if (existing.id !== targetId) {
            const renamed = renameInvoiceId(db, existing.id, targetId);
            if (renamed) invoiceId = targetId;
        }

        // Betalt kan kun gå OP herfra. Et betalt-flag sat af bank-match eller
        // e-conomic-synk overlever, at bonen bliver rettet bagefter.
        const keepPaid = existing.betalt === 1;
        const nextPaid = keepPaid ? 1 : isPaid;
        const nextPaidDate = keepPaid ? (existing.betalt_dato ?? paidDate) : paidDate;
        // Bogført i e-conomic ⇒ beløbet er fakturaens, ikke bonens.
        const nextAmount = existing.economic_number ? existing.beloeb : amount;
        db.prepare(`
            UPDATE cf_invoices
            SET kunde = ?, beloeb = ?, forfald = ?, betalt = ?, betalt_dato = ?
            WHERE id = ?
        `).run(bon.kunde_navn, nextAmount, dueDate, nextPaid, nextPaidDate, invoiceId);

        return {
            action: invoiceId !== existing.id ? 'renamed' : 'updated',
            invoice_id: invoiceId,
            previous_id: existing.id !== invoiceId ? existing.id : undefined
        };
    });
}

module.exports = {
    syncCashflowInvoice,
    parseInvoiceNumber,
    computeDueDate,
    getAssumePaidDays,
    isBeyondAssumePaidThreshold,
    INVOICED_STATUSES
};
