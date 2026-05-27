# Spec: Opret produkt — Bon v2
**Version:** 1.0
**Dato:** 2026-04-29
**Status:** Klar til deploy
**Fil:** `tools/grocy/opret-produkt.html`

---

## 1. Overblik

Tool til at oprette nye produkter i Grocy med relevante koblinger i én samlet flow:
produkt → QU-konvertering → userfields → stregkode/leverandør → initial lagerbeholdning.

Designet til to primære use cases:

1. **Generel admin** — opret produkter fra bunden ved planlægning
2. **Varemodtagelse** — registrer en ny vare man fysisk har i hånden

Princip: undgå at skulle hoppe ind i Grocy admin for hverdagsopgaver. Alt der
skal kunne sættes ved oprettelse er tilgængeligt i én formular.

---

## 2. Filstruktur

```
tools/grocy/opret-produkt.html    ← selve toolet
```

Følger standard bontool-template:
- `BonConfig.js` + `BonConfigBar.js` (data-tool="Opret produkt", data-type="grocy")
- `bon-base.css` + `bon-dark.css`
- Lytter på `bonconfig:ready` + `bonconfig:change` for installation-skift

---

## 3. Formular-struktur

Tre sektioner, mobile-first layout, max-width 720px:

### Grunddata (altid synlig)
| Felt | Type | Required | Note |
|------|------|----------|------|
| Navn | text | ✓ | Auto-fokus ved load |
| Indkøbs-QU | select (alle units) | ✓ | Default: Kilo |
| Lager-QU | select (kun Kilo/Stk) | ✓ | Default: Kilo. **Restricted** |
| QU-konverteringsfaktor | number | conditional | Vises kun hvis purchase ≠ stock |
| Default-lokation | select | ✓ | Fra `/objects/locations` |
| Varegruppe | select | optional | Fra `/objects/product_groups` |

### Workflow (altid synlig)
| Felt | Type | Note |
|------|------|------|
| Primær leverandør | select | Fra `/objects/shopping_locations` |
| Min. beholdning | number | Udløser indkøbsliste |
| HverDag (check-interval) | number | Userfield. Skjules hvis det ikke findes på `products` entity. Caption fra Grocy hvis tilpasset |
| Antal på lager nu | number | Valgfri. Stock-QU vist som dynamisk label |
| Pris (Total / Pr. enhed) | number + toggle | Valgfri. Toggle styrer hvordan tallet tolkes ved submit |
| Bedst før | date | Valgfri. Default `2999-12-31` ved tom |

### Stregkode/varenummer (foldout, lukket default)
| Felt | Type | Note |
|------|------|------|
| Stregkode/Varenummer | text | EAN eller leverandør-varenummer |
| Salgsenhed-kode | text | `supplier_unit_code` userfield (fx 'ks', 'st') |
| Salgsenhed-antal | number | `supplier_unit_qty` userfield |
| Pris pr. enhed | number | `last_price` på barcode (Grocy native) |

---

## 4. API-endpoints brugt

Alle via `grocyAPI.call(path, method, body)` (event-baseret init).

### Load (parallel ved init)
```
GET /objects/quantity_units
GET /objects/locations
GET /objects/product_groups
GET /objects/shopping_locations
GET /objects/userfields    ← filtreret på entity='products'
```

### Submit
```
POST   /objects/products
POST   /objects/quantity_unit_conversions   (kun hvis QU purchase ≠ stock)
PUT    /userfields/products/{id}            (kun hvis HverDag findes + udfyldt)
POST   /objects/product_barcodes            (kun hvis stregkode udfyldt)
PUT    /userfields/product_barcodes/{id}    (kun hvis salgsenhed-felter udfyldt)
POST   /stock/products/{id}/add             (kun hvis antal > 0)
```

---

## 5. Submit-flow (i rækkefølge)

```
1. Validation (navn, QU'er, lokation påkrævet)
2. POST /objects/products → få productId
3. POST /objects/quantity_unit_conversions
   { product_id, from_qu_id, to_qu_id, factor }
   (kun hvis purchase ≠ stock)
4. PUT /userfields/products/{id}
   { HverDag: <antal dage> }
   (kun hvis HverDag userfield findes på products + brugeren har udfyldt)
5. POST /objects/product_barcodes
   { product_id, barcode, qu_id, amount: 0, shopping_location_id?, last_price?, note }
   (kun hvis stregkode udfyldt)
6. PUT /userfields/product_barcodes/{bcId}
   { supplier_unit_code?, supplier_unit_qty? }
   (kun hvis udfyldt)
7. POST /stock/products/{id}/add
   { amount, transaction_type: 'purchase', best_before_date, price? }
   (kun hvis antal > 0)
8. Vis resultatkort med eventuelle warnings
```

**Fejlhåndtering:** Hvis steps 3-7 fejler, samles fejl som warnings og produktet
beholdes — kein rollback. Det betyder at en mislykket userfield-PUT eller
barcode-create ikke spiser et succesfuldt oprettet produkt.

---

## 6. Konventioner og constraints

### Stock-QU er begrænset
Kun **Kilo** (vægt) eller **Stk** (tællelige varer). Default er Kilo.
Dette håndhæves i dropdown'en for at understøtte vægt-/CO2-beregninger
fremover. Indkøbs-QU er fri (kasse, ks, l, m, mm).

### QU-konvertering som separat objekt
Grocy gemmer **ikke** `qu_factor_purchase_to_stock` som column på products i
denne installation. Konverteringen oprettes i den separate
`quantity_unit_conversions`-tabel.

