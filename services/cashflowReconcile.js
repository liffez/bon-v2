/**
 * services/cashflowReconcile.js
 * ════════════════════════════════════════════════════════════════════════
 * e-conomic → Bon: afstem BETALT-status på fakturaer (Pengestrøm delta B).
 * Spec: docs/economics/CLAUDE_PENGESTROEM.md §2.B.
 *
 * Læser e-conomics bogførte fakturaer via REST (samme auth som resten af
 * adapteren — INGEN OpenAPI nødvendig).
 *
 * TO AKSER, TO KILDER (#320 — rettet 10. august 2026):
 *   BETALT-status  ← REST `/invoices/unpaid`. FULD TILSTAND, intet vandmærke.
 *                    Listen er e-conomics egen debitorbog: alt bogført der IKKE
 *                    står på den, er betalt. Ét kald, ~14 rækker.
 *   Nummer + spejl ← REST `/invoices/booked` filtreret på vandmærket. Ægte delta:
 *                    en NY faktura ses kun én gang, og det er nok.
 *
 * Hvorfor: betalt-status blev tidligere også udledt af det vandmærke-filtrerede
 * booked-scan. Men vandmærket filtrerer på fakturaens EGEN dato, så en faktura
 * blev set én gang — omkring udstedelsen, hvor den per definition er ubetalt — og
 * aldrig igen. Betaling sker bagefter. Målt 10. august: 18 af 21 "forfaldne"
 * (107.669 kr) var for længst betalt hos e-conomic. Fuld tilstand kan ikke ramme
 * den fælde: der er intet vindue at falde uden for.
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
const { todayISO } = require('../db/helpers');

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
 * Hent HELE den ubetalte liste — e-conomics egen debitorbog, uden dato-filter.
 * Bevidst ufiltreret: det er præcis fuldstændigheden der gør "står ikke på listen
 * ⇒ betalt" til en gyldig slutning.
 */
async function fetchUnpaid() {
    let out = [], skip = 0, reported = null;
    while (true) {
        const r = await eco.rest(`/invoices/unpaid?pagesize=100&skippages=${skip}`);
        if (reported === null) reported = r.pagination?.results ?? null;
        out = out.concat(r.collection || []);
        if (!r.pagination?.nextPage || ++skip > 200) break;
    }
    // En tom liste er en legitim tilstand (alt betalt). En tom liste hvor e-conomic
    // SELV melder rækker er derimod brudt paginering — og ville her markere hele
    // debitorbogen betalt. Fejl hellere højlydt.
    if (reported != null && reported > 0 && out.length === 0) {
        throw new Error(`e-conomic meldte ${reported} ubetalte fakturaer men leverede 0 rækker — afbryder afstemningen`);
    }
    return out;
}

/**
 * Afstem cf_invoices mod e-conomics betalt-status.
 * @param {DatabaseSync} db
 * @param {{ dryRun?: boolean, since?: string }} opts
 *   dryRun (default true) — beregn ændringer uden at skrive.
 *   since — overstyr startdato for NUMMER-koblingen; betalt-aksen er altid fuld
 *           tilstand og påvirkes ikke.
 * @returns {Promise<{scanned,matched,flipped,conflicts,unknownNumbers,openInEconomic,
 *                    since,newWatermark,dryRun,changes,conflictRows}>}
 */
