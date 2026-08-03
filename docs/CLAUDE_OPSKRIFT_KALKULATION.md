# CLAUDE_OPSKRIFT_KALKULATION.md

**Formål:** Give opskriftsdesigneren en kostpris- og avance-visning, så en ret kan
prissættes mod et dækningsbidragsmål — uden at bygge et nyt beregningsapparat.

**Bærende princip: GENBRUG. Der findes præcis ÉN kostpris i systemet, og den bor
allerede i `recipe_cost_cache` (Grocy fulfillment `costs`).** Designeren regner ikke
sin egen kostpris. Den læser den samme værdi som office-modulet "Opskrifter & priser"
viser, lægger en valgfri løn-linje ovenpå, og udleder pris/DB klient-side. Intet nyt
kostprisgrundlag. Intet nyt userfield til råvarepriser. Ingen risiko for to tal der
divergerer.

**Status:** Mockup godkendt (`recipe_designer_pris_mockup.html`). Spec omskrevet til
genbrugsplan.
**Zone:** Kitchen (`kitchen/recipes.html` → tab `#designer`).

---

## Det eksisterende modul designeren hænger sig på

Alt herunder er **bygget og i drift** (`routes/recipes_overview.js`, migration 068,
`services/itemPriceBackfill.js`). Designeren er en klient af det — den tilføjer intet
backend-kostpris-maskineri.

> **Implementeringsnote (bygget):** Designeren bruger det eksisterende
> **`GET /api/recipes/:id/composition`** som ENESTE kostpriskilde. Det returnerer
> `total_cost` = Grocy fulfillment (samme autoritative tal som office-modulet) PLUS
> per-ingrediens- og per-underopskrift-kostpris (via `last_price`). Ét kald giver dermed
> både headline-kostpris, breakdown (Fase 2) og andel (Fase 3) — ingen ny beregning, og
> designerens kostpris er pr. definition lig office-modulets. Det oprindeligt planlagte
> `GET /api/recipes/:id/cost` blev derfor ikke nødvendigt.

| Hvad | Hvor | Genbruges til |
|---|---|---|
| **Kostpris + breakdown pr. opskrift (ex moms)** | `GET /api/recipes/:id/composition` — `total_cost` (fulfillment) + per-linje `cost` | Kostprisen, breakdown og andel. Den ENESTE kostpris. |
| **CO₂ pr. opskrift** | opskriftens `Co2e`-userfield (allerede loadet i designeren) | CO₂-kortet. |
| **Salgspris pr. priskategori (ex moms)** | `item_prices` (item_type=`recipe`) | Faktisk pris i verdict. Grocy `Salesprice*` er master, auto-synced. |
| **Skriv salgspris → Grocy** | `PUT /api/item-prices` (skriver til Grocy via `CATEGORY_TO_USERFIELD`, incl↔excl håndteret) | "Gem-salgspris"-knappen. Allerede bygget. |
| **DB%-mål pr. kategori** | `recipe_db_targets` + `GET/PUT/PATCH /api/recipes/targets` | DB-sliderens startværdi + verdict-mål. |
| **Timeløn (ex moms, tidsversioneret)** | `wage_rates.hourly_rate` + `services/laborAdapter.js` | Standard-medarbejdersats til løn-linjen. |
| **Løn-overhead** | `settings.labor_overhead_pct` (findes; produktion = 15, bekræftet i drift) | 15 %-tillægget på standardsatsen. |
| **Moms-helpers** | `shared/moms.js` (`MOMS_FACTOR`, `exclToIncl`, `inclToExcl`) — bekræftet eksporteret til frontend som `window.Moms` | Kun den viste menupris konverteres til inkl. |
| **api-wrappers** | `shared/api.js`: `fetchRecipesOverview`, `refreshRecipeCosts`, item-prices-PUT (linje 2041/2045/2053) | Frontend-kald. |
| **Produktdata m. userfields i designeren** | `_rdLoadData()` henter allerede `fetchGrocyProducts()` | CO₂/enheder ved drill-down. |

