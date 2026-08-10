# Bon v2 — Varemodtagelse
*Opdateret: april 2026*

---

## Formål

Varemodtagelse dækker to separate behov der udføres i ét samlet flow på én side:

1. **Fødevarekontrol** — dokumentation til Fødevarestyrelsen (leverandør, temperatur, tjek, foto)
2. **Lager-opdatering** — læg modtagne varer på lager i Grocy

De to sektioner er på samme side. Lager-sektionen er visuelt inaktiv ("Vælg leverandør ovenfor") indtil leverandør er valgt. Backend modtager og gemmer alt ved ét enkelt `POST /api/goods-receipts` — ingen multi-step submit.

---

## Tre driftsmodes

Styres via `settings`-tabellen. Ingen kodeændring ved skift af mode.

| Mode | Hvad sker | Konfiguration |
|------|-----------|---------------|
| `bonv2_only` | Gemmer i Bon v2, ingen webhook | `whiteboard_webhook_url` er tom |
| `whiteboard_only` | Whiteboard bruges som i dag — Bon v2 ikke involveret | Bon v2 ikke i brug |
| `combined` | Gemmer i Bon v2 + sender webhook til Whiteboard | `whiteboard_webhook_url` sat |

**Default for nye installationer:** `bonv2_only`

---

## Placering i UI

Tab 2 i `kitchen/purchasing.html`:
```
kitchen/purchasing.html  →  [ Indkøb ]  [ Varemodtagelse ]
```

`purchasing.html` kalder allerede `initVaremodtagelse(container)` ved tab-skift.
**Ingen ændringer i `purchasing.html` er nødvendige.**

Åbnes også via:
- Mobilshellet (`/m/`) → Mere → Varemodtagelse
- Deep-link `?open=varemodtagelse` (fra Whiteboard og andre systemer)

---

## UI-design

**Baseret på `varemodtagelse_v4.html`** (se mockup-fil).

Touch-first, max-width 500px, én samlet scrollbar side.
Designtokens arves fra `shared/bon-base.css`. Zone: `zone-kitchen`.

---

## Siden — layout

```
┌─────────────────────────────────────────┐
│  ← Bon v2    📦 Varemodtagelse    🗂     │
├─────────────────────────────────────────┤
│  ─────────── FØDEVAREKONTROL ────────── │
├─────────────────────────────────────────┤
│  👤 Registreret af: [Leif ▾]           │
├─────────────────────────────────────────┤
│  Leverandør  📡 Grocy                   │
│  [Søren's Grønt — 3 varer klar    ▾]   │
├─────────────────────────────────────────┤
│  🧊 Kølevarer  max. 5°C      [●  ON]   │
│  [  3,0  °C  ]  [ ✅ OK ]              │
│  · · · · · · · · · · · · · · · · · ·   │
│  ❄️ Frysvarer  max. -18°C    [●  ON]   │
│  [ -20,0 °C  ]  [ ✅ OK ]              │
├─────────────────────────────────────────┤
│  Dato/holdbarhed kontrolleret    [●  ]  │
│  Mærkning kontrolleret           [●  ]  │
│  Emballage kontrolleret          [●  ]  │
├─────────────────────────────────────────┤
│  [📷 Tag foto af følgeseddel         ]  │
├─────────────────────────────────────────┤
│  (⚠️ Afvigelse-sektion — auto-vises)   │
├─────────────────────────────────────────┤
│  + Tilføj bemærkning                    │
├─────────────────────────────────────────┤
│  ──────────────── LAGER ─────────────── │
├─────────────────────────────────────────┤
│  ✓ Alt modtaget som bestilt            │
│  Alle varer lægges på lager            │
│                      [ Godkend alt ]   │
│  [ ▸ Juster enkeltvis hvis noget afviger ] │
├─────────────────────────────────────────┤
│  (vareliste — collapsed som default)    │
├─────────────────────────────────────────┤
│  [Annuller]  [✓ Registrér varemodtagelse] │
└─────────────────────────────────────────┘
```

---

## Bruger-dropdown

Hentes fra `GET /api/users` (eksisterende endpoint, `routes/users.js`).

Auto-vælg den indloggede bruger via `req.session.user` når siden initialiseres.
Dropdown er synlig så en anden medarbejder kan overtage registreringen.

---

