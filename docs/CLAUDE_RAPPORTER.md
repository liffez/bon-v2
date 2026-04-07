# Fase: Rapporter (`office/views/rapporter.js`)

> Læs `docs/BON_V2_PRINCIPPER.md`, `docs/bon_v2_datamodel_v2.md` og `docs/bon_v2_zoner_og_layout.md` før du starter.

---

## Mål

Historisk og fremadrettet omsætningsoverblik i office-zonen. Uddyber hvad dashboardet
allerede viser — men med længere tidshorisont, top-kunder og kategorifordeling.

Dashboardet har: MTD omsætning, 10-dages legoklods, top produkter (månedlig).
Rapporter tilføjer: 12 måneder bagud, år-til-dato vs. forrige år, top kunder, kategorifordeling, månedstabel.

Mockup-reference: første `oekonomi_mockup.html` — fanen "Rapporter".

Al data beregnes med SQL-queries direkte på `bons` + `bon_lines`. Ingen ny tabel.

---

## Layout

```
┌─────────────────────────────────────────────────────────┐
│  KPI-strip (4 kort)                                     │
├───────────────────────────────────────────────────────  │
│  Månedsomsætning (bar chart, fuld bredde)               │
├──────────────────────────┬──────────────────────────────┤
│  Top kunder              │  Priskategori-fordeling      │
├───────────────────────────────────────────────────────  │
│  Lego-model (måneds-toggle + søjler, fuld bredde)       │
├───────────────────────────────────────────────────────  │
│  Akkumuleret kurve (multi-år, fuld bredde)              │
├──────────────────────────┬──────────────────────────────┤
│  Top kategorier          │  Månedsoversigt (tabel)      │
└─────────────────────────────────────────────────────────┘
```

SPA-view i office-shell: `mountRapporter(container)`.

---

## Vigtige regler for alle queries

Alle omsætnings-/ordre-queries i denne rapport SKAL:

1. **Inkludere LEVERET** i status-filter: `sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')`
   (Beslutning: LEVERET medtages i omsætningstal — mange bons ligger længe i LEVERET før fakturering)
2. **Ekskludere tilbud**: `AND COALESCE(b.is_offer, 0) = 0`
3. **Ekskludere interne ordrer**: `AND COALESCE(b.is_internal, 0) = 0`
4. **Join price_categories via TEXT-kode** (ikke id): `pc.code = b.price_category` (kolonnen er `price_category TEXT`, ikke `price_category_id`)
5. **Brug custom canvas chart** (som dashboard-legoklodsen) — **IKKE Chart.js** (fjernet fra projektet)
6. **Revenue = linje-sum**: `SUM(bl.quantity * bl.unit_price)` — IKKE `b.total_price`.
   Dashboard bruger `b.total_price`, men rapporter skal bruge linje-sum for præcision (undgår afrunding/leveringsgebyr).

---

## Genbrug fra eksisterende kode

### `shared/dashboard_chart.js` — genbrug disse funktioner direkte

| Funktion | Hvad den gør | Brug i rapporter |
|----------|-------------|-----------------|
| `CATS` | Farvepalette `{ Store: '#6d4c16', Catering: '#c49a45', ... }` | Alle charts + stacked bars |
| `fmtKr(v)` | Formatterer tal til `12k`, `345k` | Y-akse labels, tooltips |
| `rrect(ctx, x, y, w, h, r)` | Tegner rounded rectangle | Søjler i alle bar charts |
| `initDashboardChart(canvasId, data, opts)` | Fuld bar chart med mode-toggle, last-year, tooltip | Månedsomsætning chart |
| `initAccumChart(canvasId, mainId, data, opts)` | Akkumuleret area chart | Akkumuleret kurve (udvid til multi-år) |

**Vigtigt:** Udvid eksisterende funktioner hvis nødvendigt — opret IKKE parallelle chart-funktioner.
Hvis `initDashboardChart` ikke kan bruges direkte til måneds-chartet, tilføj options til den eksisterende funktion.

### `office/views/dashboard.js` — genbrug disse CSS-klasser

| Klasse | Hvad | Genbrug |
|--------|------|---------|
| `.kpi-card` | KPI-kort med heading + tal | KPI-strip |
| `.delta-up` / `.delta-down` / `.delta-flat` | Grøn/rød/grå delta-badge | Alle delta-visninger |
| `.chart-toggle` | Kr/Enh toggle-knapper | Mode-toggle på charts |

Disse klasser er defineret i `office/views/dashboard.js` inline styles eller `components.css`.
Rapporter skal genbruge dem — ikke definere nye.

