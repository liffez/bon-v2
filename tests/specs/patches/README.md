# tests/specs/patches/

SPEC-dokumenter for åbne/igangværende opgaver samles her — adskilt fra track-specs (`T_*.md`) i parent-mappen.

**PATCH_*-filer er arkiveret** til [`docs/archive/patches/`](../../../docs/archive/patches/) (maj 2026). Alle PATCH-filer dokumenterede anvendte ændringer og hørte ikke længere til det aktive spec-område.

## Konvention

| Navn-mønster | Indhold |
|---|---|
| `SPEC_<nnn>_<emne>.md` | Mindre opgave der ikke er en kode-patch (UI-spec, doc-update, oprydning). Nummereret. |
| `PATCHES_<emne>.md` | Master-oversigt der binder flere patches sammen (historik). |

## Track-specs (`T_*.md`) hører IKKE her

Track-specs definerer hvad en runner verificerer (e.g. `T_BON.md`, `T_VAREMODTAGELSE_FULL.md`). De ligger i `tests/specs/` direkte. Hver runner i `tests/scripts/run_T_*.js` har et tilhørende track-spec.

## Aktuelle SPECs

| # | Spec | Status |
|---|---|---|
| 006 | `SPEC_006_DOC_AND_011_CLEANUP.md` | Lukket (#006 + #011) |
| 007 | `SPEC_007_planning_tilbuds_toggle.md` | Lukket (#007) |

## Arkiverede PATCH-filer

Se [`docs/archive/patches/README.md`](../../../docs/archive/patches/README.md) for den fulde oversigt over anvendte patches A-G.
