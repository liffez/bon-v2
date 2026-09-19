# CLAUDE_CO2.md — CO₂-aftryk pr. bon + ESG-datagrundlag

**Status:** Spec klar til implementering i Claude Code
**Ejer:** Leif (produkt) · implementering via Claude Code
**Sidst opdateret:** 2026-05-29

---

## 0. Formål

To leverancer, klart adskilt i sværhedsgrad:

| Leverance | Sværhedsgrad | Kerne |
|-----------|--------------|-------|
| **CO₂ pr. bon** | Lav | `bon_lines.co2e` findes allerede. Opskrift → kg → faktor → frosset snapshot |
| **ESG-datagrundlag** | Mellem | Bon v2 er *datafeeder*, ikke rapportgenerator. Layout laves i Canva/Affinity |

**Princip (uændret):** Grocy ejer al varedata (pris, mængde, varenr., sammensætning, allergener, øko, kostklasse, næring — og nu CO₂-faktor). Bon v2 læser via adapter, gemmer frosne snapshots lokalt. Bon v2 skriver **kun** til Grocy via REST-API (userfields, conversions) — aldrig direkte i Grocy's DB.

---

## 1. Kildehierarki for CO₂-faktorer

CO₂-faktoren er en iboende vareegenskab og bor i Grocy, sat via **kontrolleret import** (ikke manuel indtastning — det var roden til v1-fejlene).

```
Resolution-prioritet ved import:
  1. CONCITO "Den Store Klimadatabase" v1.2   → source = klimadb    (fødevarer, match på Ra-ID)
  2. Materiale-faktortabel (Klimakompasset)    → source = material   (emballage, match på co2e_material)
  3. Hørkram hk_co2e (scrapet)                 → source = supplier   (fallback hvor 1+2 ikke har data)
  4. Manuel / estimat                          → source = manual
  5. (ingen)                                   → source = na / MANGLER
```

To eksterne kilder, begge **statiske datasæt uden API** — det gør opdatering enklere, ikke sværere:

| Kilde | Indhold | Bruges til |
|-------|---------|------------|
| **CONCITO Den Store Klimadatabase v1.2** | ~500 fødevarer, kg CO₂e/kg (nettovægt), faseopdelt. Officielle Ra-ID'er. Excel-download fra denstoreklimadatabase.dk | Fødevare-faktorer |
| **Klimakompasset (Erhvervsstyrelsen)** | Materialefaktorer (pap, plast, papir m.m.). Dataark | Emballage-materialefaktorer |

> **Ra-ID er bekræftet CONCITOs officielle nøgle** → stabil join på tværs af versioner. Gem Ra-ID på produktet **én gang** (`co2e_klima_id`); derefter re-resolver hver fremtidig CONCITO-version sig selv.

---

## 2. Grocy userfields (opret via API)

Nye userfields på `entity = products`:

| Userfield | Type | Indhold |
|-----------|------|---------|
| `co2e_per_kg` | number-decimal | Resolvet faktor, kg CO₂e pr. kg |
| `co2e_source` | text | `klimadb` \| `material` \| `supplier` \| `manual` \| `na` |
| `co2e_klima_id` | text | CONCITO Ra-ID (NULL hvis ikke fødevare-match) |
| `co2e_material` | text | Materialevalg for emballage (`pap`, `LDPE`, …) — NULL for fødevarer |
| `co2e_version` | text | Kildeversion, fx `CONCITO v1.2` / `Klimakompas 2025` |

**Deprecér det korrupte felt:** `products.Co2e` (number-decimal) er bevist upålidelig — blandede enheder og fejlindtastninger (Brød Rug=22, Morgen Boller=211, Mynthe=100, nuller). Kun 6/215 udfyldt.

- Omdøb til `Co2e_OLD` (eller markér deprecated) så **intet** beregningskald rammer det.
- Samme for `recipes.Co2e` → erstattes af genberegnet cache (§7).
- `hk_co2e` (27/215, konsistent kg/kg) **beholdes** som `source=supplier`-fallback.

---

## 3. Tre-klasse-modellen (enhedsdisciplin)

### Reglen
> **Stock-enheden er den enhed varen kan opgøres i uden at skønne, i det øjeblik den modtages.**
> Vejes ind → kg. Måles i volumen → L. Tælles → Antal.
> Stock = den ikke-skønnede enhed. Alt andet er en konvertering.

### Klassen UDLEDES af QU_stock — gemmes ikke (ingen drift)

