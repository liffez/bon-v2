# Bon v2 — Spec: Planlægningsbon
*Fase 3D · Marts 2026*

---

## Formål

En aggregerings-bon der summerer menu-linjer på tværs af rigtige bons i en valgt periode.
Bruges af køkkenet til at planlægge produktion: hvad og hvor meget skal laves.
Tilgængelig i både kitchen-zonen og office-zonen.

Ingen ordre, ingen kunde, ingen status. Ren produktionsoversigt.

---

## Fil-placering

```
shared/views/planning.html   ← delt view (kitchen + office bruger samme fil)
```

Inkluderes i:
- `kitchen/planning.html` → kitchen-shell (topbar)
- `office/views/planning.js` → office-shell (sidebar)

---

## Layout — top til bund

```
┌──────────────────────────────────────────────────────┐
│  [▶ Ugeoversigt]                                     │  ← kollapset som default
│  (klik folder ud — viser ugeplan for start-ugen)    │
├──────────────────────────────────────────────────────┤
│  STATUS-FILTER                                       │
│  [GODKENDT] [IGANG] [KLAR] [LEVERET]  ✕TILBUD ✕FAK │  ← toggle knapper
├──────────────────────────────────────────────────────┤
│  PERIODE                                             │
│  Fra: [Man 23. mar]   Til: [Søn 29. mar]   📅        │
├──────────────────────────────────────────────────────┤
│  BONS I PERIODEN                          [Vælg alle]│
│  ☑  #3421  Firma A · Man 23/3 · 40 enh              │
│  ☑  #3422  Firma B · Tir 24/3 · 25 enh              │
│  ☑  #3423  Firma C · Tir 24/3 · 12 enh              │
│  ☐  #3424  Tilbud D · Ons 25/3 (grå, tilbud)        │
├──────────────────────────────────────────────────────┤
│  AGGREGERET BON                                      │
│  [Normal bon-layout fra bon_kort_builder.js]         │
│  — special_request strippet                          │
│  — normal action-bar (Råvarer, Sammentælling, ...)   │
└──────────────────────────────────────────────────────┘
```

---

## Ugeoversigt-toggle

- **Default:** kollapset (`▶ Ugeoversigt`)
- **Udfoldet:** viser `shared/views/ugeplan.html`-indholdet for den uge start-datoen befinder sig i
- Når brugeren ændrer start-dato: ugeoversigten følger med til den nye uge (hvis udfoldet)
- Toggle-tilstand huskes i `localStorage` per zone (`planning_ugeplan_open_kitchen` / `_office`)

---

## Status-filter

- Knapper bygges fra `BON_CONFIG.statuses` (samme mønster som resten af systemet)
- **Default aktive:** GODKENDT, IGANG, KLAR, LEVERET
- **Default inaktive:** NY, VENTER, TILBUD, FAKTURERET, AFSLUTTET, BETALT, AFLYST
- Toggle on/off — huskes i `localStorage` (`planning_status_filter`)
- Tilbud (`is_offer = 1`) filtreres separat fra status-filteret — de kan slås til/fra uafhængigt

---

## Periode-valg

- To date-inputs: `fra` og `til`
- Default: indeværende uge (mandag–søndag)
- Når `fra` ændres: ugeoversigten (hvis udfoldet) springer til den uge `fra` ligger i
- Ingen begrænsning på periodeLength — brugeren vælger frit

---

## Bon-liste

Henter `GET /api/bons?from=&to=&status=` (eksisterende endpoint, udvidelse med `from`-param om nødvendigt).

Vises som kompakt tjekliste:
```
☑  #3421  Firma A · Man 23. mar · 40 enh · IGANG
☑  #3422  Firma B · Tir 24. mar · 25 enh · GODKENDT
```

- Tilbud vises dæmpet/grå
- `[Vælg alle]` / `[Fravælg alle]` knap
- Ændring i valgte bons → aggregeret bon genberegnes

---

## Aggregering

Aggregeringen sker **client-side** fra allerede hentede bon-data.

### Nøgle for sammenlægning
`grocy_recipe_id` er primær nøgle — to linjer med samme `grocy_recipe_id` lægges sammen.
Fallback: `product_name + unit` (hvis `grocy_recipe_id` er null).

### Hvad aggregeres
```js
// Per unik grocy_recipe_id:
{
  grocy_recipe_id: 42,
  product_name:    "Falafel sandwich",
  category:        "01 Sandwich",
  unit:            "stk",
  quantity:        summen af alle matchende linjer,
  unit_price:      gennemsnit (vægtet) — kun hvis show_prices = true,
  cost_price:      gennemsnit (vægtet) — kun hvis show_prices = true,
  special_request: null   // altid strippet
}
```

