# T_OPTAELLING — Lageroptælling (rullende session-model)

> Track for redesignet i #331. Spec for selve modulet: `docs/CLAUDE_OPTAELLING.md`.
> PR 1 (data-integritet) dækkes af cases 1–7 + 11. PR 2 (UX) tilføjede 8–10 og 13–15.
> Alle cases er nu aktive — ingen SKIP.

## 1. Formål
Fange de **stille-datafejl** optællingen skal fjerne (ikke indføre): afbrudt session der
forgifter Grocy, best-before overskrevet med evighedsdato, forkert sortering, og frostvarer
i den forkerte enheds-liste. Plus concurrency-klassifikation (§6) og enheds-konvertering.

## 2. Forudsætninger
- `shared/inventory_check.js` har CommonJS-export-guard der eksponerer de rene funktioner
  (`_icGroupOf`, `_icVisibleInUnit`, `_icClassifyCounted`, `_icCategorize`, `_icFindFactor`,
  `_icAltConv`, `_icGetUnitsForLocation`, `_icParseIntervalDays`, `_icComputeCheckStatus`)
  samt `_ic` state-referencen.
- **Ingen server, ingen Grocy, ingen DB** — PR 1's logik er ren beslutnings-kode, så
  runneren er selvstændig og deterministisk. Kør: `npm run test:run-optaelling`.

## 3. Strategi
Opsæt syntetisk `_ic`-state (lokation, fysiske enheder, produkter med userfields, counts,
grocyStock, conversions), kald de rene funktioner, assertér output. Datoer bygges relativt
til "nu" (fx 40 dage siden) så grupperingen er deterministisk uden faste kalenderdatoer.
To regressions-guards scanner kildefilen (Bug 1: intet `_icUpdateLastChecked`-kald i
`_icSaveCount`; Bug 2: intet `postGrocyInventory(..., '2999-12-31')` i writes).

## 4. Cases

| # | Case | Verificerer | PR |
|---|------|-------------|----|
| 1 | Klassifikation: ikke-talt vs. talt | `_icClassifyCounted` → `null` for ikke-talt (→ ingen skrivning); objekt for talt. Regressions-guard: `_icSaveCount` skriver ikke LastChecked (Bug 1). | 1 |
| 2 | Kun talte varer stemples | Guard: `_icUpdateLastChecked` kaldes kun fra commit + `_icCorrectInventory`, ikke fra `_icSaveCount`. | 1 |
| 3 | Ingen BB-overskrivning i writes | Kilde-scan: intet `postGrocyInventory(..., '2999-12-31')`. Kun læse-sammenligningen i `_icCategorize` må nævne 2999. (Bug 2) | 1 |
| 4 | Purchase→stock-konvertering | `_icFindFactor` løser produkt-specifik faktor begge veje + global fallback. | 1 |
| 5 | Konvertering mangler → null | `_icFindFactor` returnerer `null` når ingen konvertering findes (→ tæl i stock-enhed). | 1 |
| 6 | Rullende visibility (blød fallback, E) | `_icVisibleInUnit` 5-vejs sandhedstabel inkl. cross-location-fallback (vare forsvinder ikke tavst). | 1 |
| 7 | 4-gruppe sortering | `_icGroupOf` sandhedstabel + `_icCategorize` producerer rækkefølge Forfaldne < Aldrig < Snart < Ikke-forfaldne, BB kun tie-breaker, passiv nederst. | 1 |
| 8 | Enheds-chips bevarer tælling | `counts[id].units` intakt pr. enhed ved skift frem/tilbage; `total` = sum; `grocyAtCount`-baseline overlever recount. | 2 |
| 9 | ⋯ "Skal ikke tælles fast" | Beslutning ligger i sessionen; commit skriver `HverDag=""`. `_icDecide` rører IKKE Grocy. | 2 |
| 10 | ⋯ "Varen findes ikke mere" | Commit → inventory 0 + `active=0` via `putGrocyProduct`. Destruktiv → kræver bekræftelse. | 2 |
| 11 | Concurrency: drevet beholdning | `_icClassifyCounted` → `conflict=true` ved baseline≠grocyNow; `conflict=false` når afklaret. (§6-UI browser-verificeret) | 1 |
| 12 | Decimaler: komma til mennesker, punktum til Grocy | `_icFmt`/`_icParseNum`; guard mod visnings-tal der glemmes i `_icFmt`. | 1 |
| 13 | Tælleenheder | Lagerenhed først; pakke-enhed omregnes via `toStock`; manglende konvertering → kun lagerenhed. Hukommelse er pr. vare **og** fysisk enhed. Brøk-reglen (stykvare vs. målenhed) låst med kålhovedet som grænsetilfælde. | 2 |
| 14 | Session-nøgle uden UTC-dato | Nøglen er `ic_counts_<lok>` uden dato; `_icLocalDate` bruger lokale getters; genoptag-banner kun når der faktisk er noget at genoptage. | 2 |
| 16 | Commit-stien kørt med attrap-Grocy | `_icPlanCommit` + `_icExecuteCommit` med injicerede Grocy-attrapper: hvilke kald fyrer, med hvilke argumenter, i hvilken rækkefølge. Dækker Bug 1 + Bug 2 som **adfærd** (ikke kilde-scan), konflikt-gaten, keep/override, begge beslutninger inkl. rækkefølgen lager-0-før-deaktivering, fejl-adskillelse og kvitteringsteksten. | 2 |
| 15 | Sprunget over bliver synligt | Sprungne varer forsvinder ikke — de havner i `cat.skipped`, tæller ikke som tjekket, og skip persisteres i sessionens payload (ingen `sessionStorage`-kald tilbage). | 2 |

