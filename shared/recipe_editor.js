/**
 * shared/recipe_editor.js
 * ════════════════════════════════════════════════════════════
 * Opskrift-editoren (designer-spec §4–§12).
 *
 * ÉN TILSTAND, TRE INDGANGE
 * Editoren arbejder på KLADDE-objektet fra §13 og intet andet. Det er præcis
 * det `/api/opskrifter/:id/editor` leverer, det `/beregn` tager imod, og det
 * importeren producerer (§15). Derfor ser editoren ingen forskel på en
 * opskrift der kommer fra Grocy, fra en tom skærm eller fra en indsat tekst —
 * kun bundlinjen skifter.
 *
 * DEN REGNER INGENTING
 * Alle tal kommer fra `/beregn`, som får dem fra `recipeCost` og `co2Engine`.
 * Regnede editoren selv, ville den vise ét tal mens Opskrifter & priser viste
 * et andet (#360's fejlklasse). Linjernes udseende kommer fra
 * `shared/recipe_lines.js`, som er den samme model gennemgangspanelet og
 * importens forhåndsvisning bruger.
 *
 * INVARIANTERNE DEN BÆRER
 *   I2  Bon ANNOTERER, den transformerer ikke — svind står som tekst
 *   I3  Ukendt er ikke nul: et manglende tal giver `≥`, aldrig et pænt 0
 *   I4  Et Gem uden ændringer skriver ingenting (#680)
 * ════════════════════════════════════════════════════════════
 */
