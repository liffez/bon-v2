// tests/flyver_goto_bon.test.js
// ==========================================================================
// "Gå til bon" i flyver-modalen skal FØRE til bonen — også når kortet er
// filtreret væk, og også når bonen slet ikke er på siden.
//
// Baggrund: et filtreret bon-kort ligger stadig i DOM'en med
// `display: none !important` (leveret-kort, IGANG/KLAR-filter). Den gamle
// knap scrollede bare til det usynlige kort, og faldt ellers tilbage på
// `location.href = '/kitchen/today.html#bon…'` — som på today.html kun er
// et hash-skift og altså ingen navigation. Begge veje så ud som om knappen
// var død.
//
// Browserkode kan ikke require's, så de rigtige shared/flyver.js og
// kitchen/today.js køres i en vm-sandkasse med en lille DOM.
//
// Kør: node --test tests/flyver_goto_bon.test.js
// ==========================================================================

const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('node:vm');
const fs     = require('node:fs');
const path   = require('node:path');

const FLYVER = fs.readFileSync(path.join(__dirname, '..', 'shared', 'flyver.js'), 'utf8');
const UTILS  = fs.readFileSync(path.join(__dirname, '..', 'shared', 'utils.js'), 'utf8');
const TODAY  = fs.readFileSync(path.join(__dirname, '..', 'kitchen', 'today.js'), 'utf8');

/* ── Minimal DOM ─────────────────────────────────────────────── */

function classList() {
    const s = new Set();
    return {
        add:      (...xs) => xs.forEach(x => s.add(x)),
        remove:   (...xs) => xs.forEach(x => s.delete(x)),
        contains: x => s.has(x),
        toggle:   (x, on) => (on ? s.add(x) : s.delete(x)),
        _set: s,
    };
}

function element(id, attrs) {
    return Object.assign({
        id,
        dataset: {},
        style: {},
        classList: classList(),
        textContent: '',
        scrolled: false,
        scrollIntoView() { this.scrolled = true; },
        addEventListener() {},
        querySelector() { return null; },
    }, attrs || {});
}

/** Bygger et køkken-I-dag-dokument med de kort testen beder om. */
function makeDom(cards) {
    const body = element('body');
    const byId = { body };
    const buttons = {};
    ['btnIgang', 'btnKlar', 'btnLev'].forEach(n => { buttons[n] = element(n); byId[n] = buttons[n]; });
    byId.todayCount = element('todayCount');
    byId.levCount   = element('levCount');
    cards.forEach(c => { byId[c.id] = c; });

    const document = {
        body,
        getElementById: id => byId[id] || null,
        addEventListener() {},
        querySelectorAll(sel) {
            if (sel === '.bon-card[data-status="lev"]')      return cards.filter(c => c.dataset.status === 'lev');
            if (sel === '.bon-card:not([data-status="lev"])') return cards.filter(c => c.dataset.status !== 'lev');
            if (sel === '.bon-card')                          return cards;
            return [];
        },
        querySelector: () => null,
    };
    return { document, body, buttons, byId };
}

/**
 * Kører flyver.js (og valgfrit today.js, som ejer revealBonCard) i én
 * sandkasse, så knappen og filtrene ses gennem samme DOM.
 */
const I_DAG = '2026-09-01';

function setup({ cards = [], pathname = '/kitchen/today.html', withToday = true,
                 drawer = false, zone = 'zone-kitchen', bons = {} } = {}) {
    const dom  = makeDom(cards);
    const kald = { drawer: [], reload: 0, href: [], closeModal: 0, fetchBon: [] };
    const bonSvar = id => (bons[id]
        ? Promise.resolve(bons[id])
        : Promise.reject(new Error('ukendt bon ' + id)));

    // Styrbare timere: fade-timeren er 8 sekunder, og pointen er netop at den
    // IKKE må nå at skjule kortet igen efter at man er hoppet til det.
    let nextTimer = 1;
    const timers = new Map();
    const fakeSet = fn => { const id = nextTimer++; timers.set(id, fn); return id; };
    const fakeClear = id => { timers.delete(id); };
    kald.koerTimere = () => {
        for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
    };

    const sandbox = {
        console: { log(){}, warn(){}, error(){} },
        setTimeout: fakeSet, clearTimeout: fakeClear,
        setInterval: fakeSet, clearInterval: fakeClear,
        Promise, Error, JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp,
        document: dom.document,
        location: { pathname, hash: '', href: pathname, reload() { kald.reload++; } },
        closeModal() { kald.closeModal++; },
        openModal() {},
        esc: s => s,
        getClientId: () => 'test-klient',
        fetchBon: id => { kald.fetchBon.push(id); return bonSvar(id); },
        todayISO: () => I_DAG,
        markNotificationRead: () => Promise.resolve(),
        fetchUnreadNotifications: () => Promise.resolve([]),
        postFlyver: () => Promise.resolve({}),
        BonLines: { mergeLines: l => l },
        // today.js-afhængigheder der ikke rører revealBonCard
        checkAuth: () => Promise.resolve(null),
        BON_CONFIG: { statuses: {} },
        VIEW_WINDOWS: {},
    };
    // location.href skal kunne aflæses som "navigeret hertil"
    Object.defineProperty(sandbox.location, 'href', {
        get: () => kald.href[kald.href.length - 1] || pathname,
        set: v => kald.href.push(v),
    });
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    if (zone) dom.body.classList.add(zone);

    const ctx = vm.createContext(sandbox);
    vm.runInContext(FLYVER, ctx);
    if (withToday) vm.runInContext(TODAY, ctx);
    if (drawer) sandbox._bonInfoEditHandler = id => kald.drawer.push(id);

    return { ctx, dom, kald, sandbox };
}

