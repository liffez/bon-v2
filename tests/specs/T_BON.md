# T_BON — Test-spec for bon livscyklus

> Status-flow, changelog, transitions, force-mode (admin override).
> Tester `PATCH /api/bons/:id/status` mod den faktiske status_transitions-tabel.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Status-skift via API, changelog-skrivning, transitions-tabellen, AFLYST-fra-alle |
| **Hvad testes IKKE** | Status-trigger-side-effekter (Grocy consume) — det er T_GROCY |
| **Forudsætninger** | T_DB grøn. Test-server kører på port 4322 |

---

## 2. Status-flow (autoritativt — fra `status_transitions`-tabel)

```
TILBUD     → NY, GODKENDT, AFLYST
NY         → VENTER, GODKENDT, AFLYST
VENTER     → GODKENDT, AFLYST
GODKENDT   → VENTER, IGANG, KLAR, LEVERET, AFLYST
IGANG      → GODKENDT, KLAR, LEVERET, AFLYST
KLAR       → IGANG, LEVERET, AFLYST
LEVERET    → IGANG, KLAR, FAKTURERET, BETALT, AFSLUTTET, AFLYST
FAKTURERET → AFSLUTTET
```

**Bemærk:** AFLYST kan nås fra alle "aktive" statusser (TILBUD/NY/VENTER/GODKENDT/IGANG/KLAR/LEVERET) — men IKKE fra terminal-statusser (FAKTURERET/BETALT/AFSLUTTET). Hvis det er bevidst, fint. Hvis ikke, dokumenteres som finding.

**Force-mode:** CLAUDE.md siger "Med `force: true` kan admin sætte hvilken som helst status" — men `routes/bons.js:316-338` checker IKKE `force`-parameteren. T_BON_API_FORCE_01 vil fange dette.

---

## 3. Test-cases

### 3.1 DB-niveau

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_BON_DB_01** | Antal status_definitions | 11 |
| **T_BON_DB_02** | Antal status_transitions | 27 |
| **T_BON_DB_03** | Alle transitions FK'er gyldige | foreign_key_check returnerer ingen overtrædelser |
| **T_BON_DB_04** | Alle transitions er aktive | `WHERE is_active = 0` returnerer 0 rows |
| **T_BON_DB_05** | Alle aktive statusser kan AFLYSes | TILBUD/NY/VENTER/GODKENDT/IGANG/KLAR/LEVERET har transition til AFLYST |
| **T_BON_DB_06** | Terminal statusser har INGEN udgående (undt. FAKTURERET → AFSLUTTET) | BETALT, AFSLUTTET har 0 udgående |

### 3.2 API-tests — tilladte transitions

| ID | Formål | Setup | Forventet |
|----|--------|-------|-----------|
| **T_BON_API_OK_01** | NY → GODKENDT | Sæt 4006 til NY først via UPDATE | PATCH→GODKENDT returnerer 200 |
| **T_BON_API_OK_02** | GODKENDT → IGANG | Bon 4006 (GODKENDT i seed) | PATCH→IGANG returnerer 200 |
| **T_BON_API_OK_03** | IGANG → KLAR | Bon 4005 (IGANG i seed) | PATCH→KLAR returnerer 200 |
| **T_BON_API_OK_04** | KLAR → LEVERET | Bon 4003 (KLAR i seed) | PATCH→LEVERET returnerer 200 |
| **T_BON_API_OK_05** | LEVERET → IGANG (fortryd) | Bon 4001 (LEVERET i seed) | PATCH→IGANG returnerer 200 |

### 3.3 API-tests — forbudte transitions

