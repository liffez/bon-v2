# Bon v2 — Varemodtagelse
*Opdateret: april 2026*

---

## Formål

Varemodtagelse dækker to separate behov der udføres i ét samlet flow på én side:

1. **Fødevarekontrol** — dokumentation til Fødevarestyrelsen (leverandør, temperatur, tjek, foto)
2. **Lager-opdatering** — læg modtagne varer på lager i Grocy

De to sektioner er på samme side. Lager-sektionen er visuelt låst (viser "Vælg leverandør ovenfor") indtil leverandør er valgt — men der er intet hard server-side krav om rækkefølge. Backend modtager og gemmer alt ved ét samlet `POST /api/goods-receipts`.

---

## Tre driftsmodes

Styres via `system_settings`. Ingen kodeændring ved skift af mode.

| Mode | Hvad sker | Konfiguration |
|------|-----------|---------------|
| `bonv2_only` | Gemmer i Bon v2, ingen webhook | `whiteboard_webhook_url` er tom |
| `whiteboard_only` | Whiteboard bruges som i dag — ingen Bon v2 | Bon v2 ikke i brug |
| `combined` | Gemmer i Bon v2 + sender webhook til Whiteboard | `whiteboard_webhook_url` sat |

**Default for nye installationer:** `bonv2_only`

---

## Placering i UI

Varemodtagelse er **tab 2** i `kitchen/purchasing.html`:
```
kitchen/purchasing.html  →  [ Indkøb ]  [ Varemodtagelse ]
```

Åbnes også:
- Fra mobilshellet (`/m/`) via bundnavigation → Mere → Varemodtagelse
- Via deep-link `?open=varemodtagelse`
- Fra indkøbslisten når en leverance er klar til modtagelse

---

## UI-design

**Baseret på mockup `varemodtagelse_v4.html`.**

Touch-first, max-width 500px, én samlet scrollbar side. Fungerer på iPad, telefon og desktop.
Designtokens arves fra `shared/bon-base.css`. Zonen er `zone-kitchen`.

---

## Siden — layout og flow

```
┌─────────────────────────────────────────┐
│  ← Bon v2    📦 Varemodtagelse    🗂     │
├─────────────────────────────────────────┤
│  ─────────── FØDEVAREKONTROL ────────── │
├─────────────────────────────────────────┤
│  👤 Registreret af: [Leif ▾]           │
├─────────────────────────────────────────┤
│  Leverandør 📡 Grocy                    │
│  [Søren's Grønt — 3 varer klar    ▾]   │
├─────────────────────────────────────────┤
│  🧊 Kølevarer  max. 5°C      [●  ON]   │
│  [  3,0  °C  ]  [ ✅ OK ]              │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
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
│  [  Godkend alt  ]                     │
│  [ ▸ Juster enkeltvis hvis noget afviger ] │
├─────────────────────────────────────────┤
│  (vareliste — collapsed som default)    │
├─────────────────────────────────────────┤
│  [Annuller]    [✓ Registrér varemodtagelse] │
└─────────────────────────────────────────┘
```

---

## Temperaturer

### To separate felter

| Felt | Grænse | Default | Enhed |
|------|--------|---------|-------|
| Kølevarer | max. 5°C | 3°C | °C |
| Frysvarer | max. -18°C | -20°C | °C |

Begge felter vises og er aktive som standard. Hvert felt har en lille toggle (`enabled`) der slår feltet fra hvis leverancen ikke indeholder den pågældende varetype. Når disabled: feltet grå, gemmes som `NULL` i DB.

### Temperatur-badge

Vises live ved siden af hvert felt:
- Ingen input: `—`
- Inden for grænse: `✅ OK` (grøn)
- Over grænse: `❌ FEJL` (rød) → afvigelse-sektion vises automatisk

### Afvigelse trigger

Afvigelse-sektionen vises automatisk når:
- Køl-temp > 5°C (og køl er enabled)
- Frys-temp > -18°C (og frys er enabled)
- Én eller flere FVST-toggles er slået fra

---

## Afvigelse-sektion

Vises automatisk — brugeren kan ikke lukke den manuelt.

