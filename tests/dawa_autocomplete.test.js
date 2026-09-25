// tests/dawa_autocomplete.test.js
// ==========================================================================
// Adresseforslag gennem vores egen server.
//
// Danner (sep. 2026) kunne ikke bestille: deres firewall blokerede
// api.dataforsyningen.dk, så adresselisten kom aldrig frem i bestillings-
// formularen, og formularen godkendte kun en adresse valgt fra listen.
// Opslaget går nu gennem GET /embed/adresse/soeg, og reglen (København
// først, præcist husnummer først) findes ét sted: services/addressSearch.js.
//
//   §1 Reglen (rene funktioner)
//   §2 Forespørgslerne mod DAWA (fetch-attrap)
//   §3 Ruten over HTTP — cache, grænse pr. IP, 502 når DAWA er nede
//   §4 Klienterne: office (utils.js), bestillingssiden og smagsprøven taler
//      kun med vores server — ikke med dataforsyningen.dk
//   §5 Bestillingssidens nødudgang: en adresse skrevet i hånden
//   §6 ... og at den lander på bonen som "ikke verificeret"
//
// Kør: npm run test:dawa
// ==========================================================================

require('../scripts/helpers/isolated_db');

const test   = require('node:test');
const assert = require('node:assert');
const vm     = require('node:vm');
const fs     = require('node:fs');
const path   = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const A = require('../services/addressSearch');

const ids = list => Array.prototype.slice.call(list).map(x => x.adresse.id);

function item(id, postnr, tekst, extra = {}) {
    return { tekst, adresse: { id, postnr: String(postnr), postnrnavn: 'By', vejnavn: 'Vej', husnr: '1', etage: null, ...extra } };
}

/** fetch-attrap: `plan.local` / `plan.global` er et array, en Error eller 'http500'. */
function makeFetch(plan, calls) {
    return async function(url) {
        calls.push(url);
        const body = url.includes('kommunekode=') ? plan.local : plan.global;
        if (body instanceof Error) throw body;
        if (body === 'http500') return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body };
    };
}

/* ──────────────────────────────────────────────────────────────
   §1 Reglen
   ────────────────────────────────────────────────────────────── */

test('lokale hits først, hver blok sorteret efter postnr', () => {
    const local  = [item('a', 2400, 'A'), item('b', 1360, 'B')];
    const global = [item('c', 8800, 'C'), item('d', 3250, 'D'), item('e', 6000, 'E')];
    assert.deepStrictEqual(ids(A.mergeSuggestions(local, global, 10)), ['b', 'a', 'd', 'e', 'c']);
});

test('dubletter vises kun én gang — og beholder den lokale plads', () => {
    const kbh = item('x', 1620, 'Kbh');
    assert.deepStrictEqual(ids(A.mergeSuggestions([kbh], [item('c', 8800, 'V'), kbh], 10)), ['x', 'c']);
});

test('limit klipper efter fletningen — lokale fortrænger globale', () => {
    const local  = [1, 2, 3].map(i => item('l' + i, 2000 + i, 'L'));
    const global = [1, 2, 3].map(i => item('g' + i, 8000 + i, 'G'));
    assert.deepStrictEqual(ids(A.mergeSuggestions(local, global, 4)), ['l1', 'l2', 'l3', 'g1']);
});

test('ukendt postnr sidst; samme postnr beholder DAWA\'s rækkefølge', () => {
    const list = [item('a', 2400, 'A'), item('b', '', 'B'), item('c', 2400, 'C'), item('d', 1000, 'D')];
    assert.deepStrictEqual(ids(A.sortByPostnr(list)), ['d', 'a', 'c', 'b']);
});

test('item uden id og uden tekst springes over — ingen crash', () => {
    assert.deepStrictEqual(ids(A.mergeSuggestions([{ tekst: '', adresse: {} }], [item('c', 8800, 'V')], 5)), ['c']);
});

test('husnummeret læses efter gadenavnet — et postnummer alene er ikke et husnummer', () => {
    assert.equal(A.houseNumberOf('Nansensgade 1'), '1');
    assert.equal(A.houseNumberOf('Nansensgade 1, 1366 København K'), '1');
    assert.equal(A.houseNumberOf('Vesterbrogade 5A'), '5a');
    assert.equal(A.houseNumberOf('nan'), null);
    assert.equal(A.houseNumberOf('2200'), null);
    assert.equal(A.houseNumberOf('Nansensgade'), null);
});

