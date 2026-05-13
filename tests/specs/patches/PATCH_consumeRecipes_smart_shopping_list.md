# PATCH_consumeRecipes_smart_shopping_list.md

> Patch til `services/grocyAdapter.js` — udskift rå `/objects/shopping_list`-POST
> i `consumeRecipes` med smart endpoint `/stock/shoppinglist/add-product` så
> partial-consume ikke længere opretter duplikate shopping-list-entries for
> samme produkt.

---

## Baggrund

Når en bon sættes til LEVERET og der mangler lager til at dække opskrifterne,
trækker `consumeRecipes` det der er på lager (partial-consume) og lægger en
purchase-enhed på Grocys shopping_list, så indkøbet kommer med næste gang.

I dag bruger den `grocyPost('/objects/shopping_list', {...})` direkte — det
opretter en **ny entry** hver gang. Konsekvens: hvis samme produkt er partial-
consumed på flere bonner samme dag, vises det N gange på indkøbslisten i UI'en.

Grocys smart endpoint `/stock/shoppinglist/add-product` **dedupper** automatisk
("If the product is already on the shopping list, the given amount will increase
the amount of the already existing item, otherwise a new item will be added"
— Grocy API-docs).

Smart endpoint understøtter også `note`-parameter direkte, så vi behøver kun ét
Grocy-kald — ingen separat PUT for at bevare note-sporbarhed.

---

## Forudsætninger (verificér før patch anvendes)

- [ ] `services/grocyAdapter.js` eksisterer
- [ ] Funktion `addShoppingListProduct(productId, amount, listId)` er defineret omkring linje 419
- [ ] Funktion `consumeRecipes(...)` indeholder blokken vist nedenfor (omkring linje 625–641)
- [ ] Grocys API understøtter `note`-felt på `/stock/shoppinglist/add-product` (verificeret i Grocy-API-docs, maj 2026)

---

## Patchen består af TRE ændringer

To ændringer i `services/grocyAdapter.js` + én ændring i `tests/scripts/run_T_INVENTORY.js` (T_INV_PARTIAL_02-assertion).
**Alle tre skal landes sammen** — Ændring 3 holder den godkendte T_INVENTORY-suite (13/13) grøn.

### Ændring 1 af 2 — udvid `addShoppingListProduct` med optional `note`-parameter

**Find** (omkring linje 418–425 i `services/grocyAdapter.js`):

```javascript
/** Tilføj produkt til indkøbsliste via Grocy's smart endpoint */
async function addShoppingListProduct(productId, amount, listId) {
    return grocyPost('/stock/shoppinglist/add-product', {
        product_id: productId,
        product_amount: amount,
        list_id: listId || 1,
    });
}
```

**Erstat med:**

```javascript
/**
 * Tilføj produkt til indkøbsliste via Grocy's smart endpoint.
 * Hvis produktet allerede er på listen, øges amount på eksisterende entry
 * (dedup). Note skrives på entry'en — overskriver eksisterende note hvis sat.
 *
 * @param {number} productId
 * @param {number} amount
 * @param {number} [listId=1]
 * @param {string} [note]   Optional. Skrives på entry'en.
 */
async function addShoppingListProduct(productId, amount, listId, note) {
    const body = {
        product_id:     productId,
        product_amount: amount,
        list_id:        listId || 1,
    };
    if (note) body.note = note;
    return grocyPost('/stock/shoppinglist/add-product', body);
}
```

### Ændring 2 af 2 — udskift rå POST i `consumeRecipes` med smart-endpoint-kald

**Find** (omkring linje 625–641 i `services/grocyAdapter.js`):

```javascript
        // Trin 2: hvis der mangler, læg purchase-enhed(er) på shopping list
        let shortfallPurchase = 0;
        if (shortfallStock > FLOAT_TOL) {
            const factor = item.purchase_factor || 1;
            shortfallPurchase = Math.ceil(shortfallStock * factor);
            try {
                await grocyPost('/objects/shopping_list', {
                    product_id:    item.product_id,
                    amount:        shortfallPurchase,
                    note:          `Auto-tilføjet ved LEVERET (manglede ${shortfallStock.toFixed(3)} fra consume)`,
                    shopping_list_id: 1,
                });
            } catch (err) {
                console.warn(`[consume] Kunne ikke tilføje pid=${item.product_id} til shopping list:`, err.message);
                // Ikke en hård fejl — consume lykkedes (delvist), shopping-list-add er ekstra
            }
        }
```

**Erstat med:**

