# CLAUDE_CO2_TRANSPORT.md — Transport-CO₂ i CO₂-oversigten

> **Status:** Godkendt design (mockup: `co2_transport_mockup_v1.html`)
> **Afhænger af:** CO₂-modulet (`routes/co2.js` + `office/views/co2-overblik.js` — findes og er i drift), leveringsmodulet (`delivery_vehicles` + ruter), Settings → Leveringsmetoder
> **Princip:** Ingen snapshot i v1 — transport-CO₂ beregnes on-the-fly i rapporter. Km ligger fast i geo-data; kun faktorerne er "live".
> **Sidst opdateret:** 2026-07-13 — verificeret mod faktisk skema + fire designafklaringer fra Leif (legacy-mapping, positionerings-tillæg, datakvalitets-synlighed).

---

## Formål

CO₂-oversigten viser i dag kun mad + emballage. Transport tilføjes som:

1. Eget KPI-kort (12 mdr + km-dækning)
2. Ny sektion "Transport pr. leveringsmetode" (tabel + km-fordelingsgraf)
3. Udvidet CO₂-strip på bon-kort
4. Nye mail-variabler

**Låste beslutninger:**

| Beslutning | Valg |
|------------|------|
| Kuvert-KPI (0,33 kg) | Forbliver **ekskl. transport** — label opdateres til "mad + emballage, ekskl. transport" |
| `{{co2Total}}` | Uændret (mad + emballage) — nye variabler lægges oveni, ingen breaking change |
| Afhentning | 0 — kundens transport er uden for scope; vises eksplicit i tabellen |
| Multi-stop-ruter | Rutens CO₂ fordeles **km-vægtet** pr. stop (se §3) |
| Snapshot | Nej i v1 — on-the-fly. Evt. `transport_co2e` snapshot ved LEVERET i senere version |
| Legacy `delivery_method` | `bike` = altid **By-expressen** (historisk). Map method→vogn via `type` (se §1b) |
| Eksterne buds positionering | Konstant `co2_positioning_km` (leverandørens base → HQ) lægges oveni (se §1) |
| Datakvalitet | km-dækning er et **førsteklasses krav**, ikke pynt — vises prominent (se §2.4) |

---

## Verificeret mod skema (2026-07-13) — tidligere "grep først"-punkter er afklaret

| Punkt | Resultat |
|-------|----------|
| **CO₂-værtside findes** | `routes/co2.js` mountet på `/api/co2` (`/overview`, `/timeseries`, `/synonyms`, `/materials`, `/packaging`). Frontend: `office/views/co2-overblik.js` + `.css`. Transport = tilføj til eksisterende. |
| **Leveringsmetode-lagring** | **Tabel** `delivery_vehicles` (ikke settings-JSON). Migration = ren `ALTER TABLE ADD COLUMN`. |
| **geo_calculations** | Kolonner bekræftet: `distance_meters`, `duration_seconds`, `address_id`, `bon_id` (73_delivery_routes.sql). |
| **Leg-km pr. stop** | Gemmes: `delivery_route_stops.distance_from_prev_m` + `delivery_routes.total_km`. §3's primære vægtkilde findes — OSRM-fallbacken er ikke nødvendig. |
| **Seneste migration** | På denne branch findes 120-124 (bestilling, co2-materialer, smartplan, synonymer m.fl. — inkl. dublet-numre 123/124). Næste ledige = **125** (specens gamle "117" er taget). |
| **Vogn-seed (57)** | `volvo`/Volvo Duett · `own-bike`/Egen cykel · `bike`/By-expressen · `taxi`/Taxa 4×35. Type↔vogn er 1:1 blandt {volvo, bike, taxi}. |

---

## §1 · Datamodel — fire nye felter pr. leveringsmetode

Migration `db/migrations/125_co2_transport.sql` — `ALTER TABLE delivery_vehicles ADD COLUMN` ×4:

| Felt | Type | Default | Beskrivelse |
|------|------|---------|-------------|
| `co2_g_per_km` | REAL | 0 | g CO₂e pr. km (fx Volvo 250, el-taxa 60, cykelbud 5) |
| `co2_g_fixed` | REAL | 0 | Fast g CO₂e pr. tur — fallback når km-data mangler (positionering er bagt ind her) |
| `co2_distance_multiplier` | REAL | 1.0 | Kun punkt-til-punkt: Volvo 2,0 (tur/retur), bud/taxa 1,0 (kun ud) |
| `co2_positioning_km` | REAL | 0 | **Konstant km fra leverandørens base til HQ.** Eksterne bud (By-expressen/Taxa) starter ikke fra HQ — de positionerer først. Egne vogne = 0 (starter på HQ). |

Seed-værdier: **Leif leverer de konkrete faktorer** — sæt 0 som default indtil da. Redigeres i Settings → Leveringsmetoder (§4 Fase 1.2).

**Om `co2_positioning_km`:** vores egne kørsler (Volvo, Egen cykel) starter fra HQ, så `geo_calculations` (HQ→adresse) passer direkte → positionering = 0. Eksterne bud kører mange forskellige ture og starter fra deres egen base; en ærlig standard er afstanden *deres base → HQ*, lagt oveni hver tur. Det er et **standard-estimat** (nærmeste ledige bud varierer i virkeligheden) → skriv afgrænsningen i metodenoten (VSME kræver metodegennemsigtighed). Rå km-felt er valgt fremfor en base-adresse+geokodning for enkelthed; base-adresse kan tilføjes som nice-to-have senere uden at bryde formlen.

### §1b · Legacy-resolver: `delivery_method` → vogn

`delivery_vehicle_id` findes kun på nye bons (Spor 1/2). Historiske bons (~2245) har kun `delivery_method`-enum'en (`bike/taxi/volvo/pickup`). Resolver-regel i servicen:

```
1. bon.delivery_vehicle_id sat  → brug den vogns faktorer + label
2. ellers bon.delivery_method:
     'volvo'  → vogn med type='volvo'   (Volvo Duett)
     'bike'   → vogn med type='bike'    (By-expressen — historisk er bike altid By-expressen)
     'taxi'   → vogn med type='taxi'    (Taxa 4×35)
     'pickup' → afhentning (0, uden for scope)
```

Ingen mapping-tabel nødvendig — `type` er 1:1 med de tre motoriserede/eksterne metoder. **Egen cykel** (`type='own-bike'`) nås kun via `delivery_vehicle_id` på nye bons, aldrig via legacy-enum'en (bevidst — historisk bike = By-expressen). Hvis flere aktive vogne deler samme `type`, vælg en udpeget default (fx laveste `sort_order`).

---

## §2 · Beregningshierarki pr. levering

```
1. Bon ligger på beregnet rute (kun interne vogne — eksterne bud er aldrig på vores ruter)
   → rutens faktiske km (inkl. retur) × co2_g_per_km, fordelt km-vægtet pr. stop (§3)
   → multiplier + positioning bruges IKKE (ruten kender den reelle kørsel; egen vogn fra HQ)

2. Ingen rute, men geo-data findes (geo_calculations) — typisk for eksterne bud + ikke-rutede interne
   → co2 = ( co2_positioning_km + (distance_meters/1000) × co2_distance_multiplier ) × co2_g_per_km

3. Ingen km-data
   → co2_g_fixed (markeres som fallback-estimat; positionering er bagt ind i den faste værdi)

4. Metoden har hverken faktor eller fixed, eller bon er afhentning
   → 0 · afhentning = "uden for scope" · manglende data tælles i datakvalitet
```

Implementeres som ren funktion i `services/co2Transport.js`:

```javascript
// vehicle resolves via §1b (delivery_vehicle_id ELLER delivery_method→type)
// returnerer { grams, source: 'route' | 'p2p' | 'fixed' | 'none', vehicleLabel }
function transportCo2ForBon(bon, vehicle, routeData, geoCalc) { ... }
```

