# CLAUDE_OPSKRIFT_IMPORT_OVERSAETTELSE.md

**Version:** v0.3
**Status:** Tillæg til `CLAUDE_OPSKRIFT_IMPORT.md` — oversættelseslag, enheder, svind, udbytte, målvægt og underopskrifter
**Dato:** september 2026

**Ændringer fra v0.2:** Målvægt fastsat til 400 g for standardskålen (900 ml). Rollemodellen omskrevet fra procentfordeling til absolutte roller med basen som residual. Spinat afklaret som garniture. Eksisterende salatopskrifter skal justeres (§12).
**Ændringer fra v0.1:** Bærer-klassifikation udgår af v1. Salater flyttet fra kilo-konvention til målvægt pr. skål. Emballage som egen skaleringsakse. Faktorbibliotek udskilt som eget modul.

---

## 1. Formål og afgrænsning

Dette dokument beskriver det lag i opskriftsimporteren der oversætter en
kildeopskrift til noget der kan skrives i Grocy efter Ristet Rugs konventioner.

Afgrænsningen er skarp: **al oversættelse sker i importeren, ikke i Grocy.**
Grocy skal kun indeholde de QU-conversions der reelt bruges i køkkenet.
Husholdningsmål (dl, spsk, tsk, "1 mellemstort løg") må ikke blive
QU-conversions i Grocy — de er importer-data.

### Grocys måleenheder (konvention)

| Enhed | Bruges til |
|---|---|
| Kilo / Gram | Alt der kan vejes. Standard. |
| Liter / ml | Væsker hvor volumen er den praktiske enhed (eddike, saft, olie) |
| Stk / Antal | Kun det der ikke meningsfuldt kan vejes (æg, appelsiner, stjerneanis, emballage) |

Alt andet er oversættelse.

---

## 2. Hovedinvariant

> **Grocy-opskriften er sandheden, og den må ikke ændre sig ved at blive vist et
> andet sted.**

Bon må **annotere**, men aldrig **transformere**. Står linjen som `1,1 kg` i
Grocy, viser Bon `1,1 kg (+10 % rensesvind)`. Aldrig `1,0 kg` beregnet tilbage.
Samme tal, mere kontekst.

Det gælder alle afledte tal i dette dokument: batchvægt, udbytteandel, procenter
og antagelser er visninger, ikke redigeringer.

---

## 3. Enhedsreglen

> **Måleenheden bestemmes af varen, ikke af opskriften.**

Konverteringsmålet slås op på varens `QU stock` i Grocy:

- `1 dl fløde` → `0,1 l` hvis fløde er en literbaseret vare
- `1 dl fløde` → `0,103 kg` hvis fløde er en kilobaseret vare (densitet 1,03)
- `1 dl hvedemel` → `0,060 kg` (60 g/dl)

**Konsekvens:** enheden skal være besluttet i samme øjeblik importeren opretter
en ny vare. En kandidatvare uden `QU stock` kan ikke omregnes, og linjen kan
derfor ikke lukkes. Dette er en gap-type på linje med G1–G6.

**Den eneste QU-conversion der ikke kan undgås i Grocy** er stk ↔ kg for varer
der tælles på lager. Ikke for køkkenets skyld, men fordi kilder ofte skriver
gram hvor vi har stk, eller omvendt.

---

## 4. Svindfaktorer

Kilden (DTU, §7) skelner mellem to former for svind, og de hører to forskellige
steder:

| Type | Definition | Hører på |
|---|---|---|
| **Rensesvind %** | Forskel på brutto- og nettovægt, i % af brutto (skræl, ben, top) | **Varen** |
| **Tilberedningssvind %** | Det der forsvinder ved tilberedning, i % af netto | **Opskriftslinjen** |
| **Vægtændringsfaktor** | > 1 for varer der optager vand (ris, pasta, bælgfrugter) | Opskriftslinjen |

Rensesvind hører på varen, fordi en gulerod skrælles lige meget uanset
opskriften. Tilberedningssvind hører på linjen, fordi det afhænger af metoden.

### Praksis

