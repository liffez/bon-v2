#!/usr/bin/env node
'use strict';
/**
 * scripts/economic-blocking-report.js
 * ────────────────────────────────────────────────────────────
 * READ-ONLY: hvilke opskrifter blokerer faktureringen, og hvad udelades?
 *
 * Efter #454 afgøres "faktureres ikke" pr. VARE, ikke pr. kategori. Denne rapport
 * viser konsekvensen på ægte data, så koblingsarbejdet i Grocy kan planlægges FØR
 * en bon står og venter: hvilke opskrifter mangler et e-conomic varenr, hvilke KUNDER
 * mangler en kobling, hvor mange bons det rammer, og hvad udelades bevidst.
 *
 * Skriver ALDRIG. Kan køres mod drift.
 *
 * Loader selv .env (som scripts/economic-product-match.js) — koblingerne ligger i
 * Grocy, og Node loader ikke .env af sig selv. `--env-file=.env` virker også.
 *
 *   node --experimental-sqlite scripts/economic-blocking-report.js
 *   node --experimental-sqlite scripts/economic-blocking-report.js --all --since 2026-01-01
 *
 *   --all       alle fakturerbare bons, ikke kun dem i køen (LEVERET, endnu ikke sendt)
 *   --since     kun bons leveret fra denne dato (default: 90 dage tilbage)
 *   --vis-bons  navngiv de blokerede bons (bon-nr, dato, kunde, status), så man kan
 *               gå direkte til dem i faktureringen
 * ────────────────────────────────────────────────────────────
 */
require('dotenv').config({ quiet: true });
const { getDb } = require('../db/database');
const { offsetISO } = require('../db/helpers');
const economicInvoice = require('../services/economicInvoice');
const grocyAdapter = require('../services/grocyAdapter');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
const VIS_BONS = args.includes('--vis-bons');
const SINCE = (args[args.indexOf('--since') + 1] || '').match(/^\d{4}-\d{2}-\d{2}$/)
    ? args[args.indexOf('--since') + 1] : offsetISO(-90);