`source` bruges direkte til dæknings-% og datakvalitets-chippen. `vehicleLabel` bruges på bon-kort + mail.

**Positionering (branch 2):** lægges oveni som en konstant (ikke × multiplier), fordi det er et fast positioneringsben, ikke en del af selve leveringsafstanden. For egne vogne er `co2_positioning_km=0` → uændret. For By-expressen/Taxa løfter det de urealistisk lave per-levering-tal op på et ærligt niveau.

---

## §3 · Km-vægtet fordeling på multi-stop-ruter

Rutens samlede CO₂ fordeles efter hvert stops andel af kørslen:

```
rute_co2      = rute_km_total × co2_g_per_km        (delivery_routes.total_km, inkl. retur-ben)
vægt_i        = ben_km_i                             (delivery_route_stops.distance_from_prev_m / 1000)
andel_i       = vægt_i / Σ vægt                      (retur-bennet fordeles proportionalt via total_km)
bon_co2_i     = rute_co2 × andel_i
```

- **1 stop:** andel = 100% (dækker Vig-casen: 181 km × faktor til én bon)
- **Vægtkilde bekræftet:** `distance_from_prev_m` gemmes pr. stop → brug den. (Den gamle OSRM-fallback er ikke nødvendig — men behold den som defensiv gren hvis et stop mangler `distance_from_prev_m`.)
- Afrunding: fordel resten på sidste stop så Σ bon_co2 = rute_co2 præcist

---

## §4 · Faser

### Fase 1 — Settings + beregningsservice

| # | Opgave | Fil |
|---|--------|-----|
| 1.1 | Migration: fire nye felter (§1) | `db/migrations/125_co2_transport.sql` |
| 1.2 | Fire inputfelter i Rediger-formularen under Cost-formel, sektion "🌱 CO₂-beregning" — layout jf. mockup §3 (inkl. `co2_positioning_km`) | Settings → Leveringsmetoder |
| 1.3 | `services/co2Transport.js` — legacy-resolver (§1b) + hierarki (§2) + rutefordeling (§3), rene funktioner | ny fil |
| 1.4 | `GET /api/co2/transport?months=12` — aggregat pr. metode: leveringer, km, co2, gns, dækning + total | `routes/co2.js` (eksisterende — tilføj route) |

**Test Fase 1**

| Test | Forventet |
|------|-----------|
| Bon på 1-stop-rute, 181 km, faktor 250 g/km | 45,25 kg, source `route` |
| Rute 30 km total, to stop med ben 10 + 15 km | fordeling 40% / 60% af 7,5 kg — sum = præcis 7,5 kg |
| Bon uden rute, geo 6,2 km, multiplier 2,0, faktor 250, **positioning 0** | 3,1 kg, source `p2p` |
| Bon uden rute, geo 6,2 km, multiplier 1,0, faktor 60, **positioning 8 km** (By-expressen) | (8 + 6,2)×60 = 852 g, source `p2p` |
| Bon uden km-data, fixed 25 g | 25 g, source `fixed` |
| Afhentning | 0, ekskluderet fra dækning |
| Metode med alle faktorer = 0 | 0, source `none` |
| **Legacy bon: `delivery_method='bike'`, ingen vehicle_id** | resolves til By-expressen-vognens faktorer |
| **Legacy bon: `delivery_method='volvo'`** | resolves til Volvo-vognens faktorer (multiplier 2,0) |

### Fase 2 — CO₂-oversigten

