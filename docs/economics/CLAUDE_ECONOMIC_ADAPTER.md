# CLAUDE_ECONOMIC_ADAPTER.md — E-conomic faktura-adapter
> Læs CLAUDE.md, docs/bon_v2_datamodel_v2.md og **BON_V2_PRINCIPPER.md sektion 6b+6c** FØR du starter.
> Auth/forbindelse: se **CLAUDE_ECONOMIC_AUTH.md** (tokens, API-baser, fejlhåndtering).
> Status: ikke bygget. Spec oprettet maj 2026; payload-struktur korrigeret mod faktisk API juni 2026.

---

## Formål

Når Bon v2 skal sende fakturaer til e-conomic, skal denne adapter konvertere
en Bon v2 `bon` til en e-conomic-faktura-payload og POST'e den til
`/invoices/drafts` på REST-API'et (`restapi.e-conomic.com`).

---

## MOMS-HÅNDTERING — kritisk (uændret — doktrinen er korrekt)

E-conomic kræver linje-priser **EX MOMS**. E-conomic beregner selv momsen ud
fra kundens momszone + produktets momskode — vi sender ALDRIG et momsbeløb
eller en momssats i payloaden.

Bon v2-konvention (jf. `BON_V2_PRINCIPPER.md` sektion 6b):
- `bon_lines.unit_price` er **INCL. moms**
- `bon_lines.line_total` er **INCL. moms**
- `bons.total_price` er **INCL. moms**
- `bons.delivery_price` er **INCL. moms**

Konvertér derfor hver pris til ex moms med `shared/moms.js` før den sendes.

---

## API-STRUKTUR — korrigeret mod faktisk e-conomic REST API

> Den oprindelige payload (maj-spec) brugte snake_case-felter, `vat_zone: 25`
> og et `delivery_line`-objekt. Ingen af delene matcher e-conomics API og ville
> få POST'en til at fejle. Nedenstående er forankret i e-conomics egen
> draft-invoice-skabelon.

**Verificeret mod e-conomic REST API (25. juni 2026):**
- Linje-rabat-feltet hedder `discountPercentage` (0–100) — bekræftet. ✅
- Referencer: `references.salesPerson` ("Vor ref"), `references.customerContact` ("Deres ref"),
  `references.other` (fri tekst). "att."-personen = `recipient.attention`.
- Number-shortcut-formen (`customerNumber`/`paymentTermsNumber`/`layoutNumber`/`vatZoneNumber`/
  `customerContactNumber`/`employeeNumber`/`productNumber`) er gyldig — `.self`-URI er ikke nødvendig.
- Levering: bekræft mod live-skema om det er inline `delivery {address,zip,city,...}` eller
  `deliveryLocation`-reference (Simon har tokens — afklares ved build). Resten er bekræftet.

**Nøglefakta der adskiller sig fra maj-spec'en:**

| Felt | Korrekt form | Note |
|------|--------------|------|
| `date` | afsendelsesdag (`todayISO()`) | Fakturadato = i dag. IKKE leveringsdato (se `delivery`) |
| `customer` | `{ customerNumber }` (objekt) | Opløses pr. bon: erhverv → `companies.economic_customer_id`, ellers privat → `customers.economic_customer_id` (`resolveEconomicCustomer`) |
| `recipient.name` | firmanavn / kundenavn | "Region Hovedstaden" på reference-fakturaen |
| `recipient.vatZone` | `{ vatZoneNumber: 1 }` | 1 = indenlandsk DK. IKKE momssatsen. EU=2, udland=3 |
| `recipient.attention` | `{ customerContactNumber }` | "att."-personen, fra `customers.economic_contact_id` hvis sat |
| `delivery` | `{ deliveryDate, address, zip, city, country }` | Leveringsdato + -adresse PÅ fakturaen (afviger ofte fra fakturaadressen) |
| `references.other` | bon-nr (+ rekvisition/PSP) | Fakturaens reference ("3484 …"). Se EAN-sektion |
| `paymentTerms` | `{ paymentTermsNumber }` | Fra settings (1 = Netto 8 dage) |
| `layout` | `{ layoutNumber }` | Fra settings (19) |
| linje-`product` | `{ productNumber }` (**String!**) | `economic_product_number`-userfield pr. Grocy-**recipe** (via `grocy_recipe_id`). ⚠️ Skal sendes som STRING — e-conomics skema afviser et tal (verificeret 25. juni mod live API) |
| linje-`unitNetPrice` | ex moms, **maks. 2 decimaler** | e-conomic regner selv linjesum + moms |
| linje-`discountPercentage` | `bon.offer_discount_percent` | Pr. linje. Se RABAT-sektion |
| levering | almindelig linje i `lines` med eget `product` | IKKE et separat `delivery_line`-objekt |

