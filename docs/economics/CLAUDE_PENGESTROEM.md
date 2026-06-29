# CLAUDE_PENGESTROEM.md — Likviditet / e-conomic-afstemning (EVOLUTION-spec)

> Læs `CLAUDE.md`, **`BON_V2_PRINCIPPER.md` §6b+6c** (moms) og **`CLAUDE_ECONOMIC_AUTH.md` §7**
> (reconciliation-hook) FØR du starter.
> Status: dele bygget (se nedenfor). Spec omskrevet juni 2026 til **evolution** efter at det
> eksisterende cashflow-modul blev korrekt afdækket.
>
> **VIGTIGT — dette er IKKE greenfield.** Et modent cashflow-modul kører allerede i drift.
> Denne spec beskriver de **få ægte nye ting** der skal grafts ind i det — ikke et nyt modul.
> Den oprindelige greenfield-version (`bank_transactions`/`pengestroem.js`/`cashflowReconcile`
> som nybyg) er **forkastet**; den ville duplikere `cf_*`/`cashflow.js`/`cashflowSync.js`.

---

## 0. Hvad der ALLEREDE er bygget (baseline — byg IKKE igen)

| Findes | Hvad | Svarer til spec-greenfield |
|--------|------|----------------------------|
| `routes/cashflow.js` (19 endpoints) | upload, transactions, invoices CRUD, match/:txId, suggest-matches, confirm-paid, bulk-confirm-paid, stats, weekly, analyse, payment-behavior, upcoming | hele "Endpoints"-tabellen |
| `office/views/cashflow.js` (70 KB) | Økonomi → "Pengestrøm" (Overblik + Analyse) | hele "Frontend"-afsnittet |
| `services/cashflowSync.js` | holder `cf_invoices` i sync med bon-status (FAKTURERET/BETALT/AFLYST) | dele af "Fase 2" |
| `cf_transactions` (mig. 047, +092) | `dato, tekst, beloeb, saldo, matched_invoice_id, match_confidence, ignored, note` | `bank_transactions` |
| `cf_invoices` (mig. 047, +078) | `id(=fakturanr), kunde, beloeb, forfald, betalt, betalt_dato, betalingstype, noter, bon_id` | faktura-status + forecast-grundlag |
| `cf_meta` (key/value) | generisk settings-bag for cashflow | base for vandmærket |
| CSV-upload + Nykredit/Fælles Kassen-parser + dedup + matchmotor | `POST /upload`, `suggest-matches` | "CSV-import" + "Matchmotor" |

**Konsekvens:** kroner-siden, CSV-parseren, matchlisten, faktura-tabellen, analyse og forecast-stub
(`/upcoming`) er der allerede. Den eneste manglende kerne er **e-conomic som kilde til betalt-status**
— i dag kommer `cf_invoices.betalt` fra **manuel bon-markering** (`cashflowSync`), ikke fra e-conomics
faktiske bogføring.

---

## 1. Designprincipper der BEVARES (de var det gode ved originalen)

- **Adskil KRONER fra STATUS.** Kroner kommer kun fra bankudtog (`cf_transactions`). e-conomic/bon-status
  sætter kun faktura-status (`cf_invoices.betalt`). Tæl aldrig samme krone to gange.
- **Vandmærke.** e-conomic ejer det afgjorte bagkatalog; CSV/manuel ejer kun de sidste dage. Skrumper matchlisten.
- **Hele viewet er INCL. moms** (den ene undtagelse fra §6b). "Heraf moms" altid via `shared/moms.js`, aldrig `× 0,2`.
- **Bon v2 bogfører aldrig og rører aldrig banken.** e-conomic ejer bankafstemningen (Bank Connect); vi læser status.

---

## 2. Det ægte DELTA — fire kirurgiske tilføjelser

