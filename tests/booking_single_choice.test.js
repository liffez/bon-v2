// tests/booking_single_choice.test.js
// ==========================================================================
// Bookingsiden må ikke stille kunden over for et valg der allerede er truffet.
//
// Baggrund: sælgeren sender et link til en smagsprøve, og kunden lander på en
// side med et gitter af mødetyper. Målt i drift 17. september: 8 af 9 udsendte
// links havde slet ingen intent, så kunden skulle selv gætte hvad hun var
// blevet inviteret til. Valget skal forsvinde når der kun er ét muligt — og
// den der hellere bare vil snakke skal have en udvej, som en linje og ikke som
// et kort ved siden af (et ligestillet valg inviterer til at vælge).
//
// Browserkode kan ikke require's, så den ÆGTE inline-blok fra
// booking/smagning.html køres i en vm-sandkasse med en lille DOM. Scriptet
// kalder selv init() til sidst, så testen booter siden som browseren gør —
// en fejl undervejs ville vise "ikke tilgængelig", og dét asserter vi imod.
//
// Kør: node --test tests/booking_single_choice.test.js
// ==========================================================================

const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('node:vm');
const fs     = require('node:fs');
const path   = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'booking', 'smagning.html'), 'utf8');
const SRC  = (HTML.match(/<script>([\s\S]*?)<\/script>/) || [, ''])[1];

/* ── Trin-etiketterne læses ud af den RIGTIGE markup ──────────────────────
   Et håndskrevet spejl her ville kunne drive fra siden uden at én eneste
   assert faldt — og så ville testen sige god for en nummerering der ikke
   findes. */
/* Elementernes start-klasser kommer også fra markup'en — `hidden` i HTML er
   en del af sidens udgangspunkt, og et tomt classList ville lade enhver
   "er den skjult?"-assert bestå af den forkerte grund. */
function classesFromMarkup() {
    const map = {};
    const re = /<\w+([^>]*\bid="([^"]+)"[^>]*)>/g;
    let m;
    while ((m = re.exec(HTML))) {
        const cls = (m[1].match(/class="([^"]*)"/) || [, ''])[1];
        map[m[2]] = cls.split(/\s+/).filter(Boolean);
    }
    return map;
}
const START_CLASSES = classesFromMarkup();

