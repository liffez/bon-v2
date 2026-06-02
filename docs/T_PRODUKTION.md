# T_PRODUKTION — Testspor: produktionsbatch med afvigelse

> Forudsætter CLAUDE_PRODUKTION.md, bon_v2_datamodel_v2.md, BON_V2_PRINCIPPER.md.
> Slottes ind i jeres 11-sektions testskabelon. Findings = F1, F2… · globale = #NNN i TEST_OBSERVATIONS.md.
> Mål: fang **stille datafejl** (forkert lagertræk, forkert kostpris, dobbelttælling) — ikke kun UI.

---

## 1. Hvorfor dette spor — risiko-katalog

Det her er ikke kosmetik. Hver linje er en fejl der **ikke** giver fejlbesked, men forurener
lager eller food-cost over tid:

| # | Risiko | Konsekvens hvis ufanget |
|---|--------|-------------------------|
| R1 | Dobbelttælling (råvare trækkes både i batch og i bon) | Lager drifter negativt, indkøb forkert |
| R2 | Afvigelse routes til recipe-consume når en vare mangler | Hele trækket fejler tavst → batch ikke produceret |
| R3 | Produkt-pris = master, ikke faktisk | Food-cost i Grocy (og dermed `bon_lines.cost_price`) forkert |
| R4 | Yield ≠ faktisk | Produkt-lager forkert, planlægning skæv |
| R5 | Multi-kald afbrydes midtvejs | Halvt træk → lager i ukendt tilstand |
| R6 | Enheds-/QU-fejl (g vs kg) | Samme klasse som den kendte 28%-cost-bug |
| R7 | Dobbelt-submit | Dobbelt træk |
| R8 | Master-opskrift muteres | Bryder "rør aldrig originalen" |
| R9 | Skalering taber/forvrænger afvigelse | Forkerte mængder ved decimal-portioner |

---

## 2. Testarkitektur

To lag — hurtige logiktests + få, hårde integrationstests:

| Lag | Mod | Formål |
|-----|-----|--------|
| **Unit** | mocket `grocyAdapter` | Diff, skalering, kost, **vej-valg** (diff=0 → recipe-consume; diff>0 → manuel), payload-bygning. Assert eksakte kald + argumenter. |
| **Integration** | `grocytest` (Test-lokation) | Reelt consume/add, læs lager + pris + transaktions-journal tilbage. Reversering. Dobbelttælling på tværs af batch→produkt→bon. |

**Hermetisk:** test-opskrifter/produkter/batches får prefiks `ZZT_` (som test-bonner). Teardown
sletter alt med prefiks i `grocytest` + ruller `production_batches`/`_consumption` tilbage.
Integrationstests kører **kun** mod `grocytest` — aldrig hq/trailer (assertér `location.code==='test'`).

---

## 3. Fixtures

```
ZZT_MELLEMPRODUKT   Grocy-produkt, QU stock = g
ZZT_PRODOPSKRIFT    RR Produktion-opskrift, Produces product = ZZT_MELLEMPRODUKT, yield 1000 g/portion
   ingredienser: ZZT_RAW_A 250 g, ZZT_RAW_B 65 ml, ZZT_KRYDDERI 12 g
ZZT_SUBST           substitut-produkt til byt-test
ZZT_MENU            menu-opskrift der forbruger ZZT_MELLEMPRODUKT (til dobbelttællings-test)
```
Kostpriser sættes kendt og ex-moms, så forventet beløb kan beregnes præcist.

---

## 4. Testtilfælde

### A — Vej-valg (R2)
| ID | Handling | Forventet |
|----|----------|-----------|
| P1 | Producér med diff=0 | Præcis ét kald: `POST /recipes/{id}/consume`. Ingen manuelle consume/add. |
| P2 | Producér med diff>0 | **Ingen** recipe-consume. Kun `/stock/.../consume` pr. linje + ét `/stock/.../add`. |
| P3 | Substitution hvor master-vare = 0 på lager | Vej = manuel. Den manglende vare **konsumeres ikke**. Intet kald fejler. |
| P4 | Forsøg begge veje på samme batch (regression-vagt) | Umuligt — assert at koden aldrig kalder både recipe-consume og manuel for samme batch. |

### B — Stock-effekt & dobbelttælling (R1)
| ID | Handling | Forventet |
|----|----------|-----------|
| P5 | Normal produktion, 1 portion | RAW_A −250 g, RAW_B −65 ml, KRYDDERI −12 g; MELLEMPRODUKT +1000 g (self-production) |
| P6 | Bon forbruger derefter MELLEMPRODUKT | Kun MELLEMPRODUKT falder. RAW_A/B/KRYDDERI **uændret** (ingen dobbelttælling) |
| P7 | Edit-produktion: +30 g RAW_A | RAW_A −280 g (ikke −250) |
| P8 | Edit: RAW_B udeladt (0) | RAW_B uændret; ingen consume-kald for RAW_B |
| P9 | Edit: byt RAW_A → ZZT_SUBST 250 g | RAW_A uændret (0-kald), ZZT_SUBST −250 g |