### Pris pr. stock-enhed
`/stock/products/{id}/add` forventer pris pr. stock-enhed. Toggle styrer beregningen:
- `total` mode: `price = priceVal / amountNum`
- `per_unit` mode: `price = priceVal` (direkte)

Pris-enhedslabel ("Pr. kg" / "Pr. stk") opdateres dynamisk når stock-QU skifter.

### Default-felter på produkt
Minimal payload for at undgå at ramme columns der ikke findes:
```js
{ name, qu_id_purchase, qu_id_stock, location_id,
  product_group_id?, shopping_location_id?, min_stock_amount? }
```

### Dynamic userfield-detection
Userfields hentes ved load og filtreres på `entity === 'products'`. Felter i
formularen vises kun hvis det tilsvarende userfield faktisk eksisterer i Grocy.
Lige nu gælder det `HverDag` — princippet kan udvides til flere felter.

---

## 7. Userfields brugt

Fra `CLAUDE.md`'s autoritative liste:

### products entity
- `HverDag` (text-single-line) — check-interval i dage. **Case-sensitive**

### product_barcodes entity
- `supplier_unit_code` (text_single_line) — fx 'ks', 'st'
- `supplier_unit_qty` (text_single_line) — antal base-enheder pr. salgsenhed

---

## 8. Kendte begrænsninger

### QU-konvertering bruges ikke ved direkte stock-add
Når lager-QU er Stk og indkøbs-QU er Kasse, vil "Antal på lager nu" stadig være
i Stk — ikke kasser. Det er Grocys logik: `/stock/add` arbejder altid i
stock-QU. Brugeren skal selv gange op (1 kasse × 24 stk = skriv 24).

### Initial price er per-stock-unit
Hvis bruger ikke ved hvad det koster pr. stock-enhed, kan det føles akavet.
Toggle løser det halvt (total → divideres), men kun hvis brugeren også har
udfyldt antal.

### Ingen rollback ved partial fail
Et produkt kan blive oprettet uden tilhørende stregkode/userfields/lager hvis
follow-up steps fejler. Vises som warnings i resultatkortet, men brugeren skal
selv reagere.

---

## 9. Næste skridt / fremtidige features

Listet i prioritetsrækkefølge baseret på workflow-værdi:

### Tæt på (lav indsats, høj nytte)
- **Auto-populer `supplier_price_per_kg`** på produkt når pris og lager-QU=Kilo
  er udfyldt. Også sætte `price_updated_at`
- **Co2e userfield** — valgfri number-felt. Bruges af VarePicker fremover
- **`is_preferred` toggle** på stregkode-sektion — markér foretrukken leverandør

### Mellem (kræver mere logik)
- **Hørkram-varenummer auto-udfyld** — paste varenr → fetch via
  `/api/horkram/product/:varenr` → udfyld navn, brand, gtin, last_price,
  supplier_unit_code, supplier_unit_qty. Genbruger eksisterende proxy-endpoint
- **Udvid dynamic userfield-detection** til at vise alle relevante product
  userfields automatisk (Co2e, hk_organic, hk_country osv.) som valgfri
- **Validering af eksisterende navn** — advarsel hvis et produkt med samme
  navn allerede findes (fuzzy match)

### Senere
- **Genvej fra varemodtagelse.html** — knap "Opret nyt produkt fra denne
  vare" der åbner toolet med pre-udfyldt data
- **Bulk-oprettelse** — paste flere varer fra Excel/CSV
- **Admin-funktionalitet** — edit eksisterende produkter (samme formular)

---

## 10. Deploy

### A. Tilføj kort til index.html
I `<nav class="tools-grid">`:

```html
<a href="/tools/grocy/opret-produkt" class="tool-card">
  <div class="tool-icon">➕</div>
  <div class="tool-name">Opret produkt</div>
  <div class="tool-desc">Tilføj nyt produkt til Grocy med leverandør, lager og stregkode.</div>
  <span class="tool-badge grocy">Grocy</span>
</a>
```

### B. Verificer manuelt efter deploy
1. Åbn toolet → master-data loader uden fejl
2. Opret simpelt produkt (kun Navn, default-lokation) → success
3. Opret produkt med QU-konvertering (Kasse → Kilo, factor 6000) → tjek
   konverteringen findes i Grocy under produktet
4. Opret produkt med initial-lager + total pris → tjek pris pr. kg er
   korrekt i Grocy
5. Opret produkt med stregkode + salgsenhed → tjek alle felter er gemt
6. Toggle Total/Pr. kg → tjek beregningen stemmer

### C. Hvis HverDag-feltet ikke vises
Det betyder at userfield `HverDag` (camelCase!) ikke findes på `products`
entity i den aktuelle Grocy-installation. Opret det manuelt under
**Grocy → Manage master data → Userfields**:
- Entity: products
- Name: `HverDag`
- Type: text-single-line
- Caption: fx "Check-interval (dage)"

---

## Session-noter

- Bygget i én session 2026-04-29
- Opdaget undervejs: `qu_factor_purchase_to_stock` findes ikke som column
  i jeres Grocy — derfor separat `quantity_unit_conversions` POST
- Opdaget undervejs: userfield hedder `HverDag` (camelCase), ikke `hverdag`,
  og betyder check-interval — ikke opbevaringsplads som først antaget
- Stock-QU restriction (Kilo/Stk) tilføjet som hjælp til vægt-/CO2-arbejdet
  fremover — fjernede behovet for diagnose-funktion og warning-callout
