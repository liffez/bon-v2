// scripts/test-consume-race.js
// ============================================================
// Lagertrækket læser friskt og prøver igen (#589) + auto-batchen blokerer
// aldrig (#560).
//
// DRIFTS-TILFÆLDET, 3. september 2026:
//
//   B4238  09:06:06  5 produkter fejlede
//   B4240  09:06:06  8 produkter fejlede
//   B4253  09:06:09  9 produkter fejlede
//
// Tre bons inden for tre sekunder. Alle tre læste det samme cachede
// lager-snapshot (10 minutters TTL) og regnede HVOR MEGET der skulle trækkes
// ud fra det. Den første trak; de næste bad om mere end der var tilbage, og
// Grocy svarede 400. Bonsene endte som `partial`: noget trukket, resten ikke,
// lageret for højt for de fejlede varer — og trækket kan ikke gentages, for
// flaget er sat.
//
// Det ramte præcis de varer der ligger tæt på nul: Purløg 0,024 ·
// Salt-Flager 0,012 · Løvstikke 0,0081.
//
// Kapløbet kan ikke fremprovokeres mod en rigtig Grocy, så her stubbes både
// POST'en og lager-læsningen gennem det `deps`-søm adapteren har til formålet.
// Det var netop fordi tilstanden aldrig blev testet at fejlen overlevede.
//
//   node --experimental-sqlite scripts/test-consume-race.js
// ============================================================
'use strict';

const path = require('path');
const os   = require('os');

process.env.DB_PATH = path.join(os.tmpdir(), `bon-consume-race-${Date.now()}.db`);

let pass = 0, fail = 0;
const ok    = m => { console.log('  \x1b[32m✓\x1b[0m', m); pass++; };
const bad   = m => { console.log('  \x1b[31m✗\x1b[0m', m); fail++; };
const check = (c, m) => (c ? ok : bad)(m);
const head  = t => console.log(`\n\x1b[1m${t}\x1b[0m`);
const near  = (a, b) => Math.abs(a - b) < 1e-9;

// Grocys egen ordlyd ved præcis denne afvisning. Koden må IKKE genkende den på
// teksten — den står her for at bevise at genforsøget virker uden at læse den.
const GROCY_400 = 'Grocy POST fejl 400: {"error_message":"Amount to be consumed '
                + 'cannot be > current stock amount (if supplied, at the desired location)"}';

// ── Stubbet ingrediens-opløsning. Skal ligge i require-cachen før adapteren
//    slår den op (den requires lazy INDE i consumeRecipes, så det virker). ──
const resolverPath = require.resolve('../services/ingredientResolver');
const realResolver = require(resolverPath);
let RESOLVED = [];
require.cache[resolverPath].exports = {
    ...realResolver,
    resolveConsumeItems: async () => RESOLVED.map(r => ({ ...r })),
    buildProducerIndex: () => new Map(),
};

const grocy = require('../services/grocyAdapter');
const { consumeWithFreshRetry, consumeRecipes, produceBatch } = grocy;

const PURLOEG = { id: 51, name: 'Purløg', qu_id_stock: 2, qu_id_purchase: 2 };
const products = async () => [PURLOEG];
const stockOf  = amount => async () => [{ product_id: PURLOEG.id, amount }];

/**
 * En Grocy der kun har `have` på hylden: alt over afvises, som den rigtige gør.
 * `calls` er det revisionsspor testen måler på.
 */
function grocyMed(have) {
    const calls = [];
    return {
        calls,
        get have() { return have; },
        post: async (path, body) => {
            calls.push({ path, amount: body.amount });
            if (path.endsWith('/add')) return { transaction_id: 'add-' + calls.length };
            if (body.amount > have + 1e-12) throw new Error(GROCY_400);
            have -= body.amount;
            return { transaction_id: 'tx-' + calls.length };
        },
        read: async () => [{ product_id: PURLOEG.id, amount: have }],
    };
}

/**
 * En rigtig lille Grocy på localhost.
 *
 * Nødvendig fordi selve pointen i #589 er at trækket ikke må læse gennem
 * CACHEN — og det kan ikke bevises ved at injicere en lager-læser i testen:
 * så beviser man kun at den injicerede blev brugt. Her tælles HTTP-kaldene, så
 * "hentede den friskt?" bliver et faktum i stedet for en påstand.
 */
