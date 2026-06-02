// scripts/spike-produktion-grocy.js
// ============================================================
// SPIKE — verificér de to fundamentale Grocy-antagelser bag
// produktionsbatch-feature'en (CLAUDE_PRODUKTION.md) FØR vi bygger:
//
//   A) transaction_type: "self-production" accepteres på
//      POST /stock/products/{id}/add med en price-parameter,
//      og prisen sætter sig faktisk på lager-posten.
//
//   B) Tilbageførsel virker: POST /stock/transactions/{txId}/undo
//      kan rulle BÅDE en consume OG en self-production add tilbage,
//      og vi kan fange transaction_id fra add/consume-svaret.
//
// Sikkerhed: skriver KUN mod test-lokationen (location.code==='test').
// Alt oprettet får prefiks ZZT_ og ryddes op til sidst.
//
// Kør (fra main-repo eller worktree — peger selv på main data+env):
//   node --experimental-sqlite scripts/spike-produktion-grocy.js
// ============================================================

const path = require('path');
const fs = require('fs');

// Peg altid på main-repoets .env + data/bon.db (virker også fra et worktree)
const MAIN_ROOT = '/Users/lifferistetrug/Documents/Projekter/bon-v2';
const envPath = path.join(MAIN_ROOT, '.env');
if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    });
}
process.env.DB_PATH = process.env.DB_PATH || path.join(MAIN_ROOT, 'data', 'bon.db');

const { openDb } = require(path.join(MAIN_ROOT, 'db', 'compat'));

// ── Grocy-config fra test-lokationen (rå fetch, så vi ser hele svaret) ──
const db = openDb(process.env.DB_PATH);
const defaultLoc = db.prepare(`SELECT value FROM settings WHERE key='default_grocy_location_id'`).get();
const loc = db.prepare(`SELECT id,name,code,grocy_api_url,grocy_api_key FROM locations WHERE id=?`).get(defaultLoc?.value);

if (!loc) { console.error('Ingen aktiv lokation fundet.'); process.exit(1); }
if (loc.code !== 'test') {
    console.error(`AFBRUDT: aktiv lokation er "${loc.name}" (code=${loc.code}). Spiken skriver KUN mod code==='test'.`);
    process.exit(1);
}

const BASE = loc.grocy_api_url.replace(/\/+$/, '');
const KEY = loc.grocy_api_key || process.env[`GROCY_${String(loc.code).toUpperCase()}_KEY`] || process.env.GROCY_HQ_KEY || '';
if (!KEY) { console.error('Mangler Grocy API-nøgle for test-lokationen.'); process.exit(1); }

