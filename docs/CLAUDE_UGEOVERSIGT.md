# CLAUDE_UGEOVERSIGT.md — Ugeoversigt
> Tillæg til CLAUDE.md
> Implementeres som selvstændig fase efter Fase 10 (Mobil Shell)

---

## Formål

Ugeoversigt giver ledelse og køkkenchef et øjebliksbillede af ugen:
er vi bemandet nok, og har vi varerne — dag for dag?

Primær bruger: admin + office (mandag morgenmøde, løbende opfølgning)  
Sekundær bruger: kitchen_personal (køkkenchef — kapacitetsoverblik)

---

## Placering

**Office-zone:** `office/views/bons-calendar.js` — ugeoversigt er ét tab/view
i denne fil ved siden af kalender-visningen.

**Kitchen-zone:** Ikke i første version. Kan tilføjes som widget på
`kitchen/index.html` dashboard senere.

---

## 1. API — `GET /api/schedule/week`

### Query params

| Param | Type | Default | Beskrivelse |
|-------|------|---------|-------------|
| `from` | DATE | Mandag i indeværende uge | ISO-dato |
| `to`   | DATE | Søndag i indeværende uge | ISO-dato |

### Response

```json
{
  "week": {
    "from": "2026-04-07",
    "to":   "2026-04-13",
    "days": [
      {
        "date": "2026-04-08",
        "weekday": "Tirsdag",
        "bons": [
          {
            "id": 3251,
            "bon_number": "RR-3251",
            "status_code": "GODKENDT",
            "status_color": "#7594b3",
            "customer_name": "Novo Nordisk A/S",
            "total_units": 98,
            "pickup_time": "10:15",
            "delivery_time": "11:00"
          }
        ],
        "shifts": [
          {
            "name": "Mette Hansen",
            "initials": "MH",
            "start": "07:00",
            "end": "15:00"
          }
        ],
        "capacity": {
          "enabled": true,
          "day_ratio": 14.2,
          "status": "yellow",
          "slots": [
            { "hour": 9, "units": 98, "person_hours": 3.0, "ratio": 32.7 },
            { "hour": 10, "units": 214, "person_hours": 3.0, "ratio": 71.3 }
          ]
        },
        "stock": {
          "checked": 5,
          "total": 7,
          "missing": 2,
          "status": "orange"
        }
      }
    ]
  }
}
```

### Backend-logik (`routes/schedule.js`)

#### Bons
```js
SELECT b.id, b.bon_number, b.total_units, b.pickup_time, b.delivery_time,
       s.code AS status_code, s.color AS status_color,
       COALESCE(co.name, cu.first_name || ' ' || cu.last_name) AS customer_name
FROM bons b
JOIN status_definitions s ON b.status_id = s.id
LEFT JOIN customers cu ON b.customer_id = cu.id
LEFT JOIN companies co ON b.company_id = co.id
WHERE b.delivery_date BETWEEN :from AND :to
  AND s.code NOT IN ('AFLYST', 'AFSLUTTET', 'FAKTURERET', 'BETALT')
  AND b.is_offer = 0
ORDER BY b.delivery_date, b.pickup_time
```

#### Smartplan vagter
Genbruger `fetchSmartplanShifts(from, to)` fra `shared/planning.js`.
Returneres per dag som `{ name, initials, start, end }`.

#### Kapacitetsberegning
Se sektion 3 nedenfor.

#### Lager-status
```js
// Per bon: tjek om grocy_recipe_id er sat på alle linjer
// checked = antal bonner hvor alle linjer har grocy_recipe_id
// missing = antal bonner med mindst én linje uden grocy_recipe_id
// status: 'green' | 'orange' | 'grey' (ingen bonner)
// Fuld Grocy-beholdningstjek: deferred til planlægningsmodulet er klar
```

---

## 2. Frontend — `office/views/bons-calendar.js`

### Tab-struktur

Viewet har to tabs øverst:

```
[ Kalender ]  [ Ugeoversigt ]
```

Ugeoversigt aktiveres via URL: `#kalender?tab=uge`  
Kalender aktiveres via: `#kalender?tab=kalender` (default)

### Uge-navigation

```
◀  ▶  Uge 15 · 7.–13. april 2026   [I dag]
```

`◀`/`▶` skifter uge (±7 dage) og re-fetcher API.  
`[I dag]` springer til indeværende uge.

### Grid

7 kolonner (Man–Søn) × 3 rækker (Produktion, Personale, Lager).  
Venstre kolonne: rækkeetiketter med ikon.

| Række | Ikon | Indhold i celle |
|-------|------|-----------------|
| Produktion | 📋 | Status-badge · Antal bonner · Total enheder |
| Personale | 👥 | Status-badge · Antal vagter · Total timer · ratio-chip |
| Lager | 📦 | Status-badge · `X/Y bonner tjekket` |

**Kolonne-header:** Dag-navn + dato-tal. I dag fremhævet med `--brand-primary`.  
**Weekend-kolonner:** Lysere baggrund (`#f9f8f6`), dæmpet tekst.

### Klik på celle → dagdetalje

Klik på en hvilken som helst celle i en kolonne åbner et detaljepanel
**under gridet** (ikke modal). Gridet forbliver synligt som kontekst.

Detaljepanelet indeholder tre sektioner side om side:
1. **Produktion** — liste over bonner med nr, kunde, enheder, status-chip
2. **Personale** — vagtliste med avatar (initialer), navn, tid + evt. advarsel
3. **Lager** — per bon: ✓ OK / ⚠ X varer mangler / grå "Ingen opskrift koblet"

Footer i detaljepanelet:
```
[ Åbn planlægning → ]   [ Se alle bonner ]
```
`Åbn planlægning` linker til `kitchen/planning.html?from=DATO&to=DATO`
(eller åbner planlægningskomponenten inline hvis den er tilgængelig i office).

