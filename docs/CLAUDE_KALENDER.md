# CLAUDE_KALENDER.md — Kalender-opgradering (Office)

> **Formål:** Forbedre overblikket i office-kalenderen ved at gøre status visuelt dominerende, flytte dagstotalen op, og tilpasse densitet efter viewport.
> **Status:** ✅ Implementeret (19. maj 2026) · Mockup-reference: `kalender_optimering.html`
> **Indpasning:** Standalone patch — implementeret uafhængigt af test-tracks og cutover

---

## Hvad blev faktisk implementeret (afviger fra original spec)

| Område | Spec | Implementeret | Begrundelse |
|---|---|---|---|
| Tekstfarve på bon-blok | `getStatusTextColor(hex)` luminans-helper | Bruger `BON_CONFIG.statuses[code].text` direkte | Paletten har allerede et `text`-felt per status — luminans-beregning ville være parallelt overflødigt vedligehold |
| Baggrundsfarve | Raw `BON_CONFIG.color` med "ikke brutalt mættet"-disclaimer | Raw `BON_CONFIG.color` 1:1 | Brugerens krav: "samme farver alle vegne". Hvis "rød væg"-fornemmelse opstår, kan en separat `calBg`-property tilføjes senere |
| Density-toggle | Ny kalender-specifik density (compact/normal/comfortable, breakpoints 1440/1680, topbar-toggle) | Reuse global density-system fra Density toggle-feature (17.-18. maj). Kalender-density er **override-lag** der kun aktiveres ved eksplicit valg | Undgår to parallelle density-systemer. UI sidder i Settings → Denne enhed (ikke topbar) |
| Density-værdier | `compact / normal / comfortable / auto` | `inherit / comfort / compact / dense` (matcher den globale paletten) | Konsistent vokabular med eksisterende `body.density-*` |
| Produktion-bon override | Kun `data-production` attribut-selector i CSS | Direkte inline `--bon-color: #4a7ab0` + `--bon-text: #ffffff` i `calendar.js` | Pre-eksisterende bug: inline-style har højere specificitet end CSS attribute-selector. CLAUDE.md hævdede production-bon var blå i kalender, men det virkede aldrig fordi inline-style vandt. Fixed under denne implementering |
| Calendar API | Out-of-scope | Tilføjet `b.price_category` + `pc.code AS price_category_code` til `GET /api/bons/calendar` SELECT | Pre-eksisterende bug — API leverede ikke felterne, så `isProduction`-detection i frontend fejlede altid. Opdaget under verifikation |
| Listview | Spec uafklaret | **Uændret** — kun måneds-grid blev rørt | Brugerens beslutning under planlægning |
| Topbar density-toggle | Påkrævet i topbar | Udeladt — kun Settings-UI | Brugeren bad om at vi var på forkant med det, så plumbing'en findes; topbar-knap kan eksponeres senere uden ny kode |

---

## Baggrund

Bon v2's kalender har samme dataindhold som v1, men signal-til-støj-forholdet er væsentligt dårligere. Status er flyttet fra **baggrundsfarve på hele bon-blokken** (v1) til en **tynd venstrekant-stribe** (v2). Resultatet: kontoret skal læse hver linje for at få det overblik v1 leverede på et sekund.

Mockuppen (`kalender_optimering.html`) demonstrerer den foreslåede løsning side-om-side med den nuværende stil. Skal bruges som visuel reference under implementering.

**Hvad er allerede done (skal IKKE røres):**
- Produktions-bon: blå farve via `data-production="true"` overstyrer `--bon-color` til `#4a7ab0` (commit c1274b9)
- Produktions-bon: 🔧-ikon i kalender (month + list) og bon-kort (commit c1274b9)
- Mail-ikon ✉ når `bon_mails` COUNT > 0 (kalender + bon-kort + listview)
- BonConfig-paletten konsistent på tværs af web-orders, kalender-listevisning, ugeoversigt (commit c1274b9)

Den nye implementation **skal bevare** disse — særligt `data-production`-overrideret må ikke regresseres.

---

## Datakilder

| Kilde | Felter | Brug |
|-------|--------|------|
| `bons` | `delivery_date`, `pickup_time`, `bon_number`, `pax`, `total_units`, `status_id`, `price_category_id` | Bon-blokke |
| **`BON_CONFIG.statuses`** | `color`, `label`, `code` | **ENESTE sandhed for status-farver i frontend** |
| `bons` aggregeret pr. dag | SUM(total_units), COUNT(*) | Dagstotal |
| `bons` aggregeret pr. uge | SUM(total_units), COUNT(*) | Uge-total (allerede vist) |
| `localStorage` | `calendar_density` | Husket density-valg |

