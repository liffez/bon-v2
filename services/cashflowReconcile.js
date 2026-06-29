/**
 * services/cashflowReconcile.js
 * ════════════════════════════════════════════════════════════════════════
 * e-conomic → Bon: afstem BETALT-status på fakturaer (Pengestrøm delta B).
 * Spec: docs/economics/CLAUDE_PENGESTROEM.md §2.B.
 *
 * Læser e-conomics bogførte fakturaer via REST /invoices/booked (samme auth som
 * resten af adapteren — INGEN OpenAPI nødvendig). `remainder === 0` = betalt.
 *
 * MATCH-NØGLE: bon-nummeret i fakturaens OVERSKRIFT (`notes.heading`), IKKE
 * e-conomics eget fakturanummer (de er forskellige serier — et nummer-match er
 * tilfældigt). Kontoret skriver bon-nummeret/-numrene i overskriften ("4111",
 * "4093 & 4094", "#B4013"). Vi trækker alle 3-5-cifrede tal ud og matcher mod
 * digits(cf_invoices.id) (cf_invoices.id er bon-baseret, fx "B4112"). Én faktura
 * kan dække flere bons → alle deres cf_invoices opdateres. Rykker vandmærket
 * (cf_meta.economic_booked_until) til seneste bogførte dato.
 *
 * KUN læsning fra e-conomic (vi bogfører/betaler aldrig). Skriver kun til vores
 * egen cf_invoices + cf_meta. Idempotent: kører den igen → ingen ekstra ændringer.
 * ════════════════════════════════════════════════════════════════════════
 */
'use strict';
const eco = require('./economicAdapter');

const digits = (s) => String(s || '').replace(/\D/g, '');

/** Hent bogførte fakturaer fra e-conomic, valgfrit filtreret på dato ≥ since. */
async function fetchBookedSince(since) {
    const enc = encodeURIComponent;
    const filter = since ? '&filter=' + enc('date$gte:' + since) : '';
    let out = [], skip = 0;
    while (true) {
        const r = await eco.rest(`/invoices/booked?pagesize=100&skippages=${skip}${filter}`);
        out = out.concat(r.collection || []);
        if (!r.pagination?.nextPage || ++skip > 200) break;
    }
    return out;
}

/**
 * Afstem cf_invoices mod e-conomics betalt-status.
 * @param {DatabaseSync} db
 * @param {{ dryRun?: boolean, since?: string }} opts
 *   dryRun (default true) — beregn ændringer uden at skrive.
 *   since — overstyr startdato; ellers cf_meta.economic_booked_until.
 * @returns {Promise<{scanned,matched,flipped,since,newWatermark,dryRun,changes}>}
 */