function kort(id, status) {
    const c = element(id);
    c.dataset.status = status;
    return c;
}

/* ── Kortet er på siden, men filtreret væk ───────────────────── */

test('leveret kort: VIS LEVEREDE slås til, så kortet faktisk kan ses', () => {
    const c = kort('bon6', 'lev');
    const { ctx, dom } = setup({ cards: [c, kort('bon3', 'igang')] });

    // Udgangspunkt: leverede kort er skjult (body har ikke show-lev)
    assert.equal(dom.body.classList.contains('show-lev'), false);

    ctx._gotoFlyverBon(6);

    assert.equal(dom.body.classList.contains('show-lev'), true, 'VIS LEVEREDE skal være slået til');
    assert.equal(dom.buttons.btnLev.classList.contains('locked'), true, 'knappen skal vise at filteret er låst');
    assert.equal(c.scrolled, true, 'der skal scrolles til kortet');
    assert.equal(c.classList.contains('flyver-highlight'), true, 'kortet skal fremhæves');
});

test('kort skjult af IGANG-filteret: filteret slukkes', () => {
    const c = kort('bon4', 'godkendt');
    const { ctx, dom } = setup({ cards: [c, kort('bon3', 'igang')] });

    dom.body.classList.add('filter-igang');
    dom.buttons.btnIgang.classList.add('locked', 'on-igang');

    ctx._gotoFlyverBon(4);

    assert.equal(dom.body.classList.contains('filter-igang'), false, 'filteret skal slukkes');
    assert.equal(dom.buttons.btnIgang.classList.contains('locked'), false, 'knappen må ikke stå som låst bagefter');
    assert.equal(c.scrolled, true);
});

test('leveret kort midt i fade: kortet vises — og fade-timeren skjuler det ikke igen', () => {
    const c = kort('bon6', 'lev');
    const { ctx, kald } = setup({ cards: [c] });

    // Kortet er netop sat til LEVERET og er på vej ud med 8 sekunders fortryd
    ctx.startLeveretFade(c);
    assert.equal(c.classList.contains('leveret-fading'), true);

    ctx._gotoFlyverBon(6);

    assert.equal(c.classList.contains('leveret-fading'), false, 'faden skal afbrydes');
    assert.equal(c.style.display, '', 'inline display skal ryddes');

    // Lad alle ventende timere løbe færdig — den gamle fade må ikke gemme kortet igen
    kald.koerTimere();
    kald.koerTimere();
    assert.equal(c.style.display, '', 'kortet må ikke forsvinde igen bagefter');
    assert.notEqual(c.style.opacity, '0', 'og må ikke fades ud igen');
});

test('side uden filtre (fx Senere): scroll virker stadig uden revealBonCard', () => {
    const c = kort('bon6', 'lev');
    const { ctx, sandbox } = setup({ cards: [c], withToday: false });

    assert.equal(typeof sandbox.revealBonCard, 'undefined', 'siden har ingen filtre at rydde');
    ctx._gotoFlyverBon(6);

    assert.equal(c.scrolled, true);
    assert.equal(c.classList.contains('flyver-highlight'), true);
});

/* ── Bonen er slet ikke på siden ─────────────────────────────── */

test('bon i morgen set fra I dag: der navigeres til Senere — ikke draweren', async () => {
    const { ctx, kald } = setup({
        cards: [kort('bon3', 'igang')], drawer: true,
        pathname: '/kitchen/today.html',
        bons: { 9: { delivery_date: '2026-09-03' } },
    });

    await ctx._gotoFlyverBon(9);

    assert.deepEqual(kald.href, ['/kitchen/later.html#bon9'], 'køkkenet vil se kortet, ikke draweren');
    assert.deepEqual(kald.drawer, [], 'draweren er ikke svaret i køkkenet');
});

test('bon i dag set fra Senere: der navigeres til I dag', async () => {
    const { ctx, kald } = setup({
        cards: [], drawer: true, pathname: '/kitchen/later.html',
        bons: { 9: { delivery_date: I_DAG } },
    });

    await ctx._gotoFlyverBon(9);

    assert.deepEqual(kald.href, ['/kitchen/today.html#bon9']);
});

