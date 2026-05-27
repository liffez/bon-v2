# CLAUDE_DELIVERY_POPOUT.md — Popout-vindue til bud-bestilling

> **Status:** Spec — klar til implementering (review-rettet maj 2026)
> **Erstatter:** `shared/manual_booking_modal.js` (afskaffes helt)
> **Bygger på:** `docs/delivery/CLAUDE_DELIVERY.md` Spor 1
> **Afhænger af:** Migration 057 (delivery_vehicles), `services/booking_template.js`, `routes/delivery.js`
>
> **Review-rettelser (maj 2026):**
> 1. SSE-pseudokode brugte `window.SSE.subscribe` der ikke findes → erstattet med faktisk `connectSSE(url, handlers)` fra `shared/utils.js`
> 2. Window-target ændret fra fast `rr-delivery-note` til `rr-delivery-note-${bonId}` så flere bookings kan håndteres parallelt
> 3. Adressevariabler verificeret: `delivery_address_street/postal/city` findes allerede i `buildContext` — ingen udvidelse nødvendig
> 4. `booking_fields_configured`-flag fjernet — frontend bruger `Array.isArray(payload.fields)` direkte (én sandhed)
> 5. `step`-property tilføjet til seed-data for By-expressen — felter grupperes per Lobo-wizard-trin i popout-listen

---

## Formål

Erstat den eksisterende overlay-modal (`shared/manual_booking_modal.js`) med et **separat popup-vindue** der kan placeres ved siden af leverandørens hjemmeside (taxa.nu / By-expressen Lobo). Vinduet viser bon-data som **klikbare felter** (klik = kopier til clipboard) i stedet for én samlet tekstblok.

**Hvorfor:** Lobo's 4-trins wizard kræver block-by-block paste. Den nuværende samlede tekstblok hjælper ikke når kontoret skal udfylde 12 separate felter på leverandørens side. Felt-for-felt visning løser begge use-cases (Lobo + taxa.nu).

---

## Det nye princip — felter er mini-templates

Hvert "felt" i popout-listen er en lille template med samme `{variabel}`-syntaks som den eksisterende `booking_template`. Det giver mulighed for **sammensatte felter**:

```json
[
  { "label": "Reference",      "template": "{bon_id} · {total_boxes} kasser · lev. {delivery_time}" },
  { "label": "Modtager + tlf", "template": "{delivery_contact_name}, {delivery_contact_phone}" }
]
```

Genbruger `renderTemplate()` direkte. Ingen ny syntaks.

---

## 1. Migration — `booking_fields_json` på `delivery_vehicles`

