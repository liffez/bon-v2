> ⚠️ **FORÆLDET (20. maj 2026)** — denne patch er konsolideret ind i
> `CLAUDE_DELIVERY_SPOR2.md`. Læs den i stedet. Dette dokument bevares kun som historik.
> Krav her afspejler den gamle OSRM/VROOM-vision og 4-state-flowet — se Spor 2-doc'en
> for det gældende scope.

# Find/replace til `BON_V2_HUSKELISTE.md` (endelig version)

> Komplet patch efter design-session for delivery-modulet.
> **Erstatter** `HUSKELISTE_DELIVERY_PATCH.md` og `HUSKELISTE_DELIVERY_PATCH_v2.md`.
> Indeholder også krav til tilstødende moduler.

---

## ÆNDRING 1: Tilføj komplet "Delivery / levering" sektion

**FIND** (præcis tekst, inkl. linjeskift):

```
---

## Generelt / andet
```

**ERSTAT MED:**

```
---

## Delivery / levering

> **Source of truth:**
> - `CLAUDE_DELIVERY.md` (komplet spec)
> - `courier_mobile_v5.html` (mobile)
> - `plan_imorgen_v2.html` (office plan-mode)
> - `i_dag_view_v2.html` (office live-mode)
> - `tur_card_varianter_v2.html` (alle route-card states)
> - `bekraeft_og_bestil_v2.html` (bekræftelses-modal)
> - `manual_booking_modal_v1.html` (taxa-booking modal)
>
> Mockups er **bindende** for layout, farver og flows.

### Office route-planner (Plan i morgen)

| Krav | Detalje | Fase |
|------|---------|------|
| Konkret kørerute (ikke fugleflugt) | OSRM GeoJSON polyline når status≥computed | 3D.2 |
| Sequence-tal i markører | Lille hvid badge øverst-højre på markør | 3D.2 |
| Forskellige farver pr. transporttype | Brun=Volvo, blå=By-expressen, grøn=egen cykel, grå=taxa | 3D.2 |
| Drag-and-drop bons til ture | Manuel kontrol; VROOM beregner kun ved tryk | 3D.2 |
| Kun to constraint-farver | Orange=advarsel (stramt), rød=brud | 3D.2 |
| Cost vises altid med "ca." | Estimat fra cost-formel — ikke fakturapris | 3D.2 |
| Multi-stop pickup = fælles afgang | Alle stop på samme tur har samme `pickup_time` | 3D.2 |
| Sum kasser ved samme pickup ≤ kapacitet | Tjek mod `delivery_kitchen_capacity_boxes` | 3D.2/4 |
| Pickup-tider gemmes på bons ved "Acceptér" | Køkkenet ser ny pickup-tid med det samme | 3D.2 |
| Sidebar kollapsibel | Toggle-knap øverst på sidebar; localStorage-tilstand | 3D.2 |
| Selection-state binding kort↔sidebar | Klik markør → highlight bon-card + tur-card. Bidirektional. ESC ophæver | 3D.2 |

### Office route-planner (I dag — live mode)

| Krav | Detalje | Fase |
|------|---------|------|
| Tydelig live-mode-markering | Rød "LIVE" badge i topbar med pulserende dot | 3D.4 |
| Stat-bar med 3 nøgletal | Leveret · På vej · Problem | 3D.4 |
| Sequence-tal i status-farve på stop | Genbrug af `bon_status_definitions` farver | 3D.4 |
| Send-besked-knap som pille i tur-header | "💬 Send" — kun for interne courier (Volvo, egen cykel) | 3D.4 |
| Hurtige besked-templates | Chips: "Skynd dig hjem", "Tag #X med tilbage" osv | 3D.4 |
| Faktisk-tid vs planlagt på hvert stop | Orange hvis sent | 3D.4 |
| Ny bon-toast øverst | Blå (NY-status farve), forsvinder. Bon-card får "NY"-badge | 3D.4 |
| Problem på stop = rød kant + booking-footer | Pulserende sequence-cirkel + footer med "Vis"-knap | 3D.4 |
| "Afventer booking"-banner | Gul banner øverst i tur-kolonne ved `in_progress`-ture | 3D.4 |
| Completed-ture: 70% opacity + kollapsibel | Setting `delivery_completed_routes_collapsed`; localStorage-tilstand | 3D.4 |

### Tur-card states (alle kombinationer)

| Krav | Detalje | Fase |
|------|---------|------|
| Booking-badge i header | Én badge baseret på status × booking_status | 3D.2/4 |
| Booket via API + Booket manuelt = samme grøn | Visuel konsistens efter booking | 3D.4 |
| Booking-ref vises som monospace-pille | Klik = kopiér til clipboard | 3D.4 |
| Booking-footer kun ved problemer | Vises ved in_progress/failed med kald-til-handling-knap | 3D.4 |
| Pickup-banner (sort med stort tal) | Vises kun når status≥computed. Ikke i live-mode | 3D.2 |
| Aflyst tur: 60% opacity + gennemstreget badge | Bevares i listen for sporbarhed | 3D.2 |

### Mobile courier

| Krav | Detalje | Fase |
|------|---------|------|
| Pickup-info prominent (bon# + kasser) | Mørk boks med stort tal — vises før kontakt-info | 3D.3 |
| To kontakt-blokke kun hvis forskellige | "På dagen" (gul) + "Bestiller" (grå) | 3D.3 |
| SMS-knap med pre-fyldt tekst | `sms:` URL med template | 3D.3 |
| Naviger-knap åbner Google Maps i navigations-mode | URL: `maps/dir/?api=1&destination=...` | 3D.3 |
| Sekundær pin-only-knap | URL: `maps/search/?api=1&query=...` | 3D.3 |
| "Tilbage til HQ"-card efter sidste stop | Gul stiplet card med naviger-knap | 3D.3 |
| Ring kontoret-knap altid synlig | Stiplet bjælke nederst | 3D.3 |
| Geolocation auto-fanges ved problem | `navigator.geolocation` | 3D.3 |
| Foto valgfri men anbefalet | "Spring over"-mulighed i problem-flow | 3D.3 |
| Modtag besked fra office | SSE-event → modal/toast med "✓ OK"-ack | 3D.3 |

### Booking-trinet

| Krav | Detalje | Fase |
|------|---------|------|
| Clipboard-template pr. vehicle | `delivery_vehicles.booking_template`. Pladsholdere `{name}` + `{stops}` | 3D.4 |
| "Kopiér og åbn"-knap | Ét klik kopiérer + åbner extern URL | 3D.4 |
| Manglende felter markeres inline | `[mangler]` i preview + gul advarsel-boks | 3D.4 |
| Rediger-toggle på clipboard-preview | Lokal redigering ikke gemt | 3D.4 |
| Booking-ref ikke obligatorisk | "Spring over" markerer som `in_progress` | 3D.4 |
| Multi-stop bookings aggregerer | `{stops}` itererer; pakke-info summeres | 3D.4 |
| Intern kalender = view over confirmed routes | `GET /calendar` filtrerer `delivery_routes` | 3D.4 |
| iCal-eksport (senere) | Hvis ekstern sync ønskes | 3D.9 |

### Mini-kort komponent (genanvendelig)

| Krav | Detalje | Fase |
|------|---------|------|
| Genanvendelig Leaflet-baseret komponent | `frontend/components/mini-map.js`. Bruges af kitchen-bon, office-drawer, CRM | 3D.2 |
| "Tidligere leveringer hertil"-indikator | Henter seneste 5 fra Bon v2's egne data (ikke e-conomic). Vises som "📍 5 tidligere · ca. 380-510 kr" | 3D.2 |
| "Se i logistik"-knap | Springer til `/office/logistik?date=...&highlight_bon=N`. Datoen styrer mode | 3D.2 |
| "Google Maps"-knap (sekundær) | Åbner ekstern (nice-to-have for rutevejledning) | 3D.2 |

### Pris-arkitektur

| Krav | Detalje | Fase |
|------|---------|------|
| Bon v2 holder estimat | `delivery_routes.estimated_cost_dkk` fra cost-formel | 3D.2 |
| Bon v2 holder faktisk omkostning | `delivery_routes.actual_cost_dkk` + `actual_cost_source` (api/manual) | 3D.2 |
| Bon v2 holder **ikke** kunde-fakturapris | Den lever i e-conomic — Bon v2 trækker ikke data derfra i v1 | — |
| Manuel `actual_cost`-indtastning | Office UI: indtastningsfelt på tur-card for taxa | 3D.4 |
| Auto-registrering af `actual_cost` | Fra By-expressen API-respons via webhook | 3D.5 |
| e-conomic data-hentning | Ikke implementeret i v1. Senere som 3D.10 hvis behov opstår | 3D.10 |

### Status-flow og farver

| Krav | Detalje | Fase |
|------|---------|------|
| Stop-status: 4 states matcher bon-status | `planlagt`, `klar`, `leveret`, `problem` | 3D.2 |
| `klar` udledes fra bon-status | Når bon skifter til KLAR (køkken markerer): stop-status → klar automatisk | 3D.2/3 |
| `leveret` sættes via courier mobile | Bud trykker "leveret" → stop.status = leveret + completed_at | 3D.3 |
| Status-farver = bon-status farver | Genbruger `bon_status_definitions.color` via CSS-variabler | 3D.2 |
| Antaget leveret efter X min | Setting `delivery_assumed_delivered_after_min` | 3D.4 |

### Historik-side (3D.8)

| Krav | Detalje | Fase |
|------|---------|------|
| Selvstændig side `/office/leveringshistorik` | Ikke embedded i logistik-view | 3D.8 |
| Heatmap + punkter + cluster modes | Toggle mellem visualiseringer | 3D.8 |
| Filtre: dato-range, transport, kunde, kategori, pax-bracket | Default sidste 12 måneder | 3D.8 |
| Server-side aggregering | Frontend modtager kun viewport-punkter for performance | 3D.8 |
| Stats-panel med top zoner og snit km | Right sidebar | 3D.8 |
| Linkbar fra mini-kort | "Se historik for denne adresse"-link | 3D.8 |

### Rapporter

| Krav | Detalje | Fase |
|------|---------|------|
| Rapport 1: Leverings-detaljer (office-only) | Per-bon med pax, afstand, leveringstidspunkt, estimat, faktisk, diff. CSV-eksport | 3D.8 |
| Rapport 2: Aggregater (alle office-roller) | Pr. transport-type · pr. zone (postnummer) · pr. kategori · pr. pax-bracket | 3D.8 |
| Margin-rapport (estimat vs. fakturapris) | Kræver e-conomic-integration. Udskudt til 3D.10 | 3D.10 |

### Generelt

| Krav | Detalje | Fase |
|------|---------|------|
| Push-beskeder kommer i 3D.3 og 3D.4 | Ikke senere fase — vigtigt for daglig drift | 3D.3/4 |
| Send-besked kun til interne courier | Volvo og egen cykel. Eksterne ikke i vores system | 3D.4 |
| Pickup-tider er mulige at justere | VROOM må foreslå justering inden for buffer; alt skal bekræftes i v1 | 3D.2 |
| Buffer-formel | `min_buffer = osrm_drive_time + 10 min` | 3D.2 |
| 3-5 Volvo-ture/uge, typisk 1-2 stop | VROOM hovedformål er constraint-check, ikke optimering | 3D.2 |

---

## Generelt / andet
```

