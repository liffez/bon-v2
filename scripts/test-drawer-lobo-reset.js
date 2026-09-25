// By-ex-panelet i bon-draweren må aldrig bære en anden bons data (25/9 2026:
// B4321 viste B4322's reference + kontakt, og "Bestil rigtigt bud" ville have
// sendt dem afsted på B4321). Kører de ægte metoder fra shared/bon_drawer.js.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

function el(cls) {
    return { className: cls, hidden: true, innerHTML: '', textContent: '', _q: {},
        querySelector(s) { return this._q[s] || null; } };
}

const calls = { preview: [], book: [] };
let pending = [];
const ctx = {
    console, document: {}, window: {}, setTimeout, clearTimeout,
    alert() {}, confirm: () => true,
    fetchLoboStatus: async () => ({ use_sandbox: true }),
    previewLoboBooking: (d) => { calls.preview.push(d); return new Promise(r => pending.push({ d, r })); },
    bookLoboDelivery: async (d) => { calls.book.push(d); },
    fetchLoboOrderStatus: (id) => new Promise(r => pending.push({ d: { bon_id: id }, r })),
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/bon_drawer.js'), 'utf8') + ';this.BonDrawer = BonDrawer;', ctx);
const P = ctx.BonDrawer.prototype;

function drawer(bonId) {
    const nodes = { '.drawer-lobo-panel': el('drawer-lobo-panel'), '.drawer-lobo-quote': el('drawer-lobo-quote'), '.drawer-lobo-status': el('drawer-lobo-status') };
    const d = Object.create(P);
    d.bonId = bonId;
    d.el = { querySelector: (s) => nodes[s] || null };
    d._loboRenderPanel = function (host, data) { host.innerHTML = 'panel for ' + data.bon; host.hidden = false; };
    d.nodes = nodes;
    return d;
}
const tick = () => new Promise(r => setImmediate(r));

(async () => {
    console.log('§1 bon-skift rydder panelerne');
    const d = drawer(4322);
    d._loboOverrides = { reference: '#B4322', contact: 'Louise Hinsch' };
    d._loboPanelBonId = 4322;
    d.nodes['.drawer-lobo-panel'].hidden = false;
    d.nodes['.drawer-lobo-panel'].innerHTML = 'Louise Hinsch';
    d.nodes['.drawer-lobo-quote'].hidden = false;
    d.nodes['.drawer-lobo-quote'].innerHTML = 'By-ex pris 4322';
    d._resetLoboUi();
    ok(d.nodes['.drawer-lobo-panel'].hidden && d.nodes['.drawer-lobo-panel'].innerHTML === '', 'panelet er skjult og tomt');
    ok(d.nodes['.drawer-lobo-quote'].hidden && d.nodes['.drawer-lobo-quote'].innerHTML === '', 'pris-kortet er skjult og tomt');
    ok(Object.keys(d._loboOverrides).length === 0, 'overrides er ryddet');
    ok(d._loboPanelBonId === null, 'panelet er ikke længere knyttet til en bon');

    console.log('§2 load() kalder oprydningen ved skift — og kun ved skift');
    const src = fs.readFileSync(path.join(__dirname, '../shared/bon_drawer.js'), 'utf8');
    const loadBody = src.slice(src.indexOf('async load(bonId, opts)'), src.indexOf('_render() {'));
    ok(/if \(this\.bonId !== bonId\) this\._resetLoboUi\(\);[\s\S]*this\.bonId = bonId;/.test(loadBody), 'load() rydder FØR bonId skiftes');

    console.log('§3 et forsinket preview-svar lander ikke på den nye bon');
    const d2 = drawer(4322);
    const p = d2._loboFetchPreview();
    await tick(); await tick();
    d2.bonId = 4321; d2._resetLoboUi();          // brugeren skifter bon imens
    pending.shift().r({ bon: 4322 });
    await p;
    ok(d2.nodes['.drawer-lobo-panel'].innerHTML === '', 'svaret for 4322 blev kasseret');
    ok(d2._loboPanelBonId === null, 'panelet er ikke erklæret hentet for 4321');

    console.log('§4 book nægter når panelet er hentet for en anden bon');
    const d3 = drawer(4321);
    d3._loboOverrides = { reference: '#B4322' };
    d3._loboPanelBonId = 4322;
    d3.nodes['.drawer-lobo-panel']._q['.lbp-err'] = { textContent: '', hidden: true };
    await d3._loboBook(true);
    ok(calls.book.length === 0, 'intet bud sendt');
    ok(/anden bon/.test(d3.nodes['.drawer-lobo-panel']._q['.lbp-err'].textContent), 'brugeren får at vide hvorfor');

    console.log('§5 book virker når panelet hører til bonnen');
    d3.load = () => {};
    d3._loboPanelBonId = 4321;
    await d3._loboBook(true);
    ok(calls.book.length === 1 && calls.book[0].bon_id === 4321, 'bud sendt for den rigtige bon');

    console.log('§6 forsinket ordre-status lander ikke på den nye bon');
    const d4 = drawer(4322);
    const s = d4._loadLoboStatus();
    await tick();
    d4.bonId = 4321;
    pending.shift().r({ booked: true, status: 'x' });
    await s;
    ok(d4.nodes['.drawer-lobo-status'].hidden === true, 'status for 4322 vises ikke på 4321');

    console.log(`\n${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
