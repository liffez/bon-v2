# PATCH_goods_receipts_critical_fixes.md

> Patch til `routes/goods-receipts.js` — fire kritiske fixes opdaget under
> design af T_VAREMODTAGELSE-spec'en. Inkluderer den vigtigste: F35, hvor
> per-item UPDATE rammer alle items med samme product_id i samme receipt.
>
> Alle fire er små, isolerede ændringer der kan landes uafhængigt.

---

## Korrektion til T_VAREMODTAGELSE.md

**F26** — min oprindelige finding sagde "nextReceiptNumber() kaldes før validation".
Det er **forkert** — validation (linje 149-154) kommer faktisk før
nextReceiptNumber() (linje 157). F26 dropper jeg derfor. Counter er ikke i
fare ved input-validation-fejl. Der er stadig en mindre risiko for counter-
spild hvis INSERT eller addStock crasher senere — men det er en separat
diskussion og ikke en del af denne patch.

T_VAREMODTAGELSE-cases T_VAREMOD_NUM_05 skal opdateres til at afspejle dette:
counter er ikke øget ved validation-fejl. Det opdateres når patch'en er anvendt.

---

## Patchen består af 4 ÆNDRINGER i samme fil

### Ændring 1 af 4 — F35: Brug item-ID i stedet for product_id ved UPDATE

**Problem:** Hvis to items i samme receipt har samme `grocy_product_id`
(fx to leverancer af Spinat samme dag, hvor man vil holde dem adskilt på
forskellige modtagelses-tidspunkter), opdaterer den nuværende UPDATE
**begge rækker** ved første addStock-kald. Det betyder at det første items
fejl skriver over på det andet, eller omvendt.

**Fix:** Gem `lastInsertRowid` fra hver `insertItem.run()` og match på
specifik item-ID ved UPDATE.

**Find** (omkring linje 196–218 i `routes/goods-receipts.js`):

```javascript
    // 3. INSERT items
    const insertItem = db.prepare(`
        INSERT INTO goods_receipt_items (
            receipt_id, grocy_product_id, product_name,
            expected_quantity, unit, received_quantity,
            status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of items) {
        insertItem.run(
            receiptId,
            item.grocy_product_id || null,
            item.product_name,
            item.expected_quantity || null,
            item.unit || null,
            item.received_quantity || null,
            item.status || 'ok',
            item.notes || null
        );
    }

    // 4. Sekventiel Grocy addStock + shopping list cleanup
    const grocyResults = [];
    const updateItem = db.prepare(`
        UPDATE goods_receipt_items SET grocy_added = ?, grocy_error = ?
        WHERE receipt_id = ? AND grocy_product_id = ?
    `);
