/**
 * services/internalIdentity.js
 * ════════════════════════════════════════════════════════════
 * Ét sted der svarer på: "er denne mailadresse os selv?"
 *
 * Baggrunden er konkret. `info@ristetrug.dk` ligger i customers-tabellen som
 * kunde 3005 under firmaet Ristet Rug — huset er altså sin egen kunde. Da Anne
 * videresendte en kundemail til kontakt@, matchede inbound-routingen derfor
 * afsenderen mod OS SELV, og korrespondancen med kunden endte som en tråd på
 * Ristet Rug. Se migration 142.
 *
 * To uafhængige signaler, fordi de dækker hver sit behov:
 *
 *   1. `internal_mail_domains` (setting, CSV) — adresser der aldrig er kunder.
 *      Entries kan være et helt domæne (`ristetrug.dk`) eller én adresse
 *      (`bogholder@partner.dk`). Redigeres i Settings → Mail.
 *
 *   2. `companies.is_internal = 1` — firmaer der allerede er markeret interne i
 *      CRM'et (kolonnen bruges i forvejen til at holde huset ude af rapporter
 *      og kundelister). Markerer man et firma internt dér, følger mail-routingen
 *      med af sig selv.
 *
 * Cachet i 60s som resten af settings-læserne. Rydes eksplicit når settingen
 * ændres (routes/settings.js), så et gem slår igennem med det samme.
 * ════════════════════════════════════════════════════════════
 */

const CACHE_MS = 60_000;

let _domainCache = null;
let _domainCacheUntil = 0;
let _companyCache = null;
let _companyCacheUntil = 0;

/** Normalisér ét listeelement: trim, lowercase, drop et evt. indledende '@'. */
function _normEntry(raw) {
    const v = String(raw || '').trim().toLowerCase().replace(/^@/, '');
    return v || null;
}

/**
 * Interne domæner/adresser fra settings. Falder tilbage til `mail_domain` hvis
 * settingen mangler — så en database der ikke har kørt migration 142 (fx en
 * ældre kopi brugt i test) stadig beskytter vores eget domæne.
 */
function getInternalEntries(db) {
    const now = Date.now();
    if (_domainCache && now < _domainCacheUntil) return _domainCache;

    const row = db.prepare(`SELECT value FROM settings WHERE key = 'internal_mail_domains'`).get();
    let raw = row?.value;
    if (!raw || !String(raw).trim()) {
        raw = db.prepare(`SELECT value FROM settings WHERE key = 'mail_domain'`).get()?.value || '';
    }

    const entries = String(raw)
        .split(/[,;\s]+/)
        .map(_normEntry)
        .filter(Boolean);

    _domainCache = entries;
    _domainCacheUntil = now + CACHE_MS;
    return entries;
}

/** Emails på kunder der hører til et firma markeret `is_internal = 1`. */
function _getInternalCompanyEmails(db) {
    const now = Date.now();
    if (_companyCache && now < _companyCacheUntil) return _companyCache;

    const set = new Set();
    // Både kundernes cache-felt og de autoritative kontaktpunkter — en intern
    // kollega kan sagtens have flere adresser registreret.
    for (const r of db.prepare(`
        SELECT LOWER(TRIM(c.email)) AS email
          FROM customers c JOIN companies co ON co.id = c.company_id
         WHERE co.is_internal = 1 AND c.email IS NOT NULL AND TRIM(c.email) <> ''
    `).all()) if (r.email) set.add(r.email);

    for (const r of db.prepare(`
        SELECT LOWER(TRIM(cp.value)) AS email
          FROM contact_points cp
          JOIN customers c  ON c.id  = cp.entity_id AND cp.entity_type = 'customer'
          JOIN companies co ON co.id = c.company_id
         WHERE co.is_internal = 1 AND cp.kind = 'email' AND cp.is_active = 1
    `).all()) if (r.email) set.add(r.email);

    _companyCache = set;
    _companyCacheUntil = now + CACHE_MS;
    return set;
}

/**
 * Er adressen vores egen (eller på anden vis intern)?
 * Tom/ugyldig adresse → false; vi gætter ikke.
 */
function isInternalEmail(db, email) {
    const e = String(email || '').trim().toLowerCase();
    if (!e || !e.includes('@')) return false;

    const domain = e.split('@')[1];
    for (const entry of getInternalEntries(db)) {
        if (entry.includes('@')) {
            if (entry === e) return true;                  // præcis adresse
        } else if (domain === entry || domain.endsWith('.' + entry)) {
            return true;                                   // domæne + subdomæner
        }
    }

    return _getInternalCompanyEmails(db).has(e);
}

function invalidateInternalCache() {
    _domainCache = null;
    _domainCacheUntil = 0;
    _companyCache = null;
    _companyCacheUntil = 0;
}

module.exports = { isInternalEmail, getInternalEntries, invalidateInternalCache };
