// tests/pos_sales.test.js
// ============================================================
// Rene funktioner bag POS-salgsbonnen: døgnskifte, produktkobling, dagens
// aggregat og event-koblingen. Ingen database, intet netværk, ingen tid-nu.
//
// Kør: node --test tests/pos_sales.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
    businessDate, normalizeName, tokenKey, buildRecipeIndex, matchRecipeByName,
    aggregateDay, resolveEventForDay, localHour, hourlyCurve, topItems,
} = require('../services/posSales');
const { normalizePurchase } = require('../services/zettleAdapter');

const FIX = p => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/zettle', p), 'utf8')).purchases;
const REAL = FIX('purchases_festival.json').map(normalizePurchase);
const SYN = FIX('purchases_synthetic.json').map(normalizePurchase);

// Grocy-opskrifter som de faktisk hedder i grocy-hq — inkl. den ordstilling
// der afslørede at delstrengs-match er farligt.
const RECIPES = [
    { id: 10, name: 'Kartoflen',        category: '01 Sandwich', cost_price: 21.5, co2e: 0.4, unit: 'stk' },
    { id: 57, name: 'Kartoflen slider', category: '04 Slider',   cost_price: 11.2, co2e: 0.2, unit: 'stk' },
    { id: 11, name: 'Fisken',           category: '01 Sandwich', cost_price: 24.0, co2e: 0.5, unit: 'stk' },
    { id: 52, name: 'Fisken Slider',    category: '04 Slider',   cost_price: 12.0, co2e: 0.3, unit: 'stk' },
    { id: 12, name: ' Falaflen',        category: '01 Sandwich', cost_price: 18.0, co2e: 0.3, unit: 'stk' },
    { id: 93, name: 'Falaflen - slider',category: '04 Slider',   cost_price: 9.0,  co2e: 0.2, unit: 'stk' },
    { id: 53, name: 'Frikadellen Slider', category: '04 Slider', cost_price: 13.0, co2e: 0.3, unit: 'stk' },
];
const INDEX = buildRecipeIndex(RECIPES);
const BY_ID = new Map(RECIPES.map(r => [r.id, r]));

/* ══════════════════════════════════════════════════════════
   DØGNSKIFTE (§6.1)
   ══════════════════════════════════════════════════════════ */

test('døgnskifte: et køb efter midnat hører til aftenen før', () => {
    // 00:30 UTC = 02:30 i København (sommertid) — før skæringen kl. 04.
    assert.equal(businessDate('2026-08-16T00:30:00.000+0000', '04:00'), '2026-08-15');
    // 03:00 UTC = 05:00 lokalt — efter skæringen, altså en ny dag.
    assert.equal(businessDate('2026-08-15T03:00:00.000+0000', '04:00'), '2026-08-15');
    // 01:00 UTC = 03:00 lokalt — stadig aftenen før.
    assert.equal(businessDate('2026-08-15T01:00:00.000+0000', '04:00'), '2026-08-14');
    assert.equal(businessDate('2026-08-15T20:00:00.000+0000', '04:00'), '2026-08-15');
});

test('døgnskifte: vintertid regnes med samme svar', () => {
    // 02:00 UTC = 03:00 i København (vintertid, +1) — før skæringen.
    assert.equal(businessDate('2026-01-15T02:00:00.000+0000', '04:00'), '2026-01-14');
    assert.equal(businessDate('2026-01-15T04:00:00.000+0000', '04:00'), '2026-01-15');
});

test('døgnskifte: datoen aflæses i København, ikke i UTC', () => {
    // Kl. 23:30 lokalt den 14. er 21:30 UTC. Med UTC-aflæsning ville et køb
    // sent på aftenen kunne lande på den forkerte dato — den fælde der har
    // ramt huset flere gange (#331, #335).
    assert.equal(businessDate('2026-08-14T21:30:00.000+0000', '04:00'), '2026-08-14');
    // Og kl. 00:30 LOKALT den 15. (= 22:30 UTC den 14.) hører til den 14.
    assert.equal(businessDate('2026-08-14T22:30:00.000+0000', '04:00'), '2026-08-14');
});

