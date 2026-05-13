# PATCH_D_force_mode.md (v2 — omskrevet)

> Patch D til Bon v2 — implementér `force: true`-parameter på status-PATCH
> endpoint så admins kan overstyre status-transitions der ellers er forbudt.
>
> Lukker #005 (force-mode dokumenteret men ikke implementeret).
> Lukker T_BON_API_FORCE_01 SKIP (omskrives til PASS).
>
> **v2 omskrevet** efter 3 reelle problemer fundet i v1:
> - D-1: Patch'ens find/replace-blok matchede ikke faktisk kode (raw INSERT
>   vs `logChange()`-helper)
> - D-2: Raw INSERT havde forkert kolonne-rækkefølge (manglede `field_name`,
>   havde `user_id` på forkert plads)
> - D-3: **Sikkerheds-bug** — `body.user_id` til rolle-tjek lader en kitchen-
>   bruger eskalere til admin ved at sende `user_id=1` i body

---

## Baggrund

`CLAUDE.md` har dokumenteret force-mode siden v2-start, men `routes/bons.js`
har aldrig tjekket parameteren. Stuck bonner kan kun rettes via DB-UPDATE.
T_BON_API_FORCE_01 står som SKIP.

Beslutning (Leif, maj 2026): **implementér** force-mode med rolle-tjek.

---

## v1 → v2 rettelser

### D-1: Brug `logChange()`-helper, ikke raw INSERT

Patch v1 viste en raw INSERT mod changelog-tabellen. Det er forkert
konvention — `BON_V2_PRINCIPPER.md` §6 siger eksplicit:
*`logChange({...})` — objekt-API, aldrig positionelle argumenter*.

v2 udvider `logChange()`-helperen i `db/helpers.js` med et nyt felt
`wasForced` der propagerer til `payload`-kolonnen. Resten af koden er
uændret.

### D-2: `logChange()` håndterer kolonne-rækkefølge

Når vi bruger helperen er kolonne-mismatch ikke et problem længere —
helperen ejer schema-detaljerne. v1's raw INSERT havde forkert
kolonne-rækkefølge der ville have skrevet `oldValue` ind i `field_name`-
kolonnen og brudt audit-trailen.

### D-3: Identitet kommer fra session, ikke fra body