```javascript
const { inclToExcl } = require('../shared/moms');
const { todayISO } = require('../db/helpers');

// Konfiguration fra settings (IKKE hardcoded, IKKE .env):
//   economic_default_payment_terms_number = 1  (Netto 8 dage)
//   economic_layout_number                = 19 (DK std. m. bankoplys.)
//   economic_delivery_product_number      = <produkt for "Levering" i e-conomic>
const settings = getEconomicSettings(); // læser settings

function round2(n) { return Math.round(n * 100) / 100; }

// Opløs e-conomic kundenummer: erhverv → firma, ellers privat → kunde.
// Returnerer null hvis intet er sat → blokér (se fejlhåndtering).
function resolveEconomicCustomer(bon) {
    if (bon.company?.economic_customer_id) return Number(bon.company.economic_customer_id);
    if (bon.customer?.economic_customer_id) return Number(bon.customer.economic_customer_id);
    return null;
}

// Synlig reference på fakturaen: bon-nr (+ evt. rekvisition/PSP, se EAN-sektion).
function buildReference(bon) {
    return [bon.bon_number, bon.requisition_ref].filter(Boolean).join(' · ');
}

function buildDraftInvoice(bon) {
    const lines = bon.lines.map((line, i) => ({
        lineNumber:   i + 1,
        // economic_product_number = Grocy-userfield pr. RECIPE, slået op på
        // line.grocy_recipe_id via grocyAdapter. Mangler det → se fejlhåndtering.
        product:      { productNumber: line.economic_product_number },
        description:  line.special_request
                        ? `${line.product_name} (${line.special_request})`
                        : line.product_name,
        quantity:     line.quantity,
        unitNetPrice: round2(inclToExcl(line.unit_price)), // EX moms, 2 decimaler
        // line_total/moms udelades — e-conomic beregner selv
    }));

    // Miljøgebyr, servicepersonale, rabat-linjer osv. er Grocy-recipes (x-Service/
    // x-Levering) og kommer derfor allerede med ovenfor som almindelige bon_lines —
    // ingen særbehandling. Se "FAKTURALINJER".

    // ENESTE særtilfælde: det nye logistik-system gemmer levering på bon.delivery_price
    // + delivery_vehicle_id UDEN en linje. Syntetisér da en leveringslinje fra køretøjets
    // varenr. Spring over hvis bonen allerede HAR en x-Levering-linje (ellers dobbelttælling
    // — samme logik som recalcBonTotal's hasLeveringLine).
    const hasDeliveryLine = bon.lines.some(l => l.category === 'x-Levering');
    if (bon.delivery_price > 0 && !hasDeliveryLine) {
        const deliveryProductNo =
            bon.delivery_vehicle_economic_product_number      // fra delivery_vehicles
            || settings.delivery_fallback_product_number;     // 17 (default)
        lines.push({
            lineNumber:   lines.length + 1,
            product:      { productNumber: deliveryProductNo },
            description:  bon.delivery_vehicle_label
                            ? `Levering (${bon.delivery_vehicle_label})`
                            : 'Levering',
            quantity:     1,
            unitNetPrice: round2(inclToExcl(bon.delivery_price)),
        });
    }

    const addr = bon.delivery_address;

    return {
        date:         todayISO(),               // afsendelsesdag — IKKE leveringsdato (se delivery)
        currency:     'DKK',
        customer:     { customerNumber: resolveEconomicCustomer(bon) },
        // Global default fra settings. Per-kunde override = senere (se note nedenfor).
        paymentTerms: { paymentTermsNumber: settings.default_payment_terms_number },
        layout:       { layoutNumber: settings.layout_number },
        recipient: {
            name:    bon.company?.name
                       || `${bon.customer.first_name} ${bon.customer.last_name || ''}`.trim(),
            vatZone: { vatZoneNumber: 1 },      // indenlandsk DK (se EAN-sektion for offentlige)
            ...(bon.customer?.economic_contact_id
                ? { attention: { customerContactNumber: Number(bon.customer.economic_contact_id) } }
                : {}),
        },
        // Leveringsdato + -adresse PÅ fakturaen (afviger ofte fra kundens fakturaadresse)
        ...(addr ? {
            delivery: {
                deliveryDate: bon.delivery_date,
                address:      `${addr.street_name} ${addr.street_nr || ''}`.trim(),
                zip:          addr.postal_code,
                city:         addr.city,
                country:      'Danmark',
            },
        } : {}),
        references: {
            other: buildReference(bon),                  // bon-nr (+ rekvisition, se EAN)
            // salesPerson: { employeeNumber: ... },      // "Vor ref" — valgfrit, hvis vi mapper sælger → e-conomic-medarbejder
        },
        lines,
    };
}
```

