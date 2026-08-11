-- 145_offer_days.sql
--
-- Fler-dags-tilbud (#425): ét bilag til kunden, én bon pr. dag ved accept.
--
-- Et tilbud ER en `bons`-række (is_offer=1) og har derfor præcis ÉN
-- `delivery_date`. Et flerdags-arrangement — tre dages konference med levering
-- hver dag — kunne kun rummes som tre separate tilbud med hver sit T-nummer:
-- kunden fik tre PDF'er, ingen samlet total, og rabat + gyldighed skulle holdes
-- ens i hånden tre steder.
--
-- ── Hvorfor en tabel og ikke JSON ────────────────────────────────────────────
-- `offer_block_metadata` bærer allerede pax pr. blok og gemte blokke, og det var
-- fristende at lægge dagene der. Men en dag bærer en DATO, og datoer skal kunne
-- filtreres og joines: "hvilke tilbud har levering på fredag" er et rimeligt
-- spørgsmål, og det kan man ikke stille til en JSON-klump.
--
-- ── Arv frem for gentagelse ──────────────────────────────────────────────────
-- Kun `delivery_date` er påkrævet. Tid, pax og adresse er NULLABLE, og NULL
-- betyder "brug tilbuddets egen værdi" — ikke "tom". Dagene ligger som regel
-- samme sted med samme antal, så man skriver kun det der afviger. Ændrer man
-- tilbuddets pax bagefter, følger alle dage med af sig selv.

CREATE TABLE IF NOT EXISTS offer_days (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    bon_id              INTEGER NOT NULL,      -- tilbuds-bonnen (is_offer=1)
    sort_order          INTEGER NOT NULL DEFAULT 0,

    delivery_date       DATE    NOT NULL,      -- det eneste dagen SKAL have

    -- NULL = arv fra tilbuddet. Se hovedkommentaren.
    delivery_time       TEXT,
    pickup_time         TEXT,
    pax                 INTEGER,
    delivery_address_id INTEGER,

    label               TEXT,                  -- fx "Dag 2 — workshop", valgfri
    note                TEXT,

    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (bon_id)              REFERENCES bons(id)      ON DELETE CASCADE,
    FOREIGN KEY (delivery_address_id) REFERENCES addresses(id)
);

CREATE INDEX IF NOT EXISTS idx_offer_days_bon  ON offer_days(bon_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_offer_days_date ON offer_days(delivery_date);

-- ── Hvilken dag hører linjen til? ────────────────────────────────────────────
-- NULL betyder "alle dage" — ikke "ingen". Kaffe og emballage går igen hver dag,
-- og de skal ikke tastes tre gange for at komme med tre gange. Ved konvertering
-- kopieres en NULL-linje til hver dagsbon.
--
-- ON DELETE SET NULL: slettes en dag, bliver dens linjer til fælles-linjer i
-- stedet for at forsvinde. Det er den skånsomme fejl — office kan se dem og
-- flytte dem, frem for at opdage et tab efter at tilbuddet er sendt.
ALTER TABLE bon_lines ADD COLUMN offer_day_id INTEGER REFERENCES offer_days(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bon_lines_offer_day ON bon_lines(offer_day_id);

-- ── Sporbarhed tilbage til tilbuddet ─────────────────────────────────────────
-- Et fler-dags-tilbud bliver til N bons. Uden dette felt kan man bagefter ikke
-- se at de fem bons kom fra samme bilag — hverken for at finde den aftalte pris
-- eller for at forstå hvorfor de ligner hinanden.
--
-- Ét-dags-tilbud konverterer stadig ved at flippe `is_offer` på samme række
-- (uændret adfærd), så dér peger feltet på bonnen selv og forbliver NULL.
ALTER TABLE bons ADD COLUMN source_quote_id INTEGER REFERENCES bons(id);

CREATE INDEX IF NOT EXISTS idx_bons_source_quote ON bons(source_quote_id);
