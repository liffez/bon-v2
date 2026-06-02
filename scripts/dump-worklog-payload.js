/**
 * scripts/dump-worklog-payload.js — ENGANGS-DIAGNOSTIK
 *
 * Henter RÅ worklog-objekter fra Smartplan for at afgøre §5 i
 * CLAUDE_DRIFTSREGNSKAB.md: bærer worklog-objektet sats/beløb/løntype,
 * eller kun timer? Og: har det faktiske start/slut-tider (start_dt/end_dt)
 * ud over de planlagte (planned_start_dt/planned_end_dt)?
 *
 * Kør:  node --experimental-sqlite scripts/dump-worklog-payload.js
 *       (valgfrit datointerval:)  ... 2026-05-01 2026-05-20
 *
 * Læser .env fra projekt-roden. Skriver ikke noget — kun læsning.
 */

require('dotenv').config({ quiet: true });

const TOKEN_URL = process.env.SMARTPLAN_TOKEN_URL || 'https://api.smartplanapp.io/o/token/';
const API_BASE  = process.env.SMARTPLAN_API_BASE  || 'https://api.smartplanapp.io/v2';

async function getToken() {
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.SMARTPLAN_CLIENT_ID,
        client_secret: process.env.SMARTPLAN_CLIENT_SECRET,
    });
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`token ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).access_token;
}

async function getAccountUUID(token) {
    const res = await fetch(`${API_BASE}/accounts/`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`accounts ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).results[0].uuid;
}

function flattenKeys(obj, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            Object.assign(out, flattenKeys(v, key));
        } else {
            out[key] = Array.isArray(v) ? `[array len ${v.length}]` : v;
        }
    }
    return out;
}

(async () => {
    const today = new Date();
    const past = new Date(today.getTime() - 21 * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const from = process.argv[2] || fmt(past);
    const to   = process.argv[3] || fmt(today);

    console.log(`\n=== Smartplan worklog-dump  ${from} → ${to} ===\n`);

    const token = await getToken();
    const uuid  = await getAccountUUID(token);

    const url = `${API_BASE}/accounts/${uuid}/worklogs/?start_date=${from}&end_date=${to}&ordering=planned_start_dt`;
    const res = await fetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`worklogs ${res.status}: ${text.slice(0, 300)}`);

    const json = JSON.parse(text);
    const results = json.results || [];
    console.log(`Antal worklogs i intervallet: ${results.length}\n`);

    if (!results.length) {
        console.log('Ingen worklogs — prøv et interval hvor der var arbejde, fx:');
        console.log('  node --experimental-sqlite scripts/dump-worklog-payload.js 2026-04-01 2026-04-30');
        return;
    }

    // 1) Alle top-level + nested nøgler set på tværs af samtlige worklogs
    const allKeys = new Set();
    for (const wl of results) {
        for (const k of Object.keys(flattenKeys(wl))) allKeys.add(k);
    }

    // 2) De felter §5 spørger om
    const WAGE_HINTS = ['wage', 'salary', 'rate', 'amount', 'cost', 'price', 'pay', 'sats', 'loen', 'løn', 'money', 'hourly'];
    const TIME_HINTS = ['start_dt', 'end_dt', 'planned_start', 'planned_end', 'actual', 'clock', 'punch', 'break', 'hours', 'duration'];

    const wageKeys = [...allKeys].filter(k => WAGE_HINTS.some(h => k.toLowerCase().includes(h)));
    const timeKeys = [...allKeys].filter(k => TIME_HINTS.some(h => k.toLowerCase().includes(h)));

    console.log('── §5: LØN-RELATEREDE FELTER (sats/beløb/løntype?) ──');
    console.log(wageKeys.length ? wageKeys.map(k => '  • ' + k).join('\n') : '  ⚠ INGEN løn/sats/beløb-felter fundet i payloadet.');

    console.log('\n── PLANLAGT vs. FAKTISK TID ──');
    console.log(timeKeys.length ? timeKeys.map(k => '  • ' + k).join('\n') : '  (ingen tids-felter matchede)');

    console.log('\n── ALLE NØGLER (fladt) ──');
    console.log([...allKeys].sort().map(k => '  ' + k).join('\n'));

    console.log('\n── FØRSTE WORKLOG, RÅ JSON ──');
    console.log(JSON.stringify(results[0], null, 2));
})().catch(e => {
    console.error('\nFEJL:', e.message);
    process.exit(1);
});
