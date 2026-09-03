# CLAUDE_OPSKRIFT_IMPORT.md

Specifikation for opskriftsimporteren i Bon. Version 0.1 — udkast til gennemsyn.

---

## 1. Formål og afgrænsning

Importeren tager en opskrift fra en ekstern kilde og lander den i Grocy som en korrekt opskrift med korrekte varer og enhedsomregninger — uden at ødelægge eksisterende data.

Den skal kunne bruges i to situationer:

- **Opdatering** af en kørende installation (HQ), hvor det svære er at matche mod eksisterende varer uden at ændre dem.
- **Opstart** af en ny Grocy-server, hvor det svære er at undgå dubletter inden for selve importen.

### Sådan gør v1

- opretter og genbruger varer med korrekt `qu_id_stock`, købs- og forbrugsenhed
- opretter de produktspecifikke enhedsomregninger opskriften kræver
- opretter opskriften med linjer, mængder, enheder og udbytte
- viser konsekvenserne (CO2, allergener, dækningsgrad) som **læsning**, ikke som skrivning

### Sådan gør v1 ikke

- skriver ikke `co2e_*`- eller `hk_*`-felter på nye varer
- opretter ikke barcodes eller leverandørbindinger
- ændrer ikke eksisterende varers navn, enheder eller omregninger
- sætter ikke salgspriser eller salgsflag

Berigelse af varestamdata (CO2-faktorer, allergenstruktur, næringsstoffer, klassificering) er et selvstændigt spor. De to projekter rører kun hinanden ét sted: importen skaber varekandidater, berigelsessporet fylder dem ud senere.

---

## 2. Invarianter

Disse må ikke brydes af nogen kodesti.

1. **Lagerenheden er kg.** Undtagelsen er varer der reelt kun håndteres i stk. Enhver vare skal have en gyldig vej fra sine øvrige enheder til lagerenheden.
2. **Importen ændrer aldrig en eksisterende vare.** En opskriftslinje er ikke belæg for at rette QU eller omregning på en vare med lagerhistorik og indkøbsaftaler. Uoverensstemmelser rapporteres, de rettes ikke.
3. **Der skrives aldrig uden en godkendt plan.** Ingen kodesti går direkte fra parsing til Grocy-API.
4. **Alias peger på Bons varenøgle, ikke på Grocys produkt-id.** Grocy-id er et autonummer der ikke overlever en ny instans. Adapteren oversætter.
5. **Nye opskrifter er ikke salgsvarer.** `sellable` og `sellableZettle` sættes hårdt til falsk i writeren, uafhængigt af kilde.
6. **En lokalt redigeret opskrift overskrives aldrig af en genimport.** Den giver en diff til gennemsyn.
7. **Manglende data er en synlig tilstand, ikke nul.** En ingrediens uden CO2-faktor må aldrig indgå i en sum som nul.

---

## 3. Datamodel

### 3.1 Varens tilstande

| Tilstand | Betingelse | Kan bruges til |
|---|---|---|
| `kandidat` | navn og gættet enhed | opskriftslinjer, ikke lager |
| `defineret` | lagerenhed sat, gyldig omregning findes | kalkulation, lagerføring |
| `indkoebbar` | mindst én barcode med mængde og pris | indkøb, kostpris på leverandørniveau |

Importeren producerer `kandidat` og kan løfte til `defineret` når omregningen er bekræftet. `indkoebbar` er uden for v1.

### 3.2 `ingredient_alias` (Bon)

| Felt | Beskrivelse |
|---|---|
| `alias_text` | råteksten som den stod i kilden |
| `alias_normalized` | normaliseret nøgle (småt, uden fyldord, uden mængde) |
| `product_key` | Bons varenøgle |
| `source` | hvor bindingen kom fra: `manuel`, `import`, `seed` |
| `confirmed_by`, `confirmed_at` | hvem der besluttede |
| `hit_count`, `last_used_at` | bruges til oprydning og til at måle om værktøjet lærer |

Tabellen er værktøjets vigtigste aktiv. Den vokser med hver import og skal kunne eksporteres og genindlæses uafhængigt af Grocy.

### 3.3 `import_plan` og `import_plan_item` (Bon)

En plan er en gemt, gennemsynlig liste over hvad der vil ske. Den har status `kladde`, `godkendt`, `udfoert`, `delvist_udfoert` eller `annulleret`.

Hvert item har: operationstype, målentitet, forslagsværdier, konfidensbånd, gap-type hvis relevant, menneskets afgørelse, og efter udførelse det oprettede Grocy-id.

### 3.4 `RecipeDraft` — det kanoniske udkast

