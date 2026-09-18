// tests/formidler_mark.test.js
// ==========================================
// Formidler-mærket: en bon der ligger på et firma som bestiller for andre,
// og hvor vi ikke ved hvem maden er til.
//
// Mærket er bevidst tavst. Nogle formidlere oplyser aldrig slutkunden, så et
// tomt felt er ofte den rigtige tilstand — mærket må derfor ikke ligne en
// opgave. Testen holder fast i BEGGE dele: at det vises hvor det skal, og at
// det IKKE larmer (ingen farve, ingen advarselsklasse, ét ord).
//
// Browser-kode kan ikke require'es, så shared/utils.js køres i en vm-sandkasse
// og den ægte funktion kaldes. Kaldestederne verificeres mod kildefilerne, så
// en regel der lever videre mens kaldet er væk, bliver fanget.
// ==========================================

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

// Den ÆGTE utils.js i en sandkasse med de globals browseren giver den.
const sandbox = { window: {}, document: { addEventListener() {} }, localStorage: {
    getItem: () => null, setItem() {}, removeItem() {} }, navigator: { userAgent: '' },
    console, setTimeout, clearTimeout, fetch: async () => ({ ok: false }) };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared/utils.js'), 'utf8'), sandbox,
    { filename: 'shared/utils.js' });
const formidlerMark = sandbox.formidlerMark;

test('funktionen findes i utils.js', () => {
    assert.strictEqual(typeof formidlerMark, 'function',
        'formidlerMark skal være defineret i shared/utils.js');
});

test('formidler uden slutkunde → mærke', () => {
    assert.strictEqual(formidlerMark({ company_is_reseller: 1 }), true);
    assert.strictEqual(formidlerMark({ company_is_reseller: 1, end_customer_name: null }), true);
    assert.strictEqual(formidlerMark({ company_is_reseller: 1, end_customer_name: '' }), true);
    assert.strictEqual(formidlerMark({ company_is_reseller: 1, end_customer_name: '   ' }), true,
        'kun mellemrum er ikke en slutkunde');
});

test('formidler MED slutkunde → intet mærke', () => {
    // Listen viser "Able → Systematic" og draweren har navnet i feltet.
    // Et mærke oveni ville være støj om noget man allerede kan se.
    assert.strictEqual(formidlerMark({ company_is_reseller: 1, end_customer_name: 'Systematic' }), false);
});

test('almindeligt firma → aldrig mærke, uanset tomt felt', () => {
    // Kontrolprøven. Langt de fleste bons har ingen slutkunde og skal ikke have
    // det — et mærke her ville ramme hele bon-listen.
    assert.strictEqual(formidlerMark({ company_is_reseller: 0 }), false);
    assert.strictEqual(formidlerMark({ company_is_reseller: 0, end_customer_name: '' }), false);
    assert.strictEqual(formidlerMark({}), false);
    assert.strictEqual(formidlerMark({ company_is_reseller: null }), false);
});

test('tåler at blive kaldt uden bon', () => {
    // Draweren kalder den på data der endnu ikke er hentet.
    assert.strictEqual(formidlerMark(null), false);
    assert.strictEqual(formidlerMark(undefined), false);
});

test('is_reseller accepteres som tal og streng', () => {
    // SQLite giver 1; en JSON-runde eller et formularfelt kan give "1".
    assert.strictEqual(formidlerMark({ company_is_reseller: 1 }), true);
    assert.strictEqual(formidlerMark({ company_is_reseller: '1' }), true);
    assert.strictEqual(formidlerMark({ company_is_reseller: true }), true);
});

// ─── Kaldestederne bruger reglen ─────────────────────────────
// En regel der er rigtig, men ikke kaldt, er død kode. Uden disse ville en
// mutation der river kaldet ud slippe igennem alle asserts ovenfor.

test('bon-listen bruger den delte regel', () => {
    const src = fs.readFileSync(path.join(ROOT, 'office/views/bons-list.js'), 'utf8');
    assert.match(src, /formidlerMark\(bon\)/,
        'bons-list skal kalde formidlerMark, ikke have sin egen kopi af reglen');
    assert.doesNotMatch(src, /else if \(bon\.company_is_reseller\)/,
        'reglen må ikke være skrevet af i listen — den skal komme fra utils.js');
    assert.match(src, /case 'company':\s*\n\s*_blCompanyCell\(td1, bon\);/,
        'render-loopet skal bruge _blCompanyCell — ellers er funktionen død kode');
});

// ─── Cellen bygges rigtigt ───────────────────────────────────
// Kaldt, ikke grep'et. En grep kan ikke se forskel på et mærke der bygges og
// et der faktisk sættes ind i cellen — dét hul lukkes her.

function makeCell() {
    const el = {
        children: [], textContent: '', title: '', className: '',
        classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
        appendChild(c) { this.children.push(c); return c; },
    };
    return el;
}

function cellText(td) {
    return td.textContent + td.children.map(c => c.textContent || '').join('');
}

function loadList() {
    const sb = {
        console, formidlerMark,
        document: {
            createElement: () => makeCell(),
            createTextNode: (t) => ({ textContent: t }),
            addEventListener() {},
        },
        window: {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout, clearTimeout,
    };
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'office/views/bons-list.js'), 'utf8'), sb,
        { filename: 'office/views/bons-list.js' });
    return sb;
}

