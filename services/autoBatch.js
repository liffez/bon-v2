// services/autoBatch.js
// ==========================================
// Hurtig-produktion ved LEVERET (#267).
//
// FORMÅLET ER SELVKORREKTION, IKKE AUTOMATISERING
// Lavede personalet mayonnaisen uden at registrere noget, er råvarerne fysisk
// væk mens Grocy stadig tæller dem, og produktet står fysisk mens Grocy siger
// 0. Når Bon laver batchen ved levering, trækker den råvarerne (retter det for
// høje tal) OG lægger produktet på (retter det for lave). Begge sider flytter
// mod virkeligheden — rimeligt, ikke på gram.
//
// Motoren kan ikke skelne "personalet lavede den" fra "der er svind", og skal
// ikke forsøge. Den fysiske optælling forbliver backstoppet.
//
// HVORFOR BON REGNER, OG IKKE GROCY
// Grocy har `POST /recipes/{id}/consume`, som gør begge sider i ét kald. Målt
// mod grocytest 22.08.2026 duer den ikke her:
//   · den tager INGEN parametre — mængden styres kun af `desired_servings`,
//     det kladdefelt der i #517 viste sig at forurene kostpriserne
//   · den forbruger "the in stock amount" af delvist dækkede råvarer, altså
//     aldrig hele batches
//   · og den lagde alligevel det FULDE udbytte på lageret: 2 kg remoulade,
//     selvom relish stod på 0 og aldrig blev trukket. Lager ud af ingenting,
//     uden en eneste fejlbesked (HTTP 204).
// Bon regner derfor selv og lader Grocy føre lageret via `self-production` —
// samme transaktionstype Grocy selv ville have skrevet.
//
// Forskellen på det og vores egen andels-regel (#560) er netop den sidste
// prik: rækker råvarerne kun til 88 % af et batch, laver vi 88 % — ikke et
// helt. Output er altid dækket af input. Grocys endpoint trak også kun det der
// var, men lagde det FULDE udbytte på, og det er dét der er lager ud af
// ingenting.
//
// KUN `RR produktion Hurtig`
// `RR Produktion` (langtidsstegt gris, syltede løg) laver personalet i
// forvejen efter plan. At auto-producere dem ville trække råvarer for noget
// ingen har lavet. Gruppen er hele grænsen mellem de to roller.
//
// Spec: docs/CLAUDE_HURTIG_PRODUKTION.md §4.2 + §4.4 + §4.5
// ==========================================

'use strict';

const { buildProducerIndex, yieldPerBatchStockOf, collectRecipeNeedsFlat,
        productionTypeOf } = require('./ingredientResolver');

const FLOAT_TOL = 1e-9;

/**
 * Hvor meget rækker råvarerne til?
 *
 * **Hele batches er en størrelse, ikke et veto** (§1b, #560). Reglen afgør hvor
 * meget der laves når det kan lade sig gøre — ikke OM der blev lavet noget.
 * Derfor to udfald:
 *
 *   · er der råd til mindst ét helt batch → hele batches, som hidtil.
 *     Køkkenet gemmer ikke en halv pose ublandet mayo, og overskuddet af
 *     råvarer står på hylden til næste bon.
 *   · ellers → den ANDEL den bindende råvare rækker til.
 *
 * Det andet udfald er det nye. Før returnerede funktionen 0, og så blev der
 * ikke produceret noget overhovedet: 1,2 gram hvidløg spærrede for en hel
 * Tahin-dressing, selvom falaflen blev leveret, dressingen blev lavet og
 * hvidløget blev brugt. Bonen var LEVERET — maden var ude af huset — og
 * lageret sagde noget andet.
 *
 * Hvorfor en ANDEL og ikke bare et helt batch trukket på det der er:
 * et helt batch ville lægge udbytte på lageret som råvarerne ikke dækker.
 * Det er præcis dét denne fils hoved afviser Grocys eget
 * `/recipes/{id}/consume` for ("lager ud af ingenting"). Med en andel er
 * output altid dækket af input — og i det tilfælde issuet handler om er de to
 * i praksis ens: hvidløget på hylden ER 88 % af et batch, så alle 0,0088 kg
 * trækkes, og der laves 0,88 batch dressing.
 *
 * Står en råvare på NUL, bliver svaret 0. Det er ikke et veto der er sneget
 * sig ind igen — det er det sande svar: uden relish blev der ikke lavet
 * remoulade, og så er der heller ingen mayonnaise at trække for den.
 *
 * @param perBatchNeeds  Map(product_id → mængde til ÉT batch, lager-enhed)
 * @param effectiveStock (pid) → lager, med børnenes lager rullet op på forælderen
 * @returns {number} antal batches — helt tal ved ≥ 1, ellers en brøkdel
 */
