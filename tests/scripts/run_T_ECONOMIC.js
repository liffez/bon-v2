#!/usr/bin/env node
'use strict';
/**
 * tests/scripts/run_T_ECONOMIC.js
 * ════════════════════════════════════════════════════════════
 * Hermetisk integrationstest for e-conomic Spor 2 ENDPOINTS (routes/invoices.js):
 *   - GET  /api/invoices/:bonId/economic-preview   (dry-run)
 *   - GET  /api/invoices/economic-readiness        (pre-flight)
 *   - POST /api/invoices/:bonId/economic-draft     (opret udkast)
 *
 * In-process: temp-DB via DB_PATH, e-conomic + Grocy STUBBET (ingen netværk),
 * routeren monteret i en mini-express-app med fake-auth. Payload-builderens rene
 * logik dækkes separat af scripts/test-economic-invoice.js (34 tests).
 *
 * Kør: node --experimental-sqlite tests/scripts/run_T_ECONOMIC.js
 * Spec: tests/specs/T_ECONOMIC.md
 * ════════════════════════════════════════════════════════════
 */
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// ── env FØR moduler loades ──────────────────────────────────
const TMP_DB = path.join(os.tmpdir(), `t_economic_${process.pid}.db`);
process.env.DB_PATH = TMP_DB;
process.env.ECONOMIC_APP_SECRET = 'test-secret';        // isConfigured() → true
process.env.ECONOMIC_AGREEMENT_GRANT = 'test-grant';

// ── stub e-conomic + Grocy (samme cachede modul-objekter som routeren bruger) ──
const eco = require('../../services/economicAdapter');
const grocyAdapter = require('../../services/grocyAdapter');

let PRODUCT_MAP = new Map([[100, '65'], [101, '77']]);     // recipe_id → varenr
grocyAdapter.getEconomicProductMap = async () => PRODUCT_MAP;

let draftSeq = 5000, lastPostBody = null;
eco.isConfigured = () => true;
eco.rest = async (p, opts = {}) => {
    if (opts.method === 'POST' && p === '/invoices/drafts') { lastPostBody = opts.body; return { draftInvoiceNumber: ++draftSeq }; }
    if (opts.method === 'DELETE') return null;
    throw new Error('uventet eco.rest: ' + p);
};

const express = require('express');
const { getDb } = require('../../db/database');
const invoicesRouter = require('../../routes/invoices');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.error(`  ✗ ${name} ${extra}`); } };

// ── seed temp-DB ────────────────────────────────────────────
function seed() {
    const db = getDb();
    const locId = db.prepare('SELECT id FROM locations LIMIT 1').get()?.id
        || db.prepare("INSERT INTO locations (code,name) VALUES ('test','Test') RETURNING id").get().id;
    const pcId = db.prepare('SELECT id FROM price_categories LIMIT 1').get().id;
    const LEVERET = db.prepare("SELECT id FROM status_definitions WHERE code='LEVERET'").get().id;

    const coId = db.prepare("INSERT INTO companies (name, economic_customer_id) VALUES ('T_ECO Firma', 944) RETURNING id").get().id;
    const cuId = db.prepare("INSERT INTO customers (first_name, last_name, company_id) VALUES ('Test','Person',?) RETURNING id").get(coId).id;
    const adId = db.prepare("INSERT INTO addresses (street_name, street_nr, postal_code, city) VALUES ('Testvej','1','2200','København') RETURNING id").get().id;

    const insBon = db.prepare(`INSERT INTO bons (bon_number,status_id,location_id,order_date,delivery_date,payment_type,is_offer,company_id,customer_id,delivery_address_id,price_category_id)
                               VALUES (?,?,?,date('now'),date('now'),'invoice',0,?,?,?,?) RETURNING id`);
    const insLine = db.prepare(`INSERT INTO bon_lines (bon_id,product_name,quantity,unit,unit_price,line_total,grocy_recipe_id,category,sort_order)
                                VALUES (?,?,?,'stk',?,?,?,?,?)`);

    const ready = insBon.get('T_ECO_READY', LEVERET, locId, coId, cuId, adId, pcId).id;
    insLine.run(ready, 'Kartoflen', 2, 9400, 18800, 100, '01 Sandwich', 0);   // recipe 100 → '65'
    insLine.run(ready, 'Kartoflen slider', 1, 6800, 6800, 101, '04 Slider', 1); // recipe 101 → '77'

    const missing = insBon.get('T_ECO_MISSING', LEVERET, locId, coId, cuId, adId, pcId).id;
    insLine.run(missing, 'Ukoblet vare', 1, 5000, 5000, 200, '01 Sandwich', 0);  // recipe 200 → ingen

    return { ready, missing };
}

