/**
 * services/planningProduction.js
 * ════════════════════════════════════════════════════════════
 * Planlægningens niveau 4 (Skal laves) og 5 (Råvarer) — fase 2 af
 * docs/CLAUDE_PLANLAEGNING_DRILLDOWN.md. Kaldes af services/planningTree.js.
 *
 * Regner INTET selv — sammensætter:
 *   behov, lager, status   services/ingredientResolver.resolveIngredients
 *                          (samme opløsning som lagertrækket og "Lav snart")
 *   hvem laver hvad        buildProductionPolicy (produktionspolitikken, #329)
 *   kostpris (aktuel)      recipeCost.lineUnitCost — opskriften vinder for
 *                          producerede varer (#558), købte = vægtet snit (#557)
 *   CO₂ (aktuel)           co2Engine.resolveIngredient — samme regel som CO₂-rapporten
 *   "bruges i"             collectRecipeNeedsFlat
 *   🛒-mængden              resolverens shortfall_purchase (oprundet på serveren)
 *
 * Niveau 4 = de varer resolveren kalder producerbare. Resolveren stopper ved
 * en produceret vare (den laves i forvejen), så dens råvarer står IKKE i
 * råvarelisten. Derfor regnes niveau 5 som resolverens samlede behov for
 * bonlinjerne PLUS de batches der skal laves — så peberet til den mayo man
 * skal lave også kommer med, og status er resolverens egen, ikke en ny regel.
 * ════════════════════════════════════════════════════════════
 */

const R = require('./ingredientResolver');
const recipeCost = require('./recipeCost');
const co2Engine = require('./co2Engine');

const EPS = 1e-9;

function round(n, d) { const f = 10 ** d; return Math.round((Number(n) || 0) * f) / f; }
function fmtQty(q) {
    const r = round(q, 2);
    return Number.isInteger(r) ? String(r) : String(r).replace('.', ',');
}
// Grocy har enheder uden kort navn ("Gram", "Kilo") ved siden af dem med ("g",
// "kg"), så samme liste kunne vise begge. Kun visning — mængden er uændret.
const UNIT_SHORT = { gram: 'g', gr: 'g', kilo: 'kg', kilogram: 'kg', liter: 'l', milliliter: 'ml', antal: 'stk' };
function shortUnit(u) { const k = String(u || '').trim(); return UNIT_SHORT[k.toLowerCase()] || k; }

/** Behov, lager og mangel i SAMME enhed — resolverens display_factor på alle tre. */
function amounts(i) {
    let f = Number(i.display_factor) || 1;
    let unit = shortUnit(i.unit);
    // Én skala for alle tre tal: er et af dem over 1000 g, vises alt i kg
    // ("lager 2010 g" → "2,01 kg"). Ren visning.
    const big = Math.max(Number(i.needed_stock) || 0, Number(i.stock_amount) || 0) * f;
    if (big >= 1000 && (unit === 'g' || unit === 'ml')) { f = f / 1000; unit = unit === 'g' ? 'kg' : 'l'; }
    const need = (Number(i.needed_stock) || 0) * f;
    const stock = (Number(i.stock_amount) || 0) * f;
    const short = Math.max(0, need - stock);
    const fmt = (v) => fmtQty(v) + (unit ? ' ' + unit : '');
    return { unit, need, stock, short, need_display: fmt(need), stock_display: fmt(stock), short_display: fmt(short) };
}

/**
 * Det tjeklisten (fane 6) skal bruge for at logge og rette en vare gennem
 * optællingens egne endpoints (#673): Grocy-lokation, lager og behov i
 * LAGER-enhed, og den fysiske enhed varen sidst blev talt i.
 */