---

## Forudsætninger / migration

### Migration: `price_categories.sort_order`

`price_categories`-tabellen mangler `sort_order`-kolonnen. Tilføj migration:

```sql
-- db/migrations/026_price_category_sort_order.sql
ALTER TABLE price_categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE price_categories SET sort_order = 1 WHERE code = 'store';
UPDATE price_categories SET sort_order = 2 WHERE code = 'catering';
UPDATE price_categories SET sort_order = 3 WHERE code = 'festival';
UPDATE price_categories SET sort_order = 4 WHERE code = 'produktion';
UPDATE price_categories SET sort_order = 5 WHERE code = 'waiste';
```

Bruges i lego-queryen (`ORDER BY pc.sort_order`).

### Seed-data: `unit_price` mangler på bon_lines

Nuværende seed indsætter bon_lines UDEN `unit_price` og `line_total`.
Alle revenue-queries vil returnere 0 med testdata.

**Krav:** Opdater `db/seed.js` så alle bon_lines får `unit_price` (fra Grocy userfields)
og `line_total = quantity * unit_price`.

### Dashboard `is_offer`/`is_internal` filtre

Dashboard (`routes/dashboard.js`) filtrerer IKKE på `is_offer` eller `is_internal`.
Bør rettes samtidig med rapporter — ellers viser dashboard og rapporter forskellige tal.

---

## 1. API-endpoints (8 endpoints)

Alle nye endpoints samles i `routes/reports.js`. Montér i `server.js`:
```javascript
const reportsRouter = require('./routes/reports');
app.use('/api/reports', reportsRouter);
```

### GET /api/reports/summary

KPI-strip øverst. Returnerer YTD-tal + sammenligning med forrige år.

```sql
-- Omsætning YTD (ekskl. AFLYST, kun terminal statusser med beløb)
SELECT
  SUM(bl.quantity * bl.unit_price) AS revenue_ytd,
  COUNT(DISTINCT b.id)             AS orders_ytd
FROM bons b
JOIN bon_lines bl ON bl.bon_id = b.id
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
  AND COALESCE(b.is_offer, 0) = 0
  AND COALESCE(b.is_internal, 0) = 0
  AND strftime('%Y', b.delivery_date) = strftime('%Y', 'now')

-- Samme for forrige år (byt 'now' med date('now','-1 year'))
```

Response:
```json
{
  "revenue_ytd":       387200,
  "revenue_ytd_prev":  345800,
  "orders_ytd":        84,
  "orders_ytd_prev":   76,
  "avg_order_value":   4610,
  "avg_order_prev":    4550,
  "pending_invoice":   68450,
  "pending_count":     7
}
```

### GET /api/reports/monthly

12 måneders omsætning + enheder, dette år og forrige år.

Query param: `?metric=revenue` (default) eller `?metric=units`

```sql
SELECT
  strftime('%Y-%m', b.delivery_date) AS month,
  SUM(bl.quantity * bl.unit_price)   AS revenue,
  SUM(bl.quantity)                   AS units,
  COUNT(DISTINCT b.id)               AS orders
FROM bons b
JOIN bon_lines bl ON bl.bon_id = b.id
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
  AND COALESCE(b.is_offer, 0) = 0
  AND COALESCE(b.is_internal, 0) = 0
  AND b.delivery_date >= date('now', '-12 months')
GROUP BY month
ORDER BY month ASC
```

Kør samme query for forrige år (offset -24 months til -12 months).

Response:
```json
{
  "this_year": [
    { "month": "2025-04", "revenue": 28400, "units": 980, "orders": 9 },
    ...12 måneder
  ],
  "prev_year": [
    { "month": "2024-04", "revenue": 24100, "units": 870, "orders": 8 },
    ...
  ]
}
```

### GET /api/reports/top-customers

Top 10 kunder YTD efter omsætning eller ordreantal.

Query param: `?by=revenue` (default) eller `?by=orders`

```sql
SELECT
  c.id,
  c.first_name || ' ' || c.last_name AS customer_name,
  co.name                             AS company_name,
  SUM(bl.quantity * bl.unit_price)    AS revenue,
  COUNT(DISTINCT b.id)                AS orders
FROM bons b
JOIN bon_lines bl ON bl.bon_id = b.id
JOIN customers c  ON c.id = b.customer_id
LEFT JOIN companies co ON co.id = b.company_id
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
  AND COALESCE(b.is_offer, 0) = 0
  AND COALESCE(b.is_internal, 0) = 0
  AND strftime('%Y', b.delivery_date) = strftime('%Y', 'now')
GROUP BY b.customer_id
ORDER BY revenue DESC
LIMIT 10
```

