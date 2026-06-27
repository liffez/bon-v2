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

### E. Direkte salg / event-indtægt (besluttet 27. juni — bygges som næste)
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

---

## 5. Byggerækkefølge
**A + B er bygget (27. juni)** — service + endpoint + cron + UI + 12 tests. **E er næste opgave (28. juni).**
1. `cf_meta['economic_booked_until']` + vandmærke-guard i matchmotoren (A). ✅
2. **`services/cashflowReconcile.js` (B).** REST `/invoices/booked` → `remainder===0`=betalt →
   `cf_invoices.betalt` + ryk vandmærke. Match via **bon-nr i overskriften** (`notes.heading`, fx "#B4111" /
   "4093 & 4094") — IKKE fakturanummeret (separate serier). Nightly cron + "⟳ Synk e-conomic"-knap. ✅
3. **Direkte salg / event-indtægt (E) — næste opgave.** `cf_transactions.matched_event_id` + kobl-til-event +
   opret-bon-fra-indbetaling + auto-forslag på dato-overlap + per-event-indtægtsoverblik. (Spec §2.E.)
4. `bons.invoice_number` + `faktureret_at` + wiring i "Markér faktureret" (C) — koordinér med Spor 2.
5. Forecast tier-2 i `/upcoming` (D).

---

## 6. Test (tilføj til eksisterende cashflow-tests / `tests/specs/T_PENGESTROEM.md`)
- Vandmærke-guard: postering/faktura før `economic_booked_until` auto-matches ikke.
- Forecast tier-2: LEVERET+invoice tælles; LEVERET+card tælles IKKE.
- Forfald = `faktureret_at` + Netto-dage.
- KPI "heraf moms" via `shared/moms.js`.
- (Fase 2) mock `openapi()` bookedentries: `dueAmount=0` → `cf_invoices.betalt=1`; match via bon-nr i reference; vandmærke rykkes.

---

## 7. Åbne punkter / beslutninger
| Punkt | Hvem | Status |
|-------|------|--------|
| **Prioritet:** auto-afstemning (B) ønskes — fjerner manuel betalt-markering | Leif | ✅ besluttet (B prioriteret) |
| Kilde til betalt-status: REST `/invoices/booked.remainder` (ikke OpenAPI) | — | ✅ verificeret 26. juni |
| `invoice_number`+`faktureret_at` ejes af e-conomic Spor 2 (anbefalet) — bekræft rækkefølge | Simon | åben |
| Bekræft at booked-faktura eksponerer `references.other` (til bon-nr-match) på de NYE fakturaer | Simon | åben (gamle matches via fakturanr) |
| "Bankdata for gammel"-tærskel (dage) → `cf_meta` eller settings | Leif | åben |

---

## Reference
- `CLAUDE_ECONOMIC_AUTH.md` §7 — `openapi()`, `bookedentries`, `dueAmount`, fakturanr./reference = nøgle
- `CLAUDE_ECONOMIC_ADAPTER.md` — `buildReference` sætter bon-nr i `references.other` (afstemnings-broen)
- `CLAUDE_ECONOMIC_PLAN.md` — Spor 4 (dette udfylder det) + Spor 2 (leverer `invoice_number`/`faktureret_at`)
- `BON_V2_PRINCIPPER.md` §6b/6c · `shared/moms.js` — moms-doktrin + helpers
- Eksisterende kode: `routes/cashflow.js`, `office/views/cashflow.js`, `services/cashflowSync.js`, migrationer 047/078/079/082/092
