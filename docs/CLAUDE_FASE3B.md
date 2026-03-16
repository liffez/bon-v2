# CLAUDE_FASE3B.md — Fase 3B: Dashboards
> Læs CLAUDE.md og docs/bon_v2_datamodel_v2.md FØR du starter.
> Opdateret: marts 2026

---

## Hvad denne opgave dækker

To dashboards der deler backend-logik men har forskelligt indhold og zone:

| View | Fil | Zone |
|------|-----|------|
| Kitchen Dashboard | `kitchen/index.html` | Kitchen (MPA, touch) |
| Office Dashboard | `office/dashboard.html` | Office (desktop) |

---

## Nye API-endpoints (routes/dashboard.js)

Alle endpoints kræver auth. Monteres i `server.js` som `/api/dashboard`.

```
GET /api/dashboard/today
GET /api/dashboard/stats?days_back=7&days_forward=7
GET /api/dashboard/weather
```

### GET /api/dashboard/today

Returnerer alt til "Lige nu"-sektionen:

```json
{
  "date": "2026-03-15",
  "bons": [
    {
      "id": 3244,
      "bon_number": "3244",
      "status_code": "IGANG",
      "status_color": "#e8a832",
      "delivery_time": "10:45",
      "total_units": 48,
      "customer_name": "Novo Nordisk",
      "prep_ingredients_ready": 1,
      "prep_supplies_ready": 0
    }
  ],
  "totals": {
    "bon_count": 12,
    "total_units": 156,
    "total_pax": 124,
    "total_price": 42800
  },
  "categories": [
    { "name": "01 Sandwich", "units": 86 },
    { "name": "02 Slidere",  "units": 48 },
    { "name": "03 Salater",  "units": 22 },
    { "name": "04 Kager",    "units": 12 },
    { "name": "Tilbehør",    "units": 8  }
  ],
  "alerts": [
    {
      "type": "prep_missing",
      "bon_id": 3244,
      "bon_number": "3244",
      "message": "#3244 mangler emballage",
      "severity": "warning"
    },
    {
      "type": "unread_mail",
      "count": 3,
      "message": "3 ulæste mails",
      "severity": "info"
    }
  ],
  "next_pickup": "10:00"
}
```

`categories` hentes fra `bon_lines.category` for dagens bons.
`alerts` genereres server-side:
- `prep_missing` — bon med `delivery_date = today` hvor `prep_ingredients_ready=0` eller `prep_supplies_ready=0`
- `status_waiting` — bons med status NY eller VENTER
- `unread_mail` — COUNT fra `bon_mails` + `customer_mails` hvor `is_read=0`

### GET /api/dashboard/stats

Bruges til søjlegrafen. Query params: `days_back` (default 7), `days_forward` (default 7).

```json
{
  "days": [
    {
      "date": "2026-03-08",
      "is_future": false,
      "total_units": 134,
      "total_price": 38200,
      "bon_count": 9,
      "categories": [
        { "name": "01 Sandwich", "units": 72 },
        { "name": "02 Slidere",  "units": 34 },
        { "name": "03 Salater",  "units": 28 }
      ],
      "shifts": ["Mette", "Jonas"],
      "last_year": {
        "date": "2025-03-08",
        "total_units": 118,
        "total_price": 33400,
        "bon_count": 8
      }
    }
  ],
  "week_summary": {
    "current_week_units": 892,
    "current_week_price": 241000,
    "last_year_week_units": 798,
    "last_year_week_price": 214000,
    "units_pct_change": 11.8,
    "price_pct_change": 12.6
  },
  "quiet_days_ahead": [
    { "date": "2026-03-20", "expected_units": 42, "historical_avg": 98, "pct_of_avg": 43 }
  ]
}
```

`last_year` matches på `delivery_date = target_date - 364 dage` (nærmeste mandag matcher mandag).
`shifts` hentes fra Smartplan-adapteren (samme som kalender bruger).
`quiet_days_ahead` — dage fremad hvor `bon_count * avg_units < settings.dashboard_quiet_threshold %` af historisk gennemsnit for den ugedag. Kun fremtidige dage.

