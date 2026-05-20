# CLAUDE_DELIVERY_MVP.md — Spor 2 Minimum Viable Plan
> Læs FØR du starter implementering. Pegen videre til `CLAUDE_DELIVERY.md` for fuld vision.
> Skrevet: 20. maj 2026.
>
> **Formål:** klippe den fulde delivery-spec (3D.0–3D.10) ned til det MVP-sæt der lukker Bon v1 ned og kan udvides bagefter.

---

## 1. Hvad er Spor 2 MVP?

Det mindste sæt features der gør at office kan **planlægge + bestille + følge dagens leveringer** uden at logge ind i v1's Bon Map.

**Spor 1 (manuel bestilling via popout) er allerede i drift.** Spor 2 MVP bygger ovenpå, ikke i stedet for.

### Skala-tjek der driver beslutningerne

- 3-5 Volvo-ture/uge, typisk 1-2 stop per tur
- ~50 nye bons/uge
- 2 interne courier (Volvo, egen cykel), 2-3 eksterne (By-expressen, taxa)
- ~60 routing-API-kald/uge

Hele MVP'en er dimensioneret efter denne skala. Hvis I vokser 10x kan flere stykker rationaliseres opad (VROOM, multi-vehicle solver osv.).

---

## 2. Routing: ingen ekstern engine — fugleflugt × by-faktor

### Beslutning og rationale

**Ingen routing-engine i MVP.** Distance og tid beregnes direkte i Node.js fra fugleflugt + en by-faktor + per-vehicle gennemsnitshastighed.

Hvorfor det er nok for jeres skala:
- 1-2 stop per tur, primært indre by → fugleflugt × 1.4 ligger inden for ±10 % af faktisk køreafstand
- Constraint-check er "kan deadline holdes?", ikke "præcis ETA på sekundet" — 10 min safety-margin kompenserer for unøjagtighed
- Cykel tager genveje, så fugleflugt × 1.2-1.3 er ofte tættere på real-world end OSRM's bil-baserede ruter

Bevidst fravalg:
- **OSRM Docker**: kræver Docker-stack på Hetzner, OSM-data-vedligehold, ~1 GB RAM. Over-engineering for 60 routing-kald/uge
- **Mapbox/Google**: ekstern dependency, TOS, betalingsrisiko ved skala-vækst
- **GraphHopper OSS**: stadig Docker, ingen reel gevinst over OSRM

Hvis præcision viser sig at være utilstrækkelig efter pilot-uge: tilføj OSRM som 3D.6 uden at ændre interface, datamodel eller frontend. Se sektion 14.

### Tre lag der lander os på realistiske tider

```
faktisk_eta = fugleflugt × CITY_FACTOR / SPEED + SAFETY_MARGIN
```

| Lag | Hvad | Default | Setting-key |
|---|---|---|---|
| Fugleflugt | Haversine-formel fra koordinater | — | (ingen) |
| City-faktor | Konverterer fugleflugt → real afstand | 1.4 | `delivery_city_factor` |
| Speed (per vehicle) | Gennemsnitshastighed i by | Se nedenfor | `delivery_speed_kmh_<type>` |
| Safety margin | Buffer mod uforudsete | 10 min | `delivery_safety_margin_minutes` |

**Default-hastigheder** (justérbare per vehicle-type via settings):
- `volvo`: 25 km/t (indre by med læsning/parkering)
- `bike`: 15 km/t
- `own-bike`: 15 km/t
- `taxi`: 30 km/t (kan bruge busbaner, kortere stops)

### Selvkalibrering — gør estimaterne præcise over tid

To parallelle kalibreringsspor, samme princip:

**Tid (ETA)**: Når `delivery_route_stops.completed_at` sættes, log differensen mellem beregnet ETA og faktisk ankomst i `delivery_eta_log`. Efter 50+ leveringer kan office justere `delivery_city_factor` og per-vehicle-hastigheder evidence-based.

**Pris (cost)**: Når `delivery_routes.actual_cost_dkk` sættes (taxa manuelt, By-expressen via API fra 3D.5), har vi automatisk evidence for cost-formel-præcision. Ingen ekstra tabel nødvendig — diff'en findes ved `estimated_cost_dkk` vs `actual_cost_dkk`.

Eksempel-output efter 2 måneders drift:
```
ETA-rapport:
  Volvo:   gennemsnitlig afvigelse +3 min (city_factor for lav for over-bro-ture)
  Cykel:   gennemsnitlig afvigelse -1 min (præcis nok)
  Taxa:    gennemsnitlig afvigelse +8 min (speed for høj — taxa er ikke konstant 30 km/t)

Pris-rapport:
  Volvo:   gennemsnitlig diff +12 kr/tur (per_km måske 4,5 i stedet for 4)
  Cykel:   gennemsnitlig diff -8 kr/tur (extra_box_cost måske 45 i stedet for 50)
  Taxa:    gennemsnitlig diff +35 kr/tur (base eller per_km undervurderet)
```

→ Office justerer i Settings (`delivery_city_factor`, `delivery_speed_kmh_*`, `delivery_vehicles.cost_formula_json`) og næste uges estimater er bedre.