test('cellen: formidler uden slutkunde får mærket SAT IND', () => {
    const sb = loadList();
    const td = makeCell();
    sb._blCompanyCell(td, { company_name: 'Able', company_is_reseller: 1 });

    assert.strictEqual(td.textContent, 'Able', 'firmanavnet står som før');
    const mk = td.children.find(c => c.className === 'bl-mark-formidler');
    assert.ok(mk, 'mærket skal ligge i cellen — ikke bare være bygget');
    assert.strictEqual(mk.textContent, 'formidler');
    assert.match(mk.title, /slutkunde ikke oplyst/);
    assert.match(cellText(td), /^Able formidler$/, 'mærket står efter navnet, adskilt af mellemrum');
});

test('cellen: kendt slutkunde giver pil og INTET mærke', () => {
    const sb = loadList();
    const td = makeCell();
    sb._blCompanyCell(td, { company_name: 'Able', company_is_reseller: 1, end_customer_name: 'Systematic' });

    assert.strictEqual(td.textContent, 'Able \u2192 Systematic');
    assert.ok(!td.children.some(c => c.className === 'bl-mark-formidler'),
        'pilen siger det allerede — mærket ville være støj');
});

test('cellen: almindeligt firma er uændret', () => {
    const sb = loadList();
    const td = makeCell();
    sb._blCompanyCell(td, { company_name: 'Novo' });

    assert.strictEqual(cellText(td), 'Novo', 'ingen mærke, ingen pil');
    assert.strictEqual(td.children.length, 0);
    assert.ok(td.classList.contains('bl-td-dim'), 'cellen skal stadig være dæmpet som før');
});

test('bon-draweren bruger den delte regel', () => {
    const src = fs.readFileSync(path.join(ROOT, 'shared/bon_drawer.js'), 'utf8');
    // Negationen pinnes: mærket SKJULES når reglen er falsk. Uden dette slap en
    // ombytning igennem, hvor mærket dukkede op på alle andre end formidlerne.
    assert.match(src, /mark\.hidden\s*=\s*!formidlerMark\(d\)/,
        'draweren skal skjule mærket når reglen er falsk — ikke omvendt');
    assert.match(src, /drawer-mark-formidler/,
        'draweren skal have et element at vise mærket i');
});

// ─── Mærket må ikke larme ────────────────────────────────────

test('mærket er ét ord, uden ikon', () => {
    const list = fs.readFileSync(path.join(ROOT, 'office/views/bons-list.js'), 'utf8');
    const m = list.match(/mk\.textContent = '([^']*)'/);
    assert.ok(m, 'mærkets tekst skal kunne findes i listen');
    assert.strictEqual(m[1], 'formidler');
    assert.ok(!/\s/.test(m[1]), 'mærket skal være ét ord');
    assert.ok(!/[☀-➿\ud83c-\udbff⚠]/.test(m[1]), 'mærket må ikke bære et ikon');

    const drawer = fs.readFileSync(path.join(ROOT, 'shared/bon_drawer.js'), 'utf8');
    assert.match(drawer, /class="drawer-mark-formidler"[^>]*>formidler<\/span>/,
        'draweren skal bruge samme ene ord');
});

test('mærket har ingen advarselsfarve', () => {
    // Rød og amber er reserveret til noget der skal handles på. Et tomt
    // slutkunde-felt er ofte den rigtige tilstand og må aldrig se forkert ud.
    const css = [
        fs.readFileSync(path.join(ROOT, 'shared/bon_drawer.css'), 'utf8')
            .match(/\.drawer-mark-formidler\s*\{[^}]*\}/)?.[0],
        fs.readFileSync(path.join(ROOT, 'office/index.html'), 'utf8')
            .match(/\.bl-mark-formidler\s*\{[^}]*\}/)?.[0],
    ];
    for (const block of css) {
        assert.ok(block, 'begge mærker skal have en styling-regel');
        assert.doesNotMatch(block, /background/, 'ingen baggrundsfarve — det er ikke en pille');
        assert.doesNotMatch(block, /border(?!-)/, 'ingen ramme');
        assert.doesNotMatch(block, /#[0-9a-f]*[1-9a-f]{2}[0-9a-f]*\s*;|orange|red|amber|warning/i,
            'ingen advarselsfarve');
        assert.match(block, /font-size:\s*10px|opacity/, 'mærket skal være dæmpet');
    }
});

// ─── Backend leverer feltet ──────────────────────────────────

test('is_reseller kommer med fra begge endpoints', () => {
    // Uden dette er reglen altid falsk, og mærket ville aldrig vises — en
    // fejl der er usynlig, fordi et manglende mærke ligner "ingen formidler".
    assert.match(fs.readFileSync(path.join(ROOT, 'db/helpers.js'), 'utf8'),
        /co\.is_reseller\s+AS company_is_reseller/, 'getBon skal levere feltet til draweren');
    assert.match(fs.readFileSync(path.join(ROOT, 'routes/bons.js'), 'utf8'),
        /co\.is_reseller AS company_is_reseller/, 'GET /api/bons skal levere feltet til listen');
});
