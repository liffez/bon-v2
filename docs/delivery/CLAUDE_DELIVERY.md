# CLAUDE_DELIVERY.md — Delivery-modul (rute-planlægning, courier, leverings-beregning)
> Læs `CLAUDE.md`, `BON_V2_PRINCIPPER.md`, `bon_v2_datamodel_v2.md` og `bon_v2_zoner_og_layout.md` FØR du starter.
> Opdateret: april 2026

---

## Formål

Komplet leverings-modul der dækker tre dele:

1. **Leveringsberegning** (service-lag) — afstand/tid mellem punkter, transport-forslag pr. bon, constraint-check
2. **Rute-planlægning** (office) — træk bons til ture, beregn med VROOM, bekræft plan
3. **Courier-view** (mobile shell) — dagens stop, kontakt-info, status-knapper, problem-logging

Erstatter den gamle Bon Map-side. Bygger på den eksisterende `geo_calculations` + `delivery_events` + udvider med `delivery_routes`, `delivery_route_stops`, `delivery_vehicles` og `delivery_incidents`.

---

## Arkitektur

```
                          ┌──────────────────────────────┐
                          │  OFFICE — Plan i morgen       │
                          │  /office/logistik             │
                          │  Drag bons → ture             │
                          │  "Beregn rute" → VROOM-modal  │
                          └──────────────┬────────────────┘
                                         │
                                         │ (manuel bekræftelse)
                                         ▼
┌────────────────────────────────────────────────────────────────┐
│                    BACKEND SERVICES                             │
│                                                                 │
│  routes/delivery.js                                             │
│    GET  /api/delivery/routes?date=YYYY-MM-DD                    │
│    POST /api/delivery/routes                                    │
│    PUT  /api/delivery/routes/:id                                │
│    POST /api/delivery/routes/:id/compute   ← VROOM              │
│    POST /api/delivery/routes/:id/apply                          │
│    POST /api/delivery/routes/:id/confirm                        │
│    GET  /api/delivery/routes/:id/booking-payload                │
│    POST /api/delivery/routes/:id/book                           │
│    POST /api/delivery/confirm-and-book     ← bulk + manuel UI   │
│    GET  /api/delivery/calendar                                  │
│    POST /api/delivery/stops/:id/status                          │
│    POST /api/delivery/incidents                                 │
│    POST /api/delivery/calculate            ← single bon         │
│                                                                 │
│  services/osrm.js          → http://localhost:5000              │
│  services/vroom.js         → http://localhost:3000              │
│  services/delivery_calc.js → bygger på osrm.js + settings       │
│  services/route_planner.js → orchestrerer VROOM + DB-skrivning  │
│  services/booking_template.js → genererer clipboard-payload     │
│  services/cost.js          → cost-formel pr. vehicle            │
│  services/byekspressen.js  → API-integration (3D.5)             │
└────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                          ┌──────────────────────────────┐
                          │  MOBILE COURIER               │
                          │  /m/levering                  │
                          │  Dagens stop · status · sms   │
                          │  Problem-flow med foto+geo    │
                          └──────────────────────────────┘
```

---

## Stack — selvhostet på Hetzner

| Service | Port | Image | Formål |
|---------|------|-------|--------|
| OSRM | 5000 | `osrm/osrm-backend` | Afstand/tid mellem punkter (kørsel) |
| VROOM | 3000 | `vroomvrp/vroom-docker` | Constraint-check + rute-optimering |

OSRM kræver et OSM-data-extract (Danmark eller Region Hovedstaden). Dataforberedelse:

```bash
# Download OSM-data
wget https://download.geofabrik.de/europe/denmark-latest.osm.pbf

# Forbered (engangs, tager ~10 min)
docker run -t -v "$PWD:/data" osrm/osrm-backend osrm-extract -p /opt/car.lua /data/denmark-latest.osm.pbf
docker run -t -v "$PWD:/data" osrm/osrm-backend osrm-partition /data/denmark-latest.osrm
docker run -t -v "$PWD:/data" osrm/osrm-backend osrm-customize /data/denmark-latest.osrm

# Kør som service
docker run -d --restart=always -p 5000:5000 -v "$PWD:/data" osrm/osrm-backend \
  osrm-routed --algorithm mld /data/denmark-latest.osrm

# VROOM
docker run -d --restart=always -p 3000:3000 -e VROOM_ROUTER=osrm \
  -e ROUTER_HOST=host.docker.internal -e ROUTER_PORT=5000 \
  vroomvrp/vroom-docker
```

Begge bør sættes op med `docker-compose.yml` så de starter ved server-reboot. Nginx proxy ikke nødvendig — services tilgås kun fra Bon v2-backend (intern).

---

## .env

```
OSRM_URL=http://localhost:5000
VROOM_URL=http://localhost:3000
DELIVERY_SAFETY_MARGIN_MIN=10
KITCHEN_PICKUP_CAPACITY_BOXES=12
```

---

## npm-pakker

Ingen nye — bruger native `fetch` mod OSRM/VROOM.

---

## Datamodel — nye tabeller

Tilføjes til `migrations/` som ny migrationsfil. Eksisterende `geo_calculations` og `delivery_events` bevares uændrede (indices kan udvides hvis behov).

```sql
-- ==========================================
-- KØRETØJER (master data)
-- ==========================================
CREATE TABLE delivery_vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,         -- 'volvo', 'byekspressen-1', 'taxa', 'cykel-egen-1'
    label TEXT NOT NULL,                -- vises i UI: "Volvo Duett", "By-expressen", ...
    type TEXT NOT NULL                  -- 'volvo' | 'bike' | 'own-bike' | 'taxi'
        CHECK (type IN ('volvo', 'bike', 'own-bike', 'taxi')),
    is_internal INTEGER NOT NULL DEFAULT 0,  -- 1 hvis vi ejer/styrer det
    max_stops INTEGER,                  -- NULL = ingen grænse
    max_capacity_boxes INTEGER,
    max_distance_km REAL,
    cost_formula_json TEXT,             -- se sektion: cost-formel
    skills_json TEXT,                   -- frem-tids brug (fx 'cold-chain')

    -- Booking-konfiguration (per vehicle)
    booking_method TEXT NOT NULL DEFAULT 'calendar'
        CHECK (booking_method IN ('calendar', 'api', 'manual_clipboard')),
    booking_url TEXT,                   -- Eksternt URL der åbnes ved manual_clipboard
    booking_template TEXT,              -- Clipboard-template med pladsholdere (kun manual_clipboard)
    booking_api_config_json TEXT,       -- API-credentials og config (kun api)

    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_vehicles_active ON delivery_vehicles(is_active);

-- ==========================================
-- TURE
-- ==========================================
CREATE TABLE delivery_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_date DATE NOT NULL,
    vehicle_id INTEGER NOT NULL REFERENCES delivery_vehicles(id),

    -- Bemanding
    courier_user_id INTEGER REFERENCES users(id),  -- intern person, kan være NULL
    external_driver_label TEXT,                    -- "Eksternt bud", "Taxa-bestilling 12:30"
    external_reference TEXT,                       -- By-expressen booking-ID, taxa-ref

    -- Tider
    pickup_time TIME,                              -- afgang fra HQ — fælles for alle stop
    actual_departure DATETIME,
    completed_at DATETIME,

    -- Status
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'computed', 'confirmed', 'active', 'completed', 'cancelled')),

    -- Booking (separat aspekt fra status — confirmed != booked)
    booking_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (booking_status IN ('pending', 'in_progress', 'booked', 'failed', 'not_required')),
    booking_reference TEXT,                        -- Referencenr fra eksternt system
    booked_at DATETIME,
    booked_by_user_id INTEGER REFERENCES users(id),

    -- Beregnet
    total_km REAL,
    total_minutes INTEGER,
    estimated_cost_dkk INTEGER,                    -- Vores estimat fra cost-formel
    actual_cost_dkk INTEGER,                       -- Faktisk omkostning (hvis kendt)
    actual_cost_source TEXT                        -- 'api' (By-expressen) | 'manual' (taxa) | NULL
        CHECK (actual_cost_source IN ('api', 'manual') OR actual_cost_source IS NULL),
    actual_cost_at DATETIME,                       -- Hvornår blev faktisk pris registreret

    -- Geometri
    route_geojson TEXT,                            -- Den faktiske kørerute fra OSRM

    -- Meta
    notes TEXT,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_routes_date ON delivery_routes(route_date);
CREATE INDEX idx_routes_status ON delivery_routes(status);
CREATE INDEX idx_routes_courier ON delivery_routes(courier_user_id);

-- ==========================================
-- STOP PÅ TUR
-- ==========================================
CREATE TABLE delivery_route_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    bon_id INTEGER NOT NULL REFERENCES bons(id),
    sequence INTEGER NOT NULL,                     -- 1-indekseret
    eta TIME,                                      -- Beregnet ankomst
    distance_from_prev_m INTEGER,                  -- Meter fra forrige punkt (HQ for første stop)
    duration_from_prev_s INTEGER,                  -- Sekunder

    -- To-trins-leveret (vigtig nuance)
    -- Når bon-status skifter til KLAR: køkkenet har leveret = afhentet af bud
    -- Når completed_at sættes: kunden har modtaget
    completed_at DATETIME,                         -- Bud trykker leveret = hos kunde

    -- Forenklet 4-state-flow matcher bon-status
    status TEXT NOT NULL DEFAULT 'planlagt'
        CHECK (status IN ('planlagt', 'klar', 'leveret', 'problem')),
    -- planlagt: bon er ikke endnu KLAR fra køkken (ikke afhentet)
    -- klar:     bon er KLAR fra køkken — bud har den eller er på vej
    -- leveret:  bon er hos kunden (completed_at != NULL)
    -- problem:  incident logget — bon-status uændret men stop kræver opfølgning

    UNIQUE(route_id, bon_id),                      -- Samme bon kan ikke være på samme tur to gange
    UNIQUE(route_id, sequence)
);

CREATE INDEX idx_stops_route ON delivery_route_stops(route_id);
CREATE INDEX idx_stops_bon ON delivery_route_stops(bon_id);

-- ==========================================
-- INCIDENTS (problemer ved levering)
-- ==========================================
CREATE TABLE delivery_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_stop_id INTEGER REFERENCES delivery_route_stops(id),
    bon_id INTEGER NOT NULL REFERENCES bons(id),
    incident_type TEXT NOT NULL
        CHECK (incident_type IN ('no_answer', 'wrong_address', 'left_at_door', 'returned_to_kitchen', 'damage', 'other')),
    description TEXT,
    photo_path TEXT,                               -- Relativ sti i uploads/incidents/
    location_lat REAL,
    location_lng REAL,
    logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    logged_by_user_id INTEGER REFERENCES users(id),
    resolved_at DATETIME,
    resolved_by_user_id INTEGER REFERENCES users(id),
    resolution_notes TEXT
);

CREATE INDEX idx_incidents_bon ON delivery_incidents(bon_id);
CREATE INDEX idx_incidents_unresolved ON delivery_incidents(resolved_at) WHERE resolved_at IS NULL;

-- ==========================================
-- BESKEDER mellem office og courier
-- ==========================================
CREATE TABLE delivery_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES delivery_routes(id),
    direction TEXT NOT NULL
        CHECK (direction IN ('to_courier', 'from_courier')),
    body TEXT NOT NULL,
    sent_by_user_id INTEGER REFERENCES users(id),
    sent_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acked_at DATETIME                              -- Tidspunkt courier tappede ✓ på besked
);

CREATE INDEX idx_messages_route ON delivery_messages(route_id);
CREATE INDEX idx_messages_unacked ON delivery_messages(acked_at) WHERE acked_at IS NULL;

-- ==========================================
-- TILFØJ delivery_notes til bons
-- ==========================================
ALTER TABLE bons ADD COLUMN delivery_notes TEXT;
ALTER TABLE bons ADD COLUMN delivery_contact_name TEXT;     -- "Kontakt på dagen" — hvis forskellig fra ordering_contact
ALTER TABLE bons ADD COLUMN delivery_contact_phone TEXT;
```