```javascript
        // Trin 2: hvis der mangler, læg purchase-enhed(er) på shopping list.
        // Bruger Grocys smart endpoint der DEDUPPER — samme product_id øger qty
        // på eksisterende entry i stedet for at oprette duplikat.
        let shortfallPurchase = 0;
        if (shortfallStock > FLOAT_TOL) {
            const factor = item.purchase_factor || 1;
            shortfallPurchase = Math.ceil(shortfallStock * factor);
            const noteText = `Auto-tilføjet ved LEVERET (manglede ${shortfallStock.toFixed(3)} fra consume)`;
            try {
                await addShoppingListProduct(item.product_id, shortfallPurchase, 1, noteText);
            } catch (err) {
                console.warn(`[consume] Kunne ikke tilføje pid=${item.product_id} til shopping list:`, err.message);
                // Ikke en hård fejl — consume lykkedes (delvist), shopping-list-add er ekstra
            }
        }
```

### Sammenfattende ændring

| Aspekt | Før | Efter |
|---|---|---|
| Endpoint | `POST /objects/shopping_list` (rå) | `POST /stock/shoppinglist/add-product` (smart) |
| Body-feltnavn for qty | `amount` | `product_amount` |
| Body-feltnavn for liste | `shopping_list_id` | `list_id` |
| Dedup | Nej — opretter altid ny entry | **Ja** — qty summeres på eksisterende entry |
| Note bevaret | Ja | Ja (på eksisterende entry overskrives den dog) |
| Antal Grocy-kald | 1 | 1 |
| Adapter-funktion ændret | — | `addShoppingListProduct` får 4. parameter `note` |

---

## Ændring 3 af 3 — opdater T_INV_PARTIAL_02 i `tests/scripts/run_T_INVENTORY.js`

> **VIGTIGT:** Denne ændring SKAL landes sammen med Ændring 1 + 2, ellers ramler
> den godkendte test (13/13 PASS pr. 11. maj 2026) ned. Verificeret 11. maj 2026:
> nuværende assertion `!slBefore.some(b => b.id === s.id)` kræver at en helt ny
> entry-id eksisterer i `slAfter`. Smart endpoint dedupper på pid og opretter
> derfor INGEN ny entry hvis grocytest's shopping_list allerede har en entry
> for pid=72 (Transport Kasser) — testen ville falde til FAIL.

**Find** (omkring linje 605–614 i `tests/scripts/run_T_INVENTORY.js`):

```javascript
    // 6. Verificér at shopping list fik ny entry
    const slAfter = await fetch(`${url}/objects/shopping_list`, { headers }).then(r => r.json());
    const slAfterEntriesForPid = slAfter.filter(s => parseInt(s.product_id) === TEST_PID);
    const newEntry = slAfterEntriesForPid.find(s => !slBefore.some(b => parseInt(b.id) === parseInt(s.id)));

    if (!newEntry) {
        record('T_INV_PARTIAL_02', 'PARTIAL', 'FAIL',
            `Ingen ny shopping_list-entry for pid=${TEST_PID} (havde ${slBeforeCountForPid}, har nu ${slAfterEntriesForPid.length})`);
    } else {
        record('T_INV_PARTIAL_02', 'PARTIAL', 'PASS',
            `shopping_list-entry id=${newEntry.id} amount=${newEntry.amount}`);
    }
```

**Erstat med:**

