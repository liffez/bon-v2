-- 135_event_menu_options.sql
-- ════════════════════════════════════════════════════════════
-- Tilvalg på eventmenuen (fx "Glutenfri Bolle +15 kr" på udvalgte sandwich).
--
-- Hvorfor: kunden skal kunne bestille "Tunen" OG "Tunen med glutenfri bolle"
-- som to tydeligt forskellige ting. Uden dette blev bollen en løsrevet linje i
-- kurven, og hverken køkken eller udlevering kunne se HVILKEN sandwich der
-- skulle have den.
--
--   item_type  = 'dish' (en ret, default) | 'option' (et tilvalg)
--   applies_to = JSON-array af menuKey ("r:<recipe_id>" | "n:<navn>") for de
--                retter tilvalget kan vælges på. NULL/tom = gælder ingen.
--
-- ⚠️  applies_to peger på menuKey — IKKE på event_menu_items.id.
-- PUT /:id/menu er en fuld-erstat (DELETE + INSERT), så rækkernes id'er skifter
-- ved hver gemning. menuKey er derimod stabil (opskrift-id, ellers navn) og er
-- allerede tabellens dedupe-nøgle. Skifter nogen dette til id'er, går alle
-- tilvalgs-koblinger tabt næste gang menuen gemmes.
--
-- Et tilvalg vises ALDRIG som selvstændig ret på bestillingssiden; det bliver
-- til et valg på de retter det gælder (Almindelig / <tilvalg>). Har et tilvalg
-- ingen applies_to, falder broen tilbage til at vise det som en almindelig ret,
-- så en halvt opsat linje ikke forsvinder i stilhed.
-- ════════════════════════════════════════════════════════════

ALTER TABLE event_menu_items ADD COLUMN item_type  TEXT NOT NULL DEFAULT 'dish';
ALTER TABLE event_menu_items ADD COLUMN applies_to TEXT;
