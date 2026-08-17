# CLAUDE_INDKOB_FASE_A.md — Indkøb: pris, enhed og leveringsdato

> **Til Simon.** Fase A retter fejl i den eksisterende kode. Den bygger ikke nye features.
> Restruktureringen (kladde-entitet, "Bestillinger" som ægte view, engangskøb) er Fase C.
> Fase B ("ting der ikke virker") ligger i `CLAUDE_INDKOB_FASE_B.md` og kan køre parallelt.
> Læs `../CLAUDE_INDKOB_ASIS.md` først hvis du ikke kender modulet.
>
> **Baggrund:** modulet har været i drift med tre fejl der forstærker hinanden: forkert
> salgsenhed, priser der ikke findes, og en hardcodet leveringsdato. Kombinationen betyder at
> systemet kan have bestilt 5 gange for meget uden at vise en fejl. Se §1.
>
> **Autoritative dokumenter:** `../BON_V2_PRINCIPPER.md`, `../bon_v2_datamodel_v2.md`,
> `../bon_v2_zoner_og_layout.md`. Ved konflikt vinder de over dette dokument.
>
> **Note om fasenavne:** et tidligere "Fase B" betød "synkronisér leveringsdatoen til Hoka".
> Den opgave viste sig at være fire linjer kode (`_edd`-cookien) og er absorberet i A1 §4.2.
> Fase B betyder nu noget andet. Der er intet gammelt B at lede efter.

---

## 0. AKUT — inden koden er rettet

Indtil Deploy 2 er ude, er der en reel risiko for overbestilling. **Sig til den der bestiller:
tjek salgsenheden på hoka.dk's checkout før ordren godkendes.** Bon lægger varer i kurven, men
det er mennesket der trykker bestil — så fejlen kan fanges der.

Kør desuden §9.1 for at se hvor mange koblinger der er ramt.

---

## 1. Hvad der er galt — grounded i koden

Referencevare gennem hele dokumentet: **60168828, "Falafel, ristet rug, 2 kg"** (Convi Food, aftalevare).

| Sandhed hos Hørkram | |
|---|---|
| Basisenhed | pose (`ps`), 2 kg |
| Aftalepris | 200 kr/pose · 100 kr/kg |
| Karton (`kt`) | 5 poser = 10 kg = **1.000 kr** |
| `IsDefault` | **posen** |

Parseren leverer i dag:

```json
{"code":"kt","quantity":5,"listPrice":288.14,"salesPrice":200,"isDefault":false}
{"code":"ps","quantity":1,"listPrice":331.36,"salesPrice":200,"isDefault":true}
```

### 1.1 Forkert salgsenhed vælges — og gemmes i Grocy

`indkob.js:1684-1687` og `indkob_settings.js:1021-1024` + `:1522-1526` bruger alle
`salesUnits[0]`. Her er `[0]` **kartonen**; defaulten er posen.

Backendens egen fallback (`horkram.js:586`) `su.find(u => u.IsDefault) || su[0]` ville have
ramt rigtigt — men den nås aldrig, fordi frontenden på forhånd sender `'kt'` og linje 582 så
finder kartonen.

Værst: `indkob_settings.js` skriver `salesUnits[0].code` og `.quantity` ind i Grocys userfields
`supplier_unit_code` / `supplier_unit_qty`. **Den forkerte enhed er persisteret på hver kobling
der nogensinde er oprettet.** En kodefix retter ikke de data — se A6.

### 1.2 `su.price` findes ikke

```js
// indkob.js:505-508
var su = bc._hoka.salesUnits[0];
return (su.price || 0) * (qty || 1);
```

Parseren producerer `listPrice`, `salesPrice`, `salesPricePerKg` — aldrig `price`.
`_ibPackPrice` returnerer derfor **0** for enhver Hørkram-vare, og `|| 0` skjuler det.

Følgevirkninger: dropsize-subtotalen (`indkob.js:2124`) er altid 0, så minimumsbeløb-advarslen
er meningsløs. Og prischippen (`indkob.js:1084`) får `undefined`, så `if (unitPrice)` fejler og
prisen udelades helt.

Dette bryder princippet **manglende pris skal vise `?`, aldrig stille nul**.

### 1.3 `salesPrice` er pr. basisenhed — uanset hvilken enhed den sidder på

```js
// hokaParser.js
salesPrice: parseDanishNumber(u.FormattedPrices?.SalesPricePerBaseUnit)
```

Derfor står der 200 på *begge* enheder. Feltnavnet lyver. En naiv rettelse
`su.price → su.salesPrice` prissætter kartonen til 200 kr i stedet for 1.000 — **5× for lavt**.

Den rigtige pris findes i `FormattedPrices.SalesPricePerSalesUnit` ("1.000,00 / karton"),
som parseren slet ikke læser.

### 1.4 `quantity` behandles som kilo

```js
// indkob.js:489-503
function _ibPackSizeKg(bc) { return bc._hoka.salesUnits[0].quantity || 1; }   // → 5
function _ibCalcQty(needKg, bc) { return Math.max(1, Math.ceil(needKg / packKg)); }
```

`quantity` er 5 **poser**, ikke 5 kg. Korrekt er `quantity × netWeightKg` = 10 kg.
Ved et behov på 8 kg foreslås 2 kartoner = 20 kg. **Dobbelt op.**
Samme mekanik som kendt bug #001 — se `../Grocy audit/KENDTE_DATABUGS.md`.

### 1.5 Leveringsdatoen er hardcodet — og priserne afhænger af den

| Sted | Dato i dag |
|---|---|
| `horkram.js:181` `deliveryDate()` → `/product`, `/snapshots`, `enrichWithAftale`, `basket/add` | i morgen |
| `horkram.js:282` `/search` | i dag |
| `horkram.js:763` `/dropsize` (frontend sender ingen dato) | i dag |

Verificeret i hoka.dk's netværkstrafik: når leveringsdatoen skiftes, hentes `snapshots` forfra.
**Priserne er datoafhængige.** Vores hardcodede "i morgen" giver derfor forkerte priser hver
gang den faktiske leveringsdato er en anden — ikke kun når i morgen er en ugyldig leveringsdag.

Er i morgen ugyldig, returnerer `/snapshots` tomt → `snapMap` er tom → `_salesUnitIndex` bliver
`undefined` → `basket/add` falder tilbage til `SalesUnitIndex: 0` og `Code: 'st'` → Hoka afviser
linjen. Det er mekanikken bag "produktet er tilføjet med fejl" (ASIS §12.2).

**Fundet:** datoen er en cookie. `Set-Cookie: _edd=20260804` (format `YYYYMMDD`).
PUT `/api/checkout/basket` sætter den; resten af sitet læser den.

### 1.6 Vi slår Hokas validering fra

```
hoka.dk selv:  /api/checkout/basket?id=...&validate=true
horkram.js:654: /api/checkout/basket?id=...&validate=false
```