test('døgnskifte: skæringen kan flyttes, og 00:00 betyder kalenderdøgn', () => {
    assert.equal(businessDate('2026-08-16T00:30:00.000+0000', '00:00'), '2026-08-16');
    assert.equal(businessDate('2026-08-16T00:30:00.000+0000', '06:00'), '2026-08-15');
});

test('døgnskifte: ugyldigt input afvises frem for at gætte en dato', () => {
    assert.throws(() => businessDate('2026-08-16T00:30:00Z', '4'), /HH:MM/);
    assert.throws(() => businessDate('2026-08-16T00:30:00Z', '24:00'), /HH:MM/);
    assert.throws(() => businessDate('ikke en dato', '04:00'), /tidsstempel/);
});

/* ══════════════════════════════════════════════════════════
   PRODUKTKOBLING (§7)
   ══════════════════════════════════════════════════════════ */

test('navnematch: eksakt og ordsæt — men ALDRIG delstreng', () => {
    // Det farlige tilfælde: "Slider kartoflen" må ramme slider-opskriften (57),
    // ikke den fuldstore "Kartoflen" (10). En slider til 55 kr med den
    // fuldstore rets stykliste ville forgifte top-up-/retur-forslaget.
    assert.equal(matchRecipeByName('Slider kartoflen', INDEX).recipe.id, 57);
    assert.equal(matchRecipeByName('Slider kartoflen', INDEX).method, 'tokens');
    assert.equal(matchRecipeByName('Slider     fisken', INDEX).recipe.id, 52);
    assert.equal(matchRecipeByName('Kartoflen', INDEX).recipe.id, 10);
    assert.equal(matchRecipeByName('Kartoflen', INDEX).method, 'exact');
});

test('navnematch: et navn der kun ligner et andet, kobles ikke', () => {
    // "Luxus hotdog" findes ikke i Grocy og må ikke ende på "Hotdog"-noget.
    assert.equal(matchRecipeByName('Luxus hotdog', INDEX), null);
    assert.equal(matchRecipeByName('Kartoflen med ekstra', INDEX), null,
        'ekstra ord må ikke matche — det ville være delstreng ad bagvejen');
    assert.equal(matchRecipeByName('', INDEX), null);
});

test('navnematch: to opskrifter med samme nøgle matcher ingen af dem', () => {
    const idx = buildRecipeIndex([
        { id: 1, name: 'Tunen' }, { id: 2, name: 'tunen' },
        { id: 3, name: 'Fisken' },
    ]);
    assert.equal(matchRecipeByName('Tunen', idx), null, 'vi vælger ikke den ene på må og få');
    assert.equal(matchRecipeByName('Fisken', idx).recipe.id, 3);
});

test('normalisering: æøå, store bogstaver og tegnsætning foldes væk', () => {
    assert.equal(normalizeName('Pølse m/ røvermos'), 'poelse m roevermos');
    assert.equal(normalizeName('Falaflen - slider'), 'falaflen slider');
    assert.equal(tokenKey('Falaflen - slider'), tokenKey('Slider Falaflen'));
});

/* ══════════════════════════════════════════════════════════
   DAGENS AGGREGAT
   ══════════════════════════════════════════════════════════ */

test('aggregat: linjesummen rammer det der blev betalt', () => {
    const a = aggregateDay(REAL, { recipeIndex: INDEX, recipesById: BY_ID });
    const sum = Math.round(a.lines.reduce((s, l) => s + l.line_total_incl, 0) * 100) / 100;
    assert.equal(sum, a.gross_incl);
    assert.equal(a.flags.find(f => f.code === 'line_sum_mismatch'), undefined);
    assert.equal(a.purchase_count, REAL.length);
});

