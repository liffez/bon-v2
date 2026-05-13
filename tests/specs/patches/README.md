# tests/specs/patches/

Alle PATCH- og SPEC-dokumenter samles her — adskilt fra track-specs (`T_*.md`) i parent-mappen.

## Konvention

| Navn-mønster | Indhold |
|---|---|
| `PATCH_<emne>.md` | Kode-ændring til en specifik bug eller adfærd. Find/replace-blokke, verificeringstrin, rollback. |
| `SPEC_<nnn>_<emne>.md` | Mindre opgave der ikke er en kode-patch (UI-spec, doc-update, oprydning). Nummereret. |
| `PATCHES_<emne>.md` | Master-oversigt der binder flere patches sammen. |

## Track-specs (`T_*.md`) hører IKKE her

Track-specs definerer hvad en runner verificerer (e.g. `T_BON.md`, `T_VAREMODTAGELSE_FULL.md`). De ligger i `tests/specs/` direkte. Hver runner i `tests/scripts/run_T_*.js` har et tilhørende track-spec.

## Status (maj 2026)

Alle patches herunder er **anvendt** — se hver enkelt fils header for status.

| # | Patch | Status |
|---|---|---|
| A | `PATCH_goods_receipts_critical_fixes.md` | Lukket (F26, F30, F31, F32, F35) |
| B | `PATCH_goods_receipts_validation_fixes.md` | Lukket (F37, F40, F41) |
| C | `PATCH_C_api_consistency_fixes.md` | Lukket (#013, #014, #015, F28) |
| D | `PATCH_D_force_mode.md` | Lukket (#005, F005) |
| E | `PATCH_E_partially_approved_status.md` | Lukket (F33) |
| — | `PATCH_consumeRecipes_smart_shopping_list.md` | Lukket (#012, maj 2026) |
| — | `PATCH_grocy_qu_broedrug_v1_cleanup.md` | Lukket (#010, manuel) |
| 006 | `SPEC_006_DOC_AND_011_CLEANUP.md` | Lukket (#006 + #011) |
| 007 | `SPEC_007_planning_tilbuds_toggle.md` | Lukket (#007) |

`PATCHES_PRE_OFFICE_OVERVIEW.md` er master-tjekliste for de 6 patches der lukkede medium+ prioritet items før Office-fasen.
