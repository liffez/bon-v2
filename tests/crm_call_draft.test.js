// tests/crm_call_draft.test.js
// ============================================================
// shared/crm_call_draft.js — en påbegyndt samtale-log må ikke forsvinde når
// listen tegnes forfra (fx efter en sendt mail), og lukning med noget noteret
// skal spørge først. Den ÆGTE fil køres i vm mod en lille attrap-DOM.
// Kør: node --test tests/crm_call_draft.test.js
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Minimal DOM ──────────────────────────────────────────────
class El {
    constructor(tag, cls = '', attrs = {}) {
        this.tagName = tag.toUpperCase(); this.className = cls; this.attrs = { ...attrs };
        this.children = []; this.parent = null; this.textContent = ''; this.disabled = false;
        this._listeners = {};
        if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT') this.value = '';
    }
    get classList() {
        const self = this;
        return {
            contains: (c) => self.className.split(/\s+/).includes(c),
            add: (c) => { if (!this.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
            remove: (c) => { self.className = self.className.split(/\s+/).filter(x => x !== c).join(' '); },
        };
    }
    setAttribute(k, v) { this.attrs[k] = v; }
    appendChild(c) { c.parent = this; this.children.push(c); return c; }
    insertBefore(c, ref) { c.parent = this; const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c); return c; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
    get firstChild() { return this.children[0] || null; }
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
    querySelectorAll(sel) { return sel === '*' ? this.all() : this.all().filter(e => matches(e, sel)); }
    querySelector(sel) {
        if (sel.startsWith(':scope > ')) return this.children.find(c => matches(c, sel.slice(9))) || null;
        return this.querySelectorAll(sel)[0] || null;
    }
    closest(sel) { let e = this; while (e) { if (matches(e, sel)) return e; e = e.parent; } return null; }
    addEventListener(t, fn) { this._listeners[t] = fn; }
    set innerHTML(html) {
        // Kun til spørge-boksen: tre knapper.
        this.children = [];
        for (const cls of ['ccd-save', 'ccd-discard', 'ccd-keep']) {
            if (html.includes(cls)) this.appendChild(new El('button', cls));
        }
    }
}
function matches(e, sel) {
    if (sel.startsWith('[') ) return Object.prototype.hasOwnProperty.call(e.attrs, sel.slice(1, -1));
    if (sel.startsWith('.')) return e.classList.contains(sel.slice(1));
    if (sel === 'button') return e.tagName === 'BUTTON';
    return e.tagName === sel.toUpperCase();
}

function load() {
    const listeners = {};
    const ctx = {
        console,
        document: { head: { appendChild() {} }, createElement: (t) => new El(t) },
        addEventListener: (t, fn) => { listeners[t] = fn; },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'crm_call_draft.js'), 'utf8'), ctx);
    return { D: ctx.CrmCallDraft, listeners };
}

// En log-formular: 3 resultat-knapper, 2 stemnings-knapper, note, gem-knap.
function form() {
    const f = new El('div', 'crm-svc-logform');
    ['reached', 'no_answer', 'email_instead'].forEach(r => f.appendChild(new El('button', 'crm-svc-result-btn', { 'data-r': r })));
    ['positive', 'negative'].forEach(s => f.appendChild(new El('button', 'crm-svc-sentiment-btn', { 'data-s': s })));
    f.appendChild(new El('textarea'));
    const save = f.appendChild(new El('button', 'save')); save.disabled = true;
    return f;
}
const note = (f) => f.querySelector('textarea');

test('snapshot → gentegning → restore giver samme valg og tekst tilbage', () => {
    const { D } = load();
    const a = form();
    a.children[3].classList.add('active');          // 😊
    note(a).value = 'Glade';
    a.children[5].disabled = false;
    const snap = D.snapshot(a);
    const b = form();                                // "gentegnet"
    assert.ok(D.restore(b, snap));
    assert.ok(b.children[3].classList.contains('active'));
    assert.strictEqual(note(b).value, 'Glade');
    assert.strictEqual(b.children[5].disabled, false);
});

test('restore nægter når markup er anderledes', () => {
    const { D } = load();
    const snap = D.snapshot(form());
    const other = form(); other.appendChild(new El('input'));
    assert.strictEqual(D.restore(other, snap), false);
});

test('same: urørt = ens; valgt stemning eller tekst = ændret; gem-knappens tilstand tæller ikke', () => {
    const { D } = load();
    const f = form();
    const pristine = D.snapshot(f);
    f.children[5].disabled = false;
    assert.ok(D.same(pristine, D.snapshot(f)), 'kun disabled ændret');
    note(f).value = 'x';
    assert.ok(!D.same(pristine, D.snapshot(f)));
    note(f).value = '';
    f.children[4].classList.add('active');
    assert.ok(!D.same(pristine, D.snapshot(f)));
});

test('banner og spørge-boks tælles ikke med i billedet', () => {
    const { D } = load();
    const f = form();
    const pristine = D.snapshot(f);
    D.banner(f, '✓ Mail sendt');
    D.askUnsaved(f, {});
    assert.ok(D.same(pristine, D.snapshot(f)));
    const g = form();
    assert.ok(D.restore(g, D.snapshot(f)), 'billedet passer stadig på en frisk formular');
});

test('askUnsaved: Gem, Kassér og Fortsæt kalder hver sit', () => {
    const { D } = load();
    for (const [cls, want] of [['ccd-save', 'save'], ['ccd-discard', 'discard'], ['ccd-keep', null]]) {
        const f = form();
        let got = null;
        D.askUnsaved(f, { onSave: () => { got = 'save'; }, onDiscard: () => { got = 'discard'; } });
        const box = f.querySelector('.ccd-ask');
        assert.ok(box, 'boksen vises');
        const btn = box.querySelector('.' + cls);
        box._listeners.click({ target: { closest: () => btn }, preventDefault() {}, stopPropagation() {} });
        assert.strictEqual(got, want, cls);
        assert.strictEqual(f.querySelector('.ccd-ask'), null, 'boksen fjernes igen');
    }
});

test('guard: sidelukning advarer kun når noget er ugemt', () => {
    const { D, listeners } = load();
    let dirty = false;
    const off = D.guard(() => dirty);
    const ev = () => { const e = { prevented: false, preventDefault() { this.prevented = true; } }; listeners.beforeunload(e); return e.prevented; };
    assert.strictEqual(ev(), false);
    dirty = true;
    assert.strictEqual(ev(), true);
    off();
    assert.strictEqual(ev(), false, 'afmeldt');
});
