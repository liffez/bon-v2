// tests/fixtures/setup_testbon.js
// ==========================================
// Bygger et isoleret SQLite-fixture med T-5 testbonen.
// Brug:
//   node tests/fixtures/setup_testbon.js
//
// Output: tests/fixtures/moms_audit_testbon.db
//
// T-5 testbonen (T = "Testbon for moms-audit"):
//   60 × 104 kr  (Kyllingen)
//   70 × 114 kr  (Trøflen)
//   70 ×  99 kr  ("Tunen")
//    8 × 312.50 kr (Servicepersonale)
//
// Forventet:
//   total_incl_moms: 23.650
//   total_excl_moms: 18.920
//   moms_amount:      4.730
// ==========================================

const path = require('path');
const fs   = require('fs');
const { openDb, transaction } = require('../../db/compat');
const { runMigrations } = require('../../db/migrate');
const { computeMomsFields } = require('../../shared/moms');

const FIXTURE_PATH = path.join(__dirname, 'moms_audit_testbon.db');

function setupFixture() {
    // Slet eksisterende fixture (idempotent)
    for (const ext of ['', '-wal', '-shm']) {
        const f = FIXTURE_PATH + ext;
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    // Kør migrations på fresh DB
    runMigrations(FIXTURE_PATH);
    const db = openDb(FIXTURE_PATH);
    db.exec('PRAGMA foreign_keys = ON');

    transaction(db, () => {
        // Sikr default location + price_category eksisterer
        const loc = db.prepare(`SELECT id FROM locations LIMIT 1`).get();
        const priceCat = db.prepare(`SELECT id FROM price_categories WHERE code = 'catering' LIMIT 1`).get();
        const status = db.prepare(`SELECT id FROM status_definitions WHERE code = 'LEVERET'`).get();

        if (!loc || !priceCat || !status) {
            throw new Error('Mangler grundlæggende seed (locations / price_categories / status_definitions)');
        }

        // Opret testkunde
        const cust = db.prepare(`
            INSERT INTO customers (first_name, last_name, email, phone)
            VALUES ('Moms', 'Testkunde', 'moms-test@audit.local', '+45 0000 0000')
        `).run();
        const customerId = Number(cust.lastInsertRowid);

        // Opret T-5 bonnen — totalerne sættes af recalc nedenfor
        const bonRes = db.prepare(`
            INSERT INTO bons (
                bon_number, status_id, location_id, customer_id, price_category_id,
                order_date, delivery_date, delivery_time, delivery_type,
                pax, total_units, total_price, total_with_delivery,
                payment_type, kitchen_selects, customer_collects,
                prep_ingredients_ready, prep_supplies_ready,
                is_internal
            ) VALUES (
                'T5', ?, ?, ?, ?,
                '2026-05-01', '2026-05-15', '12:00', 'delivery',
                208, 208, 0, 0,
                'invoice', 0, 0,
                1, 1,
                0
            )
        `).run(status.id, loc.id, customerId, priceCat.id);
        const bonId = Number(bonRes.lastInsertRowid);

        // T-5 linjer (alle priser incl. moms — Grocy-konvention)
        const insertLine = db.prepare(`
            INSERT INTO bon_lines (
                bon_id, product_name, category, quantity, unit,
                cost_price, unit_price, line_total, sort_order, is_accessory
            ) VALUES (?, ?, ?, ?, 'stk', ?, ?, ?, ?, 0)
        `);

        const lines = [
            { name: 'Kyllingen',         cat: '01 Sandwich', qty: 60, cost: 22, price: 104 },
            { name: 'Trøflen',           cat: '01 Sandwich', qty: 70, cost: 25, price: 114 },
            { name: '"Tunen"',           cat: '01 Sandwich', qty: 70, cost: 21, price:  99 },
            { name: 'Servicepersonale',  cat: 'x-Service',   qty:  8, cost:  0, price: 312.50 },
        ];

        lines.forEach((l, i) => {
            insertLine.run(bonId, l.name, l.cat, l.qty, l.cost, l.price, l.qty * l.price, i);
        });

        // Recalc total_price som server ville gøre (sum af line_total + delivery_price)
        const linesSum = db.prepare(`SELECT COALESCE(SUM(line_total),0) as t FROM bon_lines WHERE bon_id = ?`).get(bonId).t;
        db.prepare(`UPDATE bons SET total_price = ?, total_with_delivery = ? WHERE id = ?`).run(linesSum, linesSum, bonId);

        console.log(`✓ T-5 fixture oprettet: bon_id=${bonId}, total_price=${linesSum}`);

        // Verificér mod forventet
        const expected = computeMomsFields(linesSum);
        if (expected.total_incl_moms !== 23650) {
            throw new Error(`T-5 fixture forkert! incl=${expected.total_incl_moms}, forventet 23650`);
        }
        console.log(`✓ Math-verifikation: incl=${expected.total_incl_moms}, excl=${expected.total_excl_moms}, moms=${expected.moms_amount}`);
    });

    db.close();
    console.log(`✓ Fixture-fil: ${FIXTURE_PATH}`);
}

if (require.main === module) {
    try {
        setupFixture();
    } catch (err) {
        console.error('FEJL:', err.message);
        process.exit(1);
    }
}

module.exports = { setupFixture, FIXTURE_PATH };
