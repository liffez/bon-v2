#!/usr/bin/env node
// scripts/apply-standing-discount.js
// ============================================================
// Læg et firmas stående rabat på de bons der er ældre end rabatten.
//
// Baggrund: rabatten kopieres fra firmaet til bonnen når bonnen OPRETTES
// (triggeren bons_seed_standing_discount, migration 111). Et firma der får
// sin rabat sat i dag, har derfor 0 % på alle bons fra før — og så viser
// omsætning, driftsregnskab, rapporter og CRM listeprisen for dem, mens
// kunden faktisk har betalt med rabat.
//
// Scriptet sætter firmaets sats på de bons der står med 0 % og regner deres
// total om med den fælles regel (services/bonDiscount.js): rabatten gælder
// varerne, ikke levering, gebyrer og emballage.
//
// Rører KUN:
//   - bons på det angivne firma, som ikke er tilbud
//   - hvor offer_discount_percent er 0/NULL (en bon med en sats er urørt —
//     den er sat bevidst, og det gør scriptet idempotent)
//   - valgfrit afgrænset med --from / --to (leveringsdato)
//
// Bons der ALLEREDE har en sats regnes også om, hvis deres total blev regnet
// med den gamle regel (rabat på alt, også levering og gebyrer). Satsen røres
// ikke på dem — kun totalen.
//
// Linjerne røres ikke. Kun satsen og bonens total. Fakturaer i e-conomic og
// beløb i pengestrømmen røres heller ikke — de er hvad der faktisk blev
// faktureret.
//
//   node --experimental-sqlite scripts/apply-standing-discount.js --company 3570
//   node --experimental-sqlite scripts/apply-standing-discount.js --company 3570 --apply
//   ... --from 2025-01-01 --to 2026-09-03
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'bon.db');
process.env.DB_PATH = DB_PATH;

const { openDb, transaction } = require('../db/compat');
const { recalcBonTotal } = require('../db/helpers');

function arg(name) {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
}
const APPLY = process.argv.includes('--apply');
const COMPANY_ID = Number(arg('--company'));
const FROM = arg('--from');
const TO = arg('--to');

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function fail(msg) { console.error('✗ ' + msg); process.exit(2); }

if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) fail('Angiv --company <id>');
if (FROM && !ISO.test(FROM)) fail('--from skal være YYYY-MM-DD');
if (TO && !ISO.test(TO)) fail('--to skal være YYYY-MM-DD');

const kr = (n) => (Math.round((n ?? 0) * 100) / 100).toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function findBons(db) {
    const where = [
        'b.company_id = ?',
        'COALESCE(b.is_offer, 0) = 0',
        'COALESCE(b.offer_discount_percent, 0) = 0',
    ];
    const args = [COMPANY_ID];
    if (FROM) { where.push('b.delivery_date >= ?'); args.push(FROM); }
    if (TO)   { where.push('b.delivery_date <= ?'); args.push(TO); }
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.total_price, sd.code AS status_code
          FROM bons b
          JOIN status_definitions sd ON sd.id = b.status_id
         WHERE ${where.join(' AND ')}
         ORDER BY b.delivery_date, b.id
    `).all(...args);
}

function findDiscounted(db) {
    const where = ['b.company_id = ?', 'COALESCE(b.is_offer, 0) = 0', 'COALESCE(b.offer_discount_percent, 0) > 0'];
    const args = [COMPANY_ID];
    if (FROM) { where.push('b.delivery_date >= ?'); args.push(FROM); }
    if (TO)   { where.push('b.delivery_date <= ?'); args.push(TO); }
    return db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, b.total_price, sd.code AS status_code
          FROM bons b JOIN status_definitions sd ON sd.id = b.status_id
         WHERE ${where.join(' AND ')} ORDER BY b.delivery_date, b.id
    `).all(...args);
}

function linesFingerprint(db) {
    return db.prepare('SELECT COUNT(*) AS n, ROUND(COALESCE(SUM(line_total), 0), 2) AS s FROM bon_lines').get();
}

/**
 * Selve ændringen. Kører i en transaktion — ved dry-run rulles den tilbage,
 * så forhåndsvisningen er den samme kode som den rigtige kørsel.
 */