```sql
-- migrations/0XX_delivery_booking_fields.sql (næste ledige nr.)

ALTER TABLE delivery_vehicles ADD COLUMN booking_fields_json TEXT;

-- Seed: By-expressen (Lobo 4-trins wizard kræver granulære felter)
-- `step`-property grupperer felter visuelt i popout, så kontoret kan se
-- præcis hvilke felter der hører til hvilket Lobo-trin. Felter uden step
-- vises ugrupperet i bunden (eller udelades helt i Lobo-flow).
UPDATE delivery_vehicles
SET booking_fields_json = '[
  { "step": "Trin 2: Afhentning", "label": "Afhentningssted",  "template": "Ristet Rug, Prinsesse Charlottesgade 16, 2200" },
  { "step": "Trin 2: Afhentning", "label": "Klar kl.",         "template": "{pickup_time}" },
  { "step": "Trin 2: Afhentning", "label": "Senest",           "template": "{delivery_time}" },
  { "step": "Trin 2: Afhentning", "label": "Antal kolli",      "template": "{total_boxes}" },
  { "step": "Trin 2: Afhentning", "label": "Indhold",          "template": "Mad — {packaging_lines}" },
  { "step": "Trin 2: Afhentning", "label": "Reference",        "template": "{bon_id}" },
  { "step": "Trin 2: Afhentning", "label": "Afsender-kontakt", "template": "Køkken — 33 21 89 89" },
  { "step": "Trin 3: Levering",   "label": "Lev.-adresse",     "template": "{delivery_address_street}, {delivery_address_postal} {delivery_address_city}" },
  { "step": "Trin 3: Levering",   "label": "Modtager + tlf",   "template": "{delivery_contact_name}, {delivery_contact_phone}" },
  { "step": "Trin 3: Levering",   "label": "Firma",            "template": "{company_name}" },
  { "step": "Trin 3: Levering",   "label": "Bemærkn.",         "template": "{delivery_notes}" }
]'
WHERE code = 'byekspressen';

-- Seed: Taxa 4×35
UPDATE delivery_vehicles
SET booking_fields_json = '[
  { "label": "Pickup-adresse",  "template": "Ristet Rug, Prinsesse Charlottesgade 16" },
  { "label": "Afhentning",      "template": "{pickup_time}" },
  { "label": "Dato",            "template": "{delivery_date}" },
  { "label": "Firma",           "template": "{company_name}" },
  { "label": "Kontakt + tlf",   "template": "{delivery_contact_name} · {delivery_contact_phone}" },
  { "label": "Adresse",         "template": "{delivery_address_street}" },
  { "label": "Postnr",          "template": "{delivery_address_postal}" },
  { "label": "By",              "template": "{delivery_address_city}" },
  { "label": "Lev.-tid",        "template": "{delivery_time}" },
  { "label": "Reference",       "template": "{bon_id} · {total_boxes} kasser · lev. {delivery_time}" },
  { "label": "Bemærkn.",        "template": "{packaging_lines}. {delivery_notes}" }
]'
WHERE code = 'taxa-4x35';
```

**Bagudkompatibel:** Vehicles uden `booking_fields_json` viser kun "Samlet tekst"-mode (fra eksisterende `booking_template`).

**Adressevariabler verificeret:** `delivery_address_street`, `delivery_address_postal`, `delivery_address_city` findes allerede i [`services/booking_template.js`](../services/booking_template.js) (VARIABLE_KEYS linje 30-32, buildContext linje 113-115). Ingen udvidelse af buildContext nødvendig.

---

## 2. Backend — `services/booking_template.js`

### 2.1 Refaktorér `renderTemplate` så den også returnerer mangel-flag

Behold eksisterende public API (`renderTemplate(template, vars, options)` returnerer string) men tilføj intern variant:

```javascript
// NY intern funktion — returnerer både tekst og om der var mangler
function _renderWithMeta(template, vars) {
    if (template == null) return { text: '', hasMissing: false };
    let hasMissing = false;
    const text = String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (full, key) => {
        const val = vars[key];
        if (val != null && String(val).trim() !== '') return String(val);
        if (!VARIABLE_KEYS.has(key)) {
            console.warn(`[booking_template] Ukendt placeholder: {${key}}`);
            return full;
        }
        hasMissing = true;
        return '[mangler]';
    });
    return { text, hasMissing };
}

// Eksisterende public API — uændret signatur
function renderTemplate(template, vars, options = {}) {
    const { markMissing = true } = options;
    const { text, hasMissing } = _renderWithMeta(template, vars);
    if (!markMissing && hasMissing) {
        return text.replace(/\[mangler\]/g, '');
    }
    return text;
}
```

### 2.2 Ny funktion `renderFields(vehicle, vars)`

```javascript
// Returnerer null hvis vehicle ikke har booking_fields_json (bagudkompatibel)
function renderFields(vehicle, vars) {
    if (!vehicle?.booking_fields_json) return null;
    let fields;
    try {
        fields = JSON.parse(vehicle.booking_fields_json);
    } catch (e) {
        console.warn(`[booking_template] Ugyldig booking_fields_json for vehicle ${vehicle.code}:`, e.message);
        return null;
    }
    if (!Array.isArray(fields)) return null;

    return fields.map(f => {
        const { text, hasMissing } = _renderWithMeta(f.template || '', vars);
        return {
            label: String(f.label || ''),
            value: text,
            missing: hasMissing,
            step: f.step ? String(f.step) : null   // valgfri gruppering (fx Lobo's "Trin 2: Afhentning")
        };
    });
}

module.exports = {
    // ... eksisterende ...
    renderFields
};
```