`InvalidLineItems` logges kun i det tilfælde hvor kurven ender **helt tom**
(`horkram.js:721-730`). Er 9 ud af 10 linjer gode, forsvinder den tiende lydløst.

### 1.7 Mixed format i `basket/add`

ASIS §8 beskriver merge-mekanikken. Formatet er ikke ensartet:

```js
// eksisterende linjer (600-616)
{ ProductId, Quantity, SalesUnitIndex, SalesUnitQuantity }
// nye linjer (623-639)
{ ProductId, Quantity, SalesUnitIndex, SalesUnit: { Code, Quantity } }
```

Kommentaren på linje 641 påstår begge bruger samme format. Det gør de ikke. Og kommentaren
på 620-622 siger selv at `SalesUnitQuantity` på linjeniveau **ignoreres af Hokas validator**.
Hver PUT sender altså de eksisterende linjer op igen uden det felt Hoka læser.

Dedup sker desuden på `ProductId` alene (642-645) — samme varenr i to salgsenheder kollapser.

### 1.8 Varemodtagelsen arver enheds-problemet

ASIS §7: `_vmBuildItemsFromShoppingList()` matcher på `ordered_supplier` + `ordered_varenr`
og sammenligner modtaget mod `ordered_qty`.

Bestilles 1 karton, står der `ordered_qty = 1`. Modtageren tæller 5 poser i kassen.
Er `expected` 1 og `received` 5, ser det ud som overlevering, og `addStock` lægger det
forkerte tal på lager.

Fejlen findes allerede i dag, fordi systemet uforvarende bestiller i kartoner. **A2 gør
enheden til et bevidst valg, og så skal semantikken være afklaret** — ellers flytter vi bare
fejlen fra bestilling til lager. Se §5.4.

---

## 2. Forudsætninger — Grocy userfields skal oprettes først

Følgende userfields på entiteten `shopping_list` skal oprettes i Grocy admin **før** koden
deployes. Sker det ikke, skriver Grocy-API'et dem lydløst væk — der kastes ingen fejl.

| Userfield | Type | Bruges af |
|---|---|---|
| `ordered_supplier_id` | Number | A7 |
| `ordered_unit_code` | Text | A2 |
| `ordered_unit_qty` | Number (decimal) | A2 |

Gøres på alle tre instanser: `grocy-hq`, `grocy-test`, `grocy-trailer`.

**Verificér efter oprettelse:**
```bash
curl -s -H "GROCY-API-KEY: $KEY" "$GROCY/api/objects/userfields" \
  | jq '.[] | select(.entity=="shopping_list") | .name'
```

---

## 3. Verificér før implementering

Kør disse og bekræft at billedet stadig passer, før du ændrer noget:

```bash
# 1. item_id er NOT NULL (bekræftet 2026-07-31 — bekræft igen)
sqlite3 data/bon.db "PRAGMA table_info(purchase_order_lines);" | grep item_id
#    forventet: 3|item_id|INTEGER|1||0     ← notnull=1

# 2. goods_receipts har ikke allerede supplier_id
sqlite3 data/bon.db "PRAGMA table_info(goods_receipts);"

# 3. Næste ledige migrationsnummer — GÆT IKKE
ls db/migrations/ | sort | tail -5

# 4. Alle steder der bruger salesUnits[0]
grep -rn "salesUnits\[0\]" shared/ routes/ services/

# 5. Alle steder der bruger .price på en salgsenhed
grep -rn "su\.price\|salesUnits\[0\]\.price" shared/

# 6. Alle kaldere af deliveryDate()
grep -n "deliveryDate()" routes/horkram.js

# 7. Frontend-kaldere af de berørte endpoints
grep -rn "fetchHokaSnapshots\|fetchHokaDropsize\|putHokaBasket\|horkram/product\|horkram/search" shared/

# 8. Parser-feltnavne der omdøbes i A5a
grep -rn "\.listPrice\b\|\.salesPrice\b" shared/ routes/ services/

# 9. Hvor ordered_* skrives og læses (A2 + A7 rører samme sted)
grep -rn "ordered_supplier\|ordered_varenr\|ordered_qty\|ordered_at" shared/ routes/

# 10. settings-tabellen hedder 'settings' (ikke system_settings)
sqlite3 data/bon.db ".tables" | tr ' ' '\n' | grep -i setting
```

Afviger noget fra §1: **stop og skriv til Leif før du fortsætter.**

---

## 4. A1 — Leveringsdato som parameter

**Mål:** én dato styrer alle Hørkram-kald. Ingen skjulte defaults.

### 4.1 Backend — `routes/horkram.js`

Erstat `deliveryDate()` (linje 181-185) med:

```js
/**
 * Leveringsdato for et request. Ingen fallback til "i morgen" —
 * datoen er prisbestemmende og skal komme fra kalderen.
 * @returns {{ iso: string, edd: string }} iso til query-param, edd til cookie
 */
function resolveDeliveryDate(req) {
    const raw = req.query.date;
    if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const err = new Error('date-parameter påkrævet (YYYY-MM-DD)');
        err.status = 400;
        throw err;
    }
    return { iso: `${raw}T00:00:00`, edd: raw.replace(/-/g, '') };
}
```

Ret alle kaldere til at bruge den:

| Linje | Route | Ændring |
|---|---|---|
| 259 | `/product/:varenr` | `deliveryDate()` → `resolveDeliveryDate(req).iso` |
| 282-283 | `/search` | fjern `today`, brug `resolveDeliveryDate(req).iso` |
| 313 | `/snapshots` | → `resolveDeliveryDate(req).iso` |
| 556 | `basket/add` | dato fra `req.body.date`, samme validering |
| 763 | `/dropsize` | fjern `new Date()`-fallback → 400 hvis dato mangler |
| 196 | `enrichWithAftale` | tag `iso` som argument fra kalderen |
| 823 | `/debug/:varenr` | → `resolveDeliveryDate(req).iso` |

**400 frem for fallback er bevidst.** En tavs default er præcis det der har givet forkerte
priser. Bedre at et kald fejler synligt end at det svarer med tal for en anden dag.

### 4.2 `_edd`-cookien — og hvorfor den ikke må caches

```js
// horkram.js:36 — modul-niveau, delt af hele serveren
let sessionCache = { cookies: null, exp: 0, ... };
```

Én Hoka-session deles af alle indloggede Bon-brugere i 30 minutter. Havner `_edd` i den cache,
gælder én brugers leveringsdato for alle andres priser i det næste halve time. Det er en fejl
der er umulig at fejlfinde bagefter, fordi den afhænger af hvem der klikkede sidst.

**Regel: `_edd` gemmes aldrig i `sessionCache`. Den sættes pr. request.**

