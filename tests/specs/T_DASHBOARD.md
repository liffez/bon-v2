# T_DASHBOARD — Test-spec for dashboard-endpoints

> Test-spec for `routes/dashboard.js` — alle 4 endpoints der ligger bag
> office's dashboard-view (`office/views/dashboard.js`):
>
> - `GET /api/dashboard/today` — "Lige nu"-data: dagens bons, totals, alerts, tomorrow_prep, MTD KPI
> - `GET /api/dashboard/stats` — Søjlegraf-data + uge-sammenligning + Smartplan-shifts
> - `GET /api/dashboard/top-products` — Top 10 mest solgte produkter (måneds-default)
> - `GET /api/dashboard/weather` — DMI vejr-proxy (placeholder, ikke implementeret)
>
> Dashboard er det første view brugerne ser når de starter — derfor vigtigt at
> tallene er korrekte og konsistente med §6c (moms-disciplin med eksplicitte
> ex/incl/moms-felter).

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | 4 endpoints. Filter-konsistens (`is_offer=0 AND is_internal=0`). MTD year-over-year sammenligning. Tomorrow's prep-status aggregation. Alerts (prep_missing, status_waiting, unread_mail). Moms-disciplin (revenue_excl_moms, revenue_incl_moms, vat_collected) iht. §6c. Graceful degradation for weather (DMI-API-nøgle mangler) og Smartplan (service unavailable) |
| **Hvad testes IKKE** | UI-rendering (frontend). CRM callbacks/call-log (T_CRM dækker). Faktisk DMI-API (placeholder). Faktisk Smartplan-API (mock'es) |
| **Forhold til T_BONS_LIST** | T_BONS_LIST tester at tilbud ekskluderes fra listview. Dashboard verificerer samme filter konsistent på alle 4 endpoints |
| **Forhold til T_FAKTURERING** | T_FAKTURERING tester `pending_amount` (LEVERET + invoice). Dashboard's `mtd.unfactured` tester LEVERET status alene — overlap er minimal og bevidst |
| **Forhold til T_PLAN / T_AGGR** | Plan/aggr tester kitchen-views. Dashboard tester office-views af samme data. Forskellige queries, ingen overlap |
| **Forhold til T_KITCHEN_TODAY** | Kitchen today bruger samme `_today()`-funktion. Dashboard's "/today" er office-view af samme grundtilstand |

---

## 2. Forudsætninger

### 2.1 Test-instans

- `data/test.db` seedet med `seed_planning.sql`
- Auth-session etableret
- `status_definitions` har LEVERET, FAKTURERET, AFSLUTTET, BETALT, NY, VENTER, GODKENDT, IGANG, KLAR, AFLYST
- Settings-tabel kan have `dashboard_countdown_enabled` (test både med og uden)

### 2.2 Test-bons — `T_DASH_`-prefix

Test-bons skal dække alle filter-grene:

| Bon | delivery_date | status | is_offer | is_internal | payment_type | Total | Pax | Units |
|-----|---------------|--------|---------:|------------:|--------------|------:|----:|------:|
| T_DASH_TODAY_1 | today | NY | 0 | 0 | invoice | 1000 | 10 | 20 |
| T_DASH_TODAY_2 | today | IGANG | 0 | 0 | card | 2000 | 20 | 40 |
| T_DASH_TODAY_LEV | today | LEVERET | 0 | 0 | invoice | 1500 | 15 | 30 |
| T_DASH_TODAY_AFL | today | AFLYST | 0 | 0 | invoice | 999 | 10 | 20 |
| T_DASH_TODAY_INT | today | LEVERET | 0 | **1** | invoice | 800 | 8 | 16 |
| T_DASH_TODAY_OFFER | today | LEVERET | **1** | 0 | invoice | 5000 | 50 | 100 |
| T_DASH_TOMORROW | today+1 | GODKENDT | 0 | 0 | invoice | 1200 | 12 | 24 |
| T_DASH_TOMORROW_PREP | today+1 | IGANG | 0 | 0 | invoice | 800 | 8 | 16 |
| T_DASH_MTD_DELIVERED | today-5 | FAKTURERET | 0 | 0 | invoice | 3000 | 30 | 60 |
| T_DASH_LY | today-365 (sidste år) | LEVERET | 0 | 0 | invoice | 2500 | 25 | 50 |
| T_DASH_PREP_MISSING | today | IGANG | 0 | 0 | invoice | 500 | 5 | 10 (prep_*=0) |

For `T_DASH_TOMORROW` + `T_DASH_TOMORROW_PREP`: én med begge prep-flag=1, én uden — test af `all_ingredients_ready` aggregation.

### 2.3 Test-lines

For top-products: T_DASH_TODAY_LEV har 3 lines:
- Line A: "Frikadeller", qty=30, unit_price=25 (incl moms), is_accessory=0
- Line B: "Brød Rug", qty=20, unit_price=15, is_accessory=0
- Line C: "Engangsservice", qty=10, unit_price=5, is_accessory=**1** ← skal ekskluderes

### 2.4 Smartplan mock

Test-helper sætter `services/smartplanAdapter._setMockShifts([...])` der returnerer fast shifts-array. Hvis adapter ikke har test-mode, mock'es via dependency injection eller direkte require-cache-override.

For tests der verificerer graceful degradation: mock kaster Error → response skal stadig være 200 med tomme `shifts_by_date`.

### 2.5 Float-tolerance

`FLOAT_TOL = 0.01` — særligt vigtigt for moms-decoration der involverer division/rounding.

---

## 3. Strategi: snapshot → seed → query → cleanup

```
1. snapshot = SELECT COUNT(*) FROM bons WHERE bon_number LIKE 'T_DASH_%'
2. ACTION_setup: INSERT 11 test-bons + 3 lines på T_DASH_TODAY_LEV
3. ACTION_test: GET /today, /stats, /top-products, /weather med varierende params
4. ASSERT: response struktur + beløb + filtre + moms-decoration
5. CLEANUP: DELETE FROM bons WHERE bon_number LIKE 'T_DASH_%'
   (CASCADE rydder lines)
6. VERIFY: snapshot == final state
```

---

## 4. Test-cases

### 4.1 SETUP (5)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_DASH_SETUP_01** | DB seedet med status_definitions | Alle 10 statuskoder eksisterer |
| **T_DASH_SETUP_02** | Test-bons oprettet | 11 T_DASH_-bons indsat |
| **T_DASH_SETUP_03** | Auth virker | GET med session → 200, uden → 401 |
| **T_DASH_SETUP_04** | Smartplan mock klar | `_setMockShifts` accepterer testdata |
| **T_DASH_SETUP_05** | Moms-helpers tilgængelige | `inclToExcl`, `momsOfIncl`, `r2` virker |

### 4.2 GET /today — basale data (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_T_01** | GET /today | 200 med 9 felter: date, bons, totals, production_totals, categories, alerts, next_pickup, tomorrow_prep, mtd |
| **T_DASH_T_02** | bons-array indeholder kun non-terminal bons med delivery_date=today | T_DASH_TODAY_1, T_DASH_TODAY_2 + T_DASH_PREP_MISSING. IKKE LEVERET, AFLYST, INT, OFFER (terminal eller ekskluderet) |
| **T_DASH_T_03** | Bons sorteret ASC efter delivery_time | Verificér rækkefølge |
| **T_DASH_T_04** | Bons har required-felter | id, bon_number, status_code, status_color, delivery_time, total_units, pax, prep_*, total_price, customer_name |
| **T_DASH_T_05** | customer_name = company > customer (COALESCE) | Hvis bon har company → vises co.name, ellers first+last |
| **T_DASH_T_06** | T_DASH_TODAY_AFL ekskluderet fra `bons` (terminal) | AFLYST er i TERMINAL_CODES |
| **T_DASH_T_07** | next_pickup beregnes på fremtidige times | MIN af pickup_time/delivery_time hvor >= nu |
| **T_DASH_T_08** | countdown_enabled fra settings | Hvis `dashboard_countdown_enabled='1'` → true, ellers false |

### 4.3 GET /today — totals + production_totals (7)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_TOT_01** | totals.bon_count tæller dagens bons (inkl. LEVERET, excl. AFLYST/offer/internal) | T_DASH_TODAY_1+2+LEV+PREP = 4 (NEK AFL/INT/OFFER) |
| **T_DASH_TOT_02** | totals.total_price summen | 1000+2000+1500+500 = 5000 (alle non-offer non-internal undt. AFLYST) |
| **T_DASH_TOT_03** | totals.total_units bruger fallback til pax hvis total_units=0 | `b.total_units > 0 ? total_units : pax` |
| **T_DASH_TOT_04** | production_totals separat fra totals | Kun T_DASH_TODAY_INT (is_internal=1) — bon_count=1 |
| **T_DASH_TOT_05** | production_totals.total_price IKKE inkluderet | (Kun bon_count + total_units + total_pax — IKKE total_price). Verificér |
| **T_DASH_TOT_06** | T_DASH_TODAY_OFFER (is_offer=1) IKKE i totals | Konsistent filter |
| **T_DASH_TOT_07** | T_DASH_TODAY_AFL IKKE i totals | NOT IN ('AFLYST')-klausul |

### 4.4 GET /today — alerts (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_AL_01** | T_DASH_PREP_MISSING genererer prep_missing alert | severity='warning', message inkluderer "råvarer + emballage" |
| **T_DASH_AL_02** | Bons med prep=1 IKKE i alerts | Verificér negativt |
| **T_DASH_AL_03** | T_DASH_TODAY_1 (status=NY) genererer status_waiting alert | severity='info', message "er ny" |
| **T_DASH_AL_04** | Bon med status=VENTER genererer alert "venter godkendelse" | (Hvis test-bon eksisterer) |
| **T_DASH_AL_05** | unread_mail-alert hvis ulæst mail findes | severity='info', count med count-felt |
| **T_DASH_AL_06** | Ingen ulæst mail → ingen unread_mail-alert | Negativt tjek |
| **T_DASH_AL_07** | Alert-array har korrekte felter | type, bon_id, bon_number, message, severity (eller count for unread_mail) |
| **T_DASH_AL_08** | Terminal bons (LEVERET, FAKTURERET) trigger IKKE prep_missing | Konsistent filter |

### 4.5 GET /today — tomorrow_prep (6)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_TP_01** | tomorrow_prep har date = today+1 | Verificér +1 dag |
| **T_DASH_TP_02** | tomorrow_prep.bons inkluderer ALLE non-terminal bons for i morgen | T_DASH_TOMORROW + T_DASH_TOMORROW_PREP |
| **T_DASH_TP_03** | all_ingredients_ready = AND af alle bons.prep_ingredients_ready | Hvis én bon har prep=0 → false |
| **T_DASH_TP_04** | all_supplies_ready tilsvarende | Samme logik |
| **T_DASH_TP_05** | Tom tomorrow_bons → all_*_ready=false | Edge: ingen bons → ikke "all true" |
| **T_DASH_TP_06** | tomorrow_prep.total_units summen | Sum over alle tomorrow-bons |

### 4.6 GET /today — MTD KPI (8) — VIGTIGT FOR MOMS

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_MTD_01** | mtd.revenue = SUM(total_price) for DELIVERED-bons MTD | 1500 (LEV) + 3000 (FAKT) = 4500 (incl moms) |
| **T_DASH_MTD_02** | mtd.revenue_excl_moms = round2(revenue / 1.25) | 4500 / 1.25 = 3600 |
| **T_DASH_MTD_03** | mtd.vat_collected = revenue - revenue_excl_moms | 4500 - 3600 = 900 |
| **T_DASH_MTD_04** | mtd.units = SUM(total_units) for samme bons | 30 + 60 = 90 |
| **T_DASH_MTD_05** | mtd.open_bons tæller bons i OPEN_CODES | NY+VENTER+GODKENDT+IGANG+KLAR uanset dato |
| **T_DASH_MTD_06** | mtd.unfactured = SUM(total_price) for LEVERET status uanset dato | T_DASH_TODAY_LEV: 1500 |
| **T_DASH_MTD_07** | mtd.last_year_revenue = sum fra samme MTD-periode sidste år | T_DASH_LY: 2500 (incl moms) |
| **T_DASH_MTD_08** | Moms-felter er konsistente (§6c) | revenue_incl_moms = revenue, revenue_excl_moms ≈ revenue/1.25, vat_collected ≈ revenue × 0.2 |

### 4.7 GET /today — filter-konsistens (4)

Alle queries skal filtrere konsistent. Disse cases verificerer det.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_FILT_01** | T_DASH_TODAY_OFFER ekskluderet fra ALLE queries (totals, mtd, categories) | Konsistent |
| **T_DASH_FILT_02** | T_DASH_TODAY_INT inkluderet KUN i production_totals | bons-array har den (er på dagens delivery), totals/categories/mtd ekskluderer |
| **T_DASH_FILT_03** | T_DASH_TODAY_AFL ekskluderet alle steder undt. is_offer-tjek | NOT IN ('AFLYST')-klausul på alle queries |
| **T_DASH_FILT_04** | NULL is_offer/is_internal håndteres som 0 | `COALESCE(b.is_offer, 0) = 0` virker |

### 4.8 GET /stats (10)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_S_01** | GET /stats?days_back=7&days_forward=7 | 14 dage data |
| **T_DASH_S_02** | Default days_back=7, days_forward=7 hvis ikke angivet | Verificér |
| **T_DASH_S_03** | Max-cap days_back=60 | `Math.min(parseInt, 60)` |
| **T_DASH_S_04** | Negativ days_back | parseInt accepterer negativ — bør tjekkes. F-kandidat |
| **T_DASH_S_05** | bon-rows har required felter | id, bon_number, delivery_date, total_units, total_price, pax, price_category, customer_name |
| **T_DASH_S_06** | Last year data hentes (-364 dage) | T_DASH_LY skal være i ly-data hvis indenfor range |
| **T_DASH_S_07** | Smartplan shifts loadet (mock) | shifts_by_date populeret |
| **T_DASH_S_08** | Smartplan fejler graceful | Når mock kaster Error → response stadig 200, shifts_by_date er {} |
| **T_DASH_S_09** | Filter is_offer=0 AND is_internal=0 | Tilbud + internal ikke i bon-rows |
| **T_DASH_S_10** | Bons sorteret efter delivery_date, total_units ASC | Mindste bons først (legoklods-stacking) |

### 4.9 GET /top-products (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_TP_01** | GET /top-products uden params | Default: måneds-start til today |
| **T_DASH_TP_02** | GET ?from=2026-05-01&to=2026-05-13 | Filter på interval |
| **T_DASH_TP_03** | Limit 10 | Max 10 rows |
| **T_DASH_TP_04** | Sorteret efter total_enh DESC | Mest solgte først |
| **T_DASH_TP_05** | is_accessory=1 ekskluderet (T_DASH_TODAY_LEV line C) | Engangsservice IKKE i top |
| **T_DASH_TP_06** | Moms-decoration på hver row | total_kr_excl_moms, total_kr_incl_moms, vat_collected |
| **T_DASH_TP_07** | Bons med is_offer=1 ekskluderet | T_DASH_TODAY_OFFER's lines IKKE i sum |
| **T_DASH_TP_08** | total_kr beregning | qty × unit_price (server-side incl moms aggregeret) |

### 4.10 GET /weather — placeholder (3)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_W_01** | Uden DMI_API_KEY i env | response `{available: false, reason: 'DMI_API_KEY ikke sat i .env'}` |
| **T_DASH_W_02** | Med DMI_API_KEY men ikke implementeret | response `{available: false, reason: 'DMI integration ikke implementeret endnu'}` |
| **T_DASH_W_03** | response.available altid boolean | Aldrig undefined eller null — bare false |

### 4.11 MOMS-DISCIPLIN (§6c) — krydstjek (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_M_01** | mtd-objekt har bagudkomp + eksplicitte felter | Begge "revenue" (incl) OG "revenue_excl_moms"/"revenue_incl_moms" |
| **T_DASH_M_02** | top-products har samme 3-felts pattern | total_kr (bagudkomp), total_kr_excl_moms, total_kr_incl_moms, vat_collected |
| **T_DASH_M_03** | revenue_incl_moms = revenue (samme værdi) | Bagudkomp |
| **T_DASH_M_04** | last_year-felter har samme decoration | last_year_revenue_excl_moms + last_year_revenue_incl_moms |

### 4.12 EDGE_CASES (6)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_E_01** | DB uden bons | totals=0/0/0/0, alerts=[], mtd.revenue=0 (alle felter null-safe via COALESCE) |
| **T_DASH_E_02** | next_pickup når ingen fremtidige | null |
| **T_DASH_E_03** | tomorrow_prep med 0 bons | bon_count=0, all_*_ready=false |
| **T_DASH_E_04** | category=NULL i bon_lines | Ekskluderet via `category IS NOT NULL AND category != ''` |
| **T_DASH_E_05** | Bon uden customer og company | customer_name = " " (tomme felter joinet) — verificér mod faktisk null-håndtering |
| **T_DASH_E_06** | LY-data går over årsskifte | f.eks. test today=2026-01-15 → ly start = 2025-01 — verificér streng-aritmetik |

### 4.13 CLEANUP (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_DASH_CL_01** | Alle T_DASH_-bons slettet | Count = 0 |
| **T_DASH_CL_02** | CASCADE: bon_lines slettet | Count = 0 |
| **T_DASH_CL_03** | Smartplan mock-state ryddet | Tilbage til oprindelig tilstand |
| **T_DASH_CL_04** | Snapshot match | Pre-eksisterende uændret |

---

## 5. Konkret eksempel — T_DASH_MTD_02 (moms-decoration)

```
Setup:
- T_DASH_TODAY_LEV (LEVERET, today, total_price=1500 incl moms)
- T_DASH_MTD_DELIVERED (FAKTURERET, today-5, total_price=3000 incl moms)
- Begge har is_offer=0, is_internal=0

1. GET /api/dashboard/today
   → Server beregner:
       mtdDelivered.revenue = 1500 + 3000 = 4500
       revenue_excl_moms = r2(inclToExcl(4500)) = r2(4500/1.25) = 3600.00
       vat_collected = r2(momsOfIncl(4500)) = r2(4500 - 4500/1.25) = 900.00
       revenue_incl_moms = r2(4500) = 4500.00

2. ASSERT response.mtd:
   - revenue === 4500 (bagudkomp)
   - revenue_incl_moms === 4500.00
   - revenue_excl_moms === 3600.00
   - vat_collected === 900.00
   - revenue_incl_moms - revenue_excl_moms ≈ vat_collected (FLOAT_TOL)

3. CLEANUP: DELETE bons

PASS — hermetisk
```

---

## 6. Fejlsignaler

| Symptom | Sandsynlig årsag |
|---------|------------------|
| totals.bon_count inkluderer tilbud | `COALESCE(b.is_offer, 0) = 0`-filter mangler i query |
| production_totals inkluderer normale bons | `is_internal = 1`-filter mangler |
| top-products inkluderer accessories | `bl.is_accessory = 0`-filter mangler |
| mtd.revenue_excl_moms = revenue (ikke /1.25) | inclToExcl-helper ikke kaldt |
| Smartplan fejl crashes response | try/catch mangler — graceful degradation virker ikke |
| alerts mangler unread_mail | mail_messages-join forkert eller cnt=0 silent ignored |
| tomorrow_prep.all_ingredients_ready=true når tom | `tomorrowBons.length > 0` check mangler |
| stats endpoint sorterer ikke ASC på total_units | UI legoklods-chart bryder |
| LY-data null | _dateOffset(date, -364) returnerer forkert format eller dato-streng-aritmetik fejler |
| weather endpoint returnerer 500 | Manglende try/catch — bør altid være 200 med available:false |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_DASHBOARD.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_DASHBOARD.js` | Test-runner | 🔲 |
| `tests/scripts/helpers/smartplan_mock.js` | Smartplan-mock-helper | 🔲 (ny eller eksisterende) |

npm-script:
```json
"test:run-dashboard": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_DASHBOARD.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Filter-konsistens (`is_offer=0 AND is_internal=0`) på alle 4 endpoints | Brugeren ser samme tal på dashboard som i listview |
| MTD-beregning korrekt mod last year | YoY-sammenligning kan stoles på |
| Moms-decoration §6c konsistent (3-felt pattern overalt) | Bruger kan se ex/incl moms uden at gætte |
| Tomorrow prep aggregation virker | Køkkenet ved hvad der mangler |
| Alerts dækker prep/status/mail | Bruger gøres opmærksom på det vigtige |
| Smartplan og DMI graceful degradation | Dashboard fejler ikke hvis eksterne services er nede |
| Categories aggregation fra bon_lines virker | Klar visning af hvad der produceres i dag |
| Production_totals separat fra totals | Festival/intern produktion forplumrer ikke KPI'er |
| Top-products ekskluderer tilbehør | "Mest solgte" reflekterer faktisk salg, ikke gratis ekstras |

---

## 9. Næste skridt

| Track | Indhold |
|-------|---------|
| **T_CRM** | callbacks + call-log + companies + crm-dashboard. Stor scope |
| **T_CASHFLOW** | CSV-upload, faktura-CRUD, bank-matching. Admin-only |
| **T_V1_AFSTEMNING** | Weekenden ifølge plan |

---

## 10. Status — efter første kørsel

```
(genereres ved første kørsel)
```

---

## 11. Findings — afventer første kørsel

| # | Reference | Spørgsmål | Hvordan tjekkes |
|---|-----------|-----------|-----------------|
| **F75** | §4.4 (TP_01) | tomorrow_prep.bons-array har ikke total_price | UI behøver muligvis. Tjek om frontend bruger det |
| **F76** | §4.8 (S_04) | Negativ days_back accepteres af parseInt | Math.min med Math.max(0, ...) eller eksplicit validation |
| **F77** | §4.4 (AL_05) | unread_mail-alert tæller global, ikke per bon | Måske intentional — global "ulæste mails"-banner |
| **F78** | §4.6 (MTD_05) | mtd.open_bons inkluderer alle åbne uanset dato | Skulle det være MTD-scoped? Dokumentér adfærd |
| **F79** | §4.12 (E_05) | Bon uden customer OG company → customer_name = " " (mellemrum) | Mere graceful: null eller "Ukendt" |
| **F80** | §4.4 (AL_03) | T_DASH_TODAY_1 både NY og prep_missing → 2 alerts for samme bon | UI håndtering — er det ønskværdigt? |

---

*Oprettet: maj 2026 — syvende office-track. Dashboard er det første view
brugerne ser ved startup, derfor prioriteret korrekthed af tal og filtre.
F77-F80 er kandidater til mindre UX-fix-patch hvis nødvendige.*
