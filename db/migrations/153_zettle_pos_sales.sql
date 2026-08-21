-- 153_zettle_pos_sales.sql
-- ════════════════════════════════════════════════════════════
-- Zettle (PayPal POS) → én salgsbon pr. forretningsdag.
-- Spec: docs/CLAUDE_ZETTLE_POS.md §4 · Fase 2 (#509), epic #507.
--
-- Alt er inert efter denne migration: `zettle_enabled` er '0' og
-- `events.pos_enabled` er 0 på hvert eneste event. Ingen bon opstår af sig
-- selv — features tændes af mennesker, ikke af en migration.
-- ════════════════════════════════════════════════════════════

-- ── Rå køb ────────────────────────────────────────────────────────────────
-- Vi gemmer købene i stedet for kun at aggregere: dagens tal bliver dermed en
-- REN FUNKTION af rækker vi selv har (testbar uden netværk, gen-kørbar når
-- Zettle er nede), timekurven er et GROUP BY væk, og UNIQUE(purchase_uuid)
-- gør re-synk gratis idempotent. Samme instinkt som frosne cost_price/co2e-
-- snapshots: gem hvad du så.
--
-- Varelinjer udledes af raw_json ved aggregering — ikke en tabel mere.
-- Volumen er lille (målt: 8 salgsdage på et år, største dag 230 køb), og
-- hele parse-logikken bor så ét testbart sted (services/posSales.js).
CREATE TABLE IF NOT EXISTS pos_purchases (
    id             INTEGER PRIMARY KEY,
    source         TEXT    NOT NULL DEFAULT 'zettle',
    purchase_uuid  TEXT    NOT NULL,
    purchase_no    INTEGER,
    occurred_at    TEXT    NOT NULL,            -- som POS'en leverer det (UTC-mærket)
    business_date  TEXT    NOT NULL,            -- afledt med døgnskiftet (§6.1)
    amount_incl    REAL    NOT NULL,            -- kroner INCL moms (negativ ved refundering)
    vat_amount     REAL    NOT NULL DEFAULT 0,
    payment_type   TEXT,
    site_uuid      TEXT,                        -- POS-salgssted → events.pos_store_ref
    is_refund      INTEGER NOT NULL DEFAULT 0,
    raw_json       TEXT    NOT NULL,
    synced_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, purchase_uuid)
);

CREATE INDEX IF NOT EXISTS idx_pos_purchases_day  ON pos_purchases(business_date);
CREATE INDEX IF NOT EXISTS idx_pos_purchases_site ON pos_purchases(site_uuid);

-- ── Dagen: ejerskab + opsummering ─────────────────────────────────────────
-- Både ejerskabsregister (som event_bridge_bons, migration 137 — broen må
-- ALDRIG røre en bon et menneske har lavet) og dagens opsummering.
--
-- Betalingsmiddel-splittet bor her, fordi bankafstemningen (§10, Fase 3) kun
-- må holde kort/MobilePay-delen op mod POS-udbetalingen: kontanter ligger i
-- en kasse og rammer aldrig kontoen.
--
-- event_id NULL er en GYLDIG tilstand: dagen er hentet, men ingen ved hvilket
-- event den hører til. Den skal kunne ses og kobles bagefter — ikke forsvinde.
CREATE TABLE IF NOT EXISTS pos_sales_days (
    id              INTEGER PRIMARY KEY,
    source          TEXT    NOT NULL DEFAULT 'zettle',
    business_date   TEXT    NOT NULL,
    event_id        INTEGER REFERENCES events(id) ON DELETE SET NULL,
    bon_id          INTEGER REFERENCES bons(id)   ON DELETE SET NULL,
    assign_status   TEXT    NOT NULL DEFAULT 'unassigned'
                      CHECK (assign_status IN ('unassigned','auto','manual','ambiguous')),
    gross_incl      REAL    NOT NULL DEFAULT 0,
    by_payment_json TEXT,                       -- {"IZETTLE_CARD":9105.0,"MOBILE_PAY":420.0}
    purchase_count  INTEGER NOT NULL DEFAULT 0,
    refund_count    INTEGER NOT NULL DEFAULT 0,
    unmatched_json  TEXT,                       -- POS-varer uden Grocy-kobling
    flags_json      TEXT,                       -- fx mistænkt fakturabetaling over terminalen
    last_synced_at  TEXT,
    last_error      TEXT,
    UNIQUE(source, business_date)
);