Svindet skrives fortsat **manuelt ind i mængden**: 1,1 kg gulerødder for at få
ca. 1 kg efter rensning. Det er den eneste form Grocy ser. Importeren:

1. Foreslår den justerede mængde: `500 g gulerødder → 0,550 kg (+10 % rensesvind)`
2. Skriver antagelsen i importnoten (§9)
3. Lader egne målinger overskrive standardfaktoren permanent i faktorbiblioteket

**Afklaret:** faktorerne bor i **Bon, ikke som Grocy-userfield.** Argumentet for
et userfield var synlighed for køkkenet, men køkkenet ser Bons opskriftsvisning,
ikke Grocys. Et userfield mere ville kun være endnu et felt at holde i sync, og
det ville bryde invarianten i §2. Grocy er datalager, Bon er brugerfladen.

---

## 5. Batchvægt og deklareret udbytte

Summen af ingredienslinjerne er **ikke** lig med den deklarerede portion, og det
er korrekt. Eksempel (Rødkål – Syltet, RR Produktion):

```
Rødkål - Rå        1 kg
Eddike           400 ml
Vand             800 ml
Tranebærsaft     400 ml
Sukker            70 g
Pebberkorn         7 g
Stjerne Anis       2 stk
Appelsiner       0,4 stk
Salt               5 g
-----------------------------
Batchvægt       2,75 kg
Deklareret udbytte  1 kg
```

De 1,75 kg difference er hverken rense- eller tilberedningssvind — lagen
forbruges fra lageret, men indgår ikke i det der kan bruges i sandwichen.

### Invariant (erstatter den gamle)

> Formuleringen "summen af linjerne skal give 1.000 g" udgår. Invarianten er:
> **hver linje har en mængde i varens egen enhed, og opskriften har et
> deklareret udbytte.** Batchvægten beregnes og vises, men er ikke en
> godkendelsesbetingelse.

### Afledte tal

| Tal | Bruges til |
|---|---|
| **Batchvægt** (2,75 kg) | Plads, bøtter, håndtering. "5 kg svarer til 3 store kondibøtter" |
| **Deklareret udbytte** (1 kg) | Forbrug i salater/sandwich, salgskalkulation |
| **Udbytteandel** (36 %) | Kvalitetstal — en afvigelse fra det forventede afslører en indtastningsfejl |

Kostpris og CO2 beregnes på **hele batchvægten**, fordi det er det der forlader
lageret.

### Bærer-klassifikation: udgår af v1

v0.1 foreslog at markere hver linje som `udbytte` eller `baerer` (lage,
kogevand, fritureolie). Det droppes. Det deklarerede udbytte bærer allerede
informationen: 2,75 kg batch, 1 kg deklareret, difference 1,75 kg.
Linjemarkeringen tilføjer først noget den dag næringsindhold skal beregnes pr.
brugbart kilo, hvor man skal vide hvor meget af lagen der blev optaget.

Tages op igen sammen med næringsberegningen. Indtil da: vis batchvægt og
udbytte, og lad differencen stå uforklaret — den er ikke en fejl.

---

## 6. Målvægt: tre opskriftstyper

Konventionen er ikke én, men tre. Typen afgøres **før** omregningen, fordi det
er tre forskellige beregninger.

| Type | Enhed | Målvægt | Eksempler |
|---|---|---|---|
| **Produktion** | 1 kg | Fast: 1 kg deklareret | Syltede gulerødder, rødkål, pulled pork, dressinger, mellemprodukter |
| **Skål** | 1 antal | Valgt pr. skåltype | Salater (gruppe `02 Salat`), bowls |
| **Styk** | 1 antal | Givet af produktet | Sandwich |

Fundne opskrifter er typisk skrevet til én portion eller et måltid. For
**Produktion** skaleres op til 1 kg. For **Skål** og **Styk** divideres kildens
portionsantal væk, og målvægten sættes derefter.

---

## 6.1 Skåltyper