### A. Vandmærke = én `cf_meta`-række (ingen ny tabel)
```
cf_meta['economic_booked_until'] = 'YYYY-MM-DD'   -- seneste dato e-conomic har bogført til
```
- Sættes af reconcile-servicen (B), ellers manuelt via en lille admin-knap.
- **Guard i den eksisterende matchmotor** (`suggest-matches` + auto-match i `/upload`):
  `cf_invoices`/`cf_transactions` med dato **før** vandmærket auto-matches/gen-matches IKKE — de er afgjort af e-conomic.

### B. e-conomic-afstemning = én ny service `services/cashflowReconcile.js` (PRIORITERET)
> Kernen — fjerner den manuelle betalt-markering. **Kan bygges + verificeres NU:** RR har allerede
> ~4.113 bogførte fakturaer i e-conomic, så servicen har ægte data at læse fra dag ét. Den fulde
> loop (vores udkast → bogført → afstemt) modner i takt med at Spor 2 bruges, men B er ikke gated på det.
>
> **Bruger REST `/invoices/booked` — IKKE OpenAPI.** (Verificeret 26. juni: REST-fakturaen har
> `remainder`, `grossAmount`, `netAmount`, `vatAmount`, `dueDate`, `paymentTerms`, `references`.)
> Samme REST-API + auth som resten af adapteren — ingen OpenAPI-cursor-pagination nødvendig.
1. Hent `/invoices/booked` (paginer; filtrér helst på dato **efter** `economic_booked_until` for at
   undgå at gennemgå hele bagkataloget hver gang).
2. Pr. bogført salgsfaktura: **`remainder === 0` → betalt** (`remainder` = restbeløb/dueAmount, incl moms).
   `dueDate` + `grossAmount` (incl moms) med.
3. **Match tilbage til bon via `references.other` = bon-nummeret** (vores Spor 2-payload sætter det
   allerede, jf. ADAPTER `buildReference`) — robust for nye fakturaer. **Fallback for eksisterende
   (gamle) fakturaer:** `bookedInvoiceNumber` → `cf_invoices.id` (fakturanr) → `cf_invoices.bon_id`.
4. Opdatér `cf_invoices.betalt`/`betalt_dato`/`betalingstype='bank'` + ryk `economic_booked_until`.
5. **Nightly + "synk nu"-knap.** Poll IKKE hyppigt — `remainder` ændrer sig kun når e-conomic registrerer
   en betaling (e-conomics egen Bank Connect, hver 10-14 dag). Spild ikke kald på en kilde der står stille.

### C. Struktureret fakturanummer + faktureringstidspunkt på bons
**Problem i dag:** `cashflowSync` parser fakturanummeret ud af **fri-tekst `invoice_info`** → skrøbeligt.
**Fix (ejes af e-conomic Spor 2, ikke her — den lander først):**
```sql
ALTER TABLE bons ADD COLUMN invoice_number TEXT;   -- e-conomic bookedInvoiceNumber (matchnøgle)
ALTER TABLE bons ADD COLUMN faktureret_at  TEXT;    -- sættes ved "Markér faktureret" (forfald = +Netto N)
```
- `faktureret_at` sættes når "Markér faktureret"-knappen trykkes (Spor 2 trin 3 — i dag skrives kun fri-tekst).
- `invoice_number` tastes samme sted (manuelt nu; auto sat af reconcile (B) når booked-nummeret kendes).
- `cashflowSync` skifter fra fri-tekst-parse til at læse `bons.invoice_number` (med fri-tekst som fallback i overgangen).