Det er den **kraftfulde** del af strategien: I lærer jeres egne faktiske tider og priser over tid, ikke OSM's eller en taxa-prisliste's gæt. Begge dele drives af samme princip: gem snapshot af brugt parameter på rækken, sammenlign med faktisk, vis afvigelse.

### Hvad om Hetzner er nede?

Routing-engine er Node.js-kode i samme proces som Bon v2-serveren. Hvis serveren er nede, er hele Bon v2 nede — ingen separat failure-mode for routing.

`GET /api/delivery/health` returnerer `{ up: true }` så længe Bon v2 svarer. Det er trivielt at implementere og dækker eventuelt fremtidigt swap til OSRM.

---

## 3. Hvad er IKKE i MVP

| Feature | Hvorfor udskudt | Hvornår |
|---|---|---|
| VROOM-stack | Kun værd ved 4+ stop konsekvent. Specen valgte det per default men jeres skala retfærdiggør det ikke | 3D.6 hvis behov |
| Send-besked fra office til courier | SMS/telefon virker fint til 2 interne courier | 3D.7 |
| Multi-stop bookings i popout | Sjælden, per-stop popout dækker indtil videre | 3D.6 |
| Mini-kort-komponent overalt | Brug Google Maps-link fra adresse | Polish |
| Leveringshistorik-side (heatmap) | Vis-i-listview er nok i starten | 3D.8 |
| Selection-state binding (kort↔sidebar↔tur-card) | 3-vejs binding er dyrt at få right | Polish |
| iCal-eksport | Volvo-bud kigger i Bon v2 alligevel | 3D.9 |
| e-conomic-integration | Fungerer fint uden | 3D.10 |
| Sidebar-collapse, completed-routes-kollaps | Polish | Polish |
| By-expressen API (3D.5) | Spor 1's popout dækker | Når Sebastian leverer credentials |
| `delivery_messages`-tabel | Genbrug eksisterende web-order-toast + flag-pattern | 3D.7 |
| Native push på mobile | iOS Web Push kræver Apple Developer Program | Måske aldrig |
| Offline-retry-kø på mobile | 3-5 ture/uge, mobil-dækning i Hovedstaden er stabil | Hvis behov opstår |
| Sub-state `klar` på route_stops | Udledes fra `bons.status_code` — ingen grund til dobbeltbogføring | (drop fra spec) |
| Navigations-provider-setting | Google Maps URL åbner brugerens default-app på iOS/Android | (drop fra spec) |
| "Tilbage til HQ"-card på mobile | Volvo-buddet kender vejen hjem | (drop fra spec) |

---

## 4. Datamodel (én migration)

```sql
-- migrations/0XX_delivery_routes.sql

-- ==========================================
-- TURE
-- ==========================================
CREATE TABLE delivery_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_date DATE NOT NULL,
    vehicle_id INTEGER NOT NULL REFERENCES delivery_vehicles(id),

    courier_user_id INTEGER REFERENCES users(id),
    external_driver_label TEXT,
    external_reference TEXT,

    pickup_time TIME,
    actual_departure DATETIME,
    completed_at DATETIME,

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'computed', 'confirmed', 'active', 'completed', 'cancelled')),

    booking_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (booking_status IN ('pending', 'in_progress', 'booked', 'failed', 'not_required')),
    booking_reference TEXT,
    booked_at DATETIME,
    booked_by_user_id INTEGER REFERENCES users(id),

    total_km REAL,
    total_minutes INTEGER,
    estimated_cost_dkk INTEGER,
    estimated_cost_formula_json TEXT,         -- snapshot af vehicle.cost_formula_json + total_km på beregnings-tidspunkt (kalibreringsdata)
    actual_cost_dkk INTEGER,
    actual_cost_source TEXT
        CHECK (actual_cost_source IN ('api', 'manual') OR actual_cost_source IS NULL),
    actual_cost_at DATETIME,

    route_geojson TEXT,
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
    sequence INTEGER NOT NULL,
    eta TIME,
    distance_from_prev_m INTEGER,
    duration_from_prev_s INTEGER,

    -- BEMÆRK: 3 states i MVP (ikke 4 som specen).
    -- `klar`-tilstand udledes i frontend fra bon.status_code='KLAR'.
    status TEXT NOT NULL DEFAULT 'planlagt'
        CHECK (status IN ('planlagt', 'leveret', 'problem')),
    completed_at DATETIME,

    UNIQUE(route_id, bon_id),
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
    photo_attachment_id INTEGER REFERENCES attachments(id),  -- GENBRUG eksisterende attachments-tabel
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
-- ETA-LOG (selvkalibrering)
-- ==========================================
CREATE TABLE delivery_eta_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_stop_id INTEGER REFERENCES delivery_route_stops(id),
    bon_id INTEGER NOT NULL REFERENCES bons(id),
    predicted_eta TIME NOT NULL,
    actual_arrival DATETIME NOT NULL,
    diff_minutes INTEGER NOT NULL,            -- actual - predicted, positive = sent
    vehicle_type TEXT NOT NULL,
    route_km REAL,
    city_factor_used REAL,                    -- snapshot af setting på beregnings-tidspunktet
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_eta_log_vehicle ON delivery_eta_log(vehicle_type, created_at);

-- ==========================================
-- TILFØJ delivery_notes til bons (hvis ikke allerede tilstede fra Spor 1)
-- ==========================================
-- ALTER TABLE bons ADD COLUMN delivery_notes TEXT;  -- allerede tilføjet i Spor 1
ALTER TABLE bons ADD COLUMN delivery_contact_name TEXT;
ALTER TABLE bons ADD COLUMN delivery_contact_phone TEXT;
```

