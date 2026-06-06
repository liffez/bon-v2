-- 096_event_forecast.sql
-- ════════════════════════════════════════════════════════════
-- Forecast pr. kategori pr. dag for et event.
-- Spec: docs/CLAUDE_EVENT.md §6 (revideret efter design-session 2026-06-06).
--
-- Vigtigt: forecast er i FÆRDIG-PRODUKT-enheder (sandwich, slider, kage,
-- drikke) — ikke råvarer. Køkkenet bygger sandwich on-the-spot fra råvarer
-- vi tager med fra HQ. Forecast styrer:
--   - Hvor meget vi prepper (= BOM-eksploderet fra forecast)
--   - Top-up dag N forslag = forecast_dag_N − solgt_til_nu
--   - Pakkeliste tal-mål ("du har valgt 30 af 80 sandwich")
--
-- Kategorierne kommer fra Grocy `grupper`-userfield på recipes (jf. CLAUDE.md
-- "Kolonnenavne der ofte forveksles" → category er den kanoniske form).
-- Vi lagrer som TEXT så fri-tekst er muligt (drikke kan være Grocy-produkter
-- der ikke er recipes), og fordi Grocy-userfields ikke har FK-stabilitet.
--
-- UNIQUE(event_id, forecast_date, category) → idempotent PUT.
-- ON DELETE CASCADE: hvis eventet slettes, forsvinder forecasten med det.
-- ════════════════════════════════════════════════════════════

CREATE TABLE event_forecast (
    id              INTEGER PRIMARY KEY,
    event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    forecast_date   DATE    NOT NULL,
    category        TEXT    NOT NULL,
    expected_qty    INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(event_id, forecast_date, category)
);

CREATE INDEX idx_event_forecast_event_date ON event_forecast(event_id, forecast_date);