---

## ÆNDRING 2: Tilføj noter under "Bon-kort (kitchen)" om mini-kort + leveringsindikator

**FIND** (under sektionen "## Bon-kort (kitchen)"):

```
## Bon-kort (kitchen)
```

**TILFØJ som nye rækker** (placering afhænger af eksisterende indhold — sæt det øverst i sektionens tabel):

```
| Klik på adresse → mini-kort modal | Genanvendelig komponent fra delivery 3D.2. Modalen viser pin + "tidligere leveringer hertil" + sekundære links (Se i logistik, Google Maps) | 3D.2 |
| Leveringsindikator under "Levering"-linjen | Vis transport-type med ikon. Format: `🚴 By-expressen` eller `📍 Ikke planlagt endnu` (grå hvis intet). Klik → drawer scrollet til leveringssektion. Opdateres realtid via SSE | 3D.2 |
```

---

## ÆNDRING 3: Tilføj noter under "Drawer / office bon-detalje"

**FIND** (under sektionen "## Drawer / office bon-detalje"):

```
## Drawer / office bon-detalje
```

**TILFØJ som nye rækker:**

```
| Klik på adresse → mini-kort modal | Samme komponent som kitchen. Modalen kan udvides til at vise tidligere leveringspriser hentet fra Bon v2's egne data | 3D.2 |
| Delivery-felter på drawer | Felterne `delivery_contact_name`, `delivery_contact_phone`, `delivery_notes` skal kunne udfyldes/redigeres | 3D.2 |
| Constraint-check ved bon-oprettelse | Når bon oprettes: kald `POST /api/delivery/calculate` for at få forslag til transport. Vis i bon-form | 3D.1 |
| "Bestil bud"-knap i leveringssektion | Åbner manual booking-modal (eller trigger API-booking afhængigt af `vehicle.booking_method`). Kun i drawer — ikke på bon-kortet | 3D.4 |
| Faktisk omkostning-felt i leveringssektion | Indtastningsfelt + Gem-knap. Skriver til `delivery_routes.actual_cost_dkk` med `actual_cost_source='manual'` | 3D.4 |
| Office bon-listview viser samme leveringsindikator som kitchen-kort | Konsistens på tværs af views. Format: `🚴 By-expressen` eller `📍 Ikke planlagt endnu` | 3D.2 |
```

