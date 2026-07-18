# CLAUDE_OPTAELLING.md — Lageroptælling (rullende session-model)

> Første spec for optællingen. Der fandtes ingen tidligere — komponenten voksede
> organisk. Denne fil er source-of-truth ved redesignet i issue #331.
> Læs `docs/BON_V2_PRINCIPPER.md` + `db/helpers.js` (Grocy-adapter-mønstre) først.

**Modul:** Optælling-tab i [kitchen/stock.html](../kitchen/stock.html) ·
[shared/inventory_check.js](../shared/inventory_check.js) (~1600 linjer) + `.css`
**Relateret:** #305 (auto-deduct tændt), #243 (concurrency), #331 (dette redesign)

---

## 1. Formål og hvorfor nu

Optællingen er **backstoppet** der holder Grocy-lageret præcist. Efter #305 (auto-deduct
tændt: LEVERET trækker Grocy-lager) er den vigtigere end nogensinde — den er dét der
re-baseliner når forbruget drifter. **En optælling der forgifter sine egne data
underminerer hele lagerstyringen.** Redesignet handler primært om at fjerne fire
stille-data-fejl; UX-forbedringerne er sekundære.

---

## 2. Nuværende tilstand (kort)

- Bruger vælger **lokation** (Grocy-location) + **fysisk enhed** (KØL-1, FRYS-2 …
  konfigurerbare, gemt i localStorage pr. lokation) → `_icStartCheck`.
- Produkter filtreres til lokationen, sorteres, tælles ét ad gangen med `+`/`−` +
  brøk-knapper (¼ ½ ¾) + enhedsskift ("Næste enhed").
- Optalte mængder gemmes i **localStorage** (session-key pr. lokation).
- Slutskærm (`_icShowSummary`) viser afvigelser/ikke-fundet/OK → "Gem alle" skriver til Grocy.
- **Skrivninger til Grocy:** `postGrocyInventory(id, amount, bestBefore)` (sæt eksakt
  mængde) + `putGrocyProductUserfields(id, {LastCheckedAt, LastCheckedUnit})`.

### Adapter-signaturer (verificér før brug — §11)

| Frontend (`shared/api.js`) | Route | Adapter (`services/grocyAdapter.js`) |
|---|---|---|
| `postGrocyInventory(id, amount, bestBefore?)` | `POST /grocy/stock/:id/inventory` | `setInventory(id, amount, bestBefore?)` |
| `putGrocyProductUserfields(id, fields)` | `PUT /grocy/products/:id/userfields` | `updateProductUserfields` |
| `postGrocyShoppingList(items[])` | `POST /grocy/shopping-list/*` | — |
| `fetchGrocyProducts` / `fetchGrocyStock` / `fetchGrocyQuantityUnitConversions` | GET | — |

**Vigtigt:** `postGrocyInventory` udelader `best_before_date` fra POST-body'en når 3.
argument er falsy ([api.js:436](../shared/api.js)). Route sender `best_before_date || null`
videre, og `setInventory` sætter kun `best_before_date` når den er sandt. Dvs. **at udelade
BB flyder rent gennem hele stakken** → Grocy bruger produktets `default_best_before_days`.

### Userfields (products-entity — verificér navne i Grocy, §11)

| Userfield | Type | Betydning |
|---|---|---|
| `HverDag` | text-single-line | Check-interval i dage. **Tom = passiv vare** (stiger aldrig til tops). |
| `LastCheckedAt` | datetime | ISO-timestamp, sidst talt. Skrives som UTC (`toISOString`). |
| `LastCheckedUnit` | text-single-line | Hvilken **fysisk enhed** varen sidst blev talt i. Bærer den rullende placering. |

---

## 3. Kernekoncept: rullende session-model

Tre principper:

1. **Rullende, ikke total.** Placering er *observation* (`LastCheckedUnit`), ikke stamdata.
   Tæller man en vare et nyt sted, flytter den derhen automatisk (skrives ved commit).
   Grocys `location_id` er stadig stamdata, men styrer **ikke** hvilken fysisk-enhed-liste
   varen dukker op i — det gør `LastCheckedUnit`.
2. **Alt redigerbart indtil "Gem og luk".** Optælling er en arbejdssession, ikke en wizard.
   **Intet skrives til Grocy før commit.** Session lever i localStorage; kan afbrydes og
   genoptages uden at røre Grocy.
