# CLAUDE_OPSKRIFTER.md — Opskrifter & priser (office)

> Læs `CLAUDE.md`, `bon_v2_datamodel_v2.md`, `bon_v2_zoner_og_layout.md`,
> `BON_V2_PRINCIPPER.md` og `shared/moms.js` FØR du starter.
> Opdateret: maj 2026

---

## Formål

En margin-analyse-view for office under Økonomi-sektionen. Krydser Grocy
(kostpris fra ingrediens-fulfillment) med Bon v2 (salgspriser pr. priskategori
+ faktisk volume fra `bon_lines`) for at vise dækningsbidrag pr. opskrift.

Erstatter ikke `kitchen/recipes.html` (skalering til produktion) eller
råvarer-modal'en i bon_drawer (per-bon visning). Dette er et **katalog-view
på tværs** — der hvor pengene tjenes.

---

## Sidebar-placering

Tilføjes som nyt punkt under **ØKONOMI**-sektionen i office-sidebaren —
under det eksisterende `💰 Økonomi`-punkt (der har Fakturering / Pengestrøm /
Rapporter som pills indeni). Eget sidebar-punkt, ikke pill — selvstændig
view-størrelse retfærdiggør egen URL.

```
ØKONOMI
├── 💰 Økonomi              (pills: Fakturering · Pengestrøm · Rapporter)
└── 📊 Opskrifter & priser  ← NY (ingen pills)
```

### Kode-ændringer i `office/index.html`

**1) Tilføj sidebar-link** efter `okonomi`-knappen (omkring linje 616):

```html
<button class="sidebar-link" data-view="opskrifter">
  <span class="sidebar-icon">📊</span> Opskrifter & priser
</button>
```

**2) Tilføj til `SECTION_VIEW_MAP`** (omkring linje 967):

```javascript
opskrifter: { _default: 'opskrifter' },
```

`PILLS`-objektet skal **ikke** udvides (ingen pills i denne view).

> **Patch til `bon_v2_zoner_og_layout.md` §4:** se `PATCH_zoner_og_layout_4.md`.

---

## Moms-doktrin (kritisk)

Hele viewet **viser** tal ex moms. Men data ligger gemt forskelligt — alle
konverteringer går gennem `shared/moms.js` (`Moms.inclToExcl()`,
`Moms.computeMomsFields()`). Ingen magic-tal i route- eller view-filer
(pre-commit-hook blokerer det).

| Kilde | Status | Konvertering |
|---|---|---|
| Grocy `product.price` (råvarer) | **ex moms** | Bruges direkte |
| Grocy `/recipes/{id}/fulfillment.costs` | **ex moms** | Summen af råvarer × mængde |
| Grocy `Salesprice*`-userfields på recipes | **INCL moms** | `Moms.inclToExcl()` ved migration |
| Bon v2 `item_prices.price` | **ex moms** | Single source of truth fremadrettet — gemmes ex moms |
| Bon v2 `bon_lines.cost_price` | **ex moms** | Snapshot, bruges direkte |
| Bon v2 `bon_lines.unit_price` | **INCL moms** | `Moms.inclToExcl()` før aggregering til revenue |
| Bon v2 `bons.total_price` / `delivery_price` | **INCL moms** | Bruges ikke i dette view |

> ⚠️ **Bug-fælde:** Tidligere udkast skrev `SUM(bl.quantity * bl.unit_price) AS revenue_excl_moms` — det er FORKERT. `unit_price` er incl moms, så aggregatet er incl moms. Konverter i Node-laget via `Moms.inclToExcl()` efter SUM, ELLER divider i SQL: `SUM(bl.quantity * bl.unit_price) / 1.25` (men foretrækker helper-laget).

**Synlighed i UI:** En tydelig pill i topbaren: `[ ALLE PRISER EX MOMS ]`.
Input-labels i drill-down: `Salgspris (ex moms)`, `Kostpris (ex moms)`.