### Hvad fjernes
- `special_request` — irrelevant for produktion
- Kunde-info, levering, prep-badges, fortryd-bar, status-bar

### Rendering
Aggregerings-bonen har ingen kunde, ingen status, intet id — den er strukturelt forskellig fra en rigtig bon.
Derfor en **ny funktion** `createPlanningCard(aggregatedLines, meta)` i `bon_kort_builder.js` — ikke en variant af `createCard()`.

`createPlanningCard()` genbruger de eksisterende builder-helpers men bygger kun det den har brug for:
- `_buildMenu()` + `_buildMenuItem()` — menulisten
- `_buildActions('planning', 'planningCard')` — action-bar
- `_buildSummaryPanel('planning', 'planningCard')` — sammentællings-panel

`meta` indeholder kontekst til action-knapper:
```js
{
  aggregatedLines: [...],   // til Råvarer-knappen
  bonIds: [3421, 3422],    // hvilke bons indgår
  showPrices: false
}
```

`createCard()` røres ikke — den forbliver ren til rigtige bons.

Resultatet renderes med view-konfiguration:
```js
VIEW_MODULES['planning'] = {
  prep:         false,
  customer:     false,
  alerts:       false,
  co2:          false,
  select:       true,
  kitchenInfo:  false,
  deliveryBlock: false,
  summary:      true,
  showRecipePrices: false   // styres af setting
}
```

Action-knapper i `VIEW_ACTIONS['planning']`:
- Råvarer (bruger aggregerede grocy_recipe_ids + summerede quantities)
- Sammentælling
- (ingen mail, ingen kort, ingen flyver)

---

## Priser

Kontrolleres af `system_settings`-nøglen `show_prices_in_planning` (boolean, default `false`).

Hentes én gang ved sideload via `GET /api/settings`.

Hvis `true`:
- Salgspris per linje (fra bonens price_category — vis den hyppigst forekommende eller gennemsnit)
- Kostpris per linje
- Total salgspris + total kostpris i bunden af aggregerings-bonen
- Margin i procent

Hvis `false`: priser skjules fuldstændigt — ingen kolonner, ingen totaler.

Indstillingen tilføjes til `settings/index.html` under **Køkken**-sektionen.

---

## API-udvidelse

Eksisterende `GET /api/bons` udvides med:
- `from` param (ISO dato, inklusive) — start på periode
- `to` param (ISO dato, inklusive) — slut på periode

Returnerer bons inkl. linjer (`bon_lines`) i responset, da aggregeringen sker client-side.
Alternativt: eget endpoint `GET /api/bons/planning?from=&to=&status=` der returnerer
bons + lines i ét kald (anbefalet — undgår N+1 kald).

---

## Nyt endpoint (anbefalet)

```
GET /api/bons/planning?from=2026-03-23&to=2026-03-29&status=godkendt,igang,klar,leveret
```

Response:
```json
[
  {
    "id": 3421,
    "bon_number": "RR-3421",
    "delivery_date": "2026-03-23",
    "status_code": "igang",
    "total_units": 40,
    "is_offer": 0,
    "customer_name": "Firma A",
    "lines": [
      {
        "grocy_recipe_id": 42,
        "product_name": "Falafel sandwich",
        "category": "01 Sandwich",
        "quantity": 12,
        "unit": "stk",
        "unit_price": 94,
        "cost_price": 23.55
      }
    ]
  }
]
```

Monteres i `routes/kitchen.js` (samme fil som `/today` og `/later`).

---

## Tilstands-model (client-side)

```js
const state = {
  from:           '2026-03-23',    // ISO
  to:             '2026-03-29',    // ISO
  activeStatuses: ['godkendt', 'igang', 'klar', 'leveret'],
  showOffers:     false,
  selectedBonIds: Set,             // hvilke bons er tjecket
  bons:           [],              // rådata fra API
  aggregated:     [],              // beregnede linjer
  ugeplanOpen:    false,
  showPrices:     false            // fra settings
};
```

Når `from`, `to` eller `activeStatuses` ændres → nyt API-kald.
Når `selectedBonIds` ændres → re-aggreger (ingen API-kald).

---

## SSE

Lyt på `bon_updated` og `bon_created` — hvis ændret bon falder inden for perioden: re-fetch og re-aggreger.

---

## Settings-tilføjelse

I `settings/index.html` under sektionen **Køkken** tilføjes:

```
☐  Vis priser i planlægningsbonnen
   (salgspris og kostpris vises for alle brugere med adgang til planlægning)
```

