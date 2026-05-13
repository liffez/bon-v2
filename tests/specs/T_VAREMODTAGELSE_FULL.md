# T_VAREMODTAGELSE_FULL — Komplet test-spec for varemodtagelses-flowet

> Bygger oven på `T_VAREMODTAGELSE_PATCH_REGRESSION.md` (suite der allerede
> er kørt 26/26 PASS — dækker patch A's fixes F26/F30/F31/F32/F35).
>
> Hvad denne spec dækker:
> - De resterende ~49 cases der ikke kom med i patch-regressionen:
>   receipt-number format, temperature/check/deviation-felter, foto-upload
>   edge cases, partial Grocy-failure-håndtering, listing/detalje-filtre,
>   users-dropdown, concurrency på receipt-number.
>
> Migrations-historik (gennemføres som forberedelse — se §12):
> - `tests/scripts/run_T_VAREMODTAGELSE.js` omdøbes til
>   `tests/scripts/run_T_VAREMODTAGELSE_PATCH_REGRESSION.js`
> - `tests/specs/T_VAREMODTAGELSE_PATCH_REGRESSION.md` oprettes som ny stub
>   der dokumenterer den eksisterende runner (der findes ingen
>   `T_VAREMODTAGELSE.md`-spec at omdøbe — den er aldrig blevet skrevet,
>   kun selve patch-spec'en `PATCH_goods_receipts_critical_fixes.md`)
> - npm-scriptet `test:run-varemod` omdøbes til `test:run-varemod-patch`
>
> Når begge runners er på plads:
> - `run_T_VAREMODTAGELSE_PATCH_REGRESSION.js` (26 cases — kørt)
> - `run_T_VAREMODTAGELSE_FULL.js` (49 cases — denne spec)
> - Begge kan køre uafhængigt, eller via `test:run-varemod-all` som
>   komplet validering før release.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Hele `routes/goods-receipts.js`'s overflade som **ikke** er dækket af patch-regression: receipt-number sequence + format, validation-grene, temperature/check/deviation-felter, foto-upload edge cases, partial-success-håndtering, listing/detalje-filtre, users-dropdown, concurrency på receipt-number |
| **Hvad testes IKKE** | Det der allerede er dækket af `T_VAREMODTAGELSE_PATCH_REGRESSION`: F26/F30/F31/F32/F35-fixes, basic happy-path, simpel item-status-flow, basic shopping_list-cleanup, basic webhook-mock |
| **Forhold til _PATCH_REGRESSION** | _FULL **kan** køre uden _PATCH_REGRESSION og omvendt. De deler test-fixtures (pids, photo, mock-helpers) men sætter deres egne data op. Begge kører grønne = komplet T_VAREMODTAGELSE-dækning |
| **Live mod Grocy** | JA — addStock testes faktisk. Snapshot+restore på alle berørte pids |
| **Webhook** | Mock'es via `goodsReceiptWebhook._setMockSender` — **skal tilføjes som separat opgave** før FAIL-gruppen kan testes. PATCH_REGRESSION-runneren verificerer kun at `webhook_dispatched=true` returneres i responsen, ikke at webhook faktisk kaldes |

---

## 2. Forudsætninger

Identisk med _PATCH_REGRESSION's §2 — samme test-pids (Spinat, Brød Rug),
samme mock-helpers, samme foto-fixture. **Denne sektion gentages ikke fuldt
ud** — se `T_VAREMODTAGELSE_PATCH_REGRESSION.md` §2 for detaljer.

Nye forudsætninger for _FULL specifikt:

| | |
|--|--|
| **Concurrency-test** | Node's native Promise.all bruges til at sende 3 POST'er samtidig. Ingen ekstra infrastruktur |
| **Stor-fil-test** | Foto-upload over 10 MB simuleres ved at generere en buffer (`Buffer.alloc(11 * 1024 * 1024)`) — ingen fixture nødvendig |
| **WebP + PNG** | To ekstra små fixtures (`T_VAREMOD_F_test_photo.png`, `T_VAREMOD_F_test_photo.webp`) ved siden af jpeg'en |

---

## 3. Strategi

Samme snapshot → mutate → rollback-mønster som _PATCH_REGRESSION. Float-
tolerance = 0.01. Counter snapshottes ved test-start og restores ved cleanup.

Ny strategi for concurrency-tests:

```
1. snapshot_counter_before
2. Promise.all([POST_A, POST_B, POST_C])
3. ASSERT: alle 3 succeed
4. ASSERT: receipt_numbers er unikke (Set-størrelse = 3)
5. ASSERT: counter steget med præcis 3
6. CLEANUP: DELETE alle 3 + restore counter
```

---

## 4. Test-cases — manglende grupper

### 4.1 RECEIPT_NUMBER — sequence-generering (6 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_NUM_01** | snapshot counter, opret 1 receipt, tjek counter | counter øget med 1 |
| **T_VAREMOD_F_NUM_02** | Receipt-number format | Matcher regex `^VR-\d{4}-\d{3}$` |
| **T_VAREMOD_F_NUM_03** | Year-segment matcher current year | `new Date().getFullYear()` |
| **T_VAREMOD_F_NUM_04** | Sequence-segment har leading zeros | 003, 010, 099, 100 alle korrekt format |
| **T_VAREMOD_F_NUM_05** | Counter rulles tilbage hvis INSERT fejler mid-transaction | POST med item-status der bryder CHECK constraint (`status='INVALID'`) → 500 + counter UÆNDRET. Verificerer at counter-bump + INSERTs kører i samme transaction (F26-fix, Patch A). Allerede dækket af PATCH_REGRESSION's NUM_03 — gentages her for fuld grupperingsfuldstændighed |
| **T_VAREMOD_F_NUM_06** | Counter incrementerer transactionalt | To receipts hurtigt efter hinanden får forskellige numre. (Tungere concurrency-test i §4.8 nedenfor) |

### 4.2 VALIDATION — input-fejl (6 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_VAL_01** | POST uden supplier_name | 400 "supplier_name er påkrævet". Counter ikke øget |
| **T_VAREMOD_F_VAL_02** | POST uden received_by_name OG received_by_user_id | 400 "received_by_name er påkrævet" |
| **T_VAREMOD_F_VAL_03** | POST med kun received_by_user_id (uden name) | 200 — user_id alene er nok. (Allerede dækket af PATCH_REGRESSION's USER_01 — gentages her for grupperings­fuldstændighed) |
| **T_VAREMOD_F_VAL_04** | POST med items=[] | 400 "items[] er påkrævet" |
| **T_VAREMOD_F_VAL_05** | POST med items=null eller manglende | 400 |
| **T_VAREMOD_F_VAL_06** | POST med item uden product_name | **F37 lukket (patch B)**: 400 med besked `items[0].product_name er påkrævet`. Validation kører før transaction → counter UÆNDRET. |

### 4.3 TEMPERATURE_CHECKS — kølevarer + frost (6 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_TEMP_01** | POST med `temperature_cool_enabled=true, value=4.0, ok=true` | DB: alle 3 cool-felter sat korrekt |
| **T_VAREMOD_F_TEMP_02** | POST med cool_enabled=false + cool_value=4.0 + cool_ok=true | DB: cool_value=null, cool_ok=null (uanset hvad client sender) — koden klamper dette |
| **T_VAREMOD_F_TEMP_03** | POST med frozen_enabled=true, value=-18, ok=true | Tilsvarende på frozen-felter |
| **T_VAREMOD_F_TEMP_04** | Begge enabled (kølevarer OG frost) | Alle 6 felter sat |
| **T_VAREMOD_F_TEMP_05** | Begge disabled | Alle 6 felter null |
| **T_VAREMOD_F_TEMP_06** | cool_enabled=true men cool_value mangler i body | **F40 lukket (patch B)**: koden bruger nu `(value ?? null)` så `undefined` klampes til `null`. Status=200, DB.cool_value=null, counter bumpet. Samme behov er løst for `frozen_value` |

### 4.4 OTHER_CHECKS — date/labeling/packaging (3 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_CHECK_01** | Alle 3 boolean checks = true | DB: 1/1/1 |
| **T_VAREMOD_F_CHECK_02** | Alle = false | DB: 0/0/0 |
| **T_VAREMOD_F_CHECK_03** | Manglende felter i body (undefined) | Default til 0 (koden bruger `? 1 : 0` så undefined → 0) |

### 4.5 DEVIATIONS — afvigelser (3 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_DEV_01** | `has_deviation=true, type='temperatur', note='for varm'` | DB: alle 3 deviation-felter sat |
| **T_VAREMOD_F_DEV_02** | has_deviation=false + type='other' + note='zombie' | **F41 lukket (patch B)**: clamping tilføjet — `has_deviation ? (deviation_type \|\| null) : null` (samme mønster som temperature-felterne). DB-row er nu konsistent: has_deviation=0 medfører type=NULL, note=NULL trods client-sendte værdier |
| **T_VAREMOD_F_DEV_03** | has_deviation=true men type/note tomme strings | Tomme strings → null via `\|\| null`-fallback (`'' \|\| null` evaluerer til `null` i JS) |

### 4.6 PHOTO_UPLOAD — manglende edge cases (6 cases)

_PATCH_REGRESSION dækker JPEG-upload og F30-fix (null photo_path).
_FULL dækker resten:

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_PHOTO_F_01** | POST `/photo` med text/plain-fil | 400 "Kun billedfiler er tilladt" |
| **T_VAREMOD_F_PHOTO_F_02** | POST `/photo` uden file-feld | 400 "Ingen fil modtaget" |
| **T_VAREMOD_F_PHOTO_F_03** | POST `/photo` med 11 MB buffer | 413 "Fil overstiger 10 MB". Verificer at limit håndhæves |
| **T_VAREMOD_F_PHOTO_F_04** | POST `/photo` med PNG | response.path slutter med `.png`, fil eksisterer på disk |
| **T_VAREMOD_F_PHOTO_F_05** | POST `/photo` med WebP | response.path slutter med `.webp` |
| **T_VAREMOD_F_PHOTO_F_06** | POST receipt UDEN photo_path | DB.photo_path = null, ingen fil-operation udført |

### 4.7 GROCY_FAILURES — partial-success-håndtering (5 cases)

**Vigtigste gruppe der mangler.** Patch-regression verificerer happy-path —
denne verificerer at delvis svigt håndteres gracefully.

| ID | Setup | Forventet |
|----|-------|-----------|
| **T_VAREMOD_F_FAIL_01** | 3 items: pid=28 (real), pid=999999 (invalid), pid=1 (real) | Receipt oprettes. item[0] og item[2] har grocy_added=1. item[1] har grocy_added=0 og grocy_error sat |
| **T_VAREMOD_F_FAIL_02** | Grocy-stock-snapshot for de 2 valide pids | Begge øget med korrekt qty (én fejl stopper ikke de andre — verifier sekventiel-loop) |
| **T_VAREMOD_F_FAIL_03** | response.grocy_results | Array har 3 entries med tydelig success/fail-status pr. item |
| **T_VAREMOD_F_FAIL_04** | Receipt-status er stadig 'approved' (hardcoded ved INSERT) | Selvom Grocy delvist fejlede, er Bon v2 status='approved'. Dokumentér som finding F33 (åben — design-diskussion) |
| **T_VAREMOD_F_FAIL_05** | Webhook stadig sendt | Mock kaldt 1 gang trods Grocy-fejl |

### 4.8 CONCURRENCY — receipt-number-race (2 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_CONC_01** | POST receipt A og B uden delay imellem (await både) | Begge succeed med forskellige receipt_numbers (counter incrementeres atomisk via transaction) |
| **T_VAREMOD_F_CONC_02** | `Promise.all([POST_A, POST_B, POST_C])` parallel | Alle 3 får unikke numre. Counter steget med præcis 3. Verificerer F34 (transaction() er reelt ACID i node:sqlite) |

### 4.9 GET_LIST — filter-tests (6 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_LIST_01** | GET / uden filtre | Returnerer alle receipts (test-receipts inkluderet) |
| **T_VAREMOD_F_LIST_02** | GET ?from=YYYY-MM-DD | Kun receipts >= dato |
| **T_VAREMOD_F_LIST_03** | GET ?to=YYYY-MM-DD | Inkluderer hele to-dato (23:59:59 padding tilføjet af koden) |
| **T_VAREMOD_F_LIST_04** | GET ?supplier=Hørkram | LIKE-match. "Hørkram A/S" matches også |
| **T_VAREMOD_F_LIST_05** | GET ?location=1 | Kun location_id=1 |
| **T_VAREMOD_F_LIST_06** | Sortering | ORDER BY received_at DESC. Nyeste først |

### 4.10 GET_DETAIL (3 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_DETAIL_01** | GET /:id for eksisterende | Receipt + items-array |
| **T_VAREMOD_F_DETAIL_02** | GET /:id for ikke-eksisterende | 404 "Ikke fundet" |
| **T_VAREMOD_F_DETAIL_03** | items-array tomt hvis ingen items | Edge-case: receipt uden items er ikke valid (validation), men hvis det sker via direkte SQL-INSERT: array=[] |

### 4.11 USERS_DROPDOWN (3 cases)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_USERS_01** | GET /users | Array af aktive brugere med id+name |
| **T_VAREMOD_F_USERS_02** | Soft-deleted brugere ekskluderet | Hvis user.is_active=0, ikke i listen |
| **T_VAREMOD_F_USERS_03** | Sortering | ORDER BY name |

### 4.12 CLEANUP

| ID | Action | Forventet |
|----|--------|-----------|
| **T_VAREMOD_F_CLEANUP_01** | Alle T_VAREMOD_F_F-receipts slettet | Count = 0 |
| **T_VAREMOD_F_CLEANUP_02** | Cascade-slettet items | Count = 0 |
| **T_VAREMOD_F_CLEANUP_03** | Grocy stock restored | snapshot_after == snapshot_before |
| **T_VAREMOD_F_CLEANUP_04** | Counter restored | settings.goods_receipt_number_next = snapshot |
| **T_VAREMOD_F_CLEANUP_05** | Photo-filer ryddet | Test-PNG/WebP/JPEG temp + permanent slettet |

---

## 5. Forventet samlet status

```
T_VAREMOD_F_FULL forventet:

NUM       6/6
VAL       6/6
TEMP      6/6
CHECK     3/3
DEV       3/3
PHOTO_F   6/6
FAIL      5/5
CONC      2/2
LIST      6/6
DETAIL    3/3
USERS     3/3
─────────────
TOTAL    49/49 forventet

(plus 5 cleanup-cases der ikke tæller med i resultat-summary)
```

Kombineret med _PATCH_REGRESSION:

```
T_VAREMODTAGELSE_PATCH_REGRESSION: 26/26 (kørt)
T_VAREMODTAGELSE_FULL:             49/49 (forventet)
───────────────────────────────────────────────
TOTAL                              75/75 ved fuldt grøn
```

---

## 6. Fejlsignaler og fortolkning

Identisk med _PATCH_REGRESSION §6 — samme symptomer og årsager. Tilføjede
notes for _FULL-specifikke områder:

| Symptom | Sandsynlig årsag |
|---------|------------------|
| Concurrency test viser duplikate receipt-numbers | Den inlinede `transaction(db, () => ...)` der wraper counter-bump + INSERTs er ikke faktisk ACID. Tjek `db/compat.js`'s transaction-implementering. Bemærk: node:sqlite + Express er single-threaded synkront indtil `await` — vores transaction har ingen `await` indenfor, så SQLite burde serialisere automatisk |
| Counter incrementeres trods POST-fejl med 4xx/5xx | Patch A wraper counter-bump + INSERTs i én transaction. Hvis counter alligevel bumpes, er transaction-wrappen brudt — tjek at `nextReceiptNumber()`-funktionen ikke er kommet tilbage som standalone, og at `transaction(db, () => {...})` faktisk omslutter både counter-update og INSERTs |
| Photo over 10 MB returnerer 200 i stedet for 413 | Busboy size-limit ikke konfigureret korrekt, eller "limit"-event ikke håndteret |
| GET ?to=2026-05-11 inkluderer ikke receipts fra samme dato kl 22:00 | Koden tilføjer `' 23:59:59'` til to-parameter. Hvis det ikke virker, tjek SQL-format |
| `users` endpoint returnerer soft-deleted | `WHERE is_active = 1`-filter mangler i query |
| LIKE-search returnerer ingen resultater på "Hørkram" hvis supplier hedder "Hörkram" | UTF-8 normalisering. Dokumentér adfærd |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `docs/archive/patches/PATCH_goods_receipts_critical_fixes.md` | Patch A's spec (eksisterer) | ✓ |
| `tests/specs/T_VAREMODTAGELSE_PATCH_REGRESSION.md` | Ny stub der dokumenterer eksisterende runner + 26 cases | 🔲 oprettes |
| `tests/specs/T_VAREMODTAGELSE_FULL.md` | Denne fil | ✓ |
| `tests/scripts/run_T_VAREMODTAGELSE.js` | Eksisterende runner — **skal omdøbes** | 🟡 omdøb til `run_T_VAREMODTAGELSE_PATCH_REGRESSION.js` |
| `tests/scripts/run_T_VAREMODTAGELSE_FULL.js` | Ny runner | 🔲 |
| `services/goodsReceiptWebhook.js` | Tilføj `_setMockSender`/`_clearMockSender` til test-mode | 🔲 forudsætning for FAIL-gruppen |
| `tests/fixtures/T_VAREMOD_F_test_photo.png` | 100×100 PNG (~5kb) | 🔲 |
| `tests/fixtures/T_VAREMOD_F_test_photo.webp` | 100×100 WebP (~3kb) | 🔲 |
| `tests/reports/T_VAREMODTAGELSE_FULL_YYYY-MM-DD.md` | Rapport (genereres) | 🔲 |

`package.json`-ændringer:

```diff
- "test:run-varemod": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_VAREMODTAGELSE.js",
+ "test:run-varemod-patch": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_VAREMODTAGELSE_PATCH_REGRESSION.js",
+ "test:run-varemod-full":  "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_VAREMODTAGELSE_FULL.js",
+ "test:run-varemod-all":   "npm run test:run-varemod-patch && npm run test:run-varemod-full"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Counter race-safe selv ved parallel POST (CONC) | Selv ved travle leveringsdage får hver receipt unikt nummer |
| Alle validation-grene rejekterer korrekt (VAL) | UI får forudsigelig fejlhåndtering |
| Temperature/check/deviation persisterer korrekt (TEMP/CHECK/DEV) | Compliance: alle fødevarekontrol-felter ender i DB og webhook |
| Foto-upload håndterer alle formater + size-limit (PHOTO_F) | UI'en kan trygt vise progress og fejl-states |
| Partial Grocy-failure håndteret gracefully (FAIL) | En enkelt vare-fejl stopper ikke hele modtagelsen — items får synlig fail-status |
| List/detail-filtre virker (LIST/DETAIL) | UI's "Tidligere modtagelser"-skærm kan trygt filtrere |
| Users-dropdown korrekt (USERS) | "Hvem modtog?"-felt har korrekte options |

---

## 9. Findings — opdatering af status fra _PATCH_REGRESSION

| # | Status | Note |
|---|--------|------|
| **F26** | LUKKET | Patch A — counter-bump + INSERTs wrap'et i én transaction. Counter ruller tilbage ved både CHECK- og FK-violations. Verificeret af PATCH_REGRESSION's NUM_03 + USER_03, gen-testet af _FULL's NUM_05 |
| **F27** | ÅBEN | Missing-status springer addStock over uden qty-tjek — design-diskussion |
| **F28** | ÅBEN | Ukendt item-status falder igennem — design-diskussion |
| **F29** | ÅBEN | Over-receive → full delete fra shopping_list — design-diskussion |
| **F30** | LUKKET | Patch A — null photo_path hvis temp-fil mangler |
| **F31** | LUKKET | Patch A — webhook_dispatched tilføjet |
| **F32** | LUKKET | Patch A — users-tabel-lookup ved user_id-only |
| **F33** | ÅBEN | Status='approved' selv ved partial Grocy-failure — verificeres af T_VAREMOD_F_FAIL_04 og dokumenteres |
| **F34** | LUKKET | transaction() ACID under parallel POST — verificeret af T_VAREMOD_F_CONC_02 (3 parallel POST'er får unikke numre, counter +3) |
| **F35** | LUKKET | Patch A — UPDATE matcher på item.id |
| **F36** | ÅBEN | Ingen server-side idempotens — design-diskussion |
| **F37** | LUKKET | Patch B — validation for `items[].product_name` før INSERT. Returnerer 400 med indexed besked i stedet for 500 SQLite-fejl |
| **F40** | LUKKET | Patch B — `(value ?? null)` klampe for både cool_value og frozen_value. Undefined giver nu 200 + NULL i DB i stedet for crash |
| **F41** | LUKKET | Patch B — `has_deviation ? (type \|\| null) : null` clamping. DB-row er konsistent: has_deviation=false medfører altid type=NULL, note=NULL |

Efter _FULL er kørt, opdateres TEST_OBSERVATIONS:
- F34 enten lukkes (ACID bekræftet) eller åbnes som ny obs (race-condition fundet)
- F33 dokumenteres som åben observation med konkret repro-step fra T_VAREMOD_F_FAIL_04

---

## 10. Status — efter første kørsel

```
(genereres ved første kørsel)
```

---

## 11. Findings — nye spørgsmål kun for _FULL

| # | Reference | Spørgsmål | Status |
|---|-----------|-----------|--------|
| **F37** | §4.2 (VAL_06) | NOT NULL på `goods_receipt_items.product_name` gav 500 i stedet for pæn 400 | **LUKKET (patch B)** — validation tilføjet før INSERT |
| **F38** | §4.6 (PHOTO_F_03) | Busboy size-limit håndhæves? | **VERIFICERET** — PHOTO_F_03 PASS: 11 MB returnerer 413 som forventet |
| **F39** | §4.9 (LIST_04) | LIKE-search UTF-8-håndtering | **VERIFICERET** — LIST_04 PASS: "Hørkram" matches korrekt |
| **F40** | §4.3 (TEMP_06) | `cool_enabled=true` uden `cool_value` crasher i node:sqlite | **LUKKET (patch B)** — `(value ?? null)` klamping. Samme fix anvendt på `frozen_value` |
| **F41** | §4.5 (DEV_02) | `has_deviation=false` men type/note klampes ikke | **LUKKET (patch B)** — clamping tilføjet: `has_deviation ? (type \|\| null) : null` |

---

## 12. Migrations-tjekliste til dig / Claude Code

Inden _FULL-runneren bygges:

1. [ ] Tilføj `_setMockSender(fn)` + `_clearMockSender()` til `services/goodsReceiptWebhook.js` (kun aktivt når `NODE_ENV='test'`) — forudsætning for FAIL-gruppen
2. [ ] Opret `tests/specs/T_VAREMODTAGELSE_PATCH_REGRESSION.md` (stub der referer til `PATCH_goods_receipts_critical_fixes.md` for patch-detalje + lister de 26 case-IDs runneren dækker)
3. [ ] Omdøb `tests/scripts/run_T_VAREMODTAGELSE.js` → `run_T_VAREMODTAGELSE_PATCH_REGRESSION.js`
4. [ ] I runneren: opdater eventuelle interne referencer/header til det nye navn
5. [ ] Opdater `package.json` scripts (se §7) — `test:run-varemod` → `test:run-varemod-patch`, tilføj `test:run-varemod-full` og `test:run-varemod-all`
6. [ ] Opret de 2 ekstra foto-fixtures (PNG + WebP)
7. [ ] Byg `run_T_VAREMODTAGELSE_FULL.js` med 12 case-grupper (~49 cases). Test-data markeres med supplier_name=`'T_VAREMOD_F test'` (afviger fra PATCH_REGRESSION's `'T_VAREMOD test'` så cleanup-blocker ikke krydsforurener)
8. [ ] Verificer at `test:run-varemod-all` kører begge grønt
9. [ ] T_INVENTORY + T_STOCK regression-tjek efter ændringer i `services/goodsReceiptWebhook.js` (mock-helperen må ikke ændre prod-adfærd)

---

*Oprettet: maj 2026 — efter T_VAREMODTAGELSE-patch-regression (26/26) lukkede F30/F31/F32/F35. Denne spec fanger de resterende ~49 cases der ikke kom med i patch-runden.*