function affordableBatches(perBatchNeeds, effectiveStock) {
    let n = Infinity;
    for (const [pid, perBatch] of perBatchNeeds) {
        if (!(perBatch > FLOAT_TOL)) continue;
        const have = effectiveStock(pid);
        // Råvaren er der slet ikke. Svaret er nul, ikke en uendelig lille andel:
        // en andel på 2e-9 af et batch er ikke en delvis produktion, det er
        // afrundingsstøj forklædt som en beslutning.
        if (!(have > FLOAT_TOL)) return 0;
        n = Math.min(n, have / perBatch);
    }
    if (!Number.isFinite(n)) return 0;
    // Tolerancen hører KUN til ved helt-tals-grænsen: 0,49999999 kg til et
    // 0,5 kg-batch er ét batch, ikke 0,99999998 af et. I andels-grenen ville
    // den bare puste mængden en anelse op over det der står på hylden.
    if (n + FLOAT_TOL >= 1) return Math.floor(n + FLOAT_TOL);
    return Math.max(0, n);
}

/**
 * Læg en plan for hvad der skal produceres, uden at røre noget.
 *
 * Ren funktion: alt Grocy-data kommer ind som argumenter, så hele beslutningen
 * kan testes uden netværk.
 *
 * @param needs  [{ product_id, amount_stock }] — bonens samlede behov
 * @returns {{ batches: Array, skipped: Array }}
 *   `batches`  det der skal produceres (kan være tomt)
 *   `skipped`  varer vi bevidst IKKE producerer, med grund. Aldrig et tomt svar
 *              på et åbent spørgsmål.
 */
function planAutoBatches({ needs, rawRecipeMap, posByRecipe, nestingsByRecipe,
                           productMap, unitMap, quConversions, effectiveStock }) {
    const producerIndex = buildProducerIndex(rawRecipeMap);
    const batches = [];
    const skipped = [];

    for (const need of (needs || [])) {
        const pid = Number(need.product_id);
        const needed = Number(need.amount_stock) || 0;
        if (needed <= FLOAT_TOL) continue;

        const producers = producerIndex.get(pid);
        if (!producers || !producers.length) continue;      // ikke en produceret vare

        const product = productMap.get(pid);
        if (!product) continue;

        // Gruppen er grænsen. Er varen kun lavet af `RR Produktion`, rører vi
        // den ALDRIG — personalet laver den efter plan. Politikken aflæses via
        // den DELTE `productionTypeOf` (#329), så auto-batchen og lagertrækket
        // ikke kan blive uenige om hvem der laver hvad.
        const hurtig = producers.filter(r => productionTypeOf(r) === 'on_demand');
        if (!hurtig.length) continue;

        const stock = effectiveStock(pid);
        const shortfall = needed - stock;
        if (shortfall <= FLOAT_TOL) continue;               // der er dækning

        const recipeRaw = hurtig[0];                        // deterministisk sorteret
        const perBatch = yieldPerBatchStockOf(recipeRaw, product, unitMap, quConversions);
        if (perBatch == null || !(perBatch > FLOAT_TOL)) {
            // Uden et erklæret udbytte kan behovet ikke omsættes til batches.
            // Vi laver IKKE "ét batch og håber" — det ville lægge en ukendt
            // mængde på lageret. Hullet er et manglende felt i Grocy (#372).
            skipped.push({
                product_id: pid, product_name: product.name,
                recipe_id: recipeRaw.id, recipe_name: recipeRaw.name,
                needed, stock, reason: 'yield_unknown',
            });
            continue;
        }

        const batchesNeeded = Math.max(1, Math.ceil(shortfall / perBatch));

        // Råvarebehov for ÉT batch — grundlaget for både "rækker det?" og det
        // faktiske træk. Samme sæt begge steder: vi forbruger aldrig noget vi
        // ikke har tjekket, og tjekker aldrig noget vi ikke forbruger.
        const perBatchNeeds = new Map();
        collectRecipeNeedsFlat(recipeRaw.id, 1, posByRecipe, nestingsByRecipe, rawRecipeMap,
            (rawPid, amt) => perBatchNeeds.set(Number(rawPid), (perBatchNeeds.get(Number(rawPid)) || 0) + amt),
            new Set(), { skipEmballage: true });

        if (!perBatchNeeds.size) {
            skipped.push({
                product_id: pid, product_name: product.name,
                recipe_id: recipeRaw.id, recipe_name: recipeRaw.name,
                needed, stock, reason: 'no_ingredients',
            });
            continue;
        }

        const affordable = Math.min(batchesNeeded, affordableBatches(perBatchNeeds, effectiveStock));

        // Hvad mangler der, og hvor meget? Regnet på de batches vi VILLE lave,
        // så indkøbslisten dækker behovet og ikke bare det første batch.
        const missing = [];
        for (const [rawPid, perOne] of perBatchNeeds) {
            const behov = perOne * batchesNeeded;
            const haves = effectiveStock(rawPid);
            if (haves + FLOAT_TOL >= behov) continue;
            const rp = productMap.get(rawPid) || {};
            missing.push({
                product_id: rawPid,
                product_name: rp.name || `Produkt #${rawPid}`,
                needed: behov, stock: haves, shortfall: behov - haves,
            });
        }
        missing.sort((a, b) => a.product_name.localeCompare(b.product_name, 'da'));

        batches.push({
            product_id: pid,
            product_name: product.name,
            recipe_id: recipeRaw.id,
            recipe_name: recipeRaw.name,
            needed, stock, shortfall,
            per_batch: perBatch,
            batches_needed: batchesNeeded,
            batches_made: affordable,
            produce_amount: affordable * perBatch,
            consume: [...perBatchNeeds.entries()].map(([rawPid, perOne]) => ({
                productId: rawPid,
                perBatch: perOne,
                // Klampet til det der FAKTISK står. Ved en andel rammer den
                // bindende råvare pr. definition sit eget lagertal, og
                // flydende tal kan lande en brøkdel af en milliardtedel over —
                // nok til at Grocy svarer 400. Klampen gør det umuligt at
                // PLANLÆGGE et træk der er større end lageret; genforsøget i
                // `consumeWithFreshRetry` er værnet mod at lageret ændrer sig
                // under os, ikke mod vores egen afrunding.
                amount: Math.min(perOne * affordable, effectiveStock(rawPid)),
                productName: (productMap.get(rawPid) || {}).name || `Produkt #${rawPid}`,
                stockUnitName: unitNameOf(productMap.get(rawPid), unitMap),
            })),
            missing,
        });
    }

    return { batches, skipped };
}

