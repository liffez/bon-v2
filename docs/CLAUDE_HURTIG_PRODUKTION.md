# CLAUDE_HURTIG_PRODUKTION.md — Mellemprodukter + lav-hvis-mangler

> Status: **SPEC (ikke bygget).** Source-of-truth for feature'en. Læs FØR kode.
> Branch: `claude/grocy-hurtig-produktion-*`
> Beslægtet: `services/ingredientResolver.js`, `services/grocyAdapter.js` (`produceBatch`,
> `consumeRecipes`), `db/helpers.js` (`autoConsumeBonInventory`), `routes/production.js`,
> `docs/CLAUDE_PRODUKTION_MVP.md`.

---

## 1. Formål

Underopskrifter som **remoulade** foldes i dag ud til deres råvarer (mayo + relish) og
trækkes som råvarer fra HQ ved LEVERET. Remoulade findes ikke som en fysisk lagervare.

Vi vil i stedet:

1. Give udvalgte "RR produktion Hurtig"-opskrifter et **produceret produkt** (som de
   eksisterende "RR Produktion"-opskrifter allerede har).
2. Lade menuerne trække **produktet** i stedet for de underliggende råvarer.
3. Lade Bon **selv producere** et produkt hvis det mangler ved LEVERET — rekursivt, og
   kun hvis råvarerne er der.

Gevinst: ægte lagertal på mellemprodukter (fx "vi har 3 kg remoulade"), ægte
pre-produktion (lav en bøtte mandag, brug hele ugen), og kostpris/CO₂ der kan hænge på
mellemproduktet.

---

## 2. Nuværende tilstand i grocy-hq (målt read-only 31. juli 2026)

Der er **ingen** kategori kaldet "hurtig produktion". Der er to kategorier:

| grupper-værdi | antal | betydning |
|---|---|---|
| `RR Produktion` | 15 | Producerer allerede et produkt (**skabelonen**) |
| `RR produktion Hurtig` | 17 | Nestes i menuer, **intet output-produkt** (dem vi konverterer) |

**Skabelon-eksempler** (allerede korrekt opsat, kopiér mønstret):
`Kylling stegt produktion → Kylling - BBQ`, `Falaffel- stegning → Falaffel`,
`Rødløg - Syltet → Rødløg - Sylt`, `Gulerødder - Syltet → Gulerødder - Sylt`.

**"RR produktion Hurtig" (17) opdeler sig i:**

**A) 9 reelle producerbare produkter — i scope:**

| Opskrift | Råvarer (base=1) | Output ≈ | Nestet i N menuer |
|---|---|---|---|
| Frisk Grønt | Spinat 0,1 + kål 0,5 + Rødkål 0,4 | 1,0 kg | **26** |
| Skære Slider Brød | Brød Rug 0,06 | portionering | 12 *(se §7 — judgment)* |
| Løvstikke Mayo | Mayo 1 + Løvstikke 0,03 spsk | ~1 kg | 8 |
| Senneps Mayo | Mayo 1 + Sennep 0,03 spsk | ~1 kg | 6 |
| Remoulade | Mayo 0,5 + Pickles/Relish 0,5 | 1,0 kg | 3 |
| Chili Mayo | Mayo 1 + Chili Sauce 0,1 L | ~1,1 kg | 2 |
| Trøffel Mayo | Mayo 1 + Trøffel olie 0,01 | ~1 kg | 2 |
| Tahin dressing | Mayo-Vegansk 1 + tahini/citron/salt/hvidløg | ~1 kg | 2 |
| Yoghurt dressing | Vegansk yoghurt 1 L + krydderi | ~1 L | 2 |

`base_servings = 1` på alle undtagen konvention holder → **1 portion ≈ 1 kg** passer.

**B) 8 rene arbejdstrin — UDEN FOR SCOPE** (0 råvarer, nestes ingen steder):
Hakke purløg, Koge og skære kartofler, Samle sandwich/slider/sliderskinner-bokse,
Skære fiske-deller, Skære frikadeller, Skære RR Brød. Røres ikke.

**Rewiring-omfang:** 28 distinkte menuer, men koncentreret — Frisk Grønt (26) +
Skære Slider Brød (12) dominerer; resten er små overlap.

---

## 3. Målmodel

