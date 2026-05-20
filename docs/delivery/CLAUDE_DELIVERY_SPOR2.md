# CLAUDE_DELIVERY_SPOR2.md — Delivery Spor 2 (rute-planlægning + courier)

> **Den autoritative plan for Spor 2.** Erstatter og konsoliderer:
> - `CLAUDE_DELIVERY.md` (fuld vision — OSRM/VROOM Docker)
> - `CLAUDE_DELIVERY_MVP.md` (haversine-MVP)
> - `PLAN_DELIVERY_SPOR_2_3.md` (ORS-eksekverbar plan)
> - `HUSKELISTE_DELIVERY_PATCH_v3.md` (krav til tilstødende moduler)
>
> Disse fire er **forældede**. Læs kun dette dokument + Spor 1-sektionen i `CLAUDE.md`.
> Læs også `BON_V2_PRINCIPPER.md` og `bon_v2_datamodel_v2.md` før du koder.
>
> Skrevet: 20. maj 2026 — efter design-session der afklarede skala + geografi.

---

## 0. Hvorfor dette dokument

De tre tidligere planer var uenige om routing og var organiseret om den forkerte
midte. Tre afklaringer fra office ændrede billedet:

1. **Skala:** Volvo kører 3-5 **planlagte** ture/uge (multi-stop). By-expressen + taxa
   kører 3-5 **enkelt-leveringer/dag**. Det er to forskellige arbejdsgange.
2. **Geografi:** København har vand overalt. Fugleflugt ≠ køreafstand. Levering til
   Refshaleøen er ~3-4 km i fugleflugt men 8,93 km i bil (rundt om havnen). En global
   "by-faktor" kan ikke fikse det — fejlen er adresse-specifik. **Haversine er udelukket.**
3. **Eksisterende værktøj:** v1's leveringsberegner bruger allerede OSRM
   (`router.project-osrm.org`, den offentlige demo) + DAWA-geokodning. Tallene er
   rigtige vej-afstande — office stoler på dem.

Konklusion: rigtig vej-routing er påkrævet, men ikke på en gratis demo-server.

---

## 1. To workflows — den centrale model

Spor 2 betjener **to arbejdsgange med ét fælles datagrundlag** (`delivery_routes`):

| | Workflow B — Daglig triage | Workflow A — Volvo-planlægning |
|---|---|---|
| Volumen | 3-5/dag | 3-5/uge |
| Vogn | By-expressen, taxa (eksterne) | Volvo, egen cykel (interne) |
| Mønster | Office *ser hvor leveringen skal hen* → bedømmer hvem der kører → booker | Office planlægger multi-stop-tur dagen før |
| Stop pr. rute | Typisk 1, lejlighedsvis 2 grupperet | 1-3 |
| Booking | Spor 1's popout (findes) | Intern kalender (ingen ekstern booking) |
| Courier-mobil | Nej (eksterne bude) | Ja (intern chauffør) |
| Byg | **Først** — daglig værdi | Bagefter |

**Vigtig pointe:** En "rute" kan have 1 stop. Workflow B er ikke enkelt-bookinger uden
struktur — det er "byg en lille rute (oftest 1 stop), se afstand + pris, book". Workflow A
er den samme rute-model med flere stop. Samme `delivery_routes`/`delivery_route_stops`,
samme `route_planner.js` — kun UI-vægten adskiller dem.

De fire gamle docs gjorde rute-planlæggeren (workflow A) til hovedstykket. Den betjener
~4 ruter/uge. **Workflow B er den daglige flade og bygges først.**

---

## 2. Routing: OpenRouteService (ORS)

### Beslutning

Rigtig vej-routing via **OpenRouteService** — en hostet, OSM/OSRM-baseret tjeneste.

- Afstand + tid + rute-geometri mellem punkter på det rigtige vejnet → korrekt for
  havne-/bro-krydsninger (Refshaleøen, Holmen, Amager).
- Hostet hos Heidelberg University (EU). API-nøgle. Gratis tier: 2000 directions-kald/dag.
  Faktisk forbrug: ~60/uge. Massivt headroom.