function labelsFromMarkup() {
    const out = [];
    const re = /<div class="section-label"([^>]*)>/g;
    let m;
    while ((m = re.exec(HTML))) {
        const attrs = m[1];
        const step = (attrs.match(/data-step="([^"]+)"/) || [])[1];
        if (!step) continue;
        out.push({ id: (attrs.match(/id="([^"]+)"/) || [])[1] || null, step });
    }
    return out;
}

/* ── Minimal DOM ─────────────────────────────────────────────────────────── */

function classList() {
    const s = new Set();
    return {
        add:      (...xs) => xs.forEach(x => s.add(x)),
        remove:   (...xs) => xs.forEach(x => s.delete(x)),
        contains: x => s.has(x),
        toggle:   (x, on) => (on === undefined ? (s.has(x) ? s.delete(x) : s.add(x))
                                               : (on ? s.add(x) : s.delete(x))),
    };
}

function element(id) {
    const cl = classList();
    (START_CLASSES[id] || []).forEach(c => cl.add(c));
    return {
        id, dataset: {}, style: {}, classList: cl,
        textContent: '', innerHTML: '', value: '', disabled: false,
        addEventListener() {}, removeEventListener() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        appendChild() {}, insertBefore() {}, remove() {},
        focus() {}, scrollIntoView() {},
        setAttribute() {}, removeAttribute() {},
        get parentNode() { return { insertBefore() {} }; },
    };
}

/**
 * Booter siden i en sandkasse.
 * @param {object} opts
 *   meetingTypes  — hvad /meeting-types svarer
 *   kontaktOpen   — er kontakt-flowet tændt?
 *   search        — query-strengen (?mt=…, ?t=…)
 *   tokenIntent   — hvad /token/:t svarer med som intent_meeting_type
 */
async function boot(opts = {}) {
    const meetingTypes = opts.meetingTypes || [];
    const byId = {};
    const labels = labelsFromMarkup().map(l => {
        const el = element(l.id || '');
        el.dataset.step = l.step;
        if (l.id) byId[l.id] = el;
        return el;
    });

    const get = id => (byId[id] ||= element(id));

    const document = {
        getElementById: get,
        createElement: () => element(''),
        querySelectorAll(sel) {
            if (sel === '.section-label[data-step]') return labels;
            return [];
        },
        querySelector() { return null; },
        addEventListener() {},
        get body() { return get('body'); },
    };

    const calls = [];
    const fetchStub = async (url) => {
        calls.push(String(url));
        const u = String(url);
        const json = (o, ok = true) => ({ ok, status: ok ? 200 : 404, json: async () => o });
        if (u.includes('/meeting-types')) {
            return json({ available: meetingTypes.length > 0, meeting_types: meetingTypes, contact: {} });
        }
        if (u.includes('/contact-reasons')) {
            return json({ available: !!opts.kontaktOpen, contact_reasons: [], contact: {} });
        }
        if (u.includes('/token/')) {
            return json({ customer: { first_name: 'Anne' }, sales_user: { name: 'Leif' },
                          intent_meeting_type: opts.tokenIntent || null, used: false });
        }
        if (u.includes('/page-templates/')) return json(null, false);
        if (u.includes('/slots')) return json({ slots: [] });
        return json({}, false);
    };

    const sandbox = {
        document,
        window: { location: { search: opts.search || '', href: '' }, scrollTo() {} },
        location: { search: opts.search || '', href: '' },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        fetch: fetchStub,
        console: { log() {}, warn() {}, error() {} },
        URLSearchParams, Date, Math, JSON, Promise,
        setTimeout, clearTimeout, setInterval, clearInterval,
        navigator: { clipboard: null },
    };
    sandbox.window.document = document;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    // `const state = …` er en leksikalsk binding og bliver ikke en property på
    // sandkassen. Et efterfølgende script i SAMME kontekst kan se den.
    vm.runInContext('__state = state;', sandbox);
    // init() er async og ventes ikke på i siden — lad mikrotasks løbe færdigt.
    for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r));

    return {
        sandbox, calls, labels,
        el: get,
        hidden: id => get(id).classList.contains('hidden'),
        stepText: () => labels.filter(l => !l.classList.contains('hidden')).map(l => l.textContent),
    };
}

const SMAGNING = { key: 'smagning', label: 'Smagsprøve', emoji: '🍽', duration_min: 10,
                   description: 'Smag på vores menuer', needs_delivery_address: 1, asks_event_type: 0,
                   fixed_guest_count: 2 };
const ANDET    = { key: 'andet_moede', label: 'Andet møde', emoji: '💬', duration_min: 30,
                   description: 'Uforpligtende snak', needs_delivery_address: 0, asks_event_type: 1,
                   fixed_guest_count: null };

/* ── 1. Siden booter overhovedet ─────────────────────────────────────────── */

test('siden booter uden at falde tilbage på "ikke tilgængelig"', async () => {
    const p = await boot({ meetingTypes: [SMAGNING, ANDET] });
    assert.equal(p.hidden('booking-form'), false, 'formularen skal stå');
    assert.equal(p.hidden('unavailable'), true, 'fejlskærmen skal blive skjult');
});

/* ── 2. Flere valg → vælgeren bliver, og numrene er 1-4 ──────────────────── */

test('to bookbare typer: vælgeren vises, og trinnene er nummereret 1-4', async () => {
    const p = await boot({ meetingTypes: [SMAGNING, ANDET] });
    assert.equal(p.hidden('mt-grid'), false, 'gitteret skal vises når der ER et valg');
    assert.equal(p.hidden('lbl-mt'), false);
    assert.equal(p.hidden('mt-locked'), true, 'intet låst-mærke når kunden selv vælger');
    assert.deepEqual(p.stepText(),
        ['1 — Vælg mødetype', '2 — Vælg dato', '3 — Vælg tid', '4 — Dine oplysninger']);
});