| Skåltype | Volumen | Målvægt | Pakningsdensitet | Status |
|---|---|---|---|---|
| Standard salatskål | 900 ml | **400 g** | 0,44 kg/l | I brug |
| Bowl-skål | TBD | TBD | 0,7–0,8 kg/l forventet | Ikke anskaffet |

**Målvægten er et valgt tal, ikke et beregnet.** Volumen sætter et loft — låget
skal kunne lukke — men inden for det loft er målvægten en beslutning om portion
og pris. 400 g i 900 ml er afprøvet og passer.

**For bowls vender bindingen.** Korn, pasta og kartofler pakker tættere, så en
900 ml skål ville kunne rumme 700 g eller mere. Volumen er derfor ikke længere
det bindende krav, og målvægten skal sættes efter portionsstørrelse og pris.
Importeren må ikke udlede bowl-målvægten af volumen × densitet.

---

## 6.2 Rollemodellen

Roller skalerer ikke ens, og det er dét der er strukturen. En portion protein er
en portion protein, uanset skålens størrelse.

| Rolle | Adfærd | Standard (400 g skål) |
|---|---|---|
| **Protein** | Absolut — en portion er en portion | 100 g |
| **Dressing** | Absolut pr. skål — mere gør salaten våd | 25 g |
| **Garniture** | Absolut — pynt-skala. Spinat og andre blade hører her | 60–80 g samlet |
| **Krydring** | Procent af målvægt | ca. 0,5 % |
| **Base** | **Residual** — fylder resten op | Beregnet |

### Beregning

```
base = målvægt − protein − dressing − garniture − krydring
```

Basen er den frie variabel. Det svarer til hvordan en skål faktisk pakkes: de
dyre og de nøjagtige komponenter lægges i efter mål, og grøntsagen fylder op.
Det gør også importeren simpel — den foreslår fire absolutte tal og lader basen
falde ud som rest.

**Afklaret:** basen er én rolle, ikke to. Spinat er garniture, ikke base. En
importer kan ikke pålideligt skelne hovedgrønt fra blade i en fremmed opskrift,
og skellet er heller ikke nødvendigt når basen er residual.

### Garniture er et budget

Garniture foreslås som **ét samlet tal for rollen** (80 g), ikke som et måltal
pr. linje. Det giver frihed i produktionen: køkkenet rammer budgettet på øjemål
i stedet for at veje tre ting hver for sig.

Grocy-opskriften har fortsat **konkrete linjer**, fordi kostpris, allergener og
deklaration ikke kan beregnes på et samlet tal. De 80 g fordeles på linjer ved
gennemsynet, ikke i produktionen.

Friheden gælder vægtfordelingen, ikke varevalget. Byttes valnødder ud med
græskarkerner, ændrer kostpris og allergener sig — det er en opskriftsændring,
ikke en improvisation.

**Grænse:** hvis målvægten sættes så lavt at basen kommer under ca. 30 % af
totalen, holder modellen ikke længere — så er det ikke en salat med fyld, men en
anretning. Importeren advarer i stedet for at regne videre.

### Referenceværdier

DTU sætter størrelsesordenen for de absolutte roller (lille / mellem / stor):

| Rolle | DTU-reference |
|---|---|
| Kylling | 50 / **100** / 200 g |
| Andet kød til hovedret | 50 / 100 / 175 g |
| Dressing (mayonnaisesalat) | 20 / **40** / 60 g |
| Tomat | 15 / 50 / 100 g |
| Tilbehør (feta, oliven, revet ost) | 10 / 25 / 50–75 g |
| Grønne blade | 15 / 40 / 75 g |
| Grønt drys | 1 / 3 / 7 g |
| Blandet salat med kød, i alt | 150 / 275 / 425 g |

Egne værdier går forud for DTU hvor de findes. Med kun fire salatopskrifter i
`02 Salat` er datagrundlaget for tyndt til gennemsnit, men tilstrækkeligt til at
bekræfte at rollestrukturen holder. Gennemsnit pr. rolle (`faktor_rolle_norm`)
udtrækkes når samlingen er vokset.

---

## 6.3 Emballage er en egen skaleringsakse

> **Emballage skalerer med antal enheder, ikke med vægt.**

