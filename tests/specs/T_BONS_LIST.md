# T_BONS_LIST — Test-spec for office listview backend

> Test-spec for `GET /api/bons` endpoint i `routes/bons.js` — backend for
> `office/views/bons-list.js`. Testet som **kontrakt** mod endpoint, ikke
> som UI-rendering.
>
> Også dækket: SSE-events (`bon_created`, `bon_updated`, `bon_status`,
> `notification`) som listview lytter efter for real-time opdateringer.
>
> Første track i Fase 3 (Office). Bygger på den eksisterende auth +
> moms-doktrin fra Fase 2.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | `GET /api/bons` med alle filter-parametre, sortering, pagination, søgning. Plus SSE-events der udsendes fra `POST/PATCH /api/bons/*`-endpoints (de fanges af bons-list.js via `connectSSE()`) |
| **Hvad testes IKKE** | UI-rendering (`office/views/bons-list.js` — Playwright, parkeret). `GET /api/bons/:id` detalje (T_BON_DRAWER). PATCH/POST mutationer (delvist i T_BON fra Fase 1, resten i T_BON_DRAWER). `is_offer=1`-flow (T_TILBUD) |
| **Forhold til T_BON** | T_BON tester CRUD på en enkelt bon. T_BONS_LIST tester listevisningen + filtre. Disjoint scope |
| **Forhold til T_AGGR** | T_AGGR tester `GET /api/bons/today` + `/later` + `/calendar` (kitchen-views). T_BONS_LIST tester `GET /api/bons` med fri filter (office-view) — anden endpoint, anden logik |
| **Hvilke data** | Bons med varierende status, dato, kunde, firma, moms. Seedede via `seed_planning.sql` plus test-specifikke der oprettes pr. test (snapshot+restore) |

---

## 2. Forudsætninger

### 2.1 Test-instans

- `data/test.db` seedet med `seed_planning.sql` (mindst 5 bons i forskellige statusser og datoer)
- Auth-session etableret (test-user logget ind)
- SSE-mock klar — eller test-helper der opretter ny EventSource-forbindelse til `/events`

### 2.2 Test-bons — egne T_BONS_LIST_-bons

Hver test opretter sine egne test-bons med prefix `T_BL_<scenarie>` på
`bon_number` eller note-felter, så de kan ryddes op uden at røre seedede data.

Eksempel-bons der oprettes ved start:

| Bon | bon_number | status | dato | pax | total_price | unread_mail | is_offer |
|-----|------------|--------|------|----:|------------:|------------:|---------:|
| A | T_BL_NY_1 | NY | today | 5 | 800.00 | 1 | 0 |
| B | T_BL_NY_2 | NY | today | 10 | 1500.00 | 0 | 0 |
| C | T_BL_VENTER | VENTER | today+1 | 3 | 600.00 | 0 | 0 |
| D | T_BL_IGANG | IGANG | today | 8 | 1200.00 | 2 | 0 |
| E | T_BL_FAKT | FAKTURERET | today-5 | 4 | 700.00 | 0 | 0 |
| F | T_BL_OFFER | NY | today | 12 | 2000.00 | 0 | 1 (tilbud — skal IKKE være i resultat) |

Bon F er **vigtig** — verificerer at endpoint ekskluderer tilbud.

### 2.3 SSE-mock-strategi

To muligheder, vælg én ved første runner-build:

**A) Test-EventSource (anbefalet)**: Runneren opretter en `EventSource`-forbindelse til `http://localhost:<port>/events` ved test-start. Hver POST/PATCH der trigger broadcast vil sende event til den lytter. Test asserterer på modtaget event indenfor `await waitForEvent(name, timeoutMs=2000)`.

**B) Spy på `broadcast()`**: Importér `shared/sse.js` og mock `broadcast`-funktionen — fang kald i array til assertion. Hurtigere men tester ikke faktisk SSE-pipeline.

**Anbefaling A** — det dækker den faktiske kontrakt frontend ser. Kræver:
- Lille test-helper `tests/scripts/helpers/sse_listener.js` med `connect()`, `waitForEvent(name, predicate, timeoutMs)`, `disconnect()`
- Genbruges på alle office-tracks fremover