function checkInfo(i, product) {
    if (!product) return null;
    const uf = product.userfields || {};
    return {
        product_id: Number(i.product_id),
        location_id: Number(product.location_id) || null,
        stock_qty: Number(i.stock_amount) || 0,
        need_qty: Number(i.needed_stock) || 0,
        stock_unit: shortUnit(i.stock_unit_name),
        physical_unit_name: (uf.LastCheckedUnit && String(uf.LastCheckedUnit).trim()) || null,
    };
}

function groupLabel(name) {
    const s = String(name || '').trim();
    return s ? s.replace(/^\d+\s+/, '') : 'Uden varegruppe';
}

function emptyVal() { return { cost_ex: 0, cost_unknown: 0, co2e_kg: 0, co2e_unknown: 0 }; }
function addVal(sum, v) {
    if (v.cost == null) sum.cost_unknown += v.costUnknown ? 1 : 0; else sum.cost_ex += v.cost;
    if (v.co2 == null) sum.co2e_unknown++; else sum.co2e_kg += v.co2;
}
function publicVal(v, perms) {
    const out = { co2e_kg: round(v.co2e_kg, 3), co2e_unknown: v.co2e_unknown, basis: 'aktuel' };
    if (perms.cost) { out.cost_ex = round(v.cost_ex, 2); out.cost_unknown = v.cost_unknown; }
    return out;
}

/**
 * @param {object} input  { lines:[{grocy_recipe_id, quantity}], itemRecipes: Map(recipe_id → navn),
 *                          perms:{cost, sale} }
 * @param {object} deps   { grocy } — testsøm; produktionen bruger adapteren
 */
