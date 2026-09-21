# CLAUDE_OPSKRIFT_DESIGNER.md

**Version:** v0.4
**Status:** Udkast til gennemlæsning — designbeslutninger truffet 20.09.2026

**Ændringer fra v0.3:** Startskærmen følger de eksisterende indgange — Tilpas og Ny,
plus Importér (§4.1). Produktionsvisningen under Opskrifter er eksplicit uden for
scope (§1).

**Ændringer fra v0.2:** Importnoten i beskrivelsesfeltet markeres, så parseren kan
skelne den (R9.5). Gem bruger den fælles writer fra importspecen (§12). Afstemt med
`CLAUDE_OPSKRIFT_IMPORT.md` v0.2 og oversættelsestillæg v0.6.

**Ændringer fra v0.1:** Tilføj-blokken samlet nederst med sektionsvælger (§4.4);
"Flyt til sektion" i ⋯ (§6.2); udfoldningspilen flyttet ind i badget (§6.3);
dæmpet visning og gennemgangspanel ved 4+ uafklarede linjer (§8.3–8.4);
Pris & avance i overblikket (§10.2); "Kilde og antagelser" vises kun ved import (§15).
**Dato:** september 2026
**Mockup:** https://claude.ai/artifact/NtjtEsvxYeaqKULswxxKVb
(A portionsopskrift · B produktionsopskrift · C tilføj-popup · D mobil · E importeret tilstand)
**Hænger sammen med:** `CLAUDE_OPSKRIFT_IMPORT.md`, `CLAUDE_OPSKRIFT_IMPORT_OVERSAETTELSE.md`, `CLAUDE_HURTIG_PRODUKTION.md`

---

## 1. Formål og afgrænsning

Opskrift-designeren bygges om, så **den samme editor bruges af både designeren og
importeren**. Importeren er en parser, der fylder editoren; den får ingen egen
brugerflade til gennemsyn og godkendelse.

Målet med editoren:

1. Hurtigt bygge en ny opskrift af varer og eksisterende opskrifter
2. Kunne lægge nye varer ind undervejs med mængde, pris og CO₂, så beregningen
   kan laves før varen findes i Grocy
3. Vise hvad opskriften giver, vejer, koster og udleder — mens man skriver
4. Beskrive fremgangsmåden i trin med valgfri tid

**Uden for scope: produktionsvisningen.** Visningen under fanen Opskrifter (f.eks.
"Tunen" med portioner, lager og "Træk fra lager") er den, køkkenet producerer efter.
Den er simpel og skal forblive det — den ændres ikke af denne spec. Designeren er
alene de skærme, man når via fanen Designer.

**Uden for v1:** næringsberegning, allergener, versionshistorik på opskrifter,
tidsforbrug som planlægningsdata (se §9.4).

---

## 2. Invarianter

| # | Invariant |
|---|---|
| I1 | **Grocy er sandheden.** Editoren opretter og skriver til Grocy; Bon får ingen ny tabel i v1 |
| I2 | **Bon annoterer, men transformerer ikke.** Står linjen som `1,1 kg` i Grocy, vises `1,1 kg (+10 % rensesvind)` — aldrig et tilbageregnet tal |
| I3 | **Ukendt er ikke nul.** Mangler en linje pris eller CO₂, vises summen som `≥ x` og aldrig som et færdigt tal |
| I4 | **Gem uden ændringer skriver ingenting.** Værnet fra #680 gælder uændret |
| I5 | **Enheden bestemmes af varen, ikke af opskriften** (oversættelsesspec §3) |

---

## 3. Datamodel — hvad ligger hvor

Ingen nye tabeller i Bon. Alt lagres i Grocy.

| Begreb i editoren | Lagres som |
|---|---|
| Navn, gruppe | Opskriftens navn og gruppefelt |
| "1 portion er [x] [enhed]" | Opskriftens portionsenhed-felter (`recipeunitnumber` / `recipeunit`) |
| "Giver [n] portioner" | `base_servings` |
| Produceret vare | Opskriftens `product_id` |
| Målvægt | Userfield på opskriften (nyt, jf. oversættelsesspec §6.1) |
| Ingredienslinje | Række i opskriftens positionstabel |
| Sektion | `ingredient_group` på linjen |
| Nesting | Nestings-tabellen (kun hvor underopskriften ikke har en vare) |
| Fremgangsmåde + tid | Opskriftens ene beskrivelsesfelt, serialiseret (§9) |
| Ny vare | Oprettes som produkt i Grocy **ved gem** |

> Feltnavnene ovenfor skal verificeres mod den kørende instans før implementering, jf. §17.

---

## 4. Skærmen

### 4.1 Startskærm

Tre kort. Tilpas og Ny findes i dag; Importér kommer med importeren.

| Kort | Gør |
|---|---|
| Tilpas opskrift | Den eksisterende liste "Vælg opskrift" (søgning + gruppefiltre) → editoren med opskriften indlæst |
| Ny opskrift | Tom editor |
| Importér | Indsæt tekst/URL/fil → parser fylder editoren |

