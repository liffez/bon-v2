/**
 * services/posSales.js
 * ════════════════════════════════════════════════════════════
 * Rene funktioner bag POS-salgsbonnen: døgnskifte, produktkobling og
 * dagens aggregat. Ingen HTTP, ingen database, ingen tid-nu.
 *
 * Spec: docs/CLAUDE_ZETTLE_POS.md §6 (forretningsdag + event-kobling),
 *       §7 (produktkobling), §9 (refunderinger, ikke-event-omsætning).
 *
 * Alt her er bevidst holdt uden bivirkninger, så dagens tal kan efterprøves
 * mod en fixture uden at rejse hverken netværk eller skema.
 * ════════════════════════════════════════════════════════════
 */

/* ══════════════════════════════════════════════════════════════
   FORRETNINGSDAG (§6.1)
   ══════════════════════════════════════════════════════════════ */

const CUTOFF_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Hvilken salgsdag hører et køb til?
 *
 *   POS-tidsstempel (UTC) → træk døgnskiftet fra → aflæs datoen i København.
 *
 * Der lukkes typisk ved 24, men det trækker ud; et køb kl. 01:30 hører til
 * aftenen før. Default-skæringen er 04:00.
 *
 * ⚠️ Datoen aflæses gennem `Intl` i Europe/Copenhagen — nøjagtig som
 * `todayISO()` i db/helpers.js. `toISOString().slice(0,10)` ville give UTC og
 * dermed gårsdagen hele natten (pre-commit-hook, tests/dato.test.js).
 * Fratrækket sker på selve tidspunktet, så sommer-/vintertid følger med.
 */
function businessDate(occurredAt, cutoff = '04:00') {
    const m = CUTOFF_RE.exec(String(cutoff || '').trim());
    if (!m) throw new Error(`døgnskifte skal være HH:MM (00:00–23:59), fik "${cutoff}"`);
    const d = new Date(occurredAt);
    if (Number.isNaN(d.getTime())) throw new Error(`ugyldigt tidsstempel: "${occurredAt}"`);
    const shifted = new Date(d.getTime() - ((Number(m[1]) * 60 + Number(m[2])) * 60000));
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(shifted);
}

/* ══════════════════════════════════════════════════════════════
   PRODUKTKOBLING (§7)
   ══════════════════════════════════════════════════════════════ */