**Konfiguration i `settings` (ikke hardcoded, ikke `.env`):**

| Nøgle | Værdi | Note |
|-------|-------|------|
| `economic_default_payment_terms_number` | `1` | Netto 8 dage (global default) |
| `economic_layout_number` | `19` | DK std. m. bankoplys. — altid samme |
| `economic_delivery_fallback_product_number` | `17` | Leverings-varenr når bon **ikke** har køretøj |
| `economic_fee_product_number_miljobidrag` | `98` | Miljøbidrag-linje |
| `economic_fee_product_number_kortbetaling` | `99` | ⏳ Forberedt — inaktiv til felt findes |
| `economic_fee_product_number_ekspres` | `64` | ⏳ Forberedt — inaktiv til felt findes |

**Leverings-varenr pr. køretøj bor IKKE i settings** — det bor på
`delivery_vehicles.economic_product_number` (ny kolonne), så office sætter det
i den eksisterende vehicle-admin (`PATCH /vehicles/:id`). Mapning:

| Køretøj (type) | varenr |
|----------------|--------|
| By-expressen (bike) | 17 |
| Egen cykel (own-bike) | 103 |
| Volvo (volvo) | 103 |
| Taxa (taxi) | 100 |

**Betalingsbetingelse — BESLUTTET (25. juni):** Send ALTID `paymentTerms: { paymentTermsNumber: 1 }`
(Netto 8 dage) fra settings. Alle RR-kunder er Netto 8 dage i dag, og betingelsen printes på
fakturaen af layoutet (referencefakturaen viser "Betalingsbetingelser: Netto 8 dage - forfald …").
Får I senere én kunde på afvigende vilkår, laves en undtagelse for den (udelad `paymentTerms`
så e-conomic arver fra kunden, ELLER læs et override-felt på `companies`/`customers`) — strukturen
tillader det uden ombygning, det er kun ét felt.

**Flow (KUN udkast — vi bogfører ALDRIG automatisk):**
1. Forhåndstjek: blokér hvis kunde-nr ELLER en linjes recipe-nr mangler (se fejlhåndtering).
2. POST `buildDraftInvoice(bon)` til `/invoices/drafts` → får `draftInvoiceNumber`.
3. Gem `draftInvoiceNumber` på bonen (genoptag-nøgle + idempotency-guard).
4. **Stop her.** Et menneske åbner e-conomic, gennemser og bogfører udkastet manuelt.
   `/invoices/booked` kaldes IKKE fra Bon v2.
5. Status FAKTURERET sættes IKKE ved POST. Den følger først når udkastet faktisk er bogført
   — matches tilbage via reconciliation (OpenAPI `bookedentries`, jf. AUTH §7), så et
   uafsendt udkast ikke fejl-markeres som faktureret.

**Idempotency:** Sæt `Idempotency-Key: bon-${bon.id}-${contentHash}` på POST'en (content-hash =
sha1 af payload, første 12 tegn). ⚠️ Brug IKKE en fast `bon-${id}-draft`-nøgle: e-conomic cacher
nøglen i 1 time og afviser samme nøgle med ændret indhold ("PayloadChanged") — fx en redigeret bon
gen-sendt inden for 1 time (verificeret 25. juni mod live API). Content-hash gør at ægte netværks-
retries (samme payload) dedupes, mens ændret indhold får en ny nøgle. Re-send efter success
forhindres separat af `economic_draft_number`-guarden.

