/**
 * shared/recipe_lines.js
 * ════════════════════════════════════════════════════════════
 * Linjemodellen (designer-spec §14): type, badge, kolonner, udfoldning.
 *
 * HVORFOR DEN LIGGER FOR SIG
 * Editoren tegner de samme linjer fire steder — listen, gennemgangspanelet,
 * mobilkortet og importens forhåndsvisning (§15). Skrev hver af dem sin egen
 * regel for hvornår en linje er "uafklaret", hvilket badge den bærer og om den
 * kan foldes ud, ville de skride fra hinanden. Det er præcis dét der gjorde
 * `_buildMailVars` til tre uenige udgaver.
 *
 * HVAD DEN IKKE GØR
 * Den regner ingenting. Alle tal — gram, kostpris, CO₂e — kommer fra
 * `/api/opskrifter/beregn`, som får dem fra `recipeCost` og `co2Engine`. En
 * tabel hvis linjer ikke lægger sammen til overskriften er værre end ingen
 * tabel (#360's fejlklasse).
 *
 * REGLERNE DEN BÆRER
 *   R6.1  Handlinger ligger ALTID i ⋯ — en linje må ikke skifte form
 *   R6.2  Steppere kun for stk-enheder; vægt og volumen får et talfelt
 *   R6.3  Statusprikken er afklaret/ikke-afklaret, ikke lagerstatus
 *   R6.4  Enhedsnavne normaliseres i visningen: stk, g, kg, ml, l
 *   R6.5  Svind er en ANNOTATION efter navnet; mængden er uberørt (I2)
 *   R7.5  Emballage kendes på VAREGRUPPEN, ikke på sektionsnavnet
 *   R7.6  Linjer uden sektion står øverst uden overskrift
 *   R8.1  En uafklaret linje har stiplet kant og åben statusprik
 *   §8.3  1–3 uafklarede er gule (undtagelsen); 4+ er dæmpede
 *   I3    Et manglende tal gør linjen til et MINDSTETAL, ikke til en fejl
 * ════════════════════════════════════════════════════════════
 */
