/**
 * enrich-branch.js — Berig firmaer med branche, medarbejderantal og firmatype via Virk ES
 *
 * Kør: node scripts/enrich-branch.js --dry-run     (vis hvad der ville opdateres)
 * Kør: node scripts/enrich-branch.js --run          (gem i database)
 * Kør: node scripts/enrich-branch.js --run --batch=50
 *
 * Genbruger Virk ES-infrastruktur fra enrich-cvr.js.
 * Kræver VIRK_ES_USER + VIRK_ES_PASS i .env.
 */

const path = require('path');
const fs = require('fs');
const { openDb } = require('../db/compat');

// Load .env
try {
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        const lines = fs.readFileSync(envPath, 'utf8').split('\n');
        for (const line of lines) {
            const match = line.match(/^([^#=]+)=(.*)$/);
            if (match && !process.env[match[1].trim()]) {
                process.env[match[1].trim()] = match[2].trim();
            }
        }
    }
} catch (e) { /* ignore */ }

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);

const VIRK_USER = process.env.VIRK_ES_USER;
const VIRK_PASS = process.env.VIRK_ES_PASS;
const VIRK_URL = 'http://distribution.virk.dk/cvr-permanent/_search';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const run = args.includes('--run');
const batchArg = args.find(a => a.startsWith('--batch='));
const batchSize = batchArg ? parseInt(batchArg.split('=')[1]) : null;

if (!dryRun && !run) {
    console.log('Brug: node scripts/enrich-branch.js --dry-run     (vis matches)');
    console.log('      node scripts/enrich-branch.js --run          (gem i database)');
    console.log('      node scripts/enrich-branch.js --run --batch=50');
    process.exit(0);
}

if (!VIRK_USER || !VIRK_PASS) {
    console.error('❌ VIRK_ES_USER og VIRK_ES_PASS skal sættes i .env');
    process.exit(1);
}

console.log('✓ Virk ElasticSearch credentials fundet');

// ─── Branche-mapping (DB37 2-cifret prefix → kategori) ──────

const BRANCH_MAP = {
    '01': 'Landbrug/Fiskeri',
    '02': 'Landbrug/Fiskeri',
    '03': 'Landbrug/Fiskeri',
    '10': 'Fødevarer',
    '11': 'Fødevarer',
    '46': 'Handel',
    '47': 'Handel',
    '49': 'Transport/Logistik',
    '50': 'Transport/Logistik',
    '51': 'Transport/Logistik',
    '52': 'Transport/Logistik',
    '53': 'Transport/Logistik',
    '55': 'Hotel/Restaurant',
    '56': 'Hotel/Restaurant',
    '58': 'IT/Medier',
    '59': 'IT/Medier',
    '60': 'IT/Medier',
    '61': 'IT/Medier',
    '62': 'IT/Medier',
    '63': 'IT/Medier',
    '64': 'Finans',
    '65': 'Finans',
    '66': 'Finans',
    '68': 'Ejendom',
    '69': 'Rådgivning/Revision',
    '70': 'Rådgivning/Revision',
    '71': 'Rådgivning/Revision',
    '72': 'Forskning',
    '73': 'Reklame/Marketing',
    '74': 'Rådgivning/Revision',
    '75': 'Dyrlæger',
    '77': 'Udlejning',
    '78': 'Vikarbureauer',
    '79': 'Rejsebureau',
    '80': 'Sikkerhed/Rengøring',
    '81': 'Sikkerhed/Rengøring',
    '82': 'Kontor/Erhvervsservice',
    '84': 'Offentlig forvaltning',
    '85': 'Uddannelse',
    '86': 'Sundhed',
    '87': 'Sundhed',
    '88': 'Social omsorg',
    '90': 'Kultur/Event',
    '91': 'Kultur/Event',
    '92': 'Kultur/Event',
    '93': 'Sport/Fritid',
    '94': 'Foreninger',
};

function mapBranch(branchekode) {
    if (!branchekode) return 'Andet';
    const prefix = String(branchekode).substring(0, 2);
    return BRANCH_MAP[prefix] || 'Andet';
}

// ─── Virk ES opslag ─────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function virkLookupCvr(cvr) {
    const body = {
        query: { term: { 'Vrvirksomhed.cvrNummer': parseInt(cvr) } },
        size: 1,
    };
    const r = await fetch(VIRK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(`${VIRK_USER}:${VIRK_PASS}`).toString('base64'),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const hit = data.hits?.hits?.[0];
    if (!hit) return null;

    const v = hit._source?.Vrvirksomhed;
    if (!v) return null;

    const meta = v.virksomhedMetadata || {};
    const hovedbranche = meta.nyesteHovedbranche;
    const ansatte = meta.nyesteAarsbeskaeftigelse;
    const form = meta.nyesteVirksomhedsform;

    return {
        branchekode: hovedbranche?.branchekode || null,
        branchetekst: hovedbranche?.branchetekst || null,
        employee_count: ansatte?.intervalKodeAntalAnsatte
            ? parseEmployeeInterval(ansatte.intervalKodeAntalAnsatte)
            : null,
        company_type: form?.langBeskrivelse || form?.kortBeskrivelse || null,
    };
}

/**
 * Virk returnerer medarbejder-intervaller som kodet streng.
 * Konvertér til midtpunkt-estimat.
 */
function parseEmployeeInterval(code) {
    const map = {
        'ANTAL_0_0': 0,
        'ANTAL_1_1': 1,
        'ANTAL_2_4': 3,
        'ANTAL_5_9': 7,
        'ANTAL_10_19': 15,
        'ANTAL_20_49': 35,
        'ANTAL_50_99': 75,
        'ANTAL_100_199': 150,
        'ANTAL_200_499': 350,
        'ANTAL_500_999': 750,
        'ANTAL_1000_PLUS': 1500,
    };
    return map[code] !== undefined ? map[code] : null;
}

// ─── Hovedfunktion ──────────────────────────────────────────

async function main() {
    // Find firmaer med CVR men uden branche
    let companies = db.prepare(`
        SELECT id, name, cvr
        FROM companies
        WHERE cvr IS NOT NULL AND cvr != ''
          AND branch IS NULL
          AND is_active = 1
          AND is_personal = 0
        ORDER BY id
    `).all();

    console.log(`Fandt ${companies.length} firmaer med CVR men uden branche`);

    if (batchSize) {
        companies = companies.slice(0, batchSize);
        console.log(`Begrænset til ${batchSize} firmaer`);
    }

    let enriched = 0;
    let failed = 0;
    let skipped = 0;

    const update = db.prepare(`
        UPDATE companies
        SET branch = ?, branch_source = 'virk', branch_updated_at = datetime('now'),
            cvr_enriched_at = datetime('now'),
            employee_count = COALESCE(?, employee_count),
            company_type = COALESCE(?, company_type)
        WHERE id = ?
    `);

    for (let i = 0; i < companies.length; i++) {
        const co = companies[i];
        const progress = `[${i + 1}/${companies.length}]`;

        try {
            const result = await virkLookupCvr(co.cvr);

            if (!result || !result.branchekode) {
                console.log(`${progress} ⚠ ${co.name} (CVR ${co.cvr}) — ingen branchedata`);
                skipped++;
                continue;
            }

            const branch = mapBranch(result.branchekode);

            if (dryRun) {
                console.log(`${progress} ✓ ${co.name} → ${branch} (${result.branchetekst}), ${result.employee_count ?? '?'} ans., ${result.company_type ?? '?'}`);
            } else {
                update.run(branch, result.employee_count, result.company_type, co.id);
                console.log(`${progress} ✓ ${co.name} → ${branch}`);
            }
            enriched++;
        } catch (err) {
            console.error(`${progress} ❌ ${co.name} — ${err.message}`);
            failed++;
        }

        // Undgå at hamre API'et
        if (i % 10 === 9) await sleep(200);
    }

    console.log(`\n─── Resultat ───`);
    console.log(`Beriget:  ${enriched}`);
    console.log(`Skipped:  ${skipped} (ingen branchedata)`);
    console.log(`Fejl:     ${failed}`);
    if (dryRun) console.log(`\n⚠ DRY RUN — intet gemt. Kør med --run for at gemme.`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
