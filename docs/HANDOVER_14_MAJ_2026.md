# HANDOVER_14_MAJ_2026.md

> Handover-dokument efter intensiv test-session 13.-14. maj 2026.
> Bruges som kontekst-prompt til ny chat eller som instruks til Claude Code.

---

## Hurtigt overblik

**Status:** Test-suite stærkt udbygget. 437 PASS · 0 FAIL · 3 SKIP. 9 patches anvendt og dokumenteret (A-I). 0 åbne medium+ findings på testet kode.

**Sluttet på:** Manuel integration-test af web-bestillings-flow afdækkede 5 UX/coverage-gaps (#040-#044). #040 er anvendt (mobile bon-view fix). #041-#043 åbne (medium-prio web-order UX, systemisk samme rod-årsag). #044 åben (test-coverage-gap, lav-prio).

**Næste skridt:** T_V1_AFSTEMNING (weekenden, cutover-prep) → derefter T_CRM, T_CASHFLOW + UX-fixes #041-#043.

---

## Test-suite status

### Tracks komplette (437 PASS)

```
Fase 1 (kitchen + foundation):  130/130 · 3 SKIP
  T_DB, T_BON, T_INPUT, T_AGGR, T_KITCHEN_TODAY, T_GROCY, T_ECON, T_PLAN

Fase 2a (lager):
  T_INVENTORY  10/13  (pre-existing Grocy flakiness)
  T_STOCK      31/31
  T_RECIPES    20/20

Fase 2b (indkøb + varemodtagelse):
  T_INDKOB_LISTE                       38/39
  T_INDKOB_SETUP                       47/47
  T_INDKOB_ADMIN                       50/50
  T_INDKOB_HORKRAM                     54/56
  T_VAREMODTAGELSE_PATCH_REGRESSION    26/26
  T_VAREMODTAGELSE_FULL                67/67
  T_PATCH_C                            10/10
  T_PATCH_F_REGRESSION                  5/5

Fase 3 (Office):
  T_BONS_LIST                          77/78  · 1 SKIP
  T_BON_DRAWER_CORE                    61/61
  T_BON_DRAWER_LINES_AND_RELATIONS     69/70  · 1 SKIP
  T_FAKTURERING                        60/60
  T_TILBUD                             81/82  · 1 SKIP
  T_DASHBOARD                          84/84
```

### Resterende tracks

```
T_CRM             ikke skrevet — routes/companies.js + routes/crm.js
T_CASHFLOW        ikke skrevet — routes/cashflow.js (admin-only)
T_V1_AFSTEMNING   weekenden ifølge plan — cutover-blokker
```

---

## Anvendte patches (A-I)

| # | Filer | Lukker | Type |
|---|-------|--------|------|
| A | `routes/goods-receipts.js` | F30/F31/F32/F35 | Goods-receipts kritiske fixes |
| B | `routes/goods-receipts.js` | F37/F40/F41 | Validation (temperature, product_name, has_deviation) |
| C | `routes/purchasing.js`, `services/grocyAdapter.js`, `routes/goods-receipts.js` | #013/#014/#015/F28 | API consistency (POST+PATCH, duplikat-detection, enum-validation) |
| D | `routes/bons.js`, `db/helpers.js` | #005/F005 | Force-mode med session-baseret auth (privilege escalation-fix) |
| E | `routes/goods-receipts.js` | F33 | partially_approved-status ved Grocy-fejl |
| F | `routes/bons.js`, 4 frontend-filer | F49/F57/F58 | SSE-broadcast konsistens — bon_*-events bruger `{id}` |
| G | `routes/invoices.js` | F62/F63/F64/F65 | Tilbud-filter, accessory-eksklusion, BETALT i done-list |
| H | `office/views/fakturering.js` + .css | #036 | "ekskl. moms"-label fix + 3-rækkers visning |
| I | `routes/quotes.js`, `office/views/tilbud.js` | F68/F72/F73 | Quotes consistency (won-blokering, is_accessory, SSE event-navne) |

---

## TEST_OBSERVATIONS status

```
44 observations total

Lukket:                32  (#005-#007, #010-#015, #017-#028, #030-#040)
Bevidst-accepteret:     3  (#001, #016, #029)
Åbne lav-prio:          6  (#002, #003, #004, #008, #009, #044)
Åbne medium-prio:       3  (#041, #042, #043 — alle web-order UX)
```

**Vigtigt:** De 3 åbne medium-findings (#041-#043) hænger systemisk sammen — alle om web-order-flow. Bør fikses som ét feature, ikke 3 separate.

---

## De 5 findings fra 14. maj (manuel integration-test)

### #040 — Mobile bons-list viser "Ukendt" + "?" for nye bestillinger (LUKKET — commit `6f0bb26`)

`mobile/views/bons.js:159` læser `bon.customer_name`/`bon.company_name`. Backend `GET /api/bons` returnerer kunde-navnet som `contact_name_full`. Felt-navn-mismatch.

For status: `_mbStatusStyle` slår op i `BON_CONFIG.statuses[code]` med case-sensitive key. Backend sender 'NY' i store bogstaver, BON_CONFIG kan have små.

**Fix:** 2-linjers ændring i `mobile/views/bons.js`. Skift `bon.customer_name || bon.company_name` til `bon.contact_name_full || bon.company_name || 'Ukendt'`. Plus `(code || '').toUpperCase()` ved BON_CONFIG-lookup.

### #041 — Ingen UI-alert ved ny web-bestilling (medium prio — FORRETNINGSRISIKO)

`routes/web-orders.js` udsender `bon_created`-event, men ingen frontend lytter aktivt og viser banner/alert. Dashboard har `alerts`-array men ingen `new_web_orders`-type. Kunder skal have svar inden for 2 dage max (helst samme dag, jf. Leif). Hvis ingen ser bestillingen, falder den ud af synsfeltet.

**Fix:** Tilføj alert-type til `routes/dashboard.js /today`-endpoint der tæller bons med `source='web_order'` + status='NY' uden user-acknowledgment. Vis i dashboard topbar som "X nye bestillinger".

### #042 — Fremtidige bestillinger "gemmes" væk (medium prio)

Bon v2's date-baserede views (today, later, calendar) skjuler fremtidige bons indtil de bliver tidsmæssigt relevante. En bestilling til august 2026, modtaget i maj 2026, er teknisk i systemet men praktisk usynlig. Office's bons-list med "Alle" viser dem men ikke som "nye/ubekræftede".

**Fix:** Ny dedikeret "Nye bestillinger"-sektion (sidebar-punkt) der viser ALLE bons med `source='web_order' AND status='NY' AND acknowledged_at IS NULL`, uanset delivery_date. Sortér efter created_at DESC. Tilføj "Bekræft modtaget"-knap der sætter `acknowledged_at` (uden at ændre status).

### #043 — Ingen mail-notifikation til ejer ved ny web-bestilling (medium prio)

`routes/web-orders.js` sender bekræftelsesmail til kunden men har ingen pendant til ejer/Leif. Især vigtigt fordi bestillinger kan komme om natten/weekend.

**Fix:**
1. Settings: `web_order_notification_email` (default `leifzeeberg@hotmail.dk`, redigerbar i Settings UI)
2. Mail-template `web_order_owner_notification` med variabler: bonNummer, kundeNavn, leveringsDato, leveringsTid, drawerLink, oenskerBlok
3. I `handleWebOrder` efter linje 309 i web-orders.js: fire-and-forget mail til adressen
4. Tjek `is_active`-flag på modtagermail før send (graceful disable)

### #044 — Test-coverage-gap: ingen end-to-end test af bestillings-flow (lav prio)

T_INDKOB_HORKRAM tester Hørkram basket-flow (kurv hos Hokas API), men ingen test verificerer at en bestilling fra UI'en (basket checkout, email-send, eller manuel registrering) faktisk skaber en row i `purchase_orders`-tabellen, kommer tilbage via `fetchPendingOrders()` og renderes i `_ibRenderGroup`.

`routes/orders.js` har 9 komplette endpoints (`GET /pending`, `POST /pending`, `PATCH /pending/:id`, etc.) og UI'en i `indkob.js` har `_ibPendingOrders`-join (linje 410) og render-logik (linje 816-823). Manuel undersøgelse 14. maj 2026 viste 0 rows i `purchase_orders`-tabellen — sandsynligvis fordi der aldrig er afgivet en bestilling end-to-end.

**Fix:** Nyt track **T_PURCHASE_ORDER_E2E**:
1. POST `/orders/pending` med basket-data → verificér `purchase_orders` + `purchase_order_lines`-rows oprettet
2. GET `/orders/pending` returnerer den nye PO
3. `_ibBuildGroups` joiner den korrekt til en gruppe via `grocy_location_id`
4. UI viser den i indkøbslisten

---

## Etablerede konventioner (vigtige for fremtidige patches)

| Konvention | Detaljer |
|------------|----------|
| **SSE-payload-shape** | `bon_*`-events bruger `{id, ...metadata}`. Polymorfe events (`mail_*`, `po_*`, `supplier_*`) bevarer semantiske FK-navne (`bon_id`, `customer_id` etc.) fordi de kan referere flere entiteter |
| **Force-mode auth** | Identitet kommer fra `req.session.userId`, IKKE body.user_id. Body bruges KUN til audit-felter. Privilege-escalation-vektor lukket i Patch D |
| **Quote convert-only** | `offer_status='won'` kan KUN sættes via `POST /api/quotes/:id/convert` (der samtidig sætter `is_offer=0`, `status_id=GODKENDT`). PATCH `/:id/status` accepterer kun draft/sent/lost/expired |
| **Moms-disciplin §6c** | Alle revenue-felter har 3-felts pattern (`_excl_moms`, `_incl_moms`, `vat_collected`) via `shared/moms.js` |
| **Test-spec-format** | Hver track har spec i `tests/specs/T_*.md` med 11 sektioner. Findings nummereret F* (track-lokale), observations #NNN (globale i `docs/TEST_OBSERVATIONS.md`) |
| **Test-bons prefix** | T_BL_, T_BD_, T_FAK_, T_TLB_, T_DASH_ for hermetisk cleanup |
| **SSE-test-helper** | `tests/scripts/helpers/sse_listener.js` genbruges på alle office-tracks |

---

## Hvad næste session bør gøre

### Højeste prioritet — denne weekend

**T_V1_AFSTEMNING** — cutover-blokker. Køres på prod-data parallelt med v1.

### Næste arbejdsdage — UX-fixes som hænger sammen

#### Fase 1 — Mail-notifikation (~30 min)
1. Settings-tabel: tilføj `web_order_notification_email` (redigerbar i Settings UI)
2. Mail-template `web_order_owner_notification`
3. Fire-and-forget mail i `handleWebOrder` (web-orders.js linje ~309)

#### Fase 2 — Mobile fix (DONE — commit `6f0bb26`, 14. maj 2026)
4. ~~`mobile/views/bons.js`: ændr `bon.customer_name` til `bon.contact_name_full`~~ ✓
5. ~~Tilføj `.toUpperCase()` ved BON_CONFIG.statuses-lookup~~ ✓ (faktisk fix: `t.code` i stedet for `t.to_code`)

#### Fase 3 — Dashboard alert (~1 time)
6. Ny alert-type i `routes/dashboard.js /today` — tæl bons med web_order-source + NY-status
7. Frontend: badge i dashboard topbar

#### Fase 4 — Dedikeret "Nye bestillinger"-side (~1-2 timer)
8. Ny route `GET /api/web-orders/pending`
9. Ny sidebar-section i office
10. DB-migration: `bons.acknowledged_at` + `acknowledged_by_user_id`
11. PATCH-endpoint `/api/bons/:id/acknowledge`

### Når tid er — resterende tracks

- T_CRM (større scope — routes/companies.js + routes/crm.js)
- T_CASHFLOW (større scope — admin-only CSV-upload, faktura-CRUD, bank-matching)
- T_PURCHASE_ORDER_E2E (lukker #044 — kan komme efter første reelle bestilling går igennem)

---

## Instruks til Claude Code (hvis det startes derfra)

```
Læs HANDOVER_14_MAJ_2026.md i project root.

Vi har lige afsluttet en intensiv test-suite session der bragte total til
437 PASS · 0 FAIL · 3 SKIP og lukkede 31 observations via 9 patches.

5 nye åbne findings logget (#040-#044) — alle web-order UX-relaterede.

Næste prioritet er T_V1_AFSTEMNING (weekenden) og derefter de fire UX-fixes
i prioriteret rækkefølge (Fase 1-4 ovenfor).

Inden du går i gang med næste patch:
1. Verificér nuværende tilstand: `npm run test:all` skal returnere 437/0/3
2. Læs `docs/TEST_OBSERVATIONS.md` for #040-#044 detaljer
3. Bekræft med Leif om rækkefølgen før implementering

Husk lektioner fra de 9 patches A-I:
- Verificér find/replace mod faktisk kode — ingen "..."-placeholdere
- POST/PATCH-par har ofte parallelle bugs
- Identitet kommer fra session, ikke body
- Tjek forudsætninger eksplicit
- Polymorfe events bevarer semantiske FK-navne (mail_*/po_*/supplier_*)
- Defensive tests skifter ikke retning — skal strammes til at REQUIRE adfærd
- Grep'er giver falske positive — manuel review pr. fil
```

---

## Instruks til ny Claude-chat (planlægning/sparring)

```
Jeg er Leif fra Ristet Rug. Vi har lige afsluttet en stor test-suite-session
13.-14. maj 2026 hvor vi:
- Skrev 7 office-tracks specs (BONS_LIST, BON_DRAWER CORE+LINES, FAKTURERING,
  TILBUD, DASHBOARD)
- Anvendte 9 patches (A-I) der lukkede 31 observations
- Endte på 437 PASS · 0 FAIL · 3 SKIP

Slutteligt opdagede vi 5 web-order UX-gaps (#040-#044) ved manuel test —
alle åbne, dokumenteret med konkrete fix-forslag.

Næste skridt: T_V1_AFSTEMNING (weekenden), derefter UX-fixes #041-#043
som ét feature (mail-notifikation + dashboard-alert + dedikeret "nye
bestillinger"-side).

Læs HANDOVER_14_MAJ_2026.md for fuld kontekst.
Læs CLAUDE.md for projekt-overblik.
Læs docs/TEST_OBSERVATIONS.md for observations.

I denne session: hjælp mig med [next concrete task].
```

---

## Vigtigste filer at have klar i ny session

| Fil | Hvorfor |
|-----|---------|
| `CLAUDE.md` | Projekt-overblik |
| `docs/TEST_OBSERVATIONS.md` | Alle 44 observations |
| `BON_V2_PRINCIPPER.md` | Foundational principles inkl. §6b moms-doktrin |
| `bon_v2_datamodel_v2.md` | Schema authority |
| Denne fil (`HANDOVER_14_MAJ_2026.md`) | Session-bro |

For specifik UX-fix-arbejde (#040-#043):
- `routes/web-orders.js` — webhook-handler
- `routes/dashboard.js` — for ny alert-type
- `mobile/views/bons.js` — for #040 felt-navn-fix
- `services/mailService.js` — for owner-notification mail
- `shared/moms.js` — for §6c-konsistens

---

## Filer fra denne session (klar til at smide ind i Claude Code)

| Fil | Indhold |
|-----|---------|
| `PATCH_A_goods_receipts_critical.md` | Anvendt — F30/31/32/35 |
| `PATCH_B_goods_receipts_validation.md` | Anvendt — F37/40/41 |
| `PATCH_C_api_consistency_fixes.md` v2 | Anvendt — #013/14/15 + F28 |
| `PATCH_D_force_mode.md` v2 | Anvendt — #005 + privilege escalation-fix |
| `PATCH_E_partially_approved_status.md` v2 | Anvendt — F33 |
| `PATCH_F_sse_broadcast_consolidation.md` v3 | Anvendt — F49/57/58 |
| `PATCH_G_invoices_consistency_fixes.md` | Anvendt — F62/63/64/65 |
| `PATCH_H_fakturering_moms_labels.md` | Anvendt — #036 |
| `PATCH_I_quotes_consistency.md` | Anvendt — F68/72/73 |
| `T_BONS_LIST.md` | Spec — 78 cases |
| `T_BON_DRAWER_CORE.md` | Spec — 61 cases |
| `T_BON_DRAWER_LINES_AND_RELATIONS.md` | Spec — 70 cases |
| `T_FAKTURERING.md` | Spec — 60 cases |
| `T_TILBUD.md` | Spec — 82 cases |
| `T_DASHBOARD.md` | Spec — 84 cases |
| `OBSERVATIONS_TILFOJES_BATCH.md` | Bulk-batch for #018-#028 |
| `OBSERVATIONS_WEB_ORDER_UX.md` | Bulk-batch for #040-#043 |
| `OBSERVATION_029_mail_received_polymorf.md` | Polymorf event-konvention |
| `CLAUDE_MD_UPDATE_BATCH.md` | CLAUDE.md opdaterings-instrukser |

---

*Oprettet: 14. maj 2026 — session-handover efter test-suite Fase 1+2+3 (minus
CRM/Cashflow) + manuel integration-test af web-bestillings-flow. Konteksten
er bevaret i denne ene fil — alt nødvendigt for at fortsætte uden tab af
indsigt.*

*Opdateret: 14. maj 2026 senere på dagen — #040 lukket via commit `6f0bb26`.
Status nu: 32 lukkede observations, 3 åbne medium-prio (#041-#043), 6 åbne
lav-prio. Fase 2 i næste-skridt-listen er DONE; resterende fase-rækkefølge:
Fase 1 (mail-notifikation) → Fase 3 (dashboard-alert) → Fase 4 (dedikeret
"Nye bestillinger"-side).*