test('aggregat: koblede linjer arver kategori, kostpris og CO₂ — ukoblede ikke', () => {
    const a = aggregateDay(REAL, { recipeIndex: INDEX, recipesById: BY_ID });
    const slider = a.lines.find(l => l.grocy_recipe_id === 57);
    assert.ok(slider, '"Slider kartoflen" skal kobles til "Kartoflen slider" på ordsæt');
    assert.equal(slider.category, '04 Slider');
    assert.equal(slider.cost_price, 11.2);

    // Målt sandhed, ikke en mangel i testen: POS siger "Slider Frikadelle",
    // Grocy siger "Frikadellen Slider". Ordene er ikke de samme, så ordsæt
    // rammer ikke — og vi gætter ikke. Netop derfor skal manuel kobling med.
    assert.equal(matchRecipeByName('Slider Frikadelle', INDEX), null);

    const hotdog = a.lines.find(l => /hotdog/i.test(l.product_name));
    assert.ok(hotdog, 'ukoblet vare skal stadig være en linje — der sælges andet end Grocy-varer');
    assert.equal(hotdog.grocy_recipe_id, null);
    assert.equal(hotdog.category, null);
    assert.equal(hotdog.cost_price, null);
    assert.ok(a.unmatched.some(u => /hotdog/i.test(u.name)), 'og den skal kunne ses som ukoblet');
});

test('aggregat: manuel kobling vinder over navnematch', () => {
    const uuid = REAL[0].lines[0].product_uuid;
    const a = aggregateDay(REAL, {
        recipeIndex: INDEX, recipesById: BY_ID,
        productMap: new Map([[uuid, { grocy_recipe_id: 11 }]]),
    });
    const l = a.lines.find(x => x.product_uuid === uuid);
    assert.equal(l.grocy_recipe_id, 11);
    assert.equal(l.match_method, 'manual');
});

test('aggregat: "findes ikke i Grocy" er en beslutning, ikke en manglende kobling', () => {
    const hot = REAL.flatMap(p => p.lines).find(l => /hotdog/i.test(l.name));
    const a = aggregateDay(REAL, {
        recipeIndex: INDEX, recipesById: BY_ID,
        productMap: new Map([[hot.product_uuid, { grocy_recipe_id: null }]]),
    });
    assert.ok(a.lines.some(l => /hotdog/i.test(l.product_name)), 'linjen er der stadig');
    assert.equal(a.unmatched.some(u => /hotdog/i.test(u.name)), false,
        'men den skal ikke blive ved med at stå som "uafklaret"');
});

test('aggregat: samme vare til to priser bliver to linjer', () => {
    // Ellers ville en prisændring midt på dagen blive til et gennemsnit ingen
    // har taget imod — og linjesummen ville stadig se rigtig ud.
    const base = REAL[0];
    const other = JSON.parse(JSON.stringify(base.raw));
    other.purchaseUUID = 'pris-2';
    other.amount = 6000; other.vatAmount = 1200;
    other.products[0].unitPrice = 6000;
    const a = aggregateDay([base, normalizePurchase(other)], { recipeIndex: INDEX, recipesById: BY_ID });
    const same = a.lines.filter(l => l.product_uuid === base.lines[0].product_uuid);
    assert.equal(same.length, 2);
    assert.deepEqual(same.map(l => l.unit_price_incl).sort(), [60, 65]);
});

test('aggregat: refundering nettes ind i dagen', () => {
    const solgt = REAL.find(p => p.lines[0].name === 'Slider Frikadelle' && p.lines.length === 1);
    const retur = SYN[0];   // refundering af netop den vare, samme pris
    const a = aggregateDay([solgt, retur], { recipeIndex: INDEX, recipesById: BY_ID });
    assert.equal(a.gross_incl, 0);
    assert.equal(a.refund_count, 1);
    assert.equal(a.lines.length, 0, 'en vare der er solgt og refunderet samme dag står ikke på bonnen');
});

