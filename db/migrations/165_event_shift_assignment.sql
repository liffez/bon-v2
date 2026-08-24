-- 165_event_shift_assignment.sql
-- ════════════════════════════════════════════════════════════
-- Hvilket event hører en vagt til?
--
-- Eventets løn hentes på dato + lokation (CLAUDE_EVENT.md §18.3, Model A).
-- Kører to events samme weekend, ser de derfor BEGGE alle vagter på
-- event-lokationen i perioden, og begge P&L'er tæller de samme kroner.
--
-- Smartplan kan ikke svare på det: der er én lokation ("Festivaler og Events"),
-- og noten er fritekst til medarbejderen — målt 24. august 2026 var 366 af 417
-- vagter uden note, og de 51 med blandede sted, sygemelding og arbejdsbesked
-- ("der skal laves 49 slidere i alt :-)"). To vagter dækkede oven i købet to
-- steder samtidig ("I HQ 8-11 og Tivoli bagefter"). Feltet bruges rigtigt —
-- til beskeder — og skal ikke kapres.
--
-- Derfor afgøres det HER, i Bon, hvor vi allerede har alle vagterne i spejlet.
--
-- Tre tilstande, alle med betydning:
--   ingen række       → standard: alle overlappende events tæller vagten
--                       (uændret adfærd; rigtigt når kun ét event kører)
--   event_id = N      → KUN event N tæller den
--   event_id = NULL   → INTET event tæller den (fx en HQ-vagt der ligger
--                       forkert, eller noget helt tredje den dag)
--
-- Nøglen matcher spejlets primærnøgle (uuid, source).

CREATE TABLE IF NOT EXISTS event_shift_assignments (
    shift_uuid          TEXT    NOT NULL,
    source              TEXT    NOT NULL CHECK (source IN ('shift','worklog')),
    event_id            INTEGER REFERENCES events(id) ON DELETE CASCADE,
    assigned_by_user_id INTEGER REFERENCES users(id),
    assigned_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    note                TEXT,
    PRIMARY KEY (shift_uuid, source)
);

CREATE INDEX IF NOT EXISTS idx_esa_event ON event_shift_assignments(event_id);