**Samme editor, samme udtryk** i alle tre. Forskellen er kun, hvad der er indlæst, og
hvad bundlinjen tilbyder:

| Indgang | Status-pill | Bundlinje |
|---|---|---|
| Tilpas | `TILPASNING` + "Baseret på: …" | `Gem n ændringer` (overskriver) · `Gem som ny` (kopi) · Kassér |
| Ny | `NY OPSKRIFT` | `Gem` · Kassér |
| Importér | `IMPORTERET` | `Gem` · Kassér — blokeret så længe en linje mangler enhed |

Listen "Vælg opskrift" genbruges uændret.

### 4.2 Editorens rækkefølge (artboard A)

```
Navn · gruppe · status-pill
Udbyttesætning · målvægt · [evt. produceret vare]
Ingrediensliste i sektioner
Fremgangsmåde i trin
```

Fast overblikspanel i højre side (desktop) eller som bundbjælke (mobil).

### 4.4 Tilføj-blokken

Alle nye linjer tilføjes ét sted: en blok nederst i listen med søgefelt og
sektionsvælger — "Søg vare, opskrift — eller opret ny … **i** [Dressing ▾]".

| Regel | |
|---|---|
| R4.1 | Ingen tilføj-knap i sektionsoverskrifterne. Listen skal kunne læses som en opskrift |
| R4.2 | Sektionsvælgeren forvælges til den sektion, brugeren sidst rørte |
| R4.3 | Sidste punkt i sektionslisten er "+ Ny sektion …" |
| R4.4 | En linje flyttes bagefter via ⋯ → "Flyt til sektion ▸" |

### 4.3 Udgår fra dagens designer

| Element | Begrundelse |
|---|---|
| "Base antal" som selvstændigt felt | Indgår i udbyttesætningen |
| Stepperen "Mængde − 1 +" over listen | Skalering hører til køkkenets visning |
| Sektionen "Underopskrifter" | Erstattet af ét søgefelt |
| Vis-pillerne som beregningsvælger | Bliver kolonnevælger; nøgletallene står fast i overblikket |
| Lagerstatus som linjefarve | Bliver en kolonne, slået fra som standard |

---

## 5. Udbyttesætningen

```
1 portion er [ 1,1 ] [ kg ▾ ] af [ Chili Mayo ▾ ]     Giver [ 1 ] portioner
1 portion er [ 1   ] [ stk ▾ ]                        Giver [ 30 ] portioner    (Løvstikke-pakker)
1 portion er [ 1   ] [ stk ▾ ]  Målvægt [ 350 ] g     Giver [ 1 ] portion       (Falaflen)
```

| Regel | |
|---|---|
| R5.1 | Antallet er frit. 1 kg og 1 stk er konventioner, ikke regler |
| R5.2 | Enhedslisten viser **kun** varens lagerenheder, når en vare er valgt. Udbytte og vare kan ikke modsige hinanden |
| R5.3 | Uden valgt vare producerer opskriften intet. Der vises en dæmpet linje: "Opskriften lægger ingen vare på lageret. **Skal den det?**" |
| R5.4 | Vælges en vare, vises den som chip med mulighed for at skifte eller fjerne |
| R5.5 | Målvægt er valgfri og gælder mad alene — emballage tæller ikke med |
| R5.6 | Hurtigvalg for målvægt (Salatskål 350 g, …) udfylder feltet; skåltypen gemmes ikke |

---

## 6. Ingredienslinjer

### 6.1 Søgefeltet (artboard C)

Ét felt, resultaterne grupperet:

| Gruppe | Ved valg |
|---|---|
| Varer | Almindelig linje |
| Halvfabrikata (opskrifter der lægger en vare på lager) | Linje på **varen**, badge `HALVFABRIKAT` |
| Opskrifter uden vare | Nesting, badge `NESTING` |
| `+ Ny vare "<søgeord>"` | Uafklaret linje, badge `NY VARE` (§8) |

Brugeren vælger aldrig mellem "ingrediens" og "underopskrift". Systemet afgør det
efter #270-reglen: *har underopskriften en vare, så brug varen.*

### 6.2 Kolonner

Faste kolonner: status · produkt · mængde · enhed · gram · kostpris · CO₂e · ⋯

| Regel | |
|---|---|
| R6.1 | Handlinger ligger altid i ⋯ (Erstat, Flyt til sektion ▸, Sæt svind, Åbn opskrift, Fjern). En linje må ikke skifte form |
| R6.2 | Steppere kun for stk-enheder. Vægt og volumen får et talfelt med `inputmode="decimal"` |
| R6.3 | Statusprikken betyder **afklaret / ikke afklaret** — ikke lagerstatus |
| R6.4 | Enhedsnavne normaliseres i visningen: stk, g, kg, ml, l |
| R6.5 | Svind vises som annotation efter navnet: "+10 % rensesvind medregnet". Mængden er uberørt (I2) |