## Leverandør-dropdown

### Data-source

To kald kombineres:

```js
// 1. Hent aktive leverandører fra Bon v2
GET /api/purchasing/suppliers?location_id={activeLocationId}
// Returnerer: supplier_id, supplier_name, grocy_location_display_name

// 2. Hent Grocy shopping list
GET /api/grocy/shopping-list
// Filtrer: items hvor userfields.ordered_at != '' OG userfields.ordered_varenr != ''
// Udtræk unikke ordered_supplier-værdier
```

Vis kun leverandører hvor `supplier.supplier_name` eller `supplier.grocy_location_display_name`
matcher en `ordered_supplier`-værdi fra Grocy shopping list.

**Vigtigt:** `ordered_supplier` i Grocy sættes af `indkob.js` til
`handler.grocy_location_display_name || handler.supplier_name` (linje 1362/1426).
Match derfor på begge felter.

Dropdown-tekst: `"Søren's Grønt — 3 varer klar"` (antal = shopping list items for leverandøren).

Hvis ingen leverandører har ventende varer: vis tom state — `"Ingen bestilte leverancer at modtage"`.

---

## Temperaturer

| Felt | Grænse | Default | Enhed |
|------|--------|---------|-------|
| 🧊 Kølevarer | max. 5°C | 3°C | °C |
| ❄️ Frysvarer | max. -18°C | -20°C | °C |

Begge felter vises og er aktive som standard.
Hvert felt har en lille toggle der slår det fra hvis leverancen ikke indeholder den pågældende varetype.
Når disabled: felt er gråt, inputværdi ignoreres, gemmes som `NULL` i DB.

### Temperatur-badge (live)

| Tilstand | Badge |
|----------|-------|
| Tomt felt | `—` (neutral) |
| Inden for grænse | `✅ OK` (grøn) |
| Over grænse | `❌ FEJL` (rød) |

`❌ FEJL` trigger automatisk afvigelse-sektionen.

---

## Afvigelse-sektion

Vises automatisk — kan ikke lukkes manuelt af brugeren.

**Triggers:**
- Køl-temp > 5°C (når køl er enabled)
- Frys-temp > -18°C (når frys er enabled)
- Én eller flere FVST-toggles slået fra

**Indhold:**

Radioknapper (påkrævet — én skal vælges):
- Returneret til leverandør → `deviation_type = 'returned'`
- Ingen reel risiko — anvendes → `deviation_type = 'no_risk'`
- Kasseret → `deviation_type = 'discarded'`
- Leverandør kontaktet → `deviation_type = 'supplier_contacted'`
- Andet → `deviation_type = 'other'`

Fritekst-felt: "Bemærkning ved afvigelse" (påkrævet når afvigelse er aktiv).

`✓ Registrér`-knappen forbliver disabled så længe afvigelse-sektionen er synlig men ingen radioknap er valgt.

---

## Lager-sektion

### Vareliste-data

```js
GET /api/grocy/shopping-list
→ filtrer: ordered_supplier matcher valgt leverandør OG ordered_varenr != ''
→ aggregér: gruppér på product_id, summér amount (håndterer dubletter)
→ each item: { grocy_product_id, product_name, expected_quantity, unit }
```

### Godkend alt (primær handling)

```
┌────────────────────────────────────────────┐
│  ✓ Alt modtaget som bestilt                │
│  Alle varer lægges på lager                │
│                          [ Godkend alt ]   │
│  [ ▸ Juster enkeltvis hvis noget afviger ] │
└────────────────────────────────────────────┘
```

"Godkend alt" sætter alle varer til `status: 'ok'` og `received_quantity = expected_quantity`.

"Juster enkeltvis"-knappen er **fuld bredde, min. 44px høj** (touch-target).
Åbner varelisten — collapsed som default.

### Vareliste (per vare)

- Varenavn + forventet mængde
- Mængde-justeringskontrol (−/+/input), forudfyldt med `expected_quantity`
- Status-knapper: `✓ OK` / `− Mangler` / `↔ Forkert` / `✕ Skadet`
- Notefelt vises automatisk ved ikke-OK status

`[+ Tilføj vare manuelt]` — til uplanlagte leveringer uden `ordered_*` userfields.

### Regler per varestatus

