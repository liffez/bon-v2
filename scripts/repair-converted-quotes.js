// scripts/repair-converted-quotes.js
// ============================================================
// Engangs-oprydning: giv de vundne tilbud deres bilag tilbage.
//
// ── HVAD DER SKETE ──────────────────────────────────────────────────────────
// Indtil migration 146 konverterede et ét-dags-tilbud ved at flippe `is_offer`
// fra 1 til 0 på tilbuddets EGEN række. Rækken holdt dermed op med at være et
// tilbud i samme sekund den blev en bon:
//
//   • den forsvandt fra tilbudslisten (`WHERE is_offer = 1`)
//   • den kunne aldrig vises under "Vundet" — det filter spørger på
//     `is_offer = 1 AND offer_status = 'won'`, en kombination flippet ikke
//     efterlader. Fanen var tom af konstruktion, ikke ved uheld.
//   • den faldt ud af CRM-pipelinen, som kræver `is_offer = 1` ELLER status
//     NY/VENTER — og en konverteret bon er hverken.
//
// Det vundne tilbud var altså den ene sag man bagefter ikke kunne finde. Koden
// er rettet fremadrettet (konvertering opretter nu en NY bon og lader bilaget
// blive liggende), men de rækker der allerede ER flippet retter ikke sig selv.
//
// ── HVAD SCRIPTET GØR ───────────────────────────────────────────────────────
// For hver flippet række R:
//   1. Opretter en tilbuds-række Q som kopi af R, med `is_offer = 1`,
//      `offer_status = 'won'`, låst, og — vigtigst — R's OPRINDELIGE T-nummer.
//      Det er det nummer der står på den PDF kunden har fået, så det skal
//      følge bilaget, ikke bonnen.
//   2. Giver R et almindeligt bon-nummer fra bon-serien og sætter
//      `source_quote_id = Q.id`, så de to kan findes fra hinanden.
//   3. Kopierer R's linjer til Q, så bilaget viser den aftale der blev sagt ja
//      til. R beholder sine egne linjer — den er den levende ordre.
//
// R's id røres ALDRIG. En halv snes tabeller peger på `bons(id)` (fakturaer,
// leveringer, mailtråde, vedhæftninger), og de skal blive ved med at pege på
// ordren. Derfor er det bilaget der oprettes som ny række — ikke bonnen.
//
// ── HVORFOR OMNUMMERERING ER DET FARLIGE SKRIDT ─────────────────────────────
// `bons.bon_number` er UNIQUE, så T-nummeret kan ikke stå to steder: enten
// beholder bonnen det (og bilaget må hedde noget andet end det kunden har set
// — ubrugeligt), eller også flytter det med bilaget. Derfor omnummereres
// bonnen. Bon-nummeret er ikke internt: det står i mailemner (`#b-…`), på
// fakturaudkast og i e-conomic. Derfor fredes enhver bon der er nået længere
// end til aftalen:
//
//   • status FAKTURERET / BETALT / AFSLUTTET
//   • en cf_invoices-række der peger på den
//   • et e-conomic-udkast (`economic_draft_number`)
//
// De springes over og listes til sidst. Er der en af dem, er den rigtige
// beslutning at tage manuelt — ikke at lade et script gætte.
//
// ── BRUG ────────────────────────────────────────────────────────────────────
//   node --experimental-sqlite scripts/repair-converted-quotes.js
//   node --experimental-sqlite scripts/repair-converted-quotes.js --apply
//
//   --apply    skriv rigtigt (uden = dry-run, intet ændres)
//   --force    omnummerér også fakturerede/afsluttede bons (frarådes)
// ============================================================

const path = require('path');
const fs   = require('fs');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const { getDb } = require('../db/database');
const { transaction } = require('../db/compat');
const { logChange } = require('../db/helpers');

const args  = process.argv.slice(2);
const APPLY = args.includes('--apply');
const FORCE = args.includes('--force');

const FROZEN_STATUSES = ['FAKTURERET', 'BETALT', 'AFSLUTTET'];

// Felter der IKKE må følge med over på bilaget.
//
// `v1_id` er det farlige: den har et UNIQUE partial index, så en kopi ville
// afvise sig selv med en rå constraint-fejl. Resten er driftsspor der hører til
// ordren og ikke til aftalen — et tilbud har hverken trukket lager, kvitteret
// for noget eller ligget som udkast i e-conomic.
//
// De nulstilles til skemaets egen default, ikke blindt til NULL: flere af dem
// er NOT NULL DEFAULT 0, og et NULL ville blive afvist af databasen.
const RESET_ON_COPY = [
    'v1_id',
    'inventory_deducted', 'inventory_deducted_at', 'inventory_deduct_status',
    'acknowledged_at', 'acknowledged_by_user_id',
    'economic_draft_number', 'economic_draft_at',
    'prep_ingredients_ready', 'prep_supplies_ready',
];

