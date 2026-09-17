/**
 * services/supplierPrices.js — leverandørpriser, læst og skrevet i Grocy (#657)
 *
 * Svarer på ét spørgsmål: "hvad koster én LAGER-enhed af denne vare, ex moms?"
 * Varemodtagelsen og lageroversigten sender svaret med til Grocy, når lageret
 * går op. Kendes svaret ikke, sendes der INGEN pris — aldrig et gæt. Grocy
 * fører så den forrige videre, præcis som før.
 *
 * GROCY ER ENESTE SANDHED. Bon gemmer ingen priser. Felterne er Grocys egne:
 *
 *   product_barcodes.last_price            pris pr. 1 af stregkodens enhed (qu_id)
 *   product_barcodes.amount + qu_id        hvor meget ét stk. af varenummeret indeholder
 *   userfield is_preferred                 hvilket varenummer der gælder (fandtes allerede)
 *   userfield is_agreement_item            aftalevare
 *   userfield hk_price_per_unit            leverandørens egen pris pr. stk.
 *   userfield hk_scraped_at                hvornår prisen er hentet
 *
 * Et manuelt OVERSLAG er også bare et varenummer — et internt et (`OVERSLAG-<id>`)
 * uden leverandør, hvis `last_price` er det tal nogen selv har skrevet. Derfor
 * bor overslaget samme sted som alt andet, og der er stadig kun én sandhed.
 * Det taber altid til en rigtig leverandørpris; det er sidste udvej før "ingen".
 *
 * `last_price` følger Grocys egen betydning: pris pr. ÉN af stregkodens enhed.
 * Det er det tal Grocy selv foreslår, når der købes på stregkoden, og det den
 * gamle scraper skrev (Salatost: 12,38 kr for 0,15 kg → 82,53 kr pr. kilo).
 * Omregningen til lager-enhed sker først ved brug, med den SAMME funktion som
 * varemodtagelsens mængder (#358) — så pris og mængde på samme lagerpost aldrig
 * bygger på hver sin enhed.
 *
 * Alle beløb er ex moms (moms-doktrinen §6b). Ingen momsomregning her.
 */

'use strict';

const { resolveToStockAmount } = require('./quConvert');

/** Hørkram-leverandøren genkendes på navn — samme regel som indkøbsindstillingerne. */
const HORKRAM_NAME_RE = /hørkram|hoka/i;

/** Hvor meget en udregnet kilopris må afvige fra leverandørens egen, før vi siger det. */
const PER_KG_WARN_SHARE = 0.3;

/**
 * Overslaget er et internt varenummer. Præfikset er dets identitet: alt der
 * viser LEVERANDØR-varenumre (indkøb, koblinger, Hørkram-opfriskning) skal
 * kende det igen og lade være med at vise det som en leverandør.
 */
const ESTIMATE_BARCODE_PREFIX = 'OVERSLAG-';
const ESTIMATE_NOTE = 'Manuelt overslag - ikke en leverandorpris';

function isEstimateBarcode(code) {
    return String(code == null ? '' : code).toUpperCase().startsWith(ESTIMATE_BARCODE_PREFIX);
}

function estimateBarcodeFor(productId) {
    return ESTIMATE_BARCODE_PREFIX + Number(productId);
}

const round4 = (n) => Math.round(n * 10000) / 10000;
// Stregkodens pris kan stå pr. GRAM (0,067875 kr/g). Med 4 decimaler bliver den
// til 0,0679 — og 67,90 kr/kg i stedet for 67,88. Derfor flere decimaler dér.
const round8 = (n) => Math.round(n * 1e8) / 1e8;
const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
};
const flag = (v) => v === 1 || v === '1' || v === true;

function isKiloUnit(name) {
    return /^(kilo|kg|kilogram)$/i.test(String(name || '').trim());
}

/* ── Rene regler ───────────────────────────────────────────── */

/**
 * Leverandørens pris for ét stk. → pris pr. 1 af stregkodens enhed.
 * Det er dét tal der skrives i stregkodens `last_price`.
 *
 * @param {object} a
 * @param {number} a.unitPrice      leverandørens pris for ét stk. (flasken, bakken …), ex moms
 * @param {number} a.content        stregkodens `amount` — hvad ét stk. indeholder
 * @param {string} a.barcodeUnit    navnet på stregkodens enhed (qu_id)
 * @param {number} [a.pricePerKg]   leverandørens egen kilopris
 * @returns {{ price: number|null, basis: 'content'|'per_kg'|null, note: string|null }}
 */