(function () {
'use strict';

const RL = (typeof RecipeLines !== 'undefined') ? RecipeLines : null;

/* ══════════════════════════════════════════════════════════════
   Tilstand
   ══════════════════════════════════════════════════════════════ */

/**
 * Editorens tilstand — ALT hvad der hører til ÉN opskrift.
 *
 * Den er en funktion og ikke et objektliteral, fordi `mount` skal kunne
 * nulstille den i ét greb. Felterne blev tidligere sat løbende (`S.stepsEdited = …`)
 * uden at være deklareret her, og så blev de glemt når `mount` ryddede op
 * felt for felt: en opskrift man åbnede bagefter viste — og ville gemme —
 * den forriges fremgangsmåde. Et felt der kun findes når det er sat, er et
 * felt der bliver glemt. Skriv det HER.
 */
function friskTilstand() {
    return {
        el: null,                // rod-element
        mode: 'new',             // 'new' | 'modify' | 'import'
        draft: null,             // kladden — den ENESTE sandhed om hvad der redigeres
        orig: null,              // dyb kopi ved indlæsning; diffen måles mod den (I4)
        overview: null,          // sidste svar fra /beregn
        lines: null,             // RecipeLines.buildList(...)
        ctx: {},                 // enhedsnavne, varegrupper, emballage-reglen
        meta: {},                // grupper, enheder, priskategorier — til dropdowns
        busy: false,
        lastSection: '',         // R4.2 — tilføj-blokken forvælger sidst rørte sektion
        expanded: new Set(),     // udfoldede halvfabrikat/nesting-linjer
        expandData: null,        // svarene bag dem — nøglet på linje-key, som kan kollidere
        columns: null,           // kolonnevælger (localStorage)
        search: { q: '', res: null, open: false, busy: false },
        searchSeq: 0,
        newLine: null,           // formularen for «+ Ny vare»
        review: null,            // gennemgangspanelet (§8.4)
        editLineKey: null,       // linjen der redigeres inline
        menu: null,              // åben ⋯-menu
        priceTarget: null,       // DB%-skyderen — en norm pr. kategori, ikke pr. browser
        skabelon: null,          // sektionsskabelon (hentes af hentSektionsskabelon)
        stepsParsed: null,       // parset fremgangsmåde fra `description`
        stepsEdited: null,       // brugerens ændringer i den
        _udfoldT: null,          // timer for «opdaterer …» på en åben udfoldning
        onExit: null,
    };
}

const S = friskTilstand();
// Tælleren for hvilket /beregn-svar der er det nyeste hører IKKE i
// friskTilstand(): nulstilles den til 0 ved hvert mount, kan et svar fra
// den forrige opskrift stadig være «nyt nok» og overskrive tallene.
S.calcSeq = 0;

const COL_KEY = 'rd_editor_cols';
// «Allergener» stod her som en sjette pille. Den tændte, men der findes
// ingen allergen-kolonne i listen — og datagrundlaget bærer den ikke:
// 21 af 225 varer i Grocy har `hk_allergens`, og indholdet er scrapet
// råt («Mozzarella → Ælk»). En kontrol der ikke gør noget er værre end
// ingen kontrol; en der viser forkerte allergener er farlig. Bygges den,
// skal den bygges på data nogen står inde for.
const COL_DEF = { gram: true, cost: true, co2: true, stock: false };

/* ══════════════════════════════════════════════════════════════
   Småting
   ══════════════════════════════════════════════════════════════ */

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Dansk komma ud. Tomt bliver tomt — ikke «0», som ville påstå noget. */
function nf(v, dec) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toFixed(dec == null ? 2 : dec).replace('.', ',');
}

/** Ind: dansk komma tåles. Vrøvl giver null, aldrig 0. */
function num(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return isFinite(n) ? n : null;
}

/**
 * I3 i én funktion: et tal der mangler noget er et MINDSTETAL.
 * Vi skriver `≥` foran i stedet for at vise det som færdigt — og for
 * dækningsbidraget vender det, fordi en for lav kostpris gør avancen for høj.
 */
/**
 * Et vægttal i overblikket.
 *
 * `≥` betyder «mindst så meget» — noget mangler helt. `~` betyder «omtrent»:
 * en underopskrift uden erklæret udbytte er talt som summen af sine råvarer,
 * og den sum er for høj alle steder hvor der hældes fra eller svinder. De to
 * må ikke forveksles, og `~` vinder når begge gælder: et skøn der kan være
 * for højt, er ikke et mindstetal.
 */
function vægtTal(v, w, dec) {
    if (v == null || !isFinite(v)) return '—';
    const skøn = (w.estimated || []).length > 0;
    if (skøn) return '~' + nf(v, dec) + ' g';
    return minTal(v, w.complete, dec, 'g');
}

function minTal(v, complete, dec, enhed, retning) {
    if (v == null || !isFinite(v)) return '—';
    const tegn = complete ? '' : (retning === 'ned' ? '≤ ' : '≥ ');
    return tegn + nf(v, dec) + (enhed ? ' ' + enhed : '');
}

function dybKopi(o) { return o == null ? null : JSON.parse(JSON.stringify(o)); }

/* ══════════════════════════════════════════════════════════════
   API
   ══════════════════════════════════════════════════════════════ */

async function api(sti, opts) {
    const r = await fetch(sti, Object.assign({
        headers: { 'Content-Type': 'application/json' },
    }, opts || {}));
    const t = await r.text();
    let j = null;
    try { j = t ? JSON.parse(t) : null; } catch (e) { /* ikke JSON */ }
    if (!r.ok) {
        const fejl = new Error((j && j.error) || ('HTTP ' + r.status));
        fejl.status = r.status; fejl.body = j;
        throw fejl;
    }
    return j;
}

/* ══════════════════════════════════════════════════════════════
   Beregning
   ══════════════════════════════════════════════════════════════ */

let beregnTimer = null;

/** Debounced — man taster i mængdefelter, og hvert tastetryk er ikke et spørgsmål. */
function planlægBeregn() {
    clearTimeout(beregnTimer);
    beregnTimer = setTimeout(beregn, 280);
}

async function beregn() {
    const seq = ++S.calcSeq;
    try {
        const ov = await api('/api/opskrifter/beregn', {
            method: 'POST', body: JSON.stringify(S.draft),
        });
        // Et ældre svar må aldrig overskrive et nyere. Uden vagten kan et
        // langsomt kald lande efter et hurtigere og vise gamle tal.
        if (seq !== S.calcSeq) return;
        S.overview = ov;
        byggLinjer();
        tegnOverblik();
        tegnListe();
    } catch (e) {
        if (seq !== S.calcSeq) return;
        // Beregningen er en visning, ikke en handling. Fejler den, skal
        // tallene forsvinde — ikke blive stående som var de friske.
        S.overview = null;
        byggLinjer();
        tegnOverblik(e.message);
        tegnListe();
    }
}

function byggLinjer() {
    S.lines = RL.buildList(S.draft, S.overview, S.ctx);
}

/* ══════════════════════════════════════════════════════════════
   Diff (I4)
   ══════════════════════════════════════════════════════════════ */

/**
 * Hvor mange ændringer er der siden indlæsningen?
 *
 * Tallet står på Gem-knappen, og det er ikke pynt: er det 0, skal knappen
 * ikke kunne trykkes. Et Gem uden ændringer må ikke skrive noget (I4/#680),
 * og en knap der ser aktiv ud inviterer til at trykke.
 *
 * Sammenligningen laves af `shared/recipe_diff.js` — den SAMME diff
 * `recipeWriter` bruger på serveren. Skrev editoren sin egen, kunne knappen
 * sige «3 ændringer» mens serveren skrev to, og et «Gem» kunne se ud til at
 * gøre noget uden at gøre det.
 *
 * Reserven er en grov sammenligning: den kan sige 1 hvor diffen siger 0, så
 * knappen bliver aktiv uden grund — men den kan aldrig sige 0 hvor der ER en
 * ændring, og det er den vej der ville tabe arbejde.
 */
/**
 * Er målvægten ændret?
 *
 * Den bor i Bon, ikke i Grocy, så `diffRecipe` kan ikke se den — og uden
 * dette ville feltet være dødt: man kunne taste et tal, se bjælken flytte
 * sig, og så stå med en grå Gem-knap.
 *
 * Kun en AFVIGELSE tæller. At arve gruppens norm er ikke noget man har
 * gjort, og et Gem må ikke skrive en afvigelse man aldrig har bedt om.
 */
function målvægtÆndret() {
    if (!S.orig) return false;
    const egen = (d) => (d && d.target_weight_source === 'recipe' && d.target_weight_g != null)
        ? Number(d.target_weight_g) : null;
    return egen(S.orig) !== egen(S.draft);
}

function antalÆndringer() {
    if (!S.orig) return -1;                 // ny opskrift: intet at sammenligne med
    const ekstra = målvægtÆndret() ? 1 : 0;
    if (typeof RecipeDiff !== 'undefined' && RecipeDiff.diffRecipe) {
        try {
            const p = RecipeDiff.diffRecipe(S.orig, medTrin(S.draft));
            return p.changeCount + (p.newProducts ? p.newProducts.length : 0) + ekstra;
        } catch (e) { /* falder igennem til reserven */ }
    }
    return (JSON.stringify(S.orig) === JSON.stringify(medTrin(S.draft)) ? 0 : 1) + ekstra;
}

/* ══════════════════════════════════════════════════════════════
   Opstart
   ══════════════════════════════════════════════════════════════ */

/**
 * @param el    rod-element
 * @param opts  { draft, mode, meta, onExit }
 */
async function mount(el, opts) {
    const o = opts || {};

    // Ryd tilstanden fra den forrige opskrift i ÉT greb. Feltvis oprydning
    // glemmer det felt der kom til sidst; her kan intet slippe igennem.
    //
    // Timeren stoppes først. I dag ville den alligevel ikke gøre skade —
    // den løber over `expanded`, som nulstilles lige nedenfor — men et løst
    // kort der kun holdes i skak af et ANDET felts oprydning er ikke et værn.
    clearTimeout(S._udfoldT);
    const seq = S.calcSeq;
    Object.assign(S, friskTilstand());
    S.calcSeq = seq + 1;   // ugyldiggør et /beregn-svar der stadig er undervejs

    S.el = el;
    S.mode = o.mode || (o.draft && o.draft.recipe_id != null ? 'modify' : 'new');
    S.draft = o.draft || tomKladde();
    S.orig = S.mode === 'new' ? null : dybKopi(S.draft);
    S.meta = o.meta || {};
    S.onExit = o.onExit || null;
    S.overview = o.overview || null;
    S.lastSection = førsteSektion(S.draft);
    S.columns = læsKolonner();
    S.ctx = byggCtx(S.meta);

    byggLinjer();
    tegn();
    if (!S.overview) beregn(); else { tegnOverblik(); tegnListe(); }
    hentSektionsskabelon();
}

function tomKladde() {
    return {
        recipe_id: null, name: '', group: '', base_servings: 1,
        description: '', yield: { amount: null, unit: '', product_id: null },
        target_weight_g: null, lines: [],
    };
}

function førsteSektion(d) {
    for (const l of ((d && d.lines) || [])) if (l.section) return l.section;
    return '';
}

function byggCtx(meta) {
    const enhedNavn = new Map();
    for (const u of (meta.units || [])) enhedNavn.set(String(u.id), u.name);
    const gruppeNavn = new Map();
    for (const g of (meta.productGroups || [])) gruppeNavn.set(String(g.id), g.name);
    return {
        enhedNavn, gruppeNavn,
        // Emballage-reglen serveres af shellen (browseren har ikke
        // `co2Materials`). Uden den gætter linjemodellen ikke — den siger
        // bare at intet er emballage, hvilket er ærligt.
        erEmballageGruppe: meta.erEmballageGruppe || null,
    };
}

/** R7.3: foreslå sektioner for gruppen — men kun på en TOM ny opskrift. */
async function hentSektionsskabelon() {
    if (S.mode !== 'new' || (S.draft.lines || []).length) return;
    if (!S.draft.group) return;
    try {
        const r = await api('/api/opskrifter/sektionsskabelon?gruppe=' + encodeURIComponent(S.draft.group));
        if (r && r.sections && r.sections.length) {
            S.skabelon = r;
            S.lastSection = r.sections[0];
            tegnTilføj();
        }
    } catch (e) { /* et forslag er ikke værd at fejle på */ }
}

/* ══════════════════════════════════════════════════════════════
   Kolonner
   ══════════════════════════════════════════════════════════════ */

function læsKolonner() {
    const ud = Object.assign({}, COL_DEF);
    try {
        const r = JSON.parse(localStorage.getItem(COL_KEY) || 'null');
        // KUN kendte nøgler. En gemt kolonne der ikke findes mere ville
        // ellers blive skrevet tilbage ved hvert klik og leve for evigt.
        if (r) Object.keys(COL_DEF).forEach(k => { if (k in r) ud[k] = !!r[k]; });
    } catch (e) { /* privat vindue */ }
    return ud;
}
function gemKolonner() {
    try { localStorage.setItem(COL_KEY, JSON.stringify(S.columns)); } catch (e) { /* privat vindue */ }
}

/** Kolonnebredderne følger hvad der er slået til — ellers står der tomme felter. */
function gridSkabelon() {
    // Tal-kolonnerne er skåret til deres indhold, ikke til rund luft: hver
    // sparet pixel går til PRODUKT, som er den eneste der skal kunne læses.
    // Listen klipper (`overflow: hidden`), så navnet må IKKE have et gulv —
    // et gulv ville skubbe kostprisen ud af kortet på en smal skærm.
    const d = ['26px', 'minmax(0,1fr)', '104px', '50px'];
    if (S.columns.gram) d.push('54px');
    if (S.columns.cost) d.push('68px');
    if (S.columns.co2) d.push('58px');
    if (S.columns.stock) d.push('62px');
    d.push('30px');
    return d.join(' ');
}

/* ══════════════════════════════════════════════════════════════
   Render — skelettet
   ══════════════════════════════════════════════════════════════ */

function tegn() {
    S.el.innerHTML =
        '<div class="re-wrap">' +
          '<div class="re-main">' +
            '<div class="re-head" id="reHead"></div>' +
            '<div class="re-yield" id="reYield"></div>' +
            '<div class="re-card re-list-card">' +
              '<div class="re-banner" id="reBanner"></div>' +
              '<div class="re-colhead" id="reColHead"></div>' +
              '<div class="re-lines" id="reLines"></div>' +
              '<div class="re-add" id="reAdd"></div>' +
            '</div>' +
            '<div class="re-card re-steps" id="reSteps"></div>' +
            // Bundlinjen hører til LISTEN, ikke til siden: den handler om de
            // ændringer man laver i venstre kolonne. Som søskende til .re-wrap
            // strakte den sig hen under overblikket og lovede mere end den er.
            '<div class="re-bottom" id="reBottom"></div>' +
          '</div>' +
          '<aside class="re-side" id="reSide"></aside>' +
        '</div>';

    tegnHoved();
    tegnUdbytte();
    tegnListe();
    tegnTilføj();
    tegnTrin();
    tegnOverblik();
    bind();
}

/* ── Hoved: navn, gruppe, status ──────────────────────────────── */

function tegnHoved() {
    const pill = { modify: ['TILPASNING', 're-pill-mod'],
                   'new': ['NY OPSKRIFT', 're-pill-new'],
                   'import': ['IMPORTERET', 're-pill-imp'] }[S.mode] || ['', ''];
    const grupper = (S.meta.groups || []);
    const valgt = S.draft.group || '';
    const harValgt = !valgt || grupper.some(g => g === valgt);

    const _el_reHead = document.getElementById('reHead');
    if (!_el_reHead) return;              // afmonteret — intet at tegne på
    _el_reHead.innerHTML =
        '<button class="re-back" id="reBack">← Tilbage</button>' +
        '<div class="re-head-row">' +
          '<label class="re-sr" for="reName">Opskriftens navn</label>' +
          '<input id="reName" class="re-name" type="text" value="' + esc(S.draft.name) +
                 '" placeholder="Opskriftens navn">' +
          '<span class="re-pill ' + pill[1] + '">' + pill[0] + '</span>' +
          (S.mode === 'modify' && S.orig
             ? '<span class="re-based">Baseret på: ' + esc(S.orig.name) + '</span>' : '') +
          '<label class="re-lbl" for="reGroup">Gruppe</label>' +
          '<select id="reGroup" class="re-sel">' +
            '<option value="">— vælg —</option>' +
            grupper.map(g => '<option' + (g === valgt ? ' selected' : '') + '>' + esc(g) + '</option>').join('') +
            // En gruppe der ikke længere findes i Grocy må ikke forsvinde ved
            // et Gem. Den står med, markeret, så det kan ses at den er væk.
            (harValgt ? '' : '<option selected value="' + esc(valgt) + '">' + esc(valgt) + ' (findes ikke i Grocy)</option>') +
          '</select>' +
        '</div>';
}

/* ── Udbyttesætningen (§5) ────────────────────────────────────── */

function tegnUdbytte() {
    const y = S.draft.yield || {};
    const vare = y.product_id ? findVare(y.product_id) : null;
    const enheder = enhedsvalg(vare);
    const valgtEnhed = y.unit || '';
    const kendt = !valgtEnhed || enheder.some(e => e.name === valgtEnhed);

    const _el_reYield = document.getElementById('reYield');
    if (!_el_reYield) return;              // afmonteret — intet at tegne på
    _el_reYield.innerHTML =
      '<div class="re-card re-yield-card">' +
        // Sætningens tre led er pakket hver for sig. På brede skærme er
        // beholderne `display: contents` — altså ingen boks, og rækken er
        // præcis som før. På mobil bliver de flex, så linjen bryder MELLEM
        // led og ikke midt i «Giver [3] portioner».
        '<div class="re-yield-row">' +
          '<span class="re-yield-grp">' +
          '<span class="re-yield-lead">1 portion er</span>' +
          '<label class="re-sr" for="reYAmt">Mængde pr. portion</label>' +
          '<input id="reYAmt" class="re-inp re-inp-amt" type="text" inputmode="decimal" value="' +
                 esc(y.amount == null ? '' : String(y.amount).replace('.', ',')) + '">' +
          '<label class="re-sr" for="reYUnit">Enhed</label>' +
          '<select id="reYUnit" class="re-sel">' +
            '<option value="">— vælg —</option>' +
            enheder.map(e => '<option' + (e.name === valgtEnhed ? ' selected' : '') +
                             '>' + esc(e.name) + '</option>').join('') +
            (kendt ? '' : '<option selected>' + esc(valgtEnhed) + '</option>') +
          '</select>' +
          (vare ? '<span class="re-chip">af ' + esc(vare.name) +
                    '<button class="re-chip-x" id="reYClear" aria-label="Fjern produceret vare">✕</button>' +
                    '<button class="re-chip-sw" id="reYSwap">skift</button></span>'
                : '') +
          '</span>' +
          '<span class="re-div"></span>' +
          '<span class="re-yield-grp">' +
          '<label class="re-lbl" for="reYServ">Giver</label>' +
          '<input id="reYServ" class="re-inp re-inp-small" type="text" inputmode="decimal" value="' +
                 esc(String(S.draft.base_servings == null ? 1 : S.draft.base_servings).replace('.', ',')) + '">' +
          '<span class="re-lbl">portion(er)</span>' +
          '</span>' +
          '<span class="re-div"></span>' +
          '<span class="re-yield-grp">' +
          '<label class="re-lbl" for="reTarget">Målvægt</label>' +
          // Normen for gruppen er en HJÆLPETEKST, ikke en værdi: står den i
          // feltet, ser den ud som noget nogen har sat på denne ret, og så
          // ville en senere ændring af normen ikke slå igennem. Kun en
          // afvigelse står som tekst — og bærer dermed også sit eget ansvar.
          (function () {
              const egen = S.draft.target_weight_source === 'recipe';
              const norm = S.draft.target_weight_category_g;
              const værdi = egen && S.draft.target_weight_g != null
                  ? String(S.draft.target_weight_g).replace('.', ',') : '';
              return '<input id="reTarget" class="re-inp re-inp-small" type="text" inputmode="decimal"' +
                  (norm != null ? ' placeholder="' + esc(nf(norm, 0)) + '"' +
                                  ' title="' + esc(nf(norm, 0)) + ' g er standarden for ' +
                                  esc(S.draft.group || 'gruppen') +
                                  ' — skriv et tal her hvis netop denne ret afviger"' : '') +
                  ' value="' + esc(værdi) + '">';
          })() +
          '<span class="re-lbl">g mad</span>' +
          '</span>' +
        '</div>' +
        (vare ? produktionsNote(vare)
              : '<div class="re-yield-note">Opskriften lægger ingen vare på lageret. ' +
                '<button class="re-link" id="reYPick">Skal den det?</button></div>') +
      '</div>';
}

/**
 * Hvad SKER der når opskriften producerer en vare?
 *
 * `product_id` er ikke et felt som de andre: det skifter produktionstype,
 * lagertræk og kostpris i samme øjeblik (#329/#270/#558). Konsekvensen skal
 * stå her — ikke først opdages ved næste optælling.
 */
function produktionsNote(vare) {
    const t = S.meta.productionTypeHint || null;
    const hvordan = t === 'on_demand'
        ? 'Laves automatisk når en bon leveres.'
        : (t === 'to_stock' ? 'Laves efter plan og lægges på lager.' : '');
    return '<div class="re-yield-note">Lægger <strong>' + esc(vare.name) +
           '</strong> på lageret. ' + esc(hvordan) + '</div>';
}

function findVare(id) {
    return (S.meta.products || []).find(p => Number(p.id) === Number(id)) || null;
}

/**
 * R5.2: er en vare valgt, er enhedslisten VARENS lagerenheder.
 * Udbytte og vare må ikke kunne modsige hinanden.
 */
function enhedsvalg(vare) {
    const alle = (S.meta.units || []);
    if (!vare) return alle;
    const stock = alle.find(u => Number(u.id) === Number(vare.qu_id_stock));
    return stock ? [stock] : alle;
}

/* ── Listen ───────────────────────────────────────────────────── */

function tegnListe() {
    if (!S.lines) byggLinjer();
    tegnKolonneHoved();
    tegnBanner();

    const g = gridSkabelon();
    let h = '';
    for (const sek of S.lines.sections) {
        if (sek.titled) {
            const emb = sek.lines.length && sek.lines.every(l => l.is_packaging);
            h += '<div class="re-sec"><span class="re-sec-name">' + esc(sek.name.toUpperCase()) + '</span>' +
                 (emb ? '<span class="re-sec-note">· tæller ikke med i madvægten</span>' : '') +
                 '</div>';
        }
        for (const l of sek.lines) h += tegnLinje(l, g);
    }
    if (!S.lines.lines.length) {
        h = '<div class="re-empty">Ingen linjer endnu. Søg efter en vare eller en opskrift nedenfor.</div>';
    }

    // Listen tegnes forfra hver gang beregningen lander — 280 ms efter sidste
    // tastetryk. Uden dette mister man feltet MENS man taster. Samme fælde som
    // indkøbslistens søgefelt havde.
    //
    // Og værdien skal med, ikke kun markøren: kladden bærer det TOLKEDE tal,
    // så «0,» ville blive tegnet som «0» og næste ciffer lande i et andet tal
    // end det man skrev. Mens feltet har fokus, er det brugerens råtekst der
    // gælder — kladden har allerede fået sin værdi af `sætMængde`.
    const el = document.getElementById('reLines');
    if (!el) return;                      // afmonteret — intet at tegne på
    const a = document.activeElement;
    const fokus = (a && el.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT') && a.dataset.act)
        ? { act: a.dataset.act, key: a.dataset.key || '', raa: a.value,
            start: a.selectionStart, end: a.selectionEnd }
        : null;

    el.innerHTML = h;

    if (fokus) {
        const sel = '[data-act="' + fokus.act + '"][data-key="' + fokus.key.replace(/"/g, '\\"') + '"]';
        const n = el.querySelector(sel);
        if (n) {
            if (n.tagName === 'INPUT' && n.value !== fokus.raa) n.value = fokus.raa;
            n.focus();
            // `select` har ingen markør — og et talfelt kan have mistet sin.
            if (fokus.start != null && typeof n.setSelectionRange === 'function') {
                try { n.setSelectionRange(fokus.start, fokus.end); } catch (e) { /* ikke alle typer */ }
            }
        }
    }
}

function tegnKolonneHoved() {
    const c = S.columns;
    const _el_reColHead = document.getElementById('reColHead');
    if (!_el_reColHead) return;              // afmonteret — intet at tegne på
    _el_reColHead.innerHTML =
        '<div class="re-row re-row-head" style="grid-template-columns:' + gridSkabelon() + '">' +
          '<div></div><div>PRODUKT</div><div class="re-c">MÆNGDE</div><div></div>' +
          (c.gram  ? '<div class="re-r">GRAM</div>' : '') +
          (c.cost  ? '<div class="re-r">KOSTPRIS</div>' : '') +
          (c.co2   ? '<div class="re-r">CO₂e</div>' : '') +
          (c.stock ? '<div class="re-r">LAGER</div>' : '') +
          '<div></div>' +
        '</div>';
}

function tegnBanner() {
    const b = RL.unresolvedBanner(S.lines);
    const el = document.getElementById('reBanner');
    if (!b) { el.innerHTML = ''; el.className = 're-banner'; return; }
    el.className = 're-banner re-banner-on' + (S.lines.dim ? ' re-banner-dim' : '');
    el.innerHTML =
        '<span class="re-banner-txt"><strong>' + esc(b.text) + '</strong>' +
        (b.detail ? ' — ' + esc(b.detail) : '') + '</span>' +
        '<span class="re-banner-acts">' +
          '<button class="re-link" id="reOnlyUnres">Vis kun uafklarede</button>' +
          '<button class="re-btn re-btn-s" id="reReview">Gennemgå ›</button>' +
        '</span>';
}

function tegnLinje(l, g) {
    const c = S.columns;
    const åben = S.expanded.has(l.key);
    const klasser = ['re-row',
        l.unresolved ? (S.lines.dim ? 're-row-unres-dim' : 're-row-unres') : '',
        l.is_packaging ? 're-row-pack' : ''].filter(Boolean).join(' ');

    let h = '<div class="' + klasser + '" data-key="' + esc(l.key) + '" style="grid-template-columns:' + g + '">';

    // R6.3: prikken er afklaret / ikke afklaret — ikke lagerstatus.
    h += '<div><span class="re-dot ' + (l.unresolved ? 're-dot-open' : 're-dot-ok') +
         '" title="' + (l.unresolved ? 'Ikke afklaret' : 'Afklaret') + '"></span></div>';

    // Navn + badge. Udfoldningen sidder i BADGET, så alle produktnavne flugter.
    const navn = esc(l.name) +
        (l.annotation ? '<span class="re-ann">' + esc(l.annotation) + '</span>' : '') +
        (l.missing_text && l.unresolved && S.lines.dim
            ? '<span class="re-miss">' + esc(l.missing_text) + '</span>' : '');
    // Badget ligger INDE i navnet, ikke ved siden af. Så flyder det efter
    // teksten som et ord mere og ombryder med den — i stedet for at være en
    // kolonne der enten presser navnet ned eller lægger sig hen over det.
    const mærke = l.badge
        ? '<span class="re-badge re-badge-' + l.type + '">' + l.badge.text +
          (l.badge.expandable ? ' <span class="re-caret">' + (åben ? '▾' : '▸') + '</span>' : '') +
          '</span>'
        : '';
    if (l.badge && l.badge.expandable) {
        h += '<button class="re-name-btn" data-act="expand" data-key="' + esc(l.key) + '">' +
               '<span class="re-pname">' + navn + mærke + '</span>' +
             '</button>';
    } else {
        h += '<div class="re-pname">' + navn + mærke + '</div>';
    }

    // Mængde — R6.2: stepper kun hvor man tæller.
    h += '<div class="re-qty">';
    if (l.stepper) {
        h += '<button class="re-step" data-act="dec" data-key="' + esc(l.key) + '" aria-label="Færre ' + esc(l.name) + '">−</button>';
    }
    h += '<input class="re-qin' + (l.stepper ? ' re-qin-s' : '') + '" type="text" inputmode="decimal" ' +
         'data-act="amount" data-key="' + esc(l.key) + '" aria-label="Mængde ' + esc(l.name) + '" ' +
         'value="' + esc(l.amount == null ? '' : String(l.amount).replace('.', ',')) + '">';
    if (l.stepper) {
        h += '<button class="re-step" data-act="inc" data-key="' + esc(l.key) + '" aria-label="Flere ' + esc(l.name) + '">+</button>';
    }
    h += '</div>';

    // Enhed. En ny vare skal kunne vælge sin — det er dén der blokerer gem.
    if (l.unresolved && !l.unit) {
        h += '<div class="re-unit"><select class="re-usel" data-act="newunit" data-key="' + esc(l.key) +
             '" aria-label="Enhed ' + esc(l.name) + '"><option value="">— enhed —</option>' +
             (S.meta.units || []).map(u => '<option value="' + u.id + '">' + esc(u.name) + '</option>').join('') +
             '</select></div>';
    } else {
        h += '<div class="re-unit">' + esc(l.unit) + '</div>';
    }

    // Tallene ligger i en beholder med `display: contents`, så de på brede
    // skærme er grid-celler som før. På mobil bliver beholderen selv ét felt,
    // og de tre tal én metalinje under navnet (R11.2) — uden en anden
    // rendering-vej, som ville kunne drive fra denne.
    //
    // Suffikset står på cellen, ikke i teksten: kolonneoverskriften er skjult
    // på mobil, og «120» alene siger ikke om det er gram eller kroner.
    h += '<div class="re-nums">';
    if (c.gram)  h += '<div class="re-r re-dim" data-suffix=" g"' +
        (l.weight_estimated ? ' title="Summen af underopskriftens råvarer — den har intet erklæret udbytte, så svind er ikke trukket fra"' : '') +
        '>' + (l.weight_g == null ? '—' : (l.weight_estimated ? '~' : '') + nf(l.weight_g, 0)) + '</div>';
    if (c.cost)  h += '<div class="re-r" data-suffix=" kr">' + celleTal(l, 'cost') + '</div>';
    if (c.co2)   h += '<div class="re-r re-dim" data-suffix=" kg CO₂e">' + celleTal(l, 'co2') + '</div>';
    if (c.stock) h += '<div class="re-r re-dim" data-suffix=" på lager">' + lagerCelle(l) + '</div>';
    h += '</div>';

    h += '<div class="re-r re-dots-c"><button class="re-dots" data-act="menu" data-key="' + esc(l.key) +
         '" aria-label="Handlinger for ' + esc(l.name) + '">⋯</button></div>';
    h += '</div>';

    if (åben) h += tegnUdfoldning(l);
    return h;
}

/**
 * Et manglende tal er ikke en tom celle — det er noget man kan gøre.
 * På en uafklaret linje bliver cellen derfor en knap («pris?»), ikke en streg.
 */
function celleTal(l, felt) {
    const v = felt === 'cost' ? l.cost : l.co2e;
    const mangler = felt === 'cost' ? l.missing.includes('pris') : l.missing.includes('co2');
    if (l.unresolved && mangler) {
        return '<button class="re-ask" data-act="fill-' + felt + '" data-key="' + esc(l.key) + '">' +
               (felt === 'cost' ? 'pris?' : 'CO₂?') + '</button>';
    }
    if (v == null) return '—';
    return (mangler ? '≥ ' : '') + nf(v, felt === 'cost' ? 2 : 3);
}

function lagerCelle(l) {
    const s = S.meta.stock && l.product_id != null ? S.meta.stock[String(l.product_id)] : null;
    return s == null ? '—' : nf(s, 1);
}

/**
 * Et tal der runder til nul er værre end intet tal.
 *
 * Skalerede mængder er små — 0,0088 kg hvidløg. Med to decimaler ville
 * linjen stå som «0,00 kg», og så ligner en råvare der ER der én der ikke er.
 * Samme lære som decimalerne i lagertrækket (#548).
 */
function mgd(a) {
    if (a == null) return '—';
    const v = Math.abs(a);
    const d = v >= 100 ? 0 : v >= 10 ? 1 : v >= 1 ? 2 : v >= 0.1 ? 3 : 4;
    return nf(a, d);
}

/**
 * Mængde + enhed, som serveren har formateret den.
 *
 * `/indhold` leverer både lager-enheden (`amount`/`unit`) og den læsevenlige
 * visning (`display_*`) — kg→g og l→ml under 1, efter samme regel som
 * råvare-modalen. Reglen bor ÉT sted, på serveren: en kopi her kunne skride,
 * og så viste udfoldningen noget andet end resten af huset.
 *
 * Mangler `display_*` (ældre svar fra en cachet klient), falder vi tilbage på
 * lager-enheden frem for at regne om selv.
 */
function visTal(x) {
    const brugVisning = x && x.display_amount != null;
    const v = brugVisning ? x.display_amount : (x && x.amount);
    const e = brugVisning ? x.display_unit : (x && x.unit);
    return mgd(v) + (e ? ' ' + esc(RL.visEnhed(e)) : '');
}

/**
 * §6.3: udfoldningen er skrivebeskyttet — man redigerer via «Åbn opskrift».
 *
 * Mængderne er skaleret til det LINJEN bruger, ikke opskriftens fulde hold.
 * Faktoren kommer fra serveren (`/indhold`), fordi den er den samme som
 * kostprisen og lagertrækket skalerer med — regnet forfra her ville den kunne
 * skride fra dem, og udfoldningen ville vise noget andet end der sker.
 *
 * Kan faktoren ikke bestemmes (typisk et manglende udbytte, #372), viser vi
 * opskriftens EGNE tal og siger det — frem for at skalere med et gæt.
 */
function tegnUdfoldning(l) {
    const d = S.expandData && S.expandData[l.key];
    if (!d) return '<div class="re-exp re-exp-load">Henter …</div>';
    if (d.error) return '<div class="re-exp re-exp-err">Kunne ikke hentes: ' + esc(d.error) + '</div>';

    const hoved = d.scaled
        ? esc(d.name) + ' — det der bruges her'
        : esc(d.name) + ' — opskriften som den står' +
          (d.base_servings && d.base_servings !== 1 ? ' (' + nf(d.base_servings, 0) + ' portioner)' : '');

    // Regnestykket står fremme. Ser tallet forkert ud, skal man kunne se hvorfor.
    const grundlag = d.scaled
        ? (d.factor_basis === 'servings'
            ? mgd(d.used_amount) + ' af ' + nf(d.base_servings, 0) + ' portion' +
              (d.base_servings === 1 ? '' : 'er')
            : visTal({ amount: d.used_amount, unit: d.yield && d.yield.stock_unit,
                       display_amount: d.used_display && d.used_display.amount,
                       display_unit: d.used_display && d.used_display.unit }) +
              ' af et udbytte på ' +
              visTal({ amount: d.yield && d.yield.stock_amount,
                       unit: d.yield && d.yield.stock_unit,
                       display_amount: d.yield && d.yield.display && d.yield.display.amount,
                       display_unit: d.yield && d.yield.display && d.yield.display.unit }))
        : '';

    // Forældet: tallene passede til en anden mængde end den der står nu.
    return '<div class="re-exp' + (d.stale ? ' re-exp-stale' : '') + '">' +
        '<div class="re-exp-head">' + hoved +
          (d.stale ? '<span class="re-dim"> · opdaterer …</span>' : '') +
          (grundlag ? '<span class="re-dim"> · ' + grundlag + '</span>' : '') + '</div>' +
        (d.scaled ? '' :
          '<div class="re-exp-warn">Kan ikke regnes om til denne linje' +
            (d.reason ? ' — ' + esc(d.reason) : '') + '</div>') +
        (d.lines || []).map(x =>
            '<div class="re-exp-row"><span>' + esc(x.name) + '</span>' +
            '<span class="re-dim">' + visTal(x) + '</span></div>').join('') +
        '<div class="re-exp-foot">' +
          '<button class="re-link" data-act="open-recipe" data-key="' + esc(l.key) + '">Åbn opskrift →</button>' +
          '<span class="re-dim">låst — redigér via opskriften</span>' +
        '</div></div>';
}

/* ── Tilføj-blokken (§4.4) ────────────────────────────────────── */

function tegnTilføj() {
    const sektioner = sektionsliste();
    const _el_reAdd = document.getElementById('reAdd');
    if (!_el_reAdd) return;              // afmonteret — intet at tegne på
    _el_reAdd.innerHTML =
      '<div class="re-add-inner">' +
        '<div class="re-add-lbl">TILFØJ TIL OPSKRIFTEN</div>' +
        '<div class="re-add-row">' +
          '<div class="re-add-search">' +
            '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
              '<circle cx="7" cy="7" r="4.5"></circle><path d="M10.5 10.5 14 14"></path></svg>' +
            '<label class="re-sr" for="reSearch">Søg vare, opskrift eller opret ny</label>' +
            '<input id="reSearch" type="text" placeholder="Søg vare, opskrift — eller opret ny …" ' +
                   'value="' + esc(S.search.q) + '" autocomplete="off">' +
          '</div>' +
          '<label class="re-lbl" for="reAddSec">i</label>' +
          '<select id="reAddSec" class="re-sel">' +
            sektioner.map(s => '<option' + (s === S.lastSection ? ' selected' : '') + ' value="' + esc(s) + '">' +
                               esc(s || '(uden sektion)') + '</option>').join('') +
            '<option value="__ny__">+ Ny sektion …</option>' +
          '</select>' +
        '</div>' +
        '<div class="re-res" id="reRes"></div>' +
      '</div>';
    tegnResultater();
}

function sektionsliste() {
    const set = new Set(['']);
    for (const l of (S.draft.lines || [])) if (l.section) set.add(l.section);
    for (const s of ((S.skabelon && S.skabelon.sections) || [])) set.add(s);
    return [...set];
}

function tegnResultater() {
    const el = document.getElementById('reRes');
    if (!el) return;
    if (S.newLine) { el.innerHTML = tegnNyVareForm(); el.className = 're-res re-res-on'; return; }
    const r = S.search.res;
    if (!S.search.open || !r) { el.innerHTML = ''; el.className = 're-res'; return; }
    el.className = 're-res re-res-on';

    let h = '';
    const gruppe = (titel, undertekst, rows, render) => {
        if (!rows || !rows.length) return '';
        return '<div class="re-res-h">' + esc(titel) +
               (undertekst ? '<span class="re-dim"> — ' + esc(undertekst) + '</span>' : '') + '</div>' +
               rows.map(render).join('');
    };

    h += gruppe('VARER PÅ LAGER', '', r.varer, v =>
        '<div class="re-res-row"><span class="re-res-name">' + esc(v.name) + '</span>' +
        '<span class="re-dim">' + esc(RL.visEnhed(v.unit) || '') + '</span>' +
        '<button class="re-btn re-btn-s" data-act="pick-product" data-id="' + v.product_id + '">Tilføj</button></div>');

    h += gruppe('HALVFABRIKATA', 'opskrifter der lægger en vare på lager', r.halvfabrikata, v =>
        '<div class="re-res-row"><span class="re-res-name">' + esc(v.name) +
        '<span class="re-badge re-badge-semi">HALVFABRIKAT</span></span>' +
        '<span class="re-dim">linjen lægges på varen</span>' +
        '<button class="re-btn re-btn-s" data-act="pick-semi" data-id="' + v.recipe_id +
        '" data-pid="' + v.product_id + '">Tilføj</button></div>');

    h += gruppe('OPSKRIFTER UDEN VARE', 'nestes', r.nestings, v =>
        '<div class="re-res-row"><span class="re-res-name">' + esc(v.name) +
        '<span class="re-badge re-badge-nesting">NESTING</span></span>' +
        '<span class="re-dim">råvarerne trækkes igennem</span>' +
        '<button class="re-btn re-btn-s" data-act="pick-nesting" data-id="' + v.recipe_id + '">Tilføj</button></div>');

    // Blokerede vises MED grund. Forsvandt de bare, ledte man efter dem igen.
    h += gruppe('KAN IKKE BRUGES HER', '', r.blokeret, v =>
        '<div class="re-res-row re-res-blocked"><span class="re-res-name">' + esc(v.name) + '</span>' +
        '<span class="re-dim">' + esc(v.text) + '</span></div>');

    if (r.nyVare && r.nyVare.name) {
        h += '<div class="re-res-new"><button class="re-btn re-btn-ghost" data-act="new-product">' +
             '+ Ny vare «' + esc(r.nyVare.name) + '»</button>' +
             '<span class="re-dim">Oprettes først i Grocy når opskriften gemmes</span></div>';
    }
    if (!h) h = '<div class="re-res-empty">Ingen træf.</div>';
    el.innerHTML = h;
}

/** §8: en ny vare kræver navn, mængde og ENHED. Resten er valgfrit. */
function tegnNyVareForm() {
    const n = S.newLine;
    return '<div class="re-new">' +
      '<div class="re-new-h">Ny vare<span class="re-dim"> — oprettes i Grocy når opskriften gemmes</span></div>' +
      '<div class="re-new-grid">' +
        felt('nvName', 'NAVN', n.name, 'text') +
        '<div class="re-new-f"><label for="nvUnit">LAGERENHED *</label>' +
          '<select id="nvUnit"><option value="">— vælg —</option>' +
          (S.meta.units || []).map(u => '<option value="' + u.id + '"' +
              (String(u.id) === String(n.qu_id_stock) ? ' selected' : '') + '>' + esc(u.name) + '</option>').join('') +
          '</select></div>' +
        '<div class="re-new-f"><label for="nvGroup">VAREGRUPPE</label>' +
          '<select id="nvGroup"><option value="">— vælg —</option>' +
          (S.meta.productGroups || []).map(g => '<option value="' + g.id + '"' +
              (String(g.id) === String(n.product_group_id) ? ' selected' : '') + '>' + esc(g.name) + '</option>').join('') +
          '</select></div>' +
        felt('nvAmount', 'MÆNGDE I OPSKRIFTEN', n.amount, 'decimal') +
        felt('nvPrice', 'PRIS PR. ENHED', n.price_per_unit, 'decimal', 'kan udfyldes senere') +
        felt('nvCo2', 'CO₂e PR. ENHED', n.co2e_per_unit, 'decimal', 'kan udfyldes senere') +
      '</div>' +
      '<div class="re-new-note">* Lagerenheden er det eneste påkrævede ud over navn og mængde — uden den ' +
        'kan linjen ikke regnes om. Uden pris og CO₂ regnes opskriften videre, og overblikket viser mindstetal.</div>' +
      '<div class="re-new-acts">' +
        '<button class="re-btn re-btn-ghost" data-act="new-cancel">Fortryd</button>' +
        '<button class="re-btn re-btn-primary" data-act="new-add">Tilføj linje</button>' +
      '</div></div>';
}

function felt(id, lbl, v, mode, ph) {
    return '<div class="re-new-f"><label for="' + id + '">' + lbl + '</label>' +
        '<input id="' + id + '" type="text"' + (mode === 'decimal' ? ' inputmode="decimal"' : '') +
        ' value="' + esc(v == null ? '' : String(v).replace('.', ',')) + '"' +
        (ph ? ' placeholder="' + esc(ph) + '"' : '') + '></div>';
}

/* ── Fremgangsmåde (§9) ───────────────────────────────────────── */

function tegnTrin() {
    const RS = (typeof RecipeSteps !== 'undefined') ? RecipeSteps : null;
    const el = document.getElementById('reSteps');
    if (!el) return;                      // afmonteret — intet at tegne på
    if (!RS) { el.innerHTML = ''; return; }

    const p = S.stepsParsed || (S.stepsParsed = RS.parseDescription(S.draft.description || ''));
    const trin = S.stepsEdited && S.stepsEdited.steps ? S.stepsEdited.steps : p.steps;
    const total = RS.totalMinutes(trin);

    /**
     * Den fri tekst fra Grocy SKAL kunne ses.
     *
     * Feltet i Grocy er ét fritekstfelt, og 34 af opskrifterne har rigtig
     * arbejdsbeskrivelse i det uden numre. Viste vi kun trin-listen, stod der
     * «+ Tilføj trin» på en opskrift der havde fem linjers fremgangsmåde —
     * usynlig, uredigerbar, og indtil nu slettet af det første trin man
     * tilføjede. `plain` er allerede parset; den manglede bare et sted at stå.
     */
    const plain = (S.stepsEdited && S.stepsEdited.plain !== undefined)
        ? S.stepsEdited.plain : (p.mode === 'raw' ? p.plain : '');
    const harPlain = String(plain || '').trim() !== '';

    el.innerHTML =
      '<div class="re-steps-h"><span>FREMGANGSMÅDE</span>' +
        (total ? '<span class="re-dim">Samlet tid ' + total + ' min</span>' : '') + '</div>' +
      (harPlain
        ? '<div class="re-steps-plain">' +
            '<textarea class="re-plain" data-act="plain" rows="' +
              Math.min(12, Math.max(3, String(plain).split('\n').length)) + '" ' +
              'aria-label="Fremgangsmåde fra Grocy">' + esc(plain) + '</textarea>' +
            '<div class="re-steps-plainf"><span class="re-dim">Som den står i Grocy</span>' +
              '<button class="re-btn re-btn-ghost" data-act="plain2steps">Lav om til trin</button>' +
            '</div>' +
          '</div>'
        : '') +
      (p.lead ? '<div class="re-steps-lead">' + esc(p.lead) + '</div>' : '') +
      trin.map((t, i) =>
        '<div class="re-step-row"><span class="re-step-n">' + (i + 1) + '</span>' +
        '<input class="re-step-t" type="text" data-act="step" data-i="' + i + '" ' +
               'aria-label="Trin ' + (i + 1) + '" value="' + esc(t.text) + '">' +
        '<input class="re-step-m" type="text" inputmode="decimal" data-act="step-min" data-i="' + i + '" ' +
               'aria-label="Tid trin ' + (i + 1) + '" value="' + esc(t.minutes == null ? '' : t.minutes) + '">' +
        '<span class="re-dim">min</span>' +
        '<button class="re-step-x" data-act="step-del" data-i="' + i + '" aria-label="Fjern trin ' + (i + 1) + '">✕</button>' +
        '</div>').join('') +
      '<div class="re-steps-f"><button class="re-btn re-btn-ghost" data-act="step-add">+ Tilføj trin</button>' +
        '<span class="re-dim">Gemmes som nummereret tekst i Grocys ene felt</span></div>';
}

/* ── Overblik (§10) ───────────────────────────────────────────── */

function tegnOverblik(fejl) {
    const el = document.getElementById('reSide');
    if (!el) return;
    if (fejl) {
        el.innerHTML = '<div class="re-card re-ov"><div class="re-ov-h">OVERBLIK</div>' +
            '<div class="re-ov-err">Tallene kunne ikke hentes: ' + esc(fejl) + '</div>' +
            '<div class="re-dim">De vises ikke som gamle tal — de er væk indtil beregningen svarer igen.</div>' +
            '</div>' + tegnKolonneVælger();
        return;
    }
    const o = S.overview;
    if (!o) { el.innerHTML = '<div class="re-card re-ov"><div class="re-ov-h">OVERBLIK</div>' +
                             '<div class="re-dim">Beregner …</div></div>' + tegnKolonneVælger(); return; }

    const ps = o.per_serving || {};
    const w = o.weight || {};
    const pct = o.target_weight_pct;

    // Svindet. Madvægten ER udbyttet når det er erklæret — men så passer den
    // ikke med linjerne ovenfor, og uden denne linje ligner det en fejl.
    // Ved Rødløg - Syltet hældes 1833 g lage fra; ved udblødte ærter kommer
    // der 1100 g vand TIL. Begge dele skal kunne læses af tallet.
    const portioner = o.servings || 1;
    const indPrPortion = (w.food_from_yield && w.input_g != null)
        ? w.input_g / portioner : null;
    const svind = (indPrPortion != null && ps.weight_g != null
                   && Math.abs(indPrPortion - ps.weight_g) >= 1) ? indPrPortion : null;

    let h = '<div class="re-card re-ov">' +
      '<div class="re-ov-h">OVERBLIK · PR. PORTION</div>' +
      '<div class="re-ov-big"><span>Mad</span><span>' +
        vægtTal(ps.weight_g, w, 0) + '</span></div>' +
      (svind == null ? '' :
        '<div class="re-ov-note" title="Madvægten er opskriftens erklærede udbytte — det der pakkes og lægges på lageret. Råvarerne vejer noget andet, fordi der svinder eller kommer væde til.">' +
          'råvarer ind ' + nf(svind, 0) + ' g · ' +
          (svind > ps.weight_g ? nf(svind - ps.weight_g, 0) + ' g hældes fra'
                               : nf(ps.weight_g - svind, 0) + ' g kommer til') +
        '</div>');

    // Målvægt: mål, faktisk, afstand — samme form som mål-DB (R10.3).
    if (pct != null) {
        const klasse = pct >= 95 && pct <= 105 ? 're-bar-ok' : (pct > 105 ? 're-bar-over' : 're-bar-under');
        h += '<div class="re-bar"><div class="re-bar-fill ' + klasse + '" style="width:' +
             Math.min(100, Math.max(0, pct)) + '%"></div></div>' +
             '<div class="re-bar-lbl"><span>' + nf(pct, 0) + ' % af målvægt</span>' +
             '<span class="re-dim">mål ' + nf(o.target_weight_g, 0) + ' g</span></div>';
    }

    h += '<div class="re-ov-rows">';
    h += ovRow('Emballage', minTal(w.packaging_g, w.complete, 0, 'g'));
    h += ovRow('Batchvægt', vægtTal(w.batch_g, w, 0));
    if (o.yield && o.yield.stock_amount != null) {
        h += ovRow('Udbytte', nf(o.yield.stock_amount, 2) + ' ' + esc(o.yield.stock_unit || ''));
    }
    h += ovRow('Kostpris', minTal(ps.cost, o.cost && o.cost.complete, 2, 'kr'));
    h += ovRow('CO₂e', minTal(ps.co2, o.co2 && o.co2.complete, 3, 'kg'));
    h += '</div>';

    // §10: antal uafklarede med KONSEKVENSEN, ikke bare et tal.
    if (S.lines && S.lines.unresolved_count) {
        const navne = S.lines.lines.filter(l => l.unresolved && l.missing.length)
            .slice(0, 3).map(l => l.name).join(', ');
        h += '<div class="re-ov-warn"><div class="re-ov-warn-h">' +
             S.lines.unresolved_count + (S.lines.unresolved_count === 1 ? ' linje er ikke afklaret' : ' linjer er ikke afklaret') +
             '</div><div class="re-dim">' + esc(navne) +
             ' mangler oplysninger. Tallene ovenfor er derfor mindstetal — ukendt regnes ikke som 0.</div></div>';
    }
    h += '</div>';

    h += tegnPris(o);
    h += tegnKolonneVælger();
    el.innerHTML = h;
}

function ovRow(k, v) {
    return '<div class="re-ov-row"><span>' + esc(k) + '</span><span>' + v + '</span></div>';
}

/** §10.2 — alle tal EX moms (R10.1). */
function tegnPris(o) {
    const kost = o.cost || {};
    if (kost.total == null) return '';
    const mål = S.priceTarget == null ? 70 : S.priceTarget;
    const pr = o.per_serving && o.per_serving.cost;
    if (pr == null) return '';
    const foreslået = mål < 100 ? pr / (1 - mål / 100) : null;
    const faktisk = S.actualPrice;
    const db = faktisk != null && faktisk > 0 ? (faktisk - pr) / faktisk * 100 : null;

    return '<div class="re-card re-price">' +
      '<div class="re-ov-h">PRIS &amp; AVANCE<span class="re-dim"> ex moms</span></div>' +
      '<div class="re-ov-row"><span>Mål-dækningsbidrag</span><span>' + nf(mål, 0) + ' %</span></div>' +
      '<input class="re-slider" type="range" min="0" max="95" value="' + mål + '" id="reDbTarget" ' +
             'aria-label="Mål-dækningsbidrag">' +
      '<div class="re-ov-rows">' +
        ovRow('Vareomkostning', minTal(pr, kost.complete, 2, 'kr')) +
        ovRow('Foreslået menupris', foreslået == null ? '—' : nf(foreslået, 2) + ' kr') +
        ovRow('Faktisk pris', faktisk == null ? '—' : nf(faktisk, 2) + ' kr') +
      '</div>' +
      (db == null ? '' :
        // R10.2: er kostprisen et mindstetal, er DB'et et HØJESTE tal. Et
        // manglende tal må aldrig få avancen til at se bedre ud end den er.
        '<div class="re-price-note">Nuværende pris giver <strong>' +
        minTal(db, kost.complete, 1, '% DB', 'ned') + '</strong> — ' +
        (db >= mål ? 'over målet.' : 'under målet.') + '</div>') +
      '</div>';
}

function tegnKolonneVælger() {
    const navne = { gram: 'Gram', cost: 'Kostpris', co2: 'CO₂e', stock: 'Lager' };
    return '<div class="re-card re-cols"><div class="re-ov-h">VIS KOLONNER</div><div class="re-cols-row">' +
        Object.keys(navne).map(k =>
            '<button class="re-colbtn' + (S.columns[k] ? ' re-colbtn-on' : '') +
            '" data-act="col" data-col="' + k + '" aria-pressed="' + !!S.columns[k] + '">' +
            navne[k] + '</button>').join('') + '</div></div>';
}

/* ── Bundlinjen (§12) ─────────────────────────────────────────── */

function tegnBund() {
    const n = antalÆndringer();
    const blok = S.lines ? S.lines.blocking_count : 0;
    const nye = (S.draft.lines || []).filter(l => l.new_product).length;

    const dele = [];
    if (n > 0) dele.push(n + (n === 1 ? ' ændring' : ' ændringer') + ' siden sidste gem');
    if (n === 0) dele.push('Ingen ændringer');
    if (nye) dele.push(nye + (nye === 1 ? ' ny vare oprettes' : ' nye varer oprettes') + ' i Grocy ved gem');

    const gemTekst = S.mode === 'modify'
        ? (n > 0 ? 'Gem ' + n + (n === 1 ? ' ændring' : ' ændringer') : 'Gem')
        : 'Gem';
    // I4: 0 ændringer ⇒ intet at skrive, så knappen skal ikke kunne trykkes.
    const gemSlået = blok > 0 || (S.mode === 'modify' && n === 0) || S.busy;

    const _el_reBottom = document.getElementById('reBottom');
    if (!_el_reBottom) return;              // afmonteret — intet at tegne på
    _el_reBottom.innerHTML =
      '<span class="re-bottom-txt">' + esc(dele.join(' · ')) +
        (blok ? ' · <strong class="re-blocked">' + blok +
                (blok === 1 ? ' linje mangler enhed' : ' linjer mangler enhed') + '</strong>' : '') +
      '</span>' +
      '<div class="re-bottom-acts">' +
        '<button class="re-btn re-btn-ghost" id="reDiscard">Kassér</button>' +
        (S.mode === 'modify' ? '<button class="re-btn" id="reSaveNew"' + (blok ? ' disabled' : '') +
                               '>Gem som ny</button>' : '') +
        '<button class="re-btn re-btn-primary" id="reSave"' + (gemSlået ? ' disabled' : '') + '>' +
          esc(gemTekst) + '</button>' +
      '</div>';
}

/* ══════════════════════════════════════════════════════════════
   Handlinger
   ══════════════════════════════════════════════════════════════ */

function linjeFraKey(key) {
    if (!S.lines) return null;
    const v = S.lines.lines.find(l => l.key === key);
    return v ? S.draft.lines[v.draft_index] : null;
}

function sætMængde(key, v) {
    const l = linjeFraKey(key);
    if (!l) return;
    const n = num(v);
    if (l.includes_recipe_id != null) l.servings = n;
    else l.amount = n;
    if (l.section) S.lastSection = l.section;
    genhentUdfoldning(key);
    planlægBeregn();
    tegnBund();
}

function justérMængde(key, delta) {
    const l = linjeFraKey(key);
    if (!l) return;
    const felt = l.includes_recipe_id != null ? 'servings' : 'amount';
    const nu = num(l[felt]) || 0;
    l[felt] = Math.max(0, nu + delta);
    tegnListe(); genhentUdfoldning(key); planlægBeregn(); tegnBund();
}

function tilføjLinje(l) {
    const sek = vælgSektion();
    S.draft.lines.push(Object.assign({ section: sek }, l));
    S.lastSection = sek;
    S.search.open = false; S.search.res = null; S.newLine = null;
    const s = document.getElementById('reSearch');
    if (s) { s.value = ''; S.search.q = ''; }
    byggLinjer(); tegnListe(); tegnTilføj(); planlægBeregn(); tegnBund();
}

function vælgSektion() {
    const el = document.getElementById('reAddSec');
    const v = el ? el.value : S.lastSection;
    if (v === '__ny__') {
        const navn = (prompt('Navn på den nye sektion') || '').trim();
        return navn;
    }
    return v || '';
}

function fjernLinje(key) {
    const v = S.lines.lines.find(l => l.key === key);
    if (!v) return;
    S.draft.lines.splice(v.draft_index, 1);
    byggLinjer(); tegnListe(); planlægBeregn(); tegnBund();
}

async function søg(q) {
    S.search.q = q;
    if (!q || q.trim().length < 1) { S.search.open = false; S.search.res = null; tegnResultater(); return; }
    S.search.busy = true;
    const seq = ++S.searchSeq;
    try {
        const url = '/api/opskrifter/soeg?q=' + encodeURIComponent(q) +
            (S.draft.recipe_id != null ? '&exclude=' + encodeURIComponent(S.draft.recipe_id) : '');
        const r = await api(url);
        if (seq !== S.searchSeq) return;          // et ældre svar må ikke vinde
        S.search.res = r; S.search.open = true;
    } catch (e) {
        if (seq !== S.searchSeq) return;
        S.search.res = null; S.search.open = false;
    } finally { S.search.busy = false; }
    tegnResultater();
}

/** Udfoldning (§6.3) — skrivebeskyttet, hentet på stedet. */
async function foldUd(key) {
    if (S.expanded.has(key)) { S.expanded.delete(key); tegnListe(); return; }
    S.expanded.add(key);
    S.expandData = S.expandData || {};
    tegnListe();
    await hentUdfoldning(key);
}

/**
 * Ændrer man linjens antal, holder udfoldningen op med at passe — dens tal ER
 * jo skaleret med netop det antal. Den markeres derfor forældet MED DET SAMME
 * og hentes igen; indtil svaret er hjemme står tallene dæmpet med «opdaterer».
 *
 * Et tal der stille bliver forkert er værre end et tal der siger det er på vej.
 */
function genhentUdfoldning(key) {
    if (!S.expanded.has(key)) return;
    const d = S.expandData && S.expandData[key];
    if (d && !d.error) { d.stale = true; tegnListe(); }
    clearTimeout(S._udfoldT);
    S._udfoldT = setTimeout(() => {
        for (const k of S.expanded) {
            const x = S.expandData && S.expandData[k];
            if (!x || x.stale) hentUdfoldning(k);
        }
    }, 350);
}

async function hentUdfoldning(key) {
    const v = S.lines.lines.find(l => l.key === key);
    if (!v) return;
    const rid = v.type === 'nesting' ? v.includes_recipe_id : v.semi_recipe_id;
    if (!rid) { S.expandData[key] = { error: 'opskriften er ukendt' }; tegnListe(); return; }
    // Mængden sendes med, så serveren kan skalere. Faktoren regnes ALDRIG her:
    // den er den samme som kostprisen og lagertrækket bruger, og en kopi i
    // browseren ville kunne skride fra dem uden at nogen så det.
    const q = '?kind=' + (v.type === 'nesting' ? 'nesting' : 'semi') +
              '&bruger=' + encodeURIComponent(v.amount == null ? '' : v.amount);
    try {
        const r = await api('/api/opskrifter/' + rid + '/indhold' + q);
        S.expandData[key] = r;
    } catch (e) {
        S.expandData[key] = { error: e.message };
    }
    tegnListe();
}

/* ══════════════════════════════════════════════════════════════
   Gem (§12)
   ══════════════════════════════════════════════════════════════ */

async function gem(somNy) {
    if (S.busy) return;
    if (S.lines && S.lines.blocking_count) return;     // R8.4 — håndhævet af serveren også
    S.busy = true; tegnBund();
    try {
        const sti = somNy || S.draft.recipe_id == null
            ? '/api/opskrifter/ny'
            : '/api/opskrifter/' + S.draft.recipe_id + '/gem';
        const r = await api(sti, { method: 'POST', body: JSON.stringify(medTrin(S.draft)) });
        if (typeof window.toast === 'function') {
            // `change_count` tæller kun det der gik til Grocy. Målvægten bor i
            // Bon, så en ændring af den alene ville ellers kvittere med
            // «ingen ændringer» — og så tror man den ikke blev gemt.
            window.toast(r.target_weight_error ? ('Gemt, men målvægten kunne ikke gemmes: ' + r.target_weight_error)
                : r.change_count ? ('Gemt — ' + r.change_count + ' ændringer')
                : målvægtÆndret() ? 'Målvægt gemt'
                : 'Ingen ændringer at gemme');
        }
        if (S.onExit) S.onExit(r.recipe_id);
    } catch (e) {
        const d = e.body && e.body.details;
        alert('Kunne ikke gemme: ' + e.message + (d ? '\n' + JSON.stringify(d) : ''));
    } finally { S.busy = false; tegnBund(); }
}

/**
 * Fremgangsmåden skrives kun hvis den er RØRT.
 *
 * `RecipeSteps.toStore` returnerer den oprindelige tekst uændret når intet er
 * ændret — det er dét der gør at et Gem uden ændringer ikke omskriver feltet
 * (#680). Vi må derfor ikke sende en genserialiseret udgave «for en
 * sikkerheds skyld».
 */
function medTrin(d) {
    const RS = (typeof RecipeSteps !== 'undefined') ? RecipeSteps : null;
    if (!RS || !S.stepsEdited) return d;
    const p = S.stepsParsed || RS.parseDescription(d.description || '');
    return Object.assign({}, d, { description: RS.toStore(p, S.stepsEdited) });
}

/* ══════════════════════════════════════════════════════════════
   Events
   ══════════════════════════════════════════════════════════════ */

function bind() {
    const el = S.el;

    el.addEventListener('input', (e) => {
        const t = e.target;
        if (t.id === 'reName') { S.draft.name = t.value; tegnBund(); return; }
        if (t.id === 'reSearch') { søg(t.value); return; }
        if (t.id === 'reYAmt') { S.draft.yield.amount = num(t.value); planlægBeregn(); tegnBund(); return; }
        if (t.id === 'reYServ') { S.draft.base_servings = num(t.value) || 1; planlægBeregn(); tegnBund(); return; }
        if (t.id === 'reTarget') {
            // Tomt felt = «brug gruppens norm igen», ikke «ingen målvægt».
            const v = num(t.value);
            S.draft.target_weight_g = v != null ? v : S.draft.target_weight_category_g;
            S.draft.target_weight_source = v != null ? 'recipe'
                : (S.draft.target_weight_category_g != null ? 'category' : null);
            planlægBeregn(); tegnBund(); return;
        }
        if (t.id === 'reDbTarget') { S.priceTarget = Number(t.value); tegnOverblik(); return; }
        if (t.dataset.act === 'amount') { sætMængde(t.dataset.key, t.value); return; }
        if (t.dataset.act === 'step' || t.dataset.act === 'step-min') { trinRørt(); return; }
        if (t.dataset.act === 'plain') { plainRørt(t.value); return; }
    });

    el.addEventListener('change', (e) => {
        const t = e.target;
        if (t.id === 'reGroup') {
            S.draft.group = t.value; tegnBund();
            if (S.mode === 'new' && !(S.draft.lines || []).length) hentSektionsskabelon();
            return;
        }
        if (t.id === 'reYUnit') { S.draft.yield.unit = t.value; planlægBeregn(); tegnBund(); return; }
        if (t.dataset.act === 'newunit') {
            const l = linjeFraKey(t.dataset.key);
            if (l && l.new_product) { l.new_product.qu_id_stock = t.value ? Number(t.value) : null; }
            byggLinjer(); tegnListe(); planlægBeregn(); tegnBund();
            return;
        }
    });

    el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const a = b.dataset.act;

        if (b.id === 'reBack')    { if (S.onExit) S.onExit(null); return; }
        if (b.id === 'reSave')    { gem(false); return; }
        if (b.id === 'reSaveNew') { gem(true); return; }
        if (b.id === 'reDiscard') { if (confirm('Kassér ændringerne?') && S.onExit) S.onExit(null); return; }
        if (b.id === 'reReview')  { åbnGennemgang(); return; }

        if (a === 'col') {
            S.columns[b.dataset.col] = !S.columns[b.dataset.col];
            gemKolonner(); tegnListe(); tegnOverblik(); return;
        }
        if (a === 'expand')  { foldUd(b.dataset.key); return; }
        if (a === 'inc')     { justérMængde(b.dataset.key, 1); return; }
        if (a === 'dec')     { justérMængde(b.dataset.key, -1); return; }
        if (a === 'menu')    { åbnMenu(b, b.dataset.key); return; }
        if (a === 'fill-cost' || a === 'fill-co2') { åbnNyVareFraLinje(b.dataset.key); return; }

        if (a === 'pick-product') {
            tilføjLinje({ product_id: Number(b.dataset.id), amount: 1 }); return;
        }
        if (a === 'pick-semi') {
            // #270: linjen lægges på VAREN, ikke på opskriften. Opskriften
            // bæres med, så ⋯ → «Åbn opskrift» og udfoldningen ved hvor den
            // kommer fra.
            tilføjLinje({ product_id: Number(b.dataset.pid), semi_recipe_id: Number(b.dataset.id), amount: 1 });
            return;
        }
        if (a === 'pick-nesting') {
            tilføjLinje({ includes_recipe_id: Number(b.dataset.id), servings: 1 }); return;
        }
        if (a === 'new-product') {
            S.newLine = { name: (S.search.res && S.search.res.nyVare ? S.search.res.nyVare.name : S.search.q),
                          qu_id_stock: null, product_group_id: null, amount: null,
                          price_per_unit: null, co2e_per_unit: null };
            tegnResultater(); return;
        }
        if (a === 'new-cancel') { S.newLine = null; tegnResultater(); return; }
        if (a === 'new-add')    { tilføjNyVare(); return; }
        if (a === 'plain2steps'){ plainTilTrin(); return; }
        if (a === 'step-add')   { tilføjTrin(); return; }
        if (a === 'step-del')   { fjernTrin(Number(b.dataset.i)); return; }
        if (a === 'open-recipe') {
            const v = S.lines.lines.find(l => l.key === b.dataset.key);
            const rid = v && (v.type === 'nesting' ? v.includes_recipe_id : v.semi_recipe_id);
            if (rid) window.open('/kitchen/recipes.html?recipe=' + rid, '_blank', 'noopener');
            return;
        }
    });

    tegnBund();
}

function tilføjNyVare() {
    const v = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
    const navn = v('nvName').trim();
    if (!navn) { alert('Den nye vare skal have et navn.'); return; }
    tilføjLinje({
        new_product: {
            key: 'n' + Date.now(),
            name: navn,
            qu_id_stock: v('nvUnit') ? Number(v('nvUnit')) : null,
            product_group_id: v('nvGroup') ? Number(v('nvGroup')) : null,
            price_per_unit: num(v('nvPrice')),
            co2e_per_unit: num(v('nvCo2')),
        },
        amount: num(v('nvAmount')),
    });
}

/** «pris?»-knappen: åbn den linje der mangler noget, ikke en ny. */
function åbnNyVareFraLinje(key) {
    const l = linjeFraKey(key);
    if (!l || !l.new_product) return;
    S.editLineKey = key;
    S.newLine = Object.assign({ amount: l.amount }, l.new_product);
    S.search.open = true;
    tegnResultater();
    setTimeout(() => { const e = document.getElementById('nvPrice'); if (e) e.focus(); }, 0);
}

/* ── ⋯-menuen (R6.1) ──────────────────────────────────────────── */

function åbnMenu(knap, key) {
    lukMenu();
    const v = S.lines.lines.find(l => l.key === key);
    if (!v) return;
    const m = document.createElement('div');
    m.className = 're-menu';
    const punkter = [];
    if (v.expandable) punkter.push(['open-recipe', 'Åbn opskrift']);
    punkter.push(['move', 'Flyt til sektion ▸']);
    punkter.push(['waste', v.annotation ? 'Ret svind' : 'Sæt svind']);
    punkter.push(['remove', 'Fjern']);
    m.innerHTML = punkter.map(([a, t]) =>
        '<button class="re-menu-i" data-menu="' + a + '" data-key="' + esc(key) + '">' + esc(t) + '</button>').join('');

    document.body.appendChild(m);
    const r = knap.getBoundingClientRect();
    m.style.top = (window.scrollY + r.bottom + 4) + 'px';
    m.style.left = (window.scrollX + r.right - m.offsetWidth) + 'px';
    S.menu = m;

    m.addEventListener('click', (e) => {
        const b = e.target.closest('[data-menu]');
        if (!b) return;
        const a = b.dataset.menu;
        lukMenu();
        if (a === 'remove') fjernLinje(key);
        if (a === 'move')   flytSektion(key);
        if (a === 'waste')  sætSvind(key);
        if (a === 'open-recipe') {
            const rid = v.type === 'nesting' ? v.includes_recipe_id : v.semi_recipe_id;
            if (rid) window.open('/kitchen/recipes.html?recipe=' + rid, '_blank', 'noopener');
        }
    });
    setTimeout(() => document.addEventListener('click', lukMenuUdenfor), 0);
}

function lukMenu() {
    if (S.menu) { S.menu.remove(); S.menu = null; }
    document.removeEventListener('click', lukMenuUdenfor);
}
function lukMenuUdenfor(e) { if (S.menu && !S.menu.contains(e.target)) lukMenu(); }

function flytSektion(key) {
    const l = linjeFraKey(key);
    if (!l) return;
    const valg = sektionsliste().filter(s => s !== l.section);
    const svar = prompt('Flyt til sektion:\n' + valg.map((s, i) => (i + 1) + '. ' + (s || '(uden sektion)')).join('\n') +
                        '\n\nSkriv nummer eller et nyt navn:');
    if (svar == null) return;
    const n = parseInt(svar, 10);
    l.section = (isFinite(n) && n >= 1 && n <= valg.length) ? valg[n - 1] : svar.trim();
    S.lastSection = l.section;
    byggLinjer(); tegnListe(); tegnTilføj(); tegnBund();
}

/** I2: svind ANNOTERES. Mængden røres ikke — vi regner ikke baglæns. */
function sætSvind(key) {
    const l = linjeFraKey(key);
    if (!l) return;
    const svar = prompt('Svind i procent (tom fjerner):', l.waste_pct == null ? '' : String(l.waste_pct));
    if (svar == null) return;
    const n = num(svar);
    if (n == null) { delete l.waste_pct; delete l.waste_label; }
    else {
        l.waste_pct = n;
        const t = (prompt('Hvad slags svind? (fx rensesvind)', l.waste_label || 'svind') || '').trim();
        if (t) l.waste_label = t;
    }
    byggLinjer(); tegnListe(); tegnBund();
}

/* ── Gennemgang (§8.4) ────────────────────────────────────────── */

function åbnGennemgang() {
    const rk = RL.reviewOrder(S.lines);
    if (!rk.length) return;
    // Gennemgangen tager linjerne i rækkefølge; den kan forlades når som helst,
    // og listen kan altid redigeres frit ved siden af.
    åbnNyVareFraLinje(rk[0].key);
}

/* ── Trin ─────────────────────────────────────────────────────── */

function trinRørt() {
    const RS = (typeof RecipeSteps !== 'undefined') ? RecipeSteps : null;
    if (!RS) return;
    const p = S.stepsParsed || (S.stepsParsed = RS.parseDescription(S.draft.description || ''));
    const tekster = [...S.el.querySelectorAll('[data-act="step"]')];
    const minutter = [...S.el.querySelectorAll('[data-act="step-min"]')];
    S.stepsEdited = Object.assign({}, S.stepsEdited || {}, { steps: tekster.map((t, i) => ({
        text: t.value, minutes: num(minutter[i] ? minutter[i].value : null),
    })) });
    const h = S.el.querySelector('.re-steps-h .re-dim');
    const total = RS.totalMinutes(S.stepsEdited.steps);
    if (h) h.textContent = total ? ('Samlet tid ' + total + ' min') : '';
    tegnBund();
}

/**
 * Fri tekst er rørt. Ingen gentegning — så ville markøren hoppe i textarea'et
 * ved hvert tastetryk (samme fælde som mængdefeltet havde).
 */
function plainRørt(værdi) {
    const nu = S.stepsEdited || {};
    S.stepsEdited = Object.assign({}, nu, { plain: værdi });
    tegnBund();
}

/**
 * Teksten er allerede fremgangsmåden — den mangler bare numre. Ét linjeskift
 * bliver ét trin, og `plain` ryddes: teksten ER blevet til trinene, så den må
 * ikke stå to steder.
 */
function plainTilTrin() {
    const RS = (typeof RecipeSteps !== 'undefined') ? RecipeSteps : null;
    if (!RS) return;
    const p = S.stepsParsed || (S.stepsParsed = RS.parseDescription(S.draft.description || ''));
    const tekst = (S.stepsEdited && S.stepsEdited.plain !== undefined)
        ? S.stepsEdited.plain : p.plain;
    const linjer = String(tekst || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!linjer.length) return;
    const nu = (S.stepsEdited && S.stepsEdited.steps) || p.steps;
    S.stepsEdited = {
        steps: (nu || []).concat(linjer.map(t => ({ text: t, minutes: null }))),
        plain: '',
    };
    tegnTrin(); tegnBund();
}

function tilføjTrin() {
    const RS = (typeof RecipeSteps !== 'undefined') ? RecipeSteps : null;
    if (!RS) return;
    const p = S.stepsParsed || (S.stepsParsed = RS.parseDescription(S.draft.description || ''));
    const nu = (S.stepsEdited && S.stepsEdited.steps) || p.steps;
    S.stepsEdited = Object.assign({}, S.stepsEdited || {},
        { steps: nu.concat([{ text: '', minutes: null }]) });
    tegnTrin(); tegnBund();
}

function fjernTrin(i) {
    const RS = (typeof RecipeSteps !== 'undefined') ? RecipeSteps : null;
    if (!RS) return;
    const p = S.stepsParsed || (S.stepsParsed = RS.parseDescription(S.draft.description || ''));
    const nu = ((S.stepsEdited && S.stepsEdited.steps) || p.steps).slice();
    nu.splice(i, 1);
    S.stepsEdited = Object.assign({}, S.stepsEdited || {}, { steps: nu });
    tegnTrin(); tegnBund();
}

/* ══════════════════════════════════════════════════════════════ */

window.RecipeEditor = { mount, _state: S };

})();
