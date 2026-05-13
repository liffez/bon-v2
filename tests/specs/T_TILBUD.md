# T_TILBUD — Test-spec for tilbudsmodulet

> Test-spec for `routes/quotes.js` — tilbud = bon med `is_offer=1`.
>
> Femte office-track. Verificerer at den arkitektoniske beslutning om
> tilbud-som-bon faktisk virker: T-nummerserie, offer_status-flow, CRUD,
> convert-til-aktiv-bon, og at tilbud holder sig adskilt fra bons-listen
> overalt i systemet.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Alle 8 endpoints i `routes/quotes.js`: GET `/next-number`, GET `/`, GET `/:id`, POST `/`, PATCH `/:id`, DELETE `/:id`, PATCH `/:id/status`, POST `/:id/convert`. Plus moms-disciplin via `formatOffer.computeMomsFields()`, T-nummerserie, recalcTotal, og isolation fra bons-listen |
| **Hvad testes IKKE** | Office-wizard UI (`office/views/tilbud.js`) — det er Playwright-territorium. PDF-generering (jsPDF). Mail-attachment-flow til kunde (separat T_MAIL-track) |
| **Forhold til T_BON_DRAWER** | T_BON_DRAWER tester bons med `is_offer=0`. T_TILBUD tester at QUOTES-endpoints filtrerer korrekt på `is_offer=1` — og at konverterede tilbud (is_offer=0) IKKE længere er tilgængelige via `/api/quotes` |
| **Forhold til T_FAKTURERING** | T_FAKTURERING #032 lukkede F62 (is_offer filtreres fra fakturerings-queue). T_TILBUD verificerer den anden vej — at tilbud IKKE indeholder data der hører til bons (fx LEVERET-status) |
| **Forhold til T_BONS_LIST** | T_BONS_LIST verificerer at `GET /api/bons` ekskluderer `is_offer=1`. T_TILBUD verificerer den komplementære: tilbud sendes via `GET /api/quotes` og kun via dén kanal |

---

## 2. Forudsætninger

### 2.1 Test-instans

- `data/test.db` seedet via `seed_planning.sql`
- Auth-session etableret (almindelig auth nok — ikke admin-only)
- `status_definitions`-tabellen har TILBUD + GODKENDT
- Settings `quote_number_prefix='T-'` + `quote_number_next` initialiseret

### 2.2 Test-data — egne T_TIL_

Hver test opretter sine egne tilbud via API (POST /api/quotes) for at
verificere både insert-pathen og resulterende data. Hermetisk via
`T_TIL_`-prefix på bon_number er ikke muligt fordi T-nummeret tildeles
af serveren — i stedet bruger vi customer/company med `T_TIL_`-prefix og
sletter via deres relation.

| Tilbud | offer_status | Lines | Andre felter | Forventet |
|--------|--------------|-------|--------------|-----------|
| T_TIL_DRAFT_1 | draft | 2 stk (sandwich + salat) | template=event, pax=20 | Kommer i listen, kan slettes |
| T_TIL_SENT_1 | sent | 3 stk | discount_percent=10 | Kommer i listen, kan IKKE slettes |
| T_TIL_WON_1 | won (via convert) | 1 stk | — | IKKE i /api/quotes liste (is_offer=0 efter convert) |
| T_TIL_LOST | lost | 0 lines | — | Kommer i listen, line_total=0 |
| T_TIL_EXPIRED | expired | 2 stk | valid_until=igår | Kommer i listen, expired-flag synligt |
| T_TIL_NO_LINES | draft | 0 lines | pax=5 | total_price=0 efter recalc |
| T_TIL_DELIVERY | draft | 1 line | delivery_price=200 | total_price = line_total + 200 |
| T_TIL_DISCOUNT | draft | 2 lines | discount=15% | total_price = (sum-discount) |
| T_TIL_X_LEVERING | draft | 2 lines (1 med category='x-Levering') | delivery_price=300 | total_price IKKE dobbelttalt (Quick-fix Del 5.5) |

### 2.3 Test-kunder + firma

