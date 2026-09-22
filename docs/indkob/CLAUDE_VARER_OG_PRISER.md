# CLAUDE_VARER_OG_PRISER.md — Indkøb → Varer: hvor købes varen, og hvad koster den?

> **Status:** koncept godkendt 22. september 2026. **Ikke bygget — og må ikke bygges
> før §14 (beslutninger) og §15 (rækkefølge) er afklaret.** Samler alt vi ved og
> alt vi er bekymrede for, så arbejdet ikke bliver til lappeløsninger.
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

0. **Forudsætninger** — se §15: beslutningerne i §14, natligt Hørkram-prisjob,
   kostprisens nye trin (§11) og én model for akse 3 (§10).
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
   behandler 0 som "ingen pris". **Målt 22/9 mod grocy-hq: ingen stregkoder har
   `last_price = 0`** (34 er tomme, 125 har en pris over 0), så 0 kan få den betydning
   uden oprydning.
3. **Minimumsgrænse** er en indstilling pr. vare i Grocy → den bor i **vare-panelet**,
   ikke som kolonne i listen.
4. **Kobl-panelet i indkøbslisten** skal på sigt åbne **vare-panelet** (en drawer, som
   bon-draweren) i stedet for sin egen formular. Hører til fase 4: ét panel til en
   vare, uanset hvor man står.

## 9. Rettelser efter måling

