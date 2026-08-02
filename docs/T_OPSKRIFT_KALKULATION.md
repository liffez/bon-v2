# T_OPSKRIFT_KALKULATION.md

Test af kostpris- og avance-visning i opskriftsdesigneren.
Spec: `CLAUDE_OPSKRIFT_KALKULATION.md` (genbrugsplan).

**Bærende testkrav: der er ÉN kostpris.** Designerens kostpris skal til enhver tid være
identisk med det `GET /api/recipes/overview` viser for samme opskrift. Al kostpris
kommer fra `recipe_cost_cache` (Grocy fulfillment) — designeren beregner den ikke.
Derfor tester denne suite **ikke** enhedskonvertering af råvarepriser; det ligger i
Grocy og er dækket af `T_OPSKRIFTER`.

**Miljø:** `grocy-test` udelukkende. Fixtures har prefix `ZZT_`, slettes ikke.

**Tre go-live blockers** markeret ⛔.

---

## 1. Fixture-opsætning

Fixturen bygges i Grocy så **fulfillment-kostprisen** er kendt. Vi kontrollerer ikke
råvarepriserne i testen — vi kontrollerer at designeren viser det Grocy allerede
beregner, og at løn/pris/DB lægges korrekt ovenpå.

### 1.1 Opskrift under test

`ZZT_Kalkulation` — base 10 portioner, med mindst:
- et par direkte ingredienser (så fulfillment giver en ikke-triviel kostpris)
- én ingrediens i gruppe `emballage`
- én nesting der selv har en nesting (dybde 2)

**Kendt sandhed hentes fra `GET /api/recipes/overview`**, ikke fra et regneark:
noter `cost_price_excl_moms` og `co2e` for `ZZT_Kalkulation` FØR testen og brug dem som
forventede værdier. Det er hele pointen — cachen er sandheden.

Til dette dokument antages (indsæt de faktiske tal ved kørsel):

| Fra overview for `ZZT_Kalkulation` | Antaget værdi |
|---|---|
| `cost_price_excl_moms` (pr. opskrifts-enhed) | **22,16** |
| `co2e` | 0,42 |
| kategori | `01 Sandwich` |

### 1.2 Salgspris og mål

| Kilde | Værdi |
|---|---|
| `item_prices` (recipe, catering) | 75,20 ex (= 94 kr inkl.) |
| `recipe_db_targets['01 Sandwich']` | 70 |

### 1.3 Løn

| Kilde | Værdi |
|---|---|
| `wage_rates` aktive rater | fx 190, 200 → standard 195 |
| `settings.labor_overhead_pct` | 15 |
| `arbejdstid_min` (userfield, AKTIV tid pr. batch) | 15 min ved base 10 → 1,5 min/portion |

Løn pr. portion = `195 × 1,15 × (15/10) / 60` = **5,60625 ≈ 5,61 kr**.
(Procestid indgår IKKE — kun aktiv tid.)
Fuldt belastet pr. portion = `22,16 + 5,61` = **27,77 kr**.

---

## 2. Forventede afledte tal

Regnet ovenpå den cachede kostpris (ikke fra råvarer).

| Afledt | Grundlag = råvarer | Grundlag = inkl. løn |
|---|---|---|
| Foreslået pris ex @ 70 % DB | 22,16 / 0,30 = 73,87 | 27,77 / 0,30 = 92,57 |
| Foreslået menupris inkl. | `round(73,87 × 1,25)` = **92** | `round(92,57 × 1,25)` = **116** |
| Faktisk 94 kr inkl. → ex | 75,20 | 75,20 |
| Faktisk DB | (75,20−22,16)/75,20 = **70,5 %** | (75,20−27,77)/75,20 = **63,1 %** |
| Verdict @ mål 70 % | grøn | rød (foreslår 116 kr) |

D6-fælden: glemmes momsen bliver faktisk-DB 76,4 % i stedet for 70,5 % — 6 point forkert
og fuldt plausibelt.

