# TEST_OBSERVATIONS.md — Observationer fra T_*-tracks

> Samling af små finds, uklarheder og adfærd der ikke er bugs men værd at huske —
> potentielle UI-forbedringer, adapter-justeringer, eller bare "godt-at-vide"-noter.
>
> Hver entry refererer til testen der opdagede det. Ingen action er forpligtende —
> det er en backlog af kandidater til separate PRs.

---

## Format

Hver observation har:
- **ID** — unikt, fortløbende (#001, #002 ...)
- **Kilde** — hvilken test-case observerede det
- **Beskrivelse** — hvad sker der
- **Vurdering** — er det et problem, og hvor stort
- **Foreslået action** — hvad kunne man gøre (hvis noget)
- **Status** — `åben` / `lukket` / `bevidst-accepteret`

---

## Observations

### #001 — Grocy returnerer `null` for både tom og null PUT på userfield

| | |
|--|--|
| **Kilde** | `T_STOCK_UF_04` (11. maj 2026) |
| **Beskrivelse** | `PUT /api/grocy/products/:id/userfields { HverDag: '' }` og `PUT { HverDag: null }` returnerer begge HTTP 200. Efterfølgende GET viser `HverDag: null` i begge tilfælde. Grocy lagrer internt som NULL og normaliserer tom-streng til null på output. |
| **Vurdering** | Ikke et problem — `_icParseIntervalDays` håndterer korrekt både `null`/`undefined`/`''` som "ikke sat". Værd at huske ved rollback-logik. |
| **Foreslået action** | Ingen. Dokumentér i T_STOCK-specen (gjort). |
| **Status** | `bevidst-accepteret` |

### #002 — `DELETE /api/grocy/recipes-pos/<ghost-id>` returnerer 500 ikke 404

| | |
|--|--|
| **Kilde** | `T_RECIPES_POS_04` (11. maj 2026) |
| **Beskrivelse** | DELETE mod en ikke-eksisterende `recipes_pos`-id (fx `999999999`) returnerer status 500 i stedet for forventet 404. Vores adapter `grocyDelete()` propagerer Grocy's interne 500-svar uden mapping. |
| **Vurdering** | Lav prioritet. Brugere rammer aldrig dette i UI'en (UI viser kun eksisterende positioner). Men hvis vi nogensinde bygger batch-delete eller cleanup-værktøjer, vil fejlmeddelelsen være misvisende. |
| **Foreslået action** | Hvis nogen alligevel rører `services/grocyAdapter.js:grocyDelete`, kunne man map'e 500'er der indeholder "not found"-tekst til 404 før vi propagerer. |
| **Status** | `åben` (lavt prioritet) |

### #003 — Grocy cascade'r IKKE `recipes_pos` ved recipe-delete

| | |
|--|--|
| **Kilde** | `T_RECIPES_CASCADE_01` (11. maj 2026) |
| **Beskrivelse** | Når man sletter en opskrift via direkte `DELETE /objects/recipes/:id` mod Grocy, bliver dens `recipes_pos`-rækker (ingredienser) IKKE slettet automatisk. De hænger som orphans med `recipe_id` pegende på den slettede opskrift. |
| **Vurdering** | **Medium prioritet.** Reelle konsekvenser: (a) `GET /api/grocy/recipes-pos/all` returnerer orphans, (b) `ingredientResolver` kunne potentielt fejle hvis den får serveret en orphan-position, (c) data-volumen vokser monotont. |
| **Foreslået action** | To muligheder: <br>**(i)** UI-advarsel før recipe-delete der lister positioner der vil blive forældreløse + tilbyder "slet alt"-toggle. <br>**(ii)** Backend: tilføj `deleteRecipe()` til adapteren der manuelt cascade'r (slet pos+nestings før selve recipe-delete). Det er den rigtige vej hvis vi nogensinde laver UI-recipe-delete. |
| **Status** | `åben` (medium prioritet — relevant før recipe-delete UI bygges) |

### #004 — Grocy cascade'r IKKE `recipes_nestings` ved recipe-delete

| | |
|--|--|
| **Kilde** | `T_RECIPES_CASCADE_02` (11. maj 2026) |
| **Beskrivelse** | Når man sletter en opskrift der enten ER parent ELLER child i en nesting-relation, bliver `recipes_nestings`-rækken IKKE slettet automatisk. Den hænger som orphan med `recipe_id` (eller `includes_recipe_id`) pegende på den slettede opskrift. |
| **Vurdering** | **Medium prioritet.** Samme bekymring som #003 — orphans i `recipes_nestings` kan forvirre `getRecipeNestings()` og dermed ingrediens-opløsningen i kitchen-views. Hvis en opskrift "forsvinder" fra menuen, mens en parent stadig peger på den via nesting, vil mengdeberegninger fejle. |
| **Foreslået action** | Samme som #003 — manuel cascade i en evt. ny `deleteRecipe()`-adapter-funktion, eller UI-advarsel der lister berørte parent-/child-relationer. |
| **Status** | `åben` (medium prioritet — relevant før recipe-delete UI bygges) |

### #005 — Force-mode dokumenteret i CLAUDE.md men IKKE implementeret (lukket)

| | |
|--|--|
| **Kilde** | `T_BON_API_FORCE_01` (Fase 1, maj 2026) |
| **Beskrivelse** | CLAUDE.md siger: "Med `force: true` kan admin sætte hvilken som helst status". Men `routes/bons.js:316-338` validerer altid mod `status_transitions`-tabellen uden at tjekke `force`-parameteren. T_BON_API_FORCE_01 var derfor SKIP i T_BON. |
| **Vurdering** | Implementeret via `docs/archive/patches/PATCH_D_force_mode.md` v2 (maj 2026). Force-mode bruger session-baseret rolle-tjek (IKKE body.user_id) for at undgå privilege escalation. Audit via `logChange()` med `wasForced`-flag i `changelog.payload`. |
| **Foreslået action** | N/A — implementeret |
| **Status** | `lukket` (maj 2026) |
| **Lukket-detaljer** | T_BON_API_FORCE_01-07 dækker happy path, privilege escalation regression (D-3), audit-log korrekthed |

### #006 — AFLYST kan ikke nås fra terminal-statusser (lukket — by design)

| | |
|--|--|
| **Kilde** | `T_BON` status-transitions-test (Fase 1, maj 2026) |
| **Beskrivelse** | `status_transitions`-tabellen tillader AFLYST fra TILBUD/NY/VENTER/GODKENDT/IGANG/KLAR/LEVERET, men IKKE fra FAKTURERET/BETALT/AFSLUTTET. Det betyder en faktureret bon ikke kan annulleres via UI. |
| **Vurdering** | Bekræftet "by design" af Leif (maj 2026). Kreditnotaer hører til regnskabsdomænet, ikke status-flowet. En faktureret ordre annulleres ved at oprette en kreditnota i e-conomic, ikke ved at sætte bonens status til AFLYST. Dokumenteret i `docs/BON_V2_PRINCIPPER.md` §4. |
| **Foreslået action** | Implementeret via `tests/specs/patches/SPEC_006_DOC_AND_011_CLEANUP.md` — afsnit tilføjet til BON_V2_PRINCIPPER.md |
| **Status** | `lukket — by design` (maj 2026) |

### #007 — Tilbuds-toggle i planlægning er kun localStorage — ingen synlig UI (lukket)

| | |
|--|--|
| **Kilde** | `T_PLAN_AGG_05` SKIP (Fase 1, maj 2026) |
| **Beskrivelse** | `shared/planning.js` havde en `_plShowOffers`-toggle der bestemte om tilbud (`is_offer=1`) vises i planlægningsbonnen. Toggle læstes fra `localStorage.planning_show_offers` men der var ingen synlig UI-knap eller checkbox til at skifte den. |
| **Vurdering** | Implementeret via `tests/specs/patches/SPEC_007_planning_tilbuds_toggle.md` — synlig toggle-knap tilføjet i `shared/planning.js` ved siden af status-filtrene. Knap har on/off-state med aria-pressed, persisterer via samme localStorage som før, og rerendrer ved klik. Browser-verificeret. |
| **Foreslået action** | N/A — implementeret |
| **Status** | `lukket` (maj 2026) |

### #008 — Frikadellen-Slider mangler på grocytest

| | |
|--|--|
| **Kilde** | `T_PLAN` ING-tests + T_INVENTORY parent-substitution-fix (Fase 1, maj 2026) |
| **Beskrivelse** | `Frikadellen-Slider` bruges på bons 4002 + 4007 i seed, men findes ikke som opskrift på grocytest. T_PLAN's `lines_without_recipe`-rapport fanger den. T_INVENTORY parent-substitution-fix gjorde at `consumeRecipes` på 4007 alligevel virker (sub-recipes 9/12/80 trækkes via substitution), men selve recipe-resolving er afhængig af, at den ikke er der. |
| **Vurdering** | Testdata-issue. Hvis Frikadellen-Slider tilføjes til grocytest senere, skal `TEST_PRODUCTS` i `snapshot_grocy.js` opdateres med faktisk `grocyName`. |
| **Foreslået action** | Opret Frikadellen-Slider på grocytest (én gang), eller acceptér at det blot ekskluderes fra ING-tests permanent. |
| **Status** | `åben` (lav prioritet) |

### #009 — Sub-recipes 9/12/80 ikke individuelt testet via T_INVENTORY

| | |
|--|--|
| **Kilde** | T_INVENTORY parent-substitution-fix (Fase 1, maj 2026) — noteret i `docs/CLAUDE_TESTPLAN.md` §11 |
| **Beskrivelse** | T_INVENTORY's parent-substitution-fix dækker tilfældet hvor consume mod en parent-product (fx kål) substituerer fra child-products (Hvidkål/Spidskål). Det virker for Frikadellen-Slider via underopskrifter 9/12/80, men de specifikke sub-recipes er aldrig individuelt testet. Hvis Grocy ændrer substitution-adfærd, vil testen falde igennem fordi alt aggregeres på family-niveau. |
| **Vurdering** | Test-dækkelse-gap. Lav prioritet — parent-substitution er stabil i Grocy. |
| **Foreslået action** | Hvis vi ser fejl i Frikadellen-Slider-flowet senere: tilføj specifik unit-test mod recipe 53's sub-recipes (9/12/80) i T_RECIPES eller en ny T_RESOLVER-track. |
| **Status** | `åben` (lav prioritet) |

### #010 — Brød Rug (pid=1) havde forkert QU-konvertering "1 Kasse = 10.8 Kilo"

| | |
|--|--|
| **Kilde** | T_INDKOB_ADMIN-design F12 (maj 2026) |
| **Beskrivelse** | Grocy QU-konverteringerne for pid=1 (Brød Rug) sagde `Kasse → Kilo = 10.8` og `Kilo → Kasse = 0.0926`. Korrekt er 7.68 / 0.1302 (= 64 × 0.12 kg pr. kasse). Værdien 10.8 stammede fra Bon v1-æraen og blev aldrig ryddet op ved migrering. Hørkrams karton (varenr 60097769) er "Rugbrødsstykke, 64 × 120 g" → 7.68 kg. Påvirkede ikke pris-beregning direkte, men kunne forvirre QU-aware-flows (snapshot-import, indkøbsliste-konvertering). |
| **Vurdering** | Bug i master-data — manuel oprydning, ikke kode-fix. Patch-fil dokumenterede både Manuel-UI- og API-flow. |
| **Foreslået action** | N/A — anvendt manuelt af Leif på grocytest 11. maj 2026 (jf. `docs/archive/patches/PATCH_grocy_qu_broedrug_v1_cleanup.md`). Skal også køres på grocycafe inden cutover. |
| **Status** | `lukket` (anvendt manuelt 11. maj 2026 — patch-fil bevares som skabelon til andre v1-rester) |

### #011 — `shared/bestilling.js` (60 kB) er død kode (lukket)

| | |
|--|--|
| **Kilde** | T_INDKOB_ADMIN-design F11 (maj 2026) |
| **Beskrivelse** | `initBestilling()` kaldtes ingen steder uden for filen selv. Erstattet af `shared/indkob.js` i Fase 6b (merged indkøbsliste + bestilling), men aldrig slettet. |
| **Vurdering** | Implementeret via `tests/specs/patches/SPEC_006_DOC_AND_011_CLEANUP.md`. Grep mod alle `*.html`/`*.js` viste ingen imports — kun 2 forældede kommentarer i `routes/horkram.js` (ryddet samtidig). |
| **Foreslået action** | N/A — slettet |
| **Status** | `lukket` (maj 2026 — 4 filer / ~125 KB død kode fjernet) |

### #013 — Suppliers POST/PATCH validation på integration_type (lukket)

| | |
|--|--|
| **Kilde** | `T_INDKOB_SETUP_SUP_04` + manuel observation (Fase 2, maj 2026) |
| **Beskrivelse** | POST `/api/purchasing/suppliers { integration_type: 'ftp' }` returnerede 201 med `integration_type: 'manual'` (silent fallback). PATCH havde parallel bug via `continue`-statement der silently ignorerede ugyldige værdier. |
| **Vurdering** | Implementeret via `docs/archive/patches/PATCH_C_api_consistency_fixes.md` v2. v1 ramte kun POST — v2 fixer også PATCH. Begge endpoints returnerer nu 400 med tilladte-liste i stedet for silent fallback/skip. |
| **Foreslået action** | N/A — implementeret |
| **Status** | `lukket` (maj 2026) |
| **Note** | `validTypes` inkluderer stadig `'form'` (legacy fra Migration 030). Separat oprydnings-patch hvis vi vil fjerne det |

### #014 — `supplier_grocy_locations` POST duplikat-detection (lukket)

| | |
|--|--|
| **Kilde** | `T_INDKOB_SETUP_SGL_03` (Fase 2, maj 2026) |
| **Beskrivelse** | POST `/api/purchasing/suppliers/grocy-locations` på samme (supplier_id, grocy_location_id) returnerede 200 både første og anden gang via `INSERT OR REPLACE`. Brugeren fik ingen indikation af om koblingen var ny eller erstattet. |
| **Vurdering** | Implementeret via `docs/archive/patches/PATCH_C_api_consistency_fixes.md` v2. INSERT OR REPLACE erstattet med eksplicit duplikat-tjek. Returnerer 409 med `existing`-objekt (hele rækken) i stedet for silent overwrite. |
| **Foreslået action** | N/A — implementeret |
| **Status** | `lukket` (maj 2026) |

### #015 — Grocy returnerer 500 ved duplikat product_barcode (lukket)

| | |
|--|--|
| **Kilde** | `T_INDKOB_SETUP_BC_03` (Fase 2, maj 2026) |
| **Beskrivelse** | POST `/api/grocy/product-barcodes` med samme `(product_id, barcode)` returnerede HTTP 500 fra Grocy uden mapping. |
| **Vurdering** | Implementeret via `docs/archive/patches/PATCH_C_api_consistency_fixes.md` v2. `createProductBarcode` mapper nu Grocy 500/400/409 med "constraint"/"unique"/"duplicate" i besked til 409 med `code='BARCODE_DUPLICATE'`. Route propagerer `err.status` korrekt. |
| **Foreslået action** | N/A — implementeret |
| **Status** | `lukket` (maj 2026) |

### #016 — Backend tillader flere samtidige `is_preferred='1'` på samme produkts barcodes (bevidst-accepteret)

| | |
|--|--|
| **Kilde** | `T_INDKOB_ADMIN_PREF_02` (Fase 2, maj 2026) |
| **Beskrivelse** | `is_preferred`-userfield på `product_barcodes` er ren tekst — Grocy validerer ikke at kun én barcode pr. produkt har `is_preferred='1'`. To samtidige "Foretrukken"-flag persisterer uden fejl. |
| **Vurdering** | Bekræftet af Leif (maj 2026): flere foretrukne på samme pid er gyldig adfærd. UI viser alle øverst i sorteringen — det er tilsigtet, fordi nogle produkter har flere leverandører hvor begge er "preferred" af forskellige grunde (fx forskellig pakkestørrelse eller leverancehyppighed). |
| **Foreslået action** | N/A — bevidst design |
| **Status** | `bevidst-accepteret` (maj 2026) |

### #017 — Hørkram basket-PUT lagde varer i InvalidLineItems pga forkert body-format (lukket)

| | |
|--|--|
| **Kilde** | `T_INDKOB_HORKRAM_BASKET_02` + `BASKET_04` (12. maj 2026) — fixet samme dag |
| **Beskrivelse** | PUT `/api/horkram/basket/add` returnerede HTTP 200, men varer landede i Hokas `InvalidLineItems` med `HasSalesUnitQuantity: false` i stedet for i `LineItems`. To samtidige problemer: (1) `routes/horkram.js` sendte `SalesUnitIndex + SalesUnitQuantity` på line-niveau — Hoka ignorerer `SalesUnitQuantity` og kræver nested objekt. (2) `GET /api/horkram/basket` brugte default `?id=0` der opretter ny tom basket i stedet for at hente sessionCache.basketId — så UI ville aldrig se de varer der lige blev PUT'et. |
| **Vurdering** | **Bug — fixet 12. maj 2026.** Ville have brudt "Læg i kurv"-flowet ved cutover. To kommitter: (a) GET basket defaultes til `sessionCache.basketId` så den læser samme kurv som senest PUT, (b) PUT-body sender nu nested `SalesUnit: { Code, Quantity }` i stedet for `SalesUnitIndex + SalesUnitQuantity`. Verificeret: Spinat × 1 + Brød Rug × 1 lander nu korrekt i `lines` med `invalidCount=0`. |
| **Foreslået action** | N/A — fixet. Næste skridt: når flere produkter testes manuelt, log evt. andre format-issues. |
| **Status** | `lukket` (12. maj 2026 — routes/horkram.js opdateret + T_INDKOB_HORKRAM BASKET-cases viser nu faktisk verifikation, ikke bare 200-status) |

### #018 — Duplikat product_id i samme receipt corrupte grocy_added-status (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE-design F35 (maj 2026) |
| **Beskrivelse** | `routes/goods-receipts.js` brugte `UPDATE ... WHERE receipt_id = ? AND grocy_product_id = ?` i Grocy-tracking-loopet. To items i samme receipt med samme grocy_product_id blev opdateret begge ved første UPDATE — silent data corruption på per-item `grocy_added`/`grocy_error`. |
| **Vurdering** | Bug. Fixet maj 2026 via `docs/archive/patches/PATCH_goods_receipts_critical_fixes.md` — UPDATE matcher nu på item.id efter `lastInsertRowid` blev gemt. T_VAREMODTAGELSE_PATCH_REGRESSION dækker regression-test. |
| **Status** | `lukket` (maj 2026) |

### #019 — photo_path forblev sat hvis temp-fil manglede (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE-design F30 (maj 2026) |
| **Beskrivelse** | Hvis klient sendte `photo_path` der pegede på en `vr-tmp-*`-fil der ikke længere eksisterede, hoppede koden over rename-blokken og DB.photo_path forblev sat — dangling reference. UI ville senere fejle med "billede ikke fundet". |
| **Vurdering** | UX-bug. Fixet maj 2026 via Patch A — photo_path null'es i DB hvis rename ikke kan gennemføres. |
| **Status** | `lukket` (maj 2026) |

### #020 — webhook_sent-felt i response misvisende navngivet (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE-design F31 (maj 2026) |
| **Beskrivelse** | Response-feltet `webhook_sent: true` var misvisende — webhook er fire-and-forget og kan stadig fejle async. Feltet sagde ikke hvad det lod til. |
| **Vurdering** | API-clean-up. Fixet maj 2026 — `webhook_dispatched: true` tilføjet ved siden af. `webhook_sent` bevares for klient-kompatibilitet og markeret som deprecated. |
| **Status** | `lukket` (maj 2026) |

### #021 — received_by-navn faldt til 'Ukendt' ved user_id-only (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE-design F32 (maj 2026) |
| **Beskrivelse** | Hvis klient kun sendte `received_by_user_id` (uden `received_by_name`), blev `userName` til `'Ukendt'` i webhook-payloaden, selvom navnet kunne være slået op fra users-tabellen. |
| **Vurdering** | UX-gap. Fixet maj 2026 — users-tabel-lookup ved user_id-only før fallback til 'Ukendt'. Også gemt i `goods_receipts.received_by_name`-kolonnen så detail-views har det. |
| **Status** | `lukket` (maj 2026) |

### #022 — temperature_value=undefined crasher receipt-oprettelse (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F40 (maj 2026) |
| **Beskrivelse** | Hvis klient sendte `temperature_cool_enabled=true` men ingen `temperature_cool_value`, blev `undefined` videregivet til `db.prepare().run()`. node:sqlite kastede fejl, counter rullede tilbage via transaction. 5xx til klient uden meningsfuld besked. |
| **Vurdering** | Bug. Fixet maj 2026 via `docs/archive/patches/PATCH_goods_receipts_validation_fixes.md` — eksplicit `?? null`-fallback (ikke `\|\|` som ville klampe 0°C til null). Samme fix anvendt på frozen_value. |
| **Status** | `lukket` (maj 2026) |

### #023 — items[].product_name=null gav 500 i stedet for 400 (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F37 (maj 2026) |
| **Beskrivelse** | NOT NULL constraint på `goods_receipt_items.product_name` boblede op som 500 SQLite-fejl. Ingen meningsfuld besked til UI. |
| **Vurdering** | UX-bug. Fixet maj 2026 via Patch B — validation tilføjet før INSERT med pæn 400-besked og index-info ("items[2].product_name er påkrævet"). Counter er ikke øget ved fejl. |
| **Status** | `lukket` (maj 2026) |

### #024 — has_deviation=false klampede ikke deviation_type/note (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F41 (maj 2026) |
| **Beskrivelse** | Hvis klient sendte `has_deviation=false` men også `deviation_type` og `deviation_note`, persisterede de i DB. Inkonsistent state — rækken sagde "ingen afvigelse" men havde alligevel data. |
| **Vurdering** | Konsistens-bug. Fixet maj 2026 via Patch B — type/note klampes til null når has_deviation=false. Samme mønster som temperature-felterne (`enabled ? value : null`). |
| **Status** | `lukket` (maj 2026) |

### #025 — Suppliers PATCH manglede validation (lukket — del af #013-fix)

| | |
|--|--|
| **Kilde** | `T_PATCH_C_REGRESSION_07` (maj 2026) |
| **Beskrivelse** | Patch C v1 fixede kun POST /suppliers. PATCH /suppliers/:id havde samme silent-skip bug: ugyldig integration_type gennem `continue` blev silently ignoreret. Klient fik 200 selvom intet skete. |
| **Vurdering** | Parallel bug fundet under v1→v2 review. Fixet sammen med #013 i Patch C v2. |
| **Status** | `lukket` (maj 2026) |

### #026 — status='approved' selv ved partial Grocy-failure (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F33 (maj 2026) |
| **Beskrivelse** | `goods_receipts.status` blev hardcoded til `'approved'` ved INSERT, selv hvis Grocy fejlede for én eller flere items. UI kunne ikke skelne mellem fuldt succesfulde og delvist fejlede modtagelser. |
| **Vurdering** | Design-issue. Fixet maj 2026 via `docs/archive/patches/PATCH_E_partially_approved_status.md` — ny status-værdi `'partially_approved'` tilføjet (migration 060). Server tæller `grocyFailures` (exkluderer bevidste skips som missing-status og no-pid) og opdaterer status hvis count > 0. Response re-fetcher status fra DB. Webhook læser automatisk korrekt værdi. |
| **Foreslået action** | UI-rendering af partial-status er separat fremtidigt arbejde i Fase 3 (varemodtagelses-listview) |
| **Status** | `lukket` (maj 2026) |

### #027 — SSE payload-inkonsistens på bon-events (lukket)

| | |
|--|--|
| **Kilde** | T_BONS_LIST F49 (maj 2026) |
| **Beskrivelse** | Forskellige `bon_*`-events sendte forskellige payload-shapes for samme entitet. `bon_status` + `notification` + POST lines brugte `bon_id`; alle andre brugte `id`. Frontend måtte læse `e.id \|\| e.bon_id` for at håndtere begge. |
| **Vurdering** | Lukket maj 2026 via `docs/archive/patches/PATCH_F_sse_broadcast_consolidation.md` v3 — alle `bon_*`/`notification`-events bruger nu konsistent `{id, ...metadata}`. Frontend-fallback fjernet fra 4 filer (kitchen/today.js, kitchen/later.js, shared/bon_drawer.js, shared/flyver.js linje 128). Mail-events (`mail_received`, `mail_sent`) bevares som polymorfe — `bon_id` er ét af 4 mulige FK'er i payloaden og har semantisk værdi. |
| **Foreslået action** | N/A — implementeret |
| **Status** | `lukket` (maj 2026) |

### #028 — Ukendt item.status falder igennem (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F28 (maj 2026) |
| **Beskrivelse** | `routes/goods-receipts.js` accepterede enhver streng som `item.status`. Ukendte værdier (fx `'xyz'`) faldt igennem alle conditionals i `shouldAddStock`-tjekket. Resultat: item gemtes med ugyldig status, ingen fejl, ingen Grocy-update. Silent edge-case. |
| **Vurdering** | Validation-gap. Fixet maj 2026 via Patch C v2 — enum-validation før INSERT mod `['ok', 'wrong', 'damaged', 'missing']`. |
| **Status** | `lukket` (maj 2026) |

### #029 — Polymorfe mail-events bruger semantisk `bon_id` (bevidst-accepteret, konvention)

| | |
|--|--|
| **Kilde** | Claude Code review af `PATCH_F_sse_broadcast_consolidation.md` v1+v2 (maj 2026) |
| **Beskrivelse** | `services/mailService.js` udsender 5+ broadcasts der ALLE har polymorf payload: `mail_sent`, `mail_received`, `po_mail_sent`, `po_mail_received`, `supplier_mail_sent`, `supplier_mail_received`. Hver payload indeholder mellem 4-5 forskellige FK'er: `{bon_id, customer_id, purchase_order_id, supplier_id, thread_id, unread_count}`. Det er fordi en mail KAN handle om en bon, en kunde, en purchase-order eller en supplier (eller en kombination). |
| **Vurdering** | **Korrekt design** — semantiske felt-navne er nødvendige fordi events er polymorfe. At omdøbe `bon_id` til generisk `id` ville miste betydning og bryde mail-toast + mail-badge i `shared/utils.js:119,150`. |
| **Konvention** | `bon_*`-events bruger `{id}` (kun bon-kontekst). `mail_*`-events + andre polymorfe events bevarer semantiske FK-navne (`bon_id`, `customer_id`, etc.). Fremtidige patches der "rydder op" i SSE-konsistens skal **kun** ramme bon-kun events |
| **Berørte filer** | `services/mailService.js` (linje 318, 320, 323, 567, 613, 616, 619). Frontend `shared/utils.js` (linje 119, 150) bruger `data.bon_id` korrekt — IKKE en bug |
| **Foreslået action** | N/A — dokumentation af konvention. Patch F v3 respekterer dette ved kun at røre bon-events. |
| **Status** | `bevidst-accepteret` (maj 2026) |

### #030 — PUT lines manglede SSE broadcast (lukket)

| | |
|--|--|
| **Kilde** | T_BON_DRAWER_LINES_AND_RELATIONS F57 (maj 2026) |
| **Beskrivelse** | `PUT /api/bons/:id/lines/:lid` opdaterede linjen + recalc'ede `total_price`, men sendte ikke `bon_updated`-event. Frontend's listview opdaterede ikke realtime efter line-PUT. |
| **Vurdering** | UX-gap. Fixet maj 2026 via `docs/archive/patches/PATCH_F_sse_broadcast_consolidation.md` v3 — broadcast tilføjet før response. T_PATCH_F_01 dækker regression. |
| **Status** | `lukket` (maj 2026) |

### #031 — DELETE lines manglede SSE broadcast (lukket)

| | |
|--|--|
| **Kilde** | T_BON_DRAWER_LINES_AND_RELATIONS F58 (maj 2026) |
| **Beskrivelse** | `DELETE /api/bons/:id/lines/:lid` slettede linjen + recalc'ede `total_price`, men sendte ikke `bon_updated`-event. Samme symptom som F57. |
| **Vurdering** | UX-gap. Fixet maj 2026 — samme patch som #030. T_PATCH_F_02 dækker regression. |
| **Status** | `lukket` (maj 2026) |

### #032 — Tilbud (is_offer=1) kom i fakturerings-arbejdsliste (lukket)

| | |
|--|--|
| **Kilde** | T_FAKTURERING F62 (13. maj 2026) |
| **Beskrivelse** | `GET /api/invoices/queue` filtrerede ikke `is_offer=1`. Tilbud med status LEVERET + payment_type='invoice' (sjælden men mulig kombination) dukkede op i pending-listen, klar til "fakturering". Andre views (`routes/bons.js` linje 75, dashboard, reports) filtrerer is_offer korrekt — invoices.js var inkonsistent. |
| **Vurdering** | Lukket maj 2026 via `docs/archive/patches/PATCH_G_invoices_queue_fixes.md` — tilføjet `(b.is_offer = 0 OR b.is_offer IS NULL)` til pending-, done- og doneMonth-querierne. T_FAK_PEND_05 dækker regression. |
| **Status** | `lukket` (maj 2026) |

### #033 — line_total i invoices-queue inkluderede accessory-lines (lukket)

| | |
|--|--|
| **Kilde** | T_FAKTURERING F63 (13. maj 2026) |
| **Beskrivelse** | `routes/invoices.js` summerede ALLE bon_lines (inkl. `is_accessory=1`) til `bon.line_total` og dermed til `pending_amount` + done-month-stats. Konventionen i resten af kodebasen er at ekskludere accessories fra aggregat-totaler: `routes/reports.js` (linje 561, 576), `routes/dashboard.js` (481), `routes/bons.js` (510, 544, 563), `routes/quotes.js` (392) bruger alle `AND is_accessory = 0`-filter. Invoices.js var den eneste afviger. |
| **Vurdering** | Lukket maj 2026 via Patch G — SUM filtrerer nu `is_accessory=0` (eller IS NULL) i alle 3 querier. `bon.lines[]`-arrayet beholdes komplet så frontend kan vise tilbehør separat. T_FAK_LINES_04 + T_FAK_SUM_03 dækker regression. |
| **Status** | `lukket` (maj 2026) |

### #034 — BETALT-bons forsvandt fra done-list i fakturerings-historik (lukket)

| | |
|--|--|
| **Kilde** | T_FAKTURERING F64 (13. maj 2026) |
| **Beskrivelse** | Done-querien i `routes/invoices.js:127` brugte `IN ('FAKTURERET','AFSLUTTET')` — BETALT-status faldt udenfor. Når en bon gik fra FAKTURERET → BETALT (typisk via cashflow-match), forsvandt den fra fakturerings-historikken. Forvirrende UX. |
| **Vurdering** | Lukket maj 2026 via Patch G — BETALT tilføjet til IN-listen. Matcher nu doneMonth-querien (linje 147) der altid har inkluderet BETALT — den indbyrdes inkonsistens (#035) elimineres samtidig. T_FAK_DONE_03 + T_FAK_SUM_07 dækker regression. |
| **Status** | `lukket` (maj 2026) |

### #035 — done_count_month og done-list var inkonsistente om BETALT (lukket)

| | |
|--|--|
| **Kilde** | T_FAKTURERING F65 (13. maj 2026) |
| **Beskrivelse** | `routes/invoices.js` havde to forskellige IN-lister: done-listen brugte `('FAKTURERET','AFSLUTTET')`, men summary's `done_count_month` brugte `('FAKTURERET','AFSLUTTET','BETALT')`. En BETALT-bon talte i månedstal men dukkede ikke op i selve listen. |
| **Vurdering** | Lukket maj 2026 via Patch G — done-listen aligned med doneMonth (#034). Konsekvensen var direkte forvirring for office: "der står 12 fakturerede i denne måned men jeg kan kun se 11". |
| **Status** | `lukket` (maj 2026) |

### #036 — Fakturerings-view labeller incl-moms-tal som "Sum ekskl. moms" (lukket)

| | |
|--|--|
| **Kilde** | Opdaget under Patch G-arbejde (13. maj 2026) |
| **Beskrivelse** | `office/views/fakturering.js:69` (summary-card) + `:388` (detail sum-row) labellede INCL-moms-værdier ("Ufaktureret beløb" + "Sum ekskl. moms") som ekskl. moms. Begge tal kommer fra backend som INCL moms per §6b — brugeren så et tal der var 25% højere end labelet sagde. |
| **Vurdering** | Frontend label-bug, ikke pengetab — backend regner korrekt. Lukket 13. maj 2026 via `docs/archive/patches/PATCH_H_fakturering_moms_labels.md`: linje 69-label rettet til "inkl. moms", detail sum-row udvidet til 3-rækkers visning (Subtotal ex / Moms 25% / Total incl) via `window.Moms.computeMomsFields(bon.line_total)`. Matcher §6c visningsregler og e-conomic-konvention. CSS opdateret: subtotal+moms-rækker er lette (14px dim), total-række har gold accent. T_FAKTURERING 60/0/0 efter patch. |
| **Foreslået action** | N/A — fixet |
| **Status** | `lukket` (13. maj 2026) |

### #037 — Tilbud-modul: PATCH /:id/status tillader 'won' uden /convert (åben)

| | |
|--|--|
| **Kilde** | T_TILBUD F68 (13. maj 2026) |
| **Beskrivelse** | `routes/quotes.js:431` accepterer 'won' i valid-listen for `PATCH /api/quotes/:id/status`. Det betyder en kunde kan sætte `offer_status='won'` uden at `/convert` kaldes — resultat: tilbud markeres som "vundet" men `is_offer` forbliver 1. Tilbud dukker IKKE op i `/api/bons` (forbliver i tilbudslisten), MEN `/convert` afviser den senere med "allerede konverteret" fordi `offer_status='won'` er pegene. Bonen er fanget i mellem-tilstand. |
| **Vurdering** | Inkonsistens-risk. Lav reel skade — knappen findes ikke i UI'en (`tilbud.js`'s status-toggle har ikke 'won' som mulighed, kun draft/sent/lost/expired). Men API-endpointet er ubeskyttet og kan ramme et legitimit edge-case hvis nogen automatiserer mod det. |
| **Foreslået action** | Fjern 'won' fra valid-listen i `PATCH /:id/status` — den status er reserveret til `/convert`-flowet. 1-linjes fix: `const valid = ['draft', 'sent', 'lost', 'expired'];`. |
| **Status** | `åben` (lav prioritet — UI eksponerer ikke endpointet, men API er ubeskyttet) |

### #038 — Tilbud-modul: routes/quotes.js dropper is_accessory på bon_lines (åben)

| | |
|--|--|
| **Kilde** | T_TILBUD F72 (13. maj 2026) |
| **Beskrivelse** | `routes/quotes.js`'s INSERT INTO bon_lines i både POST (linje 270-286) og PATCH (linje 373-388) lister ikke `is_accessory` i kolonne-listen. Hvis frontend sender `is_accessory: 1` på en linje, ignoreres flaget og linjen gemmes med default `is_accessory=0`. `routes/bons.js:498` håndterer feltet korrekt — quotes.js er ude af sync. Konsekvens: `total_units`-querien (quotes.js:392) filtrerer på `is_accessory=0` men da kolonnen aldrig sættes, falder alle lines igennem filteret — accessory-lines tæller med i total_units på tilbud. |
| **Vurdering** | Reel inkonsistens med tilbud-som-bon-arkitekturen. Når et tilbud konverteres til bon, beholdes linjerne (CONV_07 PASS) — men accessory-flaget er allerede tabt. Den konverterede bon vil have accessories tællende i total_units, hvor en frisk POST /api/bons/:id/lines ville bevare flaget. |
| **Foreslået action** | Tilføj `is_accessory` til INSERT-kolonne-listen i routes/quotes.js POST (linje 270-272) + PATCH (linje 373-376). Tilføj `l.is_accessory ?? 0` til parametrene begge steder. 4-linjes fix. |
| **Status** | `åben` (medium prioritet — konvertering pris-flow påvirkes) |

### #039 — Tilbud-modul: SSE event-name-mismatch (åben, frontend modtager aldrig realtime)

| | |
|--|--|
| **Kilde** | T_TILBUD F73 (13. maj 2026) |
| **Beskrivelse** | `routes/quotes.js` broadcaster `bon_created` (linje 298) og `bon_updated` (linjer 398, 450, 480) — men `office/index.html:934-939` registrerer kun listeners for `quote_created`/`quote_updated`, og `office/views/tilbud.js:184` lytter på samme navne. Frontend modtager ALDRIG realtime-opdateringer fra tilbudsendpointet. Brugeren skal manuelt re-fetche listen for at se nye/ændrede tilbud. |
| **Vurdering** | Reel UX-bug. Office-tilbudsvisningen virker som om SSE er aktiveret, men effekten er polling med manuel reload. Andre office-views (bons-list, CRM, fakturering) får korrekt realtime fordi de bruger samme event-navne backend sender. Risiko: når Patch F konsoliderede `bon_*`-events, blev tilbud-frontenden ikke fulgt med. |
| **Foreslået action** | To muligheder: <br>**(i) Rename i quotes.js**: skift broadcasts fra `bon_*` til `quote_*` (4 steder: POST, PATCH x2, convert). Konsekvens: kalender + listview lytter ikke på quote_*, så de mister synkronisering når et tilbud oprettes/ændres. Skal de? Tvivlsomt — tilbud vises ikke i bons-listview alligevel. <br>**(ii) Rename i frontend**: skift `quote_created`/`quote_updated` i office/index.html + tilbud.js til `bon_created`/`bon_updated`. Konsekvens: tilbud.js får ALLE bon-events (også for almindelige bons) og skal filtrere på `data.is_offer === true` selv. Foretrukken løsning — matcher patch F's design. |
| **Status** | `åben` (medium prioritet — funktionelt brækkede realtime-opdateringer) |

### #012 — `consumeRecipes` bruger rå `/objects/shopping_list` i stedet for smart endpoint (lukket)

| | |
|--|--|
| **Kilde** | T_INDKOB_LISTE-design Bug #001 (maj 2026) |
| **Beskrivelse** | `services/grocyAdapter.js:631` i `consumeRecipes`'s shortfall-handler kaldte `grocyPost('/objects/shopping_list', {...})` direkte. Det opretter ny entry pr. partial-add — selv hvis samme produkt allerede mangler på listen fra tidligere LEVERET. UI'en viste duplikater. Grocys smart endpoint `/stock/shoppinglist/add-product` dedupper automatisk og understøtter `note`-felt direkte. |
| **Vurdering** | Bug — fixet 11. maj 2026 via `docs/archive/patches/PATCH_consumeRecipes_smart_shopping_list.md` (3 ændringer: udvid `addShoppingListProduct` med note-param, brug smart endpoint i `consumeRecipes`, opdater `T_INV_PARTIAL_02`-assertion fra "ny entry-id" til "amount-stigning ≥ shortfall_purchase"). T_INVENTORY-suiten kører fortsat 13/13 PASS. Faktisk bevis: rapporten viser at smart endpoint `dedupped` på eksisterende entry (id=3750 for pid=72) — den gamle assertion ville have fejlet her, hvilket bekræftede at Ændring 3 var nødvendig. |
| **Foreslået action** | N/A — fixet |
| **Status** | `lukket` (11. maj 2026 — patch anvendt + T_INVENTORY verificeret) |

---

## Indeks per track

| Track | Observations |
|-------|--------------|
| T_BON | #005, #006 |
| T_PLAN | #007, #008 |
| T_STOCK | #001 |
| T_RECIPES | #002, #003, #004 |
| T_INVENTORY | #009, #012 |
| T_INDKOB_LISTE | #012 |
| T_INDKOB_SETUP | #013, #014, #015 |
| T_INDKOB_ADMIN | #010, #011, #016 |
| T_INDKOB_HORKRAM | #017 |
| T_VAREMODTAGELSE_PATCH_REGRESSION | #018, #019, #020, #021 |
| T_VAREMODTAGELSE_FULL | #022, #023, #024, #026, #028 |
| T_PATCH_C_REGRESSION | #013, #014, #015, #025, #028 |
| T_BON (Patch D) | #005 |
| T_BONS_LIST | #027 |

---

## Slutstatus (13. maj 2026)

**40 observations total** efter Patch A+B+C+D+E + Patch F + Patch G + Patch H + SPEC_006/007/011 + T_BONS_LIST + T_BON_DRAWER + T_FAKTURERING + T_TILBUD:

| Status | Count | IDs |
|---|---:|---|
| `lukket` | 28 | #005, #006, #007, #010, #011, #012, #013, #014, #015, #017, #018, #019, #020, #021, #022, #023, #024, #025, #026, #027, #028, #030, #031, #032, #033, #034, #035, #036 |
| `bevidst-accepteret` | 3 | #001, #016, #029 |
| `åben` (lav prio) | 6 | #002, #003, #004, #008, #009, #037 |
| `åben` (medium prio) | 2 | #038, #039 |

**2 åbne medium-prio findings i tilbud-modulet** (#038 + #039) som bør
patches inden større tilbuds-flow-arbejde. #037 er lav-prio (API-edge-
case uden UI-eksponering).

---

*Sidst opdateret: 13. maj 2026 — Patch H (fakturering moms-labels) lukker #036. Fakturering-detail-sum viser nu 3 rækker (Subtotal ex / Moms 25% / Total incl) via `Moms.computeMomsFields()` — matcher §6c og e-conomic-konvention. Forberedelse til faktura-PDF-generering.*