Radioknapper:
- Returneret til leverandør
- Ingen reel risiko — anvendes
- Kasseret
- Leverandør kontaktet
- Andet

Fritekst-felt: "Bemærkning ved afvigelse" (påkrævet når afvigelse er aktiv).

Validering: `✓ Registrér`-knappen forbliver disabled hvis afvigelse-sektion er synlig men ingen radioknap er valgt.

---

## Lager-sektion

### Data-source

Varelisten bygges fra Grocy shopping list:
```
GET /api/grocy/shopping-list
→ filtrer: ordered_supplier == valgt leverandør OG ordered_varenr != ''
→ aggregér: gruppér på product_id, summér amount
→ vis som varekort
```

Lager-sektionen viser "Vælg leverandør ovenfor" indtil leverandør er valgt.

### Godkend alt (primær handling)

Øverst i lager-sektionen vises en banner med "Godkend alt"-knap:

```
┌──────────────────────────────────────────┐
│  ✓ Alt modtaget som bestilt              │
│  Alle varer lægges på lager              │
│                         [ Godkend alt ]  │
│  [ ▸ Juster enkeltvis hvis noget afviger ]│
└──────────────────────────────────────────┘
```

"Godkend alt" sætter alle varer til `status: ok` og `received_quantity = expected_quantity`. Brugeren er færdig — scroller ned og trykker `✓ Registrér`.

"Juster enkeltvis"-knappen er **fuld bredde med ordentlig touch-target** (min. 44px høj) og åbner varelisten.

### Vareliste (collapsed som default)

Åbnes via "Juster enkeltvis"-knappen. Per vare:
- Varenavn + forventet mængde
- Mængde-justeringskontrol (−/+/input), forudfyldt med forventet mængde
- Status-knapper: ✓ OK / − Mangler / ↔ Forkert / ✕ Skadet
- Notefelt vises automatisk ved ikke-OK status

Manuel tilføjelse af ekstra varer via `[+ Tilføj vare manuelt]`.

### Regler per varestatus ved Registrér

| Status | Grocy addStock | Shopping list |
|--------|---------------|---------------|
| `ok` — fuld levering | ✅ `received_quantity` | Slet item |
| `ok` — delvis (modtaget < forventet) | ✅ `received_quantity` | Opdatér qty til rest, nulstil `ordered_*` |
| `missing` — intet modtaget | ❌ Spring over | Nulstil `ordered_*`, behold på liste |
| `wrong` — forkert (beholdt) | ✅ `received_quantity` | Slet item |
| `wrong` — forkert (returneret) | ❌ Spring over | Nulstil `ordered_*`, behold på liste |
| `damaged` — kasseret | ❌ Spring over | Nulstil `ordered_*`, behold på liste |
| `damaged` — accepteret | ✅ `received_quantity` | Slet item |

"Nulstil `ordered_*`" = slet `ordered_varenr`, `ordered_at`, `ordered_qty`, `ordered_supplier` fra Grocy shopping list item.

### Grocy-write

```js
POST /api/grocy/stock/products/{grocy_product_id}/add
{
  amount: received_quantity,
  best_before_date: null,       // Grocy bruger default_due_days per produkt
  location_id: activeLocationId // HQ=1, Trailer=2 — arves fra aktiv lokation
}
```

Kald køres **sekventielt** (ikke parallelt) så vi altid ved præcis hvilke varer der lykkedes.

### Fejlhåndtering ved delvis Grocy-fejl

```
Vare 1 → Grocy OK   → goods_receipt_items.grocy_added = 1
Vare 2 → Grocy FEJL → goods_receipt_items.grocy_added = 0, grocy_error = 'HTTP 500'
Vare 3 → Grocy OK   → goods_receipt_items.grocy_added = 1  (kører videre)
```

`goods_receipt.status` sættes til `approved` selv ved delvise fejl.
UI viser: `"✅ 2 varer lagt på lager · ⚠️ 1 fejlede (Tomater) — ret manuelt i Grocy"`

---

## Validering

`✓ Registrér`-knappen er disabled indtil:

