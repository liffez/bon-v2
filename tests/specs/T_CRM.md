# T_CRM — CRM + outreach-kampagner

> Track-status: **kerne-scope under opbygning** (kerne-først, jf. beslutning).
> Patch-politik: reelle bugs rettes løbende i samme PR (A-I-mønster) og logges som F-numre.

---

## 1. Formål og afgrænsning

Verificér CRM- og outreach-kampagne-API'et: `routes/crm.js`, `routes/companies.js`,
`routes/campaigns.js`. Tracken er todelt værdi: den giver **test-dækning** og
**verificerer outreach-modulet** (Fase 0-5 er bygget, men aldrig systematisk testet).

**Kerne-scope (denne omgang) — højrisiko-logikken:**
- **Kampagne-medlemmer + B2C-samtykke-gating** (kronjuvel): ren B2C uden
  `marketing_consent=1` → blokeret; `do_not_contact=1` → altid blokeret;
  partial-unique-index dedup → `already_member` (skip, ikke fejl).
- **Kunde 360°** (`GET /crm/customer/:id`): stats + ordrer + aktiviteter + flags-merge.
- **Aktiviteter** (`POST /crm/activity`): type-enum, `crm_customer_meta.last_contact_at`
  side-effekt, `campaign_id`-betinget opdatering af `campaign_members.last_activity_at`.
- **Stage + consent** (`PATCH /crm/customer/:id/stage` + `/consent`): enum-validering, upsert.
- **Kampagne-CRUD** (opret/list/luk/genåbn) som understøttelse.

**Afgrænset væk (senere udvidelse):** companies CRUD/enrich + contact_points-triggers,
import-preview/commit, pipeline-board, stats/briefing/suggestions (read-only aggregater),
edge-case-suite, SSE-fuld-dækning. Noteret i §9.

**Testes IKKE:** Grocy-mutationer (CRM rører dem ikke), frontend-views (kun API).

**Relation til andre tracks:** deler `sse_listener.js` + cleanup-mønster med T_BONS_LIST.
Overlapper bevidst med outreach-modulets verifikation.

---

## 2. Forudsætninger

- Isoleret `data/test.db` (migreret, `default_grocy_location_id=3` → test-Grocy).
- `safety_check` grøn (NODE_ENV=test, DB_PATH/GROCY_API_URL → test).
- Test-server kører: `npm run test:server` (port 4322, `.env.test`).
- Login: PIN `1234` (kitchen-bruger, `requireAuth()` passerer på CRM-routes).
- Alle fixtures oprettes med `notes='T_CRM'` (firmaer/kunder) hhv. navn-prefix
  `T_CRM_` (kampagner) → hermetisk cleanup.

---

## 3. Strategi

Snapshot → opret fixtures → kald API → assert → cleanup → verificér snapshot == slut.
Fixtures direkte i DB (hurtigt, deterministisk); selve testede handlinger via HTTP-API
(rammer den rigtige route-logik + middleware). Bugs der findes rettes i route-koden
(patch) og dækkes af en regressions-case.

---

## 4. Test-cases (kerne)

### 4.1 SETUP
- Opret 2 firmaer (B2B) + 3 kunder: Alice (B2B m/ firma), Bob (B2C, `marketing_consent=1`),
  Carl (B2C, `marketing_consent=0`), Dora (B2C, `do_not_contact=1`).
- `crm_customer_meta`-rows med stage + consent-flags.
- Login + SSE-listener.

### 4.2 CUSTOMER_360 (`GET /crm/customer/:id`)
- Fulde felter, stats-objekt, orders-array, activities-array.
- Kunde uden `company_id` (B2C) håndteres.
- Ukendt id → 404.

### 4.3 ACTIVITIES (`POST /crm/activity` + `PATCH /:id/done`)
- Opret hver gyldig `type` (call/meeting/task/note).
- Ugyldig type → 400.
- `crm_customer_meta.last_contact_at` opdateres efter POST.
- `PATCH /activity/:id/done` sætter `done_at`.
- SSE `crm_activity_created` modtages.

### 4.4 STAGE + CONSENT
- `PATCH /customer/:id/stage` med gyldig enum (lead/active/dormant/vip).
- Ugyldig stage → 400.
- `PATCH /customer/:id/consent` sætter `marketing_consent` + `do_not_contact` (upsert).

### 4.5 CAMPAIGNS_CRUD
- `POST /campaigns` → opret. `GET /campaigns?active=1`. `GET /:id`. `PATCH /:id`.
- `POST /:id/close` (is_active=0 + closed_at). `POST /:id/reopen`.

### 4.6 CAMPAIGN_MEMBERS (kronjuvel — B2C-gating + dedup)
- B2B (company_id) → tilladt.
- B2C Bob (`consent=1`) → tilladt.
- B2C Carl (`consent=0`) → **skipped** `reason=no_marketing_consent_b2c`.
- B2C Dora (`do_not_contact=1`) → **skipped** `reason=do_not_contact`.
- Batch (alle fire i ét kald) → korrekt added/skipped-split.
- Dublet-insert → **skipped** `reason=already_member` (ikke 500/UNIQUE-fejl).
- `PATCH /members/:id` status-skift (lead→contacted→won) + `member_status`-enum.
- `DELETE /members/:id`.
- SSE `campaign_members_added` modtages.
- `campaign_id` på `POST /activity` → kun DEN kampagnes `last_activity_at` opdateres.