### 2.4 Hardcoded WHERE-klausul

Endpoint har `(b.is_offer = 0 OR b.is_offer IS NULL)` som første WHERE. Tilbud kommer ALDRIG med i resultat — uanset filter. Vores test-bon F bekræfter dette.

### 2.5 Float-tolerance + moms-doktrin

Bon v2 §6b: `total_price` er INKL. moms. `computeMomsFields()` tilføjer alle moms-decorations på hver row. Float-tolerance `FLOAT_TOL = 0.01`.

---

## 3. Strategi: snapshot → create → query → cleanup

```
1. snapshot = SELECT * FROM bons WHERE bon_number LIKE 'T_BL_%' (forventet 0)
2. ACTION_setup: INSERT 6 test-bons via direkte SQL (faster end POST-flow)
3. ACTION_test: GET /api/bons?<params>
4. ASSERT: response indeholder forventede T_BL_-bons, ikke andre
5. CLEANUP: DELETE FROM bons WHERE bon_number LIKE 'T_BL_%' (CASCADE rydder lines, mail_threads)
6. VERIFY: snapshot == final state
```

For SSE-tests:
```
1. SSE-listener tilsluttet
2. POST /api/bons med test-bon
3. await waitForEvent('bon_created', e => e.id === expectedId, 2000ms)
4. Cleanup: DELETE
```

---

## 4. Test-cases

### 4.1 SETUP-cases (5)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_BL_SETUP_01** | DB seedet | `SELECT COUNT(*) FROM bons` > 0 |
| **T_BL_SETUP_02** | Test-bons kan oprettes via SQL | 6 T_BL_-bons inserterede med korrekte status_id'er |
| **T_BL_SETUP_03** | Auth virker | GET / med valid session → 200, uden → 401 |
| **T_BL_SETUP_04** | SSE-listener kan tilsluttes | EventSource forbinder til `/events`, modtager evt. heartbeat |
| **T_BL_SETUP_05** | computeMomsFields virker | Direkte enhedstest af helper-funktion. Hvis `total_price=1000`, returnerer felter med moms_excl, moms_amount, etc. |

### 4.2 FILTER_DEFAULT — uden filter (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_DEF_01** | GET `/api/bons` (ingen params) | 200, array med ALLE non-offer bons (seedede + T_BL_*-bons undtagen F) |
| **T_BL_DEF_02** | Default limit=100 anvendes | Hvis >100 bons matcher, returneres præcis 100 |
| **T_BL_DEF_03** | Default sort = `b.delivery_date ASC, b.delivery_time ASC` (secondary) | Resultater er sorteret stigende på dato+tid |
| **T_BL_DEF_04** | Hver row har moms-felter | `r.moms_excl`, `r.moms_amount` etc. tilstede via `computeMomsFields` |

### 4.3 FILTER_DATE (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_DATE_01** | `?date=today` | Server oversætter til `new Date().toISOString().slice(0,10)`. Returnerer bons med matching delivery_date. T_BL_NY_1, T_BL_NY_2, T_BL_IGANG, T_BL_OFFER (ekskluderet) |
| **T_BL_DATE_02** | `?date=2026-05-11` | Returnerer bons med præcis den dato |
| **T_BL_DATE_03** | `?date_from=2026-05-01&date_to=2026-05-15` | Range-filter på delivery_date inklusive endpoints |
| **T_BL_DATE_04** | `?date_from=2026-05-01` (uden date_to) | >= start-dato, ingen øvre grænse |
| **T_BL_DATE_05** | Tilbud (T_BL_OFFER) ekskluderes uanset dato | Verificeret eksplicit |