**Vigtigt:**
- `bon_lines.cost_price` er allerede ex moms — bruges ikke i payload (kun til DB).

---

## FAKTURALINJER — som udgangspunkt ÉN kilde (bon_lines)

**Vigtig afklaring (25. juni 2026):** Levering, miljøgebyr, rabat, servicepersonale,
skilte osv. findes ALLE som Grocy-recipes (kategorierne `x-Levering` og `x-Service`).
Når de er på en bon, er de helt **almindelige `bon_lines`** med `grocy_recipe_id` →
`economic_product_number` fra recipe-userfeltet, præcis som mad-linjer. De kræver
**ingen** særbehandling — hverken fee-felter i settings eller særlige objekter.

| Kilde | Hvornår | Varenr fra |
|-------|---------|-----------|
| **bon_lines** (mad + x-Service + x-Levering) | Standard — alt der er på bonen som linje | `economic_product_number` pr. recipe |
| **Synt. leveringslinje** | KUN når levering ligger i `bon.delivery_price` (nyt logistik-system) UDEN en x-Levering-linje | `delivery_vehicles.economic_product_number` via `delivery_vehicle_id`, fallback settings |

Den syntetiske leveringslinje er det eneste særtilfælde, og kun fordi det nye
logistik-system (Spor 1/2) gemmer levering på `bon.delivery_price` + `delivery_vehicle_id`
i stedet for som en linje. Har bonen allerede en `x-Levering`-linje (fx v1-migreret),
springes synteselinjen over (samme logik som `recalcBonTotal`'s `hasLeveringLine`),
ellers dobbelttælles leveringen.

**Miljøgebyr:** er et Grocy-produkt (29 kr, varenr 98) — håndteres som en normal linje,
IKKE som et bon-felt (der findes intet `bon.miljobidrag`). Det `if (bon.miljobidrag…)`
i kode-eksemplet ovenfor er forældet og skal fjernes.

**Moms:** miljø**bidrag** ER momspligtigt (bekræftet — bidrag pålægges moms; *afgifter*
gør ikke). Recipe-prisen er incl. moms som alle andre → `inclToExcl` ved konvertering.
Bemærk skellet i Grocy: "Rabat" (momspligtig) vs. "Rabat - afgift -" (afgift, ingen moms)
— de er to forskellige recipes med hver sin momskode i e-conomic. Adapteren rører ikke
moms pr. linje; e-conomic udregner ud fra varens momskode. Sørg for at varenrene i
e-conomic har den rigtige momskode (bidrag = momspligtig, afgift = momsfri).

---

## PRODUKTNUMMER-MAPPING (Grocy ↔ e-conomic)

`productNumber` er **RR-specifik** og bor som **userfield på RECIPE'en i Grocy**
(navn: `economic_product_number`, **entitet = recipes**) — det er recipes vi sælger,
og deres numre står i fakturaens "Nr."-kolonne. Hentes via `grocyAdapter` på
`bon_lines.grocy_recipe_id`. Grocy forbliver source of truth; adapteren slår ALDRIG
op i e-conomic pr. faktura. Skrivning til Grocy sker via Grocy's API (userfield), ikke
rå DB — konsistent med øvrig adapter-praksis.

> Levering + gebyrer er IKKE recipes (service-produkter) — deres varenr bor på
> `delivery_vehicles`/settings, jf. "FAKTURALINJER — tre kilder".

**To retninger — begge manuelle i første omgang:**

| Retning | Hvornår | Proces (manuel nu) |
|---------|---------|--------------------|
| **e-conomic → Grocy** (backfill) | Engangs, eksisterende produkter | Slå produktnummer op i e-conomic, tast det i Grocy-userfield. Overskueligt antal — intet match-værktøj nødvendigt |
| **Grocy → e-conomic** (løbende) | Nyt produkt frigives | Opret produktet manuelt i e-conomic, tast nummeret tilbage i Grocy-userfield med det samme |

**Automatik (nightly-job, fuzzy-match, "kør nu"-knap) bygges IKKE nu** — først
når frekvensen af nye produkter gør manuelt for besværligt. Adapteren *læser*
kun det færdige userfield uanset hvordan det blev udfyldt.

**Frigivelse til salg = Grocy-userfield `sellable` sættes.** Men `sellable` og
`economic_product_number` er ortogonale og må ikke blandes sammen:

| Felt | Betyder | Opførsel |
|------|---------|----------|
| `sellable` | Kan sælges nu | Toggler med sæson (true/false/true...) |
| `economic_product_number` | Findes i e-conomic | Sættes én gang, fjernes aldrig |

**Oprettelses-betingelse (gælder også manuelt):** Opret kun i e-conomic hvis
`economic_product_number` er tom. Et sæsonprodukt der allerede har sit nummer
oprettes IKKE igen når det kommer i sæson — tast aldrig et nyt nummer på et
produkt der allerede har ét.

**Mekanik (manuel nu):** Når et produkt frigives (`sellable` sættes i Grocy) og
mangler nummer, oprettes det manuelt i e-conomic og nummeret tastes tilbage.
Automatik tilføjes først ved behov.

**Fakturering er uafhængig af `sellable`.** Adapteren tjekker KUN
`economic_product_number` (jf. fejlhåndtering ovenfor). En bon leveret i
sæsonen kan faktureres efter sæsonen, hvor `sellable` er false igen. Produkter
deaktiveres/slettes ALDRIG i e-conomic pga. sæson — det ville blokere
forsinkede fakturaer.

---

## FEJLHÅNDTERING — manglende kobling blokerer (recipe ELLER kunde)

To ting kan mangle, og begge giver 400 fra e-conomic. Tjek BEGGE FØR POST og byg
ikke payloaden hvis noget mangler — returnér i stedet en samlet liste, så kontoret
kan rette det. Blokerende forudsætninger, ikke advarsler man klikker væk.

**A. Solgt recipe uden e-conomic-nummer.** En ny recipe kan være solgt *før* den er
oprettet i e-conomic (userfield tomt). En linje med tomt `productNumber` afvises.
→ **Gør opmærksom på at nummeret mangler** og guid til oprettelse. Tre veje (besluttet 25. juni):
  1. **Opret rigtig vare** i e-conomic + tast nummeret i Grocy-userfeltet (det normale).
  2. **Auto-opret via API** (valgfri forbedring): `POST /products` i e-conomic → skriv nummeret
     tilbage i Grocy-userfeltet. e-conomic-numre er stabile, men nye recipes opstår løbende,
     så dette kan fjerne meget manuelt arbejde. Bygges hvis manuelt bliver for tungt.
  3. **Engangsvare-nummer** (Leifs løsning): for ægte engangsvarer/sjældne ting, brug ét fast
     "engangs"-produktnummer i e-conomic (gemt i settings, fx `economic_oneoff_product_number`)
     og **overskriv `description` + `unitNetPrice`** på linjen. Så blokeres bonen ikke for noget
     der aldrig sælges igen.

**B. Kunde (eller kontaktperson) uden e-conomic-nummer.** Nye kunder kommer ofte og skal
oprettes i e-conomic. `resolveEconomicCustomer(bon)` returnerer `null` hvis kunden mangler.
**Kontaktpersoner ("att.") skal også have et e-conomic-nummer** (kontakter bor under firmaet
i e-conomic — `customers.economic_contact_id`). → To veje:
  1. **Dokument-flow (besluttet, som taxa-booking):** generér et lille dokument/clipboard med
     kundens (og kontaktens) info → opret manuelt i e-conomic → tast nummeret tilbage. Genbrug
     popout-mønstret fra delivery-booking.
  2. **Auto-opret via API** (senere): `POST /customers` (+ kontakt) → skriv numre tilbage.
Indtil kunde-/kontaktnummer findes: blokér bonen med "kunden mangler i e-conomic" + dokument-knap.

**C. Hvad faktureres IKKE — og hvorfor kategori er den forkerte akse (#454, august 2026).**
Nogle linjer skal aldrig på fakturaen: emballage kunden ikke betaler for, og prep-opskrifter.
Det blev først løst med en liste over *kategorier* (`NONINVOICE_CATEGORIES`). Den regel var
forkert, fordi to af kategorierne er blandede: `Tilbehør & Bokse` rummer ægte varer med
omsætning (Glutenfri Bolle, Børne Bokse, HåndDelle), og `06 Emballage` rummer både emballage
og transportkasser der faktureres. `lunch` er slet ikke en Grocy-kategori, men `block_type`
lækket fra tilbudsmodulet. Resultatet var fakturaer der så rigtige ud og var for små.

Reglen er nu **pr. linje**, i `classifyLine()`, i denne rækkefølge:

| # | Betingelse | Udfald |
|---|---|---|
| 1 | linjen har `economic_product_number` | faktureres |
| 2 | linjen er et bundt (slider-boks) | foldes ud til én linje pr. vare |
| 3 | linjen bærer 0 kr | udelades — **rapporteres** i `readiness.excluded` |
| 4 | engangsvare-redning valgt (og nummeret findes) | faktureres som engangsvare |
| 5 | ellers | **blokerer** |

To invarianter bærer det hele:

- **Beløbet afgør, ikke kategorien.** En linje til 0 kr kan ikke gøre fakturaen for lille;
  en linje med penge må aldrig forsvinde. Samme opskrift kan derfor lande begge steder —
  `Receptions Skinner` udelades når den er gratis og blokerer når den er prissat.
- **`settings.economic_noninvoice_recipes` kan kun ophæve en blokering, aldrig fjerne
  omsætning.** Står en opskrift på listen og linjen alligevel har en pris, blokerer den:
  det er en selvmodsigelse i stamdata, og den skal ses frem for at blive skjult.

Udeladelsen er aldrig stille: `checkReadiness` returnerer `excluded[]` + `excluded_total`
(INKL moms), og fakturerings-skærmen viser dem både i forhåndsvisningen og ved blokering.
`buildDraftInvoice` **kaster** (`line_without_product`) hvis en linje alligevel når frem —
et værn bag forhåndstjekket, ikke en erstatning for det.

`scripts/economic-blocking-report.js` (read-only) viser hvilke opskrifter der blokerer,
hvor mange bons det rammer, og hvad der udelades. Kan køres mod drift.

---

## RABAT (undersøgt + besluttet 24. juni 2026)

E-conomics indbyggede rabat-pr-kunde virker IKKE når vi lægger linjer ind via API
— rabatten skal derfor komme fra bonen og sendes eksplicit i payloaden.

### Sådan rammer rabatten fakturaen
Rabatten ligger som en flad procent på BON-niveau (`bons.offer_discount_percent`),
ikke i linjepriserne. Da en flad %-rabat på subtotalen er matematisk identisk med
samme % på hver linje, sendes den som `discountPercentage` på **hver** linje (alle
tre kilder: bon_lines, levering, gebyrer). `unitNetPrice` bliver ved fuld ex-moms-pris,
så rabatten står synligt på fakturaen.

```js
const lineDiscount = bon.offer_discount_percent || 0;   // samme % på alle linjer
// pr. linje:  ...(lineDiscount ? { discountPercentage: lineDiscount } : {}),
```

e-conomic genberegner totalen; `total_excl_moms` matcher Bon v2's `total_price`
(begge er flad %-rabat på subtotal). Øre-drift accepteres (e-conomics total er sandhed).

### Stående kunderabat — aktivering (prerequisite, bon-prislogik)
Den stående `companies.discount_percent` / `customers.discount_percent` LÆSES kun i
dag — ingen kode anvender den. Den skal aktiveres (fx 12,5 % frokostportal-firma).

**Beslutninger:**
- **Omfang:** både firmaer OG privatkunder (begge felter findes).
- **Sammenstød:** eksplicit rabat på bonen/tilbuddet vinder — den stående bruges KUN
  som fallback. Stables ALDRIG.
- **Snapshot:** satsen låses ved oprettelse (kopieres til bonen). Senere ændring af
  firmaets sats rører IKKE eksisterende bons. Konsistent med pris-snapshot i Bon v2.

**Mekanik — ét sted, ikke 7:** bons oprettes 7 steder (web-ordrer, tilbud, webhook,
manuel, event …) uden fælles `createBon()`. Seed derfor den stående rabat med en
**AFTER INSERT-trigger** på `bons` (samme mønster som contact_points-triggerne) —
så ingen oprettelsessti kan glemme den:

```sql
CREATE TRIGGER bons_seed_standing_discount
AFTER INSERT ON bons
WHEN (NEW.offer_discount_percent IS NULL OR NEW.offer_discount_percent = 0)
BEGIN
  UPDATE bons SET offer_discount_percent = COALESCE(
    (SELECT discount_percent FROM companies WHERE id = NEW.company_id  AND discount_percent > 0),
    (SELECT discount_percent FROM customers WHERE id = NEW.customer_id AND discount_percent > 0),
    0
  ) WHERE id = NEW.id;
END;
```

Konsekvenser:
- "Eksplicit vinder" sikres af `WHEN`-guarden (rører ikke en bon der allerede har rabat).
- "Snapshot" sikres ved at triggeren kun fyrer ved INSERT (kopierer satsen der og da).
- `recalcBonTotal()` regner totalen når linjer tilføjes — rabatten er allerede sat.
- Resten af systemet (køkken-total, fakturering, rapporter, e-conomic) virker uændret,
  fordi `offer_discount_percent` allerede er den ene rabat-sandhed.
- Edge: skifter office kunde på en eksisterende bon, gen-seedes rabatten ikke (snapshot-
  valget). Ønskes det, håndteres det separat i PATCH — ikke i triggeren.

**Hvorfor trigger og ikke en fælles `createBon()`?** Bons oprettes 7 steder med vidt
forskellige inputs (find-or-create kunde, DAWA, EAN, offer-felter, event-roller, produktions-
bons uden kunde). En fælles `createBon()` er arkitektonisk ønskværdig på sigt, men er en
refactor af systemets mest centrale tabel i drift — egen, testet opgave, IKKE en del af
e-conomic-sporet (tracked i issue #237). Til selve rabat-invarianten er triggeren desuden
*stærkere* end en helper: den håndhæves på DB-niveau, så også `seed.js`, `sync-v1.js`,
fremtidige scripts og manuel SQL får rabatten — paths en helper aldrig fanger. Bygges
`createBon()` senere, sætter den rabatten på applikationsniveau, og triggeren bliver liggende
som sikkerhedsnet (de er enige: `WHEN (=0 or null)` overskriver aldrig en sat værdi).

**Brug ALDRIG `discount_percent` direkte i e-conomic-adapteren** — kun via
`offer_discount_percent`. Ellers ville fakturaen kunne afvige fra bonen.

---

## EAN / OFFENTLIG FAKTURERING (Nemhandel / OIOUBL) — VIGTIG (stor andel af kunderne)

En stor del af RR's kunder er offentlige og bruger EAN (fx Region Hovedstaden, EAN 5798001021593
på reference-fakturaen). EAN er derfor **ikke** en niche der kan udskydes længe — men den gode
nyhed (verificeret mod e-conomic REST API, 25. juni) er at det passer ind i "kun draft"-modellen:

**e-conomic sender selv EAN-fakturaen ved bogføring.** Vi behøver ikke bygge en separat
OIOUBL-kanal. Når et menneske bogfører udkastet i e-conomic (eller vi senere automatiserer det),
sendes det elektronisk — forudsat:
- gyldigt **CVR på agreementet** (Nordic Fast Food har det) ✅
- gyldigt **EAN-nummer på kunden** (`companies.ean` → skal være sat på e-conomic-kunden)
- en **kontaktperson på kunden** (`customers.economic_contact_id`)
- `/self` har `canSendElectronicInvoice: true` (tjek ved opsætning)

| Krav | Hvor i Bon v2 | Status |
|------|---------------|--------|
| EAN-nummer | `companies.ean` (findes; kan slås op i EAN-registret) | skal også stå på e-conomic-kunden |
| Kontaktperson | `customers.economic_contact_id` | skal være sat (jf. fejlhåndtering B) |
| Rekvisition/PSP | fakturaen viser "psp L-22060-00013" | leveres af kunden NÅR den er påkrævet → `references.other` |

**Fase 1 (anbefalet — INGEN ekstra kanal):**
- Byg IKKE en separat blokering af EAN-kunder. Behandl dem som almindelige draft-fakturaer.
- Sørg for at EAN-kunder har EAN + kontaktperson på e-conomic-kunden (ellers fejler bogføringen
  → fang det i forhåndstjekket: EAN-kunde uden kontaktperson → blokér med klar besked).
- Rekvisition: kunden leverer den når den er påkrævet → læg den i `references.other` (sammen med
  bon-nr via `buildReference`). Et struktureret `requisition_ref`-felt på bon er en nice-to-have,
  men fri-tekst/`invoice_info` kan bruges indtil da.
- Mennesket bogfører i e-conomic UI → EAN sendes automatisk.

**Fase 2 (automatisering, valgfri):** Bogfør + send EAN via API:
`POST /invoices/booked` med `{ draftInvoice: { draftInvoiceNumber }, bookWithNumber, sendBy: "ean" }`.
Status spores via `GET /invoices/sent`. Dette bryder "kun draft"-princippet bevidst FOR EAN —
beslut separat om I vil automatisere bogføringen for offentlige kunder, eller beholde det manuelt.

---

## Visnings-disciplin

Når der bygges et UI til "hvad sender vi til e-conomic" (preview/dryrun):
- Vis **både** ex moms (linjer) + incl moms (kundetotal) side om side
- Label tydeligt: `"Linje-priser (ex moms)"` og `"Total til kunde (incl moms)"`
- Følg de 7 regler i `BON_V2_PRINCIPPER.md` sektion 6c

---

## Test

Verifikations-suiten har en placeholder-test (#7) i
`tests/moms_audit_e2e.test.js` der venter på e-conomic-implementation.
Når koden bygges, aktivér denne assertion (uændret — bygger på ex-moms-linjesum):

```javascript
test('#7 — E-conomic-payload har ex-moms-linjer (e-conomic beregner moms)', () => {
    const payload = buildDraftInvoice(testBon);
    const linesSum = payload.lines.reduce((s, l) => s + l.unitNetPrice * l.quantity, 0);
    assert.ok(Math.abs(linesSum - T5.excl) < 1);
});
```

T-5 testbonen:
- 23.650 incl → 18.920 ex (linje-sum) + 4.730 moms (sidstnævnte beregnes af e-conomic)

---

## Stop-betingelser

Hvis e-conomic API'et ændrer payload-format,
**opdatér denne spec FØR koden ændres**. Hold tre dokumenter synkrone:
1. Denne fil
2. `BON_V2_PRINCIPPER.md` sektion 6b/6c
3. Verifikations-tests i `tests/moms_audit_e2e.test.js`

---

## Åbne punkter før build

| Punkt | Hvem |
|-------|------|
| Tokens i hus + `/self` svarer (firma = **Nordic Fast Food** = RR's CVR-selskab) | ✅ done |
| `economic_default_payment_terms_number = 1` i settings | Simon |
| `economic_layout_number = 19` i settings | Simon |
| `economic_delivery_fallback_product_number = 17` + `economic_fee_product_number_miljobidrag = 98` i settings | Simon |
| **Ny kolonne** `delivery_vehicles.economic_product_number` (migration) + sæt 17/103/103/100 pr. køretøj | Simon (migration) + Leif/office (værdier) |
| `economic_product_number`-userfield oprettes i Grocy på entitet **recipes** | Leif (Grocy-config, engangs) |
| Backfill: tast e-conomic-numre på eksisterende **recipes** | Leif/kontor (manuelt) |
| grocyAdapter eksponerer `economic_product_number` pr. recipe (slås op på `grocy_recipe_id`) | Simon |
| Adapter-query joiner `delivery_vehicles` så `delivery_vehicle_economic_product_number` + `delivery_vehicle_label` er på bon-objektet | Simon |
| Bekræft moms-basis på miljøbidrag-feltet + varenr 98's momskode | Leif |
| Rabat: send `discountPercentage = offer_discount_percent` pr. linje (RABAT-sektion) | Simon |
| Migration: trigger `bons_seed_standing_discount` (stående kunderabat → `offer_discount_percent`) | Simon |
| EAN-kunder: blokér eksplicit i fase 1 (`company.ean`/`invoice_method='ean'`) | Simon |
| Forhåndstjek blokerer ved manglende kunde-nr OG recipe-nr | Simon |
| `createBon()`-refactor (separat tech-debt, issue #237) | Simon |

---

## Reference

- `CLAUDE_ECONOMIC_AUTH.md` — tokens, API-baser, fejlhåndtering, reconciliation-hook
- `docs/CLAUDE_TILBUD_PRIS.md` — samme moms-mønster i tilbud
- `docs/audit/moms_audit_fase3_2026-05-01.md` — dækning af moms-audit
- `shared/moms.js` — autoritativ kilde til alle moms-helpers

---

*Payload-struktur verificeret mod e-conomic REST API juni 2026. Vent på at integrationen bygges.*
