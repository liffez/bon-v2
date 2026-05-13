# PATCH_C_api_consistency_fixes.md (v2 — omskrevet)

> Patch C til Bon v2 — fire "API consistency"-fixes opdaget under
> T_INDKOB_SETUP og T_VAREMODTAGELSE_FULL. Alle er samme mønster:
> validation før mutation, eller mapping af forkert error-kode.
>
> **v2 omskrevet** efter 5 problemer i v1:
> - C-1: `validTypes` skulle have inkluderet `'form'` (eksisterer i koden)
> - C-2: PATCH `/suppliers/:id` har samme bug — v1 ramte kun POST
> - C-3: Response-form for duplikat-detection var forkert
> - C-4: DELETE-route bruger `grocy_location_id` som id, ikke supplier_id
> - C-5: Find-blokken matchede ikke faktisk kode (`...`-placeholder)

---

## Sammenfattende

| # | Finding | Type | Fil |
|---|---|---|---|
| **#013a** | POST suppliers falder tilbage til 'manual' ved ugyldig integration_type | Validation | `routes/purchasing.js:226` |
| **#013b** | **PATCH suppliers** har samme bug — `continue` skipper silently | Validation | `routes/purchasing.js:252` |
| **#014** | supplier_grocy_locations bruger INSERT OR REPLACE silently | Validation | `routes/purchasing.js:137-140` |
| **#015** | Grocy 500 ved duplikat product_barcode bobler op til klient | Error-mapping | `services/grocyAdapter.js:createProductBarcode` |
| **F28** | Ukendt item-status falder igennem i goods-receipts | Validation | `routes/goods-receipts.js` (efter F37-blok) |

#016 droppes — flere `is_preferred='1'` på samme pid er korrekt design.

---

## Ændring 1 af 4 — #013: Validate integration_type (POST + PATCH)

**Problem:** To steder skipper ugyldig `integration_type` silently:

- **POST `/suppliers`** (linje 226): `validTypes.includes(integration_type) ? integration_type : 'manual'`
- **PATCH `/suppliers/:id`** (linje 252): `if (... && !validTypes.includes(req.body[key])) continue;`

Begge er silent — klient får 201/200 selvom deres input blev ignoreret eller ændret. v1's patch ramte kun POST. v2 fixer begge.

### Find blok 1 — POST `/suppliers` (linje 225-226 i `routes/purchasing.js`):

```javascript
    const validTypes = ['api', 'form', 'email', 'manual', 'webshop', 'intern'];
    const type = validTypes.includes(integration_type) ? integration_type : 'manual';
```

### Erstat med:

```javascript
    const validTypes = ['api', 'form', 'email', 'manual', 'webshop', 'intern'];

    // Hvis klient eksplicit har sendt en integration_type, skal den være gyldig.
    // Undefined/null er OK — defaulter til 'manual'.
    if (integration_type !== undefined && integration_type !== null
        && !validTypes.includes(integration_type)) {
        return res.status(400).json({
            error: `Ugyldig integration_type: '${integration_type}'. Tilladte: ${validTypes.join(', ')}`
        });
    }
    const type = integration_type || 'manual';
```

### Find blok 2 — PATCH `/suppliers/:id` (linje 246-256):

```javascript
    const validTypes = ['api', 'form', 'email', 'manual', 'webshop', 'intern'];
    const fields = {};
    const allowed = ['name', 'integration_type', 'contact_email', 'contact_phone', 'webshop_url', 'notes', 'is_active'];

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            if (key === 'integration_type' && !validTypes.includes(req.body[key])) continue;
            if (key === 'name' && !req.body[key].trim()) continue;
            fields[key] = req.body[key];
        }
    }
```

### Erstat med:

```javascript
    const validTypes = ['api', 'form', 'email', 'manual', 'webshop', 'intern'];
    const fields = {};
    const allowed = ['name', 'integration_type', 'contact_email', 'contact_phone', 'webshop_url', 'notes', 'is_active'];

    for (const key of allowed) {
        if (req.body[key] !== undefined) {
            // Validér i stedet for at skippe silently
            if (key === 'integration_type' && !validTypes.includes(req.body[key])) {
                return res.status(400).json({
                    error: `Ugyldig integration_type: '${req.body[key]}'. Tilladte: ${validTypes.join(', ')}`
                });
            }
            if (key === 'name' && (typeof req.body[key] !== 'string' || !req.body[key].trim())) {
                return res.status(400).json({ error: 'Navn skal være en ikke-tom streng' });
            }
            fields[key] = req.body[key];
        }
    }
```

**Note:** `validTypes` inkluderer `'form'` (eksisterer i koden — sandsynligvis legacy fra Migration 030 før `'webshop'` blev tilføjet). T_INDKOB_SETUP_SUP_03 forventer kun de 5 nye typer, men `'form'` accepteres stadig. Hvis vi vil rydde `'form'` op, er det en separat patch der kræver migration og data-cleanup.

---

## Ændring 2 af 4 — #014: 409 ved duplikat supplier_grocy_locations

**Find** (linje 137-140 i `routes/purchasing.js`):

```javascript
    db.prepare(`
        INSERT OR REPLACE INTO supplier_grocy_locations (supplier_id, grocy_location_id, display_name)
        VALUES (?, ?, ?)
    `).run(supplier_id, grocy_location_id, display_name || null);

    res.json({ ok: true, grocy_location_id, supplier_id });
```

### Erstat med:

```javascript
    // Tjek for eksisterende kobling (samme supplier + grocy_location).
    // I dag bruges INSERT OR REPLACE som silent overwrite — vi vil have
    // klienten til at vide når en duplikat blev fanget.
    const existing = db.prepare(`
        SELECT supplier_id, grocy_location_id, display_name
        FROM supplier_grocy_locations
        WHERE supplier_id = ? AND grocy_location_id = ?
    `).get(supplier_id, grocy_location_id);

    if (existing) {
        return res.status(409).json({
            error: 'Kobling eksisterer allerede',
            existing: existing
        });
    }

    db.prepare(`
        INSERT INTO supplier_grocy_locations (supplier_id, grocy_location_id, display_name)
        VALUES (?, ?, ?)
    `).run(supplier_id, grocy_location_id, display_name || null);

    res.json({ ok: true, grocy_location_id, supplier_id });
```

**Note:** Tabellen har ikke en separat PK-kolonne (DELETE-route på linje 156 bekræfter: `WHERE grocy_location_id = ?`). Det betyder duplikat-detection skal være på (supplier_id, grocy_location_id)-parret, ikke en `id`-kolonne. Response-feltet `existing` indeholder hele rækken så klienten kan se hvad der allerede er der.

**Også:** DELETE-routen bruger `grocy_location_id` alene som identifier. Det er fint for nuværende design (én supplier pr. grocy-location), men hvis fremtidigt design tillader flere suppliers pr. location, skal DELETE udvides. Ikke en del af denne patch.

---

## Ændring 3 af 4 — #015: Map Grocy 500 til 409 ved duplikat barcode

Uændret fra v1. Find-blokken i `services/grocyAdapter.js` `createProductBarcode`:

```javascript
async function createProductBarcode(productId, barcode, fields = {}) {
    _cache.delete('product_barcodes');
    return grocyPost('/objects/product_barcodes', {
        product_id: productId,
        barcode,
        ...fields,
    });
}
```

### Erstat med:

```javascript
async function createProductBarcode(productId, barcode, fields = {}) {
    _cache.delete('product_barcodes');
    try {
        return await grocyPost('/objects/product_barcodes', {
            product_id: productId,
            barcode,
            ...fields,
        });
    } catch (err) {
        // Map Grocy 500 ved duplikat barcode til en pænere fejl
        const msg = String(err?.message || '').toLowerCase();
        const isDuplicate = (err?.status === 500 || err?.status === 409)
            && (msg.includes('constraint') || msg.includes('unique') || msg.includes('duplicate'));

        if (isDuplicate) {
            const conflictErr = new Error(`Barcode '${barcode}' eksisterer allerede for product_id=${productId}`);
            conflictErr.status = 409;
            conflictErr.code = 'BARCODE_DUPLICATE';
            throw conflictErr;
        }
        throw err;
    }
}
```