### Synkronisering med Spor 1's `bons.delivery_vehicle_id`

Spor 1 satte `bons.delivery_vehicle_id` direkte ved manuel booking. Spor 2 introducerer `delivery_route_stops` som autoritativ kilde.

**Pattern**: `delivery_route_stops` er sandhed. `bons.delivery_vehicle_id` bliver en denormaliseret cache holdt i sync via SQLite-triggers (samme mønster som `contact_points` → `companies.email`).

```sql
-- Trigger: når stop tilføjes, opdater bonens vehicle-cache
CREATE TRIGGER trg_route_stop_to_bon_vehicle
AFTER INSERT ON delivery_route_stops
BEGIN
    UPDATE bons SET delivery_vehicle_id = (
        SELECT vehicle_id FROM delivery_routes WHERE id = NEW.route_id
    ) WHERE id = NEW.bon_id;
END;

-- Trigger: når stop fjernes, ryd cache
CREATE TRIGGER trg_route_stop_remove_bon_vehicle
AFTER DELETE ON delivery_route_stops
BEGIN
    UPDATE bons SET delivery_vehicle_id = NULL WHERE id = OLD.bon_id
        AND NOT EXISTS (SELECT 1 FROM delivery_route_stops WHERE bon_id = OLD.bon_id);
END;
```

---

## 5. Settings — nye keys

```sql
INSERT INTO settings (key, value, description) VALUES
('delivery_safety_margin_minutes', '10', 'Buffer udover beregnet køretid (min)'),
('delivery_city_factor', '1.4', 'Multiplier på fugleflugt for at kompensere for vej-omveje (kan justeres efter selvkalibrering)'),
('delivery_speed_kmh_volvo', '25', 'Gennemsnitshastighed Volvo i by'),
('delivery_speed_kmh_bike', '15', 'Gennemsnitshastighed By-expressen cykel'),
('delivery_speed_kmh_own_bike', '15', 'Gennemsnitshastighed egen cykel'),
('delivery_speed_kmh_taxi', '30', 'Gennemsnitshastighed taxa'),
('delivery_kitchen_capacity_boxes', '12', 'Max kasser klar samtidig ved samme pickup-tid'),
('delivery_assumed_delivered_after_min', '30', 'Antag leveret hvis intet hørt efter X min over deadline'),
('delivery_office_phone', '+4533218989', 'Tlf. kontoret — vises som nødløsning i mobile'),
('delivery_default_service_time_min', '5', 'Default service-tid pr. stop (losning hos kunde)'),
('delivery_hq_address', 'Prinsesse Charlottesgade 16, 2200 København N', 'HQ-adresse'),
('delivery_hq_lat', '55.6905', 'HQ latitude'),
('delivery_hq_lng', '12.5510', 'HQ longitude');
```

**Ingen ny `.env`-konfiguration** — routing er ren Node.js-kode der læser settings.

**Bevidst udeladt fra specen**:
- `delivery_auto_accept_*` — alt skal bekræftes i v1
- `delivery_navigation_provider` — Google Maps URL fungerer på iOS+Android
- `delivery_completed_routes_collapsed` — UI-polish, ikke v1
- `delivery_booking_remind_unbooked_after_min` — manuel håndtering er fint ved jeres volumen
- `OSRM_URL` — ingen routing-engine

---

## 6. Backend services

### `services/routing.js`

Navnet er bevidst engine-agnostisk — hvis I senere skifter til OSRM/Mapbox, omskrives filen uden at callerne ændrer sig.

```javascript
const EARTH_RADIUS_KM = 6371;

function haversineKm(a, b) {
  // a, b: { lat, lng }
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1-h));
}

function getSpeedKmh(vehicleType) {
  const key = `delivery_speed_kmh_${vehicleType.replace('-', '_')}`;
  return parseFloat(getSetting(key) || '25');
}

function getCityFactor() {
  return parseFloat(getSetting('delivery_city_factor') || '1.4');
}

function getRoute(coords, vehicleType = 'volvo') {
  // coords: [{lat, lng}, ...] — HQ først og sidst hvis return-til-HQ
  const cityFactor = getCityFactor();
  const speedKmh = getSpeedKmh(vehicleType);

  let totalKm = 0;
  const legs = [];
  for (let i = 1; i < coords.length; i++) {
    const legKm = haversineKm(coords[i-1], coords[i]) * cityFactor;
    const legSec = Math.round((legKm / speedKmh) * 3600);
    legs.push({ distance_m: Math.round(legKm * 1000), duration_s: legSec });
    totalKm += legKm;
  }

  return {
    distance_m: Math.round(totalKm * 1000),
    duration_s: Math.round((totalKm / speedKmh) * 3600),
    geometry_geojson: null,   // ingen polyline; kort viser pins
    legs
  };
}

function getDistance(from, to, vehicleType = 'volvo') {
  return getRoute([from, to], vehicleType);
}

function healthCheck() {
  return { up: true };  // ingen ekstern dependency — altid up
}
```

