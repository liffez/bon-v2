# CLAUDE_LAGEROPTAELLING.md

**Status:** v0.1 — udkast, afventer beslutninger i §11
**Ejer:** Leif
**Berører:** `shared/inventory_check.js`, lageroversigten, Grocy-userfields på `products`, nye Bon-tabeller
**Relaterede specs:** `CLAUDE_INDKOB_ASIS.md`, `CLAUDE_PRODUKTION.md`, Spor B (#272/#270, Grocy-datarunden #372)

---

## 1. Formål

Gøre lageroptælling til noget der bliver gjort, frem for noget der bliver udskudt.

To ting skal skilles ad, fordi de har modsatte krav:

- **Lageroversigten** svarer på "hvad har vi?". Den må gerne være tæt og passiv. Den virker i dag, og folk bruger den.
- **Optællingen** svarer på "hvad skal jeg gøre nu?". Den skal fjerne beslutninger fra den der står ved fryseren, ikke tilføje dem.

Al friktion i dag ligger i, at optællingslisten præsenterer 28 ligeværdige valg og lader mennesket sortere.

## 2. Problemet i dag (observeret)

Fra frost-1-listen, 28 varer:

1. Langt de fleste står med rødt **"På lageret: 0 Kilo"** og "Sidst: 4. apr." Skærmen ligner 28 fejl, ikke en opgave.
2. Flere varer i listen hører fysisk til andre steder (Smør `køl-5`, Rugbrødsrester `køl-4`, Lufttørret Skinke `køl-2`). Fallbacket i `_icVisibleInUnit` trækker dem ind via Grocys `location_id`. Bliver man bedt om at tælle noget der ligger i et andet rum, mister hele listen troværdighed.
3. En stor del af nullerne er ikke tælleopgaver, men datafejl — de samme som Spor B/#372 allerede har kortlagt: ~27 produkter med lager på en forbrugslokation der står 0, 5 uden købs→lager-konvertering, ~30 uden pris.
4. Sorteringen er efter hastende, så listen åbner på det mest uinteressante der findes (ærter, Cookie dough, Topping til Muffin).
5. `HverDag` skal sættes i hånden pr. vare og bliver aldrig vedligeholdt.

## 3. Grundmodellen: tre akser

Tællelisten er i dag ét spørgsmål. Den er i virkeligheden tre, og de skal besvares hver for sig:

| Akse | Spørgsmål | Kilde |
|---|---|---|
| **Medlemskab** | Står varen i denne fysiske enhed? | `physical_units` + `LastCheckedUnit` (findes) |
| **Udvælgelse** | Skal den tælles nu? | Driftscore (§5) — erstatter `HverDag` |
| **Rækkefølge** | Hvornår møder jeg den på hylden? | Indlært fra sidste optælling (§8) |

I dag bruges svaret på "skal den tælles nu" til alle tre. Det er kernefejlen.

## 4. Datamodel

### 4.1 Rettelse i eksisterende model

`LastCheckedUnit` gemmer enhedens **navn**, mens `physical_units` har rigtige id'er.

- Omdøbes en enhed, falder medlemskabet stille tilbage til `location_id` for alle varer der var rullet derhen.
- Arkiveres en enhed, forsvinder dens varer helt ud af `_icVisibleInUnit` uden besked.

**Beslut:** gem `physical_unit_id` i stedet for navnet, eller skriv userfeltet om ved rename/arkivering. Migrering: match på navn én gang, log det der ikke matcher.

### 4.2 Nye Bon-tabeller

```
stock_count_state          -- én række pr. produkt, opdateres natligt
  product_id               (Grocy id)
  last_counted_at
  last_counted_qty
  consumed_since           -- lagerenhed, siden last_counted_at
  typical_qty              -- se §11, åben beslutning
  drift                    -- consumed_since / typical_qty
  value_at_risk            -- drift * kostpris * typical_qty  (ABC-sortering)
  deviation_history        -- JSON: sidste N afvigelser i procent
  cleanup_flags            -- JSON: hvilke datafejl varen har (§6)

stock_counts               -- selve optællingen som objekt
  id, location_id, physical_unit_id, started_at, finished_at, user_id

stock_count_lines
  count_id, product_id
  counted_qty, expected_qty, deviation_pct
  count_qu_id              -- hvilken enhed der blev talt i
  sort_index               -- rækkefølgen varen faktisk blev talt i
```

`stock_count_state` beregnes i et natligt job, ikke ved render. Optællingsskærmen må aldrig vente på Grocys stock log.

**Forbrugskilden skal verificeres mod grocytest** før der bygges: hvilke `transaction_type` i `stock_log` tæller som forbrug (consume, og hvad med produktion, spild, og korrektioner fra tidligere optællinger?). En optællingskorrektion må ikke selv tælle som forbrug — så driver varen af sig selv.

## 5. Udvælgelse: drift i stedet for kalender

`HverDag` måler kalendertid. Men et lagertal bliver ikke forkert af at der går tid — det bliver forkert af at der løber varer igennem. Hver bevægelse lægger en lille fejl oveni: forkert udbytte, en faktor der er 28 i stedet for 35 g, en portion der ikke blev tastet. Fejlen akkumulerer **pr. kilo der passerer**, ikke pr. dag.

Det betyder også, at frostvarer og tørvarer med lang holdbarhed synker til bunds af sig selv — hvilket er det rigtige. En pose ærter der ikke er rørt siden april driver ikke.

```
drift = consumed_since / typical_qty
```

Grupper (erstatter `_icGroupOf`):

| Gruppe | Betingelse |
|---|---|
| 0 Forfalden | `drift >= 1.0` — en hel beholdning er løbet igennem siden sidst |
| 1 Aldrig talt | `last_counted_at` er tom **og** varen har haft bevægelse |
| 2 Snart | `drift >= 0.7` |
| 3 Rolig | resten |

Tre sikkerhedsnet oveni:

- **Loft:** `dage_siden_sidst > MAX_DAGE` (forslag: 90) → forfalden uanset drift. Selv en vare der ligger helt stille skal ses en gang imellem.
- **Risikohistorik:** har varens sidste optællinger afveget mere end tolerancen, ganges drift med en faktor (forslag: 1,5). Varer der plejer at skride, skal tælles oftere. Det er risikobaseret optælling, som de voksne systemer kalder det.
- **Manuel override:** `HverDag` bevares som "tæl mindst hver X dage" for de få varer hvor mennesket ved bedre. Den er ikke længere motoren, kun en undtagelse.

**Sortering inden for gruppe:** `value_at_risk` faldende — kroner i risiko, ikke kilo. Kostprisen findes allerede (Hørkram-priser, §2 i Spor B). Det giver rigtig ABC uden at nogen skal taste noget.

**Holdbarhed er ikke en tællegrund.** Udløb er en selvstændig alarm på lageroversigten. Bland dem ikke sammen — de kræver to forskellige handlinger.

## 6. Oprydningsbakken

Datafejl skal ud af tællelisten. De er ikke tælleopgaver, og de er hovedårsagen til de røde nuller.

En vare ryger i **"Ryd op"** frem for i tællelisten når:

- den har lager på en lokation uden fysiske enheder (fx en forbrugslokation — #372)
- den mangler købs→lager-konvertering
- den mangler pris
- den står på 0 og aldrig har haft en bevægelse (er den overhovedet i brug?)
- den har ingen varegruppe

Bakken viser et tal der bliver mindre. Oprydningen fra Spor B får dermed et sted at bo hvor fremdriften kan ses, og tællelisten bliver troværdig med det samme.

**Dette er fase 0 og skal bygges først.** Det er det billigste greb med den største effekt, og det kræver ingen ny beregningsmodel.

## 7. Optællingsskærmen

### 7.1 Kategorisektioner

Grupperne findes allerede (`01 Brød`, `02 Pålæg`, `03 Grønt`, …). Tællelisten bruger de samme sektioner, hver med egen fremdrift:

```
03 Grønt          3/7   ✓✓✓○○○○
```

Én liste med 28 har én sejr til sidst. Syv sektioner har syv, og et naturligt sted at stoppe uden at efterlade et rod. Det er dét der gør at folk begynder.

Grupperne `01–11` dækker kun det der kan stå på en bon. De 58 varer i `Lager varer` er interne og skal deles op — se §13.

**Undergrupper er ikke i v1** — behovet var i praksis flere grupper på samme niveau, ikke dybere. Skulle der senere blive brug for et hierarki, bygges det som egen tabel i Bon med `parent_id` og kobling på Grocy `product_id`, ikke som userfields. Det overlever Grocy-udskiftningen i v3.

### 7.2 Bekræft de tomme

Varer med `lager = 0` **og** `drift = 0` foldes sammen i én sektion:

```
Skulle være tomme (24)                     [Bekræft alle]
```

Ét tryk stempler dem alle med ny `last_counted_at`. Ingen inventory-postering — der er intet at ændre. Sektionen kan foldes ud hvis nogen vil se den igennem.

På frost-1 tager det 28 kort med tre knapper hver ned til omkring 5 rigtige tælleopgaver.

### 7.3 Rækkefølge

Inden for sektionen: `sort_index` fra sidste optælling i samme fysiske enhed. Er der ingen historik, faldes tilbage på `value_at_risk`. Efter én optælling passer listen til hylden, uden at nogen har sat noget op.

## 8. Blind optælling og tolerance (fase 4)

- **Blind:** skjul Grocys forventede tal mens der tastes. Ser man "0,89", skriver man 0,89 — og så er optællingen uden værdi. Afvigelsen vises bagefter.
- **Tolerance:** afvigelse under grænsen posteres stille. Over den øvre grænse beder skærmen om en gentagelse ("Tast igen") før den skrives. Grænser i Settings, ikke hårdkodet. Forslag: bagatelgrænse i kr. **eller** 5 %, gentælling over 20 %.
- Afvigelsen skrives til `deviation_history` og fodrer risikofaktoren i §5.

## 9. Gamificering

Beløn **dækning og rettidighed**:

- fremdrift pr. kategori og pr. enhed (§7.1)
- "Fryseren er 100 % talt denne måned"
- ubrudt stime af rettidige optællinger

Beløn **aldrig** hastighed eller "antal rigtige". Så begynder folk at skrive tal der ser rigtige ud, og hele systemet mister sit formål. Fremdriftsbjælken pr. sektion er sandsynligvis 80 % af effekten.

## 10. Faser

| Fase | Indhold | Afhænger af |
|---|---|---|
| 0 | Oprydningsbakken; datafejl ud af tællelisten | — |
| 1 | Kategorisektioner, fremdrift, "bekræft de tomme" | 0 |
| 2 | `physical_unit_id` i stedet for navn; stram medlemskab så andre rums varer ikke trækkes ind | — |
| 3 | `stock_count_state` + driftscore erstatter `HverDag` | Spor B §4 (enheder/priser på plads) |
| 4 | `stock_counts`/`stock_count_lines` som objekt + indlært rækkefølge | 3 |
| 5 | Blind optælling + tolerance | 4 |
| 6 | Dækning og stimer | 1, 4 |

Fase 0-2 kræver ingen ny beregning og kan køre parallelt med Spor B. Fase 3 forudsætter, at Grocy-datarunden (#372) er gennemført — driftscoren er kun så god som enhederne og priserne.

## 11. Åbne beslutninger (Leif)

1. **`typical_qty`** — nuværende lager, beholdning ved sidste optælling, eller glidende gennemsnit? Nuværende lager er billigst, men bliver ustabilt for varer der ofte står på nul.
2. **Tærskler** — 1,0 / 0,7 for forfalden/snart, og 90 dage som loft. Skal kalibreres på rigtige data før de låses.
3. **`HverDag`** — bevares som manuel undtagelse (anbefalet), eller ryddes helt?
4. **Nye varegrupper** — 30-serien i §13 skal godkendes, og de fem grænsetilfælde i §13.3 afgøres. Hvem opretter dem, og gøres det før eller efter fase 0.
5. **`LastCheckedUnit`-migrering** — omskriv userfelt ved rename, eller skift til id med engangsmatch på navn.
6. **Blind optælling** — tør vi det fra start, eller først når tallene er til at stole på?
7. **Spild og produktion** i forbrugsberegningen — tæller de med som drift?

## 12. Ikke i v1

- Undergrupper/kategorihierarki (§7.1)
- Stregkodescanning under optælling
- Flere personer der tæller samme enhed samtidig (SSE findes, men konfliktreglen er ikke tænkt igennem)
- Optælling på tværs af lokationer i én session
- `priorities` ligger stadig i localStorage og er per-device. Stjernemarkeringen er den ene bevidste menneskelige besked i sorteringen, og den ser den der tæller på den anden skærm ikke. Flyt den til serveren sammen med fase 4.

---

## 13. Varegrupper: opdeling af "Lager varer"

### 13.1 Princip

Rækkefølgen i optællingen og på lageroversigten styres af nummerpræfikset i gruppenavnet. Det giver to serier med hver sit formål:

| Serie | Formål |
|---|---|
| `01–11` | Salgsgrupper — det der kan stå på en bon. `10 Emballage` og `08 Drikkevarer` hører hertil: de dækker kun det der følger med ud til en levering. |
| `12–19` | **Holdes fri.** Plads til at salgsgrupperne kan vokse uden at støde ind i 30-serien. |
| `30–37` | Interne lagergrupper — råvarer og hjælpevarer der aldrig står på en bon. |
| `Lager varer` | Landingsplads. Bliver stående som den er; tømmes efterhånden som varerne fordeles, og fanger nye varer der oprettes uden gruppe. |
| `x-…` | Levering og service, uændret. |

### 13.2 Nye grupper

| Gruppe | Indhold | Ca. antal |
|---|---|---|
| `30 Krydderier og urter` | cayenne, chili, gurkemeje, hvidløgspulver, ingefær stødt, karry, laurbær, paprika, peber stødt, pebberkorn, salt, stjerneanis, timian, persille | 14 |
| `31 Bagning` | bagepulver, natron, sukker, vaniliesukker, kakao, chokoladeknapper | 6 |
| `32 Tørvarer og bælgfrugter` | bønnemix, kidney bønner, kikærter udblødt, ærter udblødt, majs, peanuts, rosiner | 7 |
| `33 Olie, eddike og smagsgivere` | oliven olie, trøffelolie, eddike, spicy chili sauce, tahini, pesto, honning, citronsaft, tranebærsaft | 9 |
| `34 Mejeri og alternativer` | salatost tern, vegansk yoghurt, kefir, havredrik | 4 |
| `35 Kød og fisk, rå` | kylling rå, svinekam | 2 |
| `36 Køkkenemballage` | condikasse 1/3/5 l, stegeposer | 4 |
| `37 Rengøring og hygiejne` | desinfektion, gulvvask, vaskemiddel, klude, toiletpapir, engangshandsker L/M/S | 8 |

Saft og havredrik hører i ingrediensgrupperne, ikke i `08` — de følger ikke med ud til en levering. Engangshandsker havner under hygiejne af samme grund.

`35` er lille med to varer, men vokser af sig selv og er den eneste gruppe hvor en fejltælling koster rigtige penge.

### 13.3 Grænsetilfælde (afgøres ved oprettelsen)

- **Condikasser** — bruges de til at sende mad af sted, hører de i `10 Emballage` frem for `36`.
- **Majs** — tør/dåse → `32`; frost → `03 Grønt`.
- **Persille** — frossen urt; `30` eller `03 Grønt`.
- **The-breve** — ikke en leveringsdrikkevare, passer heller ikke rent i `32`.
- **Rugbrødsrester, Tempty** — formentlig halvfabrikata; hører til i produktionen frem for i en lagergruppe.

### 13.4 Advarsel: omdøbning

En tidligere omdøbning af en varegruppe i Grocy gik galt. Det peger på kode der matcher på gruppe**navn** frem for id.

- At **flytte** en vare til en anden gruppe er ufarligt og er alt dette arbejde kræver.
- At **omdøbe** en eksisterende gruppe gøres ikke, før de steder er fundet. `Lager varer` beholder derfor sit navn.
- Det er samtidig et argument for, at kategoritræet på sigt bor i Bon med stabile id'er (§7.1).
