/**
 * enrich-cvr.js — Berig firmaer med CVR-nummer
 *
 * Kør: node scripts/enrich-cvr.js --dry-run              # Vis matches uden at ændre
 * Kør: node scripts/enrich-cvr.js --run                   # Udfør CVR-berigelse
 * Kør: node scripts/enrich-cvr.js --run --batch=50        # Kun de første 50
 * Kør: node scripts/enrich-cvr.js --ean-only --dry-run    # Kun EAN→NemHandel opslag
 *
 * Strategi (inspireret af bontools CVR opslag):
 * 1. EAN → NemHandel opslag (GLN→CVR, sikrest for institutioner)
 * 2. Kunders email-domæne → hjemmeside CVR-scraping + cvrapi.dk
 * 3. Firmanavn → cvrapi.dk søgning
 *
 * Firmaer med flest bons behandles først.
 * 1 sek delay mellem requests.
 */

const path = require('path');
const { openDb, transaction } = require('../db/compat');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
const db = openDb(DB_PATH);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const run = args.includes('--run');
const eanOnly = args.includes('--ean-only');
const batchArg = args.find(a => a.startsWith('--batch='));
const batchSize = batchArg ? parseInt(batchArg.split('=')[1]) : null;

if (!dryRun && !run) {
  console.log('Brug: node scripts/enrich-cvr.js --dry-run              (vis matches)');
  console.log('      node scripts/enrich-cvr.js --run                   (gem CVR)');
  console.log('      node scripts/enrich-cvr.js --run --batch=50        (kun 50 firmaer)');
  console.log('      node scripts/enrich-cvr.js --ean-only --dry-run    (kun EAN-opslag)');
  process.exit(0);
}

// ─── Hjælpere ─────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalize(name) {
  return (name || '').toLowerCase()
    .replace(/[^a-zæøåé0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  const tokA = new Set(na.split(' ').filter(t => t.length > 1));
  const tokB = new Set(nb.split(' ').filter(t => t.length > 1));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) { if (tokB.has(t)) overlap++; }
  return (2 * overlap) / (tokA.size + tokB.size);
}

// ─── NemHandel EAN→CVR opslag ─────────────────────────────────

async function nemhandelLookup(ean) {
  const url = `https://registration.nemhandel.dk/NemHandelRegisterWeb/public/participant/info?keytype=GLN&key=${ean}&lang=da`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Afskær alt efter "Registrering foretaget af" — registranten er ikke det vi søger
    const relevant = html.split(/Registrering foretaget af/i)[0];

    // Find enhedsnavn: <h4>, <h5>, <h6> heading
    const navnMatch = relevant.match(/<h[456][^>]*>\s*([^<]{2,120})\s*<\/h[456]>/i);

    // Find CVR: unitcvr= parameter i link
    const cvrMatch = relevant.match(/unitcvr=(\d{8})/i)
                  || relevant.match(/CVR[:\s]*(\d{8})/i);

    if (!navnMatch && !cvrMatch) return null;
    return {
      enhedsnavn: navnMatch?.[1]?.trim() || null,
      cvr: cvrMatch?.[1] || null,
    };
  } catch (err) {
    return null;
  }
}

// ─── cvrapi.dk opslag ─────────────────────────────────────────