CREATE INDEX IF NOT EXISTS idx_pos_sales_days_event ON pos_sales_days(event_id);

-- ── Produktkobling ────────────────────────────────────────────────────────
-- POS-produkter har egne UUID'er. bons_lines.pos_product_id findes (migration
-- 002) men er INTEGER og kan ikke bære en UUID — koblingen bor derfor her.
--
-- Målt på ægte data (§15): eksakt navnematch dækker 50 % af omsætningen,
-- ordsæt-match 65 %. DELSTRENGS-MATCH ER FORBUDT — det gav forkerte match på
-- tre varer, hver gang en slider på den fuldstore ret. En slider til 55 kr
-- ville arve den fuldstore rets kostpris, CO₂ og STYKLISTE og dermed forgifte
-- top-up-/retur-forslaget. Resten kobles i hånden her.
--
-- grocy_recipe_id NULL + decided_at sat = "besluttet: findes ikke i Grocy"
-- (fx Luxus hotdog, 20 % af festivalens omsætning). Det er en gyldig beslutning
-- og skal kunne skelnes fra "ingen har kigget på den endnu" (ingen række).
CREATE TABLE IF NOT EXISTS pos_product_map (
    id              INTEGER PRIMARY KEY,
    source          TEXT    NOT NULL DEFAULT 'zettle',
    pos_product_uuid TEXT   NOT NULL,
    grocy_recipe_id INTEGER,
    name_seen       TEXT,                       -- POS-navnet da koblingen blev lavet
    decided_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    decided_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(source, pos_product_uuid)
);

-- ── Tilvalg pr. event ─────────────────────────────────────────────────────
-- Eventet slår POS til SELV. Det er ikke systemet der udleder hvilket event et
-- køb hører til (§6.2) — et forkert gæt ville lægge det ene events omsætning
-- på det andet, og det ville se helt rigtigt ud.
--
-- Default 0 ⇒ denne migration ændrer intet for eksisterende events.
ALTER TABLE events ADD COLUMN pos_enabled   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN pos_store_ref TEXT;

-- ── Indstillinger ─────────────────────────────────────────────────────────
INSERT INTO settings (key, value, description)
SELECT 'zettle_enabled', '0',
       'Master-kontakt for POS-synk fra Zettle. 0 = slukket; intet hentes og ingen bons oprettes.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'zettle_enabled');

INSERT INTO settings (key, value, description)
SELECT 'zettle_business_day_cutoff', '04:00',
       'Hvornår en salgsdag skifter. Et køb kl. 01:30 hører til dagen før. Der lukkes typisk ved 24, men det trækker ud.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'zettle_business_day_cutoff');

INSERT INTO settings (key, value, description)
SELECT 'zettle_poll_minutes', '10',
       'Hvor ofte der hentes køb fra Zettle. 0 = ingen automatisk polling (kun manuel synk).'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'zettle_poll_minutes');

INSERT INTO settings (key, value, description)
SELECT 'zettle_resync_days', '3',
       'Hvor mange dage bagud der gen-synkes ved hver polling. Fanger sene refunderinger; derefter fryser dagen.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'zettle_resync_days');

INSERT INTO settings (key, value, description)
SELECT 'zettle_default_price_category', 'festival',
       'Priskategori på POS-salgsbonnen. Prisen kommer fra POS-kvitteringen; kategorien er kun mærkning.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'zettle_default_price_category');