### 6.3 Udfoldning

Halvfabrikata og nestings kan foldes ud på stedet:

- Udfoldningen sidder **i badget** ("HALVFABRIKAT ▸"), ikke foran navnet, så alle
  produktnavne flugter i samme kolonne. Trykfeltet er hele navn + badge, mindst 44 px
- Almindelige varelinjer har ingen chevron og er ikke trykbare
- Linjerne skaleres til den mængde, der bruges (20 g af en 1 kg-opskrift)
- Linjerne er **skrivebeskyttede** — man redigerer via "Åbn opskrift →"
- Skaleringen bruger den eksisterende `recipe_yield.js` / `recipeCost.js`; der laves ingen ny regel

---

## 7. Sektioner

| Regel | |
|---|---|
| R7.1 | Sektion = `ingredient_group` på linjen. Ingen ny lagring |
| R7.2 | "+ Ny sektion" opretter frit; sektioner kan omdøbes, flyttes og slettes (linjer flytter med) |
| R7.3 | Skabelon pr. opskriftsgruppe foreslås ved ny opskrift, f.eks. `01 Sandwich` → Brød, Fyld, Dressing, Grønt, Emballage |
| R7.4 | Skabelonen foreslår — den tvinger ikke. Sammenlignelighed kommer af, at forslaget er det samme |
| R7.5 | **Emballage identificeres på varegruppen**, ikke på sektionsnavnet, så madvægten ikke ødelægges af en omdøbt sektion |
| R7.6 | Linjer uden sektion vises øverst uden overskrift |

---

## 8. Uafklarede linjer og nye varer

En uafklaret linje er en linje, der ikke peger på en eksisterende Grocy-vare.
Det gælder både designerens "+ Ny vare" og importerens gaps (G1–G6).

| Felt | Krav |
|---|---|
| Navn | Påkrævet |
| Mængde | Påkrævet |
| Enhed (`QU stock`) | Påkrævet før gem — uden den kan linjen ikke omregnes (oversættelsesspec §3) |
| Pris pr. enhed | Valgfri |
| CO₂e pr. enhed | Valgfri |
| Varegruppe | Valgfri, default fra sektionen |

| Regel | |
|---|---|
| R8.1 | Linjen vises med stiplet kant og åben statusprik |
| R8.2 | Manglende pris/CO₂ gør overbliksberegningen til et mindstetal (I3) |
| R8.3 | Varen oprettes i Grocy **ved gem** — ikke mens man skriver |
| R8.4 | Gem blokeres, hvis en linje mangler enhed. Alt andet må gemmes |
| R8.5 | Ved gem oprettes varer først, derefter opskriften. Fejler en vareoprettelse, gemmes intet |

### 8.3 Visning skalerer med antallet

| Antal uafklarede | Visning |
|---|---|
| 1–3 | Gul række med stiplet kant — det er undtagelsen |
| 4+ | Dæmpet: åben statusprik, tynd okker kant i venstre side, kort besked på linjen ("mangler enhed"). Ingen gul flade |

Ved 1+ uafklaret vises et bånd over listen: "n linjer skal afklares", delt i dem
der **blokerer gem** (manglende enhed) og dem der kun gør tallene til mindstetal.
Båndet har "Vis kun uafklarede" og "Gennemgå ›".

### 8.4 Gennemgang

Gennemgangspanelet tager linjerne én ad gangen i listens rækkefølge:

| Element | |
|---|---|
| Kildens tekst | Rå linje fra importen, plus hvorfor den ikke matchede |
| Vælg eksisterende vare | Åbner søgningen fra §6.1 |
| Opret som ny vare | Lagerenhed (påkrævet), pris, CO₂ |
| Slet linjen | |
| Spring over / Næste › | Gennemgangen kan forlades når som helst; listen kan altid redigeres frit |

Sortering: manglende enhed før manglende pris og CO₂, fordi enheden blokerer gem.

---

## 9. Fremgangsmåde

### 9.1 Visning

Trin med nummer, tekstfelt og valgfrit tidsfelt. "+ Tilføj trin" nederst.

### 9.2 Serialisering

Grocy har ét beskrivelsesfelt. Trinnene skrives som nummereret tekst:

```
1. Rist brødet og smør tahin på begge halvdele [4 min]
2. Fyld: falaffel, rødløg, grønt — yoghurtdressing til sidst [2 min]
```

### 9.3 Parser

| Regel | |
|---|---|
| R9.1 | Parseren er tolerant: `n.` eller `n)` i linjestart, tid i klammer sidst på linjen |
| R9.2 | Kan feltet ikke parses til trin, vises det som **ét råt tekstfelt**. Ingen data går tabt, hvis nogen skriver i Grocy |
| R9.3 | Feltet skrives kun, hvis trinnene er ændret (I4) |
| R9.4 | "Vis rå tekst" er altid tilgængelig og viser præcis det, der gemmes |
| R9.5 | En afsluttende blok, der starter med linjen `Importnote:`, er ikke fremgangsmåde. Den vises i panelet "Kilde og antagelser" og skrives uændret tilbage efter trinnene |