> **Note:** `BON_CONFIG` ligger i `BonConfig.js` i repo-roden og er den frontend-palette der overstyrer raw `status_definitions.color` fra DB. Dette mønster er etableret i commit c1274b9 og må ikke brydes.

---

## Krav

### 1. Status som baggrundsfarve

- Bon-blokken farves med baggrundsfarve hentet fra **`BON_CONFIG.statuses[code].color`** (ikke `status_definitions.color` direkte).
- Tekstfarve beregnes fra luminans af baggrunds-hex:
  - Luminans > 0.6 → mørk tekst (en aftonet variant af baggrundsfarven, ikke ren sort)
  - Luminans ≤ 0.6 → hvid tekst
- Helper i `shared/utils.js`: `getStatusTextColor(hexBg)` returnerer text-color string.
- Border-radius: **4px** på bon-blokken (matcher resten af systemet).

**Produktions-bon bevares:** Når `data-production="true"` er sat på `.cal-bon-entry`, overstyres `--bon-color` til `#4a7ab0` som nu. Det vil sige produktions-bon's blå overstyrer status-farven — uændret adfærd.

### 2. Dagstotal øverst

- Hver dagscelle har en `.day-total` linje øverst (under day-num): `"294 enh · 3 bons"`.
- Den eksisterende footer-total i bunden af cellen **fjernes**.
- Total-kolonnen yderst til højre (uge-total) bevares.

### 3. Density-mode

Tre modes: **Kompakt / Normal / Komfortabel**

| Mode | min-height på celle | bon-row padding | font-size |
|------|---------------------|-----------------|-----------|
| Kompakt | 80px | 1px 6px | 10px |
| Normal | 110px | 3px 6px | 11px |
| Komfortabel | 140px | 5px 8px | 12px |

**Default afhænger af viewport-bredde:**

| Viewport | Default |
|----------|---------|
| < 1440px | Kompakt |
| 1440–1680px | Normal |
| > 1680px | Komfortabel |

**Override:** User kan vælge anden mode via en lille toggle i topbaren (matcher icon-buttons stil). Valget gemmes i `localStorage` under nøglen `calendar_density` (værdier: `compact` / `normal` / `comfortable` / `auto`). `auto` følger viewport. Override gælder kun den nuværende browser/device.

### 4. Tilbud som ghost-blokke

- Bons med `is_offer = 1` vises med:
  - Lysere variant af status-farven (50% alpha)
  - Stiplet border i stedet for solid
- Bevarer eksisterende adfærd hvis den findes — verificér mod kode.

### 5. Person-badge