**Verificér:** Routen i `routes/grocy.js` POST `/product-barcodes` propagerer `err.status`. Hvis den bruger `handle()`-wrapper, sker det automatisk. Hvis ikke, tjek at status-kode forwarder.

---

## Ændring 4 af 4 — F28: Enum-validation på item.status

**Forudsætning:** Patch B er anvendt — så F37-validation-blokken eksisterer.

**Find** i `routes/goods-receipts.js` validation-blokken (efter F37-blok):

```javascript
    // Validér at alle items har product_name (NOT NULL constraint)
    for (let i = 0; i < items.length; i++) {
        const name = items[i]?.product_name;
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({
                error: `items[${i}].product_name er påkrævet`
            });
        }
    }
```

### Tilføj efter den blok:

```javascript
    // Validér at alle items har gyldig status
    const VALID_ITEM_STATUSES = ['ok', 'wrong', 'damaged', 'missing'];
    for (let i = 0; i < items.length; i++) {
        const status = items[i]?.status;
        // Status er valgfri — defaulter til 'ok' i INSERT hvis ikke sat
        if (status !== undefined && status !== null && !VALID_ITEM_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `items[${i}].status='${status}' er ugyldig. Tilladte: ${VALID_ITEM_STATUSES.join(', ')}`
            });
        }
    }
```

**Note:** Hvis patch B IKKE er anvendt endnu, så er F37-blokken ikke der. I så fald tilføj F28-blokken efter `if (!Array.isArray(items) || items.length === 0)`-checket. Begge blokke skal eksistere uanset rækkefølge.

---

## Test-cases der skal opdateres

| Test | Effekt |
|------|--------|
| **T_INDKOB_SETUP_SUP_04** | Skifter: forventer nu 400 i stedet for "fallback til manual" |
| **T_INDKOB_SETUP_SGL_03** | Skifter: forventer nu 409 med `existing`-objekt i stedet for "silent 201/200" |
| **T_INDKOB_SETUP_BC_03** | Skifter: forventer nu 409 med `code='BARCODE_DUPLICATE'` |
| **(ny i T_VAREMOD)** | F28-validation: ukendt status → 400 |

### Nye test-cases til `T_PATCH_C_REGRESSION`:

```
T_PATCH_C_REGRESSION_01: POST supplier integration_type='ftp' → 400 med tilladte-liste
T_PATCH_C_REGRESSION_02: POST supplier integration_type undefined → 201, default 'manual'
T_PATCH_C_REGRESSION_03: PATCH supplier integration_type='ftp' → 400 (regression af C-2)
T_PATCH_C_REGRESSION_04: PATCH supplier name='' (tom) → 400 (samme blok)
T_PATCH_C_REGRESSION_05: POST grocy-locations duplikat (supplier_id, grocy_location_id) → 409 med existing
T_PATCH_C_REGRESSION_06: POST grocy-locations 2 forskellige suppliers samme location → 201 begge (ikke duplikat)
T_PATCH_C_REGRESSION_07: POST product-barcodes duplikat (pid, barcode) → 409 med code='BARCODE_DUPLICATE'
T_PATCH_C_REGRESSION_08: POST goods-receipt item.status='xyz' → 400 med tilladte-liste
T_PATCH_C_REGRESSION_09: POST goods-receipt item.status undefined → 201 (defaulter til 'ok')
```

Bemærk T_PATCH_C_REGRESSION_03 — den er den vigtigste regression-case (PATCH-bugen som v1 missede).

---

## Verificering efter patch

### 1. Regression-tjek

```bash
npm run test:reset
npm run test:server &

# Alle eksisterende tracks skal stadig være grønne
npm run test:run-stock              # 31/31
npm run test:run-inv                # 13/13
npm run test:run-indkob-liste       # 38/39
npm run test:run-indkob-setup       # 47/47 (men 3 cases har nu nye forventninger — opdatér testen)
npm run test:run-indkob-admin       # 50/50
npm run test:run-indkob-horkram     # 54/56
npm run test:run-varemod-patch      # 26/26
npm run test:run-varemod-full       # 59/59 (eller flere, hvis F28 var "observerer bug" før)
```