(function (root, factory) {
    const m = factory();
    if (typeof module === 'object' && module.exports) module.exports = m;
    else root.RecipeLines = m;
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/** Over så mange uafklarede holder vi op med at farve — se §8.3. */
const GUL_GRAENSE = 3;

/* ── Enheder ──────────────────────────────────────────────────────────
   R6.4: Grocy har både `Kilo`, `kg`, `Kilogram` og `gram` i drift. Brugeren
   skal se ét navn, ikke fem. Vi oversætter KUN til visning — det der gemmes
   er fortsat `qu_id`, så intet tal kan flytte sig af en etiket.            */
const ENHED_VIS = new Map([
    ['kilo', 'kg'], ['kilogram', 'kg'], ['kg', 'kg'],
    ['gram', 'g'], ['g', 'g'],
    ['liter', 'l'], ['l', 'l'],
    ['milliliter', 'ml'], ['ml', 'ml'],
    ['antal', 'stk'], ['stk', 'stk'], ['styk', 'stk'], ['stykker', 'stk'],
]);

/** Enheder man tæller i. Kun de her får steppere (R6.2). */
const TAELLE_ENHEDER = new Set(['stk']);

function visEnhed(navn) {
    const n = String(navn == null ? '' : navn).trim();
    if (!n) return '';
    return ENHED_VIS.get(n.toLowerCase()) || n;
}

/** Tæller man den, eller vejer man den? Afgør stepper vs. talfelt (R6.2). */
function erTaelleenhed(navn) {
    return TAELLE_ENHEDER.has(visEnhed(navn));
}

/* ── Tal ──────────────────────────────────────────────────────────────── */

/** Dansk komma tåles. Tomt og vrøvl giver null — aldrig 0, som ville lyve. */
function tal(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

/* ── Linjens identitet ────────────────────────────────────────────────── */

/**
 * Hvilken slags linje er det?
 *
 * Rækkefølgen er reglen: en linje med `new_product` er uafklaret uanset hvad
 * andet den bærer, for den peger ikke på noget der findes. Derefter afgør
 * #270-reglen — men den er allerede truffet af søgningen (`recipeSearch`), så
 * her aflæses den blot: `includes_recipe_id` ⇒ nesting, ellers vare.
 *
 * ⚠️ En gemt opskrift bærer INTET `semi_recipe_id` — i Grocy er et halvfabrikat
 * bare en varelinje, og det ER #270-reglen. Men så kan editoren ikke se det, og
 * dressingen ville stå som en almindelig vare uden vej til sin opskrift. Derfor
 * afgør SERVEREN det: `/beregn` sætter `producer_recipe_id` når prisen kommer
 * fra en opskrift (#558). Vi aflæser den frem for at slå det op forfra — det er
 * den samme regel, og to opslag ville kunne blive uenige.
 */
function typeFor(linje, beregnet) {
    if (!linje) return 'product';
    if (linje.new_product) return 'new';
    if (linje.includes_recipe_id != null && linje.includes_recipe_id !== '') return 'nesting';
    if (linje.semi_recipe_id != null && linje.semi_recipe_id !== '') return 'semi';
    if (beregnet && beregnet.producer_recipe_id != null) return 'semi';
    return 'product';
}

/** Badget. `null` for en almindelig vare — den skal ikke bære en etiket. */
function badgeFor(type) {
    switch (type) {
        case 'semi':    return { text: 'HALVFABRIKAT', expandable: true };
        case 'nesting': return { text: 'NESTING', expandable: true };
        case 'new':     return { text: 'NY VARE', expandable: false };
        default:        return null;
    }
}

/* ── Emballage (R7.5) ─────────────────────────────────────────────────── */

/**
 * Emballage kendes på VAREGRUPPEN, aldrig på sektionsnavnet.
 *
 * Det er ikke en detalje: madvægten og målvægt-bjælken bygger på skellet, og
 * en omdømt sektion ("Emballage" → "Til pakning") ville ellers flytte kg fra
 * emballage til mad uden at nogen rørte en linje.
 *
 * SERVEREN afgør det: `/beregn` sætter `is_packaging` pr. linje ud fra samme
 * gennemgang som madvægten. Det er dét der gør at browseren ikke behøver en
 * kopi af `co2Materials`-listen — og at reglen ikke kan skride ét sted uden
 * at skride begge.
 *
 * `erEmballageGruppe` i ctx er reserven for en linje serveren endnu ikke har
 * set (fx mens beregningen er undervejs). Findes heller ikke den, gætter vi
 * ikke: intet er emballage.
 */
function erEmballage(linje, ctx, beregnet) {
    if (beregnet && beregnet.is_packaging != null) return !!beregnet.is_packaging;
    const f = ctx && ctx.erEmballageGruppe;
    if (typeof f !== 'function') return false;
    const gid = linje && linje.product_group_id != null ? linje.product_group_id
              : (linje && linje.new_product ? linje.new_product.product_group_id : null);
    const navn = ctx.gruppeNavn && gid != null ? ctx.gruppeNavn.get(String(gid)) : null;
    return !!f(navn == null ? gid : navn);
}

/* ── Hvad mangler? ────────────────────────────────────────────────────── */

/**
 * En uafklaret linje kan mangle to slags ting, og de er ikke lige alvorlige:
 *
 *   enhed    → BLOKERER gem (R8.4). Uden den kan linjen ikke omregnes.
 *   pris/CO₂ → gør tallene til MINDSTETAL (R8.2/I3). Gem er tilladt.
 *
 * Skellet skal frem i visningen, ellers ligner "vi ved ikke hvad den koster"
 * det samme som "den kan ikke gemmes".
 */
function manglerFor(linje, beregnet) {
    const np = linje && linje.new_product;
    const mangler = [];
    let blokerer = false;

    if (np) {
        if (np.qu_id_stock == null || np.qu_id_stock === '') { mangler.push('enhed'); blokerer = true; }
        if (tal(np.price_per_unit) == null) mangler.push('pris');
        if (tal(np.co2e_per_unit) == null) mangler.push('co2');
        if (!String(np.name || '').trim()) { mangler.push('navn'); blokerer = true; }
    } else {
        if (beregnet && beregnet.missing_cost) mangler.push('pris');
        if (beregnet && beregnet.missing_co2) mangler.push('co2');
    }
    return { mangler, blokerer };
}

/** Kort, menneskelig besked til linjen når den er dæmpet (§8.3). */
function manglerTekst(mangler) {
    const ord = { enhed: 'mangler enhed', navn: 'mangler navn',
                  pris: 'mangler pris', co2: 'mangler CO₂' };
    return mangler.map(m => ord[m] || m).join(' · ');
}

/* ── Svind (R6.5 / I2) ────────────────────────────────────────────────── */

/**
 * Svind er en ANNOTATION, ikke et regnestykke i visningen.
 *
 * Bon annoterer, den transformerer ikke: står der 1,1 kg med 10 % rensesvind,
 * viser vi `1,1 kg` og skriver `+10 % rensesvind medregnet` ved siden af.
 * Vi regner ALDRIG baglæns til et "rent" tal — så ville skærmen vise et tal
 * ingen har tastet, og ingen kunne bagefter se hvilket der var hvilket.
 */
function svindTekst(linje) {
    const p = tal(linje && linje.waste_pct);
    if (p == null || p === 0) return null;
    const t = String(p).replace('.', ',');
    return '+' + t + ' % ' + ((linje.waste_label || 'svind')) + ' medregnet';
}

/* ── Én linje til visning ─────────────────────────────────────────────── */

/**
 * @param linje    kladdens linje (§13-formatet)
 * @param beregnet den matchende post fra `/beregn`s `lines[]`, eller null
 * @param ctx      { enhedNavn: Map<id,navn>, gruppeNavn: Map<id,navn>,
 *                   erEmballageGruppe: fn }
 */
/**
 * Linjens mængde som den vises: lager-enheden ganget op med serverens faktor.
 *
 * To decimaler, som serveren selv afrunder til — ellers ville feltet vise
 * 1,995 hvor serveren siger 2, og de to ville se uenige ud om det samme tal.
 */
function visMængde(linje, b) {
    const raa = tal(linje.amount);
    const f = b && b.display_factor;
    if (raa == null || f == null || !isFinite(f) || f <= 0) return raa;
    return Math.round(raa * f * 100) / 100;
}

function buildLine(linje, beregnet, ctx) {
    const c = ctx || {};
    const b = beregnet || null;
    const type = typeFor(linje, b);
    const np = linje.new_product || null;

    // Enheden kommer fra SERVEREN når den har set linjen (`/beregn` sender den
    // ved siden af mængden). Ellers slås den op lokalt — det er reserven, ikke
    // kilden, så en cachet browser ikke kan sætte en forkert etiket på et tal.
    const quId = np ? np.qu_id_stock
               : (linje.qu_id_stock != null ? linje.qu_id_stock : (b && b.qu_id_stock));
    const raaEnhed = (b && b.unit) ||
        (quId != null && c.enhedNavn ? c.enhedNavn.get(String(quId)) : null);
    // En nesting tælles i portioner — men opskriften siger selv hvad én
    // portion ER («1 portion er 1 antal»), og dét ord kender køkkenet.
    // Serveren sender enheden når den betyder det samme som tallet; ellers
    // ingen, og så bliver vi ved «portion» (§B12).
    const raaVis = type === 'nesting' ? ((b && b.unit) || 'portion')
                                      : (raaEnhed || linje.unit || '');
    const enhed = visEnhed(raaVis);

    const { mangler, blokerer } = manglerFor(linje, b);
    const uafklaret = type === 'new';

    return {
        // Identitet
        key: linje.key != null ? String(linje.key)
             : (b && b.draft_index != null ? 'i' + b.draft_index : null),
        draft_index: b && b.draft_index != null ? b.draft_index : null,
        type,
        product_id: linje.product_id != null ? Number(linje.product_id) : null,
        includes_recipe_id: linje.includes_recipe_id != null ? Number(linje.includes_recipe_id) : null,
        // Halvfabrikatets OPSKRIFT — linjen peger på varen, men ⋯ → "Åbn
        // opskrift" og udfoldningen skal vide hvor den kommer fra.
        semi_recipe_id: linje.semi_recipe_id != null ? Number(linje.semi_recipe_id)
                       : (b && b.producer_recipe_id != null ? Number(b.producer_recipe_id) : null),

        // Visning
        name: (np ? np.name : (b ? b.name : linje.name)) || '',
        badge: badgeFor(type),
        section: linje.section || '',
        annotation: svindTekst(linje),

        // Mængde, som den LÆSES: «2 Antal», ikke «0,0133 kg». Serveren regner
        // om til linjens egen enhed (den opskriften er skrevet i) — samme tal
        // som den almindelige opskriftsvisning giver. Kladden bærer stadig
        // lager-enheden; den røres ikke her.
        //
        // `display_factor` SKAL med ud: feltet er redigerbart, og uden den
        // kan en kalder ikke komme tilbage til lager-enheden. Et gæt på 1
        // ville gemme 2 kg hvor køkkenet skrev 2 stk (#352).
        // Tallet udledes af KLADDEN med serverens faktor — ikke af serverens
        // `display_amount`. Feltet skal reagere på ± med det samme; serverens
        // svar kommer først efter debouncen, og indtil da ville feltet stå
        // med det gamle tal mens kladden var ændret.
        amount: type === 'nesting' ? tal(linje.servings) : visMængde(linje, b),
        amount_stock: type === 'nesting' ? null : tal(linje.amount),
        display_factor: (b && b.display_factor != null) ? tal(b.display_factor) : null,
        unit: enhed,
        // R6.2: stepper dér hvor man TÆLLER. En nesting i «stk» tælles lige så
        // meget som en vare i stk; en i «portion» gør ikke (portion er ikke en
        // tælleenhed), så listen afgør det — ikke linjens type.
        stepper: erTaelleenhed(raaVis),

        // Tal fra motorerne — aldrig regnet her
        weight_g: b ? b.weight_g : null,
        // Vægten er summen af underopskriftens råvarer, ikke et erklæret
        // udbytte. Visningen sætter ~ på den, så et skøn ikke kan læses
        // som en måling.
        weight_estimated: !!(b && b.weight_estimated),
        cost: b ? b.cost : null,
        co2e: b ? b.co2e : null,
        cost_source: b ? b.cost_source : null,

        // Tilstand
        is_packaging: erEmballage(np ? Object.assign({}, linje, { new_product: np }) : linje, c, b),
        unresolved: uafklaret,
        missing: mangler,
        missing_text: mangler.length ? manglerTekst(mangler) : null,
        blocks_save: blokerer,
        // I3: linjens tal er et MINDSTETAL når noget mangler — ikke forkert.
        cost_is_minimum: mangler.includes('pris'),
        co2_is_minimum: mangler.includes('co2'),
        // R6.3: prikken siger afklaret/ikke — ikke om varen er på lager.
        status: uafklaret ? 'open' : 'resolved',
        expandable: !!(badgeFor(type) && badgeFor(type).expandable),
    };
}

/* ── Hele listen ──────────────────────────────────────────────────────── */

/**
 * @param draft    kladden (bærer `lines[]` i brugerens rækkefølge)
 * @param overview svaret fra `/beregn`, eller null (så står tallene tomme)
 * @param ctx      som `buildLine`
 * @returns { lines, sections, unresolved_count, blocking_count, dim }
 */
function buildList(draft, overview, ctx) {
    const kladdeLinjer = (draft && draft.lines) || [];
    // Match på kladdens EGET indeks, ikke på rækkefølgen i svaret: `/beregn`
    // lægger nestings efter varelinjer, så en positionsbaseret kobling ville
    // hænge tal på den forkerte linje så snart de to blandes.
    const vedIndex = new Map();
    for (const l of ((overview && overview.lines) || [])) {
        if (l.draft_index != null) vedIndex.set(l.draft_index, l);
    }

    const lines = kladdeLinjer.map((l, i) => {
        const b = vedIndex.get(i) || null;
        const ud = buildLine(l, b, ctx);
        if (ud.key == null) ud.key = 'i' + i;
        if (ud.draft_index == null) ud.draft_index = i;
        return ud;
    });

    const unresolved = lines.filter(l => l.unresolved).length;
    const blocking = lines.filter(l => l.blocks_save).length;

    return {
        lines,
        sections: groupSections(lines),
        unresolved_count: unresolved,
        blocking_count: blocking,
        // §8.3: få uafklarede er undtagelsen og må gerne lyse gult. Mange er en
        // arbejdsliste — så ville en gul væg gøre siden ulæselig.
        dim: unresolved > GUL_GRAENSE,
    };
}

/**
 * Sektioner i listens rækkefølge.
 *
 * R7.6: linjer uden sektion står ØVERST og uden overskrift. De er ikke en
 * sektion der hedder "" — de er linjer der endnu ikke er sat i en.
 */
function groupSections(lines) {
    const uden = [], orden = [], efter = new Map();
    for (const l of lines) {
        const s = l.section || '';
        if (!s) { uden.push(l); continue; }
        if (!efter.has(s)) { efter.set(s, []); orden.push(s); }
        efter.get(s).push(l);
    }
    const ud = [];
    if (uden.length) ud.push({ name: '', titled: false, lines: uden });
    for (const s of orden) ud.push({ name: s, titled: true, lines: efter.get(s) });
    return ud;
}

/* ── Sektionsskabelon (R7.3/R7.4) ─────────────────────────────────────── */

/** Foreslå kun en sektion der bruges i mindst så stor en del af gruppen. */
const SKABELON_TAERSKEL = 0.5;

/**
 * Hvilke sektioner bruger gruppens opskrifter FAKTISK?
 *
 * Skabelonen UDLEDES af driften i stedet for at være en liste nogen har fundet
 * på. Målt på grocy-hq: «Emballage» bruges i 7 af 7 slider-opskrifter, mens de
 * øvrige grupper stort set ingen sektioner har. En hårdkodet liste ville
 * foreslå noget køkkenet ikke gør — og R7.4 siger at sammenligneligheden skal
 * komme af at forslaget er det samme, ikke af at det er opfundet.
 *
 * Rækkefølgen er den gennemsnitlige plads sektionen har i de opskrifter der
 * bruger den, så «Emballage» lander hvor den plejer at stå.
 *
 * En eksplicit skabelon (fra Settings) VINDER altid: driften beskriver hvad
 * der er, ikke hvad der skal være, og et køkken skal kunne sætte en ny standard.
 *
 * @returns { sections: string[], source: 'settings' | 'usage' | 'none', basis: n }
 */
function sectionTemplate(gruppe, ctx) {
    const c = ctx || {};
    const g = String(gruppe == null ? '' : gruppe).trim();

    const fraSettings = c.templates && g ? c.templates[g] : null;
    if (Array.isArray(fraSettings) && fraSettings.length) {
        return { sections: fraSettings.map(String), source: 'settings', basis: 0 };
    }
    if (!g || !Array.isArray(c.recipes) || !Array.isArray(c.pos)) {
        return { sections: [], source: 'none', basis: 0 };
    }

    const iGruppen = c.recipes.filter(r => String(((r.userfields || {}).grupper || '')).trim() === g);
    const posBy = new Map();
    for (const p of c.pos) {
        const k = String(p.recipe_id);
        if (!posBy.has(k)) posBy.set(k, []);
        posBy.get(k).push(p);
    }

    // Kun opskrifter der OVERHOVEDET bruger sektioner tæller med i nævneren.
    // Ellers ville én opskrift med sektioner blandt ti uden aldrig nå tærsklen,
    // og et ægte mønster ville forsvinde i dem der ikke har taget det i brug.
    const antal = new Map(), plads = new Map();
    let medSektioner = 0;
    for (const r of iGruppen) {
        const set = [];
        for (const p of (posBy.get(String(r.id)) || [])) {
            const s = String(p.ingredient_group || '').trim();
            if (s && set[set.length - 1] !== s) set.push(s);
        }
        if (!set.length) continue;
        medSektioner++;
        set.forEach((s, i) => {
            antal.set(s, (antal.get(s) || 0) + 1);
            plads.set(s, (plads.get(s) || 0) + i / set.length);
        });
    }
    if (!medSektioner) return { sections: [], source: 'none', basis: 0 };

    const valgt = [...antal.entries()]
        .filter(([, n]) => n / medSektioner >= SKABELON_TAERSKEL)
        .sort((a, b) => (plads.get(a[0]) / a[1]) - (plads.get(b[0]) / b[1]));

    return {
        sections: valgt.map(([s]) => s),
        source: valgt.length ? 'usage' : 'none',
        basis: medSektioner,
    };
}

/**
 * Båndet over listen (§8.3). `null` når der intet er at sige — et bånd der
 * altid står der, holder folk op med at læse det.
 */
function unresolvedBanner(liste) {
    const n = liste.unresolved_count, b = liste.blocking_count;
    if (!n) return null;
    const dele = [];
    if (b) dele.push(b + (b === 1 ? ' kan ikke gemmes (mangler enhed)' : ' kan ikke gemmes (mangler enhed)'));
    const rest = n - b;
    if (rest) dele.push(rest + (rest === 1 ? ' gør tallene til mindstetal' : ' gør tallene til mindstetal'));
    return {
        count: n,
        blocking: b,
        text: n + (n === 1 ? ' linje skal afklares' : ' linjer skal afklares'),
        detail: dele.join(' · '),
    };
}

/**
 * Rækkefølgen i gennemgangspanelet (§8.4).
 *
 * Manglende enhed først, fordi den BLOKERER gem — resten gør kun tallene til
 * mindstetal. Inden for hver gruppe: listens egen rækkefølge, så man
 * gennemgår opskriften oppefra og ned og ikke hopper rundt.
 */
function reviewOrder(liste) {
    return liste.lines
        .filter(l => l.unresolved)
        .slice()
        .sort((a, b) => (b.blocks_save - a.blocks_save) || (a.draft_index - b.draft_index));
}

return {
    buildLine, buildList, groupSections, unresolvedBanner, reviewOrder, sectionTemplate,
    typeFor, badgeFor, visEnhed, erTaelleenhed, manglerFor, svindTekst, tal,
    GUL_GRAENSE, SKABELON_TAERSKEL,
};
}));
