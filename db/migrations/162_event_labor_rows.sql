-- 162_event_labor_rows.sql
-- ════════════════════════════════════════════════════════════════════════
-- Standard-timerne kan rettes pr. event (§18.6).
--
-- Transport, op- og nedtagning kommer fra faste tal i Settings, og det er
-- rigtigt som udgangspunkt — men det ene event ligner sjældent det næste.
-- Kranen var i stykker, eller pladsen lå fem minutter væk, eller I var tre i
-- bilen. Uden en vej til at rette det er tallet enten forkert eller ubrugt.
--
-- Rækkerne beregnes fortsat LIVE fra Settings. Først en RETTELSE skriver en
-- række her — så har et event ingen har rørt stadig et tal, og en ændret
-- setting rammer ikke lukkede events. Samme mønster som top-up, salgs-prefill
-- og event-menuen.
--
-- `kind` matcher de kilder computeEventLabor allerede producerer, så en
-- rettelse ERSTATTER sin egen linje frem for at lægge en ny ved siden af.
-- 'onsite' og 'other' er med fra start: næste skridt er folk der slet ikke er
-- i Smartplan, og de er samme slags række — ikke en ny tabel.
--
-- `rate` NULL = brug eventets standardsats (event_labor_owner_rate, eller
-- gennemsnittet af de registrerede satser). 0 er en gyldig værdi og betyder
-- ulønnet — derfor NULL og ikke 0 som "ikke sat".
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE event_labor (
    id                 INTEGER PRIMARY KEY,
    event_id           INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind               TEXT    NOT NULL
                         CHECK (kind IN ('setup','teardown','trailer','transport','onsite','other')),
    label              TEXT,
    persons            REAL    NOT NULL DEFAULT 1 CHECK (persons >= 0),
    hours              REAL    NOT NULL CHECK (hours >= 0),
    rate               REAL    CHECK (rate IS NULL OR rate >= 0),
    note               TEXT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by_user_id INTEGER REFERENCES users(id)
);

-- Én rettelse pr. standard-linje pr. event: rettelsen ERSTATTER linjen.
-- 'onsite'/'other' er derimod frie rækker (flere frivillige på samme event),
-- så indekset er partielt.
CREATE UNIQUE INDEX idx_event_labor_kind ON event_labor(event_id, kind)
    WHERE kind IN ('setup','teardown','trailer','transport');
CREATE INDEX idx_event_labor_event ON event_labor(event_id);