function startFakeGrocy() {
    const http = require('http');
    const hits = {};
    let stockAmount = 0;
    const srv = http.createServer((req, res) => {
        const route = req.url.split('?')[0];
        hits[route] = (hits[route] || 0) + 1;
        const body = route === '/stock'
            ? [{ product_id: PURLOEG.id, amount: stockAmount }]
            : route === '/objects/products' ? [PURLOEG] : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    return new Promise(resolve => srv.listen(0, '127.0.0.1', () => {
        resolve({
            srv, hits,
            port: srv.address().port,
            set: v => { stockAmount = v; },
        });
    }));
}

(async () => {

// ══════════════════════════════════════════════════════════════
head('0 · Trækket læser IKKE gennem cachen');
// ══════════════════════════════════════════════════════════════
const fake = await startFakeGrocy();
{
    const { getDb } = require('../db/database');
    const db = getDb();
    const locId = db.prepare(`SELECT value FROM settings WHERE key = 'default_grocy_location_id'`).get();
    db.prepare(`UPDATE locations SET grocy_api_url = ?, grocy_api_key = 'test' WHERE id = ?`)
      .run(`http://127.0.0.1:${fake.port}`, Number(locId.value));
    grocy.clearCache();

    fake.set(5);
    await grocy.getStock();
    await grocy.getStock();
    check(fake.hits['/stock'] === 1, 'getStock() er cachet — to kald giver ét HTTP-kald (uændret)');

    fake.set(2);   // en anden bon har trukket imens
    const frisk = await grocy.getStockFresh();
    check(fake.hits['/stock'] === 2, 'getStockFresh() går uden om cachen');
    check(frisk[0]?.amount === 2, 'og ser det NYE tal, ikke det cachede');

    const efter = await grocy.getStock();
    check(efter[0]?.amount === 2,
          'og den primer cachen, så de næste læsere ikke får serveret det gamle tal');

    // Kernen: cachen er varm og LYVER (siger 9, hylden har 2). Trækket må ikke
    // bruge den. Ingen `readStock` injiceres her — det er netop standarden der
    // skal bevises.
    grocy.clearCache();
    fake.set(9);
    await grocy.getStock();                       // varm cache med det forkerte tal
    const foer = fake.hits['/stock'];
    fake.set(2);

    RESOLVED = [{
        product_id: PURLOEG.id, product_name: 'Purløg', amount_stock: 4,
        qu_id_stock: 2, qu_id_purchase: 2, parent_product_id: null, purchase_factor: 1,
    }];
    const g = grocyMed(2);
    const results = await consumeRecipes(
        [{ grocy_recipe_id: 1, quantity: 1 }], null, null, null,
        { post: g.post, addToShoppingList: async () => {} },
    );
    check(fake.hits['/stock'] > foer, 'consumeRecipes henter lageret friskt frem for at bruge den varme cache');
    check(near(results[0]?.amount ?? -1, 2),
          'og trækker de 2 der faktisk står — ikke de 4 den varme cache ville have tilladt');

    // Og helt uden `deps`: den vej drift faktisk går. Alle standarder skal være
    // de rigtige — en test der altid injicerer beviser kun at injektionen virker.
    grocy.clearCache();
    fake.set(3);
    const uden = await consumeRecipes([{ grocy_recipe_id: 1, quantity: 1 }]);
    check(uden[0]?.success === true && uden[0]?.error == null,
          'consumeRecipes uden deps kører hele vejen igennem på sine egne standarder');
    check((fake.hits['/stock/products/51/consume'] || 0) === 1,
          'og POSTer til den rigtige Grocy — standard-`post` er den ægte grocyPost');
    check((fake.hits['/objects/products'] || 0) >= 1, 'produkterne hentes gennem den rigtige adapter');
    grocy.clearCache();
}

// ══════════════════════════════════════════════════════════════
head('1 · Kapløbet: den anden bon fejler ikke længere');
// ══════════════════════════════════════════════════════════════
{
    // B4238 nåede at trække først. Vores snapshot sagde 0,024 — der er 0,010.
    const g = grocyMed(0.010);
    const res = await consumeWithFreshRetry(PURLOEG.id, 0.024, {
        post: g.post, readStock: g.read, readProducts: products,
    });

    check(res.error === null, 'trækket lykkes — ikke `partial` fordi to bons læste samme snapshot');
    check(near(res.consumed, 0.010), 'og der trækkes præcis det der ER: 0,010, ikke de 0,024 vi troede');
    check(res.clamped === true, 'det siges at mængden blev klampet, så kalderen kan regne manglen om');
    check(g.calls.length === 2, 'ét afvist forsøg, ét genforsøg — ikke en løkke der bliver ved');
    check(near(g.calls[0].amount, 0.024) && near(g.calls[1].amount, 0.010),
          'genforsøget bruger det FRISKE tal, ikke det vi startede med');
    check(res.response?.transaction_id === 'tx-2',
          'Grocys svar gives videre — revisionssporet i production_batch_consumption skal have transaction-id\'et');
}

// ══════════════════════════════════════════════════════════════
head('2 · Afvisningen genkendes på lageret, ikke på Grocys ordlyd');
// ══════════════════════════════════════════════════════════════
{
    // Grocy er nede. Et friskt læs siger at varen er der i rigelige mængder,
    // så fejlen handlede om noget andet — den skal STÅ, ikke prøves i ring.
    let n = 0;
    const res = await consumeWithFreshRetry(PURLOEG.id, 0.02, {
        post: async () => { n++; throw new Error('Grocy POST fejl 500: server error'); },
        readStock: stockOf(99), readProducts: products,
    });
    check(res.error?.includes('500'), 'en fejl der ikke handler om lageret rapporteres som fejl');
    check(res.consumed === 0, 'og der påstås intet trukket');
    check(n === 1, 'der prøves ikke igen når lageret siger at der er rigeligt');

    // Samme fejltekst som det ægte kapløb, men lageret er uændret: heller ikke
    // her må vi prøve igen — det ville skjule en ægte fejl bag et genforsøg.
    let m = 0;
    const res2 = await consumeWithFreshRetry(PURLOEG.id, 0.02, {
        post: async () => { m++; throw new Error(GROCY_400); },
        readStock: stockOf(0.02), readProducts: products,
    });
    check(m === 1 && res2.error !== null,
          'også når teksten ER Grocys 400 — det er lagertallet der afgør, ikke ordlyden');

    // Drift 14.–16.09: 13 bons faldt på SAMME produkt, forælderen «kål», med
    // Grocys anden 400 — «Product does not exist or is inactive». Den handler
    // ikke om mængden, og et genforsøg kan ikke hjælpe: varen er sat inaktiv i
    // Grocy. Prøven her er at vi ser dét og lader fejlen stå.
    //
    // Fælden er at forælderen ALTID har 0 på sin egen lagerrække — børnene
    // (Spidskål, Hvidkål) bærer beholdningen. Læste vi kun forælderens eget
    // tal, ville vi klampe til nul og rapportere en ægte fejl som en MANGEL.
    const KAAL      = { id: 60, name: 'kål' };
    const SPIDSKAAL = { id: 61, name: 'Spidskål', parent_product_id: 60 };
    const GROCY_INAKTIV = 'Grocy POST fejl 400: '
        + '{"error_message":"Product does not exist or is inactive"}';
    let k = 0;
    const res3 = await consumeWithFreshRetry(KAAL.id, 0.3472, {
        post: async () => { k++; throw new Error(GROCY_INAKTIV); },
        readStock: async () => [
            { product_id: KAAL.id,      amount: 0 },      // forælderen: altid tom
            { product_id: SPIDSKAAL.id, amount: 5.2 },    // barnet bærer lageret
        ],
        readProducts: async () => [KAAL, SPIDSKAAL],
        allowSubstitution: true,
    });
    check(k === 1, 'en inaktiv vare prøves ikke igen — det er ikke mængden der er problemet');
    check(res3.error?.includes('inactive'), 'fejlen står, med Grocys egen begrundelse');
    check(res3.consumed === 0 && res3.clamped === false,
          'og den rapporteres som fejl, ikke som en mangel: børnenes lager tæller med på forælderen');
}

// ══════════════════════════════════════════════════════════════
head('3 · Genforsøget er bundet');
// ══════════════════════════════════════════════════════════════
{
    // Et lager der bliver ved med at skride under os: tre bons i kø.
    let have = 0.03;
    let n = 0;
    const res = await consumeWithFreshRetry(PURLOEG.id, 0.03, {
        post: async (p, b) => { n++; have -= 0.01; throw new Error(GROCY_400); },
        readStock: async () => [{ product_id: PURLOEG.id, amount: have }],
        readProducts: products,
    });
    check(n === 3, 'højst tre kald i alt: første forsøg plus to genforsøg');
    check(res.error !== null, 'og taber vi stadig, siges det — vi påstår ikke at det lykkedes');
    check(res.consumed === 0, 'og intet regnes som trukket');
}

// ══════════════════════════════════════════════════════════════
head('4 · Er hylden tom, er det en mangel — ikke en fejl');
// ══════════════════════════════════════════════════════════════
{
    const g = grocyMed(0);
    const res = await consumeWithFreshRetry(PURLOEG.id, 0.024, {
        post: g.post, readStock: g.read, readProducts: products,
    });
    check(res.error === null, 'et træk klampet til nul er ikke et mislykket kald');
    check(res.consumed === 0, 'der blev trukket nul');
    check(g.calls.length === 1, 'og vi POSTer ikke en nul-mængde til Grocy');
}

// ══════════════════════════════════════════════════════════════
head('5 · Manglen regnes ud fra det der FAKTISK blev trukket');
// ══════════════════════════════════════════════════════════════
{
    // Kernen i hvorfor et genforsøg ikke er nok i sig selv: klampes mængden
    // ned, er der så meget desto MERE at købe. Regnes manglen på det vi bad
    // om, bliver indkøbslinjen for lille, og varen mangler igen i morgen.
    // Bonen skal bruge 2,4 kg. Det forældede snapshot siger 3,0 — der er 1,0.
    //
    // Med den GAMLE kode var manglen `behov − snapshot` = 2,4 − 3,0 → 0, altså
    // slet INGEN indkøbslinje: snapshottet sagde jo at der var rigeligt. Og
    // trækket fejlede oveni. Varen manglede dagen efter uden at nogen havde
    // bedt om den. Manglen skal regnes på det der FAKTISK blev trukket.
    RESOLVED = [{
        product_id: PURLOEG.id, product_name: 'Purløg', amount_stock: 2.4,
        qu_id_stock: 2, qu_id_purchase: 2, parent_product_id: null, purchase_factor: 1,
    }];
    const g = grocyMed(1.0);
    const indkoeb = [];
    let foerste = true;
    const results = await consumeRecipes(
        [{ grocy_recipe_id: 1, quantity: 1 }], null, null, null,
        {
            post: g.post,
            readStock: async () => {
                const a = foerste ? 3.0 : g.have;   // første læsning = det forældede tal
                foerste = false;
                return [{ product_id: PURLOEG.id, amount: a }];
            },
            readProducts: products,
            addToShoppingList: async (pid, amount) => { indkoeb.push({ pid, amount }); },
        },
    );

    const r = results[0];
    check(r?.success === true, 'bonen ender IKKE som fejlet');
    check(near(r?.amount ?? -1, 1.0), 'der blev trukket 1,0 — alt hvad der var');
    check(near(r?.shortfall_stock ?? -1, 1.4),
          'manglen er 1,4 — regnet på det trukne, ikke på de 2,4 vi bad om');
    check(indkoeb.length === 1,
          'der kommer en indkøbslinje — den gamle regel så en mangel på nul og bestilte INTET');
    check(indkoeb[0]?.amount === 2,
          'og den dækker hele manglen (1,4 rundet op til hele indkøbsenheder = 2)');
    check(r?.partial === true, 'linjen er delvist dækket, og det står der');
}

// ══════════════════════════════════════════════════════════════
head('6 · Auto-batchens træk klampes også (#560 uden #589 ville fejle her)');
// ══════════════════════════════════════════════════════════════
{
    // Uden vetoet trækker auto-batchen netop det der ligger tæt på nul. Før
    // klampen gik mængden direkte fra planen til Grocy — ingen Math.min.
    const g = grocyMed(0.0088);
    const res = await produceBatch(
        { consume: [{ productId: PURLOEG.id, amount: 0.010 }],
          produce: { productId: 70, amount: 0.88, price: 1 } },
        { post: g.post, readStock: g.read, readProducts: products },
    );
    check(res.failedLines.length === 0, 'et forældet tal vælter ikke produktionen');
    check(res.state === 'produced', 'og batchen regnes som lavet');
    check(near(res.consumeTx[0]?.amount ?? -1, 0.0088), 'der trækkes det der er');
    check(res.consumeTx[0]?.transactionId === 'tx-2',
          'transaction-id\'et bevares gennem genforsøget — routes/production.js skriver det i sporet');
}

// ══════════════════════════════════════════════════════════════
fake.srv.close();
console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} PASS · ${fail} FAIL\x1b[0m`);
process.exit(fail ? 1 : 0);

})().catch(err => { console.error(err); process.exit(1); });