### 9.4 Tid

Tiden bor i klammerne i v1. Skal den bruges til planlægning (kapacitet,
bemanding), kræver det en tabel i Bon — **udskudt**, besluttet 20.09.2026.

---

## 10. Overblikket

| Tal | Beregning |
|---|---|
| Mad | Sum af linjer, hvis varegruppe ikke er emballage |
| Emballage | Sum af emballagelinjer, vist separat |
| Målvægt-bjælke | Mad / målvægt i procent, kun hvis målvægt er sat |
| Batchvægt | Sum af alle linjer (produktion) |
| Udbytte / udbytteandel | Deklareret udbytte og udbytte ÷ batchvægt |
| Kostpris, CO₂e | Pr. portion og i alt. `≥` når en linje mangler værdi (I3) |
| DB | Salgspris − kostpris, `≤` når kostprisen er et mindstetal |
| Pr. portion | Vægt, kostpris, CO₂ — sanity check ("33 g pr. portion") |

Under tallene: antal uafklarede linjer med en linje om konsekvensen.

### 10.2 Pris & avance

Dagens målsætningsstruktur bevares som egen blok under overblikket:

| Element | |
|---|---|
| Mål-dækningsbidrag | Slider, default fra Settings |
| Vareomkostning | Råvarer + emballage, `≥` når en linje mangler pris |
| Foreslået menupris | Beregnet af mål-DB |
| Faktisk pris | Prisliste-vælger (catering m.fl.) |
| Status | "Nuværende pris giver ≥ x % DB — over/under målet" |

| Regel | |
|---|---|
| R10.1 | Alle beregninger ex moms, jf. moms-doktrinen i `BON_V2_PRINCIPPER.md` |
| R10.2 | `≥`-reglen (I3) gælder også DB og avance — et manglende tal må ikke få avancen til at se bedre ud |
| R10.3 | Målvægt og mål-DB er to mål af samme slags: mål, faktisk værdi, afstand. De vises ens |
| R10.4 | Flere skåltyper/målvægte kommer som hurtigvalg ved målvægtsfeltet, ikke som ny blok |

---

## 11. Responsivt

| Bredde | Layout |
|---|---|
| ≥ 1100 px | To kolonner: liste + fast overbliksppanel |
| 700–1100 px (iPad) | Én kolonne; overblikket bliver et vandret bånd under udbyttesætningen |
| < 700 px (mobil, artboard D) | Kort pr. linje, sektioner som labels, faner (Ingredienser / Fremgangsmåde / Opskrift), overblik som fast bundbjælke der kan foldes ud |

| Regel | |
|---|---|
| R11.1 | Touch-mål ≥ 44 px på mobil |
| R11.2 | Gram/kr/CO₂ flyttes ned som én metalinje under produktnavnet |
| R11.3 | Gem-knappen er altid synlig i bundbjælken |

---

## 12. Gem

1. Diff mod den indlæste tilstand — felt for felt, linje for linje
2. Ingen ændringer → ingen skrivninger (I4)
3. Nye varer oprettes først
4. Opskrift, linjer og nestings skrives derefter
5. Bundlinjen viser antal ændringer og "n nye varer oprettes i Grocy ved gem"

Skridt 3–4 udføres af den **fælles writer** (`services/recipeWriter.js`,
importspec §4.5) — den samme som importen bruger. Writeren verificerer hver oprettet
vare ved at læse den tilbage og logger oprettede id'er, så en fejl midtvejs kan
fortrydes. I designeren lever loggen kun under selve gem-kaldet; ved import lander den
i `import_plan_item`. Designeren får dermed ingen ny tabel (I1).

---

## 13. Endpoints

| Metode | Sti | Formål |
|---|---|---|
| GET | `/api/opskrifter/:id/editor` | Editorens tilstand (opskrift, linjer, sektioner, trin, afledte tal) |
| GET | `/api/opskrifter/soeg?q=` | Grupperet søgning: varer, halvfabrikata, opskrifter uden vare |
| POST | `/api/opskrifter/beregn` | Overbliksberegning på en ugemt tilstand (inkl. uafklarede linjer) |
| POST | `/api/opskrifter/:id/gem` | Diff + skriv (varer → opskrift) |
| POST | `/api/opskrifter/ny` | Gem som ny |
| GET | `/api/opskrifter/sektionsskabelon?gruppe=` | Foreslåede sektioner |

Bemærk: `/editor` og `/beregn` deler serialiseringsformat — det er det samme objekt,
importeren leverer (§15).

---

## 14. Filer

