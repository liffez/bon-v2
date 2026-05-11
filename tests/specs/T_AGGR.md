# T_AGGR — Optællings-konsistens på tværs af views

> Verificerer at samme bon-set producerer samme tal på alle endpoints der
> aggregerer pr. dag (kalender, planlægning, ugeoversigt).
>
> Fanger den klassiske bug hvor flere views udvikles parallelt og divergerer
> i deres dato/status-filtrering.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Konsistens mellem `/api/bons/calendar`, `/api/bons/planning`, `/api/schedule/week` for samme datointerval |
| **Hvad testes IKKE** | Dashboard `today` (bruger CURRENT_DATE — kan ikke pege på 11/5/2026) — dækkes evt. i T_KITCHEN_TODAY |
| **Forudsætninger** | T_BON og T_PLAN grøn. Test-server kører |

---

## 2. Kendte design-forskelle (forventet, ikke bug)

De tre endpoints har **forskellig** default-håndtering af tilbud (`is_offer=1`):

| Endpoint | Default-status-filter | Tilbud-håndtering |
|----------|-----------------------|-------------------|
| `/api/bons/calendar` | Ingen (alle statusser) | Tilbud tælles **separat** i `totals.offers`, ikke i `units`/`pax` |
| `/api/bons/planning` | `[GODKENDT,IGANG,KLAR,LEVERET]` | Tilbud (is_offer=1) **OR'es altid ind** uanset status-filter |
| `/api/schedule/week` | Alle ekskl. AFLYST | Tilbud (is_offer=1) **ekskluderes altid** |

T_AGGR sammenligner derfor kun **non-offer-bonner** med eksplicitte status-filtre.
Tilbuds-håndtering testes separat (T_AGGR_OFFER_*).

---

## 3. Test-strategi

For en given dato + status-filter, hent fra alle tre endpoints og verificer:
- Samme bon-IDs returneres
- Sum af `total_units` matcher
- Sum af `pax` matcher (hvor relevant)

### 3.1 Konsistens-tests (kerne)

| ID | Setup | Forventet |
|----|-------|-----------|
| **T_AGGR_C_01** | Status=LEVERET 11/5 | calendar.units(11/5) = sum(planning.lines.qty) = sum(schedule.units) = **103** |
| **T_AGGR_C_02** | Status=KLAR 12/5 | Alle tre giver bon 4003, 103 enheder |
| **T_AGGR_C_03** | Status=IGANG 13/5 | Alle tre giver bon 4005, 134 enheder |
| **T_AGGR_C_04** | Status=GODKENDT 14/5 | Alle tre giver bon 4006, 47 enheder |
| **T_AGGR_C_05** | Status=GODKENDT,IGANG,KLAR,LEVERET hele ugen | Calendar+schedule giver 4 bons (4001,4003,4005,4006), 387 enheder. Planning giver 5 (+ 4008) |

### 3.2 Tilbuds-håndtering (verificerer dokumenteret design-forskel)

| ID | Setup | Forventet |
|----|-------|-----------|
| **T_AGGR_OFF_01** | Calendar 14/5 | totals.offers = 1 (4008), totals.units = 47 (4006), totals.count = 1 |
| **T_AGGR_OFF_02** | Planning 14/5 status=GODKENDT | Returnerer 4006 + 4008 (tilbud OR'es ind) |
| **T_AGGR_OFF_03** | Schedule/week 14/5 | Returnerer kun 4006 (tilbud ekskluderes) |

### 3.3 AFLYST-håndtering (verificerer at AFLYST ekskluderes konsistent)

| ID | Setup | Forventet |
|----|-------|-----------|
| **T_AGGR_AFL_01** | Calendar 12/5 (uden status-filter) | bonner: 4003 + 4004, units: 103, offers: 0. Bemærk: AFLYST inkluderet uden filter |
| **T_AGGR_AFL_02** | Planning 12/5 status=AFLYST | Returnerer 4004 (+ 4008 fra OR is_offer) |
| **T_AGGR_AFL_03** | Schedule/week 12/5 default | 4003 (4004 ekskluderet via != 'AFLYST', 4008 ekskluderet via is_offer=0) |

---

## 4. Filer der skal eksistere

| Fil | Status |
|-----|--------|
| `tests/specs/T_AGGR.md` | ✅ |
| `tests/scripts/run_T_AGGR.js` | ✅ |
| `tests/reports/T_AGGR_YYYY-MM-DD.md` | ✅ |

---

## 5. Findings via T_AGGR

| Note | Detalje |
|------|---------|
| Auth-flow i runneren | `/api/schedule/week` kræver login. Runneren opretter automatisk en test-admin (`taggr@test.local`) i test.db første gang og bruger session-cookie til alle requests |
| Schedule-response shape | `body.week.days` er en **array** med `date`-felt, ikke en map nøgle med dato-strings (i modsætning til calendar) |

Ingen kode-bugs fundet. De tre endpoints regner non-offer-bonner ens for samme
dato + status-filter — den dokumenterede design-forskel for tilbud holder.

---

## 6. Status — første kørsel maj 2026

```
24 PASS · 0 FAIL · 0 SKIP

C    16/16  ✓  (4 dage × 4 endpoints/asserts: calendar/planning/schedule)
OFF  3/3    ✓  (tilbud håndteres som dokumenteret design pr. endpoint)
AFL  3/3    ✓  (AFLYST håndteres som dokumenteret design pr. endpoint)
```

T_AGGR-tracken er **funktionelt færdig** for Fase 1.

---

## 7. Køreflow

```bash
npm run test:reset          # frisk DB
npm run test:server &       # port 4322
npm run test:run-aggr       # tester konsistens
```

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
