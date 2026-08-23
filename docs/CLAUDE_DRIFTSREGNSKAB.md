# CLAUDE_DRIFTSREGNSKAB.md

> **Status: Payload verificeret (2. juni 2026) · klar til implementering.**
> Smartplan worklog/jobtype-payloadet er bekræftet direkte mod API'et (se §5a). Det afgørende
> udfald: objektet bærer **kun timer** — ingen sats/beløb/løntype — så `wage_rates`-tabellen
> (§9) er obligatorisk. Løn ligger **per medarbejder**, samme sats uanset jobtype. Alle åbne
> beslutninger er nu lukket; specen er klar til Claude Code.
> Diagnostik-script: `scripts/dump-worklog-payload.js` (genbrugeligt mod prod-kontoen).
> Mockup-reference: `driftsregnskab_mockup_v1.html` (dag: realiseret/forecast + belastningstidslinje), `driftsregnskab_mockup_v2.html` (periode: drift-trend, kapacitetsrate, per-medarbejder)

---

## 1. Formål

Et dagsbaseret driftsregnskab i Office, der kombinerer data vi allerede har (omsætning, vareforbrug, levering fra bonner) med løn fra Smartplan. To tidsretninger:

| Mode | Bemanding fra | Bonner fra | Spørgsmål |
|------|---------------|------------|-----------|
| **Realiseret** | faktiske worklogs (arkiveret) | leverede bonner | tjente vi penge i går? |
| **Forecast** | planlagte vagter | bookede bonner | er vi bemandet til det vi har solgt? |
| **Scenarie** (sidespor, parkeret) | tastet manuelt | tastet manuelt | *kan* vi — og betaler det sig? |

Smartplan arkiverer vagtplanen når dagen er omme → realiseret er fast. Forecast ændrer sig hver gang en bon kommer ind.

---

## 2. Placering

Office-sidebar → **ØKONOMI → Driftsregnskab** (samme gruppe som Opskrifter & priser).
View-fil: udvidelse af `office/views/reports.js` (eller egen `office/views/drift.js` hvis reports bliver for stor).
Desktop, informationstæt. Rolle-gated: kun office/ejer (løn er følsom data).

---

## 3. Moms-doktrin

Alt i driftsregnskabet er **ex moms** — det er en omsætnings-/resultatanalyse, ikke cashflow.
- Omsætning: ex moms (`bon_lines` → ex-moms-basis)
- Vareforbrug: `cost_price` er allerede ex moms
- Løn: **ingen moms overhovedet** — løn-tallet har intet med moms at gøre. Løn-kortet
  viser derfor ikke "ex moms"; i stedet vises den rå brutto-løn med småt under det tillagte tal.
- Øvrige figurer labels eksplicit "ex moms"

### Løntillæg (reel arbejdsgiveromkostning)

Satserne i `wage_rates` (migration 088) er medarbejderens **bruttoløn** — den rå løn FØR
arbejdsgiverens tillæg. Den reelle lønomkostning er højere: feriepenge (~12,5 % for timelønnede),
ATP-arbejdsgiverandel og evt. pension lægges oveni. (AM-bidrag og A-skat trækkes FRA bruttoløn og
er allerede inde i satsen — de lægges IKKE til.)

- `settings.labor_overhead_pct` (migration 093, default `0`) = procent-tillæg ganget på den rå
  brutto-løn. `computeDay()` i `routes/drift.js` summerer rå brutto pr. medarbejder (`timer × sats`),
  ganger summen med `(1 + pct/100)`, og bruger det tillagte tal i `labor_ex_moms`, `driftsresultat`
  og `loenandel_pct`. Den rå sum returneres som `labor_raw_ex_moms`.
- Redigeres i **Settings → Løn & jobtyper → Løntillæg** (admin-only). `0` = vis rå bruttoløn uændret.
- Bemandings-tabellens "Kostpris"-kolonne viser rå `timer × sats` pr. medarbejder; tabel-footeren
  afstemmer rå løn → tillæg → total.
- **Frosne dage** (§7) bevarer datidens opgørelse (uden `labor_raw_ex_moms`/tillæg) indtil de
  genberegnes via admin-genberegning — så historiske regnskaber ikke skrider når procenten ændres.

---

## 4. Datakilder

