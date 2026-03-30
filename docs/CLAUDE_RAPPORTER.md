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
│  Månedsoversigt (tabel, fuld bredde)                    │
└─────────────────────────────────────────────────────────┘
```

SPA-view i office-shell: `mountRapporter(container)`.

---

## 1. API-endpoints

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
WHERE sd.code IN ('FAKTURERET','BETALT','AFSLUTTET')
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
WHERE sd.code IN ('FAKTURERET','BETALT','AFSLUTTET')
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
WHERE sd.code IN ('FAKTURERET','BETALT','AFSLUTTET')
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
JOIN price_categories pc ON pc.id = b.price_category_id
JOIN status_definitions sd ON sd.id = b.status_id
WHERE sd.code IN ('FAKTURERET','BETALT','AFSLUTTET')
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
      GET /api/reports/monthly-table
    ])
  → render alle sektioner parallelt
```

Vis loading-skeleton mens data hentes (grå pladsholder-blokke).

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

Byg med `<canvas>` og **Chart.js** (allerede i projektet? tjek — ellers brug SVG-bars uden dependency).

- 12 søjle-par (dette år + forrige år side om side)
- Farver: `--brown` for dette år, `--gray` (dæmpet) for forrige år
- Indeværende måned: stribet/transparent søjle (MTD, ufærdig)
- Toggle øverst til højre: **Kr / Enh** — skifter y-akse
- Hover tooltip: måned, beløb, antal ordrer

Hvis Chart.js ikke er tilgængeligt: byg med SVG-søjler (se dashboard-pattern).

### Top kunder

Liste med rank, displaynavn, vandret bar (relativ til #1 = 100%), beløb.

Toggle øverst: **Omsætning / Ordrer** — kalder `/api/reports/top-customers?by=orders`
og re-renderer listen uden fuld reload.

### Priskategori-fordeling

**Stacked bar** øverst — én vandret bjælke opdelt i segmenter:
- Farver fra `price_categories` (brug samme farver som dashboard legoklods):
  - Store: `#4a3728`
  - Catering: `#c4922a`
  - Festival: `#5a8a3a`
  - Produktion: `#4a7ab0`
  - Waiste: `#b0aca8`

Under bar: tabel med kategori, enheder, andel %, delta vs. forrige år.

### Månedsoversigt (tabel)

Kolonner: Måned | Omsætning | vs. 2024 | Ordrer | Enheder | Gns. ordreværdi | Ufaktureret

- Indeværende måned fed + MTD-badge
- Delta-kolonne: grøn/rød med pil
- Ufaktureret-kolonne: orange tekst hvis > 0, dash ellers
- Klik på en måned-række: ingen handling i MVP (kan udvides senere)

---

## 3. Hvad der IKKE skal bygges nu

- Eksport til CSV/Excel
- Custom datointerval-vælger
- Per-lokation filtrering (HQ vs Trailer)
- Produktkategori-drill-down
- Kunde-detalje ved klik

---

## 4. Filplacering

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

## 5. Test

Manuel smoke-test:
1. Load `/office/` → klik Rapporter
2. Alle 4 KPI-kort viser tal (ikke 0 med mindre seed-data er tom)
3. Bar chart renderer 12 måneder — ingen JS-fejl i console
4. Toggle Kr/Enh skifter y-akse
5. Top kunder viser navne — toggle Omsætning/Ordrer ændrer rækkefølge
6. Kategori-bar summer til ~100%
7. Månedstabel: indeværende måned er fed med MTD-badge
8. Alle delta-værdier er grønne/røde korrekt (ikke altid grønne)

---

## 6. Prioritering inden for fasen

1. `routes/reports.js` med alle 5 endpoints + SQL
2. KPI-strip + månedstabel (nok til at se om data er rigtig)
3. Bar chart
4. Top kunder med toggle
5. Kategori-fordeling
