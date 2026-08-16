// tests/quote_convert.test.js
// ============================================================
// Konvertering af tilbud → bon.
//
// Kernepåstanden: et vundet tilbud skal stadig kunne findes bagefter. Før
// migration 146 flippede ét-dags-konvertering `is_offer` på tilbuddets egen
// række, og så holdt tilbuddet op med at eksistere i samme øjeblik det blev
// vundet — hverken tilbudslisten, "Vundet"-filteret eller CRM-pipelinen kunne
// vise det. Testene her holder øje med at det ikke sker igen.
//
// Skemaet bygges af de RIGTIGE migrations i en :memory:-database, så en
// kolonne der flytter sig får testen til at fejle i stedet for at bestå mod en
// håndskrevet kopi af skemaet.
//
// Kør: node --experimental-sqlite --test tests/quote_convert.test.js
// ============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbModule = require('../db/database');
let _testDb = null;
dbModule.getDb = () => _testDb;

const sseModule = require('../shared/sse');
sseModule.broadcast = () => {};

const MIGRATIONS = path.join(__dirname, '..', 'db', 'migrations');

function createFreshDb() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const f of fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    }
    // Bruger 1 seedes allerede af migrations (admin) — changelog kræver blot at
    // FK'en peger på nogen der findes.
    db.prepare('INSERT INTO companies (id, name) VALUES (?,?)').run(1, 'KU Science');
    db.prepare('INSERT INTO customers (id, first_name, last_name, company_id) VALUES (?,?,?,?)')
      .run(1, 'Anne', 'Andersen', 1);
    return db;
}

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = { userId: 1, user: { id: 1 } }; next(); });
app.use('/api/quotes', require('../routes/quotes'));
app.use('/api/crm', require('../routes/crm'));

let server, baseUrl;
test.before(() => new Promise(r => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); });
}));
test.after(() => new Promise(r => server.close(r)));
test.beforeEach(() => { _testDb = createFreshDb(); });