**Konsekvens:** Fase 4 (CO₂) og Fase 6 (skriv salgspris) er reelt allerede bygget —
de reduceres til "kald det eksisterende endpoint". Fase 1 er "læs cachen", ikke
"beregn". De eneste ægte nye stykker er: løn-linjen (standardsats), pris/DB-panelet
(ren klient-aritmetik), kladde-autosave, og et lille kostpris-læse-endpoint.

---

## Filer der berøres

| Fil | Ændring |
|---|---|
| `shared/recipe_designer.js` | Læs kostpris fra cache-endpoint, refresh ved gem, 3 nye summary-kort, pris-panel, kladde-autosave |
| `shared/recipe_designer.css` | Styling af pris-panel, andel-bar, verdict |
| `routes/recipes_overview.js` | Ét lille `GET /api/recipes/:id/cost` (læs cache-række for én opskrift) |
| `services/laborAdapter.js` | Én ny helper `getStandardHourlyRate(dato)` (gennemsnit af aktive `wage_rates`) |
| `shared/api.js` | `fetchRecipeCost(id)` wrapper |
| `settings` (tabel) | `labor_overhead_pct` er allerede 15 i produktion (0 i dev — sæt til 15 lokalt for test). Evt. ét flag. |

**Ingen nye tabeller. Ingen migration for kostpris/pris/mål/løn — de findes alle.**

---

## Verificér før implementering

De oprindelige punkter #1 (produkt-pris-userfield), #3 (hvor bor salgsprisen) og #5
(`MOMS_FACTOR`) er **besvaret af koden** og udgår. Tilbage stod fire genbrugs-checks —
alle nu afklaret:

| # | Skal bekræftes | Resultat |
|---|---|---|
| 1 | **`GET /api/recipes/:id/cost` er den letteste vej.** `overview` returnerer ALLE opskrifter — for tungt til designeren. Tilføj et enkelt-opskrift-læse-endpoint der returnerer cache-rækken (eller `null` hvis ikke cachet endnu). | Bygges (kopiér cache-læsning fra `overview` linje 131-140) |
| 2 | **Standard-medarbejdersats.** Gennemsnit af aktive `wage_rates.hourly_rate`, ex moms. | ✅ 26 aktive rater i dev, gns. 148,65 kr/t |
| 3 | **`labor_overhead_pct` deles med driftsregnskabet** (`routes/drift.js` linje 137-139). | ✅ Produktion = 15 (bekræftet i drift: rå 1.600 → 1.840). Genbruges direkte. Dev-DB = 0 → sæt til 15 lokalt for test |
| 4 | **Aktiv arbejdstid** er den ene data-værdi der ikke findes i dag. | ✅ Userfield `arbejdstid_min` oprettet på grocytest + grocy-hq (tomt): aktiv, hands-on tid i minutter pr. batch ved `base_servings` |

---

## Beregningsmodel

Alt regnes **ex moms**. Kun den viste menupris konverteres til inkl. moms via
`Moms.exclToIncl`. **Kostprisen beregnes ikke her — den læses.**

```
vareomkostning_pr_portion = recipe_cost_cache.cost_price_excl_moms   ← ENESTE kostpris, læst fra Grocy fulfillment
                                                                       (allerede pr. opskrifts-enhed)

aktiv_min_pr_portion = arbejdstid_min / base_servings                ← arbejdstid_min = AKTIV tid pr. batch (userfield)
løn_pr_portion   = standard_timeløn × (1 + labor_overhead_pct/100) × aktiv_min_pr_portion / 60
                   standard_timeløn = AVG(aktive wage_rates.hourly_rate)          ← laborAdapter.getStandardHourlyRate()

fuldt_belastet   = vareomkostning_pr_portion + løn_pr_portion        ← afledt sum, IKKE en anden kostprisberegning

salgspris_ex     = grundlag / (1 − maal_db_pct/100)                  ← grundlag = fuldt_belastet ELLER vareomkostning (toggle)
salgspris_inkl   = Math.round(Moms.exclToIncl(salgspris_ex))         ← afrunding KUN her

faktisk_pris_ex  = item_prices.price   (allerede ex moms)
db_faktisk_pct   = (faktisk_pris_ex − grundlag) / faktisk_pris_ex × 100
```

### Kun én kostpris — og den kommer fra ét sted