- `T_TIL_customer_1`: privat (uden company) — ejer DRAFT_1, NO_LINES, DELIVERY
- `T_TIL_customer_2`: tilknyttet `T_TIL_company` — ejer SENT_1, WON_1, LOST
- `T_TIL_company`: navn 'T_TIL_company', cvr='12345678'

### 2.4 Float-tolerance

`FLOAT_TOL = 0.01`.

---

## 3. Strategi: setup → action → assert → cleanup

```
1. snapshot = optælling af tilbud i DB før test (forventet uændret efter)
2. ACTION_setup: opret kunder + firma via DB
3. ACTION_test: POST /api/quotes for hver test-bon, manipulér via PATCH/etc.
4. ASSERT: response-struktur, beløb, moms-felter, filtrering
5. CLEANUP: DELETE FROM bons WHERE customer_id IN test-set OR company_id = T_TIL_company
6. VERIFY: snapshot.count == final.count
```

Hermetisk gennem ejer-relation. quote_number_next inkrementeres af
nextQuoteNumber() — vi accepterer det og rapporterer "next-number flyttede
fra N til N+M" som data, ikke som fejl.

---

## 4. Test-cases

### 4.1 SETUP (5)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_TIL_SETUP_01** | TILBUD-status findes | `status_definitions` har TILBUD-kode |
| **T_TIL_SETUP_02** | GODKENDT-status findes | Bruges af convert |
| **T_TIL_SETUP_03** | Settings konfigureret | `quote_number_prefix` + `quote_number_next` findes |
| **T_TIL_SETUP_04** | Test-relationer oprettet | T_TIL_company + 2 kunder indsat |
| **T_TIL_SETUP_05** | Moms-helper tilgængelig | `shared/moms.js` har `computeMomsFields` |

### 4.2 NEXT_NUMBER (3)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_NUM_01** | GET /api/quotes/next-number | Returnerer `{quote_number: 'T-N'}` med valid format |
| **T_TIL_NUM_02** | Kald 2× uden POST imellem | Samme tal — endpoint INKREMENTERER IKKE, kun reader |
| **T_TIL_NUM_03** | POST /api/quotes derefter | Nyt tilbud får T-N, GET /next-number returnerer nu T-(N+1) |

### 4.3 POST (10)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_POST_01** | Minimal POST `{customer_id, delivery_date}` | 201 med `{id, quote_number, bon_number}`. bon_number starter med 'T-' |
| **T_TIL_POST_02** | DB-row har `is_offer=1` | Direkte SELECT bekræfter |
| **T_TIL_POST_03** | offer_status default | `'draft'` |
| **T_TIL_POST_04** | offer_valid_until default | 30 dage efter quote_date |
| **T_TIL_POST_05** | Custom valid_until honoreres | Sat i body, gemt 1:1 |
| **T_TIL_POST_06** | POST med 2 lines | Linjer indsat, line_total = qty × unit_price |
| **T_TIL_POST_07** | total_price recalc'et | = SUM(line_total) + delivery_price |
| **T_TIL_POST_08** | Linje uden unit_price | line_total=null, total_price tæller med 0 |
| **T_TIL_POST_09** | SSE broadcast `bon_created` med `is_offer:true` | Lyttes via SSE-listener |
| **T_TIL_POST_10** | Changelog-entry oprettet | action='create', notes='Tilbud oprettet' |

### 4.4 GET (9)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_GET_01** | GET /api/quotes | Returnerer kun is_offer=1 bons (vores 6+ test-tilbud + evt. eksisterende) |
| **T_TIL_GET_02** | T_TIL_WON_1 IKKE i listen | Efter convert er is_offer=0 — IKKE i /api/quotes |
| **T_TIL_GET_03** | Filter `?status=draft` | Kun draft-tilbud |
| **T_TIL_GET_04** | Filter `?status=sent,lost` | Multi-status filter via komma |
| **T_TIL_GET_05** | Filter `?customer_id=N` | Kun tilbud ejet af kunden |
| **T_TIL_GET_06** | Filter `?company_id=N` | Kun tilbud ejet af firmaet |
| **T_TIL_GET_07** | Filter `?q=customer_name` | LIKE-søgning på navn |
| **T_TIL_GET_08** | Sortering ORDER BY created_at DESC | Nyeste først |
| **T_TIL_GET_09** | Moms-felter inkluderet | response[i] har total_incl_moms, total_excl_moms, moms_amount |