function backupDb(db) {
    // Backuppen lægges ved siden af den database der faktisk ændres — ellers
    // kan man komme til at kigge på en backup af noget helt andet.
    const dir = path.join(path.dirname(path.resolve(process.env.DB_PATH)), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');  // utc-ok: filnavn
    const dest = path.join(dir, `bon-foer-tilbudsreparation-${stamp}.db`);
    // VACUUM INTO er WAL-sikker — en rå filkopi kan misse ucheckpointede sider.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    return dest;
}

/**
 * Kandidaterne: rækker der ligner et flippet tilbud.
 *
 * Tre betingelser skal holde samtidig, og hver især lukker en falsk positiv:
 *   `is_offer = 0` + `offer_status = 'won'`  → kun flippet kombination
 *   T-præfiks på nummeret                    → rækken blev FØDT som tilbud
 *   `source_quote_id IS NULL`                → ikke allerede en dagsbon fra et
 *                                              fler-dags-tilbud (de er i orden)
 */
function findCandidates(db) {
    const prefix = db.prepare(`SELECT value FROM settings WHERE key='quote_number_prefix'`).get()?.value ?? 'T-';
    return {
        prefix,
        rows: db.prepare(`
            SELECT b.*, sd.code AS status_code,
                   (SELECT COUNT(*) FROM cf_invoices ci WHERE ci.bon_id = b.id) AS invoice_count
              FROM bons b
              JOIN status_definitions sd ON b.status_id = sd.id
             WHERE (b.is_offer = 0 OR b.is_offer IS NULL)
               AND b.offer_status = 'won'
               AND b.source_quote_id IS NULL
               AND b.bon_number LIKE ?
             ORDER BY b.id
        `).all(prefix + '%'),
    };
}

function frozenReason(row) {
    if (FROZEN_STATUSES.includes(row.status_code)) return `status ${row.status_code}`;
    if (row.invoice_count > 0) return 'har faktura i pengestrøm';
    if (row.economic_draft_number) return `e-conomic-udkast ${row.economic_draft_number}`;
    return null;
}

function nextBonNumber(db) {
    const prefix  = db.prepare(`SELECT value FROM settings WHERE key='bon_number_prefix'`).get()?.value ?? '';
    const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='bon_number_next'`).get()?.value ?? '1');
    db.prepare(`UPDATE settings SET value=? WHERE key='bon_number_next'`).run(String(current + 1));
    return `${prefix}${current}`;
}

function main() {
    const db = getDb();
    const { prefix, rows } = findCandidates(db);

    console.log('\n── Reparation: vundne tilbud der forsvandt ──────────────────');
    console.log(`   DB:       ${process.env.DB_PATH}`);
    console.log(`   Tilstand: ${APPLY ? 'APPLY (skriver)' : 'DRY-RUN'}`);
    console.log(`   Præfiks:  ${prefix}\n`);

    if (!rows.length) {
        console.log('   Ingen flippede tilbud fundet — intet at reparere.\n');
        return;
    }

    const frozen = [];
    const todo   = [];
    for (const r of rows) {
        const reason = frozenReason(r);
        if (reason && !FORCE) frozen.push({ row: r, reason });
        else todo.push(r);
    }

    const tilbudStatusId = db.prepare(`SELECT id FROM status_definitions WHERE code = 'TILBUD'`).get()?.id
                        ?? db.prepare(`SELECT id FROM status_definitions WHERE code = 'NY'`).get()?.id;

    // Kolonnerne læses fra skemaet, så en ny kolonne på `bons` følger med af sig
    // selv i stedet for stille at mangle på bilaget.
    const colInfo = db.prepare(`PRAGMA table_info(bons)`).all();
    const cols = colInfo.map(c => c.name).filter(c => c !== 'id');

    // Nulstilling = skemaets default. `dflt_value` kommer som SQL-litteral
    // ('0', "'store'"), så tal og citerede strenge pakkes ud.
    const resetValue = (name) => {
        const info = colInfo.find(c => c.name === name);
        if (!info || !info.notnull || info.dflt_value == null) return null;
        const raw = String(info.dflt_value).replace(/^'(.*)'$/, '$1');
        return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    };

    for (const r of todo) {
        console.log(`   ${r.bon_number} (id ${r.id}, ${r.status_code}) → bilaget beholder ${r.bon_number}, bonnen får et nyt bon-nummer`);
    }

    if (frozen.length) {
        console.log('\n   Sprunget over — bonnen er nået længere end aftalen:');
        for (const f of frozen) {
            console.log(`   ${f.row.bon_number} (id ${f.row.id}) — ${f.reason}`);
        }
        console.log('   Kør med --force hvis nummeret alligevel skal flyttes.');
    }

    if (!APPLY) {
        console.log(`\n   Dry-run — intet er ændret. ${todo.length} række(r) ville blive repareret.`);
        console.log('   Kør igen med --apply for at gennemføre.\n');
        return;
    }

    const backup = backupDb(db);
    console.log(`\n   Backup: ${backup}`);

    const done = transaction(db, () => {
        const out = [];
        for (const r of todo) {
            // 1. Bonnen får et nyt nummer FØRST — T-nummeret skal være ledigt
            //    før bilaget kan tage det (bon_number er UNIQUE).
            const bonNumber = nextBonNumber(db);
            db.prepare(`UPDATE bons SET bon_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(bonNumber, r.id);

            // 2. Bilaget: kopi af rækken som den så ud, men som tilbud igen.
            const values = cols.map(c => {
                switch (c) {
                    case 'bon_number':      return r.bon_number;   // det oprindelige T-nummer
                    case 'is_offer':        return 1;
                    case 'offer_status':    return 'won';
                    case 'offer_locked_at': return new Date().toISOString();  // utc-ok: DATETIME i DB
                    case 'status_id':       return tilbudStatusId;
                    case 'source_quote_id': return null;
                    default:                return RESET_ON_COPY.includes(c) ? resetValue(c) : (r[c] ?? null);
                }
            });
            const q = db.prepare(`
                INSERT INTO bons (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
            `).run(...values);
            const quoteId = Number(q.lastInsertRowid);

            // 3. Linjerne kopieres — bilaget skal kunne vise hvad der blev
            //    aftalt, også når bonnen bagefter bliver rettet.
            //    `menu_group_id` sættes til NULL: grupperne hører til bonnens
            //    egen række, og et kopieret id ville pege ind i en anden bon.
            db.prepare(`
                INSERT INTO bon_lines
                    (bon_id, block_type, grocy_recipe_id, product_name, category, quantity, unit,
                     unit_price, cost_price, line_total, sort_order, notes, special_request,
                     is_accessory, moms_included, co2e, pos_product_id)
                SELECT ?, block_type, grocy_recipe_id, product_name, category, quantity, unit,
                       unit_price, cost_price, line_total, sort_order, notes, special_request,
                       is_accessory, moms_included, co2e, pos_product_id
                  FROM bon_lines WHERE bon_id = ?
            `).run(quoteId, r.id);

            // 4. Båndet mellem de to. `offer_status` ryddes samtidig: en bon der
            //    står som 'won' er en rest fra flippet, og nye konverteringer
            //    efterlader ikke det spor. `offer_discount_percent` bliver
            //    derimod stående — den indgår i bonnens total, og at fjerne den
            //    ville flytte prisen på en bon ingen har bedt om at ændre.
            db.prepare(`
                UPDATE bons SET source_quote_id = ?, offer_status = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?
            `).run(quoteId, r.id);

            logChange({
                entityType: 'bon', entityId: r.id, action: 'update', fieldName: 'bon_number',
                oldValue: r.bon_number, newValue: bonNumber,
                notes: `Omnummereret: ${r.bon_number} er givet tilbage til tilbuddet (id ${quoteId})`,
            });
            logChange({
                entityType: 'bon', entityId: quoteId, action: 'create', fieldName: 'create',
                newValue: r.bon_number,
                notes: `Bilag genskabt for vundet tilbud — bonnen er ${bonNumber} (id ${r.id})`,
            });

            out.push({ quoteId, quoteNumber: r.bon_number, bonId: r.id, bonNumber });
        }
        return out;
    });

    console.log('\n   Repareret:');
    for (const d of done) {
        console.log(`   Tilbud ${d.quoteNumber} (id ${d.quoteId}) → bon ${d.bonNumber} (id ${d.bonId})`);
    }
    console.log(`\n   ${done.length} tilbud er tilbage på tilbudslisten under "Vundet".\n`);
}

main();