**Beslutning:** `item_prices` er fremadrettet single source of truth for
salgspriser. `price`-feltet gemmes ex moms. Grocy `Salesprice*`-userfields
bruges kun til auto-backfill første gang viewet vises (se § Migration).

---

## Datamodel-tillæg

Migration: `db/migrations/068_recipe_cost_cache_and_targets.sql` (næste ledige nummer).

Tre ændringer: udvid eksisterende `item_prices` med `item_type`-kolonne, ny `recipe_cost_cache`-tabel, ny `recipe_db_targets`-tabel.

### `item_prices` udvidet med `item_type`

Den eksisterende tabel (defineret i `001_core.sql`) er **tom på tværs af kodebasen** — intet i `routes/`, `services/`, `shared/` eller `db/seed.js` skriver til den. Det er trygt at recreate.

Tilføjer `item_type` med CHECK-constraint så vi entydigt kan have priser på både opskrifter, produkter og lokale items uden ID-kollision. UNIQUE-indekset gør (`item_type`, `item_id`, `price_category_id`) til den effektive primary key for upserts. `updated_by_user_id` tillader changelog-tracking.

```sql
-- Tabellen er tom — drop og recreate er sikkert
DROP TABLE IF EXISTS item_prices;

CREATE TABLE item_prices (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type           TEXT NOT NULL CHECK (item_type IN ('recipe','product','local')),
    item_id             INTEGER NOT NULL,
    price_category_id   INTEGER NOT NULL REFERENCES price_categories(id),
    price               REAL NOT NULL,    -- EX moms (autoritativ)
    updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id  INTEGER REFERENCES users(id),
    UNIQUE(item_type, item_id, price_category_id)
);

CREATE INDEX idx_item_prices_lookup ON item_prices(item_type, item_id);
```

I dette view bruges `item_type = 'recipe'` udelukkende. Produkt-priser tilføjes senere når det bliver relevant.

### `recipe_cost_cache`

Cachet output fra Grocy fulfillment-endpoint. Refreshes manuelt eller via
nightly cron. Holder hovedtabellen hurtig — ét JOIN i stedet for N Grocy-kald.

```sql
CREATE TABLE recipe_cost_cache (
    grocy_recipe_id INTEGER PRIMARY KEY,
    cost_price_excl_moms REAL NOT NULL,
    ingredients_json TEXT NOT NULL,   -- [{name, qty, unit, cost_excl_moms, pct_of_total}, ...]
    co2e REAL,
    refreshed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recipe_cost_cache_refreshed ON recipe_cost_cache(refreshed_at);
```

### `recipe_db_targets`

DB%-mål pr. Grocy-kategori. Bruges til at farve rækker rødt under mål.

**Ingen hardcoded seed** — kategorier hentes dynamisk fra Grocy (userfield `grupper` på recipes) når admin åbner DB-mål-popoveren. Tabellen er tom ved opstart. Kategorier uden mål-række får DB%-farvning blå/grå (over kostpris) eller rød (negativ DB%) men markeres ikke som "under mål".

```sql
CREATE TABLE recipe_db_targets (
    category TEXT PRIMARY KEY,    -- Grocy-kategori-navn (fra "grupper"-userfield)
    target_pct REAL NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by_user_id INTEGER REFERENCES users(id)
);
-- Ingen seed. Admin populerer via UI.
```

---

## API-endpoints

Alle endpoints kræver office- eller admin-rolle. Alle priser ex moms.

### `GET /api/recipes/overview`

Hovedtabel-data. Én forespørgsel der returnerer alt der skal renderes i tabellen.

**Query params:**
- `price_category` — `catering` (default) eller `festival`
- `period_days` — 30 / 90 / 180 / 365 (default: **365**)
- `category` — filter på Grocy-kategori (valgfri)
- `include_inactive` — `0` (default) eller `1`

**Periode-aliniering:** `period_days` styrer BÅDE summary-tal og sparkline. Sparkline opdeler altid perioden i 12 buckets — 90 dage = 12 uger, 365 dage = 12 måneder. Bucket-label vises i tooltip ("Uge 23: 14 stk" eller "Maj: 142 stk"). Default 365 dage giver klassisk "12 mdr trend".

