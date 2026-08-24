-- 163_smartplan_mirror.sql
-- ════════════════════════════════════════════════════════════
-- Lokalt spejl af Smartplans vagter, så LÆSNING aldrig rammer deres API.
--
-- Baggrund (23.-24. august 2026): seks kaldesteder hentede hver for sig, med
-- hver sin cache-nøgle. Ingen ejede beslutningen om hvornår vi taler med
-- Smartplan. Fire af dem hentede oven i købet ved HVER SSE-hændelse. Så længe
-- alt virkede, opslugte cachen det — men cachen fyldes kun ved succes, så i det
-- sekund Smartplan fejlede, forsvandt vores eneste bremse, og hvert eneste
-- opslag blev til et rigtigt kald igen. Resultatet var en throttling der holdt
-- sig selv i live.
--
-- Med spejlet er kald-frekvensen en funktion af ÉN synkronisering, ikke af hvor
-- mange skærme der står tændt. Og en Smartplan der er nede betyder "vagtplanen
-- er fra kl. 14.05" i stedet for "der er ingen vagter".
--
-- Rå felter gemmes; location_class udledes ved LÆSNING, så et skift af
-- HQ-lokation i Settings slår igennem uden at skulle synkronisere om.

-- Rå records fra Smartplan, ikke udpakkede felter. Normaliseringen (og dermed
-- location_class, timer, åben-vagt osv.) sker ved LÆSNING med de funktioner der
-- allerede findes. To grunde:
--   · Ingen anden kopi af udpakningen der kan skride fra den rigtige.
--   · Ændrer man HQ-lokationen i Settings, slår det igennem med det samme —
--     uden at skulle synkronisere hele vinduet om.
CREATE TABLE IF NOT EXISTS smartplan_shifts (
    uuid       TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('shift','worklog')),
    date       TEXT NOT NULL,             -- YYYY-MM-DD, udledt ved skrivning så vi kan slå op på interval
    raw_json   TEXT NOT NULL,
    synced_at  TEXT NOT NULL,
    PRIMARY KEY (uuid, source)
);

CREATE INDEX IF NOT EXISTS idx_sp_shifts_date ON smartplan_shifts(date);

-- Én række. Bærer hvad vi ved om spejlets tilstand: hvornår det sidst lykkedes,
-- hvilket vindue der er dækket, og hvad der eventuelt gik galt sidst.
CREATE TABLE IF NOT EXISTS smartplan_sync_state (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    last_success_at  TEXT,
    last_attempt_at  TEXT,
    last_error       TEXT,
    window_from      TEXT,
    window_to        TEXT,
    rows_synced      INTEGER NOT NULL DEFAULT 0,
    last_reason      TEXT
);

INSERT OR IGNORE INTO smartplan_sync_state (id) VALUES (1);

-- Afbryderen: standser ALLE udgående Smartplan-kald. Uden den kunne en
-- blokering ikke få lov at løbe ud i fred — noget ville altid prøve igen.
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('smartplan_enabled', '1', 'Slå Smartplan-integrationen til/fra. 0 = ingen udgående kald overhovedet.'),
    ('smartplan_sync_interval_min', '20', 'Minutter mellem automatiske synkroniseringer af vagtplanen.'),
    ('smartplan_window_back_days', '180', 'Hvor langt tilbage spejlet dækker.'),
    ('smartplan_window_forward_days', '60', 'Hvor langt frem spejlet dækker.');