### 2.3 Udvid `buildBookingPayload`

```javascript
return {
    booking_method: vehicle.booking_method,
    booking_url: vehicle.booking_url || null,
    clipboard_text,                                     // uændret
    fields: renderFields(vehicle, vars),                // NY — null hvis ikke konfigureret
    missing_fields: missing,                            // uændret (variable-keys)
    vehicle: { ... },                                   // uændret
    bon: { ... },
    estimated_cost_dkk: estimated,
    warnings
};
```

Frontend bruger `Array.isArray(payload.fields)` (eller `payload.fields === null`) til at detecte om vehicle har felt-konfiguration. Ingen separat `_configured`-flag — én sandhed.

---

## 3. Ny route — `GET /delivery/note/:bon_id`

**Mount-path:** `/delivery/note/:bon_id` (ikke under `/api`) — serverer HTML-side, ikke JSON.

Tilføj til `server.js` mount-rækkefølgen, eller læg i ny `routes/delivery_views.js`:

```javascript
// routes/delivery_views.js
const express = require('express');
const path = require('path');
const router = express.Router();
const { requireAuth } = require('../shared/auth');

router.get('/note/:bon_id', requireAuth(), (req, res) => {
    // Statisk HTML — al logik er klient-side via /api/delivery/booking-payload
    res.sendFile(path.join(__dirname, '..', 'views', 'delivery', 'note.html'));
});

module.exports = router;
```

**Auth:** Samme som resten af office. Hvis ikke logget ind → redirect til login.

**URL-format:** `/delivery/note/3467` eller `/delivery/note/3467?vehicle=2`. Vehicle er valgfri — siden auto-vælger første hvis tom.

---

## 4. Frontend — popout-siden

### 4.1 Filer

```
views/delivery/
├── note.html         ← Standalone side, ingen sidebar/topbar
├── note.css          ← Smal-vindue layout (~400px bredt)
└── note.js           ← State + render + SSE
```

### 4.2 `views/delivery/note.html`

Standalone HTML. Layout:

```
┌─────────────────────────────────────┐
│ HEADER (sticky)                     │
│  bon-id · kunde                     │
│  dato · tider · pax                 │
├─────────────────────────────────────┤
│ Leverandør: [dropdown] · ≈ 250 kr   │
├─────────────────────────────────────┤
│ [Felt-for-felt] [Samlet tekst]      │ ← tabs
├─────────────────────────────────────┤
│ ⚠ Mangler: x, y, z                  │
│                                     │
│ ┌────────────────────────────────┐ │
│ │ FELT-LISTE eller TEKST-BLOK    │ │
│ │ (scrollbar her)                │ │
│ └────────────────────────────────┘ │
├─────────────────────────────────────┤
│ FOOTER (sticky)                     │
│ Booking-ref [____]                  │
│ Faktisk pris [____]                 │
│ [Spring over] [✓ Marker som booket] │
└─────────────────────────────────────┘
```

**Reference-design:** Brug mockup'en i `docs/delivery/mockup_popout.html` (samme tokens som `shared/tokens.css`). Bemærk:
- Brand brun `#8e631f` til primær knap + leverandør-dropdown active
- Brand light `#f1e6b2` til estimat-pille + hover på felt-chips
- Manglende felter: `--color-warning-bg` baggrund + ⚠-ikon, ikke-klikbare

### 4.3 `views/delivery/note.js` — adfærd

