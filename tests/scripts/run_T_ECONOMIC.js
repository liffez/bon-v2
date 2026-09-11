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
 * logik dækkes separat af scripts/test-economic-invoice.js (100 tests).
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

let PRODUCT_MAP = new Map([[100, '65'], [101, '77'], [8, '110']]);   // recipe_id → varenr (8 = Rabat)
grocyAdapter.getEconomicProductMap = async () => PRODUCT_MAP;

// Bundter (slider-bokse): recipe uden eget varenr → indholdets varenumre.
// Tom som standard; sættes af de tests der har brug for den.
let BUNDLE_MAP = new Map();
grocyAdapter.getEconomicBundleMap = async () => BUNDLE_MAP;

// autoFees slår gebyr-opskriften op via getRecipes(). Opskrift 168 = miljøbidraget
// fra migration 147, prissat som i Grocy (INCL moms, §6b).
grocyAdapter.getRecipes = async () => ([
    { id: 168, name: 'Miljøbidrag', category: 'x- Service', unit: 'stk',
      prices: { store: 36.25, catering: 36.25, festival: 36.25 }, cost_price: 0, co2e: null },
]);

let draftSeq = 5000, lastPostBody = null;
const LEVENDE_KLADDER = new Set();   // kladder der (endnu) IKKE er slettet i e-conomic
eco.isConfigured = () => true;
eco.rest = async (p, opts = {}) => {
    if (opts.method === 'POST' && p === '/invoices/drafts') { lastPostBody = opts.body; return { draftInvoiceNumber: ++draftSeq }; }
    if (opts.method === 'DELETE') return null;
    // Kladde-opslag (frigivelses-vagten). Numre i LEVENDE_KLADDER findes stadig.
    const dm = p.match(/^\/invoices\/drafts\/(\d+)$/);
    if (dm && !opts.method) {
        if (LEVENDE_KLADDER.has(dm[1])) return { draftInvoiceNumber: Number(dm[1]) };
        const e = new Error('e-conomic 404: draft not found');
        e.status = 404;
        throw e;
    }
    // Kundekortet: adressen står i e-conomic, ikke i CRM — den skal hentes derfra.
    if (p === '/customers/944') {
        return { customerNumber: 944, name: 'T_ECO Firma', address: 'Testvej 3',
                 zip: '2200', city: 'København N', country: 'Danmark' };
    }
    // Kontakt-vagten slår op om kontakten ligger under fakturaens kunde.
    // 700 gør (firmaets kunde 944); alt andet svarer e-conomic 404 på.
    const ct = p.match(/^\/customers\/(\d+)\/contacts\/(\d+)$/);
    if (ct) {
        if (ct[1] === '944' && ct[2] === '700') return { customerContactNumber: 700 };
        const e = new Error('e-conomic 404: contact not found');
        e.status = 404;
        throw e;
    }
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

    // Slider-boks: recipe 300 har intet eget varenr, men et bundt (se BUNDLE_MAP).
    const bundle = insBon.get('T_ECO_BUNDLE', LEVERET, locId, coId, cuId, adId, pcId).id;
    insLine.run(bundle, 'Vegetar slider Boks', 5, 160, 800, 300, '04 Slider', 0);   // 160 kr incl pr. boks

    // Beløbslinje: 2.000 kr rabat tastet som 2.000 stk à -1 (recipe 8, jf. migration 144).
    const amount = insBon.get('T_ECO_BELOEB', LEVERET, locId, coId, cuId, adId, pcId).id;
    insLine.run(amount, 'Kartoflen', 1, 9400, 9400, 100, '01 Sandwich', 0);
    insLine.run(amount, 'Rabat', 2000, -1, -2000, 8, 'x- Service', 1);

    // #454: en bon med emballage der bevidst ikke faktureres. Recipe 45 er seedet
    // i economic_noninvoice_recipes af migration 149 — testen beviser dermed også
    // at migrationen er kørt (samme trick som beløbslinje-testen).
    const excl = insBon.get('T_ECO_EXCL', LEVERET, locId, coId, cuId, adId, pcId).id;
    insLine.run(excl, 'Kartoflen', 1, 9400, 9400, 100, '01 Sandwich', 0);
    insLine.run(excl, 'RR Boks  (emballage)', 3, 0, 0, 45, '06 Emballage', 1);

    // Selvmodsigelse: opskriften står på listen, men linjen har en pris. Må blokere —
    // listen kan ophæve en blokering, aldrig fjerne omsætning.
    const exclPriced = insBon.get('T_ECO_EXCL_PRICED', LEVERET, locId, coId, cuId, adId, pcId).id;
    insLine.run(exclPriced, 'Kartoflen', 1, 9400, 9400, 100, '01 Sandwich', 0);
    insLine.run(exclPriced, 'RR Boks  (emballage)', 1, 2500, 2500, 45, '06 Emballage', 1);

    // Ægte vare i den blandede kategori: før #454 forsvandt den stille, fordi
    // kategorien hed "Tilbehør & Bokse". Nu blokerer den.
    const mixed = insBon.get('T_ECO_MIXED', LEVERET, locId, coId, cuId, adId, pcId).id;
    insLine.run(mixed, 'Kartoflen', 1, 9400, 9400, 100, '01 Sandwich', 0);
    insLine.run(mixed, 'Glutenfri Bolle', 2, 4500, 9000, 75, 'Tilbehør & Bokse', 1);

    // Gebyr-bon: reglen (migration 147) gælder fra 11 pax. Bruges til at bevise at
    // en prøvekørsel IKKE skriver gebyrlinjen på bonen, mens en rigtig afsendelse gør.
    const fee = insBon.get('T_ECO_FEE', LEVERET, locId, coId, cuId, adId, pcId).id;
    db.prepare('UPDATE bons SET pax = 40 WHERE id = ?').run(fee);
    insLine.run(fee, 'Kartoflen', 40, 9400, 376000, 100, '01 Sandwich', 0);

    return { ready, missing, bundle, amount, excl, exclPriced, mixed, fee, cuId, coEco: 944 };
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

        console.log('\n── Bundt-udfoldning (slider-boks) ──');
        // Uden bundt-kobling blokerer boksen som enhver anden ukoblet vare.
        res = await req(server, 'GET', `/api/invoices/${ids.bundle}/economic-preview`);
        ok('boks uden bundt → blokerer', res.body?.readiness?.ok === false);

        BUNDLE_MAP = new Map([[300, [
            { recipe_id: 57, product_number: '77', servings: 1, name: 'Kartoflen slider' },
            { recipe_id: 62, product_number: '83', servings: 1, name: 'Ægget slider' },
            { recipe_id: 54, product_number: '79', servings: 1, name: 'Italieneren slider' },
        ]]]);
        res = await req(server, 'GET', `/api/invoices/${ids.bundle}/economic-preview`);
        ok('boks m. bundt → readiness.ok', res.body?.readiness?.ok === true);
        const bl = res.body?.payload?.lines || [];
        ok('boks m. bundt → 3 fakturalinjer', bl.length === 3);
        ok('boks m. bundt → varenumre 77/83/79', bl.map(l => l.product.productNumber).join(',') === '77,83,79');
        ok('boks m. bundt → 5 stk pr. linje', bl.every(l => l.quantity === 5));
        // 160 incl = 128 ex pr. boks × 5 bokse = 640, uanset hvordan det deles.
        ok('boks m. bundt → sum 640 ex moms',
           Math.abs(bl.reduce((s, l) => s + l.unitNetPrice * l.quantity, 0) - 640) < 0.0001);
        BUNDLE_MAP = new Map();

        console.log('\n── Beløbslinje (Rabat) ──');
        // Settingen kommer fra migration 144 — dette tester også at den er seedet.
        res = await req(server, 'GET', `/api/invoices/${ids.amount}/economic-preview`);
        ok('beløbslinje → payload bygget', !!res.body?.payload);
        const rabat = (res.body?.payload?.lines || []).find(l => l.product.productNumber === '110');
        ok('beløbslinje → foldet til antal 1', rabat?.quantity === 1);
        ok('beløbslinje → pris = -1.600 ex moms', rabat?.unitNetPrice === -1600);
        const vare = (res.body?.payload?.lines || []).find(l => l.product.productNumber === '65');
        ok('beløbslinje → almindelig vare uberørt', vare?.quantity === 1 && vare?.unitNetPrice === 7520);

        console.log('\n── Readiness (pre-flight) ──');
        res = await req(server, 'GET', '/api/invoices/economic-readiness');
        ok('readiness → 200', res.status === 200);
        ok('readiness → missing bon blokeret', res.body?.blocked?.some(b => b.bon_id === ids.missing));
        ok('readiness → ready bon IKKE blokeret', !res.body?.blocked?.some(b => b.bon_id === ids.ready));
        ok('readiness → drafts_waiting = 0', res.body?.drafts_waiting === 0);

        console.log('\n── Fakturaadressen hentes fra e-conomic når CRM ikke har den ──');
        // Firmaerne har fået fakturaer i årevis, så adressen står allerede på
        // kundekortet. Uden dette stod fakturaen helt uden afsenderadresse.
        res = await req(server, 'GET', `/api/invoices/${ids.ready}/economic-preview`);
        ok('adresse hentet fra kundekortet', res.body?.payload?.recipient?.address === 'Testvej 3',
            JSON.stringify(res.body?.payload?.recipient));
        ok('postnr + by med', res.body?.payload?.recipient?.zip === '2200'
            && res.body?.payload?.recipient?.city === 'København N');
        ok('forhåndsvisning og prøvekørsel er stadig enige',
            (await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { body: { dry_run: true } }))
                .body?.payload?.recipient?.address === 'Testvej 3');

        console.log('\n── Kontakt-vagt: kontakt under en anden kunde ──');
        // Fejlen fra drift: fakturaen udstedes til firmaets kunde, men personens
        // kontakt lå under et andet kundenummer → e-conomic afviste HELE kladden
        // med E04800. Vagten skal fange den før afsendelse, med en besked office
        // kan handle på.
        db.prepare('UPDATE customers SET economic_contact_id = ? WHERE id = ?').run('875', ids.cuId);
        res = await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { body: {} });
        ok('kontakt-mismatch → 422', res.status === 422, `(status ${res.status}, ${JSON.stringify(res.body)})`);
        ok('kontakt-mismatch → code', res.body?.code === 'contact_customer_mismatch');
        ok('kontakt-mismatch → beskeden nævner begge numre',
            /875/.test(res.body?.error || '') && /944/.test(res.body?.error || ''));
        ok('kontakt-mismatch → intet gemt på bonen',
            db.prepare('SELECT economic_draft_number n FROM bons WHERE id=?').get(ids.ready).n == null);

        res = await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { body: { dry_run: true } });
        ok('kontakt-mismatch → prøvekørslen fanger den også',
            res.status === 422 && res.body?.code === 'contact_customer_mismatch', `(status ${res.status})`);

        db.prepare('UPDATE customers SET economic_contact_id = ? WHERE id = ?').run('700', ids.cuId);
        res = await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { body: { dry_run: true } });
        ok('kontakt under rette kunde → slipper igennem', res.status === 200, `(status ${res.status})`);
        ok('kontakt under rette kunde → med i payloaden',
            res.body?.payload?.references?.customerContact?.customerContactNumber === 700
            && res.body?.payload?.recipient?.attention?.customerContactNumber === 700);
        db.prepare('UPDATE customers SET economic_contact_id = NULL WHERE id = ?').run(ids.cuId);

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

        console.log('\n── "Faktureres ikke" er pr. vare (#454) ──');
        res = await req(server, 'GET', `/api/invoices/${ids.excl}/economic-preview`);
        ok('excl → 200', res.status === 200);
        ok('excl → bonen er klar (udeladelse blokerer ikke)', res.body?.readiness?.ok === true);
        ok('excl → emballagen rapporteres som udeladt',
            res.body?.readiness?.excluded?.length === 1
            && res.body.readiness.excluded[0].grocy_recipe_id === 45
            && res.body.readiness.excluded[0].reason === 'noninvoice',
            JSON.stringify(res.body?.readiness?.excluded));
        ok('excl → udeladt linje er IKKE i payloaden',
            (res.body?.payload?.lines || []).every(l => l.product.productNumber !== '45'));
        ok('excl → migration 149 er seedet (ellers ville reason være zero_amount)',
            res.body?.readiness?.excluded?.[0]?.reason === 'noninvoice');

        res = await req(server, 'GET', `/api/invoices/${ids.exclPriced}/economic-preview`);
        ok('excl-priced → listet opskrift MED pris blokerer', res.body?.readiness?.ok === false);
        ok('excl-priced → grunden er selvmodsigelsen',
            res.body?.readiness?.missingProducts?.[0]?.reason === 'noninvoice_but_priced',
            JSON.stringify(res.body?.readiness?.missingProducts));

        res = await req(server, 'GET', `/api/invoices/${ids.mixed}/economic-preview`);
        ok('mixed → ægte vare i blandet kategori blokerer', res.body?.readiness?.ok === false);
        ok('mixed → varen er navngivet',
            res.body?.readiness?.missingProducts?.[0]?.product_name === 'Glutenfri Bolle');

        // Kø-listen læses FØR der oprettes udkast — et udkast fjerner bonen fra køen.
        res = await req(server, 'GET', '/api/invoices/economic-readiness');
        ok('readiness → udeladte linjer tælles op', typeof res.body?.excluded_bons === 'number'
            && res.body.excluded_bons >= 1);
        ok('readiness → excl-bonen er ikke blokeret',
            !(res.body?.blocked || []).some(b => b.bon_id === ids.excl));
        ok('readiness → mixed-bonen ER blokeret',
            (res.body?.blocked || []).some(b => b.bon_id === ids.mixed));

        res = await req(server, 'POST', `/api/invoices/${ids.mixed}/economic-draft`, { body: {} });
        ok('mixed → draft afvises med 422', res.status === 422);
        ok('mixed → intet udkast gemt på bonen',
            db.prepare('SELECT economic_draft_number FROM bons WHERE id=?').get(ids.mixed).economic_draft_number == null);

        // Engangsvare-redningen er en ÅBEN vej i en frisk DB: migration 144 sætter
        // economic_oneoff_product_number = 111. #444 handlede om hvad der sker når
        // feltet er tomt — så faldt koden tilbage til at droppe linjen uden en lyd.
        const oneoffBefore = db.prepare("SELECT value FROM settings WHERE key='economic_oneoff_product_number'").get()?.value;
        ok('engangsvarens varenr er sat af migration 144', oneoffBefore === '111', String(oneoffBefore));
        db.prepare("UPDATE settings SET value='' WHERE key='economic_oneoff_product_number'").run();
        res = await req(server, 'POST', `/api/invoices/${ids.mixed}/economic-draft`, { body: { oneoff_for_missing: true } });
        ok('tom engangsvare → 422, ikke en stille droppet linje', res.status === 422, JSON.stringify(res.body));
        ok('tom engangsvare → fejlkoden siger hvad der mangler', res.body?.code === 'oneoff_unavailable',
            JSON.stringify(res.body));
        ok('tom engangsvare → stadig intet udkast gemt',
            db.prepare('SELECT economic_draft_number FROM bons WHERE id=?').get(ids.mixed).economic_draft_number == null);
        db.prepare("UPDATE settings SET value=? WHERE key='economic_oneoff_product_number'").run(oneoffBefore);

        // …og med nummeret på plads virker nødudgangen: knappen i fakturerings-skærmen
        // sender oneoff_for_missing, og de ukoblede linjer faktureres på engangsvaren
        // med beløb og tekst i behold. Det er den eneste vej for en FRITEKST-linje —
        // den har ingen opskrift at koble.
        res = await req(server, 'GET', `/api/invoices/${ids.mixed}/economic-preview`);
        ok('oneoff → readiness siger at nødudgangen findes', res.body?.readiness?.oneoffAvailable === true);

        lastPostBody = null;
        res = await req(server, 'POST', `/api/invoices/${ids.mixed}/economic-draft`, { body: { oneoff_for_missing: true } });
        ok('oneoff → 200 med nummer på plads', res.status === 200, JSON.stringify(res.body));
        const oneoffLine = (lastPostBody?.lines || []).find(l => l.description === 'Glutenfri Bolle');
        ok('oneoff → den ukoblede linje kom med på engangsvarens varenr',
            oneoffLine?.product?.productNumber === '111', JSON.stringify(lastPostBody?.lines));
        ok('oneoff → beløbet er bevaret (9.000 kr incl → 7.200 ex)',
            Math.abs((oneoffLine?.unitNetPrice || 0) * (oneoffLine?.quantity || 0) - 7200) < 0.01,
            JSON.stringify(oneoffLine));
        ok('oneoff → den 0-kr emballage kom stadig IKKE med',
            !(lastPostBody?.lines || []).some(l => String(l.description).includes('Salat boks')));


        console.log('\n── Prøvekørsel (dry_run) ──');
        // Kernen: dry_run skal følge PRÆCIS samme sti som en rigtig afsendelse og
        // kun undlade det sidste skridt. Derfor måles der på tre ting: at payloaden
        // er der, at e-conomic ALDRIG blev kaldt, og at bonen er urørt bagefter.
        const førDraft = db.prepare('SELECT economic_draft_number FROM bons WHERE id=?').get(ids.ready).economic_draft_number;
        lastPostBody = null;
        res = await req(server, 'POST', `/api/invoices/${ids.excl}/economic-draft`, { body: { dry_run: true } });
        ok('dry_run → 200', res.status === 200, JSON.stringify(res.body).slice(0, 160));
        ok('dry_run → mærket som prøvekørsel', res.body?.dry_run === true);
        ok('dry_run → payloaden er bygget', Array.isArray(res.body?.payload?.lines) && res.body.payload.lines.length > 0);
        ok('dry_run → e-conomic blev ALDRIG kaldt', lastPostBody === null);
        ok('dry_run → intet udkast gemt på bonen',
            db.prepare('SELECT economic_draft_number FROM bons WHERE id=?').get(ids.excl).economic_draft_number == null);
        ok('dry_run → idempotency-nøglen er den samme form som ved rigtig afsendelse',
            /^bon-\d+-[0-9a-f]{12}$/.test(res.body?.idempotency_key || ''), res.body?.idempotency_key);
        ok('dry_run → udeladte linjer rapporteres som ellers',
            res.body?.readiness?.excluded?.length === 1);
        ok('dry_run → en ANDEN bons udkast er urørt',
            db.prepare('SELECT economic_draft_number FROM bons WHERE id=?').get(ids.ready).economic_draft_number === førDraft);

        // Samme payload som en rigtig afsendelse ville sende — ellers beviser prøven intet.
        const tørPayload = JSON.stringify(res.body.payload);
        res = await req(server, 'POST', `/api/invoices/${ids.excl}/economic-draft`, { body: {} });
        ok('rigtig afsendelse → 200', res.status === 200);
        ok('rigtig afsendelse sendte NØJAGTIG den payload prøvekørslen viste',
            JSON.stringify(lastPostBody) === tørPayload);

        // Prøvekørsel må ikke SKRIVE på bonen. Standardgebyrer er den eneste bivirkning
        // afsendelsen har ud over kaldet til e-conomic, så det er dér det skal bevises.
        db.prepare(`UPDATE settings SET value='[{"id":"miljobidrag","recipe_id":168,"min_pax":11,"active":1}]' WHERE key='auto_fee_rules'`).run();
        require('../../services/autoFees').invalidateFeeCache();
        const linjerFør = db.prepare('SELECT COUNT(*) n FROM bon_lines WHERE bon_id=?').get(ids.fee).n;
        res = await req(server, 'POST', `/api/invoices/${ids.fee}/economic-draft`, { body: { dry_run: true } });
        ok('dry_run → 200 på gebyr-bon', res.status === 200, JSON.stringify(res.body).slice(0, 140));
        ok('dry_run → gebyrlinjen blev IKKE skrevet på bonen',
            db.prepare('SELECT COUNT(*) n FROM bon_lines WHERE bon_id=?').get(ids.fee).n === linjerFør);
        ok('dry_run → men den varsles som noget afsendelsen vil lægge på',
            (res.body?.pending_fees || []).length === 1, JSON.stringify(res.body?.pending_fees));

        res = await req(server, 'POST', `/api/invoices/${ids.fee}/economic-draft`, { body: {} });
        ok('rigtig afsendelse → gebyrlinjen ER skrevet på bonen',
            db.prepare('SELECT COUNT(*) n FROM bon_lines WHERE bon_id=?').get(ids.fee).n === linjerFør + 1);

        // Prøvekørsel af en blokeret bon skal afvises på samme måde som en rigtig
        lastPostBody = null;
        res = await req(server, 'POST', `/api/invoices/${ids.exclPriced}/economic-draft`, { body: { dry_run: true } });
        ok('dry_run på blokeret bon → 422 som en rigtig afsendelse', res.status === 422);
        ok('dry_run på blokeret bon → intet kald til e-conomic', lastPostBody === null);

        console.log('\n── Auth ──');
        res = await req(server, 'POST', `/api/invoices/${ids.ready}/economic-draft`, { auth: false, body: {} });
        ok('draft uden session → 401', res.status === 401, `(status ${res.status})`);
        res = await req(server, 'GET', '/api/invoices/economic-readiness', { auth: false });
        ok('readiness uden session → 401', res.status === 401);

        console.log('\n── Readiness efter draft (drafts_waiting tæller) ──');
        res = await req(server, 'GET', '/api/invoices/economic-readiness');
        // Tre kladder nu: happy path, nødudgangen på mixed-bonen, og den rigtige
        // afsendelse der blev sammenlignet med prøvekørslen.
        ok('readiness → drafts_waiting = 3', res.body?.drafts_waiting === 3, `(${res.body?.drafts_waiting})`);

        console.log('\n── Frigiv bon efter slettet kladde ──');
        // Re-send-vagten havde ingen nødudgang: slettede man kladden i e-conomic,
        // stod nummeret stadig på bonen, og bonen kunne aldrig faktureres igen.
        {
            const bid = ids.ready;   // har fået en kladde tidligere i denne kørsel
            const nr = String(db.prepare('SELECT economic_draft_number n FROM bons WHERE id=?').get(bid).n);

            // Kladden findes stadig → må IKKE frigives (ellers to kladder).
            LEVENDE_KLADDER.add(nr);
            res = await req(server, 'DELETE', `/api/invoices/${bid}/economic-draft`);
            ok('kladde findes stadig → 409', res.status === 409, `(status ${res.status})`);
            ok('og nummeret står urørt på bonen',
                db.prepare('SELECT economic_draft_number n FROM bons WHERE id=?').get(bid).n != null);

            // Bogført faktura på bonen → må HELLER IKKE frigives (fakturaen er ude).
            LEVENDE_KLADDER.delete(nr);
            const bnum = db.prepare('SELECT bon_number FROM bons WHERE id=?').get(bid).bon_number;
            db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading)
                        VALUES ('90001','2026-09-10',1000,0,?)`).run('#' + bnum);
            res = await req(server, 'DELETE', `/api/invoices/${bid}/economic-draft`);
            ok('bogført faktura → 409', res.status === 409, `(status ${res.status})`);
            ok('og den navngiver fakturanummeret', res.body?.booked_invoice_number === '90001');

            // Hverken kladde eller bogført faktura → frigiv.
            db.prepare("DELETE FROM cf_economic_invoices WHERE booked_no='90001'").run();
            res = await req(server, 'DELETE', `/api/invoices/${bid}/economic-draft`);
            ok('slettet kladde → 200', res.status === 200, `(status ${res.status}, ${JSON.stringify(res.body)})`);
            ok('nummeret er ryddet på bonen',
                db.prepare('SELECT economic_draft_number n FROM bons WHERE id=?').get(bid).n === null);
            ok('frigivelsen er logget',
                db.prepare("SELECT COUNT(*) n FROM changelog WHERE entity_id=? AND action='economic_draft_released'").get(bid).n === 1);

            // Intet at frigive → 409, ikke en stille succes.
            res = await req(server, 'DELETE', `/api/invoices/${bid}/economic-draft`);
            ok('ingen kladde → 409', res.status === 409, `(status ${res.status})`);
        }

    } finally {
        server.close();
        try { db.close?.(); } catch (e) {}
        for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch (e) {} }
    }

    console.log(`\n${fail ? '❌' : '✅'} ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