**Cirka 50 linjer kode i alt.** Ingen Docker, ingen ekstern HTTP, ingen timeout-håndtering, ingen retry-logik.

**Eskalering til OSRM senere** kræver kun at `getRoute()` og `getDistance()` skifter implementation. Returns-formatet er samme.

### `services/delivery_calc.js`

Single-bon constraint-check ved bon-oprettelse. Foreslår vehicle-type baseret på distance + boxes.

```javascript
async function calculateForBon(bon) {
  const hq = { lat: getSetting('delivery_hq_lat'), lng: getSetting('delivery_hq_lng') };
  const { distance_m, duration_s } = await routing.getDistance(hq, bon.address);

  const vehicles = db.prepare('SELECT * FROM delivery_vehicles WHERE is_active=1').all();
  const safetyMargin = parseInt(getSetting('delivery_safety_margin_minutes')) * 60;
  const estimatedPickup = subtractSeconds(bon.delivery_time, duration_s + safetyMargin);

  const alternatives = vehicles.map(v => ({
    vehicle_type: v.type,
    cost: calculateCost(v, distance_m / 1000, bon.total_boxes),
    suitable: checkConstraints(v, distance_m, bon.total_boxes),
    reason: explainSuitability(v, distance_m, bon.total_boxes)
  }));

  return {
    suggested_vehicle_type: alternatives.find(a => a.suitable && a.cost === minCost)?.vehicle_type,
    distance_m,
    duration_s,
    estimated_pickup_time: estimatedPickup,
    alternatives
  };
}
```

### `services/route_planner.js` (uden VROOM)

For 1-2 stop er rute-rækkefølge triviel. For 3+ stop:

```javascript
function computeRoute(routeId) {
  const stops = getStopsByRouteId(routeId);
  const route = getRouteRecord(routeId);
  const vehicle = getVehicle(route.vehicle_id);
  const hq = getHqCoord();
  const safetyMargin = parseInt(getSetting('delivery_safety_margin_minutes')) * 60;

  // Drag-rækkefølge er udgangspunkt — vi optimerer ikke automatisk
  const coords = [hq, ...stops.map(s => s.coord), hq];
  const routing_result = routing.getRoute(coords, vehicle.type);

  // Beregn ETA per stop ud fra legs
  let cumDuration = 0;
  const orderedStops = stops.map((stop, i) => {
    cumDuration += routing_result.legs[i].duration_s + (stop.service_time_s || 300);
    return {
      ...stop,
      eta: addSeconds(routing_result.pickup_time, cumDuration),
      distance_from_prev_m: routing_result.legs[i].distance_m,
      duration_from_prev_s: routing_result.legs[i].duration_s
    };
  });

  // Feasibility: kan deadline holdes for hvert stop?
  const errors = orderedStops
    .filter(s => s.eta > s.delivery_time)
    .map(s => ({ bon_id: s.bon_id, type: 'cant_meet_deadline' }));

  // Pickup_time = MIN(earliest_pickup for hvert stop)
  const pickupTime = computeMinPickupTime(orderedStops, safetyMargin);

  return {
    feasible: errors.length === 0,
    proposal: { pickup_time: pickupTime, ordered_stops: orderedStops, total_km: route.distance_m / 1000, total_minutes: route.duration_s / 60, errors }
  };
}

async function applyRouteProposal(routeId, proposal) {
  // Skriv pickup_time + ETA per stop + total_km til DB
  // Opdater bons.pickup_time (men ikke for bons med status >= KLAR)
  // Sæt status='computed'
  // Broadcast SSE
}
```

**Bemærk**: ingen VROOM. Hvis jeres skala vokser så I konsekvent har 4+ stop per tur, byg det da som 3D.6 — interface i `route_planner.js` ændrer sig ikke for callerne.

### `services/cost.js`

Cost-formel per vehicle-type ud fra `delivery_vehicles.cost_formula_json`. Uændret fra specen, **men**: når estimat beregnes ved route-confirm, snapshot vi formlen + input-værdierne ind på `delivery_routes.estimated_cost_formula_json`. Det giver os data til kalibreringsrapporten senere.

```javascript
function calculateRouteCost(vehicle, totalKm, totalBoxes) {
  const formula = JSON.parse(vehicle.cost_formula_json);
  let cost;
  switch (vehicle.type) {
    case 'volvo': cost = formula.base + formula.per_km * totalKm; break;
    case 'bike': cost = formula.base + Math.max(0, totalBoxes - formula.included_boxes) * formula.extra_box_cost; break;
    case 'own-bike': cost = formula.base; break;
    case 'taxi': cost = formula.base + formula.per_km * totalKm; break;
    default: cost = formula.base || 0;
  }
  return {
    cost_dkk: Math.round(cost),
    snapshot: { vehicle_type: vehicle.type, formula, total_km: totalKm, total_boxes: totalBoxes }
  };
}
```