```javascript
// Pseudokode — Simon implementerer
const bonId = parseInt(window.location.pathname.split('/').pop(), 10);
const initialVehicleId = new URLSearchParams(window.location.search).get('vehicle');

let state = {
    bonId,
    selectedVehicleId: initialVehicleId ? Number(initialVehicleId) : null,
    vehicles: [],
    payload: null,
    mode: 'fields',  // 'fields' | 'text'
    copiedFields: new Set()  // husker hvilke felter der er kopieret (UX)
};

async function init() {
    state.vehicles = await fetchDeliveryVehicles();
    if (!state.selectedVehicleId) {
        // Pre-vælg: hvis bonen allerede har en vehicle, brug den. Ellers første aktive.
        const bon = await fetchBon(bonId);
        state.selectedVehicleId = bon.delivery_vehicle_id || state.vehicles[0]?.id;
    }
    await loadPayload();
    setupSSE();
    render();
}

async function loadPayload() {
    state.payload = await fetchBookingPayload(state.bonId, state.selectedVehicleId);
    state.copiedFields.clear();  // ny vehicle → reset kopier-status
    render();
}

function setupSSE() {
    // Popout er en standalone HTML-side — opretter sin egen EventSource via
    // shared/utils.js' connectSSE(url, handlers). Samme cookie-baseret auth som hovedvinduet.
    connectSSE('/api/sse', {
        bon_updated: (data) => {
            if (data.id === state.bonId) loadPayload();
        },
        bon_status: (data) => {
            if (data.id === state.bonId) loadPayload();
        }
    });
}

function onFieldClick(idx) {
    const field = state.payload.fields[idx];
    if (field.missing) return;
    navigator.clipboard.writeText(field.value).catch(() => {
        // Fallback: select textarea og bed bruger trykke Cmd+C
        promptManualCopy(field.value);
    });
    state.copiedFields.add(idx);
    showToast(`Kopieret: ${field.value.substring(0, 36)}`);
    render();
}

async function onMarkBooked(status /* 'booked' | 'in_progress' */) {
    const ref = document.querySelector('#booking-ref').value.trim() || null;
    const cost = Number(document.querySelector('#actual-cost').value) || null;

    await bookDelivery({ bon_id: state.bonId, vehicle_id: state.selectedVehicleId, reference: ref, status });
    if (cost > 0) {
        await setDeliveryActualCost({ bon_id: state.bonId, amount_dkk: cost, source: 'manual' });
    }
    // Vinduet lukker sig selv — drawer i hovedvinduet opdateres via SSE
    window.close();
}
```

### 4.4 Render-rules

| Element | Adfærd |
|---|---|
| Felt-chip (klikbar) | Klik → `clipboard.writeText(field.value)` + flueben + toast. Felt skifter klasse til `copied` (grøn baggrund) |
| Felt-chip (missing) | Ikke-klikbar, grå-tonet, ⚠-ikon, viser `[mangler]` |
| "Samlet tekst" tab | Viser `payload.clipboard_text` i `<pre>` + én "Kopiér hele teksten"-knap |
| Vehicle-dropdown skift | Triggerer `loadPayload()` — felt-liste re-renderes komplet |
| Banner "Mangler" | Vises hvis ≥1 felt har `missing: true`. Lister felt-labels (ikke variable-keys) |
| Estimat-pille | `payload.estimated_cost_dkk` formateret som "≈ N kr". Hvis null → vises ikke |
| Step-grupper | Hvis felter har `step`-property: render små step-headers (`<h4 class="field-step">Trin 2: Afhentning</h4>`) før hver gruppe. Felter med `step: null` rendres ugrupperet i bunden. Felter uden `step` overhovedet i hele listen → ingen headers (ikke alle vehicles bruger step) |

### 4.5 Hvis `payload.fields === null`

Vehicle har ikke `booking_fields_json` konfigureret. Vis kun "Samlet tekst"-mode (skjul tabs, default til text-view). Banner: *"Felt-for-felt-visning er ikke konfigureret for denne leverandør. Tilføj `booking_fields_json` i Settings → Leveringsmetoder."*

---