test('"Nansensgade 1": nr. 1 står først, også når DAWA lægger 10, 12, 14 foran', () => {
    // Præcis det DAWA svarede i drift: prefix-match på husnummeret gav
    // 10, 12, 14 … og nr. 1 lå på plads 11, uden for listen.
    const n = (id, husnr, etage) => item(id, 1366, `Nansensgade ${husnr}${etage ? ', ' + etage : ''}`, { husnr, etage });
    const local = [n('10-1', '10', '1.'), n('12-1', '12', '1.'), n('14-1', '14', '1.'),
                   n('1-1', '1', '1.'), n('1', '1', null), n('16-1', '16', '1.')];
    const out = ids(A.mergeSuggestions(local, [], 10, A.houseNumberOf('Nansensgade 1')));
    assert.deepStrictEqual(out.slice(0, 2), ['1', '1-1'], 'gadedøren først, så etagerne på samme nummer');
    assert.deepStrictEqual(out.slice(2), ['10-1', '12-1', '14-1', '16-1'], 'resten i DAWA\'s rækkefølge');
});

test('uden husnummer i søgningen er rækkefølgen uændret', () => {
    const local = [item('a', 1366, 'A', { husnr: '10' }), item('b', 1366, 'B', { husnr: '1' })];
    assert.deepStrictEqual(ids(A.mergeSuggestions(local, [], 10, null)), ['a', 'b']);
});

test('limit klampes: 0/vrøvl → 10, over 20 → 20', () => {
    assert.equal(A.clampLimit(undefined), 10);
    assert.equal(A.clampLimit('x'), 10);
    assert.equal(A.clampLimit(0), 10);
    assert.equal(A.clampLimit('7'), 7);
    assert.equal(A.clampLimit(500), 20);
});

/* ──────────────────────────────────────────────────────────────
   §2 Forespørgslerne mod DAWA
   ────────────────────────────────────────────────────────────── */

test('to forespørgsler: lokal med kommunekode (aldrig fuzzy), global fuzzy når bedt', async () => {
    const calls = [];
    const out = await A.searchAddresses('Vesterbrogade', {
        fuzzy: true, limit: 7,
        fetch: makeFetch({ local: [item('x', 1620, 'Kbh')], global: [item('c', 8800, 'Viborg')] }, calls),
    });
    assert.equal(calls.length, 2);
    const local = calls.find(u => u.includes('kommunekode='));
    const global = calls.find(u => !u.includes('kommunekode='));
    assert.ok(local.includes('kommunekode=0101|0147'), local);
    assert.ok(!local.includes('fuzzy'), 'fuzzy + filter giver 0 hits hos DAWA');
    assert.ok(global.includes('fuzzy=true'));
    assert.ok(local.includes('per_side=7') && global.includes('per_side=7'));
    assert.deepStrictEqual(ids(out), ['x', 'c']);
});

test('med husnummer hentes 50, så det præcise nummer kan findes — men der returneres stadig limit', async () => {
    const calls = [];
    const many = Array.from({ length: 30 }, (_, i) => item('n' + i, 1366, 'N', { husnr: String(i + 10) }));
    const out = await A.searchAddresses('Nansensgade 1', { limit: 10, fetch: makeFetch({ local: many, global: [] }, calls) });
    assert.ok(calls.every(u => u.includes('per_side=50')), calls.join('\n'));
    assert.equal(out.length, 10);
});

test('uden fuzzy-option er ingen af forespørgslerne fuzzy', async () => {
    const calls = [];
    await A.searchAddresses('Vester', { fetch: makeFetch({ local: [], global: [] }, calls) });
    assert.ok(calls.every(u => !u.includes('fuzzy')));
});

test('fejler den lokale, vises den globale alene', async () => {
    const out = await A.searchAddresses('Vester', { fetch: makeFetch({ local: new Error('net'), global: [item('c', 8800, 'V'), item('d', 3250, 'G')] }, []) });
    assert.deepStrictEqual(ids(out), ['d', 'c']);
});

test('lokal HTTP 500 behandles som tom', async () => {
    const out = await A.searchAddresses('Vester', { fetch: makeFetch({ local: 'http500', global: [item('c', 8800, 'V')] }, []) });
    assert.deepStrictEqual(ids(out), ['c']);
});