3. **`HverDag` styrer prioritet, ikke pligt.** Tom = passiv (aldrig overdue). Sat = vises
   højere efterhånden som intervallet overskrides.

---

## 4. De fire stille-data-bugs (kernen)

### Bug 1 — `LastCheckedAt` skrives pr. tælling → afbrudt session forgifter sorteringen
**Nu:** `_icSaveCount` kalder `_icUpdateLastChecked(productId)` fire-and-forget på *hver*
optælling ([inventory_check.js:1189](../shared/inventory_check.js)). Afbrydes sessionen
(luk fane, netværk dør, bruger går væk) står varerne som "tjekket i dag" i Grocy — **men
lageret blev aldrig rettet.** Næste optælling sorterer dem nederst (nyligt tjekket) selvom
de reelt er urørte.
**Fix:** Skriv `LastCheckedAt`/`LastCheckedUnit` **kun ved commit**, og **kun for varer der
faktisk blev talt** i sessionen. Batch-skrivning. Fjern kaldet fra `_icSaveCount`.

### Bug 2 — best-before stemples med evighedsdato på det optalte surplus
**Nu:** `_icCorrectInventory` + `_icSaveAllToGrocy` kalder
`postGrocyInventory(id, amount, '2999-12-31')` — hardkodet.
**Præcis effekt (verificeret, se boks nedenfor):** det overskriver *ikke* eksisterende
batchers datoer. Ved en **forøgelse** (talt mere end Grocy havde) oprettes en **ny batch**
med `2999-12-31` = udløber aldrig → skjuler holdbarhed på det netop-optalte surplus. For
varer med `default_best_before_days = -1` er nuværende og ny adfærd identisk (begge → 2999);
bug'en rammer altså **kun perishables hvor man tæller mere end forventet.**
**Fix (verificeret, foretrukken):** kald `postGrocyInventory(id, amount)` **uden**
BB-argument. Grocy stempler så den nye batch med produktets `default_best_before_days`
(§2). Ingen read-round-trip, ingen multi-batch-udfladning. Vi **hardkoder aldrig
`2999-12-31`** igen.

> **✅ Verificeret empirisk mod grocytest (Grocy 4.6.0, 18. juli 2026):**
> - Forøg 10→15 med BB udeladt (`default_best_before_days=5`): ny batch `5 @ i dag+default`,
>   eksisterende `10 @ 2026-08-01` **urørt**.
> - Formindsk 15→8 med BB udeladt: **FIFO-consume** af tidligst-udløbende, eksisterende
>   datoer intakte.
> - Forøg 0→10 med BB udeladt (`default_best_before_days=-1`): `10 @ 2999-12-31`.
>
> Konklusion: "udelad BB" er både sikkert og korrekt for en optælling — surplus dateres
> fornuftigt af produktets default, eksisterende beholdning røres aldrig. **Beslutning A
> lukket** (§11).

### Bug 3 — sortering: udløbsdato kan overtrumfe check-status
**Nu:** Sorten leder allerede med prioritet → `HverDag`-checkstatus → *derefter* udløb
([inventory_check.js:776](../shared/inventory_check.js)). Så "udløb overtrumfer alt" er
**delvist forældet** — koden er rework'et én gang. Men trin 4 (udløb ≤ 3 dage) kan stadig
løfte en nyligt-tjekket vare over en ikke-tjekket, og `checkedTodayHere` bruges ikke i selve
sorten.
**Fix:** Formalisér til **4 eksplicitte grupper** (i rækkefølge):
1. **Forfaldne** (`HverDag` overskredet, `checkStatus=overdue`)
2. **Aldrig tjekket** (ingen `LastCheckedAt`)
3. **Snart forfaldne** (`checkStatus=soon`)
4. **Ikke-forfaldne** (resten)

Inden for hver gruppe: manuel prioritet → check-ratio → **best-before kun som tie-breaker**.
Varer talt i denne session flyttes til bunden (checked-liste), ikke blandet ind.