Specens første udgave (#705) havde to forkerte antagelser. Målt 22/9 mod
grocy-hq og `supplier_grocy_locations` (sessionen *Prioritering af åbne opgaver*):

| Indkøbssted (Grocy-lokation) | Varer | Koblet til leverandør | Vurdering |
|---|---|---|---|
| Hørkram (2) | 107 | Hørkram | — |
| **Convifood (5)** | 6 | **Hørkram** | rigtig: varenumrene er Hørkram-numre — Convifood købes *gennem* Hørkram |
| **Drikkevarer (9)** | 7 | **Hørkram** | tvivlsom: øl, cava, kaffe; det ene varenummer er en EAN, ikke et Hørkram-nummer |
| Inco (3) | | Inco (`webshop`) | — |
| RR Produktion (6) | | RR Produktion (`intern`) | — |
| Emballage (7) | | Serviwet (`email`) | — |
| Trykkeriet friheden (11) | | Trykkeriet friheden (`email`) | — |
| ForEmma, Madsynergi, Dagligvare butik | 8 | **ingen** | reelt uden leverandør |

Heraf følger:

- **"Købes hos" viser indkøbssted, men "Hvor købes den?" sammenligner leverandør.**
  Indkøberen kender *Convifood*, ikke "Hørkram lokation 5" — så skærmen skal vise
  indkøbsstedet. Men Brød Rug (købes via Convifood, har et Hørkram-nummer) er
  **ikke** en uoverensstemmelse: begge er Hørkram. Alarmen skal derfor gå på
  leverandøren. Første udgave ville have givet falsk alarm her.
- **Drikkevarer lover noget der ikke holder.** Som koblet i dag får de 7 varer
  katalog-typen, dvs. "prisen hentes selv fra Hørkram" — det gør den ikke. Enten
  kobles lokationen fra Hørkram og til en faktura-leverandør, eller varerne flyttes.
  Det er en beslutning (§14.1), ikke kode.
- **Et indkøbssted uden leverandør** (ForEmma m.fl.) behandles som faktura-type, og
  Leverandører-fanen viser det som "indkøbssted uden leverandør" med den
  eksisterende *opret leverandør*-knap. #704 falder i dag tilbage på *overslag* for
  dem — forkert efter dette koncept.

## 10. Tre modeller for "hvad én pakke indeholder"

Det er den største strukturelle risiko. Samme spørgsmål — *hvor meget af vores
enhed er én af leverandørens?* — er i dag gemt tre steder, og koden læser
forskellige steder fra:

| Felt | Betyder | Læses af |
|---|---|---|
| `product_barcodes.amount` + `qu_id` (Grocys egne) | én af leverandørens **basisenheder** = X af stregkodens enhed | prisomregningen (`supplierPrices`, #657): Hørkram-opdatering, varemodtagelsens pris, lageroversigtens pris, #704's "Mangler indhold" |
| userfield `pack_size_stock_unit` | én pakke = X **lager-enheder** | indkøbslistens mængder (`_ibPackSize` i `indkob.js`), #702's "mangler pakstørrelse", #703's audit — og falder stille tilbage til **1** (#698) |
| userfields `supplier_unit_code` + `supplier_unit_qty` | leverandørens **salgsenhed** (`kt` = 5 `ps`) | Hørkram-kurven; Fase A (#471) A2 |

Fase A's "tre akser" (`CLAUDE_INDKOB_FASE_A.md` §5.4) er de samme tre:

| Akse | Fra → til | Bor i |
|---|---|---|
| 1 | salgsenhed → basisenhed (karton → pose) | `supplier_unit_code/qty` |
| 2 | Grocys indkøbsenhed → lagerenhed (kasse → kg) | Grocys QU-omregninger, `resolveToStockAmount` (#358) |
| 3 | basisenhed ⟷ Grocys enhed ("hvad vejer en pose?") | **både** `amount/qu_id` **og** `pack_size_stock_unit` |

Akse 3 er altså allerede besvaret — to gange, i hvert sit felt, som ikke kender
hinanden. Retter man det ene sted (fx via #704's indholds-felt), forbliver
indkøbslisten forkert, og omvendt. #702's 40 "mangler pakstørrelse" og #704's
"mangler indhold" er **samme mangel set fra to felter**.

**Anbefaling (§14.2):** Grocys `amount` + `qu_id` er eneste sandhed for akse 3 — det
er Grocys eget felt, det kan udtrykke enhver enhed (ikke kun lager-enheden), og
prisomregningen står allerede på det. `pack_size_stock_unit` udledes af det
(omregnet til lager-enhed på serveren) og holder op med at blive skrevet. Kræver en
engangsovergang: sammenlign de to felter på alle koblinger, og vis uenighederne
for et menneske — vi vælger ikke automatisk.

## 11. Kostprisen ser ikke en pris på et varenummer

Målt i koden (`getProductUnitCostDetails`, `services/grocyAdapter.js`): kostprisen
bygger på **køb i lagerloggen** (snit over vinduet, #557), falder tilbage på Grocys
egne lagertal, forældres snit — og til sidst **kun overslag-varenummeret**
(`OVERSLAG-<id>`). Prisen på et leverandør-varenummer eller et internt `INT-`
nummer læses **ikke**.

Konsekvens: skriver man en fakturapris på Glutenfri Bolle (internt nummer, #704),
står varen som *Klar* i Varer — men kostprisen har stadig ingen pris, indtil varen
modtages med prisen i varemodtagelsen. Et overslag ville faktisk have givet
kostprisen et tal. **"Klar" må ikke betyde noget andet end "kostprisen kender
prisen".**

Muligheder (§14.3):
- **a)** Kostprisen får et nyt trin før overslaget: *den leverandørpris der gælder*
  (`priceForStock`, samme regel som varemodtagelsen). Rækkefølgen bliver
  målt køb → Grocys lagertal → forældres snit → **leverandørens pris** → overslag.
- **b)** At sætte en pris i Varer skriver også en købspost — nej: det ville være et
  køb der ikke er sket, og det ville forurene #557's snit.

Anbefaling: **a**. Og Varer skal vise *hvilken* pris kostprisen bruger lige nu, når
den afviger fra leverandørprisen — ellers ser man to tal uden at vide hvilket der
gælder.

## 12. Berørte flader

Varer er ikke en isoleret skærm. Alle disse læser eller skriver det samme:

| Flade | Læser/skriver | Hvad der skal passe |
|---|---|---|
| **Indkøbslisten** (`indkob.js`) | leverandørgrupper = indkøbssted; `_ibPackSize` (akse 3 via `pack_size_stock_unit`); kobl-panel; fakturapris (0eee245); bestillingsmail (varenr/betegnelse, #701) | samme "Købes hos"; samme akse-3-felt (§10); kobl-panelet bliver vare-panelet (fase 4) |
| **Varemodtagelse** (`varemodtagelse.js`, #658) | kandidatliste pr. leverandør (via varenumrenes indkøbssted); sender pris; pris-status + ret-på-stedet; mængdefelter | læser samme prisoversigt, men har sin egen visning og tekst for pris-status — skal bruge Varers regler |
| **Lageroversigten** (`stock_overview.js`, #657) | pris ved op-rettelse; overslag i ✎; "N uden pris"-pille | pillen skal tælle med samme regel som Varer (fx egen produktion tæller ikke med) |
| **Optællingen** (#665/#673) | mængdefelter pr. enhed (akse 2) | uændret, men deler `mangde_felter.js` med §13.4 |
| **Kostpris / Opskrifter & priser** (#557/#558) | snit fra lagerlog, opskrift for egen produktion, overslag | §11 |
| **Hørkram-kurven** (`routes/horkram.js`) | `supplier_unit_code/qty` (akse 1) | Fase A |
| **e-conomic / CO₂** | berøres ikke | — |

## 13. Bekymringer

1. **Ingen automatisk Hørkram-prisopdatering.** Kun knappen *Opdater priser nu*.
   Katalog-typens løfte kræver et natligt job (som `booking-reminders.js`) der kører
   `refreshHorkramPrices` og logger udfaldet — og #698: `/health` svarer altid ok,
   så et nedbrud ses ikke. **Forudsætning for fase 1.** Indtil da viser Varer prisen
   som et oplyst tal med dato, aldrig "opdateres selv".
2. **Tre modeller for pakkens indhold** — §10.
3. **"Klar" uden kostpris** — §11.
4. **Antal i lager-enheden er svært fra en faktura.** Står varen i kg men købes i
   kasser à 10 stk, skal man selv regne kg pr. kasse. Løsning: antallet tastes med
   de delte mængdefelter (`mangde_felter.js`, #658/#665), serveren summerer —
   browseren dividerer stadig kun prisen.
5. **Et skift af "Købes hos" flytter varen på indkøbslisten** — også når den er
   bestilt dér (`ordered_*`). Rækken skal sige det før skiftet.
6. **En vare kan både laves og købes** (Falaffel). *Egen produktion* vinder i status,
   men varenumrene skal kunne ses og bestilles.
7. **0 kr skal bekræftes** i rækken; et fejltastet 0 trækker kostprisen ned usynligt.
8. **Hvem må sætte priser og skifte "Købes hos"?** I dag enhver indlogget (også
   køkkenets fælles konto). Sporet (#666) viser kun rollen.
9. **Hvor bor Varer?** Fem kolonner er trangt i køkkenets 880 px slide-in.
10. **Katalog-søgning koster kald hos leverandøren** — kun på klik, og en udløbet
    session skal give en besked i rækken, ikke en tom liste (#419, #698).
11. **Stamdata-arbejdet (#702) og skærmen må ikke blive to lister.** #702 retter
    91 + 40 koblinger via en CSV; Varer bør være værktøjet til det, ellers rettes det
    samme to steder.
12. **Hørkram-data er udledt, ikke målt.** Alle 119 vægte i #703 er pris/enhed ÷
    pris/kg. De må foreslås i skærmen, aldrig skrives uden et menneske (§4.6).
13. **#704 ligger i de samme filer** som Fase A og alt andet indkøbsarbejde (2.233
    linjer). Jo længere den ligger umerget, jo dyrere bliver den at bære med.
14. **Tre skærme viser pris-status hver for sig** — Varer, varemodtagelsen (#658) og
    lageroversigtens pille (#657). To regler for "har varen en pris?" er præcis den
    fejl dette koncept skal fjerne; reglen skal bo på serveren, ét sted.

## 14. Beslutninger der mangler

Med anbefaling. Ingen af dem kan afgøres i kode.

| # | Beslutning | Anbefaling |
|---|---|---|
| 14.1 | **Drikkevarer (lokation 9)**: blive ved Hørkram, eller en faktura-leverandør? | ✅ **Afgjort 22/9:** sodavand og vand købes gennem Hørkram (katalog); de øvrige drikkevarer (øl, vin, cava, kaffe) hos en faktura-leverandør. Kræver at varerne fordeles på to indkøbssteder — data-arbejde, ikke kode |
| 14.2 | **Én model for akse 3** (§10) | ✅ **Afgjort 22/9:** Grocys `amount` + `qu_id` er eneste sandhed; `pack_size_stock_unit` udledes af det og holder op med at blive skrevet |
| 14.3 | **Kostpris fra leverandørprisen** (§11) | ✅ **Afgjort 22/9:** ja — nyt trin før overslaget. Princip: *vi gætter ikke på priser, medmindre det er bevidst* — et overslag er det eneste bevidste gæt |
| 14.4 | **Hvem må sætte priser / skifte leverandør?** | office + admin; køkkenet kan se og foreslå |
| 14.5 | **Hvor bor Varer?** | fuld side i office; køkkenet linker dertil |
| 14.6 | **Visning af "Købes hos"** | indkøbssted (Convifood), sammenligning på leverandør (§9) |
| 14.7 | **Rækkefølge** (§15) | som foreslået |

## 15. Afhængigheder og rækkefølge

| Arbejde | Status | Forhold til Varer |
|---|---|---|
| #704 arbejdslisten | åben, testet i drift, server tilbage på main | fundamentet (§6) |
| #702 stamdata (91 + 40) | åben, data-arbejde | Varer er værktøjet til det (§13.11) |
| #698 synlige gæt / `/health` | åben | forudsætning for katalog-løftet (§13.1) |
| #471 Fase A (salgsenhed, pris, leveringsdato) | åben, blokeret på akse 3 | deler akse 3 med §10 |
| natligt Hørkram-job | findes ikke | forudsætning (§13.1) |

Foreslået rækkefølge:

1. ~~**Afklar §14.1–14.3.**~~ ✅ Afgjort 22/9 aften.
2. **Ret og merge #704** (afgjort 22/9: hold den til den er rettet):
   indkøbssted uden leverandør = faktura-type, ikke overslag (§9); og "Klar" må først
   vises når kostprisen kender prisen — dvs. §11's nye trin følger med, eller Varer
   skelner "leverandørpris sat" fra "kostprisen har den".
3. **Forudsætninger:** natligt Hørkram-job + #698, og kostprisens nye trin (§11).
4. **Fase 1 + 2** af Varer (liste + vare-panel), med akse 3 på ét felt (§10) og
   #702's mangler som en del af *Skal ordnes* — ikke en separat liste.
5. **Fase A (#471)** når akse 3 er afgjort og stamdataene rettet via Varer.
6. **Fase 3 + 4:** Kataloger-fanen; samme panel i lageroversigt, indkøbsliste og
   varemodtagelse (også pris-status, §13.14).

## 16. Test

Som #704: den ægte browser-kode i vm-sandkasse, målt på hvad der ville blive **sendt**,
og routes over HTTP mod `:memory:` af de rigtige migrations med Grocy stubbet.
Mutationstest af hver tilstandsregel. Browser-verificering mod grocy-test med rigtige
klik, rullet tilbage bagefter.
