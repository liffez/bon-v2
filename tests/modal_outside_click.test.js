// tests/modal_outside_click.test.js
// ==========================================================================
// En modal må ikke lukke fordi musen tilfældigvis blev SLUPPET uden for den.
//
// Baggrund: `click` fyrer på den nærmeste fælles forfader til dér hvor
// knappen blev trykket ned og dér hvor den blev sluppet. Markerer man tekst
// i et felt inde i modalen og trækker musen ud over overlayet, er den fælles
// forfader netop overlayet — og den gamle vagt (`if (e.target === overlay)`)
// lukkede modalen midt i en markering.
//
// Browserkode kan ikke require's, så den rigtige shared/utils.js køres i en
// vm-sandkasse med en lille DOM der modellerer capture-fase, bobling og
// netop den retargeting af `click`.
//
// Kør: node --test tests/modal_outside_click.test.js
// ==========================================================================

const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('node:vm');
const fs     = require('node:fs');
const path   = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'utils.js'), 'utf8');

/* ── Minimal DOM: forældre-kæde + capture på document + bobling ── */
function makeDom() {
    const docListeners = {};

    function el(name, parent, marks) {
        const node = {
            name,
            marks: marks || [],           // står i stedet for klasser/attributter
            parentNode: parent || null,
            _listeners: {},
            addEventListener(t, f) { (this._listeners[t] || (this._listeners[t] = [])).push(f); },
            contains(other) {
                for (let n = other; n; n = n.parentNode) if (n === this) return true;
                return false;
            },
            closest(sel) {
                for (let n = this; n; n = n.parentNode) {
                    if (n.marks && n.marks.indexOf(sel) !== -1) return n;
                }
                return null;
            }
        };
        return node;
    }

    const document = {
        addEventListener(t, f, capture) {
            assert.equal(capture, true, 'sporingen skal ligge i capture-fasen');
            (docListeners[t] || (docListeners[t] = [])).push(f);
        }
    };

    // Ét kald = ét ægte event: document ser det først (capture), derefter
    // bobler det fra target og op gennem forældrene.
    function fire(target, type) {
        const ev = { type, target, button: 0 };
        (docListeners[type] || []).forEach(f => f(ev));
        for (let n = target; n; n = n.parentNode) {
            (n._listeners[type] || []).forEach(f => f(ev));
        }
        return ev;
    }

    return { document, el, fire };
}

// Pointer-events findes i alle browsere vi rammer; mus-grenen er kun et
// sikkerhedsnet. Begge køres, så ingen af dem kan rådne.
function setup(kind) {
    const usePointer = kind !== 'mouse';
    const dom = makeDom();
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, Error, JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp,
        AbortController,
        location: { href: null },
        document: dom.document,
        fetch: () => Promise.reject(new Error('ikke brugt her'))
    };
    if (usePointer) sandbox.PointerEvent = function PointerEvent() {};
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SRC, ctx);

    const body    = dom.el('body');
    const overlay = dom.el('overlay', body);
    const panel   = dom.el('panel', overlay);
    const input   = dom.el('input', panel);
    const button  = dom.el('button', panel);

    // Dropdown ved siden af modalen — samme fejlklasse, uden overlay at
    // hænge en lytter på (kunde-søgning, kolonnevælger, MERE-menuen …).
    const list    = dom.el('list', body, ['.dropdown']);
    const listRow = dom.el('row', list);
    const udenfor = dom.el('andet', body);

    const closes = [];
    ctx.closeOnOutsideClick(overlay, () => closes.push(1));

    const DOWN = usePointer ? 'pointerdown' : 'mousedown';
    const UP   = usePointer ? 'pointerup'   : 'mouseup';

    // Ét helt museklik: ned på `down`, sluppet på `up`, og så det click
    // browseren udleder af de to.
    function fullClick(down, up) {
        dom.fire(down, DOWN);
        dom.fire(up, UP);
        dom.fire(commonAncestor(down, up), 'click');
    }

    return { ctx, fire: dom.fire, DOWN, UP, fullClick,
             body, overlay, panel, input, button, list, listRow, udenfor, closes };
}

// Browserens retargeting: click lander på den nærmeste fælles forfader.
function commonAncestor(a, b) {
    const chain = new Set();
    for (let n = a; n; n = n.parentNode) chain.add(n);
    for (let n = b; n; n = n.parentNode) if (chain.has(n)) return n;
    return null;
}