### 4.6b CLEANUP
- Slet i CASCADE-rækkefølge: crm_activities, campaign_members, crm_customer_meta,
  customers (`notes='T_CRM'`), companies (`notes='T_CRM'`), outreach_campaigns (`T_CRM_%`).
- Verificér snapshot == slut.

---

## 5. Konkret eksempel
`POST /campaigns/:id/members` med `[{company_id:A}, {customer_id:Bob}, {customer_id:Carl}, {customer_id:Dora}]`
→ forvent `added=[A,Bob]`, `skipped=[{Carl,no_marketing_consent_b2c},{Dora,do_not_contact}]`.

---

## 6. Fejlsignaler
- B2C uden samtykke tilføjes alligevel → jura-gating brudt (KRITISK).
- Dublet → 500/UNIQUE i stedet for skip → manglende constraint-håndtering.
- `last_contact_at`/`last_activity_at` ikke opdateret → side-effekt-bug.
- 403 på CRM-endpoints med kitchen-login → rolle-gating strammere end antaget.

---

## 7. Filer
- `tests/specs/T_CRM.md` (denne)
- `tests/scripts/run_T_CRM.js` (runner)
- Genbrug: `tests/scripts/helpers/sse_listener.js`, `safety_check.js`

---

## 8. Hvis testen passerer
CRM-aktivitets-flowet + outreach-kampagnernes jura-gating er verificeret. Outreach-modulet
(Fase 0-5) er bekræftet funktionelt på API-niveau.

## 9. Udvidelser — ALLE GENNEMFØRT ✅
- **Track 2** (import + pipeline) — §4.7 + §4.8 ✅
- **Track 3** (companies CRUD + contact_points + 053-trigger) — §4.9 + §4.10 ✅
- **Track 4** (read-only aggregater: stats/briefing/suggestions/service-calls/customers/
  callbacks/dormant/call-log/call-stats/meetings-upcoming) — §4.11 ✅
- **Track 5** (edge: SQL-injection i `q`, unicode/emoji, 8000-tegns note, ikke-numerisk id;
  + CONS_01 consent-API-eksponering) — §4.12 ✅

**Bevidst udeladt:**
- enrich-preview/enrich *success*-sti (rammer live CVR/NemHandel → flaky). Kun 404-guarden
  testes deterministisk. Kan mockes senere hvis ønsket.
- Consent-UI (spec §1.3): T_CRM tester kun API (§1) — CONS_01 bekræfter at `customer/:id`
  eksponerer `marketing_consent`/`do_not_contact` (nested under `body.customer`), så
  frontenden KAN vise dem. Om Kunde 360°-viewet faktisk viser/toggler dem er en frontend-opgave
  uden for denne track.

## 10. Status
**91 PASS · 0 FAIL** — FULD §9-dækning (kerne + Track 2–5, 23. juni 2026).
Nedbrydning: kerne 36 · pipeline+import 19 · companies+contact_points 20 · readonly 10 · edge 6.
1 reel produkt-bug fundet i hele suiten (F1); alt andet grønt. Hermetisk cleanup (CLEAN_01).

Track 3–5 tilføjer: **COMPANIES** (CRUD/søg/economic/identifiers-CVR-validering/extract-contacts/
enrich-404), **CONTACT_POINTS** (to-vejs cache-sync + promote + 409 + 053-trigger), **READONLY**
(10 aggregat-endpoints smoke), **EDGE** (injection/unicode/lang-tekst/NaN-id + consent-API).

Tidligere (kerne + Track 2):
Dækket: SETUP, CUSTOMER_360, ACTIVITIES (inkl. ACT_07 owner-regression), STAGE+CONSENT,
CAMPAIGNS_CRUD, CAMPAIGN_MEMBERS (B2C-gating + dedup + SSE), **PIPELINE** (4 kolonner,
move→status/offer_status, 400/404, SSE), **LEAD_IMPORT** (dry_run, opret, dedup, CVR-match,
privat lead, VIP-stage-guard, is_public=0-kontaktpunkt, batch-tag, række-isolation, SSE), CLEANUP.
1 reel bug fundet og patchet (F1). De to øvrige fejl undervejs var test-harness-fejl
(antaget `is_personal`-kolonne på customers; læste `ev.count` af SSE-wrapper i stedet for
`ev.data.count`) — rettet i runneren, ikke produktkode.

Kronjuvel-verifikation bestået: ren B2C uden `marketing_consent=1` → `no_marketing_consent_b2c`,
`do_not_contact=1` → `do_not_contact`, dublet → `already_member` (skip, ikke UNIQUE-fejl),
batch-split korrekt, `campaign_id`-betinget `last_activity_at`-opdatering virker.

## 11. Findings
**F1 — `owner_user_id`/`stage_locked_by` altid null** (patchet i denne PR).
`routes/crm.js` `POST /activity` (l. 1094) og `PATCH /customer/:id/stage` (l. 1179) læste
`req.session.user?.id`, men den korrekte session-nøgle er `req.session.userId` (sat af
`routes/auth.js`; consent-handleren l. 1209 brugte den allerede korrekt). Resultat: hvem der
loggede en aktivitet eller låste et stadie blev aldrig registreret — audit-feltet var altid
NULL. Begge sites rettet til `req.session?.userId`. Regression: ACT_07 asserter at
`owner_user_id` er sat efter `POST /activity`.