test('fejler den globale, kastes — kalderen skal kunne se at opslaget ikke svarede', async () => {
    await assert.rejects(
        A.searchAddresses('Vester', { fetch: makeFetch({ local: [item('x', 1620, 'K')], global: new Error('net') }, []) }),
        /net/);
});

test('svar der ikke er et array giver tom liste', async () => {
    const out = await A.searchAddresses('Vester', { fetch: makeFetch({ local: { type: 'QueryParameterFormatError' }, global: [] }, []) });
    assert.deepStrictEqual(ids(out), []);
});

/* ──────────────────────────────────────────────────────────────
   §3 Ruten over HTTP
   ────────────────────────────────────────────────────────────── */

const express = require('express');
const dbModule = require('../db/database');
let _db = null;
dbModule.getDb = () => _db;

const realFetch = global.fetch;
let dawaPlan = null;
const dawaCalls = [];
function installFakeDawa() {
    global.fetch = async (url, opts) => {
        const u = String(url);
        if (u.startsWith('https://api.dataforsyningen.dk') || u.startsWith('https://router.project-osrm.org')) {
            dawaCalls.push(u);
            if (u.includes('project-osrm')) {
                if (dawaPlan.osrm instanceof Error) throw dawaPlan.osrm;
                return { ok: true, status: 200, json: async () => dawaPlan.osrm };
            }
            return makeFetch(dawaPlan, [])(u);
        }
        return realFetch(url, opts);
    };
}

const addressRouter = require('../routes/address');
const app = express();
app.set('trust proxy', true);
app.use('/embed/adresse', addressRouter);
let server, base;

function freshDb(withBase = true) {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
    if (withBase) {
        db.prepare("INSERT INTO settings VALUES ('bestilling.base_lat','55.68'),('bestilling.base_lon','12.56')").run();
    }
    return db;
}

test.before(() => new Promise(r => {
    installFakeDawa();
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => { global.fetch = realFetch; server.close(r); }));

function reset(plan) {
    addressRouter._reset();
    dawaCalls.length = 0;
    dawaPlan = plan;
    _db = freshDb();
}
const get = (p, ip = '10.0.0.1') => realFetch(base + p, { headers: { 'X-Forwarded-For': ip } });

test('GET /soeg svarer med forslag i DAWA\'s form', async () => {
    reset({ local: [item('x', 1366, 'Nansensgade 1, 1366 København K')], global: [] });
    const r = await get('/embed/adresse/soeg?q=Nansensgade&fuzzy=1');
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d[0].tekst, 'Nansensgade 1, 1366 København K');
    assert.ok(dawaCalls.some(u => u.includes('fuzzy=true')), 'fuzzy=1 bæres videre');
});

test('GET /soeg med under 2 tegn spørger ikke DAWA', async () => {
    reset({ local: [], global: [] });
    const r = await get('/embed/adresse/soeg?q=N');
    assert.deepStrictEqual(await r.json(), []);
    assert.equal(dawaCalls.length, 0);
});

test('GET /soeg: samme søgning to gange rammer DAWA én gang (cache)', async () => {
    reset({ local: [item('x', 1366, 'X')], global: [] });
    await get('/embed/adresse/soeg?q=Nansensgade');
    const before = dawaCalls.length;
    const r = await get('/embed/adresse/soeg?q=nansensgade');
    assert.equal(r.status, 200);
    assert.equal(dawaCalls.length, before, 'andet opslag fra cache');
});

test('GET /soeg: DAWA nede → 502, ikke en tom liste', async () => {
    reset({ local: new Error('net'), global: new Error('net') });
    const r = await get('/embed/adresse/soeg?q=Nansensgade');
    assert.equal(r.status, 502, 'klienten skal kunne skelne "ingen adresser" fra "opslaget svarer ikke"');
});

test('GET /soeg: grænse pr. IP — og en anden IP er upåvirket', async () => {
    reset({ local: [], global: [] });
    let last;
    for (let i = 0; i < 121; i++) last = await get('/embed/adresse/soeg?q=Vej' + i, '10.9.9.9');
    assert.equal(last.status, 429);
    const other = await get('/embed/adresse/soeg?q=Vej', '10.8.8.8');
    assert.equal(other.status, 200);
});