Gemmes som `PATCH /api/settings/show_prices_in_planning` med value `'true'` / `'false'`.

---

## Delopgaver

Implementeres i rækkefølge — test efter hver del inden næste påbegyndes.

---

### Delopgave A — Backend endpoint

**Fil:** `routes/kitchen.js`

Nyt endpoint:
```
GET /api/bons/planning?from=2026-03-23&to=2026-03-29&status=godkendt,igang,klar,leveret
```

- Returnerer bons + lines i ét kald (undgår N+1)
- `from` og `to` er inklusive
- `status` er kommasepareret liste af status-koder
- Tilbud (`is_offer = 1`) returneres altid — filtrering sker client-side
- Lines inkluderes inline på hver bon (se response-format under "Nyt endpoint")

**Test:** `curl "http://localhost:4321/api/bons/planning?from=2026-03-23&to=2026-03-29&status=godkendt,igang"` → bekræft at lines er med og quantities er korrekte

---

### Delopgave B — Grundlæggende UI + aggregering

**Filer:** `shared/views/planning.html`, `bon_kort_builder.js`

- Periode-valg (fra/til date-inputs, default indeværende uge)
- Bon-liste med checkboxes (Vælg alle / Fravælg alle)
- `createPlanningCard(aggregatedLines, meta)` i `bon_kort_builder.js`
- Aggregeringslogik client-side (grocy_recipe_id som nøgle, fallback product_name+unit)
- Status-filter med localStorage persistens
- Menuliste renderes korrekt med summerede quantities

**Test:** Vælg to bons med overlappende varer → bekræft at `12 + 8 = 20 stk Falafel sandwich` i aggregeret bon. Fravælg én bon → bekræft at aggregat opdateres uden API-kald.

---

### Delopgave C — Ugeoversigt-toggle

**Fil:** `shared/views/planning.html`

- Kollapset som default (`▶ Ugeoversigt`)
- Udfoldet: viser `shared/views/ugeplan.html`-indholdet for start-datoen's uge
- Ændring af start-dato mens udfoldet → springer til ny uge
- Toggle-tilstand huskes i localStorage (`planning_ugeplan_open_kitchen` / `planning_ugeplan_open_office`)

**Test:** Udfold → skift start-dato til anden uge → bekræft at ugeoversigt følger med.

---

### Delopgave D — Råvarer-knap (multi-recipe)

**Fil:** `shared/modal.js` — udvidelse af `showRavarer()`

Nuværende `showRavarer(cardId)` henter én bons linjer og slår `grocy_recipe_id` op én ad gangen.

Ny signatur: `showRavarer(cardId | null, aggregatedLines | null)`

Når kaldt fra planning-kortet:
- `cardId` er null
- `aggregatedLines` er listen af `{ grocy_recipe_id, quantity, product_name }`
- For hver unik `grocy_recipe_id`: kald `GET /api/grocy/recipes/:id/ingredients`
- Skalér med den summerede `quantity` fra aggregat (ikke per-bon quantity)
- Kombiner med `GET /api/grocy/stock` som normalt
- Gruppering og visning identisk med eksisterende Råvarer-modal

Eksisterende kald fra rigtige bon-kort (`showRavarer('bon3421')`) må ikke ændre opførsel.

**Test:** Aggregér to bons med samme opskrift → åbn Råvarer → bekræft at ingrediensmængder er summeret korrekt ift. den samlede quantity.

---

### Delopgave E — Priser + settings

**Filer:** `shared/views/planning.html`, `settings/index.html`

- Hent `show_prices_in_planning` fra `GET /api/settings` ved sideload
- Hvis `true`: vis salgspris, kostpris og margin per linje + totaler i bunden af planning-kortet
- Hvis `false`: ingen priser synlige (ingen kolonner, ingen totaler)
- Tilføj toggle i `settings/index.html` under **Køkken**-sektionen
- Gem via `PATCH /api/settings/show_prices_in_planning`

**Test:** Slå priser til i settings → genindlæs planning → bekræft priser vises. Slå fra → bekræft de forsvinder.

---

## Verifikation

- Periodevalg → korrekte bons hentes
- Fravælg én bon → aggregat opdateres uden API-kald
- `grocy_recipe_id`-sammenlægning fungerer (12 + 8 = 20 af samme vare fra to bons)
- Fallback til `product_name`-nøgle hvis `grocy_recipe_id` er null
- Råvarer-knap modtager korrekte summerede quantities
- `show_prices_in_planning = false` → ingen priser synlige
- Ugeoversigt følger start-dato (hvis udfoldet)
- Toggle-tilstand huskes i localStorage