## 5. Eksempel (case 6 — cross-location fallback, beslutning E)
Lokation Køl (id 6) har enheder [KØL-1, KØL-2]. Vare hører til Køl (`location_id=6`), men
`LastCheckedUnit=FRYS-2` (enhed under Fryser). Ved optælling af Køl/KØL-1:
`_icVisibleInUnit(vare, ['KØL-1','KØL-2'])` → **true** (FRYS-2 er ikke en Køl-enhed → fallback
til hjem-lokation). Varen forsvinder ikke tavst.

## 6. Fejlsignaler
- Bug 2-guard fejler → en write-sti hardkoder stadig evighedsdato → holdbarhedsdata tabes.
- Case 6d fejler → cross-location-varer forsvinder tavst (værst for et backstop).
- Case 7 rækkefølge forkert → forfaldne/aldrig-tjekkede synker → optællingen misser dem.
- Case 11 `conflict=false` ved drift → tavs last-writer-wins → auto-deduct-forbrug overskrives.

## 7. Filer
- Kode: `shared/inventory_check.js`
- Runner: `tests/scripts/run_T_OPTAELLING.js`
- npm: `test:run-optaelling`

## 8. Hvad vi ved
BB-adfærd verificeret empirisk mod grocytest (Grocy 4.6.0, 18. juli 2026): udelad
best_before → Grocy daterer surplus via `default_best_before_days`, rører ikke eksisterende
batches, FIFO-consumer ved formindskelse. Se `docs/CLAUDE_OPTAELLING.md` §4 Bug 2-boks.

## 9. Næste
Tracken er komplet for #331.

Case 16 er **mutations-testet**: tre bevidste fejl indført i kildekoden blev alle
fanget — genindført `'2999-12-31'` (16b), stempling af ikke-talte varer (16c/16d),
og ombyttet rækkefølge i "varen findes ikke mere" (16p). Hvis optællingen udvides (fx server-side session-lås fra #243),
hører nye cases til her.

Åbent til drift, ikke til kode: tærsklen i `_icIsPackUnit` (`_IC_PACK_MIN_SHARE = 0,05`)
afgør om en brøk betyder "en del af én pakke" eller "en del af det forventede lager".
Grocy skelner ikke stykvare fra målenhed, så det er et skøn — efterprøv det i køkkenet.

## 10. Status
**112 PASS · 0 FAIL · 0 SKIP.** Cases 1–16 automatiseret (pure runner, ingen server/Grocy).

Browser-verificeret end-to-end mod grocytest 18. juli 2026 (før-tilstand noteret og rullet
tilbage bagefter): enheds-chips med tæller, tælling bevaret pr. enhed ved skift, tælleenhed
husket pr. vare+enhed, live-konvertering, brøk-reglens to grene (kålhoved vs. gram),
⋯-menu, skip + Fortryd, slutskærm med beslutnings-sektion, commit, og blivende kvittering.
Ved commit: lager rettet 2,562 → 1,5, `LastCheckedUnit` = sidst talte enhed, **best-before
bevaret** (2026-05-18, ikke 2999), og en ikke-talt vare forblev urørt i Grocy.

## 11. Findings
- **F1 (rettet i PR 2):** `_icSessionKey()` brugte UTC-dato → en aftenoptælling efter dansk
  kl. 22 skiftede nøgle og mistede alle counts. Låst af case 14c/14d.
- **F2 (rettet i PR 2):** dags-scopet nøgle modsagde §6's fler-dags-præmis og efterlod døde
  localStorage-nøgler. Låst af case 14a/14b.
- **F3 (rettet i PR 2):** skip lå i `sessionStorage` og døde ved fane-luk, mens counts
  overlevede. Låst af case 15e/15f.
- **F4 (rettet under browser-test):** enheds-chippens tæller opdaterede kun ved enhedsskift,
  ikke efter en tælling — `_icRenderUnitChips()` kaldes nu fra `_icUpdateProgress()`.
- **F5 (rettet under browser-test):** første udgave af brøk-reglen brugte `toStock > 1` og
  behandlede derfor et kålhoved (0,8 kg) som en målenhed. Erstattet af `_icIsPackUnit()`.
  Låst af case 13l–13p.
- **F6 (rettet efter kode-review):** en søgning der kun ramte en *sprunget* vare udløste
  tom-tilstanden, hvis `innerHTML`-overskrivning slettede kortet — varen lå på listen, men
  søgningen påstod den ikke fandtes, og Fortryd forsvandt. Tom-tilstanden afgøres nu før de
  sprungne kort tilføjes. Låst af case 15g/15h.
- **F7 (rettet efter kode-review):** kvitteringsbanneret blev kun ryddet af luk-knappen, så en
  kvittering fra sidste optælling stod og lignede en kvittering for den man var i gang med.
  `_icStartCheck` rydder den nu.