### 4.4 FILTER_STATUS — single + multi (6)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_STAT_01** | `?status=NY` | Kun T_BL_NY_1 + T_BL_NY_2 (single-code → `sd.code = ?`) |
| **T_BL_STAT_02** | `?status=NY,VENTER,GODKENDT,IGANG,KLAR` (åbne) | T_BL_NY_1, T_BL_NY_2, T_BL_VENTER, T_BL_IGANG — IKKE T_BL_FAKT |
| **T_BL_STAT_03** | `?status=NY,IGANG` | Multi → `sd.code IN (?, ?)` |
| **T_BL_STAT_04** | `?status=` (tom) | Behandles som ingen filter — alle statusser inkluderet. Verificér adfærd |
| **T_BL_STAT_05** | `?status=UKENDT_STATUS` | Tom resultat (intet match), IKKE fejl |
| **T_BL_STAT_06** | `?status=NY, VENTER` (med whitespace) | Trimmes via `.trim()` i koden — virker som "NY,VENTER" |

### 4.5 FILTER_SEARCH — to grene (7)

Søgning har to forskellige grene afhængigt af input (digits vs text).

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_SEARCH_01** | `?q=12345` (digits) | Bruger `bon_number LIKE '12345%'` — prefix-match på bon-number |
| **T_BL_SEARCH_02** | `?q=Hansen` (text) | Bruger 3-felt LIKE: bon_number, customer first+last, company name. Returnerer bons med "Hansen" i et af felterne |
| **T_BL_SEARCH_03** | `?q=test@firma.dk` (email-format) | **Email matches IKKE** — endpoint søger ikke på customer.email. Dokumentér som finding |
| **T_BL_SEARCH_04** | `?q=` (tom) | Ingen filter — som default |
| **T_BL_SEARCH_05** | `?q=A` (1 char) | Returnerer alle med 'A' nogen steder i de 3 felter (LIKE '%A%') |
| **T_BL_SEARCH_06** | `?q=%` (SQL wildcard som tekst) | Ikke escaped — kan returnere alt. Dokumentér adfærd, vurdér om escape skal med |
| **T_BL_SEARCH_07** | Kombiner `?q=Hansen&status=NY` | Begge filtre anvendt — kun NY-bons med Hansen-match |

### 4.6 FILTER_UNREAD_MAIL (3)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_MAIL_01** | `?unread_mail=1` | Kun bons med subquery-count > 0. T_BL_NY_1 (1) + T_BL_IGANG (2) |
| **T_BL_MAIL_02** | `?unread_mail=0` | Behandles **ikke** som filter (kun '1' aktiverer). Alle bons returneres |
| **T_BL_MAIL_03** | `?unread_mail=true` (string) | Kun '1' aktiverer — `true`-string ignoreres. Verificér |

### 4.7 FILTER_FIRMA + KUNDE (4)

Bruges af Firma 360°/Kunde 360° aggregerede views.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_FIRMA_01** | `?company_id=<test-firma>` | Kun bons med matching company_id |
| **T_BL_FIRMA_02** | `?customer_id=<test-kunde>` | Kun bons med matching customer_id |
| **T_BL_FIRMA_03** | `?company_id=<id>&customer_id=<id>` | Begge anvendt — kun bons med BOTH match |
| **T_BL_FIRMA_04** | `?company_id=9999999` (ikke-eksisterende) | Tom array, ikke 404 |

### 4.8 FILTER_LOCATION (2)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_LOC_01** | `?location=HQ` | Filtrerer på `l.code = 'HQ'` |
| **T_BL_LOC_02** | `?location=hq` (case) | Dokumentér: case-sensitive eller ej? |

### 4.9 SORT — whitelist + secondary (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_SORT_01** | `?sort=delivery_date&dir=asc` | Sorteret efter delivery_date stigende + secondary sort på delivery_time stigende |
| **T_BL_SORT_02** | `?sort=delivery_date&dir=desc` | Falder stigende, secondary samme retning |
| **T_BL_SORT_03** | `?sort=bon_number` | Whitelist → `b.bon_number` |
| **T_BL_SORT_04** | `?sort=customer_name` | Whitelist → `contact_name_full` alias |
| **T_BL_SORT_05** | `?sort=pax&dir=desc` | Højeste pax først |
| **T_BL_SORT_06** | `?sort=total_price` | Sorteret efter beløb |
| **T_BL_SORT_07** | `?sort=UKENDT_KOL` (ikke i whitelist) | Default-fallback til `b.delivery_date` — IKKE SQL-injection eller crash |
| **T_BL_SORT_08** | `?sort=delivery_date&dir=invalid` | `dir !== 'desc'` → falder tilbage til 'ASC' |

