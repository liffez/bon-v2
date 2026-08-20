// scripts/test-receipt-schema.js
// ============================================================
// Varemodtagelsens skema hentes fra tavlen — testen låser fast HVAD der sker
// når tavlen ikke svarer som forventet.
//
// Baggrunden: skemaet fandtes to steder. Whiteboard ejer det i
// registration_types.fields; Bon v2 havde en håndskrevet kopi med
// grænseværdier og labels banket ind i JavaScript. En rettelse i admin nåede
// aldrig herover, og ingen fik det at vide.
//
// Det farlige ved at hente det er den modsatte fejl: at varemodtagelsen
// holder op med at virke fordi tavlen er nede. Fødevarekontrol er lovpligtig.
// Derfor handler de fleste tests her om DEGRADERING, ikke om lykkelige svar.
//
// Den vigtigste enkeltcase er #5: tavlen ligger bag en login-gate der svarer
// 302 → en login-side med status 200. Følger vi omdirigeringen, får vi en
// HTML-side og ville tro den var et skema. Præcis dén fælde lod sytten
// varemodtagelser se ud som sendt (whiteboard #21).
//
// Kør:  node --experimental-sqlite scripts/test-receipt-schema.js
// ============================================================

'use strict';

const http = require('http');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const TMP_DB = path.join(os.tmpdir(), `schematest-${process.pid}.db`);
process.env.DB_PATH  = TMP_DB;
process.env.NODE_ENV = 'development';

const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log('  \x1b[32m✓\x1b[0m', m); pass++; } else { console.log('  \x1b[31m✗\x1b[0m', m); fail++; } };

// ── Minimal DB: kun det servicen rører ──
const seed = new DatabaseSync(TMP_DB);
seed.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, description TEXT,
                           updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO settings (key, value) VALUES
      ('whiteboard_webhook_url', ''),
      ('whiteboard_schema_cache', ''),
      ('whiteboard_schema_cache_at', '');
