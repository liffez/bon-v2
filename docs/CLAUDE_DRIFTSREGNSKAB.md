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
- Løn: ingen moms
- Hver figur i UI labels eksplicit "ex moms"

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
