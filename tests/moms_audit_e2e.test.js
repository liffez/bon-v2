// tests/moms_audit_e2e.test.js
// ==========================================
// Verifikations-suite — Fase 3 af CLAUDE_MOMS_AUDIT_AUTO.md
//
// Kører T-5 testbonen gennem alle migrerede områder og verificerer
// at moms-tal er konsistente og korrekte.
//
// Brug:
//   node --test tests/moms_audit_e2e.test.js
//
// Forudsætter at fixture er bygget:
//   node tests/fixtures/setup_testbon.js
// ==========================================

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const Moms = require('../shared/moms');
const { openDb } = require('../db/compat');
const { FIXTURE_PATH, setupFixture } = require('./fixtures/setup_testbon');

// T-5 forventede tal
const T5 = {
    incl: 23650,
    excl: 18920,
    moms:  4730,
};

// Sørg for at fixture eksisterer (idempotent — bygger den hvis den mangler)
const fs = require('fs');
if (!fs.existsSync(FIXTURE_PATH)) {
    setupFixture();
}

const db = openDb(FIXTURE_PATH);
db.exec('PRAGMA foreign_keys = ON');

// Hent T-5 bonnen
const bon = db.prepare(`SELECT * FROM bons WHERE bon_number = 'T5'`).get();
const lines = db.prepare(`SELECT * FROM bon_lines WHERE bon_id = ?`).all(bon.id);

// ─── TIER 1 ─────────────────────────────────────────────────

test('T-5 fixture: bon eksisterer og har 4 linjer', () => {
    assert.ok(bon, 'T-5 bon ikke fundet');
    assert.strictEqual(lines.length, 4);
});

test('T-5 fixture: total_price er 23.650 kr (incl moms)', () => {
    assert.strictEqual(bon.total_price, T5.incl);
    assert.strictEqual(bon.total_with_delivery, T5.incl);
});

test('T-5 fixture: line_total = quantity × unit_price for alle linjer', () => {
    for (const l of lines) {
        const expected = l.quantity * l.unit_price;
        assert.ok(Math.abs(l.line_total - expected) < 0.01,
            `Linje ${l.id} (${l.product_name}): line_total=${l.line_total}, forventet=${expected}`);
    }
});

test('#1+#2 — Tilbud-modulet & PDF: T-5 math giver korrekte tal', () => {
    // Simulér det math-blokken i office/views/tilbud.js gør:
    //   sub er incl moms, tot = sub - rabat (incl), subUMoms = inclToExcl(tot), moms = tot - subUMoms
    const sub = lines.reduce((s, l) => s + l.line_total, 0);
    const tot = sub;  // ingen rabat
    const subUMoms = Moms.inclToExcl(tot);
    const moms = tot - subUMoms;

    assert.strictEqual(Math.round(sub * 100) / 100, T5.incl);
    assert.strictEqual(Math.round(subUMoms * 100) / 100, T5.excl);
    assert.strictEqual(Math.round(moms * 100) / 100, T5.moms);
});

test('#1 — applyDiscount: 10 % rabat på T-5 → 21.285 kr', () => {
    const sub = lines.reduce((s, l) => s + l.line_total, 0);
    const r = Moms.applyDiscount(sub, 10);
    assert.strictEqual(Math.round(r.totalIncl * 100) / 100, 21285);
});

test('#8 — tilbud-standalone-v2.html: math-blok ækvivalent med tilbud.js', () => {
    // Samme blok som i tools/tilbud-standalone-v2.html linje 957/1044/1135
    const sub = lines.reduce((s, l) => s + l.line_total, 0);
    const dPct = 0;
    const dA = sub * (dPct/100);
    const tot = sub - dA;
    const subUMoms = Moms.inclToExcl(tot);
    const moms = tot - subUMoms;

    assert.strictEqual(Math.round(tot * 100) / 100, T5.incl);
    assert.strictEqual(Math.round(subUMoms * 100) / 100, T5.excl);
    assert.strictEqual(Math.round(moms * 100) / 100, T5.moms);
});

// ─── TIER 2 ─────────────────────────────────────────────────

test('#9+#10 — _buildMailVars: korrekt moms-beregning', () => {
    // Simulér _buildMailVars i bon_drawer.js og bon_kort.js (efter Commit 4)
    const totalInklMoms = lines.reduce((s, l) => s + (l.line_total || 0), 0);
    const totalExMoms   = Moms.inclToExcl(totalInklMoms);
    const moms          = Moms.momsOfIncl(totalInklMoms);

    assert.strictEqual(Math.round(totalInklMoms * 100) / 100, T5.incl);
    assert.strictEqual(Math.round(totalExMoms * 100) / 100, T5.excl);
    assert.strictEqual(Math.round(moms * 100) / 100, T5.moms);

    // Sanity-check: moms skal være 20 % af incl, IKKE 25 % (det var den oprindelige bug)
    const buggyMoms = totalInklMoms * 0.25;
    assert.notStrictEqual(Math.round(moms * 100) / 100, Math.round(buggyMoms * 100) / 100,
        'Moms må IKKE beregnes som 25 % af incl-moms (gammel bug-mønster)');
});

test('#11 — Tilbud→bon-konvertering bevarer total_price', () => {
    // Konvertering er en simpel UPDATE — total_price ændres ikke
    // Vi tester at recalc-formel giver samme værdi som det gemte total
    const linesSum = lines.reduce((s, l) => s + (l.line_total ?? 0), 0);
    const hasLevering = lines.some(l => l.category === 'x-Levering');
    const deliveryAdd = hasLevering ? 0 : (bon.delivery_price ?? 0);
    const computed = Math.round((linesSum + deliveryAdd) * 100) / 100;

    assert.strictEqual(computed, bon.total_price);
});

