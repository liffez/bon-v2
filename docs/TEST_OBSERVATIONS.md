# TEST_OBSERVATIONS.md — Observationer fra T_*-tracks

> Samling af små finds, uklarheder og adfærd der ikke er bugs men værd at huske —
> potentielle UI-forbedringer, adapter-justeringer, eller bare "godt-at-vide"-noter.
>
> Hver entry refererer til testen der opdagede det. Ingen action er forpligtende —
> det er en backlog af kandidater til separate PRs.

---

## Format

Hver observation har:
- **ID** — unikt, fortløbende (#001, #002 ...)
- **Kilde** — hvilken test-case observerede det
- **Beskrivelse** — hvad sker der
- **Vurdering** — er det et problem, og hvor stort
- **Foreslået action** — hvad kunne man gøre (hvis noget)
- **Status** — `åben` / `lukket` / `bevidst-accepteret`

---

## Observations

### #001 — Grocy returnerer `null` for både tom og null PUT på userfield

| | |
|--|--|
| **Kilde** | `T_STOCK_UF_04` (11. maj 2026) |
| **Beskrivelse** | `PUT /api/grocy/products/:id/userfields { HverDag: '' }` og `PUT { HverDag: null }` returnerer begge HTTP 200. Efterfølgende GET viser `HverDag: null` i begge tilfælde. Grocy lagrer internt som NULL og normaliserer tom-streng til null på output. |
| **Vurdering** | Ikke et problem — `_icParseIntervalDays` håndterer korrekt både `null`/`undefined`/`''` som "ikke sat". Værd at huske ved rollback-logik. |
| **Foreslået action** | Ingen. Dokumentér i T_STOCK-specen (gjort). |
| **Status** | `bevidst-accepteret` |

### #002 — `DELETE /api/grocy/recipes-pos/<ghost-id>` returnerer 500 ikke 404

| | |
|--|--|
| **Kilde** | `T_RECIPES_POS_04` (11. maj 2026) |
| **Beskrivelse** | DELETE mod en ikke-eksisterende `recipes_pos`-id (fx `999999999`) returnerer status 500 i stedet for forventet 404. Vores adapter `grocyDelete()` propagerer Grocy's interne 500-svar uden mapping. |
| **Vurdering** | Lav prioritet. Brugere rammer aldrig dette i UI'en (UI viser kun eksisterende positioner). Men hvis vi nogensinde bygger batch-delete eller cleanup-værktøjer, vil fejlmeddelelsen være misvisende. |
| **Foreslået action** | Hvis nogen alligevel rører `services/grocyAdapter.js:grocyDelete`, kunne man map'e 500'er der indeholder "not found"-tekst til 404 før vi propagerer. |
| **Status** | `åben` (lavt prioritet) |

### #003 — Grocy cascade'r IKKE `recipes_pos` ved recipe-delete

| | |
|--|--|
| **Kilde** | `T_RECIPES_CASCADE_01` (11. maj 2026) |
| **Beskrivelse** | Når man sletter en opskrift via direkte `DELETE /objects/recipes/:id` mod Grocy, bliver dens `recipes_pos`-rækker (ingredienser) IKKE slettet automatisk. De hænger som orphans med `recipe_id` pegende på den slettede opskrift. |
| **Vurdering** | **Medium prioritet.** Reelle konsekvenser: (a) `GET /api/grocy/recipes-pos/all` returnerer orphans, (b) `ingredientResolver` kunne potentielt fejle hvis den får serveret en orphan-position, (c) data-volumen vokser monotont. |
| **Foreslået action** | To muligheder: <br>**(i)** UI-advarsel før recipe-delete der lister positioner der vil blive forældreløse + tilbyder "slet alt"-toggle. <br>**(ii)** Backend: tilføj `deleteRecipe()` til adapteren der manuelt cascade'r (slet pos+nestings før selve recipe-delete). Det er den rigtige vej hvis vi nogensinde laver UI-recipe-delete. |
| **Status** | `åben` (medium prioritet — relevant før recipe-delete UI bygges) |

### #004 — Grocy cascade'r IKKE `recipes_nestings` ved recipe-delete

| | |
|--|--|
| **Kilde** | `T_RECIPES_CASCADE_02` (11. maj 2026) |
| **Beskrivelse** | Når man sletter en opskrift der enten ER parent ELLER child i en nesting-relation, bliver `recipes_nestings`-rækken IKKE slettet automatisk. Den hænger som orphan med `recipe_id` (eller `includes_recipe_id`) pegende på den slettede opskrift. |
| **Vurdering** | **Medium prioritet.** Samme bekymring som #003 — orphans i `recipes_nestings` kan forvirre `getRecipeNestings()` og dermed ingrediens-opløsningen i kitchen-views. Hvis en opskrift "forsvinder" fra menuen, mens en parent stadig peger på den via nesting, vil mengdeberegninger fejle. |
| **Foreslået action** | Samme som #003 — manuel cascade i en evt. ny `deleteRecipe()`-adapter-funktion, eller UI-advarsel der lister berørte parent-/child-relationer. |
| **Status** | `åben` (medium prioritet — relevant før recipe-delete UI bygges) |

### #005 — Force-mode dokumenteret i CLAUDE.md men IKKE implementeret

| | |
|--|--|
| **Kilde** | `T_BON_API_FORCE_01` (Fase 1, maj 2026) |
| **Beskrivelse** | CLAUDE.md siger: "Med `force: true` kan admin sætte hvilken som helst status". Men `routes/bons.js:316-338` validerer altid mod `status_transitions`-tabellen uden at tjekke `force`-parameteren. T_BON_API_FORCE_01 er derfor SKIP i T_BON. |
| **Vurdering** | Dokumentations-gap. Lav prioritet: admin kan altid lave UPDATE direkte i DB. T_BON_API_FORCE_01 vipper automatisk til PASS hvis feature implementeres. |
| **Foreslået action** | To muligheder: **(a)** implementér `force`-tjek (kræver rolle-check mod `users.role='admin'`), eller **(b)** fjern force-mode-omtalen fra CLAUDE.md. |
| **Status** | `åben` (parkeret indtil konkret behov) |

### #006 — AFLYST kan ikke nås fra terminal-statusser

| | |
|--|--|
| **Kilde** | `T_BON` status-transitions-test (Fase 1, maj 2026) |
| **Beskrivelse** | `status_transitions`-tabellen tillader AFLYST fra TILBUD/NY/VENTER/GODKENDT/IGANG/KLAR/LEVERET, men IKKE fra FAKTURERET/BETALT/AFSLUTTET. Det betyder en faktureret bon ikke kan annulleres via UI — kun via DB-UPDATE eller force-mode (som ikke virker, jf. #005). |
| **Vurdering** | Sandsynligvis bevidst (terminal = endelig), men værd at bekræfte. Hvis en faktureret bon skal annulleres (fx kreditnota-flow), er der ingen UI-vej. |
| **Foreslået action** | Bekræft med Leif at det er bevidst → dokumentér i CLAUDE.md. Eller tilføj transitions FAKTURERET/BETALT/AFSLUTTET → AFLYST som admin-only. |
| **Status** | `åben` (behøver beslutning, ikke action) |

### #007 — Tilbuds-toggle i planlægning er kun localStorage — ingen synlig UI

| | |
|--|--|
| **Kilde** | `T_PLAN_AGG_05` SKIP (Fase 1, maj 2026) |
| **Beskrivelse** | `shared/planning.js` har en `_plShowOffers`-toggle der bestemmer om tilbud (`is_offer=1`) vises i planlægningsbonnen. Toggle læses fra `localStorage.planning_show_offers` men der er ingen synlig UI-knap eller checkbox til at skifte den. Brugere skal manuelt sætte localStorage for at se tilbud i planlægning. |
| **Vurdering** | UX-gap. Lav prioritet (kun køkkenet rører planlægning og de bruger sjældent tilbudsvisning), men teknisk gæld der vokser. |
| **Foreslået action** | Tilføj en lille toggle ved siden af status-filtrene i `shared/planning.js`, eller fjern feature helt hvis ingen bruger den. |
| **Status** | `åben` (lav prioritet) |

### #008 — Frikadellen-Slider mangler på grocytest

| | |
|--|--|
| **Kilde** | `T_PLAN` ING-tests + T_INVENTORY parent-substitution-fix (Fase 1, maj 2026) |
| **Beskrivelse** | `Frikadellen-Slider` bruges på bons 4002 + 4007 i seed, men findes ikke som opskrift på grocytest. T_PLAN's `lines_without_recipe`-rapport fanger den. T_INVENTORY parent-substitution-fix gjorde at `consumeRecipes` på 4007 alligevel virker (sub-recipes 9/12/80 trækkes via substitution), men selve recipe-resolving er afhængig af, at den ikke er der. |
| **Vurdering** | Testdata-issue. Hvis Frikadellen-Slider tilføjes til grocytest senere, skal `TEST_PRODUCTS` i `snapshot_grocy.js` opdateres med faktisk `grocyName`. |
| **Foreslået action** | Opret Frikadellen-Slider på grocytest (én gang), eller acceptér at det blot ekskluderes fra ING-tests permanent. |
| **Status** | `åben` (lav prioritet) |

### #009 — Sub-recipes 9/12/80 ikke individuelt testet via T_INVENTORY

| | |
|--|--|
| **Kilde** | T_INVENTORY parent-substitution-fix (Fase 1, maj 2026) — noteret i `docs/CLAUDE_TESTPLAN.md` §11 |
| **Beskrivelse** | T_INVENTORY's parent-substitution-fix dækker tilfældet hvor consume mod en parent-product (fx kål) substituerer fra child-products (Hvidkål/Spidskål). Det virker for Frikadellen-Slider via underopskrifter 9/12/80, men de specifikke sub-recipes er aldrig individuelt testet. Hvis Grocy ændrer substitution-adfærd, vil testen falde igennem fordi alt aggregeres på family-niveau. |
| **Vurdering** | Test-dækkelse-gap. Lav prioritet — parent-substitution er stabil i Grocy. |
| **Foreslået action** | Hvis vi ser fejl i Frikadellen-Slider-flowet senere: tilføj specifik unit-test mod recipe 53's sub-recipes (9/12/80) i T_RECIPES eller en ny T_RESOLVER-track. |
| **Status** | `åben` (lav prioritet) |

### #010 — Brød Rug (pid=1) havde forkert QU-konvertering "1 Kasse = 10.8 Kilo"

| | |
|--|--|
| **Kilde** | T_INDKOB_ADMIN-design F12 (maj 2026) |
| **Beskrivelse** | Grocy QU-konverteringerne for pid=1 (Brød Rug) sagde `Kasse → Kilo = 10.8` og `Kilo → Kasse = 0.0926`. Korrekt er 7.68 / 0.1302 (= 64 × 0.12 kg pr. kasse). Værdien 10.8 stammede fra Bon v1-æraen og blev aldrig ryddet op ved migrering. Hørkrams karton (varenr 60097769) er "Rugbrødsstykke, 64 × 120 g" → 7.68 kg. Påvirkede ikke pris-beregning direkte, men kunne forvirre QU-aware-flows (snapshot-import, indkøbsliste-konvertering). |
| **Vurdering** | Bug i master-data — manuel oprydning, ikke kode-fix. Patch-fil dokumenterede både Manuel-UI- og API-flow. |
| **Foreslået action** | N/A — anvendt manuelt af Leif på grocytest 11. maj 2026 (jf. `tests/specs/PATCH_grocy_qu_broedrug_v1_cleanup.md`). Skal også køres på grocycafe inden cutover. |
| **Status** | `lukket` (anvendt manuelt 11. maj 2026 — patch-fil bevares som skabelon til andre v1-rester) |

### #011 — `shared/bestilling.js` (60 kB) er død kode

| | |
|--|--|
| **Kilde** | T_INDKOB_ADMIN-design F11 (maj 2026) |
| **Beskrivelse** | `initBestilling()` kaldes ingen steder uden for filen selv. Erstattet af `shared/indkob.js` i Fase 6b (merged indkøbsliste + bestilling), men aldrig slettet. CLAUDE.md har en linje under "Beslutninger" om at `shopping_list.js + bestilling.js` udgår, men begge filer ligger stadig i `shared/`. |
| **Vurdering** | Tech-debt — ikke blokerende for tests. Risiko: ved fremtidig refaktorering kan nogen tro filen er aktiv og prøve at "fixe" noget der ikke længere er i brug. |
| **Foreslået action** | Separat oprydnings-PR der sletter `shared/bestilling.js`, `shared/bestilling.css`, `shared/shopping_list.js`, `shared/shopping_list.css`. Verificér først via grep at ingen HTML/JS importerer dem. |
| **Status** | `åben` (lav prioritet — kandidat til oprydnings-PR) |

### #012 — `consumeRecipes` bruger rå `/objects/shopping_list` i stedet for smart endpoint

| | |
|--|--|
| **Kilde** | T_INDKOB_LISTE-design Bug #001 (maj 2026) |
| **Beskrivelse** | `services/grocyAdapter.js:631` i `consumeRecipes`'s shortfall-handler kalder `grocyPost('/objects/shopping_list', {...})` direkte. Det opretter ny entry pr. partial-add — selv hvis samme produkt allerede mangler på listen fra tidligere LEVERET. UI'en viser duplikater. Grocys smart endpoint `/stock/shoppinglist/add-product` dedupper automatisk og understøtter `note`-felt direkte. |
| **Vurdering** | Bug — patch klar med to find/replace-blokke. Konsekvens for tests: T_INV_PARTIAL_02's nuværende assertion ("ny entry id ikke i slBefore") må opdateres til "amount-stigning på pid pr. shopping_list" — ellers vil testen fejle når patch lander og grocytest har pre-existing entry for pid=72. |
| **Foreslået action** | Anvend `tests/specs/PATCH_consumeRecipes_smart_shopping_list.md` (to ændringer i grocyAdapter.js + opdatering af T_INV_PARTIAL_02-assertion i `tests/scripts/run_T_INVENTORY.js`). Skal landes som første commit i T_INDKOB_LISTE-PR. |
| **Status** | `åben` (patch klar — landes som del af T_INDKOB_LISTE-arbejdet) |

---

## Indeks per track

| Track | Observations |
|-------|--------------|
| T_BON | #005, #006 |
| T_PLAN | #007, #008 |
| T_STOCK | #001 |
| T_RECIPES | #002, #003, #004 |
| T_INVENTORY | #009, #012 |
| T_INDKOB_LISTE | #012 |
| T_INDKOB_ADMIN | #010, #011 |

---

*Sidst opdateret: 11. maj 2026 — tilføjet #010-#012 fra T_INDKOB-design.*