Alle adaptere producerer denne struktur og intet andet.

```
RecipeDraft
  source_type        fritekst | jsonld | excel | grocy
  source_ref         URL, filnavn eller fri reference
  source_hash        fingeraftryk af normaliseret kilde (idempotensnøgle)
  title
  yield_amount       udbytte, tal
  yield_unit         portioner, kg, stk
  prep_time_min
  instructions       fritekst
  ingredients[]
    raw_line         linjen som den stod
    amount           tal eller null
    amount_variable  sand ved "efter smag", "1 bundt"
    unit_text        enheden som skrevet
    name_text        varenavnet som skrevet
    note             "finthakket", "gerne økologisk"
    group            ingrediensgruppe hvis kilden har den
```

Formatviden stopper her. Resolver og writer kender kun `RecipeDraft`.

---

## 4. Pipeline

### 4.1 Adaptere

**Fritekst.** Fundamentet. Dækker mail, Word, afskrift fra bog. En sprogmodel splitter linjer i mængde, enhed, navn og note. Resultatet er altid et forslag, aldrig en afgørelse.

**URL med JSON-LD.** De fleste opskriftssider udstiller `schema.org/Recipe`, så én parser dækker bredt. Udbytte og tilberedningstid følger ofte med. Falder tilbage til fritekstadapteren på sidens brødtekst hvis der ikke findes strukturerede data.

**Excel.** Til de opskrifter der allerede findes i regneark. Kolonneopsætningen skal fastlægges ud fra et faktisk eksempel — se åbne punkter.

**Grocy → Grocy.** Læser opskrifter og deres varer fra én instans og producerer udkast til en anden. Kildedata er allerede normaliseret, så denne adapter er den mest pålidelige og formentlig den vigtigste ved opstart af en ny server.

### 4.2 Resolver

For hver ingredienslinje, i denne rækkefølge:

1. **Aliasopslag** på normaliseret navn. Fuldtræf giver bånd A.
2. **Navnematch** mod eksisterende varer med normalisering og fuzzy-sammenligning. Én kandidat over tærsklen giver bånd B; flere giver bånd C.
3. **Enhedstjek.** Findes der en vej fra linjens enhed til varens lagerenhed? Hvis ikke, er det en selvstændig mangel — ikke et matchproblem.
4. **Batch-dedup.** Ved import af flere opskrifter samtidig sammenlignes uafklarede navne også indbyrdes, så "gule løg" og "løg, gul" ikke bliver to varer.

**Konfidensbånd**

| Bånd | Betingelse | Behandling |
|---|---|---|
| A | eksakt aliastræf | anvendes automatisk |
| B | ét sandsynligt match | forslag i kø, ét klik |
| C | flere eller ingen | kræver afgørelse |

Uden båndene bliver en import på 60 linjer til 60 beslutninger, og så bruges værktøjet én gang.

### 4.3 Gap-typer

Manglerne skal være navngivne tilstande, ikke fritekst i en logfil.

| Kode | Mangel | Blokerer? |
|---|---|---|
| `G1` | ukendt ingrediens, ingen vare kan matches | ja |
| `G2` | vare findes, men enheden kan ikke omregnes til lagerenhed | ja |
| `G3` | uklar mængde ("efter smag", "1 bundt") | nej — sættes som variabel mængde |
| `G4` | tilberedt form nævnt, lagervare er rå | nej — kræver afgørelse eller udbyttefaktor |
| `G5` | opskriften mangler udbytte | ja — uden udbytte kan intet skaleres |
| `G6` | flertydigt match | ja |

`G2` fortjener særlig opmærksomhed. Volumen til vægt er ikke generisk: en dl fløde, en dl mel og en dl olie vejer vidt forskelligt, og en generisk standardfaktor rammer ved siden af med op mod fyrre procent på mel. Automatisk afledte omregninger markeres, så de kan gennemgås. Fejlen her giver ingen fejlmeddelelse — kun en forkert kostpris.

### 4.4 Planen

Planen vises som et resumé før detaljerne:

```
14 ingredienslinjer
  9  genbruger eksisterende vare          (bånd A)
  3  ny vare oprettes                     (bånd B — gennemse)
  2  kræver afgørelse                     (G6, G1)
  4  ny enhedsomregning oprettes          (heraf 2 automatisk afledt)
  1  opskriften mangler udbytte           (G5 — blokerer)
```

Planen kan gemmes, genåbnes, køres mod testinstansen og derefter mod HQ.