### Cost-formel format (JSON i `delivery_vehicles.cost_formula_json`)

```json
// Volvo (eget køretøj)
{
  "base": 0,
  "per_km": 4
}

// By-expressen
{
  "base": 100,
  "included_boxes": 2,
  "extra_box_cost": 50
}

// Taxa
{
  "base": 136,
  "per_km": 19
}

// Egen cykel
{
  "base": 0
}
```

`services/cost.js` har én funktion: `calculateRouteCost(vehicle, totalKm, totalBoxes) → number`. Branch på `vehicle.type`.

---

## Bestillings-trinet

Når en plan er beregnet og bekræftet, skal hver tur **bestilles** før den er virkelighed. Booking-mekanikken styres pr. køretøj via `delivery_vehicles.booking_method`:

| `booking_method` | Hvad sker | Brugt til |
|------------------|-----------|-----------|
| `calendar` | Bon v2 lægger turen i intern kalender. Ingen ekstern booking | Volvo, egen cykel |
| `api` | Bon v2 kalder ekstern API, gemmer booking-ref auto | By-expressen (3D.5) |
| `manual_clipboard` | Bon v2 bygger tekst-template, kopierer til clipboard, åbner ekstern URL i nyt vindue. Bruger paster manuelt + indtaster ref bagefter | Taxa |

**Booking er separat aspekt fra `status`.** En tur kan være `status='confirmed'` (planen er låst) men `booking_status='pending'` (mangler at blive bestilt). Status-flow er stadig `draft → computed → confirmed → active → completed`. Booking-flow er `pending → in_progress → booked` (eller `failed`).

### Flow ved "Bekræft og bestil"

```
Klik på "Bekræft plan" i topbar
    ↓
Modal viser oversigt over hvad der skal ske pr. tur:
    Volvo · tur 1            ✓ Lægges i kalender (auto)
    By-expressen #1          ⚡ Bookes via API (auto)        [3D.5 — placeholder i 3D.4]
    Taxa · 12:00             📞 Kræver manuel handling
    Egen cykel · tur 1       ✓ Lægges i kalender (auto)
    ↓
Klik "Bekræft og bestil"
    ↓
For hver tur, baseret på vehicle.booking_method:
    calendar         → status='confirmed', booking_status='not_required'
    api              → kald API, gem booking_ref, status='confirmed', booking_status='booked'
    manual_clipboard → status='confirmed', booking_status='in_progress'
                       Modal åbnes for hver manual tur (én ad gangen):
                           Vis genereret template
                           Knap "Kopiér og åbn" → clipboard + window.open(booking_url)
                           Felt "Booking-ref" (ikke obligatorisk men opfordres)
                           Knap "Marker som booket" → booking_status='booked'
                           ELLER Knap "Spring over" → forbliver 'in_progress'
```

### Manual booking modal (taxa)

Vises når `booking_method='manual_clipboard'` ved bekræftelse. Mockup-reference indsættes som tilføjelse til office route-planner.

```
┌──────────────────────────────────────────────────────┐
│  Book taxa · tur 1 · afgang 12:00              [×]   │
│                                                      │
│  Stop på turen:                                      │
│  • #3382 — Nørre Allé 7, 2200 København (17:15)     │
│                                                      │
│  Følgende tekst kopieres til clipboard:              │
│  ┌────────────────────────────────────────────────┐ │
│  │ Bon ID: #3382                                  │ │
│  │ Adresse: Nørre Allé 7, 2200 København          │ │
│  │ Firma: København Kommune                       │ │
│  │ Navn: Lene Bjerg Kristensen                    │ │
│  │ ...                                            │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  [Kopiér til clipboard og åbn taxa.nu]              │
│                                                      │
│  Booking-ref (anbefalet, ikke krævet):              │
│  [_____________________]                             │
│                                                      │
│  [Spring over]    [Marker som booket]               │
└──────────────────────────────────────────────────────┘
```

**Vigtigt:** "Marker som booket" er ikke obligatorisk. Hvis bruger trykker "Spring over" forbliver `booking_status='in_progress'` og turen vises i office med en synlig "afventer booking-ref"-indikator. Office kan bagefter åbne turen og indtaste ref.

### Multi-stop bookings

Hvis taxa-tur har flere stops, samles alle i ét clipboard:

```
Bon ID: #3382 + #3383
Adresser:
  Stop 1: Nørre Allé 7, 2200 København (17:15)
  Stop 2: Bredgade 45, 1260 København K (17:45)
Firma: København Kommune (#3382), Hansen Adv (#3383)
...
Antal emballager (samlet for hele turen):
  30 x Slider Boks 3 stk
  4 x Transportkasse
```

Template skal kunne håndtere `{stops}`-pladsholder der itererer over alle stop, OG aggregerede felter som `{packaging_lines}` der summerer på tværs.

### `services/booking_template.js`

Bygger clipboard-tekst fra template + tur-data:

```javascript
async function generateBookingPayload(routeId)
// Henter route + stops + bons + customers + companies
// Henter vehicle.booking_template
// Erstatter pladsholdere
// Returnerer:
// {
//   booking_method: 'manual_clipboard' | 'api' | 'calendar',
//   booking_url: 'https://taxa.nu/order.asp?type=new' | null,
//   clipboard_text: 'Bon ID: #3382\n...' | null,
//   route_summary: { stops, total_boxes, ... }   // Til preview
// }
```

**Pladsholder-format:** `{name}` for simple felter, `{stops:format}` for iterables.