### 4.10 PAGINATION (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_PAG_01** | `?limit=10` | Returnerer præcis 10 (eller færre hvis <10 matcher) |
| **T_BL_PAG_02** | `?limit=200` | Returnerer op til 200 |
| **T_BL_PAG_03** | `?limit=1000` (over max) | `Math.min(parseInt(limit), 500)` — cap til 500 |
| **T_BL_PAG_04** | `?limit=abc` (invalid) | `parseInt('abc')` → NaN → default 100 |
| **T_BL_PAG_05** | `?limit=20&offset=10` | Returnerer rows 11-30 (skip first 10) |

### 4.11 RESPONSE_STRUCTURE — kolonne-shape (7)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_RESP_01** | Hver row har core-felter | `id`, `bon_number`, `delivery_date`, `delivery_time`, `pickup_time`, `pax`, `total_price` |
| **T_BL_RESP_02** | Status-info joinet ind | `status_code`, `status_label`, `status_color` (fra status_definitions) |
| **T_BL_RESP_03** | Kunde-info joinet ind | `contact_name_full`, `customer_phone`, `customer_email` |
| **T_BL_RESP_04** | Firma-info joinet ind | `company_name`, `company_ean` |
| **T_BL_RESP_05** | Lokation-navn joinet ind | `location_name` (fra `l.name`) |
| **T_BL_RESP_06** | Pris-kategori joinet ind | `price_category_code`, `price_category_label` |
| **T_BL_RESP_07** | Subqueries virker | `unread_mail_count` numerisk, `latest_delivery_event` + `_time` (sidste delivery_event) |

### 4.12 MOMS_DECORATION (4)

Verificerer at `computeMomsFields()` decoreres på alle rows iht. §6b.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_MOMS_01** | Bon med total_price=1000.00 | Row har `moms_excl≈800.00`, `moms_amount≈200.00` (Dansk moms 25%) |
| **T_BL_MOMS_02** | total_price=NULL eller 0 | Moms-felter er null eller 0 (graceful, ikke NaN) |
| **T_BL_MOMS_03** | Alle bons har moms-felter (ingen exceptions) | response.every(r => 'moms_excl' in r) |
| **T_BL_MOMS_04** | Felter har korrekt navngivning ifølge §6b | Felt-navne matcher `Moms.*`-helpers fra shared/moms.js. Dokumentér konkret format |

### 4.13 SSE — bon_created (3)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_SSE_CREATE_01** | POST /api/bons med ny bon, mens SSE-listener er tilsluttet | Event `bon_created` modtages indenfor 2 sek. med `{id, bon_number}` |
| **T_BL_SSE_CREATE_02** | Event-data har minimum-felter | `data.id` numerisk, `data.bon_number` string |
| **T_BL_SSE_CREATE_03** | Cleanup-DELETE udsender IKKE bon_created | Negative test |

### 4.14 SSE — bon_updated (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_SSE_UPDATE_01** | PATCH /api/bons/:id (felt-ændring) → `bon_updated` event | `{id}` modtages |
| **T_BL_SSE_UPDATE_02** | POST lines → `bon_updated` event (line-add også broadcaster) | `{bon_id: id}` modtages — bemærk forskel: nogle broadcasts bruger `id`, andre `bon_id`. Dokumentér |
| **T_BL_SSE_UPDATE_03** | Mail-read PATCH → `bon_updated` med unread_mail_count | Event indeholder opdateret count |
| **T_BL_SSE_UPDATE_04** | Notification POST → `notification` event (ikke bon_updated) | Separat event-type |

### 4.15 SSE — bon_status (2)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_SSE_STATUS_01** | PATCH /:id/status → `bon_status` event | `{bon_id, old, new}` |
| **T_BL_SSE_STATUS_02** | Force-mode (patch D) → bon_status med samme payload | Event sendes uanset om force=true eller false |

