# Moms-audit Fase 1 — Kortlægning

**Dato:** 2026-05-01
**Bon v2 commit:** `2245b70`
**Helpers-version:** `shared/moms.js` introduceret i `8c6dcb3` (Commit 1)
**Auditør:** Claude Code (automatiseret)
**Spec:** `docs/CLAUDE_MOMS_AUDIT.md` + `docs/CLAUDE_MOMS_AUDIT_AUTO.md`

---

## Sammenfatning

| # | Område | Tier | Status | Antal fund |
|---|--------|:----:|--------|-----------:|
| 1 | Tilbud-modulet (`office/views/tilbud.js`, `routes/quotes.js`) | 1 | ✅ MIGRERET | 0 |
| 2 | Tilbuds-PDF-eksport | 1 | ✅ MIGRERET | 0 |
| 3 | Tilbuds-mail | 1 | ✅ MIGRERET | 0 |
| 4 | Bestillings-bekræftelses-mail | 1 | ⚪ IKKE-RELEVANT | 0 |
| 5 | Formbuilder-kvittering | 1 | ⚪ IKKE-RELEVANT | 0 |
| 6 | Faktura-generering | 1 | ❌ IKKE FUNDET | – |
| 7 | E-conomic-adapter | 1 | ❌ IKKE FUNDET | – |
| **8** | **Public tilbuds-link (`tools/tilbud-standalone-v2.html`)** | **1** | **✅ MIGRERET (commit `7d9545d`)** | **0** |
| 9 | Bon-detalje (office) | 2 | ✅ MIGRERET | 0 |
| 10 | Bon-detalje (kitchen) | 2 | ✅ MIGRERET | 0 |
| 11 | Tilbud → bon-konvertering | 2 | ✅ MIGRERET | 0 |
| 12 | Mobile shell | 2 | ⚪ IKKE-RELEVANT | 0 |
| 13 | Kalender-dagstotaler | 2 | ✅ MIGRERET (server-side) | 0 |
| 14 | Planning-view | 2 | ⚠️ MIGRATION-KANDIDAT | 1 |
| 15 | Cashflow-dashboard | 3 | 🔍 KRÆVER VURDERING | – |
| 16 | Statistik/rapporter | 3 | 🔍 KRÆVER VURDERING | – |
| 17 | CSV/Excel-eksport | 3 | ⚪ IKKE-RELEVANT | 0 |
| 18 | DB% pr. produkt | 3 | ✅ MIGRERET | 0 |
| 19 | Dashboard "Start dagen" | 3 | 🔍 KRÆVER VURDERING | – |
| 20 | Smartplan løn vs salg | 3 | ⚪ IKKE-RELEVANT | 0 |
| 21 | Indkøbsliste (ex moms) | 4 | ⚪ IKKE-RELEVANT | 0 |
| 22 | Purchase order | 4 | ⚪ IKKE-RELEVANT | 0 |
| 23 | Goods receipt valuation | 4 | ⚪ IKKE-RELEVANT | 0 |
| 24 | Grocy cost_price-snapshot | 4 | ⚪ IKKE-RELEVANT | 0 |
| 25 | iZettle/POS | 5 | ⚪ IKKE-RELEVANT (ikke bygget) | – |
| 26 | NemHandel-faktura | 5 | ⚪ IKKE-RELEVANT (ikke bygget) | – |
| 27 | Whiteboard | 5 | ⚪ IKKE-RELEVANT (ingen pris) | – |
| 28 | Menu-AI-agent | 5 | ❌ IKKE FUNDET (kun spec, ingen kode) | – |