---

## 3. ⛔ Del A — Én kostpris (den vigtigste test)

| # | Case | Forventet |
|---|---|---|
| A1 | Designer vs. overview | `ZZT_Kalkulation`s kostpris i designeren == `cost_price_excl_moms` i `GET /api/recipes/overview`. **Identisk**, ikke "tæt på" |
| A2 | Kilde | Kostprisen kommer fra `GET /api/recipes/:id/cost` (cache), IKKE fra en klient-side sum af råvarepriser. Verificér i netværkspanel: intet kald henter råvarepriser for at regne kostpris |
| A3 | Løn ændrer ikke kostprisen | Slå løn til/fra → "Kostpris (råvarer)" står uændret 22,16. Kun "fuldt belastet" og pris/DB bevæger sig |
| A4 | Uændret ved portionsskift | 10 → 25 portioner: kostpris **pr. portion** uændret (den er pr. opskrifts-enhed fra cachen) |

A1 er beviset på at der ikke findes to kostprisberegninger. Hvis den fejler, er hele
genbrugspræmissen brudt.

---

## 4. ⛔ Del B — Manglende / ikke-cachet kostpris

| # | Case | Forventet |
|---|---|---|
| B1 | Ny opskrift, aldrig gemt | Kostpris-kort viser `beregnes efter gem` · pris/DB `—` · ikke `0` |
| B2 | `fetchRecipeCost` returnerer `null` | Panelet blokerer ikke, viser `—`, ingen `NaN` |
| B3 | Grocy nede ved refresh | Kostprisen bevarer sidst-kendte cache-værdi + note; ingen exception |
| B4 | Efter `Gem` | `refreshRecipeCosts()` kaldt → `fetchRecipeCost` kaldt igen → kostpris opdateret |
| B5 | Redigering før gem | Vist kostpris = sidst-gemte + note "opdateres ved Gem". Ingen live klient-beregning |

B5 er kernen i "kun én beregning": et redigeret, ugemt træk ændrer ikke kostpris-tallet
før Grocy har regnet det om.

---

## 5. ⛔ Del C — Løn-add-on

| # | Case | Forventet |
|---|---|---|
| C1 | Standardsats | `getStandardHourlyRate()` = gennemsnit af aktive `wage_rates` (195 i fixturen) |
| C2 | Aktiv tid pr. batch | Løn = `195 × 1,15 × (arbejdstid_min/base_servings)/60` = `195 × 1,15 × (15/10)/60` = 5,61 kr/portion. `labor_overhead_pct` fra settings, ikke hardkodet |
| C3 | Kun aktiv tid | Feltet er aktiv arbejdstid. En procestid (kogetid) må aldrig havne her — testes ved review, ikke beregning |
| C4 | Løn slået fra | Løn-linje `—`, grundlag = ren vareomkostning 22,16 |
| C5 | Ingen rater / tomt userfield | Løn-linje `—` + note, aldrig `0`-gæt, aldrig `NaN` |
| C6 | Løn skalerer | 25 portioner: aktiv min/portion uændret, total-løn skalerer, pr. portion uændret |
| C7 | Grundlag-toggle | DB regnes mod det valgte grundlag; begge DB-tal (råvarer / inkl. løn) vises |

---

## 6. Del D — Moms og afrunding

| # | Case | Forventet |
|---|---|---|
| D1 | Al intern beregning | Ex moms. Kostpris 22,16 — aldrig 27,70 |
| D2 | Kun visning konverteres | Foreslået inkl. = `round(Moms.exclToIncl(73,87))` = 92 |
| D3 | Afrunding én gang | Ingen afrunding før sidste inkl.-visning |
| D4 | DB-slider | Arbejder ex moms. 70 % = 70 % ex, ikke 56 % |
| D5 | Ingen magiske tal | `grep -nE "1\.25|0\.25" shared/recipe_designer.js` → tomt. Pre-commit-hook fanger det |
| D6 | Faktisk DB | 94 kr inkl. → 70,5 % (råvarer-grundlag), ikke 76,4 % |