| QU_stock-familie | Klasse | Tillæg pr. vare | Faktorfelt |
|------------------|--------|-----------------|-----------|
| Kilo / Gram (id 4,5) | vejevare | ingen (er kg) | `co2e_per_kg` direkte |
| Liter / ml (id 6,7) | væske | densitet L→kg | `co2e_per_kg` |
| Antal/Flaske/Pose/Pakke (id 8,10,14,15…) | tællevare | vægt stk→kg | `co2e_per_kg` |
| (er underopskrift, `recipes_nestings`) | computed | — | aftryk = Σ komponenter |
| (gruppe x-levering/x-service) | na | — | — |

**Vigtigt: 3 klasser ≠ 3 faktorer pr. vare.** En vare lever i præcis én klasse og bærer **max ét** ekstra tal (densitet *eller* vægt). De 70+ vejevarer kræver nul. Mekanikken kører allerede: Grocy har i dag 242 conversions (10 globale + 232 vare-specifikke på 91 varer) + resolved cache (5847 rækker).

### Enforcement = `opret-produkt`
Når en ny vare oprettes, **er** valget af stock-enhed klassificeringen. Intake-UI skal:

- tilbyde et **vægt-felt**: "*N enheder vejer Y gram*" → systemet udleder kg/stk (vej N stk, ikke 1 — en serviet på 1,2 g kan ikke vejes enkeltvis)
- **ikke blokere** hvis tomt — varen oprettes alligevel
- vise **inline-flag** hvis tællevare oprettes uden vægt
- efterlade en stående post i CO₂-overblikket (`MANGLER vægt`) til senere

---

## 4. Konkrete db-rettelser (engangs, via Grocy-API)

Audit (§9) mod faktisk db: **161 opskrift-ingredienser, 129 har kg-vej, 32 mangler.** De 32 fordeler sig:

| Kategori | Antal | Handling |
|----------|-------|----------|
| Emballage (gruppe 9) | 21 | Vej → stk→kg-konvertering + `co2e_material` (§6) |
| Drikkevarer (gruppe 7) | 5 | Egen faktor pr. stk/L |
| **Ægte fejl** | 6 | Se nedenfor |

De 6 ægte fejl:

| # | Vare | Problem | Fix |
|---|------|---------|-----|
| 89 | Bagepapir | egl. emballage, fejlplaceret i "Lager varer" | flyt til gruppe 10 + vej |
| 85 | Fryseposer | do. | do. |
| 140 | Vaccum poser | do. | do. |
| 56 | Fatdane - sodavand | drikkevare i gruppe "Oversigt" | flyt + faktor |
| **166** | **laurbærblade** | **fødevare med stock=Antal, ingen kg-vej** | sæt kg-vej (vægt pr. blad/stk) |
| **206** | **petit four** | **fødevare med stock=Antal, ingen kg-vej** | sæt kg-vej |

Plus indtastning af:
- ~14 væsker → densitet-konvertering (vand/saft ≈ 1,0; olie ≈ 0,92; Katrine har flere estimater)
- ~33 tællevarer/emballage → **målt** vægt-pr-stk

---

## 5. Hørkram kg-priser → vægten gør tredobbelt arbejde