| Linje | Kilde | Ny lagring? |
|-------|-------|-------------|
| Omsætning | `bon_lines.line_total` (ex moms) | nej — udledt |
| Vareforbrug | `bon_lines.cost_price` (fra Grocy) | nej — udledt |
| Levering | leveringsmodul, kostpris | nej — udledt |
| **Løn** | `laborAdapter.getLabor(dato, mode)` = timer × sats fra `wage_rates` | **ja — `wage_rates` per medarbejder (§9)** |
| Belastning/time | `bons.delivery_time` + `bon_lines.quantity` | nej — udledt |
| Bemanding/time | Smartplan: `attendance_*` (realiseret) / `planned_*` (forecast) — se §5/§5a | snapshot (se §7) |

Det meste er en **forespørgsel**, ikke en tabel. Kun løn og evt. dagsnapshot er ny persistens.

---

## 5. laborAdapter — abstraktionen der gør payloadet ligegyldigt

Samme mønster som `grocyAdapter`. Resten af systemet kalder kun:

```
getLabor(dato, mode) → [{ employee_id, employee_name, jobtype_uuid, jobtype_title,
                          role_class, start, slut, timer, sats, kostpris }]

  mode = 'realiseret'  → bruger attendance_* (faktisk fremmøde, kun arkiverede dage)
  mode = 'forecast'    → bruger planned_*    (planlagt vagt; eneste data på fremtidige dage)
```

**Begge dage-typer skal kunne læses** (arkiverede *og* planlagte) — adapteren kombinerer
worklogs (fortid, bærer både `planned_*` og `attendance_*`) og shifts (fremtid, kun
`planned_*`), præcis som `smartplanAdapter.getShifts()` allerede gør. `mode` styrer hvilket
tidssæt der bruges til `timer`/`kostpris`.

**§5 AFKLARET (2. juni 2026): worklog-objektet bærer KUN timer.** Verificeret direkte mod
Smartplan-API'et — der er hverken sats, beløb eller løntype på objektet, og intet
løn-endpoint findes (`/salarytypes/`, `/wages/`, `/users/`, `/employees/` → alle 404; kun
`/jobtypes/` svarer, men det bærer kun `title`/`uuid`/`alive`, ingen sats). Vi lander altså
i det dyreste af de tre planlagte udfald:

| Udfald (worklog-objektet indeholder) | Adapter-implementation | Gælder os? |
|--------------------------------------|------------------------|-----------|
| Beløb eller sats pr. worklog | brug feltet direkte — bedst | nej |
| Kun løntype-ID | hent løntyper-endpoint, map ID → sats | nej (intet endpoint) |
| **Kun timer** | **join timer mod lokal `wage_rates`-tabel** | **JA** |

**Løn-model (bekræftet af Leif):** satsen ligger **per medarbejder** og er **den samme uanset
jobtype** (salg, assistent, bud — samme timeløn). Derfor:
- `wage_rates.smartplan_ref = owner.uuid` (medarbejder-niveau, **ikke** jobtype-niveau).
- `kostpris = timer × sats(medarbejder, gyldig på dato)` — én sats-opslag per medarbejder.
- `valid_from/to` (§9) bevarer historiske satser, så datidens regnskaber ikke skrider.

**Timer = fuld vagtlængde** (`*_shift_duration`, sekunder → timer) — **ikke** fratrukket pause.
Pause-felterne (`planned_break` / `attendance_break`) findes i payloadet hvis netto-timer
senere ønskes, men driftsregnskabet regner på fuld tid.

---

## 5a. Bekræftet Smartplan-payload (2. juni 2026)

Dumpet via `scripts/dump-worklog-payload.js` mod `/accounts/{uuid}/worklogs/`. Relevante felter:

**Worklog-objekt (arkiveret vagt):**