function barcodePriceFromSupplier({ unitPrice, content, barcodeUnit, pricePerKg }) {
    const up = num(unitPrice);
    const c  = num(content);
    const kg = num(pricePerKg);
    const kiloBarcode = isKiloUnit(barcodeUnit);

    if (up !== null && up > 0 && c !== null && c > 0) {
        const price = round8(up / c);
        let note = null;
        if (kiloBarcode && kg !== null && kg > 0 && Math.abs(price - kg) / kg > PER_KG_WARN_SHARE) {
            note = `Leverandørens egen kilopris er ${kg} — tjek indholdet på stregkoden`;
        }
        return { price, basis: 'content', note };
    }

    // Uden indhold kan leverandørens kilopris bruges direkte — men kun når
    // stregkoden er i kilo. Ellers er en kilopris ikke en pris pr. dens enhed.
    if (kiloBarcode && kg !== null && kg > 0) {
        return { price: round8(kg), basis: 'per_kg', note: null };
    }

    if (up === null || up <= 0) return { price: null, basis: null, note: 'Leverandøren oplyser ingen pris' };
    return { price: null, basis: null, note: 'Stregkoden mangler indhold (mængde og enhed)' };
}

/**
 * Stregkodens `last_price` → pris pr. produktets LAGER-enhed.
 * @returns {{ price: number|null, note: string|null }}
 */
function stockPriceFromBarcode({ barcode, product, conversions }) {
    const lp = num(barcode && barcode.last_price);
    if (lp === null || lp <= 0) return { price: null, note: 'Ingen pris på varenummeret' };
    const quId = barcode.qu_id != null && barcode.qu_id !== '' ? parseInt(barcode.qu_id) : null;
    if (!quId) return { price: null, note: 'Varenummeret har ingen enhed' };

    // Hvor mange lager-enheder er 1 af stregkodens enhed? Prisen deles med det.
    const r = resolveToStockAmount({ product, amount: 1, quId, conversions });
    if (r.error || !(r.amount > 0)) {
        return { price: null, note: 'Varenummerets enhed kan ikke omregnes til lager-enheden' };
    }
    return { price: round4(lp / r.amount), note: null };
}

/**
 * Hvilket varenummers pris gælder?
 *
 * @param {Array<{barcode, stock_price, is_preferred, is_agreement, is_estimate}>} candidates
 * @param {object} [opts]
 * @param {string} [opts.barcode]  varenummeret der FAKTISK blev leveret
 * @returns {{ price: number|null, candidate: object|null, reason: string, fell_back_from?: string }}
 *   reason: ordered | preferred | only | agreement | estimate
 *         | missing | ambiguous | preferred_unpriced | ordered_unpriced | ordered_unknown
 */
function resolveProductPrice(candidates, opts = {}) {
    const list = Array.isArray(candidates) ? candidates : [];
    const priced = (c) => c && num(c.stock_price) !== null && num(c.stock_price) > 0;
    const hit = (c, reason) => ({ price: num(c.stock_price), candidate: c, reason });

    // Overslaget deltager ikke i valget mellem leverandørernes varenumre — det
    // står udenfor og fanger kun det der ellers ville blive til "ingen pris".
    const all = list.filter(c => !c.is_estimate);
    const estimate = list.find(c => c.is_estimate && priced(c)) || null;
    const none = (reason) => (estimate
        ? { ...hit(estimate, 'estimate'), fell_back_from: reason }
        : { price: null, candidate: null, reason });

    // 1. Vi ved hvilket varenummer der kom. Mangler DET en pris, låner vi ikke en
    //    anden varenummers pris: posen og spanden koster ikke det samme.
    if (opts.barcode) {
        const c = all.find(x => String(x.barcode) === String(opts.barcode));
        if (!c) return none('ordered_unknown');
        return priced(c) ? hit(c, 'ordered') : none('ordered_unpriced');
    }

    // 2. Et menneske har markeret det foretrukne varenummer.
    const pref = all.filter(c => flag(c.is_preferred));
    if (pref.length === 1) return priced(pref[0]) ? hit(pref[0], 'preferred') : none('preferred_unpriced');

    // 3. Ellers kun når det er entydigt.
    const withPrice = all.filter(priced);
    if (withPrice.length === 0) return none('missing');
    if (withPrice.length === 1) return hit(withPrice[0], 'only');
    const agr = withPrice.filter(c => flag(c.is_agreement));
    if (agr.length === 1) return hit(agr[0], 'agreement');
    return none('ambiguous');
}

