/**
 * services/planningTree.js
 * ════════════════════════════════════════════════════════════
 * Planlægningens drill-down som ét træ (docs/CLAUDE_PLANLAEGNING_DRILLDOWN.md).
 *
 * Planlægningen er en VIRTUEL bon: summen af de valgte bons' linjer + ekstra-
 * linjer. Intet gemmes. Træet beregnes her i ét kald; frontenden navigerer i
 * det uden flere kald og formaterer kun.
 *
 * Fase 1 = niveau 1–3 (Kategorier · Varer · Ønsker). Niveau 4–5 kommer i fase 2.
 *
 * Denne fil regner INTET selv — den sammensætter:
 *   enheder     bonUnitsExpr / unitsForLines (db/helpers) — samme tal som
 *               bons.total_units, ugeoversigt og sammentælling
 *   workload    countsAsWorkload — event-salg/udgift er ikke produktion
 *   rabat       services/bonDiscount.discountForLine
 *   moms        shared/moms.inclToExcl
 *   omsætning   getNonRevenuePaymentCodes (sponsorat/modregning = 0 kr)
 *   boks-split  services/economicInvoice.splitOre, vægt = nestingens servings
 *               (samme fordeling som e-conomic-udkastet)
 *
 * Svarets form: knuderne står ÉN gang i `nodes`; niveauerne og `children`
 * peger på dem via id. En vare optræder både under sin kategori og i Varer-
 * fanen, og en kilde under både vare og ønske — uden normalisering ville
 * svaret sende det samme flere gange.
 * ════════════════════════════════════════════════════════════
 */

const helpers = require('../db/helpers');
const { discountForLine, getNoDiscountCategories } = require('./bonDiscount');
const { splitOre } = require('./economicInvoice');
const { inclToExcl } = require('../shared/moms');
const { num: grocyNum } = require('../shared/grocy_num');

