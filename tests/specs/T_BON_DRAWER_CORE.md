# T_BON_DRAWER_CORE — Test-spec for bon-detalje + CRUD-flow

> Test-spec for de **kerne CRUD-endpoints** der ligger bag office's
> bon-drawer (et SPA-detalje-view der åbnes når man klikker en bon i
> listview):
>
> - `GET /api/bons/:id` — detalje incl. moms-felter
> - `POST /api/bons` — opret ny bon
> - `PATCH /api/bons/:id` — opdater felter (med felt-whitelist)
> - `PATCH /api/bons/:id/status` — status-skift med transition-tjek
> - `PATCH /api/bons/:id/prep` — prep-flags (ingredients_ready, supplies_ready)
> - `PATCH /api/bons/:id/kitchen-info` — fri-tekst notat til køkken
>
> **Søsterspec:** `T_BON_DRAWER_LINES_AND_RELATIONS.md` dækker bon_lines + ingredients + changelog + notifications + mail-tråd.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | 6 endpoints ovenfor. Felt-validering, server-autoritativ moms-recalc, changelog-logging, SSE-broadcast, status-flow med transitions-tjek, force-mode (patch D) integration |
| **Hvad testes IKKE** | bon-lines CRUD (T_BON_DRAWER_LINES_AND_RELATIONS). Grocy auto-consume ved LEVERET (delvist i T_INVENTORY). UI-rendering af drawer. Tilbud-flow med wizard (T_TILBUD) |
| **Forhold til T_BON** | T_BON tester DB-niveau status-transitions, change-logging. T_BON_DRAWER_CORE tester HTTP-endpoints der bruger samme logik via routes/bons.js. Overlap er bevidst — T_BON tester DB-konstrakter, vi tester HTTP-kontrakter |
| **Forhold til T_BONS_LIST** | T_BONS_LIST tester `GET /api/bons` (listevisning). T_BON_DRAWER_CORE tester `GET /api/bons/:id` (detalje). Disjoint |
| **Forhold til T_BON_FORCE** | Force-mode-tests (T_BON_API_FORCE_01-07) blev tilføjet via patch D. De er nu en del af T_BON og bør ikke gentages her. T_BON_DRAWER_CORE tester normal-flow + nye edge cases der ikke kom med |

---

## 2. Forudsætninger

### 2.1 Test-instans

- `data/test.db` seedet via `seed_planning.sql`
- Auth-session etableret
- SSE-listener fra `sse_listener.js` (genbrug fra T_BONS_LIST)
- Status_transitions-tabel populeret med standard-flow

### 2.2 Test-bons — egne T_BD_

Hver test opretter eller bruger T_BD_-prefix på `bon_number`. Cleanup via prefix-LIKE.

| Bon | Initial status | Formål |
|-----|----------------|--------|
| T_BD_BASE | NY | Hovedtest-bon for PATCH/GET/status |
| T_BD_TERM | FAKTURERET | For terminal-status edge cases (kan ikke skifte uden force) |
| T_BD_PREP | IGANG | For prep-flag tests (typisk i køkkenet) |

### 2.3 Auth-roller

Test-user-konti der allerede er seeded eller skabes:
- `T_BD_admin` (role='admin') — for force-mode-tests (skal være lukket via patch D)
- `T_BD_user` (role='user' eller 'kitchen') — for normal-flow

---

## 3. Strategi: snapshot → mutate → restore

Samme mønster som T_BONS_LIST. Tilføjer:

```
1. snapshot_changelog_count = SELECT COUNT(*) FROM changelog WHERE entity_id = bonId
2. ACTION: PATCH/POST mutation
3. ASSERT response + DB-state
4. ASSERT changelog INCREMENTED with korrekt action/field_name/old_value/new_value
5. ASSERT SSE-event modtaget med korrekt payload
6. CLEANUP: DELETE FROM changelog WHERE entity_id IN (test-bons); DELETE bons
```

For status-tests:
- Start fra kendt status
- PATCH → ny status
- Verificér transition validation, status_id i DB, changelog, SSE 'bon_status'-event
- Cleanup: PATCH tilbage til original (eller force-mode hvis nødvendigt)

---

## 4. Test-cases

### 4.1 SETUP-cases (4)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_BD_C_SETUP_01** | Test-bons oprettet via INSERT | 3 T_BD_-bons aktive |
| **T_BD_C_SETUP_02** | computeMomsFields tilgængelig | Helper-import virker |
| **T_BD_C_SETUP_03** | recalcBonTotal callable | Direkte enhedstest med pre-eksisterende lines |
| **T_BD_C_SETUP_04** | SSE-listener forbundet | EventSource klar til at lytte |