/* ── 3. REGRESSIONEN: ét valg er ikke et valg ────────────────────────────── */

test('REGRESSIONEN: én bookbar type → vælgeren forsvinder og numrene rykker', async () => {
    const p = await boot({ meetingTypes: [SMAGNING] });
    assert.equal(p.hidden('mt-grid'), true, 'et gitter med ét kort er en forhindring');
    assert.equal(p.hidden('lbl-mt'), true);
    assert.equal(p.hidden('mt-locked'), false, 'men kunden skal kunne SE hvad hun booker');
    assert.match(p.el('mt-locked').innerHTML, /Smagsprøve/);
    assert.match(p.el('mt-locked').innerHTML, /10 min/);
    assert.deepEqual(p.stepText(),
        ['1 — Vælg dato', '2 — Vælg tid', '3 — Dine oplysninger'],
        'ellers står der "2 — Vælg dato" som det første kunden ser');
});

test('og typen er faktisk valgt — ikke bare skjult', async () => {
    const p = await boot({ meetingTypes: [SMAGNING] });
    assert.equal(p.sandbox.__state.selectedMt?.key, 'smagning');
    assert.equal(p.hidden('step-date'), false, 'kalenderen er åben med det samme');
});

/* ── 4. ?mt= i URL'en ────────────────────────────────────────────────────── */

test('?mt= låser typen selv når der er flere at vælge imellem', async () => {
    const p = await boot({ meetingTypes: [SMAGNING, ANDET], search: '?mt=smagning' });
    assert.equal(p.hidden('mt-grid'), true);
    assert.equal(p.sandbox.__state.selectedMt?.key, 'smagning');
});

test('en ukendt ?mt= er ikke en fejl kunden skal se — siden falder tilbage til valget', async () => {
    const p = await boot({ meetingTypes: [SMAGNING, ANDET], search: '?mt=vroevl' });
    assert.equal(p.hidden('mt-grid'), false);
    assert.equal(p.sandbox.__state.selectedMt, null);
});

/* ── 5. Sælgerens link ───────────────────────────────────────────────────── */

test('token med intent låser typen — sælgeren har allerede valgt', async () => {
    const p = await boot({ meetingTypes: [SMAGNING, ANDET], search: '?t=abc',
                           tokenIntent: { key: 'smagning' } });
    assert.equal(p.hidden('mt-grid'), true);
    assert.equal(p.sandbox.__state.selectedMt?.key, 'smagning');
});

test('token uden intent lader kunden vælge — som de 8 af 9 links i drift', async () => {
    const p = await boot({ meetingTypes: [SMAGNING, ANDET], search: '?t=abc', tokenIntent: null });
    assert.equal(p.hidden('mt-grid'), false, 'uden intent er der intet at låse');
});

test('intent på en type der ikke er bookbar låser ingenting', async () => {
    const p = await boot({ meetingTypes: [SMAGNING, ANDET], search: '?t=abc',
                           tokenIntent: { key: 'gennemgang' } });
    assert.equal(p.hidden('mt-grid'), false);
});

/* ── 6. Udvejen ──────────────────────────────────────────────────────────── */

test('udvejen vises som en linje når kontakt-flowet er tændt', async () => {
    const p = await boot({ meetingTypes: [SMAGNING], kontaktOpen: true });
    assert.equal(p.hidden('contact-alt'), false);
    assert.match(p.el('contact-alt').innerHTML, /href="\/book\/kontakt"/);
});

test('og er tavs når kontakt-flowet er slukket — ellers er linket en blindgyde', async () => {
    const p = await boot({ meetingTypes: [SMAGNING], kontaktOpen: false });
    assert.equal(p.hidden('contact-alt'), true);
});
