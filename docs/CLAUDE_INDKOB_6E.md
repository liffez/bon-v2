# CLAUDE_INDKOB_6E.md
> Spec for Fase 6e — Indkøb: bugfixes, sporbarhed og forberedelse til varemodtagelse
> Læs `CLAUDE_INDKOB.md` og `CLAUDE_SETTINGS_INDKOB.md` FØR du begynder.
> Berørte filer: `shared/indkob.js`, `routes/orders.js`, `routes/horkram.js`,
> `shared/indkob_settings.js`, `db/migrations/035_indkob_fixes.sql`

---

## Baggrund

Under review af Fase 6b+6c er der identificeret 5 konkrete problemer:

1. Feltnavnsmismatch gør at Hørkram-ordrer oprettes uden linjer i databasen
2. Valgt barcode/varenummer gemmes ikke på ordrelinjen — manglende sporbarhed
3. Kurv-kald til Hoka fejler fra anden vare og frem (mixed format-fejl)
4. Ingen vej til at tilføje en ekstra pakstørrelse til et produkt der allerede har HK-barcode
5. `goods_receipts`-tabeller mangler — nødvendige til næste sprint (varemodtagelse)

Alle fem fixes er afgrænsede og uafhængige af hinanden.

---

## Fix 1 — `lines` vs `items` feltnavnsmismatch

**Problem:**
`_ibGotoCart` i `shared/indkob.js` sender `lines: [...]` til `createPendingOrder`,
men `routes/orders.js` POST-handler læser `items` fra request body.
Hørkram-ordrer opretter derfor en PO uden linjer i `purchase_order_lines`.
`ordered_*` userfields i Grocy sættes stadig korrekt (separat kald),
så varemodtagelse virker — men PO-historikken er tom for Hørkram-bestillinger.

**Fil:** `shared/indkob.js`, funktion `_ibGotoCart` (~linje 1346)

**Find:**
```js
await createPendingOrder({
    supplier_id: g.supplierId,
    grocy_location_id: parseInt(groupKey),
    lines: lines,
});
```

**Erstat med:**
```js
await createPendingOrder({
    supplier_id: g.supplierId,
    grocy_location_id: parseInt(groupKey),
    items: lines,
});
```

**Verificér:** Efter fix skal `GET /api/orders/pending/:id` returnere `lines`-array
med korrekt antal elementer for en Hørkram-bestilling.

---

## Fix 2 — `barcode_value` gemmes ikke på ordrelinjer

**Problem:**
`barcode` er til stede i hvert item-objekt der sendes til `POST /api/orders/pending`,
men `purchase_order_lines` INSERT'en har ingen kolonne til det.
Varenummeret bruges kun til e-mail-teksten — det gemmes aldrig i databasen.
PO-historik og fremtidig sporbarhed mangler derfor hvilket varenummer der blev bestilt.

### Migration 035 (delvis — se også Fix 5)

**Fil:** `db/migrations/035_indkob_fixes.sql`

```sql
-- Fix 2: Varenummer på ordrelinjer
ALTER TABLE purchase_order_lines ADD COLUMN barcode_value TEXT;
```

### `routes/orders.js`