---

## ÆNDRING 4: Tilføj noter under "Generelt / andet"

**FIND** (i den eksisterende "Generelt / andet"-sektion, hvis den har en tabel — ellers tilføj én):

**TILFØJ som nye rækker (eller ny tabel hvis der ikke er en):**

```
| Bon låses efter cutoff (dagen-før-12) | Bons kan ændres frit indtil dagen-før kl 12. Efter: kræver bekræftelse + kommentar. Settings-key: `bon_change_cutoff_hour` | Bon-modul |
| Aflys-bon: ring budfirma | Hvis bon på `confirmed` rute aflyses: prompt office om at ringe budfirma. Logges i changelog med kommentar | Bon-modul |
| Kopiér levering | "Kopiér og opret ny bon"-knap i CRM på kunde-side. Kopierer linjer + adresse + delivery_contact_*. Dato/tid manuelt | Bon/CRM-modul |
| Auto-genereret leveringsmetode på faktura | Når bon faktureres: auto-tekst som "Leveret med Volvo" baseret på `delivery_routes.vehicle_id`. Salg behøver ikke indtaste | Bon→e-conomic |
| Bon-form med delivery-felter | `delivery_contact_name/_phone` + `delivery_notes` valgfri felter ved bon-oprettelse | Formbuilder |
```

---

## Verifikation efter find/replace

1. `BON_V2_HUSKELISTE.md` har **fem** sektioner: Kalender · Bon-kort · Drawer · **Delivery / levering** · Generelt
2. "Delivery / levering" har **9 underafsnit**: Office plan-mode, Office live-mode, Tur-card states, Mobile courier, Booking-trinet, Mini-kort, Pris-arkitektur, Status-flow, Historik+Rapporter, Generelt
3. Bon-kort, Drawer og Generelt har fået ekstra rækker for tilstødende moduler
4. Eksisterende indhold er uændret (kun tilføjelser)

---

*Endelig version — april 2026*