```js
// collectCookies (48-62): spring _edd over
if (name === '_edd') continue;

// cookiesToStr (64-66): tag edd som argument
function cookiesToStr(cookieMap, edd) {
    const list = [...cookieMap.values()];
    if (edd) list.push(`_edd=${edd}`);
    return list.join('; ');
}

// fetchWithAuth (161): videregiv edd
async function fetchWithAuth(url, options = {}, edd = null) { ... }
```

`basketId` bliver i cachen — I har én Hoka-konto og én kurv, så den *skal* deles.
Datoen hører til bestillingen, ikke til serveren.

### 4.3 Frontend — `shared/indkob.js`

- Datovælger i indkøbs-headeren, ved siden af gruppering/visning-kontrollerne.
- Default: første gyldige dag fra `GET /api/horkram/delivery-dates` (`horkram.js:749`).
- Persistér i `localStorage` som `ib_delivery_date` — samme mønster som `ib_view_mode`.
- Datoen sendes med på **alle** Hørkram-kald: snapshots, dropsize, basket/add, search, product.
- Ved datoskift: hent snapshots forfra og gen-render. Priserne ændrer sig — det er meningen.
- `_ibCheckDropsize` (2112) skal sende datoen med til `fetchHokaDropsize`.

I Fase C flytter datoen op på kladden. `localStorage` er en midlertidig bolig, ikke slutmålet
— skriv det i en kodekommentar så det ikke bliver permanent ved et uheld.

---

## 5. A2 — Enhedsvælger på chippen

**Mål:** brugeren vælger salgsenhed. Systemet gætter ikke.

Hoka bruger selv radioknapper ("kartoner (5 poser)" / "poser") med basisenheden forvalgt.
Vi spejler den model.

### 5.1 Valg af default

Rækkefølge:

1. `supplier_unit_code` fra barcode-userfields — **kun hvis den er sat efter A6**
2. Enheden hvor `isDefault === true`
3. Enheden hvor `code === baseUnitCode`
4. `salesUnits[0]` — sidste udvej, og log en advarsel

Punkt 1 må ikke bruges før A6 har ryddet op. Indtil da er userfieldet forurenet (§1.1).
Implementér med et flag i `settings`: `indkob_trust_unit_userfields` (default `0`, sættes til
`1` når A6 er kørt).

**Punkt 3 er ikke teoretisk.** Der findes varer hvor **ingen** enhed har `isDefault` sat:

```json
// varenr med BaseUnitCode "st"
{"Code":"ks","Quantity":45,"TextSingular":"kasse (45 styk)","IsDefault":null}
{"Code":"st","Quantity":1, "TextSingular":"styk",           "IsDefault":null}
```

Uden punkt 3 ville vi falde til `[0]` og vælge **kassen med 45 styk** — præcis den fejl
A2 skal rette.

**`baseUnitCode` skal læses, aldrig antages.** Der findes varer med `BaseUnitCode: "kt"`,
hvor basisenheden *er* en karton. Både `|| 'st'` (`horkram.js:635`) og `|| 'ks'`
(`indkob.js:1680`) er forkerte gæt og fjernes, jf. §5.3.

Rammer punkt 4, skal advarslen indeholde varenummeret, så varen kan slås op manuelt.

**Hokas default er ikke altid basisenheden**, og det er i orden:

| Vare | `BaseUnitCode` | `IsDefault` |
|---|---|---|
| 60168828 (falafel) | `ps` | posen |
| 60106075 (fiskefrikadeller) | `ps` | **kartonen** |

Punkt 2 vælger altså kartonen for 60106075. Det er Hokas egen anbefaling for netop den vare,
og brugeren kan skifte på chippen. Regel 3 er kun til de varer hvor `isDefault` mangler helt.

### 5.2 UI

- Chippen viser den valgte enhed: `poser · 200 kr · Nr. 60168828`
- Enheden er klikbar → lille popover med alle `salesUnits`, hver med navn, antal basisenheder,
  pris pr. salgsenhed og kg pr. salgsenhed
- Ved valg: gen-beregn antal (`_ibCalcQty`) og pris, gem valget

### 5.3 Persistering

Ved valg skrives til Grocy barcode-userfields:

```
supplier_unit_code = <code>
supplier_unit_qty  = <quantity>
```

og ved bestilling til PO-linjen (nye kolonner fra A4):

```
sales_unit_code = <code>
sales_unit_qty  = <quantity>
```

**Bemærk:** `_ibAddToCart` (1680) har i dag `|| 'ks'` som fallback, backend har `|| 'st'`
(`horkram.js:635`). Begge er gætterier på at basisenheden hedder noget bestemt — for denne
vare er den `ps`. **Fjern begge fallbacks.** Kan enheden ikke bestemmes, afvises linjen med
en synlig fejl.

### 5.4 Varemodtagelsen skal kende enheden

Uden dette flytter A2 fejlen fra bestilling til lager (§1.8).

**Skrivesiden** — ved bestilling sættes to nye userfields på `shopping_list`-linjen:

```
ordered_unit_code = <code>        // fx 'kt'
ordered_unit_qty  = <quantity>    // fx 5
```

`ordered_qty` bevarer sin betydning: **antal salgsenheder**. Det er `ordered_unit_qty` der
oversætter til basisenheder.

**Læsesiden** — `_vmBuildItemsFromShoppingList()` i `shared/varemodtagelse.js`:

- Vis linjen som brugeren ser den i kassen: **"1 karton (5 poser)"**
- `expected` i basisenheder = `ordered_qty × ordered_unit_qty`
- Mangler `ordered_unit_qty` (linjer bestilt før A2): antag `1`, og log en advarsel

**Serverside** — `routes/goods-receipts.js` sammenligner `received` mod `expected` i
basisenheder. Verificér at `addStock` også får basisenheder, ikke salgsenheder.

### 5.5 A2 og A7 rører samme kodested

Tre userfields tilføjes i samme øjeblik i `_ibGotoCart` og `_ibConfirmManualOrder`:

```
ordered_unit_code     ← A2
ordered_unit_qty      ← A2
ordered_supplier_id   ← A7
```

**Det er én ændring, ikke to.** Skrives de som separate opgaver, ender den ene med at
overskrive den anden.

---

## 6. A3 — `basket/add`: ensartet format og synlige fejl

### 6.1 Samme format på alle linjer

Eksisterende linjer (600-616) skal have samme struktur som nye:

```js
existingProducts = curLines.map(li => ({
    ProductId:      li.Product?.Id,
    Quantity:       li.Quantity,
    SalesUnitIndex: li.SalesUnitIndex ?? 0,
    SalesUnit: {
        Code:     <kode for li.SalesUnitIndex>,
        Quantity: <quantity for samme indeks>,
    },
})).filter(p => p.ProductId && p.SalesUnit.Code);
```