**Response:**

```json
{
  "price_category": "catering",
  "period_days": 365,
  "cost_refreshed_at": "2026-05-15T08:00:00Z",
  "summary": {
    "active_count": 47,
    "total_count": 63,
    "under_target_count": 8,
    "loss_making_count": 1,
    "missing_price_count": 3,
    "not_sold_count": 11,
    "oko_count": 9,
    "share_under_target_pct": 17.0,
    "avg_db_pct_weighted": 64.2,
    "total_revenue_excl_moms": 487000,
    "total_db_kr_excl_moms": 312000,
    "total_co2_kg": 348.5
  },
  "recipes": [
    {
      "grocy_recipe_id": 42,
      "name": "Frikadellen",
      "category": "01 Sandwich",
      "is_active": true,
      "is_organic": false,
      "cost_price_excl_moms": 31.90,
      "sales_price_excl_moms": 89.00,
      "db_kr_excl_moms": 57.10,
      "db_pct": 64.2,
      "db_target_pct": 65,
      "under_target": true,
      "loss_making": false,
      "sold_units": 201,
      "revenue_excl_moms": 17889,
      "co2e_per_unit": 0.71,
      "co2_total_period": 142.71,
      "period_buckets": [12, 18, 14, 22, 19, 25, 17, 21, 24, 19, 18, 22]
    }
  ]
}
```

**Bucket-format:** `period_buckets` er 12 tal — antal solgte enheder pr. tidsbøtte (uge/måned afhængig af `period_days`). Frontend rendrer sparkline direkte fra arrayet.

**Implementation:**

```javascript
// routes/recipes_overview.js
const { Moms } = require('../db/helpers');

const recipes = grocyAdapter.getRecipes();  // alle opskrifter (sellable=1 hvis !include_inactive)
const costs = db.prepare('SELECT * FROM recipe_cost_cache').all();
const targets = db.prepare('SELECT * FROM recipe_db_targets').all();
const prices = db.prepare(`
  SELECT item_id, price FROM item_prices
  WHERE item_type = 'recipe' AND price_category_id = ?
`).all(pcId);

// Sold-aggregat: revenue_incl_moms (unit_price er INCL moms — konverteres bagefter)
// Eksklusion: tilbud (is_offer=1) + interne (is_internal=1) — samme regel som rapporter
const soldRaw = db.prepare(`
  SELECT bl.grocy_recipe_id,
         SUM(bl.quantity) AS units,
         SUM(bl.quantity * bl.unit_price) AS revenue_incl_moms
  FROM bon_lines bl
  JOIN bons b ON b.id = bl.bon_id
  JOIN status_definitions s ON s.id = b.status_id
  WHERE b.delivery_date >= date('now', ?)
    AND s.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
    AND b.is_offer = 0
    AND b.is_internal = 0
    AND bl.grocy_recipe_id IS NOT NULL
  GROUP BY bl.grocy_recipe_id
`).all(`-${period_days} days`);

// Konverter til ex moms via helper — ALDRIG / 1.25 direkte
const sold = soldRaw.map(r => ({
  grocy_recipe_id: r.grocy_recipe_id,
  units: r.units,
  revenue_excl_moms: Moms.inclToExcl(r.revenue_incl_moms)
}));

// Periode-bucket-serie: GROUP BY bucket (uge for ≤90d, måned for >90d)
// 12 buckets, ældste først, nyeste sidst
const bucketSize = period_days <= 90 ? 'week' : 'month';
// ... (separat query med GROUP BY strftime)
```

### Kategori-mapping fra Grocy

Recipe-kategori kommer fra Grocy userfield `grupper` (preset-checklist).
Tag **første værdi** hvis flere — samme behandling som VarePicker bruger.
Hvis `grupper` er tom: kategori = `null`, ingen target-matching, vises i
egen "Ukategoriseret"-bucket i DB-mål-popoveren.

### `is_active` mapping