async function call(method, p, body) {
    const r = await fetch(`${baseUrl}${p}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
}
const get   = (p)       => call('GET', p);
const post  = (p, b)    => call('POST', p, b);
const patch = (p, b)    => call('PATCH', p, b);
const put   = (p, b)    => call('PUT', p, b);

async function createQuote(extra = {}) {
    const r = await post('/api/quotes', {
        customer_id: 1, company_id: 1,
        delivery_date: '2026-10-02', delivery_time: '11:00',
        pax: 200, delivery_price: 500,
        lines: [
            { product_name: 'Sandwich', quantity: 200, unit_price: 85, category: 'Frokost' },
            { product_name: 'Kaffe',    quantity: 200, unit_price: 15, category: 'Drikke' },
        ],
        ...extra,
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body;
}

// ── Ét dag: den sag der forsvandt ────────────────────────────────────────

test('ét-dags-konvertering opretter en NY bon og lader tilbuddet blive', async () => {
    const q = await createQuote();
    const r = await post(`/api/quotes/${q.id}/convert`);

    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.bons.length, 1);
    assert.notStrictEqual(r.body.bon_id, q.id, 'bonnen skal være en ny række, ikke tilbuddet selv');

    const quote = _testDb.prepare('SELECT * FROM bons WHERE id = ?').get(q.id);
    assert.strictEqual(quote.is_offer, 1, 'tilbuddet er stadig et tilbud');
    assert.strictEqual(quote.offer_status, 'won');
    assert.ok(quote.offer_locked_at, 'bilaget låses ved konvertering');

    const bon = _testDb.prepare('SELECT * FROM bons WHERE id = ?').get(r.body.bon_id);
    assert.strictEqual(bon.is_offer, 0);
    assert.strictEqual(bon.source_quote_id, q.id, 'bonnen peger tilbage på bilaget');
    assert.notStrictEqual(bon.bon_number, quote.bon_number, 'bonnen får sit eget nummer, ikke T-nummeret');
    assert.ok(quote.bon_number.startsWith('T-'));
});

test('det konverterede tilbud kan findes under Vundet', async () => {
    const q = await createQuote();
    await post(`/api/quotes/${q.id}/convert`);

    const won = await get('/api/quotes?status=won');
    assert.strictEqual(won.body.length, 1, 'præcis den sag man lige har vundet');
    assert.strictEqual(won.body[0].id, q.id);
    assert.strictEqual(won.body[0].locked, true);
    assert.strictEqual(won.body[0].converted_to_bon, true);
    assert.ok(won.body[0].bon_numbers, 'listen skal kunne sige hvor sagen blev af');
});

test('det konverterede tilbud står i CRM-pipelinens Vundet-kolonne', async () => {
    const q = await createQuote();
    await post(`/api/quotes/${q.id}/convert`);

    const pipe = await get('/api/crm/pipeline');
    const ids = pipe.body.vundet.items.map(i => i.id);
    assert.ok(ids.includes(q.id), 'tilbuddet må ikke falde ud af tavlen når det vindes');
});

test('linjer og priser følger med over på bonnen', async () => {
    const q = await createQuote();
    const r = await post(`/api/quotes/${q.id}/convert`);

    const lines = _testDb.prepare('SELECT * FROM bon_lines WHERE bon_id = ? ORDER BY sort_order').all(r.body.bon_id);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].product_name, 'Sandwich');
    assert.strictEqual(lines[0].quantity, 200);

    // Tilbuddet beholder sine egne linjer — bilaget tømmes ikke.
    const quoteLines = _testDb.prepare('SELECT COUNT(*) c FROM bon_lines WHERE bon_id = ?').get(q.id);
    assert.strictEqual(quoteLines.c, 2);

    const bon = _testDb.prepare('SELECT total_price FROM bons WHERE id = ?').get(r.body.bon_id);
    assert.strictEqual(bon.total_price, 200 * 85 + 200 * 15 + 500);
});

test('menu-grupper genskabes på bonnen med egne id’er', async () => {
    const q = await createQuote();
    const g = _testDb.prepare('INSERT INTO bon_menu_groups (bon_id, title, sort_order) VALUES (?,?,?)').run(q.id, 'Frokost', 0);
    _testDb.prepare('UPDATE bon_lines SET menu_group_id = ? WHERE bon_id = ? AND product_name = ?')
           .run(Number(g.lastInsertRowid), q.id, 'Sandwich');

    const r = await post(`/api/quotes/${q.id}/convert`);

    const groups = _testDb.prepare('SELECT * FROM bon_menu_groups WHERE bon_id = ?').all(r.body.bon_id);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].title, 'Frokost');

    const line = _testDb.prepare('SELECT menu_group_id FROM bon_lines WHERE bon_id = ? AND product_name = ?')
                        .get(r.body.bon_id, 'Sandwich');
    assert.strictEqual(line.menu_group_id, groups[0].id, 'linjen skal pege på BONNENS gruppe, ikke tilbuddets');
});

test('samme tilbud kan ikke konverteres to gange', async () => {
    const q = await createQuote();
    await post(`/api/quotes/${q.id}/convert`);
    const again = await post(`/api/quotes/${q.id}/convert`);

    assert.strictEqual(again.status, 400);
    assert.match(again.body.error, /allerede/);
    const count = _testDb.prepare('SELECT COUNT(*) c FROM bons WHERE source_quote_id = ?').get(q.id);
    assert.strictEqual(count.c, 1);
});

// ── Låsen ────────────────────────────────────────────────────────────────

test('et låst tilbud kan ikke rettes — men kan låses op', async () => {
    const q = await createQuote();
    await post(`/api/quotes/${q.id}/convert`);

    const blocked = await patch(`/api/quotes/${q.id}`, { pax: 999 });
    assert.strictEqual(blocked.status, 409);
    assert.strictEqual(blocked.body.locked, true);
    assert.strictEqual(_testDb.prepare('SELECT pax FROM bons WHERE id = ?').get(q.id).pax, 200);

    const days = await put(`/api/quotes/${q.id}/days`, { days: [{ delivery_date: '2026-10-03' }] });
    assert.strictEqual(days.status, 409);

    const status = await patch(`/api/quotes/${q.id}/status`, { status: 'lost' });
    assert.strictEqual(status.status, 409);

    const unlocked = await post(`/api/quotes/${q.id}/unlock`);
    assert.strictEqual(unlocked.status, 200);
    assert.strictEqual(unlocked.body.locked, false);

    const ok = await patch(`/api/quotes/${q.id}`, { pax: 999 });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(_testDb.prepare('SELECT pax FROM bons WHERE id = ?').get(q.id).pax, 999);
});

test('oplåsning og genlåsning står i changelog', async () => {
    const q = await createQuote();
    await post(`/api/quotes/${q.id}/convert`);
    await post(`/api/quotes/${q.id}/unlock`);
    await post(`/api/quotes/${q.id}/lock`);

    const rows = _testDb.prepare(
        `SELECT notes FROM changelog WHERE entity_id = ? AND field_name = 'offer_locked_at' ORDER BY id`
    ).all(q.id);
    assert.strictEqual(rows.length, 2);
    assert.match(rows[0].notes, /låst op/);
});

// ── Flere dage: uændret adfærd ───────────────────────────────────────────

test('fler-dags-tilbud giver stadig én bon pr. dag', async () => {
    const q = await createQuote();
    const days = await put(`/api/quotes/${q.id}/days`, {
        days: [
            { delivery_date: '2026-10-02', pax: 200 },
            { delivery_date: '2026-10-03', pax: 150 },
        ],
    });
    assert.strictEqual(days.status, 200);

    const r = await post(`/api/quotes/${q.id}/convert`);
    assert.strictEqual(r.body.multi_day, true);
    assert.strictEqual(r.body.bons.length, 2);

    const bons = _testDb.prepare('SELECT delivery_date, pax, delivery_price FROM bons WHERE source_quote_id = ? ORDER BY delivery_date').all(q.id);
    assert.deepStrictEqual(bons.map(b => b.delivery_date), ['2026-10-02', '2026-10-03']);
    assert.deepStrictEqual(bons.map(b => b.pax), [200, 150]);
    // Leveringsprisen hører til én kørsel og må ikke ganges op med antal dage.
    assert.deepStrictEqual(bons.map(b => b.delivery_price), [500, 0]);

    const quote = _testDb.prepare('SELECT is_offer, offer_status FROM bons WHERE id = ?').get(q.id);
    assert.strictEqual(quote.is_offer, 1);
    assert.strictEqual(quote.offer_status, 'won');
});

test('ét dag i offer_days behandles som ét-dags og bruger dagens værdier', async () => {
    const q = await createQuote();
    await put(`/api/quotes/${q.id}/days`, { days: [{ delivery_date: '2026-11-11', pax: 42 }] });

    const r = await post(`/api/quotes/${q.id}/convert`);
    assert.strictEqual(r.body.bons.length, 1);

    const bon = _testDb.prepare('SELECT delivery_date, pax FROM bons WHERE id = ?').get(r.body.bon_id);
    assert.strictEqual(bon.delivery_date, '2026-11-11');
    assert.strictEqual(bon.pax, 42, 'dagens eget pax skal vinde over tilbuddets');
});