Tredobles målvægten på én skål, er det stadig 1 bøtte, 1 låg, 1 gaffel, 1
serviet. Skaleres til 3 skåle, bliver det 3 af hver. To forskellige akser i
samme opskrift, og den nemmeste fejl at lave i en skaleringsrutine.

Emballagegruppen kommer fra en **skabelon pr. skåltype** ved import, ikke fra
kildeopskriften, som aldrig nævner den.

---

## 6.4 Nominelle mængder for "til smag"

"Salt og peber efter smag" må ikke importeres som en tom linje. En
produktionsopskrift skal være reproducerbar, og salt hører desuden med i
deklarationen.

Importeren sætter et nominelt tal som **procent af målvægten** — salt 1,0 %,
peber 0,2 % — og markerer linjen "sat ved import, ikke målt" i importnoten.
Procent frem for fast gramtal, så tallet følger med ved skalering. Realistiske
tal, ikke placeholdere.

---

## 7. Faktorbiblioteket (eget modul)

Måltabellen er ikke importer-specifik. Den har samme form som CO2-faktorerne:
**en værdi, en kilde, en version.** DSK v1.2, Klimakompas 2025, DEFRA 2025 og
DTU 2013 er fire datasæt i det samme register.

Derfor: et **faktorbibliotek** som eget modul, som opskriftsimporteren,
CO2-modulet og senere næringsberegningen slår op i — i stedet for tre steder der
hver har deres egen tabel. Det løser samtidig udskiftningen til TRyeIT, fordi
datasættet bliver konfiguration og ikke kode.

### Kilde: måltabellen

DTU Fødevareinstituttet: *Mål, vægt og portionsstørrelser på fødevarer*,
1. udgave, januar 2013, Karin Hess Ygil. ISBN 978-87-92763-66-2.
Ca. 850 fødevarer og ca. 180 registrerede portionsstørrelser.
Foreligger som `maal_vaegt_portionsstoerrelser_marts_13.xlsm`, 33 dataark.

**Rettigheder.** Rapportens rettighedstekst tillader én kopi til privat
studie/forskning og udelukker videredistribution og kommerciel brug. En enkelt
vægtangivelse er en kendsgerning, men en systematisk kopi af hele samlingen er
det databasebeskyttelsen dækker. Håndtering:

1. Intern brug hos Ristet Rug nu
2. Henvendelse til Fødevareinstituttet om tilladelse med kildeangivelse (afsendt, intet svar endnu)
3. `dataset`-feltet gør samlingen udskiftelig: TRyeIT-udgaven kan sendes med et
   datasæt bygget på egne målinger og frit tilgængelige værdier, uden kodeændring

Det er samlingen der skal kunne skiftes ud, ikke de enkelte tal.
(Ikke en juridisk vurdering.)

### ETL, ikke live-opslag

Regnearket kan ikke læses direkte. Kendte problemer:

- Tal er tekst med kildebogstaver og indlejrede linjeskift: "240 / brutto 250b", "5 f", "2,1 j"
- `*` betyder "ikke oplyst", `-` betyder "ikke relevant"
- `kød`-arket har svinekød i kolonne A–F og oksekød i K–P, side om side
- Overskriftsrækker gentages, og gruppenavn ligger i cellen over tabellen
- Intervaller: "150-200", "0,990 – 1,000"
- Danske decimalkommaer
- Værdier over 50 g er afrundet til nærmeste 5 g — falsk præcision genindføres ikke

Konverteres én gang. Kildebogstavet bevares, så et tvivlsomt tal kan spores
tilbage til `kilder`-arket.

### Tabeller

**`faktor_maal_vaegt`** — mål og vægt pr. fødevare

```
navn, gruppe, undergruppe,
g_pr_stk_lille, g_pr_stk_mellem, g_pr_stk_stor,
g_pr_dl, g_pr_spsk, g_pr_tsk,
brutto_g_mellem, rensesvind_pct,
tilberedningssvind_pct, vaegtaendringsfaktor,
vaerdi_min, vaerdi_max,
kilde_bogstav, kilde_note, dataset, version
```