Koden hentes fra kurvsvarets eget `li.Product.SalesUnits.Values[li.SalesUnitIndex]`.
Er den ikke med i svaret, hent snapshot for de produkt-ID'er i samme batch som de nye
(`horkram.js:561-574` gør det allerede — udvid `snapIds` til også at rumme eksisterende linjer).

Kan koden stadig ikke bestemmes: **udelad linjen og returnér den i `warnings`.** Gæt ikke.

### 6.2 Dedup på enhed, ikke kun produkt

```js
// linje 642 — i dag
const newIds = new Set(newProducts.map(p => p.ProductId));
// skal være
const key = p => `${p.ProductId}:${p.SalesUnitIndex}`;
const newKeys = new Set(newProducts.map(key));
const merged = existingProducts.filter(p => !newKeys.has(key(p))).concat(newProducts);
```

### 6.3 `validate=true` og returnér afviste linjer

- Linje 654 og 682: `validate=false` → `validate=true`
- Flyt `InvalidLineItems`-håndteringen ud af `if (!updated?.LineItems?.length)` (721-730),
  så den altid køres
- Svaret udvides:

```json
{
  "ok": true,
  "basketId": 43191038,
  "lineCount": 9,
  "subtotal": 4071.50,
  "addedProducts": 10,
  "rejected": [
    { "varenr": "60168828", "name": "Falafel, ristet rug, 2 kg", "reason": "..." }
  ]
}
```

- `_ibAddToCart` viser afviste linjer som en vedvarende fejlbesked pr. vare — ikke en toast
  der forsvinder. Brugeren skal kunne se hvad der ikke kom med.

---

## 7. A4 — Migration

**Filnavn:** `db/migrations/NNN_indkob_fase_a.sql` hvor `NNN` er næste ledige nummer.
Slå det op med §3 punkt 3. **Gæt ikke — migrationer køres aldrig om.**

```sql
-- ==========================================
-- NNN_indkob_fase_a.sql
-- purchase_order_lines: item_id nullable + salgsenhed + linjekilde
-- goods_receipts: supplier_id ved siden af supplier_name
-- unit_mappings: lærende Hoka→Grocy enhedsoversættelse
--
-- item_id gøres nullable for at kunne bestille en leverandørvare
-- der ikke er koblet til et Grocy-produkt (engangskøb, Fase C).
-- SQLite kan ikke ALTER en NOT NULL væk — tabellen recreates,
-- samme mønster som 030_purchasing_v2.sql.
-- ==========================================

PRAGMA foreign_keys = OFF;

CREATE TABLE _pol_backup AS SELECT * FROM purchase_order_lines;

DROP TABLE purchase_order_lines;

CREATE TABLE purchase_order_lines (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_order_id       INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    supplier_product_id     INTEGER REFERENCES supplier_products(id),
    item_id                 INTEGER,            -- ← nu nullable
    quantity_ordered        REAL NOT NULL,
    unit_quantity           REAL,
    price_per_pack          REAL,
    line_total              REAL,
    shopping_list_id        INTEGER,            -- død lokal tabel, FK fjernet (ASIS §1)
    grocy_shopping_list_id  INTEGER,
    grocy_product_id        INTEGER,
    barcode_value           TEXT,

    -- Nyt i Fase A
    sales_unit_code         TEXT,               -- fx 'ps', 'kt'
    sales_unit_qty          REAL,               -- antal basisenheder pr. salgsenhed
    product_name_snapshot   TEXT,               -- navn på linje uden Grocy-produkt

    -- Forberedelse til Fase C
    line_source             TEXT NOT NULL DEFAULT 'shopping_list'
                            CHECK (line_source IN ('shopping_list','direct','replacement')),
    replaces_barcode        TEXT
);

INSERT INTO purchase_order_lines (
    id, purchase_order_id, supplier_product_id, item_id,
    quantity_ordered, unit_quantity, price_per_pack, line_total,
    shopping_list_id, grocy_shopping_list_id, grocy_product_id, barcode_value
)
SELECT
    id, purchase_order_id, supplier_product_id, item_id,
    quantity_ordered, unit_quantity, price_per_pack, line_total,
    shopping_list_id, grocy_shopping_list_id, grocy_product_id, barcode_value
FROM _pol_backup;

CREATE INDEX idx_po_lines_order ON purchase_order_lines(purchase_order_id);

DROP TABLE _pol_backup;

-- A7: leverandør-id ved siden af navnet (ASIS §12.5)
ALTER TABLE goods_receipts ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);

-- A9: lærende oversættelse Hoka-salgsenhed → Grocy-lagerenhed (§10c.2)
CREATE TABLE unit_mappings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    hoka_code         TEXT NOT NULL,
    grocy_qu_id       INTEGER NOT NULL,
    product_group_id  INTEGER,
    use_count         INTEGER NOT NULL DEFAULT 1,
    last_used_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (hoka_code, grocy_qu_id, product_group_id)
);
CREATE INDEX idx_unit_mappings_lookup ON unit_mappings(hoka_code, product_group_id);

PRAGMA foreign_keys = ON;
```

`purchase_orders` røres ikke — `status='draft'`, `expected_delivery_date`, `sent_at` og
`grocy_location_id` findes alle allerede.

### 7.1 `routes/orders.js`

- Linje 150-164: indsæt `sales_unit_code`, `sales_unit_qty`, `product_name_snapshot`,
  `line_source` fra `item.*`
- `line_source` default `'shopping_list'` når kalderen ikke sætter den
- **Rør ikke `status: 'sent'` på linje 130 i denne fase.** Kladde-modellen er Fase C —
  ændres det nu, uden UI til at se kladder, forsvinder bestillinger ud af syne.

---

## 8. A5 — Pris og enhed regnes rigtigt

### 8.1 A5a — `services/hokaParser.js`

Feltnavnene lyver i dag og har direkte forårsaget §1.2 og §1.3. De omdøbes.

I **både** `parseProduct` og `parseSnapshotToSummary`:

```js
const salesUnits = (m.SalesUnits?.Values || []).map(u => ({
    code:       u.Code,
    name:       u.TextSingular,
    namePlural: u.TextPlural,
    quantity:   u.Quantity,          // antal BASISENHEDER pr. salgsenhed — ikke kg, ikke kr

    // Pr. basisenhed (det parseren før kaldte listPrice / salesPrice)
    listPricePerBaseUnit:   u.ListPrice ?? null,
    salesPricePerBaseUnit:  parseDanishNumber(u.FormattedPrices?.SalesPricePerBaseUnit),

    // Pr. salgsenhed — NYT. Det er dét man betaler for én karton/pose.
    listPricePerSalesUnit:  parseDanishNumber(u.FormattedPrices?.ListPricePerSalesUnit),
    salesPricePerSalesUnit: parseDanishNumber(u.FormattedPrices?.SalesPricePerSalesUnit),

    salesPricePerKg: parseDanishNumber(u.FormattedPrices?.SalesPricePerKilo),
    isDefault:       u.IsDefault || false,
}));
```