`vareomkostning_pr_portion` er **altid** `recipe_cost_cache.cost_price_excl_moms`.
Designeren regner den aldrig selv fra råvarepriser. Derfor findes den kendte
enhedskonverterings-fælde (35–150× fejl, `KENDTE_DATABUGS.md #001`) slet ikke i denne
opgave — den konvertering ligger i Grocys fulfillment, som allerede er testet i
`T_OPSKRIFTER`.

Løn er en **separat linje** oven på vareomkostningen. Den ændrer ikke
vareomkostnings-tallet, og "Kostpris (råvarer)" i designeren skal til enhver tid være
identisk med det office-modulet viser for samme opskrift. Det er testens vigtigste
invariant (T_OPSKRIFT_KALKULATION Del A).

### Redigering før gem

Grocys fulfillment-kostpris opdateres først når opskriften er gemt. Derfor:

- **Gemt opskrift, uændret:** vis cache-værdien direkte.
- **Under redigering:** vis cache-værdien for sidst-gemte tilstand + en diskret note
  "afspejler sidst gemte — opdateres ved Gem". Ingen live klient-beregning (det ville
  være kostpris nr. to).
- **Ved `Gem` / `Gem som ny`:** kald `refreshRecipeCosts()`, læs derefter
  `fetchRecipeCost(id)` igen → kostprisen opdateres. Ét kald, én sandhed.
- **Helt ny opskrift, endnu ikke gemt:** kostpris-kortet viser `beregnes efter gem`,
  ikke `0` og ikke et estimat.

### Manglende kostpris må ikke blive 0

Hvis `fetchRecipeCost(id)` returnerer `null` (opskriften er ikke i cachen endnu):

- kostpris-kortet viser `—` / `beregnes efter gem`
- foreslået pris og DB vises som `—`, ikke som tal
- pris-panelet blokerer ikke, det venter bare på første refresh

---

## Fase 0 — Kort-synlighed (ikke et nyt modul-flag)

Backend-modulet ("Opskrifter & priser") findes allerede uden et separat
`module_*_enabled`-flag. Derfor bygger vi **ikke** et nyt modul-flag her. De nye kort
er per-bruger opt-in, præcis som designerens eksisterende `weight`/`stock`-kort.

- `_rdVisibleCards` er allerede et Set → udvid med `cost`/`price`/`db`/`co2`, persistér
  pr. bruger i localStorage `rd_cards_v1`
- **Default: kun `weight` + `stock`** — som i dag. De nye kort tændes bevidst.
- Er alle pris-kort slået fra → pris-panelet skjules helt, og `fetchRecipeCost` kaldes
  ikke (ét kald mindre).

Vil kokke ikke se kostpriser, er det en rollebeslutning der rører flere moduler end
dette — den træffes ikke her.

## Fase 1 — Kostpris fra composition · **go-live blocker** ✅ bygget

Designeren kalder `fetchRecipeComposition(id)` (`GET /api/recipes/:id/composition`) ved
åbning af en opskrift. `total_cost` (fulfillment) / `base_servings` = kostpris pr. portion
= headline. Gemmes i `_rdComp`; `_rdRenderPrice()` skriver kortet. Ingen ny beregning.

**Bekræftet mod koden — vær præcis her:**
- `_rdCardDefs` (linje 614) er allerede et array `{id,label}` med kun `weight`+`stock`.
  Tilføj `cost`/`price`/`db`/`co2` dér.
- **Chips renderes hardkodet inline** i `_rdShowDesigner` (linje 375-376), *ikke* fra
  `_rdCardDefs`. **Beslutning: generér chip-rækken fra `_rdCardDefs`** i stedet — så nye
  kort kun tilføjes ét sted, og dobbeltvedligeholdet forsvinder.
- **Kostprisen beregnes IKKE i `_rdRecalcSummary`s ingrediens-løkke.** Den løkke (linje
  635-656) summerer vægt/lager fra ingredienserne — det er ikke kostpris. Kostpris + CO₂
  hentes async fra cachen (`fetchRecipeCost`), gemmes i en modul-var (fx `_rdCost`), og
  `_rdRecalcSummary` skriver dem via `setVal('cost', …)` / `setVal('co2', …)`. Ingen
  ny per-ingrediens-beregning.