Når `services/route_planner.js` applyrer et forslag:
```javascript
const { cost_dkk, snapshot } = calculateRouteCost(vehicle, totalKm, totalBoxes);
db.prepare(`
  UPDATE delivery_routes
  SET estimated_cost_dkk = ?, estimated_cost_formula_json = ?
  WHERE id = ?
`).run(cost_dkk, JSON.stringify(snapshot), routeId);
```

### `services/calibration_report.js` (ny — lille rapport-bygger)

```javascript
function buildCostCalibrationReport({ from, to }) {
  // SUM/AVG over delivery_routes hvor begge tal findes
  return db.prepare(`
    SELECT
      v.type AS vehicle_type,
      v.label,
      COUNT(*) AS sample_size,
      AVG(r.actual_cost_dkk - r.estimated_cost_dkk) AS avg_diff_dkk,
      MIN(r.actual_cost_dkk - r.estimated_cost_dkk) AS min_diff,
      MAX(r.actual_cost_dkk - r.estimated_cost_dkk) AS max_diff
    FROM delivery_routes r
    JOIN delivery_vehicles v ON v.id = r.vehicle_id
    WHERE r.actual_cost_dkk IS NOT NULL
      AND r.estimated_cost_dkk IS NOT NULL
      AND r.route_date BETWEEN ? AND ?
    GROUP BY v.id
    HAVING sample_size >= 5
  `).all(from, to);
}

function buildEtaCalibrationReport({ from, to }) {
  // Samme princip, men over delivery_eta_log + group by vehicle_type
  return db.prepare(`
    SELECT
      vehicle_type,
      COUNT(*) AS sample_size,
      AVG(diff_minutes) AS avg_diff_min,
      AVG(city_factor_used) AS avg_city_factor_used
    FROM delivery_eta_log
    WHERE created_at BETWEEN ? AND ?
    GROUP BY vehicle_type
    HAVING sample_size >= 5
  `).all(from, to);
}
```

To endpoints serverer det til en lille office-rapport:
- `GET /api/delivery/calibration/eta?from=&to=`
- `GET /api/delivery/calibration/cost?from=&to=`

Frontend: simpel tabel under `/office/rapporter/levering-kalibrering`. Office klikker "Justér settings" når de er overbevist om at en parameter skal ændres.

### `services/eta_log.js` (ny — selvkalibrering)

```javascript
function logEtaAccuracy(stopId, actualArrival) {
  const stop = db.prepare(`
    SELECT s.eta, s.bon_id, s.route_id, r.total_km, v.type AS vehicle_type
    FROM delivery_route_stops s
    JOIN delivery_routes r ON r.id = s.route_id
    JOIN delivery_vehicles v ON v.id = r.vehicle_id
    WHERE s.id = ?
  `).get(stopId);
  if (!stop) return;

  const predictedDateTime = combineTodayWithTime(stop.eta);
  const diffMin = Math.round((new Date(actualArrival) - predictedDateTime) / 60000);
  const cityFactor = parseFloat(getSetting('delivery_city_factor'));

  db.prepare(`
    INSERT INTO delivery_eta_log
      (route_stop_id, bon_id, predicted_eta, actual_arrival, diff_minutes, vehicle_type, route_km, city_factor_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(stopId, stop.bon_id, stop.eta, actualArrival, diffMin, stop.vehicle_type, stop.total_km, cityFactor);
}
```

Kaldes automatisk når `delivery_route_stops.completed_at` sættes (i route_planner.js eller en SSE-listener).

**Bemærk**: kolonnen `traffic_multiplier_used` i migrationen skal omdøbes til `city_factor_used` for at matche denne implementation. Det er bare ét felt.

---

## 7. API-endpoints (MVP-delsæt)

Alle under `/api/delivery/`. Mountes på toppen af eksisterende `routes/delivery.js` fra Spor 1.

| Method | Path | Formål |
|--------|------|--------|
| GET | `/routes?date=YYYY-MM-DD` | Dagens ture med stops |
| POST | `/routes` | Opret tom tur |
| PUT | `/routes/:id` | Opdater driver/notes/vehicle |
| DELETE | `/routes/:id` | Slet (kun status='draft') |
| POST | `/routes/:id/stops` | Tilføj stop |
| DELETE | `/routes/:id/stops/:bon_id` | Fjern stop |
| POST | `/routes/:id/compute` | Kør route_planner, returner forslag |
| POST | `/routes/:id/apply` | Skriv forslag til DB |
| POST | `/routes/:id/confirm` | Status='confirmed' |
| GET | `/routes/:id/booking-payload` | Genbrug Spor 1's payload-builder |
| POST | `/routes/:id/book` | Marker booket (samme som Spor 1) |
| POST | `/routes/:id/actual-cost` | Office indtaster faktisk pris (samme som Spor 1) |
| POST | `/stops/:id/status` | Mobile courier: leveret/problem |
| POST | `/incidents` | Log problem (multipart for foto) |
| POST | `/calculate` | Single-bon beregning ved bon-opret |
| GET | `/courier/today` | Mobile: courier's egne stop |
| GET | `/calibration/eta?from=&to=` | Selvkalibreringsrapport: tid pr. vehicle |
| GET | `/calibration/cost?from=&to=` | Selvkalibreringsrapport: pris pr. vehicle |
| GET | `/health` | Routing-engine up/down (altid up i MVP) |

**Udeladt fra specen** (kommer senere): `/messages*`, `/incidents?unresolved=1`, `/history*`, `/history/heatmap`, `/history/report`, `/calendar`, `/confirm-and-book` (bulk).

---

## 8. Frontend — to zoner

### Office: `/office/logistik`

3-kolonne layout (mockup `plan_imorgen_v2.html` for plan-mode, `i_dag_view_v2.html` for live-mode).

**MVP-justeringer fra specen**:
- **Plan-mode + live-mode i samme view, dato styrer mode** — uændret fra spec
- **Drag-and-drop bons → ture** — uændret
- **"Beregn rute"-knap** — kalder route_planner uden VROOM, viser ETA per stop + total + advarsler
- **"Bekræft og bestil"** — genbruger Spor 1's popout (`/delivery/note/:route_id`) udvidet til route-niveau med `{stops}`-iterable. **Ingen separat manual_booking_modal**
- **Stat-bar** (Leveret / På vej / Problem) — uændret
- **Selection-state binding**: kun bons↔kort i MVP, ikke 3-vejs

**Genbrug fra Spor 1**:
- Vehicle-dropdown
- Booking-payload-builder (`services/booking_template.js`)
- Popout-vindue (`views/delivery/note.{html,js,css}`) udvidet til route-niveau
- Settings-editor for booking-templates

### Mobile: `/m/levering`

Mockup `courier_mobile_v5.html`. **MVP-justeringer**:
- PIN-login (eksisterende `mobile/` shell)
- Dagens stop med 3 statuser (planlagt/leveret/problem)
- Stop-detalje med navigér-knap (Google Maps URL) + status-knapper
- Problem-flow: 3 trin → `POST /incidents` med foto via `attachments`-tabel
- **Skip**: send-besked, "Tilbage til HQ"-card, dual-kontakter (én blok i v1)

**Når bon aflyses mid-route**: SSE `bon_status` → mobile viser AFLYST-overlay på stop'et. 5-linjer-implementation, ikke noget at lave en stor feature af.

### Bon-kort + listview

Allerede klar fra Spor 1. Skift kun data-kilde:

```javascript
// I dag (Spor 1):
const vehicle = bons.delivery_vehicle_id;

