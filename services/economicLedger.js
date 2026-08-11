/**
 * services/economicLedger.js
 * ════════════════════════════════════════════════════════════════════════
 * Spejler e-conomics BETALINGSPOSTERINGER (`customerPayment`) ind i
 * `cf_economic_payments`. Kræver app-rollen `Bookkeeping` (jf.
 * docs/economics/CLAUDE_ECONOMIC_AUTH.md §1) — med kun `Sales` svarer
 * `/accounting-years` 403, og synken springer over uden at larme.
 *
 * HVORFOR: en betalingspostering er den eneste ærlige kilde til hvornår en
 * faktura blev betalt. De to vi havde i forvejen duer ikke —
 * `cf_invoices.betalt_dato` er for hovedparten leveringsdatoen, og bankmatchet
 * er skævt udvalgt (auto-matcheren scorer på nærhed til forfaldsdatoen, så sene
 * betalinger uden fakturanr aldrig registreres). Se migration 145.
 *
 * ── VANDMÆRKET ER RIGTIGT HER (modsat #320) ────────────────────────────────
 * I fakturasynken var et vandmærke forkert, fordi `remainder` ændrer sig
 * BAGUDRETTET når betalingen falder. En postering gør ikke det: den er en
 * begivenhed på en dato, og et LUKKET regnskabsår kan pr. definition ikke ændre
 * sig mere. e-conomic oplyser selv `closed` pr. år, så vi behøver ikke gætte på
 * "de nyeste N år" — regnskabet fortæller hvornår et år er færdigt. Lukkede år
 * hentes én gang; åbne år hver gang.
 *
 * KUN LÆSNING. e-conomic ejer posteringerne; vi bogfører aldrig.
 * ════════════════════════════════════════════════════════════════════════
 */
'use strict';
const eco = require('./economicAdapter');

/**
 * Regnskabsår, nyeste sidst: `{ year, entriesUrl, closed }`.
 *
 * ⚠️ Byg ALDRIG entries-URL'en selv ud fra `year`. Årets navn og dets URL-slug
 * er ikke det samme: `"2015/2016"` hedder `2015_6_2016` i stien, og et
 * `encodeURIComponent` på navnet giver 404. Brug API'ets eget `entries`-link.
 */
async function fetchAccountingYears() {
    const r = await eco.rest('/accounting-years?pagesize=100');
    return (r.collection || []).map(y => ({
        year: String(y.year),
        entriesUrl: y.entries || null,
        closed: y.closed === true,
    }));
}

/** Absolut e-conomic-URL → sti, så den kan gå gennem adapterens auth-wrapper. */
function toPath(url) {
    return String(url).replace(/^https?:\/\/[^/]+/, '');
}

/** Alle posteringer i ét regnskabsår (pagineret). Tager årets `entries`-link. */
async function fetchEntries(entriesUrl) {
    const base = toPath(entriesUrl);
    const sep = base.includes('?') ? '&' : '?';
    let out = [], skip = 0;
    while (true) {
        const r = await eco.rest(`${base}${sep}pagesize=1000&skippages=${skip}`);
        out = out.concat(r.collection || []);
        if (!r.pagination?.nextPage || ++skip > 50) break;
    }
    return out;
}

/** Postering → række. `amountInBaseCurrency` frem for `amount`: DKK i dag, men vi vil ikke måle i fremmed valuta hvis det ændrer sig. */
function toRow(e, year) {
    return {
        entry_number: e.entryNumber,
        entry_date: e.date || null,
        amount: e.amountInBaseCurrency ?? e.amount ?? 0,
        invoice_number: e.invoiceNumber != null ? String(e.invoiceNumber) : null,
        customer_number: e.customer?.customerNumber != null ? String(e.customer.customerNumber) : null,
        text: e.text || null,
        voucher_number: e.voucherNumber != null ? String(e.voucherNumber) : null,
        accounting_year: year,
    };
}

/**
 * Hent betalingsposteringer og skriv dem til cf_economic_payments.
 *
 * @param {DatabaseSync} db
 * @param {{ dryRun?: boolean, years?: string[], full?: boolean }} opts
 *   full  — ignorér vandmærket og hent ALLE år (førstegangs-backfill).
 *   years — hent præcis disse år (bruges af tests og fejlsøgning).
 * @returns {Promise<{available, years, scanned, payments, written, skippedYears, reason?}>}
 */