async function cvrApiSearch(query) {
  try {
    const r = await fetch(
      `https://cvrapi.dk/api?country=dk&search=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    if (Array.isArray(data)) return data;
    if (data && data.vat) return [data];
    return [];
  } catch (err) {
    return [];
  }
}

async function cvrApiLookup(cvr) {
  try {
    const r = await fetch(
      `https://cvrapi.dk/api?country=dk&vat=${cvr}`,
      { headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' } }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch (err) {
    return null;
  }
}

// ─── Kendte institutioner (email-domæne → CVR) ────────────────

const KENDTE = {
  'kk.dk':             { cvr: '64942212', navn: 'Københavns Kommune' },
  'rh.dk':             { cvr: '33657598', navn: 'Rigshospitalet' },
  'regionh.dk':        { cvr: '29190623', navn: 'Region Hovedstaden' },
  'ku.dk':             { cvr: '29979812', navn: 'Københavns Universitet' },
  'dtu.dk':            { cvr: '30060946', navn: 'Danmarks Tekniske Universitet' },
  'sdu.dk':            { cvr: '29283958', navn: 'Syddansk Universitet' },
  'frederiksberg.dk':  { cvr: '11259979', navn: 'Frederiksberg Kommune' },
};

// ═══════════════════════════════════════════════════════════════
// HOVED
// ═══════════════════════════════════════════════════════════════

async function main() {
  // Hent firmaer uden CVR
  let companies = db.prepare(`
    SELECT co.id, co.name, co.ean, co.phone, co.email,
           COUNT(b.id) as bon_count
    FROM companies co
    LEFT JOIN bons b ON b.company_id = co.id
    WHERE (co.cvr IS NULL OR co.cvr = '')
    GROUP BY co.id
    ORDER BY bon_count DESC
  `).all();

  if (eanOnly) {
    companies = companies.filter(c => c.ean && c.ean.length === 13);
  }

  console.log(`Firmaer at behandle: ${companies.length}${eanOnly ? ' (kun med EAN)' : ''}`);

  if (batchSize) {
    companies = companies.slice(0, batchSize);
    console.log(`Begrænset til batch: ${companies.length}`);
  }

  // Hent email-domæner fra kunders emails (for strategi 2)
  const customerEmails = {};
  if (!eanOnly) {
    const rows = db.prepare(`
      SELECT c.company_id, c.email
      FROM customers c
      WHERE c.company_id IS NOT NULL AND c.email IS NOT NULL AND c.email != ''
    `).all();
    for (const row of rows) {
      if (!customerEmails[row.company_id]) customerEmails[row.company_id] = [];
      const domain = row.email.split('@')[1]?.toLowerCase();
      if (domain && !domain.includes('gmail') && !domain.includes('hotmail') &&
          !domain.includes('yahoo') && !domain.includes('outlook') &&
          !domain.includes('icloud') && !domain.includes('live.')) {
        customerEmails[row.company_id].push(domain);
      }
    }
  }

  const results = {
    nemhandel: [],   // EAN→NemHandel match
    cvrapi: [],      // cvrapi.dk match
    known: [],       // Kendt institution
    no_match: [],
  };

  for (let i = 0; i < companies.length; i++) {
    const co = companies[i];
    const progress = `[${i + 1}/${companies.length}]`;

    // Skip rene nummer-navne
    if (/^\d{6,}$/.test(co.name.replace(/\s/g, ''))) {
      results.no_match.push({ company: co, reason: 'nummer-navn' });
      continue;
    }

    // ── Strategi 1: EAN → NemHandel ─────────────────────────────
    if (co.ean && co.ean.replace(/\s/g, '').length === 13) {
      const ean = co.ean.replace(/\s/g, '');
      process.stdout.write(`${progress} NemHandel EAN ${ean} "${co.name}"...`);
      const nhr = await nemhandelLookup(ean);

      if (nhr && nhr.cvr) {
        // Hent fuldt CVR-data fra cvrapi
        const cvrData = await cvrApiLookup(nhr.cvr);
        const officialName = cvrData?.name || nhr.enhedsnavn;
        console.log(` ✓ CVR:${nhr.cvr} "${officialName}" (enhed: "${nhr.enhedsnavn}")`);
        results.nemhandel.push({
          company: co,
          cvr: nhr.cvr,
          enhedsnavn: nhr.enhedsnavn,
          officialName,
          cvrData,
        });
        await sleep(1000);
        continue;
      }
      console.log(' ✗ ikke fundet');
      await sleep(1000);
    }

    if (eanOnly) {
      results.no_match.push({ company: co, reason: 'EAN ikke fundet i NemHandel' });
      continue;
    }

    // ── Strategi 2: Kendt institution via email-domæne ───────────
    const domains = [...new Set(customerEmails[co.id] || [])];
    for (const domain of domains) {
      const known = KENDTE[domain];
      if (known) {
        process.stdout.write(`${progress} Kendt: ${domain}...`);
        console.log(` ✓ CVR:${known.cvr} "${known.navn}"`);
        results.known.push({ company: co, cvr: known.cvr, officialName: known.navn, domain });
        break;
      }
    }
    if (results.known.find(r => r.company.id === co.id)) continue;

    // ── Strategi 3: cvrapi.dk navnesøgning ──────────────────────
    let searchName = co.name
      .replace(/\(.*?\)/g, '')
      .replace(/,\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const words = searchName.split(' ');
    if (words.length > 5) searchName = words.slice(0, 5).join(' ');

    process.stdout.write(`${progress} cvrapi "${searchName}" (${co.bon_count} bons)...`);
    const apiResults = await cvrApiSearch(searchName);

    if (apiResults.length > 0) {
      const scored = apiResults
        .filter(r => r.vat)
        .map(r => ({
          cvr: String(r.vat),
          name: r.name,
          score: similarity(co.name, r.name),
        }))
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0 && scored[0].score >= 0.8) {
        console.log(` ✓ CVR:${scored[0].cvr} "${scored[0].name}" (${Math.round(scored[0].score * 100)}%)`);
        results.cvrapi.push({ company: co, cvr: scored[0].cvr, officialName: scored[0].name, score: scored[0].score });
      } else if (scored.length > 0) {
        console.log(` ? "${scored[0].name}" (${Math.round(scored[0].score * 100)}%) — for lav`);
        results.no_match.push({ company: co, reason: `lav: "${scored[0].name}" ${Math.round(scored[0].score * 100)}%` });
      } else {
        console.log(' ✗ ingen CVR');
        results.no_match.push({ company: co, reason: 'ingen CVR i resultater' });
      }
    } else {
      console.log(' ✗ ingen resultater');
      results.no_match.push({ company: co, reason: 'ingen resultater' });
    }

    await sleep(1000);
  }

  // ─── Opsummering ──────────────────────────────────────────────

  const totalMatched = results.nemhandel.length + results.cvrapi.length + results.known.length;
  console.log('\n═══════════════════════════════════════');
  console.log(`NemHandel (EAN):      ${results.nemhandel.length}`);
  console.log(`Kendte institutioner: ${results.known.length}`);
  console.log(`cvrapi.dk (>80%):     ${results.cvrapi.length}`);
  console.log(`Ingen match:          ${results.no_match.length}`);
  console.log(`Total beriget:        ${totalMatched}`);
  console.log('═══════════════════════════════════════');

  // ─── Gem ──────────────────────────────────────────────────────

  if (run && totalMatched > 0) {
    console.log(`\n🔧 Gemmer ${totalMatched} CVR-numre...`);

    transaction(db, () => {
      const updateCvr = db.prepare(`
        UPDATE companies SET cvr = ?, updated_at = datetime('now')
        WHERE id = ? AND (cvr IS NULL OR cvr = '')
      `);
      const updateLegal = db.prepare(`
        UPDATE companies SET legal_name = ?, updated_at = datetime('now')
        WHERE id = ?
      `);

      for (const m of results.nemhandel) {
        updateCvr.run(m.cvr, m.company.id);
        if (m.officialName) updateLegal.run(m.officialName, m.company.id);
      }
      for (const m of results.known) {
        updateCvr.run(m.cvr, m.company.id);
        if (m.officialName) updateLegal.run(m.officialName, m.company.id);
      }
      for (const m of results.cvrapi) {
        updateCvr.run(m.cvr, m.company.id);
        if (m.officialName) updateLegal.run(m.officialName, m.company.id);
      }
    });

    const withCvr = db.prepare("SELECT COUNT(*) as c FROM companies WHERE cvr IS NOT NULL AND cvr != ''").get().c;
    console.log(`✅ Fuldført! Firmaer med CVR nu: ${withCvr}`);

    // Tjek for nye CVR-duplikater (kan merges efterfølgende)
    const cvrDups = db.prepare(`
      SELECT cvr, GROUP_CONCAT(id) as ids, GROUP_CONCAT(name, ' | ') as names, COUNT(*) as c
      FROM companies WHERE cvr IS NOT NULL AND cvr != ''
      GROUP BY cvr HAVING c > 1
    `).all();

    if (cvrDups.length) {
      console.log(`\n⚠ ${cvrDups.length} CVR-duplikat-grupper fundet (kan merges med merge-cvr-duplicates.js):`);
      cvrDups.forEach(d => console.log(`  CVR ${d.cvr} (${d.c}x): ${d.names}`));
    }
  } else if (dryRun) {
    console.log('\n🔍 DRY RUN — intet ændret.');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
