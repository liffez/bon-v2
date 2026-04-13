# Feature: Web-formular webhook → web_orders indbakke

## Formål

Modtage bestillinger fra hjemmesidens HTML-formular (hostet på Simply.com/WordPress) og gemme dem i en ny `web_orders` tabel som fungerer som indbakke. Herfra behandler personalet dem i Bon v2 og konverterer dem til rigtige bons.

---

## Baggrund

- Bestillingsformularen sender en `POST` med JSON-body til Bon v2's server via en webhook-URL
- Formularen er bygget med formbuilder og genererer felter som `first_name`, `last_name`, `email`, `phone`, `ordertype`, `delivery_date`, `delivery_time`, `address_text`, `validatedAddress` (DAWA-objekt), `pax`, `wishes`, `ean_info` m.fl.
- Web-forespørgsler kan ikke gå direkte i `bons` da de mangler `bon_number`, `status_id`, `location_id` og skal bekræftes af personalet først

---

## 1. Migration: `web_orders` tabel

Opret ny migration-fil (næste nummer i sekvensen), f.eks. `0XXX_web_orders.sql`:

```sql
CREATE TABLE web_orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    status          TEXT NOT NULL DEFAULT 'ny'
                    CHECK (status IN ('ny', 'konverteret', 'afvist')),

    -- Kerneinformation fra formularen
    order_type      TEXT CHECK (order_type IN ('catering', 'pickup')),
    customer_name   TEXT,
    customer_email  TEXT,
    customer_phone  TEXT,
    company         TEXT,
    delivery_date   TEXT,           -- ISO dato-streng, fx "2025-06-15"
    delivery_time   TEXT,           -- "11:30"
    address_text    TEXT,           -- Fri tekst fra DAWA
    address_lat     REAL,           -- Fra validatedAddress.lat
    address_lon     REAL,           -- Fra validatedAddress.lon
    address_postnr  TEXT,           -- Fra validatedAddress.postnr
    pax             INTEGER,
    wishes          TEXT,
    ean_info        TEXT,

    -- Rådata — hele JSON-body fra POST, så intet går tabt
    raw_data        TEXT NOT NULL,

    -- Kobling til bon når den konverteres
    bon_id          INTEGER REFERENCES bons(id),

    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_web_orders_status ON web_orders(status);
CREATE INDEX idx_web_orders_date   ON web_orders(delivery_date);
```

---

## 2. Backend: Webhook route

### Fil
`routes/webhook.js` (eller tilsvarende, tilpas til projektets struktur)

### Endpoint
`POST /webhook/bestilling`

### Sikkerhed
Tjek `x-webhook-secret` header mod `process.env.WEBHOOK_SECRET`

### Logik
1. Valider secret header → 401 hvis forkert
2. Parse JSON-body
3. Map formular-felter til `web_orders`-kolonner
4. Indsæt række med `status = 'ny'`
5. Send SSE-event `web_order_new` så dashboardet reagerer uden reload
6. Returnér `{ ok: true }`

### Eksempel på mapping
```js
const b = req.body;
const addr = b.validatedAddress || {};

db.prepare(`
  INSERT INTO web_orders
    (order_type, customer_name, customer_email, customer_phone,
     company, delivery_date, delivery_time,
     address_text, address_lat, address_lon, address_postnr,
     pax, wishes, ean_info, raw_data)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`).run(
  b.ordertype || null,
  [b.first_name, b.last_name].filter(Boolean).join(' ') || null,
  b.email || null,
  b.phone || null,
  b.company || null,
  b.delivery_date || null,
  b.delivery_time || null,
  addr.tekst || b.address_text || null,
  addr.lat || null,
  addr.lon || null,
  addr.postnr || null,
  parseInt(b.pax) || null,
  b.wishes || null,
  b.ean_info || null,
  JSON.stringify(b)
);
```

### CORS
Tillad kun requests fra hjemmesidens domæne:
```js
cors({ origin: 'https://www.ristetrug.dk' })
```

---

## 3. SSE event (valgfrit men anbefalet)

Send et event til alle tilsluttede klienter når en ny web-ordre ankommer, så dashboardet kan vise en notifikation eller opdatere en tæller uden reload:

```js
broadcastSSE({ type: 'web_order_new', count: nyAntalUbehandlede });
```

Tilpas til projektets eksisterende SSE-implementation.

---

## 4. Fremtidigt (ikke del af denne opgave)

- UI i Bon v2 til at se og behandle `web_orders` med `status = 'ny'`
- "Konvertér til bon"-funktion der opretter kunde, adresse og bon ud fra `web_orders`-rækken og sætter `bon_id` + `status = 'konverteret'`

---

## Afhængigheder

- `WEBHOOK_SECRET` skal være sat i `.env` på Hetzner-serveren
- CORS-origin skal matche det faktiske domæne på formularen
- Migrations-systemet kører via `_migrations`-tabellen — følg eksisterende mønster