### 4.16 EDGE_CASES (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_EDGE_01** | Tom DB (ingen bons matcher) | 200 med `[]` |
| **T_BL_EDGE_02** | NULL-felter (fx customer uden last_name) | `contact_name_full` håndteret pænt — COALESCE bruges i koden så `c.first_name || ' ' || COALESCE(c.last_name,'')` |
| **T_BL_EDGE_03** | Bon uden customer (customer_id=NULL) | LEFT JOIN bevarer rækken. `contact_name_full` = null eller " " — verificér |
| **T_BL_EDGE_04** | Special-tegn i søgning (Ø, æ, ø, å) | UTF-8-match virker — verificér med fx "Søren" |
| **T_BL_EDGE_05** | SQL-injection-forsøg i `q` (`?q=' OR 1=1`) | Prepared statements binder som data, ikke SQL. Ingen exploitation |

### 4.17 CLEANUP

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BL_CLEANUP_01** | Alle T_BL_-bons slettet | `SELECT COUNT(*) FROM bons WHERE bon_number LIKE 'T_BL_%'` = 0 |
| **T_BL_CLEANUP_02** | CASCADE: bon_lines + mail_threads + delivery_events også fjernet | Verificeret via tre separate counts |
| **T_BL_CLEANUP_03** | Pre-eksisterende seeded bons uændret | Counts før og efter test = same |
| **T_BL_CLEANUP_04** | SSE-listener afsluttet | Connection lukket, ingen orphans |

---

## 5. Konkret eksempel — T_BL_SEARCH_02 step for step

```
Setup:
- Opret T_BL_SEARCH_HANSEN-bon med customer.first_name='Lars', last_name='Hansen'
- snapshot_bons = COUNT(*) FROM bons WHERE bon_number LIKE 'T_BL_%'

1. GET /api/bons?q=Hansen
   → Server detekterer q ikke er kun digits → går i text-grenen
   → WHERE-klausul tilføjes:
     "(b.bon_number LIKE '%Hansen%' OR c.first_name || ' ' || COALESCE(c.last_name,'') LIKE '%Hansen%' OR co.name LIKE '%Hansen%')"

2. ASSERT response:
   - response.length >= 1
   - response[i] hvor bon_number='T_BL_SEARCH_HANSEN' findes
   - response[i].contact_name_full contains 'Hansen'

3. CLEANUP:
   - DELETE FROM bons WHERE bon_number = 'T_BL_SEARCH_HANSEN'

VERIFY: snapshot match

PASS — hermetisk
```

---

## 6. Fejlsignaler og fortolkning

| Symptom | Sandsynlig årsag |
|---------|------------------|
| `?status=NY,VENTER` returnerer kun NY | `split(',').map(s => s.trim())` virker ikke — tjek `.filter(Boolean)` der fjerner tomme |
| `?date=today` returnerer alle datoer | Server-side tidszone — Node bruger UTC, men DK er CET. Tjek dato-konvertering |
| `?sort=UNKNOWN` returnerer 500 | SORT_WHITELIST-fallback virker ikke. Tjek fallback-linje |
| `unread_mail_count` altid 0 | Subquery joiner ikke korrekt. Tjek `mail_threads.bon_id` vs `mail_messages.thread_id` |
| SSE `bon_created` modtages aldrig | Test-EventSource har auth-issue. SSE kan kræve cookie/session |
| computeMomsFields fejler på null | Tjek `shared/moms.js` håndtering af null/0 |
| `q=%` returnerer alt | Wildcard ikke escaped. Hvis ønskværdigt at understøtte literal `%`, escape eller fjern char |
| `?offset=10` returnerer samme rows | offset glemmes i Math.min — tjek `parseInt(offset) || 0` |
| Tilbud (is_offer=1) kommer med i resultat | Hardcoded WHERE-klausul mangler eller bypassede |
| Status-filter med IN-klausul fejler | parameter-binding rækkefølge — args.push(...codes) for hver |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_BONS_LIST.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_BONS_LIST.js` | Test-runner | 🔲 |
| `tests/scripts/helpers/sse_listener.js` | SSE-test-helper (`connect`, `waitForEvent`, `disconnect`) | 🔲 (ny — genbruges på alle office-tracks) |
| `tests/fixtures/T_BL_seed.sql` | Optional: SQL-script til at oprette de 6 test-bons | 🔲 (valgfrit hvis runneren laver dem programmatisk) |
| `tests/reports/T_BONS_LIST_YYYY-MM-DD.md` | Rapport (genereres) | 🔲 |

npm-script:
```json
"test:run-bons-list": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_BONS_LIST.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Alle 6 filter-typer virker (date, status, search, mail, firma, location) | Office-listview kan trygt filtrere uden at ramme data der ikke matcher |
| Tilbud ekskluderes konsekvent | T_TILBUD's separate view kan trygt antage at almindelig liste er ren bons |
| Søgning matcher korrekt bons | Bruger kan finde bons via bon-nr, kunde-navn eller firma-navn |
| Sortering er race-safe og SQL-injection-resistent | Brugerens valg er pålideligt |
| Pagination respekterer max=500 | Database overbelastes ikke ved store queries |
| Moms-decoration er konsistent | UI skal aldrig regne moms selv (§6b) — alle felter er pre-beregnede |
| SSE-events udsendes ved alle mutationer | Listview opdaterer realtime når nogen andre ændrer noget |
| Edge-cases håndteret (null, UTF-8, SQL-injection-forsøg) | System bryder ikke ved sær-input |