```
Menu (fx "Fisken")
  └─ recipes_pos: Remoulade-PRODUKT  0,03 kg      ← produkt-ingrediens (ikke nesting)
                     │
                     ▼ ved LEVERET, hvis lager < behov
        produceBatch: consume Mayo 0,5 + Relish 0,5  →  add "Remoulade" 1 kg
                     │
                     ▼
              consume Remoulade-PRODUKT 0,03 kg fra HQ
```

**Invariant:** ved LEVERET trækkes altid det færdige mellemprodukt, aldrig dets råvarer
direkte (medmindre produktet ikke kunne laves — se §5).

---

## 4. Grocy master-data (den største, men manuelle del)

Per af de 9 opskrifter (kopiér skabelon-mønstret fra en eksisterende `RR Produktion`):

1. **Opret et lagerprodukt** (fx "Remoulade") — stock-enhed **Kilo**, egen lokation HQ.
2. **Sæt opskriftens "produceret produkt"** til det, med **1 portion = 1 kg** output.
3. **Rewire hver menu** der i dag nester opskriften: fjern nesting, tilføj i stedet en
   `recipes_pos`-linje der peger på det nye produkt med den mængde menuen bruger
   (fx Fisken: Remoulade-produkt 0,03 kg).
4. Verificér QU-konvertering findes hvis menuen bruger en anden enhed end kg.

> ⚠️ **Rækkefølge:** rewire menuerne FØR koden slås til i drift — ellers ser resolveren
> stadig nestings og folder ud som før. Konverter gerne én opskrift ad gangen
> (fx start med Remoulade — kun 3 menuer) og verificér før de store (Frisk Grønt = 26).

Grocy laver **ikke** selv rekursiv produktion når man consumer en menu — det er derfor
koden i §5 skal gøre det.

---

## 5. Kode

### 5.1 Resolver: "stop-ved-produkt"-tilstand

`resolveConsumeItems` folder i dag ALT ud til råvarer. Når mellemprodukterne bliver
rigtige produkt-ingredienser, holder resolveren automatisk op med at folde dem ud (de er
ikke længere nestings) — **så selve resolveren kræver formentlig ingen ændring** for
consume-stien; produkt-ingredienser aggregeres allerede som direkte `recipes_pos`.

Det vi skal tilføje er **produktions-laget** oven på consume.

### 5.2 LEVERET: lav-hvis-mangler (rekursivt)

Ny orkestrering i `autoConsumeBonInventory` → ny helper (fx
`ensureProducedThenConsume(lines)`):

```
1. Resolve consume-items for bonen (produkt-niveau, som i dag).
2. Byg "producer-map": produkt_id → producerende opskrift
   (fra recipes hvor product_id er sat, kategori RR Produktion*).
3. Topologisk: producér BLADE før forældre (et mellemprodukt kan bruge et andet).
   For hvert produkt der er et produceret produkt OG lager < behov:
     shortfall = behov − lager
     batches   = ceil(shortfall / 1 kg)           ← hele 1-kg batches (§ bekræftet)
     Sørg først (rekursivt) for at DETS inputs findes.
     raw_ok_batches = min(batches, max hele batches råvarerne rækker til)
     if raw_ok_batches > 0: produceBatch(consume råvarer × raw_ok_batches,
                                         produce produkt raw_ok_batches kg)
     if raw_ok_batches < batches: WARN (§5.3) + manglende RÅVARER → indkøbsliste
4. Consume alle menu-items normalt (eksisterende consumeRecipes-hale:
   consume + shortfall→indkøbsliste + resultat pr. linje).
```

**Vigtigt om indkøbslisten:** når produktion ikke kan fuldføres, skal de **manglende
RÅVARER** (mayo/relish) på indkøbslisten — IKKE det uindkøbelige mellemprodukt
(remoulade kan man ikke bestille).

**Idempotens:** hele blokken er allerede vagtet af `bons.inventory_deducted` — LEVERET
kan ikke dobbelt-producere.

**Oprunding sker på restbehovet** (bekræftet): 0,3 kg på lager, behov 0,6 → shortfall
0,3 → rund op → lav 1 kg → 0,7 kg står tilbage til næste bon.

### 5.3 Advarslen (til diskussion — foreløbig beslutning)

Advarslen er en **hændelse på den bon der leveres**, ikke et stående flag på fremtidige
bonner (en fremtidig bon er ikke leveret endnu → intet mangel-faktum). Foreslået home:

- **changelog** på bonen (audit — altid),
- **SSE-notifikation** til køkkenet (samme kanal som flyver/notifikationer),
- synlig i bonens **Råvarer-visning**.