```javascript
    // 6. Verificér at shopping list fik shortfall lagt på (smart endpoint dedupper på pid).
    //    Vi kan IKKE stole på "ny entry id" — hvis pid=72 allerede er på listen
    //    (fra anden test eller manuel handling), øger smart endpoint amount på
    //    eksisterende entry. Assert i stedet at total-amount for pid steg med
    //    mindst result72.shortfall_purchase.
    const slAfter = await fetch(`${url}/objects/shopping_list`, { headers }).then(r => r.json());
    const slAfterEntriesForPid = slAfter.filter(s => parseInt(s.product_id) === TEST_PID);
    const sumBefore = slBefore.filter(s => parseInt(s.product_id) === TEST_PID)
        .reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);
    const sumAfter = slAfterEntriesForPid
        .reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);
    const purchaseAdded = sumAfter - sumBefore;
    const expectedPurchase = result72.shortfall_purchase;

    // Find entry der enten er ny ELLER har fået øget amount (til cleanup)
    let touchedEntry = slAfterEntriesForPid.find(s => !slBefore.some(b => parseInt(b.id) === parseInt(s.id)));
    let touchedIsNew = !!touchedEntry;
    if (!touchedEntry) {
        // Smart endpoint dedupped — find eksisterende entry der fik bumpet amount
        touchedEntry = slAfterEntriesForPid.find(s => {
            const before = slBefore.find(b => parseInt(b.id) === parseInt(s.id));
            return before && parseFloat(s.amount) > parseFloat(before.amount);
        });
    }

    if (Math.abs(purchaseAdded - expectedPurchase) >= 0.01) {
        record('T_INV_PARTIAL_02', 'PARTIAL', 'FAIL',
            `purchase-stigning ${purchaseAdded} ≠ shortfall_purchase ${expectedPurchase} (havde ${slBeforeCountForPid}, har nu ${slAfterEntriesForPid.length})`);
    } else {
        record('T_INV_PARTIAL_02', 'PARTIAL', 'PASS',
            `shopping_list: pid=${TEST_PID} amount-stigning=${purchaseAdded} (entry id=${touchedEntry ? touchedEntry.id : '?'}, ${touchedIsNew ? 'ny' : 'dedupped'})`);
    }
```

**Og find cleanup-blokken** (omkring linje 624–630):

```javascript
    if (newEntry) {
        try {
            await fetch(`${url}/objects/shopping_list/${newEntry.id}`, { method: 'DELETE', headers });
        } catch (err) {
            console.warn('  ⚠ kunne ikke rydde shopping_list-entry:', err.message);
        }
    }
```

**Erstat med:**

```javascript
    // Cleanup: hvis vi oprettede en ny entry, slet den. Hvis vi dedupped onto en
    // eksisterende, reducer amount tilbage med det vi tilføjede (bevarer pre-existing state).
    if (touchedEntry) {
        try {
            if (touchedIsNew) {
                await fetch(`${url}/objects/shopping_list/${touchedEntry.id}`, { method: 'DELETE', headers });
            } else {
                const restoredAmount = parseFloat(touchedEntry.amount) - expectedPurchase;
                await fetch(`${url}/objects/shopping_list/${touchedEntry.id}`, {
                    method: 'PUT',
                    headers,
                    body: JSON.stringify({ amount: restoredAmount }),
                });
            }
        } catch (err) {
            console.warn('  ⚠ kunne ikke rydde shopping_list-entry:', err.message);
        }
    }
```

### Sammenfattende ændring (T_INV_PARTIAL_02)

| Aspekt | Før | Efter |
|---|---|---|
| Assertion-strategi | "Ny entry-id eksisterer i slAfter" | "Total amount for pid steg med ≥ shortfall_purchase" |
| Robust mod pre-existing entries | Nej — falder ved dedup | Ja — fanger både ny entry og bumpet eksisterende |
| Cleanup | DELETE ny entry | DELETE hvis ny / PUT amount-restore hvis dedupped |
| Forventet resultat | Sårbar over for state-leakage | Hermetisk — uanset om pre-existing |

---

## Verificering efter patch

### 1. T_INV_PARTIAL re-kør

```bash
npm run test:reset
npm run test:server &
npm run test:inv
```

**Forventet:**
- `T_INV_PARTIAL_01` — PASS (partial-flag og shortfall-beregning uændret)
- `T_INV_PARTIAL_02` — PASS uanset om grocytest har pre-existing entry for pid=72
- Hele T_INVENTORY-suiten — fortsat 13/13 PASS

### 1b. Manuel pre-state-test for at bevise Ændring 3 virker

```bash
# 1. Tilføj manuelt en pid=72-entry til shopping_list FØRST
curl -X POST -H "GROCY-API-KEY: $GROCY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"product_id":72,"amount":5}' \
  https://grocytest.ristetrug.dk/api/stock/shoppinglist/add-product

# 2. Kør T_INVENTORY
npm run test:inv

# Forventet: T_INV_PARTIAL_02 PASS (assertion er på sumstigning, ikke ny id)
#            Cleanup restorer pre-existing amount til 5 (ikke slettet)

# 3. Bekræft pid=72-entry stadig findes med amount=5
curl -H "GROCY-API-KEY: $GROCY_API_KEY" \
  https://grocytest.ristetrug.dk/api/objects/shopping_list | jq '.[] | select(.product_id == 72)'

# 4. Cleanup manuelt
# DELETE entry-id'et
```

### 2. Direkte verifikation på grocytest