const REASON_TEXT = {
    ordered: 'det leverede varenummer',
    estimate: 'manuelt overslag',
    preferred: 'foretrukket varenummer',
    only: 'eneste varenummer med pris',
    agreement: 'aftalevare',
    missing: 'ingen pris',
    ambiguous: 'flere varenumre — markér hvilket der gælder',
    preferred_unpriced: 'det foretrukne varenummer har ingen pris',
    ordered_unpriced: 'det leverede varenummer har ingen pris',
    ordered_unknown: 'det leverede varenummer er ikke koblet til varen',
};

/* ── Læsning fra Grocy ─────────────────────────────────────── */

async function loadGrocyMeta(grocy) {
    const [barcodes, products, conversions, units] = await Promise.all([
        grocy.getProductBarcodes(), grocy.getProducts(),
        grocy.getQuantityUnitConversions(), grocy.getQuantityUnits(),
    ]);
    return {
        barcodes,
        conversions,
        productMap: new Map(products.map(p => [Number(p.id), p])),
        unitName: new Map(units.map(u => [Number(u.id), u.name])),
    };
}

function candidatesFor(meta, productId) {
    const product = meta.productMap.get(Number(productId));
    if (!product) return [];
    return meta.barcodes
        .filter(b => Number(b.product_id) === Number(productId))
        .map(b => {
            const uf = b.userfields || {};
            const s = stockPriceFromBarcode({ barcode: b, product, conversions: meta.conversions });
            return {
                id: b.id,
                barcode: String(b.barcode),
                last_price: num(b.last_price),
                unit: meta.unitName.get(Number(b.qu_id)) || null,
                amount: num(b.amount),
                stock_price: s.price,
                note: s.note,
                is_preferred: flag(uf.is_preferred),
                is_agreement: flag(uf.is_agreement_item),
                is_estimate: isEstimateBarcode(b.barcode),
                fetched_at: uf.hk_scraped_at || null,
                shopping_location_id: b.shopping_location_id || null,
            };
        });
}

/**
 * Prisen der skal sendes med til Grocy for et produkt, eller null.
 * @param {object} grocy  grocyAdapter (cachede læsninger)
 */
async function priceForStock(grocy, productId, opts = {}) {
    const meta = opts.meta || await loadGrocyMeta(grocy);
    const candidates = candidatesFor(meta, productId);
    const r = resolveProductPrice(candidates, opts);
    const product = meta.productMap.get(Number(productId));
    return {
        ...r,
        reason_text: REASON_TEXT[r.reason] || '',
        stock_unit: product ? meta.unitName.get(Number(product.qu_id_stock)) || null : null,
        candidates,
    };
}

/** Pris-status for alle aktive produkter: { [pid]: { price, reason, reason_text, stock_unit } }. */
async function priceOverview(grocy) {
    const meta = await loadGrocyMeta(grocy);
    const out = {};
    for (const [pid, p] of meta.productMap) {
        if (Number(p.active) === 0) continue;
        const candidates = candidatesFor(meta, pid);
        const r = resolveProductPrice(candidates);
        out[pid] = {
            price: r.price,
            reason: r.reason,
            reason_text: REASON_TEXT[r.reason] || '',
            barcode: r.candidate ? r.candidate.barcode : null,
            fetched_at: r.candidate ? r.candidate.fetched_at : null,
            stock_unit: meta.unitName.get(Number(p.qu_id_stock)) || null,
            is_estimate: r.reason === 'estimate',
            estimate_price: (candidates.find(c => c.is_estimate) || {}).stock_price ?? null,
            barcodes: candidates.map(c => ({
                id: c.id, barcode: c.barcode, stock_price: c.stock_price,
                note: c.note, is_estimate: c.is_estimate,
            })),
        };
    }
    return out;
}

/** Markér ét varenummer som foretrukket (og de andre som ikke). null = ryd. */
async function setPreferredBarcode(grocy, productId, barcodeId) {
    // Overslaget kan ikke være "foretrukken leverandør" — det har ingen leverandør.
    const barcodes = (await grocy.getProductBarcodes())
        .filter(b => Number(b.product_id) === Number(productId) && !isEstimateBarcode(b.barcode));
    if (barcodeId != null && !barcodes.some(b => Number(b.id) === Number(barcodeId))) {
        const e = new Error('Varenummeret hører ikke til varen');
        e.status = 400;
        throw e;
    }
    for (const b of barcodes) {
        const want = barcodeId != null && Number(b.id) === Number(barcodeId) ? '1' : '';
        const have = flag((b.userfields || {}).is_preferred) ? '1' : '';
        if (want !== have) await grocy.updateProductBarcodeUserfields(b.id, { is_preferred: want });
    }
}