| Pladsholder | Værdi | Multi-stop opførsel |
|-------------|-------|---------------------|
| `{bon_ids}` | "#3382 + #3383" | Sammenkædet med " + " |
| `{delivery_address}` | Adresse linje | Hvis multi: vises kun første. Brug `{stops}` for alle |
| `{company_name}` | Firma | Multi: kommasepareret |
| `{contact_name}` | Bestiller-navn | Multi: kommasepareret |
| `{contact_phone}` | Bestiller-tlf | Multi: kommasepareret |
| `{delivery_contact_name}` | Kontakt-på-dagen | Multi: kommasepareret |
| `{delivery_contact_phone}` | Kontakt-på-dagen tlf | Multi: kommasepareret |
| `{delivery_time}` | Levering kl. | Multi: vises kun første |
| `{delivery_date}` | Dato | Same |
| `{pickup_time}` | Afgang fra HQ | Same (fælles) |
| `{packaging_lines}` | Beregnet pakke-info | **Aggregeres på tværs af stops** |
| `{delivery_notes}` | Leveringsinstruks | Multi: med stop-prefiks |
| `{stops}` | Alle stops, formateret | Iterer alle |

Eksempel `{stops}` template:
```
Stop {sequence}: {customer} · {address} · lev. {delivery_time}
```

Bliver til:
```
Stop 1: København Kommune · Nørre Allé 7 · lev. 17:15
Stop 2: Hansen Adv · Bredgade 45 · lev. 17:45
```

### Intern kalender

For `booking_method='calendar'` ture: ingen ekstern handling. Kalender-view er bare et **filtreret view over `delivery_routes`**:

```sql
-- Min kalender (én bruger)
SELECT
    r.id, r.route_date, r.pickup_time, r.status,
    v.label AS vehicle_label,
    v.type AS vehicle_type,
    (SELECT count(*) FROM delivery_route_stops WHERE route_id = r.id) AS stop_count
FROM delivery_routes r
JOIN delivery_vehicles v ON r.vehicle_id = v.id
WHERE r.courier_user_id = ?
    AND r.route_date >= date('now')
    AND r.status IN ('confirmed', 'active')
ORDER BY r.route_date, r.pickup_time;

-- Hele teamets kalender (admin/office)
-- Samme query uden courier_user_id filter
```

Vises:
- I office-dashboard som "Dagens ture"
- I mobile courier-view som default landing
- I logistik-view som rute-liste

**Ingen separat `calendar_events`-tabel.** Hvis senere behov for iCal-eksport: `services/calendar_ical.js` der genererer iCal fra `delivery_routes`.

### Seed-eksempel

```sql
-- delivery_vehicles seed
INSERT INTO delivery_vehicles (code, label, type, is_internal, max_capacity_boxes, max_distance_km, cost_formula_json, booking_method, booking_url, booking_template) VALUES

('volvo', 'Volvo Duett', 'volvo', 1, 30, NULL,
 '{"base":0,"per_km":4}',
 'calendar', NULL, NULL),

('byekspressen', 'By-expressen', 'bike', 0, 4, 8,
 '{"base":100,"included_boxes":2,"extra_box_cost":50}',
 'manual_clipboard',                                       -- 3D.4: starter som taxa-flow
 'https://www.byekspressen.dk/booking',                    -- skal verificeres med rigtig URL
 'Afhentning: Ristet Rug, Prinsesse Charlottesgade 16
Tid: {pickup_time} {delivery_date}

Levering til:
{delivery_address}

Modtager: {contact_name}
Telefon: {delivery_contact_phone}
Bon-ID: {bon_ids}
Antal kasser: {total_boxes}
{delivery_notes}'),
-- 3D.5 OPDATERING: når API'et er klar:
--   UPDATE delivery_vehicles
--      SET booking_method = ''api'',
--          booking_api_config_json = ''{"endpoint":"...", "api_key":"..."}''
--    WHERE code = ''byekspressen'';

('cykel-egen', 'Egen cykel', 'own-bike', 1, 4, 8,
 '{"base":0}',
 'calendar', NULL, NULL),

('taxa-4x35', 'Taxa 4×35', 'taxi', 0, 8, NULL,
 '{"base":136,"per_km":19}',
 'manual_clipboard',
 'https://taxa.nu/order.asp?type=new',
 'Bon ID: {bon_ids}
Adresse: {delivery_address}
Firma: {company_name}
Navn: {contact_name}
Telefon: {contact_phone}
Levering: {delivery_time} {bon_ids}

Antal emballager:
{packaging_lines}

Leveringsinfo:
{delivery_notes}
Kontakt: {delivery_contact_name}
Telefon: {delivery_contact_phone}

Dato: {delivery_date}
Afhentningstid: {pickup_time}');
```

---

## Settings — nye keys

Tilføjes til `seeds/settings.js`:

```sql
INSERT INTO settings (key, value, description) VALUES
('delivery_safety_margin_minutes', '10', 'Buffer udover OSRM-køretid (min)'),
('delivery_kitchen_capacity_boxes', '12', 'Max kasser klar samtidig ved samme pickup-tid'),
('delivery_auto_accept_enabled', '0', 'Auto-accept små pickup-justeringer (0=alt skal bekræftes)'),
('delivery_auto_accept_threshold_min', '15', 'Max minutter for auto-accept (kun hvis enabled)'),
('delivery_assumed_delivered_after_min', '30', 'Antag leveret hvis intet hørt efter X min over deadline'),
('delivery_office_phone', '+4533218989', 'Tlf. kontoret — vises som nødløsning i mobile shell'),
('delivery_default_service_time_min', '5', 'Default service-tid pr. stop (losning hos kunde)'),
('delivery_booking_remind_unbooked_after_min', '60', 'Advar om ture med booking_status=in_progress efter X min'),
('delivery_hq_address', 'Prinsesse Charlottesgade 16, 2200 København N', 'HQ-adresse — bruges til "Naviger hjem" i mobile'),
('delivery_hq_lat', '55.6905', 'HQ latitude'),
('delivery_hq_lng', '12.5510', 'HQ longitude'),
('delivery_navigation_provider', 'google', 'Navigations-app: google | apple | waze. Default google = virker på iOS+Android'),
('delivery_completed_routes_collapsed', '1', 'Default skjul completed ture i listview (1=kollaps, 0=vis)');
```

> **Bemærk:** Booking-templates og URL'er er pr. vehicle (i `delivery_vehicles.booking_template`/`booking_url`), ikke globale settings. Det giver mulighed for at have flere taxa-firmaer med forskellige formater senere.

---

## Backend services

### `services/osrm.js`

Tynd HTTP-wrapper omkring OSRM. Cacher ikke (brug `geo_calculations` til persistent cache).

```javascript
async function getRoute(coords)
// coords: [[lng, lat], [lng, lat], ...]
// returnerer: { distance_m, duration_s, geometry_geojson, legs: [...] }

async function getDistance(from, to)
// Convenience for to-punkts beregning
// returnerer: { distance_m, duration_s }

async function getDistanceMatrix(coords)
// Til VROOM-input når flere stop
// returnerer: { distances: [[]], durations: [[]] }
```

### `services/vroom.js`

```javascript
async function planRoute({ vehicle, stops, hq_coord, settings })
// vehicle: { id, type, max_capacity_boxes, max_distance_km, ... }
// stops: [{ bon_id, lat, lng, delivery_time, boxes, service_time_s }]
// hq_coord: { lat, lng }
// settings: { safety_margin_min }
//
// Returnerer:
// {
//   feasible: bool,
//   pickup_time: 'HH:MM',                    // Fælles afgang fra HQ
//   ordered_stops: [{ bon_id, sequence, eta, distance_from_prev_m, duration_from_prev_s }],
//   total_km, total_minutes,
//   warnings: [{ bon_id, type: 'tight_buffer', minutes_buffer }],
//   errors:   [{ bon_id, type: 'cant_meet_deadline' }]
// }
```

VROOM-input bygges sådan:

```javascript
{
  vehicles: [{
    id: 1,
    start: [hq_lng, hq_lat],
    end:   [hq_lng, hq_lat],
    capacity: [vehicle.max_capacity_boxes],
    time_window: [unixStartOfDay, unixEndOfDay]
  }],
  jobs: stops.map((s, i) => ({
    id: i + 1,
    location: [s.lng, s.lat],
    service: s.service_time_s || 300,
    delivery: [s.boxes],
    time_windows: [[
      unixStart,                                    // Tidligst muligt
      unixOf(s.delivery_time)                       // Senest = delivery deadline
    ]]
  }))
}
```

VROOM returnerer rute med `arrival`-timestamps. Vi konverterer til:
- `pickup_time` = vehicle's `start` arrival (= afgang fra HQ)
- Hvert stops `eta` = job arrival
- Foreslået bon `pickup_time` = route's pickup_time (alle stop på turen)

### `services/delivery_calc.js`

Single-bon beregning brugt ved bon-oprettelse og formbuilder:

```javascript
async function calculateForBon(bon)
// returnerer:
// {
//   suggested_vehicle_type: 'bike' | 'volvo' | 'taxi',
//   distance_m, duration_s,
//   estimated_pickup_time: 'HH:MM',
//   alternatives: [
//     { vehicle_type, cost, suitable: bool, reason: '...' }
//   ]
// }
```

Logik:
1. Beregn afstand HQ → leveringsadresse via OSRM (cache i `geo_calculations`)
2. For hver vehicle-type i `delivery_vehicles WHERE is_active=1`: tjek constraints (max_distance, max_capacity)
3. Foreslå billigste suitable
4. `estimated_pickup_time` = `delivery_time - duration_s - safety_margin_min × 60`

### `services/route_planner.js`

Orchestrerer VROOM-kald + DB-skrivning:

```javascript
async function computeRoute(routeId)
// Henter route + stops fra DB
// Henter vehicle-config
// Kalder vroom.planRoute()
// Returnerer forslag som JSON (skriver IKKE til DB endnu)

async function applyRouteProposal(routeId, proposal)
// Skriver bekræftet plan:
//   - Opdaterer delivery_routes (pickup_time, total_km, total_min, estimated_cost, geojson)
//   - Opdaterer/sletter delivery_route_stops så de matcher proposal.ordered_stops
//   - Opdaterer bons.pickup_time hvor det er ændret
//   - Skriver til changelog: "Pickup ændret af rute-planlægger"
//   - Sætter status='computed'
```

---

## API-endpoints

Alle under `/api/delivery/`. Auth: standard session-baseret (`req.session.userId`). Permissions tjekkes via `req.session.permissions.delivery_manage` hvor relevant.

| Method | Path | Formål |
|--------|------|--------|
| GET | `/routes?date=YYYY-MM-DD` | Hent dagens ture med stops |
| POST | `/routes` | Opret ny tom tur. Body: `{ route_date, vehicle_id }` |
| PUT | `/routes/:id` | Opdater tur (driver, notes, vehicle_id) |
| DELETE | `/routes/:id` | Slet tur (kun hvis status='draft') |
| POST | `/routes/:id/stops` | Tilføj stop. Body: `{ bon_id }` |
| DELETE | `/routes/:id/stops/:bon_id` | Fjern stop |
| POST | `/routes/:id/compute` | Kør VROOM. Returnerer forslag. |
| POST | `/routes/:id/apply` | Bekræft forslag (skriver til DB) |
| POST | `/routes/:id/confirm` | Endelig bekræftelse → status='confirmed' (uden booking-handling) |
| GET | `/routes/:id/booking-payload` | Returnerer booking_method + url + clipboard_text + summary |
| POST | `/routes/:id/book` | Marker booket. Body: `{ reference?, status: 'booked'\|'in_progress'\|'failed' }` |
| POST | `/confirm-and-book` | Bulk-bekræft alle ture for en dato + trigger booking-flow. Body: `{ route_date }`. Returnerer per-tur status + manuelle bookings der kræver UI |
| GET | `/calendar?user_id=&from=&to=` | Kalender-view: confirmed ture for en bruger eller alle |
| POST | `/routes/:id/actual-cost` | Office indtaster faktisk omkostning. Body: `{ amount_dkk, source: 'manual'\|'api', note? }` |
| GET | `/history?address_id=&from=&to=&limit=` | Historiske leveringer til en adresse (til mini-kort indikator) |
| GET | `/history/heatmap?from=&to=&vehicle_type=&category=` | Aggregerede data for heatmap (3D.8) |
| GET | `/history/report?type=details\|aggregates&from=&to=` | Rapport-data: detaljer pr. bon eller aggregater pr. kategori/zone/pax |
| POST | `/stops/:id/status` | Status-skift fra courier. Body: `{ status: 'leveret'\|'problem', lat?, lng? }` (klar sættes automatisk når køkken markerer bon som KLAR) |
| POST | `/incidents` | Log problem. Multipart for foto. |
| GET | `/incidents?unresolved=1` | Office-view: åbne incidents |
| PATCH | `/incidents/:id` | Opdater (resolution_notes, resolved_at) |
| POST | `/messages` | Send besked til courier. Body: `{ route_id, body }`. Triggers SSE event til mobile |
| POST | `/messages/:id/ack` | Courier markerer besked som læst |
| GET | `/messages?route_id=&unacked=1` | Hent beskeder for en tur eller alle ulæste |
| POST | `/calculate` | Single-bon beregning. Body: `{ bon_id }` eller `{ lat, lng, delivery_time, boxes }` |
| GET | `/courier/today` | Mobile: courier's egne stop i dag |

### Eksempel: `POST /routes/:id/compute`

Request body: tom.

Response:
```json
{
  "feasible": true,
  "proposal": {
    "pickup_time": "11:35",
    "ordered_stops": [
      { "bon_id": 3447, "sequence": 1, "eta": "11:55", "distance_from_prev_m": 4200, "duration_from_prev_s": 720 },
      { "bon_id": 3425, "sequence": 2, "eta": "12:25", "distance_from_prev_m": 1400, "duration_from_prev_s": 360 },
      { "bon_id": 3448, "sequence": 3, "eta": "13:50", "distance_from_prev_m": 3600, "duration_from_prev_s": 1080 }
    ],
    "pickup_changes": [
      { "bon_id": 3425, "from": "11:30", "to": "11:35", "diff_min": 5 },
      { "bon_id": 3448, "from": "13:00", "to": "11:35", "diff_min": -85 }
    ],
    "total_km": 18.5,
    "total_minutes": 72,
    "estimated_cost_dkk": 75,
    "warnings": [
      { "bon_id": 3448, "type": "tight_buffer", "minutes_buffer": 10 }
    ],
    "errors": []
  }
}
```

Hvis `feasible=false`, har `errors` `cant_meet_deadline`-entries og frontend viser dem.

---

## Frontend — to zoner

### Office: `/office/logistik`

Samme komponent håndterer både planlægning og live-mode. **Datoen styrer mode** — datovælger viser i dag → live elementer aktive; viser fremtid → planlægnings-elementer aktive. Brugeren kan eksplicit skifte med "Plan i morgen"-knap (når i live) eller "I dag"-knap (når i plan).

**Tre kolonner, responsive:**

| Kolonne | Indhold |
|---------|---------|
| Bons (venstre) | Dagens bons der har `delivery_method != 'pickup'`. Drag-source i plan-mode. I live-mode: viser dagens bons med leverings-status |
| Kort (midten) | Leaflet + OSM. HQ + bons som markører. Kørerute fra OSRM tegnes når status≥'computed' |
| Ture (højre) | Liste af `delivery_routes` for valgt dato. Drop-target i plan-mode. Live status i I-dag-mode |

**Sidebar er kollapsibel** — toggle-knap øverst på sidebar gør den til 50px (kun ikoner), så kortet kan udvides ved behov. Tilstand huskes pr. bruger.

**Mockup-referencer:**

| Mockup | Hvad den dækker |
|--------|-----------------|
| `plan_imorgen_v2.html` | Plan-mode: drag-and-drop, VROOM-modal, 3-kolonne layout |
| `i_dag_view_v2.html` | Live-mode: status-stat-bar, send-besked-knap, sidebar-collapse, kun 3 status-farver (PLANLAGT/KLAR/LEVERET) + PROBLEM |
| `tur_card_varianter_v2.html` | Alle states af route-card: draft/computed/confirmed × booking-status × live-status. 9 varianter samlet |
| `bekraeft_og_bestil_v2.html` | "Bekræft og bestil"-modal: validering, kompakt liste, sekventielt booking-flow, partial state |
| `manual_booking_modal_v1.html` | Manual booking-modal: clipboard-preview, ref-input, edit-mode, multi-stop håndtering, manglende felter |

Frontend skal følge mockups pixel-tæt for layout, farver, og flows.

### Status-farver (vigtigt — én sandhed)

Status-farver i delivery-modulet **matcher** `bon_status_definitions`-tabellen. Ingen separat farve-palet.

| Stop-status | Bon-status | Farve | Hex |
|-------------|------------|-------|-----|
| `planlagt` | NY/GODKENDT/IGANG | Blå | `#7594b3` |
| `klar` | KLAR | Grøn | `#6ab04c` |
| `leveret` | LEVERET | Grå | `#8a8580` |
| `problem` | (incident logget, bon-status uændret) | Rød | `#bc181b` |

Hvis bon-status farver ændres i `status_definitions`, skal delivery-UI'et reflektere det automatisk via CSS-variabler.

### Plan-mode flow ("Plan i morgen"):

