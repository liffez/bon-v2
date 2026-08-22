/**
 * services/posFinance.js
 * ════════════════════════════════════════════════════════════
 * Zettles hovedbog: gebyret pr. salgsdag og udbetalingens sammensætning.
 *
 * Spec: docs/CLAUDE_ZETTLE_POS.md §10 · Fase 3 (#510).
 *
 * Alt her hviler på fire ting der er MÅLT mod produktionskontoen (migration
 * 154's hoved har detaljerne):
 *   1. gebyret ligger pr. betaling, ikke pr. udbetaling
 *   2. nøglen til købet er `purchase.payments[].uuid` — ikke købets eget uuid
 *   3. gebyret bogføres samtidig med betalingen, så det aldrig kommer bagefter
 *   4. en udbetaling fejer saldoen: den er summen af alt siden forrige udbetaling
 *
 * ⚠️ Gebyret dækker KUN kort. MobilePay og kontant går uden om Zettles konto
 *    og må aldrig afstemmes mod en udbetaling.
 * ⚠️ Intet af dette rører `event_bridge_fee_pct` (Stripes gebyr på
 *    forudbestillinger, migration 137). De to lever side om side.
 * ════════════════════════════════════════════════════════════
 */

const round2 = n => Math.round(n * 100) / 100;

/**
 * Byg opslaget betalings-uuid → købets forretningsdag.
 * Betalings-uuid'erne ligger i den rå payload vi allerede har gemt, så der
 * skal ikke hentes noget for at kunne fordele gebyret.
 */
function paymentUuidIndex(purchaseRows) {
    const map = new Map();
    for (const row of purchaseRows) {
        let raw;
        try { raw = JSON.parse(row.raw_json); } catch { continue; }
        for (const p of raw.payments || []) {
            if (p?.uuid) map.set(p.uuid, { business_date: row.business_date, purchase_uuid: row.purchase_uuid });
        }
    }
    return map;
}

/**
 * Fordel hovedbogen på udbetalinger og salgsdage.
 *
 * Ren funktion: ingen database, ingen netværk. Tager hovedbogen (normaliseret)
 * og betalings-opslaget, og returnerer hvad der skal gemmes.
 *
 * `openingBalance` er saldoen FØR den første post i vinduet. Uden den kan en
 * udbetaling der fejer en balance opsparet før vinduet ikke gøres op — den
 * markeres derfor `partial: true` frem for at få et forkert regnestykke.
 */
function attributeLedger(ledger, paymentIndex, { openingBalance = 0 } = {}) {
    const sorted = [...ledger].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));

    const rows = [];          // hovedbogsposter med payout_uuid + business_date
    const payouts = [];
    const dayTotals = new Map();   // business_date → { card_gross, fee }

    let pending = [];         // poster siden sidste udbetaling
    let carried = openingBalance;
    let sawOpening = openingBalance !== 0;

    const flush = (payout) => {
        let gross = 0, fee = 0;
        const perDay = new Map();
        for (const r of pending) {
            const hit = r.business_date;
            if (r.tx_type === 'PAYMENT_FEE') fee += r.amount_incl;
            else if (r.tx_type === 'PAYMENT') gross += r.amount_incl;
            if (!hit) continue;
            const d = perDay.get(hit) || { business_date: hit, gross_incl: 0, fee_incl: 0 };
            if (r.tx_type === 'PAYMENT_FEE') d.fee_incl = round2(d.fee_incl + r.amount_incl);
            else if (r.tx_type === 'PAYMENT') d.gross_incl = round2(d.gross_incl + r.amount_incl);
            perDay.set(hit, d);
        }
        // Udbetalingen er negativ i hovedbogen; i banken lander den positivt.
        const amount = round2(-payout.amount_incl);
        const forklaret = round2(gross + fee + carried);
        payouts.push({
            payout_uuid: payout.originating_uuid,
            occurred_at: payout.occurred_at,
            amount_incl: amount,
            gross_incl: round2(gross),
            fee_incl: round2(fee),
            covered: [...perDay.values()].sort((a, b) => a.business_date.localeCompare(b.business_date)),
            // Stemmer summen af det vi har set med det der blev udbetalt?
            // Gør den ikke, er en del af perioden hentet uden for vinduet.
            partial: Math.abs(forklaret - amount) > 0.01,
            explained_incl: forklaret,
        });
        pending = [];
        carried = 0;
        sawOpening = true;
    };

    for (const tx of sorted) {
        const hit = tx.originating_uuid ? paymentIndex.get(tx.originating_uuid) : null;
        const row = {
            tx_type: tx.tx_type,
            originating_uuid: tx.originating_uuid,
            occurred_at: tx.occurred_at,
            amount_incl: tx.amount_incl,
            business_date: hit ? hit.business_date : null,
            payout_uuid: null,
        };
        if (tx.tx_type === 'PAYOUT') {
            for (const r of pending) r.payout_uuid = tx.originating_uuid;
            flush(tx);
        } else {
            pending.push(row);
            if (row.business_date) {
                const d = dayTotals.get(row.business_date) || { card_gross_incl: 0, fee_incl: 0 };
                if (tx.tx_type === 'PAYMENT_FEE') d.fee_incl = round2(d.fee_incl + tx.amount_incl);
                else if (tx.tx_type === 'PAYMENT') d.card_gross_incl = round2(d.card_gross_incl + tx.amount_incl);
                dayTotals.set(row.business_date, d);
            }
        }
        rows.push(row);
    }

    return {
        rows,
        payouts,
        days: [...dayTotals.entries()].map(([business_date, v]) => ({ business_date, ...v })),
        // Poster der endnu ikke er udbetalt — de er stadig på Zettle-kontoen.
        unsettled: round2(pending.reduce((s, r) => s + r.amount_incl, 0) + (sawOpening ? 0 : 0)),
    };
}

/**
 * Foreslå den bankpostering en udbetaling svarer til.
 *
 * Vi bogfører ALDRIG automatisk — det her er et forslag et menneske godkender.
 * Beløbet skal ramme; datoen bruges kun til at rangere, fordi en udbetaling
 * lander i banken et par dage efter den forlod Zettle.
 */
function suggestBankMatch(payout, transactions, { maxDaysAfter = 7, tolerance = 0.01 } = {}) {
    const day = String(payout.occurred_at || '').slice(0, 10);
    const cands = [];
    for (const tx of transactions) {
        if (Math.abs(tx.beloeb - payout.amount_incl) > tolerance) continue;
        const diff = Math.round((new Date(tx.dato + 'T00:00:00Z') - new Date(day + 'T00:00:00Z')) / 86400000);
        if (diff < 0 || diff > maxDaysAfter) continue;
        cands.push({ ...tx, days_after: diff });
    }
    return cands.sort((a, b) => a.days_after - b.days_after);
}

module.exports = { paymentUuidIndex, attributeLedger, suggestBankMatch, round2 };