/** Fold til sammenlignelig form: små bogstaver, æøå udfoldet, tegnsætning væk. */
function normalizeName(s) {
    return String(s ?? '')
        .toLowerCase()
        .replace(/ø/g, 'oe').replace(/æ/g, 'ae').replace(/å/g, 'aa')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Ordene sorteret — "Slider kartoflen" og "Kartoflen slider" bliver ens. */
function tokenKey(s) {
    return normalizeName(s).split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Opslagstabeller over Grocy-opskrifter. Kollisioner (to opskrifter med samme
 * nøgle) lægges i `ambiguous` og matches IKKE — vi vælger ikke den ene på
 * må og få.
 */
function buildRecipeIndex(recipes) {
    const exact = new Map(), tokens = new Map(), ambiguous = new Set();
    for (const r of recipes || []) {
        for (const [map, key] of [[exact, normalizeName(r.name)], [tokens, tokenKey(r.name)]]) {
            if (!key) continue;
            if (map.has(key) && map.get(key).id !== r.id) { ambiguous.add(key); continue; }
            map.set(key, r);
        }
    }
    for (const k of ambiguous) { exact.delete(k); tokens.delete(k); }
    return { exact, tokens, ambiguous };
}

/**
 * POS-varenavn → Grocy-opskrift. To trin, i denne orden:
 *
 *   1. eksakt navn (normaliseret)
 *   2. ordsæt — samme ord, vilkårlig rækkefølge
 *
 * ⚠️ **Delstreng er bevidst UDELADT.** Målt på ægte data (§7) gav den forkerte
 * match på tre varer, hver gang en slider på den fuldstore ret:
 * "Slider kartoflen" → "Kartoflen" i stedet for "Kartoflen slider". En slider
 * til 55 kr ville arve den fuldstore rets kostpris, CO₂ og STYKLISTE — og
 * dermed forgifte top-up-/retur-forslaget, der eksploderer salget via Grocy-BOM.
 * Et forkert match er værre end intet match, fordi det ser rigtigt ud.
 * Resten kobles i hånden (pos_product_map).
 */
function matchRecipeByName(name, index) {
    if (!index) return null;
    const n = normalizeName(name);
    if (!n) return null;
    const e = index.exact.get(n);
    if (e) return { recipe: e, method: 'exact' };
    const t = index.tokens.get(tokenKey(name));
    if (t) return { recipe: t, method: 'tokens' };
    return null;
}

/* ══════════════════════════════════════════════════════════════
   DAGENS AGGREGAT
   ══════════════════════════════════════════════════════════════ */

const round2 = n => Math.round(n * 100) / 100;

function median(values) {
    if (!values.length) return 0;
    const v = [...values].sort((a, b) => a - b);
    const i = v.length >> 1;
    return v.length % 2 ? v[i] : (v[i - 1] + v[i]) / 2;
}

/**
 * Alle dagens køb → bon-linjer, betalingsmiddel-split og advarsler.
 *
 * @param {Array}  purchases  normaliserede køb (zettleAdapter.normalizePurchase)
 * @param {object} opts.recipeIndex  fra buildRecipeIndex — udelades ⇒ ingen navnematch
 * @param {Map}    opts.productMap   pos_product_uuid → { grocy_recipe_id } (manuel kobling, vinder)
 * @param {Map}    opts.recipesById  id → opskrift (kostpris/CO₂/kategori-snapshot)
 *
 * Linjer grupperes pr. (produkt, enhedspris). To priser samme dag giver to
 * linjer — ellers ville en prisændring midt på dagen blive til et gennemsnit
 * ingen har taget imod.
 *
 * Refunderinger nettes ind: de kommer med negativt antal, så dagens tal er
 * netto. Går en vare i minus, bliver den stående — det er virkeligheden
 * (solgt i går, refunderet i dag).
 */
function aggregateDay(purchases, { recipeIndex = null, productMap = new Map(), recipesById = new Map() } = {}) {
    const groups = new Map();
    const byPayment = {};
    const unmatched = new Map();
    let gross = 0, vat = 0, refundCount = 0;
    const suspectInvoice = [];

    for (const p of purchases) {
        gross += p.amount_incl;
        vat += p.vat_amount;
        if (p.is_refund) refundCount++;
        for (const pay of p.payments || []) {
            const k = pay.type || 'UKENDT';
            byPayment[k] = round2((byPayment[k] || 0) + pay.amount_incl);
        }

        for (const l of p.lines || []) {
            // Manuel kobling vinder over navnematch — et menneske har set på den.
            const mapped = l.product_uuid ? productMap.get(l.product_uuid) : undefined;
            let recipeId = null, method = null;
            if (mapped !== undefined) {
                recipeId = mapped?.grocy_recipe_id ?? null;
                method = recipeId ? 'manual' : 'manual_none';   // manual_none = "findes ikke i Grocy"
            } else {
                const hit = matchRecipeByName(l.name, recipeIndex);
                if (hit) { recipeId = hit.recipe.id; method = hit.method; }
            }

            const identity = l.product_uuid || ('adhoc:' + normalizeName(l.name));
            const key = `${identity}|${l.unit_price_incl}`;
            const g = groups.get(key) || {
                product_uuid: l.product_uuid || null,
                product_name: l.name || '(uden navn)',
                variant_name: l.variant_name || null,
                unit_price_incl: l.unit_price_incl,
                quantity: 0,
                grocy_recipe_id: recipeId,
                match_method: method,
            };
            g.quantity += l.quantity;
            groups.set(key, g);

            if (recipeId === null && method !== 'manual_none') {
                const u = unmatched.get(identity) || { product_uuid: l.product_uuid || null, name: l.name, quantity: 0, amount_incl: 0 };
                u.quantity += l.quantity;
                u.amount_incl = round2(u.amount_incl + l.line_total_incl);
                unmatched.set(identity, u);
            }
        }
    }

    // Linjer: drop dem der er nettet til nul (solgt og refunderet samme dag).
    const lines = [...groups.values()]
        .filter(g => g.quantity !== 0)
        .map(g => {
            const rec = g.grocy_recipe_id ? recipesById.get(g.grocy_recipe_id) : null;
            return {
                ...g,
                line_total_incl: round2(g.quantity * g.unit_price_incl),
                category: rec?.category ?? null,
                cost_price: rec?.cost_price ?? null,   // ex moms (Grocy-doktrin)
                co2e: rec?.co2e ?? null,
                unit: rec?.unit || 'stk',
            };
        })
        .sort((a, b) => b.line_total_incl - a.line_total_incl);

    /* ── Advarsler: ting der skal SES, ikke gættes væk ────────────────── */
    const flags = [];

    // (a) Linjerne skal summe til det der blev betalt. Gør de ikke, er der
    //     noget i kvitteringen vi ikke forstår (rabat på kvitteringsniveau?)
    //     — og så må bonnen ikke bare se rigtig ud.
    const lineSum = round2(lines.reduce((s, l) => s + l.line_total_incl, 0));
    if (Math.abs(lineSum - round2(gross)) > 0.01) {
        flags.push({ code: 'line_sum_mismatch', line_sum: lineSum, gross: round2(gross) });
    }

    // (b) Momsen skal ligge i prisen. Hele designet hviler på det.
    const excl = purchases.filter(p => p.taxation_mode && String(p.taxation_mode).toUpperCase() !== 'INCLUSIVE');
    if (excl.length) flags.push({ code: 'exclusive_vat', count: excl.length });

    // (c) Terminalen bruges også til at tage imod betaling på en FAKTURA
    //     (målt: "Fakture 4087", 5.321 kr). Fakturaen er allerede bogført —
    //     kom den også med på salgsbonnen, stod omsætningen to gange.
    //     Vi afviser den ikke automatisk (det ville være et gæt), men et
    //     enkeltstående stort køb uden Grocy-kobling skal ses.
    const amounts = purchases.filter(p => !p.is_refund).map(p => p.amount_incl);
    const med = median(amounts);
    for (const p of purchases) {
        if (p.is_refund || (p.lines || []).length !== 1) continue;
        const l = p.lines[0];
        const mapped = l.product_uuid ? productMap.get(l.product_uuid) : undefined;
        const known = (mapped && mapped.grocy_recipe_id) || matchRecipeByName(l.name, recipeIndex);
        if (known) continue;
        if (p.amount_incl < 1000) continue;
        if (amounts.length >= 3 && p.amount_incl < 5 * med) continue;
        suspectInvoice.push({ purchase_uuid: p.purchase_uuid, name: l.name, amount_incl: p.amount_incl });
    }
    if (suspectInvoice.length) flags.push({ code: 'possible_invoice_payment', purchases: suspectInvoice });

    return {
        lines,
        unmatched: [...unmatched.values()].sort((a, b) => b.amount_incl - a.amount_incl),
        by_payment: byPayment,
        gross_incl: round2(gross),
        vat_amount: round2(vat),
        purchase_count: purchases.length,
        refund_count: refundCount,
        flags,
    };
}

/* ══════════════════════════════════════════════════════════════
   EVENT-KOBLING (§6.2/§6.3)
   ══════════════════════════════════════════════════════════════ */

/**
 * Hvilket event hører dagen til?
 *
 * **Eventet slår POS til selv.** Vi udleder det ikke af datoen alene: et
 * forkert gæt ville lægge det ene events omsætning på det andet, og det ville
 * se helt rigtigt ud. Uden `pos_enabled` opstår der ingen bon.
 *
 *   præcis 1 kandidat            → auto
 *   flere, men ét matcher salgsstedet → auto (§6.3)
 *   ellers                       → unassigned / ambiguous, kobles i hånden
 *
 * @param {Array} events   kandidater der dækker datoen og har pos_enabled = 1
 * @param {Array} siteUuids  distinkte salgssteder blandt dagens køb
 */
function resolveEventForDay(events, siteUuids = []) {
    const list = events || [];
    if (list.length === 0) return { event_id: null, status: 'unassigned', reason: 'no_event', candidates: [] };
    if (list.length === 1) return { event_id: list[0].id, status: 'auto', reason: 'single', candidates: list };

    // Flere events samme dag: salgsstedet kan skille dem ad — men kun hvis
    // dagens køb kommer fra ÉT salgssted og præcis ét event peger på det.
    const sites = [...new Set(siteUuids.filter(Boolean))];
    if (sites.length === 1) {
        const bySite = list.filter(e => e.pos_store_ref && e.pos_store_ref === sites[0]);
        if (bySite.length === 1) return { event_id: bySite[0].id, status: 'auto', reason: 'site', candidates: list };
    }
    return { event_id: null, status: 'ambiguous', reason: 'multiple_events', candidates: list };
}

/* ══════════════════════════════════════════════════════════════
   TIMEFORDELING (§11)
   ══════════════════════════════════════════════════════════════ */

/** Klokketimen i København — ikke i UTC. Samme fælde som forretningsdagen. */
function localHour(occurredAt) {
    const d = new Date(occurredAt);
    if (Number.isNaN(d.getTime())) return null;
    return Number(new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Copenhagen', hour: '2-digit', hour12: false,
    }).format(d)) % 24;
}