| Status | Grocy addStock | Shopping list |
|--------|---------------|---------------|
| `ok` — modtaget = forventet | ✅ `received_quantity` | Slet item |
| `ok` — modtaget < forventet | ✅ `received_quantity` | Opdatér qty til rest, nulstil `ordered_*` |
| `missing` — intet modtaget | ❌ Spring over | Nulstil `ordered_*`, behold på liste |
| `wrong` — forkert (beholdt) | ✅ `received_quantity` | Slet item |
| `wrong` — forkert (returneret) | ❌ Spring over | Nulstil `ordered_*`, behold på liste |
| `damaged` — kasseret | ❌ Spring over | Nulstil `ordered_*`, behold på liste |
| `damaged` — accepteret | ✅ `received_quantity` | Slet item |

**"Nulstil `ordered_*`"** = PUT til Grocy userfields på shopping list item:
```js
{ ordered_varenr: '', ordered_at: '', ordered_qty: '', ordered_supplier: '' }
```

### Grocy addStock

```js
POST /api/grocy/stock/products/{grocy_product_id}/add
{
  amount: received_quantity,
  best_before_date: null,        // Grocy bruger produktets default_due_days
  location_id: activeLocationId  // HQ=1, Trailer=2 — arves fra aktiv lokation
}
```

Kald køres **sekventielt** — aldrig parallelt. Vi skal vide præcis hvilke varer der lykkedes.

### Delvis Grocy-fejl

```
Vare 1 → OK   → goods_receipt_items.grocy_added = 1
Vare 2 → FEJL → goods_receipt_items.grocy_added = 0, grocy_error = 'HTTP 500'
Vare 3 → OK   → goods_receipt_items.grocy_added = 1  ← kører videre uanset fejl på vare 2
```

`goods_receipt.status` = `'approved'` selv ved delvise fejl — registreringen er gyldig.
UI viser: `"✅ 2 varer lagt på lager · ⚠️ 1 fejlede (Tomater) — ret manuelt i Grocy"`

---

## Validering — Registrér-knap

`✓ Registrér`-knappen er disabled indtil alle betingelser er opfyldt:

| Betingelse | Krav |
|-----------|------|
| Bruger | Valgt (auto-selected — burde aldrig mangle) |
| Leverandør | Valgt |
| Køl-temp | Udfyldt og numerisk (medmindre køl-toggle er disabled) |
| Frys-temp | Udfyldt og numerisk (medmindre frys-toggle er disabled) |
| Afvigelsesårsag | Valgt, hvis afvigelse-sektion er synlig |

---

## Foto

Upload sker **inden** den endelige submit:

```
POST /api/goods-receipts/photo   (multipart/form-data, felt: "photo")
→ gemmer til /uploads/receipts/vr-tmp-{timestamp}.jpg
→ returnerer { path: "/uploads/receipts/vr-tmp-1234567890.jpg" }
```

`path` gemmes i UI-state og medsendes i `POST /api/goods-receipts` som `photo_path`.
Backend omdøber filen til `vr-{receipt_number}-{timestamp}.jpg` ved finalize.

Foto er anbefalet men ikke påkrævet — `photo_path` kan være `null`.

---

## Database

**Migration: `036_goods_receipts.sql`**
(Seneste eksisterende migration er `035_indkob_fixes.sql`)

