# CLAUDE_VARER_OG_PRISER.md — Indkøb → Varer: hvor købes varen, og hvad koster den?

> **Status:** spec, godkendt som koncept 22. september 2026. Ikke bygget.
> **Mockup:** https://claude.ai/artifact/VEqBpyGsTpCdrBDQRDtXQS (klikbar, eksempeldata)
> **Bygger videre på:** #657 (leverandørpriser i Grocy), #704 (arbejdslisten "N uden pris"),
> #703 (enhedsaudit), #666 (stamdata-spor), #558 (kostpris fra opskrift).
> **Afløser:** Produkter-fanens "uden pris"-tilstand og Hørkram → *Ny kobling* / *Alle koblinger*.

---

## 1. Problemet

Spørgsmålet *"hvordan får vi fat i varen, og hvad koster den?"* blev besvaret tre steder
med hver sin regel:

| Sted | Afgør ud fra | Hvad gik galt |
|---|---|---|
| ⚙ → Produkter | varens indkøbssted (Grocy) | handlinger kun i filteret "uden pris" — ellers en død `—` |
| Hørkram → Ny kobling | "har ingen Hørkram-stregkode" | spørger ikke hvor varen købes: **67 af 102** var ikke Hørkram-varer (Emballage, egen produktion, Drikkevarer …) |
| Kobl-panelet i indkøbslisten | gruppen på listen | virker, men kun for varer der står på listen |

Og data var skredet: **11 varer** købes hos X men har kun varenummer hos Y
(Bagepapir, Gafler → Emballage/Hørkram; Brød Rug, Frikadeller → Convifood/Hørkram).
Det var Gafler-fejlen i sin rod.

Målt mod grocy-test 22/9 (kopi af HQ), 189 aktive varer:

| | Antal |
|---|---|
| varenummer hos egen leverandør | 81 |
| intet varenummer | 76 |
| egen produktion (opskrift) | 20 |
| varenummer kun hos en anden leverandør | 11 |
| ingen leverandør | 1 |

## 2. Konceptet

**"Købes hos" er ankeret.** Hver vare har præcis én leverandør den købes hos. Den
afgør hvad varen beder om; leverandørens **type** afgør *hvordan*. Alt andet er
afledt.

### 2.1 Leverandørtyper

Typen er leverandørens `suppliers.integration_type` — intet nyt felt.

| Type | `integration_type` | Varenummer | Pris |
|---|---|---|---|
| **Katalog** | `api` | slås op i leverandørens katalog | hentes af Bon og holder sig selv ajour |
| **Faktura** | `email`, `manual`, `webshop`, `form` | leverandørens eget, eller internt (`INT-nnnn`) hvis de ikke har numre | tastes fra fakturaen |
| **Intern** | `intern` | intet | fra opskriften, ellers overslag |

Hørkram er i dag den eneste katalog-leverandør. Det er en **type**, ikke et
specialtilfælde: får Inco (eller en anden) et API, bliver den katalog nr. 2 uden
nyt koncept. Katalog-specifikt (login, snapshots, salgsenheder) bor i
leverandørens adapter, ikke i Varer-skærmen.

### 2.2 Tilstande og status-mærker

Hver vare står i én tilstand. Rækken viser mærket og har feltet eller knappen til
næste skridt.