### GET /api/dashboard/weather

Proxy til DMI API. Returnerer vejr for i dag + de næste 7 dage.

```json
{
  "available": false,
  "reason": "DMI_API_KEY ikke sat i .env"
}
```

```json
{
  "available": true,
  "days": [
    {
      "date": "2026-03-15",
      "temp_max": 8,
      "temp_min": 3,
      "symbol": "cloudy",
      "description": "Skyet"
    }
  ]
}
```

**Endpoint afventer:** DMI API-nøgle mangler (se åbne punkter). Returnerer `available: false` indtil nøgle er sat. Frontend håndterer dette gracefully — vejr-widget skjules.

`.env` nøgle: `DMI_API_KEY=`

---

## Settings-nøgler (tilføjes til seed)

```sql
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('dashboard_countdown_enabled', '0',  '1 = vis nedtælling til næste pickup på kitchen dashboard'),
    ('dashboard_quiet_threshold',   '60', 'Stille-dag advarsel ved under X% af historisk gennemsnit');
```

---

## kitchen/index.html

MPA-side. Bruger kitchen-topbar. Touch-first. SSE-opdatering.

### Layout

```
┌─────────────────────────────────────────────────────┐
│  TOPBAR                                             │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ØVERST — LIGE NU                                   │
│  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ Statusringe  │  │ Kategori-tabel               │ │
│  │ (bon-cirkler)│  │ Sandwich    86               │ │
│  │              │  │ Slidere     48               │ │
│  │ Vejr         │  │ Salater     22               │ │
│  │ [Countdown]  │  │ Kager       12               │ │
│  └──────────────┘  │ Tilbehør     8               │ │
│                    └──────────────────────────────┘ │
│                                                     │
│  NAVIGATIONSKNAPPER                                 │
│  [→ I dag]  [→ Senere]  [Lager]  [Opskrifter]      │
│  [Varemodtagelse]  [Bestilling]                     │
│                                                     │
│  NEDENUNDER — PERSPEKTIV                            │
│  [Søjlegraf — enheder, 7+7 dage]                   │
│  [Toggle: sammenlign med sidste år]                 │
│                                                     │
│  På arbejde i dag                                   │
│  Mette (Køkken 07:00–15:00)                        │
│  Jonas (Køkken 08:00–16:00)                        │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Statusringe

Én farvet cirkel per bon i dag, sorteret efter `delivery_time`.
Farve = `status_color` fra BonConfig.
Hover/tap: viser bon-nummer + kundenavn + tid.
Klik: navigerer til `today.html#bon-{id}`.

```
● ● ● ● ●   ← GODKENDT (grøn)
●           ← IGANG (gul)
● ●         ← KLAR (blå)
```

Ingen statusring for LEVERET/AFLYST (terminale) — de tones ned.

### Countdown (hvis `dashboard_countdown_enabled = 1`)

```
Næste pickup om
  1t 23m
```

Stort tal, brun farve. Opdateres hvert minut. Skjules hvis ingen kommende pickups.

### Grafen

Bibliotek: `Chart.js` (allerede tilgængeligt via CDN).
Stablet søjlegraf. X-akse: datoer. Y-akse: enheder.
Kategorier stables med faste farver (fra designsystem).
Fremtidige søjler: 40% opacity.
Dagens søjle: fed border.

Toggle "Sammenlign med sidste år": tilføjer en grå outline-søjle bag hver søjle.

Smartplan-navne vises som små tekst-badges over fremtidige søjler (kun fornavn).

### SSE

Lytter på `bon_status` og `bon_created` — opdaterer statusringe og totaler in-place uden reload.

---

## office/dashboard.html