test('GET /afstand regner fra husets udgangspunkt, i km med én decimal', async () => {
    reset({ local: [], global: [], osrm: { routes: [{ distance: 3456 }] } });
    const r = await get('/embed/adresse/afstand?lat=55.68&lon=12.57');
    assert.equal(r.status, 200);
    assert.deepStrictEqual(await r.json(), { km: 3.5 });
    assert.ok(dawaCalls[0].includes('/12.56,55.68;12.57,55.68'), 'fra bestilling.base_* — ikke et startpunkt fra klienten');
});

test('GET /afstand: ugyldige koordinater → 400; intet udgangspunkt → 503; OSRM nede → 502', async () => {
    reset({ osrm: { routes: [] } });
    assert.equal((await get('/embed/adresse/afstand?lat=x&lon=1')).status, 400);
    assert.equal((await get('/embed/adresse/afstand?lat=99&lon=1')).status, 400);
    _db = freshDb(false);
    assert.equal((await get('/embed/adresse/afstand?lat=55.6&lon=12.5')).status, 503);
    reset({ osrm: new Error('net') });
    assert.equal((await get('/embed/adresse/afstand?lat=55.6&lon=12.5')).status, 502);
});

/* ──────────────────────────────────────────────────────────────
   §4 Klienterne taler kun med vores server
   ────────────────────────────────────────────────────────────── */

function loadUtils() {
    const src = fs.readFileSync(path.join(ROOT, 'shared', 'utils.js'), 'utf8');
    const sandbox = {
        console, setTimeout, clearTimeout, Promise, Error, JSON, Object, Array, String,
        Number, Boolean, Date, Math, RegExp, parseInt, isNaN, encodeURIComponent,
        document: { addEventListener() {}, body: {} }, location: { href: '' },
        navigator: {}, localStorage: { getItem() { return null; }, setItem() {} },
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'utils.js' });
    return sandbox;
}

test('office: dawaAutocomplete spørger /embed/adresse/soeg med limit og fuzzy', async () => {
    const U = loadUtils();
    const calls = [];
    const out = await U.dawaAutocomplete('Vesterbrogade 10', {
        fuzzy: true, limit: 7,
        fetch: async (url) => { calls.push(url); return { ok: true, json: async () => [item('x', 1620, 'K')] }; },
    });
    assert.deepStrictEqual(calls, ['/embed/adresse/soeg?q=Vesterbrogade%2010&limit=7&fuzzy=1']);
    assert.deepStrictEqual(ids(out), ['x']);
});

test('office: dawaAutocomplete kaster når opslaget svarer 502', async () => {
    const U = loadUtils();
    await assert.rejects(U.dawaAutocomplete('Vester', { fetch: async () => ({ ok: false, status: 502, json: async () => ({}) }) }), /502/);
});

for (const rel of ['public/embed/bestilling.html', 'booking/smagning.html', 'shared/utils.js']) {
    test(rel + ' taler ikke direkte med dataforsyningen.dk eller OSRM', () => {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        // Kun kode — kommentarer må gerne nævne domænet.
        const code = src.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
        assert.ok(!/https:\/\/api\.dataforsyningen\.dk/.test(code), 'direkte kald til dataforsyningen.dk');
        assert.ok(!/router\.project-osrm\.org/.test(code), 'direkte kald til OSRM');
        if (rel.endsWith('.html')) assert.ok(src.includes('/embed/adresse/soeg'), 'bruger vores rute');
    });
}

/* ──────────────────────────────────────────────────────────────
   §5 Bestillingssidens nødudgang
   ────────────────────────────────────────────────────────────── */

function loadUnverified(value) {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'embed', 'bestilling.html'), 'utf8');
    const m = html.match(/function unverifiedAddress\(\) \{[\s\S]*?\n\}\n/);
    assert.ok(m, 'unverifiedAddress findes i bestilling.html');
    const ctx = { addrInput: { value } };
    vm.createContext(ctx);
    return vm.runInContext(m[0] + ';unverifiedAddress()', ctx);
}

test('en hel adresse skrevet i hånden accepteres — med postnr og by', () => {
    const a = loadUnverified('Nansensgade 1, 1366 København K');
    assert.equal(a.tekst, 'Nansensgade 1, 1366 København K');
    assert.equal(a.postnr, '1366');
    assert.equal(a.by, 'København K');
    assert.equal(a.unverified, true);
    assert.equal(a.lat, null);
});

