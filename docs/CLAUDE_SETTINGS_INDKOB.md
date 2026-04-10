# CLAUDE_SETTINGS_INDKOB.md
> Spec for indkøbsindstillinger — slide-in panel (kitchen) + fuld side (office)
> Mockup: `docs/settings_mockup.html`
> Læs `BON_V2_PRINCIPPER.md` og `docs/CLAUDE_INDKOB.md` FØR du begynder.

---

## Formål og kontekst

Indkøbsmodulet kræver konfiguration på tre niveauer:
1. **Leverandører** — hvem køber vi fra, hvordan kontaktes de, hvilke Grocy-lokationer tilhører dem
2. **Produkter** — batch-redigering af Grocy-felter der er kritiske for indkøb (leverandør, min-stock)
3. **Hørkram** — initial kobling af varer, prisvedligehold, favoritlister

Settings er tilgængeligt to steder:
- **Kitchen**: slide-in panel via ⚙ i indkøbs-toolbar (diskret, forstyrrer ikke)
- **Office**: fuld side i sidebar under Settings → Indkøb

Begge steder bruger **samme komponenter** — kun mounting er forskellig.

---

## Arkitektur

### Filer
```
shared/indkob_settings.js     ← NY — fælles settings-komponent (kitchen + office)
shared/indkob_settings.css    ← NY
kitchen/purchasing.html       ← Tilføj ⚙ knap + slide-in container
office/views/settings.js      ← Tilføj "Indkøb" sektion der mounter indkob_settings.js
```

### Mounting pattern
```javascript
// Kitchen — slide-in panel
initIndkobSettings(document.getElementById('settingsPanel'), { mode: 'panel' });

// Office — fuld side
initIndkobSettings(document.getElementById('settingsPage'), { mode: 'page' });
```

`mode: 'panel'` giver kompakt layout med scroll inden i panelet.
`mode: 'page'` giver fuld bredde, sticky header, mere luft.

### State-prefix
`_is` (indkob settings) — fx `_isSuppliers`, `_isGrocyLocs`, `_isProducts`

---

## Kitchen: ⚙ knap og slide-in

### Placering
Yderst til højre i indkøbs-toolbaren, efter Liste/Fokus-toggle:
```
[Søg...]  [+ Tilføj]  [📉 3]  [⏰ 2]  |  [≡ ⊡]  [⚙]
```

### HTML i purchasing.html
```html
<!-- Tilføj i toolbar-right -->
<button class="ib-gear-btn" id="ibGearBtn" 
        onclick="toggleIndkobSettings()" 
        title="Indkøbsindstillinger">⚙</button>

<!-- Tilføj før </body> -->
<div class="ib-settings-overlay" id="ibOverlay" onclick="toggleIndkobSettings()"></div>
<div class="ib-settings-panel" id="ibSettingsPanel"></div>
```

### JS i purchasing.html
```javascript
var _ibSettingsOpen = false;
var _ibSettingsInitialized = false;

function toggleIndkobSettings() {
    _ibSettingsOpen = !_ibSettingsOpen;
    document.getElementById('ibSettingsPanel').classList.toggle('on', _ibSettingsOpen);
    document.getElementById('ibOverlay').classList.toggle('on', _ibSettingsOpen);
    document.getElementById('ibGearBtn').classList.toggle('active', _ibSettingsOpen);

    // Lazy init — mount komponent første gang
    if (_ibSettingsOpen && !_ibSettingsInitialized) {
        initIndkobSettings(document.getElementById('ibSettingsPanel'), { mode: 'panel' });
        _ibSettingsInitialized = true;
    }
}

// Escape lukker panel
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _ibSettingsOpen) toggleIndkobSettings();
});
```

### CSS mål (indkob_settings.css)
```css
.ib-settings-panel {
    position: fixed;
    top: 0; right: 0;
    height: 100vh;
    width: 880px;
    max-width: 95vw;
    background: var(--color-surface);
    z-index: 201;
    box-shadow: -4px 0 32px rgba(0,0,0,.15);
    transform: translateX(100%);
    transition: transform .28s cubic-bezier(.32,.72,0,1);
    display: flex;
    flex-direction: column;
}
.ib-settings-panel.on { transform: translateX(0); }

.ib-settings-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,.25);
    z-index: 200;
    opacity: 0; pointer-events: none;
    transition: opacity .25s;
}
.ib-settings-overlay.on { opacity: 1; pointer-events: all; }

.ib-gear-btn {
    width: 32px; height: 32px;
    border-radius: 8px;
    border: 1.5px solid var(--color-border);
    background: var(--color-surface);
    cursor: pointer;
    font-size: 15px;
    transition: all .15s;
}
.ib-gear-btn:hover { border-color: var(--brand-primary); }
.ib-gear-btn.active { background: var(--brand-primary); color: #fff; border-color: var(--brand-primary); }
```

