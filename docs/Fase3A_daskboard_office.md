**6. `office/views/dashboard.js`** — Office Dashboard

Fil: `office/views/dashboard.js` (loades dynamisk af `office/index.html`)
Reference-mockup: `office_dashboard.html` (ligger i projektmappen)

---

### Layout

Desktop. Sidebar (200px) + main-kolonne. Ingen scroll på main — alt i viewport.
```
┌─ SIDEBAR 200px ─┬─────────────── MAIN ──────────────────────────┐
│ Logo            │ TOPBAR: titel · dato · vagt-pills · vejr       │
│ Nav-grupper     ├───────────────────────────────────────────────┤
│ (se sidebar-    │ KPI-STRIP (4 kort, full width)                 │
│  struktur i     ├──────────────────────┬────────────────────────┤
│  zoner_og_      │ GRAF (legoklods      │ I DAG (klikbar →       │
│  layout.md)     │ + toggle + grå linje)│  today.html)           │
│                 │                      │ PREP I MORGEN (klikbar │
│ Bruger nederst  │                      │  → later.html)         │
│                 ├──────────────────────┼────────────────────────┤
│                 │ TOP PRODUKTER        │ CRM PLACEHOLDER        │
└─────────────────┴──────────────────────┴────────────────────────┘
```

---

### Sidebar

Statisk HTML i `office/index.html` — ikke en del af det dynamisk loadede view.
Struktur og nav-punkter: se `bon_v2_zoner_og_layout.md` sektion 4.
Aktiv side markeres med `border-left: 3px solid var(--brand-primary-light)`.
Bruger-sektion nederst: avatar (initialer) + navn + rolle fra session.

---

### Topbar

- Titel: "Dashboard"
- Dato: formateret dansk, fx "Mandag 16. marts 2026"
- Vagt-pills: samme mønster som kitchen-dashboardet.
  Avatar (brun baggrund) + fornavn + "07–15". Hover tooltip: fuldt navn + tid.
  ≤3 = individuelle pills. >3 = tæller-badge med hover-liste.
- Vejr-chip: samme Open-Meteo-kald som kitchen (`latitude=55.70&longitude=12.55`).
  WMO-ikon + temp + "København". Stille fejl.

---

### KPI-strip
```
GET /api/bons?status=LEVERET,FAKTURERET,AFSLUTTET,BETALT&from=MONTH_START&to=TODAY
```

Fire kort:

| Kort | Beregning | Farve ved advarsel |
|---|---|---|
| Omsætning · marts MTD | `SUM(total_price)` på leverede/fakturerede bons denne måned | — |
| Enheder · marts MTD | `SUM(total_units)` samme filter | — |
| Åbne bons | COUNT bons med status NY/VENTER/GODKENDT/IGANG/KLAR | orange hvis >15 |
| Ufaktureret | `SUM(total_price)` på bons med status LEVERET | orange hvis >0 |

**Sammenligning med forrige år:**
```
GET /api/bons?status=LEVERET,...&from=LAST_YEAR_MONTH_START&to=LAST_YEAR_TODAY
```
Beregn delta i % og vis som badge: `↑ 12% vs. 2025` (grøn) / `↓ 8% vs. 2025` (rød) / `→ ±0%` (grå).
Threshold: delta < 2% = grå.

---

### Legoklods-graf med toggle

Samme rendering-logik som `kitchen/index.html` (se opgave 5).

**Toggle `[ Enheder | Kr ]`:**
- Enheder: Y-akse = `total_units`, klods-højde = bon's `total_units`
- Kr: Y-akse = `total_price`, klods-højde = bon's `total_price`
- Toggle sidder i kortets header, højre side
- Ved toggle: genrender canvas + opdater Y-akse labels + opdater tooltip + opdater top-produkter-tabel

**Grå overlay-linje (forrige år):**
```
GET /api/bons?from=LAST_YEAR_MINUS4&to=LAST_YEAR_PLUS5
```
Aggreger pr. dag (samme ugedag, -1 år). Tegnes som stiplet grå linje (`rgba(180,170,160,0.55)`, `lineWidth=1.5`, `setLineDash([3,4])`). Label "2025" ved slutpunktet.
Fallback: hvis ingen data for forrige år, tegnes linjen ikke (stille).

**Data:**
```
GET /api/bons?from=MINUS_4_DAYS&to=PLUS_5_DAYS
```
10 dage: 4 historik + i dag + 5 frem. Historik: 0.65 alpha.

**Staff-badges:** samme logik som kitchen. Samme STAFF-data fra Smartplan.

**Legend:** samme som kitchen.

---

### I dag + Prep i morgen (højre kolonne)

Identisk med kitchen-dashboardet — se opgave 5.
Genbruger samme API-kald og samme visuelle komponenter.
Kompakt version: mindre font-size (12px vs 13px), mindre padding.

---

### Top produkter
```
GET /api/bons/stats/top-products?from=MONTH_START&to=TODAY&metric=ENH|KR
```
Eller beregn fra eksisterende bon-data:
```sql
SELECT bl.product_name,
       SUM(bl.quantity) as total_enh,
       SUM(bl.quantity * bl.cost_price) as total_kr
FROM bon_lines bl
JOIN bons b ON bl.bon_id = b.id
WHERE b.delivery_date >= MONTH_START
  AND b.status_id IN (LEVERET, FAKTURERET, AFSLUTTET, BETALT)
GROUP BY bl.product_name
ORDER BY [metric] DESC
LIMIT 10
```

Tabel: Produkt · Antal/Kr (skifter med toggle) · % af total (mini bar).
Sorteres dynamisk når toggle skifter — ingen ny API-kald, kun re-sort i JS.

**Ny endpoint til backend:**
```
GET /api/stats/top-products?from=&to=
→ [{ product_name, total_enh, total_kr }, ...]
```

---

### CRM Placeholder

Statisk HTML. Grå baggrund, centreret tekst:
```
📞
CRM-modulet kommer i Fase 3
Serviceopkald · tilbud der udløber · sovende kunder · pipeline
[Serviceopkald] [Tilbud] [Kunder] [Pipeline]   ← grå tags
```
Ingen logik, ingen API-kald.

---

### API-behov (nye endpoints)

| Endpoint | Brug |
|---|---|
| `GET /api/bons/today` | I dag-sektion (genbrugt) |
| `GET /api/bons?date=TOMORROW&status=GODKENDT,VENTER` | Prep i morgen |
| `GET /api/bons?from=X&to=Y` | Graf + forrige år |
| `GET /api/bons?status=...&from=MONTH_START` | KPI MTD |
| `GET /api/stats/top-products?from=&to=` | **Ny** — top produkter |
| `GET /api/smartplan/today` | Vagt-pills |
| Open-Meteo (ekstern) | Vejr |

**`GET /api/stats/top-products`** skal implementeres i `routes/bons.js` eller ny `routes/stats.js`.
Returnerer: `[{ product_name, total_enh, total_kr }]` sorteret efter `total_enh DESC`.

---

### Tekniske noter

- Loades som dynamisk view i `office/index.html` — ikke standalone HTML
- Ingen SSE (snapshot-data, refresh ved navigation)
- Vejr: hent ved view-load
- Graf resize: samme mønster som kitchen (resize-handler + 50ms delay til staff-badges)
- Toggle-state: gem i `localStorage` nøgle `dashboard_graf_mode` så det huskes ved navigation
- KPI-beregning: forrige år hentes parallelt med `Promise.all` — blokerer ikke visning