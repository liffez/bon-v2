-- 137_event_bridge_roles.sql
-- ════════════════════════════════════════════════════════════
-- Broen laver nu TRE bons pr. event-dag i stedet for én — samme format som
-- resten af event-modulet (§3):
--
--   prep  → produktion, 0 kr, GODKENDT   køkkenet: hvad skal laves (trækker lager)
--   sales → festival, RIGTIGE priser, BETALT   omsætningen: det kunden betalte
--   fee   → udgift (event_role='expense'), negativ, is_internal=1   Stripe-gebyr
--
-- Hvorfor salgsbonnen skal findes: pengene fra Stripe lander samlet i banken,
-- og uden en bon med rigtige priser er der intet at afstemme udbetalingen mod.
-- Priserne må IKKE bare lægges på prep-bonnen: en produktion-bon indgår som
-- VAREFORBRUG i P&L'en, så samme linje ville tælle som både omkostning og
-- omsætning. Adskilt holder regnskabet: prep giver forbrug, sales giver
-- omsætning, fee giver udgift. No-deduct-gaten (§5) sikrer at salgsbonnen
-- ikke dobbelt-trækker lager — prep-bonnen ejer trækket.
--
-- Gebyret er et ESTIMAT (sats i settings, default 3 %). Stripes præcise
-- afregning kendes først på balance-transaktionen. Det er bevidst valgt at
-- generere det automatisk: en udgift der kun bogføres "hvis jeg husker det"
-- bliver systematisk glemt.
--
-- Tabellen genskabes fordi UNIQUE(event_id, delivery_date) fra migration 136
-- er et implicit auto-indeks der ikke kan droppes. Eksisterende rækker (hvis
-- 136 nåede at køre) bæres over som rolle 'prep' — det var alt den lavede.
-- ════════════════════════════════════════════════════════════

CREATE TABLE event_bridge_bons_new (
    id            INTEGER PRIMARY KEY,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    delivery_date TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'prep',   -- prep | sales | fee
    bon_id        INTEGER NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id, delivery_date, role)
);

INSERT INTO event_bridge_bons_new (id, event_id, delivery_date, role, bon_id, created_at, updated_at)
    SELECT id, event_id, delivery_date, 'prep', bon_id, created_at, updated_at FROM event_bridge_bons;

DROP TABLE event_bridge_bons;
ALTER TABLE event_bridge_bons_new RENAME TO event_bridge_bons;

CREATE INDEX idx_event_bridge_bon ON event_bridge_bons(bon_id);

-- Stripe-gebyr i procent af bruttoomsætningen. Tom/0 = ingen gebyr-bon.
INSERT OR IGNORE INTO settings (key, value) VALUES ('event_bridge_fee_pct', '3');