const kr = (n) => (n ?? 0).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
    const db = getDb();
    const settings = economicInvoice.getEconomicSettings(db);

    let productMap, bundleMap;
    try {
        [productMap, bundleMap] = await Promise.all([
            grocyAdapter.getEconomicProductMap(), grocyAdapter.getEconomicBundleMap(),
        ]);
    } catch (e) {
        console.error(`Kunne ikke hente koblinger fra Grocy: ${e.message}`);
        if (!process.env.GROCY_HQ_KEY && !process.env.GROCY_HQ_URL) {
            console.error('\nIngen GROCY_*-variabler er indlæst. Scriptet leder efter .env i den mappe');
            console.error('det køres fra — kør det fra projektroden, eller peg på filen:');
            console.error('  node --env-file=/sti/til/.env --experimental-sqlite scripts/economic-blocking-report.js\n');
        } else {
            console.error('Rapporten kræver adgang til den Grocy-instans der bærer economic_product_number (grocy-hq).');
        }
        process.exit(2);
    }

    const rows = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.delivery_price,
               b.delivery_vehicle_id, b.company_id, b.customer_id, sd.code AS status_code,
               COALESCE(co.name, TRIM(c.first_name || ' ' || c.last_name)) AS company_name,
               -- checkReadiness læser kunden som NESTEDE objekter (bon.company.…),
               -- ikke flade kolonner. Uden dem meldte rapporten "mangler kunde" på alt.
               co.name AS co_name, co.ean AS co_ean, co.economic_customer_id AS co_eco,
               c.economic_customer_id AS cu_eco, c.economic_contact_id AS cu_kontakt
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN companies co ON co.id = b.company_id
        LEFT JOIN customers c  ON c.id  = b.customer_id
        WHERE b.payment_type = 'invoice'
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
          AND b.delivery_date >= ?
          ${ALL ? '' : "AND sd.code = 'LEVERET' AND b.economic_draft_number IS NULL"}
        ORDER BY b.delivery_date
    `).all(SINCE);

    const lineSql = db.prepare(`
        SELECT id, product_name, quantity, unit_price, line_total, category, grocy_recipe_id
        FROM bon_lines WHERE bon_id = ? ORDER BY sort_order, id
    `);

    const blocking = new Map();   // recipe-nøgle → { navn, bons:Set, kr, kategori }
    const excluded = new Map();
    // Kunde-siden: en manglende kobling på firmaet blokerer hele bonen, uanset varerne.
    // Den er lige så almindelig som manglende varenumre — og var usynlig her.
    const kunder = new Map();
    let blockedBons = 0, okBons = 0;
    const blockedList = [];

    for (const b of rows) {
        const lines = lineSql.all(b.id);
        for (const l of lines) {
            const rid = l.grocy_recipe_id != null ? Number(l.grocy_recipe_id) : null;
            l.economic_product_number = rid != null ? (productMap.get(rid) ?? null) : null;
            l.economic_bundle = (l.economic_product_number == null && rid != null)
                ? (bundleMap.get(rid) ?? null) : null;
        }
        const beriget = {
            ...b, lines,
            company:  b.company_id  ? { name: b.co_name, ean: b.co_ean, economic_customer_id: b.co_eco } : null,
            customer: b.customer_id ? { economic_customer_id: b.cu_eco, economic_contact_id: b.cu_kontakt } : null,
        };
        const r = economicInvoice.checkReadiness(beriget, settings);

        if (r.missingCustomer || r.eanWithoutContact) {
            const key = b.company_id ?? `kunde:${b.customer_id}`;
            const hit = kunder.get(key) || {
                navn: b.company_name || '—', bons: new Set(), kr: 0,
                grund: r.missingCustomer ? 'mangler kunde-nr' : 'EAN uden kontaktperson',
            };
            hit.bons.add(b.id);
            hit.kr += lines.reduce((sum, l) => sum + economicInvoice.lineAmount(l), 0);
            kunder.set(key, hit);
        }

        if (r.missingProducts.length) {
            blockedBons++;
            blockedList.push({ ...b, varer: r.missingProducts.map(m => m.product_name.trim()),
                               beløb: r.missingProducts.reduce((sum, m) => sum + (m.amount || 0), 0) });
        } else okBons++;

        const tally = (map, e) => {
            const key = e.grocy_recipe_id ?? `fritekst:${e.product_name}`;
            const hit = map.get(key) || { navn: e.product_name, bons: new Set(), kr: 0, rid: e.grocy_recipe_id };
            hit.bons.add(b.id); hit.kr += e.amount || 0;
            map.set(key, hit);
        };
        r.missingProducts.forEach(e => tally(blocking, e));
        r.excluded.forEach(e => tally(excluded, e));
    }

    const table = (map, title) => {
        console.log(`\n── ${title} ──`);
        if (!map.size) return console.log('  (ingen)');
        [...map.values()].sort((a, b2) => b2.bons.size - a.bons.size).forEach(v => {
            console.log(`  ${String(v.rid ?? '—').padStart(4)}  ${String(v.navn).slice(0, 38).padEnd(40)}`
                + `${String(v.bons.size).padStart(4)} bons  ${kr(v.kr).padStart(12)} kr inkl.`);
        });
    };

    console.log(`\ne-conomic — blokerings-rapport`);
    console.log(`${rows.length} bons ${ALL ? '(alle fakturerbare)' : '(kø: LEVERET, ikke sendt)'} fra ${SINCE}`);
    const kundeBons = new Set([...kunder.values()].flatMap(v => [...v.bons]));
    console.log(`${okBons} uden blokerende linjer · ${blockedBons} blokeret af varer`
        + (kundeBons.size ? ` · ${kundeBons.size} blokeret af manglende kunde-kobling` : ''));
    table(blocking, 'Blokerer — mangler et e-conomic varenr');
    table(excluded, 'Udelades bevidst — "faktureres ikke" eller 0 kr');

    if (kunder.size) {
        console.log('\n── Blokerer — kunden mangler en e-conomic-kobling ──');
        [...kunder.values()].sort((a, b2) => b2.bons.size - a.bons.size).forEach(v => {
            console.log(`  ${String(v.navn).slice(0, 40).padEnd(42)}${String(v.bons.size).padStart(4)} bons  `
                + `${kr(v.kr).padStart(12)} kr inkl.   ${v.grund}`);
        });
        console.log('\n  Kunde-nr sættes på firmaet (CRM → Kontakter → Firmaer → e-conomic ✎),');
        console.log('  eller med "Foreslå kunde fra e-conomic" i faktureringen.');
    }

    if (VIS_BONS && blockedList.length) {
        console.log('\n── De blokerede bons ──');
        for (const b of blockedList) {
            console.log(`  #${String(b.bon_number).padEnd(10)} ${b.delivery_date}  ${String(b.status_code).padEnd(11)}`
                + `${String(b.company_name || '—').slice(0, 26).padEnd(28)}${kr(b.beløb).padStart(11)} kr`);
            console.log(`     ${b.varer.join(' · ')}`);
        }
    } else if (blockedList.length) {
        console.log(`\n(kør med --vis-bons for at se hvilke ${blockedList.length} bons det er)`);
    }
    console.log('\nBeløb er INKL moms (bon_lines.line_total, jf. §6b).');
    console.log('Blokerende opskrifter kobles i Grocy, eller sættes på settings.economic_noninvoice_recipes.\n');
})().catch(e => { console.error(e); process.exit(1); });