---

## Panel-struktur (delt mellem kitchen + office)

```
┌─ Panel header ──────────────────────────────────── [✕] ─┐
│  ⚙  Indkøbsindstillinger                                 │
├─ Tabs ───────────────────────────────────────────────────┤
│  [ Leverandører ]  [ Produkter ]  [ Hørkram ]            │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  (tab-indhold)                                           │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Header og tabs er sticky — kun tab-body scroller.

---

## Tab 1 — Leverandører

### Datakilde
`GET /api/purchasing/suppliers` — returnerer alle aktive leverandører med Grocy-locations.

### Leverandørtabel

Kolonner: Navn/Note · Type · Kontakt · Grocy-lokationer · Handlinger

```
┌────────────────┬────────┬──────────────────┬───────────────────┬────┐
│ Navn           │ Type   │ Kontakt          │ Grocy-lokationer  │    │
├────────────────┼────────┼──────────────────┼───────────────────┼────┤
│ Hørkram        │ [api]  │ ordre@hoka.dk    │ [2] [5] [9]       │ ✏ ✕│
│ hoka.dk        │        │ 44 33 22 11      │                   │    │
├────────────────┼────────┼──────────────────┼───────────────────┼────┤
│ Inco           │[websh] │ bestil@inco.dk   │ [3 Inco]          │ ✏ ✕│
│ inco.dk        │        │                  │                   │    │
├────────────────┼────────┼──────────────────┼───────────────────┼────┤
│ Serviwet       │[manual]│ 40 12 34 56      │ [!ikke koblet]    │ ✏ ✕│
│ Leverer tirsd. │        │ Vivil Hansen     │                   │    │
└────────────────┴────────┴──────────────────┴───────────────────┴────┘
[+ Tilføj leverandør]
```

**Type-badges** farves efter integration_type:
- `api` → grøn
- `email` → blå
- `manual` → grå
- `webshop` → orange
- `intern` → lilla

**Grocy-lokation chips** er klikbare — klik åbner kobling-sektionen scrollet til den lokation.

**Slet-knap** — soft delete (`is_active = 0`). Hvis leverandøren har aktive koblinger: vis advarsel "3 Grocy-lokationer og 12 produkter er koblet — deaktiver alligevel?"

### Inline redigering

Klik ✏ åbner en inline form under rækken (ikke modal):

```
┌─ Rediger Hørkram ────────────────────────────────────────┐
│ Navn:          [Hørkram                    ]             │
│ Integration:   [api ▼]                                   │
│ Kontakt email: [ordre@hoka.dk              ]             │
│ Kontakt tlf:   [44 33 22 11               ]             │
│ Webshop URL:   [https://www.hoka.dk/...   ]             │
│ Noter:         [hoka.dk · API-integration  ]             │
│ Aktiv:         [✓]                                       │
│                              [Gem]  [Annuller]           │
└──────────────────────────────────────────────────────────┘
```

**API-endpoint:** `PATCH /api/purchasing/suppliers/{id}`

### Grocy-location kobling

Under leverandørtabellen, separeret med en sektion-header:

```
Grocy-lokationer — kobling til leverandør
─────────────────────────────────────────
Ukoblede lokationer vises som "type: none" i indkøb

1 · Madsynergi          [Ikke koblet]   [— Vælg leverandør —  ▼]
2 · Hørkram             [✓ Hørkram]     [Hørkram               ▼]
3 · Inco                [✓ Inco]        [Inco                  ▼]
4 · Dagligvare          [Ikke koblet]   [— Vælg leverandør —  ▼]
5 · Drikkevarer         [✓ Hørkram]     [Hørkram               ▼]
6 · RR Produktion       [✓ RR Prod.]    [RR Produktion         ▼]
7 · Emballage           [Ikke koblet]   [— Vælg leverandør —  ▼]
```

Ændring af dropdown → øjeblikkelig POST/DELETE til `/api/purchasing/suppliers/grocy-locations`.
Ingen "Gem"-knap — auto-save med loading-indikator.

**Display-navn:** Hvis en leverandør har flere Grocy-lokationer kan man sætte et display-navn pr. kobling (fx "Hørkram · Drikkevarer"). Vises som undertekst i chip.

---

## Tab 2 — Produkter

### Formål
Batch-redigering af Grocy-produktfelter der er kritiske for indkøb.
Grocy's eget UI er klodset til dette — her er det hurtigt og overskueligt.

### Kolonne-vælger

Øverst i tabben — chips der toggles til/fra:

```
Vis kolonner:
[● Leverandør] [● Minimumsgrænse] [● Enhed] [○ Produktgruppe] [○ Pris/kg] [○ Sidst opdateret]
```

- Grøn/fyldt chip = aktiv kolonne
- Tom chip = skjult kolonne
- Minimum: Produktnavn er altid vist
- Præferencer gemmes i `localStorage` med nøgle `ib_settings_product_cols`

### Filter-bar

Under kolonne-vælgeren:
```
[Søg produkt...]  [Alle leverandører ▼]  [Alle grupper ▼]  [3 ændringer]  [Gem i Grocy]
```

- Søg: live filter på produktnavn
- Leverandør-filter: viser kun produkter med den `shopping_location_id`
- "Ingen leverandør": produkter uden `shopping_location_id`
- "3 ændringer": vises kun når der er unsaved changes (orange tekst)

### Produkt-tabel

```
Produkt              │ Leverandør          │ Min. grænse │ Enhed  │
─────────────────────┼─────────────────────┼─────────────┼────────┼
● Smør, usaltet Lurpak│ [Hørkram         ▼] │ [5        ] │ kg     │
  Mejeriprodukter    │                     │             │        │
─────────────────────┼─────────────────────┼─────────────┼────────┼
● Fløde 38% Arla     │ [Hørkram         ▼] │ [10       ] │ liter  │
  Mejeriprodukter    │                     │             │        │
─────────────────────┴─────────────────────┴─────────────┴────────┴
```

- Orange dot (●) og gul rækkefarve = ændret, ikke gemt endnu
- Leverandør = dropdown med alle Grocy shopping_locations (ikke V2 suppliers)
- Min. grænse = `number` input
- Enhed = read-only (vises til reference — ændres i Grocy)

### Ændringer og bulk-gem

**Sticky bulk-bar** i bunden (vises kun når der er ændringer):
```
3 ændringer venter                [Fortryd alle]  [Gem i Grocy]
```

"Gem i Grocy" → PUT til `/api/grocy/objects/products/{id}` for hvert ændret produkt.
Kald afsendes parallelt (Promise.all), men med max 5 samtidige for at undgå Grocy rate limit.

Progressbar vises: "Gemmer 3/5..."

Fejl-håndtering: Hvis et enkelt produkt fejler, fortsætter resten. Fejlede produkter vises med rød markering bagefter.

### API-kald
```javascript
// For hvert ændret produkt:
PUT /api/grocy/objects/products/{id}
Body: { shopping_location_id: N, min_stock_amount: N }

// For barcode userfields (is_preferred):
PUT /api/grocy/userfields/product_barcodes/{barcode_id}
Body: { is_preferred: '1' }  // eller '' for at fjerne
```

---

## Tab 3 — Hørkram

### Status-linje
```
● Proxy OK · Logget ind · Session udløber om 24 min    [Sidst synkroniseret: i dag 08:32]
```

Henter fra `GET /api/horkram/health`. Opdateres ved tab-åbning.

### Pris-opdaterings-bar
```
203 produkter med Hørkram-barcodes · 187 har aktuel pris
[⏱ Planlæg daglig]  [↻ Opdater priser nu]
```

"Opdater priser nu" → batch-snapshot på alle HK-barcodes → opdater `last_price` i Grocy.
Progress: "Opdaterer 50/203..." med progressbar.
Resultat: "✓ 198 opdateret · 5 sprunget over (ingen pris) · 0 fejl"

"Planlæg daglig" → gem `hk_price_update_schedule` i `system_settings` (fx "06:00").
Server-side cron implementeres i `services/schedulerService.js` (fremtidig fase).

### Under-tabs: Opslag · Favoritter · Ny kobling · Alle koblinger

#### Opslag
```
[Varenr. eller søg produktnavn...] [Søg]

┌─ Resultat ─────────────────────────────────────────────┐
│ [📷] Smør, usaltet Lurpak 500g×20                       │
│      Varenr. 245801 · Arla · Mejeriprodukter           │
│      ★ Aftale · 🇩🇰 DK                                  │
│      89 kr · 8,9 kr/kg                                  │
│                                                         │
│ [Kobl til Grocy-produkt] [Opdater pris] [Sæt enhed-kode]│
└─────────────────────────────────────────────────────────┘
```

"Kobl til Grocy-produkt" → åbner Grocy-produktsøgning (autocomplete) → ved valg:
1. Opret barcode i Grocy (POST /api/grocy/product-barcodes)
2. Sæt `supplier_unit_code` + `supplier_unit_qty` fra Hokas salesUnits
3. Sæt `is_agreement_item` hvis relevant

"Sæt enhed-kode" → dropdown med Hokas salesUnits for produktet → gem på barcode userfields.

Input: varenummer (numerisk) ELLER fritekst-søgning (kalder `/api/horkram/search?q=`).
Smart lookup: hvis input er numerisk → direkte produkt-opslag, ellers søgning.

#### Favoritter
```
📋 Standardvarer          Auto-genereret · 156 produkter  [142 i Grocy]  [Importer priser]
⭐ Aftalevarer            Brugerdefineret · 48 produkter   [44 i Grocy]   [Importer priser]
🥛 Mejeriprodukter        Brugerdefineret · 32 produkter   [!12 mangler]  [Kobl ukoblede]
🥦 Grøntsager og frugt    Brugerdefineret · 28 produkter   [28 i Grocy]   [Importer priser]
```

Lister hentes fra `GET /api/horkram/favorites` ved tab-åbning.
Koblet-count beregnes ved at matche favorit-produkternes varenumre mod eksisterende Grocy-barcodes.

"Importer priser" (for én liste) → hent alle produkter via `/api/horkram/favorites/{id}/all` → batch-opdater `last_price` på matchede barcodes.

"Kobl ukoblede" → skifter til "Ny kobling"-tabben, pre-filtreret på produkter der matcher listens varenumre.

#### Ny kobling
Viser Grocy-produkter der mangler HK-barcode. Sorteret efter produktgruppe.

```
[Søg produkt...]  [Alle grupper ▼]
8 produkter uden Hørkram-barcode

🧴 Rapsfrøolie, neutral    Fedtstoffer     [Søg og kobl →]
🌿 Timian, frisk           Urter           [Søg og kobl →]
🍋 Citroner, ubehandlede   Frugt           [Søg og kobl →]
```

"Søg og kobl →":
1. Auto-søger i Hoka med produktets navn
2. Viser resultater inline under rækken med confidence-score
3. Bruger vælger match → barcode oprettes

Confidence-scoring:
- Høj: navne-match > 85% + samme enhed
- Medium: navne-match 60-85%
- Lav: kun delvist match

#### Alle koblinger
Tabel over alle eksisterende HK-barcodes. Konfigurerbar — samme kolonne-vælger-pattern som Produkter-tabben.

Standard kolonner: Grocy-produkt · Varenr. · Pakkeform · Enhed-kode · Pris/kg · Foretrukket

```
[Søg...]  [Alle lokationer ▼]           [Gem ændringer]

Grocy-produkt          │ Varenr.  │ Pakkeform   │ Enhed  │ Kr/kg │ Foretr. │
───────────────────────┼──────────┼─────────────┼────────┼───────┼─────────┼
Smør, usaltet Lurpak   │ 245801   │ [500g×20  ] │ [ks ▼] │ [8.9] │  [●]    │ ✏
Fløde 38% Arla         │ 118342   │ [1 liter  ] │ [st ▼] │ [18 ] │  [●]    │ ✏
```

Inline redigering: Pakkeform (tekst), Enhed-kode (select), Pris/kg (number), Foretrukket (toggle).
Gem → PUT til `/api/grocy/userfields/product_barcodes/{id}`.

---

## Office Settings — fuld side

I `office/views/settings.js` tilføjes en "Indkøb" sektion i sidebaren:

```
Settings
├── Generelt
├── Brugere
├── Indkøb        ← NY
│   └── (mounter indkob_settings.js i page-mode)
├── Tilbud
└── Integrationer
```

Forskelle i `mode: 'page'`:
- Ingen slide-in animation — indholdet monteres direkte i view-containeren
- Bredere layout (op til 1100px i stedet for 880px)
- Tabs vises som en mere fremtrædende navigation

---

## Ny migration: 032_suppliers_intern.sql

```sql
-- Migration 032: Tilføj 'intern' som integration_type på suppliers
-- SQLite understøtter ikke ALTER TABLE ... MODIFY COLUMN CHECK
-- Bruger temp-table copy pattern

CREATE TABLE suppliers_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    integration_type TEXT    NOT NULL DEFAULT 'manual'
                     CHECK (integration_type IN ('api','email','manual','webshop','intern')),
    contact_email    TEXT,
    contact_phone    TEXT,
    webshop_url      TEXT,
    notes            TEXT,
    is_active        INTEGER NOT NULL DEFAULT 1
);