| Betingelse | Krav |
|-----------|------|
| Bruger | Valgt |
| Leverandør | Valgt |
| Køl-temp | Udfyldt (medmindre køl disabled) |
| Frys-temp | Udfyldt (medmindre frys disabled) |
| Afvigelsesårsag | Valgt hvis afvigelse-sektion er synlig |

---

## Database — Bon v2

Migration: `025_goods_receipts.sql`

```sql
CREATE TABLE goods_receipts (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_number            TEXT NOT NULL UNIQUE,    -- VR-2026-042
  supplier_name             TEXT NOT NULL,            -- snapshot fra Grocy
  location_id               INTEGER REFERENCES locations(id),
  received_by               INTEGER REFERENCES users(id),
  received_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Køl-temperatur
  temperature_cool_enabled  INTEGER NOT NULL DEFAULT 1,  -- 0 = ikke relevant
  temperature_cool_value    REAL,                         -- NULL hvis disabled
  temperature_cool_ok       INTEGER,                      -- NULL hvis disabled

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
  deviation_type            TEXT,  -- 'returned'|'no_risk'|'discarded'|'supplier_contacted'|'other'
  deviation_note            TEXT,

  photo_path                TEXT,
  notes                     TEXT,
  purchase_order_id         INTEGER,   -- nullable, ubrugt i v1
  whiteboard_synced_at      DATETIME,
  status                    TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved')),
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE goods_receipt_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id        INTEGER NOT NULL REFERENCES goods_receipts(id),
  grocy_product_id  INTEGER,
  product_name      TEXT NOT NULL,   -- snapshot
  expected_quantity REAL,
  unit              TEXT,
  received_quantity REAL,
  status            TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok','missing','wrong','damaged')),
  notes             TEXT,
  grocy_added       INTEGER NOT NULL DEFAULT 0,
  grocy_error       TEXT
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
  ('goods_receipt_number_prefix', 'VR', 'Præfiks for varemodtagelses-numre'),
  ('goods_receipt_number_next',   '1',  'Næste løbenummer'),
  ('whiteboard_webhook_url',      '',   'URL til Whiteboard /api/events (tom = ingen sync)'),
  ('whiteboard_webhook_secret',   '',   'Valgfri HMAC-secret til webhook-validering');
```

---

## API-endpoints — Bon v2

Alle i `routes/goods-receipts.js`.

```
GET    /api/goods-receipts                 Liste, filter: ?from=&to=&supplier=&location=
GET    /api/goods-receipts/:id             Detalje inkl. items
POST   /api/goods-receipts                 Opret + finalize i ét kald
POST   /api/goods-receipts/photo           Upload foto (multipart) → returnerer { path }
GET    /api/goods-receipts/:id/pdf         PDF-rapport (fremtid)
```

**Ét kald — ikke to.**
`POST /api/goods-receipts` modtager al data (fødevarekontrol + vareliste), gemmer goods_receipt + items, trigger sekventiel Grocy-write og afsender webhook. Returnerer `{ id, receipt_number, grocy_results[], webhook_sent }`.

```json
// POST /api/goods-receipts — request body
{
  "supplier_name":              "Søren's Grønt",
  "received_by_user_id":        3,
  "location_id":                1,

  "temperature_cool_enabled":   true,
  "temperature_cool_value":     3.5,
  "temperature_cool_ok":        true,

  "temperature_frozen_enabled": true,
  "temperature_frozen_value":   -20.0,
  "temperature_frozen_ok":      true,

  "date_check_ok":              true,
  "labeling_check_ok":          true,
  "packaging_check_ok":         true,

  "has_deviation":              false,
  "deviation_type":             null,
  "deviation_note":             null,

  "photo_path":                 "/uploads/receipts/vr-2026-042.jpg",
  "notes":                      null,

  "items": [
    {
      "grocy_product_id":   42,
      "product_name":       "Tomater",
      "expected_quantity":  5,
      "received_quantity":  5,
      "unit":               "kg",
      "status":             "ok",
      "notes":              null
    }
  ]
}
```

---

## Webhook til Whiteboard

