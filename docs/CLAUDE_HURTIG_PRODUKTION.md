# CLAUDE_HURTIG_PRODUKTION.md — Mellemprodukter, forecast + lav-hvis-mangler

> Status: **SPEC (ikke bygget).** Source-of-truth. Læs FØR kode.
> Branch: `claude/grocy-hurtig-produktion-*`
> Beslægtet: `services/ingredientResolver.js`, `services/grocyAdapter.js`
> (`produceBatch`, `consumeRecipes`, `getRecipeFulfillment`), `db/helpers.js`
> (`autoConsumeBonInventory`), `routes/production.js`, `docs/CLAUDE_PRODUKTION_MVP.md`,
> prep-kapacitet #276 / `docs/CLAUDE_EVENT.md §15`.

---

## 1. Formål

Lige nu driller **lageret**: menuer peger på producerede mellemprodukter (syltede
rødløg, langtidsstegt gris, remoulade blandet af mayo), og når det mellemprodukt står på
**0**, ser menuen "umulig at lave" — selvom køkkenet sagtens kan lave den, fordi
råvarerne er der. Køkkenets egen sætning er hele løsningen:

> *"Grisen er stegt, og mayoen blander vi det der mangler — hvis råvarerne er der til at
> lave menuen, har vi styr på resten."*

Målet er at lageret **afspejler den virkelighed**, med mindst mulig medarbejder-interaktion.

---

## 1b. Princippet bag det hele (aftalt 26.08.2026)

> **Motoren skal flytte tallene mod virkeligheden, ikke vente på at virkeligheden er pæn.**

Er en bon sat til LEVERET, har kunden fået de varer der stod på bonnen. Maden er ude
af huset, råvarerne er brugt. Det er en kendsgerning, og lageret skal afspejle den.

Man kan ikke sige til en kunde en time før levering at hun ikke får sin mad, fordi der
mangler 1,2 gram hvidløg. Mangler der noget i køkkenet, fikses det eller erstattes —
løber løvstikke-mayoen tør på en festival, får gæsten senneps-mayo hvis hun vil.
Det "ødelægger" lageret, men ikke mere end at næste optælling retter det op.
**Optællingen er backstoppet; motoren skal ikke forsøge at være det.**

Tre følger af princippet:

1. **Ingen blokering.** Rækker råvarerne ikke, træk hvad der ER, læg resten på
   indkøbslisten, og lad leveringen gå igennem. Se #560 — §2 og §4.4 nedenfor er
   endnu ikke rettet til dette.
2. **Hele batches er en størrelse, ikke et veto.** Reglen afgør *hvor meget* der laves
   når det kan lade sig gøre — ikke *om* der blev lavet noget.
3. **Sig det højt frem for at gætte.** Mangler et tal, skal det kunne ses at det
   mangler. En tavs nul-værdi er værre end en synlig tom.

### Lagerpris og kostpris er ikke det samme

En tilbagevendende forvirring, så den står her:

| | hvad det er | hvor det kommer fra |
|---|---|---|
| **Lagerpris** | hvad varen er bogført til | det vi betalte — for købte varer |
| **Kostpris** | hvad opskriften koster at lave | Σ ingrediens × pris ÷ udbytte |

For en **købt** råvare er de to det samme tal. For noget **vi selv laver** findes der
ingen købspris — og så er lagerprisen et tal Grocy har båret videre fra en optælling,
mens kostprisen er svaret. `services/recipeCost.js` foretrækker i dag lagerprisen når
den findes, hvilket gør elleve salgbare retters kostpris 1–11 % for lav. Se #558.

Målt 26.08: Remoulade står til 43,47 kr/kg og koster 70,15 at lave. Chili Mayo 80 mod
117,76. Kylling-BBQ 91,33 mod 109,75.