### E. Direkte salg / event-indtægt (KOMPLET 29. juni — event-indtægt ALTID via salgsbon)
> **Kernebeslutning (Leif 29. juni): bons er den eneste sandhed for event-økonomi.** `routes/events.js`
> beregner P&L udelukkende fra eventets bons (0 referencer til cf_allocations). En "bar" event-allokering
> (target_type='event') ville derfor være usynlig i event-regnskabet → forbudt. Event-indtægt går ALTID
> gennem en salgsbon; bank-afstemning kobler indbetalinger til de bons (target_type='bon').
> - ❌ **Bar "Kobl til event" FJERNET.** `match-targets` returnerer ikke længere events; auto-forslags-chips
>   i split-panelet fjernet. Migration 116 rydder eksisterende bare event-allokeringer (de berørte
>   indbetalinger vender tilbage til "kan ikke matches" og laves korrekt via Opret bon).
> - ✅ **Opret bon fra indbetaling** `POST /cashflow/create-bon-from-tx` — DEN kanoniske vej til event-penge.
>   Opretter BETALT salgsbon (event_role='sales', price_category='festival', customer NULL) + allokerer tx
>   til den. Genbruger eventets eksisterende salgsbon hvis den findes. Linjer fleksible — én samle-linje
>   ELLER salg pr. menu-linje. **Linjer kan vælges som rigtige Grocy-menuer** (autocomplete på varenavn via
>   `GET /api/grocy/recipes`): valg fylder `grocy_recipe_id` + rigtig kategori + kostpris/CO2 → konsistent
>   med normale bons (tæller i omsætnings-/kategori-/margin-rapporter). Pr. linje: antal + beløb (total).
>   Grocy-festivalprisen vises kun som **reference-hint** — beløb-feltet er linjens TOTAL og styres af
>   brugeren (event-prisen afviger ofte fra Grocy; forudfyldes IKKE). Fri-tekst stadig muligt (kategori
>   'Event-salg', ingen recipe-id). Event-dropdown = ALLE events (`GET /api/events`), dato-overlap forvalgt.
> - ✅ **Brutto vs. netto + afgift som event-udgift (besluttet 29. juni).** Ved event-afregning (fx Zettle)
>   taster kontoret BRUTTO-salget pr. menu; differencen til netto-indbetalingen (udbyder-gebyr + arrangør-
>   afgift, fx Tivoli 10%) fyldes med ét klik via **"= rest"** i Gebyr/afgift-feltet. På et EVENT bogføres
>   denne afgift/gebyr som en **udgiftsbon** (event_role='expense', genbruger eventets udgiftsbon) — så den
>   tæller i eventets P&L (ikke kun som bank-fradrag). Standalone (uden event) → fee-allokering som før.
>   Faktura-linjer i Zettle-rapporten hører IKKE til kort/kontant-afregningen (separate cf_invoices).
> - ✅ **Per-event-indtægtsoverblik** `GET /cashflow/event-income` — bank-afstemt pr. event beregnet fra
>   allokeringer på eventets BONS: brutto (salgsbons), fradrag (udgiftsbons + udbyder-gebyr på samme tx),
>   netto, tx-antal. Matcher event-P&L'en (samme bons) → ingen divergens/dobbelttælling. Kort i Overblik.
> - **Eksisterende bons + netto-afregning:** har eventet allerede salgsbons (fx Rebel Food-festival),
>   splittes bank-indbetalingen direkte på dem (salg + udgiftsbons som fradrag, §2.F) — ingen ny bon nødvendig.

> B afstemmer kun FAKTURA-indtægter. Den anden halvdel er **direkte salg ved events**
> (festival, POS/Zettle, kontant) hvor der **ikke er skrevet en faktura** — de havner
> ellers permanent i "kan ikke matches". Det er det egentlige markerings-arbejde for kontoret.
>
> Model bekræftet: `events` (navn, start_date/end_date), `bons.event_id`+`event_role`, `event_forecast`.
- **Data:** `cf_transactions.matched_event_id` (FK → events). En tx kan være: faktura-matchet (B) ·
  event-koblet · bon-koblet (findes) · ignoreret · umatchet.
- **UI i "kan ikke matches"-listen** pr. tx: **"Kobl til event"** (søg navn+dato, primær) · "Kobl til bon" (findes) ·
  **"Opret bon fra indbetalingen"** når der INGEN intern post er (besluttet: den rigtige løsning er at oprette
  en rigtig bon for det direkte salg, ikke bare en kategori-markering).