test('postnummeret er det sidste firecifrede tal — ikke et husnummer, og en etage bagefter forstyrrer ikke', () => {
    assert.equal(loadUnverified('Vesterbrogade 1000, 1620 København V').postnr, '1620');
    assert.equal(loadUnverified('Nansensgade 1, 1366 København K, 2. sal').postnr, '1366');
    assert.equal(loadUnverified('Nansensgade 1 1366').postnr, '1366');
});

test('det der ikke ligner en adresse afvises: uden postnr, uden gade, uden nummer', () => {
    assert.equal(loadUnverified('Nansensgade 1'), null);
    assert.equal(loadUnverified('Nansensgade'), null);
    assert.equal(loadUnverified('1366 København K'), null);
    assert.equal(loadUnverified(''), null);
});

test('formularen åbner kun nødudgangen når opslaget faktisk har fejlet', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'embed', 'bestilling.html'), 'utf8');
    assert.match(html, /!validatedAddress\?\.id && !\(addrLookupDown && unverifiedAddress\(\)\)/,
        'validering: en valgt adresse, ELLER opslaget er nede og teksten ligner en adresse');
    assert.match(html, /catch \{[\s\S]{0,80}addrLookupDown = true;/, 'fejl i søgningen åbner nødudgangen');
});

/* ──────────────────────────────────────────────────────────────
   §6 ... og en ikke-verificeret adresse lander på bonen med en note
   ────────────────────────────────────────────────────────────── */

test('web-bestilling med ikke-verificeret adresse: adressen gemmes, og kontoret får besked', async () => {
    const sse = require('../shared/sse'); sse.broadcast = () => {};
    const mail = require('../services/mailService'); mail.sendFromTemplate = async () => ({ ok: true });
    const geocode = require('../services/geocode');
    const geocoded = [];
    geocode.geocodeAddress = async (id) => { geocoded.push(id); };
    const { offsetISO } = require('../db/helpers');

    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const dir = path.join(ROOT, 'db', 'migrations');
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    db.prepare("UPDATE settings SET value='' WHERE key='webhook_secret'").run();
    _db = db;

    const wapp = express();
    wapp.use(express.json());
    wapp.use('/webhook', require('../routes/web-orders'));
    const s = await new Promise(r => { const x = wapp.listen(0, () => r(x)); });
    try {
        const res = await realFetch(`http://127.0.0.1:${s.address().port}/webhook/bestilling`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                first_name: 'Janet', last_name: 'Ravn', email: 'jar@example.dk', phone: '30788290',
                delivery_date: offsetISO(30), delivery_time: '11:30', ordertype: 'catering', pax: '10',
                validatedAddress: { tekst: 'Nansensgade 1, 1366 København K', postnr: '1366', by: 'København K', lat: null, lon: null, unverified: true },
            }),
        });
        assert.equal(res.status, 200);
        const bon = db.prepare('SELECT * FROM bons ORDER BY id DESC LIMIT 1').get();
        const addr = db.prepare('SELECT * FROM addresses WHERE id = ?').get(bon.delivery_address_id);
        assert.equal(addr.street_name, 'Nansensgade');
        assert.equal(addr.street_nr, '1');
        assert.equal(addr.postal_code, '1366');
        assert.equal(addr.city, 'København K');
        assert.match(bon.internal_notes || '', /ikke verificeret/);
        await new Promise(r => setImmediate(r));
        assert.deepStrictEqual(geocoded, [addr.id], 'geokodningen prøver bagefter');

        // Kontrolprøve: en valgt adresse får ingen note.
        await realFetch(`http://127.0.0.1:${s.address().port}/webhook/bestilling`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                first_name: 'Janet', last_name: 'Ravn', email: 'jar@example.dk', phone: '30788290',
                delivery_date: offsetISO(30), delivery_time: '11:30', ordertype: 'catering', pax: '10',
                validatedAddress: { id: 'abc', tekst: 'Nansensgade 1, 1366 København K', postnr: '1366', by: 'København K', lat: 55.68, lon: 12.56 },
            }),
        });
        const bon2 = db.prepare('SELECT * FROM bons ORDER BY id DESC LIMIT 1').get();
        assert.ok(!/ikke verificeret/.test(bon2.internal_notes || ''));
    } finally {
        await new Promise(r => s.close(r));
    }
});