**Retningen er aftalt:** alt skal have en kostpris, og det skal kunne ses hvis noget
mangler en. På sigt lægges opskriftens produktionstid oven i råvareprisen, så man kan
se hvad det koster at lave fx syltet rødkål (hænger sammen med #276).

---

## 2. Kernemodel (låst med køkkenet)

**Ét princip:** hver underopskrift laver **ét produkt** med et udbytte (kg *eller* stk).
Menuen trækker **produktet**. Der trækkes **ved levering som i dag** (timing uændret).

Køkkenets **to kategorier styrer to roller** — ikke to systemer:

| Kategori | Lead-time | Hvem laver det | Bons rolle |
|---|---|---|---|
| **RR produktion** | lang (gris 5 t, sylt dagen før) | **personalet**, ahead, på rolige dage | **Forecast**: "der skal nok laves gris snart". Bon laver det **aldrig** selv. |
| **RR produktion Hurtig** | kort (mayo 5 min) | **Bon** ved levering | **Laver hele batches** — minimum antal nødvendigt (1 kg mayo ad gangen). Overskud står til næste bon. |

Og den ene fælles rettelse der stopper lager-drillet:

> **En menu tæller som "kan laves" når RÅVARERNE er der** — også når mellemproduktet står
> på 0. Gælder begge kategorier. Så holder Råvarer-/planlægnings-visningen op med at råbe
> ulven, når et sylt/gris-produkt lige er tomt.

**Batch-reglen (bekræftet):** Hurtig laver hele batches, ikke præcis mængde — I gemmer
ikke en halv pose ublandet mayo. Restbehov rundes op til hele batches; overskud står.

**Udenfor scope (bevidst parkeret):** prep-tider, kapacitet, holdplanlægning, metode-valg
(hurtig/langsom løvstikke), sekvens (kog→køl→skær). Køkkenet: *"resten har vi styr på."*

---

## 3. Data fra grocy-hq (målt read-only 31. juli 2026)

Kategorierne findes allerede: **`RR Produktion` (15)** — laver et produkt, tælles op.
**`RR produktion Hurtig` (17)** — intet output-produkt, nestes i menuer.

**Beviset på det akutte drill — producerede RR-produkter der bruges i menuer, men står på 0:**

| Mellemprodukt | Lager nu | Menuer der bruger det |
|---|---|---|
| Rødløg - Sylt | **0** | Kartoflen, Ægget, Tunen, Kyllingen … (11) |
| Rødkål - Sylt | **0** | Frikadellen (+slider) |
| Gulerødder - Sylt | **0** | Fisken (+slider) |
| Spicy "Tuna" | **0** | Tunen (+slider) |
| Æble chutney | **0** | Grisen på Rug (+slider) |
| Langtids Stegt Gris | 1,18 | Grisen på Rug (+slider) |
| Kylling - BBQ / Falaffel | 6 / 23 | Kyllingen / Falaflen … |

→ Menuerne med et 0-produkt ser umulige ud, selvom råvarerne er der.

**"RR produktion Hurtig" (17) opdeler sig i:**
- **9 reelle blandinger** (skal konverteres til produkter): Frisk Grønt (26 menuer),
  Løvstikke Mayo (8), Senneps Mayo (6), Remoulade (3), Chili/Trøffel Mayo · Tahin ·
  Yoghurt dressing (2 hver), + Skære Slider Brød (12 — se §7).
- **8 rene arbejdstrin** (0 råvarer, nestes ingen steder — røres **ikke**): Hakke purløg,
  Koge kartofler, Samle bokse, Skære frikadeller osv.

---

## 4. Kode — Lag 1 (fikser drillet, på data der allerede findes)

### 4.1 Tilgængelighed: "kan laves af råvarer"
`getRecipeFulfillment` (Grocy) stopper ved et produkts lager — den ved ikke at produktet
kan *laves*. Tilføj et Bon-lag: et mellemprodukt tæller som tilgængeligt hvis
`lager ≥ behov` **ELLER** dets producerende opskrifts råvarer er tilgængelige (rekursivt
ned til rå). Menu = "kan laves" når alt løser op til tilgængelige råvarer. Fikser
sylt/gris-visningen straks — ingen Grocy-ændring nødvendig.

### 4.2 Hurtig: Bon laver hele batches ved LEVERET
I `autoConsumeBonInventory` (timing uændret): for hvert **Hurtig-produkt** hvor
`lager < behov`:
```
shortfall = behov − lager
batches   = ceil(shortfall / batch_udbytte)      ← hele batches
raw_ok    = min(batches, max hele batches råvarerne rækker til)
if raw_ok > 0: produceBatch(consume råvarer × raw_ok  →  add produkt raw_ok × udbytte)
```
Derefter trækkes menu-produktet som i dag. Genbruger `produceBatch` fra
`routes/production.js`. Idempotent via `bons.inventory_deducted`.

### 4.3 RR: kun forecast — aldrig auto-produktion
Bon laver **aldrig** et RR-produkt. I stedet: forecast over de næste N dage (behov pr.
RR-produkt fra kommende bons, samme beregning som planlægning) → en liste "lav snart:
~X kg rødløg-sylt, Y portioner gris". Vises hvor køkkenet ser det (dashboard / Råvarer /
en simpel prep-ahead-liste). Ingen `produceBatch`.