async function reconcile(db, { dryRun = true, since } = {}) {
    const getMeta = (k) => db.prepare('SELECT value FROM cf_meta WHERE key = ?').get(k)?.value || null;
    const sinceDate = since || getMeta('economic_booked_until') || null;

    // ── AKSE 1: fuld tilstand — hvem skylder os penge lige nu? ──────────────
    const unpaidList = await fetchUnpaid();
    const unpaidByNo = new Map();
    for (const inv of unpaidList) {
        const no = digits(inv.bookedInvoiceNumber);
        if (no) unpaidByNo.set(no, inv);
    }

    // ── AKSE 2: delta — nye bogførte fakturaer siden vandmærket ─────────────
    const booked = await fetchBookedSince(sinceDate);

    // cf_invoices indekseret på digit-strippet fakturanummer
    const cfByNum = new Map();
    for (const r of db.prepare('SELECT id, betalt, bon_id, economic_number FROM cf_invoices').all()) {
        cfByNum.set(digits(r.id), r);
    }

    let scanned = 0, matched = 0, noHeading = 0, numbered = 0, newWatermark = sinceDate;
    const numberChanges = [];                      // {cf_id, economic_number} — gem bogført fakturanr
    const mirror = [];                             // spejl af ALLE bogførte fakturaer (cf_economic_invoices)
    const seenNum = new Set();
    const bookedNos = new Set();                   // numre set i dette scan
    for (const inv of booked) {
        scanned++;
        if (inv.date && (!newWatermark || inv.date > newWatermark)) newWatermark = inv.date;
        const heading = inv.notes?.heading || '';
        const ecoNo = inv.bookedInvoiceNumber != null ? String(inv.bookedInvoiceNumber) : null;
        // Spejl ENHVER bogført faktura (også uden bon-nr i overskrift) — grundlaget for
        // at genkende bank-indbetalinger som afregnede fakturaer uden bon-kobling.
        if (ecoNo) {
            bookedNos.add(digits(ecoNo));
            mirror.push({
                booked_no: ecoNo, date: inv.date || null,
                gross_amount: inv.grossAmount ?? inv.netAmount ?? null,
                remainder: inv.remainder ?? null, heading,
            });
        }
        const bonNums = heading.match(/\d{3,5}/g) || [];   // ét eller flere bon-numre i overskriften
        if (!bonNums.length) { noHeading++; continue; }     // tom/beskrivende overskrift (fx "Michelin")
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
        }
    }

    /* ── BETALT-AKSEN på fuld tilstand ──────────────────────────────────────
       For hver cf_invoice med et e-conomic-nummer: står nummeret på den ubetalte
       liste, skylder kunden stadig; gør det ikke, er fakturaen afregnet.

       "Kendt" er et værn mod et forkert/forældet nummer: vi konkluderer kun
       "betalt" når nummeret rent faktisk findes hos e-conomic (spejlet eller
       dette scan). Ellers ville et vilkårligt ciffer-rod markere en faktura
       betalt — den dyreste af de to fejlretninger.                            */
    const numbersToApply = new Map();              // digits(nr) → [cf-rækker]
    for (const cf of db.prepare(`SELECT id, betalt, bon_id, economic_number FROM cf_invoices
                                 WHERE economic_number IS NOT NULL AND economic_number != ''`).all()) {
        const no = digits(cf.economic_number);
        if (!no) continue;
        if (!numbersToApply.has(no)) numbersToApply.set(no, []);
        numbersToApply.get(no).push(cf);
    }
    // Numre vi netop er ved at skrive på (nye koblinger i denne kørsel) tæller med
    for (const c of numberChanges) {
        const no = digits(c.economic_number);
        if (!no) continue;
        if (!numbersToApply.has(no)) numbersToApply.set(no, []);
        const row = cfByNum.get(digits(c.cf_id));
        if (row && !numbersToApply.get(no).some(r => r.id === c.cf_id)) numbersToApply.get(no).push(row);
    }

    const knownInMirror = new Set(
        db.prepare(`SELECT booked_no FROM cf_economic_invoices`).all().map(r => digits(r.booked_no))
    );
    // Bedste kendte betalingsdato = datoen på den bankpostering fakturaen er koblet
    // til. Findes ingen, bruger vi dags dato: e-conomics REST oplyser ikke hvornår
    // en faktura blev betalt, kun AT den er det. Datoen er "konstateret", ikke bogført.
    const txDate = new Map(
        db.prepare(`SELECT matched_invoice_id AS inv, MIN(dato) AS d FROM cf_transactions
                    WHERE matched_invoice_id IS NOT NULL GROUP BY matched_invoice_id`)
          .all().map(r => [r.inv, r.d])
    );
    const today = todayISO();

    let flipped = 0, unknownNumbers = 0;
    const changes = [];                            // 0 → 1 (afregnet hos e-conomic)
    const conflictRows = [];                       // vi siger betalt, e-conomic siger ubetalt
    const seenCf = new Set();
    for (const [no, rows] of numbersToApply) {
        const openInv = unpaidByNo.get(no);
        for (const cf of rows) {
            if (seenCf.has(cf.id)) continue;
            seenCf.add(cf.id);
            if (openInv) {
                if (cf.betalt === 1) conflictRows.push({
                    cf_id: cf.id, bon_id: cf.bon_id, booked_no: no,
                    remainder: openInv.remainder ?? null, due_date: openInv.dueDate || null,
                });
                continue;                          // stadig åben hos e-conomic — lad stå
            }
            if (!knownInMirror.has(no) && !bookedNos.has(no)) { unknownNumbers++; continue; }
            if (cf.betalt !== 1) {
                flipped++;
                changes.push({ cf_id: cf.id, bon_id: cf.bon_id, booked_no: no, date: txDate.get(cf.id) || today });
            }
        }
    }

    if (!dryRun && changes.length) {
        const upd = db.prepare(`UPDATE cf_invoices
            SET betalt = 1, betalt_dato = COALESCE(betalt_dato, ?), betalingstype = COALESCE(betalingstype, 'bank')
            WHERE id = ?`);
        for (const c of changes) upd.run(c.date, c.cf_id);
    }
    if (!dryRun && numberChanges.length) {
        const updNo = db.prepare(`UPDATE cf_invoices SET economic_number = ? WHERE id = ?`);
        for (const c of numberChanges) updNo.run(c.economic_number, c.cf_id);
    }
    if (!dryRun && mirror.length) {
        const upM = db.prepare(`INSERT INTO cf_economic_invoices (booked_no, date, gross_amount, remainder, heading, updated_at)
            VALUES (?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(booked_no) DO UPDATE SET
                date = excluded.date, gross_amount = excluded.gross_amount,
                remainder = excluded.remainder, heading = excluded.heading, updated_at = datetime('now')`);
        for (const m of mirror) upM.run(m.booked_no, m.date, m.gross_amount, m.remainder, m.heading);
    }
    // Spejlets `remainder` var indtil nu et fastfrosset øjebliksbillede fra den ene
    // gang fakturaen blev scannet — det er samme fælde som betalt-status havde.
    // Den ubetalte liste er fuld tilstand, så alt uden for den er afregnet.
    let mirrorCleared = 0;
    if (!dryRun) {
        const openNos = [...unpaidByNo.keys()];
        const stale = db.prepare(`SELECT booked_no FROM cf_economic_invoices WHERE remainder IS NOT NULL AND remainder != 0`)
            .all().map(r => r.booked_no).filter(n => !unpaidByNo.has(digits(n)));
        if (stale.length) {
            const clr = db.prepare(`UPDATE cf_economic_invoices SET remainder = 0, updated_at = datetime('now') WHERE booked_no = ?`);
            for (const n of stale) clr.run(n);
            mirrorCleared = stale.length;
        }
        // …og omvendt: de reelt åbne skal bære deres aktuelle restbeløb.
        if (openNos.length) {
            const setOpen = db.prepare(`UPDATE cf_economic_invoices SET remainder = ?, updated_at = datetime('now') WHERE booked_no = ?`);
            for (const [no, inv] of unpaidByNo) {
                if (inv.remainder != null) setOpen.run(inv.remainder, String(inv.bookedInvoiceNumber));
            }
        }
    }
    const setMeta = db.prepare(`INSERT INTO cf_meta (key, value) VALUES (?, ?)
                                ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    if (!dryRun && newWatermark) setMeta.run('economic_booked_until', newWatermark);
    // Betalt-status er fuld tilstand og har derfor ingen "ajour til"-dato — kun et
    // tidspunkt for hvornår vi sidst spurgte. Vandmærket ovenfor dækker nu alene
    // nummer-koblingen; de to må ikke forveksles i UI'et.
    if (!dryRun) setMeta.run('economic_synced_at', new Date().toISOString()); // utc-ok: tidsstempel, ikke kalenderdato
    // Gem e-conomics egen åbne total, så badgen kan vise den uden at spørge API'et
    // ved hvert sideskift — og uden at udlede den af spejlet, som kun kender de
    // fakturaer vi har scannet.
    if (!dryRun) {
        setMeta.run('economic_open_count', String(unpaidByNo.size));
        setMeta.run('economic_open_total', String(r2([...unpaidByNo.values()].reduce((s, i) => s + (i.remainder || 0), 0))));
    }

    // Åbne fakturaer hos e-conomic som INGEN cf_invoice peger på. Typisk fordi
    // overskriften ikke bærer et bon-nummer ("DCU Rødovre", tom) — eller fordi
    // fakturaen slet ikke stammer fra en bon. De forklarer hvorfor e-conomics tal
    // og "Forfaldne" ikke er ens, og er derfor værd at vise frem for at skjule.
    const unlinkedOpen = [];
    for (const [no, inv] of unpaidByNo) {
        if (numbersToApply.has(no)) continue;
        unlinkedOpen.push({
            booked_no: no, remainder: r2(inv.remainder), due_date: inv.dueDate || null,
            heading: inv.notes?.heading || '', customer: inv.customer?.name || null,
        });
    }

    // ── Fakturabeløbet er e-conomics, ikke bonens ─────────────────────────
    // cf_invoices.beloeb blev sat fra bonens total da den blev faktureret — og
    // ældre rækker mangler leveringen (total_price uden delivery_price). Kunden
    // betaler det tal der står på fakturaen i e-conomic, så det er DET beløb
    // "Udestående" skal summere og bank-matchet skal tolerere. Kun 1:1-koblinger:
    // en samlefaktura (ét nummer, flere bons) kan ikke fordeles uden at gætte.
    const grossByNo = new Map();
    for (const m of db.prepare(`SELECT booked_no, gross_amount FROM cf_economic_invoices`).all()) {
        if (m.gross_amount != null) grossByNo.set(digits(m.booked_no), m.gross_amount);
    }
    for (const m of mirror) if (m.gross_amount != null) grossByNo.set(digits(m.booked_no), m.gross_amount);
    const cfAmount = new Map(db.prepare(`SELECT id, beloeb FROM cf_invoices`).all().map(r => [r.id, r.beloeb]));
    const amountChanges = [];
    for (const [no, rows] of numbersToApply) {
        if (rows.length !== 1) continue;
        const gross = grossByNo.get(no);
        const cur = cfAmount.get(rows[0].id);
        if (!(gross > 0) || cur == null || Math.abs(gross - cur) < 0.01) continue;
        amountChanges.push({ cf_id: rows[0].id, booked_no: no, from: cur, to: gross });
    }
    if (!dryRun && amountChanges.length) {
        const updAmt = db.prepare(`UPDATE cf_invoices SET beloeb = ? WHERE id = ?`);
        for (const c of amountChanges) updAmt.run(c.to, c.cf_id);
    }

    return {
        scanned, matched, flipped, numbered, mirrored: mirror.length, mirrorCleared,
        amountsCorrected: amountChanges.length, amountChanges,
        conflicts: conflictRows.length, unknownNumbers,
        openInEconomic: unpaidByNo.size,
        openInEconomicTotal: r2([...unpaidByNo.values()].reduce((s, i) => s + (i.remainder || 0), 0)),
        unlinkedOpen,
        since: sinceDate, newWatermark, dryRun, changes, conflictRows,
    };
}

/** Afrund til 2 decimaler. */
function r2(n) { return Math.round((n ?? 0) * 100) / 100; }

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
 * Kobl bank-indbetalinger til fakturaer via e-conomics bogførte fakturanummer i
 * bankteksten ("FAKTURA 3957" → cf_invoices.economic_number = 3957).
 *
 * Nummeret i bankteksten er det stærkeste signal vi har — kunden skriver selv
 * hvilken regning hun betaler. Derfor:
 *
 *   1. Det VINDER over et beløbs-gæt. `runMatchLogic` matcher på beløb + dato og
 *      kan lægge "FAKTURA 4131" på en anden faktura der tilfældigvis koster det
 *      samme (set i drift: 4131 → B4228, mens B4145 — som ER 4131 — stod åben).
 *      En tx hvis nuværende match er et gæt (conf < 95) flyttes til den faktura
 *      nummeret peger på. Manuelle matches (conf 100) røres aldrig.
 *   2. Det MARKERER BETALT. Kontoret skal kunne se bankens virkelighed mellem
 *      e-conomic-opdateringerne — det er hele pointen med pengestrømmen. Den
 *      næste synk mod e-conomic er upåvirket: en faktura vi siger er betalt og
 *      e-conomic siger er åben, rapporteres som uenighed og flippes ikke tilbage.
 *   3. Beløbet tjekkes mod e-conomics EGET fakturabeløb (spejlet) når vi kender
 *      det — cf_invoices.beloeb kan mangle leveringen (ældre rækker), og så
 *      falder et rigtigt nummer-match på beløbstolerancen.
 *   4. Spejlets overskrift ("#B4130") bruges også: en bogført faktura hvis nummer
 *      ingen cf_invoice bærer, kan stadig kobles gennem bon-nummeret i overskriften.
 *
 * Flyttes en tx væk fra en faktura, rulles den KUN tilbage til ubetalt hvis
 * (a) ingen anden bankpostering peger på den, OG (b) e-conomic selv siger at
 * fakturaen stadig er åben (spejlets restbeløb > 0). Så var vores "betalt" et
 * beløbs-gæt uden dækning. Siger e-conomic betalt — eller kender vi ikke
 * fakturaen dér — bliver den stående: afstemningen daterer en e-conomic-
 * bekræftet betaling med bankposteringens dato, så datoen alene kan ikke skelne
 * "gættet" fra "bekræftet". Målt mod driftsdata rullede den første udgave 25
 * e-conomic-betalte fakturaer tilbage; denne rører kun de reelt åbne.
 *
 * Værn: nummer i tekst er ikke nok alene — beløbet skal passe (relativ tolerance
 * eller op til +extraMax kr over). Et tilfældigt firecifret tal må ikke koble.
 *
 * @returns {{ linked:number, paid:number, moved:number, changes:Array }}
 */
function matchByEconomicNumber(db, { dryRun = false } = {}) {
    const { relativePct, extraMax } = getTolerance(db);
    const ratio = relativePct / 100;

    const cfRows = db.prepare(`SELECT id, beloeb, betalt, betalt_dato, economic_number FROM cf_invoices`).all();
    const cfById = new Map(cfRows.map(r => [r.id, r]));
    const cfByIdDigits = new Map();
    for (const r of cfRows) { const k = digits(r.id); if (k && !cfByIdDigits.has(k)) cfByIdDigits.set(k, r); }

    // economic_number → [cf-rækker]   (én samlefaktura → flere bons deler nummer)
    const byNum = new Map();
    for (const r of cfRows) {
        const k = digits(r.economic_number);
        if (!k) continue;
        if (!byNum.has(k)) byNum.set(k, []);
        byNum.get(k).push(r);
    }
    // e-conomics eget fakturabeløb pr. nummer + overskrift → bon-nr → cf-række
    const grossByNo = new Map();
    const openAtEconomic = new Set();                     // numre e-conomic stadig har som ubetalte
    for (const m of db.prepare(`SELECT booked_no, gross_amount, remainder, heading FROM cf_economic_invoices`).all()) {
        const no = digits(m.booked_no);
        if (!no) continue;
        if (m.gross_amount != null) grossByNo.set(no, m.gross_amount);
        if (m.remainder > 0) openAtEconomic.add(no);
        if (byNum.has(no)) continue;                       // nummeret er allerede koblet direkte
        for (const bn of (m.heading || '').match(/\d{3,6}/g) || []) {
            const cf = cfByIdDigits.get(bn);
            if (cf) { byNum.set(no, [cf]); break; }
        }
    }

    // Kandidater: ukoblede — OG dem hvis nuværende match kun er et beløbs-gæt.
    // 95 = nummer-match (denne funktion / runMatchLogic med nummer), 100 = manuel.
    const cands = db.prepare(`SELECT id, dato, tekst, beloeb, matched_invoice_id, match_confidence FROM cf_transactions
        WHERE beloeb > 0 AND ignored = 0
          AND (matched_invoice_id IS NULL OR COALESCE(match_confidence, 0) < 95)`).all();

    const fits = (tx, inv, no) => {
        const base = grossByNo.get(no) ?? inv.beloeb;
        if (!(base > 0)) return false;
        const diff = tx.beloeb - base;
        return Math.abs(diff) / base <= ratio || (diff > 0 && diff <= extraMax);
    };

    const changes = [];
    for (const tx of cands) {
        const nums = tx.tekst.match(/\d{3,6}/g) || [];
        let hit = null;
        for (const n of nums) {
            for (const inv of byNum.get(n) || []) {
                if (fits(tx, inv, n)) { hit = inv; break; }   // nummer + beløb → høj sikkerhed
            }
            if (hit) break;
        }
        if (!hit) continue;
        const from = tx.matched_invoice_id && tx.matched_invoice_id !== hit.id ? tx.matched_invoice_id : null;
        changes.push({ tx_id: tx.id, tx_dato: tx.dato, invoice_id: hit.id, from_invoice_id: from,
                       marks_paid: hit.betalt !== 1 });
        hit.betalt = 1;                                     // to tx'er på samme faktura → kun én "paid"
    }

    let paid = 0, moved = changes.filter(c => c.from_invoice_id).length;
    if (!dryRun && changes.length) {
        const upd = db.prepare(`UPDATE cf_transactions SET matched_invoice_id = ?, match_confidence = 95 WHERE id = ?`);
        const markPaid = db.prepare(`UPDATE cf_invoices SET betalt = 1, betalt_dato = ?, betalingstype = COALESCE(betalingstype, 'bank')
                                     WHERE id = ? AND betalt = 0`);
        const anyTx = db.prepare(`SELECT COUNT(*) AS n FROM cf_transactions WHERE matched_invoice_id = ?`);
        const unpay = db.prepare(`UPDATE cf_invoices SET betalt = 0, betalt_dato = NULL WHERE id = ? AND betalt = 1`);
        // Pas 1: flyt alle links (og rul de nu dækningsløse fakturaer tilbage).
        for (const c of changes) upd.run(c.invoice_id, c.tx_id);
        for (const c of changes) {
            if (!c.from_invoice_id) continue;
            const prev = cfById.get(c.from_invoice_id);
            if (!prev || prev.betalt !== 1) continue;
            const stillOpen = openAtEconomic.has(digits(prev.economic_number));
            if (stillOpen && anyTx.get(c.from_invoice_id).n === 0 && unpay.run(c.from_invoice_id).changes > 0) {
                c.unpaid_previous = true;
            }
        }
        // Pas 2: markér betalt — EFTER alle flytninger, så en faktura der først blev
        // rullet tilbage og så fik sin rigtige postering ender som betalt.
        for (const c of changes) {
            if (markPaid.run(c.tx_dato, c.invoice_id).changes > 0) { paid++; c.marks_paid = true; }
            else c.marks_paid = false;
        }
    } else {
        paid = changes.filter(c => c.marks_paid).length;
    }
    return { linked: changes.length, paid, moved, changes };
}

module.exports = { reconcile, fetchBookedSince, fetchUnpaid, matchByEconomicNumber };
