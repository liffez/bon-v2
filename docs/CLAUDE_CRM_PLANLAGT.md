# CLAUDE_CRM_PLANLAGT.md — Planlagt aktivitet i CRM

> **Status:** Godkendt til implementering · juli 2026 (revideret 14. juli — 3 beslutninger indarbejdet, se nedenfor)
> **Mockup:** `crm_planlagt_aktivitet_mockup_v3.html` (autoritativ for UI)
> **Migration:** `126` (verificeret mod origin/main 14. juli — main topper på `125_co2_transport.sql`).
> Bemærk: main har allerede dublet-numre (093/104/108/**123**/**124** — CRM-triks kolliderede med
> CO₂-branches), så tjek altid `db/migrations/` igen hvis der er gået tid inden byg. Nummeret
> 121 er TAGET (`121_co2_material_factors.sql`). Byg fra **main** (har Ringelisten #285/#286/#288).
> **Afhænger af:** intet — ingen skemaændringer, kun data-backfill + kode

### Revisioner (14. juli 2026)

1. **Dashboard owner-filter droppet i v1.** Login er rolle-baseret (delte PIN-konti), så
   `owner_user_id`-filtrering ville være misvisende. `owner_user_id` SÆTTES stadig ved
   INSERT (klar til fremtidig personlig login), men BRUGES ikke til filtrering. Se §4.3, §7.
2. **Struktureret resultat ved "udfør planlagt" — ikke tekst-append.** Resultatet gemmes i
   `result`/`sentiment`/`outcome` (samme struktur som service-kald + review-ask-måling,
   migration 114), så planlagt→udført-konvertering kan måles uden tekst-scraping. Fritekst-note
   kan stadig lægges i `text`, men resultatet er strukturelt. Se §3 regel 4, §4.3, §5.3.
3. **Dashboard → Ringeliste-link.** "Mine opfølgninger"-panelet får en header-genvej
   (`window.switchSection('crm', 'ringeliste')`) til de system-foreslåede ringekøer. To lag:
   "hvad jeg selv har planlagt" (dashboard) + "hvem systemet foreslår" (Ringeliste). Se §7.

---

## 1. Formål

CRM'et kan i dag kun **logge** aktiviteter (fortid). Der mangler muligheden for at **planlægge** en kontakt frem i tiden ("ring til Dagny om festival-budget på torsdag") og få den serveret på dashboardet den dag.

Dette er IKKE et nyt begreb — det er samme `crm_activities`-række i en anden tilstand. Ingen ny tabel, ingen ny sidebar-post, intet nyt modul.

### Afgrænsning mod eksisterende mekanismer

| Mekanisme | Svarer på | Rør IKKE |
|---|---|---|
| Påmindelse (bon/firma) | "husk dette når konteksten opstår" — ingen dato | Uændret |
| Service-callback (`result='callback'`) | opfølgning født af service-flowet | Eget flow bevares; kun fælles **visning** på dashboard (fase 4) |
| Booket møde (`type='meeting'`, booking-modul) | kalenderaftale | Eget flow bevares; vises på kundekort men IKKE i dashboard-opfølgninger |
| **Planlagt aktivitet (NY)** | "jeg skal gøre noget på en dato" | — |

---

## 2. Verificeret skema-grundlag (juli 2026)

Bekræftet mod kørt migration og `sqlite3 data/bon.db ".schema crm_activities"`:

- `crm_activities` har allerede: `due_at DATETIME`, `done_at DATETIME`, `bon_id`, `customer_id`, `type`, `result`, `purpose_id`, `campaign_id`, `owner_user_id`
- Indekser findes: `idx_crm_act_owner_due`, `idx_crm_act_pending (WHERE done_at IS NULL)`, `idx_crm_act_due_planned`
- `051_booking.sql` etablerede allerede semantikken "`done_at IS NULL` = planlagt" for møder
- Callback-listen bruger `result='callback' AND done_at IS NULL` (jf. `019_crm_columns.sql:117`)
- POST-endpointet i `routes/crm.js` (~linje 1250) accepterer allerede `due_at` i body

**⚠️ Kendt datahul:** INSERT'en sætter aldrig `done_at` — alle historisk loggede aktiviteter har `done_at = NULL`. Fase 1 retter dette.

---

## 3. Semantik — tilstandsmodel

En aktivitet er i præcis én af tre tilstande:

| Tilstand | Definition | Opstår ved |
|---|---|---|
| **Logget** | `done_at IS NOT NULL` | "Hvornår = Nu" eller bagudrettet dato |
| **Planlagt** | `due_at IS NOT NULL AND done_at IS NULL` | "Hvornår = fremtidig dato" |
| **Forfalden** | planlagt + `due_at < now` | tiden går |

Regler:

1. **Log (nu):** `done_at = CURRENT_TIMESTAMP`, `due_at = NULL`
2. **Bagudrettet log:** `done_at = <valgt fortidig dato>`, `due_at = NULL`, `created_at` forbliver reelt oprettelsestidspunkt (revisionsspor)
3. **Planlæg:** `due_at = <fremtidig dato + evt. tid>`, `done_at = NULL`
4. **Udfør planlagt:** sæt `done_at = CURRENT_TIMESTAMP` på **samme række** (aldrig ny række). Resultatet gemmes **struktureret** i `result`/`sentiment`/`outcome` (valgfrit — samme felter som service-kald-flowet). En evt. fritekst-note kan appendes til `text`, men den er supplement, ikke bærer af resultatet
5. Timeline sorterer på `COALESCE(done_at, created_at) DESC`
6. Klokkeslæt er valgfrit. Uden tid gemmes `due_at` som dato kl. 00:00 og vises uden klokkeslæt. UI foreslår 09:00 (kan slettes)

---

## 4. Fase 1 — Migration 121 + backend

### 4.1 Migration `121_activity_done_backfill.sql`

```sql
-- Historisk loggede aktiviteter uden deadline er per definition
-- udført ved oprettelse. Møder (har due_at) og callbacks friholdes.
UPDATE crm_activities
SET done_at = created_at
WHERE done_at IS NULL
  AND due_at IS NULL
  AND (result IS NULL OR result != 'callback');
```

### 4.2 `routes/crm.js` — POST aktivitet (~linje 1250)

Body udvides med valgfrit `done_at` (bagudrettet) og bevarer `due_at` (planlæg). Serverlogik:

```
hvis body.due_at (fremtid)     → INSERT med due_at, done_at = NULL
hvis body.done_at (fortid)     → INSERT med done_at = body.done_at, due_at = NULL
ellers (log nu)                → INSERT med done_at = CURRENT_TIMESTAMP, due_at = NULL
```

Validering: `due_at` og `done_at` må ikke begge være sat i body → 400. Identitet fra `req.session.userId` (aldrig body).

### 4.3 Nye/udvidede queries i `routes/crm.js`

**Planlagte pr. kunde** (kundekortets Planlagt-blok — inkluderer møder):

```sql
SELECT id, type, text, due_at, bon_id
FROM crm_activities
WHERE customer_id = ? AND done_at IS NULL AND due_at IS NOT NULL
ORDER BY due_at ASC;
```

**Planlagte pr. bon** (drawer + info-modal):

```sql
... WHERE bon_id = ? AND done_at IS NULL AND due_at IS NOT NULL ...
```

**Dashboard "Mine opfølgninger"** (ekskluderer møder — de har egen sektion):

```sql
SELECT a.id, a.type, a.text, a.due_at, a.bon_id, a.customer_id, c.name,
       CASE WHEN a.result = 'callback' THEN 'service' ELSE 'planlagt' END AS kilde
FROM crm_activities a
JOIN customers c ON c.id = a.customer_id
WHERE a.done_at IS NULL
  AND a.type != 'meeting'
  AND (
        (a.due_at IS NOT NULL AND DATE(a.due_at) <= DATE('now'))
     OR (a.result = 'callback')
      )
ORDER BY
  CASE WHEN DATE(a.due_at) < DATE('now') THEN 0 ELSE 1 END,  -- forfaldne først
  a.due_at ASC;
```

> **v1: ingen owner-filtrering** (revision 1). Login er rolle-baseret med delte konti, så
> `owner_user_id`-filtrering ville skjule kollegaers planlagte/callbacks vilkårligt. Listen
> viser derfor ALLE forfaldne/dagens planlagte + alle åbne callbacks. Når personlig login
> engang indføres, tilføjes filtergrenen igen (`owner_user_id` er allerede sat pr. række).
>
> Denne query ERSTATTER datakilden bag "Ring tilbage"-listen (019:117-mønstret) — callbacks flyder med via `result='callback'`-grenen. Callback-flowets egne endpoints/complete-logik røres ikke.

**Udfør planlagt** — sæt `done_at` + valgfrit struktureret resultat (revision 2). Genbrug
complete-mønstret (crm.js ~1173), men skriv resultatet i `result`/`sentiment`/`outcome` frem
for at appende til `text`:

```sql
UPDATE crm_activities
SET done_at   = CURRENT_TIMESTAMP,
    result    = COALESCE(?, result),
    sentiment = COALESCE(?, sentiment),
    outcome   = COALESCE(?, outcome),
    text      = CASE WHEN ? != '' THEN text || char(10) || '→ ' || ? ELSE text END
WHERE id = ?;
```

> Parametre: `result`, `sentiment`, `outcome` (alle valgfri — NULL = uændret), samt en
> valgfri fritekst-note der stadig kan appendes til `text`. `outcome` valideres server-side
> mod samme enum som POST-endpointet (`success`/`partial`/`declined`/`no_response`/`pending`,
> jf. crm.js:1121). Dette holder planlagt→udført konsistent med service-kald + review-ask-måling
> (migration 114), så konverteringen kan måles struktureret senere.

### 4.4 Briefing-tæller

Dashboardets "X callbacks at følge op" skifter datakilde til dashboard-queryens rækketal (begge kilder). Tekst ændres til "X opfølgninger i dag".

---

## 5. Fase 2 — Kundekort UI

Jf. mockup v3, View 1.

### 5.1 Aktivitetsformular: nyt "Hvornår"-felt

Dropdown efter Formål: `Nu` (default) · `I morgen` · `Om 3 dage` · `Næste uge` · `Vælg dato…`

| Valg | Tilstand | Knap | Ekstra felter |
|---|---|---|---|
| Nu | log | "Log aktivitet" (brun) | ingen |
| I morgen / 3 dage / næste uge | planlæg | "Planlæg" (orange) | tid-felt, prefilet 09:00, kan slettes |
| Vælg dato… (fremtid) | planlæg | "Planlæg" (orange) | dato + tid (09:00-forslag) |
| Vælg dato… (fortid) | bagudrettet log | "Log aktivitet" (blå tilstand) | dato |

Hint-tekst under formularen skifter med tilstanden (ordlyd fra mockup). Default-flowet ("Nu") er 100% identisk med i dag.

### 5.2 Bon-link (valgfrit)

"🔗 Knyt til bon…"-knap → typeahead-søgning (genbrug eksisterende bon-søge-endpoint hvis findes — **tjek `routes/bons.js` før ny bygges**). Valgt bon vises som chip med ✕. Gemmes som `bon_id`.

### 5.3 Planlagt-blok

- Placeres mellem formular og timeline
- Vises KUN når der findes åbne planlagte (inkl. møder) — ellers helt skjult
- Pr. række: afkrydsningscirkel · type-badge · tekst · evt. bon-chip · dato (+ tid hvis sat)
- Forfalden: rød dato med ⚑
- Afkrydsning → inline "Log resultat?"-prompt med **strukturerede vælgere** (resultat + stemning, som service-kald-flowet) + valgfri fritekst-note. Knapper "Gem" / "Gem uden resultat" → række flytter til timeline med markering "✓ planlagt → udført". Resultatet gemmes i `result`/`sentiment`/`outcome`, ikke kun i teksten (revision 2)

### 5.4 Timeline

- Sortering: `COALESCE(done_at, created_at) DESC`
- Bagudrettet loggede markeres "registreret senere" (når `done_at`-dato ≠ `created_at`-dato)

---

## 6. Fase 3 — Bon-drawer + info-modal

Jf. mockup v3, View 3. **Arbejdsdeling: info-modal = kig, drawer = handling.**

### Info-modal (`Info — #B…`)
- **REVIDERET (14. juli):** planlagt-aktivitet (ring tilbage) er office-CRM og hører IKKE
  til på en bons info-visning. Den read-only planlagt-sektion blev bygget og derefter
  **fjernet igen** efter driftsfeedback. Info-modalen viser i stedet køkken-synlige
  **påmindelser** (`entity_flags.show_in_kitchen=1`) som et read-only banner øverst — se
  separat flags-udvidelse (migration 127). Planlagt aktivitet findes kun i draweren + kundekortet.

### Bon-drawer
- Ny handling "⏰ Planlæg opfølgning" i Handlinger-rækken → åbner aktivitetsformularen i overlay, prefilet: `bon_id` + `customer_id` fra bonnen, Hvornår = "I morgen", tid = 09:00-forslag. Ingen navigation væk fra draweren
- Sektion "Planlagt på denne bon" MED afkrydsning (samme Log resultat?-flow som kundekortet)
- Skjules når tom

---

## 7. Fase 4 — Dashboard "Mine opfølgninger"

Jf. mockup v3, View 2. Erstatter "Ring tilbage"-listens visning (samme placering).

- Datakilde: dashboard-queryen fra 4.3 (**ingen owner-filtrering i v1** — revision 1)
- **Header-link "Se ringeliste →"** (revision 3): kalder `window.switchSection('crm', 'ringeliste')`
  og springer til de system-foreslåede ringekøer (Sæson/Rytme/Sovende/Kolde tilbud). Global
  findes allerede — ét linje-kald, ingen ny plumbing. Dashboardet er "hvad jeg selv har
  planlagt"; Ringelisten er "hvem systemet foreslår". Linket binder de to lag sammen så
  dagens kontakt-arbejde ikke kun bor ét sted
- Pr. række: avatar · navn · firma · aktivitetstekst · evt. bon-chip · kilde-badge (`Planlagt` orange / `Service` blå) · tidspunkt · Ring-knap
- Sortering: forfaldne først (ældst øverst, rød ⚑), derefter dagens (med tid før uden)
- Fremtidige planlagte vises IKKE her — kun på kundekort/drawer
- Møder vises IKKE her — de bor i "Kommende bookede møder"
- Ring-knappens eksisterende adfærd for callbacks bevares; for planlagte åbner den kundekortet med Planlagt-blokken synlig

> **Valgfri fremtidig løkke (ikke v1):** en "⏰ Planlæg"-genvej i selve Ringelistens
> ringekø-rækker, så man kan planlægge en opfølgning direkte fra en kø. Lukker løkken den
> anden vej. Afventer beslutning.

---

## 8. Uden for scope

- Gentagelse, prioritet, køer (HubSpot-mønstre — bevidst fravalgt)
- Tildeling til andre brugere i UI (`owner_user_id` sættes altid til aktuel bruger; vælger evt. senere bag settings-flag som i Indbakke)
- Konvertering af service-callback-flowet til planlagt-mønstret
- Notifikationer/mail-reminders
- Kobling til ringelister/kampagner (`campaign_id` ligger klar, men afventer ringeliste-arkitekturbeslutningen)

---

## 9. Test

### Fase 1

| # | Test | Forventet |
|---|---|---|
| T1.1 | Kør migration 121 på kopi af prod-db | Alle rækker med `due_at IS NULL` og `result != 'callback'` får `done_at = created_at` |
| T1.2 | Callbacks efter migration | `result='callback'`-rækker har stadig `done_at = NULL` |
| T1.3 | Bookede møder efter migration | Uændrede (`due_at` sat, `done_at NULL`) |
| T1.4 | POST uden due_at/done_at | Række med `done_at ≈ nu` |
| T1.5 | POST med fremtidig `due_at` | Række med `due_at` sat, `done_at NULL` |
| T1.6 | POST med fortidig `done_at` | Række med `done_at = valgt`, `created_at = nu` |
| T1.7 | POST med både `due_at` og `done_at` | 400 |
| T1.8 | Complete-endpoint med struktureret resultat | `done_at` sat + `result`/`sentiment`/`outcome` skrevet på rækken; evt. note appendet til `text` |
| T1.9 | "Ring tilbage"-callbacks vises stadig | Kilde-badge = Service i dashboard-query |
| T1.10 | Dashboard-query uden owner-filter (rev. 1) | Planlagte/callbacks ejet af en ANDEN bruger vises også (ingen `owner_user_id`-WHERE) |
| T1.11 | Complete med ugyldig `outcome` | 400 (samme enum-validering som POST) |

### Fase 2

| # | Test | Forventet |
|---|---|---|
| T2.1 | "Hvornår = Nu" | Formular og resultat identisk med gammelt flow |
| T2.2 | "I morgen" valgt | Knap → "Planlæg" (orange), tid-felt med 09:00 |
| T2.3 | Tid slettes, planlæg | `due_at` = dato uden tid, vises uden klokkeslæt |
| T2.4 | Fortidig dato under "Vælg dato…" | Blå tilstand, knap "Log aktivitet", hint om bagudrettet |
| T2.5 | Planlagt-blok, 0 åbne | Blok helt skjult |
| T2.6 | Afkryds planlagt + resultat/stemning | Flyttes til timeline, "✓ planlagt → udført", `result`/`sentiment` gemt struktureret + evt. note synlig |
| T2.7 | Bon-link valgt og fjernet igen | `bon_id = NULL` i request |
| T2.8 | Forfalden planlagt | Rød dato med ⚑ |
| T2.9 | Booket møde på kunden | Vises i Planlagt-blok |

### Fase 3

| # | Test | Forventet |
|---|---|---|
| T3.1 | Info-modal, bon med 1 planlagt | Læse-sektion vises, ingen interaktion |
| T3.2 | Info-modal, bon uden planlagte | Sektion skjult |
| T3.3 | "Planlæg opfølgning" i drawer | Overlay-formular prefilet med bon + kunde, drawer forbliver åben |
| T3.4 | Afkryds i drawer | Samme Log resultat?-flow, opdaterer også kundekort |

### Fase 4

| # | Test | Forventet |
|---|---|---|
| T4.1 | Planlagt i dag + callback + forfalden planlagt | Én liste: forfalden øverst (⚑), korrekt kilde-badges |
| T4.2 | Planlagt i morgen | IKKE på dashboard, KUN på kundekort |
| T4.3 | Booket møde i dag | IKKE i opfølgninger, KUN i "Kommende bookede møder" |
| T4.4 | Briefing-tæller | Matcher listens rækketal |
| T4.5 | Ring-knap på planlagt | Åbner kundekort med Planlagt-blok |

**Go-live blokker:** T1.1–T1.3 SKAL køres mod kopi af prod-db og verificeres med rækketal (før/efter-counts pr. gren) inden migration køres i prod.

---

## 10. Til CLAUDE.md → Næste opgave

```
CRM: Planlagt aktivitet — se CLAUDE_CRM_PLANLAGT.md
Fase 1: migration 121 (done_at backfill) + POST-logik + queries
Fase 2: kundekort (Hvornår-felt, Planlagt-blok, bon-link)
Fase 3: bon-drawer (Planlæg opfølgning) + info-modal (læse-sektion)
Fase 4: dashboard "Mine opfølgninger" (afløser Ring tilbage-visning) + "Se ringeliste →"-link
Mockup: crm_planlagt_aktivitet_mockup_v3.html er autoritativ for UI
Revisioner (14. juli): (1) intet owner-filter i v1, (2) struktureret resultat ved udfør,
(3) dashboard→Ringeliste-link. Grib faktisk næste migrations-nummer på main ved byg.
```
