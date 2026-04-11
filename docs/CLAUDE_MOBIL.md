# Bon v2 — Mobil Shell (Fase 1)
*Oprettet: april 2026*

---

## Formål

En dedikeret mobilvenlig shell til brug på farten — primært telefon.
Dækker de use cases der opstår uden for kontoret: tjekke ordrestatus, se bon-detaljer, flytte statusser, varemodtagelse og få overblik over dagens travlhed og bemanding.

**Ikke** en responsiv udgave af office eller kitchen. En selvstændig, slank shell.

---

## URL og placering

| | |
|---|---|
| **URL** | `/m/` |
| **Shell-fil** | `mobile/index.html` |
| **Login** | `mobile/login.html` (touch-venlig PIN) |
| **Zone-klasse** | `<body class="zone-mobile">` |
| **CSS-densitet** | Touch-first (samme tokens som kitchen, `--touch-target-min: 44px`) |
| **Viewport** | `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` |

### PWA

Mobilshellet inkluderer et `manifest.json` med `display: standalone` for app-lignende oplevelse (ingen browser-chrome, add-to-homescreen). Ingen service worker eller push-notifikationer i fase 1.

```json
{
  "name": "Bon v2",
  "short_name": "Bon",
  "start_url": "/m/",
  "display": "standalone",
  "background_color": "#f5f4f2",
  "theme_color": "#8e631f"
}
```

---

## Auto-detect og redirect

Systemet skal automatisk tilbyde mobilvisningen — men aldrig tvinge.

**Logik i `shared/login.html`:**
```js
// Ved login-siden: detect mobil
if (window.innerWidth < 640 && 'ontouchstart' in window) {
  // Vis banner: "Åbn mobilvisning?" med knap → /m/
  // Bruger kan afvise — valget huskes i localStorage
}
```

**Logik i `mobile/login.html`:**
```js
// Omvendt: hvis desktop, vis link til fuld version
if (window.innerWidth >= 1024) {
  showBanner('Du er på en stor skærm — vil du åbne fuld version?');
}
```

Ingen automatisk redirect — kun forslag. Brugeren bestemmer.

---

## Login — PIN-pad

### Fil: `mobile/login.html`

Touch-venlig PIN-login. Brugeren vælger sit navn fra en liste, taster PIN.

### Flow
1. Hent aktive brugere: `GET /api/goods-receipts/users` → vis navne som store knapper
   *(Eksisterende endpoint — returnerer `[{ id, name }]` for aktive brugere)*
2. Bruger tapper sit navn
3. PIN-pad vises (store cifre, `>= 72px` per knap)
4. `POST /api/auth/pin` → `{ user_id, pin }` → session oprettes
5. Redirect til `/m/`

**Backend-ændring nødvendig:** Det eksisterende `POST /api/auth/pin` endpoint (routes/auth.js:33) accepterer kun `{ pin }` og matcher på PIN alene (`WHERE pin = ?`). Mobilshellet sender `{ user_id, pin }` fordi brugeren vælger sit navn først. Endpointet skal udvides:
```js
// Nuværende: WHERE pin = ? AND is_active = 1
// Nyt:       WHERE id = ? AND pin = ? AND is_active = 1
// Bagudkompatibelt: hvis user_id er udeladt, fald tilbage til kun-PIN match
```
Dette forhindrer kollision hvis to brugere har samme PIN.

### Fejlhåndtering
- Forkert PIN: ryst animation + "Forkert PIN, prøv igen"
- 3 fejl: 30 sekunders lockout (vises som nedtælling)
  - **Backend:** In-memory Map per `user_id` med counter + timestamp. Reset ved success. Ingen migration nødvendig.
- Ingen PIN sat på bruger: vis "Log ind med adgangskode" → redirect til `shared/login.html`

### Auth-redirect
Mobilshellet bruger `checkAuth()` fra `shared/utils.js`. Redirect-URL overrides til `/m/login.html`:
```js
var user = await checkAuth('/m/login.html');
```

### Settings-konfiguration
Nyt settings-nøgle:

| Nøgle | Default | Beskrivelse |
|-------|---------|-------------|
| `mobile_pin_enabled` | `true` | Om PIN-login er aktivt |
| `mobile_pin_min_length` | `4` | Minimum PIN-længde |

PIN sættes per bruger i Settings → Brugere (eksisterende `users.pin` kolonne — allerede i schema).

---

## Shell-layout

Ingen sidebar. Ingen topbar med mange punkter. Bundnavigation med 5 ikoner.

```
┌─────────────────────────────────┐
│  🍞 Ristet Rug        [Leif ▾]  │  ← Slank header, brugernavn + logout
├─────────────────────────────────┤
│                                 │
│         CONTENT AREA            │
│                                 │
│                                 │
│                                 │
│                                 │
├─────────────────────────────────┤
│ 📋    📦    📞    📊    👤     │  ← Bottom navigation
│ Bons Modtag CRM Overblik Mig   │
└─────────────────────────────────┘
```

Bottom nav har 5 punkter:
- **Bons** — bonliste + detalje
- **Modtag** — varemodtagelse (shared/varemodtagelse.js)
- **CRM** — service calls + kundesøg
- **Overblik** — travlhed + Smartplan
- **Mig** — brugerinfo, skift til fuld version, log ud

### Offline-indikator
Vis en tydelig "Ingen forbindelse"-banner øverst når netværk er nede. Varemodtagelse og statusskift kræver netværk — brugeren skal vide det med det samme.

```js
window.addEventListener('online',  () => hideBanner());
window.addEventListener('offline', () => showBanner('Ingen forbindelse'));
```

---

## Views

### 1. Bonliste (`/m/` → standard view)

**API:** To parallelle kald (bons API understøtter kun én dato ad gangen):
```js
var [today, tomorrow] = await Promise.all([
    apiFetch('/api/bons?date=today&status=NY,VENTER,GODKENDT,IGANG,KLAR,LEVERET'),
    apiFetch('/api/bons?date=tomorrow&status=NY,VENTER,GODKENDT,IGANG,KLAR,LEVERET')
]);
```

**Layout:**
- To tabs: **I dag** / **I morgen**
- Hvert bon-kort viser: bonnummer, kundenavn, tidspunkt, status-badge, antal enheder
- Tap på kort → Bon-detalje
- Pull-to-refresh

**Sortering:** Tidspunkt stigende.

**Statusfarver:** Genbruger eksisterende CSS-variabler fra `tokens.css`.

---

### 2. Bon-detalje (`/m/bon/:id`)

**API:** `GET /api/bons/:id`

**Viser:**
- Bonnummer + status (stor badge)
- Kunde: navn, telefon (tappbar → ring op), adresse (tappbar → åbn Maps)
- Leveringstidspunkt + leveringstype
- Linjer: produktnavn + antal (read-only i fase 1)
- Køkkeninfo (read-only)
- Er levering bestilt? (ja/nej baseret på `delivery_events`) — Byekspressen-detaljer udskydes til Lobo-integration

**Statusskift:**
- Hent gyldige transitions: `GET /api/statuses/:code/transitions`
- Vis som store knapper nederst
- `PATCH /api/bons/:id/status` med brugerens `user_id` fra session
- Optimistisk UI: badge opdateres straks, fejl fortryder
- Haptic feedback: `navigator.vibrate(50)` ved statusskift

**Tilbage:** ← tilbage til bonliste (browser history)

---

### 3. Varemodtagelse (📦 Modtag)

**Genbruger `shared/varemodtagelse.js`** — eksisterende touch-first komponent (max 500px).

**Montering:**
```js
// I mobile/views/modtag.js
async function initModtag(container) {
    // shared/varemodtagelse.js er allerede loaded via <script>
    await initVaremodtagelse(container);
}
```

**Ingen ændringer i `shared/varemodtagelse.js` nødvendige.** Komponenten:
- Er allerede designet til touch (store knapper, toggles, stepper)
- Bruger `checkAuth()` internt — auth-redirect sættes via parameter eller global
- Henter brugere via `GET /api/goods-receipts/users` (staff + Smartplan merge)
- Henter leverandører fra Grocy shopping list
- Foto-upload via `<input type="file" capture="environment">` (kamera på mobil)
- Poster alt i ét kald: `POST /api/goods-receipts`