### 4.2 GET /api/bons/:id (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_GET_01** | GET med valid id | 200 med fuld bon + moms-felter |
| **T_BD_C_GET_02** | GET med ikke-eksisterende id | 404 "Bon ikke fundet" |
| **T_BD_C_GET_03** | GET med string id (`?id=abc`) | parseInt → NaN → 404 (er gracefully håndteret) |
| **T_BD_C_GET_04** | Moms-decoration inkluderet i response | `total_incl_moms`, `total_excl_moms`, `moms_amount` (jf. F48 fra T_BONS_LIST) |
| **T_BD_C_GET_05** | Bon med `is_offer=1` returneres alligevel | GET /:id ekskluderer IKKE tilbud (kun listview gør) — det er drawer-flow OK |

### 4.3 POST /api/bons — opret (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_POST_01** | Minimal body: `{delivery_date}` | 201 med ny bon, auto bon_number, default status=NY, default location |
| **T_BD_C_POST_02** | Uden delivery_date | 400 "delivery_date er påkrævet" |
| **T_BD_C_POST_03** | Med klient-sat total_price | total_price IGNORERES — server sætter 0 (recalc baseret på lines). **Vigtig regression** mod prismanipulation |
| **T_BD_C_POST_04** | Med klient-sat total_with_delivery | Tilsvarende — server-autoritativ |
| **T_BD_C_POST_05** | Boolean-felter (kitchen_selects, customer_collects, is_internal) | Konverteres til 0/1 |
| **T_BD_C_POST_06** | Bon med customer_id+company_id | Begge persisterer |
| **T_BD_C_POST_07** | logChange registreret | changelog har action='create', newValue=bon_number |
| **T_BD_C_POST_08** | SSE bon_created broadcast | Listener modtager `{id, bon_number}` indenfor 2s |

### 4.4 PATCH /api/bons/:id (10)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_PATCH_01** | Opdater valid felt (pax=10) | 200 `{ok:true}`, DB opdateret |
| **T_BD_C_PATCH_02** | Opdater 5 felter samtidigt | Alle 5 SQL-bound, alle ændrede |
| **T_BD_C_PATCH_03** | Tom body | 400 "Ingen gyldige felter" |
| **T_BD_C_PATCH_04** | Body med IKKE-allowed felt (`status_id`, `total_price`, `bon_number`) | Filtreres væk — kun allowed-felter opdateres. Counter ikke 400 — bare ignoreret |
| **T_BD_C_PATCH_05** | Ikke-eksisterende id | 404 "Bon ikke fundet" |
| **T_BD_C_PATCH_06** | Boolean-konvertering virker | `kitchen_selects: true` → 1, `is_internal: false` → 0 |
| **T_BD_C_PATCH_07** | delivery_price ændret → recalc trigger | total_price opdateres server-autoritativt. Verificér via getBon efter PATCH |
| **T_BD_C_PATCH_08** | logChange pr. ændret felt | Hvis 3 felter ændret, 3 nye changelog-rows. **Hvis felt er uændret (samme value), IKKE logget** (jf. `String(oldVal) !== String(newVal)`-tjek) |
| **T_BD_C_PATCH_09** | SSE bon_updated broadcast | Listener modtager `{id}` |
| **T_BD_C_PATCH_10** | updated_at sat til CURRENT_TIMESTAMP | Verificeret ved at sammenligne før/efter |

### 4.5 PATCH /api/bons/:id/status (8)

Force-mode (force=true + admin) er fuldt dækket af T_BON_API_FORCE_01-07 fra patch D. T_BD_C_STATUS tester resten.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_STATUS_01** | NY → VENTER (tilladt transition) | 200, DB status_id opdateret |
| **T_BD_C_STATUS_02** | Uden status_code | 400 "status_code er påkrævet" |
| **T_BD_C_STATUS_03** | Ukendt status_code | 400 "Ukendt status: XYZ" |
| **T_BD_C_STATUS_04** | Forbudt transition (NY → FAKTURERET direkte) | 400 "Transition NY → FAKTURERET er ikke tilladt" |
| **T_BD_C_STATUS_05** | changelog-entry skrevet med action='status_change', fieldName='status_id' | Verificér felt-navn + old/new |
| **T_BD_C_STATUS_06** | SSE bon_status broadcast | `{bon_id, old: 'NY', new: 'VENTER'}` |
| **T_BD_C_STATUS_07** | LEVERET-trigger: Grocy auto-consume forsøges hvis settings.inventory_auto_deduct='1' | T_INVENTORY har fuld dækning. Her tjekker vi blot at flowet kører (DB inventory_deducted=1) |
| **T_BD_C_STATUS_08** | LEVERET idempotens — anden gang skipper Grocy-consume | Verificér at `alreadyDeducted=1` afstedkommer skip-log |