/**
 * Ret et varenummers pris. Prisen tastes pr. LAGER-enhed (det tal man ser), og
 * gemmes som Grocys `last_price` — pr. 1 af stregkodens enhed.
 * @returns {{ last_price: number, stock_price: number }}
 */
async function setBarcodeStockPrice(grocy, barcodeId, stockPrice) {
    const p = num(stockPrice);
    if (p === null || p <= 0) {
        const e = new Error('Prisen skal være et positivt tal (kr pr. lager-enhed, ex moms)');
        e.status = 400; throw e;
    }
    const meta = await loadGrocyMeta(grocy);
    const b = meta.barcodes.find(x => Number(x.id) === Number(barcodeId));
    if (!b) { const e = new Error('Varenummeret findes ikke'); e.status = 404; throw e; }
    const product = meta.productMap.get(Number(b.product_id));
    const quId = b.qu_id != null && b.qu_id !== '' ? parseInt(b.qu_id) : null;
    const r = quId ? resolveToStockAmount({ product, amount: 1, quId, conversions: meta.conversions }) : null;
    if (!r || r.error || !(r.amount > 0)) {
        const e = new Error('Varenummerets enhed kan ikke omregnes til varens lager-enhed — ret enheden på stregkoden i Grocy');
        e.status = 400; throw e;
    }
    // 1 stregkode-enhed = r.amount lager-enheder → pris pr. stregkode-enhed = p × r.amount
    const lastPrice = round8(p * r.amount);
    await grocy.updateProductBarcode(b.id, { last_price: lastPrice });
    return { last_price: lastPrice, stock_price: round4(p) };
}

/**
 * Sæt (eller ryd) varens manuelle overslag.
 *
 * Overslaget gemmes som et internt varenummer i Grocy — ikke som et felt i Bon.
 * `amount: 1` i varens egen lager-enhed betyder at `last_price` ER prisen pr.
 * lager-enhed, og at overslaget læses tilbage gennem nøjagtig samme omregning
 * som ethvert andet varenummer. Ingen særvej, intet andet sted at holde styr på.
 *
 * @param {number|null} stockPrice  kr pr. lager-enhed, ex moms. null/0 rydder overslaget.
 * @returns {{ price: number|null, barcode: string, removed: boolean }}
 */
async function setEstimatePrice(grocy, productId, stockPrice) {
    const meta = await loadGrocyMeta(grocy);
    const product = meta.productMap.get(Number(productId));
    if (!product) { const e = new Error('Varen findes ikke'); e.status = 404; throw e; }

    const code = estimateBarcodeFor(productId);
    const existing = meta.barcodes.find(b =>
        Number(b.product_id) === Number(productId) && isEstimateBarcode(b.barcode));

    const p = num(stockPrice);
    if (p === null || p <= 0) {
        if (existing) await grocy.deleteProductBarcode(existing.id);
        return { price: null, barcode: existing ? String(existing.barcode) : code, removed: !!existing };
    }

    const quStock = product.qu_id_stock != null && product.qu_id_stock !== ''
        ? parseInt(product.qu_id_stock) : null;
    if (!quStock) {
        const e = new Error('Varen har ingen lager-enhed i Grocy');
        e.status = 400; throw e;
    }

    const price = round4(p);
    const fields = { qu_id: quStock, amount: 1, last_price: price, note: ESTIMATE_NOTE };
    if (existing) {
        await grocy.updateProductBarcode(existing.id, fields);
        return { price, barcode: String(existing.barcode), removed: false };
    }
    await grocy.createProductBarcode({ product_id: Number(productId), barcode: code, ...fields });
    return { price, barcode: code, removed: false };
}

/**
 * Varernes overslag: Map(product_id → pris pr. lager-enhed).
 * Bruges af kostprisen som sidste udvej, efter alt der er målt.
 */
async function estimatePrices(grocy) {
    const barcodes = await grocy.getProductBarcodes();
    const out = new Map();
    for (const b of barcodes) {
        if (!isEstimateBarcode(b.barcode)) continue;
        const p = num(b.last_price);
        if (p === null || p <= 0) continue;
        out.set(String(b.product_id), p);
    }
    return out;
}

/* ── Hørkram-opfriskning ───────────────────────────────────── */

/**
 * Hent friske Hørkram-priser og skriv dem på hver stregkode i Grocy.
 * Kun felter der faktisk ændrer sig, skrives.
 *
 * @param {object} db                    Bons DB — kun til at finde Hørkram-indkøbsstederne
 * @param {object} deps
 * @param {object} deps.grocy
 * @param {Function} deps.fetchSnapshots (ids) → { products, errors, failedIds }
 * @param {object} [opts]
 * @param {string[]} [opts.barcodes]     kun disse varenumre
 */