| Felt | Eksempel | Brug |
|------|----------|------|
| `owner.uuid` | `86ed161c-…` | medarbejder-ID → **wage_rates-nøgle** |
| `owner.first_name` / `last_name` / `initials` | Simon / Jensen / SJ | visning |
| `jobtype.uuid` | `4e3389e1-…` | **rolle-mapping-nøgle (§6a)** |
| `jobtype.title` | `Salgsassistent` | visning (IKKE unik — se note) |
| `display_date` | `2026-05-12` | dato |
| `planned_start_dt` / `planned_end_dt` | `…T08:00:00` / `…T14:00:00` | **forecast** |
| `planned_break` / `planned_shift_duration` | `0` / `21600` (sek.) | forecast (pause + fuld tid) |
| `attendance_start_dt` / `attendance_end_dt` | `…T08:00:00` / `…T14:00:00` | **realiseret** |
| `attendance_break` / `attendance_shift_duration` | `0` / `21600` (sek.) | realiseret (pause + fuld tid) |
| `attendance_status` | `attended` | filtrér fravær (no-show o.l.) |
| `location.title` | `Ristet Rug` | evt. multi-lokation-filter |

- **Varighed er i sekunder** (`21600` = 6 t). `timer = *_shift_duration / 3600`.
- **`jobtype.title` er IKKE unik** — der findes fx tre forskellige "ZOO"-jobtyper med hver sit
  `uuid`. Map altid på `jobtype.uuid`, brug `title` kun til visning.
- **Intet løn-felt nogen steder** — hverken på worklog eller jobtype. Derfor `wage_rates` (§9).
- Shifts (fremtidige vagter) har samme `planned_*`-struktur men **ingen `attendance_*`** —
  derfor er `forecast` det eneste mulige mode for fremtidige dage.

---

## 6. Outputs fra modulet

Driftsregnskabet eksponerer disse som genbrugelige tal (ikke kun visning):

1. **Driftsresultat** = omsætning − vareforbrug − levering − løn (ex moms)
2. **DB%** = driftsresultat / omsætning
3. **Kapacitetsrate** = `enheder ÷ mandetimer` — **enheder pr. mandetime**
   - Operationelt nøgletal, ikke økonomisk
   - **Skal eksponeres som et opslagbart tal**, ikke kun vises
   - Bruges af: forecast (hvor mange mandetimer kræver X enheder), kategori-overblik, og senere scenarie-/event-værktøjet
   - Beregnes pr. dag og bør kunne aggregeres til et historisk gennemsnit (evt. pr. kategori, hvis enheder kan splittes)

   **To beregningsmetoder — flad er autoritativ:**

   | Metode | Formel | Status |
   |--------|--------|--------|
   | **Flad total** | total enheder ÷ total mandetimer (pr. dag/person/hold) | **primær — den autoritative rate** |
   | Time-vægtet | enheder fordelt time-for-time efter belastning × bemanding den time | sekundær, valgfri udfoldning |

   Flad total er det tal Leif allerede bruger og kan sanity-tjekke i hovedet — det er sandheden. Time-vægtet er en bonus systemet kan lave (fordi det ikke regner i hovedet); den viser *hvornår på dagen* belastningen lå, men erstatter aldrig den flade rate som primær. UI: vis flad som overskrift, time-vægtet bag en udfoldning.
4. **Lønandel** = løn / omsætning (kun produktionsroller — se §6a)
5. **Vareforbrug pr. enhed**
6. **Lønprocent** = løn / omsætning — hele driftslønnen (ekskl. bud, **inkl.** `other`-roller og løntillæg)
7. **Råvareprocent** (vareforbrugsprocent) = vareforbrug / omsætning

> **6+7 er branchens to standard-nøgletal** og vises som en linje direkte på Løn- og
> Vareforbrug-pillen i både dag-, uge- og periodevisning — dér hvor kronebeløbet står,
> så man ikke skal regne selv. I uge-/periodevisningens **dag-for-dag-tabel** står de
> som kolonnerne `Vare%` og `Løn%` umiddelbart efter hver sin kronekolonne (dæmpet:
> beløbet er stadig det primære), så en skæv dag kan ses uden at regne.
>
> **Tabellen har bevidst ingen total-række.** Pillerne øverst ER periodens totaler, og
> en samlet procent er IKKE gennemsnittet af dagenes procenter — den skal regnes på
> periodens samlede omsætning. To tal der ligner hinanden, men afviger, ville invitere
> til fejllæsning. Dage uden omsætning viser `—`, ikke `0 %`.
>
> **Forskellen på 4 og 6 er bevidst.** Lønandel (4) er snæver — kun produktionsroller —
> og bruges til effektivitet. Lønprocenten (6) måler præcis det tal pillen selv viser,
> så pille og procent altid stemmer. Derfor hedder nøgletallet nu
> "Lønandel (kun produktionsroller)" i UI'et: de to må gerne afvige.
>
> **Begge udledes i frontenden** (`_drShareOf` i `office/views/drift.js`) af tal der
> allerede ligger i svaret — ikke som nye API-felter. Grunden: afsluttede dage fryses
> som `data_json` i `labor_day_snapshot`, og et nyt server-felt ville mangle i alle
> eksisterende snapshots. Det er et rent forhold mellem to tal der begge allerede er
> ex moms — ingen momsregning i frontenden (jf. `BON_V2_PRINCIPPER.md` §6b).