### 4.4 Når produktion ikke kan fuldføres (Hurtig, råvarer utilstrækkelige)
Lav de hele batches råvarerne rækker til (kan være 0), træk hvad der er, læg de manglende
**RÅVARER** (mayo/relish) på indkøbslisten — **ikke** det uindkøbelige mellemprodukt.
**Advarsel** (hændelse på den bon der leveres, ikke et flag på fremtiden): changelog +
køkken-notifikation + synlig i bonens Råvarer-visning. Leveringen blokeres aldrig.

### 4.5 Pris ved produktion
`produceBatch` tager kostpris ex moms fra råvarerne (som `routes/production.js`), så
Grocy-fulfillment og margin-analyse (Opskrifter & priser) er upåvirket.

---

## 5. Grocy master-data — Lag 2 (konvertér de 9 Hurtig-blandinger)

Per blanding (kopiér mønstret fra en eksisterende `RR Produktion`, fx Rødløg-Syltet →
Rødløg-Sylt):
1. Opret lagerprodukt med **udbytte-enhed** = kg *eller* stk (se §6).
2. Sæt opskriftens "produceret produkt" + udbytte pr. batch.
3. Rewire hver menu: nesting → `recipes_pos` der peger på det nye produkt.

### 5.1 Udrulningsplan — de otte (fastlagt 24.08.2026)

Batchstørrelserne er bekræftet af køkkenet på et ark og rettet i Grocy hvor de var
forkerte (Frisk Grønt trak for lidt kål, fordi stokken ikke var talt med; Tahin,
Chili og Yoghurt erklærede et udbytte der var mindre end det de vejer). Nul-linjen
til gaten ligger i `data/gate-baseline/`.

**Lokation og varegruppe følger hovedingrediensen** — efterprøvet mod Grocy, ikke
skønnet: mayonnaisen står i Køleskab/05 Dressinger, kålen i Køleskab/03 Grønt,
Brød Rug i Fryser/01 Brød. Lokationen bestemmer hvilken liste varen dukker op på
ved den fysiske optælling, så en vare det forkerte sted bliver aldrig talt.

| # | Blanding | Menuer | `--location` | `--group` | Særligt |
|---|---|---|---|---|---|
| 1 | Tahin dressing | 2 | Køleskab | 05 Dressinger | |
| 2 | Chili Mayo | 2 | Køleskab | 05 Dressinger | |
| 3 | Trøffel Mayo | 2 | Køleskab | 05 Dressinger | |
| 4 | Yoghurt dressing | 2 | Køleskab | 05 Dressinger | |
| 5 | Senneps Mayo | 7 | Køleskab | 05 Dressinger | |
| 6 | Løvstikke Mayo | 10 | Køleskab | 05 Dressinger | |
| 7 | Skære Slider Brød | 14 | Fryser | 01 Brød | `--stock-unit Kilo --unit-size 0.06` |
| 8 | **Frisk Grønt** | **28** | Køleskab | 03 Grønt | |

Rækkefølgen er stigende blast-radius. Én ad gangen, med drift imellem.