**Det her er den vigtigste rettelse.** v1 brugte `body.user_id` til at slå
rolle op. Det betyder at en kitchen-bruger der er logget ind kan sende
`user_id=1` (en admin's id) i request body og bypasse rolle-tjekket —
fordi `requireAuth()` lader dem komme ind (de er jo logget ind) og body
påligger ikke noget yderligere bevis.

**Korrekt mønster:** brug `req.session.userId` til identitet. Det sætter
`requireAuth()` baseret på sessionen, ikke på client-controlled input.

Hvis Bon v2 har en `requireAuth('admin')`-variant, brug den direkte ved
entry-tjek hvis `force=true` — det er endnu cleaner.

---

## Patchen består af 3 ÆNDRINGER

### Ændring 1 af 3 — Udvid `logChange()` med `wasForced`-flag

**Find** i `db/helpers.js` `logChange`-funktionen. Den nuværende signatur
(jf. v1's screenshot fra Claude Code):

```javascript
logChange({
    entityType: 'bon',
    entityId: id,
    action: 'status_change',
    fieldName: 'status_id',
    oldValue: bon.current_code,
    newValue: status_code,
    userId: user_id ?? null
});
```

**Udvid signaturen** så funktionen accepterer optional `wasForced`-felt der
skrives til `payload`-kolonnen. Den eksisterende kode-base får ny parameter
men er bagudkompatibel — eksisterende kald uden `wasForced` virker som før.

Find `logChange`-funktionen i `db/helpers.js` (formentlig omkring linje 30-80)
og opdatér den til:

```javascript
function logChange({
    entityType,
    entityId,
    action,
    fieldName = null,
    oldValue = null,
    newValue = null,
    userId = null,
    notes = null,
    wasForced = false        // NY parameter
}) {
    const db = getDb();
    const payload = wasForced
        ? JSON.stringify({ was_forced: true, by_user_id: userId })
        : null;

    db.prepare(`
        INSERT INTO changelog (
            entity_type, entity_id, action, field_name,
            old_value, new_value, user_id, notes, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        entityType,
        entityId,
        action,
        fieldName,
        oldValue !== null ? String(oldValue) : null,
        newValue !== null ? String(newValue) : null,
        userId,
        notes,
        payload
    );
}
```

**Forudsætning:** `changelog`-tabellen skal have `payload TEXT`-kolonne.
Tjek schema:

```bash
sqlite3 data/test.db ".schema changelog" | grep -i payload
```

Hvis manglende, tilføj migration:

```sql
-- db/migrations/059_changelog_payload.sql
ALTER TABLE changelog ADD COLUMN payload TEXT;
```

---

### Ændring 2 af 3 — Force-mode-tjek i status-PATCH

**Vigtigt:** Identitet kommer fra session (ikke body). Body kan stadig
overrides bruger-id for audit-formål (fx batch-systemer), men rolle-
verifikation går altid mod session.

**Find** i `routes/bons.js` PATCH `/:id/status`-handler (omkring linje 316-360):

```javascript
router.patch('/:id/status', requireAuth(), handle((req, res) => {
    const db = getDb();
    const bonId = parseInt(req.params.id);
    const { status_code, user_id, notes } = req.body;

    if (!status_code) return res.status(400).json({ error: 'status_code er påkrævet' });

    const bon = db.prepare(`SELECT id, current_code FROM bons WHERE id = ?`).get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const statusDef = db.prepare(`SELECT code FROM status_definitions WHERE code = ?`).get(status_code);
    if (!statusDef) return res.status(400).json({ error: `Ukendt status: ${status_code}` });

    const transition = db.prepare(`
        SELECT 1 FROM status_transitions
        WHERE from_status = ? AND to_status = ? AND is_active = 1
    `).get(bon.current_code, status_code);

    if (!transition) {
        return res.status(400).json({ error: `Transition ${bon.current_code} → ${status_code} er ikke tilladt` });
    }

    // ... eksisterende UPDATE bons SET current_code, plus logChange-kald
```

**Erstat med:**

```javascript
router.patch('/:id/status', requireAuth(), handle((req, res) => {
    const db = getDb();
    const bonId = parseInt(req.params.id);
    const { status_code, user_id: bodyUserId, notes, force } = req.body;

    if (!status_code) return res.status(400).json({ error: 'status_code er påkrævet' });

    const bon = db.prepare(`SELECT id, current_code FROM bons WHERE id = ?`).get(bonId);
    if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

    const statusDef = db.prepare(`SELECT code FROM status_definitions WHERE code = ?`).get(status_code);
    if (!statusDef) return res.status(400).json({ error: `Ukendt status: ${status_code}` });

    // Force-mode: rolle-tjek baseret på SESSION (ikke body!)
    const isForce = force === true;
    let isAdmin = false;
    if (isForce) {
        const sessionUserId = req.session?.userId;
        if (!sessionUserId) {
            // requireAuth() bør have fanget dette, men dobbelt-tjek
            return res.status(401).json({ error: 'Force-mode kræver login' });
        }
        const sessionUser = db.prepare(
            `SELECT role FROM users WHERE id = ? AND is_active = 1`
        ).get(sessionUserId);
        if (!sessionUser) {
            return res.status(401).json({ error: 'Session-bruger ikke gyldig' });
        }
        if (sessionUser.role !== 'admin') {
            return res.status(403).json({ error: 'Force-mode kræver admin-rolle' });
        }
        isAdmin = true;
    }

    // Tjek at transition er tilladt (springes over hvis force+admin verificeret)
    if (!(isForce && isAdmin)) {
        const transition = db.prepare(`
            SELECT 1 FROM status_transitions
            WHERE from_status = ? AND to_status = ? AND is_active = 1
        `).get(bon.current_code, status_code);

        if (!transition) {
            return res.status(400).json({
                error: `Transition ${bon.current_code} → ${status_code} er ikke tilladt`,
                hint: 'Admins kan overstyre med {force: true}'
            });
        }
    }

    // ... eksisterende UPDATE bons SET current_code
    // (uændret)

    // logChange — udvidet med wasForced-flag
    // userId kommer fra body hvis givet (audit-formål), ellers session.
    // ROLLEN er allerede bekræftet via session ovenfor — body kan ikke ændre auth.
    const auditUserId = bodyUserId ?? req.session?.userId ?? null;
    logChange({
        entityType: 'bon',
        entityId: bonId,
        action: 'status_change',
        fieldName: 'status_id',
        oldValue: bon.current_code,
        newValue: status_code,
        userId: auditUserId,
        notes: notes ?? null,
        wasForced: isForce && isAdmin
    });

    // ... resten af handleren (broadcast, response) — uændret
}));
```

**Tre vigtige punkter:**

1. `bodyUserId` (omdøbt fra `user_id`) bruges KUN til audit-logging — ikke
   til rolle-tjek. Rollen kommer altid fra session.
2. `req.session.userId` er kilden til identitet ved force-tjek.
3. Hvis Bon v2 har `requireAuth('admin')` som variant, kan entry-guard
   forenkles til `requireAuth(isForce ? 'admin' : undefined)`. Men det
   kræver at vi læser body før requireAuth kører — komplekst. Den indlejrede
   version ovenfor er enklere og tilstrækkelig.

---

### Ændring 3 af 3 — T_BON tests udvides

7 nye test-cases der dækker både happy path og de tre v2-rettelser
(særligt D-3 — privilege escalation).

**Tilføj til `tests/scripts/run_T_BON.js`** (eller separat patch-regression-fil):

```
T_BON_API_FORCE_01:
  Setup: session som admin (login som user med role='admin')
  POST { force: true, status_code: '<forbudt-transition-target>' }
  Forventet: 200, transition gennemført

T_BON_API_FORCE_02:
  Setup: session som kitchen-bruger (role='kitchen')
  POST { force: true, status_code: '<forbudt-transition>' }
  Forventet: 403 "Force-mode kræver admin-rolle"

T_BON_API_FORCE_03 (D-3-regression — privilege escalation):
  Setup: session som kitchen-bruger
  POST { force: true, status_code: '<forbudt>', user_id: 1 (admin's id) }
  Forventet: 403 "Force-mode kræver admin-rolle"
  (Body user_id må IKKE påvirke rolle-tjek)

T_BON_API_FORCE_04:
  Setup: ingen session (logget ud)
  POST { force: true, ... }
  Forventet: 401 (fra requireAuth)

T_BON_API_FORCE_05 (regression — ikke-force virker som før):
  Setup: enhver session
  POST { status_code: <forbudt>, force: false }
  Forventet: 400 "Transition ikke tilladt" som hidtil

T_BON_API_FORCE_06 (terminal-transition):
  Setup: session som admin
  POST { force: true, status_code: 'IGANG' } på en FAKTURERET bon
  Forventet: 200 (kan force'e fra terminal)

T_BON_API_FORCE_07 (audit):
  Setup: session som admin, send force-skift
  Tjek changelog efter skift:
  - row har action='status_change'
  - payload kolonne = '{"was_forced":true,"by_user_id":<admin-id>}'
  - field_name='status_id', old_value=<før>, new_value=<efter>
  - Verificér at field_name er KORREKT placeret (regression mod D-2)
```

**Note om T_BON_API_FORCE_03:** Det er den vigtigste case. Den skal
verificere at kitchen-brugere ikke kan eskalere ved at sende admin's
user_id i body. Hvis denne case PASSER, har vi reelt lukket privilege-
escalation-vektoren.

---

## Forudsætninger

| | |
|---|---|
| **changelog.payload-kolonne** | Tjek schema. Hvis manglende, migration 059 kræves |
| **Session.userId** | Verificér at `req.session.userId` er den korrekte property-sti. Tjek `shared/auth.js` |
| **Test-admin + test-kitchen brugere** | T_BON skal kunne logge ind som begge roller. Tilføj seed hvis nødvendigt |
| **`requireAuth('admin')`-variant** | Hvis den eksisterer, kan entry-guard forenkles. Hvis ikke, brug indlejret tjek som vist |

---

## Verificering efter patch

### 1. Regression

```bash
npm run test:reset
npm run test:server &

# Eksisterende tests skal forblive grønne
npm run test:run-bon              # forventet: 18 (gammel) → 25 (med 7 nye force-cases)
npm run test:run-stock            # 31/31 uændret
npm run test:run-inv              # 13/13 uændret
# osv. — alle øvrige tracks uændrede
```

### 2. Manuel verifikation af D-3 (privilege escalation-fix)

```bash
# Log ind som kitchen-bruger
curl -c cookies.txt -X POST http://localhost:4322/api/auth/login \
  -d '{"username": "kitchen", "password": "..."}'

# Prøv at force'e med admin's user_id i body
curl -b cookies.txt -X PATCH http://localhost:4322/api/bons/4001/status \
  -H "Content-Type: application/json" \
  -d '{
    "status_code": "IGANG",
    "force": true,
    "user_id": 1
  }'

# Forventet (efter patch): 403 "Force-mode kræver admin-rolle"
# Før patch v2 ville den have returneret 200 — privilege escalation
```

### 3. Audit-log korrekt

```bash
# Admin force'r en bon
curl -b admin-cookies.txt -X PATCH http://localhost:4322/api/bons/4001/status \
  -d '{"status_code": "IGANG", "force": true}'

# Tjek changelog — kolonner i RIGTIGE positioner (D-2-regression)
sqlite3 data/test.db "SELECT entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes, payload FROM changelog WHERE entity_id=4001 ORDER BY id DESC LIMIT 1"

# Forventet:
# bon | 4001 | status_change | status_id | FAKTURERET | IGANG | <admin-id> | NULL | {"was_forced":true,"by_user_id":<admin-id>}
```

---

## Markering i TEST_OBSERVATIONS

```markdown
### #005 — Force-mode dokumenteret men ikke implementeret (lukket)

| | |
|--|--|
| **Status** | `lukket` (maj 2026) |
| **Fix** | `PATCH_D_force_mode.md` v2 — implementeret med rolle-tjek mod session (ikke body), audit-log via logChange + payload.was_forced. T_BON_API_FORCE_01-07 dækker happy path + privilege escalation-regression |
```

---

## Hvad v1 lærte os (for fremtidige patches)

Tre lektioner fra v1's review der bør anvendes på fremtidige patches:

1. **Verificér find/replace mod faktisk kode** — patch'ens "find"-blokke
   skal kopieres fra koden, ikke gættes fra hukommelsen
2. **Hvis kode bruger en helper, skal patch'en også** — raw SQL der
   omgår etablerede konventioner er en kode-smell selv hvis den virker
3. **Identitet kommer aldrig fra body** — body er input, ikke autoritet.
   Sessionen er autoritet. Body kan bruges til audit-felter (hvem var det
   på vegne af) men aldrig til rolle-beslutninger

---

## Rollback

Migration 059 kan ikke nemt rulles tilbage (DROP COLUMN er begrænset i
SQLite). Verificér grundigt på test før prod. Selve kode-ændringen kan
revertes via `git revert`.

---

*v2 oprettet: maj 2026 — efter Claude Code review af v1 fandt tre kritiske
problemer: find-block-mismatch (D-1), forkert kolonne-rækkefølge (D-2), og
privilege escalation gennem body.user_id (D-3). v1 har korrekt design-intent
men implementering var fejlbehæftet — v2 retter alle tre.*