// Efter Spor 2 (læs autoritativt fra route_stops):
const vehicle = bon.route_stop_vehicle_id ?? bons.delivery_vehicle_id;
// Trigger holder bons.delivery_vehicle_id i sync, så fallback'en næsten aldrig rammer
```

---

## 9. SSE-events

| Event | Hvornår | Hvem lytter |
|---|---|---|
| `delivery_route_stop_added` | `POST /routes/:id/stops` | Bon-kort, bons-listview, logistik-view |
| `delivery_route_stop_removed` | `DELETE /routes/:id/stops/:bon_id` | Samme |
| `delivery_route_status_changed` | `POST /routes/:id/confirm` etc | Logistik-view |
| `delivery_stop_status_changed` | `POST /stops/:id/status` | Logistik-view, mobile |
| `delivery_incident_logged` | `POST /incidents` | Logistik-view |

**Bevidst udeladt**: `delivery_message_to_courier` (ingen besked-feature i MVP).

---

## 10. Rækkefølge — sigte mod v1-shutdown

```
Uge 1   ─ Migration + services/routing.js (haversine) + services/delivery_calc.js + services/route_planner.js
          - Unit-tests for alle tre services (Node native test runner)
          - POST /api/delivery/calculate endpoint
          - Integrer i bon-opret-flow (foreslå vehicle-type ved oprettelse)
          - Verificér med 5-10 håndberegnede testcases (HQ → adresse i Kbh)
Uge 2   ─ Office route-planner UI (plan-mode)
          - 3-kolonne layout fra mockup plan_imorgen_v2.html
          - Drag-and-drop bons → ture
          - Beregn-knap → vis forslag-modal
          - Accept-flow → skriv pickup_time på bons
          - Genbrug popout til "Bekræft og bestil"
Uge 3   ─ Office live-mode + mobile courier
          - Live-mode: stat-bar, tur-card live-status, ny-bon-toast
          - mobile/views/levering.js: dagens stop, detalje, navigér-knap
          - Status-endpoints + foto-upload via attachments
          - Problem-flow (3-trin modal)
          - SSE-handlers (route_stop_added, stop_status_changed)
Uge 3.5 ─ Pilot: én rigtig uge med real bestilling + real bud
          - Office bruger nye flow, ikke v1
          - Log faktiske ankomster vs ETA (selvkalibrering starter her)
          - Daglig mini-review: hvad fejlede?