**Menu-tallene er den fulde rækkevidde**, ikke antallet af direkte nestere — en
produktionsopskrift kan selv være nestet videre (#543's Æggesalat-fund). Issuets
oprindelige tal var derfor for lave hele vejen ned.

Per konvertering:

```bash
# 1. mål før
node --env-file=.env scripts/recipe-fingerprint.js --uses "<navn>" --out foer.json
# 2. se hvad der ville ske
node --env-file=.env scripts/convert-blend-to-product.js --recipe "<navn>" \
     --state <navn>.json --confirm-hq --location <lok> --group "<gruppe>"
# 3. gør det   (samme linje + --apply)
# 4. mål efter og sammenlign — gaten SKAL være grøn
node --env-file=.env scripts/recipe-fingerprint.js --uses "<navn>" --out efter.json
node scripts/recipe-fingerprint.js --diff foer.json efter.json
```

Rulles noget tilbage: `--rollback --apply` med samme tilstandsfil.

> Kun **Skære Slider Brød** har lager-enhed ≠ udbytte-enhed: lageret føres i kilo,
> forbruget tælles i sliders (1 slider = ½ brød = 0,06 kg). Batchen er 32 brød =
> ½ kasse = 64 sliders, sat via `base_servings` så de 12 menuers `servings=1`
> bliver stående. Se §6/§7.1.

> ⚠️ **Rækkefølge:** Lag 1-koden skal være i drift FØR (eller samtidig med) konverteringen
> — ellers bliver 0-lager-produkter til nye "umulig"-menuer, præcis som sylterne driller nu.
> Start med **Remoulade** (3 menuer) som pilot; Frisk Grønt (26) til sidst.

---

## 6. Udbytte pr. opskrift — kg ELLER stk

"1 kg = 1 portion" gælder **ikke** universelt. Udbyttet sættes pr. opskrift:
- **Blandinger** (mayo, remoulade, Frisk Grønt): kg. Fx Remoulade 1 kg = 0,5 mayo + 0,5 relish.
- **Antalsvarer** (slider-brød): **lager-QU = Kilo, consume-QU = stk** — Grocy
  QU-konvertering som resten af systemet (`recipes_pos.amount` i stock-units). 1 brød →
  **2 slidere**. Lageret føres i kg, men tælles/forbruges i stk, så morgen-tallet er
  `behov − lager` i stk: *"128 slidere skal bruges, 40 på lager → skær 44 brød."* Ingen
  separat prep-liste — samme beregning som alt andet.

---

## 7. Besluttet med køkkenet

1. **Skære Slider Brød** → **bliver et produkt** (ikke nesting). Lager-QU = **Kilo**,
   consume-QU = **stk** (2 slidere/brød, jf. §6). 12 menuer rewires.
2. **RR-produkt tomt ved levering** → trækkes som i dag (må gå i minus/shortfall);
   forecastet (§4.3) skal forhindre det. Bon laver **aldrig** gris bag om ryggen.
3. **CO₂** → hænger **på mellemproduktet**. Fallback: rul fra råvarer hvis det er nemmere
   at implementere (acceptabelt — samme resultat). (`services/co2Engine.js`)
4. **Råvarer-fanens dybde** → **ja**, man skal kunne **folde et produkt op til dets
   råvarer** ("hvad går der i remoulade"). Krav på Råvarer-modalen (`shared/modal.js`).

---

## 8. Rippeeffekt — forbrugere der SKAL auditeres ved Lag 2

Når blandinger bliver produkter, ændrer det hvad disse viser (Frisk Grønt = 26 menuer,
har allerede buffer-særbehandling i event-prep):

| Forbruger | Fil |
|---|---|
| Råvarer/Produktion-modal | `shared/modal.js`, `resolveIngredients` |
| Pakkeliste | `shared/modal.js` (`showPakkeliste`) |
| Planlægning | `shared/planning.js` |
| Event top-up-forecast | `routes/events.js` (`computeTopupSuggestion`) |
| CO₂ (hæng på mellemproduktet; fallback rul fra råvarer — §7.3) | `services/co2Engine.js` |
| Råvarer-fold-out (produkt → råvarer — §7.4) | `shared/modal.js` |

---

## 9. Build-rækkefølge

1. **Lag 1-kode** (§4): tilgængelighed-fra-råvarer + Hurtig auto-batch ved LEVERET +
   RR-forecast + advarsel. Fixer sylt/gris straks, ingen Grocy-rewiring.
2. Verificér i drift på de eksisterende RR-produkter.
3. **Konvertér Remoulade** (pilot, 3 menuer) → verificér end-to-end.
4. Konvertér resten (Frisk Grønt sidst), auditér rippeforbrugere (§8) undervejs.

---

## 10. Test (skitse)

- Tilgængelighed: menu med 0-lager RR-produkt men råvarer til stede → "kan laves".
- Hurtig auto-batch: lager 0, behov 0,03 → lav 1 batch (1 kg), træk 0,03, 0,97 står.
- Oprunding: shortfall 1,2 batch → 2 batches.
- Råvarer utilstrækkelige → max hele batches + rest af RÅVARER på indkøbsliste + advarsel.
- RR: forecast beregner behov; **ingen** `produceBatch` kaldes for RR.
- Idempotens: to LEVERET → ét produktions-/træk-sæt.
- Slider: behov 128, lager 40 → "skær 44 brød".
- Regression: `test-prep-packing`, `test-topup-suggestion`, `test-subrecipe-status`,
  `test-recipe-factor`, `moms_audit_e2e`.