test('samme side, kortet mangler: siden genindlæses (hash alene er ikke en navigation)', async () => {
    const { ctx, kald } = setup({
        cards: [], drawer: false, pathname: '/kitchen/today.html',
        bons: { 9: { delivery_date: I_DAG } },
    });

    await ctx._gotoFlyverBon(9);

    assert.equal(kald.reload, 1, 'et hash-skift alene henter ikke bonen');
});

test('bon i fortiden: draweren, for kortet står hverken i I dag eller Senere', async () => {
    const { ctx, kald } = setup({
        cards: [], drawer: true, bons: { 9: { delivery_date: '2026-08-20' } },
    });

    await ctx._gotoFlyverBon(9);

    assert.deepEqual(kald.drawer, [9]);
    assert.deepEqual(kald.href, [], 'ingen navigation til en side hvor kortet ikke er');
});

test('bonen kan ikke hentes: draweren frem for at gætte på en side', async () => {
    const { ctx, kald } = setup({ cards: [], drawer: true, bons: {} });

    await ctx._gotoFlyverBon(9);

    assert.deepEqual(kald.drawer, [9]);
    assert.deepEqual(kald.href, []);
});

test('office: draweren — der er ingen kort-side at navigere til', async () => {
    const { ctx, kald } = setup({
        cards: [], drawer: true, zone: 'zone-office',
        pathname: '/office/index.html', bons: { 9: { delivery_date: '2026-09-03' } },
    });

    await ctx._gotoFlyverBon(9);

    assert.deepEqual(kald.drawer, [9], 'office skal blive i office');
    assert.deepEqual(kald.href, [], 'ingen navigation væk fra office');
    assert.deepEqual(kald.fetchBon, [], 'datoen er uinteressant når vi bliver på siden');
});

test('modalen lukkes uanset hvilken vej der tages', async () => {
    const a = setup({ cards: [kort('bon6', 'lev')] });
    await a.ctx._gotoFlyverBon(6);
    assert.equal(a.kald.closeModal, 1);

    const b = setup({ cards: [], drawer: true, bons: { 9: { delivery_date: '2026-09-03' } } });
    await b.ctx._gotoFlyverBon(9);
    assert.equal(b.kald.closeModal, 1);
});

/* ── Hash-vejen: den anden halvdel af den samme rejse ────────── */
//
// _gotoFlyverBon navigerer til `…#bon<id>`, og så er det scrollToBonHash der
// skal finde kortet i den anden ende. Kunne den ikke det, ville navigationen
// bare flytte den døde knap over på næste side.

function setupHash({ cards = [], hash = '#bon9', drawer = true, withToday = true } = {}) {
    const dom  = makeDom(cards);
    const kald = { drawer: [], replaceState: [] };

    let nextTimer = 1;
    const timers = new Map();
    const sandbox = {
        console: { log(){}, warn(){}, error(){} },
        setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
        clearTimeout: id => timers.delete(id),
        setInterval: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
        clearInterval: id => timers.delete(id),
        Promise, Error, JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp, Intl,
        AbortController,
        document: dom.document,
        location: { pathname: '/kitchen/later.html', hash },
        history: { replaceState: (...a) => kald.replaceState.push(a) },
        getSelection: () => null,
        fetch: () => Promise.reject(new Error('ikke brugt her')),
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(UTILS, ctx);
    if (withToday) vm.runInContext(TODAY, ctx);
    if (drawer) sandbox._bonInfoEditHandler = id => kald.drawer.push(id);

    kald.koerTimere = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
    return { ctx, dom, kald };
}

test('hash-vejen: et filtreret kort gøres synligt, ikke bare scrollet til', () => {
    const c = kort('bon9', 'lev');
    const { ctx, dom, kald } = setupHash({ cards: [c], hash: '#bon9' });

    ctx.scrollToBonHash();
    kald.koerTimere();

    assert.equal(dom.body.classList.contains('show-lev'), true, 'VIS LEVEREDE skal tændes');
    assert.equal(c.scrolled, true);
    assert.equal(c.classList.contains('bon-highlight'), true);
});

test('hash-vejen: står bonen slet ikke på siden, åbnes draweren', () => {
    const { ctx, kald } = setupHash({ cards: [kort('bon3', 'igang')], hash: '#bon9' });

    ctx.scrollToBonHash();

    assert.deepEqual(kald.drawer, ['9'], 'Senere viser fx ikke terminale bons');
    assert.equal(kald.replaceState.length, 1, 'hash ryddes så et refresh ikke gentager det');
});

test('hash-vejen: uden drawer sker der intet — men det kaster ikke', () => {
    const { ctx, kald } = setupHash({ cards: [], hash: '#bon9', drawer: false });

    assert.doesNotThrow(() => ctx.scrollToBonHash());
    assert.deepEqual(kald.drawer, []);
});

test('hash-vejen: andre hashes røres ikke', () => {
    const { ctx, kald } = setupHash({ cards: [], hash: '#top', drawer: true });

    ctx.scrollToBonHash();

    assert.deepEqual(kald.drawer, [], 'kun #bon-hashes er bon-navigation');
    assert.deepEqual(kald.replaceState, []);
});