> **UTC-fælde (memory `project_utc_today_bug`):** gruppe 2 ("aldrig/i dag tjekket") og
> `checkedTodayHere` bruger i dag `now.toISOString().slice(0,10)` — det er UTC-dato og
> viser gårsdag efter dansk midnat. Brug `todayISO()`/`offsetISO()` fra `db/helpers.js`
> (eller den lokale ækvivalent) i grupperingen. Lille effekt, men det er præcis den slags
> tavse dato-drift optællingen skal fjerne, ikke indføre.

### Bug 4 — lokations-filtrering trækker frostvarer ind i køle-listen
**Nu:** `_ic.products` inkluderer produkter hvor `location_id === loc` **OR**
`default_consume_location_id === loc` ([inventory_check.js:594](../shared/inventory_check.js)).
En frostvare hvis forbrugslokation er køl dukker derfor op i køle-enhedens liste.
**Fix:** Filtrér på den rullende model:
- Vis en vare i den fysiske enheds liste hvis `LastCheckedUnit === physicalUnit`, **eller**
- (fallback, aldrig talt endnu) hvis Grocy `location_id === locationId`.
- **Drop `default_consume_location_id` fra filteret helt.**

> **Skarp kant — cross-location (bindende regel, beslutning E ✅):** fysiske enheder er
> scoped pr. Grocy-lokation (localStorage pr. lokation). En vare hvis `LastCheckedUnit`
> peger på en enhed under en **anden** lokation må ikke forsvinde tavst fra den lokation man
> ville forvente den i — for et **backstop**-værktøj er tavs udeladelse den værste fejl.
> **Den bindende fallback-regel:** vis en vare under sin Grocy-lokation når `LastCheckedUnit`
> er tom **eller** ikke matcher nogen enhed under den aktuelle lokation (ikke kun "aldrig
> talt"). Så en vare der hører til Køl (stamdata) men blev talt i en Fryser-enhed dukker
> stadig op når man tæller Køl. Den præcise visnings-regel for Bug 4:
>
> ```
> vis(vare, lokation, enhed):
>   hvis LastCheckedUnit == enhed                      → vis (rullet hertil)
>   ellers hvis LastCheckedUnit matcher en enhed
>           under DENNE lokation                        → skjul (rullet til anden enhed her)
>   ellers hvis vare.location_id == lokation            → vis (fallback: hører til her)
>   ellers                                              → skjul
> ```

---

## 5. Grocy-skrivestrategi (samlet, ved commit)

Ved "Gem og luk" — én batch, i denne rækkefølge pr. talt vare:

1. **Inventory** (kun hvis `|talt − nuværende| > 0.01`): `postGrocyInventory(id, amount)`
   uden BB. Hent **frisk** lager først (genbrug mønstret i `_icSaveAllToGrocy`,
   [inventory_check.js:1372](../shared/inventory_check.js)) så vi sammenligner mod Grocys
   nuværende beholdning, ikke start-snapshot (auto-forbrug kan have drevet lageret).
2. **Userfields** (for alle **talte** varer, også dem uden afvigelse):
   `putGrocyProductUserfields(id, {LastCheckedAt: now, LastCheckedUnit: physicalUnit})`.
   Dette er hvad der flytter den rullende placering.
3. Varer der **ikke** blev talt: **rør intet** i Grocy (hverken inventory eller userfields).

> **"Ikke fundet" skal kunne rettes (driftsfeedback):** en vare med Grocy-lager > 0 der ikke
> blev talt, vises i slutskærmens "Ikke fundet". Den skal kunne rettes med den **faktiske
> mængde** (antal-felt + Ret → `_icCorrectInventory(id, mængde)`), ikke kun "Sæt til 0" eller
> "Indkøb" — ellers kan man ikke rette en vare man bare glemte at tælle.

`amount` sendes altid i **stock-enhed** (efter evt. tælleenheds-konvertering, §7).

> **Multi-enheds-vare:** en vare kan tælles i flere fysiske enheder i samme session
> (`counts[id].units` summeres til `counts[id].total`). Inventory-skrivningen bruger
> **totalen** (korrekt — Grocy kender kun ét lagertal pr. produkt pr. lokation).
> `LastCheckedUnit` kan derimod kun rumme **én** enhed → sæt den til den sidst-talte.
> Tabsfrit for lageret, let-tabsgivende for "hvor blev den set" (acceptabelt).

---

## 6. Concurrency (#243) — ikke valgfri

Den rullende model + "intet før commit" + localStorage-session betyder at to der tæller
samtidig clobber'er hinandens **hele** batch ved commit. Med auto-deduct tændt er en
tavs overskrivning farlig.

**Minimumsgaranti (PR 1):** ved commit hentes frisk lager (allerede krævet i §5.1). For
hver vare hvor Grocys nuværende beholdning **afviger fra det tal brugeren så da hun indtastede
sin optælling**, markér "ændret siden du talte" i slutskærmen og **kræv bekræftelse** før
overskrivning — tavs last-writer-wins er ikke acceptabelt.

> **Baseline = pr. vare ved tælletidspunkt, ikke session-start.** Sessioner kan genoptages
> over flere dage (localStorage persisterer). Gem derfor Grocy-mængden **på det tidspunkt
> varen blev talt** (`counts[id].grocyAtCount`), ikke ét snapshot fra `_icStartCheck`. Det
> er den værdi brugeren traf sin beslutning ud fra; det er den der skal sammenlignes mod
> frisk lager ved commit.

**Udskudt (kan tages med #243):** rigtig session-lås eller server-side optimistisk
concurrency. Ligger uden for PR 1/2 medmindre driften viser reelle kollisioner.

---

## 7. UX-forbedringer (PR 2)

> **Mockup:** `docs/optaelling_mockup_pr2.html` (klikbar, ingen backend) — viser enheds-chips,
> tælleenheder med live-konvertering, ⋯-menu, og ny slutskærm + kvitteringsbanner. Byg PR 2
> mod den.

- **Enheds-chips** erstatter "Næste enhed"-knappen: chips for hver fysisk enhed, klik
  skifter aktiv enhed, **optalt mængde bevares** pr. enhed (allerede modelleret:
  `counts[id].units[enhed]`). Tydeliggør at man tæller samme vare på flere steder.
- **Tælleenheder:** tæl i indkøbs-/naturlig enhed ("3 bøtter"), konvertér til stock-enhed
  **før skrivning**. Genbrug `_icFindFactor(productId, fromQu, toQu)` +
  `_icAltConv(product)` ([inventory_check.js:1560](../shared/inventory_check.js)) — samme
  resolved-conversions-vej som recipe_viewer/designer. Live-visning: "3 bøtter = 4,5 kg".
  **Fallback:** ingen konvertering fundet → tæl i stock-enhed (ingen fejl).
- **Sprog-princip (driftsfeedback — gælder alle tekster i modulet):** skriv som du ville
  forklare det til en ny kollega i køkkenet, ikke som systemet tænker. Personalet har aldrig
  programmeret.
  - **Ingen systemord i UI:** ikke "commit", "overskriv", "deaktivér", "stamdata", "userfield",
    "HverDag". Sig hvad der sker for *brugeren*: "Gemt. 2 varer rettet på lageret."
  - **Forklar hvorfor, ikke hvad systemet gør:** ikke "Grocy-lageret har flyttet sig", men
    "Lagertallet er ændret, mens du talte — måske har en anden rettet det, eller en bon er
    blevet leveret."
  - **Valg formuleres som virkelighed, ikke som operation:** "Mit tal er rigtigt" /
    "Lagerets tal er rigtigt" — ikke "Overskriv" / "Behold".
  - **Rigtigt dansk:** æ/ø/å, ikke "Saet"/"Indkoeb"/"Optaelling". (Filen er UTF-8 og serveres
    som UTF-8 — de gamle omskrivninger var vane, ikke et krav.)
- **Decimaler — komma til mennesker, punktum til Grocy (verificeret mod grocytest):**
  | | Format | Bevis |
  |---|---|---|
  | Til Grocy | **punktum**, som JSON-tal (`{"new_amount": 2.5}`) | En streng med komma afvises hårdt: `must be of type float, string given` — lageret ændres ikke |
  | Til brugeren | **komma** (`2,5`) | Dansk konvention |

  - `_icFmt(n)` formaterer **kun tekst mennesker læser**. Brug den **aldrig** på noget der
    sendes til API'et eller gemmes i et `data-*`-attribut (`data-amount`, `data-grocy`
    parses tilbage og skal være rå).
  - `_icParseNum(v)` læser brugerindtastning og accepterer både `2,5` og `2.5`.
    **Rå `parseFloat` må aldrig bruges på et input** — `parseFloat('2,5')` giver `2`, dvs.
    tavst forkert optælling.
  - Antal-feltet er `type="text" inputmode="decimal"`, **ikke** `type="number"`: et
    number-felt afviser komma (`.value` bliver tom), og danskere taster komma.
  - Dækket af T_OPTAELLING case 12 (16 asserts), inkl. en guard der fanger et visnings-tal
    der glemmes i `_icFmt` — præcis den fejl der slap igennem første gennemløb.
- **Interaktions-princip (driftsfeedback — bindende for PR 2):** omkostningen skal følge
  **hyppighed**, ikke konsekvens-frygt. Man står i kølerummet med en tablet; hyppige
  arbejdsskridt må ikke koste to tryk.
  - **1 tryk, direkte på kortet** (hyppige arbejdsskridt): **✓ godkend** (tæl = Grocys tal)
    og **⏭ spring over**. Store touch-targets (≥44 px). *Findes allerede i dag — må ikke
    demoteres ned i ⋯-menuen.*
  - **Billig fortryd er modstykket:** gør man en handling 1-tryks-let, skal den kunne
    fortrydes lige så let. Sprunget-over-kort dæmpes med "Sprunget over i \<enhed\> · Fortryd"
    i stedet for bare at forsvinde.
  - **2 tryk (⋯-menu)** — kun beslutninger der ændrer stamdata; her *er* friktionen pointen.
- **⋯-menu pr. kort (kun beslutninger):**
  - "Skal ikke tjekkes" → `HverDag = ""` (gør varen passiv). Skriv ved commit.
  - "Udgået" → inventory `0` + `active = 0`. Skriv ved commit (destruktiv — bekræft, dvs. 3 tryk).
- **Ny slutskærm ("Gem og luk")** + **blivende kvitteringsbanner** (ikke kun 3-sek toast):
  antal talt / rettet / ikke-fundet, med link til at genåbne. Banner forsvinder først ved
  ny session eller manuel luk.

---

## 8. Leveringsplan — split i to PR'er

**PR 1 — data-integritet (lille, lav risiko, haster pga. #305):**
- Bug 1: flyt `LastCheckedAt`/`LastCheckedUnit` til commit, kun for talte varer
- Bug 2: stop BB-overskrivning (`postGrocyInventory(id, amount)` uden 3. arg)
- Bug 3: 4-gruppe-sortering, BB kun tie-breaker
- Bug 4: filtrér på `LastCheckedUnit` + lokation, drop `default_consume_location_id`
- Concurrency-minimum (§6): frisk-lager-tjek + bekræftelse ved drevet beholdning
- T_OPTAELLING cases 1–7 (§10)

**PR 2 — UX-redesign:**
- Enheds-chips, tælleenheder, ⋯-menu, ny slutskærm + kvitteringsbanner
- T_OPTAELLING cases 8–11

**Følgeopgave (separat lille, efter PR 1):** varemodtagelse sætter `LastCheckedUnit` når en
vare modtages i en fysisk enhed — så en netop modtaget vare tæller som "observeret der".
Rør [shared/varemodtagelse.js](../shared/varemodtagelse.js) minimalt.

---

## 9. Grep-tjekliste FØR implementering

Kør og bekræft hver linje — antag ikke:

```bash
# Userfield-navne findes på products-entity i Grocy (case-sensitivt)
grep -rn "HverDag\|LastCheckedAt\|LastCheckedUnit" shared/ routes/ services/

# Adapter-signaturer (argument-rækkefølge)
grep -n "function setInventory\|function updateProductUserfields\|async setInventory" services/grocyAdapter.js
grep -n "postGrocyInventory\|putGrocyProductUserfields" shared/api.js

# Resolved-conversions-vej (tælleenheder genbruger denne)
grep -n "_icFindFactor\|_icAltConv\|fetchGrocyQuantityUnitConversions" shared/inventory_check.js

# Bekræft at postGrocyInventory udelader BB når 3. arg mangler
sed -n '436,443p' shared/api.js
```

```bash
# "Udgået" (§7) sætter active=0 på PRODUKT-objektet (ikke et userfield).
# Bekræft at adapteren KAN patche et produkt — findes der ikke en vej, er det
# et nyt endpoint i PR 2, ikke en gratis genbrug.
grep -n "updateProduct\|PATCH.*products\|active" services/grocyAdapter.js routes/grocy.js
```

**Verificér i Grocy-UI (grocytest):** at `default_best_before_days` er sat fornuftigt på de
produkter der tælles — det er hvad der styrer BB ved forøgelse når vi udelader datoen (§11-A).

---

## 10. Test — track T_OPTAELLING (11 cases)

Ny track. Fanger primært **stille-datafejl** (det der ikke fejler synligt). Følg
`docs/CLAUDE_TEST_*`-mønstret: spec i `tests/specs/T_OPTAELLING.md`, runner i
`tests/scripts/run_T_OPTAELLING.js`, mod grocytest med syntetiske produkter, ryd op bagefter.

| # | Case | Verificerer |
|---|---|---|
| 1 | Afbrudt session → ingen Grocy-ændring | Tæl 2 varer, luk **uden** commit → `LastCheckedAt` uændret i Grocy, inventory uændret (Bug 1) |
| 2 | Commit skriver kun talte varer | Tæl 3 af 10 → kun de 3 får `LastCheckedAt`; de 7 urørt |
| 3 | BB ved inventory-rettelse | Eksisterende batch-BB **urørt**; forøgelse → ny batch = `default_best_before_days`-dato, **ikke** 2999-12-31 (Bug 2, jf. §4-boks) |
| 4 | Purchase→stock-konvertering | Tæl "3 bøtter" (konv. 1,5 kg/bøtte) → Grocy modtager 4,5 kg i stock-enhed |
| 5 | Konvertering mangler → stock-enhed | Vare uden konvertering → tæl i stock-enhed, ingen fejl |
| 6 | `LastCheckedUnit` flytter | Tæl vare i FRYS-2 → `LastCheckedUnit=FRYS-2`; næste session vises den i FRYS-2-listen (Bug 4) |
| 7 | Sortering: 4 grupper | Overdue < aldrig-tjekket < snart < ikke-forfaldne; BB kun tie-breaker (Bug 3) |
| 8 | Enheds-chips bevarer tælling | Skift enhed frem/tilbage → `counts[id].units` intakt pr. enhed |
| 9 | ⋯ "Skal ikke tjekkes" | Commit → `HverDag=""`; varen bliver passiv i næste sort |
| 10 | ⋯ "Udgået" | Commit → inventory 0 + `active=0` |
| 11 | Concurrency: drevet beholdning | Start session, ret Grocy-lager eksternt, commit → "ændret siden du talte" + kræver bekræftelse (§6) |

---

## 11. Åbne beslutninger (afklar før byg)

- **A — BB ved forøgelse: ✅ LUKKET (verificeret 18. juli 2026).** Grocy stempler ny batch
  med `default_best_before_days`, rører ikke eksisterende batches, FIFO-consumer ved
  formindskelse. Strategi: **udelad BB** (`postGrocyInventory(id, amount)`). Se §4 Bug 2-boks.
  Én implikation at huske: har en vare `default_best_before_days = -1`, får surplus stadig
  2999-12-31 — men det er Grocys egen stamdata-beslutning, ikke vores at overstyre.
- **B — Concurrency-omfang: ✅ LUKKET (18. juli 2026).** §6-minimum i PR 1 (frisk-lager-tjek
  ved commit + bekræftelse ved drevet beholdning, baseline pr. vare ved tælletidspunkt).
  Server-side lås udskudt til #243, kun hvis driften viser reelle kollisioner.
- **C — Passiv vare i sort:** skal `HverDag=""`-varer skjules helt fra listen eller bare
  ligge nederst (gruppe 4)? Default: nederst, ikke skjult (så de kan tælles ad hoc).
- **D — Følgeopgave-timing:** varemodtagelse-`LastCheckedUnit` — separat PR efter PR 1
  (default), eller vent til PR 2?
- **E — Cross-location-fallback: ✅ LUKKET (18. juli 2026).** Blød fallback valgt: en vare
  vises under sin Grocy-stamdata-lokation når `LastCheckedUnit` er **tom eller ikke matcher
  nogen enhed under den aktuelle lokation** — så intet forsvinder tavst. Ikke den rene
  rullende model. Dette er den bindende regel for Bug 4-koden (§4 Bug 4-boks).

---

*Oprettet 18. juli 2026 som del af #331. Første spec for optællingen.*
