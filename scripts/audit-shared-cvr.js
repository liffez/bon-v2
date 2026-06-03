/**
 * audit-shared-cvr.js — READ-ONLY kortlægning af firmaer der deler samme CVR
 *
 * Finder firmaer der (fejlagtigt) deler ét CVR — typisk interne events/dubletter
 * der har arvet hovedfirmaets CVR. Viser hvad der hænger fast i hver post, så vi
 * kan beslutte: SLET (tom) eller SAMMENLÆG ind i hovedfirmaet (har data).
 *
 * SKRIVER ALDRIG NOGET. Kun rapport.
 *
 * Brug:
 *   node --experimental-sqlite scripts/audit-shared-cvr.js                 # default CVR 40140255
 *   node --experimental-sqlite scripts/audit-shared-cvr.js --cvr=40140255
 *   node --experimental-sqlite scripts/audit-shared-cvr.js --cvr=40140255 --keep=2539
 *
 * --keep = id på det firma der SKAL beholdes (hovedfirmaet). Udelades det,
 *          vælges firmaet med flest bons automatisk.
 */

const path = require('path');
const { openDb } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);

const args = process.argv.slice(2);
const getArg = (n) => {
    const a = args.find(a => a.startsWith(`--${n}=`));
    return a ? a.split('=').slice(1).join('=') : null;
};

const cvr = (getArg('cvr') || '40140255').replace(/\D/g, '');
let keepId = getArg('keep') ? parseInt(getArg('keep'), 10) : null;

if (!/^\d{8}$/.test(cvr)) {
    console.error('Ugyldigt CVR. Brug --cvr=12345678');
    process.exit(1);
}

// ── Afhængigheds-tællere (kun tabeller der findes i denne DB) ──
const hasTable = (t) => !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
).get(t);

function countFor(companyId) {
    const c = { };
    const q = (sql, ...p) => { try { return db.prepare(sql).get(...p)?.n ?? 0; } catch { return 0; } };

    c.bons        = q('SELECT COUNT(*) n FROM bons WHERE company_id=? AND COALESCE(is_offer,0)=0', companyId);
    c.tilbud      = q('SELECT COUNT(*) n FROM bons WHERE company_id=? AND is_offer=1', companyId);
    c.customers   = q('SELECT COUNT(*) n FROM customers WHERE company_id=?', companyId);
    c.contact_pts = hasTable('contact_points')
        ? q("SELECT COUNT(*) n FROM contact_points WHERE entity_type='company' AND entity_id=?", companyId) : 0;
    c.flags       = hasTable('entity_flags')
        ? q("SELECT COUNT(*) n FROM entity_flags WHERE entity_type='company' AND entity_id=? AND dismissed_at IS NULL", companyId) : 0;
    c.booking_tok = hasTable('booking_tokens')
        ? q('SELECT COUNT(*) n FROM booking_tokens WHERE company_id=?', companyId) : 0;
    c.campaign    = hasTable('campaign_members')
        ? q('SELECT COUNT(*) n FROM campaign_members WHERE company_id=?', companyId) : 0;
    c.attachments = hasTable('attachments')
        ? q("SELECT COUNT(*) n FROM attachments WHERE entity_type='company' AND entity_id=?", companyId) : 0;
    c.activities = hasTable('crm_activities')
        ? q("SELECT COUNT(*) n FROM crm_activities a JOIN customers cu ON cu.id=a.customer_id WHERE cu.company_id=?", companyId) : 0;

    // Distinkte email-domæner på firmaets kontaktpunkter — afslører om det
    // ligner en reel ekstern part (fremmed domæne) frem for en intern event.
    c.domains = [];
    if (hasTable('contact_points')) {
        try {
            const rows = db.prepare(`
                SELECT DISTINCT lower(substr(value, instr(value,'@')+1)) AS dom
                  FROM contact_points
                 WHERE entity_type='company' AND entity_id=? AND kind='email'
                   AND instr(value,'@')>0
            `).all(companyId);
            c.domains = rows.map(r => r.dom).filter(Boolean);
        } catch { /* ignore */ }
    }

    // "Reelle" data = noget en bruger ville miste ved sletning
    c._hard = c.bons + c.tilbud + c.customers + c.booking_tok;
    // "Bløde" data = kan flyttes eller er ligegyldigt
    c._soft = c.contact_pts + c.flags + c.campaign + c.attachments + c.activities;
    return c;
}