---

## 7. Del E — Salgspris & write-back (genbrug)

| # | Case | Forventet |
|---|---|---|
| E1 | Faktisk pris | Hentes fra `item_prices` (recipe, valgt kategori), ikke fra Grocy direkte i frontend |
| E2 | Skriv salgspris | Checkbox + gem → `PUT /api/item-prices` kaldes med `price_excl_moms` |
| E3 | Grocy master | Fejler Grocy → prisen gemmes IKKE lokalt (endpointet håndterer det); UI viser fejl |
| E4 | Ingen ny kode til write-back | Designeren kalder eksisterende endpoint — ingen ny Grocy-skrivning bygget |

---

## 8. Del F — DB-mål (genbrug)

| # | Case | Forventet |
|---|---|---|
| F1 | Slider-start | = `recipe_db_targets` for opskriftens kategori (`01 Sandwich` → 70) |
| F2 | Kategori uden mål | Fallback 70, ingen crash |
| F3 | Mål ændres i office | Nyt mål slår igennem ved næste load (samme `recipe_db_targets`, ét sted) |
| F4 | Intet nyt setting | `grep -rn "kalkulation.maal_db_pct" shared/ routes/` → tomt |

---

## 9. Del G — Skalering

| # | Case | Forventet |
|---|---|---|
| G1 | 10 → 25 portioner | Kostpris pr. portion uændret · løn skalerer · foreslået pris uændret (den er pr. portion) |
| G2 | 10 → 1 portion | Pr. portion uændret |
| G3 | 0/negative portioner | Ikke muligt · minimum 1 |

---

## 10. Del H — Kladde

| # | Case | Forventet |
|---|---|---|
| H1 | Reload midt i arbejdet | Kladde tilbydes: `Fortsæt` / `Kassér` |
| H2 | `Fortsæt` | Ingredienser, portioner, løn-min og DB-mål gendannes |
| H3 | Prissnapshot | Kostpris/CO₂ i kladden er de **læste** værdier + snapshot-dato; ændres ikke når Grocy ændrer sig |
| H4 | Efter publicering | Kladde-nøgle ryddes |
| H5 | Fuld localStorage | Fejler stille, blokerer ikke designeren |

---

## 11. Del I — Kort-synlighed

| # | Case | Forventet |
|---|---|---|
| I1 | Default | Kun `weight` + `stock` synlige |
| I2 | Slå `cost` til | Kort + pris-panel vises |
| I3 | Slå alle pris-kort fra | Pris-panel skjules, `fetchRecipeCost` kaldes ikke (netværkspanel bekræfter) |
| I4 | Reload | Valget huskes pr. bruger (`rd_cards_v1`) |
| I5 | Intet nyt modul-flag | Ingen `module_kalkulation_enabled` bygget — kort-synlighed er per-bruger |

---

## 12. Sign-off

| Del | Blocker | Status | Testet af | Dato |
|---|---|---|---|---|
| A — Én kostpris | ⛔ | ☐ | | |
| B — Manglende/ikke-cachet | ⛔ | ☐ | | |
| C — Løn-add-on | ⛔ | ☐ | | |
| D — Moms | | ☐ | | |
| E — Salgspris & write-back | | ☐ | | |
| F — DB-mål | | ☐ | | |
| G — Skalering | | ☐ | | |
| H — Kladde | | ☐ | | |
| I — Kort-synlighed | | ☐ | | |

Efter grøn A+B+C: åbn en **rigtig** opskrift på `grocy-hq` i read-only og bekræft at
designerens kostpris matcher office-modulets for samme opskrift. Enhver afvigelse er en
fejl i genbrugskoblingen, ikke i en beregning — for der er kun én.