**Auth-håndtering:** `checkAuth()` i varemodtagelse.js (linje 76) redirecter til `/shared/login.html` som default. Mobilshellet løser dette ved at kalde `checkAuth('/m/login.html')` i `modtag.js` *inden* `initVaremodtagelse()`:
```js
async function initModtag(container) {
    var user = await checkAuth('/m/login.html');
    if (!user) return;
    // Når initVaremodtagelse kalder checkAuth() internt,
    // returnerer den den allerede-gyldige session — ingen redirect.
    await initVaremodtagelse(container);
}
```
Ingen ændringer i `shared/varemodtagelse.js` nødvendige.

**Vigtig bemærkning:** Varemodtagelse bruger data fra Grocy shopping list der ændrer sig løbende. Da SSE er udskudt i fase 1, vises en "Opdater data"-knap øverst i modtag-viewet. Alternativt: auto-refresh ved tab-switch (når bruger navigerer væk og tilbage).

**Deep-link:** `?open=modtag` åbner Modtag-tab direkte (bruges fra Whiteboard notifikationer).

---

### 4. CRM — Service calls

**API:** `GET /api/crm/service-calls` (eksisterende endpoint)

**Layout:**
- Liste over åbne service calls sorteret efter forfaldsdato
- Hvert kort viser: kundenavn, hvad det handler om, forfaldsdato
- Tap på telefonnummer → ring direkte (native `tel:` link)
- Tap på kort → detalje med fuld beskrivelse + handlinger

**Handlinger på et service call:**
- **Ring** — `tel:` link med kundens nummer
- **Marker udført** — åbner et enkelt tekstfelt: "Hvad skete der?" → `POST /api/crm/activity` med `{ customer_id, type: 'service_call', result: 'done', note: string }`
  *(Bruger eksisterende activity-endpoint — der er ingen PATCH /service-calls/:id)*
- Ingen opret-funktion på mobil

---

### 5. CRM — Kundesøg

Tilgængelig via søgeikon øverst i CRM-tab.

**API:** `GET /api/customers?q=` + `GET /api/customers/:id`

**Flow:**
1. Søgefelt (autofokus) → resultater vises løbende
2. Tap på kunde → kundekort

**Kundekort viser:**
- Navn, firma, telefon (tappbar → ring), email (tappbar → åbn mail-app)
- Seneste 5 bons: dato, status-badge, antal enheder — tap → bon-detalje
- **Log samtale:** kort fritekstfelt + kategori-vælger:
  - Klage / Feedback
  - Spørgsmål om bon
  - Prisforespørgsel
  - Andet
  → `POST /api/crm/activity` med `{ customer_id, type, note }`

**Ingen opret bon, ingen opret tilbud på mobil.**

---

### 6. Travlhedsoverblik

**API:** Tre parallelle kald (bons API understøtter kun én dato ad gangen):
```js
var todayISO    = new Date().toISOString().slice(0, 10);
var tomorrowISO = /* +1 dag */;
var day3ISO     = /* +2 dage */;
var [d1, d2, d3] = await Promise.all([
    apiFetch('/api/bons?date=today'),
    apiFetch(`/api/bons?date=${tomorrowISO}`),
    apiFetch(`/api/bons?date=${day3ISO}`)
]);
```

**Layout:**
- 3 kort i kolonne: I dag / I morgen / Overmorgen
- Hvert kort viser: dato, antal bons, antal enheder total, statusfordeling (mini-badges)
- Simpelt — ingen graf i fase 1

---

### 7. Smartplan-widget

**API:** Eksisterende Smartplan-adapter — `GET /api/smartplan/shifts?date=today`

**Layout:**
- Dagens dato som overskrift
- Liste: `[Fornavn]  [mødetidspunkt] – [sluttidspunkt]`
- Sorteret efter mødetidspunkt
- Ingen rediger-funktion
- API returnerer også efternavn og stillingstype — **vises ikke**