### 2. Manuel verifikation

```bash
# C-1: POST integration_type='ftp'
curl -X POST http://localhost:4322/api/purchasing/suppliers \
  -H "Content-Type: application/json" -H "Cookie: <test-session>" \
  -d '{"name": "Test", "integration_type": "ftp"}'
# Før: 201 med type='manual' (silent fallback)
# Efter: 400 med tilladte-liste

# C-2: PATCH integration_type='ftp' (regression-tjek af PATCH-bug)
curl -X PATCH http://localhost:4322/api/purchasing/suppliers/1 \
  -H "Content-Type: application/json" -H "Cookie: <test-session>" \
  -d '{"integration_type": "ftp"}'
# Før: 200 med uændret integration_type (silent skip via continue)
# Efter: 400 med tilladte-liste

# C-4: Duplikat supplier_grocy_locations
curl -X POST http://localhost:4322/api/purchasing/suppliers/grocy-locations \
  -d '{"supplier_id": 1, "grocy_location_id": 3}'
# Anden gang: 409 med {existing: {supplier_id, grocy_location_id, display_name}}

# #015: Duplikat barcode
curl -X POST http://localhost:4322/api/grocy/product-barcodes \
  -d '{"product_id": 28, "barcode": "TEST"}'
# Anden gang: 409 med code='BARCODE_DUPLICATE'

# F28: Ugyldig item-status
curl -X POST http://localhost:4322/api/goods-receipts \
  -d '{... "items": [{"product_name": "X", "status": "xyz", "received_quantity": 1}]}'
# Efter: 400 med tilladte-liste
```

---

## Markering i TEST_OBSERVATIONS

```markdown
### #025 — Suppliers POST/PATCH validation på integration_type (lukket)
| | |
|--|--|
| **Status** | `lukket` (maj 2026) |
| **Kilde** | #013 (patch C v2) |
| **Note** | v1 ramte kun POST, v2 fixer også PATCH. Begge returnerer nu 400 med tilladte-liste i stedet for silent fallback/skip |

### #026 — supplier_grocy_locations duplikat-detection (lukket)
| | |
|--|--|
| **Status** | `lukket` (maj 2026) |
| **Note** | INSERT OR REPLACE fjernet, 409 returneres ved duplikat-par. Response inkluderer `existing`-objekt |

### #027 — Grocy barcode-duplikat mapping (lukket)
| | |
|--|--|
| **Status** | `lukket` (maj 2026) |

### #028 — Ukendt item.status valideres nu (lukket)
| | |
|--|--|
| **Status** | `lukket` (maj 2026) |

### #016 — Flere is_preferred per pid (afvist som bug)
| | |
|--|--|
| **Status** | `bevidst-accepteret` (Leif, maj 2026) |
```

---

## v1 → v2 lektioner

Som med patch D er der lektioner her at tage med:

1. **Sammenhængende validation skal fanges samme sted** — POST og PATCH af
   samme resource har ofte parallelle bugs. Min v1 ramte kun POST. Tjek
   altid begge endpoints når et validation-problem identificeres
2. **Find-blokken skal være eksakt kopi af faktisk kode** — ingen
   `...`-placeholdere, ingen "(eksisterende validation)"-noter. Hvis jeg
   ikke har set koden, kan jeg ikke skrive en find-blok
3. **Response-struktur skal matche eksisterende konvention** — POST
   grocy-locations returnerede allerede `{ok: true, ...}`. Vores 409-response
   skal følge samme stil (jeg foreslog først `{error, existing_id}` —
   v2 bruger `{error, existing: {hele rækken}}` der følger samme mønster)

---

## Rollback

Alle 4 ændringer er bagudkompatible for korrekt-formede klient-requests.
Ugyldige requests får nu 400/409 i stedet for silent fail. Hvis problemer:
`git revert <commit-sha>`.

---

*v2 oprettet: maj 2026 — efter review af faktisk kode i `routes/purchasing.js`
afdækkede at v1 manglede PATCH-fix og havde forkert find-blok-format.*