Grocy har ingen `is_active` på recipes (kun på products). Mapping er:
`is_active = (recipe.userfields.sellable === '1')`. Når `include_inactive=0`
filtreres på dette — matcher VarePickers gating.

### `POST /api/recipes/refresh-costs`

Manuel refresh af `recipe_cost_cache` fra Grocy fulfillment.

**Body:** ingen (refresher alle opskrifter)
**Response:** `{ refreshed: 63, duration_ms: 4120, refreshed_at: "..." }`
**Broadcast:** SSE-event `recipe_costs_refreshed`

Implementation: looper over alle Grocy-opskrifter, kalder
`grocyAdapter.getRecipeFulfillment(id)`, upserter i cache. Tag højde for
fejlende kald (single recipe-fejl må ikke afbryde batch).

### `PUT /api/item-prices`

Inline-redigering af salgspris fra drill-down.

**Body:**
```json
{
  "item_type": "recipe",             // 'recipe' | 'product' | 'local'
  "item_id": 42,                     // Grocy recipe_id når item_type='recipe'
  "price_category_code": "catering",
  "price_excl_moms": 95.00
}
```

**Response:** `{ ok: true, updated_at: "..." }`
**Changelog:** log via `logChange({ entity_type: 'item_prices', ... })`
**Broadcast:** SSE-event `item_price_updated` med samme felter

### `GET /api/recipes/targets`

Returnerer alle `recipe_db_targets` + alle Grocy-kategorier (også dem uden mål).
Frontend bruger denne til at populere DB-mål-popoveren — så admin ser
**hver kategori der faktisk findes i Grocy**, ikke en hardcoded liste.

**Response:**
```json
{
  "categories": ["01 Sandwich", "02 Salat", "03 Kager", ...],
  "targets": [
    { "category": "01 Sandwich", "target_pct": 65, "updated_at": "..." }
  ]
}
```

### `PUT /api/recipes/targets`

Bulk-upsert af mål pr. kategori (fra ⚙ DB-mål popoveren).
Kategorier der udelades fra body fjernes ikke — kun upsert.
For at fjerne et mål: brug `PUT` med `target_pct: null` ELLER nyt endpoint
`DELETE /api/recipes/targets/:category`.

**Body:**
```json
{
  "targets": [
    { "category": "01 Sandwich", "target_pct": 65 },
    { "category": "02 Salat",    "target_pct": 60 }
  ]
}
```

### `PATCH /api/recipes/targets/:category` (inline-edit fra drill-down)

Når brugeren redigerer DB-mål direkte fra drill-down (warning-banner →
"Mål for [01 Sandwich]: 65% [rediger]"), opdateres ét mål ad gangen.

**Body:** `{ "target_pct": 67 }`
**Response:** `{ ok: true, updated_at: "..." }`
**Broadcast:** SSE-event `recipe_targets_updated` (samme som bulk)

---

## Cache-strategi

- **Standalone-script** `scripts/refresh-recipe-costs.js` — bruger `openDb()`
  fra `db/compat.js` (CLAUDE.md-regel for standalone-scripts). Samme mønster
  som `scripts/booking-reminders.js` og `scripts/sync-v1.js`.
- **System-crontab** kører scriptet hver nat. Foreslået tidspunkt: **kl 03:00**
  (færdigt før folk møder ind, og før v1-sync kl 05). Cron-entry:
  ```
  0 3 * * * cd /opt/bon-v2 && node --experimental-sqlite scripts/refresh-recipe-costs.js >> logs/recipe-costs.log 2>&1
  ```
- **Manuel refresh-knap** i topbaren — `↻ Opdater fra Grocy` kalder
  `POST /api/recipes/refresh-costs` (kører samme logik som scriptet, in-process).
