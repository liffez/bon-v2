# T_ECON — Test-spec for økonomi pr. bon

> Verificerer moms-doktrin (§6b i `BON_V2_PRINCIPPER.md`) og at
> per-bon-totaler er regnet konsistent.
>
> Komplementært til T_PLAN's uge-niveau-tests — T_ECON tester enkelt-bon-niveau.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Per-bon `total_price` = SUM(line_total), per-linje `line_total` = quantity × unit_price, moms-doktrin |
| **Hvad testes IKKE** | Aggregering på tværs af bonner (T_PLAN). UI-visning af pris (Playwright senere) |
| **Forudsætninger** | T_DB grøn. Test.db seedet med seed_planning |

---

## 2. Moms-doktrin (autoritativ — fra BON_V2_PRINCIPPER.md §6b)

| Felt | Konvention |
|------|-----------|
| `bon_lines.unit_price` | **INCL** moms (snapshot fra Grocy salgspris) |
| `bon_lines.cost_price` | **EX** moms |
| `bon_lines.line_total` | quantity × unit_price → **INCL** moms |
| `bons.total_price` | SUM(line_total) → **INCL** moms |
| Moms-andel | `total_price × 0.2` (= total_incl × 25/125) |

---

## 3. Test-cases

### 3.1 Per-bon konsistens

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_ECON_BON_01** | Alle 8 bonner: `total_price = SUM(line_total)` | diff < 0.01 for alle |
| **T_ECON_BON_02** | Alle 8 bonner: `total_units = SUM(quantity)` | matcher for alle |
| **T_ECON_BON_03** | Hver bon-linje: `line_total = quantity × unit_price` | diff < 0.01 for alle 30 linjer |

### 3.2 Moms-beregning (per bon)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_ECON_MOMS_01** | Bon 4001 incl moms = 5237,50 | matcher seed |
| **T_ECON_MOMS_02** | Bon 4001 ex moms = 5237,50 / 1,25 = 4190,00 | beregnet |
| **T_ECON_MOMS_03** | Bon 4001 moms-andel = 5237,50 × 0,2 = 1047,50 | beregnet |
| **T_ECON_MOMS_04** | Sum af alle bon-momser stemmer pr. uge (S4) | sum_incl × 0,2 = sum_moms |

### 3.3 Cost vs. Revenue (margin)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_ECON_MGN_01** | Bon 4001: revenue_ex = 4190,00, cost_ex = 1334,00, margin% ≈ 68,2 | matcher T_PLAN §7.1 |
| **T_ECON_MGN_02** | DB% korrekt på alle bonner | (rev_ex - cost_ex) / rev_ex × 100, > 0 for alle |

### 3.4 Snapshot-natur (cost_price er ex moms)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_ECON_SNAP_01** | Falaflen i seed: unit_price=104 (incl), cost_price=25 (ex) | margin på linje = (104/1.25 - 25) / (104/1.25) ≈ 70% |
| **T_ECON_SNAP_02** | RR Boks (emballage): unit_price=0, cost_price=1.50 | linjer findes i alle bonner med disse værdier |

---

## 4. Filer der skal eksistere

| Fil | Status |
|-----|--------|
| `tests/specs/T_ECON.md` | ✅ |
| `tests/scripts/run_T_ECON.js` | ✅ |
| `tests/reports/T_ECON_YYYY-MM-DD.md` | ✅ |

---

## 5. Status — første kørsel maj 2026

```
14 PASS · 0 FAIL · 0 SKIP

BON   3/3   ✓  (total_price = SUM(line_total), total_units = SUM(quantity), line_total = qty × unit_price)
MOMS  5/5   ✓  (incl, ex, moms-andel, S4 sum)
MGN   3/3   ✓  (rev_ex, cost_ex, margin% — bon 4001 + alle bonner positiv margin)
SNAP  2/2   ✓  (Falaflen, RR Boks unit_price/cost_price snapshot-konsistente)
```

T_ECON-tracken er **færdig** for Fase 1. Moms-doktrin §6b overholdes på alle 8 seed-bonner.

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