async function buildProductionLevels(input, deps = {}) {
    const grocy = deps.grocy || require('./grocyAdapter');
    const perms = input.perms || {};
    const warnings = [];
    const nodes = {};
    const out = { nodes, levels: { prep: [], raw: [] }, level_totals: { prep: null, raw: null }, warnings };

    const lines = (input.lines || []).filter(l => l.grocy_recipe_id && Number(l.quantity) > 0)
        .map(l => ({ grocy_recipe_id: Number(l.grocy_recipe_id), quantity: Number(l.quantity) }));
    if (!lines.length) {
        out.level_totals = { prep: publicVal(emptyVal(), perms), raw: publicVal(emptyVal(), perms) };
        return out;
    }

    const [rawMap, sellable, products, groups, pos, nestings, units, conversions] = await Promise.all([
        grocy.getRecipesRawMap(), grocy.getRecipes(), grocy.getProducts(), grocy.getProductGroups(),
        grocy.getAllRecipesPos(), grocy.getRecipeNestings(), grocy.getQuantityUnits(),
        grocy.getQuantityUnitConversions(),
    ]);
    const productById = new Map(products.map(p => [Number(p.id), p]));
    const groupById = new Map((groups || []).map(g => [Number(g.id), g]));
    const unitNumber = new Map((sellable || []).map(r => [Number(r.id), Number(r.unit_number) || 1]));
    const policy = R.buildProductionPolicy(rawMap);
    // Hvem laver varen — også når den er dækket af lager og resolveren derfor
    // ikke nævner en opskrift. Samme indeks (og samme valg ved flere) som resolveren.
    const producers = R.buildProducerIndex(rawMap);
    const rawList = [...rawMap.entries()].map(([id, r]) => ({ ...r, id: r.id ?? id }));

    /* ── Værdisætning: aktuelle priser og CO₂ ───────────────── */
    let costCtx = null;
    if (perms.cost) {
        try {
            const detail = await grocy.getProductUnitCostDetails(6);
            // recipeCost slår op med tekst-nøgler.
            const priceByProduct = new Map(), priceDetailByProduct = new Map();
            for (const [pid, d] of detail) {
                priceDetailByProduct.set(String(pid), d);
                if (d && d.cost > 0) priceByProduct.set(String(pid), d.cost);
            }
            costCtx = recipeCost.buildCtx({ recipes: rawList, pos, nestings, products, units, conversions,
                priceByProduct, priceDetailByProduct });
        } catch (e) {
            warnings.push('Kostpriserne kunne ikke hentes — kost på niveau 4–5 vises som ukendt.');
        }
    }
    const co2Ctx = co2Engine.buildCtx({ recipes: rawList, pos, nestings, products, conversions, units });
    const costMemo = new Map(), co2Memo = new Map();
    function valueOf(pid, amountStock) {
        const product = productById.get(Number(pid));
        const v = { cost: null, costUnknown: !!perms.cost, co2: null };
        if (!product) return v;
        if (costCtx) {
            const r = recipeCost.lineUnitCost(product, null, costCtx, costMemo, new Set());
            if (r.unit_cost != null) v.cost = r.unit_cost * amountStock;
        }
        const c = co2Engine.resolveIngredient(product, amountStock, co2Ctx, co2Memo, new Set());
        if (c.status === 'na') v.co2 = 0;            // bevidst udeladt — ikke en mangel
        else if (c.status === 'ok') v.co2 = c.total;
        return v;
    }

    /* ── Behov: bonlinjerne, og så + de batches der skal laves ── */
    const A = await R.resolveIngredients(lines);
    const producibleA = A.raw.ingredients.filter(i => i.producible);

    const producerLines = [];
    const estimated = [];
    for (const i of producibleA) {
        const short = (Number(i.needed_stock) || 0) - (Number(i.stock_amount) || 0);
        if (!(short > EPS) || !i.make_recipe_id || !(i.make_batches > 0)) continue;
        if (i.make_estimated) { estimated.push(i.product_name); continue; }
        producerLines.push({ grocy_recipe_id: Number(i.make_recipe_id),
            quantity: i.make_batches * (unitNumber.get(Number(i.make_recipe_id)) || 1),
            _pid: i.product_id });
    }
    if (estimated.length) {
        warnings.push('Udbyttet mangler i Grocy for ' + estimated.join(', ') +
            ' — deres råvarer er ikke regnet med i niveau 5, og antallet de skal laves i kan ikke bestemmes.');
    }
    const B = producerLines.length
        ? await R.resolveIngredients(lines.concat(producerLines.map(l => ({ grocy_recipe_id: l.grocy_recipe_id, quantity: l.quantity }))))
        : A;

    /* ── "Bruges i": hvilke varer (niveau 2) indeholder den producerede vare ── */
    const posByRecipe = {}, nestingsByRecipe = {};
    pos.forEach(p => { (posByRecipe[p.recipe_id] = posByRecipe[p.recipe_id] || []).push(p); });
    nestings.forEach(n => { (nestingsByRecipe[n.recipe_id] = nestingsByRecipe[n.recipe_id] || []).push(n); });
    const usedIn = new Map();
    for (const [rid, name] of (input.itemRecipes || new Map())) {
        const pids = new Set();
        R.collectRecipeNeedsFlat(Number(rid), 1, posByRecipe, nestingsByRecipe, rawMap, (pid) => pids.add(Number(pid)));
        for (const pid of pids) {
            if (!usedIn.has(pid)) usedIn.set(pid, []);
            usedIn.get(pid).push(name);
        }
    }

    /* ── Niveau 4: Skal laves ─────────────────────────────── */
    const prepRows = [...producibleA];
    const seenA = new Set(producibleA.map(i => i.product_id));
    // En kæde (Ingrid ærter udblødt → Falaffel): en vare der først bliver nødvendig
    // fordi en ANDEN skal laves, står kun i det samlede behov.
    for (const i of B.raw.ingredients) if (i.producible && !seenA.has(i.product_id)) prepRows.push(i);

    const batchLine = new Map(producerLines.map(l => [l._pid, l]));
    const prepTotal = emptyVal();
    for (const i of prepRows) {
        const pid = Number(i.product_id);
        const type = policy.get(pid) || 'to_stock';
        const v = valueOf(pid, Number(i.needed_stock) || 0);
        const sum = emptyVal(); addVal(sum, v); addVal(prepTotal, v);
        const am = amounts(i);
        const node = nodes['prep:' + pid] = {
            id: 'prep:' + pid, kind: 'prep', name: i.product_name,
            qty: round(am.need, 3), qty_display: fmtQty(am.need), unit: am.unit,
            need_display: am.need_display, short_display: am.short_display,
            production_type: type,
            // Niveau 4 spørger "kan den laves?", ikke "er der noget på hylden?":
            // dækket → ok · råvarerne er der → kan_laves · ellers opskriftens egen
            // status (mangler/lav/ukendt). Alle tre er resolverens tal.
            status: (i.effective_status === 'ok' || i.effective_status === 'kan_laves')
                ? i.effective_status : (i.make_status || i.effective_status || i.status),
            stock_display: am.stock_display,
            make: {
                batches: i.make_batches ?? null,
                recipe_id: i.make_recipe_id ?? (producers.get(pid)?.[0]?.id ?? null),
                recipe_name: i.make_recipe_name ?? (producers.get(pid)?.[0]?.name ?? null),
                estimated: !!i.make_estimated,
                make_status: i.make_status ?? null,
                missing: (i.make_shortfalls || []).map(s => s.product_name),
            },
            used_in: usedIn.get(pid) || null,
            check: type === 'to_stock' ? checkInfo(i, productById.get(pid)) : null,
            // Varegruppen, så tjeklisten kan dele de færdige varer op som råvarerne.
            group_name: (() => {
                const gid = Number(productById.get(pid)?.product_group_id) || 0;
                return gid ? groupLabel(groupById.get(gid)?.name || `Varegruppe ${gid}`) : '';
            })(),
            days: {},
            values: publicVal(sum, perms),
            children: [],
        };
        // Børn: råvarerne i de batches der skal laves — resolverens egne tal.
        const bl = batchLine.get(i.product_id);
        if (bl) {
            const C = await R.resolveIngredients([{ grocy_recipe_id: bl.grocy_recipe_id, quantity: bl.quantity }]);
            for (const c of C.raw.ingredients) {
                const cid = 'prepraw:' + pid + ':' + c.product_id;
                const cv = valueOf(c.product_id, Number(c.needed_stock) || 0);
                const cs = emptyVal(); addVal(cs, cv);
                nodes[cid] = {
                    id: cid, kind: 'prep_raw', name: c.product_name,
                    qty: round(amounts(c).need, 3), qty_display: fmtQty(amounts(c).need), unit: amounts(c).unit,
                    status: c.status, stock_display: amounts(c).stock_display,
                    days: {}, values: publicVal(cs, perms), children: [],
                };
                node.children.push(cid);
            }
        }
        out.levels.prep.push(node.id);
    }
    // Tre afsnit (afgjort 25.09): det der skal laves i forvejen, det Bon laver
    // ved levering, og det der er dækket af lager (foldet sammen i visningen).
    // Inden for et afsnit: det der ikke kan laves af det der er, øverst — det
    // kræver indkøb, ikke bare tid.
    const PREP_RANK = { mangler: 0, lav: 1, ukendt: 2, kan_laves: 3, ok: 4 };
    const byRank = (a, b) => (PREP_RANK[nodes[a].status] ?? 5) - (PREP_RANK[nodes[b].status] ?? 5)
        || String(nodes[a].name).localeCompare(String(nodes[b].name), 'da');
    const secs = { to_stock: [], on_demand: [], covered: [] };
    for (const id of out.levels.prep) {
        const n = nodes[id];
        if (n.status === 'ok') secs.covered.push(id);
        else secs[n.production_type === 'on_demand' ? 'on_demand' : 'to_stock'].push(id);
    }
    out.sections = { prep: [
        { key: 'to_stock',  title: 'Skal laves i forvejen', ids: secs.to_stock.sort(byRank) },
        { key: 'on_demand', title: 'Laves ved levering',    ids: secs.on_demand.sort(byRank),
          note: 'Bon laver dem selv når bonen leveres' },
        { key: 'covered',   title: 'Dækket af lager',       ids: secs.covered.sort(byRank), collapsed: true },
    ].filter(x => x.ids.length) };
    out.levels.prep = out.sections.prep.flatMap(x => x.ids);

    /* ── Niveau 5: Råvarer, grupperet efter varegruppe ──────── */
    const rawTotal = emptyVal();
    const grpNodes = new Map();
    for (const i of B.raw.ingredients) {
        if (i.producible) continue;              // står på niveau 4
        const pid = Number(i.product_id);
        const product = productById.get(pid) || {};
        const gid = Number(product.product_group_id) || 0;
        let g = grpNodes.get(gid);
        if (!g) {
            const gname = gid ? (groupById.get(gid)?.name || `Varegruppe ${gid}`) : '';
            g = { id: 'pgrp:' + gid, kind: 'raw_group', name: groupLabel(gname), sort: gname,
                  qty: 0, qty_display: '', unit: '', days: {}, children: [], _v: emptyVal(), _short: 0 };
            grpNodes.set(gid, g);
        }
        const v = valueOf(pid, Number(i.needed_stock) || 0);
        const s = emptyVal(); addVal(s, v); addVal(g._v, v); addVal(rawTotal, v);
        const short = (Number(i.needed_stock) || 0) - (Number(i.stock_amount) || 0) > EPS;
        const rid = 'raw:' + pid;
        nodes[rid] = {
            id: rid, kind: 'raw', name: i.product_name,
            qty: round(amounts(i).need, 3), qty_display: fmtQty(amounts(i).need), unit: amounts(i).unit,
            status: i.status,
            // Mangler = behovet er større end lageret. Samme regel som gruppens
            // "N mangler" og Råvarer-filteret — ét sted.
            short,
            stock_display: amounts(i).stock_display,
            check: checkInfo(i, product),
            // Indkøbslisten som i Råvarer-modalen i dag: mængden er oprundet på
            // serveren (shortfall_purchase). Nettomangel mod indkøbslisten og
            // bestillinger hører til indkøbs-sessionen (spec §8).
            cart: short && i.shortfall_purchase > 0
                ? { product_id: pid, amount: i.shortfall_purchase, unit: i.purchase_unit || '' } : null,
            days: {}, values: publicVal(s, perms), children: [],
        };
        g.children.push(rid);
        if (short) g._short++;
    }
    const STATUS_ORDER = { mangler: 0, lav: 1, ok: 2 };
    // Varegruppens nummer styrer rækkefølgen; uden varegruppe og emballage sidst.
    const grpRank = (g) => /emballage/i.test(g.sort) ? 2 : (g.sort ? 0 : 1);
    const grpList = [...grpNodes.values()].sort((a, b) =>
        (grpRank(a) - grpRank(b)) || String(a.sort).localeCompare(String(b.sort), 'da'));
    for (const g of grpList) {
        g.children.sort((a, b) => (STATUS_ORDER[nodes[a].status] ?? 3) - (STATUS_ORDER[nodes[b].status] ?? 3)
            || String(nodes[a].name).localeCompare(String(nodes[b].name), 'da'));
        g.qty = g.children.length;
        g.qty_display = String(g.children.length);
        g.short_count = g._short;
        if (g._short) g.badge = { text: g._short + ' mangler', tone: 'red' };
        g.values = publicVal(g._v, perms);
        delete g._v; delete g._short; delete g.sort;
        nodes[g.id] = g;
        out.levels.raw.push(g.id);
    }

    out.level_totals = { prep: publicVal(prepTotal, perms), raw: publicVal(rawTotal, perms) };
    return out;
}

module.exports = { buildProductionLevels, _amounts: amounts, _shortUnit: shortUnit };