```

**Erstat med:**

```javascript
    // 3. INSERT items — gem item-ID per række så vi senere kan opdatere
    // den specifikke item (ikke alle items med samme grocy_product_id)
    const insertItem = db.prepare(`
        INSERT INTO goods_receipt_items (
            receipt_id, grocy_product_id, product_name,
            expected_quantity, unit, received_quantity,
            status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const itemIds = [];
    for (const item of items) {
        const result = insertItem.run(
            receiptId,
            item.grocy_product_id || null,
            item.product_name,
            item.expected_quantity || null,
            item.unit || null,
            item.received_quantity || null,
            item.status || 'ok',
            item.notes || null
        );
        itemIds.push(result.lastInsertRowid);
    }

    // 4. Sekventiel Grocy addStock + shopping list cleanup
    // UPDATE matcher på item.id (unik) ikke på grocy_product_id — fordi
    // samme product kan optræde flere gange i samme receipt.
    const grocyResults = [];
    const updateItem = db.prepare(`
        UPDATE goods_receipt_items SET grocy_added = ?, grocy_error = ?
        WHERE id = ?
    `);
```

**Find så loopet** (omkring linje 220–262 — der er to `updateItem.run(...)`-kald inde i loopet):

```javascript
    for (const item of items) {
        const shouldAddStock = item.status === 'ok' ||
            (item.status === 'wrong' && item.received_quantity > 0) ||
            (item.status === 'damaged' && item.received_quantity > 0);

        if (!shouldAddStock || !item.grocy_product_id || (item.received_quantity || 0) <= 0) {
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: false,
                error: null,
                skipped: true
            });
            continue;
        }

        try {
            await grocy.addToStock(
                item.grocy_product_id,
                item.received_quantity,
                null, // best_before_date — Grocy bruger default_due_days
                location_id || null
            );
            updateItem.run(1, null, receiptId, item.grocy_product_id);
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: true,
                error: null
            });
        } catch (err) {
            updateItem.run(0, err.message, receiptId, item.grocy_product_id);
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: false,
                error: err.message
            });
        }
```

**Erstat med** (skift fra `for (const item of items)` til `for (let i = 0; i < items.length; i++)` så vi kan indexe `itemIds`):

```javascript
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemId = itemIds[i];

        const shouldAddStock = item.status === 'ok' ||
            (item.status === 'wrong' && item.received_quantity > 0) ||
            (item.status === 'damaged' && item.received_quantity > 0);

        if (!shouldAddStock || !item.grocy_product_id || (item.received_quantity || 0) <= 0) {
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: false,
                error: null,
                skipped: true
            });
            continue;
        }

        try {
            await grocy.addToStock(
                item.grocy_product_id,
                item.received_quantity,
                null, // best_before_date — Grocy bruger default_due_days
                location_id || null
            );
            updateItem.run(1, null, itemId);
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: true,
                error: null
            });
        } catch (err) {
            updateItem.run(0, err.message, itemId);
            grocyResults.push({
                product_name: item.product_name,
                grocy_added: false,
                error: err.message
            });
        }
```

**Note:** Shopping-list-cleanup-blokken (linje 264+) skifter også fra `item.shopping_list_id` til at bruge `items[i].shopping_list_id` — men siden vi allerede har `item` som reference inde i for-loopet, kræver det ikke ekstra ændring.

---

### Ændring 2 af 4 — F30: Null photo_path hvis temp-fil ikke findes

**Problem:** Hvis klient sender `photo_path` der peger på en `vr-tmp-*`-fil
der ikke længere eksisterer (måske allerede slettet, eller forkert sti),
hopper koden over rename-blokken og `photo_path` i DB peger på en
ikke-eksisterende fil. UI'en vil senere fejle med "billede ikke fundet".

**Fix:** Null photo_path i DB hvis rename ikke kunne gennemføres.

**Find** (omkring linje 290–305 i `routes/goods-receipts.js`):

```javascript
    // 5. Omdøb foto hvis det er en temp-fil
    if (photo_path && photo_path.includes('vr-tmp-')) {
        try {
            const oldName = path.basename(photo_path);
            const ext = path.extname(oldName);
            const newName = `vr-${receiptNumber}-${Date.now()}${ext}`;
            const oldPath = path.join(UPLOAD_DIR, oldName);
            const newPath = path.join(UPLOAD_DIR, newName);

            if (fs.existsSync(oldPath)) {
                fs.renameSync(oldPath, newPath);
                const newPhotoPath = `/uploads/receipts/${newName}`;
                db.prepare(`UPDATE goods_receipts SET photo_path = ? WHERE id = ?`).run(newPhotoPath, receiptId);
            }
        } catch (err) {
            console.warn('[goods-receipts] Foto omdøbning fejlede:', err.message);
        }
    }
```

**Erstat med:**

```javascript
    // 5. Omdøb foto hvis det er en temp-fil.
    // Hvis rename ikke kan gennemføres (temp-fil mangler), null'er vi
    // photo_path i DB så vi ikke ender med dangling reference.
    if (photo_path && photo_path.includes('vr-tmp-')) {
        let renameSucceeded = false;
        try {
            const oldName = path.basename(photo_path);
            const ext = path.extname(oldName);
            const newName = `vr-${receiptNumber}-${Date.now()}${ext}`;
            const oldPath = path.join(UPLOAD_DIR, oldName);
            const newPath = path.join(UPLOAD_DIR, newName);

            if (fs.existsSync(oldPath)) {
                fs.renameSync(oldPath, newPath);
                const newPhotoPath = `/uploads/receipts/${newName}`;
                db.prepare(`UPDATE goods_receipts SET photo_path = ? WHERE id = ?`).run(newPhotoPath, receiptId);
                renameSucceeded = true;
            }
        } catch (err) {
            console.warn('[goods-receipts] Foto omdøbning fejlede:', err.message);
        }

        if (!renameSucceeded) {
            // Null photo_path så DB ikke peger på fil der ikke findes
            db.prepare(`UPDATE goods_receipts SET photo_path = NULL WHERE id = ?`).run(receiptId);
            console.warn(`[goods-receipts] photo_path nullet for receipt ${receiptId} — temp-fil findes ikke`);
        }
    }
```

---

### Ændring 3 af 4 — F32: Slå navn op fra users-tabel ved user_id-only

**Problem:** Hvis klient sender kun `received_by_user_id` (uden
`received_by_name`), bliver `userName` til `'Ukendt'` i webhook-payloaden,
selvom navnet kunne være slået op fra users-tabellen.

**Fix:** Lookup users.name som fallback før vi defaulter til 'Ukendt'.

**Find** (omkring linje 308–314 i `routes/goods-receipts.js`):

```javascript
    // 6. Fire-and-forget webhook
    const userName = receiverName || 'Ukendt';
    const receiptRow = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(receiptId);
    webhook.send(receiptRow, userName).catch(err => {
        console.warn('[goods-receipts] Webhook fejl (non-blocking):', err.message);
    });
```

**Erstat med:**

```javascript
    // 6. Fire-and-forget webhook
    // Brug received_by_name først, ellers slå op fra users-tabel via id,
    // ellers fald tilbage til 'Ukendt'.
    let userName = receiverName;
    if (!userName && received_by_user_id) {
        const user = db.prepare(`SELECT name FROM users WHERE id = ?`).get(received_by_user_id);
        userName = user?.name;
    }
    userName = userName || 'Ukendt';

    const receiptRow = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(receiptId);
    webhook.send(receiptRow, userName).catch(err => {
        console.warn('[goods-receipts] Webhook fejl (non-blocking):', err.message);
    });
```

---

### Ændring 4 af 4 — F31: Tilføj `webhook_dispatched` ved siden af `webhook_sent`

**Problem:** Response-feltet `webhook_sent: true` er misvisende —
webhook er fire-and-forget og kan stadig fejle async. Feltet siger ikke
hvad det lader til.

**Fix:** Behold `webhook_sent` for bagudkompatibilitet (klienten bruger
det måske), men tilføj korrekt-navngivet `webhook_dispatched` med samme
værdi. På sigt kan UI skifte til det nye felt og `webhook_sent` deprecates.

**Find** (omkring linje 317–323 i `routes/goods-receipts.js`):

```javascript
    // 7. Response
    res.json({
        id: receiptId,
        receipt_number: receiptNumber,
        status: 'approved',
        grocy_results: grocyResults,
        webhook_sent: true // vi ved det ikke endnu — async
    });
```

**Erstat med:**

```javascript
    // 7. Response
    res.json({
        id: receiptId,
        receipt_number: receiptNumber,
        status: 'approved',
        grocy_results: grocyResults,
        webhook_sent: true,         // @deprecated — bevares for klient-kompatibilitet
        webhook_dispatched: true    // korrekt navn — fire-and-forget, ikke bekræftet leveret
    });
```

---

## Sammenfattende ændringer

| # | Finding | Ændring | Risiko hvis ikke fixet |
|---|---|---|---|
| 1 | F35 | UPDATE matcher på item.id i stedet for grocy_product_id | **Høj** — silent data corruption ved duplikat-pids i samme receipt |
| 2 | F30 | Null photo_path hvis temp-fil mangler | Lav — UX-issue, dangling DB-reference |
| 3 | F32 | Slå navn op fra users-tabel ved user_id-only | Lav — webhook-payload viser 'Ukendt' i stedet for rigtigt navn |
| 4 | F31 | Tilføj webhook_dispatched-felt | Lav — misvisende API-felt |

---

## Verificering efter patch

### 1. Regression — eksisterende tests

```bash
npm run test:reset
npm run test:server &

# Alle Fase 2-tests skal fortsat passe:
npm run test:inv     # T_INVENTORY: 13/13
npm run test:stock   # T_STOCK: 31/31
```

Ingen af ændringerne rører kontrakter som T_INVENTORY eller T_STOCK tester
mod, så de bør være uændrede.

### 2. F35-specifik manuel verifikation

```bash
# Opret en receipt med 2 items af samme pid (fx Spinat × 5 + Spinat × 3)
# fra forskellige leverandører/batches.

curl -X POST http://localhost:4322/api/goods-receipts \
  -H "Content-Type: application/json" \
  -H "Cookie: <test-session>" \
  -d '{
    "supplier_name": "Test Manual",
    "received_by_name": "Test",
    "items": [
      {"grocy_product_id": 28, "product_name": "Spinat batch 1", "received_quantity": 5, "status": "ok"},
      {"grocy_product_id": 28, "product_name": "Spinat batch 2", "received_quantity": 3, "status": "ok"}
    ]
  }'

# Tjek DB:
sqlite3 data/test.db "SELECT id, product_name, grocy_added FROM goods_receipt_items WHERE receipt_id = (SELECT MAX(id) FROM goods_receipts)"

# Forventet: begge items har grocy_added=1 og hver sit unikke ID
# Før patch: kun én af de to har korrekt status, fordi UPDATE rammer begge
```

### 3. F30-specifik manuel verifikation

```bash
# POST receipt med photo_path til en fil der ikke findes
curl -X POST http://localhost:4322/api/goods-receipts \
  -d '{... "photo_path": "/uploads/receipts/vr-tmp-9999999.jpg" ...}'

# Tjek DB:
sqlite3 data/test.db "SELECT photo_path FROM goods_receipts WHERE id = LAST"

# Forventet: NULL (fordi temp-fil ikke fandtes)
# Før patch: '/uploads/receipts/vr-tmp-9999999.jpg' (dangling reference)
```

### 4. F32-specifik manuel verifikation

```bash
# POST receipt med kun user_id, ingen name
curl -X POST http://localhost:4322/api/goods-receipts \
  -d '{... "received_by_user_id": 1, "supplier_name": "Test" ...}'
# (uden received_by_name)

# Tjek webhook-mock output:
# Forventet: userName = users.name for id=1 (fx 'Leif')
# Før patch: userName = 'Ukendt'
```

---

## Konsekvenser for tests

| Test | Effekt |
|------|--------|
| T_INVENTORY | PASS (uændret — bruger ikke goods-receipts) |
| T_STOCK | PASS (uændret) |
| T_INDKOB_* | PASS (alle 4 — uændret) |
| T_VAREMODTAGELSE (når runneren bygges) | Spec'en skal opdateres for F35: test-cases for duplikat-pid skal bruges som regression-tjek (T_VAREMOD_DUP_01-02) |

T_VAREMODTAGELSE-spec'ens findings-tabel skal opdateres:
- F26: dropper (analyseret forkert)
- F30, F31, F32, F35: markeres som **lukket — fixet i patch** efter anvendelse
- F27, F28, F29, F33, F34, F36: forbliver åbne til design-diskussion i patch B

---

## Rollback

Alle 4 ændringer er bagudkompatible:
- Klient der ikke sender duplikat-pids er ikke berørt af ændring 1
- Klient der ikke sender ugyldig photo_path er ikke berørt af ændring 2
- Klient der sender received_by_name virker som før (ændring 3)
- Klient der læser `webhook_sent` virker stadig (ændring 4 tilføjer kun)

Hvis problemer: `git revert <commit-sha>` og kør tests igen.

---

## Markering i TEST_OBSERVATIONS efter patch er anvendt

```markdown
### #018 — duplikat product_id i samme receipt corrupte grocy_added-status (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE-design (maj 2026) F35 |
| **Beskrivelse** | `routes/goods-receipts.js` brugte `UPDATE ... WHERE receipt_id = ? AND grocy_product_id = ?` i Grocy-tracking-loopet. To items i samme receipt med samme grocy_product_id ville opdateres begge ved første UPDATE — silent data corruption på per-item `grocy_added`/`grocy_error`. |
| **Vurdering** | Bug. Fixed maj 2026 via `PATCH_goods_receipts_critical_fixes.md` — UPDATE matcher nu på item.id efter `lastInsertRowid` blev gemt. |
| **Status** | `lukket` |

### #019 — photo_path forblev sat hvis temp-fil manglede (lukket)
### #020 — webhook_sent-felt misvisende navngivet (lukket)
### #021 — received_by-navn faldt til 'Ukendt' ved user_id-only (lukket)
```

(Detaljer som #018 — én entry pr. fix.)

---

*Oprettet: maj 2026 — som forberedelse til T_VAREMODTAGELSE-runner. F26 droppet
efter genlæsning af koden (validation kommer faktisk før nextReceiptNumber).*