### 4.5 GET BY ID (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_DETAIL_01** | GET /api/quotes/:id | 200 med fuldt objekt |
| **T_TIL_DETAIL_02** | Lines i response | Array sorteret efter sort_order, id |
| **T_TIL_DETAIL_03** | delivery_address rendret | Bygget fra street_name + street_nr + postal_code + city |
| **T_TIL_DETAIL_04** | Moms-felter (total_incl_moms, total_excl_moms, moms_amount) | Returneres altid |
| **T_TIL_DETAIL_05** | offer_block_metadata parses som JSON | Hvis sat — ellers null |
| **T_TIL_DETAIL_06** | GET /:id på en bon (is_offer=0) | 404 — endpoint filtrerer is_offer=1 |
| **T_TIL_DETAIL_07** | GET /:id på konverteret tilbud | 404 — is_offer=0 efter convert |
| **T_TIL_DETAIL_08** | GET /:id på ukendt id | 404 |

### 4.6 PATCH (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_PATCH_01** | PATCH `{pax: 30}` | Felt opdateret, changelog-entry oprettet |
| **T_TIL_PATCH_02** | Field-rename: `notes` → `internal_notes` | DB-kolonnen rammes korrekt |
| **T_TIL_PATCH_03** | PATCH `{template: 'event'}` | Rammer `offer_template`-kolonnen |
| **T_TIL_PATCH_04** | PATCH med `lines: [...]` | Replace-all: gamle linjer slettet, nye indsat |
| **T_TIL_PATCH_05** | total_price recalc'et efter line-replace | recalcTotal kører |
| **T_TIL_PATCH_06** | total_units opdateres (ekskl. accessory) | Konsistent med bons.js + invoices Patch G |
| **T_TIL_PATCH_07** | PATCH `offer_block_metadata: invalid` | 400 med "skal være valid JSON-objekt" |
| **T_TIL_PATCH_08** | SSE broadcast `bon_updated` | Lyttes via SSE-listener |

### 4.7 STATUS_PATCH (6)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_STAT_01** | PATCH status='sent' | offer_status='sent', offer_sent_at sat |
| **T_TIL_STAT_02** | PATCH status='lost' | Accepteret |
| **T_TIL_STAT_03** | PATCH status='expired' | Accepteret |
| **T_TIL_STAT_04** | PATCH status='xyz' | 400 "Ugyldig status" |
| **T_TIL_STAT_05** | PATCH status='won' direkte (uden convert) | **F-kandidat**: Tillader status='won' uden at sætte is_offer=0. Resulterer i tilbud der er "won" men stadig er et tilbud → forvirrende. Bør status='won' kun nås via /convert? |
| **T_TIL_STAT_06** | Changelog-entry action='status_change' | Logget med fieldName='offer_status' |

### 4.8 CONVERT (7)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_CONV_01** | POST /:id/convert på draft | 200, is_offer=0, offer_status='won', status_id=GODKENDT |
| **T_TIL_CONV_02** | Konverteret tilbud nu i `GET /api/bons` | Dukker op som regulær bon |
| **T_TIL_CONV_03** | Konverteret tilbud IKKE i `GET /api/quotes` | Filtreret bort fordi is_offer=0 |
| **T_TIL_CONV_04** | Convert ikke-eksisterende id | 404 |
| **T_TIL_CONV_05** | Convert allerede konverteret (is_offer=0) | 400 "Denne bon er ikke et tilbud" |
| **T_TIL_CONV_06** | Convert tilbud med offer_status='won' (sat via PATCH /status) | 400 "Tilbud er allerede konverteret" — selv om is_offer stadig er 1 (jf. T_TIL_STAT_05) |
| **T_TIL_CONV_07** | Lines bevares ved convert | DELETE/INSERT sker ikke — lines er stadig samme rækker |