### Måltal og farvekodning (migration 145)

Procenterne farves mod et måltal. Lavere er bedre for begge:

| Tilstand | Betingelse | Visning |
|---|---|---|
| På/under mål | `pct ≤ mål` | grøn |
| Lige over | `mål < pct ≤ mål + tolerance` | gul + ▲ |
| Klart over | `pct > mål + tolerance` | rød + ▲ |

| Setting | Default | Betyder |
|---|---|---|
| `target_labor_pct` | **tom** | Måltal for lønprocent |
| `target_food_cost_pct` | **tom** | Måltal for råvareprocent |
| `target_pct_tolerance` | `2` | Procentpoint over målet der stadig er gult |

**Tom værdi = ingen farvekodning.** Det er med vilje: et måltal er husets eget (det
afhænger af koncept, priser og bemanding), og en default ville være et gæt der lignede
en anbefaling. Procenterne vises stadig — de er bare neutrale indtil nogen har taget
stilling. Sættes i **Settings → Løn & jobtyper → Måltal** (admin).

**▲ ved overskridelse.** Farve alene bærer ikke signalet (farveblindhed, print, skærm i
sollys), så gul og rød får også et mærke. Titel-teksten på tallet siger hvad målet er.

**Måltal fryses ALDRIG ind i en dagsopgørelse.** `readTargets()` i `routes/drift.js`
læser dem ved hvert kald og lægger dem på svaret *uden om* `data_json`. Et måltal er en
målestok, ikke et regnskabstal: fryses det, kan man ikke se gamle dage i lyset af det man
styrer efter i dag. Til sammenligning fryses `labor_overhead_pct` netop fordi det ER et
regnskabstal (§3) — de to må ikke behandles ens.