/** Ønsker grupperes på normaliseret tekst — ingen parsing (spec §6). */
function normRequest(s) {
    return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Kategoriens visningsnavn: "04 Slider" → "Slider". Sortering bruger det rå navn. */
function categoryLabel(cat) {
    const s = String(cat || '').trim();
    if (!s) return 'Uden kategori';
    return s.replace(/^\d+\s+/, '');
}

const ore = (kr) => Math.round((Number(kr) || 0) * 100);

/**
 * Hvilke opskrifter foldes ud, og i hvad? En linje er en boks når dens opskrift
 * nester mindst én opskrift med `sellable = 1` — de sælgelige børn er varerne
 * (spec §6). Ikke-sælgelige børn er produktion og hører til niveau 4.
 *
 * → Map(recipe_id → [{ recipe_id, servings, name, category }])
 */
function buildUnfoldMap(rawRecipes, nestings) {
    const byId = new Map((rawRecipes || []).map(r => [Number(r.id), r]));
    const sellable = (r) => String(r?.userfields?.sellable) === '1';
    const out = new Map();
    for (const n of nestings || []) {
        const pid = Number(n.recipe_id);
        const child = byId.get(Number(n.includes_recipe_id));
        if (!child || !sellable(child)) continue;
        if (!out.has(pid)) out.set(pid, []);
        out.get(pid).push({
            recipe_id: Number(child.id),
            servings: Number(n.servings) > 0 ? Number(n.servings) : 1,
            name: String(child.name || '').trim(),
            category: child.userfields?.grupper || null,
        });
    }
    return out;
}

/**
 * Del en linjes tal ud på boksens børn efter servings. Kroner og enheder
 * fordeles med splitOre (største rest), så summen er PRÆCIS linjens — en
 * boks der foldes ud må ikke ændre et tal. CO₂ fordeles proportionalt.
 */
function unfoldAtom(atom, parts) {
    const weights = parts.map(p => p.servings);
    const sum = weights.reduce((a, b) => a + b, 0);
    const units = splitOre(atom.units, weights);          // hele enheder, ingen øre
    const cost = atom.cost_ex == null ? null : splitOre(ore(atom.cost_ex), weights);
    const sale = atom.sale_ex == null ? null : splitOre(ore(atom.sale_ex), weights);
    return parts.map((p, i) => ({
        ...atom,
        item_key: 'r:' + p.recipe_id,
        grocy_recipe_id: p.recipe_id,
        name: p.name,
        category: p.category ?? atom.category,
        unit: 'stk',
        qty: atom.qty * p.servings,
        units: units[i],
        cost_ex: cost ? cost[i] / 100 : null,
        sale_ex: sale ? sale[i] / 100 : null,
        co2e_kg: atom.co2e_kg == null ? null : atom.co2e_kg * p.servings / sum,
        from_box: atom.name,
    }));
}

/* ── Knude-hjælpere ───────────────────────────────────────── */

function emptyValues() {
    return { cost_ex: 0, cost_unknown: 0, co2e_kg: 0, co2e_unknown: 0,
             sale_ex: 0, sale_unknown: 0, sale_bon: false, sale_list: false };
}

function addValues(v, a) {
    if (a.cost_ex == null) v.cost_unknown++; else v.cost_ex += a.cost_ex;
    if (a.co2e_kg == null) v.co2e_unknown++; else v.co2e_kg += a.co2e_kg;
    if (a.sale_ex == null) v.sale_unknown++; else v.sale_ex += a.sale_ex;
    if (a.source.extra) v.sale_list = true; else v.sale_bon = true;
}

/** Offentlig form: kun de tal brugeren må se. DB kræver både kost og salg. */
function publicValues(v, perms) {
    const out = { co2e_kg: round(v.co2e_kg, 3), co2e_unknown: v.co2e_unknown };
    if (perms.cost) { out.cost_ex = round(v.cost_ex, 2); out.cost_unknown = v.cost_unknown; }
    if (perms.sale) {
        out.sale_ex = round(v.sale_ex, 2);
        out.sale_unknown = v.sale_unknown;
        out.sale_basis = v.sale_bon && v.sale_list ? 'blandet' : v.sale_list ? 'liste' : v.sale_bon ? 'bon' : null;
    }
    if (perms.cost && perms.sale) {
        out.db_ex = round(v.sale_ex - v.cost_ex, 2);
        out.db_unknown = v.sale_unknown + v.cost_unknown;
    }
    return out;
}

function round(n, d) {
    const f = 10 ** d;
    return Math.round((Number(n) || 0) * f) / f;
}

function fmtQty(q) {
    const r = round(q, 2);
    return Number.isInteger(r) ? String(r) : String(r).replace('.', ',');
}

/**
 * Byg træet.
 *
 * @param {object} db
 * @param {object} input  { bonIds:number[], extras:[{grocy_recipe_id, quantity, price_category?}],
 *                          perms:{ cost:bool, sale:bool } }
 * @param {object} deps   { grocy } — testsøm; produktionen bruger adapteren
 */
async function buildPlanningTree(db, input, deps = {}) {
    const grocy = deps.grocy || require('./grocyAdapter');
    const perms = { cost: !!input?.perms?.cost, sale: !!input?.perms?.sale };
    const bonIds = [...new Set((input?.bonIds || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
    const extrasIn = (input?.extras || [])
        .map(e => ({ grocy_recipe_id: Number(e.grocy_recipe_id), quantity: Number(e.quantity),
                     price_category: e.price_category ? String(e.price_category) : 'catering' }))
        .filter(e => Number.isInteger(e.grocy_recipe_id) && e.quantity > 0);
    const warnings = [];

    /* ── Bons ─────────────────────────────────────────────── */
    let bons = [];
    if (bonIds.length) {
        const ph = bonIds.map(() => '?').join(',');
        bons = db.prepare(`
            SELECT b.id, b.bon_number, b.delivery_date, b.event_role, b.payment_type,
                   COALESCE(b.offer_discount_percent, 0) AS discount_pct,
                   sd.code AS status_code,
                   COALESCE(co.name, TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))) AS customer
              FROM bons b
              JOIN status_definitions sd ON sd.id = b.status_id
              LEFT JOIN customers c  ON c.id  = b.customer_id
              LEFT JOIN companies co ON co.id = b.company_id
             WHERE b.id IN (${ph})
        `).all(...bonIds);
    }
    // Event-salg og -udgifter er ikke produktion — maden er talt i prep-bonnen.
    const excluded = bons.filter(b => !helpers.countsAsWorkload(b)).map(b => b.bon_number);
    bons = bons.filter(b => helpers.countsAsWorkload(b));
    const bonById = new Map(bons.map(b => [b.id, b]));

    /* ── Bonlinjer med enheder (samme udtryk som bons.total_units) ── */
    let lines = [];
    if (bons.length) {
        const { contrib, join, args } = helpers.bonUnitsExpr();
        const ph = bons.map(() => '?').join(',');
        lines = db.prepare(`
            SELECT bl.id, bl.bon_id, bl.grocy_recipe_id, bl.product_name, bl.category,
                   bl.quantity, bl.unit, bl.unit_price, bl.line_total, bl.cost_price, bl.co2e,
                   bl.special_request, COALESCE(bl.is_accessory, 0) AS is_accessory,
                   CASE WHEN COALESCE(bl.is_accessory, 0) = 0 THEN ${contrib} ELSE 0 END AS units
              FROM bon_lines bl ${join}
             WHERE bl.bon_id IN (${ph})
             ORDER BY bl.bon_id, bl.sort_order, bl.id
        `).all(...args, ...bons.map(b => b.id));
    }

    /* ── Grocy: udfoldning af bokse + ekstra-linjernes data ── */
    let unfold = new Map();
    try {
        const [raw, nestings] = await Promise.all([grocy.getRecipesRaw(), grocy.getRecipeNestings()]);
        unfold = buildUnfoldMap(raw, nestings);
    } catch (e) {
        warnings.push('Opskrifterne kunne ikke hentes fra Grocy — bokse vises som bokse, ikke som deres indhold.');
    }

    let recipeById = new Map();
    if (extrasIn.length) {
        try {
            recipeById = new Map((await grocy.getRecipes()).map(r => [Number(r.id), r]));
        } catch (e) {
            warnings.push('Ekstra-linjerne kunne ikke slås op i Grocy og er ikke med.');
        }
    }

    const noDiscount = getNoDiscountCategories(db);
    const nonRevenue = new Set(helpers.getNonRevenuePaymentCodes());

    /* ── Atomer: én pr. (bonlinje eller ekstra) — før udfoldning ── */
    const atoms = [];
    for (const l of lines) {
        const bon = bonById.get(l.bon_id);
        const qty = Number(l.quantity) || 0;
        let sale = null;
        if (l.line_total != null) {
            const pct = discountForLine(l.category, bon.discount_pct, { noDiscountCategories: noDiscount });
            const net = nonRevenue.has(bon.payment_type) ? 0 : Number(l.line_total) * (1 - pct / 100);
            sale = inclToExcl(net);
        }
        atoms.push({
            item_key: l.grocy_recipe_id ? 'r:' + l.grocy_recipe_id : 'n:' + (l.product_name || '') + '|' + (l.unit || ''),
            grocy_recipe_id: l.grocy_recipe_id || null,
            name: String(l.product_name || '').trim(),
            category: l.category || null,
            unit: l.unit || 'stk',
            qty,
            units: Number(l.units) || 0,
            request: l.special_request ? String(l.special_request).trim() : '',
            date: bon.delivery_date,
            cost_ex: l.cost_price == null ? null : Number(l.cost_price) * qty,
            co2e_kg: l.co2e == null ? null : Number(l.co2e) * qty,
            sale_ex: sale,
            source: { bon_id: bon.id, bon_nr: bon.bon_number, customer: bon.customer || '',
                      delivery_date: bon.delivery_date, status: bon.status_code },
        });
    }

    const extraRows = [];
    for (const e of extrasIn) {
        const r = recipeById.get(e.grocy_recipe_id);
        if (!r) {
            if (recipeById.size) warnings.push(`Ekstra-opskrift ${e.grocy_recipe_id} findes ikke som salgbar opskrift i Grocy.`);
            continue;
        }
        extraRows.push({ e, r });
    }
    const extraUnits = helpers.unitsForLines(db, extraRows.map(({ e, r }) => ({
        quantity: e.quantity, category: r.category, grocy_recipe_id: r.id })));
    extraRows.forEach(({ e, r }, i) => {
        const priceIncl = grocyNum(r.prices?.[e.price_category]);
        atoms.push({
            item_key: 'r:' + r.id,
            grocy_recipe_id: Number(r.id),
            name: String(r.name || '').trim(),
            category: r.category || null,
            unit: r.unit || 'stk',
            qty: e.quantity,
            units: extraUnits[i] || 0,
            request: '',
            date: null,
            cost_ex: r.cost_price == null ? null : Number(r.cost_price) * e.quantity,
            co2e_kg: r.co2e == null ? null : Number(r.co2e) * e.quantity,
            // Listepris (Grocy er incl moms) — ikke en bonpris. Mærkes "liste".
            sale_ex: Number.isFinite(priceIncl) && priceIncl > 0 ? inclToExcl(priceIncl * e.quantity) : null,
            source: { extra: true, price_category: e.price_category },
        });
    });

    /* ── Udfold bokse ─────────────────────────────────────── */
    const flat = [];
    for (const a of atoms) {
        const parts = a.grocy_recipe_id ? unfold.get(Number(a.grocy_recipe_id)) : null;
        if (parts && parts.length) flat.push(...unfoldAtom(a, parts));
        else flat.push(a);
    }

    const tree = assemble(flat, { perms, warnings, excluded, bonCount: bons.length, extraCount: extraRows.length });

    // ── Fase 2: niveau 4 (Skal laves) og 5 (Råvarer) ──
    // Bygger på atomerne FØR udfoldning: resolveren folder selv bokse ud via
    // deres nestings, så en boks må ikke tælles både som boks og som indhold.
    const itemRecipes = new Map();
    for (const id of tree.levels.items) {
        const n = tree.nodes[id];
        const m = /^item:r:(\d+)$/.exec(id);
        if (m) itemRecipes.set(Number(m[1]), n.name);
    }
    try {
        const { buildProductionLevels } = require('./planningProduction');
        const prod = await buildProductionLevels({
            lines: atoms.filter(a => a.grocy_recipe_id).map(a => ({ grocy_recipe_id: a.grocy_recipe_id, quantity: a.qty })),
            itemRecipes, perms,
        }, deps.production || {});
        Object.assign(tree.nodes, prod.nodes);
        tree.levels.prep = prod.levels.prep;
        tree.levels.raw = prod.levels.raw;
        tree.level_totals = prod.level_totals;
        tree.sections = prod.sections || {};
        tree.meta.warnings.push(...prod.warnings);
    } catch (e) {
        tree.levels.prep = [];
        tree.levels.raw = [];
        tree.level_totals = null;
        tree.meta.warnings.push('Skal laves og Råvarer kunne ikke beregnes: ' + (e.message || e));
    }
    return tree;
}

/**
 * Saml atomerne til knuder. Ren funktion — testbar uden DB og Grocy.
 */
function assemble(flat, meta) {
    const perms = meta.perms;
    const nodes = {};
    const mk = (id, props) => (nodes[id] = { id, children: [], days: {}, ...props, _v: emptyValues() });
    const addDay = (n, date, amount) => { if (date) n.days[date] = round((n.days[date] || 0) + amount, 3); };

    const days = new Set();        // leveringsdage med noget på
    const unitsDays = {};          // enheder pr. dag (tabellens bundlinje)
    const items = new Map();       // item_key → node
    const cats = new Map();        // category → node
    const sources = new Map();     // node-id → node (kilde-blade)

    const sourceNode = (parentKey, a) => {
        const s = a.source;
        const id = 'src:' + parentKey + ':' + (s.extra ? 'x' : s.bon_id);
        let n = sources.get(id);
        if (!n) {
            n = mk(id, {
                kind: 'source',
                name: s.extra ? 'Ekstra (uden bon)' : '#' + s.bon_nr + (s.customer ? ' · ' + s.customer : ''),
                qty: 0, unit: a.unit, units: 0,
                source: s.extra ? { extra: true } : { bon_id: s.bon_id, bon_nr: s.bon_nr, customer: s.customer,
                                                        delivery_date: s.delivery_date, status: s.status },
            });
            sources.set(id, n);
        }
        return n;
    };

    const grow = (n, a) => {
        n.qty += a.qty;
        n.units += a.units;
        addDay(n, a.date, a.qty);
        addValues(n._v, a);
    };

    for (const a of flat) {
        if (a.date) {
            days.add(a.date);
            if (a.units) unitsDays[a.date] = (unitsDays[a.date] || 0) + a.units;
        }
        // Vare
        let it = items.get(a.item_key);
        if (!it) {
            it = mk('item:' + a.item_key, { kind: 'item', name: a.name, category: a.category,
                qty: 0, unit: a.unit, units: 0, _std: null, _req: new Map() });
            items.set(a.item_key, it);
        }
        grow(it, a);

        // Standard eller ønske-gruppe under varen
        let grp;
        if (a.request) {
            const key = normRequest(a.request);
            grp = it._req.get(key);
            if (!grp) {
                grp = mk('req:' + a.item_key + '|' + key, { kind: 'request', name: a.request,
                    request: a.request, qty: 0, unit: a.unit, units: 0, item_id: it.id });
                it._req.set(key, grp);
            }
        } else {
            grp = it._std;
            if (!grp) {
                grp = it._std = mk('std:' + a.item_key, { kind: 'standard', name: 'Standard',
                    qty: 0, unit: a.unit, units: 0, item_id: it.id });
            }
        }
        grow(grp, a);
        const src = sourceNode(grp.id, a);
        grow(src, a);
        if (!grp.children.includes(src.id)) grp.children.push(src.id);

        // Kategori
        const catKey = a.category || '';
        let c = cats.get(catKey);
        if (!c) {
            c = mk('cat:' + catKey, { kind: 'category', name: categoryLabel(catKey), category: catKey,
                qty: 0, unit: 'stk', units: 0 });
            cats.set(catKey, c);
        }
        c.qty += a.qty;
        c.units += a.units;
        addDay(c, a.date, a.units > 0 ? a.units : a.qty);
        addValues(c._v, a);
        if (!c.children.includes(it.id)) c.children.push(it.id);
    }

    const byName = (a, b) => String(nodes[a].name).localeCompare(String(nodes[b].name), 'da');

    // Varer: children = standard (hvis der er noget) + ønske-grupper. Uden ønsker
    // går man direkte til kilderne.
    const requestLevel = [];
    for (const it of items.values()) {
        const reqs = [...it._req.values()].sort((x, y) => y.qty - x.qty || x.name.localeCompare(y.name, 'da'));
        if (reqs.length) {
            it.children = [...(it._std ? [it._std.id] : []), ...reqs.map(r => r.id)];
            const reqQty = reqs.reduce((s, r) => s + r.qty, 0);
            it.badge = { text: reqs.length === 1 ? '1 ønske' : reqs.length + ' ønsker', tone: 'amber' };
            // Niveau 3: kun varer med ønsker, antal = de ønskede, "af N" = hele varen.
            const rq = mk('rq:' + it.id.slice(5), { kind: 'item_requests', name: it.name, category: it.category,
                qty: reqQty, unit: it.unit, units: 0, of_qty: it.qty, item_id: it.id });
            rq.children = reqs.map(r => r.id);
            for (const r of reqs) {
                for (const d of Object.keys(r.days)) addDay(rq, d, r.days[d]);
                // Værdierne summeres ikke her: de står på ønske-grupperne, og en sum
                // af en delmængde ville ligne varens samlede tal.
            }
            rq._v = null;
            requestLevel.push(rq.id);
        } else {
            // Ingen ønsker: standard-gruppen er hele varen og springes over.
            it.children = it._std ? [...it._std.children] : [];
            if (it._std) delete nodes[it._std.id];
        }
        delete it._std; delete it._req;
    }

    // Kategorier: tællende først (sammentællingens rækkefølge), så resten.
    const catIds = [...cats.values()]
        .sort((a, b) => (b.units > 0) - (a.units > 0)
            || String(a.category).localeCompare(String(b.category), 'da'))
        .map(c => {
            c.counts_as_unit = c.units > 0;
            c.children.sort((x, y) => byName(x, y));
            return c.id;
        });

    // Varer-fanen: fladt, i kategoriernes rækkefølge.
    const itemIds = [];
    for (const cid of catIds) itemIds.push(...nodes[cid].children);

    // Offentlig form: færdige tal, formateret antal, kun tilladte værdier.
    let totals = emptyValues();
    let units = 0;
    for (const n of Object.values(nodes)) {
        n.qty = round(n.qty, 3);
        n.qty_display = fmtQty(n.qty);
        if (n.kind === 'category') { units += n.units; for (const k of Object.keys(totals)) {
            if (typeof totals[k] === 'number') totals[k] += n._v[k];
            else totals[k] = totals[k] || n._v[k];
        } }
        n.values = n._v ? publicValues(n._v, perms) : null;
        delete n._v;
        if (!n.children.length) n.children = [];
    }
    // Kilde-blade sorteres efter dato, så tidligste levering står øverst.
    for (const n of Object.values(nodes)) {
        if (n.children.length && nodes[n.children[0]]?.kind === 'source') {
            n.children.sort((a, b) => String(nodes[a].source.delivery_date || '9999')
                .localeCompare(String(nodes[b].source.delivery_date || '9999')) || byName(a, b));
        }
    }

    return {
        levels: {
            categories: catIds,
            items: itemIds,
            requests: requestLevel.sort(byName),
        },
        nodes,
        totals: { units, units_days: unitsDays, ...publicValues(totals, perms) },
        // Dagskolonnerne i Pr. dag-tabellen: kun dage der har noget på (sorteret).
        days: [...days].sort(),
        perms,
        meta: {
            bon_count: meta.bonCount,
            extra_count: meta.extraCount,
            excluded_bons: meta.excluded,
            warnings: meta.warnings,
        },
    };
}

module.exports = { buildPlanningTree, assemble, buildUnfoldMap, unfoldAtom, normRequest, categoryLabel };