1. Tilføj tur via dropdown → `POST /routes`
2. Drag bon → tur → `POST /routes/:id/stops`
3. "Beregn rute"-knap → `POST /routes/:id/compute` → vis modal med proposal
4. "Acceptér" → `POST /routes/:id/apply` → opdater UI + **pickup-tider gemmes på bons med det samme** (køkkenet ser dem)
5. **"Bekræft og bestil"** topbar-knap → `POST /confirm-and-book` med dato:
   - Valideringer kører (uplanlagte bons, kapacitet)
   - For hver tur baseret på `vehicle.booking_method`:
     - `calendar` → confirmed direkte
     - `api` → kald API, gem ref
     - `manual_clipboard` → vis booking-modal sekventielt (én tur ad gangen)

### Live-mode flow ("I dag"):

1. Stat-bar øverst viser **3 nøgletal**: Leveret · På vej · Problem
2. Tur-cards har:
   - Sequence-tal i status-farve
   - **Send-besked pille-knap** ("💬 Send") synlig i header for **interne courier kun** (Volvo, egen cykel) — eksterne har ingen
   - Faktisk-tid vs planlagt (orange hvis sent)
3. Ny bon ankommer:
   - Toast øverst i bons-kolonne (blå, NY-status farve)
   - Bon-card med "NY"-badge i bons-kolonne
4. Stop får `status='leveret'` når **kunden** har modtaget (courier trykker leveret på mobile)
   - Stop får `status='klar'` automatisk når **bonnens status** skifter til KLAR (køkken markerer)
   - Det er bon-systemet der driver den state, ikke delivery-modulet
5. Problem trigger:
   - Stop får `status='problem'`
   - Tur-card får rød kant + booking-footer med "Vis"-knap
   - Bon-card i venstre kolonne får rød "⚠ Problem"-chip

### Bekræft plan-tjek (før booking-flow):

- Alle bons med `delivery_method != 'pickup'` skal være tildelt en tur
- Sum kasser pr. unikke pickup_time ≤ `delivery_kitchen_capacity_boxes`

Hvis fejl: vis konkret hvad og hvor (toast eller dialog). Booking-flow startes ikke.

### Booking-modal (`manual_clipboard`):

1. Hentes data via `GET /routes/:id/booking-payload`
2. Viser stop-oversigt + clipboard-tekst i preview (mørkt code-block)
3. **Manglende felter** markeres inline som `[mangler]` i preview + gul advarsel-boks øverst (ikke-blokerende)
4. **"Rediger"-toggle** øverst — gør preview til editable textarea (lokal kun, ikke gemt)
5. **"Kopiér og åbn"-knap** (én knap, to handlinger): `navigator.clipboard.writeText()` + `window.open(booking_url)` i nyt vindue. Knap-label skifter til "Kopiér igen og åbn taxa.nu" efter første klik
6. Felt for booking-ref (valgfri)
7. "Marker som booket" → `POST /routes/:id/book` med `status='booked'` og ref
8. "Spring over" → `POST /routes/:id/book` med `status='in_progress'` (ture markeres med advarsel-indikator i listview)

### Listview af ture med booking-status:

Tur-card har **én badge i header** baseret på kombination af `status` og `booking_status`:

| `booking_status` | Visning i header-badge |
|------------------|------------------------|
| `pending` (før confirm) | Status-badge i stedet ("Kladde" eller "Beregnet") |
| `not_required` (calendar-type) | Grøn "I kalender"-badge |
| `booked` (api eller manual) | Grøn "Booket via API" eller "Booket manuelt"-badge |
| `in_progress` | Gul klikbar "Afventer"-badge + booking-footer med "Book nu"-knap |
| `failed` | Rød klikbar "Fejlede"-badge + booking-footer med "Prøv igen"-knap |

**Booking-ref vises** som monospace-pille (`<code>BE-7821</code>`) i meta-linjen. Klik kopiérer til clipboard.

**Completed-ture** vises i listview med 70% opacity. Bruger kan kollapse dem (default styres af `delivery_completed_routes_collapsed` setting). Tilstand huskes pr. bruger i localStorage.

### "Afventer booking"-banner:

Når der er ture med `booking_status='in_progress'` i dagens dato, vises en gul banner øverst i højre kolonne (over tur-listen):

```
⚠ N ture afventer booking         [chevron]
   ↓ udvidet:
   - Tur-navn · "Book nu"-knap
   - Tur-navn · "Book nu"-knap
```

Banneret forsvinder automatisk når alle er booket.

### Selection-state binding (kort ↔ sidebar)

Plan-i-morgen og I-dag-views har bidirektional highlighting mellem kort-markører og bon-cards i venstre kolonne:

| Handling | Effekt |
|----------|--------|
| Klik på markør på kortet | 1. Bon-card i venstre kolonne får brun ramme + scroll-into-view · 2. Tur-card i højre kolonne med samme bon highlightes også |
| Klik på bon-card i venstre kolonne | Markør på kortet pulserer kort + zoomes til |
| ESC-tast eller klik udenfor | Selection ophæves |

State holdes i frontend via `selected_bon_id`. Ingen backend-roundtrip — det er ren UI-state.

### Mini-kort komponent (genanvendelig)

En genanvendelig Leaflet-baseret komponent der bruges fra **flere views** — ikke kun delivery:

**Brugskontekst:**
- Kitchen-bon (klik på adresse → modal med mini-kort)
- Office bon-drawer (klik på adresse → modal eller inline)
- CRM kunde-side (vis adresser-kort)
- Andre fremtidige views der har brug for "vis hvor"

**Komponent: `frontend/components/mini-map.js`**

```javascript
// Usage
mountMiniMap(container, {
    address_id: 1234,           // henter coords + history
    show_history: true,          // viser "5 tidligere leveringer"-indikator
    show_link_to_logistics: true, // "Se i logistik"-knap
    show_link_to_external: true,  // "Google Maps"-knap (sekundær)
    height: 240
});
```

**Visning:**
```
┌────────────────────────────┐
│  [Leaflet pin på adresse]  │
│  Åbenrå 34, 1124 Kbh K     │
│                            │
│  📍 5 tidligere · ca. 380-510 kr │
└────────────────────────────┘
[ Se i logistik ]  [ Google Maps ↗ ]
```

"Se i logistik"-knappen springer til `/office/logistik?date=YYYY-MM-DD&highlight_bon=N`. Datoen styrer mode (i dag → live, fremtid → plan). Highlight-parameter selecter automatisk bon når viewet loader.

### Office: `/office/leveringshistorik` (3D.8 — selvstændig)

Selvstændig analyse-side. Mockup ikke designet endnu — designes når 3D.8 startes.

**Modes:**
- **Heatmap** — densitet-baseret farvning, hvor leverer vi mest?
- **Punkter** — individuelle leveringer, klik → bon-info popover
- **Cluster** — automatisk gruppering ved zoom-out (Leaflet.markercluster)

**Filtre:**
- Dato-range (default: sidste 12 måneder)
- Transport-type (alle / volvo / bike / own-bike / taxi)
- Kunde (søgefelt)
- Kategori (sandwich / sliders / kager / drikke — fra bon-data)
- Pax-bracket (1-10 / 11-25 / 26+)

**Stats-panel** (right sidebar):
- Total leveringer i filter
- Total km
- Mest besøgte zoner (top 10 postnumre)
- Snit km pr. levering
- Snit pr. pax-bracket

**Performance:**
- Server-side aggregering — frontend modtager kun de punkter der vises i nuværende viewport
- Cluster-mode default ved >500 punkter
- Heatmap genereres serversidigt for at undgå Leaflet.heat overload

### Office rapporter

Tilgængelige fra `/office/rapporter/levering` (eller embedded i logistik-side):

**Rapport 1: Leverings-detaljer (office-only)**

Per-bon detaljer for office. Adgang via rolle `logistics_admin`.

| Kolonne | Kilde |
|---------|-------|
| Bon-nr | `bons.bon_number` |
| Kunde | `customers.name` |
| Pax | `bons.pax` |
| Afstand | `delivery_route_stops.distance_from_prev_m` (sum) |
| Leveringstidspunkt (faktisk) | `delivery_route_stops.completed_at` |
| Estimeret cost | `delivery_routes.estimated_cost_dkk` |
| Faktisk cost | `delivery_routes.actual_cost_dkk` |
| Cost-source | `delivery_routes.actual_cost_source` |
| Diff (faktisk − estimat) | beregnet |

CSV-eksport tilgængelig.

**Rapport 2: Aggregater**

Drift-overblik tilgængelig for alle office-roller.

| Snit | Vis |
|------|-----|
| Pr. transport-type | Total km, antal ture, snit-cost |
| Pr. zone (postnummer) | Antal leveringer, total km |
| Pr. kategori | Sandwich / Sliders / Kager / Drikke (fra `bons.category` eller bon-linjer) |
| Pr. pax-bracket | 1-10, 11-25, 26+ med antal og snit km |