```bash
# Tjek hvordan en eksisterende entry ser ud
curl -H "GROCY-API-KEY: $GROCY_API_KEY" \
  https://grocytest.ristetrug.dk/api/objects/shopping_list | jq

# Kald smart endpoint mod et test-pid og bekræft note + dedup
curl -X POST \
  -H "GROCY-API-KEY: $GROCY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"product_id": 87, "product_amount": 5, "list_id": 1, "note": "manuel test"}' \
  https://grocytest.ristetrug.dk/api/stock/shoppinglist/add-product

# Kald samme igen — verificer at amount summeres, IKKE at ny entry oprettes
curl -X POST \
  -H "GROCY-API-KEY: $GROCY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"product_id": 87, "product_amount": 3, "list_id": 1, "note": "manuel test 2"}' \
  https://grocytest.ristetrug.dk/api/stock/shoppinglist/add-product

# GET → entry for pid=87 har amount=8, note="manuel test 2" (overskrevet)
curl -H "GROCY-API-KEY: $GROCY_API_KEY" \
  https://grocytest.ristetrug.dk/api/objects/shopping_list | jq '.[] | select(.product_id == 87)'

# Cleanup: slet entry'en igen
# DELETE /objects/shopping_list/<id>
```

### 3. Dual-bon scenario (det vigtigste — det er her bug'en var synlig)

```
1. Opret to bonner samme dag, begge med samme produkt der overskrider lager
2. Sæt bon A til LEVERET
   → Shopping_list får en entry for produktet, qty = oprundet shortfall A
3. Sæt bon B til LEVERET
   → Shopping_list's SAMME entry får qty øget med shortfall B (ikke ny entry)
4. Tjek entry'en — én entry, qty = shortfall_A + shortfall_B
```

---

## Rollback

Hvis fix'et giver problemer kan ændringerne rulles tilbage:

- **Ændring 1** (adapter-signatur): bagudkompatibel — eksisterende kald uden
  note virker stadig. Kan beholdes selv hvis Ændring 2 rulles tilbage
- **Ændring 2** (consumeRecipes): rul tilbage til oprindelig blok
- **Ændring 3** (T_INV_PARTIAL_02): rul tilbage SAMMEN MED Ændring 2 — assertion
  er strikt på "ny entry-id" og kræver at koden også bruger rå POST igen

Git: `git revert <commit-sha>` eller manuel rollback.

---

## Konsekvenser for andre tests

| Test | Forventet effekt |
|------|------------------|
| `T_INV_PARTIAL_01` | PASS (uændret — tester partial-flag og shortfall-beregning) |
| `T_INV_PARTIAL_02` | **Kræver Ændring 3** (assertion-update). Uden Ændring 3 vil testen fejle på grocytest hvis der er pre-existing entry for pid=72 |
| `T_INV_LEVERET_*` | PASS (uændret — tester full-consume hvor shortfall=0) |
| `T_GROCY_*` | PASS (adapter-ændringen er bagudkompatibel) |
| `T_INDKOB_LISTE` (når skrevet) | Spec'en forventer denne adfærd — patch'en låser den korrekte kontrakt ind |

---

## Markering i TEST_OBSERVATIONS efter verifikation

Patch'en er logget som **#012** (åben) i `docs/TEST_OBSERVATIONS.md`. Når
patch'en er landet og T_INVENTORY igen er 13/13 PASS, flyt #012 til `lukket`:

```markdown
### #012 — consumeRecipes brugte rå shopping_list-endpoint (lukket)

| | |
|--|--|
| **Kilde** | T_INDKOB_LISTE-design Bug #001 (maj 2026) |
| **Beskrivelse** | `services/grocyAdapter.js:631` brugte `grocyPost('/objects/shopping_list', ...)` direkte. UI'en viste duplikater ved gentagne partial-consume af samme pid. |
| **Vurdering** | Bug — fixet <DATO>. Skiftet til smart endpoint `/stock/shoppinglist/add-product` via udvidet `addShoppingListProduct(pid, qty, listId, note)`. T_INV_PARTIAL_02 opdateret samtidig så assertion er på amount-stigning, ikke ny entry-id. |
| **Foreslået action** | N/A — fixet |
| **Status** | `lukket` (<DATO>) |
```

---

*Oprettet: maj 2026 — som forberedelse til T_INDKOB_LISTE. Opdateret 11. maj 2026:
Ændring 3 tilføjet (T_INV_PARTIAL_02-assertion-update) efter analyse af nuværende
assertion mod patch-adfærd. Logget som #012 i TEST_OBSERVATIONS.*
