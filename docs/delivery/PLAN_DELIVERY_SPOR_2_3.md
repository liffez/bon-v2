⚠️ FORÆLDET (20. maj 2026) — denne patch er konsolideret ind i CLAUDE_DELIVERY_SPOR2.md. Læs den i stedet. Dette dokument bevares kun som historik. Krav her afspejler den gamle OSRM/VROOM-vision og 4-state-flowet — se Spor 2-doc'en for det gældende scope.

# PLAN_DELIVERY_SPOR_2_3.md
> Eksekverbar plan for delivery-modulets Spor 2 (rute-planlægger) + Spor 3 (mobile courier).
> Læs `CLAUDE_DELIVERY.md`, `BON_V2_PRINCIPPER.md`, `bon_v2_datamodel_v2.md` FØR du går i gang.
> Opdateret: maj 2026

---

## 1. Status før planen starter

| Element | Status |
|---------|--------|
| **Spor 1 (manuel bestilling)** | ✅ Leveret maj 2026 — migration 057, booking_template.js, delivery_log.js, 9 endpoints, manual_booking_modal, leveringsindikator på bon-kort. 65 unit + 46 integration tests grønne |
| **Spec for Spor 2** | ✅ Klar — `CLAUDE_DELIVERY.md` + 5 godkendte mockups |
| **Spec for Spor 3** | ✅ Klar — `courier_mobile_v5.html` godkendt |
| **OpenRouteService API-key** | ⏳ Registrér på openrouteservice.org (gratis tier 2000 req/dag) — forudsætning for 3D.0 |
| **By-expressen API-credentials** | ⏳ Sebastian — blokerer kun 3D.5 |

**Hvad Spor 1 har konsumeret af det oprindelige plan:**
- 3D.1 manual-clipboard flow er **færdig** (taxa + By-expressen via Lobo)
- 3D.4 manual-modal er **færdig** — men "Bekræft og bestil"-bulk-flow + "I dag"-mode mangler stadig
- 3D.2/3D.3 er **fuldt ud foran os**

---

## 2. Implementations-rækkefølge (begrundet)

| # | Fase | Indhold | Hvorfor netop denne rækkefølge |
|---|------|---------|--------------------------------|
| 1 | **3D.0** | OpenRouteService API-key + `.env`-config + `services/routing.js` HTTP-wrapper + cache i `geo_calculations` | Fundament — alt andet kalder den. Krymper fra "Docker-stack på server" til "registrér API-key" |
| 2 | **3D.0b** | Mini-kort komponent + `GET /api/delivery/history` | Bygge-blok for både 3D.2-kort, drawer, bon-kort, CRM. Bør stå færdig FØR route-planner-UI |
| 3 | **3D.1b** | `services/delivery_calc.js` + `POST /api/delivery/calculate` + constraint-check ved bon-oprettelse | Single-bon transport-forslag. Kan stå alene, leverer værdi i formbuilder |
| 4 | **3D.2** | Migration: `delivery_routes`, `delivery_route_stops`, `delivery_incidents`, `delivery_messages`. `services/route_planner.js` (inkl. egen constraint-check + TSP for små ture). Office plan-mode UI ifølge mockup | Hovedopgaven — office får værktøjet. Mobile har endnu ingen stops at vise, så den kan vente |
| 5 | **3D.4** | `POST /confirm-and-book` (bulk) + "Bekræft og bestil"-modal + intern kalender + I-dag mode + send-besked-modal | Lukker office-loopen. Genbruger eksisterende manual-modal fra Spor 1 |
| 6 | **3D.3** | Mobile `/m/levering` UI + status-endpoints + foto-upload + naviger-knapper + push-besked-modtagelse | Sidst — fordi der nu er ture at vise. Kan rulles ud uden at forstyrre office |
| 7 | **3D.5** | `services/byekspressen.js` + auto-`actual_cost` via webhook + SQL-update til `booking_method='api'` | Kun når credentials kommer. Triggrer automatisk uden kode-ændring |
| 8 | **3D.6–3D.10** | Multi-stop UI-finpudsning, SMS-templates, historik-side, iCal, e-conomic | Når behov opstår — ikke kritisk path |

