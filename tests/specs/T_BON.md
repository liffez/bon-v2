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

**Force-mode:** Implementeret via [PATCH_D_force_mode.md](patches/PATCH_D_force_mode.md) (maj 2026). Admin kan overstyre forbudte transitions med `{force: true}` i body. Rolle-tjek mod session (ikke body) for at undgå privilege escalation. Audit-log via `changelog.payload = {was_forced: true, by_user_id}`. T_BON_API_FORCE_01-07 dækker happy path + D-3 privilege-escalation-regression.

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

### 3.5 Force-mode (Patch D — implementeret maj 2026)

| ID | Formål | Setup | Forventet |
|----|--------|-------|-----------|
| **T_BON_API_FORCE_01** | Admin kan force'e forbudt transition | Login som admin, GODKENDT → BETALT | 200, transition gennemført |
| **T_BON_API_FORCE_02** | Non-admin afvises ved force | Login som kitchen, force=true | 403 "Force-mode kræver admin-rolle" |
| **T_BON_API_FORCE_03** | **Privilege escalation forhindret (D-3)** | Login som kitchen, send `user_id: <admin>` i body | 403 — body.user_id må IKKE påvirke rolle-tjek |
| **T_BON_API_FORCE_04** | Ingen session + force=true | Ingen cookie | 401 |
| **T_BON_API_FORCE_05** | Ikke-force fortsat regression | Forbudt transition uden force | 400 "ikke tilladt" som hidtil |
| **T_BON_API_FORCE_06** | Terminal-tilbageskift | Admin force'r FAKTURERET → IGANG | 200 |
| **T_BON_API_FORCE_07** | Audit-log korrekt (D-2 regression) | Force-skift som admin | changelog.payload = `{was_forced:true, by_user_id:<admin>}` + kolonne-rækkefølge intakt |

Runneren håndterer login automatisk: sætter midlertidig PIN på admin-bruger, logger ind som både admin og kitchen, restorerer PIN ved cleanup.

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

## 6. Findings — historiske

| ID | Finding | Sted | Status |
|----|---------|------|--------|
| **#005 / F005** | `force: true` parameter understøttes ikke af status-PATCH | `routes/bons.js` | ✅ **LUKKET (Patch D, maj 2026)** — implementeret med session-baseret rolle-tjek + audit via `changelog.payload`. Se [patches/PATCH_D_force_mode.md](patches/PATCH_D_force_mode.md) |

Beslutningen (Leif, maj 2026): **B — implementér**. Admin kan rette stuck bons via UI i stedet for direkte DB-UPDATE. Audit-trailen viser hvilke skift gik uden om normalt flow.

Sikkerheds-detalje (D-3): rolle-tjek baseret på `req.session.userId`, ikke `req.body.user_id`. En kitchen-bruger der sender `user_id: <admin>` i body bliver afvist — verificeret af T_BON_API_FORCE_03.

---

## 7. Status

### Første kørsel (maj 2026)

```
18 PASS · 0 FAIL · 1 SKIP

DB     6/6   ✓
OK     5/5   ✓
NO     5/5   ✓
CL     2/2   ✓
FORCE  0/1   ⊘  (parkeret — force-mode ikke implementeret)
```

### Efter Patch D (maj 2026)

```
25 PASS · 0 FAIL · 0 SKIP

DB     6/6   ✓
OK     5/5   ✓
NO     5/5   ✓
CL     2/2   ✓
FORCE  7/7   ✓  (alle force-cases implementeret og verificeret)
```

T_BON-tracken er **funktionelt færdig**.

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