test('aggregat: en refundering af noget solgt i går giver en negativ linje', () => {
    const a = aggregateDay([SYN[0]], { recipeIndex: INDEX, recipesById: BY_ID });
    assert.equal(a.gross_incl, -65);
    assert.equal(a.lines.length, 1);
    assert.equal(a.lines[0].quantity, -1);
    assert.equal(a.lines[0].line_total_incl, -65);
});

test('aggregat: betalingsmidler splittes — kontant rammer aldrig banken', () => {
    const a = aggregateDay([...REAL, SYN[2]], { recipeIndex: INDEX, recipesById: BY_ID });
    assert.ok(a.by_payment.IZETTLE_CARD > 0);
    assert.equal(a.by_payment.CASH, 50);
    const sum = Math.round(Object.values(a.by_payment).reduce((s, v) => s + v, 0) * 100) / 100;
    assert.equal(sum, a.gross_incl);
});

test('aggregat: EXCLUSIVE moms rejser flag i stedet for at give for lave priser', () => {
    const a = aggregateDay([SYN[4]], { recipeIndex: INDEX, recipesById: BY_ID });
    assert.ok(a.flags.some(f => f.code === 'exclusive_vat'));
});

test('aggregat: et stort enkeltkøb uden kobling mistænkes for at være en faktura', () => {
    // Målt i drift: "Fakture 4087" på 5.321 kr gik gennem terminalen. Fakturaen
    // er allerede bogført — kom den med på salgsbonnen, stod omsætningen to gange.
    const raw = JSON.parse(JSON.stringify(REAL[0].raw));
    raw.purchaseUUID = 'faktura';
    raw.amount = 532125; raw.vatAmount = 106425;
    raw.products = [{ quantity: '1', productUuid: null, name: 'Fakture 4087', unitPrice: 532125, vatPercentage: 25 }];
    raw.payments = [{ uuid: 'x', amount: 532125, type: 'IZETTLE_CARD' }];
    const a = aggregateDay([...REAL, normalizePurchase(raw)], { recipeIndex: INDEX, recipesById: BY_ID });
    const flag = a.flags.find(f => f.code === 'possible_invoice_payment');
    assert.ok(flag, 'skal markeres');
    assert.equal(flag.purchases[0].name, 'Fakture 4087');
    // Vi afviser den ikke automatisk — det ville være et gæt.
    assert.ok(a.lines.some(l => l.product_name === 'Fakture 4087'));
});

test('aggregat: en almindelig dag mistænkes ikke for fakturabetaling', () => {
    const a = aggregateDay(REAL, { recipeIndex: INDEX, recipesById: BY_ID });
    assert.equal(a.flags.some(f => f.code === 'possible_invoice_payment'), false);
});

test('aggregat: uden Grocy-indeks kobles intet — men dagen tælles stadig', () => {
    const a = aggregateDay(REAL, { recipeIndex: null });
    assert.ok(a.gross_incl > 0);
    assert.ok(a.lines.every(l => l.grocy_recipe_id === null));
    assert.equal(a.unmatched.length > 0, true);
});

/* ══════════════════════════════════════════════════════════
   EVENT-KOBLING (§6.2/§6.3)
   ══════════════════════════════════════════════════════════ */

test('event-kobling: præcis ét event med POS slået til → koblet', () => {
    const r = resolveEventForDay([{ id: 7, name: 'Vig', pos_store_ref: null }], ['site-a']);
    assert.deepEqual([r.event_id, r.status], [7, 'auto']);
});

test('event-kobling: intet event med POS slået til → utildelt, ingen bon', () => {
    const r = resolveEventForDay([], ['site-a']);
    assert.equal(r.event_id, null);
    assert.equal(r.status, 'unassigned');
    assert.equal(r.reason, 'no_event');
});

test('event-kobling: to events skilles ad på salgsstedet', () => {
    const events = [
        { id: 1, name: 'A', pos_store_ref: 'site-a' },
        { id: 2, name: 'B', pos_store_ref: 'site-b' },
    ];
    assert.equal(resolveEventForDay(events, ['site-b']).event_id, 2);
    assert.equal(resolveEventForDay(events, ['site-b']).reason, 'site');
});