**Redigerbarhed følger planens status.** Så længe planen er kladde, kan enhver afklaret linje åbnes igen og laves om — den er blot en række i Bon, og der er ingen grund til at spærre noget. Når planen er udført, står varen derimod i Grocy med lagerenhed og omregning, og invariant 2 gælder: importen ændrer ikke eksisterende varer. En linje i en udført plan er derfor ikke redigerbar; den vises som et link til varekortet, hvor rettelsen sker med åbne øjne.

### 4.5 Writer

Fast rækkefølge, da Grocy har fremmednøgleafhængigheder og ingen transaktioner:

1. enheder
2. globale omregninger
3. grupper, lokationer, indkøbssteder
4. varer
5. produktspecifikke omregninger
6. userfields på varer
7. opskrift
8. opskriftslinjer

Efter hvert skridt logges det oprettede id i `import_plan_item`. Efter sidste skridt køres en **verifikation**: hver oprettet vare læses tilbage, og det kontrolleres at lagerenhed og omregning faktisk er som planlagt. Grocys `/objects`-endpoint validerer stort set ingenting, så en vare kan sagtens oprettes i en tilstand der ser rigtig ud og regner forkert.

Fejler et skridt, standses udførelsen, planen får status `delvist_udfoert`, og der tilbydes en fortrydelse baseret på de loggede id'er.

---

## 5. Konsekvensvisning

Mulige allergener og CO2-aftryk er designparametre når en opskrift udvikles, ikke kun rapporteringsdata bagefter. Importeren skriver ikke berigelsesdata, men den **viser** konsekvensen — både i planen og efter udførelse.

**Altid sammen med dækningsgrad.** Et tal uden dækningsgrad er misvisende:

```
CO2e      2,3 kg pr. portion   (dækning 8 af 14 ingredienser)
Allergener  gluten, mælk, æg    (6 ingredienser uden data)
```

Uden den anden kolonne ser en opskrift med mange manglende faktorer klimavenlig ud, netop fordi den mangler data.

**Modenhed er forskellig for de to.** CO2-rulle-op kan bygges nu — faktorerne findes resolvet pr. kg med kilde og version, og opskriftsniveauet har allerede en cache. Allergenrulle-op er derimod begrænset af at allergendata i dag er én ustruktureret tekststreng: den kan ikke skelne "indeholder" fra "spor af", eller "ved det ikke" fra "indeholder ikke". Visningen kan derfor være vejledende i v1, men **må ikke præsenteres som deklarationsgrundlag** før allergendata er struktureret i berigelsessporet. Det er ikke importerens opgave at løse, men den skal være ærlig om det.

---

## 6. Idempotens og genimport

`source_hash` beregnes på den normaliserede kilde og gemmes på opskriften sammen med `source_ref`. Ved genimport:

- **Uændret hash, uændret opskrift i Grocy** → ingen handling.
- **Ændret hash, uændret opskrift i Grocy** → planlagt opdatering.
- **Opskriften er redigeret lokalt** → aldrig automatisk overskrivning. Der vises en diff, og valget står mellem at beholde, at oprette en ny version, eller at flette manuelt.

Opskrifter ændrer sig i køkkenet over tid, og den lokale version er som regel den rigtige.

---

## 7. Eksport af varestamdata

Bygges i v1 som ren læsning: enheder, globale og produktspecifikke omregninger, grupper, lokationer, varer, barcodes og userfields dumpes til én fil.

Tre formål: den gør det muligt at nulstille og teste hårdt mod en tom instans, den er en backup der ikke findes i dag, og den er feltkontrakten udtrykt som data. Apply-siden — altså den egentlige grundpakke til en ny server — er fase 2 og har dermed sit inputformat defineret på forhånd.

---

## 8. Instanser og sites

Afsnittet beskriver en model der først bygges færdig efter v1, men som v1 ikke må spærre for.

### 8.1 Tre niveauer

```
tenant   →   site        →   storage
kunde        adresse         fryser, køl, tørvarehylde
```

Fordelingen af data på niveauerne er den afgørende beslutning:

| Niveau | Data |
|---|---|
| `tenant` | varer, opskrifter, omregninger, aliaser, CO2-faktorer, allergener, priser |
| `site` | åbningsperiode, adresse, hvilken instans der betjener stedet |
| `storage` | lagerbeholdning, partier, holdbarhed |

**Stamdata har ingen adresse.** Alt hvad importeren skriver, hører til `tenant`. Det er grunden til at hele dette afsnit kan udskydes uden at blokere v1.