Uge 4   ─ Bugfix + selvkalibrering + v1-shutdown
          - Analyse `delivery_eta_log` — er city_factor 1.4 korrekt?
          - Justér per-vehicle hastigheder i settings
          - Final acceptance-test
          - Sluk v1 Bon Map
```

**Sparet uge sammenlignet med OSRM-Docker-planen**: 1 hel uge — fordi der ikke længere er Hetzner-infrastruktur at opsætte. Hele MVP'en er 4 uger + pilot.

**Kritisk-path**: Migration + `services/routing.js` (uge 1, første dag). Intet andet kan startes før den er på plads, men det er nu en 1-dags opgave, ikke en uges Docker-setup.

---

## 11. Beslutninger taget i denne MVP

| # | Spec sagde | MVP beslutter | Hvorfor |
|---|---|---|---|
| 1 | OSRM + VROOM Docker-stack | **Ingen routing-engine** — haversine × city-faktor i Node.js | Skala (1-2 stop) retfærdiggør ikke infrastruktur. Sparer Docker, RAM, OSM-data-vedligehold |
| 2 | OSM = hele DK eller Region H | **Irrelevant** — ingen OSM-data nødvendig | Fugleflugt-formel + selvkalibrering dækker præcision |
| 3 | 4 stop-states | **3 states** (planlagt/leveret/problem) | `klar` udledes fra bon-status |
| 4 | Nav-provider-setting | **Drop** | Google Maps URL åbner brugerens default-app |
| 5 | Foto-mappe `uploads/incidents/` | **Genbrug `attachments`-tabel** | Samme mønster som varemodtagelse |
| 6 | Send-besked SSE-kanal | **Drop fra MVP** | SMS/telefon virker; tilføj som 3D.7 |
| 7 | "Bekræft og bestil"-modal | **Genbrug Spor 1's popout** | Spar duplikation |
| 8 | Mini-kort-komponent overalt | **Drop fra MVP** | Google Maps-link er nok |
| 9 | "Tilbage til HQ"-card | **Drop** | Buddet kender vejen hjem |
| 10 | Sub-status `klar` på route_stops | **Drop** | Udledes fra bon-status |
| 11 | Multi-stop popout | **Drop fra MVP** | Per-stop popout dækker |
| 12 | Selection-state 3-vejs | **Kun 2-vejs** (bons↔kort) | 3-vejs er notorisk dyrt |
| 13 | Offline-retry-kø mobile | **Drop** | Mobil-dækning i Hovedstaden er stabil |
| 14 | Native push på mobile | **Drop, SSE+toast i stedet** | iOS Web Push kræver Apple Dev Program |
| 15 | "Antaget leveret efter X min" | **Behold, setting findes** | Lavt-omkostnings-feature |
| 16 | Aflys-bon mid-route | **Minimum-implementation** | 5 linjer kode forhindrer fejl-køreture |
| 17 | Polyline-kørerute på kort | **Drop** — kun pins | Ingen routing-engine, ingen rute-geometri |
| 18 | Accuracy-problem (estimater for upræcise) | **`city_factor` 1.4 + per-vehicle hastighed + selvkalibrering** | Justeres evidence-based efter pilot-uge |
| 19 | Cost-formler er bare gæt — taxa-priser/By-expressen-priser kan ændre sig | **Snapshot formel på `delivery_routes` + kalibreringsrapport** | Samme symmetri som ETA — `actual_cost_dkk` giver os data gratis. Office justerer `cost_formula_json` evidence-based |

---

## 12. Spørgsmål til office (samles til ét møde)

| # | Spørgsmål | Bruges til |
|---|---|---|
| 1 | By-expressen-template — brug Spor 1 popout i 2 uger og noter irritation | Justér popout-felt-konfig i Settings |
| 2 | Vil buddet have "Tilbage til HQ"-knap på mobile? | Beslut om feature kommer i polish |
| 3 | Hvilken navigations-app åbner buddet typisk? | Validér Google Maps URL-strategi |
| 4 | By-expressen-fejl-frekvens? | Validér at manuel håndtering er OK indtil 3D.5 |
| 5 | Rapport 2 — aggregér eller per-kategori? | Designvalg når 3D.8 startes |
| 6 | Har vi Storage Box på Hetzner-kontoen? | Foto-backup-strategi |
| 7 | Er der bro/havn-krydsninger blandt typiske ruter? (fx Amager-Frederiksberg) | Forventet city_factor — hvis ja, sandsynligvis 1.6+ for de ture |

---

## 13. Hvad der ikke ændrer sig fra Spor 1

Spor 1's eksisterende kode bibeholdes uændret:
- `routes/delivery.js` (9 endpoints — udvides med MVP-endpoints, ingen breaking changes)
- `services/booking_template.js` (`renderFields`, `renderTemplate`, `buildBookingPayload`)
- `services/delivery_log.js` (`logBookingEvent`, `setActualCost`)
- `views/delivery/note.{html,js,css}` (popout-vindue — udvides til route-niveau)
- `shared/bon_drawer.js` BESTIL BUD-sektion (uændret)
- `shared/bon_kort_builder.js` leveringsindikator (data-kilde skifter)
- `settings/index.html` Leveringsmetoder-fane (uændret)

Migration 057 (`delivery_vehicles`) og 071 (`delivery_booking_fields`) er fundament for resten.

---

## 14. Hvad sker hvis MVP rammer skala-loftet?

| Symptom | Trigger | Næste skridt |
|---|---|---|
| Estimater er konsekvent for upræcise selv efter kalibrering | `delivery_eta_log` viser store diff'er på tværs af alle vehicle-typer | **Tilføj OSRM** som drop-in: omskriv `services/routing.js` til at kalde OSRM Docker. Interface uændret. ~4-6 timers arbejde |
| Specifik rute-type fejler (fx bro-krydsninger) | `delivery_eta_log` filtreret på by-zone viser konsekvent +15 min | Tilføj per-zone city-faktor (fx Amager→Frederiksberg = 1.7), eller tilføj OSRM |
| 4+ stop per tur ofte | Manuel rute-rækkefølge bliver irritation | Tilføj VROOM som 3D.6 — kræver OSRM først |
| Office sender meget besked til Volvo | SMS-trafik mellem kontor og bud | Tilføj send-besked-modal som 3D.7 |
| Sebastian leverer By-expressen-credentials | API-kald muligt | Skift `byekspressen.booking_method` til `'api'` (én SQL) som 3D.5 |
| Ny manager efterspørger heatmap | "Hvor leverer vi mest?" | Byg 3D.8 leveringshistorik-side |
| Salg vil have margin-rapport | "Hvad tjener vi på levering?" | Byg e-conomic-integration som 3D.10 |
| Selvkalibrering viser at faktor skal ændres | `delivery_eta_log`-analyse | Juster `delivery_city_factor` eller `delivery_speed_kmh_<type>` i settings |

Det er bevidste exit-ramps. MVP'en er designet så ingen af dem kræver omskrivning af det allerede byggede.

### OSRM-eskaleringsstien (hvis det bliver nødvendigt)

Hvis pilot-ugen viser at haversine-tilgangen ikke er præcis nok:

1. Sæt OSRM op via Docker på Hetzner (3-trin extract/partition/customize fra Region H .pbf, ca. 1-2 timers arbejde)
2. Skriv `services/routing.js` om til at kalde OSRM (~50 linjer, samme interface)
3. Tilføj `OSRM_URL` til `.env`
4. Tilføj timeout-håndtering + healthCheck mod den eksterne service
5. Selvkalibreringen fortsætter at virke — den måler nu OSRM's tider vs. faktiske ankomster

**Ingen migrations-ændringer, ingen frontend-ændringer, ingen datamodel-skift.** Det er en lokaliseret swap af én service-fil.

---

## 15. Tests

### Unit (Node native test runner)

```javascript
// tests/services/routing.test.js
test('getRoute applies traffic_multiplier to duration', ...)
test('healthCheck returns up when OSRM responds', ...)

