/**
 * services/invoiceGuard.js
 * ════════════════════════════════════════════════════════════
 * Fakturavagt (#319).
 *
 * En bon kan markeres FAKTURERET/AFSLUTTET i hånden uden at der nogensinde blev
 * lavet en faktura. Bonnen forlader faktureringskøen, kunden får aldrig en
 * regning, og beløbet gemmer sig under "Forfaldne" som en dårlig betaler.
 * Intet sted mødtes de to sandheder ("markeret faktureret" og "faktura findes").
 *
 * Vagten har to ansigter — samme regel begge steder, så de aldrig kan divergere:
 *   1. bonMissingInvoice()  — spørges i øjeblikket ved status-skift (409-gate)
 *   2. missingInvoiceSQL()  — udleder mærket i lister/detaljer
 *
 * Mærket er BEVIDST udledt, ikke gemt: der er intet at rydde op i, og det
 * forsvinder af sig selv i samme øjeblik en kladde eller bogført faktura dukker
 * op — uanset rækkefølgen handlingerne blev udført i.
 *
 * Fire filtre holder den fri for falske alarmer:
 *   • Betalingstype: kun 'invoice'. Modregning/sponsorat/kontant/POS skal
 *     aldrig have en faktura (jf. migration 129).
 *   • Tilbud/interne bons: aldrig.
 *   • Skæringsdato (settings.invoice_guard_from_date): historiske bons fra før
 *     e-conomic-rutinen vurderes ikke — ellers ville vagten lyse på alt.
 *     Mangler den, er tom eller ugyldig, bruges GUARD_DEFAULT_FROM_DATE.
 *     Sættes den for tidligt, drukner vagten i v1-historik: målt på driftsdata
 *     giver 2026-06-27 én bon, 2026-01-01 et par hundrede, og ingen grænse 2.762
 *     helt tilbage til 2022. De gamle er betalt for længst — de har bare aldrig
 *     haft et e-conomic-nummer i Bon v2.
 *   • e-conomic konfigureret: uden tokens findes der ingen kladder at finde.
 * ════════════════════════════════════════════════════════════
 */

const eco = require('./economicAdapter');

const GUARDED_STATUSES = ['FAKTURERET', 'AFSLUTTET'];

// Samme dato som migration 130 seeder: dagen den første e-conomic-kladde blev
// oprettet fra Bon v2. Bruges som FALDSKÆRM når settingen mangler, er tom eller
// har et format vi ikke kan tolke.
//
// Hvorfor en faldskærm og ikke "ingen grænse": en tom skæringsdato betyder ikke
// "vurdér alt" — det betyder "ingen har taget stilling". Uden grænse lyser vagten
// på hele v1-historikken (målt på driftsdata: 1 bon → 2.762, helt tilbage til
// 2022), og så holder man op med at se den. Det er præcis den død migration 130
// beskriver. Fravær af konfiguration skal give det sikre svar, ikke det larmende.
const GUARD_DEFAULT_FROM_DATE = '2026-06-27';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Er strengen en brugbar ISO-dato (YYYY-MM-DD)? Bruges også af PATCH-valideringen. */
function isValidGuardDate(val) {
    if (typeof val !== 'string' || !ISO_DATE_RE.test(val)) return false;
    const d = new Date(`${val}T00:00:00Z`);
    // Fanger 2026-02-31 og lignende: Date normaliserer dem til en anden dag.
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === val; // utc-ok: ren format-validering af en ISO-streng, ikke "i dag"
}

let _fromDateCache = null;
let _fromDateCacheUntil = 0;

function getGuardFromDate(db) {
    const now = Date.now();
    if (_fromDateCache !== null && now < _fromDateCacheUntil) return _fromDateCache;
    let val = null;
    try {
        const row = db.prepare(`SELECT value FROM settings WHERE key = 'invoice_guard_from_date'`).get();
        val = row?.value || null;
    } catch { val = null; }
    if (!isValidGuardDate(val)) val = GUARD_DEFAULT_FROM_DATE;
    _fromDateCache = val;
    _fromDateCacheUntil = now + 60_000;
    return val;
}

function invalidateGuardCache() {
    _fromDateCache = null;
    _fromDateCacheUntil = 0;
}

/**
 * Mangler denne bon en faktura? Bruges som gate ved status-skift.
 * Returnerer { missing, reason, bon_number } — reason forklarer hvorfor vagten
 * IKKE slog til, hvilket gør den nem at fejlsøge fra et 409-svar.
 */
function bonMissingInvoice(db, bonId) {
    const b = db.prepare(`
        SELECT b.id, b.bon_number, b.payment_type, b.economic_draft_number, b.delivery_date,
               COALESCE(b.is_offer, 0) AS is_offer, COALESCE(b.is_internal, 0) AS is_internal
        FROM bons b WHERE b.id = ?`).get(bonId);

    if (!b) return { missing: false, reason: 'bon_not_found' };
    if (b.is_offer || b.is_internal) return { missing: false, reason: 'offer_or_internal' };
    if (b.payment_type !== 'invoice') return { missing: false, reason: 'payment_type_not_invoice' };
    if (b.economic_draft_number != null) return { missing: false, reason: 'draft_exists' };
    if (!eco.isConfigured()) return { missing: false, reason: 'economic_not_configured' };

    const from = getGuardFromDate(db);
    if (!b.delivery_date || b.delivery_date < from) {
        return { missing: false, reason: 'before_guard_date' };
    }

    const booked = db.prepare(
        `SELECT 1 FROM cf_invoices WHERE bon_id = ? AND economic_number IS NOT NULL LIMIT 1`
    ).get(bonId);
    if (booked) return { missing: false, reason: 'booked_invoice_exists' };

    return { missing: true, reason: 'no_draft_no_booked_invoice', bon_number: b.bon_number };
}

/**
 * SQL-udtryk (0/1) til lister — samme regel som bonMissingInvoice.
 * Returnerer '0' når vagten er inaktiv, så kaldere altid kan interpolere den.
 * bonAlias/statusAlias gør den brugbar i de forskellige list-queries.
 */
function missingInvoiceSQL(db, bonAlias = 'b', statusAlias = 'sd') {
    if (!eco.isConfigured()) return '0';
    // getGuardFromDate() garanterer en gyldig YYYY-MM-DD (falder tilbage på
    // GUARD_DEFAULT_FROM_DATE) — derfor er der altid et dato-led, og strengen
    // kan ikke bære citationstegn ind i SQL'en.
    const dateClause = ` AND ${bonAlias}.delivery_date >= '${getGuardFromDate(db)}'`;
    return `CASE WHEN ${statusAlias}.code IN (${GUARDED_STATUSES.map(s => `'${s}'`).join(', ')})
                  AND ${bonAlias}.payment_type = 'invoice'
                  AND COALESCE(${bonAlias}.is_offer, 0) = 0
                  AND COALESCE(${bonAlias}.is_internal, 0) = 0
                  AND ${bonAlias}.economic_draft_number IS NULL${dateClause}
                  AND NOT EXISTS (SELECT 1 FROM cf_invoices ci
                                   WHERE ci.bon_id = ${bonAlias}.id AND ci.economic_number IS NOT NULL)
             THEN 1 ELSE 0 END`;
}

module.exports = {
    GUARDED_STATUSES,
    GUARD_DEFAULT_FROM_DATE,
    isValidGuardDate,
    bonMissingInvoice,
    missingInvoiceSQL,
    getGuardFromDate,
    invalidateGuardCache,
};