```sql
CREATE TABLE goods_receipts (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number            TEXT NOT NULL UNIQUE,    -- VR-2026-042
  supplier_name             TEXT NOT NULL,            -- snapshot, ikke FK

  location_id               INTEGER REFERENCES locations(id),
  received_by               INTEGER REFERENCES users(id),
  received_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Køl-temperatur
  temperature_cool_enabled  INTEGER NOT NULL DEFAULT 1,  -- 0 = ikke relevant for denne levering
  temperature_cool_value    REAL,                         -- NULL hvis disabled
  temperature_cool_ok       INTEGER,                      -- NULL hvis disabled, 1=ok, 0=fejl

  -- Frys-temperatur
  temperature_frozen_enabled INTEGER NOT NULL DEFAULT 1,
  temperature_frozen_value   REAL,
  temperature_frozen_ok      INTEGER,

  -- FVST-tjek
  date_check_ok             INTEGER NOT NULL DEFAULT 1,
  labeling_check_ok         INTEGER NOT NULL DEFAULT 1,
  packaging_check_ok        INTEGER NOT NULL DEFAULT 1,

  -- Afvigelse
  has_deviation             INTEGER NOT NULL DEFAULT 0,
  deviation_type            TEXT CHECK (deviation_type IN
                              ('returned','no_risk','discarded','supplier_contacted','other')),
  deviation_note            TEXT,

  photo_path                TEXT,
  notes                     TEXT,

  -- Fremtid: kobling til purchase_orders-tabel (ikke implementeret endnu)
  purchase_order_id         INTEGER,

  whiteboard_synced_at      DATETIME,
  status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved')),
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE goods_receipt_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id        INTEGER NOT NULL REFERENCES goods_receipts(id),
  grocy_product_id  INTEGER,                -- NULL ved manuelt tilføjet vare
  product_name      TEXT NOT NULL,          -- snapshot
  expected_quantity REAL,
  unit              TEXT,
  received_quantity REAL,
  status            TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok','missing','wrong','damaged')),
  notes             TEXT,
  grocy_added       INTEGER NOT NULL DEFAULT 0,  -- 1 = addStock lykkedes
  grocy_error       TEXT                         -- fejlbesked hvis grocy_added = 0
);

CREATE TABLE webhook_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL,
  payload     TEXT NOT NULL,
  status_code INTEGER,
  error       TEXT,
  sent_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  retry_count INTEGER NOT NULL DEFAULT 0
);

INSERT INTO settings (key, value, description) VALUES
  ('goods_receipt_number_prefix', 'VR',  'Præfiks for varemodtagelses-numre'),
  ('goods_receipt_number_next',   '1',   'Næste løbenummer'),
  ('whiteboard_webhook_url',      '',    'URL til Whiteboard /api/events (tom = ingen sync)'),
  ('whiteboard_webhook_secret',   '',    'Valgfri HMAC-secret til webhook-validering');
```

`receipt_number` genereres med `BEGIN IMMEDIATE`-transaktion — forhindrer dubletter ved samtidig registrering fra to enheder.

---

## API-endpoints

Alle endpoints i `routes/goods-receipts.js`. Monteres i `server.js`:
```js
app.use('/api/goods-receipts', require('./routes/goods-receipts'));
```

```
POST   /api/goods-receipts/photo    Upload foto — returnerer { path }
POST   /api/goods-receipts          Opret + finalize i ét kald
GET    /api/goods-receipts          Liste, filter: ?from=&to=&supplier=&location=
GET    /api/goods-receipts/:id      Detalje inkl. items
GET    /api/goods-receipts/:id/pdf  PDF-rapport (udskydes til fase 7)
```

### Request body — POST /api/goods-receipts

```json
{
  "supplier_name":               "Søren's Grønt",
  "received_by_user_id":         3,
  "location_id":                 1,

  "temperature_cool_enabled":    true,
  "temperature_cool_value":      3.5,
  "temperature_cool_ok":         true,

  "temperature_frozen_enabled":  true,
  "temperature_frozen_value":    -20.0,
  "temperature_frozen_ok":       true,

  "date_check_ok":               true,
  "labeling_check_ok":           true,
  "packaging_check_ok":          true,

  "has_deviation":               false,
  "deviation_type":              null,
  "deviation_note":              null,

  "photo_path":                  "/uploads/receipts/vr-tmp-1234567890.jpg",
  "notes":                       null,

  "items": [
    {
      "grocy_product_id":    42,
      "product_name":        "Tomater",
      "expected_quantity":   5,
      "received_quantity":   5,
      "unit":                "kg",
      "status":              "ok",
      "notes":               null
    }
  ]
}
```

### Response

```json
{
  "id":             42,
  "receipt_number": "VR-2026-042",
  "status":         "approved",
  "grocy_results": [
    { "product_name": "Tomater", "grocy_added": true,  "error": null },
    { "product_name": "Salat",   "grocy_added": false, "error": "HTTP 500" }
  ],
  "webhook_sent": true
}
```

---

## Webhook til Whiteboard

Whiteboard modtager **kun fødevarekontrol-data** — intet om Grocy, varemængder eller items.