- Gemt opskrift: id findes i `_rdDs.originalRecipeId`. `_rdSaveAsNew()` returnerer `newId`
  fra `postGrocyRecipe` (linje 1236-1249) → brug det til at hente kostpris efter gem.

**Accept:** Kostpris for en gemt opskrift i designeren er **identisk** med
`cost_price_excl_moms` for samme opskrift i `GET /api/recipes/overview`. Ikke "tæt på"
— identisk. Det er beviset på at der kun er én kostpris.

## Fase 2 — Pris & avance-panel · **go-live blocker**

Nyt panel: vareomkostning + løn-linje → fuldt belastet, DB-slider (40–88 %), foreslået
menupris, verdict mod faktisk pris fra `item_prices`.

- **DB-sliderens startværdi** = opskriftens kategori-mål fra `recipe_db_targets`
  (`GET /api/recipes/targets`), fallback 70 hvis kategorien ikke har et mål. **Intet nyt
  `kalkulation.maal_db_pct`-setting.**
- **Løn-toggle:** slået til lægger standard-medarbejdersats × overhead × min/portion
  oven på vareomkostningen. Slået fra → grundlag = ren vareomkostning, løn-linje `—`.
- **Grundlag-toggle** (råvarer / inkl. løn): styrer om DB regnes på vareomkostning
  alene eller fuldt belastet. Vis begge DB-tal så det er gennemsigtigt.
- Verdict grøn hvis `db_faktisk >= maal_db`, ellers rød med den pris der ville nå målet.

**Accept:** Al matematik ex moms. Ingen bar `1.25`/`0.25` i koden — pre-commit-hook
fanger det. Sæt DB til 75 % på en opskrift med kendt kostpris og verificér mod hånden.

## Fase 3 — Andel-kolonne · **go-live blocker**

Andel i procent pr. ingrediens/nesting-række i `_rdRenderIngredients()` /
`_rdRenderNestings()`, regnet mod det viste kostpris-grundlag. Dette er ren visning —
tallet drives af Grocys fulfillment-breakdown, ikke af egne priser.

**Accept:** Summen af andelene er 100 % (± afrunding).

## Fase 4 — CO₂-kort

Kort `co2` fra `recipe_cost_cache.co2e` (samme cache-række som kostprisen — ét kald,
ingen ekstra kilde). Ikke go-live blocker.

## Fase 5 — Kladde-autosave

`_rdDs` + de læste kostpris/CO₂-værdier + `min_pr_portion` + DB-mål serialiseres til
localStorage `rd_draft_v1` ved `_rdMarkChanged()`. Gem `snapshot_at` (ISO), så et
estimat ikke ændrer sig når Grocy-priserne gør. Ved `initRecipeDesigner()`: tilbyd
`Fortsæt` / `Kassér`. Ryd nøglen efter succesfuld gem. Ingen tabel.

## Fase 6 — Skriv salgspris til Grocy

**Allerede bygget.** Checkbox ved gem → `PUT /api/item-prices` med `item_type:'recipe'`,
`price_category_code`, `price_excl_moms`. Endpointet skriver til Grocy (master) via
`CATEGORY_TO_USERFIELD` og gemmer lokalt kun hvis Grocy svarer. Aldrig automatisk —
altid eksplicit valg. Designeren skal kalde **item-prices-endpointet** (holder
`item_prices` i sync), ikke `putGrocyRecipeUserfields` direkte — sidstnævnte ville skrive
til Grocy uden om den lokale pris-cache.

---

## Løn: standard-medarbejder + 15 % · kun AKTIV tid