Udføres asynkront efter DB-skrivning. Fejler webhook → log til `webhook_log`, blokér ikke brugeren.

### Whiteboard modtager kun fødevarekontrol-data — intet om Grocy eller varemængder.

```json
{
  "schema_name": "varemodtagelse",
  "user":        "Leif",
  "supplier":    "Søren's Grønt",
  "data": {
    "temperature_cool_enabled":   true,
    "temperature_cool_value":     3.5,
    "temperature_cool_ok":        true,
    "temperature_frozen_enabled": true,
    "temperature_frozen_value":   -20.0,
    "temperature_frozen_ok":      true,
    "date_check":                 true,
    "labeling_check":             true,
    "packaging_check":            true,
    "photo_path":                 "https://bon.ristetrug.dk/uploads/receipts/vr-2026-042.jpg",
    "deviation":                  "none",
    "deviation_note":             null,
    "bon_v2_receipt_id":          42,
    "bon_v2_receipt_number":      "VR-2026-042"
  }
}
```

`photo_path` er absolut URL — Whiteboard gemmer ingen kopi, linker kun.

### Fejlhåndtering webhook

```js
const webhookUrl = getSetting('whiteboard_webhook_url');
if (!webhookUrl) return; // bonv2_only mode — skip
```

Log fejl til `webhook_log`. Ingen automatisk retry i v1 (udskydes til fase 7).

---

## Foto-håndtering

Upload sker **inden** selve registreringen via:
```
POST /api/goods-receipts/photo   (multipart/form-data)
→ gemmer til /uploads/receipts/vr-tmp-{timestamp}.jpg
→ returnerer { path }
```

`path` medsendes i den endelige `POST /api/goods-receipts` som `photo_path`.
Fil omdøbes til endeligt navn ved finalize: `vr-{receipt_number}-{timestamp}.jpg`.

---

## Filer der oprettes/ændres

| Fil | Handling |
|-----|---------|
| `db/migrations/025_goods_receipts.sql` | Ny — tabeller + settings |
| `routes/goods-receipts.js` | Ny — alle endpoints |
| `services/goodsReceiptWebhook.js` | Ny — webhook-logik |
| `shared/varemodtagelse.js` | Ny — UI-logik, eksporterer `initVaremodtagelse(container)` |
| `shared/varemodtagelse.css` | Ny — styling (touch-first, baseret på mockup v4) |
| `kitchen/purchasing.html` | Allerede wired — ingen ændringer |
| `server.js` | Mount `routes/goods-receipts.js` |

---

## Rækkefølge for implementering

1. **Migration 025** — tabeller og settings
2. **`routes/goods-receipts.js`** — `POST /api/goods-receipts/photo` + `POST /api/goods-receipts`
3. **`shared/varemodtagelse.js`** — UI: leverandør, bruger, temperaturer, toggles, foto
4. **Lager-sektion** — vareliste fra Grocy shopping list, godkend-alt, juster enkeltvis
5. **Grocy-write** — sekventiel addStock + shopping list cleanup
6. **`services/goodsReceiptWebhook.js`** — Whiteboard sync

Trin 1–3 giver komplet fødevarekontrol-dokumentation og kan tages i brug inden Grocy-write er færdig.

---

## Test-matrix

Tests køres på **grocytest**-instansen. Nulstil testdata efter hver kørsel.

### Forudsætninger

```bash
# Grocy testdata — 3 varer klar til modtagelse fra "Testleverandør"
sqlite3 /var/www/grocytest/data/grocy.db "
  UPDATE shopping_list_item SET
    userfield_ordered_at       = datetime('now'),
    userfield_ordered_qty      = 5,
    userfield_ordered_supplier = 'Testleverandør',
    userfield_ordered_varenr   = 'TEST-001'
  WHERE product_id IN (1, 2, 3);
"
# whiteboard_webhook_url sat til Whiteboard-testmiljø (eller tom for bonv2_only)
```

---

### Scenarie 1 — Fuld OK-levering, ingen afvigelse

**Mål:** Happy path. Alt grønt. Intet afvigelsesflow.

