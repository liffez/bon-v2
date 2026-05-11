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

---

## Indeks per track

| Track | Observations |
|-------|--------------|
| T_STOCK | #001 |
| T_RECIPES | #002, #003, #004 |

---

*Sidst opdateret: 11. maj 2026.*