- **Per-recipe invalidering ved Grocy-ændring**: når en opskrift redigeres via
  `kitchen/recipes.html` designer-tab (eller andre Grocy CRUD-veje), sletter
  vi `recipe_cost_cache.grocy_recipe_id`-rækken. Hook i `grocyAdapter`:
  - `updateRecipe(id)` → invalidér `id`
  - `createRecipePosition({ recipe_id })` / `updateRecipePosition` /
    `deleteRecipePosition` → invalidér recipe_id der ejer positionen
  - `createRecipeNesting` / `deleteRecipeNesting` → invalidér parent_recipe_id
  Per-recipe sletning blokerer ikke parallelle opdateringer af andre opskrifter.
- **Stale-indikator:**
  - `< 48t`: ingen advarsel (normalt — nightly refresh er 21t gammel ved
    arbejdsdagens slut)
  - `48t–7d`: "for X dage siden" i grå
  - `> 7d`: "for X dage siden" i rødt + manuel refresh-knap blinker
- **Ingen live re-fetch ved sidevisning** — kun cache. Hurtigt og forudsigeligt.

---

## Filplacering

| Fil | Beskrivelse |
|---|---|
| `office/views/opskrifter.js` | View-modul (hovedtabel, KPI-strip, drill-down). Registreres i view-loaderen under navnet `'opskrifter'` |
| `office/views/opskrifter.css` | Stilark (sparkline, KPI-cards, drill-down panel) |
| `routes/recipes_overview.js` | API-endpoints (overview, refresh-costs, item-prices, targets) |
| `services/grocyAdapter.js` | `getRecipeFulfillment()` findes allerede. Tilføj `invalidateRecipeCost(recipeId)` der sletter cache-række. Hook ind i recipe-CRUD-funktioner. |
| `db/migrations/068_recipe_cost_cache_and_targets.sql` | Migration: recreate `item_prices` med `item_type` + nye tabeller `recipe_cost_cache` + `recipe_db_targets` |
| `scripts/refresh-recipe-costs.js` | Standalone Node-script, kaldes fra system-crontab kl 03:00 |
| `shared/api.js` | Wrappers: `fetchRecipesOverview()`, `refreshRecipeCosts()`, `putItemPrice()`, `fetchRecipeTargets()`, `putRecipeTargets()`, `patchRecipeTarget()` |

Sidebar-link og `SECTION_VIEW_MAP`-entry tilføjes i `office/index.html`
(se §Sidebar-placering ovenfor for konkrete kode-snippets).

---

## Frontend

### Hovedtabel

Vanilla JS, ingen Vue her. Følger `office/views/bons-list.js` som referencemønster.

**Kolonner:**
1. Opskrift (navn + kategori-undertekst + øko/inaktiv-badges)
2. Kostpris (ex moms)
3. Salgspris (ex moms, valgt priskategori)
4. DB kr (ex moms)
5. DB % (med farve: rød < target, grå/blå ok, grøn ≥ target+5)
6. Solgt — periode-trend (sparkline-mini-bars + tal — buckets matcher valgt periode)
7. Omsætning (ex moms, valgt periode)
8. CO₂e pr. enhed
9. CO₂ total (= CO₂e × solgte enheder i perioden — sortérbar)

**Rækkefarver (én ad gangen, prioritets-rækkefølge):**
- Mørk rød: **tabsgivende** (DB% < 0 — kostpris > salgspris). Subtil — ikke neon.
- Rød: under DB-mål
- Gul: mangler salgspris i valgt priskategori
- Grå: ikke solgt i perioden
- Reduceret opacity: inaktiv (sellable=0)

**Default sortering:** rækker under mål øverst, sorteret efter omsætning desc.
Konkret rangering:
1. Tabsgivende rækker (DB% < 0) sorteret efter omsætning desc
2. Under-mål rækker sorteret efter omsætning desc
3. Resten sorteret efter DB% asc

Det viser "her tjener vi mindst på det vi sælger mest af" først.
Klik på header toggler asc/desc. Indikator: ↕ / ↑ / ↓.

### KPI-strip (klikbare filtre)

7 klikbare KPI-cards som additive filtre + 2 info-only cards. **Andel under mål**
er primær KPI — vægtet gns. DB% kan maskere at én storsælger trækker tallet op.

