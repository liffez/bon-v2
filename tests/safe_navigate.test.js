// tests/safe_navigate.test.js
// ==========================================================================
// safeNavigate(): et zone-skift må ikke ende på browserens "Der er ingen
// internetforbindelse"-side når forbindelsen er død (#423).
//
// Browserkode kan ikke require's, så den rigtige shared/utils.js køres i en
// vm-sandkasse med attrapper for fetch/location/document. Det er altså de
// samme funktioner browseren bruger — ikke en kopi.
//
// Kør: node --test tests/safe_navigate.test.js
// ==========================================================================

const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('node:vm');
const fs     = require('node:fs');
const path   = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'utils.js'), 'utf8');

/* ── Minimal DOM, kun det _navShowRetry og guardLink rører ── */
function makeEl(tag) {
    return {
        tagName: tag,
        id: '',
        style: {},
        children: [],
        parentNode: null,
        innerHTML: '',
        textContent: '',
        type: '',
        _attrs: {},
        _listeners: {},
        setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
        addEventListener(t, f) { (this._listeners[t] || (this._listeners[t] = [])).push(f); },
        dispatch(t, ev) { (this._listeners[t] || []).forEach(f => f(ev)); }
    };
}

function findByText(el, text) {
    if (el.textContent === text) return el;
    for (const c of el.children) { const hit = findByText(c, text); if (hit) return hit; }
    return null;
}

function find(el, id) {
    if (el.id === id) return el;
    for (const c of el.children) { const hit = find(c, id); if (hit) return hit; }
    return null;
}

/**
 * @param {Array<'ok'|'fail'|'timeout'>} plan  ét svar pr. forventet probe.
 *                                             Løber planen tør, svares 'fail'.
 */