Ingen `entity_flags`. Look-ahead ("kan ikke nå at lave X til torsdag") dækkes af de
eksisterende lager-status-farver i Råvarer-fane / planlægning / ugeoversigt.

> ÅBENT: bekræft placering (changelog + notifikation + Råvarer-visning?).

### 5.4 Pris/kostpris ved produktion

`produceBatch` tager en `price` (kostpris pr. enhed, ex moms — R3). Sæt den fra
råvarernes kostpris (samme mønster som `routes/production.js` / `services/production.js`).
Så bevarer Grocy-fulfillment korrekt kostpris når menuen refererer produktet, og
**Opskrifter & priser** (margin-analyse) er upåvirket.

---

## 6. Rippeeffekt — resolver-forbrugere der SKAL auditeres

Når remoulade/Frisk Grønt bliver produkter (ikke nestings), ændrer det hvad ALLE disse
viser. Hver skal besluttes bevidst:

| Forbruger | Fil | Effekt |
|---|---|---|
| Råvarer/Produktion-modal | `shared/modal.js`, `resolveIngredients` | "Remoulade 0,6 kg" i stedet for mayo+relish. Ønsket — men de underliggende råvarer forsvinder fra Råvarer-fanen medmindre vi folder produkt→opskrift ét niveau. |
| Pakkeliste | `shared/modal.js` (`showPakkeliste`), `resolveConsumeItems` | Mellemprodukt pakkes som ét item ("blandet hjemmefra"). Passer godt — men verificér mod §14b i CLAUDE_EVENT. |
| Planlægnings-aggregering | `shared/planning.js`, `/planning/ingredients` | Aggregerer nu på produkt-niveau. |
| Event top-up-forecast | `routes/events.js` (`computeTopupSuggestion`) | BOM-behov skifter niveau. **Frisk Grønt har allerede buffer-særbehandling** — dobbelttjek. |
| CO₂ | `services/co2Engine.js` | CO₂ skal hænge på mellemproduktet (eller stadig rulles fra råvarer). Beslut. |
| Margin / Opskrifter & priser | `routes/recipes_overview.js` | Kostpris via fulfillment — OK hvis produktets pris sættes ved produktion (§5.4). |

Dette er den **egentlige pris** ved feature'en (bruger bekræftet: "større arbejde").

---

## 7. Åbne beslutninger

1. **Skære Slider Brød** — portionering, ikke en blanding. "1 kg = 1 portion" passer
   dårligt. Skal den overhovedet være et lagerprodukt, eller forblive en nesting?
   (12 menuer på spil.) → **Anbefaling: lad den forblive nesting i første omgang.**
2. **Advarsel-placering** (§5.3) — bekræft.
3. **CO₂-niveau** (§6) — hæng på mellemprodukt eller rul fra råvarer?
4. **Råvarer-fanens dybde** — skal den kunne folde et produkt op til dets råvarer, så
   køkkenet stadig kan se "hvad går der i remoulade"?
5. **Rækkefølge for udrulning** — start med Remoulade (3 menuer) som pilot?

---

## 8. Test-plan (skitse)

- `resolveConsumeItems`: menu med produkt-ingrediens → trækker produktet, ikke råvarer.
- Lav-hvis-mangler: lager 0 remoulade → LEVERET → produceBatch (mayo+relish trukket,
  1 kg remoulade lagt på) → remoulade trukket. Verificér mod isoleret test-Grocy.
- Oprunding: shortfall 0,3 → 1 batch; 1,2 → 2 batches.
- Råvarer utilstrækkelige: producér max hele batches råvarerne rækker til, rest af RÅVARER
  på indkøbsliste + advarsel; leveringen blokeres ikke.
- Idempotens: to LEVERET-kald → kun ét produktions- + consume-sæt.
- Rekursion: produkt der bruger et andet produkt → blade produceres først.
- Regression: `test-prep-packing`, `test-topup-suggestion`, `test-subrecipe-status`,
  `test-recipe-factor`, `moms_audit_e2e`.

---

## 9. Udrulnings-rækkefølge

1. Grocy: opret produkt + rewire menuer for **Remoulade** (pilot, 3 menuer).
2. Kode: resolver-verifikation + lav-hvis-mangler + advarsel, testet mod test-Grocy.
3. Verificér Remoulade end-to-end i drift.
4. Konverter resten (Frisk Grønt til sidst — 26 menuer), én ad gangen.
5. Audit hver rippeforbruger (§6) efterhånden.
