# T_KITCHEN_TODAY — Test-spec for I dag-viewets backend

> Verificerer at `/api/bons/today` returnerer korrekte bonner og at status/prep/
> kitchen-info-PATCH virker for I dag-viewet's flow (PREP → KLAR → LEVERET).
>
> UI-tests (Playwright på today.html) udskydes — skrives når flow er stable.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Backend `/api/bons/today`, prep-toggle, kitchen-info-edit, status-flow til LEVERET + fortryd |
| **Hvad testes IKKE** | UI: filter-bar, KIOSK-mode, leveret-fading (Playwright senere) |
| **Forudsætninger** | T_BON og T_INPUT grøn. Test-server kører |

---

## 2. Setup-flow

`/today`-endpoint filtrerer på `b.delivery_date = CURRENT_DATE`. Seed-bonnerne er på
2026-05-11 til 15. Runneren UPDATE'r derfor bon 4006 (GODKENDT) midlertidigt til
i dag, kører tests, og restorerer ved cleanup.

```javascript
// Setup
UPDATE bons SET delivery_date = TODAY WHERE id = 4006;

// Tests kører...

// Cleanup
UPDATE bons SET delivery_date = '2026-05-14' WHERE id = 4006;
```

---

## 3. Test-cases

### 3.1 GET /api/bons/today

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_KT_GET_01** | Default-filter returnerer GODKENDT/IGANG/KLAR/LEVERET | bon 4006 (GODKENDT) i resultat |
| **T_KT_GET_02** | Hver bon har lines-array | bon.lines.length > 0 |
| **T_KT_GET_03** | VENTER ekskluderet i default | hvis vi sætter en bon til VENTER + today, vises den IKKE |

### 3.2 PATCH /api/bons/:id/prep

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_KT_PREP_01** | Toggle ingredients_ready til 1 | DB: prep_ingredients_ready=1, changelog skrives |
| **T_KT_PREP_02** | Toggle supplies_ready til 1 | DB: prep_supplies_ready=1, changelog skrives |
| **T_KT_PREP_03** | Toggle ingredients_ready til 0 | DB: prep_ingredients_ready=0 |

### 3.3 PATCH /api/bons/:id/kitchen-info

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_KT_KI_01** | Sæt kitchen_info tekst | DB: kitchen_info = 'Test note' |
| **T_KT_KI_02** | Ryd kitchen_info (sæt til null/tom) | DB: kitchen_info = null eller '' |

### 3.4 Status-flow GODKENDT → IGANG → KLAR → LEVERET → IGANG (fortryd)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_KT_STAT_01** | GODKENDT → IGANG | 200, status_code='IGANG' |
| **T_KT_STAT_02** | IGANG → KLAR | 200, status_code='KLAR' |
| **T_KT_STAT_03** | KLAR → LEVERET | 200, status_code='LEVERET' |
| **T_KT_STAT_04** | LEVERET → IGANG (fortryd) | 200, status_code='IGANG' |

### 3.5 AFLYST forsvinder fra /today

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_KT_AFL_01** | Bon AFLYST forsvinder fra /today | GET /today returnerer ikke bonen efter status=AFLYST |

---

## 4. Filer der skal eksistere

| Fil | Status |
|-----|--------|
| `tests/specs/T_KITCHEN_TODAY.md` | ✅ |
| `tests/scripts/run_T_KITCHEN_TODAY.js` | ✅ |
| `tests/reports/T_KITCHEN_TODAY_YYYY-MM-DD.md` | ✅ |

---

## 5. Status — første kørsel maj 2026

```
13 PASS · 0 FAIL · 0 SKIP

GET   3/3   ✓  (default-filter inkluderer GODKENDT, lines udfyldt, VENTER ekskluderet)
PREP  3/3   ✓  (ingredients_ready/supplies_ready toggle 0↔1)
KI    2/2   ✓  (kitchen_info sæt + ryd)
STAT  4/4   ✓  (GODKENDT → IGANG → KLAR → LEVERET → IGANG fortryd)
AFL   1/1   ✓  (AFLYST forsvinder fra /today)
```

T_KITCHEN_TODAY-tracken er **færdig** for Fase 1. Runneren restorerer bon 4006's
oprindelige tilstand i `cleanup()` så seed forbliver konsistent.

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