function makeCtx(plan) {
    const probes = [];
    const body = makeEl('body');
    const nav = { href: null };

    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        Promise, Error, JSON, Object, Array, String, Number, Boolean, Date, Math, RegExp,
        AbortController,

        get location() { return nav; },
        set location(v) { nav.href = v; },

        document: {
            body,
            createElement: makeEl,
            getElementById: (id) => find(body, id)
        },

        fetch(url, opts) {
            const answer = plan.length ? plan.shift() : 'fail';
            probes.push({ url, method: opts && opts.method, cache: opts && opts.cache });
            if (answer === 'ok') return Promise.resolve({ ok: true, status: 200 });
            if (answer === 'fail') return Promise.reject(new TypeError('Load failed'));
            // 'timeout': svarer aldrig — men skal afvise ved abort, praecis som
            // den rigtige fetch. Ellers ville testen bare haenge.
            return new Promise((_, reject) => {
                const sig = opts && opts.signal;
                if (sig) sig.addEventListener('abort', () => {
                    const e = new Error('The operation was aborted.');
                    e.name = 'AbortError';
                    reject(e);
                });
            });
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    // location er en accessor på sandbox-objektet; i vm-konteksten skal
    // tildeling ramme den samme.
    const ctx = vm.createContext(sandbox);
    vm.runInContext(SRC, ctx);
    ctx.NAV_PROBE_TIMEOUT_MS = 60;     // hold testen hurtig
    ctx.NAV_RETRY_INTERVAL_MS = 40;
    return { ctx, probes, nav, body };
}

const tick = (ms) => new Promise(r => setTimeout(r, ms));

test('levende forbindelse: navigerer efter én prøve', async () => {
    const { ctx, probes, nav } = makeCtx(['ok']);
    ctx.safeNavigate('/office/');
    await tick(30);

    assert.equal(probes.length, 1, 'kun én prøve');
    assert.equal(probes[0].method, 'HEAD', 'prøven må ikke hente hele siden');
    assert.equal(probes[0].cache, 'no-store', 'og må ikke besvares fra cachen');
    assert.equal(probes[0].url, '/office/', 'den prøver selve destinationen');
    assert.equal(nav.href, '/office/');
});

test('død forbindelse rives ned af første prøve — anden går igennem', async () => {
    const { ctx, probes, nav } = makeCtx(['fail', 'ok']);
    ctx.safeNavigate('/office/');
    await tick(40);

    assert.equal(probes.length, 2, 'præcis ét genforsøg');
    assert.equal(nav.href, '/office/', 'og så navigerer vi');
});

test('to fejl: vi bliver på siden og viser vores egen besked', async () => {
    const { ctx, probes, nav, body } = makeCtx(['fail', 'fail']);
    ctx.safeNavigate('/office/');
    await tick(40);

    assert.equal(probes.length, 2);
    assert.equal(nav.href, null, 'siden brugeren står på må ikke gå tabt');
    const overlay = find(body, 'nav-retry-overlay');
    assert.ok(overlay, 'brugeren skal se hvad der sker');

    // "Bliv her" skal lukke overlayet og stoppe genforsoegene.
    findByText(overlay, 'Bliv her').dispatch('click', {});
    assert.equal(find(body, 'nav-retry-overlay'), null, 'overlayet skal kunne lukkes');
});

test('overlayet prøver videre af sig selv og navigerer når nettet er tilbage', async () => {
    const { ctx, nav, body } = makeCtx(['fail', 'fail', 'fail', 'ok']);
    ctx.safeNavigate('/office/');
    await tick(200);

    assert.equal(nav.href, '/office/', 'genforsøget skal selv komme videre');
    assert.equal(find(body, 'nav-retry-overlay'), null, 'og rydde op efter sig');
});

test('langsomt net er ikke dødt net — timeout blokerer ikke', async () => {
    const { ctx, probes, nav } = makeCtx(['timeout']);
    ctx.safeNavigate('/office/');
    await tick(140);

    assert.equal(probes.length, 1, 'et timeout udløser ikke et genforsøg');
    assert.equal(nav.href, '/office/', 'vi navigerer frem for at spærre');
});

test('guardLink: almindeligt klik går gennem safeNavigate', async () => {
    const { ctx, probes, nav } = makeCtx(['ok']);
    const a = makeEl('a');
    a.setAttribute('href', '/office/');
    ctx.guardLink(a);

    let prevented = false;
    a.dispatch('click', { button: 0, preventDefault() { prevented = true; } });
    await tick(30);

    assert.ok(prevented, 'browserens egen navigation skal stoppes');
    assert.equal(probes.length, 1);
    assert.equal(nav.href, '/office/');
});

test('guardLink: cmd-klik og ny fane røres ikke', async () => {
    const { ctx, probes } = makeCtx(['ok', 'ok', 'ok']);

    const cmd = makeEl('a');
    cmd.setAttribute('href', '/office/');
    ctx.guardLink(cmd);
    let p1 = false;
    cmd.dispatch('click', { button: 0, metaKey: true, preventDefault() { p1 = true; } });

    const blank = makeEl('a');
    blank.setAttribute('href', '/office/');
    blank.setAttribute('target', '_blank');
    ctx.guardLink(blank);
    let p2 = false;
    blank.dispatch('click', { button: 0, preventDefault() { p2 = true; } });

    const middle = makeEl('a');
    middle.setAttribute('href', '/office/');
    ctx.guardLink(middle);
    let p3 = false;
    middle.dispatch('click', { button: 1, preventDefault() { p3 = true; } });

    await tick(30);
    assert.ok(!p1 && !p2 && !p3, 'ny fane / ny vindue skal stadig virke som før');
    assert.equal(probes.length, 0, 'og der må ikke prøves noget af');
});

test('guardLink binder kun én gang', async () => {
    const { ctx, probes } = makeCtx(['ok', 'ok']);
    const a = makeEl('a');
    a.setAttribute('href', '/office/');
    ctx.guardLink(a);
    ctx.guardLink(a);

    a.dispatch('click', { button: 0, preventDefault() {} });
    await tick(30);
    assert.equal(probes.length, 1, 'dobbelt binding ville give dobbelt navigation');
});