**Total estimat:** 3D.0 → 3D.3 = ca. 3–5 ugers udviklingsarbejde for Simon (1-2 uger sparet ved at droppe Docker/VROOM). Hvert fase kan deployes uafhængigt.

---

## 3. Fase 3D.0 — Routing-service

### Mål
Bon v2 har en HTTP-wrapper mod OpenRouteService (ORS) der leverer distance, duration og rute-geometri mellem punkter. Cache i `geo_calculations`.

### Hvorfor ORS

- **Open Source-baseret** — bruger samme OSRM-engine vi ellers selv skulle hoste
- **EU-hostet** — Heidelberg University, ingen GDPR-grå-zone
- **Gratis tier 2000 req/dag** — vi estimerer max ~100/dag selv uden cache, cached < 30/dag
- **Optimization endpoint findes** — men vi bruger den ikke (egen TSP for 1-2 stop er trivielt)
- **Ingen drift** — ingen Docker, ingen kompilering, ingen OSM-refresh, ingen disk

### Opgaver

1. **Registrér API-key** på https://openrouteservice.org/dev/#/signup (gratis konto)
2. **Tilføj til `.env`**:
   ```
   ORS_API_KEY=...
   ORS_BASE_URL=https://api.openrouteservice.org
   DELIVERY_SAFETY_MARGIN_MIN=10
   KITCHEN_PICKUP_CAPACITY_BOXES=12
   ```
3. **Opret `services/routing.js`** — tynd HTTP-wrapper med native `fetch`:

   ```javascript
   // services/routing.js
   const BASE = process.env.ORS_BASE_URL;
   const KEY  = process.env.ORS_API_KEY;

   // 1. Distance + duration mellem 2 punkter (med geo_calculations cache)
   async function getDistance(from, to) { ... }

   // 2. Hele rute med flere waypoints — én ORS-kald giver alle legs + geometry
   async function getRoute(coords) { ... }   // returnerer { distance_m, duration_s, legs, geometry_geojson }

   // 3. Cache-helper — slår op i geo_calculations før kald
   async function cachedDistance(fromLat, fromLng, toLat, toLng) { ... }
   ```

   Timeout 5s. Clear error på fail. Ingen retry-loops (frontend håndterer "prøv igen").

4. **Cache-strategi**: Hver `getDistance`-kald gemmer/slår op i `geo_calculations`-tabellen (eksisterende). Key = `(round_lat_from, round_lng_from, round_lat_to, round_lng_to)` med 5 decimaler (~1m præcision). TTL: 30 dage.

5. **Opdater smoke-test** (`scripts/smoke-test.sh`):
   ```bash
   curl -sf -H "Authorization: $ORS_API_KEY" \
     "$ORS_BASE_URL/v2/directions/driving-car?start=12.55,55.69&end=12.58,55.68" >/dev/null \
     && echo "✓ ORS" || echo "✗ ORS"
   ```

### Definition of done
- [ ] API-key i `.env`, ikke i kode
- [ ] `getDistance(HQ, kunde)` returnerer korrekt distance/duration på første kald
- [ ] Andet kald med samme punkter hitter cache (verificeret: ingen ORS-hit i logs)
- [ ] Timeout efter 5s med clear error
- [ ] `tests/routing.test.js`: cache-hit, cache-miss, timeout, ORS-fejl-håndtering
- [ ] Smoke-test grøn

### Fallback hvis ORS er nede
Frontend viser "Beregning ikke tilgængelig — prøv igen". Manuel rute-bygning fungerer stadig (drag bons til ture, bare uden beregnet distance/eta). Efter et par ugers drift har `geo_calculations` de fleste HQ→kunde-afstande cached.

---

## 4. Fase 3D.0b — Mini-kort komponent + history-endpoint

### Mål
Genbrugbar mini-kort modal der erstatter dagens "klik på pin → Google Maps" på bon-kortet, og samtidig kan bruges fra drawer, listview og CRM.

### Opgaver

