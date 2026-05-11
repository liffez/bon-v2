# T_GROCY — Test-spec for Grocy-adapter

> Verificerer at `services/grocyAdapter.js` læser korrekt fra Grocy
> (read-only) og at `services/ingredientResolver.js` beregner consume-mængder
> korrekt uden side-effekter.
>
> Skrive-operationer (consume + tilbageføring) udskydes — de kræver
> state-management for at undgå at gøre grocytest beskidt.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | READ-funktioner i grocyAdapter, ingredientResolver-helpers, cache |
| **Hvad testes IKKE i Fase 1** | `consumeRecipes` med rigtige stock-skrivninger (kommer senere når vi har isoleret test-stock) |
| **Forudsætninger** | grocytest.ristetrug.dk er oppe og har data (gjort maj 2026) |

---

## 2. Test-cases

### 2.1 Read-funktioner

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_GROCY_R_01** | `getRecipes()` returnerer ≥ 1 recipe | `length > 0` |
| **T_GROCY_R_02** | Hver recipe har required fields | id, name, category, unit, unit_number, prices, cost_price |
| **T_GROCY_R_03** | `getProducts()` returnerer ≥ 1 produkt | `length > 0` |
| **T_GROCY_R_04** | `getStock()` returnerer en array | `Array.isArray(stock)` |
| **T_GROCY_R_05** | `getQuantityUnits()` returnerer enheder | `length > 0`, hver har name + id |
| **T_GROCY_R_06** | `getRecipeIngredients(88)` (Kyllingen) returnerer 5 ingredienser | matcher snapshot |
| **T_GROCY_R_07** | `getRecipeNestings()` returnerer en array (kan være tom) | `Array.isArray()` |
| **T_GROCY_R_08** | `getAllRecipesPos()` returnerer alle ingrediens-rækker | `length > 0` |

### 2.2 Cache

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_GROCY_C_01** | Andet kald til `getRecipes()` er hurtigere end første | t2 < t1 / 2 |
| **T_GROCY_C_02** | `clearCache()` tvinger ny fetch | t3 > t2 (genaccessen er langsom igen) |

### 2.3 Ingredient resolver

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_GROCY_IR_01** | `resolveIngredients` på en bon-id returnerer production + raw blokke | begge eksisterer i response |
| **T_GROCY_IR_02** | Skalering virker — 2x quantity giver 2x mængder | proportional |
| **T_GROCY_IR_03** | `resolveConsumeItems` returnerer per-produkt mængder | array af `{product_id, amount_stock, ...}` |
| **T_GROCY_IR_04** | Linjer uden grocy_recipe_id ekskluderes fra consume | filtreret væk |

### 2.4 Skrive-operationer

| ID | Formål | Status |
|----|--------|--------|
| **T_GROCY_W_01** | `consumeRecipes` reducerer Grocy stock | **SKIP** → erstattet af [T_INVENTORY](T_INVENTORY.md) |
| **T_GROCY_W_02** | LEVERET → IGANG tilbagefører stock | **SKIP** → erstattet af [T_INVENTORY](T_INVENTORY.md) (T_INV_REVERT_01/02) |

Skrive-flowet testes nu kontrakt-baseret af T_INVENTORY mod live Grocy med snapshot/diff/restore.
T_GROCY behøver derfor kun teste read-siden af adapteren.

---

## 3. Filer der skal eksistere

| Fil | Status |
|-----|--------|
| `tests/specs/T_GROCY.md` | ✅ |
| `tests/scripts/run_T_GROCY.js` | ✅ |
| `tests/reports/T_GROCY_YYYY-MM-DD.md` | 🔲 |

---

## 4. Bugs/findings via T_GROCY

| Finding | Note |
|---------|------|
| Spec-rettelse | T_GROCY_R_02 brugte forkerte feltnavne (`base_servings` i stedet for `unit_number`/`prices`) — `getRecipes()` flat'er Grocy raw til simplere shape |
| Spec-rettelse | T_GROCY_IR_02 brugte `amount` — feltet hedder faktisk `amount_needed` (raw-niveau) eller `amount_stock` (consume) |

Ingen kode-bugs fundet i grocyAdapter eller ingredientResolver — begge fungerer korrekt
mod live Grocy.

---

## 5. Status — første kørsel maj 2026

```
14 PASS · 0 FAIL · 2 SKIP

R    8/8   ✓  (recipes, products, stock, qu, ingredients, nestings, pos)
C    2/2   ✓  (cache speedup + clearCache)
IR   4/4   ✓  (resolveIngredients + resolveConsumeItems)
W    0/2   ⊘  (consumeRecipes-write-tests udskudt)
```

T_GROCY-tracken er **funktionelt færdig** for Fase 1. Skrive-tests (`consumeRecipes`)
er parkeret indtil vi har isoleret test-stock-strategi.

---

## 6. Køreflow

```bash
npm run test:reset       # frisk DB
npm run test:patch       # opdater grocy_recipe_id på bon_lines (kræver snapshot)
npm run test:run-grocy   # kør tests (ingen test:server nødvendig)
```

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