```json
{
  "schema_name": "varemodtagelse",
  "user":        "Leif",
  "supplier":    "Søren's Grønt",
  "data": {
    "temperature_cool_enabled":    true,
    "temperature_cool_value":      3.5,
    "temperature_cool_ok":         true,
    "temperature_frozen_enabled":  true,
    "temperature_frozen_value":    -20.0,
    "temperature_frozen_ok":       true,
    "date_check":                  true,
    "labeling_check":              true,
    "packaging_check":             true,
    "photo_path":                  "https://bon.ristetrug.dk/uploads/receipts/vr-2026-042.jpg",
    "deviation":                   "none",
    "deviation_note":              null,
    "bon_v2_receipt_id":           42,
    "bon_v2_receipt_number":       "VR-2026-042"
  }
}
```

`photo_path` er absolut URL — Whiteboard linker til den, gemmer ingen kopi.
`bon_v2_receipt_id` og `bon_v2_receipt_number` bruges til evt. deep-link tilbage til Bon v2.

### Afsendelse

```js
const webhookUrl = getSetting('whiteboard_webhook_url');
if (!webhookUrl) return; // bonv2_only mode — skip stille
```

Udføres **asynkront** efter DB-skrivning. Fejler webhook → log til `webhook_log`, blokér ikke brugeren.
Ingen automatisk retry i v1 (udskydes til fase 7).

---

## Filer der oprettes/ændres

| Fil | Handling | Note |
|-----|---------|------|
| `db/migrations/036_goods_receipts.sql` | **Ny** | Tabeller + settings |
| `routes/goods-receipts.js` | **Ny** | Alle goods-receipt endpoints |
| `services/goodsReceiptWebhook.js` | **Ny** | Webhook-logik |
| `shared/varemodtagelse.js` | **Overskriv** | Fil eksisterer — komplet ny implementering fra mockup v4. Bevarer `initVaremodtagelse(container)` som entry point |
| `shared/varemodtagelse.css` | **Overskriv** | Fil eksisterer — styling fra mockup v4 |
| `shared/api.js` | **Tilføj** | Tre nye funktioner efter linje 790 (efter eksisterende `postReceivingComplete`) |
| `server.js` | **Tilføj** | Mount `routes/goods-receipts.js` |
| `routes/receiving.js` | **Rør ikke** | Backend til `shared/indkob.js`'s bestillingsflow (`postReceivingComplete` → `/receiving/complete`). Ikke et separat varemodtagelsessystem — intet overlap med `goods-receipts.js` |
| `kitchen/purchasing.html` | **Ingen ændringer** | Kalder allerede `initVaremodtagelse(container)` |

### Tilføjelse til shared/api.js

Indsæt efter linje 790 (efter den eksisterende `postReceivingComplete`-funktion):

```js
/* ── GOODS RECEIPTS (/api/goods-receipts) ────────────── */

function postGoodsReceiptPhoto(formData) {
    // Ingen Content-Type header — browser sætter multipart boundary selv
    return apiFetch('/goods-receipts/photo', {
        method: 'POST', body: formData,
    });
}

function postGoodsReceipt(data) {
    return apiFetch('/goods-receipts', {
        method: 'POST', body: JSON.stringify(data),
    });
}

function fetchGoodsReceipts(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/goods-receipts' + qs);
}
```

---

## Rækkefølge for implementering

1. **Migration 036** — tabeller og settings
2. **`routes/goods-receipts.js`** — `POST /api/goods-receipts/photo` + `POST /api/goods-receipts` + GET-endpoints
3. **`shared/api.js`** — tilføj tre nye funktioner
4. **`shared/varemodtagelse.js` — fødevarekontrol** — bruger-dropdown, leverandør-dropdown, temperaturer, FVST-toggles, foto, afvigelse-sektion, submit
5. **`shared/varemodtagelse.js` — lager-sektion** — vareliste fra Grocy, godkend-alt, juster-enkeltvis, opsummering
6. **`shared/varemodtagelse.css`** — styling fra mockup v4
7. **`services/goodsReceiptWebhook.js`** — Whiteboard sync
8. **`server.js`** — mount goods-receipts route

**Efter trin 4** er komplet fødevarekontrol-dokumentation funktionel og kan tages i brug inden Grocy-write (trin 5) er færdig.

---

## Test-matrix

Tests køres på **grocytest**-instansen. Nulstil testdata mellem scenarier.

### Testdata-setup

