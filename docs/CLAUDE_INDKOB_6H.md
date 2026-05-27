# CLAUDE_INDKOB_6H.md
> Spec for Fase 6h — Indkøb: samlet liste, opret/kobl-flow og kanal-labels
> Læs `CLAUDE_INDKOB.md`, `CLAUDE_SETTINGS_INDKOB.md` OG **`shared/indkob.js`** FØR du begynder.
> Mockup: `docs/indkob_mockup_6h.html`
> Berørte filer: `shared/indkob.js`, `shared/indkob.css`, `routes/horkram.js`
> Genbruger uændret backend — se "Backend der genbruges".

---

## Baggrund

Fire problemer i den nuværende indkøbsliste, identificeret i drift:

1. **Leverandør-opdelingen kommer for tidligt.** Det daglige behov er "har jeg det hele med?" — det kræver én samlet liste. Opdelingen pr. leverandør betyder kun noget i selve bestillingsøjeblikket.
2. **To "Hørkram"-blokke.** Convi-varer købes via Hørkram og ligger i en separat Grocy shopping_location, men begge blokke labels med V2-leverandørnavnet → to identiske "Hørkram"-headers.
3. **Ingen klar vej til nye varer.** "Søg Grocy-produkt" lægger eksisterende varer på, men man ser ikke hvor de landede; og der er ingen brugbar vej til varer der ikke findes i Grocy, eller til at koble et Hørkram-varenummer til en eksisterende vare.
4. **Varenummer-opslag er skjult i Settings.** Koblingen lever kun i Settings → Hørkram, langt fra det øjeblik hvor behovet opstår.

Alle fire løses uden ny adapter-kode. Den eneste nye backend er varenummer-validering i `routes/horkram.js`.

---

## Del 1 — To views: Samlet liste + Klar til bestilling

### Beslutning
`shared/indkob.js` får to visningstilstande styret af én toggle i toolbaren:

| View | Default | Grupperet efter | Formål |
|------|---------|-----------------|--------|
| **Samlet liste** | ✅ | Produktkategori (Grocy product_group) | "Har jeg det hele med?" |
| **Klar til bestilling** | | Indkøbskanal (shopping_location) | "Hvor købes hvad — gå til kurv" |

Den eksisterende **Liste/Fokus**-toggle erstattes IKKE blindt. **Læs `indkob.js` først** og afgør om Fokus-tilstanden bevares som en tredje knap, eller om den nye Samlet/Bestilling-akse afløser den. Beslutning noteres i implementeringen og bekræftes med Leif hvis Fokus har en funktion der ikke er dækket.

### Samlet liste (ny)
- Grupperet efter produktkategori (samme kategori-data som køkkenets kategori-overblik).
- Hver linje: produktnavn · behov · qty-stepper · **destinations-tag** (dæmpet): `→ Hørkram`, `→ Convi`, eller `⚠ mangler leverandør`.
- Linjer uden shopping_location (umatched) får `⚠ mangler leverandør` + en `Kobl →`-knap (se Del 4). Det er den eneste completeness-blocker der skal være synlig her.
- Footer: `N varer på listen · M mangler leverandør`.
- **Ingen** leverandør-blokke, ingen "Gå til kurv" i dette view — det er et arbejds-/tjek-view.

### Klar til bestilling (nuværende view, justeret)
- Beholder de eksisterende leverandørblokke med chips, kr/kg-beregning og "Gå til kurv".
- Eneste ændring her er kanal-labels (Del 2) og at en ren-umatched blok ("Uden leverandør") får `Kobl →` pr. linje i stedet for en blind "umatched"-tæller.

### Toggle
Placeres hvor Liste/Fokus sidder i dag. Default = Samlet liste ved sideindlæsning. Valget behøver ikke persisteres på tværs af sessioner (men må gerne i `localStorage` med nøgle `ib_view_mode` hvis det er trivielt).

---

## Del 2 — Kanal-labels (Convi-fix)

Grupperingsnøglen er allerede `shopping_location_id` — **det er kun labelen der er forkert.** Header skal vise indkøbskanalens eget navn, ikke V2-leverandørnavnet.