- **Auto-forslag:** tx-dato inden for et events `start_date`–`end_date` → foreslå det event (ét-klik-kobling).
- **Per-event-indtægtsoverblik:** "Festival X = Y kr ind" (Σ koblede tx pr. event) — med fra start.
- Virkeligheden er rodet: én indbetaling pr. event, daglig Zettle-batch (mange salg → én indbetaling), eller
  kontant — koblingen skal kunne håndtere alle tre. Én tx → ét event.

### D. Forecast tier-2 i `/upcoming` (lille udvidelse)
`/upcoming` læser i dag kun `cf_invoices` (= faktureret). Tilføj **tier 2 = LEVERET + payment_type='invoice'
endnu ikke faktureret** ("Afventer fakturering"-køen som fremtidig indtægt), forfald ≈ `delivery_date` + Netto-dage.
Kontant/kort/MobilePay tæller IKKE (betalt ved levering → dukker op som CSV-bevægelse). Alt incl. moms.

### F. Split-allokering, universel kobling + to-akset status (tre-eksempel-delta — juni 2026)
> **Hvorfor dette tillæg.** Drift afdækkede tre konkrete sager, der hver er symptom på et
> strukturelt hul §A–E ikke lukker. §E's model er **`matched_event_id` enkelt-FK, "én tx → ét mål"**
> — den dækker den daglige Zettle-batch (ét event), men **ikke split**: én indbetaling der dækker
> flere bons, eller én faktura betalt ad flere gange. Beslutning (Leif, juni 2026): koblings-mål er
> **fleksibelt** (faktura ELLER bon ELLER event), direkte salg **attribueres til event**, og bank-
> afstemningen er et **blivende** mellem-sync-værktøj (e-conomic er sandhed, men afstemmes kun hver
> 14. dag / månedligt).
>
> **De tre sager → de fire huller:**
> | Live-sag | Hul | §A–E dækker? |
> |----------|-----|--------------|
> | Faktura 4112, REBEL FOOD 137.092 → 3 event-bons, betalt men ikke i e-conomic endnu | Kardinalitet: 1 tx → N mål m. beløb; + status-konflation | Nej (`matched_invoice_id`/`bon_id` er enkelt-FK; `betalt` blander to fakta) |
> | Bon 4001 findes, men ses ikke i koblings-feltet | Søge-scope: feltet henter kun `udestaaende` cf_invoices | Nej |
> | Zettle Michelin = kontant-indbetaling fra andet event | §E dækker — men kun 1:1 (ikke split-batch) | Delvist |

#### F.1 Kerne-primitiv: `cf_allocations` (én join-tabel opløser kardinaliteten)
```sql
CREATE TABLE cf_allocations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES cf_transactions(id) ON DELETE CASCADE,
  target_type    TEXT NOT NULL CHECK (target_type IN ('invoice','bon','event','fee')),
  target_id      TEXT NOT NULL,        -- cf_invoices.id (fakturanr, TEXT) | bons.id | events.id | fee-kategori
  amount         REAL NOT NULL,        -- INCL moms; del af tx.beloeb (negativ ved kreditnota/refusion)
  note           TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_cf_alloc_tx     ON cf_allocations(transaction_id);
CREATE INDEX idx_cf_alloc_target ON cf_allocations(target_type, target_id);
```
- **Én tx → mange allokeringer** (split: 4112 → 3 rækker). **Ét mål ← mange allokeringer** (rater/aconto).
- **Invariant:** `Σ amount pr. tx === tx.beloeb` når tx er fuldt afstemt (fee-allokeringer tæller med, se F.5).
  Rest (`beloeb − Σ amount`) = **uallokeret** → tx er *delvist* afstemt (ikke skjult fra listen).
  Forudbetaling/depositum modelleres IKKE (afklaret 29. juni: forekommer ikke) — en overskydende rest er
  derfor en fejl/afrunding, ikke en bevidst forudbetaling.