---

## 3. Kapacitetsberegning

### Forudsætning
Feature-flag `capacity_ratio_enabled = false` (default).  
Beregningen køres kun på server hvis flaget er `true`.

### Algoritme

```
production_end(bon):
  if pickup_time is not null:
    return pickup_time
  else:
    return delivery_time - 45 minutter

for hvert time-slot t ∈ { alle hele timer med mindst én bon på dagen }:
  slot_units  = Σ total_units for bons hvor production_end ∈ [t:00, t+1:00[
  slot_hours  = Σ max(0, min(shift_end, t+1:00) - max(shift_start, t:00))
                for alle vagter på dagen
  slot_ratio  = slot_units / slot_hours  (spring over hvis slot_hours = 0)

day_ratio = max(slot_ratio)   ← worst-case bestemmer dagsstatus
```

Tider sammenlignes som decimal-timer: `"10:30"` → `10.5`

### Tærskelværdier

```js
function ratioStatus(ratio, settings) {
    if (ratio === null)          return 'grey';    // ingen data
    if (ratio < settings.low)   return 'blue';    // ledig kapacitet
    if (ratio < settings.green) return 'green';   // OK
    if (ratio < settings.yellow)return 'yellow';  // kræver opmærksomhed
    return 'red';                                  // understaffed
}
```

| Status | Farve | Default tærskel |
|--------|-------|-----------------|
| `blue` | `--color-blue` | ratio < 20 |
| `green` | `--color-green` | 20 ≤ ratio < 35 |
| `yellow` | `--color-orange` | 35 ≤ ratio < 45 |
| `red` | `--color-red` | ratio ≥ 45 |

"Blå/ledig" vises som neutral — ikke som problem, men som information.

---

## 4. Settings

### Settings-tabel rækker (indsættes i migration)

```sql
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('capacity_ratio_enabled',   'false', 'Vis kapacitetsratio i ugeoversigt'),
  ('capacity_threshold_low',   '20',    'Under dette = ledig kapacitet (blå)'),
  ('capacity_threshold_green', '35',    'Under dette = OK (grøn)'),
  ('capacity_threshold_yellow','45',    'Under dette = advarsel (gul), over = rød');
```

### Settings UI

Placering: Settings → Generelt → sektion "Kapacitetsplanlægning"

```
Vis kapacitetsratio i ugeoversigt  [toggle]

Grænseværdier (enheder/time/person):
  Ledig kapacitet  [20]    (under dette)
  OK               [35]    (under dette)
  Advarsel         [45]    (under dette — over dette er rød)
```

Felterne er kun synlige hvis toggle er slået til.  
Gem sker ved `change`-event — ingen gem-knap.

---

## 5. Roller og adgang

| Rolle | Adgang |
|-------|--------|
| `admin` | Fuld adgang |
| `office` | Fuld adgang |
| `kitchen_personal` | Læseadgang (kapacitet + vagter, ikke bon-detaljer) |
| `kitchen` | Ingen adgang |
| `delivery` | Ingen adgang |

`requireAuth('admin', 'office', 'kitchen_personal')` på API-endpointet.

---

## 6. Filstruktur

| Fil | Ændring |
|-----|---------|
| `routes/schedule.js` | Ny fil — `GET /api/schedule/week` |
| `server.js` | Mount: `app.use('/api/schedule', require('./routes/schedule'))` |
| `office/views/bons-calendar.js` | Tilføj ugeoversigt-tab og render-logik |
| `shared/schedule.css` | Ny — ugeoversigt-styles (kopiér og udvid fra mockup) |
| `db/migrations/042_capacity_settings.sql` | Ny — settings-rækker |

---

## 7. Implementeringsrækkefølge for Simon

| Trin | Hvad | Fil |
|------|------|-----|
| 1 | Migration 042 — settings-rækker | `db/migrations/042_capacity_settings.sql` |
| 2 | `GET /api/schedule/week` — bons + Smartplan, uden kapacitet | `routes/schedule.js` |
| 3 | Ugeoversigt grid + navigation i frontend | `office/views/bons-calendar.js` |
| 4 | CSS | `shared/schedule.css` |
| 5 | Dagdetalje-panel | `office/views/bons-calendar.js` |
| 6 | Kapacitetsberegning i backend (bag feature-flag) | `routes/schedule.js` |
| 7 | Settings UI — kapacitetstærskler | `settings/index.html` |

Trin 1–5 kan deployes og bruges i produktion inden kapacitetsberegningen er klar.

---

## 8. Smoke-test

```bash
# Hent indeværende uge
curl -s "http://localhost:4321/api/schedule/week" \
  -H "Cookie: $OFFICE_SESSION" | jq '.week.days | length'
# Forventet: 7

# Hent specifik uge
curl -s "http://localhost:4321/api/schedule/week?from=2026-04-07&to=2026-04-13" \
  -H "Cookie: $OFFICE_SESSION" | jq '.week.days[1].capacity'

# Verificer at kitchen-bruger ikke har adgang
curl -s "http://localhost:4321/api/schedule/week" \
  -H "Cookie: $KITCHEN_SESSION"
# Forventet: 403
```

---

## 9. Mockup

Se `ugeoversigt-mockup.html` — interaktiv mockup med klikbart dagdetalje-panel.

---

## Åbne spørgsmål (til senere)

- **Lager V2:** Når planlægningsmodulet har fuld Grocy-kobling, kan lager-rækken
  vise faktisk beholdningstjek frem for "opskrift koblet/ikke koblet".
- **Kitchen dashboard widget:** Mini-version af ugeoversigt (kun kapacitetsstatus)
  som widget på `kitchen/index.html`.

---

*Oprettet: april 2026*