/**
 * Salget fordelt på timer.
 *
 * Formålet er **bemanding**, ikke pynt: `CLAUDE_EVENT.md` §15.3 pkt. 2 parkerede
 * festival-kapacitet netop fordi ordre-fordelingen pr. time kun kan komme fra
 * eget POS. Derfor er ANTAL ORDRER det primære tal — det er dét man bemander
 * efter — og kronerne det sekundære.
 *
 * Timerne ordnes efter deres plads i FORRETNINGSDAGEN, ikke efter urets tal:
 * med skæring 04:00 læses en festivaldag 10, 11 … 23, 00, 01. Ellers ville en
 * aften der trækker over midnat lægge sig som en pukkel i venstre kant og se
 * ud som om der var run på om morgenen.
 *
 * Refunderinger tælles ikke som ordrer (ingen bemandes for en refundering),
 * men beløbet trækkes fra, så summen af timerne rammer dagens omsætning.
 *
 * `items` er ALT der gik over disken — hver vare er arbejde uanset kategori.
 * ⚠️ Det er bevidst IKKE husets "enheder" (`bons.total_units`), som kun tæller
 * kategorierne i `unit_count_categories` (sandwich/salat/slider). På festivalen
 * ville Luxus hotdog og pølserne tælle nul dér, og de er ~30 % af salget — så
 * en bemanding regnet på "enheder" ville være regnet på det halve køkken.
 */