function applyTo(db, bons, pct) {
    const setPct = db.prepare('UPDATE bons SET offer_discount_percent = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const log = db.prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
        VALUES ('bon', ?, 'update', ?, ?, ?, NULL, ?)
    `);
    const note = `Stående rabat lagt på gammel bon (scripts/apply-standing-discount.js, firma #${COMPANY_ID})`;
    const out = [];
    for (const b of bons) {
        setPct.run(pct, b.id);
        const total = recalcBonTotal(db, b.id);
        log.run(b.id, 'offer_discount_percent', '0', String(pct), note);
        log.run(b.id, 'total_price', String(b.total_price ?? ''), String(total), note);
        out.push({ ...b, new_total: total });
    }
    return out;
}

/** Regn totalen om på bons der allerede har satsen. Returnerer kun dem der flytter sig. */
function recalcExisting(db, bons) {
    const log = db.prepare(`
        INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes)
        VALUES ('bon', ?, 'update', 'total_price', ?, ?, NULL, ?)
    `);
    const note = 'Total regnet om: rabat kun på varer, ikke levering/gebyrer/emballage (scripts/apply-standing-discount.js)';
    const out = [];
    for (const b of bons) {
        const total = recalcBonTotal(db, b.id);
        if (Math.abs((b.total_price ?? 0) - total) >= 0.01) {
            log.run(b.id, String(b.total_price ?? ''), String(total), note);
            out.push({ ...b, new_total: total });
        }
    }
    return out;
}

function main() {
    if (!fs.existsSync(DB_PATH)) fail(`Databasen findes ikke: ${DB_PATH}`);
    const db = openDb(DB_PATH);

    const company = db.prepare('SELECT id, name, discount_percent FROM companies WHERE id = ?').get(COMPANY_ID);
    if (!company) fail(`Firma #${COMPANY_ID} findes ikke`);
    const pct = Number(company.discount_percent) || 0;
    if (!(pct > 0 && pct < 100)) fail(`${company.name} har ingen stående rabat (discount_percent = ${company.discount_percent ?? 'NULL'})`);

    const bons = findBons(db);
    const discounted = findDiscounted(db);
    console.log(`${company.name} (#${company.id}) · stående rabat ${String(pct).replace('.', ',')} %`);
    console.log(`Periode: ${FROM || 'start'} → ${TO || 'nu'} · ${bons.length} bons uden rabat · ${discounted.length} med rabat (tjekkes for omregning)`);
    if (!bons.length && !discounted.length) { console.log('Intet at gøre.'); return; }

    const before = linesFingerprint(db);
    let result;
    let backup = null;

    if (APPLY) {
        backup = DB_PATH.replace(/\.db$/, '') + `.pre-standing-discount-${COMPANY_ID}.db`;
        fs.rmSync(backup, { force: true });
        db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
        result = transaction(db, () => {
            const r = { set: applyTo(db, bons, pct), recalc: recalcExisting(db, discounted) };
            const after = linesFingerprint(db);
            if (after.n !== before.n || after.s !== before.s) {
                throw new Error(`Bonlinjerne flyttede sig (${before.n}/${before.s} → ${after.n}/${after.s}) — rulles tilbage`);
            }
            return r;
        });
    } else {
        db.exec('BEGIN');
        try { result = { set: applyTo(db, bons, pct), recalc: recalcExisting(db, discounted) }; }
        finally { db.exec('ROLLBACK'); }
    }

    const byStatus = {};
    let sumBefore = 0, sumAfter = 0;
    if (!result.set.length && !result.recalc.length) {
        console.log('Intet at ændre — alle bons har allerede satsen og en total efter den fælles regel.');
        if (APPLY) console.log(`(Backup taget alligevel: ${backup})`);
        return;
    }
    const line = (r) => `  ${String(r.bon_number).padEnd(10)} ${r.delivery_date}  ${String(r.status_code).padEnd(11)} ${kr(r.total_price).padStart(12)} → ${kr(r.new_total).padStart(12)}`;
    if (result.set.length) console.log('\nRabat sættes på:');
    for (const r of result.set) {
        sumBefore += r.total_price || 0;
        sumAfter += r.new_total || 0;
        byStatus[r.status_code] = (byStatus[r.status_code] || 0) + 1;
        console.log(line(r));
    }
    if (result.recalc.length) {
        console.log('\nHar allerede rabat — totalen regnes om (levering/gebyrer/emballage uden rabat):');
        for (const r of result.recalc) {
            sumBefore += r.total_price || 0;
            sumAfter += r.new_total || 0;
            console.log(line(r));
        }
    }
    console.log('');
    console.log(`${result.set.length} bons får rabat · ${result.recalc.length} regnes om`);
    console.log(`Status (rabat sættes): ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`Total før ${kr(sumBefore)} kr · efter ${kr(sumAfter)} kr · rabat ${kr(sumBefore - sumAfter)} kr (inkl. moms)`);

    if (APPLY) {
        console.log(`\n✓ Skrevet. Backup: ${backup}`);
        console.log('  Tryk "Gem & genberegn" under Kundeindsigt, så kundescoren (RFM) følger med.');
    } else {
        console.log('\n(dry-run — intet skrevet. Kør med --apply for at skrive.)');
    }
}

main();