// ── Find alle firmaer med dette CVR ──
const companies = db.prepare(`
    SELECT id, name, cvr, legal_name, ean, created_at
      FROM companies
     WHERE REPLACE(REPLACE(cvr,' ',''),'-','') = ?
     ORDER BY id
`).all(cvr);

if (companies.length === 0) {
    console.log(`Ingen firmaer med CVR ${cvr}.`);
    process.exit(0);
}

// Auto-vælg keep = flest bons hvis ikke angivet
if (!keepId) {
    let best = null, bestBons = -1;
    for (const co of companies) {
        const b = countFor(co.id).bons;
        if (b > bestBons) { bestBons = b; best = co.id; }
    }
    keepId = best;
}

const keep = companies.find(c => c.id === keepId);

console.log(`\n══ Firmaer med CVR ${cvr} ══`);
console.log(`Antal: ${companies.length}   Beholdes (--keep): id:${keepId} "${keep?.name ?? '??'}"\n`);

const buckets = { keep: [], empty: [], soft: [], hard: [] };

for (const co of companies) {
    const c = countFor(co.id);
    const parts = [];
    if (c.bons)        parts.push(`${c.bons} bons`);
    if (c.tilbud)      parts.push(`${c.tilbud} tilbud`);
    if (c.customers)   parts.push(`${c.customers} kunder`);
    if (c.booking_tok) parts.push(`${c.booking_tok} booking-tokens`);
    if (c.contact_pts) parts.push(`${c.contact_pts} kontaktpkt`);
    if (c.activities)  parts.push(`${c.activities} aktiviteter`);
    if (c.flags)       parts.push(`${c.flags} flag`);
    if (c.campaign)    parts.push(`${c.campaign} kampagne`);
    if (c.attachments) parts.push(`${c.attachments} vedhæft`);

    let bucket;
    if (co.id === keepId)      bucket = 'keep';
    else if (c._hard > 0)      bucket = 'hard';
    else if (c._soft > 0)      bucket = 'soft';
    else                       bucket = 'empty';
    buckets[bucket].push({ co, c, summary: parts.join(', ') || 'tom' });
}

// Domæner der IKKE er Ristet Rugs egne — et fremmed domæne kan tyde på en
// reel ekstern part, der bør gennemgås ekstra grundigt før sletning.
const ownDomain = (d) => /ristetrug\.dk$/i.test(d);

const line = (b) => {
    const co = b.co;
    const created = co.created_at ? String(co.created_at).slice(0, 10) : '—';
    const ean = co.ean ? ` EAN:${co.ean}` : '';
    const foreign = (b.c.domains || []).filter(d => !ownDomain(d));
    const flagExt = foreign.length ? `  ⚠ fremmed domæne: ${foreign.join(', ')}` : '';
    return `  id:${String(co.id).padEnd(5)} oprettet ${created}${ean}  "${co.name}"\n        → ${b.summary}${flagExt}`;
};

console.log('── BEHOLD (hovedfirma) ──');
buckets.keep.forEach(b => console.log(line(b)));

console.log('\n── GENNEMGÅ: TOM (ingen data overhovedet) — typisk sikker at slette ──');
if (!buckets.empty.length) console.log('  (ingen)');
buckets.empty.forEach(b => console.log(line(b)));

console.log('\n── GENNEMGÅ: KUN BLØDE DATA (kontaktpkt/flag/kampagne/aktiviteter) — tjek ⚠ før sletning ──');
if (!buckets.soft.length) console.log('  (ingen)');
buckets.soft.forEach(b => console.log(line(b)));

console.log('\n── HAR REELLE DATA — SKAL SAMMENLÆGGES ind i hovedfirma (ALDRIG slet) ──');
if (!buckets.hard.length) console.log('  (ingen)');
buckets.hard.forEach(b => console.log(line(b)));

// Kopiér-venlig ID-liste over sletnings-KANDIDATER (du fjerner selv dem der skal blive)
const candidateIds = [...buckets.empty, ...buckets.soft].map(b => b.co.id);

console.log('\n══ Opsummering ══');
console.log(`  Behold (hovedfirma):     1  (id:${keepId})`);
console.log(`  Tom:                     ${buckets.empty.length}`);
console.log(`  Kun bløde data:          ${buckets.soft.length}`);
console.log(`  Har reelle data (merge): ${buckets.hard.length}`);
console.log(`\nSletnings-kandidater (gennemgå og fjern dem der skal BLIVE):`);
console.log(`  ${candidateIds.length ? candidateIds.join(',') : '(ingen)'}`);
console.log('\n(Read-only. Intet er ændret. Ingen slettes uden at du eksplicit godkender ID-listen.)\n');
