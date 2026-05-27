# Fix: Hørkram "Læg i kurv" fejler ved anden vare

## Problemet

Første vare lægges i kurven uden fejl.
Anden vare (og alle efterfølgende) giver fejl fra Hørkram.

**Årsag: mixed format i PUT-body til Hoka.**

Hoka's `PUT /api/checkout/basket` erstatter hele kurven. Koden henter
derfor eksisterende kurv-linjer og merger dem med de nye inden PUT.
Men de to typer ender i to forskellige formater:

| Kilde | Format sendt til Hoka |
|---|---|
| Eksisterende varer (fra basket GET) | `{ ProductId, Quantity, SalesUnitIndex: 0 }` |
| Nye varer (fra frontend) | `{ ProductId, Quantity, SalesUnit: { Code, Quantity } }` |

Hoka returnerer fejl når body indeholder begge formater i samme array.

Første kald virker fordi `existingProducts` er tom — der er kun nye varer
med `SalesUnit`-format, og det accepterer Hoka fint.
Fra andet kald og frem er `existingProducts` ikke tom, og mixed-problemet opstår.

Kommentaren på linje 607 i koden beskriver endda præcis situationen:
```
// Merge: eksisterende (med SalesUnitIndex) + nye (med SalesUnit)
```
— det er netop den mix der bryder det.

---

## Rettelsen

**Princip:** Brug `SalesUnitIndex` konsekvent for ALLE varer i PUT-body.
`SalesUnitIndex` er et heltal (0 = første/default salgsenhed, 1 = anden).
Snapshot-lookup'en skal gemme indexet i stedet for Code.

### Tre ændringer i `routes/horkram.js`

---

### Ændring 1 — Snapshot-lookup gemmer index (linje 559–562)

**Find:**
```js
                            if (def) {
                                p.salesUnitCode = def.Code;
                                p.salesUnitQuantity = def.Quantity || 1;
                                console.log(`[Hørkram] Auto-resolved salesUnit for ${p.varenummer}: ${def.Code} (${def.TextSingular})`);
                            }
```

**Erstat med:**
```js
                            if (def) {
                                const idx = su.findIndex(u => u.Code === def.Code);
                                p._salesUnitIndex = idx >= 0 ? idx : 0;
                                p.salesUnitCode = def.Code;        // beholdes til logging
                                p.salesUnitQuantity = def.Quantity || 1;
                                console.log(`[Hørkram] Auto-resolved salesUnit for ${p.varenummer}: ${def.Code} idx=${p._salesUnitIndex}`);
                            }
```

---

### Ændring 2 — Eksisterende varer: fallback på SalesUnitIndex (linje 581–585)

**Find:**
```js
                existingProducts = curLines.map(li => ({
                    ProductId:      li.Product?.Id,
                    Quantity:       li.Quantity,
                    SalesUnitIndex: li.SalesUnitIndex,
                })).filter(p => p.ProductId); // filter ugyldige
```

**Erstat med:**
```js
                existingProducts = curLines.map(li => ({
                    ProductId:      li.Product?.Id,
                    Quantity:       li.Quantity,
                    SalesUnitIndex: li.SalesUnitIndex ?? 0,
                })).filter(p => p.ProductId); // filter ugyldige
```

> `?? 0` sikrer at feltet altid er et tal — Hoka udelader det sommetider i GET-response.

---

### Ændring 3 — Nye varer: brug SalesUnitIndex i stedet for SalesUnit (linje 600–604)

**Find:**
```js
            newProducts.push({
                ProductId: pid,
                Quantity:  parseFloat(p.quantity) || 1,
                SalesUnit: { Code: p.salesUnitCode || 'st', Quantity: p.salesUnitQuantity || 1 },
            });
```

**Erstat med:**
```js
            newProducts.push({
                ProductId:      pid,
                Quantity:       parseFloat(p.quantity) || 1,
                SalesUnitIndex: p._salesUnitIndex ?? 0,
            });
```

> `_salesUnitIndex` sættes af snapshot-lookup'en (ændring 1).
> Hvis den ikke kørte (fordi `salesUnitCode` allerede var sat fra frontend),
> falder vi tilbage på `0` — som er Hokas default-enhed (typisk kassen).

---

### Opdater også kommentaren på linje 607

**Find:**
```js
        // Merge: eksisterende (med SalesUnitIndex) + nye (med SalesUnit)
```

**Erstat med:**
```js
        // Merge: eksisterende + nye — begge bruger SalesUnitIndex-format
```

---

## Hvad der skal gøre

1. Åbn `routes/horkram.js`
2. Anvend de tre ændringer ovenfor
3. Genstart server (`npm run dev` eller `pm2 restart bon-v2`)
4. Test flowet nedenfor

### Test

1. Gå til indkøbssiden
2. Læg vare A i kurven → skal returnere `{ ok: true, lineCount: 1 }`
3. Læg vare B i kurven → skal returnere `{ ok: true, lineCount: 2 }`
4. Tjek server-console: andet kald skal logge `Eksisterende kurv: 1 gyldige linjer`

### Hvis fejlen stadig opstår

Tjek server-console for:
```
[Hørkram] ← Basket PUT fejl: HTTP XXX <fejltekst>
```

- **HTTP 400 / 422** med tekst om SalesUnit → format-fejl stadig til stede, check ændring 3
- **HTTP 403** → udløbet CSRF-token, kør `POST /api/horkram/login` og prøv igen
- **HTTP 404** → kurv-ID udløbet, håndteres allerede af den eksisterende retry-logik