| ID | Formål | Setup | Forventet |
|----|--------|-------|-----------|
| **T_BON_API_NO_01** | GODKENDT → BETALT (ikke direkte tilladt) | Bon 4006 | PATCH→BETALT returnerer 400 |
| **T_BON_API_NO_02** | BETALT → IGANG (terminal) | UPDATE bon til BETALT først | PATCH→IGANG returnerer 400 |
| **T_BON_API_NO_03** | Ukendt status | Bon 4006 | PATCH→FOOBAR returnerer 400 |
| **T_BON_API_NO_04** | Manglende status_code | Bon 4006 | PATCH med tom body returnerer 400 |
| **T_BON_API_NO_05** | Ukendt bon-id | bon=999999 | PATCH returnerer 404 |

### 3.4 API-tests — changelog

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_BON_API_CL_01** | Status-skift skriver changelog-entry | Efter PATCH findes en row med action='status_change', old_value=før-status, new_value=ny-status |
| **T_BON_API_CL_02** | Changelog inkluderer user_id når givet | PATCH med `user_id: 1` → changelog.user_id = 1 |

### 3.5 Force-mode (parkeret — venter på beslutning)

| ID | Formål | Status |
|----|--------|--------|
| **T_BON_API_FORCE_01** | `force: true` tillader normalt forbudt transition | **SKIP** — feature ikke implementeret i `routes/bons.js`, design-beslutning pending |

Runneren skifter automatisk til PASS hvis force-mode bliver implementeret (PATCH returnerer 200).

---

## 4. Filer der skal eksistere

| Fil | Status |
|-----|--------|
| `tests/specs/T_BON.md` | ✅ |
| `tests/scripts/run_T_BON.js` | ✅ |
| `tests/reports/T_BON_YYYY-MM-DD.md` | 🔲 |

---

## 5. Setup-flow

T_BON laver UPDATE på bonner i test.db undervejs (fx ændrer status til NY før test).
Kør `npm run test:reset` mellem hver kørsel for at få frisk seed-state.

```bash
npm run test:reset
npm run test:server &
npm run test:run-bon
```

---

## 6. Findings — kræver beslutning, ikke fix nu

| ID | Finding | Sted | Status |
|----|---------|------|--------|
| **T_BON_API_FORCE_01** | `force: true` parameter understøttes ikke af status-PATCH | `routes/bons.js:316-338` validerer altid mod `status_transitions`-tabel uden at tjekke `force` | 🟡 **Parkeret** — afventer beslutning |

**Beslutning at tage:** Skal force-mode (admin-override af status-flow) implementeres,
eller fjernes fra CLAUDE.md som ufuldendt feature?

- **For implementering:** Admin kan rette stuck bons (fx undo BETALT/AFSLUTTET) uden DB-direkte SQL.
- **Imod implementering:** YAGNI — admin kan altid lave UPDATE direkte i DB. Tilføjer rolle-tjek-kompleksitet.
- **Anbefaling:** Vent til konkret behov opstår. Indtil da: T_BON_API_FORCE_01 = SKIP.

Hvis implementeret, vil den se sådan ud i `routes/bons.js`:
```javascript
const force = req.body.force === true;
const userId = req.body.user_id;
const isAdmin = userId && db.prepare(`SELECT role FROM users WHERE id = ?`).get(userId)?.role === 'admin';
if (!transition && !(force && isAdmin)) {
    return res.status(400).json({ error: `Transition ${bon.current_code} → ${status_code} er ikke tilladt` });
}
```

---

## 7. Status — første kørsel maj 2026

```
18 PASS · 0 FAIL · 1 SKIP

DB     6/6   ✓  (status_definitions, transitions, FK, AFLYST-fra-alle, terminale)
OK     5/5   ✓  (NY→GODKENDT, GODKENDT→IGANG, IGANG→KLAR, KLAR→LEVERET, LEVERET→IGANG)
NO     5/5   ✓  (forbudte transitions, ukendte statusser, manglende felter)
CL     2/2   ✓  (changelog auto-skrives, user_id videregives)
FORCE  0/1   ⊘  (SKIP — force-mode parkeret indtil beslutning)
```

T_BON-tracken er **funktionelt færdig** for Fase 1.

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