**Totaler (efter Fase 2 commit `7d9545d`):**
- 🔴 KRITISK BUG: **0 områder** (#8 fixet 1. maj 2026 — 0 nginx-hits før fix, ingen kunder ramt)
- ⚠️ Migration-kandidater: **1 område** (#14, kosmetisk)
- 🔍 Kræver vurdering: **3 områder** (#15, #16, #19 — alle om "omsætning ex eller incl?")
- ✅ Migreret: **10 områder** (#1, #2, #3, #8, #9, #10, #11, #13, #14 (math), #18)
- ⚪ Ikke-relevant: **11 områder**
- ❌ Ikke fundet (mangler kode): **3 områder** (#6, #7, #28)

---

## Globale grep-resultater

### A1 (`* 1.25`)
**0 fund** udenfor `shared/moms.js` og `tests/`.

### A2 (`/ 1.25`)
**1 fund:** `shared/planning.js:574` — `var vatDiv = isExcl ? 1.25 : 1;`. Det er en **lokal toggle-divisor** (1.25 når brugeren har valgt "u/moms"-visning, ellers 1). Bruges intentionelt på linjepriser linje 601-602. Math er korrekt — men kunne erstattes med `Moms.MOMS_FACTOR` for konsistens. Se #14.

### A3 (`* 0.25` / `0.25 *`)
**0 fund** med moms-kontekst. Falske positiver:
- `tools/crm-rfm-icp.html:831` — `Math.floor(ranked.length * 0.25)` — RFM-kvartil på top-25 %-kunder. Ingen moms-relation.
- `shared/dashboard_chart.js:1158` — `'rgba(142,99,31,0.25)'` — alpha-værdi i CSS-farve.

### A3b (`grand * 25 / 125`)
**0 fund.**

### A5 (moms-konstanter)
**1 fund — som forventet:** `db/helpers.js:170-171` re-eksporterer `MOMS_RATE` + `MOMS_FACTOR` fra `shared/moms.js`. Ingen drift.

---

## SQL B-resultater

| Query | Resultat |
|---|---|
| **B1** — bons hvor `total_price` ≠ `SUM(line_total) + delivery_price` (>1 kr) | **0 rækker** ✓ |
| **B2** — bons med BÅDE `x-Levering`-linje OG `delivery_price>0` | **0 rækker** ✓ (quick-fix har intet at rette) |
| **B3** — bons med flere `x-Levering`-linjer | **23 rækker** (alle fra v1-sync, fx `cafe-73` har 2× "By-Ekspressen Standard"). Datafejl — ikke moms-relateret. Loggges i KENDTE_DATABUGS. |
| **B6** — `line_total ≠ quantity × unit_price` (>0.5 kr) | **0 rækker** ✓ |
| **B7** — mail-skabeloner med `moms`/`total`/`pris`/`1.25` | **0 rækker** ✓ |
| **B8** — settings med `moms`/`vat`/`price` | **1 række:** `show_prices_in_planning=1` (ingen moms-konstant i settings) |

DB er konsistent efter Commit 1-3. Ingen efterladt skæv data.

---

## Per-område

### #1 — Tilbud-modulet (Tier 1)

**Filer:** `office/views/tilbud.js`, `routes/quotes.js`

**Bug-mønstre fra spec:** A, C

**Grep-fund:** 0

**Status:** ✅ MIGRERET

Verificeret i Commit 2 og Commit 3. Alle 5 magic `1.25` i `tilbud.js` migreret til `window.Moms.inclToExcl()`. `routes/quotes.js` udstiller `total_incl_moms`/`total_excl_moms`/`moms_amount` på GET-svar.

---

### #2 — Tilbuds-PDF-eksport (Tier 1)

**Filer:** `office/views/tilbud.js` `_tGenPDF()` (linje 1441 + 1572)

**Bug-mønstre fra spec:** A

**Grep-fund:** 0

**Status:** ✅ MIGRERET

PDF-rendering bruger `window.Moms.inclToExcl(tot)` siden Commit 2. Server-side PDF findes ikke.

---

### #3 — Tilbuds-mail (Tier 1)

**Filer:** `office/views/tilbud.js` `_tSendQuoteMail()` (linje 1608), mail-skabelon `booking_confirmation`

**Bug-mønstre fra spec:** A — mail-skabelon kunne have hardcoded × 1.25

**Grep-fund:** 0

**SQL B7:** 0 mail-skabeloner indeholder hardcoded moms-tal.

**Status:** ✅ MIGRERET

`_tSendQuoteMail()` genererer PDF (via `_tGenPDF` → bruger Moms-helpers) og uploader som vedhæftning. Mail-body indeholder ingen pris-tekst.

---

### #4 — Bestillings-bekræftelses-mail (Tier 1)

**Filer:** `mail_templates`-tabel: `booking_confirmation`, `web_order_confirmation`, `booking_smagning_confirmation`

**Bug-mønstre fra spec:** A

**Grep-fund:** 0

**Status:** ⚪ IKKE-RELEVANT

Skabelonerne indeholder ikke pris- eller moms-felter overhovedet (bekræftet via SQL og mail-historik). Kun bonnummer, dato, tid, adresse, pax.

---

### #5 — Formbuilder-kvittering (Tier 1)

**Filer:** `docs/bestilling (1).html`, `docs/formbuilder.html`, `tools/bestilling_v2.html`

**Bug-mønstre fra spec:** A

**Grep-fund:** Ingen `1.25`/`0.25` i moms-kontekst (formularerne har "1.25" som CSS-værdi, ikke beregning).

**Status:** ⚪ IKKE-RELEVANT

Formularerne indsamler kun kontakt+ordreinfo og POSTer til `/webhook/bestilling`. Viser ingen priser til kunden.

---

### #6 — Faktura-generering (Tier 1)

**Filer:** `routes/invoices.js` (eksisterer — `GET /api/invoices/queue`, ingen generering)

**Status:** ❌ IKKE FUNDET

`routes/invoices.js` indeholder kun arbejdsliste-API (`pending`, `done`, `summary`). Faktura-generering er **ikke bygget**. Audit-relevans først når den bygges.

---

### #7 — E-conomic-adapter (Tier 1, kritisk når den bygges)

**Filer:** Findes ikke. `routes/companies.js` og `routes/customers.js` har kun PATCH-endpoints til at gemme `economic_customer_id`.

**Status:** ❌ IKKE FUNDET

E-conomic-adapter er **ikke bygget**. Når den bygges skal den konvertere `unit_price` ex moms via `inclToExcl()` (jf. doktrinen). Skal med i CLAUDE_MOMS_AUDIT_AUTO.md når koden findes.

---

### #8 — Public tilbuds-link (`tools/tilbud-standalone-v2.html`) (Tier 1) 🔴

**Filer:** `tools/tilbud-standalone-v2.html`

**Bug-mønstre fra spec:** A — original 25 %-overshoot bug

**Grep-fund:** 3 forekomster af `moms = pre * .25`:

| Linje | Kontekst | Type |
|---:|---|---|
| 955 | Tabel-rendering (HTML) | A |
| 1041 | Preview-rendering (HTML) | A |
| 1131 | PDF-rendering | A |

```javascript
const dA=sub*(dPct/100),pre=sub-dA,moms=pre*.25,tot=pre+moms;
```

`pre` er incl. moms (jf. doktrin), så `moms = pre × 0.25` overskyder med 25 %, og `tot = pre + moms = 125 % × incl`. Det er **præcis den oprindelige tilbud.js-bug** der blev fixet i Commit 2 — men den lever videre i denne fil.

**Public-eksponering:** Filen serveres statisk via `app.use(express.static(__dirname))` i `server.js:63`. Den er nåbar fra `https://bon.ristetrug.dk/tools/tilbud-standalone-v2.html`. Hvis kunder har modtaget link, ser de 25 %-overshoot.

**Status:** 🔴 KRITISK BUG — kunde-eksponeret prisbug.

**Foreslået ændring:**
1. Tilføj `<script src="/shared/moms.js"></script>` i `<head>`.
2. Erstat alle 3 forekomster af `pre * .25` → `Moms.momsOfIncl(pre)`.
3. Rabat-rendering (`fK(dA)`) bør overvejes om det er ex eller incl moms — verificer mod tilbud.js-mønstret som blev valgt.

**Leif-beslutning:** [x] **GO migration** — fixet i commit `7d9545d` (1. maj 2026)

**Verifikation før fix:**
- Nginx access.log på prod: **0 hits** på `/tools/tilbud-standalone-v2.html` — præventiv migration, ingen kunder var ramt
- Filen var untracked i git før fix — gemt som lokal udkast, aldrig delt

**Hvad blev ændret (commit 7d9545d):**
- `<head>`: tilføjet `<script src="/shared/moms.js">`
- 3× math-blokke: `pre * .25` → `Moms.inclToExcl(tot)` så total ikke længere overshyder med 25 %
- Rabat-linje: vises nu i ex moms-rummet (`Moms.inclToExcl(dA)`) konsistent med `office/views/tilbud.js`
- Labels: `"Subtotal"` → `"Subtotal (u/moms)"` så label matcher værdi
- Filen er nu tracked i git med fix'et som første version

**Verifikation efter fix:**
- Browser-preview: `window.Moms` loadet, T-5 math-blok giver 23.650/18.920/4.730 ✓
- `tests/moms.test.js`: 9/9 ✓

---

### #9 — Bon-detalje-view (office) (Tier 2)

**Filer:** `office/views/bons-list.js`, `shared/bon_drawer.js`, `shared/modal.js`

**Bug-mønstre fra spec:** A, B

**Grep-fund:** 0 (efter Commit 4)

**Status:** ✅ MIGRERET

`shared/modal.js` bruger `Moms.momsOfIncl()` (Commit 2). `shared/bon_drawer.js` `_buildMailVars` bruger `Moms.inclToExcl/momsOfIncl` (Commit 4). `office/views/bons-list.js` viser kun `total_price` direkte (ingen egen beregning).

---

### #10 — Bon-detalje-view (kitchen) (Tier 2)

**Filer:** `shared/bon_kort.js`, `shared/bon_kort_builder.js`

**Status:** ✅ MIGRERET

`bon_kort.js` `_buildMailVars` bruger `Moms.*` (Commit 4). `bon_kort_builder.js` viser ingen priser. `shared/modal.js` (info-modal) bruger `Moms.momsOfIncl()` (Commit 2).

---

### #11 — Tilbud → bon-konvertering (Tier 2)

**Filer:** `routes/quotes.js:454` `POST /:id/convert`

**Status:** ✅ MIGRERET

Konvertering er en simpel `UPDATE bons SET is_offer=0, offer_status='won'`. `total_price` ændres ikke i konverteringen, og `recalcTotal` (Commit 3) sikrer at den genberegnes konsistent ved næste line-mutation.

---

### #12 — Mobile shell (Tier 2)

**Filer:** `mobile/views/bons.js`, `mobile/views/oversigt.js`, m.fl.

**Status:** ⚪ IKKE-RELEVANT

Mobile views viser ikke priser/moms — de viser bonnummer, kunde, status, tid. Ingen egen moms-beregning.

---

### #13 — Kalender-dagstotaler (Tier 2)

**Filer:** `shared/calendar.js`, `routes/kitchen.js` (calendar-endpoint)

**Grep-fund:** 0 i `shared/calendar.js`. Server aggregerer `total_price` direkte uden moms-konvertering.

**Status:** ✅ MIGRERET (server-side)

Frontend laver ikke egen moms-beregning. Hvis dagstotaler senere skal vises ex moms, kan det laves via API-feltet `total_excl_moms`. Ingen kodefix nødvendig nu.

---

### #14 — Planning-view (Tier 2)

**Filer:** `shared/planning.js`

**Bug-mønstre fra spec:** A — aggregerer

**Grep-fund:** 1

| Linje | Indhold | Type |
|---:|---|---|
| 574 | `var vatDiv = isExcl ? 1.25 : 1;` | Bevidst toggle-divisor |

**Status:** ⚠️ MIGRATION-KANDIDAT (kosmetisk)

Variablen `vatDiv` er en lokal toggle der omsætter incl-moms-priser til ex moms når brugeren har valgt "u/moms"-visningstilstand. Bruges på linje 601-602 til at dividere linje-priser. Math er korrekt og fanger Commit 1-doktrinen.

**Forslået ændring:**
```js
var vatDiv = isExcl ? Moms.MOMS_FACTOR : 1;
```

Eller alternativt brug `Moms.inclToExcl()` direkte og fjern `vatDiv` helt. Lavt prioriteret — koden er korrekt som den er, og pre-commit-hooken (når den aktiveres) vil kun ramme bart `1.25`.

**Leif-beslutning:** [ ] GO migration / [ ] NO-GO / [ ] KRÆVER DISKUSSION

---

### #15 — Cashflow-dashboard (Tier 3)

**Filer:** `routes/cashflow.js`, `office/views/cashflow.js`

**Grep-fund:** 0 magic-numre

**Status:** 🔍 KRÆVER VURDERING

Cashflow-dashboard rapporterer `b.total_price` som "omsætning". Hvis det er **omsætning til ledelsesrapportering**, er konventionen typisk EX moms — men koden viser INCL moms-tal uden at sige det.

**Vurderingsspørgsmål til Leif:**
1. Hvilket basis skal "omsætning" rapporteres på i cashflow-dashboardet — ex eller incl moms?
2. Hvis ex moms ønskes: skal det gælde alle metrics (saldo, udestående, forfaldne, forventet 30d)?

Hvis ex moms: opret tickets til at konvertere via `Moms.inclToExcl()` på frontend eller bedre — udstil `revenue_basis: 'incl'/'excl'` flag på API.

**Leif-beslutning:** [ ] Omsætning ex moms / [ ] Omsætning incl moms (status quo) / [ ] KRÆVER DISKUSSION

---

### #16 — Statistik/rapporter (Tier 3)

**Filer:** `routes/reports.js`, `office/views/rapporter.js`

**Grep-fund:** 0 magic-numre

**Status:** 🔍 KRÆVER VURDERING

`routes/reports.js` `SUM(b.total_price)` returneres som "amount" i 4 endpoints (summary, monthly, top-customers, monthly-table, cumulative). Det er incl moms.

**Vurderingsspørgsmål til Leif:**
- Skal "omsætning" i rapporter være ex moms (som er standard for ledelsesrapportering) eller incl moms?

Konsistent med #15 — bør besluttes samtidig.

**Leif-beslutning:** [ ] Ex moms / [ ] Incl moms (status quo) / [ ] KRÆVER DISKUSSION

---

### #17 — CSV/Excel-eksport (Tier 3)

**Grep-fund:** Ingen `csv`/`xlsx`-relateret kode i `routes/`/`services/`.

**Status:** ⚪ IKKE-RELEVANT

Ingen eksport-funktioner bygget endnu.

---

### #18 — DB% pr. produkt (Tier 3)

**Filer:** `office/views/tilbud.js` (DB%-kolonne i prisoverslag), `shared/planning.js` (margin-kolonne i planlægningsbon)

**Bug-mønstre fra spec:** C

**Status:** ✅ MIGRERET

Begge bruger `Moms.inclToExcl()` siden Commit 2. Margin-formel er `(salgEx − costEx) / salgEx * 100`.

**Caveat (loggges i `KENDTE_DATABUGS.md`):** 4.454 v1-migrerede `bon_lines` har `cost_price ≥ unit_price` — sync-bug. DB%-tabellen er upålidelig for de rækker indtil v1-shutdown og data-rydning. Ikke et moms-problem.

---

### #19 — Dashboard "Start dagen" (Tier 3)

**Filer:** `routes/dashboard.js`, `office/views/dashboard.js`, `shared/dashboard_chart.js`

**Grep-fund:** 0 magic-numre (kun en RGBA-alpha-værdi)

**Status:** 🔍 KRÆVER VURDERING

Dashboard viser KPI-tal (Omsætning MTD m.fl.) baseret på `total_price`. Samme spørgsmål som #15/#16 — skal det være ex eller incl moms?

Også: spec'en J5 i `CLAUDE_TILBUD_PRIS.md` påpeger at dashboard `is_offer`/`is_internal`-filtrering bør efterprøves — men det er ikke en moms-bug.

**Leif-beslutning:** [ ] Ex moms / [ ] Incl moms / [ ] KRÆVER DISKUSSION

---

### #20 — Smartplan løn vs salg (Tier 3)

**Filer:** `routes/smartplan.js`, `services/smartplanAdapter.js`

**Status:** ⚪ IKKE-RELEVANT

Ingen lønsammenligning i koden. Smartplan-data er kun bemandings-info (shifts + employees).

---

### #21 — Indkøbsliste (Tier 4)

**Filer:** `shared/indkob.js`, `routes/horkram.js`, `routes/orders.js`

**Status:** ⚪ IKKE-RELEVANT (ex moms-konvention bevares)

Indkøbsliste bruger leverandørpriser ex moms. Ingen krydsfertilisering med salgs-konventionen.

---

### #22 — Purchase order (Tier 4)

**Filer:** `routes/orders.js`

**Status:** ⚪ IKKE-RELEVANT

`purchase_orders.price_per_pack` gemmes som ex moms (leverandørens pris). Ingen moms-konvertering ind/ud.

---

### #23 — Goods receipt valuation (Tier 4)

**Filer:** `routes/goods-receipts.js`

**Status:** ⚪ IKKE-RELEVANT

Goods receipt opdaterer Grocy-lager med ex moms-priser fra PO. Ingen valutakonvertering.

---

### #24 — Grocy cost_price-snapshot (Tier 4)

**Filer:** `routes/bons.js` POST `/lines` (snapshot fra Grocy ved tilføjelse)

**Status:** ⚪ IKKE-RELEVANT

`bon_lines.cost_price` gemmes som ex moms (jf. doktrin) — uden konvertering. Bekræftet via grep — ingen `* 1.25` ved cost_price-håndtering.

**Note:** Antagelsen "cost_price ex moms" er ikke 100 % verificerbar fra data alene (ratio-invarians) — men holder mod Grocy-konventionen. 4.454 v1-rækker har skæve værdier — separat sync-bug, ikke moms.

---

### #25 — iZettle/POS (Tier 5)

**Status:** ⚪ IKKE-RELEVANT (ikke bygget)

Verificeret via kode-gennemgang 1. maj 2026 — ingen `routes/pos.js`, `services/zettle*.js` eller `payment_type='pos'`-bons. POS-undtagelsesmønster dokumenteret i `routes/bons.js` `recalcBonTotal` (Commit 3-amendment).

---

### #26 — NemHandel-faktura (Tier 5)

**Status:** ⚪ IKKE-RELEVANT (ikke bygget)

Ingen NemHandel-integration. Skal med når den bygges.

---

### #27 — Whiteboard (Tier 5)

**Status:** ⚪ IKKE-RELEVANT (ingen pris-render)

Whiteboard-sidekick henter task-data, ikke priser.

---

### #28 — Menu-AI-agent (Tier 5)

**Filer:** `docs/CLAUDE_MENU_AGENT.md` findes — men ingen kode (`routes/menu*.js`, `services/menu*.js` mangler)

**Status:** ❌ IKKE FUNDET

Menu-AI-agent er kun beskrevet i spec. Ikke bygget. Audit-relevans først når den bygges.

---

## Områder der mangler kode (❌ IKKE FUNDET)

Tre områder i specs henviser til funktionalitet der **ikke er bygget endnu**:

1. **#6 Faktura-generering** — `routes/invoices.js` har kun arbejdsliste, ingen generering. **Action:** Når den bygges, skal `unit_price` konverteres ex moms via `Moms.inclToExcl()` før send til e-conomic.
2. **#7 E-conomic-adapter** — eksisterer ikke. **Action:** Når den bygges, skal den have eksplicit moms-håndtering (kritisk).
3. **#28 Menu-AI-agent** — kun spec. **Action:** Når den bygges, skal den IKKE returnere priser direkte (kun line_items).

Disse skal med i `CLAUDE_MOMS_AUDIT_AUTO.md` Fase 1 v2 når koden findes.

---

## Konklusion

**Bug-fix-status efter Commit 1-4:** Hele kodebasens egen kerne er ren. **Én public-vendt fil** (`tools/tilbud-standalone-v2.html`) har den oprindelige bug — det er det eneste reelle migrations-arbejde tilbage.

Tre områder kræver ikke kode-fix men en **forretningsbeslutning fra Leif**: skal "omsætning" i cashflow/rapporter/dashboard rapporteres ex eller incl moms? Det er konsistens-spørgsmål, ikke bugs.

**Anbefaling:** Fase 2 kan reduceres til:
- 1 GO til #8 (kritisk)
- Op til 1 GO til #14 (kosmetisk)
- 3 forretningsbeslutninger til #15/#16/#19

---

## Leif's GO/NO-GO

Markér ved at ændre check-bokse:

| # | Område | Beslutning |
|---|--------|------------|
| 8 | Public tilbuds-link | [x] **GO** — commit `7d9545d` (1. maj 2026) |
| 14 | Planning vatDiv kosmetisk | [ ] GO migration / [ ] NO-GO / [ ] SKIP (lavt prioritet) |
| 15 | Cashflow omsætnings-basis | [ ] Ex moms / [ ] Incl moms / [ ] KRÆVER DISKUSSION |
| 16 | Rapporter omsætnings-basis | [ ] Ex moms / [ ] Incl moms / [ ] KRÆVER DISKUSSION |
| 19 | Dashboard omsætnings-basis | [ ] Ex moms / [ ] Incl moms / [ ] KRÆVER DISKUSSION |

---

*Slut på Fase 1-rapport. STOP — vent på Leif's GO/NO-GO før Fase 2.*