`salesPricePerKg` mangler i dag i `parseSnapshotToSummary` — tilføj den der også.

**Ingen `|| 0` nogen steder.** Mangler et tal, er det `null`, og frontenden viser `?`.

`parseDanishNumber` håndterer allerede "1.000,00 / karton" korrekt (regex + punktum/komma-swap).
Verificér med testcase 11.4.

### 8.2 A5b — `shared/indkob.js`

| Funktion | I dag | Skal være |
|---|---|---|
| `_ibPackPrice` (505) | `(su.price \|\| 0) * qty` | `_ibPricePerSalesUnit(su) * qty`, `null` hvis prisen mangler |
| `_ibPackSizeKg` (489) | `salesUnits[0].quantity` | `su.quantity × product.netWeightKg`, `null` hvis vægt mangler |
| `_ibCalcQty` (499) | `ceil(needKg / packKg)` | uændret formel, men på korrekt `packKg` |
| `_ibPricePerKg` (483) | `last_price / packKg` | `su.salesPricePerKg` direkte fra Hoka — se §8.4 |
| `_ibChipLabel` (512) | `salesUnits[0].name` | valgt enheds `name` |
| linje 1084 | `salesUnits[0].price` | `_ibPricePerSalesUnit(valgt enhed)` |

Nye hjælpefunktioner:

```js
/** Pris for én salgsenhed. Aftalepris hvis der er en, ellers listepris. null hvis ingen. */
function _ibPricePerSalesUnit(su) {
    if (!su) return null;
    return su.salesPricePerSalesUnit ?? su.listPricePerSalesUnit ?? null;
}

/** Kg pr. salgsenhed. null hvis varen ikke har vægt (stk-varer). */
function _ibKgPerSalesUnit(su, hoka) {
    if (!su || !hoka || hoka.netWeightKg == null) return null;
    return su.quantity * hoka.netWeightKg;
}
```

**`null` skal renderes som `?` — aldrig som 0, aldrig som tom streng, aldrig skjult.**
En kunstigt billig vare er farligere end ingen pris. Se `../BON_V2_PRINCIPPER.md`.

Har en vare ingen `netWeightKg`, kan dækning ikke beregnes i kg. Vis antal i salgsenheder og
`?` ved kg — foreslå ikke et antal på et gæt.

### 8.3 A5c — `enrichWithAftale` skal ikke smide data væk

`horkram.js:194-225` henter allerede fulde snapshots for hvert søgeresultat, men beholder kun
to felter. `parseSearchResults` giver derfor ingen `salesUnits` og ingen pris pr. enhed.

Udvid løkken (linje 209-215) til også at kopiere fra snapshottet:

```js
salesUnits, pricePerUnit, netWeightKg, baseUnitCode
```

Genbrug `parser.parseSnapshotToSummary(snap)` frem for at mappe felterne i hånden.

Det koster nul ekstra API-kald og gør `/search` brugbar som indgang til engangskøb i Fase C.

### 8.4 A5d — kiloprisen kommer fra Hoka, ikke fra os

**Problemet i dag:** kiloprisen importeres til **produktets** userfields
(ASIS §9 Tab 3 → Favoritter → "Importer priser"). Det giver én kilopris pr. Grocy-produkt,
uanset hvor mange barcodes produktet har.

Prisen hører ikke til på produktet. Den hører til på **(barcode × salgsenhed)**.
Med flere barcodes pr. produkt — hvilket "+ Vare variant" udtrykkeligt understøtter —
vinder **sidste import**. Ikke den billigste, ikke den foretrukne. Og man kan ikke se
hvilken barcode tallet kom fra.

**Kilden er Hokas `salesPricePerKg`.** Den kommer direkte fra samme sted som prisen og har
ingen mellemregning hos os. Vores egen udregning (`pris / (quantity × netWeightKg)`) har
to faktorer der begge kan være forkerte — og som netop *var* forkerte i §1.4.

```js
/** Kilopris for en valgt barcode + salgsenhed. Kilde: Hoka. */
function _ibPricePerKg(su) {
    return su?.salesPricePerKg ?? null;
}
```

`supplier_price_per_kg` på produktet bliver dermed en **projektion** af den foretrukne
barcodes kilopris — skrevet, men aldrig brugt som kilde. Samme mønster som `ordered_*`
får i Fase C.

### 8.5 A5e — vores udregning som assertion mod Hokas tal

Vi *viser* Hokas kilopris. Vi *regner* vores egen udelukkende for at kontrollere faktorerne:

```js
const shown  = su.salesPricePerKg;                       // det brugeren ser
const derived = (() => {                                 // kun til kontrol
    const price = _ibPricePerSalesUnit(su);
    const kg    = _ibKgPerSalesUnit(su, hoka);
    return (price == null || !kg) ? null : price / kg;
})();

if (shown != null && derived != null &&
    Math.abs(derived - shown) / shown > 0.02) {
    console.warn(`[indkob] Kilopris divergerer for ${barcode} (${su.code}): ` +
                 `udledt ${derived.toFixed(2)}, Hoka ${shown.toFixed(2)}`);
}
```

Divergens betyder at `quantity` eller `netWeightKg` er forkert. Det er præcis mekanikken bag
§1.4 — med denne assertion ville fejlen have råbt op den dag den opstod, i stedet for at blive
opdaget ved en dobbeltbestilling.

**Vigtigt: assertionen må aldrig ændre hvad der vises.** Den logger. Punktum.

### 8.6 `shared/indkob_settings.js`

Linje 1021-1024 og 1522-1526: `salesUnits[0]` → enheden hvor `isDefault === true`,
med `salesUnits[0]` som sidste udvej **og en `console.warn`**.

---

## 9. A6 — Oprydning af persisterede enheder

**Blokeret: afventer beslutning fra Leif.** Bygges ikke før den er taget.

### 9.1 Kortlæg omfanget først

```sql
-- I Grocy-databasen: koblinger hvor der er gemt en ikke-basisenhed
SELECT COUNT(*) FROM userfield_values
WHERE field_id = (SELECT id FROM userfields WHERE name = 'supplier_unit_qty')
  AND CAST(value AS INTEGER) > 1;
```

Hold resultatet op mod faktiske bestillinger via `GET /api/horkram/orders`
(`horkram.js:782`) for at se om der reelt *er* bestilt kartoner hvor I ville have poser.

### 9.2 To muligheder

| | Automatisk | Gennemgangsliste |
|---|---|---|
| Hvad | Alle userfields sættes til `isDefault`-enheden | Liste over afvigelser, Leif godkender pr. vare |
| Hurtighed | Én kørsel | Manuelt arbejde |
| Risiko | Overskriver de varer hvor karton **er** det rigtige valg | Ingen |
| Dokumentation | Ingen | Listen er kvitteringen på hvad der blev rettet |

