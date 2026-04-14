/**
 * enrich-cvr.js — Berig firmaer med CVR-nummer via Virk ElasticSearch
 *
 * Kør: node scripts/enrich-cvr.js --dry-run              # Vis matches uden at ændre
 * Kør: node scripts/enrich-cvr.js --run                   # Udfør CVR-berigelse
 * Kør: node scripts/enrich-cvr.js --run --batch=50        # Kun de første 50
 * Kør: node scripts/enrich-cvr.js --ean-only --dry-run    # Kun EAN→NemHandel opslag
 *
 * Strategi (prioriteret):
 * 1. EAN → NemHandel opslag (GLN→CVR, sikrest for institutioner)
 * 2. Kendte institutioner via email-domæne
 * 3. Virk ElasticSearch navnesøgning (ingen rate limit)
 *
 * Kræver VIRK_ES_USER + VIRK_ES_PASS i .env (eller cvrapi.dk som fallback).
 */

const path = require('path');
const { openDb, transaction } = require('../db/compat');

// Load .env
try {
  const envPath = path.join(__dirname, '..', '.env');
  const fs = require('fs');
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
const eanOnly = args.includes('--ean-only');
const safeOnly = args.includes('--safe-only');       // Kun strategi 1+2 (EAN + email)
const exportReview = args.includes('--export-review'); // Eksportér Virk ES matches til review JSON
const batchArg = args.find(a => a.startsWith('--batch='));
const batchSize = batchArg ? parseInt(batchArg.split('=')[1]) : null;

if (!dryRun && !run && !exportReview) {
  console.log('Brug: node scripts/enrich-cvr.js --dry-run              (vis matches)');
  console.log('      node scripts/enrich-cvr.js --run                   (gem CVR)');
  console.log('      node scripts/enrich-cvr.js --run --safe-only       (kun EAN + email, ingen Virk)');
  console.log('      node scripts/enrich-cvr.js --export-review         (eksportér Virk matches til review)');
  console.log('      node scripts/enrich-cvr.js --run --batch=50        (kun 50 firmaer)');
  console.log('      node scripts/enrich-cvr.js --ean-only --dry-run    (kun EAN-opslag)');
  process.exit(0);
}

if (VIRK_USER && VIRK_PASS) {
  console.log('✓ Virk ElasticSearch credentials fundet');
} else {
  console.log('⚠ Ingen Virk ES credentials — bruger cvrapi.dk (har rate limit!)');
}

// ─── Hjælpere ─────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Juridiske suffixer der skal ignoreres ved sammenligning
const LEGAL_SUFFIXES = /\b(i\/s|a\/s|aps|s\/i|a\.m\.b\.a|f\.m\.b\.a|fond|forening|smba|ivs|p\/s|k\/s|holding|group|as|is)\b/gi;
const PARENS = /\(.*?\)/g;

function normalize(name) {
  return (name || '').toLowerCase()
    .replace(PARENS, '')           // fjern parenteser: "(FOND)", "(ODM)"
    .replace(LEGAL_SUFFIXES, '')   // fjern juridiske suffixer
    .replace(/[^a-zæøåé0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  // "Ristet Rug" contained in "Ristet Rug I/S" → høj score
  if (na.includes(nb) || nb.includes(na)) return 0.95;
  const tokA = new Set(na.split(' ').filter(t => t.length > 1));
  const tokB = new Set(nb.split(' ').filter(t => t.length > 1));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokA) { if (tokB.has(t)) overlap++; }
  // Alle tokens fra den korteste side matcher → høj score
  const smaller = Math.min(tokA.size, tokB.size);
  if (overlap === smaller && smaller >= 1) return 0.90;
  return (2 * overlap) / (tokA.size + tokB.size);
}

// ─── Virk ElasticSearch ───────────────────────────────────────

function parseVirkHit(hit) {
  const v = hit._source?.Vrvirksomhed;
  if (!v) return null;
  const meta = v.virksomhedMetadata || {};
  const navn = meta.nyesteNavn?.navn;
  const cvr = v.cvrNummer ? String(v.cvrNummer) : null;
  const adr = meta.nyesteBeliggenhedsadresse;
  const branche = meta.nyesteHovedbranche?.branchetekst;
  // Check om virksomheden er aktiv
  const status = meta.sammensatStatus;
  return {
    cvr,
    navn,
    adresse: adr ? `${adr.vejnavn || ''} ${adr.husnummerFra || ''}`.trim() : null,
    postnr: adr?.postnummer ? String(adr.postnummer) : null,
    by: adr?.postdistrikt || null,
    branche,
    status,
    score: hit._score,
  };
}

async function virkSearch(query) {
  if (!VIRK_USER || !VIRK_PASS) return [];
  try {
    const body = {
      query: {
        bool: {
          must: {
            match: {
              'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn': {
                query: query,
                fuzziness: 'AUTO',
              }
            }
          }
        }
      },
      size: 5,
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
    if (!r.ok) return [];
    const data = await r.json();
    return (data.hits?.hits || []).map(parseVirkHit).filter(Boolean);
  } catch (err) {
    console.error(`  ⚠ Virk ES fejl: ${err.message}`);
    return [];
  }
}

async function virkLookupCvr(cvr) {
  if (!VIRK_USER || !VIRK_PASS) return null;
  try {
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
    return hit ? parseVirkHit(hit) : null;
  } catch (err) {
    return null;
  }
}

// ─── NemHandel EAN→CVR ───────────────────────────────────────

async function nemhandelLookup(ean) {
  const url = `https://registration.nemhandel.dk/NemHandelRegisterWeb/public/participant/info?keytype=GLN&key=${ean}&lang=da`;
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const relevant = html.split(/Registrering foretaget af/i)[0];
    const navnMatch = relevant.match(/<h[456][^>]*>\s*([^<]{2,120})\s*<\/h[456]>/i);
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

// ─── cvrapi.dk fallback ──────────────────────────────────────

async function cvrApiSearch(query) {
  try {
    const r = await fetch(
      `https://cvrapi.dk/api?country=dk&search=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    if (data.error) return []; // quota exceeded
    if (Array.isArray(data)) return data;
    if (data && data.vat) return [data];
    return [];
  } catch (err) {
    return [];
  }
}

// ─── Kendte institutioner ────────────────────────────────────

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
    companies = companies.filter(c => c.ean && c.ean.replace(/\s/g, '').length === 13);
  }

  console.log(`Firmaer at behandle: ${companies.length}${eanOnly ? ' (kun med EAN)' : ''}`);
  if (batchSize) {
    companies = companies.slice(0, batchSize);
    console.log(`Begrænset til batch: ${companies.length}`);
  }

  // Hent email-domæner fra kunder
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
      if (domain && !/(gmail|hotmail|yahoo|outlook|icloud|live\.)/.test(domain)) {
        customerEmails[row.company_id].push(domain);
      }
    }
  }

  const results = {
    nemhandel: [],
    virk: [],
    cvrapi: [],
    known: [],
    no_match: [],
  };

  for (let i = 0; i < companies.length; i++) {
    const co = companies[i];
    const progress = `[${i + 1}/${companies.length}]`;

    if (/^\d{6,}$/.test(co.name.replace(/\s/g, ''))) {
      results.no_match.push({ company: co, reason: 'nummer-navn' });
      continue;
    }

    // ── 1. EAN → NemHandel ──────────────────────────────────────
    if (co.ean && co.ean.replace(/\s/g, '').length === 13) {
      const ean = co.ean.replace(/\s/g, '');
      process.stdout.write(`${progress} NemHandel EAN ${ean}...`);
      const nhr = await nemhandelLookup(ean);

      if (nhr && nhr.cvr) {
        // Hent officielt navn fra Virk ES
        const virkData = await virkLookupCvr(nhr.cvr);
        const officialName = virkData?.navn || nhr.enhedsnavn;
        console.log(` ✓ CVR:${nhr.cvr} "${officialName}"`);
        results.nemhandel.push({ company: co, cvr: nhr.cvr, officialName, enhedsnavn: nhr.enhedsnavn });
        await sleep(500);
        continue;
      }
      console.log(' ✗ ikke fundet');
      await sleep(500);
    }

    if (eanOnly) {
      results.no_match.push({ company: co, reason: 'EAN ikke i NemHandel' });
      continue;
    }

    // ── 2. Kendt institution via email ───────────────────────────
    const domains = [...new Set(customerEmails[co.id] || [])];
    let foundKnown = false;
    for (const domain of domains) {
      const known = KENDTE[domain];
      if (known) {
        console.log(`${progress} Kendt: ${domain} → CVR:${known.cvr} "${known.navn}"`);
        results.known.push({ company: co, cvr: known.cvr, officialName: known.navn });
        foundKnown = true;
        break;
      }
    }
    if (foundKnown) continue;

    // ── 3. Virk ElasticSearch navnesøgning ──────────────────────
    if (safeOnly) {
      results.no_match.push({ company: co, reason: 'safe-only mode' });
      continue;
    }
    let searchName = co.name
      .replace(/\(.*?\)/g, '')
      .replace(/,\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    const words = searchName.split(' ');
    if (words.length > 6) searchName = words.slice(0, 6).join(' ');

    process.stdout.write(`${progress} Virk "${searchName}" (${co.bon_count} bons)...`);

    const virkResults = await virkSearch(searchName);

    if (virkResults.length > 0) {
      // Score og find bedste match
      const scored = virkResults.map(r => ({
        ...r,
        sim: similarity(co.name, r.navn),
      })).sort((a, b) => b.sim - a.sim);

      const best = scored[0];

      // Korte navne (1 ord) kræver højere match for at undgå falske positiver
      // Men normalize() fjerner suffixer, så "AS3" vs "AS3 A/S" → begge "as3" → 1.0
      const normWords = normalize(co.name).split(' ').filter(w => w.length > 1).length;
      const threshold = normWords <= 1 ? 0.90 : 0.75;

      if (best.sim >= threshold) {
        const activeNote = best.status === 'NORMAL' ? '' : ` [${best.status}]`;
        console.log(` ✓ CVR:${best.cvr} "${best.navn}" (${Math.round(best.sim * 100)}%)${activeNote}`);
        results.virk.push({ company: co, cvr: best.cvr, officialName: best.navn, score: best.sim, status: best.status });
      } else {
        console.log(` ? "${best.navn}" (${Math.round(best.sim * 100)}%) — for lav`);
        results.no_match.push({ company: co, reason: `lav: "${best.navn}" ${Math.round(best.sim * 100)}%` });
      }
    } else {
      console.log(' ✗ ingen resultater');
      results.no_match.push({ company: co, reason: 'ingen resultater' });
    }

    await sleep(200); // Virk ES tåler mere end cvrapi
  }

  // ─── Opsummering ──────────────────────────────────────────────

  const totalMatched = results.nemhandel.length + results.virk.length + results.cvrapi.length + results.known.length;
  console.log('\n═══════════════════════════════════════');
  console.log(`NemHandel (EAN):      ${results.nemhandel.length}`);
  console.log(`Kendte institutioner: ${results.known.length}`);
  console.log(`Virk ES (>70%):       ${results.virk.length}`);
  if (results.cvrapi.length) console.log(`cvrapi.dk:            ${results.cvrapi.length}`);
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

      for (const m of [...results.nemhandel, ...results.known, ...results.virk, ...results.cvrapi]) {
        updateCvr.run(m.cvr, m.company.id);
        if (m.officialName) updateLegal.run(m.officialName, m.company.id);
      }
    });

    const withCvr = db.prepare("SELECT COUNT(*) as c FROM companies WHERE cvr IS NOT NULL AND cvr != ''").get().c;
    console.log(`✅ Fuldført! Firmaer med CVR nu: ${withCvr}`);

    // CVR-duplikater
    const cvrDups = db.prepare(`
      SELECT cvr, GROUP_CONCAT(id) as ids, GROUP_CONCAT(name, ' | ') as names, COUNT(*) as c
      FROM companies WHERE cvr IS NOT NULL AND cvr != ''
      GROUP BY cvr HAVING c > 1
    `).all();
    if (cvrDups.length) {
      console.log(`\n⚠ ${cvrDups.length} CVR-duplikat-grupper:`);
      cvrDups.forEach(d => console.log(`  CVR ${d.cvr} (${d.c}x): ${d.names}`));
    }
    // Gem review-log
    const logPath = path.join(__dirname, '..', 'data', 'cvr-enrich-log.json');
    const log = [...results.nemhandel, ...results.known, ...results.virk, ...results.cvrapi].map(m => ({
      id: m.company.id,
      name: m.company.name,
      bons: m.company.bon_count,
      cvr: m.cvr,
      legal_name: m.officialName || null,
      source: m.enhedsnavn ? 'nemhandel' : m.domain ? 'known' : m.score ? `virk (${Math.round(m.score * 100)}%)` : 'cvrapi',
    }));
    require('fs').writeFileSync(logPath, JSON.stringify(log, null, 2));
    console.log(`📋 Review-log gemt: ${logPath} (${log.length} entries)`);
    console.log('   Ret fejl med: node scripts/fix-cvr.js --id=X --cvr=Y --legal="Z"');
  } else if (dryRun) {
    console.log('\n🔍 DRY RUN — intet ændret.');
  }

  // ─── Export review JSON for Virk ES matches ────────────────────
  if (exportReview || (dryRun && results.virk.length > 0)) {
    const reviewPath = path.join(__dirname, '..', 'data', 'cvr-virk-review.json');
    const reviewData = results.virk.map(m => ({
      id: m.company.id,
      company_name: m.company.name,
      bon_count: m.company.bon_count,
      ean: m.company.ean || null,
      cvr: m.cvr,
      virk_name: m.officialName,
      confidence: Math.round((m.score || 0) * 100),
      status: m.status || null,
    }));
    require('fs').writeFileSync(reviewPath, JSON.stringify(reviewData, null, 2));
    console.log(`\n📋 Virk ES review-data: ${reviewPath} (${reviewData.length} matches)`);
    console.log('   Åbn tools/cvr-review.html i browser for at gennemgå');
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