- **Bagudkompat (vigtigt — ingen big-bang):** `cf_transactions.matched_invoice_id` og §E's
  `matched_event_id` **bevares**, men bliver en **denormaliseret hurtig-sti for det rene 1:1-tilfælde**
  (præcis én allokering) — samme cache-mønster som `contact_points` → `companies.email`. Sandheden er
  allokeringerne. Migration backfiller eksisterende `matched_invoice_id` → én `cf_allocations`-række.
  → **§E bygges oven på `cf_allocations` (target_type='event'), ikke på et separat enkelt-FK-felt.**
  Ellers skal event-koblingen omskrives når split lander. (Se §7 — bekræft denne rækkefølge.)

#### F.2 To-akset status — "betalt i banken" ≠ "bogført i e-conomic"
§1 siger "kroner fra bank, status fra e-conomic". Dette gør de **to akser eksplicitte** og forbyder
at de smeltes til ét flag (roden til 4112's "betalt men ikke i economic endnu"):

| Akse | Kilde | Hyppighed | Felt |
|------|-------|-----------|------|
| **Bank-afstemt** (operationel) | `cf_allocations` dækker målets beløb | løbende, kontoret selv | *afledt* (Σ allokeringer ≥ beløb) |
| **E-conomic-bogført** (autoritativ) | reconcile B (`remainder===0`) | hver 14. dag / md. | `cf_invoices.betalt` |

- Et mål kan være **bank-afstemt men ikke bogført** (4112) — UI viser to separate flueben, aldrig ét.
- Bank-afstemt er det kontoret styrer mellem e-conomic-syncs (præcis behovet Leif beskrev).
- Når B senere bogfører målet, **konflikter det ikke** med en eksisterende bank-allokering — de er to akser. Vandmærket (§A) forhindrer at B gen-matcher den manuelt allokerede hale.

#### F.3 Universel koblings-søgning (løser bon 4001)
Bugkilde i dag: `_cfGetUmInvoices()` henter kun `fetchCfInvoices('udestaaende')`
([office/views/cashflow.js](office/views/cashflow.js)) → betalte/forfaldne/bon-uden-cf_invoice ses aldrig.
- **Nyt endpoint** `GET /cashflow/match-targets?q=&date=` → typet union: **bons** (bon_number/kunde/beløb/dato,
  uanset status) · **cf_invoices** (betalt eller ej) · **events** (navn + start/end). Erstatter den smalle liste.
- **Auto-forslag** bevares fra §E: tx-dato inden for events `start_date`–`end_date` → foreslå eventet.
  Udvid med: beløb ≈ bon-total / fakturanr i tekst → foreslå bon/faktura (samme signal som matchmotoren).
- **Udgifts-bons MEDTAGES som negative fradrag** (`event_role='expense'`, fx festival-arrangørens
  provision/afgift). Ved netto-afregning (arrangør trækker sin andel før udbetaling) vælges salgsbonnen
  (brutto, +) sammen med udgifts-bonnerne (−); Σ rammer netto-indbetalingen. De markeres "Udgift" i UI og
  indsættes med deres negative total. Kun ægte data-anomalier (negativ total UDEN expense-rolle) skjules.

#### F.4 Brutto vs. netto på kort-/MobilePay-afregning (besluttet 29. juni)
Zettle/MobilePay-afregning rammer banken **netto** (efter udbyder-gebyr), men event-salget er **brutto**.
Beslutning: **vis brutto, gebyr som egen linje** — så per-event-omsætningen er det faktiske salg.
Modellen klarer det inden for invarianten med en **negativ fee-allokering**:
```
Zettle-afregning, event "Michelin":  tx.beloeb = +9.105 (netto)
  → allokering 1: target=event   amount = +9.300   (brutto salg)
  → allokering 2: target=fee      amount =   −195   (Zettle-gebyr)
  Σ = 9.105 = tx.beloeb ✓
```
- **Per-event-overblik** (§E) summerer kun `target_type='event'` → viser brutto (9.300). Gebyr-linjen
  hører til samme tx, så "brutto / gebyr / netto" pr. event er afledt uden ekstra felt.
- Bruttobeløbet tastes fra Zettle/MobilePay-rapporten; gebyret kan udfyldes som `netto − brutto`.
- Gælder også §E's `matched_event_id`-1:1-sti: en gebyr-fri afregning er bare én event-allokering.

#### F.5 Fuld case-liste = acceptkriterier (byg IKKE før alle er gennemtænkt)
| # | Case | Forventet håndtering |
|---|------|----------------------|
| 1 | Samlefaktura: 1 indbetaling → N bons (4112) | 1 tx → N allokeringer (**target=bon**, besluttet). Bank-afstemt straks; bogført afventer B |
| 2 | Delvis / aconto / rater: N indbetalinger → 1 mål | N allokeringer på samme target. Mål bank-afstemt når Σ ≥ beløb; ellers "delvist (X af Y)" |
| 3 | Zettle/**MobilePay**/kontant-batch dækker N events | 1 tx → N event-allokeringer (+ fee-linje pr. F.4). Generaliserer §E's 1:1 |
| 4 | Kreditnota / refusion (penge UD mod et mål) | Negativ tx → negativ allokering. Reducerer målets bank-afstemte sum |
| 5 | Støj uden mål — **bankgebyr/renter · intern overførsel · løn/privathævning/SKAT** | Kategorisér (ikke blind-ignorér): `ignored` udvides med disse 3 grund-kategorier + note |
| 6 | 1 indbetaling = faktura + Zettle på samme event | Blandede mål-typer i samme tx (target_type pr. allokering) — modellen tillader det |
| 7 | Indbetaling > Σ kendte mål | Rest forbliver uallokeret; tx vises som delvist afstemt, ikke skjult (IKKE forudbetaling — sker ikke) |
| 8 | Mål allerede e-conomic-bogført, nyt bank-match dukker op | Vandmærke-guard (§A) + to-akset status forhindrer dobbelt-tælling |
| 9 | "Opret bon fra indbetalingen" (intet internt spor — §E) | Opret rigtig bon for direkte salg → allokér tx til den nye bon |

**Afklaret som IKKE relevant (29. juni — byg ikke):** forudbetaling/depositum · gavekort/klippekort ·
én betaling fra flere kunder · modregning (leverandør = kunde). MobilePay-afregning ER relevant (case 3).

> **Listen er bevidst ikke udtømmende.** Inden migration 115 skrives: kør den igennem med Leif og
> tilføj de cases driften kender og denne ikke fanger (fx valuta, samlebetaling på tværs af måneder).

#### F.6 "Kan ikke matches"-listen: vandmærke-FOLD + event-kontant løftet over (29. juni)

> **Hvorfor.** Et tidligt forsøg på at *skjule* posteringer der "matcher en betalt faktura på
> beløb" var en fejl: med ~2.900 fakturaer rammer næsten ethvert beløb tilfældigt en betalt
> faktura (±2%), så det skjulte event-kontant (fx "Zettle Michelin" 9.105 matchede 5 urelaterede
> fakturaer). Beløbs-match er lige så tilfældigt som fakturanummer-match (jf. B) — fjernet.

- **Princip:** en postering *skjules ALDRIG* automatisk. Den foldes eller løftes — men er altid
  findbar via søgning (søg går på tværs af ALT, også pre-vandmærke).
- **Vandmærke-FOLD:** posteringer EFTER `economic_booked_until` er actionable → vises. Posteringer
  FØR/PÅ vandmærket antages bogført i e-conomic (B) → **foldes** bag "▸ vis N tidligere" (ikke skjult).
  `GET /transactions?unmatched=1` returnerer `folded_count`; `&include_folded=1` henter dem frem.
- **Event-kontant løftes OVER folden:** bankposteringer hvis tekst matcher `EVENT_CASH_SQL`
  (Zettle/MobilePay/kontant/Vipps, positive) vises ØVERST med **🎪 kræver salgsbon**-tag — også
  pre-vandmærke — fordi de aldrig er faktura-afregnet og kræver en salgsbon (§E's "Opret bon").
  `unmatched_count` tæller dem med; `folded_count` ekskluderer dem (`is_event_cash`-flag pr. række).
- **Bevidst lille hul:** Zettle-afregninger halter typisk ~en uge efter event-datoen, så de falder
  uden for §E's ±5-dages auto-forslag — eventet vælges da manuelt i Opret-bon-dropdownen. Kan
  udvides til en større event-kontant-buffer hvis driften ønsker det.

---

## 3. Hvad der IKKE skal bygges (det duplikerer drift-kode)
- ❌ `bank_transactions`-tabel → brug `cf_transactions`.
- ❌ `office/views/pengestroem.js` → udvid `office/views/cashflow.js`.
- ❌ Ny CSV-parser → genbrug den eksisterende Nykredit/Fælles Kassen-parser i `routes/cashflow.js`.
- ❌ Ny matchliste/endpoints → tilføj kun vandmærke-guard til de eksisterende.

---

## 4. Migration
**`112_cashflow_watermark.sql`** (IKKE 110 — taget af economic). Reelt indhold er minimalt:
```sql
INSERT OR IGNORE INTO cf_meta (key, value) VALUES ('economic_booked_until', '');
-- bons.invoice_number + faktureret_at: tilføjes af den e-conomic-migration der lander først (Spor 2),
-- ikke her. Lander de allerede via Spor 2 → denne migration rører dem ikke.
```

**`115_cashflow_allocations.sql`** (§2.F — næste ledige nr.; 114 er taget på branch i flight — bekræft mod main ved build):
```sql
-- cf_allocations (DDL i §2.F.1) + backfill af eksisterende 1:1-matches:
INSERT INTO cf_allocations (transaction_id, target_type, target_id, amount)
  SELECT id, 'invoice', matched_invoice_id, beloeb
  FROM cf_transactions WHERE matched_invoice_id IS NOT NULL;
-- (+ tilsvarende backfill af §E's matched_event_id hvis det allerede er landet før 115)
-- matched_invoice_id/matched_event_id DROPPES IKKE — de bliver 1:1-hurtig-sti (§2.F.1).
```
**Skriv først 115 når §2.F.5-caselisten er gennemgået (gjort 29. juni).**

---

## 5. Byggerækkefølge
**A + B er bygget (27. juni). F er bygget (29. juni)** — migration 115 `cf_allocations`, allokerings-
endpoints (`POST/DELETE /allocations`, `GET /transactions/:id/allocations`, `GET /match-targets`),
to-akset status (allokering rører IKKE `betalt`), split-UI i "kan ikke matches"-listen. Browser-
verificeret mod prod-data-kopi: alle tre live-sager (4001 universel kobling, split, Zettle event+gebyr).
**E er næste opgave** — event-kobling som selvstændig feature (auto-forslag på dato-overlap,
opret-bon-fra-indbetaling, per-event-indtægtsoverblik) bygges oven på `cf_allocations` (target='event').
1. `cf_meta['economic_booked_until']` + vandmærke-guard i matchmotoren (A). ✅
2. **`services/cashflowReconcile.js` (B).** REST `/invoices/booked` → `remainder===0`=betalt →
   `cf_invoices.betalt` + ryk vandmærke. Match via **bon-nr i overskriften** (`notes.heading`, fx "#B4111" /
   "4093 & 4094") — IKKE fakturanummeret (separate serier). Nightly cron + "⟳ Synk e-conomic"-knap. ✅
3. ✅ **Split-allokering + universel kobling (F) — BYGGET 29. juni.** Migration 115 `cf_allocations`
   + backfill, allokerings-endpoints, `GET /cashflow/match-targets`, split-UI. Browser-verificeret.
   `cf_allocations` ligger nu klar som mål for E's event-kobling (target_type='event').
4. ✅ **Direkte salg / event-indtægt (E) — BYGGET 29. juni.** E.1 auto-forslag (`/events-on-date`),
   E.2 per-event-overblik (`/event-income`), E.3 opret-bon-fra-indbetaling (`/create-bon-from-tx`) —
   alt oven på `cf_allocations`. Browser-verificeret end-to-end.
5. `bons.invoice_number` + `faktureret_at` + wiring i "Markér faktureret" (C) — koordinér med Spor 2.
6. Forecast tier-2 i `/upcoming` (D).

---

## 6. Test (tilføj til eksisterende cashflow-tests / `tests/specs/T_PENGESTROEM.md`)
- Vandmærke-guard: postering/faktura før `economic_booked_until` auto-matches ikke.
- Forecast tier-2: LEVERET+invoice tælles; LEVERET+card tælles IKKE.
- Forfald = `faktureret_at` + Netto-dage.
- KPI "heraf moms" via `shared/moms.js`.
- (Fase 2) mock `openapi()` bookedentries: `dueAmount=0` → `cf_invoices.betalt=1`; match via bon-nr i reference; vandmærke rykkes.
- **(§2.F) Split:** 1 tx → 3 allokeringer; Σ = beløb → mål bank-afstemt; Σ < beløb → "delvist". Σ > |beloeb| afvises (invariant).
- **(§2.F) To akser:** mål bank-afstemt men `cf_invoices.betalt=0` → begge flueben uafhængige; B-bogføring konflikter ikke.
- **(§2.F) Universel kobling:** `match-targets?q=` finder bon uden cf_invoice + betalt faktura (bon 4001-regression).
- **(§2.F) Kreditnota:** negativ tx → negativ allokering reducerer målets afstemte sum.

---

## 7. Åbne punkter / beslutninger
| Punkt | Hvem | Status |
|-------|------|--------|
| **Prioritet:** auto-afstemning (B) ønskes — fjerner manuel betalt-markering | Leif | ✅ besluttet (B prioriteret) |
| Kilde til betalt-status: REST `/invoices/booked.remainder` (ikke OpenAPI) | — | ✅ verificeret 26. juni |
| `invoice_number`+`faktureret_at` ejes af e-conomic Spor 2 (anbefalet) — bekræft rækkefølge | Simon | åben |
| Bekræft at booked-faktura eksponerer `references.other` (til bon-nr-match) på de NYE fakturaer | Simon | åben (gamle matches via fakturanr) |
| "Bankdata for gammel"-tærskel (dage) → `cf_meta` eller settings | Leif | åben |
| **(§2.F) §E bygger på `cf_allocations` (target='event'), ikke separat `matched_event_id`-FK | Leif | ✅ besluttet 29. juni |
| **(§2.F) Caseliste §2.F.5 gennemgået + edge-cases afklaret (brutto/gebyr, forudbetaling, MobilePay) | Leif | ✅ gjort 29. juni |
| **(§2.F) Samlefaktura-mål: allokér til de N **bons** (ikke en samle-cf_invoice) | Leif | ✅ besluttet 29. juni |

---

## Reference
- `CLAUDE_ECONOMIC_AUTH.md` §7 — `openapi()`, `bookedentries`, `dueAmount`, fakturanr./reference = nøgle
- `CLAUDE_ECONOMIC_ADAPTER.md` — `buildReference` sætter bon-nr i `references.other` (afstemnings-broen)
- `CLAUDE_ECONOMIC_PLAN.md` — Spor 4 (dette udfylder det) + Spor 2 (leverer `invoice_number`/`faktureret_at`)
- `BON_V2_PRINCIPPER.md` §6b/6c · `shared/moms.js` — moms-doktrin + helpers
- Eksisterende kode: `routes/cashflow.js`, `office/views/cashflow.js`, `services/cashflowSync.js`, migrationer 047/078/079/082/092
