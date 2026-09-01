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
function setup({ cards = [], pathname = '/kitchen/today.html', withToday = true, drawer = false } = {}) {
    const dom  = makeDom(cards);
    const kald = { drawer: [], reload: 0, href: [], closeModal: 0 };

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
        fetchBon: () => Promise.resolve({}),
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

test('bon på en anden dag: draweren åbnes i stedet for en død hash-navigation', () => {
    const { ctx, kald } = setup({ cards: [kort('bon3', 'igang')], drawer: true });

    ctx._gotoFlyverBon(9);

    assert.deepEqual(kald.drawer, [9], 'bonen skal åbnes i draweren');
    assert.equal(kald.reload, 0, 'ingen genindlæsning når draweren kan vise bonen');
    assert.deepEqual(kald.href, [], 'ingen navigation');
});

test('ingen drawer og allerede på I dag: siden genindlæses (hash alene er ikke en navigation)', () => {
    const { ctx, kald } = setup({ cards: [], drawer: false, pathname: '/kitchen/today.html' });

    ctx._gotoFlyverBon(9);

    assert.equal(kald.reload, 1, 'et hash-skift alene henter ikke bonen');
});

test('ingen drawer og en anden side: der navigeres til I dag med hash', () => {
    const { ctx, kald } = setup({ cards: [], drawer: false, pathname: '/kitchen/planning.html' });

    ctx._gotoFlyverBon(9);

    assert.equal(kald.reload, 0);
    assert.deepEqual(kald.href, ['/kitchen/today.html#bon9']);
});

test('modalen lukkes uanset hvilken vej der tages', () => {
    const a = setup({ cards: [kort('bon6', 'lev')] });
    a.ctx._gotoFlyverBon(6);
    assert.equal(a.kald.closeModal, 1);

    const b = setup({ cards: [], drawer: true });
    b.ctx._gotoFlyverBon(9);
    assert.equal(b.kald.closeModal, 1);
});
