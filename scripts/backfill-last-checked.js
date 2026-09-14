// scripts/backfill-last-checked.js
// ============================================================
// Bagudfyld "sidst tjekket" (userfield LastCheckedAt) fra Grocys lagerlog.
//
// HVORFOR
// Lageroversigtens "ret beholdning" stemplede ikke varen som tjekket før #613
// (14. sep 2026) — kun optællingen og varemodtagelsen gjorde. Køkkenet retter
// lageret dagligt fra oversigten, så stemplerne står med måneder gamle datoer,
// mens Grocys `stock_log` viser rettelser fra i forgårs. Målt 14/9: 49 af 81
// varer på lager har et stempel, det nyeste fra 19. august; 112 rettelser
// siden da, ingen stemplet.
//
// Uden bagudfyldning ville oversigten stå rød på næsten alt fra dag ét
// (178 af 180 varer har HverDag = 7).
//
// REGLER
//   - Kilde: seneste `inventory-correction` ELLER `purchase` pr. produkt.
//     Et consume er ikke et tjek (det er bon-levering), så det tælles ikke.
//   - Der skrives KUN hvor loggen er nyere end det eksisterende stempel.
//     Et nyere stempel fra optællingen vinder altid over loggen.
//   - LastCheckedUnit røres ALDRIG — det er optællingens felt.
//   - Kun aktive produkter.
//
// TIDSZONE — vigtigt
// `stock_log.row_created_timestamp` er LOKAL tid (Grocy skriver
// datetime('now','localtime')), mens LastCheckedAt er UTC med 'Z'. Bekræftet
// mod data: optællingens stempler 17/7 kl. 14:06–14:29Z ligger ud for
// log-rækker kl. 16:10–16:30 — præcis to timer (CEST). Skrives loggens tal
// råt, bliver hvert stempel to timer for "nyt", og en optælling der kører
// lige efter ville kunne tabe til det. Derfor konverteres Europe/Copenhagen → UTC.
//
// Dry-run som standard. `--apply` skriver. `--test` bruger grocytest.
//
//   npm run backfill:sidst-tjekket
//   npm run backfill:sidst-tjekket -- --apply
//   node --env-file=.env scripts/backfill-last-checked.js --test
// ============================================================

'use strict';

const APPLY = process.argv.includes('--apply');
const TEST  = process.argv.includes('--test');
const LIMIT = 5000;
// Loggen har sekund-opløsning, stemplet millisekunder; et stempel skrevet i
// samme sekund som rettelsen (optællingens commit) må ikke tælle som ældre.
const TOLERANCE_MS = 60 * 1000;

// ── Rene funktioner (testes i scripts/test-last-checked.js) ──

function tzOffsetMs(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date);
    const o = {};
    parts.forEach(p => { o[p.type] = p.value; });
    const asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second);
    return asUtc - date.getTime();
}

/** "YYYY-MM-DD HH:MM:SS" i Europe/Copenhagen → ISO UTC. null ved ugyldigt input. */
function cphLocalToUtcIso(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(str || ''));
    if (!m) return null;
    const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    let off = tzOffsetMs(new Date(naive), 'Europe/Copenhagen');
    let utc = naive - off;
    // Omkring skift til/fra sommertid kan første gæt ramme den forkerte side.
    const off2 = tzOffsetMs(new Date(utc), 'Europe/Copenhagen');
    if (off2 !== off) utc = naive - off2;
    return new Date(utc).toISOString();
}

/** Eksisterende stempel → ms. Grocy kan strippe 'Z'; uden marker antages UTC. */
function parseStamp(raw) {
    if (!raw) return null;
    const s = String(raw);
    const d = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s) : new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * Skal stemplet sættes? { set: bool, reason }
 *   ingen log-spor      → nej (vi opfinder ikke et tjek)
 *   intet stempel       → ja
 *   log nyere (> tol.)  → ja
 *   ellers              → nej, stemplet er nyere eller samtidigt
 */
function decide(existingStamp, logIso) {
    if (!logIso) return { set: false, reason: 'intet log-spor' };
    const ex = parseStamp(existingStamp);
    if (ex === null) return { set: true, reason: 'intet stempel' };
    const lg = new Date(logIso).getTime();
    if (lg - ex > TOLERANCE_MS) return { set: true, reason: 'loggen er nyere' };
    return { set: false, reason: 'stemplet er nyere eller samtidigt' };
}