async function gx(method, route, body) {
    const res = await fetch(BASE + route, {
        method,
        headers: { 'GROCY-API-KEY': KEY, 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { ok: res.ok, status: res.status, json };
}

const results = [];
function check(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function findQuId(name) {
    const r = await gx('GET', '/objects/quantity_units');
    const u = (r.json || []).find(q => q.name?.toLowerCase() === name.toLowerCase());
    return u?.id || null;
}

async function main() {
    console.log(`\n── SPIKE mod grocytest (${loc.name} · ${BASE}) ──\n`);

    // health
    const sys = await gx('GET', '/system/info');
    check('Grocy svarer', sys.ok, sys.ok ? `version ${sys.json?.grocy_version?.Version || '?'}` : `status ${sys.status}`);
    if (!sys.ok) return;

    const gramId = await findQuId('Gram') || await findQuId('g');
    check('Fandt QU "Gram"', !!gramId, gramId ? `qu_id=${gramId}` : 'ingen Gram/g — bruger fallback id 1');
    const quId = gramId || 1;

    let productId = null;
    try {
        // ── Opret midlertidigt produkt ZZT_SPIKE_PRODUCED ──
        const created = await gx('POST', '/objects/products', {
            name: 'ZZT_SPIKE_PRODUCED',
            location_id: 1,
            qu_id_stock: quId,
            qu_id_purchase: quId,
            qu_id_price: quId,
        });
        productId = created.json?.created_object_id;
        check('Oprettet test-produkt', !!productId, productId ? `pid=${productId}` : `status ${created.status}: ${JSON.stringify(created.json).slice(0,160)}`);
        if (!productId) return;

        // ════════════════════════════════════════════════════
        // ANTAGELSE A — self-production add med price
        // ════════════════════════════════════════════════════
        const PRICE = 0.0531; // kr/g (ex moms) — vilkårlig kendt værdi
        const addRes = await gx('POST', `/stock/products/${productId}/add`, {
            amount: 1000,
            transaction_type: 'self-production',
            price: PRICE,
            best_before_date: '2999-12-31',
        });
        check('A1: add(self-production, price) accepteres', addRes.ok,
            addRes.ok ? '' : `status ${addRes.status}: ${JSON.stringify(addRes.json).slice(0,200)}`);

        // Hvor ligger transaction_id i svaret?
        const addArr = Array.isArray(addRes.json) ? addRes.json : (addRes.json ? [addRes.json] : []);
        const addTxId = addArr[0]?.transaction_id || addArr[0]?.stock_row?.transaction_id || null;
        check('A2: add-svar indeholder transaction_id', !!addTxId,
            addTxId ? `txId=${addTxId}` : `svar-form: ${JSON.stringify(addRes.json).slice(0,200)}`);

        // Læs lager + pris tilbage
        const stock1 = await gx('GET', `/stock/products/${productId}`);
        const amt1 = parseFloat(stock1.json?.stock_amount ?? 'NaN');
        check('A3: lager = +1000 efter add', Math.abs(amt1 - 1000) < 0.001, `stock_amount=${amt1}`);
        // Pris kan ligge på last_price / avg_price afhængig af Grocy-version
        const lastPrice = parseFloat(stock1.json?.last_price ?? stock1.json?.product?.last_price ?? 'NaN');
        const avgPrice = parseFloat(stock1.json?.avg_price ?? 'NaN');
        check('A4: prisen satte sig (last_price ELLER avg_price = 0.0531)',
            Math.abs(lastPrice - PRICE) < 0.0005 || Math.abs(avgPrice - PRICE) < 0.0005,
            `last_price=${lastPrice} avg_price=${avgPrice} (forventet ${PRICE})`);

        // ════════════════════════════════════════════════════
        // ANTAGELSE B — kan transaktioner fortrydes?
        // Nulstil til kendt baseline (0) først, så hver assertion er ren.
        // ════════════════════════════════════════════════════
        await gx('POST', `/stock/products/${productId}/inventory`, { new_amount: 0 });

        // B1 — self-production add: KAN DEN UNDOES? (spec antog ja)
        const spAdd = await gx('POST', `/stock/products/${productId}/add`, {
            amount: 1000, transaction_type: 'self-production', price: PRICE, best_before_date: '2999-12-31',
        });
        const spTxId = (Array.isArray(spAdd.json) ? spAdd.json : [spAdd.json])[0]?.transaction_id;
        const undoSp = await gx('POST', `/stock/transactions/${spTxId}/undo`);
        check('B1: KAN self-production add fortrydes via undo?', undoSp.ok,
            undoSp.ok ? 'ja' : `NEJ — status ${undoSp.status}: ${JSON.stringify(undoSp.json).slice(0,120)}`);

        // B2 — purchase add: kan DEN undoes? (isolerer om det er self-production-specifikt)
        await gx('POST', `/stock/products/${productId}/inventory`, { new_amount: 0 });
        const purAdd = await gx('POST', `/stock/products/${productId}/add`, {
            amount: 1000, transaction_type: 'purchase', price: PRICE, best_before_date: '2999-12-31',
        });
        const purTxId = (Array.isArray(purAdd.json) ? purAdd.json : [purAdd.json])[0]?.transaction_id;
        const undoPur = await gx('POST', `/stock/transactions/${purTxId}/undo`);
        check('B2: purchase add KAN fortrydes (isolation)', undoPur.ok,
            undoPur.ok ? 'ja → self-production er specialtilfældet' : `nej — status ${undoPur.status}`);

        // B3 — consume: kan DEN undoes? (raw-siden af batchen)
        await gx('POST', `/stock/products/${productId}/inventory`, { new_amount: 1000 });
        const consumeRes = await gx('POST', `/stock/products/${productId}/consume`, {
            amount: 200, transaction_type: 'consume', spoiled: false,
        });
        const conTxId = (Array.isArray(consumeRes.json) ? consumeRes.json : [consumeRes.json])[0]?.transaction_id;
        const undoCon = await gx('POST', `/stock/transactions/${conTxId}/undo`);
        const stockC = await gx('GET', `/stock/products/${productId}`);
        const amtC = parseFloat(stockC.json?.stock_amount ?? '0') || 0;
        check('B3: consume KAN fortrydes (raws ruller tilbage)', undoCon.ok && Math.abs(amtC - 1000) < 0.001,
            `undo=${undoCon.ok}, lager=${amtC} (forventet 1000)`);

        // B4 — REVERSERINGS-VEJ for produkt-add: kompenserende consume.
        // Da self-production ikke kan undoes, ruller vi den tilbage ved at
        // consume den producerede mængde igen → lager tilbage til baseline.
        await gx('POST', `/stock/products/${productId}/inventory`, { new_amount: 0 });
        await gx('POST', `/stock/products/${productId}/add`, {
            amount: 1000, transaction_type: 'self-production', price: PRICE, best_before_date: '2999-12-31',
        });
        const compConsume = await gx('POST', `/stock/products/${productId}/consume`, {
            amount: 1000, transaction_type: 'consume', spoiled: false,
        });
        const stockR = await gx('GET', `/stock/products/${productId}`);
        const amtR = parseFloat(stockR.json?.stock_amount ?? '0') || 0;
        check('B4: kompenserende consume ruller produkt-add tilbage', compConsume.ok && Math.abs(amtR) < 0.001,
            `consume=${compConsume.ok}, lager=${amtR} (forventet 0)`);
    } finally {
        // ── Teardown: ryd lager til 0 + slet produktet ──
        if (productId) {
            try { await gx('POST', `/stock/products/${productId}/inventory`, { new_amount: 0 }); } catch {}
            const del = await gx('DELETE', `/objects/products/${productId}`);
            check('Teardown: test-produkt slettet', del.ok, del.ok ? '' : `status ${del.status}`);
        }
    }

    const fails = results.filter(r => !r.pass);
    console.log(`\n── RESULTAT: ${results.length - fails.length}/${results.length} grønne ──`);
    if (fails.length) {
        console.log('Fejlede:', fails.map(f => f.name).join(', '));
        process.exitCode = 1;
    } else {
        console.log('Begge fundamentale antagelser HOLDER. Klar til at bygge route + saga.');
    }
}

main().catch(e => { console.error('SPIKE crashede:', e); process.exit(1); });