| KPI | Type | Filter-action |
|---|---|---|
| Aktive opskrifter (47) | Filter | Default valgt |
| **Andel under mål** (17% — 8 af 47) | Filter+Info | Primær KPI. Klik = `under_target=true` |
| Tabsgivende (1) | Filter | `loss_making = true` — vises kun hvis count > 0 |
| Under DB-mål (8) | Filter | `under_target = true` |
| Mangler salgspris (3) | Filter | `sales_price = null` |
| Ikke solgt i perioden (11) | Filter | `sold_units = 0` |
| Økologiske (9) | Filter | `is_organic = true` |
| Gns. DB% (vægtet) | Info | — |
| Omsætning i perioden | Info | DB i kr i sub-tekst |

Aktive filtre: `--brand-primary-light` baggrund + brun ramme + ✓ i hjørnet.
"Ryd filtre"-pill vises kun når mere end default er aktivt.

**"Tabsgivende"-KPI'en vises kun når der ER tabsgivende opskrifter** —
ellers fylder den bare visuel plads med et nul.

### Drill-down side-panel (klik på række)

Åbner fra højre, 540px bred. Indhold:

1. **Warning-banner**:
   - Mørk rød + "⚠ TABSGIVENDE — kostpris over salgspris" hvis DB% < 0
   - Rød + "Under DB-mål" hvis under_target
   - Gul + "Mangler salgspris" hvis sales_price null
   - Grøn + "OK" hvis ingen issues
2. **Salgspriser (redigerbare)** — input pr. priskategori med live DB%-beregning,
   "Gem priser"-knap, "+ Tilføj priskategori"-link
3. **Inline DB-mål** — under warning-banneret:
   `Mål for [01 Sandwich]: 65% [rediger]`
   Klik på "rediger" → inline number-input → Gem opdaterer hele kategorien
   (alle opskrifter i kategorien re-evalueres mod nyt mål). Bruger SSE
   `recipe_targets_updated` til at re-rendere hovedtabel.
4. **Kostpris-breakdown** — tabel med ingredienser sorteret efter bidrag,
   top-bidrager fremhævet, link "→ Åbn i Grocy"
5. **Volumen i valgt periode** — bar-chart med toggle: **DB kr (default) / Solgt / Omsætning**.
   Samme buckets som sparklinen i tabellen. Default = DB kr fordi det er
   det viewet handler om.
6. **Metadata** — kategori, CO₂e pr. enhed, CO₂ total i perioden, øko, status, Grocy recipe ID

**"→ Åbn i Grocy"-link**: Backend-endpoint `GET /api/grocy/recipe-link/:id`
returnerer 302-redirect til `${GROCY_BASE_URL}/recipe/${id}`. Frontend kender
ikke Grocy-URL'en — den ligger i `.env`.

Genbrug `shared/modal.js`-mønster for åbne/luk-mekanik (backdrop + escape +
klik-uden-for). Selve indholdet er view-specifikt — ikke værd at abstrahere.

### Sparkline

Inline-component, ren CSS + dom (ingen lib).

- 60px × 18px, **12 buckets — bucket-størrelse matcher valgt periode**
  (≤90 dage = ugentlige buckets, >90 dage = månedlige)
- Hver bar: `flex:1` med `height` proportional til serien max
- Sidste bar: fuld `--brand-primary` (highlight "vi er nu")
- Tom serie (`sold_units = 0`): stiplet linje + "ingen salg" tekst
- Tooltip pr. bar: "Uge 23: 14 stk" eller "Maj 2026: 142 stk"

Skala: pr. opskrifts egen max. Sparkline'en sammenligner trend, ikke volumen
mellem opskrifter. Tallet ved siden af giver det absolutte mål for hele
perioden.

### Topbar-layout

```
[💰 Opskrifter & priser] [breadcrumb] [ALLE PRISER EX MOMS]
[Kostpriser opdateret for 2 dage siden] [↻ Opdater fra Grocy]
                                            [⚙ DB-mål pr. kategori]
```