**Label-opløsning (rækkefølge):**
1. Display-navn på koblingen `supplier ↔ grocy-location` (sat i Settings Tab 1, jf. `CLAUDE_SETTINGS_INDKOB.md`)
2. Grocy shopping_location-navnet (`GET /api/grocy/shopping-locations`)
3. V2-leverandørnavn (nuværende adfærd — fallback)

Subtekst under header må vise leverandøren når den afviger fra kanalen, fx:
```
Convi                       (1 klar)   [Gå til kurv →]
købes via Hørkram · kanal: Drikkevarer
```

**Forudsætning — verificér FØR kodning:** Bekræft hvor display-navnet ligger. Hvis hverken Grocy-lokationsnavnet eller et eksisterende koblings-felt giver et distinkt navn, så er en lille tilføjelse til koblingstabellen nødvendig — men det afgøres ved at læse den faktiske kobling, ikke ved at gætte. Ingen blind migration.

---

## Del 3 — Opret / kobl vare (drawer)

Søgefeltet i toolbaren er den primære tilføj-vej (søg eksisterende Grocy-vare → læg på liste). Drawer'en er **kun** for varer der ikke kan findes via søgning. Knappen omdøbes derefter (fx "Vare ikke fundet? + Opret/kobl").

Drawer'en er ét flow i to trin:

```
1 · Find varenummer hos Hørkram   →   2 · Knyt til Grocy-vare
   (søg Hoka / indsæt manuelt)         ( ) Eksisterende vare  (default)
                                        ( ) Helt ny vare
```

Trin 1 kommer først fordi varenummeret er det svære. Trin 2 vælger destination.

### Gren A — "Eksisterende vare" (hyppigst: ny barkode til vare der allerede er i Grocy)
1. `POST /api/grocy/product-barcodes` med:
   ```js
   { product_id, barcode, shopping_location_id, note, amount, qu_id, last_price }
   ```
   Håndtér 409 `BARCODE_DUPLICATE` (adapteren mapper allerede Grocy-duplikat → 409): vis "varenummeret er allerede koblet til denne vare".
2. `POST /api/grocy/shopping-list/add-product` `{ product_id, product_amount, list_id, note }`.

### Gren B — "Helt ny vare" (genbruger eksisterende createProduct-kæde)
1. `POST /api/grocy/products` (→ `created_object_id`):
   ```js
   { name, qu_id_purchase, qu_id_stock, location_id,
     product_group_id, min_stock_amount, shopping_location_id }
   ```
   Felter hentes fra: `GET /api/grocy/quantity-units`, `/locations`, `/product-groups`, `/shopping-locations`.
2. Hvis indkøbs-QU ≠ lager-QU: `POST /api/grocy/quantity-unit-conversions` `{ product_id, from_qu_id, to_qu_id, factor }`.
3. Som Gren A trin 1 (barcode), med `product_id = created_object_id`.
4. Som Gren A trin 2 (shopping-list).

### Find varenummer (trin 1)
- **Søg:** kald Hoka-søgning (samme mekanik som Settings Tab 3 Opslag, `GET /api/horkram/search?q=`). Resultat: navn · varenr · pakkeform · pris · leverandør → "Vælg" udfylder varenummer + henter pack/pris.
- **Manuel:** input-felt + link til hoka.dk. Ved manuel indtastning → validér (se Del 5).
- **Hjælpetekst** (altid synlig): kort "sådan finder du varenummeret" så køkkenpersonale kan det uden oplæring.

### Bekræftelse (toast)
- Gren A: `✓ varenr. X koblet til «vare» · lagt på listen`
- Gren B: `✓ «vare» oprettet i Grocy + koblet til varenr. X · lagt på listen`

---

## Del 4 — "Kobl →" fra umatched linjer

Enhver umatched linje (samlet view: `⚠ mangler leverandør`; bestillingsview: "Uden leverandør"-blok) får en `Kobl →`-knap.

Klik åbner samme drawer som Del 3, men:
- Trin 2 er låst til **Eksisterende vare**, forudfyldt med den kendte Grocy-vare (ingen produktsøgning nødvendig).
- Trin 1 forudfyldes med varens navn som søgning i Hoka.

