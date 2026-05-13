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
| **Foreslået action** | N/A — anvendt manuelt af Leif på grocytest 11. maj 2026 (jf. `tests/specs/patches/PATCH_grocy_qu_broedrug_v1_cleanup.md`). Skal også køres på grocycafe inden cutover. |
| **Status** | `lukket` (anvendt manuelt 11. maj 2026 — patch-fil bevares som skabelon til andre v1-rester) |

### #011 — `shared/bestilling.js` (60 kB) er død kode

| | |
|--|--|
| **Kilde** | T_INDKOB_ADMIN-design F11 (maj 2026) |
| **Beskrivelse** | `initBestilling()` kaldes ingen steder uden for filen selv. Erstattet af `shared/indkob.js` i Fase 6b (merged indkøbsliste + bestilling), men aldrig slettet. CLAUDE.md har en linje under "Beslutninger" om at `shopping_list.js + bestilling.js` udgår, men begge filer ligger stadig i `shared/`. |
| **Vurdering** | Tech-debt — ikke blokerende for tests. Risiko: ved fremtidig refaktorering kan nogen tro filen er aktiv og prøve at "fixe" noget der ikke længere er i brug. |
| **Foreslået action** | Separat oprydnings-PR der sletter `shared/bestilling.js`, `shared/bestilling.css`, `shared/shopping_list.js`, `shared/shopping_list.css`. Verificér først via grep at ingen HTML/JS importerer dem. |
| **Status** | `åben` (lav prioritet — kandidat til oprydnings-PR) |

### #013 — `routes/purchasing.js` POST /suppliers falder tilbage til `integration_type='manual'` ved ugyldig værdi

| | |
|--|--|
| **Kilde** | `T_INDKOB_SETUP_SUP_04` (11. maj 2026) |
| **Beskrivelse** | POST `/api/purchasing/suppliers { integration_type: 'ftp' }` returnerer 201 med `integration_type: 'manual'` — route-validering i `routes/purchasing.js:225-226` har fallback i stedet for at afvise. Der er ingen DB-CHECK-constraint der ville afvise det. |
| **Vurdering** | Route-design der prioriterer robusthed over strikthed. Lav prioritet — UI'en kun tillader de gyldige typer alligevel. Men hvis nogen kalder API'en direkte med en typo, får de silent fallback i stedet for fejl. |
| **Foreslået action** | Overvej at returnere 400 ved ugyldig integration_type i stedet for at falde tilbage. Eller dokumentér fallback-adfærden i routes-filen som bevidst. |
| **Status** | `åben` (lav prioritet — design-beslutning) |

### #014 — `supplier_grocy_locations` POST accepterer duplikat silently via INSERT OR REPLACE

| | |
|--|--|
| **Kilde** | `T_INDKOB_SETUP_SGL_03` (11. maj 2026) |
| **Beskrivelse** | POST `/api/purchasing/suppliers/grocy-locations` på samme (supplier_id, grocy_location_id) returnerer 200 både første og anden gang — route bruger `INSERT OR REPLACE` (`routes/purchasing.js:137-140`). Brugeren får ingen indikation af om koblingen er ny eller blev erstattet. |
| **Vurdering** | Acceptabelt for nuværende UI-flow (genvalg af samme leverandør = no-op), men kan skjule bugs hvor man tror man har oprettet en ny kobling. Tabellen har ikke UNIQUE-constraint på (supplier_id, grocy_location_id) — det kunne tilføjes. |
| **Foreslået action** | Hvis duplikat-detection nogensinde bliver vigtig, tilføj enten en UNIQUE-constraint og returnér 409 ved konflikt, eller dokumentér i UI'en at re-tilknytning er destruktiv. |
| **Status** | `åben` (lav prioritet — design-beslutning) |

### #015 — Grocy returnerer 500 ved duplikat product_barcode (samme pid + barcode)

| | |
|--|--|
| **Kilde** | `T_INDKOB_SETUP_BC_03` (11. maj 2026) |
| **Beskrivelse** | POST `/api/grocy/product-barcodes` med samme `(product_id, barcode)` der allerede eksisterer returnerer HTTP 500 fra Grocy (ikke 409 eller 400). Vores adapter propagerer 500'en uden mapping. |
| **Vurdering** | Lav prioritet i UI'en — flowet "Tilføj barcode-kobling" tjekker eksisterende koblinger først, så brugeren ser sjældent denne fejl. Men hvis batch-import eller automatisering støder på dette, vil fejlmeddelelsen være misvisende. Beslægtet med #002 (Grocy 500 ved DELETE ghost-id). |
| **Foreslået action** | Samme som #002 — hvis nogen rører `services/grocyAdapter.js:grocyPost`, kunne man map'e Grocy-500'er med "already exists"-tekst til 409. Eller pre-validér i route før POST. |
| **Status** | `åben` (lav prioritet) |

### #016 — Backend tillader flere samtidige `is_preferred='1'` på samme produkts barcodes