## 5. Drawer-integration — `shared/bon_drawer.js`

### 5.1 Erstat modal-kald med `window.open`

Find eksisterende kode i bon_drawer.js der kalder `openManualBookingModal(...)`. Erstat med:

```javascript
function openDeliveryNote(bonId, vehicleId = null) {
    const url = `/delivery/note/${bonId}` + (vehicleId ? `?vehicle=${vehicleId}` : '');
    // Target-navn per bon — flere bons kan have hver sit popout åbent samtidig
    // (fx weekend hvor kontoret batcher 5 bookings). Klik på samme bon to gange
    // genbruger eksisterende vindue.
    const win = window.open(
        url,
        `rr-delivery-note-${bonId}`,
        'width=420,height=780,left=100,top=100,scrollbars=yes,resizable=yes,toolbar=no,location=no,menubar=no'
    );
    if (!win) {
        showPopupBlockedError(bonId, vehicleId);
        return;
    }
    win.focus();
}

function showPopupBlockedError(bonId, vehicleId) {
    // Brug eksisterende shared/modal.js til en lille besked
    showModal({
        title: 'Popup blokeret',
        body: `Din browser blokerede popup-vinduet. Tillad popups for <code>bon.ristetrug.dk</code> og prøv igen, eller åbn siden i en ny fane:<br><br><a href="${url}" target="_blank">Åbn bestillings-note i ny fane</a>`,
        buttons: [{ label: 'Prøv igen', primary: true, onClick: () => openDeliveryNote(bonId, vehicleId) }]
    });
}
```

### 5.2 Deep-linking fra bon-kort

Eksisterende `openBonDeliveryFromCard(cardId)` skal nu åbne popout i stedet for drawer-scroll. Behold drawer-scroll som secondary (booking-historik vises der). Ny default: åbn popout direkte hvis booking ikke er gennemført endnu.

---

## 6. Settings UI — `views/settings/index.html`

Leveringsmetoder-fanen får ny editor for `booking_fields_json` per vehicle.

### 6.1 UI

```
┌─ Felt-konfiguration ────────────────────────────────────────┐
│ Hvert felt er en mini-template med {variabel}-syntaks.      │
│ Tomme variabler vises som [mangler].                        │
│                                                             │
│ ┌─┬─────────────────┬───────────────────────────────────┬─┐ │
│ │↕│ Label           │ Template                          │×│ │
│ ├─┼─────────────────┼───────────────────────────────────┼─┤ │
│ │↕│ Klar kl.        │ {pickup_time}                     │×│ │
│ │↕│ Antal kolli     │ {total_boxes}                     │×│ │
│ │↕│ Reference       │ {bon_id} · {total_boxes} kasser   │×│ │
│ │↕│ Modtager + tlf  │ {delivery_contact_name}, {delivery_contact_phone} │×│ │
│ └─┴─────────────────┴───────────────────────────────────┴─┘ │
│ [+ Tilføj felt]                                             │
│                                                             │
│ Variabel-chips (klik for at indsætte i fokuseret template): │
│ {bon_id} {company_name} {delivery_contact_name} {…}         │
└─────────────────────────────────────────────────────────────┘
```

| Egenskab | Detalje |
|---|---|
| Drag-handle (↕) | Reorder rækker — gemmes ved release |
| Label-input | Fri tekst, kort (vises i popout) |
| Template-input | Mono-font, `{variabel}`-chips er klikbare og indsætter ved cursor-position |
| ×-knap | Fjern række (med confirm hvis ikke-tom) |
| Variabel-chips | Hentes fra `GET /api/delivery/template-variables` (eksisterer) |
| Gem-knap | Validerer JSON, sender `PATCH /api/delivery/vehicles/:id` med `booking_fields_json: JSON.stringify(rows)` |
| Validation | Hver række kræver non-empty `label`. Tom template tilladt (renderes som tom). Ukendte placeholders i template = warning, ikke fejl |

### 6.2 PATCH-endpoint udvides

