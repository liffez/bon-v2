# Opgave til Claude Code: Patch varemodtagelse.html

## Kontekst

Vi har et bestillingssystem (Bontool / Bon v2) der bruger Grocy som backend.
Når en ordre afgives gemmes den i `/api/orders/pending` som et JSON-array af PendingOrder-objekter.
`varemodtagelse.html` skal læse herfra i stedet for at bygge leverancer fra Grocy shopping list alene.

---

## Hvad der skal ændres

Filen `tools/varemodtagelse/varemodtagelse.html` (eller lignende sti — find den).

### Nuværende adfærd
`buildDeliveries()` bygger leverancer ved at filtrere Grocy shopping list på `ordered_at` userfield:
```javascript
const ordered = state.shoppingList.filter(item => {
    const uf = item.userfields;
    return uf && uf.ordered_at;
});
```
Den grupperer derefter varer pr. leverandør + dato og laver `state.deliveries`.

### Ønsket adfærd
1. Hent pending orders fra `GET /api/orders/pending`
2. Brug dem som primær kilde til `state.deliveries`
3. Grocy shopping list bruges stadig (hentes allerede) til at berige med lager-enhedsnavne og produktinfo
4. Fallback: hvis `/api/orders/pending` returnerer tomt array eller fejler, brug den eksisterende logik (filtrér shopping list på `ordered_at`)

### PendingOrder-formatet fra `/api/orders/pending`

```javascript
[{
    id: "order_1748393600000",
    supplierName: "Hørkram",
    supplierId: "3",
    orderedAt: "2026-03-28T08:00:00Z",
    expectedDelivery: "2026-03-29",
    status: "pending",
    externalOrderId: "896957",
    orderedBy: "Bontool",
    items: [{
        grocyShoppingListId: 42,
        grocyProductId: 17,
        productName: "Lurpak Smør Saltet 500g",
        varenr: "12345",
        orderedQty: 4,
        unit: "stk",
        pricePerUnit: 31.20,
        shoppingLocationId: 3,
    }],
    extraItems: [{
        varenr: "99001",
        orderedQty: 2,
        note: "Tilføjet manuelt",
    }],
}]
```

### Mapping til state.deliveries-formatet

`state.deliveries` er et array af:
```javascript
{
    supplier: "Hørkram",          // displaynavn
    orderedAt: "2026-03-28T...",
    pendingOrderId: "order_...",  // NY — bruges til DELETE ved afslutning
    items: [{
        id: 42,                   // grocyShoppingListId
        productId: 17,
        productName: "Lurpak Smør Saltet 500g",
        orderedQty: 4,
        orderedVarenr: "12345",
        orderedSupplier: "Hørkram",
        stockUnitName: "stk",     // fra Grocy quantityUnits hvis muligt
        shoppingLocationId: 3,
    }]
}
```

`extraItems` fra pending order skal tilføjes til `items`-arrayet med `id: null` (de har ikke en Grocy shopping list ID).

---

## Hvad der IKKE må ændres

- Al modtagelseslogik (quickApprove, finalApprove, setItemStatus osv.) er korrekt og skal ikke røres
- `grocyAPI.call()` og `grocyAPI.deleteObject()` kald skal bevares som de er
- CSS og HTML-struktur røres ikke

---

## Hvad der skal tilføjes: DELETE pending order ved afslutning

Når `quickApprove()` eller `finalApprove()` er færdig og alt er gået godt, kald:

```javascript
// Slet pending order (arkiveres automatisk på serveren)
if (state.currentDelivery.pendingOrderId) {
    await fetch(`/api/orders/pending/${state.currentDelivery.pendingOrderId}`, {
        method: 'DELETE'
    }).catch(err => console.warn('[VM] Kunne ikke slette pending order:', err));
}
```

Indsæt dette i `showSuccess()` — eller lige inden den kaldes i både `quickApprove()` og `finalApprove()`.

---

## Test

Efter ændringen skal dette virke:
1. Åbn `/api/orders/pending` i browseren → se om der er ordrer
2. Åbn `varemodtagelse.html` → leverancer vises (fra pending orders)
3. Godkend én leverance → pending order forsvinder fra `/api/orders/pending`
4. Hvis `/api/orders/pending` er tom → tom skærm ELLER fallback til shopping list (begge er OK)

---

## Filer du måske har brug for

- `tools/varemodtagelse/varemodtagelse.html` — filen der skal patches
- `routes/orders.js` — den nye route (allerede deployet, `GET /api/orders/pending` virker)
- `services/hokaAdapter.js` — ikke relevant for denne opgave
