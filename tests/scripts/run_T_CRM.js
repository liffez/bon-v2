#!/usr/bin/env node
/**
 * tests/scripts/run_T_CRM.js
 * ════════════════════════════════════════════════════════════
 * T_CRM — CRM + outreach-kampagner (kerne-scope).
 * Dækker: Kunde 360°, activities (+ campaign_id side-effekt), stage/consent,
 * kampagne-CRUD, kampagne-medlemmer (B2C-samtykke-gating + dedup).
 *
 * Forudsætning: test-server kører (npm run test:server, port 4322),
 * isoleret data/test.db, safety_check grøn.
 *
 * Kør:  node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_CRM.js [--verbose]
 * ════════════════════════════════════════════════════════════
 */
'use strict';

const { openDb } = require('../../db/compat');
const safetyCheck = require('./safety_check');
const sse = require('./helpers/sse_listener');

const SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const VERBOSE = process.argv.includes('--verbose');
const PREFIX = 'T_CRM';

let db, COOKIE = null, listener = null;
const results = [];
const fx = { companies: {}, customers: {}, campaigns: {}, activities: {}, members: {}, bons: {}, cp: {} };
const IMP_CVRS = ['10000099', '10000098', '10000097'];
const IMP_EMAILS = ['imp-dry@t-crm.test', 'imp-a@t-crm.test', 'imp-b@t-crm.test', 'imp-priv@t-crm.test',
    'imp-vip@t-crm.test', 'imp-tag@t-crm.test', 'imp-good@t-crm.test'];

function rec(id, group, ok, detail = '') {
    results.push({ id, group, ok, detail });
    if (!ok || VERBOSE) console.log(`  ${ok ? '✓' : '✗'} ${id}${detail ? ' — ' + detail : ''}`);
}
function assert(id, group, cond, detail = '') { rec(id, group, !!cond, detail); return !!cond; }