`routes/delivery.js` linje 116-117 — tilføj `booking_fields_json` til allowed-listen:

```javascript
const allowed = [
    'label', 'type', 'is_internal',
    'max_capacity_boxes', 'max_distance_km',
    'booking_method', 'booking_url', 'booking_template',
    'booking_fields_json',  // NY
    'supplier_id', 'sort_order', 'is_active'
];
```

---

## 7. Slet `shared/manual_booking_modal.js`

Når popout-flow er deployet og verificeret:

| Fil | Aktion |
|---|---|
| `shared/manual_booking_modal.js` | Slet |
| `shared/manual_booking_modal.css` | Slet |
| HTML-filer der linker dem | Fjern `<link>` og `<script>` tags. Berørte: `kitchen/today.html`, `kitchen/later.html`, `kitchen/calendar.html`, `office/index.html` |
| Globalt: `window.openManualBookingModal` | Tilføj eslint-regel `no-restricted-globals: ['error', { name: 'openManualBookingModal' }]` så fremtidige kald fanges |

**Migration-strategi:** Behold modal'en i én commit hvor popout er parallel-deployet bag feature-flag `delivery.use_popout` i settings. Sæt til `1` i production. Verificér i én uge. Slet i opfølgende commit.

---

## 8. Tests

### 8.1 Unit — `scripts/test-delivery-spor1-unit.js`

Tilføj cases:

```javascript
test('renderFields returnerer null hvis booking_fields_json mangler', () => {
    const vehicle = { booking_fields_json: null };
    assert.equal(renderFields(vehicle, {}), null);
});

test('renderFields returnerer null hvis booking_fields_json er ugyldig JSON', () => {
    const vehicle = { booking_fields_json: 'not json', code: 'test' };
    assert.equal(renderFields(vehicle, {}), null);
});

test('renderFields rendrer felt-array korrekt', () => {
    const vehicle = { booking_fields_json: JSON.stringify([
        { label: 'Test', template: '{bon_id} · {total_boxes}' }
    ])};
    const vars = { bon_id: '3467', total_boxes: '4' };
    const fields = renderFields(vehicle, vars);
    assert.deepEqual(fields, [{ label: 'Test', value: '3467 · 4', missing: false }]);
});

test('renderFields markerer missing når variabel mangler', () => {
    const vehicle = { booking_fields_json: JSON.stringify([
        { label: 'Reference', template: '{bon_id} · {total_boxes} kasser' }
    ])};
    const vars = { bon_id: '3467', total_boxes: '' };  // mangler
    const fields = renderFields(vehicle, vars);
    assert.equal(fields[0].missing, true);
    assert.equal(fields[0].value, '3467 · [mangler] kasser');
});

test('buildBookingPayload inkluderer fields-array når konfigureret', () => {
    // Seed test-vehicle med booking_fields_json
    // Kald buildBookingPayload
    // Verificér payload.fields er array af { label, value, missing }
});
```

### 8.2 Integration — ny test-fil `scripts/test-delivery-popout.js`

```javascript
test('GET /delivery/note/:bon_id returnerer HTML med auth', async () => {
    const res = await fetch('/delivery/note/3467', { headers: authHeaders });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /html/);
});

test('GET /delivery/note/:bon_id 401 uden auth', async () => {
    const res = await fetch('/delivery/note/3467');
    assert.equal(res.status, 401);  // eller 302 → login
});

test('GET /api/delivery/booking-payload returnerer fields-array', async () => {
    const res = await fetch(`/api/delivery/booking-payload?bon_id=3467&vehicle_id=${byekspressenId}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.fields));
    assert.ok(body.fields.every(f => 'label' in f && 'value' in f && 'missing' in f));
});