- Ingen Docker, ingen OSM-data-vedligehold.

### Bevidste fravalg

| Fravalgt | Hvorfor |
|---|---|
| **Haversine × by-faktor** (MVP-doc'en) | Refshaleøen vælter den. Fejlen er adresse-specifik — ingen multiplier kan fikse den. Også prisen (per_km × km) ville blive forkert. |
| **`router.project-osrm.org`** (v1's nuværende) | Offentlig demo-server. Ingen SLA, throttler automatiseret brug, kan forsvinde. OK til v1's lejlighedsvise manuelle beregner — uforsvarligt for et dagligt værktøj. |
| **Self-hostet OSRM + VROOM** (fuld spec) | Docker-stack + OSM-data-vedligehold. Overkill for jeres volumen. ORS er samme engine-familie uden driften. |

### Eskalering hvis ORS ikke rækker

Hvis gratis-tier rammes (det gør det ikke ved jeres volumen) eller ORS-vilkår ændrer sig:
self-host OSRM via Docker. `services/routing.js`-interfacet ændrer sig ikke — kun
implementeringen. ~4-6 timers arbejde. Ingen migrations- eller frontend-ændring.

---

## 3. Geokodning: DAWA

Routing kræver lat/lon på leveringsadresser. `addresses`-tabellen **har allerede**
`lat` + `lon`-kolonner (fra migration 001) — men de er sandsynligvis NULL for
v1-synkede adresser.

- **Kilde:** DAWA (`api.dataforsyningen.dk/adgangsadresser`) — samme tjeneste v1's
  leveringsberegner og v2's embed-bestillingsformular allerede bruger.
- **Ved adresse-oprettelse:** `routes/addresses.js`, webhook og embed-flow geokoder
  adressen og skriver `lat`/`lon` ved INSERT.
- **Backfill:** `scripts/backfill-geocode.js` — itererer `addresses WHERE lat IS NULL`,
  geokoder via DAWA (rate-limited, ~10/s er fint), skriver coords. Køres én gang før
  Spor 2 går live.
- **Manglende coords:** hvis en adresse ikke kan geokodes (ufuldstændig adresse),
  vises bonen i leveringsoversigten med "📍 Adresse mangler koordinater" — routing
  springes over, office kan stadig booke manuelt.

`services/geocode.js` — `geocodeAddress(addressId)` + `geocodeRaw({street, nr, zip})`.

---

## 4. Datamodel — migration `072_delivery_routes.sql`

> Næste ledige migrationsnummer er **072** (071 er sidste). Verificér før commit.
> `delivery_vehicles` findes allerede (migration 057, udvidet i 071 med `booking_fields_json`).

```sql
-- ==========================================
-- TURE
-- ==========================================
CREATE TABLE delivery_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_date DATE NOT NULL,
    vehicle_id INTEGER NOT NULL REFERENCES delivery_vehicles(id),

    courier_user_id INTEGER REFERENCES users(id),   -- intern chauffør, kan være NULL
    external_reference TEXT,                        -- By-expressen/taxa booking-ref

    pickup_time TIME,                               -- fælles afgang fra HQ
    actual_departure DATETIME,
    completed_at DATETIME,

    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','computed','confirmed','active','completed','cancelled')),

    booking_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (booking_status IN ('pending','in_progress','booked','failed','not_required')),
    booked_at DATETIME,
    booked_by_user_id INTEGER REFERENCES users(id),

    total_km REAL,
    total_minutes INTEGER,
    estimated_cost_dkk INTEGER,
    actual_cost_dkk INTEGER,
    actual_cost_source TEXT
        CHECK (actual_cost_source IN ('api','manual') OR actual_cost_source IS NULL),
    actual_cost_at DATETIME,

    route_geojson TEXT,                             -- ORS-rute-geometri til kort-polyline
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
-- 3 states. 'klar' udledes i frontend fra bons.status_code='KLAR' — ikke dobbeltbogført.
CREATE TABLE delivery_route_stops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_id INTEGER NOT NULL REFERENCES delivery_routes(id) ON DELETE CASCADE,
    bon_id INTEGER NOT NULL REFERENCES bons(id),
    sequence INTEGER NOT NULL,
    eta TIME,
    distance_from_prev_m INTEGER,
    duration_from_prev_s INTEGER,
    status TEXT NOT NULL DEFAULT 'planlagt'
        CHECK (status IN ('planlagt','leveret','problem')),
    completed_at DATETIME,
    UNIQUE(route_id, bon_id),
    UNIQUE(route_id, sequence)
);
CREATE INDEX idx_stops_route ON delivery_route_stops(route_id);
CREATE INDEX idx_stops_bon ON delivery_route_stops(bon_id);

-- ==========================================
-- INCIDENTS (problemer ved levering — bruges fra S2.3)
-- ==========================================
CREATE TABLE delivery_incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    route_stop_id INTEGER REFERENCES delivery_route_stops(id),
    bon_id INTEGER NOT NULL REFERENCES bons(id),
    incident_type TEXT NOT NULL
        CHECK (incident_type IN ('no_answer','wrong_address','left_at_door',
                                 'returned_to_kitchen','damage','other')),
    description TEXT,
    photo_attachment_id INTEGER REFERENCES attachments(id),  -- genbrug attachments-tabel
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
```

**Verificér før migration skrives:** har `bons` allerede `delivery_contact_name`,
`delivery_contact_phone`? Spor 1 tilføjede `delivery_notes`. Hvis kontakt-felterne
mangler, tilføj dem her (`ALTER TABLE bons ADD COLUMN ...`). Tjek med en grep i
`db/migrations/`.

**Bevidst udeladt:** `delivery_messages` (SMS/telefon dækker 2 interne bude),
`delivery_eta_log` (ORS giver rigtige tider — ingen by-faktor at kalibrere).

---

## 5. Spor 1 ↔ Spor 2 — synkronisering af bon-cache

Spor 1 satte `bons.delivery_vehicle_id` **og** `bons.delivery_method` direkte ved
popout-booking (via `services/delivery_log.js`). Spor 2 introducerer
`delivery_route_stops` som autoritativ kilde.

**Regel:** `delivery_route_stops` er sandhed når en bon er på en rute.
`bons.delivery_vehicle_id` + `bons.delivery_method` forbliver en denormaliseret cache.

Når et stop **tilføjes/fjernes** (i `routes/delivery.js`-endpointet, ikke en trigger —
så vi kan genbruge Spor 1's type-mapping eksplicit):

```
tilføj stop  → UPDATE bons SET delivery_vehicle_id = <route.vehicle_id>,
                                delivery_method    = mapVehicleTypeToMethod(vehicle.type)
fjern sidste → UPDATE bons SET delivery_vehicle_id = NULL, delivery_method = NULL
```

`mapVehicleTypeToMethod`: `volvo→volvo`, `bike|own-bike→bike`, `taxi→taxi` — **samme
mapping som Spor 1 allerede bruger** (genbrug funktionen fra `services/delivery_log.js`).
Det er kritisk: alle eksisterende lister/filtre i bons-list, kalender og kitchen-views
filtrerer på `delivery_method`. Hvis Spor 2 kun opdaterer `delivery_vehicle_id`, går de
visninger skævt.

Bons der bookes manuelt via Spor 1's popout **uden** at være på en rute: Spor 1's
direkte skrivning bevares uændret. En bon er enten på en rute eller manuelt booket —
hvis begge, vinder ruten.

`bons.delivery_vehicle_id` / `delivery_method` / `delivery_cost_*` slettes **aldrig** —
de er single-source-of-truth for pickup-only-bons og popout-bookede bons uden rute.

---

## 6. Settings + .env

```sql
INSERT OR IGNORE INTO settings (key, value, description) VALUES
('delivery_safety_margin_minutes', '10',  'Buffer udover ORS-køretid (min)'),
('delivery_kitchen_capacity_boxes','12',  'Max kasser klar samtidig ved samme pickup-tid'),
('delivery_default_service_time_min','5', 'Default service-tid pr. stop (losning hos kunde)'),
('delivery_assumed_delivered_after_min','30','Antag leveret hvis intet hørt X min over deadline'),
('delivery_office_phone','+4533218989',   'Tlf. kontoret — nødløsning i mobile'),
('delivery_hq_address','Prinsesse Charlottesgade 16, 2200 København N','HQ-adresse'),
('delivery_hq_lat','55.6905', 'HQ latitude'),
('delivery_hq_lon','12.5510', 'HQ longitude');
```

`.env` (nye nøgler):
```
ORS_API_KEY=...
ORS_BASE_URL=https://api.openrouteservice.org
```

HQ-koordinaterne ovenfor er omtrentlige — geokod den rigtige HQ-adresse via DAWA og
ret dem ved opsætning.

---

## 7. Backend services

### `services/routing.js` (ny) — ORS-wrapper

Engine-agnostisk navn. Tynd HTTP-wrapper med native `fetch`. Timeout 5s, clear error,
ingen retry-loops (frontend håndterer "prøv igen").

```javascript
// distance + tid mellem 2 punkter — slår op i geo_calculations-cache først
async function getDistance(from, to)        // → { distance_m, duration_s }

// hele rute med waypoints — ÉT ORS directions-kald giver alle legs + geometri
async function getRoute(coords)             // coords: [{lat,lng}, ...] inkl. HQ start/slut
                                            // → { distance_m, duration_s, legs[], geometry_geojson }

function healthCheck()                      // → { up: bool } — pinger ORS
```

- ORS-endpoint: `POST {BASE}/v2/directions/driving-car` med
  `{ coordinates: [[lng,lat], ...] }` og header `Authorization: <ORS_API_KEY>`.
- **Ingen matrix-endpoint, ingen permutations-løkke.** Office bestemmer stop-rækkefølgen
  ved drag — `getRoute()` kaldes én gang med den givne rækkefølge. Auto-optimering af
  rækkefølge er udskudt (se sektion 13). Det fjerner både rate-limit-risiko og den
  TSP-fejl der lå i `PLAN_DELIVERY_SPOR_2_3.md`.
- **Cache:** `getDistance` slår op/gemmer i `geo_calculations` (eksisterende tabel),
  nøgle = afrundede coords (5 decimaler), TTL 30 dage. Rute-geometri caches ikke
  (ændrer sig med stop) — beregnes on-demand, lav volumen.

### `services/geocode.js` (ny) — DAWA

```javascript
async function geocodeAddress(addressId)    // læser addresses-row, kalder DAWA, skriver lat/lon
async function geocodeRaw({ street, nr, zip })   // → { lat, lon } | null
```

### `services/delivery_calc.js` (ny) — single-bon forslag

Driver workflow B's triage: for én bon, hvad er afstanden og hvilken vogn passer?

```javascript
async function calculateForBon(bon)
// 1. routing.getDistance(HQ, bon-adresse) — cachet
// 2. for hver aktiv vehicle: tjek constraints (max_distance_km, max_capacity_boxes)
// 3. pris pr. vogn via booking_template.estimateCost (se nedenfor)
// 4. estimated_pickup_time = delivery_time - duration_s - safety_margin
// → { distance_m, duration_s, estimated_pickup_time,
//     suggested_vehicle_id,
//     alternatives: [{ vehicle_id, label, type, cost_dkk, suitable, reason }] }
```

`suggested_vehicle_id` = billigste *suitable*. Men det er kun et **forslag** — office
bedømmer selv. `alternatives` viser alle vogne med pris + om de er egnede, så office
kan vælge bevidst (fx vælge Volvo selvom taxa er billigere fordi der allerede er en
Volvo-tur den dag).

### `services/route_planner.js` (ny) — rute-orchestrator

```javascript
async function computeRoute(routeId)
// 1. hent route + stops (i drag-rækkefølge) + vehicle
// 2. coords = [HQ, ...stops, HQ]; routing.getRoute(coords)
// 3. ETA pr. stop fra legs + service-tid; pickup_time = MIN over stops af
//    (delivery_time - kumulativ varighed - safety_margin)
// 4. constraint-check (4 regler — se nedenfor)
// 5. → { feasible, pickup_time, ordered_stops[], total_km, total_minutes,
//        estimated_cost_dkk, geometry_geojson, warnings[], errors[] }
//    SKRIVER IKKE til DB

async function applyRouteProposal(routeId, proposal)
// skriver: delivery_routes (pickup_time, total_km/min, estimated_cost, route_geojson),
//          delivery_route_stops (sequence, eta, distance/duration_from_prev),
//          bons.pickup_time hvor ændret (IKKE for bons med status >= KLAR),
//          changelog pr. bon, status='computed', SSE-broadcast
```

Constraint-check (4 regler):
```
1. kapacitet:  sum(boxes) > vehicle.max_capacity_boxes        → error 'capacity_exceeded'
2. distance:   total_km > vehicle.max_distance_km             → error 'distance_exceeded'
3. deadline:   stop.eta > stop.delivery_time                  → error 'cant_meet_deadline'
4. stram buffer: (deadline - eta) < 15 min                    → warning 'tight_buffer'
```

### Pris — genbrug `services/booking_template.js`

Spor 1 har allerede `estimateCost(vehicle, bon)` i `booking_template.js`. **Udvid den**
til også at kunne tage rute-aggregater (`total_km`, `total_boxes`) — opret **ikke** en ny
`cost.js`. Cost-formler ligger i `delivery_vehicles.cost_formula_json` (Spor 1).

---

## 8. API-endpoints

Alle under `/api/delivery/`. Mountes oven på Spor 1's eksisterende `routes/delivery.js`
(272 linjer, 9 endpoints — ingen breaking changes). Auth: session-baseret.

| Method | Path | Workflow | Formål |
|---|---|---|---|
| POST | `/calculate` | B | Single-bon forslag (`{bon_id}` eller `{lat,lng,delivery_time,boxes}`) |
| GET | `/overview?date=` | B | Leveringsoversigt: dagens delivery-bons + status + forslag |
| GET | `/routes?date=` | A+B | Ture med stops for dato |
| POST | `/routes` | A+B | Opret tom tur `{route_date, vehicle_id}` |
| PUT | `/routes/:id` | A+B | Opdater (vehicle, courier, notes) |
| DELETE | `/routes/:id` | A+B | Slet (kun status='draft') |
| POST | `/routes/:id/stops` | A+B | Tilføj stop `{bon_id}` |
| DELETE | `/routes/:id/stops/:bon_id` | A+B | Fjern stop |
| POST | `/routes/:id/compute` | A+B | Kør route_planner, returnér forslag |
| POST | `/routes/:id/apply` | A+B | Skriv forslag til DB |
| POST | `/routes/:id/confirm` | A+B | status='confirmed' |
| GET | `/routes/:id/booking-payload` | B | Genbrug Spor 1's payload-builder (route-niveau) |
| POST | `/routes/:id/book` | B | Marker booket `{reference?, status}` |
| POST | `/routes/:id/actual-cost` | B | Faktisk pris `{amount_dkk, source}` |
| GET | `/history?address_id=&limit=5` | B | Tidligere leveringer til adresse (reference for office) |
| GET | `/calendar?from=&to=&user_id=` | A | Confirmed ture til kalender-view |
| POST | `/stops/:id/status` | S2.3 | Courier: `{status:'leveret'\|'problem', lat?, lng?}` |
| POST | `/incidents` | S2.3 | Log problem (multipart for foto) |
| GET | `/courier/today` | S2.3 | Courier's egne stop i dag |
| GET | `/health` | — | ORS up/down |

---

## 9. Frontend

### Office `/office/logistik` — erstatter Logistik-placeholder

CLAUDE.md noterer "Logistik som placeholder-side indtil Spor 2". Den udfyldes nu i
`office/views/logistik.js` + `.css`.

**Workflow B — leveringsoversigt (default-flade, byg først):**
- Liste over dagens/morgendagens delivery-bons (`delivery_method != 'pickup'`).
- Pr. bon: destination, ORS-afstand fra HQ, foreslået vogn + pris pr. alternativ
  (fra `/calculate`).
- Leaflet pin-kort (OSM-tiles) med alle dagens leveringer som markører — så office
  kan *se hvor de skal hen* og bedømme.
- Vælg 1+ bons → "Opret tur" → vælg vogn → ruten vises, ORS-rute tegnes som polyline.
- "Book" → Spor 1's popout (`/delivery/note/...`) — udvidet til route-niveau.
- Faktisk-pris-felt pr. tur (taxa varierer).

**Workflow A — Volvo plan-mode (byg bagefter):**
- 3-kolonne layout efter mockup `plan_imorgen_v2.html`: bons (venstre) · kort (midt) ·
  ture (højre).
- Drag-and-drop bons → ture (native HTML5 drag, ingen build-step).
- "Beregn rute" → compute-modal med ETA pr. stop, pickup-tid, advarsler.
- "Acceptér" → pickup-tider skrives på bons med det samme (køkkenet ser dem).
- ORS-polyline på kortet når status ≥ computed.

`plan_imorgen_v2.html` er retningsgivende for layout — den antager rigtig routing
(polyline, rigtige km) og er konsistent med denne plan.

**Live-mode (S2.3):** datoen = i dag → stat-bar (Leveret/På vej/Problem), live
tur-status, ny-bon-toast. Mockup `i_dag_view_v2.html` — **men uden** send-besked-knappen
(se sektion 12).

### Mobile `/mobile/views/levering.js` (S2.3 — lav prioritet)

Betjener kun den interne Volvo-/cykel-chauffør (3-5 ture/uge). PIN-login via
eksisterende mobile-shell. Dagens stop, naviger-knap (Google Maps URL), status-knapper,
problem-flow (3 trin → `/incidents` med foto via `attachments`-tabel).

Mockup `courier_mobile_v5.html` — **men uden** "Tilbage til HQ"-card og dual-kontakt-blokke
(se sektion 12).

### Leveringsindikator (bon-kort + bons-list)

Spor 1 byggede allerede indikatoren. Spor 2 skifter kun datakilden til parallel læsning:

```sql
LEFT JOIN delivery_route_stops s ON s.bon_id = b.id
LEFT JOIN delivery_routes r ON r.id = s.route_id AND r.status != 'cancelled'
LEFT JOIN delivery_vehicles v_route  ON v_route.id  = r.vehicle_id
LEFT JOIN delivery_vehicles v_legacy ON v_legacy.id = b.delivery_vehicle_id
SELECT COALESCE(v_route.label, v_legacy.label) AS delivery_vehicle_label, ...
```

Tilføjes i `routes/kitchen.js` + `routes/bons.js`. Trigger-fri — `delivery_method`-cachen
holdes i sync via endpoint-koden (sektion 5).

---

## 10. SSE-events

| Event | Hvornår | Lyttere |
|---|---|---|
| `delivery_route_stop_added` | `POST /routes/:id/stops` | bon-kort, bons-list, logistik |
| `delivery_route_stop_removed` | `DELETE /routes/:id/stops/:bon_id` | samme |
| `delivery_route_status_changed` | confirm/book | logistik |
| `delivery_stop_status_changed` | `POST /stops/:id/status` | logistik, mobile |
| `delivery_incident_logged` | `POST /incidents` | logistik |

Polymorf payload-konvention: disse events refererer flere entiteter — brug semantiske
FK-navne (`bon_id`, `route_id`), ikke `{id}` (jf. SSE-konventionen i `CLAUDE.md`).

---

## 11. Faser, rækkefølge, estimat

| Fase | Indhold | Estimat |
|---|---|---|
| **S2.0 — Fundament** | ORS `routing.js` + DAWA `geocode.js` + backfill-script + migration 072 + settings + `delivery_calc.js` + `POST /calculate`. Constraint-forslag vises i bon-drawer. | ~1 uge |
| **S2.1 — Workflow B** | Leveringsoversigt i `office/views/logistik.js`: liste + pin-kort + forslag + opret-rute fra valgte + book via popout (udvidet til route-niveau). `route_planner.js`-kerne. Route-CRUD-endpoints. **Den daglige flade.** | ~1-1,5 uge |
| **S2.2 — Workflow A** | Volvo plan-mode: 3-kolonne drag-drop efter `plan_imorgen_v2.html`, multi-stop compute, pickup-tid-write-back, polyline. Genbruger rute-modellen fra S2.1. | ~1 uge |
| **S2.3 — Live + mobil** | Live-mode (i_dag), `mobile/views/levering.js`, status-endpoints, incidents + foto. Lav prioritet — betjener 1 intern chauffør. | ~1-1,5 uge |
| **S2.4 — By-expressen API** | `services/byekspressen.js` + webhook for `actual_cost`. Aktiveres med én SQL-update (`booking_method='api'`). | Når Sebastian leverer credentials |

**Total S2.0 → S2.3: ~4-5 uger.** Hvert trin kan deployes uafhængigt. Kritisk sti:
S2.0's migration + `routing.js` (dag 1) — alt andet hænger på den.

---

## 12. Hvad der IKKE er i scope

| Udeladt | Hvorfor | Hvornår |
|---|---|---|
| VROOM / multi-vehicle solver | 1-3 stop pr. tur — intet at optimere | Hvis 4+ stop bliver normalen |
| Auto-optimering af stop-rækkefølge | Office dragger rækkefølgen; ORS respekterer den | Senere, kræver ORS matrix-endpoint |
| Send-besked office→courier | SMS/telefon dækker 2 interne bude | Hvis behov opstår |
| Mini-kort-komponent overalt | Logistik-kortet rækker; bon-kort beholder Google Maps-link | Polish |
| "Tilbage til HQ"-card på mobil | Chaufføren kender vejen hjem | (droppet) |
| Dual-kontakt-blokke på mobil | Én blok i v1 | Hvis behov opstår |
| Leveringshistorik-side (heatmap) | `/history`-endpoint + listview rækker | 3D.8 senere |
| iCal-eksport | Volvo-bud kigger i Bon v2 | Hvis behov |
| e-conomic-integration | Fungerer fint uden | Hvis margin-rapport ønskes |
| `delivery_messages`-tabel | Genbrug web-order-toast-mønstret | Med send-besked, hvis nogensinde |
| `delivery_eta_log` / by-faktor-kalibrering | ORS giver rigtige tider — intet at kalibrere | (droppet) |
| Native push på mobil | iOS Web Push kræver Apple Developer Program | Måske aldrig |

**Mockup-afvigelser:** mockup'erne er retningsgivende for *layout*, men de viser
features der er droppet ovenfor. Følg ikke `i_dag_view_v2.html`'s send-besked-knap eller
`courier_mobile_v5.html`'s "Tilbage til HQ"-card / dual-kontakter. `plan_imorgen_v2.html`
er konsistent og kan følges tæt.

---

## 13. Åbne afhængigheder

| Item | Handling | Blokerer |
|---|---|---|
| ORS API-nøgle | Registrér på openrouteservice.org (gratis, ~2 min) | S2.0 |
| HQ-koordinater | Geokod den rigtige HQ-adresse, ret settings | S2.0 |
| `bons.delivery_contact_name/_phone` | Verificér om kolonnerne findes; tilføj i migration 072 hvis ikke | S2.0 |
| Backfill-geokodning | Kør `scripts/backfill-geocode.js` mod eksisterende adresser | Før go-live |
| By-expressen API-credentials | Sebastian — ryk ham | Kun S2.4 |
| Foto-storage til incidents | Genbrug `attachments`-tabel + uploads-mappe; med i backup? | S2.3 |
| Popout route-niveau | Udvid `routes/delivery_views.js` / `views/delivery/note.*` til at tage `route_id` (multi-stop). 1-stop virker som i dag | S2.1 |

---

## 14. Filer pr. fase (rigtige stier — der findes ingen `frontend/`-mappe)

**S2.0**
```
services/routing.js                 NY      services/geocode.js          NY
services/delivery_calc.js           NY      scripts/backfill-geocode.js  NY
db/migrations/072_delivery_routes.sql NY    routes/delivery.js           UDVID (+/calculate,/health)
.env                                UDVID   shared/api.js                UDVID
routes/addresses.js                 MODIFICÉR (geokod ved INSERT)
tests/routing.test.js  tests/delivery_calc.test.js  NY
```

**S2.1 — Workflow B**
```
services/route_planner.js           NY      routes/delivery.js           UDVID (route-CRUD,/overview)
services/booking_template.js        UDVID (estimateCost tager rute-aggregater)
office/views/logistik.js            NY      office/views/logistik.css    NY
shared/api.js                       UDVID   shared/sse.js                UDVID (5 events)
routes/delivery_views.js            UDVID (popout route-niveau)
routes/kitchen.js  routes/bons.js   MODIFICÉR (parallel læsning af route-stops)
tests/route_planner.test.js         NY
```

**S2.2 — Workflow A**
```
office/views/logistik.js            UDVID (plan-mode: 3-kolonne, drag-drop, compute-modal)
office/views/logistik.css           UDVID
```

**S2.3 — Live + mobil**
```
mobile/views/levering.js            NY      routes/delivery.js           UDVID (courier-endpoints)
office/views/logistik.js            UDVID (live-mode)
shared/sse.js                       UDVID   tests/mobile_courier.test.js NY
```

**S2.4**
```
services/byekspressen.js            NY      routes/delivery.js           UDVID (webhook)
```

---

## 15. Tests

| Fase | Unit | Integration | Manuel acceptance |
|---|---|---|---|
| S2.0 | `routing.test.js` (cache-hit/miss, timeout, ORS-fejl), `delivery_calc.test.js` (bike < 8km, taxa langt/mange kasser) | `/calculate` mod test-DB | Bon til Refshaleøen → afstand ≈ 9 km (ikke fugleflugt) |
| S2.1 | `route_planner.test.js` (pickup_time = MIN over stop, feasible=false ved overskredet deadline, capacity_exceeded) | opret tur → 2 stops → compute → apply → `bons.pickup_time` opdateret | Triagér dagens leveringer, opret tur, book via popout |
| S2.2 | — | drag 3 bons → compute → polyline tegnes | Køkkenet ser ny pickup-tid efter "Acceptér" |
| S2.3 | `mobile_courier.test.js` (status-endpoints, incident-upload) | status-flow mod test-DB | "Stillet ved døren" + foto → incident med location |

Test-konvention: `T_DEL_`-prefiks for test-bons, hermetisk cleanup. Genbrug
`sse_listener.js`-helper fra eksisterende office-tracks.

---

## 16. Eskaleringsramper

| Symptom | Næste skridt |
|---|---|
| ORS gratis-tier rammes / vilkår ændrer sig | Self-host OSRM via Docker — `routing.js`-interface uændret, ~4-6 timer |
| 4+ stop pr. tur bliver normalen | Tilføj ORS matrix-endpoint + auto-optimering i `route_planner.js` |
| Office sender meget besked til Volvo-bud | Tilføj send-besked-modal + `delivery_messages` |
| Sebastian leverer By-expressen-credentials | S2.4 — én SQL-update til `booking_method='api'` |
| Behov for leverings-heatmap/rapport | Byg historik-side på `/history`-data |

Ingen af dem kræver omskrivning af det allerede byggede.

---

*Konsolideret 20. maj 2026 fra de fire tidligere delivery-docs. Routing-fundament:
OpenRouteService. Geokodning: DAWA. To-workflow-model: B (daglig triage) før A
(Volvo-planlægning). Mockups retningsgivende for layout med undtagelserne i sektion 12.*