DB-mål-knappen skal altid være yderst til højre, også når topbaren wrapper
på smal skærm. Brug `margin-left: auto` på højre-gruppen — ikke `<spacer>`-div
som ikke virker ved wrap.

---

## SSE-events

Nye events der broadcastes til alle office-klienter:

| Event | Payload | Trigger |
|---|---|---|
| `recipe_costs_refreshed` | `{ refreshed_at, count }` | Efter `POST /refresh-costs` |
| `item_price_updated` | `{ item_id, price_category_code, price_excl_moms }` | Efter `PUT /item-prices` |
| `recipe_targets_updated` | `{ targets: [...] }` | Efter `PUT /targets` |

Frontend abonnerer på alle tre og re-renderer relevante dele (ingen full reload).

---

## Auto-backfill: Grocy-salgspriser → item_prices

**Ingen manuelt script.** Backfill sker automatisk første gang viewet vises
for at undgå "Simon glemte at køre scriptet" → tomt view ved deploy.

**Flow:**

1. Ved `GET /api/recipes/overview` checker routen `settings.recipe_prices_backfilled`
2. Hvis `'0'` (eller mangler) → kør backfill-funktion **inden** response sendes
3. Backfill itererer alle Grocy-opskrifter:
   - For hver `Salesprice*`-userfield: `price_excl_moms = Moms.inclToExcl(parseFloat(value))`
   - Map userfield → price_category_code:
     - `SalespriceStore` → `store`
     - `SalespriceCatering` → `catering`
     - `SalespriceFestival` → `festival`
     - `SalespriceProduktion` → `produktion`
     - `SalespriceWaiste` → `waiste`
   - `INSERT OR IGNORE INTO item_prices (item_type, item_id, price_category_id, price)`
     (IGNORE så manuel redigering ikke overskrives ved repeat-kald)
4. Sæt `settings.recipe_prices_backfilled = '1'`
5. Returnér overview-response

**Idempotent:** Hvis flag allerede er `'1'`, springes backfill over.
**Force-rerun:** `POST /api/recipes/backfill?force=1` (admin-only) nulstiller
flag og kører backfill igen — bruges hvis Grocy-priser ændrer sig
markant i en migration. Bemærk at `INSERT OR IGNORE` betyder manuel redigerede
priser i `item_prices` IKKE overskrives. Brug `force=2` for at også overskrive.

**Helper:** `services/itemPriceBackfill.js` — `backfillIfNeeded()` + `runBackfill(force)`.

---

## To-vejs sync: Grocy er master (juni 2026)

Backfillen ovenfor var oprindelig et engangs-løft, hvorefter `item_prices` var
**frakoblet** Grocy: redigeringer i viewet landede kun lokalt, og Grocy-prisændringer
slog ikke igennem i analysen — mens VarePicker fortsat solgte til Grocy-priserne.
Det er lukket med to mekanismer (Grocy er altid master):

1. **Write-back** — `PUT /api/item-prices` (item_type='recipe') skriver FØRST til
   Grocy-userfieldet (`Moms.exclToIncl(price)` — §6b: Salesprice* er incl moms) via
   `grocyAdapter.updateRecipeUserfields()`. Fejler Grocy → 503, og der gemmes INTET
   lokalt, så de to aldrig divergerer. item_type 'product'/'local' er fortsat lokale.
2. **Pull-sync** — `syncPricesFromGrocy(rawRecipes)` i `itemPriceBackfill.js` kaldes
   fra både `POST /api/recipes/refresh-costs` og nightly `scripts/refresh-recipe-costs.js`.
   Upsert'er Grocy → item_prices (kun rækker der reelt afviger, så `updated_at` ikke
   churner), sletter rækker hvis prisen er fjernet/0 i Grocy. `updated_by_user_id`
   sættes NULL ved sync-skrivninger ("kom fra Grocy").