| # | Handling | Forventet |
|---|----------|-----------|
| 1 | Vælg bruger "Testbruger" | |
| 2 | Vælg "Testleverandør" | Lager-sektion vises med 3 varer |
| 3 | Køl: 3°C (default) — badge: ✅ OK | |
| 4 | Frys: -20°C (default) — badge: ✅ OK | |
| 5 | Alle 3 FVST-toggles ON | Ingen afvigelses-sektion |
| 6 | Tryk "Godkend alt" | Alle varer markeres OK |
| 7 | Tryk "✓ Registrér" | |
| ✓ | `goods_receipts`: status=approved, has_deviation=0 | |
| ✓ | `goods_receipts`: temperature_cool_value=3, temperature_frozen_value=-20 | |
| ✓ | `goods_receipt_items`: alle 3 rækker, status=ok, grocy_added=1 | |
| ✓ | Grocy lager: alle 3 produkter steget korrekt | |
| ✓ | Grocy shopping list: 3 items slettet | |
| ✓ | Whiteboard `item_log`: ny række, registration_type='varemodtagelse' | |
| ✓ | Whiteboard data: deviation='none', begge temp_ok=true | |

---

### Scenarie 2 — Køl-temperaturafvigelse

**Mål:** Afvigelse trigger, korrekt logning, afvigelsestype gemmes.

| # | Handling | Forventet |
|---|----------|-----------|
| 1 | Udfyld leverandør, bruger | |
| 2 | Køl-temp: **8°C** | Badge: ❌ FEJL, afvigelse-sektion vises |
| 3 | Frys: -20°C | Badge: ✅ OK |
| 4 | Vælg "Leverandør kontaktet" i afvigelse-sektion | |
| 5 | Skriv bemærkning | |
| 6 | Godkend alt → Registrér | |
| ✓ | `goods_receipts`: has_deviation=1, deviation_type='supplier_contacted' | |
| ✓ | `goods_receipts`: temperature_cool_value=8, temperature_cool_ok=0 | |
| ✓ | Whiteboard data: deviation='supplier_contacted', temperature_cool_ok=false | |

---

### Scenarie 3 — Kun kølevarer (frys disabled)

**Mål:** Frys-felt deaktiveret gemmes korrekt som NULL.

| # | Handling | Forventet |
|---|----------|-----------|
| 1 | Slå frys-toggle fra | Frys-felt grår ud |
| 2 | Køl: 4°C | Badge: ✅ OK |
| 3 | Registrér | |
| ✓ | `goods_receipts`: temperature_frozen_enabled=0, temperature_frozen_value=NULL | |
| ✓ | `goods_receipts`: temperature_cool_value=4, temperature_cool_ok=1 | |
| ✓ | Whiteboard data: temperature_frozen_enabled=false | |

---

### Scenarie 4 — FVST-toggle slået fra

**Mål:** Toggle-afvigelse trigger korrekt flow.

| # | Handling | Forventet |
|---|----------|-----------|
| 1 | Slå "Dato/holdbarhed kontrolleret" fra | Række rød, afvigelse-sektion vises |
| 2 | ✓ Registrér er stadig disabled | Afvigelsesårsag ikke valgt endnu |
| 3 | Vælg "Kasseret" | Knap enabled |
| 4 | Registrér | |
| ✓ | `goods_receipts`: date_check_ok=0, has_deviation=1, deviation_type='discarded' | |

---

### Scenarie 5 — Delvis levering (enkeltvis justering)

**Mål:** Vareliste åbnes, mængde justeres, Grocy opdateres korrekt.

| # | Handling | Forventet |
|---|----------|-----------|
| 1 | Tryk "Juster enkeltvis" | Vareliste åbnes |
| 2 | Vare A (Tomater, forventet 5 kg): sæt modtaget = **3 kg**, status = OK | |
| 3 | Vare B (Salat): status = Mangler | Modtaget sættes til 0 |
| 4 | Vare C: status = OK, modtaget = forventet | |
| 5 | Registrér | |
| ✓ | Vare A: grocy_added=1, addStock amount=3 | |
| ✓ | Vare A: shopping list qty opdateret til 2 (rest), ordered_* nulstillet | |
| ✓ | Vare B: grocy_added=0, shopping list beholdt, ordered_* nulstillet | |
| ✓ | Vare C: grocy_added=1, shopping list slettet | |