Det er den eneste forskel — resten af flowet er identisk.

---

## Del 5 — Varenummer-validering (eneste nye backend)

Når et varenummer indtastes **manuelt** (ikke valgt fra et Hoka-søgeresultat), valideres det mod Hoka før kobling:

**Ny/bekræft endpoint i `routes/horkram.js`:**
```
GET /api/horkram/lookup/:varenr   →  { found, name, pack, unit, price_per_unit }  | { found:false }
```
Hvis et tilsvarende opslag allerede findes (numerisk søgning via `/search`), genbrug det og dokumentér det i stedet for at tilføje en dublet-route.

**Adfærd:**
- `found:true` → udfyld pack/pris automatisk på koblingen, fortsæt.
- `found:false` → advar ("Varenummeret blev ikke fundet hos Hørkram"), men **blokér ikke** — tillad kobling med tom pris (samme tolerance som i dag). Begrundelse: et nyt/sjældent varenummer kan være gyldigt selvom katalog-opslaget ikke rammer.

---

## Backend der genbruges (ingen ny adapter-kode)

| Endpoint | Adapter-funktion | Bruges i |
|----------|------------------|----------|
| `POST /api/grocy/products` | `createProduct` | Del 3 Gren B |
| `POST /api/grocy/quantity-unit-conversions` | `createQuConversion` | Del 3 Gren B (QU≠QU) |
| `POST /api/grocy/product-barcodes` | `createProductBarcode` (409-mapping) | Del 3 + 4 |
| `POST /api/grocy/shopping-list/add-product` | `addShoppingListProduct` | Del 3 + 4 |
| `GET /api/grocy/shopping-locations` | `getShoppingLocations` | Del 2 label + Del 3 kanal |
| `GET /api/grocy/quantity-units` · `/locations` · `/product-groups` | resp. | Del 3 Gren B felter |
| `PUT /api/grocy/products/:id` | `updateProduct` | (kun hvis felter ikke sættes i create-body) |

---

## Rækkefølge for implementering

1. **Læs `shared/indkob.js`** — kortlæg nuværende gruppering, Liste/Fokus-toggle og hvor "Søg Grocy-produkt"/"Opret nyt produkt" sidder.
2. Del 2 — kanal-labels (mindst invasiv, verificér display-navn-kilden først).
3. Del 1 — Samlet liste + toggle.
4. Del 3 — opret/kobl-drawer (genbrug createProduct-kæden).
5. Del 4 — "Kobl →" genvej (deler drawer med Del 3).
6. Del 5 — varenummer-validering i `routes/horkram.js`.

---

## Acceptkriterier

- [ ] Samlet liste er default; viser alle varer grupperet efter kategori med destinations-tag.
- [ ] Toggle skifter til bestillingsview med leverandørblokke + "Gå til kurv".
- [ ] Convi vises som egen header adskilt fra Hørkram (label, ikke ny gruppe).
- [ ] "Vare ikke fundet?"-knap åbner drawer; Gren A kobler til eksisterende vare; Gren B opretter ny vare via `createProduct` + kobler.
- [ ] "Kobl →" på en umatched linje åbner drawer med varen låst i trin 2.
- [ ] Manuelt varenummer valideres mod Hoka; ukendt nummer advarer men blokerer ikke.
- [ ] Duplikat-barcode giver pæn 409-besked, ikke en rå fejl.

---

## Checkliste til CLAUDE.md

```
#### Fase 6h — Indkøb: samlet liste + opret/kobl (spec: CLAUDE_INDKOB_6H.md)
- [ ] Del 1: shared/indkob.js — Samlet liste + Bestilling-toggle (default Samlet)
- [ ] Del 2: shared/indkob.js — kanal-labels (Convi-fix, display-navn → lokationsnavn → leverandør)
- [ ] Del 3: shared/indkob.js — opret/kobl-drawer (genbrug createProduct + product-barcodes + add-product)
- [ ] Del 4: shared/indkob.js — "Kobl →" genvej fra umatched linjer
- [ ] Del 5: routes/horkram.js — GET /api/horkram/lookup/:varenr (varenummer-validering)
- [ ] shared/indkob.css — samlet-liste-rækker + drawer
```