INSERT INTO suppliers_new SELECT * FROM suppliers;
DROP TABLE suppliers;
ALTER TABLE suppliers_new RENAME TO suppliers;

-- Seed: RR Produktion som intern leverandør (hvis ikke allerede der)
INSERT OR IGNORE INTO suppliers (name, integration_type, notes, is_active)
VALUES ('RR Produktion', 'intern', 'Intern produktion — opskrifter i Grocy', 1);
```

---

## API-endpoints der mangler (skal tilføjes til routes/purchasing.js)

Nuværende purchasing.js har kun grocy-location endpoints. Mangler:

```javascript
// CRUD for suppliers (mangler pt.)
GET    /api/purchasing/suppliers/:id          // Enkelt leverandør
POST   /api/purchasing/suppliers              // Opret ny
PATCH  /api/purchasing/suppliers/:id          // Opdater
DELETE /api/purchasing/suppliers/:id          // Deaktiver (is_active = 0)
```

---

## Init-flow for indkob_settings.js

```javascript
async function initIndkobSettings(containerEl, options) {
    _isContainer  = containerEl;
    _isMode       = options.mode || 'panel'; // 'panel' | 'page'
    _isActiveTab  = 0;

    _isRenderShell();   // Header + tabs + tab-body container

    // Load data parallelt
    await Promise.all([
        _isLoadSuppliers(),    // GET /api/purchasing/suppliers
        _isLoadGrocyLocs(),    // GET /api/grocy/shopping-locations
        _isLoadHokaHealth(),   // GET /api/horkram/health
    ]);

    _isRenderTab(0);   // Vis Leverandører-tab som default
}
```

Tab-skift er lazy — data for Produkter og Hørkram hentes kun første gang den tab åbnes.

---

## Settings-afhængigheder der skal eksistere FØR settings virker

| Afhængighed | Kilde | Status |
|------------|-------|--------|
| `routes/purchasing.js` CRUD endpoints | Ny kode | ☐ Mangler |
| Migration 032 (`intern` type) | Ny migration | ☐ Mangler |
| `PUT /api/grocy/objects/products/{id}` | routes/grocy.js | ✓ Eksisterer |
| `PUT /api/grocy/userfields/product_barcodes/{id}` | routes/grocy.js | ✓ Eksisterer |
| `POST /api/grocy/product-barcodes` | routes/grocy.js | ✓ Eksisterer |
| `GET /api/horkram/favorites` | routes/horkram.js | ✓ Eksisterer |
| `GET /api/horkram/snapshots` | routes/horkram.js | ✓ Eksisterer |

---

## Checkliste til CLAUDE.md

```
Fase 6c — Settings (shared/indkob_settings.js):
- [ ] Migration 032_suppliers_intern.sql
- [ ] routes/purchasing.js — CRUD endpoints (GET/:id, POST, PATCH, DELETE)
- [ ] shared/indkob_settings.js + indkob_settings.css
- [ ] kitchen/purchasing.html — ⚙ knap + slide-in container
- [ ] office/views/settings.js — "Indkøb" sektion tilføjet
- [ ] Tab 1: Leverandører CRUD + Grocy-location kobling
- [ ] Tab 2: Produkter batch-editor (konfigurerbar tabel)
- [ ] Tab 3: Hørkram (opslag, favoritter, ny kobling, alle koblinger, prisopdatering)
```