| Fil | Indhold |
|---|---|
| `shared/recipe_designer.js` | Omskrives til editoren |
| `shared/recipe_designer.css` | Tokens, ingen nye farver uden for designsystemet |
| `shared/recipe_lines.js` | Linjemodellen: type, badge, kolonner, udfoldning |
| `shared/recipe_steps.js` | Serialisering og parsing af fremgangsmåden |
| `services/recipeCost.js`, `shared/recipe_yield.js` | Genbruges, udvides ikke med nye skaleringsregler |
| `services/recipeWriter.js` | Fælles writer for designer og import: varer → omregninger → userfields → opskrift → linjer, med verifikation |

---

## 15. Importeren bruger samme editor

Importeren leverer **editorens tilstandsobjekt** og intet andet:

| Importerens output | Editorens felt |
|---|---|
| Kildens portionsantal | `base_servings` i udbyttesætningen |
| Type og målvægt (oversættelsesspec §6) | Målvægtsfeltet |
| Linje med match | Almindelig linje |
| Gap G1–G6 | Uafklaret linje (§8) |
| Svindantagelse | Annotation på linjen (I2) |
| Importnote (§9 i oversættelsesspecen) | Panelet "Kilde og antagelser" i sidepanelet — **vises kun når det har indhold**, dvs. efter import |
| Omregninger (husholdningsmål, svind) | Annotation på linjen, der bliver stående efter afklaring ("kilde: 3 spsk · omregnet 41 g") |

Gennemsyn og gem sker i editoren. Importeren har ingen egen gem-sti.

**Skal rettes i de eksisterende specs:**

1. ✅ `CLAUDE_OPSKRIFT_IMPORT_OVERSAETTELSE.md` §6 og §6.1: de tre typer
   (Produktion/Skål/Styk) erstattes af "producerer vare ja/nej + valgfri målvægt".
   Skål bliver et hurtigvalg for målvægt
2. ✅ `CLAUDE_OPSKRIFT_IMPORT.md` §4.6: gennemsyn sker i denne editor
3. ✅ Rettet i `CLAUDE_OPSKRIFT_IMPORT.md` v0.2 og tillæg v0.6: importeren opretter ikke
   varer selv; editorens Gem udløser den fælles writer

---

## 16. Testtilfælde

