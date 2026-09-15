#!/usr/bin/env node
// scripts/remap-deleted-recipes.js
// ==========================================
// Peg slettede Grocy-opskrifter på deres levende tvilling i bon_lines (#441).
//
// Grocy-opskrifter der er slettet hænger stadig på gamle bon_lines. Faktureringen
// slår varenummeret op via /objects/recipes (kun levende), så enhver bon med en
// af dem blokerer — og der er intet at koble, for opskriften findes ikke.
//
// Kun ægte TVILLINGER er med: samme vare, oprettet igen under nyt id. Listen er
// LÆST AF ET MENNESKE og efterprøvet mod grocy-hq 16. september 2026 — issuets
// første bud (134 → 88, 138 → 76) viste sig at pege på Kyllingen og Lyse boller,
// fordi tallene var e-conomic-varenumre og ikke recipe-id'er. Udgåede varer
// (Tomaten, Humus'en, Paté …) og afløsninger med et andet produkt (Muffin →
// Brownie) rører vi IKKE; de faktureres via engangsbeløb.
//
// Værn ved kørsel (kræver Grocy-adgang, kør på serveren):
//   - kilden skal være VÆK i Grocy (ellers er den ikke et spøgelse)
//   - målet skal FINDES og hedde det samme (uden hængende bindestreg/mellemrum)
// Skriver kun grocy_recipe_id. product_name, antal og priser er urørte — kunden
// købte det der står; kun koblingen flyttes. Linje- og beløbssum verificeres i
// samme transaktion og ruller tilbage hvis de flytter sig. Idempotent.
//
// Brug:
//   node --experimental-sqlite scripts/remap-deleted-recipes.js            # tørkørsel
//   node --experimental-sqlite scripts/remap-deleted-recipes.js --apply    # skriver (tager backup)
// ==========================================

'use strict';

require('dotenv').config({ quiet: true });
const path = require('path');
const { openDb, transaction } = require('../db/compat');

// slettet id → levende id. Navnene står til kontrol mod Grocy ved kørsel.
const MAPPING = [
    { from: 133, to: 94,  name: 'Trøflen - slider' },   // 94 har varenr 92
    { from: 163, to: 167, name: 'Cookie knæk' },        // 0 kr-vare; udelades af fakturaen uanset, men skal ikke stå som spøgelse
];

const APPLY   = process.argv.includes('--apply');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-–]+/g, ' ').trim();
function fail(msg) { console.error('\n✗ ' + msg); process.exit(2); }

/** Kontrollér parrene mod Grocy. Returnerer kun de par der holder. */
async function verifyAgainstGrocy(pairs, live) {
    const byId = new Map(live.map(r => [Number(r.id), r]));
    const ok = [];
    for (const p of pairs) {
        const src = byId.get(p.from), dst = byId.get(p.to);
        if (src) { console.log(`  (springer over) ${p.from} "${src.name}" findes stadig i Grocy — ikke et spøgelse`); continue; }
        if (!dst) { console.log(`  (springer over) ${p.to} findes ikke i Grocy — intet at pege på`); continue; }
        if (norm(dst.name) !== norm(p.name)) {
            console.log(`  (springer over) ${p.to} hedder "${dst.name}", forventede "${p.name}" — er det den rigtige tvilling?`); continue;
        }
        ok.push({ ...p, toName: dst.name, varenr: dst.userfields?.economic_product_number || null });
    }
    return ok;
}

async function main() {
    const db = openDb(DB_PATH);
    console.log(`Database:   ${DB_PATH}`);
    console.log(APPLY ? '\n*** SKRIVER ***\n' : '\n(tørkørsel — intet skrives. --apply for at gennemføre)\n');

    let live;
    try {
        const { getRecipesRaw } = require('../services/grocyAdapter');
        live = await getRecipesRaw();
    } catch (err) {
        fail(`Kan ikke nå Grocy (${err.message}). Værnet kræver den — kør på serveren.`);
    }
    if (!Array.isArray(live) || !live.length) fail('Grocy svarede med en tom opskriftsliste — nægter at gætte.');

    const pairs = await verifyAgainstGrocy(MAPPING, live);

    const count = db.prepare(`
        SELECT COUNT(*) AS lines, COUNT(DISTINCT bl.bon_id) AS bons,
               SUM(CASE WHEN s.code IN ('FAKTURERET','BETALT','AFSLUTTET','AFLYST') THEN 0 ELSE 1 END) AS open_lines
        FROM bon_lines bl JOIN bons b ON b.id = bl.bon_id JOIN status_definitions s ON s.id = b.status_id
        WHERE bl.grocy_recipe_id = ?`);
    const plan = [];
    for (const p of pairs) {
        const c = count.get(p.from);
        console.log(`  ${String(p.from).padStart(4)} → ${String(p.to).padEnd(4)} ${p.toName.padEnd(22)} varenr ${p.varenr || '—'}   ${c.lines} linjer på ${c.bons} bons (${c.open_lines} på åbne bons)`);
        if (c.lines) plan.push({ ...p, ...c });
    }
    const total = plan.reduce((a, p) => a + p.lines, 0);
    console.log(`\n${total} linjer flyttes · ${MAPPING.length - pairs.length} par sprunget over`);
    if (!total || !APPLY) return;

    const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace(/Z$/, '') + '-' + process.pid; // utc-ok: filnavn
    const backup = DB_PATH.replace(/\.db$/, '') + `.pre-remap-recipes-${stamp}.db`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`Backup: ${backup}`);

    const fingerprint = () => db.prepare('SELECT COUNT(*) AS n, ROUND(SUM(quantity * unit_price), 2) AS sum, SUM(quantity) AS qty FROM bon_lines').get();
    const before = fingerprint();
    const bonsFor = db.prepare('SELECT DISTINCT bon_id FROM bon_lines WHERE grocy_recipe_id = ?');
    const upd = db.prepare('UPDATE bon_lines SET grocy_recipe_id = ? WHERE grocy_recipe_id = ?');
    const log = db.prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, notes)
        VALUES ('bon', ?, 'update', 'bon_lines.grocy_recipe_id', ?, ?, ?)`);
    transaction(db, () => {
        for (const p of plan) {
            const bons = bonsFor.all(p.from).map(r => r.bon_id);
            const r = upd.run(p.to, p.from);
            if (r.changes !== p.lines) throw new Error(`${p.from}: forventede ${p.lines} linjer, ramte ${r.changes} — ruller tilbage`);
            for (const bonId of bons) {
                log.run(bonId, String(p.from), String(p.to),
                    `Slettet Grocy-opskrift ${p.from} peget på tvillingen ${p.to} "${p.toName}" (scripts/remap-deleted-recipes.js, #441) — navn, antal og pris urørte`);
            }
        }
        const after = fingerprint();
        if (after.n !== before.n || after.sum !== before.sum || after.qty !== before.qty) {
            throw new Error(`Linjesum flyttede sig (${JSON.stringify(before)} → ${JSON.stringify(after)}) — ruller tilbage`);
        }
    });
    console.log(`\n✓ ${total} linjer flyttet på ${plan.reduce((a, p) => a + p.bons, 0)} bons`);
}

main().catch(err => fail(err.message));
