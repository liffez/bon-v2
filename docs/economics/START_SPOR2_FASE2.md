# START — e-conomic Spor 2, Fase 2+3 (handoff til ny session)

> Kopiér ikke bare — LÆS de 4 docs i `docs/economics/` først. Alle beslutninger er taget
> (se hver fils "AFKLARET"/"Beslutninger"). Spørg ikke om det allerede besluttede.

## Branch — VIGTIGT
Arbejd videre på **`claude/economic-docs`** (start med `git checkout claude/economic-docs`).
Lav IKKE en ny branch — så ender Spor 1 + Spor 2 i ÉN PR (en PR følger branchen).
e-conomic-tokens står i `.env` (`ECONOMIC_APP_SECRET` + `ECONOMIC_AGREEMENT_GRANT`) — sørg for
at den `.env` er i dit arbejds-dir, så lokal test virker.

## Hvad er FÆRDIGT (bygget + verificeret 25. juni 2026)
- **Spor 1 — auth:** `services/economicAdapter.js` + `scripts/economic-self-check.js`.
  Verificeret: `/self` → "Nordic Fast Food" (agreement 1073932).
- **Spor 2 Fase 1:**
  - Migration 105 (`delivery_vehicles.economic_product_number`, `bons.economic_draft_number/_at`,
    `customers.discount_percent`, 7 economic-settings) + 106 (rabat-trigger `bons_seed_standing_discount`).
  - `grocyAdapter.getEconomicProductMap()` (recipe_id → economic_product_number fra RÅ recipes).
  - `services/economicInvoice.js`: `buildDraftInvoice`, `resolveEconomicCustomer`, `buildReference`,
    `checkReadiness`, `createDraftInvoice`, `deleteDraftInvoice`, `getEconomicSettings`.
  - 34 lokale tests grønne: `node --experimental-sqlite scripts/test-economic-invoice.js`.
  - **Skrive-stien BEVIST mod live API** (smoke-test: oprettede+slettede ægte udkast, kunde 944).

## To API-fund (allerede indarbejdet — husk dem ved videre payload-arbejde)
1. `lines[].product.productNumber` SKAL være **String** (skema afviser Integer).
2. Idempotency-nøgle = `bon-${id}-${sha1(payload)[:12]}` — fast nøgle giver "PayloadChanged"
   ved gen-send med ændret indhold inden for 1t.
- Bonus: kladde-listens "Nr."-kolonne = `draftInvoiceNumber` (vores API-nr). Detalje-headerens
  "Fakturanr." er et ANDET (reserveret bogførings-)nummer. Web-UI-URL bruger et tredje internt id.

## TILBAGE at bygge

### Fase 2 — endpoints (routes/invoices.js + shared/api.js)
- Berig kø-bons' linjer med `economic_product_number` (join `getEconomicProductMap()` på
  `grocy_recipe_id`) + `delivery_vehicle_economic_product_number`/`_label` (join `delivery_vehicles`).
- `POST /api/invoices/:bonId/economic-draft` (`requireAuth()`): kør `checkReadiness`; ved fejl →
  422 med liste over manglende numre. Ved ok → `createDraftInvoice` → gem `economic_draft_number`
  + `economic_draft_at` på bonen → changelog + SSE `bon_updated`. Re-send-guard: er
  `economic_draft_number` sat → returnér "udkast findes allerede" (byg ikke nyt).
- `POST|GET /api/invoices/:bonId/economic-preview` (dry-run): byg payload + returnér den UDEN at
  POST'e til e-conomic. (Bruges til lokal verifikation + UI-preview.)
- `GET /api/invoices/economic-readiness`: liste over kø-bons der vil blive blokeret + hvorfor
  (pre-flight). + tæller "kladder venter" (bons med economic_draft_number sat, ikke faktureret).
- `shared/api.js`: `createEconomicDraft(bonId)`, `previewEconomicDraft(bonId)`.

### Fase 3 — UI (office/views/fakturering.js)
- "Send til e-conomic"-knap pr. bon → kald endpoint → vis bonen **overstreget** i køen + kladde-nr.
  Fejl (422) → vis blokeringsliste. Bevar "Markér faktureret" (sætter FAKTURERET ved godkendt bogføring).
- Valgfrit "Åbn kladde i e-conomic →"-link (kun hvis `economic_draft_url` sat — degraderer pænt,
  vis altid nummeret). "Kladder venter · N"-kort i summary-striben.
- Preview-knap der viser dry-run-payloaden (ex moms-linjer + incl-total, jf. visnings-disciplin §6c).

### Tests
- Flyt `scripts/test-economic-invoice.js`-mønstret til `tests/specs/T_ECONOMIC.md` + runner
  (jf. projektets test-konvention). Tilføj integration-tests (spawned server, mock e-conomic HTTP):
  endpoint happy-path, re-send-guard, 422 ved manglende kobling, auth 401.

## TESTSTRATEGI (uden mockup — draft er reversibel)
1. Byg dry-run/preview FØRST → verificér payload på rigtige bons UDEN e-conomic-kald.
2. `checkReadiness` mod rigtige bons → ser præcis hvad der mangler (Grocy-backfill ikke gjort endnu
   → forvent "mangler numre" indtil Leif opretter Grocy-userfeltet `economic_product_number` + backfiller).
3. Ægte udkast fra syntetisk `T_ECON_`-bon → se i e-conomic → SLET igen
   (`scripts/economic-delete-draft.js <nr>`). Smoke-script: `scripts/economic-smoke-draft.js`.
4. Branch-test på Hetzner FØRST når serveren er fri (Byekspressen-test kørte ~26. juni).

## AFHÆNGER AF (data, ikke kode — Leif/office)
- Grocy: opret userfield `economic_product_number` på entitet **recipes** + backfill numrene.
- Kunder/firmaer: `economic_customer_id` sat (nogle har, fx 944). Nye kunder/kontakter via
  dokument-flow (se ADAPTER fejlhåndtering B). EAN-kunder kræver kontaktperson (`economic_contact_id`).

## STOP-regler
Commit/push/PR/merge KUN når brugeren beder om det. Én PR til sidst, når hele integrationen er bygget+testet.