Bemærk: kunde-fakturapris ikke i rapporterne — den lever i e-conomic. Hvis I senere vil have margin-rapport: tilføj e-conomic-integration som 3D.10.

### Mobile: `/m/levering` (courier)

PIN-login (eksisterende mobile shell). Lander på dagens egne stop hvis bruger er tildelt en tur. Hvis ikke: tom tilstand med "Du har ingen leveringer i dag".

**Mockup-reference:** `courier_mobile_v5.html` (godkendt). Inkluderer dual-kontakter (på dagen + bestiller), prominent pickup-info, problem-flow, og navigations-knapper.

**Skærme:**
1. Dagens tur — liste af stop med sequence, customer, adresse, status. **Inkluderer "Tilbage til HQ"-card efter sidste stop** med naviger-knap til HQ-adresse fra settings
2. Stop-detalje — kort-link, kontakt-blokke (på dagen + bestiller), delivery_notes, pickup-info, indhold, action-bar
3. Problem-modal — 3 trin (type → foto+geo+note → bekræft) → `POST /incidents`

**Navigations-knapper:**
Buddet skal kunne navigere fra sin nuværende position til både kunder og tilbage til HQ. To knap-typer:

| Knap | URL-format (Google Maps default) |
|------|----------------------------------|
| **➤ Naviger til kunden** (primær, fuld bredde) | `https://www.google.com/maps/dir/?api=1&destination={ENCODED_ADDRESS}&travelmode=driving` |
| **📍 Vis pin** (sekundær, ikon-only) | `https://www.google.com/maps/search/?api=1&query={ENCODED_ADDRESS}` |
| **➤ Naviger til HQ** (på "Tilbage til HQ"-card) | Samme som naviger-til-kunde, men med `delivery_hq_address` fra settings |

URL'erne åbner Google Maps app på både iOS og Android (hvis installeret), ellers Google Maps i browser. Settings-key `delivery_navigation_provider` styrer hvilken provider der bruges (default `google` — virker overalt).

**Status-knapper kalder:** `POST /stops/:id/status` med body `{ status: 'leveret' | 'problem', lat, lng }`.

**Modtag besked fra office:**
SSE-kanal `delivery_message_to_courier` på mobile shell. Når besked modtages: vis modal/toast med tekst, "✓ OK"-knap → `POST /messages/:id/ack`.

**Kontakt-logik:**
```js
const showSecondary = bon.delivery_contact_phone
                      && bon.delivery_contact_phone !== bon.ordering_contact_phone;
```
Hvis `showSecondary=true`: to kontakt-blokke. Ellers: én.

**Telefon-links:** brug `tel:` og `sms:?body=`. SMS-template kan være `Hej ${name}, Ristet Rug her — vi er på vej til levering på ${address}.`

**Office-knap (nødløsning):** ringer til `delivery_office_phone` fra settings. Vis altid nederst.

---

## Faseopdeling

| Fase | Indhold | Implementér i denne rækkefølge |
|------|---------|-------------------------------|
| **3D.0** | Docker setup: OSRM + VROOM kørende på Hetzner. Test med curl | Først |
| **3D.1** | `services/osrm.js`, `services/delivery_calc.js`, migration med `delivery_vehicles` + seed. `POST /api/delivery/calculate`. Constraint-check ved bon-oprettelse | Parallel med v1-shutdown |
| **3D.2** | Migration med `delivery_routes` (inkl. `actual_cost_dkk`-felter), `delivery_route_stops`, `delivery_incidents`, `delivery_messages`. `services/vroom.js`, `services/route_planner.js`. Office route-planner UI ifølge mockup. **Inkluderer OSRM-tegnet rute på kortet fra dag ét.** Sidebar-collapse-feature i office. **Mini-kort komponent** (genanvendelig). **Selection-state binding** mellem kort og sidebar. **"Tidligere leveringer hertil"-indikator** baseret på Bon v2's egne data | Efter v1-shutdown |
| **3D.3** | Mobile `/m/levering` UI ifølge mockup. Status-endpoints. Foto-upload-håndtering. Naviger-knapper (Google Maps URL). "Tilbage til HQ"-card. **Push-beskeder fra office (modtagelse + ack)** via SSE | Sammen med 3D.2 |
| **3D.4** | **Bestillings-trinet:** `services/booking_template.js`, `POST /routes/:id/book`, `POST /confirm-and-book`, `GET /calendar`. Modal-flow for `manual_clipboard` (taxa). Intern kalender-view i office-dashboard og mobile. **"I dag"-mode i office med live status, send-besked-modal, tur-card varianter med booking-status indikatorer.** **Manuel `actual_cost`-indtastning** for taxa via tur-card. Indtil 3D.5 er By-expressen midlertidigt sat til `manual_clipboard` med deres bestillingsside som URL | **Kritisk-path — sammen med 3D.2/3D.3** |
| **3D.5** | `services/byekspressen.js` — booking via deres API. Tracking-callback. Auto-status-opdatering. **Auto-registrering af `actual_cost_dkk` fra API-respons.** Skift `byekspressen.booking_method` fra `manual_clipboard` → `api` | Når Sebastian svarer med credentials |
| **3D.6** | Multi-stop ture for cykel/taxa (allerede understøttet i datamodel — kun UI-justering) | Når behovet opstår |
| **3D.7** | SMS-templates til courier-besked-modal. Auto-besked-templates (fx "kunden har ringet" når en bestemt event sker) | Efter feedback fra brug |
| **3D.8** | Leveringshistorik-side: selvstændig `/office/leveringshistorik` med heatmap + punkter + cluster + filtre. Server-side aggregering for performance. **Rapporter** (detaljer + aggregater) tilgængelige fra `/office/rapporter/levering` | Senere |
| **3D.9** | iCal-eksport fra `delivery_routes` (hvis behov for ekstern kalender-sync) | Hvis behov opstår |
| **3D.10** | e-conomic API-integration for at hente faktisk fakturapris til kunden. Muliggør komplet margin-rapport. Opvejer kompleksitet vs. værdi når Bon v2 har kørt et stykke tid | Hvis behov opstår — ikke planlagt |

---

## Pris-arkitektur (3 niveauer)

Bon v2 håndterer **ikke** kunde-fakturapris. Den bor i e-conomic. Bon v2 har derimod tre pris-niveauer der hjælper office med at sætte en god fakturapris:

| Niveau | Hvor gemmes | Hvornår sættes | Formål |
|--------|-------------|----------------|--------|
| **Estimat** | `delivery_routes.estimated_cost_dkk` | Når rute beregnes (3D.2) | Intern planlægning, viser "ca."-pris |
| **Faktisk omkostning** | `delivery_routes.actual_cost_dkk` + `actual_cost_source` | Auto via API (3D.5) eller manuel | Hvad turen rent faktisk kostede os |
| **Kunde-fakturapris** | e-conomic (ikke i Bon v2) | Manuelt af salg når faktura forberedes | Hvad kunden betaler |

### Cost-formel for estimat (`services/cost.js`)

| Vehicle type | Formel |
|--------------|--------|
| `volvo` | `base + (per_km × total_km)` |
| `bike` (By-expressen) | `base + max(0, (total_boxes - included_boxes)) × extra_box_cost` |
| `own-bike` | `base` (typisk 0) |
| `taxi` | `base + (per_km × total_km)` |

Estimat er **kun** et planlægnings-input. Vises i UI med "ca."-præfiks. Påvirker ikke faktura.

### Faktisk omkostning — to kilder

| Kilde | Hvornår | Hvor sættes | Setting |
|-------|---------|-------------|---------|
| **API** | Når By-expressen-kvittering kommer (webhook) | Auto via `services/byekspressen.js` (3D.5) | `actual_cost_source = 'api'` |
| **Manuel** | Office indtaster når faktura fra taxa modtages | Office UI: indtastningsfelt på tur-card | `actual_cost_source = 'manual'` |

For Volvo og egen cykel: ingen faktisk omkostning (vi betaler ikke leverandør). `actual_cost_dkk` forbliver NULL eller sættes = `estimated_cost_dkk` afhængigt af konvention.

### "Tidligere leveringer hertil"-indikator

Når office planlægger en bon eller åbner mini-kort, hentes seneste 5 leveringer til samme adresse:

```sql
SELECT
    r.actual_cost_dkk,
    r.actual_cost_source,
    r.estimated_cost_dkk,
    r.route_date
FROM delivery_routes r
JOIN delivery_route_stops s ON s.route_id = r.id
JOIN bons b ON b.id = s.bon_id
WHERE b.delivery_address_id = ?
    AND r.status = 'completed'
ORDER BY r.route_date DESC
LIMIT 5;
```

Vises som: "📍 5 tidligere leveringer · estimat ca. 380-510 kr · faktisk 420-510 kr"

Det erstatter algoritmer for prisforudsigelse — det er **historik som reference**, ikke prediktion. Office beslutter selv hvad de skriver i e-conomic.