### C — Kostpris (R3)
| ID | Handling | Forventet |
|----|----------|-----------|
| P10 | Normal: produkt-pris | = Grocys auto-beregning fra master (ingen `price` sendt) |
| P11 | Edit m. dyrere substitut: produkt-pris | `price` = (Σ actual_qty×enhedskost) / yield, ex-moms |
| P12 | Bon's `cost_price` efter P11 | Læser den **faktiske** produkt-pris fra Grocy (ingen split-brain) |
| P13 | Moms-basis | Alle priser sendt til Grocy er ex-moms |

### D — Yield (R4)
| ID | Handling | Forventet |
|----|----------|-----------|
| P14 | Faktisk udbytte 870 g (stegesvind) | MELLEMPRODUKT +870 (ikke +1000) |
| P15 | `production_batches` | planned_output_qty=1000, actual_output_qty=870 gemt |

### E — Reversering (R5-tilbageførsel)
| ID | Handling | Forventet |
|----|----------|-----------|
| P16 | Reverse normal batch | Lager nøjagtig som før (raws tilbage, produkt fjernet) |
| P17 | Reverse **afveget** batch (P7/P9) | Tilbagefører de **faktiske** mængder via gemte `grocy_transaction_id` — ikke master |
| P18 | Reverse uden gemt transaction-id | Fejler kontrolleret + logger; ingen blind gætte-tilbageførsel |

### F — Skalering (R9)
| ID | Handling | Forventet |
|----|----------|-----------|
| P19 | +30 g RAW_A ved 1 portion → sæt 1,3 portion | RAW_A actual = (250+30)×1,3 = 364 g; afvigelse bevaret |
| P20 | Udeladt vare + skalér | Forbliver 0 |
| P21 | Decimal-parse "1,3" og "1.3" | Begge = 1,3 |
| P22 | Skalér frem og tilbage (1→2→1) | Ingen rundingsdrift > 0,01 |

### G — Atomicitet & idempotens (R5, R7)
| ID | Handling | Forventet |
|----|----------|-----------|
| P23 | Simulér fejl på consume-kald #2 af 3 | Enten rollback af #1, **eller** batch markeres `partial` med præcis log over hvad der nåede igennem — aldrig tavst halvt træk |
| P24 | Dobbelt-submit (to hurtige kald) | Kun ét træk. Idempotens-vagt (fx batch-id/nonce) |
| P25 | Toggle frem/tilbage før produktion | Data uændret (ingen utilsigtet nulstilling) |

### H — Enheder/QU (R6)
| ID | Handling | Forventet |
|----|----------|-----------|
| P26 | Opskrift i g, Grocy-stock i kg | Mængde konverteres korrekt før consume (250 g → 0,25 kg) |
| P27 | ml/l og stk-varer | Korrekt QU-konvertering pr. vare |

### I — Immutabilitet (R8)
| ID | Handling | Forventet |
|----|----------|-----------|
| P28 | Kør alle veje, snapshot master-opskrift før/efter | Identisk. Ingen PUT/PATCH mod recipe-ingredienser |

### J — Consumption-log integritet
| ID | Handling | Forventet |
|----|----------|-----------|
| P29 | Hver Grocy-transaktion → én `production_batch_consumption`-række | grocy_transaction_id, planned_qty, actual_qty, deviation_reason, unit_cost udfyldt |
| P30 | Byt-par | original-linje (actual 0, reason=byttet) + substitut-linje (substitute_for_product_id sat) |

---

## 5. Findings & observations

- Lokale fund i sporet: **F1, F2…** med ID, forventet vs faktisk, mistænkt fil/linje.
- Globale/systemiske: **#NNN** i `TEST_OBSERVATIONS.md`.
- Knyt hver fundet fejl til risiko-id (R1–R9) så dækningen kan revideres.

## 6. Workflow

```
læs source (services/route_planner-ækvivalent: produktion-rute + grocyAdapter)
  → denne spec
  → runner (unit først, så grocytest-integration)
  → rapport (P1–P30 pass/fail)
  → findings (F#, #NNN)
  → patch
  → regression: hele sporet grønt + de tidligere grønne forbliver grønne
```

## 7. Exit-kriterier

- P1–P30 grønne.
- 0 åbne findings på R1, R3, R5, R6 (de tavse data-ødelæggere) — disse er **blokerende** for go-live.
- `inventory_auto_deduct`-interaktion verificeret separat hvis batch-produktion kobles til auto-deduct.