### 4.9 DELETE (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_DEL_01** | DELETE på draft | 200 + lines slettet (CASCADE) |
| **T_TIL_DEL_02** | DELETE på sent | 400 "Kun kladder kan slettes" |
| **T_TIL_DEL_03** | DELETE på lost | 400 |
| **T_TIL_DEL_04** | DELETE på konverteret bon (via /api/quotes/:id) | 404 — is_offer=0 |
| **T_TIL_DEL_05** | DELETE på ukendt id | 404 |

### 4.10 RECALC (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_REC_01** | T_TIL_DELIVERY: 1 line à 500 + delivery_price=200 | total_price=700 |
| **T_TIL_REC_02** | T_TIL_DISCOUNT: 2 lines = 1000 + 15% rabat | total_price=850 |
| **T_TIL_REC_03** | T_TIL_X_LEVERING: 2 lines hvoraf 1 er category='x-Levering' à 200, delivery_price=300 sat | total_price = (line A + 200), IKKE +300 oveni. Quick-fix Del 5.5 |
| **T_TIL_REC_04** | T_TIL_NO_LINES + delivery_price=0 | total_price=0 |
| **T_TIL_REC_05** | recalc kører ved PATCH med lines | Ny total stemmer med nye lines |

### 4.11 MOMS-DISCIPLIN (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_MOMS_01** | response.total_price er INCL moms | Verificeret mod seedet line.unit_price (incl) |
| **T_TIL_MOMS_02** | response.total_incl_moms == total_price | Identisk værdi (begge er INCL) |
| **T_TIL_MOMS_03** | response.total_excl_moms = inclToExcl(total_price) | Verificeret med shared/moms.js |
| **T_TIL_MOMS_04** | response.moms_amount = total_incl - total_excl | Verificeret |

### 4.12 ISOLATION (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_ISO_01** | GET /api/bons ekskluderer T_TIL-tilbud | bons.js linje 75 har `is_offer=0 OR IS NULL` |
| **T_TIL_ISO_02** | GET /api/invoices/queue ekskluderer T_TIL-tilbud | Patch G F62-fix verificeret |
| **T_TIL_ISO_03** | GET /api/bons/calendar/... viser T_TIL-tilbud | Kalender VISER tilbud (separate sektion) — verificér ej brudt |
| **T_TIL_ISO_04** | GET /api/bons/later viser T_TIL-tilbud | OR b.is_offer=1 i WHERE — bekræftet |

### 4.13 CLEANUP (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_TIL_CLEAN_01** | DELETE alle T_TIL-tilbud + konverterede bons | Via customer_id IN + company_id |
| **T_TIL_CLEAN_02** | bon_lines slettet via CASCADE | 0 orphans |
| **T_TIL_CLEAN_03** | Test-kunder slettet | T_TIL_customer_1/2 væk |
| **T_TIL_CLEAN_04** | T_TIL_company slettet | Eksisterer ikke længere |
| **T_TIL_CLEAN_05** | quote_number_next inkrementeret korrekt | Forventet stigning ≥ antal POST'ede tilbud |

---

## 5. Konkret eksempel — T_TIL_REC_03 (x-Levering quick-fix)

```
Setup:
- POST /api/quotes med 2 lines:
  - Line A: product_name='Sandwich', qty=10, unit_price=100, line_total=1000
  - Line B: product_name='Levering', category='x-Levering', qty=1, unit_price=200, line_total=200
- delivery_price=300

Når recalcTotal kører:
- linesSum = 1000 + 200 = 1200
- hasLeveringLine = true (category='x-Levering')
- deliveryAdd = 0 (IKKE 300 — undgår dobbelttælling)
- subtotal = 1200
- discount = 0
- total = 1200

ASSERT:
- response.total_price === 1200
- IKKE 1500 (det ville være dobbelttælling fra bug-tiden)

CLEANUP: DELETE bons WHERE id

PASS — Quick-fix Del 5.5 dokumenteret og virker
```

---

## 6. Fejlsignaler