function unitNameOf(product, unitMap) {
    if (!product || product.qu_id_stock == null) return '';
    const u = unitMap instanceof Map ? unitMap.get(Number(product.qu_id_stock))
                                     : (unitMap || []).find(x => Number(x.id) === Number(product.qu_id_stock));
    return u ? (u.name_short || u.name || '') : '';
}

/**
 * Nonce for en auto-batch. DETERMINISTISK, i modsætning til panelets tilfældige.
 *
 * `autoConsumeBonInventory` lader flaget stå på 0 når intet blev trukket, så
 * trækket kan gentages. Uden en fast nonce ville gentagelsen producere batchen
 * ÉN GANG TIL og lægge dobbelt op på lageret. Kollisionen på UNIQUE-kolonnen
 * er dermed selve værnet.
 */
function autoBatchNonce(bonId, recipeId) {
    return `auto:bon:${bonId}:recipe:${recipeId}`;
}

module.exports = { planAutoBatches, affordableBatches, autoBatchNonce };

/**
 * Udfør planen: producér i Grocy, skriv revisionsspor, læg manglende råvarer
 * på indkøbslisten.
 *
 * Leveringen blokeres ALDRIG. Rækker råvarerne ikke til et helt batch, laves
 * den andel der er dækning til, råvarerne trækkes, og resten bliver et synligt
 * spor på bonen (#560).
 *
 * `deps` gør hele udførelsen testbar uden Grocy og uden en rigtig database.
 *
 * @returns {{ produced: Array, skipped: Array, shortages: Array, errors: Array }}
 */