/** Seneste correction/purchase pr. produkt ud fra to log-udtræk (desc-sorterede). */
function latestPerProduct(rows) {
    const out = {};
    for (const r of rows) {
        const iso = cphLocalToUtcIso(r.row_created_timestamp);
        if (!iso) continue;
        const cur = out[r.product_id];
        if (!cur || iso > cur.iso) out[r.product_id] = { iso, type: r.transaction_type, local: r.row_created_timestamp };
    }
    return out;
}

module.exports = { cphLocalToUtcIso, parseStamp, decide, latestPerProduct, TOLERANCE_MS };

// ── Kørsel ──

async function main() {
    const URL = TEST ? process.env.GROCY_TEST_URL : process.env.GROCY_HQ_URL;
    const KEY = TEST ? process.env.GROCY_TEST_KEY : process.env.GROCY_HQ_KEY;
    if (!URL || !KEY) {
        console.error('Mangler GROCY_' + (TEST ? 'TEST' : 'HQ') + '_URL / _KEY i .env (husk --env-file=.env)');
        process.exit(2);
    }
    const base = URL.replace(/\/+$/, '');
    const get = async (p) => {
        const r = await fetch(base + p, { headers: { 'GROCY-API-KEY': KEY } });
        if (!r.ok) throw new Error('GET ' + p + ' → ' + r.status);
        return r.json();
    };
    const put = async (p, body) => {
        const r = await fetch(base + p, { method: 'PUT', headers: { 'GROCY-API-KEY': KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error('PUT ' + p + ' → ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 120));
    };
    const logQuery = (type) =>
        `/objects/stock_log?query%5B%5D=transaction_type%3D${type}&query%5B%5D=undone%3D0&order=row_created_timestamp%3Adesc&limit=${LIMIT}`;

    console.log((APPLY ? 'APPLY' : 'DRY-RUN') + ' mod ' + base + (TEST ? ' (grocytest)' : ''));

    const [products, corr, purch] = await Promise.all([
        get('/objects/products'),
        get(logQuery('inventory-correction')),
        get(logQuery('purchase'))
    ]);
    if (corr.length >= LIMIT || purch.length >= LIMIT) {
        console.warn(`⚠ log-udtræk ramte grænsen på ${LIMIT} rækker — ældste spor kan mangle (kun et problem for varer uden nyere rettelser)`);
    }
    const latest = latestPerProduct(corr.concat(purch));
    const active = products.filter(p => String(p.active) === '1');

    const plan = [];
    const skipped = { 'intet log-spor': 0, 'stemplet er nyere eller samtidigt': 0 };
    for (const p of active) {
        const uf = p.userfields || {};
        const lg = latest[p.id];
        const d = decide(uf.LastCheckedAt, lg && lg.iso);
        if (d.set) plan.push({ id: p.id, name: p.name, from: uf.LastCheckedAt || null, to: lg.iso, via: lg.type, reason: d.reason });
        else skipped[d.reason] = (skipped[d.reason] || 0) + 1;
    }
    plan.sort((a, b) => a.name.localeCompare(b.name, 'da'));

    console.log(`\n${active.length} aktive produkter · ${plan.length} sættes · ` +
        Object.entries(skipped).map(([k, v]) => `${v} springes over (${k})`).join(' · '));
    const fmt = (iso) => iso ? iso.slice(0, 16).replace('T', ' ') + 'Z' : '—';
    for (const row of plan) {
        console.log(`  ${String(row.id).padStart(4)}  ${row.name.padEnd(32).slice(0, 32)}  ${fmt(row.from).padEnd(18)} → ${fmt(row.to)}  (${row.via}, ${row.reason})`);
    }

    if (!APPLY) { console.log('\nDry-run — kør med --apply for at skrive.'); return; }

    let ok = 0, fail = 0;
    for (const row of plan) {
        try {
            await put(`/userfields/products/${row.id}`, { LastCheckedAt: row.to });   // KUN datoen
            ok++;
        } catch (e) {
            fail++;
            console.error(`  ✗ ${row.name}: ${e.message}`);
        }
    }
    console.log(`\nSkrevet: ${ok} · fejlet: ${fail}`);
    if (fail) process.exit(1);
}

if (require.main === module) {
    main().catch(e => { console.error(e); process.exit(1); });
}