- Bevares som i nuværende design (Leif's eksplicitte ønske).
- Vises kun når der er > 0 tildelte personer på dagen.
- Synlig i alle tre density modes.

### 6. Produktions-bon (NO-OP — allerede done)

Skal blot **ikke regresseres**. `data-production="true"` skal stadig:
- Overskrive baggrundsfarven til `#4a7ab0`
- Vise 🔧-ikon efter `bon_number`

### 7. Mail-ikon (NO-OP — allerede done)

Skal blot **ikke regresseres**. ✉-ikon vises efter `bon_number` når `bon_mails` har rows.

---

## UI-detaljer

### Topbar density-toggle

Tilføj icon-button i topbaren mellem nav-pile og "+ Ny bon" eller i højre side ved siden af de eksisterende icon-buttons:

```
[≡ density-icon] → dropdown: Auto · Kompakt · Normal · Komfortabel
```

Nuværende valg markeres. "Auto" = følg viewport-default.

### Filter-pills

Behold de eksisterende status-filterknapper i deres nuværende stil og placering. Farverne på pillerne kommer allerede fra `BON_CONFIG.statuses` efter commit c1274b9 — verificér visuel koherens med kalenderblokkene.

### Kontrast og læsbarhed

- Mockuppens nuancerede look (mørk tekst på farve) er foretrukket. **Ikke** brutalt hvid-på-mættet-farve som v1.
- Hvis en specifik hex giver dårlig læsbarhed, justeres i `BON_CONFIG.statuses` — ikke som per-status undtagelse i frontend.

---

## Implementeringsplan — gennemført

| Step | Hvad | Filer | Status |
|------|------|-------|--------|
| 1 | ~~Luminans-helper~~ — droppet | — | ✅ N/A (bruger `statusCfg.text` direkte) |
| 2 | Refaktorér `.cal-bon-entry`: raw `BON_CONFIG.color` som baggrund + `BON_CONFIG.text` som tekstfarve via inline CSS-variable | `shared/calendar.css`, `shared/calendar.js:629-650` | ✅ |
| 3 | Flyt total fra bunden til toppen af dagsceller | `shared/calendar.js:610-622` | ✅ |
| 4 | Tilføj kalender-density CSS-overrides (`body.cal-density-comfort/compact/dense`) | `shared/density.css:227-247` | ✅ |
| 5 | `window.CalendarDensity`-modul med `init/set/reset/current` + localStorage `bon_v2_calendar_density` | `shared/density.js:90-160` | ✅ |
| 6 | ~~Topbar-toggle~~ — udeladt, kun Settings-UI | `settings/index.html` | ✅ (Settings) |
| 7 | Production-bon override (fix pre-existing bug) | `calendar.js` inline + `routes/kitchen.js` JOIN | ✅ |
| 8 | Ghost-stil for `[data-offer="true"]` | `shared/calendar.css` | ✅ |
| 9 | Mail-ikon (✉) regression-tjek — uændret | — | ✅ |
| 10 | Border-radius 4px | `shared/calendar.css` | ✅ |

---

## Mockup-reference

`kalender_optimering.html` indeholder:
- Toggle mellem nuværende stil og foreslået stil (sammenligning)
- Density-toggle (Kompakt / Normal / Komfortabel)
- Repræsentativ data fra maj 2026 (samme uger som rigtigt screenshot)

Placér i `mockups/` mappen i repoet.

---

## Filer rørt

| Fil | Ændring |
|---|---|
| `shared/calendar.js` | `--bon-text` CSS-variabel sat fra `statusCfg.text`. Production-bon sætter inline `--bon-color: #4a7ab0` + `--bon-text: #ffffff` direkte (inline beats attribute-selector). Total-row rendres øverst, ikke nederst. |
| `shared/calendar.css` | `.cal-bon-entry` skiftet fra venstrekant-stribe (`border-left: 5px solid`) til fuld bg (`background: var(--bon-color)`). Border-radius 4px. Ghost-stil for `[data-offer="true"]` (50%-mix + stiplet border). Hover via `filter: brightness(1.08)`. `.cal-day-totals` flyttet fra `margin-top: auto` til top med `border-bottom: 1px dotted`. |
| `shared/density.js` | Nyt `window.CalendarDensity`-modul (init/set/reset/current/hasExplicitChoice). Sætter `body.cal-density-X` kun ved eksplicit valg. Eget event `calendar-density:change`. |
| `shared/density.css` | 3 sæt overrides (`body.cal-density-comfort/compact/dense:not(.zone-mobile) .cal-*`) der står efter de globale density-regler så cascade-rækkefølgen sikrer override. |
| `settings/index.html` | Ny "Tæthed — kalender (særskilt)" sektion med 4 radios (Følg global default + 3 modes) + nulstil-knap. JS-handlere wired til `CalendarDensity`. |
| `routes/kitchen.js` | Bonus-fix: calendar-endpointet manglede `price_category` + `price_category_code` i SELECT — pre-existing bug der gjorde production-bon-detektion umulig i frontend. |

---

## Åbne spørgsmål

1. ~~Hvor sidder kalender-rendering konkret?~~ — Bekræftet: `shared/calendar.js` (både kitchen-zone via `/kitchen/calendar.html` og office via `office/index.html` deler komponenten).
2. **Hover-tooltip på bon-blok?** Out-of-scope. v1 har ingen.
3. **Klik på tom dag-celle?** Out-of-scope. Afklares senere.
4. **Topbar-toggle for kalender-density?** Plumbing'en findes (`window.CalendarDensity.set('comfort')` virker fra hvor som helst). Kan eksponeres som icon-button i kalender-header uden ny model — kun render-logik. Implementeres når brugeren spørger efter den.

---

*Sidst opdateret: 19. maj 2026 — feature implementeret og verificeret. Specens "Patch til BON_V2_HUSKELISTE.md"-sektion er flyttet til selve huskelisten som ✅-rækker.*