// ── http helper ─────────────────────────────────────────────
function req(server, method, url, { auth = true, body } = {}) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: '127.0.0.1', port, method, path: url, headers: {
            'Content-Type': 'application/json',
            ...(auth ? { 'x-test-user': '1' } : {}),
            ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        } }, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
        r.on('error', reject); if (data) r.write(data); r.end();
    });
}

(async () => {
    const ids = seed();
    const db = getDb();

    const app = express();
    app.use(express.json());
    app.use((req2, _res, next) => { req2.session = req2.headers['x-test-user'] ? { userId: Number(req2.headers['x-test-user']) } : {}; next(); });
    app.use('/api/invoices', invoicesRouter);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));

    try {
        console.log('\n── Preview (dry-run) ──');
        let res = await req(server, 'GET', `/api/invoices/${ids.ready}/economic-preview`);
        ok('preview ready → 200', res.status === 200, `(status ${res.status})`);
        ok('preview ready → readiness.ok', res.body?.readiness?.ok === true);
        ok('preview ready → payload bygget', !!res.body?.payload);
        ok('preview ready → customerNumber 944', res.body?.payload?.customer?.customerNumber === 944);
        ok('preview ready → 2 linjer m. varenr', res.body?.payload?.lines?.length === 2 && res.body.payload.lines[0].product.productNumber === '65');

        res = await req(server, 'GET', `/api/invoices/${ids.missing}/economic-preview`);
        ok('preview missing → 200', res.status === 200);
        ok('preview missing → readiness.ok false', res.body?.readiness?.ok === false);
        ok('preview missing → payload null', res.body?.payload === null);
        ok('preview missing → 1 manglende vare', res.body?.readiness?.missingProducts?.length === 1);

        console.log('\n── Readiness (pre-flight) ──');
        res = await req(server, 'GET', '/api/invoices/economic-readiness');
        ok('readiness → 200', res.status === 200);
        ok('readiness → missing bon blokeret', res.body?.blocked?.some(b => b.bon_id === ids.missing));
        ok('readiness → ready bon IKKE blokeret', !res.body?.blocked?.some(b => b.bon_id === ids.ready));
        ok('readiness → drafts_waiting = 0', res.body?.drafts_waiting === 0);

        console.log('\n── Draft (opret udkast) ──');
        res = await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { body: {} });
        ok('draft happy → 200', res.status === 200, `(status ${res.status}, ${JSON.stringify(res.body)})`);
        const draftNo = res.body?.economic_draft_number;
        ok('draft happy → draftInvoiceNumber returneret', typeof draftNo === 'number');
        const saved = db.prepare('SELECT economic_draft_number, economic_draft_at FROM bons WHERE id=?').get(ids.ready);
        ok('draft happy → gemt på bon', saved.economic_draft_number === draftNo && !!saved.economic_draft_at);
        const cl = db.prepare("SELECT COUNT(*) n FROM changelog WHERE entity_type='bon' AND entity_id=? AND action='economic_draft_created'").get(ids.ready).n;
        ok('draft happy → changelog skrevet', cl === 1);

        console.log('\n── Re-send-guard ──');
        res = await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { body: {} });
        ok('re-send → 409', res.status === 409, `(status ${res.status})`);
        ok('re-send → returnerer eksisterende nr', res.body?.economic_draft_number === draftNo);

        console.log('\n── 422 ved manglende kobling ──');
        res = await req(server, 'POST', `/api/invoices/${ids.missing}/economic-draft`, { body: {} });
        ok('missing → 422', res.status === 422, `(status ${res.status})`);
        ok('missing → readiness.missingProducts', res.body?.readiness?.missingProducts?.length === 1);

        console.log('\n── Auth ──');
        res = await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { auth: false, body: {} });
        ok('draft uden session → 401', res.status === 401, `(status ${res.status})`);
        res = await req(server, 'GET', '/api/invoices/economic-readiness', { auth: false });
        ok('readiness uden session → 401', res.status === 401);

        console.log('\n── Readiness efter draft (drafts_waiting tæller) ──');
        res = await req(server, 'GET', '/api/invoices/economic-readiness');
        ok('readiness → drafts_waiting = 1', res.body?.drafts_waiting === 1, `(${res.body?.drafts_waiting})`);
    } finally {
        server.close();
        try { db.close?.(); } catch (e) {}
        for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch (e) {} }
    }

    console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