// tests/services/delivery_calc.test.js
test('suggests bike for < 8km and ≤ 4 boxes', ...)
test('suggests volvo for > 8km', ...)

// tests/services/route_planner.test.js
test('pickup_time = MIN of earliest pickups across stops', ...)
test('feasibility=false when any delivery deadline cant be met', ...)
test('does not modify pickup_time for bons with status >= KLAR', ...)
```

### Smoke (`scripts/smoke-test.sh` — udvid eksisterende)

```bash
curl -sf "$OSRM_URL/route/v1/driving/12.55,55.69;12.58,55.68" >/dev/null \
  && echo "✓ OSRM" || echo "✗ OSRM"

curl -sf "http://localhost:4321/api/delivery/health" \
  | jq '.osrm == true' >/dev/null && echo "✓ /health" || echo "✗ /health"
```

### Acceptance (pilot-uge)

1. Opret bon med adresse i indre by, 2 kasser → forslag = `bike`
2. Opret bon i Albertslund, 6 kasser → forslag = `taxi` eller `volvo`
3. Plan 3 bons til Volvo-tur, beregn → fælles pickup_time for alle 3
4. Bekræft plan med 13 kasser ved samme pickup_time → fejl (kapacitet 12)
5. Mobile: log "stillet ved døren" med foto → incident oprettet med location
6. Efter 10+ leveringer: tjek `delivery_eta_log` for systematisk afvigelse

---

## 16. Hvor README'er ligger nu

- `docs/delivery/CLAUDE_DELIVERY.md` — den fulde spec (3D.0–3D.10)
- `docs/delivery/CLAUDE_DELIVERY_MVP.md` — **dette dokument** (det der bygges nu)
- `docs/delivery/PLAN_BYEKSPRESSEN_3D4.md` — ignoreres, Spor 1's popout dækker det
- `docs/delivery/HUSKELISTE_DELIVERY_PATCH_v3.md` — krav til andre moduler (bon-kort, drawer)
- Mockup-filer (`courier_mobile_v5.html` etc.) — bindende source of truth for UI

**Når MVP er deployed**: opdater `CLAUDE.md` "Næste opgave"-sektion med ny status og slet eller annotér 3D.4/3D.5-referencer der ikke længere er kritisk-path.

---

*Sidst opdateret: 20. maj 2026 — initial MVP-plan efter design-session.*