**Anbefaling: gennemgangsliste.** Der findes varer hvor kartonen er det rigtige — dem må vi
ikke tromle. Og listen er dokumentation på hvad der blev rettet, hvilket der bliver brug for
hvis der skal reklameres over en fejlbestilling.

Når A6 er kørt: sæt `indkob_trust_unit_userfields = 1` i `settings` (jf. §5.1).

---

## 10. A7 — Leverandør-id ved siden af navnet

**Mål:** en omdøbt leverandør må ikke kunne tabe udestående bestillinger (ASIS §12.5).

`ordered_supplier` er leverandørens **navn** som fritekst, og `goods_receipts.supplier_name`
er ligeledes en streng uden FK. Navnet er frit redigerbart i Indstillinger → Tab 1.
Omdøbes en leverandør med udestående bestillinger, viser varemodtagelsen "0 varer klar",
varerne lægges aldrig på lager, og `ordered_*` nulstilles aldrig. **Tabet er tavst.**

### 10.1 Skrivesiden

Nyt userfield på `shopping_list`-linjen ved bestilling:

```
ordered_supplier_id = <suppliers.id>
```

`ordered_supplier` (navnet) bevares uændret — det er et snapshot af hvad leverandøren hed
dengang, og har værdi i sig selv.

Tilsvarende sættes `goods_receipts.supplier_id` ved nye modtagelser. `supplier_name` bevares.

Se §5.5: dette skrives sammen med A2's to userfields, i én ændring.

### 10.2 Læsesiden — `_vmBuildItemsFromShoppingList()`

```
1. Match på ordered_supplier_id, hvis feltet er sat
2. Ellers match på ordered_supplier (navn) — for linjer bestilt før A7
3. Log en advarsel hver gang trin 2 rammer, så man kan se hvornår
   de gamle linjer er væk
```

Fallbacken kan fjernes når der ikke har været et trin 2-hit i en måned.

### 10.3 Deploy-fordeling

| Del | Deploy |
|---|---|
| `goods_receipts.supplier_id` (kolonne) | 1 — folder ind i migrationen §7, ikke en ny fil |
| Skriv `ordered_supplier_id` i `indkob.js` | 2 |
| Læs den i `varemodtagelse.js` | 2 |

Skrivesiden er frontend. Deployes læsesiden alene, sættes feltet aldrig, og fallbacken rammer
hver gang.

---

## 10b. A8 — Når en vare ikke kan købes

**Mål:** færrest mulige klik når du står med en vare der ikke kan lægges i kurven.
A8 forsøger **ikke** at forudsige eller overvåge tilgængelighed.

### 10b.1 Afvisningen er signalet

A3 (§6.3) sætter `validate=true` og returnerer `rejected[]` fra Hoka. Det sker i
nøjagtig det sekund hvor problemet betyder noget, og kun for de varer du faktisk
vil købe.

**Derfor bygger A8 ingen detektion.** Ingen batch-scanning, intet statusfelt, ingen
polling, ingen kortlægning af Hokas interne API. Vi behøver ikke vide *hvorfor* varen
ikke kan købes — kun *at* den ikke kan, og hvad du så gør.

> **Fravalgt bevidst:** en tæller der efter N afvisninger foreslår permanent erstatning.
> Sæsonvarer ville blive stemplet som udgåede hver vinter. Systemet gætter aldrig på
> "permanent" — det er altid dit valg (§10b.3).

### 10b.2 Erstatning i samme bestilling

Afvisningen vises på selve linjen:

```
⚠ Æbler Elstar (17163019) kunne ikke lægges i kurven
   [Søg erstatning]   [Spring over]
```

**"Søg erstatning"** åbner draweren (`_ibOpenDrawer`) i couple-mode med varenavnet
forudfyldt i Hørkram-søgningen. Det gør den i forvejen — se `indkob.js:2776`.

Vælges en vare, indsættes den i **denne** bestilling:

```
line_source      = 'replacement'
replaces_barcode = '17163019'
```

**Grocy-koblingen røres ikke.** Næste gang står den oprindelige vare der igen — hvilket
er rigtigt for sæsonvarer, som er den hyppigste årsag.

**"Spring over"** lader linjen blive på indkøbslisten som uopfyldt behov. `ordered_*`
blev aldrig sat, så den dukker op igen af sig selv. Ingen kode nødvendig.

### 10b.3 Checkbox: "brug fremover"

I erstatnings-draweren, under vareresultatet:

```
☐ Brug fremover — flyt koblingen til denne vare
```

**Default: fra.** Sat, sker der to ting oveni:

1. Ny barcode oprettes på Grocy-produktet (`createProductBarcode`)
2. Den gamle barcodes `is_preferred` fjernes; den nye får `'1'`

Den gamle barcode **slettes ikke**. Kommer varen tilbage i sæson, kan du vælge den igen.

### 10b.4 Historik frem for automatik

`purchase_order_lines` samler af sig selv en oversigt via `replaces_barcode`. En simpel
liste i Indstillinger → Hørkram:

```
Æbler Elstar → Royal Gala          4 gange siden marts
Fiskefrikadeller → (ingen)         2 gange, sprunget over
```

Ren læsning. Ingen advarsler, ingen forslag, ingen automatik — bare synlighed, så du selv
kan se hvornår noget er værd at gøre permanent.

```sql
SELECT replaces_barcode, barcode_value, COUNT(*) AS antal, MAX(po.created_at) AS sidst
FROM purchase_order_lines pol
JOIN purchase_orders po ON po.id = pol.purchase_order_id
WHERE pol.line_source = 'replacement'
GROUP BY replaces_barcode, barcode_value
ORDER BY antal DESC;
```

### 10b.5 Testcases

- [ ] Afvist linje viser varenavn + varenr + begge knapper
- [ ] "Spring over" → linjen bliver på indkøbslisten, `ordered_*` er ikke sat
- [ ] "Søg erstatning" → draweren åbner med varenavnet forudfyldt og søgningen kørt
- [ ] Valgt erstatning → `line_source='replacement'`, `replaces_barcode` sat
- [ ] Uden checkbox: Grocy-koblingen er **uændret** efter bestilling
- [ ] Med checkbox: ny barcode oprettet, `is_preferred` flyttet, gammel barcode findes stadig
- [ ] Historik-listen viser erstatningen efter bestilling

---

## 10c. A9 — Draweren skal forudfylde

Draweren har allerede begge veje ind (`indkob.js:2706`):

| Gren | `_ibDrawerTarget` | Hvad den gør |
|---|---|---|
| **A** | `'existing'` | Kobl varenr som barcode på eksisterende Grocy-produkt |
| **B** | `'new'` | Mounter `initProductCreate` — opretter nyt Grocy-produkt |

Den har også Hørkram-søgning indbygget (`_ibDrawerHkSearch`) og link til hoka.dk.
**Strukturen er der. Problemet er at intet bliver forudfyldt.**