**Grocys begrænsning skal noteres eksplicit.** Grocy har én flad lokationsliste, og den er hos Ristet Rug brugt til opbevaringssted. En kunde med flere adresser kræver to dimensioner, som Grocy ikke kan holde adskilt. Krydsnavngivning ("Køl, Amager" / "Frys, Amager") virker ved to-tre steder, men kan ikke rulles op pr. sted uden navnekonventioner og kan ikke bruges til adgangsstyring. Det er en midlertidig løsning, ikke modellen. Den rigtige løsning hører til den egne lagerengine, og `site` skal ligge i skemaet fra begyndelsen — det koster ingenting før der findes data og kræver migrering af hver eneste lagerbevægelse bagefter.

### 8.2 Instansregister

En tabel i Bon over de Grocy-instanser der findes:

| Felt | Beskrivelse |
|---|---|
| `instance_key` | kort navn, fx `hq`, `trailer`, `test`, `kaelder` |
| `role` | `autoritativ`, `satellit` eller `test` |
| `endpoint`, `credentials_ref` | forbindelse |
| `tenant_key` | hvilken kunde instansen tilhører |
| `sites[]` | hvilke steder instansen betjener |
| `last_replicated_at`, `last_export_hash` | replikeringstilstand |

**Én hård regel:** varestamdata redigeres kun på den autoritative instans. Satellitter modtager. Oprettes en vare på en satellit, er den en kandidat til gennemsyn på den autoritative instans — aldrig en autoritativ vare.

Replikering af stamdata er envejs og bygger direkte på eksporten i afsnit 7. Det er den lette halvdel og bør bygges først.

### 8.3 Planen målrettes en instans

Hver plan bærer en målinstans. Samme plan kan udføres mod test og derefter mod produktion; de to udførelser logges hver for sig med hver deres oprettede id'er. Det er også mekanismen bag replikering: en satellit modtager en plan genereret ud fra den autoritative instans' eksport.

### 8.4 Midlertidige sites

En festivaltrailer er ikke et selvstændigt lager, men et **site med en start- og slutdato**. Samme begreb dækker en pop-up hos en kunde og en midlertidig produktion.

Fordi netforbindelsen på en festivalplads ikke kan garanteres, skal det midlertidige site kunne fungere uden kontakt til den autoritative instans. Det løses ikke med løbende tovejssynkronisering, men med to hændelser:

1. **Udlæsning** før afgang — en flytning fra faste opbevaringssteder til det midlertidige site, med en pakkeliste.
2. **Afregning** ved hjemkomst — én opgørelse af hvad der kom hjem, hvad der blev forbrugt, og hvad der blev kasseret.

Derimellem registrerer stedet lokalt uden at røre den autoritative instans. Løbende synkronisering falder dermed bort som krav.

Afregningen er samtidig det sted hvor svindet opgøres: der findes en pakkeliste før og en optælling efter. Det gør midlertidige sites til det mest præcise datagrundlag for madspild i hele systemet.

### 8.5 Hvad det kræver af v1

Kun én ting, og den er allerede besluttet: aliaser og planer skal referere Bons egen varenøgle, aldrig et Grocy-id (invariant 4). Uden den er flere instanser umuligt, fordi autonumre ikke stemmer overens på tværs. Med den er resten additivt.

---

## 9. Uden for v1

- apply af grundpakke til tom server
- foto og PDF som kilde (OCR-fejl lander i kostprisgrundlaget og er svære at opdage)
- oprettelse af barcodes og leverandørbindinger
- automatisk udfyldning af CO2, allergener og næringsstoffer
- udbyttefaktorer mellem rå og tilberedt vare
- forslag til substitution ud fra klimaaftryk

---

## 10. Åbne punkter

1. **Excel-formatet.** Kræver et faktisk eksempel på et af de eksisterende regneark, før adapteren kan specificeres.
2. **Klassificering.** Kød, grønt, korn og så videre kan afgøres fra navnet og er billig at foreslå. Forslag gemmes som ubekræftet; taksonomien selv hører til berigelsessporet.
3. **Tærskel for fuzzy-match.** Fastlægges empirisk på et sæt kendte opskrifter frem for at gættes.
4. **Densitetstabel.** Start med de mest almindelige råvarer og udvid efter behov. Skal ligge i Bon, ikke i koden.
5. **Ophavsret.** Opskrifter hentet fra websider kan bruges internt. De må ikke indgå i en grundpakke der distribueres til andre virksomheder — den må kun indeholde egne opskrifter.
6. **Aliaslagring ved bånd B.** Gemmes et alias automatisk når et forslag bekræftes, eller kun ved et eksplicit valg mellem flere kandidater? Mockuppen gør det i dag inkonsekvent.
7. **Krydsnavngivning som mellemløsning.** Er "Køl, Amager"-mønsteret acceptabelt hos en flerlokationskunde indtil den egne lagerengine er klar, eller udskyder det den kundetype til efter v3?
