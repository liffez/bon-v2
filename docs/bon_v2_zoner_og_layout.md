# Bon v2 — Zoner, Layout & Filstruktur
## Arkitektur-dokument · Marts 2026

> **Formål:** Definer zoner, navigation, roller, filstruktur og designsystem-strategi som fælles reference for udvikling. Læses sammen med `bon_v2_arkitektur_diskussion.md` og `bon_v2_datamodel_v2.md`.

---

## 1. OVERBLIK — FIRE ZONER

Bon v2 består af fire UI-zoner med forskellig shell, layout-densitet og primær bruger. De er ikke adskilte applikationer — de deler samme backend, database og designsystem — men de har hver deres HTML-shell og navigationsmodel.

```
┌─────────────────────────────────────────────────────────────────┐
│                        BON V2 SERVER                            │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │   KITCHEN        │  │   OFFICE         │                    │
│  │   (topbar)       │  │   (sidebar)      │                    │
│  │   Tablet/stor    │  │   Desktop        │                    │
│  │   touch-venlig   │  │   informationstæt│                    │
│  └──────────────────┘  └──────────────────┘                    │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │   LOGISTIK       │  │   SETTINGS       │                    │
│  │   (delt)         │  │   (kontrolpanel) │                    │
│  │   Desktop + mobil│  │   Desktop        │                    │
│  │   bud-app senere │  │   sjældent brugt │                    │
│  └──────────────────┘  └──────────────────┘                    │
│                                                                 │
│  ══════════════════════════════════════════════════════         │
│  SELVSTÆNDIGE SYSTEMER (egne servere, sidekick-integration)    │
│  Whiteboard · SOP · Smartplan                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. ROLLER OG ZONEADGANG

Roller styres via `users.role` i databasen. `default_zone` bestemmer hvad brugeren lander på ved login.

| Rolle               | Kitchen | Office | Logistik | Settings | default_zone |
|---------------------|---------|--------|----------|----------|--------------|
| `kok`               | ✅      | —      | ✅       | —        | kitchen      |
| `koekkenchef`       | ✅      | —      | ✅       | delvis   | kitchen      |
| `kontor`            | —       | ✅     | ✅       | —        | office       |
| `salg`              | —       | salg   | —        | —        | office       |
| `admin`             | ✅      | ✅     | ✅       | ✅       | office       |
| `bud`               | —       | —      | bud-view | —        | logistik     |

> **Bemærk:** Køkkenroller ser logistik-planlægning som en del af kitchen-zonen (samme topbar-navigation). Kontor ser det som et punkt i office-sidebaren. Det er det samme data, to indgange.

---

## 3. KITCHEN-ZONEN

### Shell
- **Layout:** Topbar + content. Ingen sidebar.
- **Device:** Primært tablet (stående eller liggende), evt. stationær skærm i kiosk-mode.
- **UI-densitet:** Touch-first. Store klikflader, tydelig typografi, minimal tekst.
- **Tech:** Multi-page (MPA) — hver view er sin egen HTML-fil. Topbar inkluderes som shared komponent.

### Topbar-navigation

Otte punkter er for mange til én topbar-linje på tablet. Løsning: primær og sekundær gruppe.

```
┌─────────────────────────────────────────────────────────────────┐
│  🍞  [ I DAG ]  [ SENERE ]  [ PLANLÆGNING ]  [ ··· Mere ▼ ]   │
│                                                                 │
│  Under "Mere":  Opskrifter · Lager · Indkøb · Varemodtagelse   │
└─────────────────────────────────────────────────────────────────┘
```

Alternativ (hvis skærmen er bred nok): alle otte i én linje med kortere labels.

```
[ I Dag ] [ Senere ] [ Plan ] [ Opskrifter ] [ Lager ] [ Indkøb ] [ Bestillinger ] [ Modtagelse ]
```

> **Beslutning:** Afklares i mockup-fase. Afhænger af faktisk skærmbredde i produktionen.

### Views i Kitchen-zonen

| View               | Fil                     | Beskrivelse                                              | UI-densitet    |
|--------------------|-------------------------|----------------------------------------------------------|----------------|
| Dashboard          | `kitchen/index.html`    | Dagens overblik: alerts, leveringer, antal bons, prep    | Touch           |
| Køkken I Dag       | `kitchen/today.html`    | Bon-kort, kiosk-mode, ringer-animation                   | Kiosk/Touch    |
| Køkken Senere      | `kitchen/later.html`    | Kommende bons, næste dage                                | Touch           |
| Planlægning        | `kitchen/planning.html` | Produktionsplanlægning, hvad skal laves hvornår          | Funktionel     |
| Opskrifter         | `kitchen/recipes.html`  | Skalering til produktion, ingredienser fra Grocy         | Funktionel     |
| Lagerstatus        | `kitchen/stock.html`    | Lagercheck, optælling, beholdning                        | Touch           |
| Indkøbsliste       | `kitchen/purchasing.html`| Bestillinger ud til leverandører                        | Funktionel     |
| Bestillinger       | `kitchen/orders.html`   | Oversigt over indkommende bestillinger                   | Funktionel     |
| Varemodtagelse     | `kitchen/goods-receipt.html` | Modtagelse, temp-tjek, foto, dokumentation         | Touch           |

### Kiosk-mode
"Køkken I Dag" kan skifte til ægte kiosk-mode: topbar skjules, fullscreen, passiv visning. Aktiveres via en knap i viewet eller URL-parameter (`?kiosk=1`).

### Whiteboard Sidekick
Sidekick er tilgængelig i alle kitchen-views (og office) som et tre-trins overlay:

```
Trin 1: Flydende ikon (nederst højre) — whiteboard er lukket
Trin 2: Sidepanel (25% af skærmen, højre side) — hurtig adgang
Trin 3: Fullscreen — fuld whiteboard-visning
```

Bon-systemet trækker sig til 75% bredde når sidepanelet åbnes. Whiteboard kører på sin egen server og vises via iframe i sidekick-panelet. Sidekick-tilstand huskes pr. bruger/enhed.

---

## 4. OFFICE-ZONEN

### Shell
- **Layout:** Fast sidebar (venstre) + content-område (højre). Topbar med søgning og bruger-info.
- **Device:** Desktop. Ikke optimeret til touch.
- **UI-densitet:** Informationstæt. Kompakte kort, tabeller, formularer.
- **Tech:** SPA-lignende — én `office/index.html` loader views dynamisk. URL-routing via hash eller history API, så deep links virker (f.eks. direkte link til Bon #3421).

### Sidebar-struktur

> **Status: Besluttet · Marts 2026**

```
OFFICE SIDEBAR
│
├── Dashboard                    ← daglig briefing, alerts, serviceopkald-påmindelse
│
├── Bons                         ← listview + kalender (views deles med kitchen)
│
├── CRM
│   ├── Pipeline                 ← kanban på forespørgsler og tilbud
│   ├── Kunder                   ← liste, 360°-profil, sovende
│   ├── Serviceopkald            ← mandagsliste, callbacks, svære-at-nå
│   └── Aktiviteter              ← mine opgaver i dag
│
├── Tilbud                       ← wizard (5 trin), PDF, gem/send, konvertér til bon
│
├── Planlægning / Logistik       ← ruter, leveringer, tracking, bud-QR (senere)
│
├── Køkken                       ← opskrifter + lagerstatus (read-access fra office)
│
├── Indkøb                       ← leverandørpriser, aftaler, Hørkram-mapping
│
├── Vagtplan                     ← Smartplan embed
│
├── Fakturering                  ← e-conomic integration, EAN-håndtering
│
├── Rapporter
│
├── 📋 Whiteboard                ← sidekick-panel ELLER fuld side; link til SOP herfra
│
└── ⚙ Settings                  ← installations-konfiguration (eget shell)
```

**Principper:**
- Max to niveauer i sidebar
- Primære punkter afspejler arbejdsprocesser, ikke systemets interne struktur
- Serviceopkald bor under CRM men vises også fremtrædende på dashboard
- Salg som separat sektion tilføjes kun ved ansættelse af sælger
- Modul-opdeling i sidebar udskydes — alle moduler er aktive for Ristet Rug; relevant når systemet sælges til andre
- Whiteboard er kommunikationsplatform for alle — tilgængelig som sidekick overalt og som fuld side i office

### Logistik i Office
Logistik-planlægning er et punkt i office-sidebaren med:
- Rute-overblik og tidsplanlægning
- Leveringsstatus og tracking
- Bud-tildeling
- Link/QR til bud-browser-app (add-on, implementeres senere)

---

## 5. LOGISTIK-ZONEN

Logistik er ikke en separat shell — det er et view der deles mellem kitchen og office med tilpasset layout:

| Kontekst | Indgang | Layout |
|----------|---------|--------|
| Kitchen | Topbar → Planlægning | Touch-venlig, dagens leveringer |
| Office | Sidebar → Planlægning/Logistik | Fuld planlægningsvisning, redigering |

### Bud-app (add-on — implementeres senere)
- Browser-baseret, mobiloptimeret (PWA-kandidat)
- Eget login med rolle `bud`
- Adgang via QR-kode i logistik-view eller whiteboard
- Indhold: Mine leveringer i dag, aktiv levering, kvittering/aflevering, rapporter problem
- Implementeres som add-on til logistik-modulet

---

## 6. SETTINGS-ZONEN

Settings er et selvstændigt kontrolpanel — ikke en del af office-sidebaren, men tilgængeligt via et ikon/link øverst eller nederst i sidebaren.

### Struktur

```
SETTINGS
├── Firma & Installation
│   ├── Firmanavn, CVR, adresse, telefon
│   ├── Logo og brand-farver (CSS-theming)
│   └── Lokationer (HQ, trailer, etc.)
├── Moduler
│   ├── Kitchen ✅/❌
│   ├── CRM ✅/❌
│   ├── Logistik ✅/❌
│   ├── Indkøb/Grocy ✅/❌
│   └── Bud-app ✅/❌
├── Brugere & Roller
│   ├── Brugeradministration
│   └── Rolle-definitioner
├── Bon-konfiguration
│   ├── Statusser og flow
│   ├── Ordretyper
│   ├── Bonnummer-præfiks og tæller
│   └── Bestillingsfrister
├── Leveringstyper
│   ├── Cykel (Byekspressen)
│   ├── Taxa
│   └── Eget køretøj
├── Integrationer
│   ├── Grocy (URL, API-nøgle, lokation)
│   ├── Smartplan
│   ├── e-conomic
│   └── Mail (IMAP/SMTP)
├── Mail-konfiguration
│   ├── bon@... (ordremail)
│   └── kontakt@... (CRM/generel)
└── System
    ├── Backup og eksport
    ├── Changelog / versionshistorik
    └── Udvikler-info