**To tider — kun den ene koster løn.** En opskrift har både *aktiv arbejdstid*
(hands-on: skære, samle, stege-med-opsyn) og *procestid* (elapsed: kartofler der koger,
dej der hæver, ting der køler). Kun aktiv tid betales der løn for. Kalkulationen bruger
**udelukkende aktiv tid** — procestid hører til prep-kapacitet (#276) og får sit eget
søsterfelt der. Skriv aldrig procestid ind i `arbejdstid_min`.

Timeløn i `wage_rates` er pr. medarbejder. Designeren skal ikke vide hvem der laver
retten, så vi bruger en **standard-medarbejder**:

```
standard_timeløn = AVG(wage_rates.hourly_rate)   for aktive rater (valid_to IS NULL OR now < valid_to)
aktiv_min_pr_portion = arbejdstid_min / base_servings            ← userfield: aktiv tid pr. batch
løn_pr_portion   = standard_timeløn × (1 + labor_overhead_pct/100) × aktiv_min_pr_portion / 60
```

- Ny helper `laborAdapter.getStandardHourlyRate(dato)` — genbruger samme
  `wage_rates`-opslag som `_wageRate()`, bare aggregeret.
- Overhead = eksisterende `labor_overhead_pct` (produktion = 15, bekræftet i drift).
  Deles med driftsregnskabet → automatisk konsistens.
- Ingen rater i DB eller tomt `arbejdstid_min` → løn-linjen viser `—` + note, aldrig et gæt.

**Per batch, ikke per portion:** `arbejdstid_min` er den aktive tid for ét batch ved
`base_servings`, delt ud på portioner. Aktiv tid skalerer ikke perfekt lineært (fælles
opsætningstid), men en ægte opsætning+marginal-model hører til #276 — her er
per-batch ÷ portioner den ærlige, simple v1.

---

## To niveauer af til/fra — ikke tre

| Niveau | Hvor | Spørgsmål |
|---|---|---|
| Kort | localStorage `rd_cards_v1` | Vil *jeg* se de tal nu? |
| (Modul) | — findes allerede via office-modulet, intet nyt flag her | Findes funktionen? |

Default når et pris-kort tændes første gang: stadig kun `weight`+`stock` synlige. Ingen
bruger skal opleve at skærmen ændrer sig af sig selv.

---

## Ikke i scope

| Udeladt | Hvorfor |
|---|---|
| Egen klient-side råvarepris-beregning | Kostprisen er Grocys fulfillment. Kun én beregning. |
| Nyt produkt-pris-userfield | Ikke nødvendigt — fulfillment leverer allerede kostprisen |
| Enhedskonvertering af råvarepriser | Sker i Grocy, testet i `T_OPSKRIFTER` — ikke her |
| Procestid (elapsed) i kostprisen | Kun aktiv tid koster løn. Procestid → prep-kapacitet (#276) |
| Nyt modul-flag / nye settings for timesats+maal_db | `recipe_db_targets` + `wage_rates` + `labor_overhead_pct` findes |
| Rollestyring (skjul priser for kokke) | Selvstændig beslutning på tværs af moduler |
| Faktisk kostpris fra varemodtagelse | Kræver varemodtagelse→batch→kostpris. Selvstændig fase |

---

## Test

Se `T_OPSKRIFT_KALKULATION.md`. Kernen: **designerens kostpris == office-modulets
kostpris for samme opskrift** (én-sandheds-invarianten), plus løn-add-on, pris/DB-math,
manglende-cache-håndtering (`—`, ikke `0`), og genbrug af `item_prices`-write-back.
Enhedskonvertering testes IKKE her — den er delegeret til Grocy + `T_OPSKRIFTER`.

Fixture `ZZT_Kalkulation` på `grocy-test`, aldrig `grocy-hq`. Go-live blockers: Fase
1, 2, 3.

---

## Næste opgave-blok til CLAUDE.md

```
### Næste opgave: Opskrifts-kalkulation i designeren (GENBRUGSPLAN)
Spec: CLAUDE_OPSKRIFT_KALKULATION.md
Designeren er en klient af det eksisterende "Opskrifter & priser"-modul.
ÉN kostpris: recipe_cost_cache (Grocy fulfillment) — designeren regner ikke selv.
Genbrug: recipe_db_targets (DB-mål), item_prices (salgspris + write-back),
wage_rates + labor_overhead_pct (løn). Nyt: GET /api/recipes/:id/cost,
getStandardHourlyRate(), pris-panel (klient-math), kladde.
Go-live blockers: Fase 1, 2, 3. Userfield arbejdstid_min oprettet på begge instanser.
```