`);
seed.close();

const db = new DatabaseSync(TMP_DB);
require.cache[require.resolve('../db/database')] = {
    id: require.resolve('../db/database'),
    filename: require.resolve('../db/database'),
    loaded: true,
    exports: { getDb: () => db },
};

const schema = require('../services/receiptSchema');

const setUrl    = v => db.prepare(`UPDATE settings SET value=? WHERE key='whiteboard_webhook_url'`).run(v);
const cacheRow  = () => db.prepare(`SELECT value FROM settings WHERE key='whiteboard_schema_cache'`).get()?.value || '';
const clearCache = () => {
    db.prepare(`UPDATE settings SET value='' WHERE key='whiteboard_schema_cache'`).run();
    db.prepare(`UPDATE settings SET value='' WHERE key='whiteboard_schema_cache_at'`).run();
    schema.invalidate();
};

// ── Attrap-tavle ──
let mode = 'ok';
let hits = 0;
let lastSecret = null;

const TAVLE_FIELDS = [
    { id: 'temperature', type: 'number', label: '🧊 Kølevarer', warn_above: 4, action_above: 5,
      default_value: 4.5, optional_toggle: true, unit: '°C' },
    { id: 'temp_product', type: 'text', label: 'Målt på (kølevare)' },
    { id: 'date_ok', type: 'checkbox', label: 'Dato/holdbarhed kontrolleret', required: true },
    { id: 'chauffor', type: 'text', label: 'Chauffør' },   // felt Bon v2 ikke kender
];

const server = http.createServer((req, res) => {
    hits++;
    lastSecret = req.headers['x-webhook-secret'] || null;

    if (mode === 'redirect') {                 // login-gaten
        res.writeHead(302, { Location: 'https://bon.ristetrug.dk/login.html' });
        return res.end();
    }
    if (mode === 'down') { res.writeHead(502); return res.end('bad gateway'); }
    if (mode === 'empty') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ key: 'varemodtagelse', fields: [] }));
    }
    if (mode === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Ugyldig webhook-legitimation' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ key: 'varemodtagelse', name: 'Varemodtagelse', fields: TAVLE_FIELDS }));
});

// Vent på at baggrundsopfriskningen har kørt færdig.
const settle = () => new Promise(r => setTimeout(r, 60));

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const PORT = server.address().port;
    const URL_OK = `http://127.0.0.1:${PORT}/api/events/webhook`;

    console.log('\n\x1b[1m1. Koblingen er slukket\x1b[0m');
    {
        setUrl(''); clearCache();
        delete process.env.GOODS_RECEIPT_WEBHOOK_SECRET;
        hits = 0;
        const r = await schema.getSchemaFresh();
        ok(r.source === 'builtin', `slukket kobling giver det indbyggede skema (fik '${r.source}')`);
        ok(hits === 0, 'der ringes ikke til tavlen når koblingen er slukket');
        ok(Array.isArray(r.fields) && r.fields.length > 0, 'skemaet er brugbart alligevel');
        ok(/slukket/i.test(r.error || ''), 'og det siges hvorfor');
        ok(r.fields.some(f => f.id === 'temp_product'), 'det indbyggede skema har produktfeltet med');
    }

    console.log('\n\x1b[1m2. Hemmeligheden mangler\x1b[0m');
    {
        setUrl(URL_OK); clearCache();
        delete process.env.GOODS_RECEIPT_WEBHOOK_SECRET;
        hits = 0;
        const r = await schema.getSchemaFresh();
        ok(r.source === 'builtin', 'uden hemmelighed bruges det indbyggede skema');
        ok(hits === 0, 'og der ringes slet ikke — vi sender ikke et kald vi ved bliver afvist');
        ok(/GOODS_RECEIPT_WEBHOOK_SECRET/.test(r.error || ''), 'fejlen peger på den manglende hemmelighed');
    }

    process.env.GOODS_RECEIPT_WEBHOOK_SECRET = 'hemmelig-1234';

    console.log('\n\x1b[1m3. Tavlen svarer\x1b[0m');
    {
        setUrl(URL_OK); clearCache(); mode = 'ok'; hits = 0;
        const r = await schema.getSchemaFresh();
        ok(r.source === 'whiteboard', `skemaet kommer fra tavlen (fik '${r.source}')`);
        ok(lastSecret === 'hemmelig-1234', 'hemmeligheden sendes med som X-Webhook-Secret');
        ok(r.fields.some(f => f.id === 'chauffor'), 'et felt tavlen har tilføjet kommer med');

        const temp = r.fields.find(f => f.id === 'temperature');
        ok(temp?.action_above === 5 && temp?.warn_above === 4,
            'grænseværdierne kommer med — hele grunden til at hente skemaet');
        ok(cacheRow().length > 0, 'svaret gemmes i cachen');
        ok(Array.isArray(r.known_field_ids) && r.known_field_ids.includes('temperature'),
            'svaret fortæller frontenden hvilke felter Bon v2 selv håndterer');
    }

    console.log('\n\x1b[1m4. Tavlen går ned bagefter\x1b[0m');
    {
        mode = 'down'; schema.invalidate();
        const r = await schema.getSchemaFresh();
        ok(r.source === 'cache', `så bruges det sidst hentede, ikke det indbyggede (fik '${r.source}')`);
        ok(r.fields.some(f => f.id === 'chauffor'), 'tavlens eget felt er stadig med fra cachen');
        ok(/Kunne ikke hente/.test(r.error || ''), 'men det siges at skemaet ikke er friskt');
    }

    console.log('\n\x1b[1m5. Login-gaten svarer i stedet for tavlen\x1b[0m');
    {
        mode = 'redirect'; clearCache();
        const r = await schema.getSchemaFresh();
        ok(r.source === 'builtin', 'en omdirigering tolkes ikke som et skema');
        ok(/omdirigering|nginx/i.test(r.error || ''),
            'fejlen peger på den manglende nginx-undtagelse — ikke bare "det virkede ikke"');
        ok(cacheRow() === '', 'og en login-side gemmes ikke i cachen');
    }

    console.log('\n\x1b[1m6. Tavlen svarer, men uden felter\x1b[0m');
    {
        mode = 'empty'; clearCache();
        const r = await schema.getSchemaFresh();
        ok(r.source === 'builtin', 'et tomt skema bruges ikke — det ville give en tom formular');
        ok(cacheRow() === '', 'og gemmes ikke');
    }

    console.log('\n\x1b[1m7. Hemmeligheden er forkert\x1b[0m');
    {
        mode = 'unauthorized'; clearCache();
        const r = await schema.getSchemaFresh();
        ok(r.source === 'builtin', '401 falder tilbage frem for at blokere varemodtagelsen');
        ok(/401/.test(r.error || ''), 'og statuskoden nævnes så fejlen kan findes');
    }

    console.log('\n\x1b[1m8. Mange samtidige kald\x1b[0m');
    {
        mode = 'ok'; clearCache(); hits = 0;
        await Promise.all(Array.from({ length: 8 }, () => schema.getSchemaFresh()));
        ok(hits === 1, `otte samtidige kald giver ét kald til tavlen (fik ${hits})`);
    }

    console.log('\n\x1b[1m9. getSchema() venter aldrig på nettet\x1b[0m');
    {
        mode = 'ok'; clearCache(); hits = 0;
        const t0 = Date.now();
        const r = schema.getSchema();
        const ms = Date.now() - t0;
        ok(ms < 50, `svaret kommer med det samme (${ms} ms)`);
        ok(r.fields.length > 0, 'og er brugbart');
        await settle();
        ok(hits === 1, 'skemaet hentes i baggrunden til næste gang');
    }

    console.log('\n\x1b[1m10. Ekstrafelter renses mod skemaet\x1b[0m');
    {
        const fields = TAVLE_FIELDS;
        const S = (o) => JSON.parse(schema.sanitizeExtraFields(o, fields) || 'null');

        ok(S({ chauffor: 'Jens' })?.chauffor === 'Jens', 'et felt fra skemaet gemmes');
        ok(S({ findes_ikke: 'x' }) === null, 'et felt der ikke står i skemaet gemmes ikke');
        ok(S({ temperature: 99 }) === null,
            'et felt Bon v2 har sin egen kolonne til havner ikke her — ellers stod tallet to steder');
        ok(S({ chauffor: '   Jens   ' })?.chauffor === 'Jens', 'værdien trimmes');
        ok(S({ chauffor: '' }) === null, 'tom værdi gemmes ikke');
        ok(S({ chauffor: 'x'.repeat(900) })?.chauffor.length === 500, 'lange værdier klippes');
        ok(S({ chauffor: { ondt: true } }) === null, 'objekter afvises — feltsvar er flade');
        ok(schema.sanitizeExtraFields(null, fields) === null, 'intet input giver null');
        ok(schema.sanitizeExtraFields(['a'], fields) === null, 'et array er ikke et feltsvar');
        ok(schema.sanitizeExtraFields({ chauffor: 'Jens' }, []) === null,
            'et tomt skema tillader intet');
    }

    server.close();
    db.close();
    try { fs.unlinkSync(TMP_DB); } catch {}

    console.log(`\n${pass} PASS · ${fail} FAIL\n`);
    process.exit(fail ? 1 : 0);
})();