Desktop-side. Monteres i office-shellen (sidebar + topbar).

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  ØVERST — LIGE NU                          [Vejr 8°☁]  │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  12      │ │  156     │ │  42.800  │ │  3 alerts│  │
│  │  bonner  │ │  enheder │ │  kr.     │ │  ⚠       │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
│                                                         │
│  Statusringe: ● ● ● ● ● ● ● ● ● ● ● ●                 │
│                                                         │
│  Alerts:                                                │
│  ⚠ #3244 mangler emballage          [Se bon →]         │
│  ✉ 3 ulæste mails                   [Åbn →]            │
│  📅 #3241 venter godkendelse        [Se bon →]         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  NEDENUNDER — PERSPEKTIV                                │
│                                                         │
│  [Søjlegraf]              [Uge-sammenligning]           │
│                           Denne uge                     │
│  Toggle: Enheder / Kr.    892 enh. / 241.000 kr.       │
│  Toggle: Sammenlign       +11,8% enheder ift. sidste år │
│          sidste år        +12,6% omsætning              │
│                                                         │
│  Stille dag advarsel:                                   │
│  ⚠ Torsdag 20/3 ser stille ud (43% af normalt)         │
│                                                         │
│  På arbejde i dag                                       │
│  Mette · Jonas · Leif · Sara                           │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Store tal (KPI-kort)

Fire kort øverst. Klik på "bonner" → navigerer til listview med dato=today filter.
Klik på "enheder" eller "kr." → ingen navigation (bare tal).
Klik på "alerts" → scroller ned til alert-listen.

### Alerts

Genereres fra `GET /api/dashboard/today` → `alerts` array.
Hver alert har en handling: "Se bon →" åbner drawer, "Åbn →" navigerer til mail-indbakke (Fase 4 — grayed out indtil da).

### Uge-sammenligning

Hentes fra `stats.week_summary`. Vises som:
```
Enheder denne uge:   892   (+11,8% ift. 2025)
Omsætning:      241.000 kr (+12,6% ift. 2025)
```

Procent-ændring: grøn hvis positiv, rød hvis negativ.

### Stille dage

Vises kun hvis `quiet_days_ahead` ikke er tom.
Max 3 advarsler. Subtil gul baggrund — ikke alarmerende.

### SSE

Lytter på `bon_status`, `bon_created`, `bon_updated` — opdaterer KPI-kort og statusringe in-place.

---

## Delt komponent: Søjlegraf

Grafen er identisk i begge dashboards. Forskellen er:
- Kitchen: kun enheder, ingen kr.-toggle
- Office: enheder + toggle til kr.

Kan implementeres som én funktion `initDashboardChart(canvasId, data, opts)` i en lille
`shared/dashboard_chart.js` fil.

```javascript
initDashboardChart('canvas-id', statsData, {
    showKr: false,           // kitchen: false, office: true
    showLastYear: false,     // begge starter med false, toggle aktiverer
    highlightToday: true
});
```

---

## Rækkefølge

1. `routes/dashboard.js` — today + stats (uden vejr)
2. `shared/dashboard_chart.js` — Chart.js wrapper
3. `kitchen/index.html` — statusringe, kategori-tabel, nav-knapper, graf, Smartplan
4. `office/dashboard.html` — KPI-kort, alerts, uge-sammenligning, stille dage, graf
5. `GET /api/dashboard/weather` — tilføjes når DMI API-nøgle er på plads

---

## Åbne punkter

| Punkt | Status |
|-------|--------|
| DMI API-nøgle | ⏳ Leif finder frem til eksisterende nøgle |
| Bon v1-data migration til v2 | ⏳ Nødvendig for at "sidste år"-sammenligning virker fra dag 1 |

---

## Test-kommandoer

```bash
# Dagens data
curl -s http://localhost:4321/api/dashboard/today | jq

# Graf-data, standard interval
curl -s "http://localhost:4321/api/dashboard/stats" | jq

# Graf-data, bredere vindue
curl -s "http://localhost:4321/api/dashboard/stats?days_back=14&days_forward=14" | jq

# Vejr (returnerer available:false indtil DMI-nøgle er sat)
curl -s http://localhost:4321/api/dashboard/weather | jq
```