DTU anbefaler selv **mellemvægten** som standard. Lille/stor gemmes, men bruges
kun ved eksplicit kilde ("1 stort løg").

**Intervaller:** `vaerdi_min` og `vaerdi_max` gemmes, midtpunktet regnes med, og
intervallet skrives i importnoten: `175 g (kilde: 150-200 g)`. Ingen nye
userfields i Grocy. Så ser man hvornår usikkerheden er stor nok til at man selv
bør veje.

**`faktor_portionsstoerrelse`** — registrerede portioner (lille/mellem/stor, g)
for ca. 180 retter. Referencegrundlag for de absolutte roller i §6.2.

**`faktor_rolle_norm`** — egne værdier pr. rolle pr. skåltype. Udtrækkes af
`02 Salat` når samlingen er stor nok. Primærkilde når den findes.

**`faktor_skaaltype`** — volumen, målvægt, emballageskabelon, pakningsdensitet.

**`faktor_husholdningsmaal`** — glas, kopper, skeer i ml.
`1 dl = 100 ml`, `1 spsk = 15 ml`, `1 tsk = 5 ml`.

**`faktor_densitet`** — kg/l pr. produkttype, til ml→kg på væsker. Ikke fra DTU;
egen tabel (vand 0,998, mælk 1,03, eddike 5 % ca. 1,007, olie ca. 0,915, sirup
1,3–1,4). Udvides efter behov.

### Kobling til Grocy-varer

DTU-navn → Grocy-vare kører gennem den eksisterende `ingredient_alias`-tabel og
resolveren med konfidensbånd A/B/C. "Agurk, rå" → "Agurk - Grøn" er et B-match
der bekræftes én gang og derefter huskes.

---

## 8. Underopskrifter

### Model — bekræftet af praksis

Grocys nesting ("Inkluderede opskrifter") bruges **ikke**; feltet står tomt i
eksisterende opskrifter. En underopskrift bliver:

1. Sin egen opskrift efter samme konvention (1 kg for produktion)
2. Med "Produceret vare" → et mellemprodukt på lager
3. Moderopskriften forbruger en mængde af **mellemproduktet**

Det er allerede praksis: Chili Mayo og Kylling - BBQ står i BBQ-salaten med
`[→]`, altså som producerede varer. Modellen skal ikke indføres, bare
understøttes ved import.

Det giver kostpris, allergener og CO2 som roll-up, lagerstyring på dressingen,
og passer på produktionspolitikkens "RR hurtig produktion".

Flatning (indlejring af dressingens råvarer i moderopskriften) er ikke et
alternativ — det koster mellemproduktet, og det er det produktionen styres efter.

### Ingrediensgrupper findes allerede

Grocy grupperer ingredienser (`Dressing`, `emballage` i eksemplet). En importeret
opskrifts underafsnit kan derfor lande som grupper uden at der skal bygges noget
nyt. Gruppen er det rigtige sted for et afsnit der **ikke** skal være et
selvstændigt mellemprodukt.

### Detektion kræver brugerinteraktion

Heuristisk, og må aldrig være tavs:

- **Fritekst:** ny ingrediensoverskrift ("Til dressingen:", "Til lagen:")
- **Excel:** ny blok med tom række imellem, eller nyt faneblad
- **Web/JSON-LD:** sjældent markeret — kræver næsten altid manuel opdeling

Flowet er et forslag: *"Jeg ser 2 opskrifter her — opret dressingen som
selvstændig 1 kg-opskrift?"* med fire svar:

1. Peg på eksisterende mellemprodukt *(forvalgt hvis fundet)*
2. Opret som ny opskrift + mellemprodukt
3. Behold som ingrediensgruppe i moderopskriften
4. Udelad

---

## 9. Visning og dokumentation af antagelser

### Ved gennemsyn: tre kolonner