### Hvorfor ikke e-conomic-data

Bon v2 trækker bevidst **ikke** fakturapriser fra e-conomic. To grunde:

1. **Implementerings-tid** — e-conomic API-integration er ikke kritisk-path
2. **Det meste kan klares fra Bon v2's egne data** — By-expressen API giver faktisk pris, taxa er sjælden nok til manuel registrering

Hvis behovet senere opstår (fx for komplet margin-rapport): tilføj som dedikeret fase 3D.10.

---

## Constraint-formel (pickup-tid)

For multi-stop ture: **alle stop har samme pickup-tid = afgang fra HQ**.

```
For hvert stop i: 
    earliest_pickup_i = delivery_time_i 
                        - sum(duration_from HQ til stop_i, inkl. tidligere stops + service-tid)
                        - safety_margin_min

route.pickup_time = MIN(earliest_pickup_i for i in stops)
                    -- dvs. det stramme stop bestemmer afgang
```

Køkken-kapacitet:
```
For hver pickup_time t:
    capacity_used_t = sum(boxes for alle bons med pickup_time = t)
    Hvis capacity_used_t > delivery_kitchen_capacity_boxes
        → advarsel ved "Bekræft plan"
```

---

## Test-strategi

### Unit (Node native test runner)

```javascript
// tests/services/delivery_calc.test.js
test('byekspressen suggested under 8km, 4 boxes', ...)
test('volvo suggested over 8km', ...)
test('taxi suggested when many boxes', ...)

// tests/services/cost.test.js  
test('byekspressen cost: 100 + (boxes-2)*50', ...)
test('taxi cost: 136 + km*19', ...)

// tests/services/route_planner.test.js
test('multi-stop pickup_time = MIN of stop earliest_pickups', ...)
test('feasibility false when delivery deadline cant be met', ...)
```

### Smoke (`scripts/smoke-test.sh`)

Tilføj nye sektioner:

```bash
# OSRM up
curl -sf "$OSRM_URL/route/v1/driving/12.55,55.69;12.58,55.68" >/dev/null \
  && echo "✓ OSRM" || echo "✗ OSRM"

# VROOM up
curl -sf -X POST -H "Content-Type:application/json" \
  -d '{"jobs":[],"vehicles":[]}' "$VROOM_URL" >/dev/null \
  && echo "✓ VROOM" || echo "✗ VROOM"

# Endpoints
curl -sf "http://localhost:4321/api/delivery/routes?date=$(date +%Y-%m-%d)" \
  && echo "✓ /routes"
```

### Manuel acceptance-test

1. Opret bon med adresse i indre by, 2 kasser → forslag skal være `bike`
2. Opret bon med adresse i Albertslund, 6 kasser → forslag skal være `taxi`
3. Tilføj 3 bons til Volvo-tur, beregn → skal returnere én pickup_time for alle 3
4. Bekræft plan med 13 kasser ved samme pickup_time → fejl (kapacitet 12)
5. Mobile: log "stillet ved døren" med foto → skal oprette incident med location

---

## Overgangsstrategi: By-expressen i 3D.4 → 3D.5

By-expressen API er ikke klar i 3D.4 (kræver credentials fra Sebastian). Indtil da behandles By-expressen **præcis som taxa**: manuel booking via deres bestillingsside med clipboard-flow. Det matcher hvordan Bon v1 har kørt indtil nu.

### Konfiguration i 3D.4 (start)

```sql
-- I seed: byekspressen-vehicle
booking_method = 'manual_clipboard'
booking_url = 'https://www.byekspressen.dk/booking'   -- verificér med rigtig URL
booking_template = '... (pre-fyldt template, se seed-eksempel)'
```

Office-flow:
1. Bon planlagt til By-expressen → tur oprettes som normalt
2. "Bekræft og bestil" → manual booking-modal åbner (samme som taxa)
3. Office klikker "Kopiér og åbn" → tekst i clipboard, By-expressens side åbner i nyt vindue
4. Office paster manuelt og bekræfter booking på deres side
5. Booking-ref indtastes (valgfri) i Bon v2
6. **Faktisk omkostning** indtastes manuelt af office når By-expressen-fakturaen modtages (samme tilgang som taxa)

### Migrering til API i 3D.5

Når Sebastian har leveret API-credentials, foretages **én SQL-opdatering**:

```sql
UPDATE delivery_vehicles
SET booking_method = 'api',
    booking_api_config_json = '{
        "endpoint": "https://api.byekspressen.dk/v3/bookings",
        "api_key": "...",
        "webhook_secret": "..."
    }',
    booking_template = NULL,
    booking_url = NULL
WHERE code = 'byekspressen';
```

**Ingen kode-ændring** i frontend eller route-planner — `services/byekspressen.js` aktiveres automatisk fordi `booking_method = 'api'` triggrer det service. UI-flow skifter automatisk:
- Office trykker "Bekræft og bestil"
- Bon v2 kalder API direkte
- Booking-ref kommer tilbage automatisk
- Faktisk omkostning kommer via webhook når levering er gennemført

Hele tiden kører Volvo + egen cykel + taxa uændret. Det er kun By-expressen-routen der skifter mode.

### Hvad der skal verificeres før 3D.4 går live

| Item | Spørgsmål til office |
|------|----------------------|
| By-expressens URL | Er det `byekspressen.dk/booking` eller noget andet? |
| Template-format | Hvilke felter har deres bestillings-side brug for? Vægt? Antal pakker? |
| Dansk eller engelsk? | Skriver I dansk eller engelsk i deres formular? |
| Specielle instrukser | Er der noget særligt I altid skriver? Fx "Skåne emballage" eller lignende |

Når office har bekræftet, opdater seed-template før 3D.4-deploy.

---

## Tilstødende moduler — krav der ikke er delivery, men interagerer

Følgende krav kom op under design-sessioner, men hører hjemme i **andre moduler** end delivery. Listet her som reference så de ikke glemmes:

| Krav | Modul | Beskrivelse |
|------|-------|-------------|
| Bon låses efter cutoff | Bon-modul | Bons kan ændres frit indtil dagen-før kl 12. Efter: kræver bekræftelse + kommentar. Settings-key: `bon_change_cutoff_hour` (default 12) på dagen-før |
| Aflys-bon-flow | Bon-modul | Manuel sletning fra rute fortsat understøttet. Aflysning logges i changelog med kommentar. Hvis bon er på `confirmed` rute: prompt office om at ringe budfirma |
| Kopiér levering (genvejsbookinger) | Bon-modul (CRM) | "Kopiér og opret ny bon"-knap i CRM på kunde-side. Kopierer linjer + adresse + delivery_contact_*. Dato/tid sættes manuelt |
| Auto-genereret leveringsmetode på faktura | Bon→e-conomic-integration | Når bon faktureres, auto-generér tekst som "Leveret med Volvo" baseret på `delivery_routes.vehicle_id`. Salg behøver ikke indtaste manuelt |
| Bon-form med delivery-felter | Formbuilder/Bon-modul | Felterne `delivery_contact_name`, `delivery_contact_phone`, `delivery_notes` skal kunne udfyldes ved bon-oprettelse. Valgfri felter |
| Constraint-check ved bon-oprettelse | Bon-modul | Når bon oprettes, kald `POST /api/delivery/calculate` for at få forslag til transport-type. Vis i bon-form |
| Leveringsindikator på bon-kort + bon-listview | Bon-modul (kitchen) + Office bon-listview | Visning af transport-type på bon-kortet under "Levering"-linjen. Klik åbner drawer scrollet til leveringssektion. Opdateres realtid via SSE når office planlægger/booker |
| "Bestil bud"-knap i drawer | Bon-modul drawer | Knap der åbner manual booking-modal (eller trigger API-booking). Kun i drawer — ikke på bon-kortet |

Disse skal indarbejdes i de respektive modulers specifikationer. Tilføj som krav i `BON_V2_HUSKELISTE.md` separat fra delivery-sektionen.

### Leveringsindikator på bon-kort og bon-listview — visnings-spec

Bon-kortet i kitchen-view (`bon_kort.js`) og bon-listview i office viser **én linje** med transport-info under "Levering"-linjen (datoen).

**Placering:**
```
┌─────────────────────────────────────┐
│ #cafe-3450             8 ENHEDER    │
│ 11:32 → Lev 12:00                   │
│ Man 4. maj · Levering               │
│ 🚴 By-expressen                     │  ← linjen her
└─────────────────────────────────────┘
```

**Indhold pr. tilstand:**

| Tilstand | Visning |
|----------|---------|
| Ikke planlagt endnu | `📍 Ikke planlagt endnu` (grå tekst) |
| Tildelt tur | `{vehicle_icon} {vehicle.label}` (fx `🚴 By-expressen`) |
| Bon med `delivery_method='pickup'` | `🍱 Afhentning` |

