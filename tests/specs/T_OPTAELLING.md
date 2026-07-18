# T_OPTAELLING — Lageroptælling (rullende session-model)

> Track for redesignet i #331. Spec for selve modulet: `docs/CLAUDE_OPTAELLING.md`.
> PR 1 (data-integritet) dækkes af cases 1–7 her. Cases 8–11 hører til PR 2 (UX) +
> concurrency-UI og er markeret SKIP indtil da.

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
| 8 | Enheds-chips bevarer tælling | `counts[id].units` intakt pr. enhed ved enhedsskift. | 2 (SKIP) |
| 9 | ⋯ "Skal ikke tjekkes" | Commit → `HverDag=""`. | 2 (SKIP) |
| 10 | ⋯ "Udgået" | Commit → inventory 0 + `active=0` (kræver produkt-patch-endpoint). | 2 (SKIP) |
| 11 | Concurrency: drevet beholdning | `_icClassifyCounted` → `conflict=true` ved baseline≠grocyNow; `conflict=false` når afklaret. (§6-UI browser-verificeret) | 1 |

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
PR 2: cases 8–10 (enheds-chips, ⋯-menu) kræver DOM/browser-verifikation; "Udgået" (case 10)
kræver et produkt-patch-endpoint der måske ikke findes endnu (se §9 grep-tjek i modul-specen).

## 10. Status
PR 1: cases 1–7 + 11 automatiseret (pure runner). Cases 8–10 SKIP indtil PR 2.
Write-stien (commit skriver kun talte varer, ingen BB) er desuden browser-verificeret.

## 11. Findings
(ingen endnu)