Databasen bekræfter: stort set alle Hørkram-priser er pr. kg, også på tællevarer (sodavand #56: `supplier_price_per_kg=73.24`). Med en kg-vej pr. vare bliver den **samme** målte vægt brugt tre steder:

| Tal | Beregning |
|-----|-----------|
| CO₂ | stk × kg/stk × `co2e_per_kg` |
| ESG emballagemasse (VSME B7) | Σ(stk på bonner × kg/stk) |
| Kostpris pr. stk | kg-pris × kg/stk |

**Risiko at flage i kode:** forkert vægt → både CO₂ *og* kostpris er forkert. Derfor plausibilitetsgrænser (§9) og "vej N stk".

**Auto-seed muligt? Nej.** `supplier_unit_qty/_code` indeholder kun kolli (`8 ks`, `1 fl`) uden vægt; `pack_size_stock_unit` er tom; barcode-`amount` er NULL for tællevarer. De ~33 vægte vejes manuelt (engangs).

---

## 6. Emballage — egen materiale-faktortabel

CONCITO kan **ikke** bruges: det er ~500 *fødevarer*; emballage optræder kun som en *fase inde i* en fødevares aftryk, ikke som selvstændigt opslagbart materiale. Derfor egen lille reference (både nemmest og mest rigtigt — materialer deles på tværs af mange varer; vedligehold ~15 faktorer, ikke 33 varer).

```
co2e_material (Grocy userfield, peger på ÉT materiale)
        │  resolves ved import
        ▼
materiale-faktortabel (lille reference i Bon v2, kun brugt ved import, versioneret)
        │
        ▼
skriver co2e_per_kg + co2e_source=material + co2e_version på varen
```

Symmetrisk med CONCITO: ekstern reference resolves til Grocy-userfield ved import. Tildeling sker via samme bulk-bekræft-UI som Ra-ID-tildeleren (§8).

**Startsæt af materialer** (Katrine/bror udfylder de faktiske kg CO₂e/kg fra Klimakompasset):

| Materiale | Typiske varer | kg CO₂e/kg |
|-----------|---------------|-----------|
| Bølgepap | Transportkasser, pomfrit-/pizzabakker | _udfyldes_ |
| Karton/pap | Salatbokse, RR/slider/børneboks | _udfyldes_ |
| Papir | Servietter, bagepapir, etiketter | _udfyldes_ |
| LDPE-film | Fryse-/vakuum-/turposer | _udfyldes_ |
| PET | Klare kopper/bægre | _udfyldes_ |
| PLA/bagasse | "Grønne" engangsvarer | _udfyldes_ |
| PP | Gafler, rørepinde, låg | _udfyldes_ |
| Aluminium | Foliebakker | _udfyldes_ |

**Metodenote (til rapporten, ikke en blocker):** CONCITOs emballagefase = fødevarens egen detail-emballage (plasten om osten), **ikke** jeres cateringboks (downstream). Ingen dobbelttælling — men skriv afgrænsningen i metodeafsnittet.

---

## 7. Beregningsmotor

Ny service (vanilla, læser Grocy via eksisterende adapter — ingen ORM, ingen Docker):

```
For hver opskrift:
  for hver recipes_pos-linje:
     hvis underopskrift (nesting) → recurse
     ellers:
        mængde (recipes_pos.amount, recipes_pos.qu_id)
          → konvertér til kg via cache__quantity_unit_conversions_resolved
          → × co2e_per_kg (userfield)
     Σ = opskrift-CO₂ pr. base_servings
  → skriv recipes.Co2e (denormaliseret CACHE, genberegnes ved opskriftsændring)

Ved bon-oprettelse (samme mønster som cost_price):
  bon_lines.co2e  = frosset snapshot af faktor × mængde   (autoritativ, ændres aldrig bagud)
  bons.total_co2e = Σ(bon_lines.co2e)                      (evt. denormaliseret cache)
```

- **Producerede varer (`co2e_source = 'computed'`)** — `co2-f5-compute.js` skriver en
  kg-faktor på varen en opskrift producerer: **opskriftens samlede CO₂ ÷ udbyttet i kg**
  (`recipeunitnumber × base_servings`, omregnet via `shared/recipe_yield` → lager-enhed →
  kg). Reglen bor i `co2Engine.computedProductFactors`. Opskriften pr. vare er den samme
  som motoren ruller i (`producedBy`, laveste id). Kun tom kilde eller `computed` skrives —
  aldrig `klimadb`/`material`/`supplier`/`manual`/`na`. Tidligere blev CO₂ pr. *portion*
  skrevet uden division, så Chili Mayo (1,1 kg pr. portion) fik 3,3613 i stedet for
  3,0557 (#663).
- **Natlig kørsel.** `co2-f5-compute.js --apply` står i serverens crontab efter
  kostpris-jobbet, så `recipes.Co2e` følger med når en opskrift, en faktor eller et
  udbytte rettes — uden at nogen skal huske det:
  `15 3 * * * cd /home/leif/bon-v2 && node scripts/co2-f5-compute.js --location=hq --apply >> logs/co2.log 2>&1`
  Kun forskelle skrives (`co2Engine.recipeCacheUpdates`), og loggen viser hver ændring
  med før → efter, eller "0 ændret". Opskrifter uden ingredienser får aldrig et 0, og en
  opskrift der er blevet ufuldstændig beholder sit tal og nævnes som advarsel.
- **`computed` er en cache, ikke en kilde.** Kan motoren rulle ned i den producerende
  opskrift, ignorerer den varens `computed`-faktor og regner live — ellers ville en ændret
  opskrift holde fast i et gammelt tal til næste F5-kørsel. Cachen bruges kun når udbyttet
  ikke kan bestemmes.
- **`recipes.Co2e` er kun visnings-cache**, ikke kilde. Autoritativ værdi = frosset `bon_lines.co2e`.
- Frys-på-bon beskytter historik når CONCITO opdaterer faktorer (v1.1→v1.2 ændrede flere tal).
- Motoren har **én regel**: `mængde → kg × faktor`. Emballage adskiller sig kun ved at have en vægt-konvertering, ikke ved en særregel.

---

## 8. Import-loop + Ra-ID/materiale-tildeler

### Import (idempotent, et par gange om året)
```
CONCITO v1.2 Excel  (+ Katrines ark som v1.1-seed)
   → for hvert Grocy-produkt med co2e_klima_id: slå Ra-ID op → opdatér co2e_per_kg + co2e_version
   → producér diff-rapport: matched / ny / ændret / umatchet / fjernet
```

### Tildeler (genbrug eksisterende scraper-kode)
Den tilbagevendende opgave er at give **nye varer** et Ra-ID. Genbrug fra `horkram-scraper`:
- `tokenScore` — normaliseret token-match (håndterer æ/ø/å allerede)
- `findBestGrocyMatch` — vendt om: match Grocy-produktnavn mod CONCITOs ~540 navne, filtrér på kostklasse
- `prepareBulkLink` / `confClass` — konfidens-tærskler (0.35/0.6) + bulk-bekræft-UI

Tre lag, faldende sikkerhed:

| Lag | Mekanik | Dækker |
|-----|---------|--------|
| 1. SKU-bro | Hørkram-varenr (i `product_barcodes`) → husket Ra-ID fra tidligere tildelinger | Gengangere |
| 2. Navne-forslag | fuzzy match mod CONCITO, filtreret på kostklasse | Nye fødevarer → "bekræft forslag" |
| 3. Manuel | resten | Sjældent |

Hver bekræftelse skriver Ra-ID permanent → manuel bunke skrumper over tid. Samme UI bruges til `co2e_material`-tildeling for emballage.

Eksisterende userfield-skrivning genbruges fra `products-editor` (`updateUserfield` → `/api/userfields/{entity}/{id}`).

---

## 9. Audit + plausibilitet (go/no-go + "mistænkelig")

Script kører over alle opskrift-ingredienser. Mål: **0 manglende kg-veje.** Det er konsistens-garantien for *både* CO₂ og kostpris (de deler kg-konverteringen).

Kerne-SQL (kg-vej findes?):
```sql
-- ingrediens uden vej til Kilo/Gram = blocker
SELECT p.id, p.name, p.qu_id_stock
FROM products p
WHERE p.id IN (SELECT DISTINCT product_id FROM recipes_pos)
  AND p.qu_id_stock NOT IN (4,5)              -- ikke allerede kg/gram
  AND NOT EXISTS (
    SELECT 1 FROM cache__quantity_unit_conversions_resolved cc
    WHERE cc.product_id = p.id
      AND cc.from_qu_id = p.qu_id_stock
      AND cc.to_qu_id IN (4,5)
  );
```

Overblikket er ikke "mangler/sat" men **mangler / sat / mistænkelig**:

| Tjek | Flag hvis |
|------|-----------|
| Densitet | uden for 0,4–1,5 kg/L |
| Vægt pr. stk | uden for fornuftigt interval pr. produktgruppe |
| `co2e_per_kg` | uden for 0,1–40 (fanger "22'eren") |
| **Pris-mismatch** | `average_price` afviger > faktor 2 fra `supplier_price_per_kg × kg-vej` → sandsynligt enheds-mismatch |

CO₂-datakvalitet-overblik (Office/Settings): én række pr. vare — `grocy_product_id (koblet?)` · klasse · `kg-vej OK?` · `co2e_per_kg` · kilde · Ra-ID/materiale · version · status.

---

## 10. Pris vs CO₂ — enhedsdisciplin (KRITISK)

To fuldstændig adskilte prisverdener i Bon v2 i dag:

| | Salgspris (menupris til kunden) | Kostpris (intern) |
|---|--------------------------------|-------------------|
| Felt | `bon_lines.unit_price` → `line_total` → `bons.total_price` | `bon_lines.cost_price` |
| Kilde | `item_prices` pr. `price_category` — **Ristet Rug sætter den** | Grocy `cache__products_average_price` via adapter |
| Grocy? | **Nej** | Ja (kun til dækningsbidrag/analyse) |
| Moms | inkl. moms-userfields findes i Grocy, men bruges IKKE her | `average_price` = **ekskl. moms** |

Regler der skal stå eksplicit i koden:

1. **Menuprisen til kunden afledes ALDRIG af Grocy-priser.** Den kommer fra `item_prices`. Et forkert kg-tal i Grocy kan ikke vælte kundens menupris.
2. **Kostpris læses fra `average_price` i QU_stock-enhed.** Den er ekskl. moms → går direkte i `bon_lines.cost_price`, **ingen moms-konvertering** i adapteren.
3. **Userfields er ALDRIG beregningsinput.** `supplier_price_per_kg` er pr. kg reference; salgspris-userfields er inkl. moms. At bruge dem som kost ville blande enheder og moms-grundlag.
4. **Moms-afstemning** sker i Bon's økonomi-/rapportlag, ikke i snapshottet.
5. **CO₂ er momsneutralt** og deler kun kg-konverteringen med kostpris → ét fejlpunkt, ét audit.

> NB: `qu_id_price ≠ qu_id_stock` flere steder (Brød Rug price=Kasse/stock=Kilo; Servietter price=Pakke/stock=Antal). Grocy håndterer det *hvis* konverteringen findes — endnu en grund til at audit (§9) skal være grøn.

---

## 11. ESG-eksport-hook (ikke rapportgenerator)

Bon v2 dumper kun de tal det ejer; layout i Canva/Affinity. Mål mod **VSME** (EFRAG, frivillig SMV-standard, basismodul B1–B11).

| VSME | Bon v2 ejer? | Kilde i Bon v2 |
|------|--------------|----------------|
| B3 — CO₂e mad (scope 3) | ✅ | Σ `bon_lines.co2e` pr. år |
| B3 — transport-CO₂ | ✅ | `bons.delivery_method` (bike/taxi/volvo) + km + faktor pr. km |
| B7 — emballage/affald | ✅ | Σ(emballage-stk × kg/stk) |
| Øko-% | ✅ bonus | `Oeko` pr. ingrediens (122/215 sat) — vægtet andel |
| B3 — el/varme/gas, B8–B10 personale, B1/B2/B11 governance | ❌ | Klimakompasset / Smartplan / manuelt |

Transport-faktor pr. km (`delivery_vehicles`) er **Bon v2-data, ikke Grocy** — cykel ≈ 0, el-taxa lav, Volvo diesel høj.

Stærke afledte tal: **CO₂ pr. kuvert + YoY-trend** (VSME kræver sammenligning med foregående år); **CO₂ på følgeseddel/bon** ("denne levering: X kg CO₂e · Y% øko · leveret på cykel") som B2B-differentiator i portalen.

---

## 12. Implementeringsrækkefølge + verifikation

| # | Skridt | Verifikation |
|---|--------|--------------|
| 0 | Audit-script (§9) | Kører, rapporterer 32 manglende kg-veje som baseline |
| 1 | Opret userfields (§2), deprecér `Co2e`→`Co2e_OLD` | `/api/userfields` viser de 5 nye; intet kald læser `Co2e` |
| 2 | Db-rettelser (§4): 6 fejl + ~14 densiteter + ~33 vægte | Audit → 0 manglende kg-veje (drikkevarer/emballage = na/material, ikke "mangler") |
| 3 | Materiale-faktortabel + `co2e_material`-tildeler (§6,§8) | Alle emballagevarer har materiale + resolvet `co2e_per_kg` |
| 4 | CONCITO-import + Ra-ID-tildeler (§8) | Diff-rapport; fødevarer har `co2e_klima_id` + `source=klimadb` |
| 5 | Motor (§7) | `recipes.Co2e` genberegnet; stikprøve mod Katrines ark |
| 6 | Bon-snapshot: `bon_lines.co2e` + `bons.total_co2e` | Ny bon fryser co2e; ændret faktor rører ikke gammel bon |
| 7 | CO₂-overblik m. "mistænkelig"-tilstand (§9) | Røde/gule rækker vises korrekt |
| 8 | ESG-eksport-hook (§11) | Dumper mad-CO₂ + transport + emballagemasse + øko-% for et år |

Intake-UI (§3) bygges ind i `opret-produkt` parallelt fra skridt 2.

---

## 13. Åbne punkter

| Punkt | Status |
|-------|--------|
| Materialefaktorer (kg CO₂e/kg) | Katrine/bror udfylder fra Klimakompasset |
| Materialeliste vs faktisk emballagesortiment | Verificér de 8 startmaterialer dækker alt |
| Drikkevarer (5 stk): faktor pr. stk vs pr. L | Afklares når sporet rammes |
| Transport-CO₂ faktorer pr. km | Sæt på `delivery_vehicles` (cykel/taxa/volvo) |
| `supplier_price_per_kg` moms-grundlag | Irrelevant så længe userfields aldrig beregnes — men noteret |
