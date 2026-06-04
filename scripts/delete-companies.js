/**
 * delete-companies.js — Slet specifikke firmaer ID-for-ID (kuraterede dubletter/events)
 *
 * Følger op på scripts/audit-shared-cvr.js. Sletter KUN de ID'er du eksplicit
 * angiver, og NÆGTER at slette et firma der har reelle data (bons, tilbud,
 * kunder eller booking-tokens) — sådan kan en post der har fået en bon siden
 * audit'en ikke slettes ved en fejl.
 *
 * Dry-run som standard. Tilføj --apply for at udføre (tager backup først).
 *
 * Brug:
 *   node --experimental-sqlite scripts/delete-companies.js --ids=2862,2879,2915,3193,3204,3228
 *   node --experimental-sqlite scripts/delete-companies.js --ids=2862,2879 --apply
 */

const fs = require('fs');
const path = require('path');
const { openDb, transaction } = require('../db/compat');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const getArg = (n) => {
    const a = args.find(a => a.startsWith(`--${n}=`));
    return a ? a.split('=').slice(1).join('=') : null;
};

const DB_PATH = process.env.DB_PATH
    ? path.resolve(process.env.DB_PATH)
    : path.join(__dirname, '..', 'data', 'bon.db');

const idsRaw = getArg('ids');
if (!idsRaw) {
    console.error('Angiv --ids=2862,2879,...  (kommasepareret liste af firma-id\'er)');
    process.exit(1);
}
const ids = idsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
if (!ids.length) {
    console.error('Ingen gyldige id\'er i --ids.');
    process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
    console.error(`DB ikke fundet: ${DB_PATH}`);
    process.exit(1);
}

const db = openDb(DB_PATH);
const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// ── Hard-data-tjek: en spærre der ALDRIG må slettes hvis sand ──
function hardData(id) {
    const q = (sql, ...p) => { try { return db.prepare(sql).get(...p)?.n ?? 0; } catch { return 0; } };
    const bons      = q('SELECT COUNT(*) n FROM bons WHERE company_id=? AND COALESCE(is_offer,0)=0', id);
    const tilbud    = q('SELECT COUNT(*) n FROM bons WHERE company_id=? AND is_offer=1', id);
    const customers = q('SELECT COUNT(*) n FROM customers WHERE company_id=?', id);
    const tokens    = hasTable('booking_tokens') ? q('SELECT COUNT(*) n FROM booking_tokens WHERE company_id=?', id) : 0;
    return { bons, tilbud, customers, tokens, total: bons + tilbud + customers + tokens };
}

// ── Bløde rækker der ryddes sammen med firmaet (undgår forældreløse) ──
function softCounts(id) {
    const q = (sql, ...p) => { try { return db.prepare(sql).get(...p)?.n ?? 0; } catch { return 0; } };
    return {
        contact_points: hasTable('contact_points') ? q("SELECT COUNT(*) n FROM contact_points WHERE entity_type='company' AND entity_id=?", id) : 0,
        entity_flags:   hasTable('entity_flags')    ? q("SELECT COUNT(*) n FROM entity_flags WHERE entity_type='company' AND entity_id=?", id) : 0,
        campaign:       hasTable('campaign_members')? q('SELECT COUNT(*) n FROM campaign_members WHERE company_id=?', id) : 0,
        attachments:    hasTable('attachments')     ? q("SELECT COUNT(*) n FROM attachments WHERE entity_type='company' AND entity_id=?", id) : 0,
        custom_values:  hasTable('crm_custom_values')? q("SELECT COUNT(*) n FROM crm_custom_values WHERE entity_type='company' AND entity_id=?", id) : 0,
        rfm:            hasTable('rfm_scores')       ? q('SELECT COUNT(*) n FROM rfm_scores WHERE company_id=?', id) : 0,
    };
}

// ── Saml plan ──
const plan = [];
const blocked = [];
for (const id of ids) {
    const co = db.prepare('SELECT id, name, cvr FROM companies WHERE id=?').get(id);
    if (!co) { console.log(`  id:${id} — findes ikke, springes over`); continue; }
    const hard = hardData(id);
    if (hard.total > 0) {
        blocked.push({ co, hard });
    } else {
        plan.push({ co, soft: softCounts(id) });
    }
}

console.log(`\n══ Slet-plan (${apply ? 'APPLY' : 'DRY-RUN'}) ══\n`);

if (blocked.length) {
    console.log('⛔ SPÆRRET — har reelle data, slettes IKKE (merge dem i stedet):');
    for (const b of blocked) {
        const d = [];
        if (b.hard.bons) d.push(`${b.hard.bons} bons`);
        if (b.hard.tilbud) d.push(`${b.hard.tilbud} tilbud`);
        if (b.hard.customers) d.push(`${b.hard.customers} kunder`);
        if (b.hard.tokens) d.push(`${b.hard.tokens} booking-tokens`);
        console.log(`  id:${b.co.id} "${b.co.name}" → ${d.join(', ')}`);
    }
    console.log('');
}

console.log('🗑 SLETTES (firma + tilknyttede bløde rækker):');
if (!plan.length) console.log('  (ingen)');
for (const p of plan) {
    const s = p.soft;
    const bits = Object.entries(s).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
    console.log(`  id:${p.co.id} "${p.co.name}"${bits.length ? '  (+ ' + bits.join(', ') + ')' : ''}`);
}

if (!apply) {
    console.log(`\n→ Dry-run. Ville slette ${plan.length} firma(er). Kør igen med --apply for at udføre.\n`);
    process.exit(0);
}

if (!plan.length) {
    console.log('\nIntet at slette.\n');
    process.exit(0);
}

// ── Backup + udfør ──
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${DB_PATH}.pre-delete-companies-${ts}`;
fs.copyFileSync(DB_PATH, backup);
console.log(`\nBackup: ${backup}`);

let deleted = 0;
transaction(db, () => {
    for (const p of plan) {
        const id = p.co.id;
        // Re-tjek hard-data inde i transaktionen (defensivt)
        if (hardData(id).total > 0) {
            console.log(`  id:${id} fik reelle data — springes over`);
            continue;
        }
        if (hasTable('contact_points'))    db.prepare("DELETE FROM contact_points WHERE entity_type='company' AND entity_id=?").run(id);
        if (hasTable('entity_flags'))      db.prepare("DELETE FROM entity_flags WHERE entity_type='company' AND entity_id=?").run(id);
        if (hasTable('campaign_members'))  db.prepare('DELETE FROM campaign_members WHERE company_id=?').run(id);
        if (hasTable('attachments'))       db.prepare("DELETE FROM attachments WHERE entity_type='company' AND entity_id=?").run(id);
        if (hasTable('crm_custom_values')) db.prepare("DELETE FROM crm_custom_values WHERE entity_type='company' AND entity_id=?").run(id);
        if (hasTable('rfm_scores'))        db.prepare('DELETE FROM rfm_scores WHERE company_id=?').run(id);
        db.prepare('DELETE FROM companies WHERE id=?').run(id);
        deleted++;
        console.log(`  ✓ slettet id:${id} "${p.co.name}"`);
    }
});

console.log(`\n✓ Færdig. ${deleted} firma(er) slettet. Backup: ${backup}\n`);