---

## 9. Næste skridt efter T_BONS_LIST

| Track | Indhold |
|-------|---------|
| **T_BON_DRAWER** | GET/PATCH/DELETE `/api/bons/:id` + lines-CRUD + changelog + notifications |
| **T_FAKTURERING** | `routes/invoices.js` (queue, mark-invoiced, moms-håndtering) |
| **T_TILBUD** | `is_offer=1` flow, wizard-steps |
| **T_V1_AFSTEMNING** | Parallel — venter til weekenden ifølge plan |

---

## 10. Status — efter første kørsel

```
(genereres ved første kørsel)
```

---

## 11. Findings — skal tjekkes og noteres ved første kørsel

| # | Reference | Spørgsmål | Hvordan tjekkes |
|---|-----------|-----------|-----------------|
| **F42** | §4.5 (SEARCH_03) | Email-format matches ikke i søg | Verificér ved første kørsel. Hvis intentional, dokumentér. Hvis ikke, F-kandidat for udvidelse af søge-felter |
| **F43** | §4.5 (SEARCH_06) | Wildcard `%` ikke escaped | Tjek om det skal være tilladt eller skal escapes til literal |
| **F44** | §4.6 (MAIL_02/03) | Kun '1' aktiverer unread_mail-filter | Dokumentér: hvis klient sender 'true' eller '0', tæller det som tomt? |
| **F45** | §4.8 (LOC_02) | Location case-sensitivity | Test og dokumentér |
| **F46** | §4.9 (SORT_07) | Default-fallback ved ukendt sort-key | Verificér at det er `b.delivery_date ASC` (ikke crash) |
| **F47** | §4.10 (PAG_04) | parseInt('abc') → NaN → default 100? Eller bug? | Verificér adfærd |
| **F48** | §4.12 (MOMS_04) | Konkret format af moms-decoration-felter | Læs `shared/moms.js` ved første kørsel og dokumentér eksakt navne |
| **F49** | §4.14 (SSE_UPDATE_02) | Inkonsistent event-payload: `{id}` vs `{bon_id}` | Påvirker frontend håndtering — påkrævet at standardisere? |
| **F50** | §4.16 (EDGE_03) | Bon uden customer — contact_name_full | Tjek faktisk værdi: null, " ", eller andet |
| **F51** | Generel | Field-spec der mangler i bons-list.js's UI er `payment_type`, `delivery_type`, `kitchen_selects` | Endpoint returnerer dem, men UI viser dem i optional kolonner. Bekræft mapping til SQL-row |

---

*Oprettet: maj 2026 — første office-track. Specet mod faktisk `routes/bons.js` GET-handler. SSE-test-helper er ny infrastruktur der genbruges på alle office-tracks.*