async function syncPayments(db, { dryRun = false, years, full = false } = {}) {
    const getMeta = (k) => db.prepare('SELECT value FROM cf_meta WHERE key = ?').get(k)?.value || null;
    const setMeta = db.prepare(`INSERT INTO cf_meta (key, value) VALUES (?, ?)
                                ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    let allYears;
    try {
        allYears = years || await fetchAccountingYears();
    } catch (err) {
        // 403 = app-rollen mangler Bookkeeping. Det er en konfigurationstilstand,
        // ikke en fejl — resten af afstemningen skal stadig kunne køre.
        if (err.status === 403) return { available: false, reason: 'missing_bookkeeping_role', years: [], scanned: 0, payments: 0, written: 0, skippedYears: [] };
        throw err;
    }

    // Et LUKKET regnskabsår kan ikke ændre sig — det hentes én gang og springes
    // over derefter. Åbne år hentes hver gang. e-conomic oplyser selv `closed`,
    // så vi behøver ikke gætte på "de nyeste N år"; regnskabet siger det.
    const todo = [], skippedYears = [];
    for (const y of allYears) {
        const seen = getMeta(`economic_entries_year_${y.year}`);
        if (full || !y.closed || !seen) todo.push(y);
        else skippedYears.push(y.year);
    }

    const ins = db.prepare(`
        INSERT INTO cf_economic_payments
            (entry_number, entry_date, amount, invoice_number, customer_number, text, voucher_number, accounting_year, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(entry_number) DO UPDATE SET
            entry_date = excluded.entry_date, amount = excluded.amount,
            invoice_number = excluded.invoice_number, customer_number = excluded.customer_number,
            text = excluded.text, voucher_number = excluded.voucher_number,
            accounting_year = excluded.accounting_year, synced_at = datetime('now')`);

    let scanned = 0, payments = 0, written = 0;
    for (const y of todo) {
        if (!y.entriesUrl) continue;                  // år uden entries-link — spring over frem for at gætte URL'en
        const entries = await fetchEntries(y.entriesUrl);
        scanned += entries.length;
        const rows = entries.filter(e => e.entryType === 'customerPayment').map(e => toRow(e, y.year));
        payments += rows.length;
        if (!dryRun) {
            for (const r of rows) {
                ins.run(r.entry_number, r.entry_date, r.amount, r.invoice_number,
                        r.customer_number, r.text, r.voucher_number, r.accounting_year);
                written++;
            }
            // Markér året hentet. Åbne år markeres også — flaget bruges kun til at
            // springe LUKKEDE år over, og `closed` vinder altid over det.
            setMeta.run(`economic_entries_year_${y.year}`, new Date().toISOString()); // utc-ok: tidsstempel
        }
    }
    if (!dryRun) setMeta.run('economic_entries_synced_at', new Date().toISOString()); // utc-ok: tidsstempel

    return { available: true, years: todo.map(y => y.year), scanned, payments, written, skippedYears };
}

/**
 * Betalingsdato pr. faktura = datoen for den SIDSTE betaling på den.
 * En faktura kan have flere (delbetalinger — 41 tilfælde i 2025+2026); det er
 * den sidste der gør den betalt, og det er dét tidspunkt en rytme handler om.
 * @returns {Map<string, {date:string, amount:number, n:number}>} fakturanr → betaling
 */
function paymentByInvoice(db) {
    const rows = db.prepare(`
        SELECT invoice_number,
               MAX(entry_date)      AS last_date,
               SUM(-amount)         AS received,
               COUNT(*)             AS n
        FROM cf_economic_payments
        WHERE invoice_number IS NOT NULL AND invoice_number != ''
        GROUP BY invoice_number
    `).all();
    const out = new Map();
    for (const r of rows) out.set(String(r.invoice_number), { date: r.last_date, amount: r.received, n: r.n });
    return out;
}

module.exports = { syncPayments, fetchEntries, fetchAccountingYears, paymentByInvoice, toPath };