test('event-kobling: to events der ikke kan skilles ad → ambiguous, aldrig et gæt', () => {
    const events = [{ id: 1, name: 'A', pos_store_ref: null }, { id: 2, name: 'B', pos_store_ref: null }];
    const r = resolveEventForDay(events, ['site-a']);
    assert.equal(r.event_id, null);
    assert.equal(r.status, 'ambiguous');
    assert.equal(r.candidates.length, 2);

    // Også når købene kommer fra flere salgssteder.
    const r2 = resolveEventForDay(
        [{ id: 1, name: 'A', pos_store_ref: 'a' }, { id: 2, name: 'B', pos_store_ref: 'b' }],
        ['a', 'b']);
    assert.equal(r2.status, 'ambiguous');
});

/* ══════════════════════════════════════════════════════════
   TIMEFORDELING (§11) — datagrundlaget for bemanding
   ══════════════════════════════════════════════════════════ */

const p = (t, a, opts = {}) => ({ occurred_at: t, amount_incl: a, is_refund: !!opts.refund, lines: opts.lines || [] });

test('timen aflæses i København, ikke i UTC', () => {
    // 08:30 UTC er 10:30 i dansk sommertid. Med UTC ville hele kurven ligge
    // to timer forskudt, og bemandingen ville være regnet på det forkerte tidsrum.
    assert.equal(localHour('2026-08-14T08:30:00.000+0000'), 10);
    assert.equal(localHour('2026-08-14T22:30:00.000+0000'), 0, 'midnat lokalt');
    assert.equal(localHour('2026-01-14T08:30:00.000+0000'), 9, 'vintertid er én time');
    assert.equal(localHour('ikke en dato'), null);
});

test('timerne ordnes efter forretningsdagen — natten lægger sig SIDST', () => {
    // Uden dette ville en aften der trækker over midnat lægge sig som en pukkel
    // i venstre kant og se ud som om der var run på om morgenen.
    const c = hourlyCurve([
        p('2026-08-16T00:30:00Z', 75),    // 02:30 lokalt — efter midnat
        p('2026-08-15T08:30:00Z', 100),   // 10:30
        p('2026-08-15T20:00:00Z', 200),   // 22:00
    ], '04:00');
    assert.deepEqual(c.hours.map(h => h.label), ['10:00', '22:00', '02:00']);
});

test('en anden skæring flytter rækkefølgen med', () => {
    const kl = t => hourlyCurve([p('2026-08-15T08:30:00Z', 1), p('2026-08-16T00:30:00Z', 1)], t)
        .hours.map(h => h.label);
    assert.deepEqual(kl('04:00'), ['10:00', '02:00'], 'natten hører til dagen før');
    assert.deepEqual(kl('00:00'), ['02:00', '10:00'], 'rent kalenderdøgn: natten kommer først');
});

test('den travleste time er ORDRER, ikke kroner — det er dét man bemander efter', () => {
    const c = hourlyCurve([
        p('2026-08-14T08:00:00Z', 1000),                                   // 10:00 · 1 stor ordre
        p('2026-08-14T10:00:00Z', 50), p('2026-08-14T10:10:00Z', 50),
        p('2026-08-14T10:20:00Z', 50),                                     // 12:00 · 3 små
    ], '04:00');
    assert.equal(c.peak.label, '12:00');
    assert.equal(c.peak.orders, 3);
    assert.equal(c.total_orders, 4);
});

test('refunderinger bemandes ikke — men beløbet trækkes fra', () => {
    const c = hourlyCurve([
        p('2026-08-14T08:00:00Z', 100),
        p('2026-08-14T08:30:00Z', -100, { refund: true }),
    ], '04:00');
    const t = c.hours.find(h => h.label === '10:00');
    assert.equal(t.orders, 1, 'kun det ægte salg tæller som en ordre');
    assert.equal(t.refunds, 1);
    assert.equal(t.gross_incl, 0, 'men kronerne går i nul, så timerne summer til dagen');
    assert.equal(c.total_orders, 1);
});

