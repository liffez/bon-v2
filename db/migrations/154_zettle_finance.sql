-- 154_zettle_finance.sql
-- ════════════════════════════════════════════════════════════
-- Zettle Fase 3 (#510): faktisk gebyr + bankafstemning af udbetalingen.
-- Spec: docs/CLAUDE_ZETTLE_POS.md §10.
--
-- Bygger på fire ting der er MÅLT mod produktionskontoen, ikke antaget:
--
--   1. Gebyret ligger PR. BETALING (`PAYMENT_FEE`), ikke pr. udbetaling.
--   2. Nøglen til købet er betalingens uuid (`purchase.payments[].uuid`) —
--      IKKE købets eget uuid, som matcher 0 %. Betalings-uuid'et ligger
--      allerede i den rå payload vi gemmer i pos_purchases.raw_json.
--   3. Gebyret bogføres SAMTIDIG med betalingen (484 af 484 inden for 5 sek),
--      så en dags gebyr er kendt så snart dagens køb er hentet.
--   4. En udbetaling FEJER saldoen: den er præcis summen af alt siden forrige
--      udbetaling. Efterprøvet på fire udbetalinger — alle stemmer til øren.
--      Derfor kan vi udlede nøjagtigt hvilke dage en udbetaling dækker.
--
-- ⚠️ Gebyret dækker KUN kortbetalinger. MobilePay (158 køb på et år) og
--    kontant har ingen gebyrposter og går uden om Zettles konto — de penge
--    kommer ad en anden vej og må ikke afstemmes mod udbetalingen.
--
-- ⚠️ Dette har INTET med `event_bridge_fee_pct` (3 %) at gøre. Den er Stripes
--    andel af forudbestillinger gennem event-order-broen (migration 137) og
--    skal blive stående. Et event kan have begge.
-- ════════════════════════════════════════════════════════════

-- ── Zettles hovedbog ──────────────────────────────────────────────────────
-- Gemmes rå af samme grund som købene: dagens gebyr og en udbetalings
-- sammensætning bliver rene funktioner af rækker vi selv har, i stedet for at
-- afhænge af at Zettle svarer.
--
-- Rækkerne har ikke deres eget id — nøglen er (type, originating_uuid):
-- for PAYMENT/PAYMENT_FEE er det betalingens uuid, for PAYOUT udbetalingens.
CREATE TABLE IF NOT EXISTS pos_finance_tx (
    id               INTEGER PRIMARY KEY,
    source           TEXT    NOT NULL DEFAULT 'zettle',
    tx_type          TEXT    NOT NULL,          -- PAYMENT | PAYMENT_FEE | PAYOUT | …
    originating_uuid TEXT    NOT NULL,
    occurred_at      TEXT    NOT NULL,
    amount_incl      REAL    NOT NULL,          -- kroner, fortegn som Zettle: udbetaling er negativ
    payout_uuid      TEXT,                      -- hvilken udbetaling der fejede posten med
    business_date    TEXT,                      -- købets dag, når posten kan kobles til et køb
    synced_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, tx_type, originating_uuid)
);

CREATE INDEX IF NOT EXISTS idx_pos_fin_payout ON pos_finance_tx(payout_uuid);
CREATE INDEX IF NOT EXISTS idx_pos_fin_day    ON pos_finance_tx(business_date);

-- ── Udbetalinger ──────────────────────────────────────────────────────────
-- Én række pr. PAYOUT, med den sammensætning vi selv har regnet ud.
-- `cf_transaction_id` sættes først når et menneske har godkendt matchet —
-- vi bogfører aldrig automatisk.
CREATE TABLE IF NOT EXISTS pos_payouts (
    id                INTEGER PRIMARY KEY,
    source            TEXT    NOT NULL DEFAULT 'zettle',
    payout_uuid       TEXT    NOT NULL,
    occurred_at       TEXT    NOT NULL,
    amount_incl       REAL    NOT NULL,         -- POSITIVT: hvad der lander i banken
    gross_incl        REAL    NOT NULL DEFAULT 0,   -- kortsalg i perioden
    fee_incl          REAL    NOT NULL DEFAULT 0,   -- gebyr (negativt)
    covered_json      TEXT,                     -- [{business_date, gross_incl, fee_incl}]
    cf_transaction_id INTEGER REFERENCES cf_transactions(id) ON DELETE SET NULL,
    matched_at        TEXT,
    matched_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(source, payout_uuid)
);

-- ── Dagens gebyr + kortandel ──────────────────────────────────────────────
-- `card_gross_incl` er den del af dagen der reelt går gennem Zettles konto og
-- dermed det eneste der må afstemmes mod en udbetaling. `gross_incl` (hele
-- dagen) står uændret ved siden af.
ALTER TABLE pos_sales_days ADD COLUMN fee_incl       REAL    NOT NULL DEFAULT 0;
ALTER TABLE pos_sales_days ADD COLUMN card_gross_incl REAL   NOT NULL DEFAULT 0;
ALTER TABLE pos_sales_days ADD COLUMN fee_bon_id     INTEGER REFERENCES bons(id) ON DELETE SET NULL;

-- ── Indstilling ───────────────────────────────────────────────────────────
INSERT INTO settings (key, value, description)
SELECT 'zettle_fee_bon_enabled', '1',
       'Bogfør Zettles kortgebyr som en udgiftsbon pr. salgsdag. 0 = gebyret vises kun, men bogføres ikke.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'zettle_fee_bon_enabled');