Response:
```json
{
  "by": "revenue",
  "customers": [
    {
      "id": 7,
      "display_name": "Novo Nordisk A/S",
      "revenue": 89400,
      "orders": 22,
      "pct_of_total": 23
    }
  ]
}
```

`display_name`: brug `company_name` hvis udfyldt, ellers `customer_name`.
`pct_of_total`: beregn server-side (kunde_revenue / total_ytd * 100).

### GET /api/reports/categories

Priskategori-fordeling YTD.

```sql
SELECT
  pc.code,
  pc.label,
  SUM(bl.quantity)                 AS units,
  SUM(bl.quantity * bl.unit_price) AS revenue
FROM bons b
JOIN bon_lines bl       ON bl.bon_id = b.id
JOIN price_categories pc ON pc.code = b.price_category
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
  AND COALESCE(b.is_offer, 0) = 0
  AND COALESCE(b.is_internal, 0) = 0
  AND strftime('%Y', b.delivery_date) = strftime('%Y', 'now')
GROUP BY pc.code
ORDER BY units DESC
```

Inkluder forrige år til delta-beregning (samme query, andet årstal).

Response:
```json
{
  "this_year": [
    { "code": "catering", "label": "Catering", "units": 980, "revenue": 245000, "pct": 37 }
  ],
  "prev_year": [
    { "code": "catering", "label": "Catering", "units": 905, "revenue": 221000, "pct": 35 }
  ]
}
```

### GET /api/reports/monthly-table

Tabelvisning — alle KPI'er per måned, seneste 12 måneder.

```json
{
  "rows": [
    {
      "month_label": "Marts 2026",
      "is_current": true,
      "revenue_this": 43000,
      "revenue_prev": 38500,
      "delta_pct": 12,
      "orders": 14,
      "units": 556,
      "avg_order_value": 3071,
      "pending_invoice": 68450
    }
  ]
}
```

`is_current: true` → indeværende måned (MTD), markeres i tabellen.
`pending_invoice` → kun udfyldt for nuværende og evt. forrige måned hvis der stadig afventer.

---

## 2. Frontend — `office/views/rapporter.js`

### Init-flow

```
mountRapporter(container)
  → render skeleton HTML
  → Promise.all([
      GET /api/reports/summary,
      GET /api/reports/monthly,
      GET /api/reports/top-customers,
      GET /api/reports/categories,
      GET /api/reports/monthly-table,
      GET /api/reports/lego,           ← default: alle måneder
      GET /api/reports/cumulative,     ← default: 3 år
      GET /api/reports/top-categories
    ])
  → render alle sektioner parallelt
```

Vis loading-skeleton mens data hentes (grå pladsholder-blokke).

Lego + cumulative hentes lazy ved scroll (eller ved init hvis viewport er stort nok).

### KPI-strip

Fire kort i en række:

| Kort | Felt | Delta |
|------|------|-------|
| Omsætning YTD | `revenue_ytd` formateret | vs. forrige år i % |
| Ordrer YTD | `orders_ytd` | vs. forrige år absolut |
| Gns. ordreværdi | `avg_order_value` formateret | vs. forrige år i % |
| Ufaktureret pipeline | `pending_invoice` formateret | `pending_count` bonner |

Delta-farve: grøn hvis positiv, rød hvis negativ.

### Månedsomsætning (bar chart)

Byg med custom `<canvas>` (samme mønster som `shared/dashboard_chart.js` legoklods-chart — **IKKE Chart.js**).

- 12 søjle-par (dette år + forrige år side om side)
- Farver: `--brown` for dette år, `--gray` (dæmpet) for forrige år
- Indeværende måned: stribet/transparent søjle (MTD, ufærdig)
- Toggle øverst til højre: **Kr / Enh** — skifter y-akse
- Hover tooltip: måned, beløb, antal ordrer

### Top kunder