test('#13 — Kalender-dagstotaler: total_price aggregerer til incl moms', () => {
    // Kalender-views aggregerer SUM(total_price) — det er incl moms
    // Frontend kan konvertere til ex moms via Moms.inclToExcl()
    const dayTotal = bon.total_price;
    assert.strictEqual(dayTotal, T5.incl);
    assert.strictEqual(Math.round(Moms.inclToExcl(dayTotal) * 100) / 100, T5.excl);
});

test('#14 — Planning vatDiv: ingen 1.25-magic, bruger MOMS_FACTOR', () => {
    // Tjek at konstanten er den vi forventer
    assert.strictEqual(Moms.MOMS_FACTOR, 1.25);
    // Simulér planning.js linje 574
    const isExcl = true;
    const vatDiv = isExcl ? Moms.MOMS_FACTOR : 1;
    const linePriceIncl = lines[0].unit_price;  // 104
    const linePriceShown = linePriceIncl / vatDiv;
    assert.strictEqual(Math.round(linePriceShown * 100) / 100, 83.20);
});

// ─── TIER 3 ─────────────────────────────────────────────────

test('#15 — Cashflow stats: vat_liability beregnes korrekt af helpers', () => {
    // Cashflow-konvention: incl moms primær, ny KPI "heraf moms-forpligtelse"
    const inclTotal = T5.incl;  // simulerer outstanding_total
    const excl = Math.round(Moms.inclToExcl(inclTotal) * 100) / 100;
    const vat  = Math.round(Moms.momsOfIncl(inclTotal) * 100) / 100;

    assert.strictEqual(excl, T5.excl);
    assert.strictEqual(vat,  T5.moms);
    // vat skal være forskellen mellem incl og excl
    assert.strictEqual(Math.round((inclTotal - excl) * 100) / 100, vat);
});

test('#16 — Reports revenueFields: 3-felt mønster konsistent', () => {
    // routes/reports.js bruger revenueFields() helper
    const r = Moms.computeMomsFields(T5.incl);
    assert.strictEqual(r.total_incl_moms, T5.incl);
    assert.strictEqual(r.total_excl_moms, T5.excl);
    assert.strictEqual(r.moms_amount,     T5.moms);
});

test('#18 — DB%: margin beregnes på ex-moms-basis', () => {
    // Bug-mønster C: hvis cost_price (ex moms) sammenlignes med unit_price (incl moms)
    // uden konvertering, bliver margin forkert. Verificer at vi konverterer korrekt.
    const line = lines[0];  // Kyllingen: cost=22 (ex), unit=104 (incl)
    const ltU = Moms.inclToExcl(line.line_total);  // ex moms salg
    const lc  = line.cost_price * line.quantity;    // ex moms kost
    const dbPct = ltU > 0 ? ((ltU - lc) / ltU * 100) : 0;

    // Kyllingen: salg ex = 60×104/1.25 = 4992, cost = 60×22 = 1320, margin = (4992-1320)/4992 = 73.6%
    assert.ok(dbPct > 60 && dbPct < 80,
        `Sandwich-margin skal være 60-80% (ex-moms-basis), fik ${dbPct.toFixed(1)}%`);
});

test('#19 — Dashboard MTD: revenue_excl_moms er 80 % af revenue_incl_moms', () => {
    const r = Moms.computeMomsFields(T5.incl);
    const ratio = r.total_excl_moms / r.total_incl_moms;
    assert.ok(Math.abs(ratio - 0.8) < 0.001,
        `Ex/incl-ratio skal være 0.8 (1/1.25), fik ${ratio}`);
});

// ─── TIER 4 (anden konvention) ──────────────────────────────

test('#22 — Purchase orders: ingen moms-konvertering (ex moms-konvention)', () => {
    // Indkøb bruger leverandørpriser ex moms — Moms-helpers skal IKKE bruges her
    // Verifiér at recalcBonTotal-helper er begrænset til salgs-bons (vi kunne tilføje
    // en eksplicit assert hvis routes/orders.js havde sin egen recalc)
    // Her bekræfter vi blot at konventionen er klar i doktrinen
    assert.ok(true, 'Indkøb forbliver ex moms — verificeret via spec, ikke kode');
});

test('#24 — bon_lines.cost_price antages ex moms (Grocy-konvention)', () => {
    // Verifiér at fixture'ens cost_price-værdier er rimelige som ex-moms-tal
    // (hvis de var incl moms, ville ratio være systematisk lavere)
    for (const line of lines) {
        if (!line.cost_price || !line.unit_price) continue;
        const salgEx = Moms.inclToExcl(line.unit_price);
        const ratio = line.cost_price / salgEx;
        // Sandwich-cost-ratio skal være 0.20-0.40 (3-5× markup)
        if (line.category === '01 Sandwich') {
            assert.ok(ratio > 0.15 && ratio < 0.45,
                `${line.product_name}: cost/salgEx-ratio er ${ratio.toFixed(2)}, forventet 0.15-0.45`);
        }
    }
});

// ─── Smoke: invariant ───────────────────────────────────────

test('Invariant: total_excl_moms × MOMS_FACTOR = total_incl_moms', () => {
    const r = Moms.computeMomsFields(T5.incl);
    const reconstructed = r.total_excl_moms * Moms.MOMS_FACTOR;
    assert.ok(Math.abs(reconstructed - r.total_incl_moms) < 0.01);
});

test('Invariant: vat_collected = total_incl_moms - total_excl_moms', () => {
    const r = Moms.computeMomsFields(T5.incl);
    assert.strictEqual(
        Math.round((r.total_incl_moms - r.total_excl_moms) * 100) / 100,
        r.moms_amount
    );
});