| Symptom | Sandsynlig årsag |
|---------|------------------|
| POST returnerer T-nummer der allerede findes | Race condition i nextQuoteNumber — verificér at den kører i transaction |
| GET /api/quotes viser konverteret tilbud | WHERE-klausul mangler is_offer=1 |
| total_price=0 efter POST med lines | line_total beregnes ikke korrekt (unit_price=null?) |
| total_price = linesSum + delivery_price (begge talt) | Quick-fix Del 5.5 ikke aktiv |
| DELETE returnerer 400 på draft | offer_status-tjek inverteret |
| convert returnerer 400 på legitim draft | offer_status checked forkert ('draft' vs 'won') |
| status='won' uden convert giver inkonsistent state | F-kandidat T_TIL_STAT_05 — overvej at flytte 'won' til convert-only |
| moms_amount er negativt | computeMomsFields fejler ved 0 eller negativ total |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_TILBUD.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_TILBUD.js` | Test-runner | 🔲 |
| `tests/reports/T_TILBUD_YYYY-MM-DD.md` | Rapport | 🔲 |

npm-script:
```json
"test:run-tilbud": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_TILBUD.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Tilbud-som-bon arkitekturen virker | is_offer=1 isolerer korrekt i hele systemet |
| T-nummerserie inkrementerer atomisk | Ingen duplikat-numre selv ved samtidige POSTs |
| recalcTotal håndterer x-Levering quick-fix | Ingen dobbelttælling af leveringsgebyr |
| Moms-felter konsistent INCL+EX+amount | Frontend kan bruge response direkte |
| Convert flytter tilbud korrekt over til bons-domænet | Tilbud forsvinder fra /api/quotes, dukker op i /api/bons |
| DELETE-restriction til kladder | Sent tilbud kan ikke ved et uheld slettes — historik bevares |
| GET-filtre virker (status, customer_id, company_id, q) | Office tilbudsliste virker |

---

## 9. Næste skridt

| Track | Indhold |
|-------|---------|
| **T_CASHFLOW** | `routes/cashflow.js` — CSV-upload, manual faktura-CRUD, bank-matching. Stor suite, admin-only |
| **T_BOOKING** | Booking-modul end-to-end test: smagsprøve + kontakt-flows, slot-beregning, token-redirect |
| **T_V1_AFSTEMNING** | Weekend-track ifølge plan |

---

## 10. Status — efter første kørsel

```
(genereres ved første kørsel)
```

---

## 11. Findings — afventer første kørsel

| # | Reference | Spørgsmål | Hvordan tjekkes |
|---|-----------|-----------|-----------------|
| **F68** | §4.7 (STAT_05) | PATCH status='won' tillader 'won' uden convert | Verificér ved første kørsel. Hvis adfærden er at status='won' kun må sættes via /convert, bør valid-listen ekskludere 'won' |
| **F69** | §4.8 (CONV_06) | Convert på allerede won (uden konvertering) — er fejlmeddelelsen rigtig? | Status text "allerede konverteret" er upræcist når is_offer stadig er 1 |
| **F70** | §4.6 (PATCH_04) | PATCH med lines:[] (tom array) | Sletter alle linjer uden at indsætte nogen — er det intended? Lille rationale-spørgsmål |
| **F71** | (overordnet) | DELETE bon_lines i PATCH replace-all logger ingen changelog | Linjeniveau-historik tabes ved tilbud-redigering. F-kandidat hvis audit-trail er vigtig |
| **F72** | §4.6 (PATCH_06) | routes/quotes.js INSERT INTO bon_lines mangler is_accessory-kolonne | Både POST og PATCH dropper `is_accessory`-flaget på lines. routes/bons.js bevarer det (linje 498) — quotes.js er ude af sync. Konsekvens: accessory-lines på tilbud kan ikke markeres, og total_units kan ikke ekskludere dem. Fix: tilføj `is_accessory` til INSERT-statementen i POST + PATCH (2 steder) |

---

*Oprettet: 13. maj 2026 — femte office-track. Verificerer at den
arkitektoniske beslutning om tilbud-som-bon (is_offer=1-mønstret) faktisk
holder under realistiske CRUD-operationer.*