| Mærke | Når | Rækken tilbyder |
|---|---|---|
| **Klar** | foretrukket varenummer hos leverandøren, med pris | intet |
| **Egen produktion** | en opskrift producerer varen (`recipes.product_id`) | intet — kostprisen kommer fra opskriften (#558) |
| **Mangler leverandør** | intet indkøbssted | vælg i "Købes hos" |
| **Hvor købes den?** | varen købes hos X, men dens eneste varenummer er hos Y | spørgsmål med to svar: **[Hos Y]** **[Hos X]** |
| **Vælg foretrukken** | flere numre hos leverandøren, intet foretrukket | ét klik pr. nummer (viser pris pr. lager-enhed) |
| **Mangler varenummer** | katalog-leverandør, intet nummer | **Find i ⟨leverandør⟩s katalog** → forslag → Kobl. Alternativt overslag |
| **Mangler pris** | faktura-leverandør uden nummer, *eller* et nummer uden pris | `[115] kr for [25] stk` — uden nummer oprettes et internt nummer hos leverandøren |
| **Mangler indhold** | katalog-nummer med leverandørpris, men stregkoden ved ikke hvad én salgsenhed indeholder | `1 salgsenhed indeholder [500] ark` → serveren henter prisen |

Rækkefølgen i koden er den i tabellen (fra "Egen produktion" og ned); den første
der passer, vinder.

**"Hvor købes den?"** sammenligner **leverandører, ikke Grocy-lokationer**: én
leverandør kan have flere indkøbssteder (Hørkram er koblet til lokation 2, 5 og 9).
Svarer man *Hos X*, beholdes Y-nummeret som **alternativ**; svarer man *Hos Y*,
skifter "Købes hos".

### 2.3 Ord

Besluttet 22/9 — brug disse, også i kode-kommentarer og toasts:

| Ord | Ikke |
|---|---|
| foretrukken / Gør foretrukken | gælder, gældende, primær |
| Status (kolonne), Klar | Næste skridt, I orden |
| Hvor købes den? | Uenig |
| Egen produktion | Laves selv |
| alternativ (nummer hos en anden leverandør) | sekundær |
| Køb her i stedet (på et alternativ) | Gør gældende |
| Skal ordnes (filter) | Mangler noget |

## 3. Skærmen

### 3.1 Faner under Indkøb → Leverandører

`Leverandører · Varer · Kataloger · Duplikater`

- **Leverandører** — som i dag, plus typen vist pr. leverandør.
- **Varer** — afløser *Produkter*. Se 3.2.
- **Kataloger** — én blok pr. katalog-leverandør: status (logget ind, antal koblede
  numre, hvornår priserne sidst blev hentet), **Opdater priser nu**, **Opslag**,
  **Favoritter**, og et link til Varer filtreret på leverandøren.
  *Ny kobling* og *Alle koblinger* forsvinder — de er Varer-rækkens "Find i
  kataloget" og Varer filtreret på Hørkram.
- **Duplikater** — uændret.

### 3.2 Varer-listen

Kolonner: **Vare · Købes hos · Varenummer · Pris ex moms · Status**.

- **Samme række i alle filtre** — ingen særlig tilstand man skal kende.
- Filtre: **Alle · Skal ordnes · Hvor købes den? · Egen produktion · Klar**, plus
  leverandør-vælger og søgning. Tallet på fanen er *Skal ordnes* + *Hvor købes den?*.
- "Købes hos" er en dropdown i rækken. Et skift genberegner tilstanden med det samme.
- Pris vises pr. **lager-enhed**, med kilden under: *fra kataloget · opdateres selv*,
  *fakturapris*, *overslag*, *fra opskriften*.
- Under varenummeret: **+ varenummer** (åbner panelet på formularen, 3.3).
- **Tast, tab, videre:** Tab ud af rækken gemmer; Tab mellem felterne i samme række
  gør ikke. Enter gemmer og flytter til næste række med et felt. Øvrige felter
  (min.-grænse o.l.) har `tabindex="-1"`, så Tab går pris → antal → næste vare.
- En række der lige er ordnet, **bliver stående** med kvitteringen indtil filteret
  skiftes — ellers forsvinder den under fingrene.

### 3.3 Vare-panelet

Åbnes ved klik på varens navn eller **+ varenummer**. Indhold:

1. **Status** (samme tekst som rækken).
2. **Egen produktion** — opskrift og kostpris, hvis det er tilfældet.
3. **Købes hos** — dropdown + leverandørtypen i klartekst.
4. **Varenumre** — grupperet: leverandøren varen købes hos først (*her købes varen*),
   derefter *alternativer* pr. anden leverandør. Pr. nummer: nummer, betegnelse, pris
   pr. lager-enhed, aftalevare. Knapper: **Gør foretrukken** (egen leverandør),
   **Køb her i stedet** (alternativ — skifter "Købes hos"), **Fjern** (ikke på det
   foretrukne).
5. **+ Tilføj varenummer** — fra **enhver** leverandør:
   - *katalog*: søg på navn eller nummer → **Kobl**; prisen kommer fra kataloget.
   - *faktura*: leverandørens nummer (tomt = internt `INT-nnnn`), betegnelse, valgfri
     pris `[kr] for [antal] ⟨lager-enhed⟩`.
   - Er det første nummer hos varens egen leverandør, bliver det foretrukket. Ellers
     vælger man selv — vi gætter ikke. Et nummer hos en anden leverandør bliver et
     alternativ, og formularen siger det før man gemmer.
6. **Minimumsgrænse** — Grocys indstilling pr. vare (8.3).
7. **Senere** — pris-historik, stamdata-spor (#666).

Panelet er **kun** her i første omgang. På sigt er det samme panel bag ✎ i
lageroversigten og i indkøbslisten (besluttet 22/9: "på sigt, ikke nu").

## 4. Regler der ikke må brydes

1. **Browseren dividerer — intet andet.** `[115] kr for [25] stk` → 4,60 via
   `shared/invoice_price.js`. Omregning mellem varenummerets enhed og lager-enheden
   bor i `services/supplierPrices.js` (#352: faktor 1000).
2. **Serveren afgør hvilken pris der gælder.** Efter enhver skrivning spørges
   `GET /prices/product/:id`, og rækken bygges af svaret.
3. **Grocy er eneste sandhed** (#657). Bon gemmer ingen priser, kun kvitteringer.
4. **Ét foretrukket nummer pr. vare** (`is_preferred`), og det ligger hos den
   leverandør varen købes hos. "Køb her i stedet" flytter begge dele i ét hug.
5. **Et fejlet skridt siges i rækken** — aldrig en tavs fallback (#305/#319).
   Gemt-men-stadig-uden-pris er en fejl, ikke en succes.
6. **Vi gætter aldrig** et indhold, en foretrukken eller en leverandør. Et udledt tal
   (fx Hørkrams pris/enhed ÷ pris/kg, #703) må foreslås, ikke skrives.
7. **Alle skrivninger sporer** (#666) med kilde `indkob`.

## 5. Data og endpoints

| Begreb | Hvor det bor |
|---|---|
| Købes hos | `products.shopping_location_id` (Grocy) → leverandør via `supplier_grocy_locations` |
| Leverandørtype | `suppliers.integration_type` |
| Varenummer | `product_barcodes` (Grocy): `barcode`, `note` (betegnelse), `shopping_location_id` |
| Indhold | `product_barcodes.amount` + `qu_id` (ikke userfieldet `pack_size_stock_unit`, jf. #703) |
| Pris | `product_barcodes.last_price` (pr. 1 af stregkodens enhed) |
| Foretrukken | userfield `is_preferred` |
| Overslag | internt nummer `OVERSLAG-<id>` |
| Egen produktion | `recipes.product_id` (laveste opskrift-id vinder, som kostprisen) |

Findes allerede (#657/#704):
`GET /prices/overview` · `GET /prices/product/:id` · `PUT /prices/product/:id/preferred` ·
`PUT /prices/product/:id/estimate` · `PUT /prices/barcode/:id` ·
`POST /prices/product/:id/internal` · `PUT /prices/barcode/:id/content` ·
`POST /api/grocy/product-barcodes` · `PUT /api/grocy/products/:id` (købes hos) ·
Hørkram-søgning via `routes/horkram.js`.

Mangler:
- `GET /prices/overview` skal bære **leverandør** (ikke kun lokation) pr. nummer og
  pr. vare, så "Hvor købes den?" kan sammenligne leverandører. Afledes server-side
  af `supplier_grocy_locations`.
- **Tilføj et leverandørnummer med pris** (faktura-type, *med* nummer): opret
  stregkode i lager-enheden, `amount: 1`, `last_price` — samme regel som
  `createInternalBarcode`, men med leverandørens nummer. Udvid
  `POST /prices/product/:id/internal` med et valgfrit `barcode`, frem for et nyt route.
- **Fjern varenummer** med stamdata-spor (i dag kun det generiske
  `DELETE /api/grocy/product-barcodes/:id`, som ikke sporer).
- **Katalog-kobling fra rækken**: "Find i kataloget" + Kobl, udtrukket af
  `_isHkUnlinkedSearch`/`_isHkUnlinkedPick` (indkob_settings) og kobl-panelet
  (indkob.js), så der er ÉN kobl-vej. Prisen hentes med
  `refreshHorkramPrices({ barcodes: [nr] })` bagefter.

## 6. Hvad fra #704 genbruges

`_isWorkPlan` er tilstandsmaskinen i 2.2 — den udvides med "Hvor købes den?",
"Mangler leverandør" og katalog-opslaget, og vises **altid** i stedet for kun i
filteret. `shared/invoice_price.js`, `createInternalBarcode`, `setBarcodeContent`,
`produced_by` i oversigten og testen `test-indkob-arbejdsliste.js` bruges uændret.
#704 merges derfor ikke som den er; den er fundamentet.

## 7. Faser

0. **Forudsætninger** — natligt Hørkram-prisjob (9.1) og leverandører på de fem
   indkøbssteder uden (9.2). Uden dem lover skærmen noget den ikke holder.
1. **Varer-listen** — ny fane der afløser Produkter; tilstande, filtre, "Købes hos" i
   rækken, alle række-handlinger inkl. "Hvor købes den?" og "Find i kataloget".
2. **Vare-panelet** — varenumre pr. leverandør, Gør foretrukken, Køb her i stedet,
   Fjern, + Tilføj varenummer.
3. **Kataloger-fanen** — Hørkram-fanen omlagt; Ny kobling og Alle koblinger fjernes.
4. *(senere)* Samme panel bag ✎ i lageroversigten og som kobl-panel i indkøbslisten (8.4).

Hver fase kan testes i drift for sig; 1 kræver ikke 2.

## 8. Afklaret 22. september 2026

1. **Webshops med eget API** (fx Inco) er *faktura*-type indtil der er skrevet en
   API-adapter til dem. Så bliver de *katalog*-type — samme vej som Hørkram, uden
   nyt koncept (2.1).
2. **Varer der aldrig skal have en pris** (vareprøver o.l.) får prisen **0**. Et
   bevidst 0 er en pris og giver *Klar*; en tom pris (`""`/null) betyder *mangler*
   og giver *Skal ordnes*. Kræver en ændring: i dag afviser
   `setBarcodeStockPrice`/`setEstimatePrice` alt ≤ 0, og `resolveProductPrice`
   behandler 0 som "ingen pris". **Mål før det bygges** hvor mange stregkoder der i
   dag har `last_price = 0` — betyder de "ukendt", skal de ryddes til null først,
   ellers bliver de stille til *Klar*.
3. **Minimumsgrænse** er en indstilling pr. vare i Grocy → den bor i **vare-panelet**,
   ikke som kolonne i listen.
4. **Kobl-panelet i indkøbslisten** skal på sigt åbne **vare-panelet** (en drawer, som
   bon-draweren) i stedet for sin egen formular. Hører til fase 4: ét panel til en
   vare, uanset hvor man står.

## 9. Udfordringer der skal løses undervejs

Fundet mens specen blev skrevet. De første tre er målt, ikke antaget.

1. **"Holder sig selv ajour" er ikke sandt i dag.** Der findes ingen planlagt
   Hørkram-prisopdatering — kun knappen *Opdater priser nu*
   (`POST /prices/refresh-horkram`). Katalog-typens løfte kræver et natligt job
   (cron, som `booking-reminders.js`), der kører `refreshHorkramPrices` og logger
   udfaldet. Uden det bliver en katalog-pris lige så forældet som en fakturapris,
   bare uden at nogen ved det. **Skal på plads før fase 1 går i drift.**

2. **Fem indkøbssteder har ingen leverandør i Bon.** Kun lokation 2, 3, 5, 6, 7, 9
   og 11 er koblet (`supplier_grocy_locations`). Convifood, ForEmma, Drikkevarer,
   Madsynergi og Dagligvare butik er ikke — deres type er derfor ukendt, og #704
   falder tilbage på *overslag* for dem, hvor det burde være *fakturapris på et
   internt nummer*. Regel: et indkøbssted uden leverandør behandles som
   **faktura-type**, og Leverandører-fanen viser det som "indkøbssted uden
   leverandør" med den eksisterende *opret leverandør*-knap.

3. **Én leverandør, flere indkøbssteder.** Hørkram er lokation 2, 5 og 9. Skal
   "Købes hos" vise leverandører (Hørkram én gang) eller Grocy-lokationer (tre
   gange Hørkram)? Forslag: **leverandører**, og et skift skriver leverandørens
   første lokation — men så skal det afklares hvad de tre Hørkram-lokationer
   bruges til i dag, før én af dem vælges som "den".

4. **Antal i lager-enheden er svært fra en faktura.** Står varen på lager i kg men
   købes i kasser à 10 stk, skal man selv regne kg pr. kasse for at skrive
   `[kr] for [antal] kg`. Det er præcis dér enhedsfejl opstår. Løsning: antallet
   tastes med de delte mængdefelter (`shared/mangde_felter.js`, #658/#665), og
   **serveren** summerer til lager-enhed med sine egne omregninger — browseren
   dividerer stadig kun prisen med den sum serveren giver.

5. **Et skift af "Købes hos" flytter varen på indkøbslisten** (grupperet efter
   indkøbssted) — også hvis den allerede er bestilt dér. Rækken skal sige det før
   skiftet, når varen har en åben bestilling (`ordered_*`-userfields).

6. **En vare kan både laves og købes** (fx Falaffel: opskrift *og* Hørkram-nummer).
   *Egen produktion* vinder i status (kostprisen kommer fra opskriften, #558), men
   varenumrene skal stadig kunne ses og bruges i panelet — ellers kan den ikke
   bestilles når køkkenet ikke når at lave den.

7. **Pris 0 (8.2) påvirker kostprisen** — en vare på 0 kr trækker kostprisen ned på
   hver ret der bruger den. Det er rigtigt for en gratis vareprøve, men et 0 tastet
   ved en fejl er usynligt. 0 kræver derfor en bekræftelse i rækken ("gratis — ingen
   pris?"), ikke bare et tal i feltet.

8. **Hvem må sætte priser?** Priser styrer kostprisen og marginen. I dag er
   prisruterne `requireAuth()` (enhver indlogget, også køkkenets fælles konto).
   Skal det være sådan, eller kun office/admin? Samme spørgsmål for "Købes hos".
   Sporet (#666) viser hvem — men kun rollen, fordi login er delte konti.

9. **Hvor bor Varer?** Indkøbsindstillingerne findes både som side i office og som
   880 px slide-in i køkkenet. Fem kolonner + række-handlinger er trangt i
   slide-in'en. Forslag: Varer er fuld side i office; i køkkenet åbner fanen den
   samme side i stedet for at presse den ind i panelet.

10. **Katalog-søgning pr. række koster kald hos leverandøren.** Opslaget må kun ske
    på klik (aldrig automatisk for alle 76 rækker), og en udløbet Hørkram-session
    skal give en forståelig besked i rækken, ikke en tom resultatliste (jf. #419).

## 10. Test

Som #704: den ægte browser-kode i vm-sandkasse, målt på hvad der ville blive **sendt**,
og routes over HTTP mod `:memory:` af de rigtige migrations med Grocy stubbet.
Mutationstest af hver tilstandsregel. Browser-verificering mod grocy-test med rigtige
klik, rullet tilbage bagefter.