**Backend:**
1. Tilføj endpoint i `routes/delivery.js`:
   ```
   GET /api/delivery/history?address_id=&limit=5
   ```
   Returnerer seneste leveringer til samme adresse. **I første version:** læser fra `delivery_events` + `bons.delivery_cost` (Spor 1's data). Når 3D.2 deployes udvides til også at læse fra `delivery_routes`.

   Response-form:
   ```json
   {
     "deliveries": [
       {"date": "2026-04-12", "vehicle_label": "By-expressen", "actual_cost": 180},
       {"date": "2026-03-28", "vehicle_label": "Volvo Duett", "actual_cost": null}
     ],
     "stats": {"count": 5, "cost_min": 180, "cost_max": 510}
   }
   ```

**Frontend:**
2. Opret `frontend/components/mini-map.js` — Leaflet-baseret modal-komponent.
3. API: `window.MiniMap.open(options)` hvor options er:
   ```js
   {
     address_id: 1234,
     lat: 55.69, lng: 12.58,        // hvis ingen address_id
     label: "Åbenrå 34, 1124 Kbh K",
     show_history: true,
     show_link_to_logistics: true,  // kun synlig hvis bon_id passes
     bon_id: 3447,                  // til "Se i logistik"-link
     date: "2026-05-21"             // styrer logistik-mode
   }
   ```
4. Leaflet importeres som CDN i `shared/leaflet-loader.js` (lazy — kun ved første åbning).
5. Tiles: OSM standard (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`).
6. **Bevar Google Maps-knap** som sekundær — same URL-format som dagens:
   ```
   https://www.google.com/maps/search/?api=1&query={ENCODED_ADDRESS}
   ```

**Integration:**
7. Skift bon-kortets pin-ikon i `frontend/kitchen/components/bon_kort.js`:
   ```js
   // FØR:
   onclick="window.open('https://www.google.com/maps/...')"
   // EFTER:
   onclick="window.MiniMap.open({ address_id: ..., bon_id: ..., date: ... })"
   ```
8. Samme i office bon-listview + bon-drawer (klik på adresse-felt).
9. CRM kunde-side: ny "Vis kort"-knap pr. adresse — kalder samme komponent.

### Definition of done
- [ ] Modal åbner < 300ms efter klik
- [ ] Leaflet loades lazy (ikke ved hvert sideindlæs)
- [ ] "Se i logistik" kun synlig når `bon_id` er passet ind
- [ ] "Google Maps ↗" virker som backup
- [ ] Tested fra: kitchen bon-kort, office listview, office drawer, CRM kunde-side
- [ ] `tests/delivery_history.test.js` dækker history-endpoint

---

## 5. Fase 3D.1b — Single-bon constraint-check

### Mål
Når en bon oprettes eller redigeres, kald `POST /api/delivery/calculate` for at få forslag til transport-type og estimeret pickup-tid.

### Opgaver

**Backend services:**
1. `services/delivery_calc.js`:
   ```js
   async function calculateForBon(bon)
   // 1. routing.getDistance(HQ, bon.delivery_address) — bruger cache fra 3D.0
   // 2. For hver vehicle WHERE is_active: tjek constraints (max_km, max_capacity_boxes)
   // 3. Foreslå billigste suitable (bruger cost-formel fra services/booking_template.js — allerede bygget i Spor 1)
   // 4. estimated_pickup_time = delivery_time - duration - safety_margin
   ```

2. `routes/delivery.js` — nyt endpoint:
   ```
   POST /api/delivery/calculate
   Body: { bon_id } eller { lat, lng, delivery_time, boxes }
   Response: { suggested_vehicle_type, distance_m, duration_s, estimated_pickup_time, alternatives: [...] }
   ```

**Frontend:**
3. Formbuilder + bon-edit-drawer kalder `/calculate` når adresse er sat eller ændret. Vis forslag som ikke-blokerende hint:
   ```
   💡 Forslag: 🚴 By-expressen — pickup ca. 10:35, distance 4.2 km
   [Brug dette forslag]   [Vælg manuelt]
   ```

### Definition of done
- [ ] Routing-kald cacher i `geo_calculations` — verificeret med to identiske kald (kun ét ORS-hit)
- [ ] Constraint-tjek skipper vehicles med `max_distance_km < calculated_distance`
- [ ] Formbuilder viser forslag uden at blokere submit
- [ ] Drawer viser forslag og opdaterer ved adresse-ændring
- [ ] `tests/delivery_calc.test.js` dækker: bike-suggest under 8km, volvo over 8km, taxi når mange boxes

---

## 6. Fase 3D.2 — Office route-planner

### Mål
Office kan trække bons til ture, beregne ruter og bekræfte planen. Plan-i-morgen-mode er fuldt funktionelt.

### Opgaver

**Migration:**
1. Ny migration: `migrations/060_delivery_routes.sql` (præcist nummer afhænger af nuværende migrations-tæller):
   - `delivery_routes` (inkl. `actual_cost_dkk`-felter — se `CLAUDE_DELIVERY.md` §Datamodel)
   - `delivery_route_stops`
   - `delivery_incidents`
   - `delivery_messages`
   - Settings-keys (safety_margin, kitchen_capacity, HQ-coord osv.)

**Backend services:**
2. `services/route_planner.js` — den centrale orchestrator. **Bygger constraint-check + rute-rækkefølge selv** (ingen VROOM):

   ```js
   // Hovedfunktioner
   async function computeRoute(routeId)
   // 1. Hent route + stops + vehicle fra DB
   // 2. Byg koordinat-liste: HQ → stop_1 → stop_2 → ... → HQ
   // 3. For ≤2 stops: prøv begge permutationer, vælg lavest total_minutes
   //    For 3+ stops: simpel nearest-neighbor TSP (3-5 stop = 6-120 permutationer maks)
   // 4. routing.getRoute() med valgt rækkefølge → distance, duration, legs, geometry
   // 5. Beregn pickup_time = MIN over alle stop af (delivery_time - cumulative_duration - safety_margin)
   // 6. Constraint-check (capacity, max_distance, deadline pr. stop)
   // 7. Returnér proposal med {feasible, pickup_time, ordered_stops, total_km, total_minutes, warnings, errors, geometry}
   // 8. SKRIVER IKKE til DB endnu

   async function applyRouteProposal(routeId, proposal)
   // Skriver proposal til DB:
   // - delivery_routes (pickup_time, total_km, total_minutes, estimated_cost, route_geojson)
   // - delivery_route_stops (sequence, eta, distance_from_prev_m, duration_from_prev_s)
   // - bons.pickup_time hvor ændret
   // - changelog-entry pr. bon: "Pickup ændret af rute-planlægger"
   // - status='computed'
   ```

   **TSP-implementering:** For ≤5 stop er brute-force trivielt (5! = 120 permutationer × routing-kald). For 6+ stop bruges nearest-neighbor heuristik. Realistisk maksimum i Bon v2: 3-5 stop på Volvo-ture, 1-2 på cykel/taxa.

   **Constraint-check (4 regler):**
   ```js
   // 1. Kapacitet
   if (total_boxes > vehicle.max_capacity_boxes) errors.push({type: 'capacity_exceeded'});
   // 2. Distance
   if (vehicle.max_distance_km && total_km > vehicle.max_distance_km) errors.push({type: 'distance_exceeded'});
   // 3. Deadline pr. stop
   for (const stop of ordered_stops) {
     if (stop.eta_minutes > stop.delivery_deadline_minutes) errors.push({type: 'cant_meet_deadline', bon_id});
   }
   // 4. Stram buffer (advarsel, ikke fejl)
   for (const stop of ordered_stops) {
     const buffer = stop.delivery_deadline_minutes - stop.eta_minutes;
     if (buffer < 15) warnings.push({type: 'tight_buffer', bon_id, minutes_buffer: buffer});
   }
   ```

**Backend endpoints (alle under `/api/delivery/`):**
3. `GET /routes?date=YYYY-MM-DD`
4. `POST /routes` — opret tom tur
5. `PUT /routes/:id` — opdater (vehicle, driver, notes)
6. `DELETE /routes/:id` — kun hvis status=draft
7. `POST /routes/:id/stops` — tilføj stop
8. `DELETE /routes/:id/stops/:bon_id`
9. `POST /routes/:id/compute` — kør route_planner, returnér forslag
10. `POST /routes/:id/apply` — bekræft forslag
11. `POST /routes/:id/confirm` — endelig bekræftelse
12. `POST /routes/:id/actual-cost` — manuel indtastning

**Frontend (office):**
13. Ny side: `/office/logistik` (erstatter eksisterende placeholder). Tre kolonner:
    - Venstre: bons-liste (drag source)
    - Midten: Leaflet kort med markører og rute-polyline (fra `delivery_routes.route_geojson`)
    - Højre: ture-liste (drop target)
14. Drag-and-drop med `Sortable.js` eller native HTML5 drag-drop (vanilla, ingen build-step)
15. "Beregn rute"-knap → modal med proposal
16. **Pixel-tæt implementering af `plan_imorgen_v2.html` mockup**
17. Sidebar-collapse med localStorage-state
18. Selection-state binding kort↔sidebar (bidirektional highlight, ESC ophæver)
19. **Mini-kort genbruges** — klik på markør på det store kort selecter, ikke åbner modal

**SSE-events:**
20. Tilføj events: `delivery_route_created`, `delivery_route_stop_added`, `delivery_route_stop_removed`, `delivery_route_status_changed`
21. Mount under eksisterende SSE-handler

### Definition of done
- [ ] Migration kører på test-DB uden fejl
- [ ] Drag bon → tur opdaterer DB + SSE
- [ ] Compute-modal viser pickup_time, warnings, errors korrekt
- [ ] ORS-rute tegnes på kortet når status≥computed (polyline fra `route_geojson`)
- [ ] Sequence-tal i markører matcher status-farve
- [ ] Pickup-tider gemmes på bons ved "Acceptér" → kitchen ser dem med det samme
- [ ] Aflyst tur: 60% opacity + gennemstreget badge
- [ ] `tests/route_planner.test.js`: 
  - 2-stop: vælger korrekt rækkefølge (kortest total)
  - multi-stop pickup_time = MIN over stop earliest_pickups
  - feasibility=false ved overskredet deadline
  - constraint: capacity_exceeded når sum boxes > max
- [ ] Integration-test: opret tur → tilføj 3 stops → compute → apply → bons.pickup_time opdateret

---

## 7. Fase 3D.4 — "Bekræft og bestil" + I-dag mode

### Mål
Office kan med ét klik bekræfte hele dagens plan og udløse booking-flow pr. tur. I-dag mode viser live status. Manuel `actual_cost` kan indtastes.

### Opgaver

**Backend:**
1. `POST /api/delivery/confirm-and-book` — bulk-bekræft alle ture for dato:
   - Validér (uplanlagte bons, kapacitet > delivery_kitchen_capacity_boxes)
   - For hver tur baseret på `vehicle.booking_method`:
     - `calendar` → status='confirmed', booking_status='not_required'
     - `api` → kald API (kun By-expressen i 3D.5)
     - `manual_clipboard` → returner liste til frontend så modal vises sekventielt
2. `GET /calendar?user_id=&from=&to=` — confirmed ture for kalender-view
3. `POST /api/delivery/messages` — send besked til courier
4. `GET /api/delivery/messages?route_id=&unacked=1`

**Frontend (office):**
5. "Bekræft og bestil"-modal — bygger på `bekraeft_og_bestil_v2.html` mockup
6. Manual booking-modal **genbruges fra Spor 1** — den eksisterer allerede i `frontend/components/manual_booking_modal.js`
7. "Afventer booking"-banner øverst i tur-kolonne
8. Tur-card varianter ifølge `tur_card_varianter_v2.html`:
   - Header-badge baseret på status × booking_status
   - Booking-ref som monospace-pille (klik = kopiér)
   - Booking-footer kun ved problemer
9. I-dag mode — bygger på `i_dag_view_v2.html`:
   - Stat-bar med 3 nøgletal (Leveret · På vej · Problem)
   - Send-besked pille-knap på tur-header (kun interne courier)
   - Faktisk-tid vs planlagt (orange hvis sent)
   - Ny bon-toast øverst i bons-kolonne
   - Completed-ture: 70% opacity + kollapsibel
10. Manuel `actual_cost`-indtastning på tur-card (taxa)
11. Send-besked-modal med template-chips ("Skynd dig hjem", "Tag #X med tilbage")

**SSE-events:**
12. `delivery_route_booked`, `delivery_message_to_courier`, `delivery_message_acked`

### Definition of done
- [ ] "Bekræft og bestil" validerer kapacitet og uplanlagte bons
- [ ] Modal viser per-tur-status (kalender/API/manual) med ikoner
- [ ] Manual-modal åbner sekventielt for hver manual tur
- [ ] By-expressen ture behandles som taxa (booking_method='manual_clipboard' indtil 3D.5)
- [ ] I-dag mode aktiveres automatisk når datoen er = TODAY
- [ ] Send-besked når mobile via SSE — ack registreres
- [ ] Manuel `actual_cost` skriver til `delivery_routes.actual_cost_dkk` + source='manual'

---

## 8. Fase 3D.3 — Mobile courier

### Mål
Buddet bruger `/m/levering` på sin mobil. Dagens stop, navigation, status-knapper, problem-flow.

### Opgaver

**Backend:**
1. `GET /api/delivery/courier/today` — courier's egne stop i dag
2. `POST /api/delivery/stops/:id/status` — body `{status, lat?, lng?}`
3. `POST /api/delivery/incidents` — multipart for foto
4. `POST /api/delivery/messages/:id/ack`
5. Foto-storage: `uploads/incidents/YYYY/MM/{incident_id}.jpg`
6. Background-task: efter X min over deadline + ingen status → antag leveret (`delivery_assumed_delivered_after_min` setting)

**Frontend (mobile shell):**
7. Ny side: `frontend/mobile/levering.html` — PIN-login via eksisterende mobile shell
8. **Pixel-tæt implementering af `courier_mobile_v5.html`**
9. Dagens tur — liste af stops med sequence, customer, adresse, status
10. Stop-detalje:
    - Prominent pickup-info (bon# + kasser i mørk boks med stort tal)
    - To kontakt-blokke kun hvis forskellige (på dagen + bestiller)
    - SMS-knap med pre-fyldt tekst
    - Naviger-knap (Google Maps navigations-mode)
    - Sekundær pin-only-knap
11. "Tilbage til HQ"-card efter sidste stop (gul stiplet)
12. Ring kontoret-knap altid synlig (stiplet bjælke nederst)
13. Problem-modal — 3 trin (type → foto+geo+note → bekræft)
14. Geolocation auto-fanges ved problem (`navigator.geolocation`)
15. SSE-handler for `delivery_message_to_courier` → modal med "✓ OK"-ack

**Status-flow:**
16. `klar` sættes automatisk når bon-status skifter til KLAR (server-side trigger på status_change)
17. `leveret` sættes når bud trykker leveret
18. `problem` sættes når incident logges

### Definition of done
- [ ] PIN-login virker på iOS Safari + Android Chrome
- [ ] Geolocation prompt vises kun ved problem (ikke ved load)
- [ ] Naviger-knap åbner Google Maps app hvis installeret
- [ ] Foto-upload virker (test med 3MB-billede)
- [ ] SSE-besked viser modal — ack registreres
- [ ] Bon-status → KLAR opdaterer stop-status til klar automatisk
- [ ] `tests/mobile_courier.test.js` dækker status-endpoints + incident-logging

---

## 9. Migration fra Spor 1 (leveringsindikator)

Bon-kortet og office bon-listview viser i dag leveringsindikatoren baseret på `bons.delivery_vehicle_id` (Spor 1). Når Spor 2 går live skal indikatoren også reflektere route-stops:

### Strategi: parallel læsning

```sql
-- I `routes/kitchen.js` og `routes/bons.js` (listview-query):
LEFT JOIN delivery_route_stops s ON s.bon_id = b.id
LEFT JOIN delivery_routes r ON r.id = s.route_id AND r.status NOT IN ('cancelled')
LEFT JOIN delivery_vehicles v_route ON v_route.id = r.vehicle_id
LEFT JOIN delivery_vehicles v_legacy ON v_legacy.id = b.delivery_vehicle_id

-- Prioritér route-stop hvis det findes, ellers fallback til legacy:
SELECT
  COALESCE(v_route.label, v_legacy.label) AS delivery_vehicle_label,
  COALESCE(v_route.type, v_legacy.type) AS delivery_vehicle_type,
  ...
```

### SSE-events der opdaterer leveringsindikatoren

| Event | Trigger |
|-------|---------|
| `bon_updated` | Spor 1: når vehicle bookes via drawer |
| `delivery_route_stop_added` | Spor 2: når bon tilføjes en tur |
| `delivery_route_stop_removed` | Spor 2: når bon fjernes |
| `delivery_route_status_changed` | Når tur skifter status (relevante for I-dag mode) |
| `delivery_stop_status_changed` | Når stop går til klar/leveret/problem |

Frontend (`frontend/kitchen/components/bon_kort.js` og `frontend/office/bons_list.js`) håndterer alle events i samme handler.

### Hvornår kan Spor 1's legacy-felter retire?

`bons.delivery_vehicle_id`, `bons.delivery_cost_estimated`, `bons.delivery_cost_source` bevares **indefinitely** fordi de fungerer som single-source-of-truth for booking når bonnen ikke er en del af en tur (fx pickup-only bons med "Bestil bud"-knappen i drawer). Slet ikke kolonnerne.

---

## 10. Test-strategi pr. fase

| Fase | Unit | Integration | Smoke | Manuel acceptance |
|------|------|-------------|-------|-------------------|
| 3D.0 | `routing.test.js` (cache-hit, miss, timeout) | — | ORS curl med API-key | Verificér API-key i dashboard, tjek rate-limit headers |
| 3D.0b | `mini-map.test.js`, `delivery_history.test.js` | History-endpoint mod test-DB | — | Klik på bon-kort pin → modal åbner |
| 3D.1b | `delivery_calc.test.js` | `/calculate` mod test-DB | `/calculate` endpoint up | Opret bon i indre by → bike foreslås |
| 3D.2 | `route_planner.test.js` (TSP + constraints + pickup_time) | Full route-flow mod test-DB | `/routes` endpoint up | Drag 3 bons → compute → apply → kitchen ser pickup-tider |
| 3D.4 | `confirm_and_book.test.js` | Bulk-confirm mod test-DB | — | Bekræft plan med 13 kasser samme pickup → fejl |
| 3D.3 | `mobile_courier.test.js` | Status-endpoints + incident-upload | `/courier/today` up | Mark "stillet ved døren" + foto → incident i DB |

**Test-konvention:**
- T-prefiks for test-bons (`T_DEL_xxx`) for hermetic cleanup
- Hver fase får sin egen test-track i `docs/TEST_OBSERVATIONS.md`
- `sse_listener.js`-helper genbruges fra eksisterende office-tracks

---

## 11. Åbne afklaringer

| Item | Spørgsmål | Hvem afgør | Blokerer fase |
|------|-----------|------------|---------------|
| **ORS gratis tier OK?** | 2000 req/dag (cached: < 30/dag faktisk forbrug). Hvis vi rammer loftet: opgrader til paid (~€50/mdr) eller skift til self-hosted OSRM | Leif | Ikke blokerende — observér efter deploy |
| **Foto-storage backup** | `uploads/incidents/` med i nightly backup? | Bror | 3D.3 |
| **Geolocation samtykke** | Skal vi vise samtykke-tekst første gang? GDPR-implikation? | Leif | 3D.3 |
| **Sebastian — By-expressen** | Status på API-credentials? | Leif (rykker) | Kun 3D.5 |
| **Mini-kort historik-data i v1** | Skal "tidligere leveringer hertil" inkludere pre-Spor-1-bons? `delivery_events` er tom for ældre bons | Leif | 3D.0b |
| **Sortable-bibliotek vs native HTML5 drag** | Sortable.js (~30KB) eller native? | Simon | 3D.2 |

---

## 12. Filer der oprettes/ændres pr. fase

### 3D.0
```
services/routing.js                     NY (HTTP-wrapper mod ORS + cache)
.env                                    UDVIDET (ORS_API_KEY, ORS_BASE_URL)
scripts/smoke-test.sh                   UDVIDET (ORS-check)
tests/routing.test.js                   NY
```

### 3D.0b
```
routes/delivery.js                      UDVIDET (history-endpoint)
frontend/components/mini-map.js         NY
frontend/components/mini-map.css        NY
shared/leaflet-loader.js                NY
shared/api.js                           UDVIDET (fetchDeliveryHistory)
frontend/kitchen/components/bon_kort.js MODIFICERET (skift pin-handler)
frontend/office/bons_list.js            MODIFICERET (klik adresse → mini-map)
frontend/office/bon_drawer.js           MODIFICERET
frontend/office/crm/kunde_view.js       MODIFICERET ("Vis kort"-knap)
tests/delivery_history.test.js          NY
```

### 3D.1b
```
services/delivery_calc.js               NY
routes/delivery.js                      UDVIDET (POST /calculate)
shared/api.js                           UDVIDET (calculateDelivery)
frontend/embed/bestilling.js            MODIFICERET (forslag-hint)
frontend/office/bon_drawer.js           MODIFICERET (forslag-hint)
tests/delivery_calc.test.js             NY
```

### 3D.2
```
migrations/060_delivery_routes.sql      NY (eller næste tilgængelige nummer)
seeds/settings.js                       UDVIDET (12 nye keys)
services/route_planner.js               NY (inkl. constraint-check + TSP for små ture)
routes/delivery.js                      UDVIDET (12 nye endpoints)
shared/api.js                           UDVIDET (~12 nye wrappers)
frontend/office/logistik/plan.js        NY (drag-and-drop)
frontend/office/logistik/plan.css       NY
frontend/office/logistik/map.js         NY (Leaflet kort-komponent)
frontend/office/logistik/compute_modal.js NY
routes/kitchen.js                       MODIFICERET (parallel læsning af routes)
routes/bons.js                          MODIFICERET (parallel læsning)
services/sse.js                         UDVIDET (4 nye events)
tests/route_planner.test.js             NY
```

### 3D.4
```
routes/delivery.js                      UDVIDET (confirm-and-book, calendar, messages)
frontend/office/logistik/confirm_modal.js NY
frontend/office/logistik/i_dag.js       NY (live-mode)
frontend/office/logistik/tur_card.js    NY
frontend/office/logistik/send_besked.js NY
frontend/components/manual_booking_modal.js GENBRUG (fra Spor 1)
tests/confirm_and_book.test.js          NY
```

### 3D.3
```
frontend/mobile/levering.html           NY
frontend/mobile/levering.js             NY
frontend/mobile/levering.css            NY
routes/delivery.js                      UDVIDET (courier-endpoints)
services/incident_storage.js            NY (foto-håndtering)
services/sse.js                         UDVIDET (delivery_message_to_courier)
tests/mobile_courier.test.js            NY
```

### 3D.5 (når credentials kommer)
```
services/byekspressen.js                NY
routes/delivery.js                      UDVIDET (webhook-modtagelse)
sql/seed_update_byekspressen.sql        NY (én UPDATE — se §13)
```

---

## 13. By-expressen API-aktivering (3D.5)

Når Sebastian leverer credentials, kør:

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

Implementér `services/byekspressen.js`:
- `bookRoute(routeId)` — kalder API, gemmer reference, sætter `booking_status='booked'`
- `handleWebhook(payload)` — modtager status-updates + faktisk pris, opdaterer `delivery_routes.actual_cost_dkk` + `actual_cost_source='api'`

**Ingen kode-ændring** i frontend eller route-planner — `booking_method='api'` triggrer service automatisk.

---

## 14. Næste skridt

1. **Leif:** Registrér ORS API-key på openrouteservice.org (gratis konto, ~2 min)
2. **Leif:** Ryk Sebastian på By-expressen credentials (lav prioritet — blokerer kun 3D.5)
3. **Simon:** Når ORS-key er i `.env` → start 3D.0 (`services/routing.js` + cache + smoke-test)
4. **Claude/Leif:** Når 3D.0 er live → konkret prompt til Simon for 3D.0b (mini-kort)

---

*Plan oprettet maj 2026 baseret på `CLAUDE_DELIVERY.md` + `HUSKELISTE_DELIVERY_PATCH_v3.md` + `PLAN_BYEKSPRESSEN_3D4.md` + 5 godkendte mockups. Status pr. spor verificeret mod `CLAUDE.md` Spor 1 sektion. Opdateret til at bruge OpenRouteService (ingen Docker, ingen VROOM) — egen TSP + constraint-check i `route_planner.js`.*