```bash
# Verificér at testleverandør findes i Bon v2
sqlite3 /opt/bon-v2/data/bon.db "
  SELECT id, name FROM suppliers WHERE name = 'Testleverandør';
"
# Hvis ikke: INSERT OR IGNORE INTO suppliers (name, integration_type, is_active) VALUES ('Testleverandør', 'manual', 1);

# Sæt 3 Grocy shopping list items klar til modtagelse
sqlite3 /var/www/grocytest/data/grocy.db "
  UPDATE shopping_list SET
    userfield_ordered_at       = datetime('now'),
    userfield_ordered_qty      = '5',
    userfield_ordered_supplier = 'Testleverandør',
    userfield_ordered_varenr   = 'TEST-001'
  WHERE product_id IN (1, 2, 3);
"

# Verificér
sqlite3 /var/www/grocytest/data/grocy.db "
  SELECT product_id, amount, userfield_ordered_supplier, userfield_ordered_at
  FROM shopping_list WHERE product_id IN (1,2,3);
"
```

### Nulstil mellem scenarier

```bash
sqlite3 /var/www/grocytest/data/grocy.db "
  UPDATE shopping_list SET
    userfield_ordered_at = datetime('now'),
    userfield_ordered_qty = '5',
    userfield_ordered_supplier = 'Testleverandør',
    userfield_ordered_varenr = 'TEST-001'
  WHERE product_id IN (1,2,3);
"
```

---

### Scenarie 1 — Happy path: fuld OK-levering

**Mål:** Alt grønt, ingen afvigelser, Grocy opdateret, Whiteboard notificeret.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| 1 | Åbn varemodtagelse | Bruger auto-selected til indlogget bruger |
| 2 | Vælg "Testleverandør" | Lager-sektion vises med 3 varekort |
| 3 | Køl: 3°C (default) | Badge: ✅ OK. Ingen afvigelse-sektion |
| 4 | Frys: -20°C (default) | Badge: ✅ OK |
| 5 | Alle 3 FVST-toggles ON (default) | Ingen afvigelse-sektion |
| 6 | Tryk "Godkend alt" | Alle 3 varer markeres ✓ OK |
| 7 | Tryk "✓ Registrér" | Succès-overlay vises |
| ✓ | DB: `goods_receipts` has_deviation=0, status='approved' | |
| ✓ | DB: temperature_cool_value=3, temperature_cool_ok=1 | |
| ✓ | DB: temperature_frozen_value=-20, temperature_frozen_ok=1 | |
| ✓ | DB: `goods_receipt_items` — 3 rækker, status='ok', grocy_added=1 | |
| ✓ | Grocy: lager steget for product_id 1, 2, 3 | |
| ✓ | Grocy: shopping list items slettet for product_id 1, 2, 3 | |
| ✓ | Whiteboard: `item_log` har ny række, registration_type='varemodtagelse' | |
| ✓ | Whiteboard data: deviation='none', begge temp_ok=true | |

---

### Scenarie 2 — Køl-temperaturafvigelse

**Mål:** Afvigelse trigger, korrekt logning, Grocy stadig opdateret.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| 1 | Vælg leverandør | |
| 2 | Køl-temp: **8°C** | Badge: ❌ FEJL. Afvigelse-sektion vises automatisk |
| 3 | Frys: -20°C | Badge: ✅ OK |
| 4 | ✓ Registrér er **disabled** | Afvigelsesårsag ikke valgt endnu |
| 5 | Vælg "Leverandør kontaktet" | Knap enabled |
| 6 | Skriv bemærkning | |
| 7 | Godkend alt → Registrér | |
| ✓ | DB: has_deviation=1, deviation_type='supplier_contacted' | |
| ✓ | DB: temperature_cool_value=8, temperature_cool_ok=0 | |
| ✓ | DB: temperature_frozen_value=-20, temperature_frozen_ok=1 | |
| ✓ | Grocy: lager opdateret (afvigelse stopper ikke lagertræk) | |
| ✓ | Whiteboard data: deviation='supplier_contacted', temperature_cool_ok=false | |

---

### Scenarie 3 — Kun kølevarer (frys disabled)