Ingen budnavn, ingen booking-ref, ingen booking-status i v1 — kun transport-type. Holder visningen simpel.

**Klik:** Åbner bon-drawer scrollet til leveringssektion.

**Realtid via SSE:** Når office planlægger eller ændrer bonnen, opdateres linjen automatisk uden refresh.

**SSE-events der trigger opdatering:**

| Event | Hvornår fyres | Hvilke views opdaterer |
|-------|----------------|------------------------|
| `delivery_route_stop_added` | Når bon tilføjes en tur | Bon-kort, bon-listview |
| `delivery_route_stop_removed` | Når bon fjernes fra tur | Bon-kort, bon-listview |
| `delivery_route_status_changed` | Når booking-status ændrer | Tur-card i logistik |
| `delivery_stop_status_changed` | Når stop går til klar/leveret/problem | Bon-kort, tur-card, kort |
| `delivery_message_to_courier` | Office sender besked | Mobile shell |

**Datakilde:**
```sql
SELECT v.label, v.type
FROM delivery_route_stops s
JOIN delivery_routes r ON r.id = s.route_id
JOIN delivery_vehicles v ON v.id = r.vehicle_id
WHERE s.bon_id = ?
```

Hvis ingen række: vis "Ikke planlagt endnu".

---

## Migration fra v1

Eksisterende leveringer i v1 har ingen rute-struktur — hver bon havde bare `delivery_method` + `delivery_time`. Migration:

1. Bons med `delivery_method='delivery'` får INGEN automatisk tildeling til ture
2. Office-team starter forfra med planlægning fra Bon v2 go-live
3. Historiske leveringer bevares via `delivery_events` (eksisterende) til rapportering

**Ingen automatisk rute-bygning fra historik** — det vil give falske forventninger.

---

## Åbne punkter

| Punkt | Status | Handling |
|-------|--------|----------|
| Hetzner-server klar med Docker | ⏳ | Forudsætning for 3D.0 |
| OSM-data udvælgelse: hele DK eller kun Region H? | ⏳ Beslutning | Hele DK = 1.2 GB extract, mere fleksibelt. Region H = 200 MB, hurtigere |
| By-expressen API-credentials | ⏳ Sebastian | Blokerer 3D.5 (ikke 3D.4 — i 3D.4 bruges deres bestillingsside som `manual_clipboard` midlertidigt) |
| Foto-upload til incidents: gemmes hvor? | ⏳ | Foreslag: `uploads/incidents/YYYY/MM/{incident_id}.jpg`. Backup-strategi inkluderes |
| Heatmap-data: ny tabel eller eksisterende? | ⏳ 3D.8 | Bruger `geo_calculations` + `bons` join — formentlig nok |
| Ekstern courier (By-expressen): hvordan ses status i office? | Afklaret | Webhook fra deres API → opdaterer `delivery_routes.booking_status` direkte i 3D.5 |
| Hvad sker hvis OSRM/VROOM er nede? | Afklaret | `services/osrm.js` har timeout 5s + clear error. Frontend viser "Beregning ikke tilgængelig — prøv igen". Manuel rute-bygning fungerer stadig |
| `delivery_contact_*` på bons: udfyldes hvor? | Afklaret | Formbuilder + bon-edit-drawer. Felter er valgfri. Hvis tomme: brug ordering_contact |
| Booking-template format og placering | Afklaret | Pr. vehicle i `delivery_vehicles.booking_template`. Pladsholder-syntax `{name}` + `{stops}` for iterables. Office kan redigere via settings-UI senere |
| Booking-ref obligatorisk? | Afklaret | Nej — opfordres men "Spring over" tilladt. Ture med `booking_status='in_progress'` vises med synlig indikator i office-listview |
| Clipboard API i ældre browsere | Afklaret | Brug `navigator.clipboard.writeText()` som primær. Fallback: midlertidigt textarea + `document.execCommand('copy')` for ældre Safari |
| Stop-status flow: hvor mange states? | Afklaret | 4 states: `planlagt`, `klar`, `leveret`, `problem`. `klar` udledes automatisk fra bon-status (når bon skifter til KLAR i kitchen). `leveret` sættes når courier trykker leveret på mobile. Ingen separat "picked_up" eller "arrived" |
| Status-farver | Afklaret | Genbruger bon-status farver fra `status_definitions`. Ingen separat palet for delivery |
| Navigations-app | Afklaret | Default Google Maps (URL-format virker på iOS+Android). Settings-key `delivery_navigation_provider` kan ændre til Apple/Waze senere |
| Send-besked-knap: hvem kan modtage? | Afklaret | Kun **interne courier** (Volvo, egen cykel). Eksterne (By-expressen, taxa) har ingen — vi kan ikke nå dem direkte |
| Push-besked på mobile: hvordan? | Afklaret | SSE-event `delivery_message_to_courier`. Mobile viser modal/toast, "✓ OK"-knap → `POST /messages/:id/ack`. Ingen native push i v1 |
| Completed-ture: skjul eller vis? | Afklaret | Vis med 70% opacity. Bruger kan kollapse via klik. Tilstand i localStorage |
| HQ-position til "Naviger hjem" | Afklaret | `delivery_hq_address` + `delivery_hq_lat`/`lng` settings. Vises som "Tilbage til HQ"-card efter sidste stop |
| Ny bon ankommer mens dagen kører | Afklaret | Toast øverst i bons-kolonne (blå) + "NY"-badge på bon-card. Ingen native notification |
| Faktisk pris til faktura | Afklaret | Bon v2 holder estimat + faktisk omkostning fra leverandør. **Ikke** kunde-fakturapris (lever i e-conomic). Office sammenligner manuelt og indtaster i e-conomic |
| e-conomic data-hentning | Afklaret — udskudt | Ikke implementeret i v1. Kan tilføjes som 3D.10 hvis behov opstår senere |
| Mini-kort genanvendelig komponent | Afklaret | Bygges i delivery 3D.2, bruges fra kitchen-bon, office-drawer og evt. CRM. Inkluderer "tidligere leveringer hertil"-indikator |
| Selection-state binding | Afklaret | Bidirektional kort↔sidebar highlighting i Plan-i-morgen og I-dag. Frontend-only state. URL-parameter `highlight_bon` for djupelinks fra mini-kort |
| Aflys-bon mid-route | Afklaret | Sker aldrig i praksis — ikke implementeret. Hvis det sker: telefonisk koordinering med køkken og budfirma |
| Drikkepenge | Afklaret | Ikke relevant — ingen ekstra felter |
| Returnerede leveringer | Afklaret | Sker aldrig — vi afleverer altid (med foto hvis ingen er tilstede). `incident_type='left_at_door'` dækker scenariet |
| Kategori i rapport 2 | Afklaret | Sandwich / Sliders / Kager / Drikke. Skal komme fra `bons.category` eller udledes fra bon-linjer (afklares ved 3D.8) |

---

## Rækkefølge for første implementering (3D.0 + 3D.1)

1. Docker-compose for OSRM + VROOM på Hetzner
2. OSM-data extract og forberedelse
3. `services/osrm.js` med tre funktioner + tests
4. Migration: `delivery_vehicles` + seed med 4 standard-køretøjer (inkl. `booking_method`, `booking_template` for taxa)
5. `services/cost.js` med `calculateRouteCost()` + tests
6. `services/delivery_calc.js` + tests
7. `routes/delivery.js` med `POST /calculate` endpoint
8. Tilføj `POST /api/delivery/calculate`-kald til formbuilder og bon-opret
9. Smoke-test sektion opdateret
10. Verificér: opret testbon, se foreslået transport, sammenlign med gammel beregner

Når 3D.1 er stabilt: gå videre til 3D.2 (datamodel + VROOM + office UI).

---

## Mockup-filer — bindende source of truth

Alle frontend-implementeringer skal følge mockup-filer pixel-tæt for layout, farver, og flows. Ved tvivl: mockup'en er sandheden, ikke spec-tekst.

| Fil | Dækker | Status |
|-----|--------|--------|
| `courier_mobile_v5.html` | Mobile courier: dagens tur, stop-detalje, problem-flow, naviger-knapper, tilbage-til-HQ | Godkendt |
| `plan_imorgen_v2.html` | Office Plan-mode: drag-and-drop, VROOM-modal, 3 kolonner | Godkendt |
| `i_dag_view_v2.html` | Office Live-mode: stat-bar, send-besked, sidebar-collapse, 3 status-farver | Godkendt |
| `tur_card_varianter_v2.html` | Alle tur-card states sammen — Simon's reference for alle kombinationer | Godkendt |
| `bekraeft_og_bestil_v2.html` | "Bekræft og bestil"-modal: 4 states + "Afventer booking"-banner | Godkendt |
| `manual_booking_modal_v1.html` | Manual taxa-booking: clipboard, ref-input, edit, multi-stop | Godkendt |

---