async function runAutoBatches(bonId, plan, deps) {
    const { db, grocy, locationId, userId = null, logChange } = deps;
    const produced = [], errors = [], shortages = [];

    for (const b of plan.batches) {
        if (b.missing.length) {
            shortages.push({ product_id: b.product_id, product_name: b.product_name,
                             batches_needed: b.batches_needed, batches_made: b.batches_made,
                             missing: b.missing });
        }
        if (b.batches_made <= 0) continue;

        const nonce = autoBatchNonce(bonId, b.recipe_id);
        const findes = db.prepare('SELECT id FROM production_batches WHERE batch_nonce = ?').get(nonce);
        if (findes) {
            // Trækket er blevet gentaget efter en fejl. Batchen er allerede lavet;
            // en ny ville lægge dobbelt op på lageret.
            continue;
        }

        // Kostpris pr. enhed: hvad batchen kostede, delt med hvad der kom ud.
        // Ex moms — Grocys indkøbspriser er ex moms (CLAUDE.md §6b).
        let batchCost = 0;
        for (const c of b.consume) batchCost += (c.amount || 0) * (deps.unitCost(c.productId) || 0);
        const pricePerUnit = b.produce_amount > FLOAT_TOL
            ? Math.round((batchCost / b.produce_amount) * 10000) / 10000
            : 0;

        let result;
        try {
            result = await grocy.produceBatch({
                consume: b.consume.map(c => ({ productId: c.productId, amount: c.amount })),
                produce: { productId: b.product_id, amount: b.produce_amount, price: pricePerUnit },
            });
        } catch (err) {
            errors.push({ product_id: b.product_id, product_name: b.product_name, error: err.message });
            continue;
        }

        // Revisionsspor i den tabel produktionsmodulet allerede har (#85).
        // Uden det ligner auto-batchen magi: køkkenet kan ikke se hvad systemet
        // gjorde for dem, og der er intet at forklare tallene med bagefter.
        try {
            const r = db.prepare(`
                INSERT INTO production_batches
                  (location_id, grocy_recipe_id, grocy_output_product_id, portions,
                   planned_output_qty, actual_output_qty, output_unit, batch_nonce,
                   state, master_cost, actual_cost, notes, produced_by_user_id,
                   produce_transaction_id, produced_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'))
            `).run(
                locationId, b.recipe_id, b.product_id, b.batches_made,
                b.produce_amount, b.produce_amount, b.unit || '', nonce,
                result.state, Math.round(batchCost * 100) / 100, Math.round(batchCost * 100) / 100,
                `Lavet af Bon ved levering af bon ${bonId}`, userId,
                result.produceTx || null,
            );
            const ins = db.prepare(`
                INSERT INTO production_batch_consumption
                  (production_batch_id, grocy_product_id, product_name, planned_qty,
                   actual_qty, unit, unit_cost)
                VALUES (?,?,?,?,?,?,?)
            `);
            for (const c of b.consume) {
                ins.run(r.lastInsertRowid, c.productId, c.productName,
                        c.amount, c.amount, c.stockUnitName || '',
                        Math.round((deps.unitCost(c.productId) || 0) * 100) / 100);
            }
        } catch (err) {
            // Grocy HAR produceret. At sporet fejler må ikke vælte leveringen,
            // men det skal ses — ellers står et lagertræk uden forklaring.
            errors.push({ product_id: b.product_id, product_name: b.product_name,
                          error: 'batch produceret, men sporet kunne ikke gemmes: ' + err.message });
        }

        produced.push({
            product_id: b.product_id, product_name: b.product_name,
            recipe_name: b.recipe_name, batches: b.batches_made,
            amount: b.produce_amount, price_per_unit: pricePerUnit, state: result.state,
        });
    }

    // Manglende RÅVARER på indkøbslisten — ikke det uindkøbelige mellemprodukt.
    const tilIndkoeb = new Map();
    for (const s of shortages) {
        for (const m of s.missing) {
            tilIndkoeb.set(m.product_id, Math.max(tilIndkoeb.get(m.product_id) || 0, m.shortfall));
        }
    }
    if (tilIndkoeb.size && grocy.addToShoppingList) {
        try {
            await grocy.addToShoppingList([...tilIndkoeb.entries()].map(([product_id, amount]) => ({
                product_id, amount, note: `Manglede til produktion ved bon ${bonId}`,
            })));
        } catch (err) {
            errors.push({ error: 'indkøbsliste: ' + err.message });
        }
    }

    if (logChange && (produced.length || shortages.length || errors.length)) {
        logChange({
            entityType: 'bon', entityId: bonId, action: 'auto_batch', fieldName: 'stock',
            oldValue: null,
            newValue: JSON.stringify({ produced, shortages, skipped: plan.skipped, errors }),
            notes: produced.length
                ? `Bon lavede ${produced.length} produktion(er) ved levering`
                : 'Ingen produktion mulig — råvarer manglede',
        });
    }

    return { produced, skipped: plan.skipped, shortages, errors };
}

module.exports.runAutoBatches = runAutoBatches;