**Mål:** Frys-felt deaktiveret gemmes korrekt som NULL. Ingen fejl fra tomt frys-felt.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| 1 | Slå frys-toggle fra | Frys-felt grår ud, input deaktiveres |
| 2 | Køl: 4°C | Badge: ✅ OK. Ingen afvigelse-sektion |
| 3 | Godkend alt → Registrér | |
| ✓ | DB: temperature_frozen_enabled=0, temperature_frozen_value=NULL, temperature_frozen_ok=NULL | |
| ✓ | DB: temperature_cool_enabled=1, temperature_cool_value=4, temperature_cool_ok=1 | |
| ✓ | Whiteboard data: temperature_frozen_enabled=false | |

---

### Scenarie 4 — FVST-toggle afvigelse

**Mål:** Toggle-afvigelse trigger korrekt. Knap re-enables når årsag er valgt.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| 1 | Slå "Dato/holdbarhed kontrolleret" fra | Rækken skifter rød. Afvigelse-sektion vises |
| 2 | ✓ Registrér er **disabled** | Afvigelsesårsag ikke valgt endnu |
| 3 | Slå togglen til igen | Afvigelse-sektion forsvinder. Knap enabled |
| 4 | Slå den fra igen, vælg "Kasseret" | Knap enabled |
| 5 | Registrér | |
| ✓ | DB: date_check_ok=0, has_deviation=1, deviation_type='discarded' | |
| ✓ | DB: labeling_check_ok=1, packaging_check_ok=1 | |

---

### Scenarie 5 — Delvis levering med enkeltvis justering

**Mål:** Vareliste åbnes, mængder justeres, Grocy og shopping list opdateres korrekt per vare.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| 1 | Vælg leverandør, defaults OK | |
| 2 | Tryk "Juster enkeltvis" | Vareliste åbnes (3 varekort) |
| 3 | Vare A (Tomater, 5 kg): sæt modtaget = **3 kg**, status = OK | |
| 4 | Vare B (Salat): status = **Mangler** | Modtaget sættes automatisk til 0 |
| 5 | Vare C: status = OK, modtaget = forventet | |
| 6 | Registrér | |
| ✓ | Vare A: grocy_added=1, addStock amount=3 | |
| ✓ | Vare A: shopping list qty=2 (5−3), ordered_* nulstillet | |
| ✓ | Vare B: grocy_added=0, shopping list beholdt med original qty, ordered_* nulstillet | |
| ✓ | Vare C: grocy_added=1, shopping list item slettet | |

---

### Scenarie 6 — Grocy-fejl på én vare

**Mål:** Delvis Grocy-fejl blokerer ikke registreringen. Fejl logges per vare.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| Mock | Grocy returnerer HTTP 500 på addStock for product_id=2 | |
| 1 | Godkend alt → Registrér | |
| ✓ | Vare 1 (product_id=1): grocy_added=1 | |
| ✓ | Vare 2 (product_id=2): grocy_added=0, grocy_error='HTTP 500' | |
| ✓ | Vare 3 (product_id=3): grocy_added=1 — kørte videre efter fejl på vare 2 | |
| ✓ | goods_receipt.status='approved' — ikke blokeret af fejlen | |
| ✓ | UI viser: "⚠️ 1 vare fejlede — ret manuelt i Grocy" | |

---

### Scenarie 7 — Webhook fejler

**Mål:** Whiteboard-fejl blokerer ikke brugeren. Fejl logges i webhook_log.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| Mock | `whiteboard_webhook_url` sat, endpoint returnerer HTTP 503 | |
| 1 | Fuld OK-registrering | Succès-overlay vises — ikke blokeret |
| ✓ | goods_receipt.status='approved' | |
| ✓ | `webhook_log`: ny række, status_code=503, error sat | |
| ✓ | goods_receipt.whiteboard_synced_at=NULL | |
| ✓ | UI viser ingen fejlbesked om Whiteboard | |

---

### Scenarie 8 — bonv2_only mode

**Mål:** Ingen webhook sendes når URL er tom. Grocy opdateres normalt.

| # | Handling | Forventet resultat |
|---|----------|--------------------|
| Setup | `whiteboard_webhook_url` = '' i settings-tabel | |
| 1 | Fuld OK-registrering | |
| ✓ | `webhook_log`: ingen nye rækker | |
| ✓ | Grocy: lager opdateret korrekt | |
| ✓ | goods_receipt.whiteboard_synced_at=NULL | |

---