Liste med rank, displaynavn, vandret bar (relativ til #1 = 100%), beløb.

Toggle øverst: **Omsætning / Ordrer** — kalder `/api/reports/top-customers?by=orders`
og re-renderer listen uden fuld reload.

### Priskategori-fordeling

**Stacked bar** øverst — én vandret bjælke opdelt i segmenter:
- Farver: brug `CATS` fra `shared/dashboard_chart.js` (importér, ikke kopier):
  - Store: `#6d4c16`
  - Catering: `#c49a45`
  - Festival: `#7a9c54`
  - Produktion: `#7594b3`
  - Waiste: `#c8c2bb`

Under bar: tabel med kategori, enheder, andel %, delta vs. forrige år.

### Månedsoversigt (tabel)

Kolonner: Måned | Omsætning | vs. 2024 | Ordrer | Enheder | Gns. ordreværdi | Ufaktureret

- Indeværende måned fed + MTD-badge
- Delta-kolonne: grøn/rød med pil
- Ufaktureret-kolonne: orange tekst hvis > 0, dash ellers
- Klik på en måned-række: ingen handling i MVP (kan udvides senere)

---

---

## 3. Lego-model med måneds-sammenligning

Det vigtigste rapporterings-værktøj. Inspireret af Excel-dashboardet.

### Koncept

Vælg én eller flere måneder → se antal ordrer + omsætning per priskategori-søjle
for de valgte måneder, sammenlignet automatisk med samme måneder forrige år.

```
┌─────────────────────────────────────────────────────────┐
│  Vælg måneder:                                          │
│  [Jan] [Feb] [Mar] [Apr] [Maj] [Jun]                    │
│  [Jul] [Aug] [Sep] [Okt] [Nov] [Dec]                    │
│                          [Nulstil] [Samme periode 2024] │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ANTAL ORDRER                  OMSÆTNING KR             │
│                                                         │
│  [Store]  [Catering] [Fest.]   [Store] [Cat.] [Fest.]   │
│    88         3                  ...                    │
│   2025  2024                                            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

Hver priskategori vises som to søjler side om side: dette år (brun) og forrige år (grå).

### API: GET /api/reports/lego

```
Query params:
  ?months=1,2,3        → kommasepareret liste af månedsnumre (1=jan)
  ?year=2025           → (default: indeværende år)
```

```sql
SELECT
  pc.code,
  pc.label,
  COUNT(DISTINCT b.id)             AS orders,
  SUM(bl.quantity)                 AS units,
  SUM(bl.quantity * bl.unit_price) AS revenue
FROM bons b
JOIN bon_lines bl        ON bl.bon_id = b.id
JOIN price_categories pc ON pc.code = b.price_category
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
  AND COALESCE(b.is_offer, 0) = 0
  AND COALESCE(b.is_internal, 0) = 0
  AND CAST(strftime('%m', b.delivery_date) AS INTEGER) IN (?,?,?)  -- måneder
  AND strftime('%Y', b.delivery_date) = ?                          -- år
GROUP BY pc.code
ORDER BY pc.sort_order  -- kræver migration 026
```

Kør samme query for forrige år og returner begge:

```json
{
  "months": [1, 2, 3],
  "year": 2025,
  "this_year": [
    { "code": "store",    "label": "Store",    "orders": 88, "units": 3200, "revenue": 180000 },
    { "code": "catering", "label": "Catering", "orders": 3,  "units": 240,  "revenue": 24000  }
  ],
  "prev_year": [
    { "code": "store",    "label": "Store",    "orders": 79, "units": 2900, "revenue": 158000 },
    { "code": "catering", "label": "Catering", "orders": 2,  "units": 180,  "revenue": 18500  }
  ]
}
```

### Frontend-logik

- Måneds-toggles: klik = toggle måneden til/fra, vælges med highlight
- "Nulstil" → ingen måneder valgt → vis hele året (alle 12)
- Ved skift: debounce 200ms → kald `/api/reports/lego` → re-render søjler
- Toggle øverst: **Ordrer / Omsætning / Enheder** — skifter y-akse
- Søjle-farver: brug samme farvepalette som dashboard-legoklodsen

---

## 4. Akkumuleret omsætningskurve (multi-år)

Linjekurve der viser akkumuleret omsætning uge for uge gennem året,
med separate linjer per år (2023, 2024, 2025).

Visuelt: man kan øjeblikkeligt se om man er foran eller bagud ift. forrige år
på samme tidspunkt.

**Genbrug:** `initAccumChart()` fra `shared/dashboard_chart.js` tegner allerede en
akkumuleret area chart. Udvid den med en `multiYear`-option der accepterer et objekt
med flere år-serier i stedet for et enkelt dataset. Indeværende år = fed linje,
forrige år = tyndere stiplede linjer.

### API: GET /api/reports/cumulative

```
Query params:
  ?years=2023,2024,2025   → hvilke år der skal med (default: indeværende + 2 forrige)
```

```sql
-- For hvert år: akkumuleret omsætning per uge
SELECT
  strftime('%W', b.delivery_date) AS week_nr,
  SUM(SUM(bl.quantity * bl.unit_price))
      OVER (ORDER BY strftime('%W', b.delivery_date)) AS cumulative_revenue
FROM bons b
JOIN bon_lines bl ON bl.bon_id = b.id
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
  AND COALESCE(b.is_offer, 0) = 0
  AND COALESCE(b.is_internal, 0) = 0
  AND strftime('%Y', b.delivery_date) = ?
GROUP BY week_nr
ORDER BY week_nr
```

Response:
```json
{
  "years": {
    "2023": [ { "week": 1, "cumulative": 12400 }, { "week": 2, "cumulative": 28100 }, ... ],
    "2024": [ ... ],
    "2025": [ ... ]
  }
}
```

Indeværende år stopper ved seneste uge med data — de øvrige år fortsætter til uge 52.
Indeværende år vises med fed linje, forrige år med tyndere stiplede linjer.

---

## 5. Top produkter — kategoriseret

I stedet for kun enkeltprodukter: vis aggregeret per `bon_lines.category`
(snapshot-feltet der matcher Grocys produktkategori).

### API: GET /api/reports/top-categories

```sql
SELECT
  COALESCE(bl.category, 'Uden kategori') AS category,
  SUM(bl.quantity)                         AS units,
  ROUND(100.0 * SUM(bl.quantity) /
    SUM(SUM(bl.quantity)) OVER (), 2)      AS pct
FROM bons b
JOIN bon_lines bl ON bl.bon_id = b.id
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('LEVERET','FAKTURERET','BETALT','AFSLUTTET')
  AND COALESCE(b.is_offer, 0) = 0
  AND COALESCE(b.is_internal, 0) = 0
  AND strftime('%Y', b.delivery_date) = strftime('%Y', 'now')
GROUP BY category
ORDER BY units DESC
LIMIT 10
```

Vises som vandret bar-liste (samme mønster som top-kunder):
```
01 Sandwich   ████████████████  6237   76%
02 Salat      ██                  39    0%
04 Slider     █████             2015   25%
```

---

## 6. Km / leveringsafstand (FASE 2 — ikke nu)

Kræver at `geo_calculations` er befolket af logistik-modulet.
Tilføjes til rapporter når `delivery_events` + `geo_calculations` er i brug.

Planlagt indhold:
- Total km kørt per leveringstype (RR intern vs. Byekspressen vs. Taxa)
- Gennemsnit km per levering
- Månedlig km-udvikling

Data-kilde:
```sql
SELECT
  de.provider,
  SUM(gc.distance_meters) / 1000.0 AS total_km,
  COUNT(*)                          AS leveringer
FROM delivery_events de
JOIN geo_calculations gc ON gc.bon_id = de.bon_id
WHERE de.event_type = 'delivered'
GROUP BY de.provider
```

---

## 7. Hvad der IKKE skal bygges nu

- Eksport til CSV/Excel
- Custom datointerval-vælger
- Per-lokation filtrering (HQ vs Trailer)
- Kunde-detalje ved klik
- Km-rapport (venter på logistik-modul)

---

## 8. Filplacering

```
office/views/rapporter.js     ← mount-funktion + al logik
office/views/rapporter.css    ← styles
routes/reports.js             ← alle /api/reports/* endpoints
```

Tilføj til `server.js`:
```javascript
const reportsRouter = require('./routes/reports');
app.use('/api/reports', reportsRouter);
```

Tilføj til office navigation i `office/index.html`:
```html
<a class="sidebar-item" data-view="rapporter" href="#">
  <span class="icon">📋</span> Rapporter
</a>
```

---

## 9. Test

Manuel smoke-test:
1. Load `/office/` → klik Rapporter
2. Alle 4 KPI-kort viser tal
3. Lego-model: ingen måneder valgt → viser hele året → klik "Mar" → data opdateres
4. Klik "Mar" + "Apr" → begge måneder aggregeres → forrige år vises ved siden af
5. Toggle Ordrer/Omsætning/Enheder skifter søjlerne
6. Akkumuleret kurve: 3 linjer, indeværende år stopper ved seneste uge
7. Top kunder toggle Omsætning/Ordrer ændrer rækkefølge
8. Top kategorier summer til ~100%
9. Månedstabel: indeværende måned er fed med MTD-badge
10. Delta-værdier er grønne/røde korrekt

---

## 10. Prioritering inden for fasen

1. `routes/reports.js` — alle endpoints + SQL
2. KPI-strip + månedstabel (verificér data er korrekt)
3. Lego-model med måneds-toggles (mest værdifuldt)
4. Akkumuleret kurve
5. Top kunder + top kategorier
6. Priskategori stacked bar