### 4.6 PATCH /api/bons/:id/prep (6)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_PREP_01** | `{ingredients_ready: true}` alene | 200 med `{prep_ingredients_ready: true, prep_supplies_ready: <previous>}` |
| **T_BD_C_PREP_02** | `{supplies_ready: true}` alene | Tilsvarende |
| **T_BD_C_PREP_03** | Begge sammen | Begge opdateres |
| **T_BD_C_PREP_04** | Tom body | 400 "Ingen felter at opdatere" |
| **T_BD_C_PREP_05** | Booleans konverteres til 0/1 | DB-værdier er numeriske, response konverterer tilbage til JS-booleans |
| **T_BD_C_PREP_06** | Ingen logChange for prep-felter (jf. kode — flagged som "ingen audit" på prep) | Tjek changelog: ingen ny entry. Dokumentér som finding (lille audit-gap) |

### 4.7 PATCH /api/bons/:id/kitchen-info (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_KI_01** | `{text: "Allergi - nødder"}` | 200, DB kitchen_info opdateret |
| **T_BD_C_KI_02** | Tom text (sætter til null) | text=null persisteret. F-kandidat hvis det er forkert |
| **T_BD_C_KI_03** | Ikke-eksisterende bon | 404 |
| **T_BD_C_KI_04** | changelog logget med action='update', fieldName='kitchen_info', oldValue, newValue | Verificér |

### 4.8 RECALC + MOMS-konsekvens (4)

Server-autoritativ moms-håndtering er kernen i §6b. Disse tests beskytter mod regression.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_RECALC_01** | POST ny bon, derefter POST line (qty=2, unit_price=100) | total_price = 200 (server-beregnet). Klient kunne ikke have dikteret |
| **T_BD_C_RECALC_02** | PATCH delivery_price=50 | recalcBonTotal kører automatisk. total_with_delivery opdateres |
| **T_BD_C_RECALC_03** | GET /:id efter recalc | Moms-felter pre-beregnede via computeMomsFields |
| **T_BD_C_RECALC_04** | Klient sender total_price i PATCH | Filtreres væk (ikke i allowed-listen). DB.total_price uændret |

### 4.9 SSE — bon_status + payload-form (3)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_SSE_01** | Status-PATCH → bon_status event | `{bon_id, old, new}` |
| **T_BD_C_SSE_02** | bon_status payload-shape | Bekræfter F49 (åben): bruger `bon_id` ikke `id`. **Skal harmoniseres senere** |
| **T_BD_C_SSE_03** | Hvis transition fejler med 400, INGEN broadcast | Verificér via mock — sentEvents.length uændret |

### 4.10 EDGE_CASES (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_EDGE_01** | PATCH med samme værdi (no-op) | DB opdateres (updated_at + UPDATE-statement), men INGEN changelog-entry pga. `String(old) !== String(new)`-tjek |
| **T_BD_C_EDGE_02** | POST med order_date i fortiden | Accepteres — ingen validation |
| **T_BD_C_EDGE_03** | POST med delivery_date i fortiden | Accepteres — ingen validation. F-kandidat? |
| **T_BD_C_EDGE_04** | PATCH-felt med null værdi | Persisterer som null i DB. F.eks. `delivery_notes: null` |
| **T_BD_C_EDGE_05** | Currency-felter med string-format (`"100.50"` vs `100.50`) | SQLite tolerant — typer konverteres. Verificér konsekvens |

### 4.11 CLEANUP (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BD_C_CLEANUP_01** | Alle T_BD_-bons slettet | Count = 0 |
| **T_BD_C_CLEANUP_02** | Changelog-rows for test-bons slettet | Count = 0 |
| **T_BD_C_CLEANUP_03** | SSE-listener afsluttet | Connection lukket |
| **T_BD_C_CLEANUP_04** | Pre-eksisterende bons + changelog uændret | Snapshots match |

---

## 5. Konkret eksempel — T_BD_C_PATCH_07 (recalc-trigger)