for (const kind of ['pointer', 'mouse']) {
    const k = ` [${kind}]`;

    test('markering trukket ud af modalen lukker den IKKE' + k, () => {
        const t = setup(kind);
        t.fullClick(t.input, t.overlay);
        assert.equal(t.closes.length, 0,
            'trykket startede inde i modalen — den skal blive stående');
    });

    test('ægte klik uden for modalen lukker den' + k, () => {
        const t = setup(kind);
        t.fullClick(t.overlay, t.overlay);
        assert.equal(t.closes.length, 1, 'ned og op på overlayet = klik udenfor');
    });

    test('klik på en knap inde i modalen lukker den ikke' + k, () => {
        const t = setup(kind);
        t.fullClick(t.button, t.button);
        assert.equal(t.closes.length, 0);
    });

    test('trykket startede udenfor men blev sluppet inde — lukker ikke' + k, () => {
        const t = setup(kind);
        t.fullClick(t.overlay, t.input);
        assert.equal(t.closes.length, 0,
            'sluppet inde i modalen; det er ikke et klik udenfor');
    });

    test('en afbrudt markering spærrer ikke for det næste ægte klik' + k, () => {
        const t = setup(kind);
        t.fullClick(t.input, t.overlay);   // markering trukket ud
        t.fullClick(t.overlay, t.overlay); // så et rigtigt klik udenfor
        assert.equal(t.closes.length, 1, 'vagten må ikke sætte sig fast');
    });

    test('et tryk der endnu ikke er sluppet tæller ikke som klik' + k, () => {
        const t = setup(kind);
        // Markering trukket ud og sluppet på overlayet (lukker ikke) …
        t.fullClick(t.input, t.overlay);
        // … og så et nyt tryk hvor slippet aldrig når frem (fx pointercancel
        // ved scroll på touch). Det gamle slip må ikke tælle med.
        t.fire(t.overlay, t.DOWN);
        t.fire(t.overlay, 'click');
        assert.equal(t.closes.length, 0,
            'slippet fra forrige tryk må ikke lukke modalen');
    });

    test('to markeringer i træk lukker stadig ikke' + k, () => {
        const t = setup(kind);
        t.fullClick(t.input, t.overlay);
        t.fullClick(t.input, t.overlay);
        assert.equal(t.closes.length, 0);
    });
}

test('isOutsideClick bruges af delegerede handlere (fx lageroversigten)', () => {
    const t = setup();

    // Delegeret handler: den har intet overlay-element at hænge en lytter på
    // og må spørge om trykkets ophav i stedet.
    t.fire(t.input, t.DOWN);
    t.fire(t.overlay, t.UP);
    let ev = t.fire(t.overlay, 'click');
    assert.equal(t.ctx.isOutsideClick(ev, t.overlay), false,
        'markering trukket ud er ikke et klik udenfor');

    t.fire(t.overlay, t.DOWN);
    t.fire(t.overlay, t.UP);
    ev = t.fire(t.overlay, 'click');
    assert.equal(t.ctx.isOutsideClick(ev, t.overlay), true);
});

test('isOutsideClick er tolerant over for manglende argumenter', () => {
    const t = setup();
    assert.equal(t.ctx.isOutsideClick(null, t.overlay), false);
    assert.equal(t.ctx.isOutsideClick({ target: t.overlay }, null), false);
});

test('closeOnOutsideClick vælter ikke på et manglende overlay', () => {
    const t = setup();
    assert.doesNotThrow(() => t.ctx.closeOnOutsideClick(null, () => {}));
    assert.doesNotThrow(() => t.ctx.closeOnOutsideClick(t.overlay, null));
});

/* ── Dropdowns og menuer: clickedOutside / clickedOutsideSelector ── */

test('markering trukket ud af en dropdown lukker den ikke', () => {
    const t = setup();
    t.fire(t.listRow, t.DOWN);
    t.fire(t.udenfor, t.UP);
    const ev = t.fire(t.body, 'click');   // fælles forfader
    assert.equal(t.ctx.clickedOutside(ev, t.list), false,
        'trykket startede i listen — den skal blive stående');
    assert.equal(t.ctx.clickedOutsideSelector(ev, '.dropdown'), false);
});

test('ægte klik ved siden af lukker dropdownen', () => {
    const t = setup();
    t.fire(t.udenfor, t.DOWN);
    t.fire(t.udenfor, t.UP);
    const ev = t.fire(t.udenfor, 'click');
    assert.equal(t.ctx.clickedOutside(ev, t.list), true);
    assert.equal(t.ctx.clickedOutsideSelector(ev, '.dropdown'), true);
});

test('klik inde i dropdownen tæller ikke som udenfor', () => {
    const t = setup();
    t.fire(t.listRow, t.DOWN);
    t.fire(t.listRow, t.UP);
    const ev = t.fire(t.listRow, 'click');
    assert.equal(t.ctx.clickedOutside(ev, t.list), false);
});

test('musen sluppet inde i dropdownen tæller ikke som udenfor', () => {
    const t = setup();
    t.fire(t.udenfor, t.DOWN);
    t.fire(t.listRow, t.UP);
    const ev = t.fire(t.body, 'click');
    assert.equal(t.ctx.clickedOutside(ev, t.list), false);
});

test('clickedOutside tager flere elementer (felt + resultatliste)', () => {
    const t = setup();
    // En autocomplete er BÅDE feltet og resultatlisten. Markeringen trækkes
    // ud af feltet — så må listen ikke lukke.
    t.fire(t.input, t.DOWN);
    t.fire(t.udenfor, t.UP);
    const ev = t.fire(t.body, 'click');
    assert.equal(t.ctx.clickedOutside(ev, t.input, t.list), false,
        'feltet hører med til dropdownen');
    assert.equal(t.ctx.clickedOutside(ev, t.list), true,
        'set alene fra listen lå både tryk og slip udenfor — den lukker');
});

test('clickedOutside tåler null-elementer', () => {
    const t = setup();
    t.fire(t.udenfor, t.DOWN);
    t.fire(t.udenfor, t.UP);
    const ev = t.fire(t.udenfor, 'click');
    assert.equal(t.ctx.clickedOutside(ev, null, t.list), true);
    assert.equal(t.ctx.clickedOutsideSelector(ev, '.findes-ikke'), true);
});