| | |
|--|--|
| **Kilde** | `T_INDKOB_ADMIN_PREF_02` (11. maj 2026) |
| **Beskrivelse** | `is_preferred`-userfield på `product_barcodes` er ren tekst — Grocy validerer ikke at kun én barcode pr. produkt har `is_preferred='1'`. To samtidige "Foretrukken"-flag persisterer uden fejl. Verificeret via T_INDKOB_ADMIN_PREF_02: oprettede ny barcode på pid=28 og satte `is_preferred='1'` mens den eksisterende også havde `is_preferred='1'` — begge persisterede. |
| **Vurdering** | UI-design-mismatch. Hvis brugeren kan klikke "Foretrukken" på to barcodes uden at den anden auto-cleares, vil UI'en vise to lilla "Foretrukket"-badges og chip-sortering blive uforudsigelig (jf. `shared/indkob.js` chip-sortering: `is_preferred` → aftale → billigst). |
| **Foreslået action** | I `shared/indkob_settings.js` "Alle koblinger"-tab: når brugeren toggler `is_preferred` ON på en barcode, clear alle andre barcodes for samme `product_id` først (eller `PATCH /api/grocy/userfields/product_barcodes/:id` for hver). Alternativt: tilføj en server-side guard i route'en. |
| **Status** | `åben` (lav prioritet — design-beslutning) |

### #017 — Hørkram basket-PUT lagde varer i InvalidLineItems pga forkert body-format (lukket)

| | |
|--|--|
| **Kilde** | `T_INDKOB_HORKRAM_BASKET_02` + `BASKET_04` (12. maj 2026) — fixet samme dag |
| **Beskrivelse** | PUT `/api/horkram/basket/add` returnerede HTTP 200, men varer landede i Hokas `InvalidLineItems` med `HasSalesUnitQuantity: false` i stedet for i `LineItems`. To samtidige problemer: (1) `routes/horkram.js` sendte `SalesUnitIndex + SalesUnitQuantity` på line-niveau — Hoka ignorerer `SalesUnitQuantity` og kræver nested objekt. (2) `GET /api/horkram/basket` brugte default `?id=0` der opretter ny tom basket i stedet for at hente sessionCache.basketId — så UI ville aldrig se de varer der lige blev PUT'et. |
| **Vurdering** | **Bug — fixet 12. maj 2026.** Ville have brudt "Læg i kurv"-flowet ved cutover. To kommitter: (a) GET basket defaultes til `sessionCache.basketId` så den læser samme kurv som senest PUT, (b) PUT-body sender nu nested `SalesUnit: { Code, Quantity }` i stedet for `SalesUnitIndex + SalesUnitQuantity`. Verificeret: Spinat × 1 + Brød Rug × 1 lander nu korrekt i `lines` med `invalidCount=0`. |
| **Foreslået action** | N/A — fixet. Næste skridt: når flere produkter testes manuelt, log evt. andre format-issues. |
| **Status** | `lukket` (12. maj 2026 — routes/horkram.js opdateret + T_INDKOB_HORKRAM BASKET-cases viser nu faktisk verifikation, ikke bare 200-status) |

### #012 — `consumeRecipes` bruger rå `/objects/shopping_list` i stedet for smart endpoint (lukket)

| | |
|--|--|
| **Kilde** | T_INDKOB_LISTE-design Bug #001 (maj 2026) |
| **Beskrivelse** | `services/grocyAdapter.js:631` i `consumeRecipes`'s shortfall-handler kaldte `grocyPost('/objects/shopping_list', {...})` direkte. Det opretter ny entry pr. partial-add — selv hvis samme produkt allerede mangler på listen fra tidligere LEVERET. UI'en viste duplikater. Grocys smart endpoint `/stock/shoppinglist/add-product` dedupper automatisk og understøtter `note`-felt direkte. |
| **Vurdering** | Bug — fixet 11. maj 2026 via `tests/specs/patches/PATCH_consumeRecipes_smart_shopping_list.md` (3 ændringer: udvid `addShoppingListProduct` med note-param, brug smart endpoint i `consumeRecipes`, opdater `T_INV_PARTIAL_02`-assertion fra "ny entry-id" til "amount-stigning ≥ shortfall_purchase"). T_INVENTORY-suiten kører fortsat 13/13 PASS. Faktisk bevis: rapporten viser at smart endpoint `dedupped` på eksisterende entry (id=3750 for pid=72) — den gamle assertion ville have fejlet her, hvilket bekræftede at Ændring 3 var nødvendig. |
| **Foreslået action** | N/A — fixet |
| **Status** | `lukket` (11. maj 2026 — patch anvendt + T_INVENTORY verificeret) |

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
| T_INDKOB_SETUP | #013, #014, #015 |
| T_INDKOB_ADMIN | #010, #011, #016 |
| T_INDKOB_HORKRAM | #017 |

---

*Sidst opdateret: 12. maj 2026 — #017 flyttet til lukket efter routes/horkram.js fix: nested SalesUnit-format + GET defaultes til sessionCache.basketId. Basket-PUT lægger nu varer korrekt i Hokas LineItems.*