**Tolerance `0` er et gyldigt valg** ("ingen gul zone — alt over målet er rødt), mens et
*måltal* på `0` betyder "intet mål". Derfor har de to hver sin nedre grænse i
`readTargets()`; ellers ville tolerance 0 tavst blive til default 2.

### Procent-trend i uge/periode (`_drPctTrend`)

Under søjlediagrammet over driftsresultat ligger en kurve med løn% og råvare% pr. dag +
måltallet som stiplet linje. Søjlerne viser kroner; kurven viser om *forholdet* skred —
en dag kan give overskud og alligevel have løbet løbsk på lønnen.

- Inline SVG, intet chart-bibliotek (stack-reglen: ingen build-step).
- **Dage uden omsætning bliver et hul i kurven**, ikke et 0-punkt — 0 % råvareforbrug
  ville ligne en fantastisk dag i stedet for en lukkedag.
- **Y-aksen starter i 0.** Et afkortet nulpunkt ville forstørre små udsving til drama.
  Det gør kurven fladere, men tallene bag står i tabellen lige under.
- **Prikkerne er HTML oven på svg'en**, ikke `<circle>`: `preserveAspectRatio="none"`
  strækker viewBox'en vandret for at fylde bredden, og det ville trække cirkler ud til
  ovaler. De bærer samtidig måltals-farven, så en enkelt skæv dag ses i kurven.

---

## 6b. Produktions-sammentælling ("hvad blev der lavet")

`GET /api/drift/items?from=&to=&mode=` — antal pr. **varekategori** for dagen eller
perioden, med varerne bag hver kategori bag et klik. Dagsvisningen kalder med
`from = to = dagen`. Vises både i dag- og uge-/periodevisning.

To tal pr. række, fordi de svarer på hver sit spørgsmål:

| Felt | Betyder |
|---|---|
| `quantity` | antal stk på bon-linjerne — "hvor mange lavede vi" |
| `units` | boks-aware enheds-bidrag (`bonUnitsExpr`) — "hvad tæller det som" |

De er ens for almindelige varer og afviger kun hvor en vare tæller som flere enheder (en
boks med 3 slidere tæller 3), eller hvor kategorien slet ikke tæller med i Enheder.
**Kategorier der ikke tæller (emballage, levering …) vises dæmpet frem for at blive
skjult** — køkkenet har stadig pakket dem. Samme greb som bon-kortets sammentælling.

Ens varer slås sammen på tværs af bonner, og `special_request` ignoreres: "Grisen uden
tomat" er stadig en Gris når køkkenet tæller. Samme regel som bon-kortets VARE-visning.

**Beregnes live, ikke i snapshot.** Det er en optælling af bon-linjer, som ligger i basen
i forvejen og ikke skrider når Smartplan ændrer sig. Hentes i et **separat kald** efter
dagsresultatet, så en tung optælling aldrig forsinker de tal folk kommer efter — og så en
fejl i optællingen ikke kan vælte hele regnskabet.

> **SQL-fælde:** `GROUP BY` skal stå på de rå kolonner (`bl.category`), ikke på
> output-aliasset — `category` findes begge steder, og SQLite kalder det tvetydigt.
> Konsekvensen er at NULL og `''` bliver hver sin række; de samles i JS, hvor de begge
> lander under "(uden kategori)".

---

## 6a. Roller: bud holdes ude af driftens effektivitetstal

Bud (leveringsservice) afregnes **separat** og hører derfor ikke til i driftsregnskabets effektivitets- og løntal:

| Tal | Indgår bud? | Hører hjemme |
|-----|-------------|--------------|
| Kapacitetsrate (enh/mandetime) | **nej** | Driftsregnskab |
| Løn vs. køkkenets omsætning | **nej** | Driftsregnskab |
| Hvilke bude kørte, antal ture, timer, hvornår | ja | **Leveringsmodulet** (buddenes egen oversigt/afregning) |

Samme `getLabor()`-data, filtreret på rolle:
- Driftsregnskab kalder `getLabor(dato)` og bruger **kun produktionsroller** (kok o.l.) til rate og lønandel.
- Leveringsmodulet kalder samme adapter men bruger `rolle = bud` til buddenes oversigt.

Konkret: `getLabor()` skal returnere `role_class`, så begge views kan filtrere. Driften ekskluderer bud; leveringen isolerer dem. Buddenes timer/ture er reel data Leif altid kigger på — den bor bare i leveringsmodulet, ikke i driften.

**Rolle-mapping (afklaret): Smartplan-jobtype → role_class.** Smartplan har intet rolle-felt —
**jobtypen er rollesignalet**. Bud ligger spredt på flere jobtyper (Budcykel, Cykel Blå Zone,
Cykel Event, Cykel Kødbyens Mad og Marked, Cykel Strøget Rød Zone, Bil Event …), så en
hardkodet titel-test ville lække bud-løn ind i driftens rate. Mapping skal være **eksplicit og
konfigurerbar**, nøglet på `jobtype.uuid`:

```
jobtype.uuid → role_class ∈ { production | delivery | other }
```

- `production` → indgår i kapacitetsrate + lønandel (kok/salg/assistent).
- `delivery`   → ekskluderet fra driften, isoleret i leveringsmodulet (alle bud-jobtyper).
- `other`      → hverken/eller (fx Forretningsudvikling) — vises men tæller ikke i rate/lønandel.

> **VIGTIGT:** der findes allerede roller i Settings, men de er **ikke nødvendigvis de samme**
> som Smartplans jobtyper. Antag derfor IKKE 1:1 — mapping er et selvstændigt opslag
> (`jobtype.uuid → role_class`), seedet fra de 18 nuværende jobtyper og redigerbart i Settings.
> Nye/ukendte jobtyper defaulter til `other` og flagges, så de ikke tavst forsvinder ud af
> rate-beregningen.

---

## 7. Frys-beslutning

| | Live-hent | Snapshot |
|---|---|---|
| I dag / denne uge | ✅ altid frisk | overkill |
| Afsluttede dage | ⚠️ tal kan skride hvis Smartplan ændres | ✅ stabilt |

**Beslutning:** live for nutid/fremtid; **frys ved dagsafslutning** (statusovergang) til en lille `labor_day_snapshot`. Afsluttede perioder bliver dermed urørlige uanset senere ændringer i Smartplan.

---

## 8. Belastnings-tidslinje

To udledte tidsserier oven på en dags-timeakse:
- **Søjler:** enheder der skal være klar/leveres pr. time (fra leveringstider)
- **Linje:** mandetimer på arbejde pr. time — **kun produktionsroller** (`getLabor()` filtreret, jf. §6a; bud udeladt)

Divergens markeres (høj belastning + lav bemanding = underbemandet). Ingen ny lagring.

---

## 9. wage_rates-tabel (OBLIGATORISK — payloadet giver kun timer)

Bekræftet i §5: Smartplan bærer ingen sats. Denne tabel er derfor påkrævet, ikke betinget.
Løn er **per medarbejder**, så `smartplan_ref = owner.uuid`.

```sql
-- wage_rates
id            INTEGER PRIMARY KEY
smartplan_ref TEXT      -- = Smartplan owner.uuid (medarbejder, IKKE jobtype)
employee_name TEXT      -- denormaliseret cache til visning/admin
hourly_rate   REAL      -- ex moms, samme sats uanset jobtype
valid_from    TEXT      -- 'YYYY-MM-DD'
valid_to      TEXT      -- NULL = gældende; ellers så historiske regnskaber bruger datidens sats
```

- `valid_from/to` er ufravigelig: ellers ændrer en lønstigning historiske tal med tilbagevirkende
  kraft. Opslag = den række hvor `dato` ligger i `[valid_from, valid_to)`.
- **Manglende sats = eksplicit hul, ikke 0.** Hvis en medarbejder ikke har en gyldig sats på
  datoen, skal `getLabor()` markere rækken (`rate_missing: true`) så UI kan vise "⚠ løn
  ufuldstændig" frem for et selvsikkert for-lavt driftsresultat.
- Satser vedligeholdes i Settings (rolle-gated, løn er følsom data). Seed fra de medarbejdere
  der optræder i Smartplan-worklogs.

---

## 10. Sidespor (parkeret): scenarie-/event-værktøj

"Skal vi stille op og sælge mad et sted?" → samme motor, men inputs tastet i hånden.
- Operationelt først: *kan N mand nå X enheder på T timer?* (bruger kapacitetsraten fra §6)
- Derefter økonomisk: omsætning − vareforbrug − transport − løn

**Designkonsekvens nu (gratis senere):** byg motoren så den tager **normaliserede inputs** (enheder-pr-time, labor-rækker, rate) uanset kilde. Så er scenarie-mode blot en tredje input-kilde — ingen ny motor. Implementeres ikke nu.

---

## 11. Næste skridt

1. ~~**Bror:** verificér worklog/vagt-payload (§5).~~ ✅ **Udført 2. juni 2026** (se §5/§5a) —
   udfald: kun timer, løn per medarbejder. Diagnostik-script: `scripts/dump-worklog-payload.js`.
2. **`wage_rates`-migration** (§9) + Settings-UI til satser (rolle-gated). Seed fra medarbejdere
   i Smartplan-worklogs.
3. **`role_class`-mapping** (§6a): tabel/setting `jobtype.uuid → {production|delivery|other}`,
   seedet fra de 18 jobtyper, redigerbart i Settings. Ukendt jobtype → `other` + flag.
4. **`laborAdapter`** (samme cache-mønster som `grocyAdapter`):
   `getLabor(dato, mode)` → læser både arkiverede (attendance) og planlagte (planned) dage,
   join mod `wage_rates`, fuld vagtlængde (`*_shift_duration / 3600`), `rate_missing`-flag.
5. **Kapacitetsrate (§6)** skal genbruge `getUnitCountCategories()` (migration 070) som
   definition af "enheder" — ellers divergerer systemets rate fra Leifs hoved-sanity-tjek.
6. **`labor_day_snapshot`** + frys-trigger (§7) — vælg cron vs. lazy-frys ved første visning.
7. Færdiggør view (`office/views/drift.js`) → Claude Code.

## Smartplan: grænser og fejl

Smartplan tillader **60 kald i minuttet og 2000 i døgnet**. Det er minut-grænsen
der binder: API'et paginerer, så ét logisk opslag ("hent et halvt år") er 10-45
HTTP-kald afsendt i træk.

**En afvisning forlænger sig selv.** Målt 23. august 2026 voksede `availableIn`
fra 161 til 243 sekunder, fordi vi blev ved med at spørge mens vi var blokeret.
En throttling kan derfor holde sig selv i live så længe nogen klikker rundt i
driften — og hele tiden se ud som om vagtplanen er tom.

Derfor tre ting i `services/smartplanAdapter.js`:

1. **Glidende egen grænse** (50/min, 1900/døgn — margin ned til Smartplans).
   Vi venter selv når vi nærmer os, i stedet for at blive afvist. Et burst under
   grænsen forsinkes ikke, så normal brug mærker intet.
2. **Karantæne efter 429 med eksponentiel backoff**: vi holder helt op med at
   spørge til det tidspunkt Smartplan selv oplyser — og aldrig kortere end vores
   egen trappe: **60 → 120 → 240 → 480 sek**, med loft ved 15 minutter. Et
   vellykket kald nulstiller trappen.

   > ⚠️ **Nulstillingen skal ske når et OPSLAG er lykkedes, ikke når en SIDE er.**
   > Lå den pr. side, nulstiller en delvist vellykket paginering — side 1 ok,
   > side 2 afvist — trappen hver gang, og backoff'en står på 60 sekunder for
   > evigt. Det skete i drift 23. august: afvisningerne steg (12 → 14 → …)
   > mens ventetiden blev ved med at være ét minut. Dækket af en navngiven
   > regressionstest.

   Trappen er nødvendig fordi vi sender ét prøve-kald når karantænen udløber
   (den eneste måde at opdage at blokeringen er hævet). Med fast ventetid bliver
   det et evigt drop af prøve-kald der holder blokeringen åben — præcis det der
   skete under fejlsøgningen 23. august.

   Strikes tælles pr. **karantæne-periode**, ikke pr. kald: ét opslag sender to
   kald parallelt (shifts + worklogs), så begge rammer 429 samtidig. Uden den
   skelnen ville to mislykkede visninger give otte minutters karantæne.

   Ventetiden vises som **klokkeslæt**, ikke "om N sekunder" — beskeden bliver
   stående på skærmen, og et relativt tal er forkert to minutter senere. Settings
   tæller ned og stopper så med en **"Prøv igen"-knap**.

   > **Ingen automatisk genoptagelse — med vilje.** En side der prøver igen af
   > sig selv, gør en glemt fane til en robot der banker på Smartplan hvert par
   > minutter, også når ingen kigger. To åbne faner = to forsøg pr. periode, og
   > hvert afvist forsøg forlænger blokeringen. Et forsøg skal være noget et
   > menneske beder om. Intet andet i systemet henter fra Smartplan uden at
   > nogen har klikket — ingen cron, ingen SSE-drevet genindlæsning.
3. **Ingen tavse fejl.** Adapteren returnerer aldrig en tom liste for en fejl —
   se `npm run test:smartplan-honesty`. Det er dét der gør at driftens og
   eventets frys-værn kan fyre; ellers kan "0 kr løn" blive frosset permanent.

Målt forbrug pr. handling (sidestørrelse 100):

| Handling | Kald |
|---|---|
| Driftens dagsvisning | 6 |
| Klik gennem 7 dage | 18 |
| Ugevisning | 6 |
| Kalender, én måned | 8 |
| Importér løn-CSV | 20 |
| Settings → Smartplan (180 dage) | 24 |

> **Ukendt:** Smartplans sidestørrelse. Ved 100 er tallene ovenfor rigtige; ved
> 50 fordobles de. Derfor er diagnose-vinduet 180 dage og ikke et helt år — et
> år ved sidestørrelse 50 ville alene sprænge minut-grænsen, altså en garanteret
> 429 ved hvert eneste Settings-besøg. Mål sidestørrelsen med ét kald når
> Smartplan svarer igen (`results.length` på side 1) og justér hvis nødvendigt.

Forbruget vises i **Settings → Integrationer → Smartplan**, sammen med antal
afvisninger og hvornår senest. Tælleren er in-memory og nulstilles ved genstart.