**Eksempel:**
```
I dag på arbejde
─────────────────
Karla       07:00 – 15:00
Simon       08:30 – 16:30
Nadia       10:00 – 18:00
```

---

## Filer der oprettes

```
mobile/
  index.html          ← Shell + bottom nav + view-router
  login.html          ← PIN-pad login
  manifest.json       ← PWA manifest (standalone, add-to-homescreen)
  views/
    bons.js           ← Bonliste (i dag / i morgen tabs)
    bon_detail.js     ← Bon-detalje + statusskift
    modtag.js         ← Varemodtagelse wrapper (kalder initVaremodtagelse)
    crm.js            ← Service calls liste + kundesøg + log samtale
    oversigt.js       ← Travlhed + Smartplan
    mig.js            ← Brugerinfo, log ud, skift til fuld version
  mobile.css          ← Mobilspecifik CSS (arver tokens.css)
```

**Shared-filer der indlæses (uændrede):**
```
shared/tokens.css               ← Design tokens
shared/components.css            ← Fælles styles
shared/utils.js                  ← connectSSE, checkAuth, mapApiBonToCardData
shared/api.js                    ← API-funktioner
shared/varemodtagelse.js         ← Varemodtagelse-komponent (monteres i modtag.js)
shared/varemodtagelse.css        ← Varemodtagelse styling
```

---

## API-endpoints der genbruges (ingen ændringer)

```
GET  /api/bons                          ← bonliste med filtre
GET  /api/bons/:id                      ← bon-detalje
PATCH /api/bons/:id/status              ← statusskift
GET  /api/statuses/:code/transitions    ← gyldige skift
GET  /api/crm/service-calls             ← åbne service calls
POST /api/crm/activity                  ← log aktivitet (service call, samtale)
GET  /api/customers                     ← kundesøg (?q=)
GET  /api/customers/:id                 ← kundekort med seneste bons
GET  /api/smartplan/shifts              ← vagter
GET  /api/goods-receipts/users          ← aktive brugere (PIN-login + varemodtagelse dropdown)
POST /api/goods-receipts/photo          ← foto-upload (varemodtagelse)
POST /api/goods-receipts                ← opret modtagelse (varemodtagelse)
POST /api/auth/pin                      ← PIN-login (eksisterer allerede)
```

---

## Backend-ændringer

### PIN-lockout (in-memory)

Tilføjes i `routes/auth.js` — ingen migration:

```js
const pinAttempts = new Map(); // user_id → { count, lockedUntil }
const MAX_ATTEMPTS = 3;
const LOCKOUT_MS = 30_000;

// I POST /api/auth/pin handler:
// 1. Check lockout: if (entry.lockedUntil > Date.now()) → 423 + lockout_seconds
// 2. Forkert PIN: entry.count++ → if >= MAX → sæt lockedUntil
// 3. Korrekt PIN: delete entry
```

### Settings-seed

Tilføjes i næste migration:

```sql
INSERT INTO settings (key, value, description) VALUES
  ('mobile_pin_enabled',    'true', 'Tillad PIN-login fra mobilshell'),
  ('mobile_pin_min_length', '4',    'Minimum antal cifre i PIN');
```

---

## Udskydes til senere faser

| Feature | Årsag |
|---------|-------|
| Byekspressen tracking | Lobo API-integration mangler |
| Rediger bon-linjer | VarePicker ikke touch-optimeret |
| Opret ny bon | Kræver touch-optimeret wizard |
| Push-notifikationer | Kræver PWA service worker |
| SSE realtid | Nice-to-have — pull-to-refresh + auto-refresh ved tab-switch dækker behovet i fase 1 |
| Varemodtagelse historik | `GET /api/goods-receipts` liste — tilføjes i fase 2 |

---

## Ikke-mål

- Gør ikke office eller kitchen responsive — de forbliver uændrede
- Mobilshellet har ikke adgang til settings, fakturering, tilbud, indkøb osv.
- Ingen ny databasetabel (PIN-kolonnen eksisterer allerede)
- `shared/varemodtagelse.js` ændres ikke — monteres som den er
