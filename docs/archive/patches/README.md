# docs/archive/patches/

Anvendte PATCH-filer arkiveret fra `tests/specs/patches/` (maj 2026). Disse dokumenter er historisk dokumentation af kode-ændringer der allerede er implementeret, testet, merget og pushet til main. De er flyttet hertil for at holde det aktive spec-område (`tests/specs/patches/`) ryddeligt.

## Hvorfor beholde dem?

1. **Audit-spor** — `docs/TEST_OBSERVATIONS.md` (#005, #012-#015, #018-#028, #032-#035) refererer direkte til disse filer for at forklare *hvorfor* en observation er lukket.
2. **Begrundelse** — Konventionsanalyser og design-rationaler dokumenteret i patch-filerne kommer ikke ud af git-loggen.
3. **Regression-tjeklister** — Hver patch har en "Acceptance-tests"-sektion med konkrete kommandoer en næste-dev kan køre for at gen-verificere.

## Oversigt over arkiverede patches (kronologisk)

| # | Patch | Lukker findings | Anvendt |
|---|---|---|---|
| — | `PATCH_grocy_qu_broedrug_v1_cleanup.md` | #010 | 11. maj 2026 (manuelt på grocytest) |
| — | `PATCH_consumeRecipes_smart_shopping_list.md` | #012 | 11. maj 2026 |
| A | `PATCH_goods_receipts_critical_fixes.md` | F26, F30, F31, F32, F35 | maj 2026 |
| B | `PATCH_goods_receipts_validation_fixes.md` | F37, F40, F41 | maj 2026 |
| C | `PATCH_C_api_consistency_fixes.md` | #013, #014, #015, F28 | maj 2026 |
| D | `PATCH_D_force_mode.md` | #005, F005 | maj 2026 |
| E | `PATCH_E_partially_approved_status.md` | F33 | maj 2026 |
| F | `PATCH_F_sse_broadcast_consolidation.md` | #027, #030, #031 (F49, F57, F58) | maj 2026 |
| G | `PATCH_G_invoices_queue_fixes.md` | #032, #033, #034, #035 (F62-F65) | 13. maj 2026 |
| H | `PATCH_H_fakturering_moms_labels.md` | #036 (moms-label-bug i fakturering UI) | 13. maj 2026 |

## Tilhørende test-runners (verificerer regression)

| Patch | Runner |
|---|---|
| A + B | `npm run test:run-varemod-patch` + `test:run-varemod-full` |
| C + E | `npm run test:run-patch-c` |
| D | `npm run test:run-bon` (T_BON_API_FORCE_*-cases) |
| F | `npm run test:run-patch-f` |
| G | `npm run test:run-fakturering` |
| H | `npm run test:run-fakturering` (frontend-only — backend uændret) |
| Grocy QU | `npm run test:run-stock` + `test:inv` |
| consumeRecipes | `npm run test:inv` |

## Hvad ligger stadig i `tests/specs/patches/`?

- Aktuelle SPEC-filer (mindre opgaver, ikke kode-patches): `SPEC_006_DOC_AND_011_CLEANUP.md`, `SPEC_007_planning_tilbuds_toggle.md`
- Master-oversigt: `PATCHES_PRE_OFFICE_OVERVIEW.md` — historisk tjekliste der oprindeligt bandt PATCH A-E sammen, beholdt som læsbar narrativ
- README.md med peger hertil

---

*Arkiveret: 13. maj 2026 efter T_FAKTURERING + Patch G blev landet på main.*