---

### Scenarie 6 — Grocy-fejl på én vare

**Mål:** Delvis fejl blokerer ikke registreringen.

| # | Handling | Forventet |
|---|----------|-----------|
| Mock | Grocy returnerer HTTP 500 på vare 2 af 3 | |
| ✓ | Vare 1: grocy_added=1 | |
| ✓ | Vare 2: grocy_added=0, grocy_error='HTTP 500' | |
| ✓ | Vare 3: grocy_added=1 (kørte videre) | |
| ✓ | goods_receipt.status = 'approved' | |
| ✓ | UI viser: "⚠️ 1 vare fejlede (Tomater) — ret manuelt i Grocy" | |

---

### Scenarie 7 — Webhook fejler

**Mål:** Whiteboard-fejl blokerer ikke brugeren.

| # | Handling | Forventet |
|---|----------|-----------|
| Mock | Whiteboard-endpoint returnerer HTTP 503 | |
| ✓ | `goods_receipt.status` = approved | Registrering gyldig |
| ✓ | `webhook_log`: ny række med status_code=503, error sat | |
| ✓ | `goods_receipt.whiteboard_synced_at` = NULL | |
| ✓ | Brugeren ser succès-overlay uden fejlbesked om Whiteboard | |

---

### Scenarie 8 — bonv2_only mode (ingen Whiteboard)

**Mål:** Ingen webhook sendes når `whiteboard_webhook_url` er tom.

| # | Handling | Forventet |
|---|----------|-----------|
| Setup | `whiteboard_webhook_url` = '' i settings | |
| 1 | Fuld OK-registrering | |
| ✓ | `webhook_log`: ingen nye rækker | |
| ✓ | Grocy opdateret korrekt | |
| ✓ | `goods_receipt.whiteboard_synced_at` = NULL | |

---

### Verifikationskommandoer

```bash
# Seneste goods_receipt
sqlite3 /opt/bon-v2/data/bon.db \
  "SELECT id, receipt_number, supplier_name,
          temperature_cool_value, temperature_cool_ok,
          temperature_frozen_value, temperature_frozen_ok,
          has_deviation, deviation_type, status
   FROM goods_receipts ORDER BY id DESC LIMIT 1;"

# Items for seneste receipt
sqlite3 /opt/bon-v2/data/bon.db \
  "SELECT product_name, expected_quantity, received_quantity,
          status, grocy_added, grocy_error
   FROM goods_receipt_items
   WHERE receipt_id = (SELECT MAX(id) FROM goods_receipts);"

# Webhook log
sqlite3 /opt/bon-v2/data/bon.db \
  "SELECT url, status_code, error, sent_at
   FROM webhook_log ORDER BY id DESC LIMIT 5;"

# Grocy — lagerstatus for testvarer
sqlite3 /var/www/grocytest/data/grocy.db \
  "SELECT product_id, amount FROM stock_current
   WHERE product_id IN (1,2,3);"

# Grocy — shopping list efter modtagelse
sqlite3 /var/www/grocytest/data/grocy.db \
  "SELECT id, product_id, amount,
          userfield_ordered_at, userfield_ordered_supplier
   FROM shopping_list_item
   WHERE product_id IN (1,2,3);"

# Whiteboard — seneste varemodtagelse
sqlite3 /var/www/html/whiteboard/db/whiteboard.sqlite \
  "SELECT id, user, registration_type, ts, data
   FROM item_log
   WHERE registration_type='varemodtagelse'
   ORDER BY id DESC LIMIT 1;"
```

---

## Udskydes

| Feature | Hvornår |
|---------|---------|
| PDF-eksport til Fødevarestyrelsen | Fase 7 |
| Webhook retry-job (automatisk genforsøg) | Fase 7 |
| Kobling til Purchase Orders (PO-tabel) | Indkøb bruger Grocy userfields endnu |
| Temperatur-log over tid (kølekæde-rapport) | Fremtid |
