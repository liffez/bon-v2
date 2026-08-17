# T_ECONOMIC — Test-spec for e-conomic faktura-integration (Spor 2)

> Verificerer e-conomic-**integrationen**: payload-builder + de tre endpoints i
> `routes/invoices.js`. Adskilt fra `T_ECON` (som tester per-bon moms/økonomi).

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | `buildDraftInvoice`/`checkReadiness` (ren logik) + `GET economic-preview`, `GET economic-readiness`, `POST economic-draft` |
| **Hvad testes IKKE** | Reelle e-conomic-kald (mockes), Grocy-productmap (stubbes), UI-klik (manuel/Playwright), reconciliation (Spor 4) |
| **Forudsætninger** | Migrationer 105+106. Ingen netværk — e-conomic + Grocy er stubbet |

---

## 2. Moms-doktrin (autoritativ — §6b/§6c)

- `bon_lines.unit_price`/`line_total`, `bons.delivery_price`, `bons.total_price` er **INCL** moms.
- e-conomic kræver linje-priser **EX** moms → `shared/moms.inclToExcl()` ved konvertering.
- Vi sender **aldrig** momsbeløb/-sats; e-conomic beregner selv ud fra varens momskode.
- T-5 testbon: 23.650 incl → 18.920 ex (linjesum) + 4.730 moms.

---

## 3. To test-lag

### 3.1 Unit — payload-builder (ingen netværk)
Dækkes af `scripts/test-economic-invoice.js` (100 tests): T-5 ex-moms-linjesum, kunde-resolver
(firma vinder over privat), rabat → `discountPercentage` pr. linje, syntetisk leveringslinje
(kun ved `delivery_price>0` uden x-Levering-linje), `date=todayISO()` ≠ `delivery.deliveryDate`,
afrunding maks. 2 decimaler, blokering ved manglende kobling, + rabat-trigger (T1–T7).

### 3.2 Integration — endpoints (`run_T_ECONOMIC.js`, in-process, hermetisk)
Temp-DB via `DB_PATH`, `eco.rest`/`eco.isConfigured` + `grocyAdapter.getEconomicProductMap`
stubbet, routeren monteret i mini-express med fake-auth. **24 tests:**

| # | Case | Forventet |
|---|------|-----------|
| preview | ready-bon | 200, `readiness.ok`, payload bygget, `customerNumber=944`, varenr på linjer |
| preview | bon m. ukoblet vare | 200, `payload=null`, `readiness.ok=false`, 1 `missingProducts` |
| readiness | kø-scan | 200, blokeret-liste indeholder missing-bon, ikke ready-bon, `drafts_waiting=0` |
| draft | happy path | 200, `draftInvoiceNumber`, gemt på bon (`economic_draft_number`+`_at`), changelog `economic_draft_created` |
| draft | re-send | 409 + eksisterende nummer (ingen dublet) |
| draft | manglende kobling | 422 + `readiness.missingProducts` |
| auth | POST/GET uden session | 401 |
| readiness | efter draft | `drafts_waiting=1` |

---

## 4. Stub-kontrakt

- `eco.isConfigured() → true`; `eco.rest('/invoices/drafts', POST) → { draftInvoiceNumber: ++seq }`.
- `grocyAdapter.getEconomicProductMap() → Map(recipe_id → varenr)` — recipe 100→'65', 101→'77';
  recipe 200 bevidst ukoblet (driver 422/missing-stien).

---

## 5. Kør

```
npm run test:economic     # begge lag

node --experimental-sqlite scripts/test-economic-invoice.js   # 100 unit
node --experimental-sqlite tests/scripts/run_T_ECONOMIC.js    #  52 integration
```

---

## 6. Filer

- `services/economicInvoice.js` — payload-builder + readiness + createDraftInvoice
- `services/economicAdapter.js` — auth + ecoFetch (Spor 1)
- `routes/invoices.js` — `enrichBonForEconomic` + de tre endpoints
- `scripts/test-economic-invoice.js` — unit
- `tests/scripts/run_T_ECONOMIC.js` — integration

---

## 7. Status

| Lag | Antal | Status |
|-----|-------|--------|
| Unit (payload + trigger + udeladelses-reglen) | 100 | ✅ PASS |
| Integration (endpoints) | 52 | ✅ PASS |

### Mutationsmatrix — "faktureres ikke" pr. vare (#444 + #454)

Fire regler bærer rettelsen. Hver mutation er kørt og fælder en navngiven assert —
en regel der ikke kan falde, er ikke testet.

| Mutation i `services/economicInvoice.js` | Fælder |
|---|---|
| `throw` → `continue` i builderen (den oprindelige #444) | `#12 kaster uden nummer (strict)` + `#N2` |
| listen konsulteres også for linjer **med** varenr | `#N4 varenr vinder over listen` |
| beløbsvagten fjernet (listet opskrift droppes uanset pris) | `#N2 listet opskrift MED beløb blokerer` + `#N1` |
| `oneoffForMissing` tilladt uden engangsnummer | `#S1 oneoff uden nummer kaster` |

`T_ECO_EXCL` bruger recipe 45, som er seedet i `economic_noninvoice_recipes` af
migration 149 — integrationstesten beviser dermed også at migrationen er kørt
(samme trick som beløbslinje-testen bruger for migration 144).

**Resterende (manuelt, ikke i runner):** UI-klik i fakturering (browser), ægte udkast mod
e-conomic-regnskabet på branch-test (oprettes → verificeres → slettes), Grocy-backfill af
`economic_product_number` (review-liste via `scripts/economic-product-match.js`).