### Verifikationskommandoer

```bash
# ── Bon v2 ────────────────────────────────────────────────────────

# Seneste receipt
sqlite3 /opt/bon-v2/data/bon.db "
  SELECT id, receipt_number, supplier_name, received_at,
         temperature_cool_value, temperature_cool_ok,
         temperature_frozen_value, temperature_frozen_ok,
         has_deviation, deviation_type, status
  FROM goods_receipts ORDER BY id DESC LIMIT 1;
"

# Items for seneste receipt
sqlite3 /opt/bon-v2/data/bon.db "
  SELECT product_name, expected_quantity, received_quantity,
         unit, status, grocy_added, grocy_error
  FROM goods_receipt_items
  WHERE receipt_id = (SELECT MAX(id) FROM goods_receipts);
"

# Webhook log
sqlite3 /opt/bon-v2/data/bon.db "
  SELECT url, status_code, error, sent_at
  FROM webhook_log ORDER BY id DESC LIMIT 5;
"

# ── Grocy (grocytest) ─────────────────────────────────────────────

# Lagerstatus for testvarer
sqlite3 /var/www/grocytest/data/grocy.db "
  SELECT product_id, amount FROM stock_current
  WHERE product_id IN (1,2,3);
"

# Shopping list — ordered_* felter efter modtagelse
sqlite3 /var/www/grocytest/data/grocy.db "
  SELECT id, product_id, amount,
         userfield_ordered_at, userfield_ordered_supplier, userfield_ordered_varenr
  FROM shopping_list WHERE product_id IN (1,2,3);
"

# ── Whiteboard ────────────────────────────────────────────────────

sqlite3 /var/www/html/whiteboard/db/whiteboard.sqlite "
  SELECT id, user, registration_type, ts, data
  FROM item_log
  WHERE registration_type = 'varemodtagelse'
  ORDER BY id DESC LIMIT 1;
"
```

---

## Modtagelseslog (august 2026)

Registreringerne blev gemt korrekt, men **ingen visning i Bon v2 læste dem** —
`fetchGoodsReceipts()` havde nul forbrugere. Webhooken til Whiteboard var derfor
i praksis det eneste vindue ind til dem, og den var slukket (`whiteboard_webhook_url`
tom siden migration 035 blev seedet 11. april 2026). Resultat: fem registreringer
mellem maj og august var usynlige fra det øjeblik succes-skærmen forsvandt, og
køkkenet gik tilbage til Whiteboards egen formular — den uden lagerdelen.

Tilføjet:

| Hvad | Hvor |
|------|------|
| 🗂 Modtagelseslog — liste + detalje med FVST-data, varer og foto | `shared/varemodtagelse.js` (samme container, virker i køkken + mobil) |
| Loggen kan åbnes selvom Grocy er nede | `initVaremodtagelse` catch-gren — dokumentationen er uafhængig af Grocy |
| Webhook-URL kan sættes uden SQL + status og forsøgslog | Settings → Integrationer → Whiteboard |
| `whiteboard: { configured, dispatched }` i POST-svaret | `routes/goods-receipts.js` — `webhook_sent`/`webhook_dispatched` stod altid på `true`, også når intet blev sendt (bevaret som deprecated) |
| `GET /webhook-log`, `POST /:id/resend-webhook` | do. — gensend nægter når `whiteboard_synced_at` er sat (Whiteboard afviser ikke dubletter) |
| Backfill af efterslæb | `scripts/resend-goods-receipt-webhooks.js` (dry-run default) |
| Regressionstest | `scripts/test-goods-receipt-webhook.js` — 27 asserts, mutations-testet |

**Driftsnote:** feltet skal pege på `/api/events`, ikke på Whiteboards forside.
En URL uden stien giver et 404 der ligner "noget blev sendt".

---

## Udskydes

| Feature | Hvornår |
|---------|---------|
| PDF-eksport til Fødevarestyrelsen | Fase 7 |
| Webhook retry-job (automatisk genforsøg) | Fase 7 — indtil da: gensend-knappen i loggen + backfill-scriptet |
| Kobling til `purchase_orders`-tabel | Indkøb bruger Grocy userfields endnu — `purchase_order_id` nullable og ubrugt i v1 |
| Temperatur-log over tid (kølekæde-rapport) | Fremtid |