test('PATCH /api/delivery/vehicles/:id accepterer booking_fields_json', async () => {
    const newConfig = [{ label: 'Test', template: '{bon_id}' }];
    const res = await fetch(`/api/delivery/vehicles/${vehicleId}`, {
        method: 'PATCH',
        body: JSON.stringify({ booking_fields_json: JSON.stringify(newConfig) }),
        headers: { 'Content-Type': 'application/json', ...adminAuth }
    });
    assert.equal(res.status, 200);
    // Re-fetch og verificér
});
```

### 8.3 Manuel acceptance (Office)

1. Åbn bon-drawer for en bon med `delivery_type='delivery'` uden booking
2. Klik "📦 Bestil hos…" — verificér at popup-vindue åbnes (ikke modal)
3. Vælg Taxa 4×35 i dropdown — felt-liste viser 11 felter
4. Klik på "Reference"-felt — verificér clipboard har `{bon_id} · {total_boxes} kasser · lev. {delivery_time}` rendered
5. Skift til By-expressen — verificér 11 andre felter (Lobo-tilpasset)
6. Klik "Samlet tekst" tab — verificér samme felter sammensat som "Label: værdi"-linjer
7. Manglende felt (fx hvis `total_boxes` mangler på bonen) — verificér ⚠-ikon, ikke-klikbar, banner øverst
8. Indtast Booking-ref + faktisk pris, klik "Marker som booket" — verificér vinduet lukker + drawer i hovedvinduet opdaterer via SSE
9. Åbn note for **samme** bon igen — verificér at samme vindue genbruges (target `rr-delivery-note-${bonId}`)
10. Åbn note for **anden** bon — verificér at et **separat** vindue åbnes (begge kan stå åbne parallelt)

---

## 9. Migrations-checkliste

- [ ] Migration tilføjet med næste ledige nummer
- [ ] Seed for By-expressen + Taxa 4×35 verificeret
- [ ] `services/booking_template.js` udvidet med `_renderWithMeta` + `renderFields`
- [ ] `buildBookingPayload` returnerer `fields`
- [ ] `routes/delivery.js` PATCH allowed-liste udvidet
- [ ] Ny route `/delivery/note/:bon_id` mountes
- [ ] `views/delivery/note.{html,js,css}` oprettet
- [ ] `shared/bon_drawer.js` opdateret: `openDeliveryNote()` erstatter `openManualBookingModal()`
- [ ] Settings UI udvidet med felt-editor (drag-reorder + variabel-chips)
- [ ] Unit + integration tests grønne
- [ ] Feature-flag `delivery.use_popout` introduceret (1 uge parallel-drift)
- [ ] Modal-filer slettet efter verifikation
- [ ] HTML-filer (kitchen + office) ryddet for modal-script/css
- [ ] CLAUDE.md opdateret under "Delivery — Spor 1: Manuel bestilling"
- [ ] CLAUDE_DELIVERY.md "Manual booking modal"-sektion erstattet med "Popout-vindue"-sektion

---

## 10. Åbne spørgsmål

| # | Punkt | Beslutning |
|---|---|---|
| 1 | `window.open` target-navn | `rr-delivery-note-${bonId}` — én vindue pr. bon, så kontoret kan have flere bookings åbne parallelt (fx weekend-batch). Klik på samme bon to gange genbruger samme vindue. |
| 2 | Vinduesstørrelse default | 420 × 780 px (juster ift. faktisk content-højde efter test) |
| 3 | Skal popout huske leverandør-valg på tværs af bons? | Nej — pre-vælg ud fra `bons.delivery_vehicle_id`, fallback til første aktive |
| 4 | Popup-blokeret fallback | Vis lille modal med "Tillad popups + retry"-link. **Ikke** fallback til den gamle modal — modalen afskaffes |
| 5 | Multi-stop (3D.6) | Ikke i denne spec — popout designes single-bon. Multi-stop får senere sin egen visning |

---

*Spec skrevet: maj 2026. Bygger på beslutninger taget i Claude.ai-sparring efter konstatering af at den nuværende `manual_booking_modal.js` gør Lobo's 4-trins wizard sværere at bruge end den behøver være.*