| # | Test |
|---|---|
| T1 | Indlæs + gem uden ændringer → **nul** skrivninger, byte-identisk fingeraftryk (#680-værnet) |
| T2 | Halvfabrikat vælges → linje lægges på varen, ikke som nesting |
| T3 | Opskrift uden vare vælges → nesting oprettes |
| T4 | Ny vare uden enhed → gem blokeres med besked på linjen |
| T5 | Ny vare uden pris → kostpris vises som `≥`, aldrig som færdigt tal |
| T6 | Vareoprettelse fejler → hverken vare eller opskrift gemmes |
| T7 | Trin serialiseres og parses tilbage → samme trin og tider |
| T8 | Beskrivelsesfelt med fritekst fra Grocy → vises råt, ændres ikke ved gem |
| T9 | Emballagelinje → tæller i kostpris og CO₂, ikke i madvægt |
| T10 | Udbytte 30 stk af 1 kg batch → 33 g pr. portion i overblikket |
| T11 | Sektion omdøbes → linjer beholder deres `ingredient_group`-værdi konsistent |
| T12 | Importeret tilstand → samme gem-sti som designeren |
| T13 | 4+ uafklarede linjer → dæmpet visning, ikke gul flade |
| T14 | Gennemgang sorterer manglende enhed før manglende pris |
| T15 | "Flyt til sektion" ændrer kun `ingredient_group`, intet andet |
| T16 | Ingen importnote → "Kilde og antagelser" renderes ikke |
| T17 | Beskrivelse med trin + `Importnote:`-blok → trin parses, noten bevares uændret ved gem |
| T18 | Writer fejler på vare 2 af 3 → vare 1 fortrydes via loggen, opskriften skrives ikke |

Kører som `npm run test:designer` mod `grocytest` med ZZT_-fixtures og teardown.

---

## 17. Verificér før implementering

```bash
# Felter på opskriften: portionsenhed, produceret vare, base_servings
grep -rn "recipeunit\|base_servings\|product_id" services/ shared/ | grep -i recipe

# Har opskriftslinjen ingredient_group i denne instans?
grep -rn "ingredient_group" .

# Nestings — omfang i drift (#270 udfaser dem)
grep -rn "nesting" services/ shared/

# Eksisterende skalering og kostpris — skal genbruges, ikke genopfindes
grep -rn "recipe_yield\|recipeCost" .

# Gem-værnet fra #680
grep -rn "test:designer-gem\|snapshot:opskrifter" package.json

# Varegruppe for emballage — hvad hedder den?
grep -rn "emballage" services/ shared/
```

Bekræft desuden i Grocy-instansen: findes userfield til målvægt, eller skal det oprettes?

---

## 17b. Status — hvad er bygget (21. september 2026)

| Del | Fil | Status |
|---|---|---|
| Søgningen (§6.1) | `services/recipeSearch.js` + `GET /api/opskrifter/soeg` | ✅ |
| Linjemodellen (§14) | `shared/recipe_lines.js` | ✅ |
| Sektionsskabelon (§7.3) | `RecipeLines.sectionTemplate` + `GET /sektionsskabelon` | ✅ |
| Editoren (§4–§12) | `shared/recipe_editor.{js,css}` | ✅ |
| Fremgangsmåden (§9) | `shared/recipe_steps.js` | ✅ |
| Kladde + beregning (§13) | `services/recipeDraft.js` | ✅ |
| Gem (§12) | `services/recipeWriter.js` + `shared/recipe_diff.js` | ✅ |
| Startskærm + picker (§4.1) | `shared/recipe_designer.js` | genbrugt uændret |

**Tests:** `test:opskrift-soeg` (75) · `test:opskrift-visning` (108) ·
`test:opskrift-kladde` (66) · `test:opskrift-linjer` (48) · `test:opskrift-trin` (74) ·
`test:opskrift-writer` (40) · `test:designer-gem` (73 + 6).

### Beslutninger truffet under implementeringen

| # | Valg | Hvorfor |
|---|---|---|
| B1 | **#270-reglen afgøres på SERVEREN** (`recipeSearch` + `producer_recipe_id` fra `/beregn`) | En gemt opskrift bærer intet «halvfabrikat»-mærke — i Grocy ER det bare en varelinje. Skulle browseren udlede det, ville den have en anden kopi af reglen end kostprisen (#558) |
| B2 | **En produceret vare står KUN under halvfabrikata**, aldrig også under varer | Ellers to knapper der gør præcis det samme — og §6.1 siger at valget er systemets |
| B3 | **Varen kan findes på sit eget navn**, ikke kun hvis opskriften hedder det samme | «Slider Brød» laves af «Skære Slider Brød» |
| B4 | **Emballage (R7.5) afgøres af serveren** (`is_packaging` pr. linje fra `/beregn`) | Samme gennemgang som madvægten. Browseren har ingen kopi af `co2Materials`-listen, så reglen kan ikke skride ét sted uden at skride begge |
| B5 | **Enheden kommer fra `/beregn`**, ikke fra et opslag i browseren | Etiketten skal komme samme sted fra som tallet |
| B6 | **Sektionsskabelonen UDLEDES af driften** (+ `settings.recipe_section_templates` som overstyring) | Målt: 7 af 7 slidere bruger «Emballage», resten har ingen sektioner. En hårdkodet liste ville foreslå noget køkkenet ikke gør (løser Å2) |
| B7 | **Mængden vises i LAGER-enhed** (0,0571 kg, ikke 57 g) | Det er dét tallet ER. Gram-kolonnen står ved siden af og er til at læse. At regne om i det redigerbare felt er præcis #352's fejl |
| B8 | **Udfoldningen (§6.3) er SKALERET til det linjen bruger — og serveren regner faktoren** (`GET /api/opskrifter/:id/indhold`) | Faktoren er ikke en ny regel: nesting = `portioner / base_servings` (`recipeCost.compute`), halvfabrikat = `mængde / udbytte-i-lager-enhed` (`lineUnitCost` → `RecipeYield.yieldInStockUnits`). Regnet forfra i browseren ville den kunne skride fra lagertrækket. Kan faktoren ikke bestemmes (#372), står opskriftens EGNE tal med grunden — aldrig et gæt (I3) |
| B8b | **Ændrer man linjens antal, markeres en åben udfoldning forældet med det samme** og hentes igen | Dens tal ER skaleret med netop det antal. Et tal der stille bliver forkert er værre end et der siger det er på vej |
| B8c | **Udfoldningens mængder vises i gram og ml** (`quConvert.autoFormatAmount`, på serveren) | 0,0081 kg er ulæseligt og bredt. Lager-enheden står uberørt ved siden af (`display_*`) — den er dét kostprisen og lagertrækket regner i (B7) |
| B10 | **Badget står INDE i navnet** som `inline-block`, ikke som flex-søskende | Så flyder det efter teksten som et ord mere. Ved siden af lagde det sig lodret hen over et to-linjers navn, og en fast kolonne pressede navnet ned i to linjer |
| B12 | **En nesting måles i opskriftens EGEN enhed** når «1 portion er 1 antal» — ellers i portioner | Køkkenet tæller i stk og kg, ikke i portioner. Er forholdet ikke 1:1, ville enheden lyve om tallet i feltet; så bliver vi ved «portion». Ren VISNING — `servings` gemmes uændret (#352) |
| B13 | **Mobil: tal-cellerne ligger i `.re-nums`** med `display: contents` på brede skærme | To grid-celler kan ikke dele én celle. Beholderen er ingen boks på desktop (gridet er uændret) og bliver ét felt på mobil — ÉN rendering-vej, ikke to der kan drive |
| B11 | **Editoren får 1280 px mens den er monteret**; `recipe_designer.js` ejer klassen | 900 px var den gamle designers mål (én kolonne). Editoren har to, så navne-kolonnen blev 156 px. Editoren skal ikke kende den side den er monteret i — og kan så heller ikke glemme at rydde op |
| B9 | **Den gamle designer-vej står tilbage** bag `window.RD_LEGACY` | En omskrivning man ikke kan slå fra, kan ikke sammenlignes med det den erstattede. Ryddes når editoren er godkendt i drift |

### Fundet undervejs — rettet

| Fund | |
|---|---|
| **En ny vare faldt tavst ud af beregningen** (`recipeDraft`) | Nøglen blev dannet af et løbenummer og slået op med kladdens indeks. De faldt kun sammen hvis alle linjer før også var nye varer — ellers forsvandt linjen uden en fejl, og totalen blev for lille. Samme fejlklasse som #305/#319. Låst af `test-recipe-draft.js` §9 |
| **`/beregn` kunne ikke kobles tilbage til kladdens linjer** | Rækkefølgen i svaret er ikke kladdens (nestings lægges efter varelinjer). `draft_index` bæres nu med — et tal på den forkerte linje er værre end intet tal |
| **Mængdefeltet blev skrevet om MENS man tastede** | `tegnListe()` er et rent `innerHTML`-skift, og beregningen kalder den 280 ms efter sidste tastetryk. Man mistede feltet — og værre: kladden bærer det TOLKEDE tal, så «0,» blev tegnet som «0», og næste ciffer landede i et andet tal end man skrev. Fokus, markør OG brugerens råtekst bevares nu over en gentegning. **Pre-eksisterende**; fundet fordi udfoldningen nu afhænger af antallet |
| **Badget lagde sig hen over et to-linjers varenavn** | `align-items: center` centrerede det lodret mod et navn der var brudt om. Navn og badge ombryder nu hver for sig (`flex-wrap` + `baseline`), og tal-kolonnerne er skåret til deres indhold, så PRODUKT får pladsen. Listen klipper (`overflow: hidden`), så navnet må ikke have et gulv — et gulv ville skubbe kostprisen ud af kortet |

### Fundet undervejs — IKKE rettet (data/andres område)

| Fund | |
|---|---|
| `locations`-rækken for `test` peger på `https://grocytest.ristetrug.dk/api` (**401**) | Den levende instans er `grocy-test` med bindestreg (`.env`'s `GROCY_TEST_URL`). Hver frisk dev-DB kan derfor ikke nå grocytest. Samme fejlklasse som HQ/grocycafe-fælden fra juli |
| `Hvidløg - i tern` er **inaktiv** i Grocy, men bruges i opskrift 98 (Tahin dressing) | Stamdata. En inaktiv vare i en levende opskrift er den tilstand der gav 13 bons `partial` i #645 |
| Vandret scroll på telefon-bredde i kitchen-zonen | **Pre-eksisterende**: `kitchen/stock.html` har 34 px overflow ved 375 px, editoren 16. Kitchen er bygget til tablets; telefoner har `mobile/` |

---

## 18. Åbne punkter

| # | Punkt |
|---|---|
| Å1 | Målvægt som userfield — navn og oprettelse |
| Å2 | ~~Sektionsskabeloner~~ — **løst (B6)**: udledes af driften, overstyres med `settings.recipe_section_templates` |
| Å3 | Hurtigvalg for målvægt: hvilke skåltyper med i v1? |
| Å4 | Tid pr. trin som planlægningsdata — udskudt til en tabel i Bon |
| Å5 | Allergener som kolonne — ikke i v1 |
| Å6 | Overblikket på iPad (vandret bånd) er utestet — tallene skal være synlige mens man skriver |
| Å7 | Prislister: catering · festival · store · produktion · waiste. Default-valg mangler stadig |
| Å8 | ~~Udfoldningen skalerer ikke~~ — **løst (B8)**: `GET /api/opskrifter/:id/indhold?kind=&bruger=` skalerer på serveren. Dækket af `test:opskrift-udfold` |
| Å9 | ~~Målvægt gemmes ikke~~ — **løst**: norm pr. Grocy-kategori (`recipe_db_targets.target_weight_g`, migration 187) + afvigelse pr. opskrift (`recipe_target_weights`). Dækket af `test:opskrift-maalvaegt` |

---

## 18. Efter første drifttest (21. september 2026)

Fire ting kom retur fra drift. Den anden var den alvorlige.

### 18.1 Fremgangsmåden var usynlig — og blev slettet

34 af opskrifterne i grocy-hq har rigtig arbejdsbeskrivelse i Grocys ene
fritekstfelt, uden numre. `parseDescription` læste den korrekt til `plain`,
men `tegnTrin` renderede **kun** trin-listen. På Balsamico + løg stod der
derfor «+ Tilføj trin» på en opskrift med fem linjers fremgangsmåde.

Værre: `toStore` kasserede `plain` i det øjeblik der fandtes ét trin.

```
før:   <p>løgene skæres i ringe…</p><p>2 timer i ovnen ved 120°</p>
efter: <p>1. Køl ned [30 min]</p>      ← ét tilføjet trin
```

Et passivt Gem var harmløst (`toStore` kaldes slet ikke når intet er rørt),
men **det første trin man tilføjede, tog beskrivelsen med sig** — uden at
man nogensinde havde set den. Samme fejlklasse som #305/#319: handlingen ser
uskyldig ud, tabet er tavst.

- Teksten vises nu i et redigerbart felt over trin-listen, mærket «Som den
  står i Grocy», med **Lav om til trin** (ét linjeskift = ét trin).
- `toStore` sætter teksten FORAN trinene. Round-trip er stabilt: ved næste
  læsning bliver den til `lead`, som allerede er en del af modellen.
- At **rydde** feltet er stadig brugerens eget valg — ellers kunne man ikke
  omskrive en rodet beskrivelse til rene trin.
- `S.stepsEdited` bærer nu både `steps` og `plain`; de tre steder der satte
  den, overskrev hinandens felt.

Dækket af `test:opskrift-trin` §10. Mutations-testet: rulles rettelsen
tilbage, falder 3 navngivne asserts.

### 18.2 Vægt fra en underopskrift uden erklæret udbytte

Slider-boksen stod med `—` i GRAM på alle tre nestings, mens kostprisen lige
ved siden af skrev `≥ 11,87`. Vi har allerede et sprog for «mindst så meget»;
vægten brugte det bare ikke.

Reglen fandtes i huset i forvejen — `ingredientResolver` skriver den selv:

> *Erklæret yield vinder over summen af input. Findes intet yield, falder vi
> tilbage på summen — den er stadig bedre end ingenting, men den overvurderer
> alt hvor der hældes fra eller svinder.*

Editoren var den eneste flade der gav op. `subRecipeInputGrams` summerer nu
underopskriftens egne råvarer (rekursivt, emballage udeladt, stak-baseret
cyklusværn jf. #354) når udbyttet ikke kan bestemmes.

**Tallet markeres som et skøn** (`~137 g`, forklaring i tooltip) og
underopskrifterne nævnes ved navn i `weight.estimated`. For en slider ER
summen reelt vægten; for Balsamico + løg er den 57 % for høj (1566 g ind,
1000 g ud). `≥` og `~` betyder ikke det samme, og `~` vinder når begge
gælder: et skøn der kan være for højt, er ikke et mindstetal.

Målt på slider-boksen: `—` → `~414 g` mad, og de tre sliders står med
137/138/140 g.

### 18.3 Målvægt — en norm pr. kategori (Å9)

«Hvad sigter vi på at en sandwich vejer» er ikke en egenskab ved ÉN opskrift.
`recipe_db_targets` bærer allerede præcis den slags norm pr. Grocy-kategori
(DB%-målet), så målvægten hører samme sted: ét sted at vedligeholde.

- **Migration 187**: `target_weight_g` på `recipe_db_targets` (tabellen
  genskabes, så `target_pct` kan være NULL — en kategori må have den ene norm
  uden den anden) + `recipe_target_weights` til afvigelsen pr. opskrift.
- **Kun afvigelsen gemmes.** Er tallet det samme som normen, fjernes rækken —
  ellers ville en senere ændring af normen ikke slå igennem, og opskriften
  ville stå med et tal ingen huskede at have sat.
- Editorens felt viser normen som **placeholder** med tooltip, aldrig som
  værdi: en hjælpetekst og en indtastning må ikke se ens ud. Tomt felt betyder
  «brug normen igen», ikke «ingen målvægt».
- Normerne redigeres i ⚙-popoveren i **Opskrifter & priser**, ved siden af
  DB%-målet. De to er uafhængige: et gem af den ene rører ikke den anden.
- `målvægtÆndret()` tæller den som en ændring — `diffRecipe` kan ikke se den,
  og uden det var feltet dødt: man kunne taste, se bjælken flytte sig, og stå
  med en grå Gem-knap.

Dækket af `test:opskrift-maalvaegt` (18 asserts, skema fra de rigtige
migrations). Mutations-testet: fire regler, alle fanget.

### 18.4 Margen og tavse konsolfejl

`#recipeDesignerContainer` havde `padding: 0`, så indholdet klistrede til
venstre kant. Nu `0 20px`.

Samtidig: `gem()`s `finally { tegnBund() }` kører EFTER `onExit` har
afmonteret editoren, så hvert gem kastede to `Cannot set properties of null`.
Fejlen er pre-eksisterende (findes i den committede udgave), men den slags
støj skjuler de ægte fejl. Alle seks tegnere har nu en vagt:
findes elementet ikke, er der intet at tegne på.

---

## 19. Disciplin

Skærmen fungerer, fordi hver ting har ét sted. Et nyt felt (allergener, holdbarhed,
temperatur) koster en kolonne eller en linje og skal have sit eget sted — ikke klemmes
ind ved siden af et eksisterende. Det var sådan, den gamle designer endte med fire
mængdebegreber ved siden af hinanden.