async function refreshHorkramPrices(db, deps, opts = {}) {
    const { grocy, fetchSnapshots } = deps;

    const hkIds = db.prepare(`SELECT id, name FROM suppliers`).all()
        .filter(s => HORKRAM_NAME_RE.test(s.name || '')).map(s => s.id);
    const locs = hkIds.length
        ? db.prepare(`SELECT grocy_location_id FROM supplier_grocy_locations
                      WHERE supplier_id IN (${hkIds.map(() => '?').join(',')})`).all(...hkIds)
        : [];
    const hkLocs = new Set(locs.map(r => Number(r.grocy_location_id)));
    const empty = { checked: 0, updated: 0, unchanged: 0, unpriced: [], dead: [], warnings: [], errors: [] };
    if (!hkLocs.size) return { ...empty, message: 'Ingen Grocy-indkøbssted er koblet til Hørkram' };

    const meta = await loadGrocyMeta(grocy);
    const only = opts.barcodes ? new Set(opts.barcodes.map(String)) : null;
    const hk = meta.barcodes.filter(b =>
        hkLocs.has(Number(b.shopping_location_id))
        && /^\d+$/.test(String(b.barcode || ''))
        && (!only || only.has(String(b.barcode))));
    if (!hk.length) return empty;

    const snap = await fetchSnapshots(hk.map(b => String(b.barcode)));
    const snapMap = new Map((snap.products || []).map(p => [String(p.varenummer), p]));
    const failed = new Set((snap.failedIds || []).map(String));
    const result = { ...empty, checked: hk.length, errors: [...(snap.errors || [])] };
    const now = new Date().toISOString(); // utc-ok: tidsstempel, ikke en dato

    for (const b of hk) {
        const vn = String(b.barcode);
        if (failed.has(vn)) continue;                  // opslaget fejlede — rør intet
        const s = snapMap.get(vn);
        const product = meta.productMap.get(Number(b.product_id));
        if (!s) { result.dead.push({ barcode: vn, name: product ? product.name : null }); continue; }

        // Hørkrams salgspris står pr. BASISENHED (flasken, ikke kassen) for alle
        // salgsenheder. Stregkodens `amount` beskriver netop én basisenhed.
        const units = s.salesUnits || [];
        const unit = units.find(u => u.code === s.baseUnitCode)
            || units.find(u => u.isDefault) || units[0] || null;
        const unitPrice = (unit && num(unit.salesPrice)) ?? num(s.pricePerUnit);

        const r = barcodePriceFromSupplier({
            unitPrice,
            content: b.amount,
            barcodeUnit: meta.unitName.get(Number(b.qu_id)),
            pricePerKg: s.pricePerKg,
        });
        if (r.note && r.price !== null) {
            result.warnings.push({ barcode: vn, name: product ? product.name : null, note: r.note });
        }
        if (r.price === null) {
            result.unpriced.push({ barcode: vn, name: product ? product.name : null, reason: r.note });
        }

        const uf = b.userfields || {};
        const ufPatch = {};
        const up = unitPrice !== null ? String(unitPrice) : '';
        if ((uf.hk_price_per_unit || '') !== up) ufPatch.hk_price_per_unit = up;
        const agr = s.isAgreementItem ? '1' : '';
        if ((uf.is_agreement_item || '') !== agr) ufPatch.is_agreement_item = agr;

        try {
            const priceChanged = r.price !== null && num(b.last_price) !== r.price;
            if (priceChanged) await grocy.updateProductBarcode(b.id, { last_price: r.price });
            // Datoen skrives altid: en uændret pris er også en SET pris, og uden
            // den ligner en stabil pris en gammel.
            const changed = priceChanged || Object.keys(ufPatch).length > 0;
            ufPatch.hk_scraped_at = now;
            await grocy.updateProductBarcodeUserfields(b.id, ufPatch);
            if (changed) result.updated++; else result.unchanged++;
        } catch (err) {
            result.errors.push({ barcode: vn, error: err.message });
        }
    }
    return result;
}

module.exports = {
    barcodePriceFromSupplier,
    stockPriceFromBarcode,
    resolveProductPrice,
    priceForStock,
    priceOverview,
    setPreferredBarcode,
    setBarcodeStockPrice,
    setEstimatePrice,
    estimatePrices,
    refreshHorkramPrices,
    loadGrocyMeta,
    candidatesFor,
    REASON_TEXT,
    HORKRAM_NAME_RE,
    ESTIMATE_BARCODE_PREFIX,
    isEstimateBarcode,
    estimateBarcodeFor,
};