async function reconcile(db, { dryRun = true, since } = {}) {
    const getMeta = (k) => db.prepare('SELECT value FROM cf_meta WHERE key = ?').get(k)?.value || null;
    const sinceDate = since || getMeta('economic_booked_until') || null;

    const booked = await fetchBookedSince(sinceDate);

    // cf_invoices indekseret på digit-strippet fakturanummer
    const cfByNum = new Map();
    for (const r of db.prepare('SELECT id, betalt, bon_id, economic_number FROM cf_invoices').all()) {
        cfByNum.set(digits(r.id), r);
    }

    let scanned = 0, matched = 0, flipped = 0, noHeading = 0, numbered = 0, newWatermark = sinceDate;
    const changes = [];
    const numberChanges = [];                      // {cf_id, economic_number} — gem bogført fakturanr
    const seenCf = new Set();                      // undgå dobbelt-flip hvis to fakturaer peger på samme bon
    const seenNum = new Set();
    for (const inv of booked) {
        scanned++;
        if (inv.date && (!newWatermark || inv.date > newWatermark)) newWatermark = inv.date;
        const heading = inv.notes?.heading || '';
        const bonNums = heading.match(/\d{3,5}/g) || [];   // ét eller flere bon-numre i overskriften
        if (!bonNums.length) { noHeading++; continue; }     // tom/beskrivende overskrift (fx "Michelin")
        const paid = inv.remainder === 0;
        const ecoNo = inv.bookedInvoiceNumber != null ? String(inv.bookedInvoiceNumber) : null;
        for (const num of bonNums) {
            const cf = cfByNum.get(num);
            if (!cf) continue;                              // bon-nr uden cf_invoice (ikke Bon-v2-bon)
            matched++;
            // Gem e-conomics bogførte fakturanr på cf_invoice (også hvis allerede betalt) —
            // grundlaget for at koble bank-indbetalingen via nummeret i bankteksten.
            if (ecoNo && cf.economic_number !== ecoNo && !seenNum.has(cf.id)) {
                seenNum.add(cf.id);
                numbered++;
                numberChanges.push({ cf_id: cf.id, economic_number: ecoNo });
            }
            if (paid && cf.betalt !== 1 && !seenCf.has(cf.id)) {
                seenCf.add(cf.id);
                flipped++;
                changes.push({ cf_id: cf.id, bon_id: cf.bon_id, booked_no: ecoNo, heading, date: inv.date });
            }
        }
    }

    if (!dryRun && changes.length) {
        const upd = db.prepare(`UPDATE cf_invoices
            SET betalt = 1, betalt_dato = ?, betalingstype = COALESCE(betalingstype, 'bank')
            WHERE id = ?`);
        for (const c of changes) upd.run(c.date, c.cf_id);
    }
    if (!dryRun && numberChanges.length) {
        const updNo = db.prepare(`UPDATE cf_invoices SET economic_number = ? WHERE id = ?`);
        for (const c of numberChanges) updNo.run(c.economic_number, c.cf_id);
    }
    if (!dryRun && newWatermark) {
        db.prepare(`INSERT INTO cf_meta (key, value) VALUES ('economic_booked_until', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(newWatermark);
    }

    return { scanned, matched, flipped, numbered, since: sinceDate, newWatermark, dryRun, changes };
}

/** Læs match-tolerance fra settings (samme defaults som routes/cashflow.js). */
function getTolerance(db) {
    const pct = parseFloat(db.prepare(`SELECT value FROM settings WHERE key = 'cf_match_relative_tolerance_pct'`).get()?.value);
    const extra = parseFloat(db.prepare(`SELECT value FROM settings WHERE key = 'cf_match_extra_tolerance_max'`).get()?.value);
    return {
        relativePct: Number.isFinite(pct) && pct >= 0 ? pct : 2.0,
        extraMax: Number.isFinite(extra) && extra >= 0 ? extra : 350,
    };
}

/**
 * Kobl umatchede bank-indbetalinger til fakturaer via e-conomics bogførte
 * fakturanummer i bankteksten ("FAKTURA 3957" → cf_invoices.economic_number=3957).
 * VERIFICERET link: nummer i tekst OG beløb inden for tolerance (også allerede
 * betalte fakturaer — disse er afregnet, men ikke koblet 1:1 i bank-visningen).
 * Rører IKKE betalt-status (det ejer reconcile/e-conomic). Idempotent.
 * @returns {{ linked, changes }}
 */
function matchByEconomicNumber(db, { dryRun = false } = {}) {
    const { relativePct, extraMax } = getTolerance(db);
    const ratio = relativePct / 100;

    // economic_number → [{id, beloeb}]   (én samlefaktura → flere bons deler nummer)
    const byNum = new Map();
    for (const i of db.prepare(`SELECT id, beloeb, economic_number FROM cf_invoices
                                WHERE economic_number IS NOT NULL AND economic_number != ''`).all()) {
        const k = digits(i.economic_number);
        if (!k) continue;
        if (!byNum.has(k)) byNum.set(k, []);
        byNum.get(k).push(i);
    }

    const unmatched = db.prepare(`SELECT id, tekst, beloeb FROM cf_transactions
        WHERE matched_invoice_id IS NULL AND beloeb > 0 AND ignored = 0`).all();

    const changes = [];
    for (const tx of unmatched) {
        const nums = tx.tekst.match(/\d{3,6}/g) || [];
        let hit = null;
        for (const n of nums) {
            const cands = byNum.get(n);
            if (!cands) continue;
            for (const inv of cands) {
                const diff = tx.beloeb - inv.beloeb;
                const within = Math.abs(diff) / Math.abs(inv.beloeb) <= ratio || (diff > 0 && diff <= extraMax);
                if (within) { hit = inv; break; }       // nummer + beløb → høj sikkerhed
            }
            if (hit) break;
        }
        if (hit) changes.push({ tx_id: tx.id, invoice_id: hit.id });
    }

    if (!dryRun && changes.length) {
        const upd = db.prepare(`UPDATE cf_transactions SET matched_invoice_id = ?, match_confidence = 95 WHERE id = ?`);
        for (const c of changes) upd.run(c.invoice_id, c.tx_id);
    }
    return { linked: changes.length, changes };
}

module.exports = { reconcile, fetchBookedSince, matchByEconomicNumber };