**Find** INSERT i `POST /pending` (~linje 133):
```js
const insertLine = db.prepare(`
    INSERT INTO purchase_order_lines (
        purchase_order_id, supplier_product_id, item_id,
        quantity_ordered, unit_quantity, price_per_pack, line_total,
        shopping_list_id, grocy_product_id, grocy_shopping_list_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
```

**Erstat med:**
```js
const insertLine = db.prepare(`
    INSERT INTO purchase_order_lines (
        purchase_order_id, supplier_product_id, item_id,
        quantity_ordered, unit_quantity, price_per_pack, line_total,
        shopping_list_id, grocy_product_id, grocy_shopping_list_id,
        barcode_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
```

**Find** `.run(...)` kaldet umiddelbart efter:
```js
insertLine.run(
    orderId,
    item.supplier_product_id || null,
    item.item_id || item.product_id || item.grocy_product_id || null,
    item.quantity_ordered || item.quantity || 0,
    item.unit_quantity || null,
    item.price_per_pack || null,
    item.line_total || null,
    null,
    item.grocy_product_id || null,
    item.grocy_shopping_list_id || null
);
```

**Erstat med:**
```js
insertLine.run(
    orderId,
    item.supplier_product_id || null,
    item.item_id || item.product_id || item.grocy_product_id || null,
    item.quantity_ordered || item.quantity || 0,
    item.unit_quantity || null,
    item.price_per_pack || null,
    item.line_total || null,
    null,
    item.grocy_product_id || null,
    item.grocy_shopping_list_id || null,
    item.barcode || item.varenr || null
);
```

**Opdatér også `getOrderWithLines`** så `barcode_value` returneres i GET-svaret:
```js
order.lines = db.prepare(`
    SELECT pol.*, pol.barcode_value,
           sp.product_name as supplier_product_name, sp.supplier_sku
    FROM purchase_order_lines pol
    LEFT JOIN supplier_products sp ON pol.supplier_product_id = sp.id
    WHERE pol.purchase_order_id = ?
`).all(orderId);
```

**Verificér:** `GET /api/orders/pending/:id` skal returnere `barcode_value`
på hver linje for både Hørkram- og manuel bestilling.

---

## Fix 3 — Hoka kurv fejler fra anden vare

**Problem:**
`PUT /api/horkram/basket` erstatter hele kurven. Eksisterende varer
hentes og merges med nye inden PUT — men de to typer ender i
forskellige formater (`SalesUnitIndex` vs `SalesUnit`).
Hoka returnerer fejl når body indeholder begge formater i samme array.
Første vare virker (tom kurv), anden og frem fejler.

**Fil:** `routes/horkram.js`

Tre præcise ændringer er dokumenteret i `docs/FIX_horkram_basket.md`.
Anvend samtlige tre ændringer nøjagtigt som beskrevet der — ingen afvigelser.

**Verificér:**
1. Læg vare A i kurven → `{ ok: true, lineCount: 1 }`
2. Læg vare B i kurven → `{ ok: true, lineCount: 2 }`
3. Server-console: andet kald logger `Eksisterende kurv: 1 gyldige linjer`

---

## Fix 4 — Settings: tilføj ekstra pakstørrelse til eksisterende produkt

**Problem:**
"Ny kobling" i Tab 3 viser kun Grocy-produkter der ingen HK-barcode har.
Der er ingen vej til at tilføje en ekstra barcode (fx ny pakstørrelse)
til et produkt der allerede er koblet. Eneste omvej er Tab 3 → Opslag
→ søg varenr → kobl — det er skjult og uintuitiv.

**Fil:** `shared/indkob_settings.js`, funktion `_isRenderHkAllLinks`

### Ny tabel-struktur: grupperet per Grocy-produkt

Erstat den flade tabel med en produktgruppestruktur:

```
┌─ Alle Hørkram-koblinger ──────────────────────────────────┐
│ [Søg produkt...]                                           │
│                                                            │
│  Smør, usaltet Lurpak                  [+ Pakstørrelse]   │
│  ┌──────────┬────────────┬───────┬──────────┬──────────┐  │
│  │ Varenr.  │ Pakkeform  │ Enhed │ Kr/kg    │ Foretr.  │  │
│  ├──────────┼────────────┼───────┼──────────┼──────────┤  │
│  │ 245801   │ 500g×20    │ ks    │ 8,9 kr   │ [★] [✕] │  │
│  │ 312445   │ 500g×10    │ st    │ 9,2 kr   │ [☆] [✕] │  │
│  └──────────┴────────────┴───────┴──────────┴──────────┘  │
│                                                            │
│  Fløde 38% Arla                        [+ Pakstørrelse]   │
│  ┌──────────┬────────────┬───────┬──────────┬──────────┐  │
│  │ 118342   │ 1 liter    │ st    │ 18 kr    │ [★] [✕] │  │
│  └──────────┴────────────┴───────┴──────────┴──────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Gruppering

```js
// Byg produktgrupper fra _isAllBarcodes
var hkBcs = _isAllBarcodes.filter(_isIsHkBarcode);
var groups = {};
hkBcs.forEach(function(bc) {
    if (!groups[bc.product_id]) {
        var prod = _isAllProducts.find(function(p) { return p.id === bc.product_id; });
        groups[bc.product_id] = { product: prod, barcodes: [] };
    }
    groups[bc.product_id].barcodes.push(bc);
});
```

### "[+ Pakstørrelse]" knap

Klik åbner et inline søgepanel under produktgruppen — samme søgemekanik som
"Søg og kobl" i "Ny kobling":

1. Brugeren søger i Hoka (varenr eller navn)
2. Resultater vises inline med navn, varenr, pakkeform
3. Klik "Kobl" → `POST /api/grocy/product-barcodes` med:
   ```js
   {
     product_id: groupProductId,
     barcode: hokaProduct.varenummer,
     shopping_location_id: hkShopLocId,  // samme som eksisterende HK-barcodes
     note: hokaProduct.name,
     last_price: hokaProduct.pricePerUnit,
   }
   ```
4. Sæt userfields (`supplier_unit_code`, `supplier_unit_qty`) fra Hokas salesUnits
5. Reload `_isAllBarcodes` og re-render

### Slet-knap [✕]

Klik på [✕] → bekræftelsesdialog: "Fjern koblingen til varenr. 245801?" →
`DELETE /api/grocy/product-barcodes/:id`

**Ny endpoint der mangler:**
```
DELETE /api/grocy/product-barcodes/:id
```

Tilføjes i `routes/grocy.js`:
```js
router.delete('/product-barcodes/:id', handle(async (req, res) => {
    await grocy.deleteProductBarcode(parseInt(req.params.id));
    res.json({ ok: true });
}));
```

Og i `services/grocyAdapter.js`:
```js
async deleteProductBarcode(id) {
    await this.grocyDelete(`/objects/product_barcodes/${id}`);
    this.invalidateCache('productBarcodes');
}
```

**Verificér:**
- Produkt med 1 barcode: vises som gruppe med én række + [+ Pakstørrelse]
- Tilføj pakstørrelse → ny række vises straks i gruppen
- Slet → rækken forsvinder, produktgruppen forbliver hvis andre barcodes
- Slet sidste barcode → produktgruppen forsvinder

---

## Fix 5 — Forbered tabeller til varemodtagelse

**Problem:**
Varemodtagelse bygges i næste sprint. Skema-ændringer laves nu
så næste sprint ikke kræver en migration midt i implementeringen.

**Fil:** `db/migrations/035_indkob_fixes.sql` (samme fil som Fix 2)

```sql
-- Fix 5: Goods receipts tabeller til varemodtagelse (næste sprint)

CREATE TABLE IF NOT EXISTS goods_receipts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_number      TEXT NOT NULL,
    supplier_name       TEXT NOT NULL,
    receiver_name       TEXT NOT NULL,
    location_id         INTEGER REFERENCES locations(id),
    temperature         REAL,
    temp_ok             INTEGER NOT NULL DEFAULT 1,
    date_check          INTEGER NOT NULL DEFAULT 1,
    label_check         INTEGER NOT NULL DEFAULT 1,
    packaging_check     INTEGER NOT NULL DEFAULT 1,
    has_deviation       INTEGER NOT NULL DEFAULT 0,
    deviation_type      TEXT,
    deviation_note      TEXT,
    photo_path          TEXT,
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved')),
    whiteboard_event_id TEXT,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by_user_id  INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id          INTEGER NOT NULL REFERENCES goods_receipts(id),
    grocy_product_id    INTEGER NOT NULL,
    product_name        TEXT NOT NULL,
    ordered_varenr      TEXT,       -- snapshot fra ordered_varenr userfield ved bestilling
    quantity_expected   REAL,
    quantity_received   REAL NOT NULL DEFAULT 0,
    status              TEXT NOT NULL DEFAULT 'ok'
                        CHECK (status IN ('ok','missing','wrong','damaged')),
    grocy_added         INTEGER NOT NULL DEFAULT 0,
    grocy_error         TEXT,
    note                TEXT
);

CREATE TABLE IF NOT EXISTS webhook_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT NOT NULL,
    payload     TEXT NOT NULL,
    status_code INTEGER,
    error       TEXT,
    sent_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    retry_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('whiteboard_webhook_url',    '', 'URL til Whiteboard /api/events (tom = ingen sync)'),
  ('whiteboard_webhook_secret', '', 'HMAC-secret til webhook-validering');
```

**Verificér:** `sqlite3 bon.db ".tables"` viser `goods_receipts`, `goods_receipt_items`, `webhook_log`.

---

## Verificering af multi-barcode chips

**Opgave:** Test på grocytest-instansen at to HK-barcodes på samme produkt
vises korrekt som to chips i `indkob.js`.

**Fremgangsmåde:**
1. Vælg et testprodukt i grocytest der har én HK-barcode
2. Tilføj en anden HK-barcode til samme produkt via Settings → Hørkram → Alle koblinger → [+ Pakstørrelse]
3. Tilføj produktet til Grocy shopping list
4. Åbn indkøbssiden
5. Verificér at begge chips vises i Hørkram-gruppen
6. Skift chip → antal genberegnes korrekt → pris/kg opdateres

**Forventet resultat:** To chips, korrekt sortering (foretrukken/aftale/pris), qty-genberegning ved chip-skift.

---

## Rækkefølge for implementering

1. Migration `035_indkob_fixes.sql` (Fix 2 + Fix 5) — kør først
2. Fix 3 — `routes/horkram.js` kurv-fix (selvstændig, ingen afhængigheder)
3. Fix 1 — `shared/indkob.js` feltnavnsmismatch (én linje)
4. Fix 2 — `routes/orders.js` barcode_value i INSERT
5. Fix 4 — `shared/indkob_settings.js` grupperet tabel + ny endpoint i `routes/grocy.js` + `services/grocyAdapter.js`
6. Verificering af multi-barcode chips på grocytest

---

## Checkliste til CLAUDE.md

```
#### Fase 6e — Indkøb bugfixes (spec: CLAUDE_INDKOB_6E.md)
- [ ] Migration 035_indkob_fixes.sql
- [ ] Fix 1: shared/indkob.js — _ibGotoCart lines→items
- [ ] Fix 2: routes/orders.js — barcode_value på purchase_order_lines
- [ ] Fix 3: routes/horkram.js — kurv mixed-format fix (FIX_horkram_basket.md)
- [ ] Fix 4: shared/indkob_settings.js — Alle koblinger grupperet + tilføj pakstørrelse
- [ ] Fix 4: routes/grocy.js — DELETE /api/grocy/product-barcodes/:id
- [ ] Fix 4: services/grocyAdapter.js — deleteProductBarcode()
- [ ] Fix 5: goods_receipts + goods_receipt_items + webhook_log tabeller (migration 035)
- [ ] Verificering: multi-barcode chips på grocytest
```