| Kilden skrev | Bliver | Antagelse |
|---|---|---|
| 1 dl hvedemel | 0,060 kg | 60 g/dl (DTU 2013, kilde b) |
| 500 g gulerødder, skrællede | 0,550 kg | +10 % rensesvind (DTU 2013, kilde f) |
| 2 spsk rapsolie | 0,027 kg | 15 ml/spsk × 0,915 kg/l |
| Salt efter smag | 0,004 kg | 1,0 % af målvægt — sat ved import, ikke målt |
| 1 bøf | 0,175 kg | midtpunkt, kilde angiver 150-200 g |

Antagelseskolonnen er den vigtigste af de tre. Den kan efterprøves bagefter, og
den afslører en dårlig værdi i faktorbiblioteket, så den kan rettes én gang for
alle i stedet for at forplante sig til hver import.

Under linjerne: målvægt, faktisk sum, afvigelse, batchvægt og dækningsgrad.

### Afvigelsesadvarsel

```
Målvægt 400 g — opskriften giver 447 g (+12 %)
```

En **advarsel, ikke en blokering.** En tung salat kan være et bevidst valg, men
den skal være set. Samme visning bruges ved gennemgang af eksisterende
opskrifter (§12).

### Efter import: to spor

**Grocy får den menneskelige version** — en kort importnote i fremgangsmåden,
hvor køkkennoterne i forvejen står:

```
Importnote (DTU 2013): 1 dl mel = 60 g. Gulerødder +10 % rensesvind.
Bøf 175 g, kilde angiver 150-200 g. Salt sat til 1,0 % af målvægt, ikke målt.
```

**Bon beholder den strukturerede version** i `import_plan`, så en import kan
efterprøves maskinelt. Det bryder ikke §2, fordi logen dokumenterer importen,
ikke opskriften.

Ingen nye userfields i Grocy til dette formål.

---

## 10. Skalering: forbehold

Skalering fra 4 portioner til 1 kg ændrer emulsioner, hævetider, krydring og
kogetider. Det kan ingen tabel fange.

Importerede opskrifter markeres **"skaleret, ikke prøvet"** indtil første
produktion er vejet. Ved første produktion sammenholdes faktisk udbytte med
deklareret, og differencen tilbageføres som et **forslag** til rettelse af
udbyttet — ikke som en automatisk justering.

---

## 11. Regneeksempel: Kyllingen BBQ-Salat

Nuværende opskrift mod 400 g målvægt:

| Rolle | Vare | Nu | Justeret |
|---|---|---|---|
| Protein | Kylling - BBQ | 100 g | 100 g |
| Base | Spidskål | 240 g | **195 g** |
| Garniture | Semidried tomater | 40 g | 40 g |
| Garniture | Spinat | 20 g | 20 g |
| Garniture | Valnødder | 20 g | 20 g |
| Dressing | Chili Mayo | 25 g | 25 g |
| Krydring | Salt - Flager | 2 g | 2 g |
| **I alt** | | **447 g** | **402 g** |

```
base = 400 − 100 − 25 − (40 + 20 + 20) − 2 = 193 g → 195 g afrundet
```

Hele justeringen på 47 g tages i basen. Protein, dressing og garniture står
urørt — man skærer ikke i kyllingen for at ramme en skålvægt.

---

## 12. Opgaver

1. **Juster de fire eksisterende salatopskrifter** i `02 Salat` til 400 g efter
   rollemodellen. Basen absorberer differencen i hver.
2. Vej en fyldt skål af hver af de fire, og registrer pakningsdensiteten i
   `faktor_skaaltype`. Fire målte værdier er mere værd end DTU til dette formål.
3. Beslut bowl-skålens volumen og målvægt (§6.1) når skålene anskaffes.
4. Opfølgning på henvendelsen til Fødevareinstituttet (§7).

---

## 13. Åbne punkter

1. Findes skålstørrelserne allerede i Bon som varer eller prisniveauer, eller
   skal `faktor_skaaltype` oprettes som ny tabel?
2. Er 400 g også den rigtige målvægt for en bowl, eller skal bowls have deres
   egen — givet at de pakker tættere og koster mere pr. skål?
3. Hvornår er `02 Salat` stor nok til at `faktor_rolle_norm` er meningsfuld?
   Under ca. 10 opskrifter er DTU-referencen bedre.