| # | Opgave |
|---|--------|
| 2.1 | KPI-kort "Transport · 12 mdr" (kg + km-dækning i undertekst); kuvert-kortets label ændres til "ekskl. transport" |
| 2.2 | Sektion "Transport pr. leveringsmetode" mellem "CO₂ over tid" og "CO₂ pr. opskrift": hierarki-forklaring, metode-tabel (metode m. vognfarve-dot, leveringer, km, CO₂, gns/levering, km-dækning), footer-total ekskl. afhentning |
| 2.3 | km-fordelingsgraf — vandrette bjælker med % og km, vognfarver fra leveringsmodulet |
| 2.4 | **Datakvalitets-strip (førsteklasses krav):** "N leveringer mangler km-data" + link til leveringsmodulet. Skal være prominent — i dag (7 uger efter cutover) er 12-mdr-vinduet domineret af før-geo-data, så dækningen bliver lav indtil geodata-backfill kører. Det SKAL vises ærligt, ikke skjules. |
| 2.5 | "CO₂ over tid"-grafen: transport som egen kategori i den stakkede visning (kategorien `x-Levering` findes allerede i legenden — genbrug/omdøb) |

**Test Fase 2**

| Test | Forventet |
|------|-----------|
| Metode uden leveringer i perioden | Vises ikke i tabellen |
| Alle leveringer mangler km | Dækning 0%, alt beregnet via fixed, gul strip viser fuldt antal |
| Afhentnings-rækken | "—" i km/gns/dækning, 0 kg, note "uden for scope" |
| Total-rækken | Ekskluderer afhentning i antal og dækning |
| Lav km-dækning (fx <50%) | Strip er tydeligt synlig, ikke skjult |

### Fase 3 — Bon-kort + mail

| # | Opgave |
|---|--------|
| 3.1 | CO₂-strip på bon-kort udvides: `Mad X kg · Transport Y kg (metode) · I alt Z kg` — transport-delen skjules hvis source = `none` |
| 3.2 | Mail-variabler: `{{co2Transport}}` ("0,9 kg"), `{{co2MedTransport}}` ("5,2 kg CO₂e"), `{{leveringsMetode}}` (metodens visningsnavn). `{{co2Total}}` røres ikke |
| 3.3 | Variabel-chips i skabelon-editoren opdateres |

**Test Fase 3**

| Test | Forventet |
|------|-----------|
| Bon med transport-data | Strip viser tre tal, i alt = mad + transport |
| Afhentnings-bon | Strip viser kun mad-tal (som i dag) |
| Skabelon med `{{co2MedTransport}}`, bon uden km-data | Fallback-tal indsættes (ikke `[mangler]`) |
| Gammel skabelon med `{{co2Total}}` | Uændret output |

---

## Åbne punkter

| Punkt | Ejer | Status |
|-------|------|--------|
| Konkrete CO₂-faktorer pr. metode (g/km + fixed + positioning-km) | Leif | ⏳ Indtastes i Settings efter Fase 1 |
| ~~Rute-tabellernes navne + om ben-km gemmes pr. stop~~ | — | ✅ Afklaret: `delivery_route_stops.distance_from_prev_m` + `delivery_routes.total_km` |
| ~~Leveringsmetode-lagring: tabel vs. settings-JSON~~ | — | ✅ Afklaret: tabel `delivery_vehicles` → `ALTER TABLE` |
| Geodata-backfill for gamle leveringer | Separat projekt (#234) | Forbedrer dækning løbende — blokerer intet, men lav dækning skal vises ærligt (§2.4) |
| `transport_co2e` snapshot ved LEVERET (revisionssikre ESG-tal) | — | Udskudt til senere version |

---

## Til CLAUDE.md → "Næste opgave"

```
Transport-CO₂ (CLAUDE_CO2_TRANSPORT.md):
Fase 1 — migration 125 (FIRE felter på delivery_vehicles: co2_g_per_km,
co2_g_fixed, co2_distance_multiplier, co2_positioning_km),
services/co2Transport.js (legacy-resolver §1b + hierarki §2 + rutefordeling §3),
GET /api/co2/transport tilføjet til eksisterende routes/co2.js.
Bygger på det eksisterende, kørende CO₂-modul (routes/co2.js + office/views/co2-overblik.js).
Mockup: co2_transport_mockup_v1.html
```