function hourlyCurve(purchases, cutoff = '04:00') {
    const m = CUTOFF_RE.exec(String(cutoff || '').trim());
    if (!m) throw new Error(`døgnskifte skal være HH:MM, fik "${cutoff}"`);
    const startHour = Number(m[1]);

    const buckets = new Map();
    for (const p of purchases || []) {
        const h = localHour(p.occurred_at);
        if (h === null) continue;
        const b = buckets.get(h) || { hour: h, orders: 0, refunds: 0, items: 0, gross_incl: 0 };
        if (p.is_refund) b.refunds++; else b.orders++;
        b.items += (p.lines || []).reduce((s, l) => s + (Number(l.quantity) || 0), 0);
        b.gross_incl = round2(b.gross_incl + p.amount_incl);
        buckets.set(h, b);
    }
    if (!buckets.size) return { hours: [], peak: null, total_orders: 0, total_items: 0 };

    // Placering i forretningsdagen: 0 = skæringstimen.
    const pos = h => (h - startHour + 24) % 24;
    const hours = [...buckets.values()]
        .sort((a, b) => pos(a.hour) - pos(b.hour))
        .map(b => ({ ...b, label: String(b.hour).padStart(2, '0') + ':00' }));

    const peak = hours.reduce((best, h) => (!best || h.orders > best.orders ? h : best), null);
    return {
        hours,
        peak: peak ? { hour: peak.hour, label: peak.label, orders: peak.orders, items: peak.items, gross_incl: peak.gross_incl } : null,
        total_orders: hours.reduce((s, h) => s + h.orders, 0),
        total_items: hours.reduce((s, h) => s + h.items, 0),
    };
}

/**
 * Dagens mest solgte varer — rå navne fra kassen, uden Grocy.
 * Bevidst uafhængig af opskrift-koblingen: listen skal kunne vises selv når
 * Grocy er nede, og en ukoblet vare (fx Luxus hotdog, 20 % af en festivals
 * omsætning) hører absolut med i toppen.
 */
function topItems(purchases, limit = 10) {
    const agg = new Map();
    for (const p of purchases || []) {
        for (const l of p.lines || []) {
            const key = l.product_uuid || ('adhoc:' + normalizeName(l.name));
            const e = agg.get(key) || { name: l.name, quantity: 0, gross_incl: 0 };
            e.quantity += l.quantity;
            e.gross_incl = round2(e.gross_incl + l.line_total_incl);
            agg.set(key, e);
        }
    }
    return [...agg.values()]
        .filter(x => x.quantity !== 0)
        .sort((a, b) => b.gross_incl - a.gross_incl)
        .slice(0, limit);
}

module.exports = {
    localHour, hourlyCurve, topItems,
    businessDate,
    normalizeName, tokenKey, buildRecipeIndex, matchRecipeByName,
    aggregateDay, resolveEventForDay,
    median,
};