```

> `system_settings`-tabellen er allerede designet og klar. Settings-UI implementeres men modul-flags ignoreres i første omgang — Ristet Rug har alle moduler aktiveret som standard.

---

## 7. SELVSTÆNDIGE SYSTEMER

Disse kører på egne servere og integreres via sidekick eller embed — de er ikke del af Bon v2-kodebasen.

| System | Server | Kobling til Bon v2 |
|--------|--------|---------------------|
| **Whiteboard** | `whiteboard.ristetrug.dk` | Sidekick overlay (iframe, tre-trins) i alle zoner |
| **SOP** | `sop.ristetrug.dk` | Links fra whiteboard, settings-links |
| **Smartplan** | Ekstern (proxy port 8080) | Embed i office → Vagtplan, data til ugeoversigt |

### Whiteboard ↔ SOP kobling
SOP og whiteboard har et eksisterende link-system (SOP deep links). Det videreføres uændret. Bon v2 berører ikke disse systemer direkte.

---

## 8. FILSTRUKTUR

```
bon-v2/                          ← rod (ny server, adskilt fra bon v1)
│
├── shared/                      ← FÆLLES FOR ALLE ZONER
│   ├── tokens.css               ← CSS-variabler (farver, spacing, typografi)
│   ├── components.css           ← Genanvendelige UI-komponenter
│   ├── kitchen-topbar.html      ← Topbar-komponent (inkluderes i kitchen-views)
│   ├── sidekick.js              ← Whiteboard sidekick (tilgængelig overalt)
│   ├── api.js                   ← Alle kald til Bon v2 backend
│   └── utils.js                 ← Datoformatering, tal, hjælpefunktioner
│
├── kitchen/                     ← KITCHEN-ZONE
│   ├── index.html               ← Dashboard
│   ├── today.html               ← Køkken I Dag (bon-kort, kiosk)
│   ├── later.html               ← Køkken Senere
│   ├── planning.html            ← Produktionsplanlægning
│   ├── recipes.html             ← Opskrifter (fra Grocy)
│   ├── stock.html               ← Lagerstatus / lagercheck
│   ├── purchasing.html          ← Indkøbsliste / bestillinger ud
│   ├── orders.html              ← Bestillingsoversigt
│   └── goods-receipt.html       ← Varemodtagelse
│
├── office/                      ← OFFICE-ZONE
│   ├── index.html               ← Shell (sidebar + content)
│   └── views/                   ← Dynamisk loadede views
│       ├── dashboard.js
│       ├── bons-list.js         ← Listview, søg, opret
│       ├── bons-calendar.js     ← Kalender og ugeoversigt
│       ├── bon-detail.js        ← Enkelt bon (edit, historik, mail)
│       ├── crm.js               ← Kunder, aktiviteter, pipeline
│       ├── tilbud.js             ← Tilbudswizard + liste (separat sidebar-punkt)
│       ├── mail.js              ← Mailtråde og indbakke
│       ├── logistics.js         ← Logistik og ruteplanlægning
│       ├── purchasing.js        ← Leverandørpriser, aftaler, Hørkram
│       ├── schedule.js          ← Vagtplan (Smartplan embed)
│       ├── invoicing.js         ← Fakturering / e-conomic
│       ├── reports.js           ← Rapporter og statistik
│       └── admin.js             ← Brugere, roller, system
│
├── settings/                    ← SETTINGS-ZONE
│   └── index.html               ← Kontrolpanel (eget shell)
│
├── assets/                      ← Statiske filer
│   ├── logo.svg
│   ├── icons/
│   └── fonts/
│
├── server.js                    ← Node.js/Express backend
├── BonConfig.js                 ← Installations-konfiguration
├── BonConfigBar.js              ← (eksisterende)
├── package.json
└── .env                         ← API-nøgler, hemmeligheder (ikke i git)
```

> **`tools/`-mappen** fra Bontool beholdes som reference/testbed på udviklingsmaskinen. Fungerende komponenter migreres ind i ovenstående struktur én ad gangen.

---

## 9. DESIGNSYSTEM

### tokens.css — ét sted, alt arver herfra

Alle farver, spacing og typografi defineres som CSS-custom properties i `shared/tokens.css`. Alle andre CSS-filer bruger udelukkende tokens — ingen hardcodede farver.

```css
:root {
  /* Brand (overskrives pr. installation via settings) */
  --brand-primary:     #8e631f;   /* Ristet Rug brun */
  --brand-primary-light: #f1e6b2; /* Gul/creme */
  --brand-name:        "Ristet Rug";

  /* Faste systemfarver */
  --color-surface:     #ffffff;
  --color-background:  #f5f4f2;
  --color-border:      #d7d1ca;
  --color-text:        #333333;
  --color-text-dim:    #8a8580;

  /* Statusfarver */
  --color-green:       #a5bf75;
  --color-green-dark:  #7a9c54;
  --color-red:         #bc181b;
  --color-blue:        #7594b3;
  --color-orange:      #e8a832;

  /* Spacing */
  --space-xs:   4px;
  --space-s:    8px;
  --space-m:   16px;
  --space-l:   24px;
  --space-xl:  40px;

  /* Typografi */
  --font-body:    'Lato', sans-serif;
  --font-size-s:  13px;
  --font-size-m:  15px;
  --font-size-l:  18px;
  --font-size-xl: 24px;

  /* UI-densitet (touch vs. desktop) */
  --touch-target-min: 44px;   /* Kitchen: min klikflade */
  --touch-target-desk: 32px;  /* Office: kan være smallere */
}
```

### White-label theming
Når en ny installation sættes op, overskrives brand-tokens fra `system_settings`:

```js
// Ved opstart: hent brand-farver fra settings og injicer i :root
document.documentElement.style.setProperty('--brand-primary', settings.brand_color_primary);
```

### UI-densitet: to modes
Kitchen og office bruger de samme komponenter men med forskellig densitet:

| | Kitchen (touch) | Office (desktop) |
|---|---|---|
| Knaphøjde | ≥ 44px | ≥ 32px |
| Skriftstørrelse | 15–18px | 13–15px |
| Padding i kort | 16–20px | 10–14px |
| Tabelrækker | store | kompakte |

Implementeret via CSS-klasse på body: `<body class="zone-kitchen">` eller `<body class="zone-office">`.

---

## 10. TEKNISKE BESLUTNINGER

| Beslutning | Valg | Begrundelse |
|------------|------|-------------|
| Kitchen tech | MPA (multi-page) | Enkelt, robust på tablet/kiosk, ingen framework-afhængighed |
| Office tech | SPA-lignende (dynamisk load) | Sammenhængende navigation, state bevares, deep links via URL |
| Styling | Vanilla CSS med tokens | Ingen build-step, nem vedligehold, white-label venlig |
| Framework | Vanilla JS + selectiv Vue.js | Eksisterende valg, videreføres |
| Backend | Node.js/Express + SQLite | Eksisterende valg, videreføres |
| Realtid | SSE (Server-Sent Events) | Køkken-displays, bon-statusopdateringer |
| Sidekick | iframe + postMessage | Whiteboard kører selvstændigt, ingen kobling til Bon-kode |

---

## 11. ÅBNE SPØRGSMÅL

| Spørgsmål | Status | Næste skridt |
|-----------|--------|--------------|
| Office sidebar-struktur og navigation | ✅ Besluttet | Se sektion 4 |
| Kitchen topbar: 8 punkter eller primær/sekundær? | ⚠️ Åben | Afklares i layout-mockup med faktisk skærmbredde |
| Logistik desktop-view: dag-timeline eller uge-kalender som primær? | ⚠️ Åben | Afklares ved design af logistik-view |
| Kalender og bonliste: delte views mellem kitchen og office | ✅ Besluttet | Placeres i `shared/views/`, importeres af begge shells |
| Modul-opdeling i sidebar | 🔜 Senere | Relevant når systemet sælges; ikke nu |
| Bud-app implementation | 🔜 Senere | Add-on til logistik, browser-baseret, QR-kode indgang |
| Salg som separat sidebar-sektion | 🔜 Hvis sælger ansættes | Tilføjes da |
| DAWA erstatning (adressevalidering, udgår april 2026) | ⚠️ Haster | Teknisk afklaring |

---

## 12. BESLUTNINGSLOG

| Dato | Beslutning |
|------|------------|
| Marts 2026 | Fire zoner defineret: Kitchen, Office, Logistik (delt), Settings |
| Marts 2026 | Roller: kok og køkkenansvarlig ser identisk inkl. logistik |
| Marts 2026 | Whiteboard sidekick med i v1 — tre-trins overlay, tilgængelig fra alle zoner |
| Marts 2026 | Whiteboard er kommunikationsplatform for alle — fuld side i office, sidekick overalt |
| Marts 2026 | Bud-app er add-on til logistik, browser-baseret, implementeres senere |
| Marts 2026 | Office-split (salg) kun ved ansættelse af sælger |
| Marts 2026 | Single-tenant: én SQLite pr. installation, `module_*` flags i settings nu men bruges ikke endnu |
| Marts 2026 | Modul-opdeling i sidebar udskydes — ikke relevant for Ristet Rug i v1 |
| Marts 2026 | MPA i kitchen, SPA-lignende i office |
| Marts 2026 | White-label theming via CSS-tokens genereret fra settings-tabel |
| Marts 2026 | Kalender og bonliste er delte views — placeres i shared/, bruges af både kitchen og office |
| Marts 2026 | Office sidebar fastlagt — se sektion 4 |
| April 2026 | Tilbud er et selvstændigt sidebar-punkt — efter CRM, før Fakturering (wizard-flow passer ikke som CRM-underside) |
| Marts 2026 | Serviceopkald bor under CRM men vises fremtrædende på office-dashboard |
| Marts 2026 | Køkken-views (opskrifter, lager) tilgængelige read-only fra office-sidebar |