**Deploy-engangstrin:** kør `scripts/reconcile-item-prices.js` (dry-run) FØR første
refresh efter deploy — den lister rækker hvor item_prices afviger fra Grocy.
`--push` = view-redigeringer var de rigtige (lokal → Grocy), `--pull` = Grocy var
den rigtige. `updated_by_user_id` kan IKKE bruges til at skelne manuel/backfill
(backfillen stemplede også bruger-id).

**Kendt fix samme omgang:** `scripts/refresh-recipe-costs.js` kaldte `openDb()` uden
sti-argument og crashede derfor altid (cron-jobbet har aldrig kunnet køre). Rettet
til `openDb(process.env.DB_PATH)`.

---

## Implementeringsrækkefølge

1. **Migration 068** — recreate `item_prices` med `item_type` + ny `recipe_cost_cache` + ny `recipe_db_targets` (uden seed)
2. **`services/itemPriceBackfill.js`** — auto-backfill helper
3. **`services/grocyAdapter.js`** — `invalidateRecipeCost(id)` + hook i CRUD-funktioner
4. **`routes/recipes_overview.js`** — alle endpoints (overview, refresh-costs, item-prices, targets bulk+patch, backfill, grocy-recipe-link)
5. **`scripts/refresh-recipe-costs.js`** — standalone, kaldes fra crontab
6. **`shared/api.js`** — wrappers
7. **`office/views/opskrifter.js` + CSS** — UI
8. **Sidebar-link** i `office/index.html` (linje 616) + `SECTION_VIEW_MAP` (linje 967)
9. **SSE-events** wired ind i endpoints
10. **Test-data** — verificér at `bon_lines.grocy_recipe_id` er udfyldt på seed-bons (ellers ingen sold-data)
11. **Crontab-entry på deploy** — `0 3 * * *` (færdigt før folk møder ind, før v1-sync kl 05)

---

## Test-kommandoer

```bash
# Refresh cache
curl -X POST http://localhost:4321/api/recipes/refresh-costs \
  -H "Cookie: session=..."

# Hent overview
curl "http://localhost:4321/api/recipes/overview?price_category=catering&period_days=90" \
  -H "Cookie: session=..." | jq

# Opdater salgspris
curl -X PUT http://localhost:4321/api/item-prices \
  -H "Content-Type: application/json" -H "Cookie: session=..." \
  -d '{"item_id":42,"price_category_code":"catering","price_excl_moms":95}'

# Tjek SSE-events
curl -N http://localhost:4321/api/sse -H "Cookie: session=..."
```

---

## Åbne punkter

| Punkt | Status |
|---|---|
| Mockup v3 godkendt | ✅ |
| Sidebar-placering under Økonomi | ✅ |
| Moms-doktrin afklaret (revenue konverteres via `Moms.inclToExcl()` efter SUM) | ✅ |
| `item_prices` udvidet med `item_type`-kolonne | ✅ Migration 068 |
| Auto-backfill første gang viewet vises (ingen manuelt script) | ✅ |
| Cron-mønster: standalone-script + system-crontab | ✅ `scripts/refresh-recipe-costs.js`, kl 03:00 |
| Per-recipe cache-invalidering ved Grocy-CRUD | ✅ Hook i `grocyAdapter` |
| `recipe_db_targets` uden hardcoded seed (kategorier fra Grocy) | ✅ |
| `is_active` = `sellable === '1'` (Grocy har ingen native is_active på recipes) | ✅ |
| Tilbud + interne bons ekskluderes (samme som rapporter) | ✅ |
| Sparkline-buckets matcher valgt periode | ✅ |
| `bon_v2_zoner_og_layout.md` §4 patch (tilføj punkt) | ⏳ Apply ved samme PR |
| Test-data: `bon_lines.grocy_recipe_id` på seed | ⏳ Verificér før første test |
| T_OPSKRIFTER.md test-spec | ⏳ Skrives parallelt med implementation |

---

## Reference til mockup

`opskrifter_margin_v3.html` (i Claude.ai-projektet) viser alle UI-elementer
inkl. KPI-filtre, sparkline-design, drill-down med chart-toggle, DB-mål
popover og refresh-knap.