test('timerne summer til dagens omsætning', () => {
    const purchases = REAL;
    const c = hourlyCurve(purchases, '04:00');
    const sum = Math.round(c.hours.reduce((s, h) => s + h.gross_incl, 0) * 100) / 100;
    const dag = Math.round(purchases.reduce((s, x) => s + x.amount_incl, 0) * 100) / 100;
    assert.equal(sum, dag);
});

test('varer tælles ved siden af ordrer — én ordre kan være mange varer', () => {
    const line = (q) => ({ name: 'x', product_uuid: null, quantity: q, line_total_incl: q * 50 });
    const c = hourlyCurve([
        p('2026-08-14T08:00:00Z', 150, { lines: [line(3)] }),
        p('2026-08-14T08:30:00Z', 50, { lines: [line(1)] }),
    ], '04:00');
    const t = c.hours[0];
    assert.equal(t.orders, 2, 'to i køen');
    assert.equal(t.items, 4, 'men fire ting skulle laves');
    assert.equal(c.total_items, 4);
});

test('varer er ALT over disken — ikke husets kategori-filtrerede "enheder"', () => {
    // Luxus hotdog har ingen Grocy-kobling og tæller nul i bons.total_units.
    // På kurven SKAL den tælle: den er arbejde, og ~30 % af festivalens salg.
    const c = hourlyCurve([p('2026-08-14T08:00:00Z', 109, {
        lines: [{ name: 'Luxus hotdog', product_uuid: 'u', quantity: 1, line_total_incl: 109 }],
    })], '04:00');
    assert.equal(c.total_items, 1);
});

test('en refunderet vare trækkes fra vare-tallet', () => {
    const line = (q) => ({ name: 'x', product_uuid: null, quantity: q, line_total_incl: q * 50 });
    const c = hourlyCurve([
        p('2026-08-14T08:00:00Z', 100, { lines: [line(2)] }),
        p('2026-08-14T08:30:00Z', -50, { refund: true, lines: [line(-1)] }),
    ], '04:00');
    assert.equal(c.hours[0].items, 1);
    assert.equal(c.hours[0].orders, 1);
});

test('en dag uden køb giver en tom kurve, ikke en fejl', () => {
    const c = hourlyCurve([], '04:00');
    assert.deepEqual(c.hours, []);
    assert.equal(c.peak, null);
    assert.equal(c.total_orders, 0);
    assert.equal(c.total_items, 0);
});

test('ugyldig skæring afvises frem for at give en tilfældig rækkefølge', () => {
    assert.throws(() => hourlyCurve([], '4'), /HH:MM/);
});

test('top-varer virker uden Grocy — den ukoblede vare hører med i toppen', () => {
    // Luxus hotdog er 20 % af en festivals omsætning og har ingen opskrift.
    const items = topItems(REAL);
    assert.ok(items.length > 0);
    assert.ok(items.some(i => /hotdog/i.test(i.name)), 'ukoblede varer skal med');
    for (let i = 1; i < items.length; i++) {
        assert.ok(items[i - 1].gross_incl >= items[i].gross_incl, 'sorteret efter omsætning');
    }
});

test('top-varer: en vare solgt og refunderet samme dag falder ud', () => {
    const line = (name, qty, tot) => ({ name, product_uuid: null, quantity: qty, line_total_incl: tot });
    const items = topItems([
        p('2026-08-14T08:00:00Z', 65, { lines: [line('Slider', 1, 65)] }),
        p('2026-08-14T09:00:00Z', -65, { refund: true, lines: [line('Slider', -1, -65)] }),
        p('2026-08-14T10:00:00Z', 99, { lines: [line('Fisken', 1, 99)] }),
    ]);
    assert.deepEqual(items.map(i => i.name), ['Fisken']);
});