```js
// indkob.js:2875 — alt hvad gren B får med i dag
initProductCreate(mount, { barcode: _ibDrawerVarenr || null, onCreated: ... });
```

Kun varenummeret, selvom Bon lige har hentet hele produktet fra Hoka.

### 10c.1 Hent det fulde produkt ved valg

Når et varenummer vælges i draweren, kald `GET /api/horkram/product/:varenr`.
`parseProduct` giver:

| Grocy-felt | Fra Hoka | Automatisk |
|---|---|---|
| Navn | `name` | ✅ |
| Nettovægt | `netWeightKg` | ✅ |
| Økologisk | `isOrganic` | ✅ |
| Oprindelsesland | `countryCode` | ✅ |
| CO₂e | `co2e` | ✅ |
| Brand / producent | `brand`, `manufacturer` | ✅ |
| Produktgruppe | `categories` | forslag |
| Lagerenhed | `baseUnitCode` | forslag — §10c.2 |
| **Min. lager** | — | **kun mennesket** |

Samme data sendes til **begge** grene: gren A bruger navn og pris på barcoden, gren B
forudfylder produktformularen.

### 10c.2 `unit_mappings` — lærende, ikke fast

Hokas kode bestemmer ikke din lagerenhed. `ps` på falaflen er en 2 kg pose, som du vil
lagerføre i **kg**. `st` på æblerne er ét æble, som du vil lagerføre i **stk**. Samme
kode, forskellig konklusion — det afhænger af varen, ikke af koden.

Derfor er en fast tabel forkert. Tabellen skal **huske hvad du gjorde**, ikke bestemme.

```sql
CREATE TABLE unit_mappings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    hoka_code         TEXT NOT NULL,        -- 'ps', 'st', 'kt', 'ks'
    grocy_qu_id       INTEGER NOT NULL,
    product_group_id  INTEGER,              -- NULL = gælder bredt
    use_count         INTEGER NOT NULL DEFAULT 1,
    last_used_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (hoka_code, grocy_qu_id, product_group_id)
);

CREATE INDEX idx_unit_mappings_lookup ON unit_mappings(hoka_code, product_group_id);
```

**Opslag ved forudfyldning:**

| Trin | Kriterium |
|---|---|
| 1 | `hoka_code` + `product_group_id` → højeste `use_count` |
| 2 | `hoka_code` alene → højeste `use_count` |
| 3 | intet forslag — feltet står tomt |

**Skrivning** ved hver oprettelse eller kobling:

```sql
INSERT INTO unit_mappings (hoka_code, grocy_qu_id, product_group_id)
VALUES (?, ?, ?)
ON CONFLICT (hoka_code, grocy_qu_id, product_group_id)
DO UPDATE SET use_count = use_count + 1, last_used_at = CURRENT_TIMESTAMP;
```

Ingen admin-UI. Ingen vedligeholdelse. Tabellen bygger sig selv af det du faktisk gør,
og lærer via `product_group_id` at frostvarer i pose bliver kg mens frugt i styk bliver stk
— uden at nogen skal formulere reglen.

**Forslaget vises som forudfyldt værdi i et almindeligt felt.** Ikke låst, ikke ledsaget af
en "vi har valgt for dig"-besked. Du skal kunne se og ændre det uden at klikke noget op.
Vælger du noget andet, får den nye kombination `use_count = 1` og overhaler eventuelt
den gamle med tiden.

### 10c.3 Foreslå gren, beslut ikke

Confidence-scoringen findes allerede i Indstillinger → Ny kobling (Dice/bigram,
>0.85 høj, >0.6 medium). Kør Hoka-navnet mod Grocy-produkterne:

| Resultat | Forslag |
|---|---|
| > 0.85 | gren A, produktet forudvalgt |
| 0.6 – 0.85 | gren A, produktet vist som "mente du…?" |
| < 0.6 | gren B |

Toggle mellem grenene forbliver altid aktiv. Det er et forslag.

### 10c.4 Migration

`unit_mappings` lægges i samme migrationsfil som A4 (§7) — den er additiv og har ingen
afhængigheder.

### 10c.5 Testcases

- [ ] Vælg varenr i draweren → navn, vægt, økologi, land, CO₂e er udfyldt
- [ ] Gren B: kun min-lager mangler at blive udfyldt manuelt
- [ ] Første `ps` → enhedsfeltet er tomt, du vælger; anden `ps` → forudfyldt
- [ ] `ps` i frostvarer og `ps` i kolonial kan give hver sin enhed
- [ ] Forudfyldt enhed kan ændres uden ekstra klik
- [ ] Højt navnematch → gren A forudvalgt; intet match → gren B
- [ ] Toggle mellem grene virker uanset forslag

---


## 11. Testcases

Alle mod referencevaren **60168828**.

### 11.1 Salgsenhed
- [ ] Chippen viser **poser** som default, ikke kartoner
- [ ] Enhedsvælgeren viser begge enheder med korrekt navn og antal
- [ ] Skift til kartoner ændrer pris fra 200 til 1.000 kr
- [ ] Valget gemmes i `supplier_unit_code` / `supplier_unit_qty`

### 11.2 Pris
- [ ] Chippen viser `200 kr` for pose — ikke tom, ikke 0, ikke 288,14
- [ ] Chippen viser `1.000 kr` for karton — ikke 200
- [ ] `100 kr/kg` vises for begge enheder (kommer fra Hoka)
- [ ] En vare uden pris viser `?` — ikke `0 kr`

```sql
-- Efter en bestilling: enheden skal stå på linjen
SELECT id, barcode_value, sales_unit_code, sales_unit_qty, quantity_ordered, price_per_pack
FROM purchase_order_lines
WHERE purchase_order_id = <id>;
-- forventet for 1 pose: ps | 1 | 1 | 200.0
```

### 11.3 Dækning (regressionsområde — bug #001)
- [ ] Behov 8 kg → **1 karton** (10 kg), ikke 2
- [ ] Behov 8 kg i poser → **4 poser** (8 kg)
- [ ] Behov 12 kg → 2 kartoner (20 kg)
- [ ] Vare uden `netWeightKg` → antal i salgsenheder, kg vist som `?`, intet gæt

### 11.4 Parser
- [ ] `parseDanishNumber("1.000,00 / karton")` → `1000`
- [ ] `parseDanishNumber("200,00 / pose")` → `200`
- [ ] `parseDanishNumber(null)` → `null` (ikke `0`)
- [ ] `salesPricePerSalesUnit` findes på begge enheder i `/snapshots`-svaret
- [ ] `/search` returnerer nu `salesUnits` efter A5c

### 11.5 Kilopris-assertion (A5e)

Begge varer er verificeret mod rigtige Hoka-data august 2026.