async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (COOKIE) opts.headers.Cookie = COOKIE;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(`${SERVER_URL}${path}`, opts);
    let parsed = null; const text = await res.text();
    try { parsed = JSON.parse(text); } catch {}
    return { status: res.status, body: parsed, raw: text };
}
async function login() {
    const res = await fetch(`${SERVER_URL}/api/auth/pin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: '1234' }),
    });
    if (res.status !== 200) throw new Error(`login fejlede: ${res.status}`);
    COOKIE = res.headers.get('set-cookie').split(';')[0];
}
const meta = (cid) => db.prepare('SELECT * FROM crm_customer_meta WHERE customer_id = ?').get(cid);

// ── SETUP ────────────────────────────────────────────────────
async function setup() {
    console.log('\n── 4.1 SETUP ──');
    const co = (name) => Number(db.prepare(
        "INSERT INTO companies (name, is_active, is_personal, notes) VALUES (?,1,0,?)"
    ).run(`${PREFIX}_${name}`, PREFIX).lastInsertRowid);
    // B2C vs B2B afgøres af company_id (null = B2C) — der er ingen is_personal på customers
    const cust = (companyId, first) => Number(db.prepare(
        "INSERT INTO customers (company_id, first_name, last_name, is_active, notes) VALUES (?,?,?,1,?)"
    ).run(companyId, `${PREFIX}_${first}`, 'Test', PREFIX).lastInsertRowid);
    const setMeta = (cid, stage, consent, dnc) => db.prepare(
        "INSERT INTO crm_customer_meta (customer_id, stage, marketing_consent, do_not_contact) VALUES (?,?,?,?)"
    ).run(cid, stage, consent, dnc);

    fx.companies.ACME = co('ACME');
    fx.customers.ALICE = cust(fx.companies.ACME, 'Alice');  // B2B (har firma)
    fx.customers.BOB   = cust(null, 'Bob');                 // B2C, consent=1
    fx.customers.CARL  = cust(null, 'Carl');               // B2C, consent=0
    fx.customers.DORA  = cust(null, 'Dora');               // B2C, dnc=1
    setMeta(fx.customers.ALICE, 'active', 0, 0);
    setMeta(fx.customers.BOB,   'lead',   1, 0);
    setMeta(fx.customers.CARL,  'lead',   0, 0);
    setMeta(fx.customers.DORA,  'lead',   1, 1);

    await login();
    listener = await sse.connect(SERVER_URL, COOKIE);
    assert('SETUP_01', 'SETUP', fx.customers.ALICE && fx.customers.BOB, '2 firmaer/4 kunder + meta + login + SSE');
}

// ── CUSTOMER_360 ─────────────────────────────────────────────
async function customer360() {
    console.log('\n── 4.2 CUSTOMER_360 ──');
    const r = await api('GET', `/api/crm/customer/${fx.customers.ALICE}`);
    assert('C360_01', 'C360', r.status === 200 && r.body, `status=${r.status}`);
    if (r.body) {
        assert('C360_02', 'C360', r.body.stats && typeof r.body.stats.total_orders !== 'undefined', 'stats-objekt');
        assert('C360_03', 'C360', Array.isArray(r.body.orders), 'orders-array');
        assert('C360_04', 'C360', Array.isArray(r.body.activities), 'activities-array');
    }
    const b2c = await api('GET', `/api/crm/customer/${fx.customers.BOB}`);
    assert('C360_05', 'C360', b2c.status === 200, `B2C (uden firma) håndteret, status=${b2c.status}`);
    const nf = await api('GET', '/api/crm/customer/99999999');
    assert('C360_06', 'C360', nf.status === 404, `ukendt id → 404 (fik ${nf.status})`);
}

// ── ACTIVITIES ───────────────────────────────────────────────
async function activities() {
    console.log('\n── 4.3 ACTIVITIES ──');
    const before = meta(fx.customers.ALICE).last_contact_at;
    listener.clearEvents();
    const r = await api('POST', '/api/crm/activity', { customer_id: fx.customers.ALICE, type: 'note', text: 'T_CRM note' });
    assert('ACT_01', 'ACT', r.status === 200 && r.body?.id, `opret note, status=${r.status}`);
    if (r.body?.id) fx.activities.NOTE = r.body.id;
    // last_contact_at opdateret
    const after = meta(fx.customers.ALICE).last_contact_at;
    assert('ACT_02', 'ACT', after && after !== before, 'last_contact_at opdateret');
    // SSE
    let ev = null;
    try { ev = await listener.waitForEvent('crm_activity_created', e => e.id === fx.activities.NOTE, 2500); } catch {}
    assert('ACT_03', 'ACT', ev, 'SSE crm_activity_created modtaget');
    // valideringer
    const bad1 = await api('POST', '/api/crm/activity', { customer_id: fx.customers.ALICE, type: 'note' });
    assert('ACT_04', 'ACT', bad1.status === 400, `manglende text → 400 (fik ${bad1.status})`);
    const bad2 = await api('POST', '/api/crm/activity', { type: 'note', text: 'x' });
    assert('ACT_05', 'ACT', bad2.status === 400, `manglende customer_id → 400 (fik ${bad2.status})`);
    // owner_user_id skal være den indloggede bruger (ikke null) — F1: req.session.user?.id-bug
    if (fx.activities.NOTE) {
        const owner = db.prepare('SELECT owner_user_id FROM crm_activities WHERE id = ?').get(fx.activities.NOTE).owner_user_id;
        assert('ACT_07', 'ACT', owner != null, `activity.owner_user_id sat (fik ${owner})`);
    }
    // PATCH done
    if (fx.activities.NOTE) {
        const d = await api('PATCH', `/api/crm/activity/${fx.activities.NOTE}/done`);
        const row = db.prepare('SELECT done_at FROM crm_activities WHERE id = ?').get(fx.activities.NOTE);
        assert('ACT_06', 'ACT', d.status === 200 && row?.done_at, `done_at sat (status=${d.status})`);
    }
}

// ── STAGE + CONSENT ──────────────────────────────────────────
async function stageConsent() {
    console.log('\n── 4.4 STAGE+CONSENT ──');
    const ok = await api('PATCH', `/api/crm/customer/${fx.customers.BOB}/stage`, { stage: 'vip' });
    assert('STG_01', 'STG', ok.status === 200 && meta(fx.customers.BOB).stage === 'vip', `stage=vip (status=${ok.status})`);
    const bad = await api('PATCH', `/api/crm/customer/${fx.customers.BOB}/stage`, { stage: 'frækkert' });
    assert('STG_02', 'STG', bad.status === 400, `ugyldig stage → 400 (fik ${bad.status})`);
    // consent: giv Carl samtykke
    const c = await api('PATCH', `/api/crm/customer/${fx.customers.CARL}/consent`, { marketing_consent: true });
    assert('STG_03', 'STG', c.status === 200 && meta(fx.customers.CARL).marketing_consent === 1, `consent sat (status=${c.status})`);
    // tilbage til 0 så medlems-testen er deterministisk
    await api('PATCH', `/api/crm/customer/${fx.customers.CARL}/consent`, { marketing_consent: false });
    assert('STG_04', 'STG', meta(fx.customers.CARL).marketing_consent === 0, 'consent kan sættes tilbage til 0');
    const none = await api('PATCH', `/api/crm/customer/${fx.customers.CARL}/consent`, {});
    assert('STG_05', 'STG', none.status === 400, `ingen felter → 400 (fik ${none.status})`);
}

// ── CAMPAIGNS_CRUD ───────────────────────────────────────────
async function campaignsCrud() {
    console.log('\n── 4.5 CAMPAIGNS_CRUD ──');
    const cr = await api('POST', '/api/campaigns', { name: `${PREFIX}_CRUD`, description: 'crud' });
    assert('CMP_01', 'CMP', cr.status === 200 && cr.body?.id, `opret (status=${cr.status})`);
    const cid = cr.body?.id; fx.campaigns.CRUD = cid;
    const list = await api('GET', '/api/campaigns?active=1');
    assert('CMP_02', 'CMP', Array.isArray(list.body) && list.body.some(c => c.id === cid), 'vises i active=1');
    const get = await api('GET', `/api/campaigns/${cid}`);
    assert('CMP_03', 'CMP', get.status === 200 && get.body?.id === cid, 'GET /:id');
    const pa = await api('PATCH', `/api/campaigns/${cid}`, { description: 'opdateret' });
    assert('CMP_04', 'CMP', pa.status === 200, `PATCH (status=${pa.status})`);
    const close = await api('POST', `/api/campaigns/${cid}/close`);
    const closed = db.prepare('SELECT is_active, closed_at FROM outreach_campaigns WHERE id = ?').get(cid);
    assert('CMP_05', 'CMP', close.status === 200 && closed.is_active === 0 && closed.closed_at, 'luk → is_active=0 + closed_at');
    const re = await api('POST', `/api/campaigns/${cid}/reopen`);
    assert('CMP_06', 'CMP', re.status === 200 && db.prepare('SELECT is_active FROM outreach_campaigns WHERE id=?').get(cid).is_active === 1, 'genåbn');
}

// ── CAMPAIGN_MEMBERS (kronjuvel) ─────────────────────────────
async function campaignMembers() {
    console.log('\n── 4.6 CAMPAIGN_MEMBERS ──');
    const cr = await api('POST', '/api/campaigns', { name: `${PREFIX}_MEM` });
    const cid = cr.body.id; fx.campaigns.MEM = cid;
    listener.clearEvents();

    // Batch: Alice(B2B firma), Bob(B2C consent=1), Carl(B2C consent=0), Dora(B2C dnc=1)
    const batch = await api('POST', `/api/campaigns/${cid}/members`, { members: [
        { company_id: fx.companies.ACME },
        { customer_id: fx.customers.BOB },
        { customer_id: fx.customers.CARL },
        { customer_id: fx.customers.DORA },
    ]});
    assert('MEM_01', 'MEM', batch.status === 200, `batch status=${batch.status}`);
    assert('MEM_02', 'MEM', batch.body?.added === 2, `2 added (B2B + B2C m/ consent), fik ${batch.body?.added}`);
    const reasons = (batch.body?.skipped || []).map(s => s.reason);
    assert('MEM_03', 'MEM', reasons.includes('no_marketing_consent_b2c'), `Carl skippet (no_marketing_consent_b2c), reasons=${JSON.stringify(reasons)}`);
    assert('MEM_04', 'MEM', reasons.includes('do_not_contact'), 'Dora skippet (do_not_contact)');
    // SSE
    let ev = null;
    try { ev = await listener.waitForEvent('campaign_members_added', e => e.campaign_id === cid, 2500); } catch {}
    assert('MEM_05', 'MEM', ev && ev.data && ev.data.count === 2, `SSE campaign_members_added (count=${ev?.data?.count})`);
    // dedup: tilføj Bob igen
    const dup = await api('POST', `/api/campaigns/${cid}/members`, { members: [{ customer_id: fx.customers.BOB }] });
    assert('MEM_06', 'MEM', dup.status === 200 && dup.body.added === 0 && (dup.body.skipped||[]).some(s => s.reason === 'already_member'),
        `dublet → already_member (added=${dup.body?.added})`);
    // status-skift på Bob's medlemskab
    const bobMember = db.prepare('SELECT id FROM campaign_members WHERE campaign_id=? AND customer_id=?').get(cid, fx.customers.BOB);
    fx.members.BOB = bobMember?.id;
    const pm = await api('PATCH', `/api/campaigns/${cid}/members/${fx.members.BOB}`, { member_status: 'contacted' });
    assert('MEM_07', 'MEM', pm.status === 200 && db.prepare('SELECT member_status FROM campaign_members WHERE id=?').get(fx.members.BOB).member_status === 'contacted',
        `status → contacted (status=${pm.status})`);
    // campaign_id på activity → kun DEN kampagnes last_activity_at
    const beforeLA = db.prepare('SELECT last_activity_at FROM campaign_members WHERE id=?').get(fx.members.BOB).last_activity_at;
    await api('POST', '/api/crm/activity', { customer_id: fx.customers.BOB, type: 'call', text: 'ring', campaign_id: cid });
    const afterLA = db.prepare('SELECT last_activity_at FROM campaign_members WHERE id=?').get(fx.members.BOB).last_activity_at;
    assert('MEM_08', 'MEM', afterLA && afterLA !== beforeLA, 'activity m/ campaign_id opdaterer last_activity_at');
    // DELETE medlem
    const del = await api('DELETE', `/api/campaigns/${cid}/members/${fx.members.BOB}`);
    assert('MEM_09', 'MEM', del.status === 200 && !db.prepare('SELECT 1 FROM campaign_members WHERE id=?').get(fx.members.BOB), `slet medlem (status=${del.status})`);
    // closed campaign → 409
    await api('POST', `/api/campaigns/${cid}/close`);
    const onClosed = await api('POST', `/api/campaigns/${cid}/members`, { members: [{ company_id: fx.companies.ACME }] });
    assert('MEM_10', 'MEM', onClosed.status === 409, `lukket kampagne afviser members → 409 (fik ${onClosed.status})`);
}

// ── PIPELINE (§9) ────────────────────────────────────────────
async function pipeline() {
    console.log('\n── 4.7 PIPELINE ──');
    const loc = db.prepare('SELECT id FROM locations LIMIT 1').get()?.id || 1;
    const nyId = db.prepare("SELECT id FROM status_definitions WHERE code='NY'").get().id;
    const bonId = Number(db.prepare(`
        INSERT INTO bons (bon_number, status_id, location_id, order_date, delivery_date, customer_id, is_offer, price_category)
        VALUES (?, ?, ?, date('now'), date('now','+7 days'), ?, 0, 'catering')
    `).run(`${PREFIX}_PIPE1`, nyId, loc, fx.customers.ALICE).lastInsertRowid);
    fx.bons.PIPE = bonId;

    const bonStatus = () => db.prepare(
        'SELECT sd.code c FROM bons b JOIN status_definitions sd ON b.status_id=sd.id WHERE b.id=?').get(bonId)?.c;

    const p = await api('GET', '/api/crm/pipeline');
    assert('PIP_01', 'PIP', p.status === 200 && p.body?.ny && p.body?.vundet && p.body?.forhandling && p.body?.tilbud_sendt,
        `4 kolonner (status=${p.status})`);
    assert('PIP_02', 'PIP', p.body?.ny?.items?.some(it => it.id === bonId), 'NY-bon i ny-kolonne');

    const mv1 = await api('PATCH', `/api/crm/pipeline/${bonId}/move`, { column: 'forhandling' });
    assert('PIP_03', 'PIP', mv1.status === 200 && bonStatus() === 'VENTER', `→ VENTER (fik ${bonStatus()})`);

    const mv2 = await api('PATCH', `/api/crm/pipeline/${bonId}/move`, { column: 'vundet' });
    assert('PIP_04', 'PIP', mv2.status === 200 && bonStatus() === 'GODKENDT', `→ GODKENDT (fik ${bonStatus()})`);

    const bad = await api('PATCH', `/api/crm/pipeline/${bonId}/move`, { column: 'nonsens' });
    assert('PIP_05', 'PIP', bad.status === 400, `ugyldig kolonne → 400 (fik ${bad.status})`);

    const nf = await api('PATCH', '/api/crm/pipeline/99999999/move', { column: 'ny' });
    assert('PIP_06', 'PIP', nf.status === 404, `ukendt bon → 404 (fik ${nf.status})`);

    listener.clearEvents();
    const mv3 = await api('PATCH', `/api/crm/pipeline/${bonId}/move`, { column: 'tilbud_sendt' });
    const row = db.prepare('SELECT is_offer, offer_status FROM bons WHERE id=?').get(bonId);
    assert('PIP_07', 'PIP', mv3.status === 200 && row.is_offer === 1 && row.offer_status === 'sent',
        `tilbud_sendt → is_offer/offer_status (${row.is_offer}/${row.offer_status})`);
    let ev = null;
    try { ev = await listener.waitForEvent('bon_updated', e => e.id === bonId, 2500); } catch {}
    assert('PIP_08', 'PIP', ev, 'SSE bon_updated ved move');
}

// ── LEAD_IMPORT (§9 — kronjuvel #2) ──────────────────────────
async function leadImport() {
    console.log('\n── 4.8 LEAD_IMPORT ──');
    const coCount = () => db.prepare('SELECT COUNT(*) n FROM companies WHERE notes=?').get(PREFIX).n;
    const cuCount = () => db.prepare('SELECT COUNT(*) n FROM customers WHERE notes=?').get(PREFIX).n;

    // IMP_01 — dry_run rapporterer uden writes
    const co0 = coCount(), cu0 = cuCount();
    const dry = await api('POST', '/api/crm/leads/import', {
        dry_run: true,
        rows: [{ company_name: 'T_CRM Dry Firma', cvr: '10000099', email: 'imp-dry@t-crm.test', first_name: 'DryContact', notes: PREFIX }],
    });
    assert('IMP_01', 'IMP', dry.status === 200 && dry.body?.dry_run === true && dry.body?.rows?.[0]?.company_action
        && coCount() === co0 && cuCount() === cu0, `dry_run uden writes (co ${co0}→${coCount()})`);

    // IMP_02 — opret nyt firma + kontakt
    const imp = await api('POST', '/api/crm/leads/import', {
        rows: [{ company_name: 'T_CRM Import Firma', cvr: '10000099', email: 'imp-a@t-crm.test', first_name: 'ImpAlice', notes: PREFIX }],
    });
    assert('IMP_02', 'IMP', imp.status === 200 && imp.body?.summary?.companies_created >= 1 && imp.body?.summary?.customers_created >= 1,
        `opret firma+kontakt (${JSON.stringify(imp.body?.summary)})`);
    const impCust = db.prepare("SELECT id FROM customers WHERE email='imp-a@t-crm.test'").get()?.id;
    fx.customers.IMP = impCust;

    // IMP_03 — dedup: gentag samme række → 0 nye firmaer, kontakt matched
    const dup = await api('POST', '/api/crm/leads/import', {
        rows: [{ company_name: 'T_CRM Import Firma', cvr: '10000099', email: 'imp-a@t-crm.test', first_name: 'ImpAlice', notes: PREFIX }],
    });
    assert('IMP_03', 'IMP', dup.status === 200 && dup.body.summary.companies_created === 0 && dup.body.summary.customers_matched >= 1,
        `dedup: 0 nye, matched (${JSON.stringify(dup.body.summary)})`);

    // IMP_04 — CVR-match slår navn: andet navn, samme CVR → matched
    const cvrm = await api('POST', '/api/crm/leads/import', {
        rows: [{ company_name: 'Helt Andet Navn', cvr: '10000099', email: 'imp-b@t-crm.test', first_name: 'ImpBob', notes: PREFIX }],
    });
    assert('IMP_04', 'IMP', cvrm.status === 200 && cvrm.body.rows[0].company_action === 'matched',
        `CVR-match trods andet navn (${cvrm.body.rows?.[0]?.company_action})`);

    // IMP_05 — privat lead (kun email) → intet firma
    const priv = await api('POST', '/api/crm/leads/import', {
        rows: [{ is_private: true, email: 'imp-priv@t-crm.test', first_name: 'ImpPriv', notes: PREFIX }],
    });
    const privCust = db.prepare("SELECT company_id FROM customers WHERE email='imp-priv@t-crm.test'").get();
    assert('IMP_05', 'IMP', priv.status === 200 && privCust && privCust.company_id === null,
        `privat lead uden firma (company_id=${privCust?.company_id})`);

    // IMP_06 — stage-guard: eksisterende VIP nedgraderes ALDRIG til lead
    const vipCust = Number(db.prepare(
        'INSERT INTO customers (company_id, first_name, last_name, email, is_active, notes) VALUES (NULL,?,?,?,1,?)'
    ).run(`${PREFIX}_VipLead`, 'Test', 'imp-vip@t-crm.test', PREFIX).lastInsertRowid);
    db.prepare("INSERT INTO crm_customer_meta (customer_id, stage) VALUES (?, 'vip')").run(vipCust);
    const vipImp = await api('POST', '/api/crm/leads/import', {
        rows: [{ is_private: true, email: 'imp-vip@t-crm.test', first_name: 'X', notes: PREFIX }],
    });
    assert('IMP_06', 'IMP', vipImp.status === 200 && meta(vipCust)?.stage === 'vip',
        `VIP nedgraderes IKKE til lead (stage=${meta(vipCust)?.stage})`);

    // IMP_07 — kontaktpunkt oprettet med is_public=0 (juridisk sikker default)
    const cp = impCust ? db.prepare(
        "SELECT is_public FROM contact_points WHERE entity_type='customer' AND entity_id=? AND kind='email'").get(impCust) : null;
    assert('IMP_07', 'IMP', cp && cp.is_public === 0, `contact_point is_public=0 (${cp?.is_public})`);

    // IMP_08 — batch-tag gemmes i crm_customer_meta.tags
    const tagImp = await api('POST', '/api/crm/leads/import', {
        tag: 'T_CRM_batch',
        rows: [{ company_name: 'T_CRM Tag Firma', cvr: '10000098', email: 'imp-tag@t-crm.test', first_name: 'ImpTag', notes: PREFIX }],
    });
    const tagCust = db.prepare("SELECT id FROM customers WHERE email='imp-tag@t-crm.test'").get()?.id;
    const tags = tagCust ? (JSON.parse(meta(tagCust)?.tags || '[]') || []) : [];
    assert('IMP_08', 'IMP', tagImp.status === 200 && tags.includes('T_CRM_batch'), `tag gemt (${JSON.stringify(tags)})`);

    // IMP_09 — validering: tom rows → 400
    const empty = await api('POST', '/api/crm/leads/import', { rows: [] });
    assert('IMP_09', 'IMP', empty.status === 400, `tom rows → 400 (fik ${empty.status})`);

    // IMP_10 — række-isolation: dårlig række fejler, resten importeres
    listener.clearEvents();
    const mixed = await api('POST', '/api/crm/leads/import', {
        rows: [
            { notes: PREFIX }, // hverken firmanavn eller CVR → række-fejl
            { company_name: 'T_CRM God Firma', cvr: '10000097', email: 'imp-good@t-crm.test', first_name: 'ImpGood', notes: PREFIX },
        ],
    });
    const goodMade = !!db.prepare("SELECT 1 FROM customers WHERE email='imp-good@t-crm.test'").get();
    assert('IMP_10', 'IMP', mixed.status === 200 && mixed.body.summary.errors === 1 && goodMade,
        `dårlig række isoleret, god importeret (errors=${mixed.body?.summary?.errors})`);

    // IMP_11 — SSE crm_stage_changed ved writes
    let ev = null;
    try { ev = await listener.waitForEvent('crm_stage_changed', e => e.source === 'lead_import', 2500); } catch {}
    assert('IMP_11', 'IMP', ev, 'SSE crm_stage_changed ved import');
}

// ── COMPANIES (Track 3 — CRUD + economic + extract + enrich-guard) ──
async function companies() {
    console.log('\n── 4.9 COMPANIES ──');

    // CO_01 — opret firma (verificerer også lastInsertRowid-serialisering)
    const created = await api('POST', '/api/companies', { name: 'T_CRM_CoNew', notes: PREFIX });
    assert('CO_01', 'CO', created.status === 200 && created.body?.id, `opret firma (status=${created.status}, id=${created.body?.id})`);
    const coId = created.body?.id ? Number(created.body.id) : null;
    fx.companies.NEW = coId;

    // CO_02 — hent firma
    const got = coId ? await api('GET', `/api/companies/${coId}`) : { status: 0 };
    assert('CO_02', 'CO', got.status === 200 && got.body?.name === 'T_CRM_CoNew', `GET firma (navn=${got.body?.name})`);

    // CO_03 — søg (q ≥ 2 tegn)
    const search = await api('GET', '/api/companies?q=T_CRM_CoNew');
    assert('CO_03', 'CO', search.status === 200 && Array.isArray(search.body) && search.body.some(c => c.id === coId),
        `søgning finder firmaet (${search.body?.length} hits)`);

    // CO_04 — e-conomic-nr
    const econ = coId ? await api('PATCH', `/api/companies/${coId}/economic`, { economic_customer_id: 'ECON-777' }) : { status: 0 };
    const econSaved = coId ? db.prepare('SELECT economic_customer_id e FROM companies WHERE id=?').get(coId)?.e : null;
    assert('CO_04', 'CO', econ.status === 200 && econSaved === 'ECON-777', `economic-nr gemt (${econSaved})`);

    // CO_05 — ukendt firma → 404
    const nf = await api('GET', '/api/companies/99999999');
    assert('CO_05', 'CO', nf.status === 404, `ukendt firma → 404 (fik ${nf.status})`);

    // CO_06 — identifiers: ugyldigt CVR → 400, gyldigt → gemt
    const badCvr = coId ? await api('PATCH', `/api/companies/${coId}/identifiers`, { cvr: '123' }) : { status: 0 };
    assert('CO_06a', 'CO', badCvr.status === 400, `CVR 3 cifre → 400 (fik ${badCvr.status})`);
    const okCvr = coId ? await api('PATCH', `/api/companies/${coId}/identifiers`, { cvr: '12345678' }) : { status: 0 };
    const cvrSaved = coId ? db.prepare('SELECT cvr FROM companies WHERE id=?').get(coId)?.cvr : null;
    assert('CO_06b', 'CO', okCvr.status === 200 && cvrSaved === '12345678', `CVR 8 cifre gemt (${cvrSaved})`);

    // CO_07 — extract-contacts (paste-flow, deterministisk regex)
    const pasteText = 'Kontakt vores catering-afdeling på kontakt@t-crm-eksempel.dk eller ring på +45 12 34 56 78 i hverdagene mellem 9 og 16.';
    const ext = coId ? await api('POST', `/api/companies/${coId}/extract-contacts`, { text: pasteText }) : { status: 0 };
    const emails = (ext.body?.candidates || []).filter(c => c.kind === 'email').map(c => c.value.toLowerCase());
    assert('CO_07', 'CO', ext.status === 200 && ext.body?.ok && emails.includes('kontakt@t-crm-eksempel.dk'),
        `extract fandt email (${JSON.stringify(emails)})`);

    // CO_08 — extract validering: for kort tekst → 400
    const short = coId ? await api('POST', `/api/companies/${coId}/extract-contacts`, { text: 'kort' }) : { status: 0 };
    assert('CO_08', 'CO', short.status === 400, `for kort tekst → 400 (fik ${short.status})`);

    // CO_09 — enrich-preview guard: ukendt firma → 404 (deterministisk, ingen netværk)
    const enrNf = await api('GET', '/api/companies/99999999/enrich-preview');
    assert('CO_09', 'CO', enrNf.status === 404, `enrich-preview ukendt firma → 404 (fik ${enrNf.status})`);
}

// ── CONTACT_POINTS (Track 3 — CRUD + cache-sync + promote + 053-trigger) ──
async function contactPoints() {
    console.log('\n── 4.10 CONTACT_POINTS ──');
    const co = fx.companies.ACME;
    const coEmail = () => db.prepare('SELECT email FROM companies WHERE id=?').get(co)?.email;
    const cpPrimary = (id) => db.prepare('SELECT is_primary FROM contact_points WHERE id=?').get(id)?.is_primary;

    // CP_01 — opret primær email → cache synkes til companies.email
    const c1 = await api('POST', '/api/contact-points', { entity_type: 'company', entity_id: co, kind: 'email', value: 'primary1@t-crm.test', is_primary: 1 });
    fx.cp.P1 = c1.body?.id;
    assert('CP_01', 'CP', c1.status === 201 && coEmail() === 'primary1@t-crm.test', `primær email → cache (${coEmail()})`);

    // CP_02 — ny primær demoterer den gamle + opdaterer cache
    const c2 = await api('POST', '/api/contact-points', { entity_type: 'company', entity_id: co, kind: 'email', value: 'primary2@t-crm.test', is_primary: 1 });
    fx.cp.P2 = c2.body?.id;
    assert('CP_02', 'CP', c2.status === 201 && cpPrimary(fx.cp.P1) === 0 && coEmail() === 'primary2@t-crm.test',
        `ny primær demoterer gammel (P1.primary=${cpPrimary(fx.cp.P1)}, cache=${coEmail()})`);

    // CP_03 — dublet (aktiv) → 409
    const dup = await api('POST', '/api/contact-points', { entity_type: 'company', entity_id: co, kind: 'email', value: 'primary2@t-crm.test' });
    assert('CP_03', 'CP', dup.status === 409, `aktiv dublet → 409 (fik ${dup.status})`);

    // CP_04 — validering
    const badKind = await api('POST', '/api/contact-points', { entity_type: 'company', entity_id: co, kind: 'fax', value: 'x@y.dk' });
    assert('CP_04a', 'CP', badKind.status === 400, `ugyldig kind → 400 (fik ${badKind.status})`);
    const noEntity = await api('POST', '/api/contact-points', { entity_type: 'company', entity_id: 99999999, kind: 'email', value: 'a@b.dk' });
    assert('CP_04b', 'CP', noEntity.status === 404, `ukendt entity → 404 (fik ${noEntity.status})`);
    const badVal = await api('POST', '/api/contact-points', { entity_type: 'company', entity_id: co, kind: 'email', value: 'ikke-en-email' });
    assert('CP_04c', 'CP', badVal.status === 400, `ugyldig email-værdi → 400 (fik ${badVal.status})`);

    // CP_05 — toggle-public
    const before = db.prepare('SELECT is_public FROM contact_points WHERE id=?').get(fx.cp.P2)?.is_public;
    const tog = await api('PATCH', `/api/contact-points/${fx.cp.P2}/toggle-public`);
    const after = db.prepare('SELECT is_public FROM contact_points WHERE id=?').get(fx.cp.P2)?.is_public;
    assert('CP_05', 'CP', tog.status === 200 && after !== before, `toggle-public (${before}→${after})`);

    // CP_06 — slet primær → næste promoveres + cache opdateres
    const del = await api('DELETE', `/api/contact-points/${fx.cp.P2}`);
    assert('CP_06', 'CP', del.status === 200 && cpPrimary(fx.cp.P1) === 1 && coEmail() === 'primary1@t-crm.test',
        `slet primær promoverer næste (P1.primary=${cpPrimary(fx.cp.P1)}, cache=${coEmail()})`);

    // CP_07 — liste
    const list = await api('GET', `/api/contact-points?entity_type=company&entity_id=${co}`);
    assert('CP_07', 'CP', list.status === 200 && Array.isArray(list.body) && list.body.some(c => c.id === fx.cp.P1),
        `liste indeholder P1 (${list.body?.length} rækker)`);

    // CP_08 — 053-trigger: direkte UPDATE companies.email → synk til contact_points
    db.prepare("UPDATE companies SET email='trigger@t-crm.test' WHERE id=?").run(co);
    const trg = db.prepare("SELECT 1 FROM contact_points WHERE entity_type='company' AND entity_id=? AND kind='email' AND value='trigger@t-crm.test' AND is_primary=1 AND is_active=1").get(co);
    assert('CP_08', 'CP', !!trg, '053-trigger: legacy companies.email-UPDATE synket til contact_point');
}

// ── READONLY (Track 4 — aggregater, smoke: status + form) ────
async function readonly() {
    console.log('\n── 4.11 READONLY ──');
    const stats = await api('GET', '/api/crm/stats');
    assert('RO_01', 'RO', stats.status === 200 && stats.body && typeof stats.body === 'object' && !Array.isArray(stats.body), `stats objekt (status=${stats.status})`);

    const brief = await api('GET', '/api/crm/briefing');
    assert('RO_02', 'RO', brief.status === 200 && Array.isArray(brief.body), `briefing array (status=${brief.status})`);

    const sug = await api('GET', '/api/crm/suggestions');
    assert('RO_03', 'RO', sug.status === 200 && sug.body !== null, `suggestions 200 (status=${sug.status})`);

    const sc = await api('GET', '/api/crm/service-calls?days=14');
    assert('RO_04', 'RO', sc.status === 200 && Array.isArray(sc.body), `service-calls array (status=${sc.status})`);

    const cust = await api('GET', '/api/crm/customers');
    const custVip = await api('GET', '/api/crm/customers?stage=vip');
    assert('RO_05', 'RO', cust.status === 200 && Array.isArray(cust.body) && custVip.status === 200 && Array.isArray(custVip.body),
        `customers + stage-filter arrays (${cust.status}/${custVip.status})`);

    const cb = await api('GET', '/api/crm/callbacks');
    assert('RO_06', 'RO', cb.status === 200 && Array.isArray(cb.body?.callbacks) && Array.isArray(cb.body?.hard_to_reach), `callbacks + hard_to_reach (status=${cb.status})`);

    const dorm = await api('GET', '/api/crm/dormant');
    assert('RO_07', 'RO', dorm.status === 200 && Array.isArray(dorm.body), `dormant array (status=${dorm.status})`);

    const cl = await api('GET', '/api/crm/call-log');
    assert('RO_08', 'RO', cl.status === 200 && Array.isArray(cl.body), `call-log array (status=${cl.status})`);

    const cs = await api('GET', '/api/crm/call-stats');
    assert('RO_09', 'RO', cs.status === 200 && cs.body && Array.isArray(cs.body.weekly) && cs.body.results !== undefined,
        `call-stats objekt m/ weekly (status=${cs.status})`);

    const mu = await api('GET', '/api/crm/meetings/upcoming?days=14');
    assert('RO_10', 'RO', mu.status === 200 && Array.isArray(mu.body), `meetings/upcoming array (status=${mu.status})`);
}

// ── EDGE + CONSENT-API (Track 5) ─────────────────────────────
async function edge() {
    console.log('\n── 4.12 EDGE ──');
    // EDGE_01 — SQL-injection i customers?q= må ikke sprænge (parameteriseret)
    const inj = await api('GET', `/api/crm/customers?q=${encodeURIComponent("'; DROP TABLE customers; --")}`);
    const aliceStillThere = !!db.prepare('SELECT 1 FROM customers WHERE id=?').get(fx.customers.ALICE);
    assert('EDGE_01', 'EDGE', inj.status === 200 && aliceStillThere, `SQL-injection i q håndteret sikkert (status=${inj.status}, tabel intakt=${aliceStillThere})`);

    // EDGE_02 — æøå + emoji i q
    const uni = await api('GET', `/api/crm/customers?q=${encodeURIComponent('Ærø-Ø 🍞')}`);
    assert('EDGE_02', 'EDGE', uni.status === 200 && Array.isArray(uni.body), `unicode i q → 200 (status=${uni.status})`);

    // EDGE_03 — injection i companies?q=
    const coInj = await api('GET', `/api/companies?q=${encodeURIComponent("x' OR '1'='1")}`);
    assert('EDGE_03', 'EDGE', coInj.status === 200 && Array.isArray(coInj.body), `companies q injection → 200 array (status=${coInj.status})`);

    // EDGE_04 — meget lang aktivitets-tekst
    const longText = 'x'.repeat(8000);
    const longAct = await api('POST', '/api/crm/activity', { customer_id: fx.customers.ALICE, type: 'note', text: longText });
    const savedLen = longAct.body?.id ? db.prepare('SELECT length(text) n FROM crm_activities WHERE id=?').get(longAct.body.id)?.n : 0;
    assert('EDGE_04', 'EDGE', longAct.status === 200 && savedLen === 8000, `8000-tegns note gemt uden trunkering (len=${savedLen})`);

    // EDGE_05 — ikke-numerisk customer-id → 404 (parseInt NaN-guard)
    const nan = await api('GET', '/api/crm/customer/abc');
    assert('EDGE_05', 'EDGE', nan.status === 404, `ikke-numerisk id → 404 (fik ${nan.status})`);

    // CONS_01 — consent-felter eksponeres på Kunde 360° (spec §1.3-gap: API-siden er dækket).
    // Felterne ligger nested under body.customer (res.json({ customer, stats, ... })).
    const bob = await api('GET', `/api/crm/customer/${fx.customers.BOB}`);
    const c = bob.body?.customer;
    const hasConsent = c && ('marketing_consent' in c) && ('do_not_contact' in c);
    assert('CONS_01', 'EDGE', bob.status === 200 && hasConsent && c.marketing_consent === 1,
        `customer.marketing_consent eksponeret (=${c?.marketing_consent})`);
}

// ── CLEANUP ──────────────────────────────────────────────────
function cleanup() {
    console.log('\n── CLEANUP ──');
    // Pipeline-bons (+ afledte rækker) ryddes eksplicit — bons har ikke notes-markør
    const bonIds = Object.values(fx.bons).filter(Boolean);
    if (bonIds.length) {
        const ph0 = bonIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM bon_lines WHERE bon_id IN (${ph0})`).run(...bonIds);
        db.prepare(`DELETE FROM changelog WHERE entity_type='bon' AND entity_id IN (${ph0})`).run(...bonIds);
        db.prepare(`DELETE FROM bons WHERE id IN (${ph0})`).run(...bonIds);
    }
    // T_CRM-firmaer: ryd afledte rfm_scores + contact_points + changelog (import/enrich skriver dem)
    const coIds = db.prepare("SELECT id FROM companies WHERE notes = ?").all(PREFIX).map(r => r.id);
    if (coIds.length) {
        const ph0 = coIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM rfm_scores WHERE company_id IN (${ph0})`).run(...coIds);
        db.prepare(`DELETE FROM contact_points WHERE entity_type='company' AND entity_id IN (${ph0})`).run(...coIds);
        db.prepare(`DELETE FROM changelog WHERE entity_type='company' AND entity_id IN (${ph0})`).run(...coIds);
    }
    const custIds = db.prepare("SELECT id FROM customers WHERE notes = ?").all(PREFIX).map(r => r.id);
    if (custIds.length) {
        const ph0 = custIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM contact_points WHERE entity_type='customer' AND entity_id IN (${ph0})`).run(...custIds);
        db.prepare(`DELETE FROM changelog WHERE entity_type='customer' AND entity_id IN (${ph0})`).run(...custIds);
    }
    const campIds = db.prepare("SELECT id FROM outreach_campaigns WHERE name LIKE ?").all(`${PREFIX}\\_%` .replace('\\_','_') + '%').map(r => r.id);
    const ph = (a) => a.map(() => '?').join(',');
    if (custIds.length) {
        db.prepare(`DELETE FROM crm_activities WHERE customer_id IN (${ph(custIds)})`).run(...custIds);
        db.prepare(`DELETE FROM campaign_members WHERE customer_id IN (${ph(custIds)})`).run(...custIds);
        db.prepare(`DELETE FROM crm_customer_meta WHERE customer_id IN (${ph(custIds)})`).run(...custIds);
    }
    db.prepare("DELETE FROM campaign_members WHERE company_id IN (SELECT id FROM companies WHERE notes = ?)").run(PREFIX);
    db.prepare("DELETE FROM customers WHERE notes = ?").run(PREFIX);
    db.prepare("DELETE FROM companies WHERE notes = ?").run(PREFIX);
    db.prepare("DELETE FROM outreach_campaigns WHERE name LIKE 'T_CRM\\_%' ESCAPE '\\'").run();
    const left = db.prepare("SELECT COUNT(*) n FROM customers WHERE notes = ?").get(PREFIX).n
        + db.prepare("SELECT COUNT(*) n FROM companies WHERE notes = ?").get(PREFIX).n
        + db.prepare("SELECT COUNT(*) n FROM outreach_campaigns WHERE name LIKE 'T_CRM\\_%' ESCAPE '\\'").get().n;
    assert('CLEAN_01', 'CLEAN', left === 0, `alt T_CRM-data fjernet (rest=${left})`);
}

async function main() {
    safetyCheck();
    db = openDb(process.env.DB_PATH);
    console.log(`[run_T_CRM] server=${SERVER_URL}`);
    try {
        await setup();
        await customer360();
        await activities();
        await stageConsent();
        await campaignsCrud();
        await campaignMembers();
        await pipeline();
        await leadImport();
        await companies();
        await contactPoints();
        await readonly();
        await edge();
    } catch (e) {
        console.error('[run_T_CRM] FEJL:', e.message);
        rec('RUN', 'RUN', false, e.message);
    } finally {
        try { cleanup(); } catch (e) { rec('CLEAN', 'CLEAN', false, e.message); }
        if (listener) listener.disconnect();
        db.close();
    }
    const pass = results.filter(r => r.ok).length, fail = results.filter(r => !r.ok).length;
    console.log(`\n[run_T_CRM] ${pass} PASS · ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
}
main();
