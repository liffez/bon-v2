#!/usr/bin/env node
'use strict';
/**
 * scripts/economic-blocking-report.js
 * ────────────────────────────────────────────────────────────
 * READ-ONLY: hvilke opskrifter blokerer faktureringen, og hvad udelades?
 *
 * Efter #454 afgøres "faktureres ikke" pr. VARE, ikke pr. kategori. Denne rapport
 * viser konsekvensen på ægte data, så koblingsarbejdet i Grocy kan planlægges FØR
 * en bon står og venter: hvilke opskrifter mangler et e-conomic varenr, hvor mange
 * bons rammer det, og hvad udelades bevidst.
 *
 * Skriver ALDRIG. Kan køres mod drift.
 *
 * Loader selv .env (som scripts/economic-product-match.js) — koblingerne ligger i
 * Grocy, og Node loader ikke .env af sig selv. `--env-file=.env` virker også.
 *
 *   node --experimental-sqlite scripts/economic-blocking-report.js
 *   node --experimental-sqlite scripts/economic-blocking-report.js --all --since 2026-01-01
 *
 *   --all     alle fakturerbare bons, ikke kun dem i køen (LEVERET, endnu ikke sendt)
 *   --since   kun bons leveret fra denne dato (default: 90 dage tilbage)
 * ────────────────────────────────────────────────────────────
 */
require('dotenv').config({ quiet: true });
const { getDb } = require('../db/database');
const { offsetISO } = require('../db/helpers');
const economicInvoice = require('../services/economicInvoice');
const grocyAdapter = require('../services/grocyAdapter');

const args = process.argv.slice(2);
const ALL = args.includes('--all');
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
               b.delivery_vehicle_id, co.name AS company_name
        FROM bons b
        JOIN status_definitions sd ON sd.id = b.status_id
        LEFT JOIN companies co ON co.id = b.company_id
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
    let blockedBons = 0, okBons = 0;

    for (const b of rows) {
        const lines = lineSql.all(b.id);
        for (const l of lines) {
            const rid = l.grocy_recipe_id != null ? Number(l.grocy_recipe_id) : null;
            l.economic_product_number = rid != null ? (productMap.get(rid) ?? null) : null;
            l.economic_bundle = (l.economic_product_number == null && rid != null)
                ? (bundleMap.get(rid) ?? null) : null;
        }
        const r = economicInvoice.checkReadiness({ ...b, lines }, settings);
        if (r.missingProducts.length) blockedBons++; else okBons++;

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
    console.log(`${okBons} uden blokerende linjer · ${blockedBons} blokeret`);
    table(blocking, 'Blokerer — mangler et e-conomic varenr');
    table(excluded, 'Udelades bevidst — "faktureres ikke" eller 0 kr');
    console.log('\nBeløb er INKL moms (bon_lines.line_total, jf. §6b).');
    console.log('Blokerende opskrifter kobles i Grocy, eller sættes på settings.economic_noninvoice_recipes.\n');
})().catch(e => { console.error(e); process.exit(1); });