- [ ] 60168828 pose: udledt 200 / (1 × 2) = 100, matcher Hokas 100 → ingen advarsel
- [ ] 60168828 karton: udledt 1.000 / (5 × 2) = 100, matcher også → ingen advarsel
- [ ] 60106075 pose: udledt 168,15 / (1 × 2) = 84,08, matcher Hokas 84,08 → ingen advarsel
- [ ] 60106075 karton: udledt 840,75 / (5 × 2) = 84,08, matcher også → ingen advarsel
- [ ] Sæt bevidst `netWeightKg` forkert i en testkørsel → advarsel udløses
- [ ] Advarslen ændrer **ikke** den viste kilopris

### 11.6 Leveringsdato
- [ ] Kald uden `?date=` → **400**, ikke et svar for i morgen
- [ ] Samme vare på to forskellige datoer kan give to forskellige priser
- [ ] `_edd` optræder ikke i `sessionCache` efter et kald
- [ ] Bruger A sætter 04.08, bruger B kalder umiddelbart efter uden dato → B får 400,
      ikke A's dato
- [ ] Datovælgeren defaulter til første gyldige dag fra `/delivery-dates`

### 11.7 Kurv
- [ ] Tilføj 10 varer hvoraf 1 er ugyldig → 9 lander, den 10. vises som afvist med årsag
- [ ] Samme varenr i to enheder → to linjer, ikke én
- [ ] Eksisterende kurvlinjer overlever et nyt PUT

### 11.8 Varemodtagelse (A2 §5.4 + A7)
- [ ] Bestil **1 karton** → modtag **5 poser** → registreres som **fuld levering**,
      ikke overlevering
- [ ] `addStock` lægger 10 kg på lager, ikke 2 og ikke 50
- [ ] Linje uden `ordered_unit_qty` (bestilt før A2) → antages 1, advarsel logges
- [ ] Bestil en vare → omdøb leverandøren i Indstillinger → varemodtagelsen viser
      **stadig** varen som klar
- [ ] Linje uden `ordered_supplier_id` findes via navnet, og advarsel logges
- [ ] `goods_receipts.supplier_id` sættes ved nye modtagelser; gamle rækker har NULL
      og bryder ikke listevisningen

### 11.9 Migration
```sql
PRAGMA table_info(purchase_order_lines);
-- item_id skal nu have notnull=0
-- sales_unit_code, sales_unit_qty, product_name_snapshot,
-- line_source, replaces_barcode skal findes

PRAGMA table_info(goods_receipts);
-- supplier_id skal findes

SELECT COUNT(*) FROM purchase_order_lines;
-- skal matche antallet før migrationen — noter det inden
```

---

## 12. Rækkefølge og go-live-blockere

| Deploy | Indhold | Blokerer |
|---|---|---|
| **0** | Grocy userfields oprettes (§2) på alle tre instanser | forudsætning for Deploy 2 |
| **1** | A4 (migration, inkl. `goods_receipts.supplier_id`) | intet — additiv, ingen adfærdsændring |
| **2** | A1 + A2 + A3 + A5a-e + A7 skrive- og læseside + A8 + A9 | **hænger sammen.** A5a omdøber parser-felter og bryder kaldere; A2 kræver A5a for at vise pris pr. enhed; A1 ændrer route-signaturer og kræver frontend samtidig; A2 og A7 rører samme funktion (§5.5); varemodtagelsen skal med, ellers flytter A2 fejlen til lageret. A8 afhænger af A3's `rejected[]`; A9 afhænger af A5c's berigede søgeresultater |
| **3** | A6 + `indkob_trust_unit_userfields = 1` | afventer Leifs beslutning (§9.2) |

**Go-live-blockere for at genoptage normal bestilling:** A2, A5b og §5.4.
Indtil de er ude, gælder §0.

Deploy 2 kan ikke splittes. Forsøg ikke at tage A5a alene "for at komme i gang" — så står
frontenden med felter der ikke findes, og fejlen bliver stille igen.

---

## 13. Ikke i denne fase

| | Hvorfor | Hvor |
|---|---|---|
| Kladde-entitet (`status='draft'` i brug) | Kræver nyt UI. `GET /pending` filtrerer allerede på `'draft'`, så halvdelen findes | Fase C |
| "Bestillinger" som selvstændigt view | Samme. Pill'en omdøbes midlertidigt i Fase B (B1.2) | Fase C |
| Engangskøb via `/search` | A4 og A5c gør det muligt; UI'et er Fase C | Fase C |
| Permanent erstatnings-automatik | A8 viser historik; beslutningen er altid Leifs. Sæsonvarer gør automatik forkert | bevidst fravalgt |
| Kortlægning af Hokas interne tilgængeligheds-API | Unødvendig når afvisningen er signalet | bevidst fravalgt |
| Persistér udgået-status | `_isDeadBarcodes` (`indkob_settings.js:1604`) lever kun i browserhukommelse. Kræver gyldig leveringsdato først, altså A1 | Fase C |
| Kildefelt på `shopping_list` | Datamodel-ændring, hænger sammen med forecast (ASIS §14 spm. 2 + 8) | Fase C |
| Sæt `_edd` som eksplicit PUT | Cookie-injektion i A1 er nok. Det rå PUT-payload (42 bytes) er stadig ikke dokumenteret | noteret |
| Default-enhed fra købshistorik | `/api/accounting/purchasehistory/{id}` proxies allerede (`horkram.js:805`). "Sidst: 1 pose" ville være en bedre default end `isDefault` — jeres adfærd frem for Hokas anbefaling | overvejes efter A6 |
| Fjern `services/hokaAdapter.js` | Død kode | Fase B, B3.1 |

---

## 14. Åbne punkter

| Punkt | Ejer |
|---|---|
| A6: automatisk oprydning eller gennemgangsliste? | Leif |
| Omfanget af forkerte `supplier_unit_qty` (§9.1) | Simon kører, Leif vurderer |
| Er der reelt bestilt kartoner hvor I ville have poser? | Leif, via `/api/horkram/orders` |
| Rå payload for PUT `/api/checkout/basket` (42 bytes) | Leif, valgfrit |
| ~~Er `availableForOrder` brugbar?~~ **Bortfaldet.** A8 bygger ikke på detektion — afvisningen fra `validate=true` er signalet | lukket |
| Kalkulationsmodulet: `supplier_price_per_kg` er kilde til kostpris. Kiloprisen er enhedsuafhængig og formentlig korrekt — **verificér, men pausér ikke** | Simon |

---

*Skrevet august 2026. Grounded i `routes/horkram.js`, `services/hokaParser.js`,
`shared/indkob.js`, `shared/indkob_settings.js`, `routes/orders.js`,
`routes/goods-receipts.js`, migrationerne 005 + 030, og verificeret netværkstrafik
mod hoka.dk 31.07.2026. Referencer til `../CLAUDE_INDKOB_ASIS.md` følger den udvidede
version (smertepunkter i §12).*