```
Setup:
- T_BD_BASE-bon med 2 lines (line A qty=2 unit_price=100, line B qty=1 unit_price=50)
- Initial total_price = 250 (server-beregnet)
- delivery_price = 0

1. PATCH /api/bons/:id med {delivery_price: 75}
   → Server-side: 
       UPDATE bons SET delivery_price=75
       recalcBonTotal() kører automatisk (delivery_price er i recalc-triggere)
       UPDATE bons SET total_with_delivery = 250 + 75 = 325

2. GET /api/bons/:id
   → response:
       delivery_price: 75
       total_price: 250 (uændret — lines er ikke ændret)
       total_with_delivery: 325 (recalculated)
       moms_amount: ... (pre-beregnet på total_price)

3. ASSERT alle 3 felter matcher forventning

4. CLEANUP: PATCH {delivery_price: 0}

PASS — hermetisk
```

---

## 6. Fejlsignaler

| Symptom | Sandsynlig årsag |
|---------|------------------|
| PATCH med `total_price: 9999` ændrer beløbet i DB | allowed-listen mangler filter. Sikkerheds-issue. Verificér |
| Status-PATCH NY → FAKTURERET returnerer 200 | Transitions-tjek omgået. Tjek WHERE-klausul i `status_transitions` |
| SSE bon_status modtages ikke | broadcast() kaldes ikke ved status-skift. Tjek linje 343 |
| recalcBonTotal ikke trigget ved delivery_price | Linje 306-308 logik mangler. Bemærk: KUN `delivery_price` er i recalc-trigger-listen — andre felter (pax, total_units etc.) trigger IKKE recalc selvom de logisk burde påvirke total. F-kandidat |
| changelog skriver oldValue=undefined | `String(oldVal ?? '')` fallback virker ikke |
| prep-PATCH skriver changelog | KORREKT er at det IKKE skrives (kode mangler logChange). F-kandidat |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_BON_DRAWER_CORE.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_BON_DRAWER_CORE.js` | Test-runner | 🔲 |
| `tests/scripts/helpers/sse_listener.js` | Genbrug fra T_BONS_LIST | ✅ eksisterende |
| `tests/reports/T_BON_DRAWER_CORE_YYYY-MM-DD.md` | Rapport | 🔲 |

npm-script:
```json
"test:run-bon-drawer-core": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_BON_DRAWER_CORE.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Felt-whitelist på PATCH virker (total_price ignoreres) | Klient kan IKKE manipulere beløb direkte |
| recalcBonTotal trigger ved delivery_price | Server-autoritativ moms holder |
| Status-transitions valideres ved hver skift | Bonner kan ikke hoppe ulovlige steps |
| Force-mode (patch D) virker korrekt for admin | Stuck bonner kan rettes uden DB-UPDATE |
| changelog skrives ved alle relevante mutationer | Audit-trail komplet |
| SSE broadcasts ved hver mutation | Realtime sync mellem klienter |
| Boolean-felter konverteres korrekt | Ingen "true"-strenge i DB |
| 404 returneres for ikke-eksisterende bons | Robust fejlhåndtering |

---

## 9. Næste skridt

**Søsterspec:** `T_BON_DRAWER_LINES_AND_RELATIONS.md` dækker:
- `POST/PUT/DELETE /:id/lines/*` — bon_lines CRUD
- `GET /:id/ingredients` — aggreged Grocy-ingredienser
- `GET /:id/changelog` — audit-trail-visning
- `POST/GET /:id/notifications` + `POST /:id/notifications/:nid/read`
- `GET/POST /:id/mail` + `PATCH /:id/mail/:msgId/read`

---

## 10. Status — efter første kørsel

```
(genereres ved første kørsel)
```

---

## 11. Findings — afventer første kørsel

| # | Reference | Spørgsmål | Hvordan tjekkes |
|---|-----------|-----------|-----------------|
| **F52** | §4.6 (PREP_06) | prep-PATCH skriver IKKE changelog | Bekræft. Hvis ønskværdigt, lille fix til at logge prep-flag-ændringer |
| **F53** | §4.7 (KI_02) | Tom text sætter kitchen_info=null | Verificér. Hvis intentional (clear), OK |
| **F54** | §4.8 (RECALC_02) | Kun delivery_price triggerer recalc, ikke andre felter | Læs `recalcBonTotal`-trigger-betingelser. Hvis pax+total_units IKKE påvirker total, dokumentér |
| **F55** | §4.10 (EDGE_03) | Bon med delivery_date i fortiden accepteres | Designvalg eller mangel? |
| **F56** | §4.9 (SSE_02) | bon_status bruger `{bon_id}` ikke `{id}` — F49-relateret | Konsoliderings-patch |

---

*Oprettet: maj 2026 — anden track i Fase 3 (Office). Del 1 af 2.*
