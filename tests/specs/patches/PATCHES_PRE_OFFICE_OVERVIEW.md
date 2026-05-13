# PATCHES_PRE_OFFICE_OVERVIEW.md

> Samlet oversigt over alle patches og specs der lukker åbne items før
> Office-fasen. Bruges som tjekliste af dig / Simon ved anvendelse.

---

## De 6 dokumenter

| # | Fil | Type | Lukker | Størrelse |
|---|-----|------|--------|-----------|
| 1 | `PATCH_C_api_consistency_fixes.md` | Server-patch | #013, #014, #015, F28 | Lille |
| 2 | `PATCH_D_force_mode.md` | Server-patch + migration | #005, F005 | Mellem |
| 3 | `PATCH_E_partially_approved_status.md` | Server-patch + (evt.) migration | F33 | Mellem |
| 4 | `SPEC_007_planning_tilbuds_toggle.md` | UI-spec | #007 | Lille |
| 5 | `SPEC_006_DOC_AND_011_CLEANUP.md` | Dokumentation + sletning | #006, #011 | Lille |
| 6 | (denne fil) | Master-oversigt | — | — |

---

## Anvendelses-rækkefølge

Patches kan anvendes uafhængigt — men hvis Claude Code arbejder dem
sekventielt giver denne rækkefølge mindst sammenhæng:

### Trin 1 — Patch C (API consistency) først
- Mindst risikabel
- Allerede 4 dækkede tests forventer disse 400/409 fra spec'erne
- Kør test-suite efter for at få regression-baseline før D/E

### Trin 2 — Patch D (force-mode)
- Mellem størrelse, kræver `users.role='admin'`-tjek
- Eventuel ny migration (changelog.payload — tjek schema først)
- Omskriv T_BON_API_FORCE_01 fra SKIP til 7 nye cases

### Trin 3 — Patch E (partially_approved)
- Tjek først om `goods_receipts.status` har CHECK-constraint (afgør om migration nødvendig)
- Justér T_VAREMOD_FAIL_04 + 7 nye patch E-tests

### Trin 4 — UI-toggle (SPEC_007)
- Kan landes parallelt med patches — ingen test-afhængighed
- Lille UI-task til Simon

### Trin 5 — Housekeeping (SPEC_006_011)
- Markdown-redigering + 4 fil-sletninger
- Land til sidst for at undgå sletnings-konflikter under patch-arbejde

---

## Test-tabel pr. patch

Hver patch har sin egen test-strategi. Samlet oversigt:

| Patch | Regression-tjek | Nye tests | Forventet samlet status |
|-------|-----------------|-----------|-------------------------|
| C | Alle eksisterende tracks | T_PATCH_C_REGRESSION (6 cases) | 6/6 PASS, øvrige uændrede |
| D | T_BON udvidet | T_BON_API_FORCE_01-07 (7 cases) | T_BON: 18→25 PASS |
| E | T_VAREMODTAGELSE_FULL T_VAREMOD_FAIL_04 justeret | T_PATCH_E_REGRESSION (7 cases) | _FULL: 59 uændret, 7 nye PASS |
| 007 | Manuel UI-test | Ingen runner | Ingen suite-ændring |
| 006/011 | Alle tracks bør være uændrede | Ingen | Ingen suite-ændring |

---

## Forventet sluttilstand efter alle 6

```
T_DB                                    18/18 PASS (uændret)
T_BON                                   25/25 PASS  (+7 force-cases)
T_INPUT                                 15/15 PASS  (uændret)
T_AGGR                                  24/24 PASS  (uændret)
T_KITCHEN_TODAY                         13/13 PASS  (uændret)
T_GROCY                                 14/14 PASS  (uændret)
T_ECON                                  14/14 PASS  (uændret)
T_PLAN                                  28/28 PASS  (uændret)
T_INVENTORY                             13/13 PASS  (uændret)
T_STOCK                                 31/31 PASS  (uændret)
T_RECIPES                               20/20 PASS  (uændret)
T_INDKOB_LISTE                          38/39 PASS  (uændret)
T_INDKOB_SETUP                          47/47 PASS  (3 cases justeret til at forvente 400/409)
T_INDKOB_ADMIN                          50/50 PASS  (uændret)
T_INDKOB_HORKRAM                        54/56 PASS  (uændret)
T_VAREMODTAGELSE_PATCH_REGRESSION       26/26 PASS  (uændret)
T_VAREMODTAGELSE_FULL                   59/59 PASS  (T_VAREMOD_FAIL_04 justeret)
T_PATCH_C_REGRESSION                     6/6  PASS  (ny)
T_PATCH_E_REGRESSION                     7/7  PASS  (ny)
─────────────────────────────────────────────────────
TOTAL                                  502/505 PASS · 6 SKIP

Hvilket er +44 cases fra 458 (forrige tilstand), og 0 nye åbne findings.
```

---

## TEST_OBSERVATIONS endelig tilstand efter alle 6

```
Lukkede:           #001 (bevidst-acc), #010, #012, #017,
                   #018-#024 (patch A+B), #025-#028 (patch C),
                   #005 (patch D), F33 (patch E), #007 (UI), #011 (oprydning)
                   = 17 items

Bekræftet "by design":  #006

Åbne (lav prioritet, parkeret):
  - #002 — DELETE recipes-pos 500 (UI rammer ikke)
  - #003 — Grocy cascade recipes_pos (relevant ved recipe-delete UI)
  - #004 — Grocy cascade recipes_nestings (samme)
  - #008 — Frikadellen-Slider test-data
  - #009 — Sub-recipes individuel test
  - F27 — Missing-status + qty>0 edge-case
  - F29 — Over-receive → full delete (dokumenteret som korrekt)
  - F34 — ACID-verifikation (bekræftet via CONC-test)
  - F36 — Server-side idempotens (UI-løsning tilstrækkelig)
  - #016 — Flere is_preferred (bevidst-accepteret — Leif maj 2026)

Total: 17 lukkede / 1 by design / 10 parkeret
```

---

## Klar til Office-fase

Når alle 6 er anvendt og verificeret:

- ✅ Ingen åbne bugs af medium+ prioritet
- ✅ Alle "behov for beslutning"-items besluttet og dokumenteret
- ✅ Test-suite 99%+ grøn med 502/505 PASS
- ✅ TEST_OBSERVATIONS rengjort — kun parkerede lav-prioritet tilbage
- ✅ Bon v1 kan trygt slukkes (T_V1_AFSTEMNING kører som parallel-track)

**Office-fasen kan startes uden teknisk gæld i kitchen-flowet.**

---

## Spørgsmål til Leif under anvendelse

| Spørgsmål | Hvornår |
|-----------|---------|
| Har `changelog`-tabellen en `payload`-kolonne? | Før Patch D — afgør om migration 059 skal med |
| Har `goods_receipts.status` en CHECK-constraint? | Før Patch E — afgør om migration 060 skal med |
| Skal `T_PATCH_C/E_REGRESSION` være separate runners, eller cases inde i eksisterende tracks? | Konvention-spørgsmål — uden betydning for korrekthed |

---

*Oprettet: maj 2026 — master-oversigt over de 6 dokumenter der lukker
alle medium+ prioritet items før Office-fasen.*
