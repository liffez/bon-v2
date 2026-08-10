// scripts/test-offer-days.js
// ============================================================
// Integration-test for fler-dags-tilbud (#425).
//
// Spawner en frisk server mod isoleret test-DB i /tmp — prod røres ikke.
// Rammer de ÆGTE endpoints over HTTP, fordi både reconcile-valideringen og
// konverteringen bor i route-handlerne:
//   PUT  /api/quotes/:id/days
//   POST /api/quotes/:id/convert
//   GET  /api/quotes/:id
//
// Den vigtigste test er den FØRSTE: et almindeligt ét-dags-tilbud skal
// konvertere præcis som før. Fler-dags er en tilføjelse, ikke en omlægning.
//
// Kør:
//   node --experimental-sqlite scripts/test-offer-days.js
// ============================================================

const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

const TEST_DB = path.join(os.tmpdir(), `bon-test-offerdays-${Date.now()}.db`);
const PORT = 4337;
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
function assert(cond, msg) {
    if (cond) { console.log('  \x1b[32m✓\x1b[0m', msg); pass++; }
    else      { console.log('  \x1b[31m✗\x1b[0m', msg); fail++; }
}

async function waitForServer(maxMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try { const r = await fetch(BASE + '/api/auth/pin-users'); if (r.status > 0) return true; } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

let _cookies = [];
async function http(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_cookies.length) headers.Cookie = _cookies.join('; ');
    const res = await fetch(BASE + url, {
        method, headers, body: body == null ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) _cookies = [set.split(';')[0]];
    let data = null;
    try { data = await res.json(); } catch {}
    return { status: res.status, data };
}

async function main() {
    process.env.DB_PATH = TEST_DB;
    const { runMigrations } = require('../db/migrate');
    runMigrations(TEST_DB);

    const { openDb } = require('../db/compat');
    const db = openDb(TEST_DB);

    const TEST_PIN = '9999';
    const admin = db.prepare(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`).get();
    if (admin) db.prepare(`UPDATE users SET pin=? WHERE id=?`).run(TEST_PIN, admin.id);
    else db.prepare(`INSERT INTO users (name,email,role,pin,is_active) VALUES ('Test Admin','t@local','admin',?,1)`).run(TEST_PIN);
    db.close();

    let serverProc;
    try {
        serverProc = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, DB_PATH: TEST_DB, PORT: String(PORT), NODE_ENV: 'test' },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        serverProc.stderr.on('data', d => {
            const s = String(d);
            if (/Error|error/.test(s) && !/Experimental/.test(s)) process.stderr.write(s);
        });
        if (!await waitForServer()) throw new Error('Server startede ikke');
        await http('POST', '/api/auth/pin', { pin: TEST_PIN });

        // ── 1. Regression: ét-dags-tilbud konverterer som hidtil ────────────
        console.log('\n— Ét-dags-tilbud: uændret adfærd —');
        let r = await http('POST', '/api/quotes', {
            template: 'single', price_category: 'catering',
            delivery_date: '2026-09-10', delivery_time: '11:00', pax: 20,
            lines: [{ product_name: 'Sandwich', category: '01 Sandwich', quantity: 20, unit_price: 100 }],
        });
        const single = r.data;
        assert(r.status === 201 && single.id, `tilbud oprettet (${single.quote_number})`);

        r = await http('GET', `/api/quotes/${single.id}`);
        assert(Array.isArray(r.data.days) && r.data.days.length === 0, 'uden dage: days er tom liste');

        r = await http('POST', `/api/quotes/${single.id}/convert`);
        assert(r.status === 200, 'convert svarer 200');
        assert(r.data.bon_id === single.id, 'SAMME række flippes — ingen ny bon oprettet');
        assert(!r.data.multi_day, 'ikke markeret som fler-dags');

        let dbx = openDb(TEST_DB);
        const conv = dbx.prepare('SELECT is_offer, offer_status FROM bons WHERE id=?').get(single.id);
        const spawned = dbx.prepare('SELECT COUNT(*) c FROM bons WHERE source_quote_id=?').get(single.id).c;
        dbx.close();
        assert(conv.is_offer === 0 && conv.offer_status === 'won', 'is_offer=0 + won som før');
        assert(spawned === 0, 'ingen afledte bons');

        // ── 2. Validering af dage ──────────────────────────────────────────
        console.log('\n— Dage: validering før der skrives —');
        r = await http('POST', '/api/quotes', {
            template: 'event', price_category: 'catering',
            delivery_date: '2026-10-01', delivery_time: '10:00', pax: 42,
            delivery_price: 800, payment_type: 'invoice',
            kitchen_info: 'Husk kaffe', customer_wishes: 'Ingen nødder',
            lines: [],
        });
        const multi = r.data;
        assert(r.status === 201, `fler-dags-tilbud oprettet (${multi.quote_number})`);

        r = await http('PUT', `/api/quotes/${multi.id}/days`, { days: [{ delivery_date: '1. oktober' }] });
        assert(r.status === 400 && /YYYY-MM-DD/.test(r.data.error), 'ugyldig dato afvises');

        r = await http('PUT', `/api/quotes/${multi.id}/days`, {
            days: [{ delivery_date: '2026-10-01' }, { delivery_date: '2026-10-01' }],
        });
        assert(r.status === 400 && /to gange/.test(r.data.error), 'samme dato to gange afvises');

        r = await http('PUT', `/api/quotes/${multi.id}/days`, {
            days: [{ delivery_date: '2026-10-01', pax: -5 }],
        });
        assert(r.status === 400 && /pax/.test(r.data.error), 'negativ pax afvises');

        dbx = openDb(TEST_DB);
        const afterBad = dbx.prepare('SELECT COUNT(*) c FROM offer_days WHERE bon_id=?').get(multi.id).c;
        dbx.close();
        assert(afterBad === 0, 'intet skrevet efter afviste payloads');

        // ── 3. Dage gemmes, arv er NULL ────────────────────────────────────
        console.log('\n— Dage: gemmes med arv som NULL —');
        r = await http('PUT', `/api/quotes/${multi.id}/days`, { days: [
            { delivery_date: '2026-10-01', label: 'Ankomst' },
            { delivery_date: '2026-10-02', delivery_time: '09:30', pax: 60 },
            { delivery_date: '2026-10-03' },
        ]});
        assert(r.status === 200 && r.data.days.length === 3, 'tre dage gemt');
        const days = r.data.days;
        assert(days[0].delivery_time === null && days[0].pax === null, 'dag 1 arver (NULL i felterne)');
        assert(days[1].delivery_time === '09:30' && days[1].pax === 60, 'dag 2 har egne værdier');
        assert(days[0].label === 'Ankomst', 'label gemt');

        r = await http('GET', `/api/quotes/${multi.id}`);
        assert(r.data.delivery_date === '2026-10-01', 'tilbuddets egen dato følger første dag');

        // ── 4. Linjer: dagsspecifikke + fælles ─────────────────────────────
        console.log('\n— Linjer: dagsspecifikke og fælles —');
        const dayIds = days.map(d => d.id);
        const line = (name, qty, price, dayId) => ({
            product_name: name, category: '01 Sandwich', quantity: qty, unit: 'stk',
            unit_price: price, offer_day_id: dayId ?? null,
        });

        // Tilknytningen sættes gennem PATCH — den vej wizarden bruger. Skrives
        // den i stedet med rå SQL, beviser resten af testen kun at konverteringen
        // fordeler rigtigt, ikke at nogen kan komme til at fordele.
        r = await http('PATCH', `/api/quotes/${multi.id}`, { lines: [
            line('Kaffe', 42, 25, null),             // fælles — alle dage
            line('Sandwich dag 1', 40, 100, dayIds[0]),
            line('Salat dag 2', 60, 90, dayIds[1]),
            line('Kage dag 3', 42, 35, dayIds[2]),
        ]});
        assert(r.status === 200, 'linjer gemt med dag-tilknytning gennem PATCH');

        r = await http('GET', `/api/quotes/${multi.id}`);
        const byName = Object.fromEntries((r.data.lines || []).map(l => [l.product_name, l]));
        assert(byName['Kaffe']?.offer_day_id === null, 'fælles linje kommer retur uden dag');
        assert(byName['Sandwich dag 1']?.offer_day_id === dayIds[0], 'dagslinje kommer retur med sin dag');

        console.log('\n— Dag-tilknytning: ugyldigt payload skriver ikke —');
        r = await http('PATCH', `/api/quotes/${multi.id}`, { lines: [line('Umulig', 1, 10, 999999)] });
        assert(r.status === 400 && /hører ikke til/.test(r.data.error || ''), 'fremmed dag afvises');
        r = await http('GET', `/api/quotes/${multi.id}`);
        assert(r.data.lines.length === 4,
            `de fire linjer står stadig efter afvist payload (fandt ${r.data.lines.length})`);

        dbx = openDb(TEST_DB);
        const quotesBefore = dbx.prepare('SELECT COUNT(*) c FROM bons WHERE is_offer=1').get().c;
        dbx.close();
        r = await http('POST', '/api/quotes', {
            template: 'event', delivery_date: '2026-10-01',
            lines: [line('For tidlig', 1, 10, dayIds[0])],
        });
        assert(r.status === 400 && /gem dagene/.test(r.data.error || ''),
            'dag på oprettelse afvises — tilbuddet har ingen dage endnu');
        dbx = openDb(TEST_DB);
        const quotesAfter = dbx.prepare('SELECT COUNT(*) c FROM bons WHERE is_offer=1').get().c;
        dbx.close();
        assert(quotesAfter === quotesBefore, 'den afviste oprettelse efterlod ikke et tomt tilbud');

        // ── 5. Konvertering: én bon pr. dag ────────────────────────────────
        console.log('\n— Konvertering: én bon pr. dag —');
        r = await http('POST', `/api/quotes/${multi.id}/convert`);
        assert(r.status === 200 && r.data.multi_day === true, 'convert markerer fler-dags');
        assert(r.data.bons.length === 3, `tre bons oprettet (fik ${r.data.bons?.length})`);

        dbx = openDb(TEST_DB);
        const bons = dbx.prepare(`
            SELECT id, bon_number, delivery_date, delivery_time, pax, delivery_price, kitchen_info,
                   customer_wishes, payment_type, price_category, source_quote_id, total_price
              FROM bons WHERE source_quote_id = ? ORDER BY delivery_date
        `).all(multi.id);
        const linesOf = id => dbx.prepare('SELECT product_name, quantity FROM bon_lines WHERE bon_id=? ORDER BY id').all(id);
        const l1 = linesOf(bons[0].id), l2 = linesOf(bons[1].id), l3 = linesOf(bons[2].id);
        const quoteRow = dbx.prepare('SELECT is_offer, offer_status FROM bons WHERE id=?').get(multi.id);
        dbx.close();

        assert(bons.map(b => b.delivery_date).join(',') === '2026-10-01,2026-10-02,2026-10-03',
            'datoerne er dagenes');
        assert(bons.every(b => b.source_quote_id === multi.id), 'alle peger tilbage på tilbuddet');
        assert(quoteRow.is_offer === 1 && quoteRow.offer_status === 'won',
            'tilbuddet BLIVER et tilbud, markeret won');

        console.log('\n— Arv fra tilbuddet —');
        assert(bons[0].delivery_time === '10:00', 'dag 1 arvede tilbuddets tid');
        assert(bons[1].delivery_time === '09:30', 'dag 2 beholdt sin egen tid');
        assert(bons[0].pax === 42 && bons[2].pax === 42, 'dag 1 og 3 arvede pax');
        assert(bons[1].pax === 60, 'dag 2 beholdt sin egen pax');
        assert(bons.every(b => b.customer_wishes === 'Ingen nødder'), 'kundeønsker arvet til alle');
        assert(bons.every(b => b.payment_type === 'invoice'), 'betalingsform arvet');
        assert(/Ankomst/.test(bons[0].kitchen_info || ''), 'dagens label med i køkkeninfo');

        console.log('\n— Leveringspris ganges ikke op —');
        assert(bons[0].delivery_price === 800, 'første dag bærer leveringsprisen');
        assert(bons[1].delivery_price === 0 && bons[2].delivery_price === 0,
            'øvrige dage har 0 — prisen er ikke ganget med tre');

        console.log('\n— Linjefordeling —');
        assert(l1.some(l => l.product_name === 'Sandwich dag 1'), 'dag 1 fik sin egen linje');
        assert(!l1.some(l => l.product_name === 'Salat dag 2'), 'dag 1 fik IKKE dag 2s linje');
        assert(l2.some(l => l.product_name === 'Salat dag 2'), 'dag 2 fik sin egen linje');
        assert(l3.some(l => l.product_name === 'Kage dag 3'), 'dag 3 fik sin egen linje');
        assert([l1, l2, l3].every(l => l.some(x => x.product_name === 'Kaffe')),
            'fælles linje kopieret til ALLE tre dage');
        assert(l1.length === 2 && l2.length === 2 && l3.length === 2,
            'hver dag har præcis sin egen + den fælles');

        console.log('\n— Totaler regnet pr. dag —');
        // dag 1: 40×100 + 42×25 = 5.050 + levering 800 = 5.850
        assert(bons[0].total_price === 5850, `dag 1 total inkl. levering (fik ${bons[0].total_price})`);
        // dag 2: 60×90 + 42×25 = 6.450, ingen levering
        assert(bons[1].total_price === 6450, `dag 2 total (fik ${bons[1].total_price})`);

        console.log('\n— Dobbelt-konvertering afvises —');
        r = await http('POST', `/api/quotes/${multi.id}/convert`);
        assert(r.status === 400, 'allerede konverteret → 400');

        console.log('\n— Listen kan se at det er fler-dags —');
        r = await http('GET', '/api/quotes');
        const listed = (r.data || []).find(q => q.id === multi.id);
        assert(listed?.day_count === 3, `day_count = 3 på listen (fik ${listed?.day_count})`);
        assert(listed?.converted_to_bon === true,
            'et vundet fler-dags-tilbud regnes som konverteret, selvom is_offer stadig er 1');
        assert(!(r.data || []).some(q => q.id === single.id),
            'det konverterede ét-dags-tilbud er væk fra listen — dét flipper is_offer');
        // Et almindeligt tilbud uden dage skal stå med 0, ikke NULL: UI\'et
        // afgør på tallet om der overhovedet skal vises en dags-sektion.
        r = await http('POST', '/api/quotes', { template: 'single', delivery_date: '2026-12-01', lines: [] });
        const plain = r.data;
        r = await http('GET', '/api/quotes');
        assert((r.data || []).find(q => q.id === plain.id)?.day_count === 0,
            'tilbud uden dage har day_count 0');

        console.log('\n— Køkkenet ser dagsbonnerne, ikke bilaget —');
        r = await http('GET', '/api/bons/later?days=120');
        const laterIds = (r.data || []).map(b => b.id);
        assert(!laterIds.includes(multi.id),
            'det vundne fler-dags-tilbud er væk fra Senere — ellers fire kort for tre dages arbejde');
        assert(bons.every(b => laterIds.includes(b.id)), 'alle tre dagsbons er der');

        console.log('\n— EX-moms-linjer bliver ikke til INCL ved kopiering —');
        r = await http('POST', '/api/quotes', {
            template: 'event', delivery_date: '2026-11-02', pax: 10,
            lines: [line('Stadeleje', 1, 4000, null)],
        });
        const exq = r.data;
        r = await http('PUT', `/api/quotes/${exq.id}/days`, { days: [
            { delivery_date: '2026-11-02' }, { delivery_date: '2026-11-03' },
        ]});
        assert(r.status === 200, 'to dage på EX-moms-tilbuddet');
        // Ingen endpoint sætter moms_included — flaget stammer fra event-udgifter
        // (migration 104). Her simuleres en sådan linje; det testede er KOPIEN.
        dbx = openDb(TEST_DB);
        dbx.prepare(`UPDATE bon_lines SET moms_included = 0 WHERE bon_id = ?`).run(exq.id);
        dbx.close();
        r = await http('POST', `/api/quotes/${exq.id}/convert`);
        assert(r.status === 200 && r.data.bons.length === 2, 'konverteret til to dage');
        dbx = openDb(TEST_DB);
        const exLines = dbx.prepare(`
            SELECT bl.moms_included FROM bon_lines bl
              JOIN bons b ON bl.bon_id = b.id
             WHERE b.source_quote_id = ?
        `).all(exq.id);
        dbx.close();
        assert(exLines.length === 2 && exLines.every(l => l.moms_included === 0),
            'begge dage arvede moms_included = 0 — linjen ligger stadig ex moms');

        console.log('\n— Sletning af dag efterlader linjerne som fælles —');
        r = await http('PUT', `/api/quotes/${multi.id}/days`, { days: [
            { id: dayIds[0], delivery_date: '2026-10-01' },
            { id: dayIds[1], delivery_date: '2026-10-02' },
        ]});
        assert(r.status === 200 && r.data.days.length === 2, 'dag 3 slettet');
        dbx = openDb(TEST_DB);
        const orphan = dbx.prepare(
            `SELECT offer_day_id FROM bon_lines WHERE bon_id=? AND product_name='Kage dag 3'`
        ).get(multi.id);
        const kept = dbx.prepare(
            `SELECT offer_day_id FROM bon_lines WHERE bon_id=? AND product_name='Sandwich dag 1'`
        ).get(multi.id);
        dbx.close();
        assert(orphan && orphan.offer_day_id === null, 'linjen fra den slettede dag blev fælles, ikke slettet');
        assert(kept && kept.offer_day_id === dayIds[0], 'de øvrige linjer beholdt deres dag');

    } finally {
        if (serverProc) serverProc.kill();
        try { require('fs').unlinkSync(TEST_DB); } catch {}
        for (const suf of ['-wal', '-shm']) { try { require('fs').unlinkSync(TEST_DB + suf); } catch {} }
    }

    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} pass · ${fail} fail\x1b[0m`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
