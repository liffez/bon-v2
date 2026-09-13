# INDKOB_GENNEMFOERELSE.md — plan for indkøbsarbejdet

> Overblik over hvad der skal ske, i hvilken rækkefølge, og hvem der gør hvad.
> Detaljerne står i `CLAUDE_INDKOB_FASE_A.md` og `CLAUDE_INDKOB_FASE_B.md`.
> Dette dokument er kun rækkefølge og ansvar.

---

## Dokumenterne

| Fil | Indhold | Status |
|---|---|---|
| `../CLAUDE_INDKOB_ASIS.md` | Sådan virker modulet i dag | ✅ Indsættelsen anvendt 17.08.2026 (nyt §12.5, gammelt §12.5 → §12.6, spørgsmål 11) |
| `CLAUDE_INDKOB_FASE_A.md` | A1–A9: retter fejl | Klar til Simon — **læs de tre noter dateret 17.08.2026** (header, §5.4, §6) |
| `CLAUDE_INDKOB_FASE_B.md` | B1–B3: fjerner det der lyver | Klar — sporet som issue |
| `HUSKELISTE_indkob_fase_c.md` | Fase C-skitse | ✅ Peget på fra `../BON_V2_HUSKELISTE.md`. Denne fil er source-of-truth. **Ingen spec endnu** |
| ~~`ASIS_indsaettelse_12_5.md`~~ | Tre blokke til ASIS | ✅ Anvendt og slettet 17.08.2026 |

Ingen mockup nødvendig for A og B — alt er backend eller små tilføjelser i eksisterende
komponenter. Fase C kræver mockup før spec.

---

## Trin 0 — inden noget som helst (Leif, i dag)

- [ ] Sig til den der bestiller: **tjek salgsenheden på hoka.dk's checkout** indtil Deploy 2
      er ude. Systemet kan bestille kartoner hvor du ville have poser (Fase A §0)
- [x] ~~Indsæt de tre blokke fra `ASIS_indsaettelse_12_5.md`~~ — gjort 17.08.2026
- [x] ~~Indsæt `HUSKELISTE_indkob_fase_c.md` i `../BON_V2_HUSKELISTE.md`~~ — gjort 17.08.2026
      som afsnit + peger (skitsen kopieres bevidst ikke ind: to kopier ville drive fra hinanden)

### Trin 0b — spec-rettelser efter kode-ændringer siden 31.07 (gjort 17.08.2026)

Fase A er skrevet mod koden 31.07. Siden da er tre ting landet i drift. Alle tre er noteret
**i** Fase A dér hvor de rammer:

| Hvad | Hvor det står nu |
|---|---|
| **#358/PR #408** — varemodtagelsens enheds-konvertering er rettet. Der er nu **tre** enhedsakser, ikke to. A2 §5.4's antagelse om at `addStock` skal have basisenheder er forældet | A §5.4, boks dateret 17.08 |
| **#419** — `resolveSalesUnits` + `rejected[]` findes allerede. A3 udvider kanalen, opfinder den ikke. A8's fundament er dermed halvt på plads | A §6, boks dateret 17.08 |
| **#477** (merget 18.08) — kobl-panelet, gruppe-navne, render-livscyklus og inline varenr-håndtering. **Rører ikke regnestykket**, men tre ting fra den påvirker A2, A9 og Fase B | A §5.1, §5.2, §10c · B B1.2 + note før B2 |
| **Linjenumre drevet ~32 linjer** efter #477 (`shared/indkob.js` 3.132 → 3.544) + næste migrationsnummer er **149** | A's header + §3 punkt 3 |
| **A6-modstriden** mellem Trin 5 ("besluttet") og §14 ("åbent") | Ryddet: A §9.2 + §14. Trin 5 vinder — ingen kode i A6 |

**Testgæld der stakker:** hverken #419 eller #477 fik kørt `T_INDKOB_LISTE` / `T_INDKOB_SETUP`
(de kræver `.env.test` + testserver på 4322 + grocytest). Deploy 2 rører de samme tracks. Læg en
kørsel ind **før** Deploy 2, så man kan se forskel på "fejler pga. Fase A" og "fejlede i forvejen".
`T_INDKOB_HORKRAM`s fixtur er desuden rådden — se spec'ens §10b.

⚠️ **Det ene punkt der stadig skal afgøres inden Deploy 2:** akse 3 — er
`ordered_unit_qty` udtrykt i Hokas basisenhed eller i Grocys indkøbsenhed, og hvilken `qu_id`
sender varemodtagelsen for en A2-bestilt linje? Tre konkrete spørgsmål i A §5.4.

---

## Trin 1 — forudsætninger (Bror + Simon, ~1 time)

| # | Opgave | Hvem | Reference |
|---|---|---|---|
| 1.1 | Opret 3 userfields på `shopping_list` i **alle tre** Grocy-instanser | Bror | A §2 |
| 1.2 | Kør grep-tjeklisten, bekræft at billedet passer | Simon | A §3 |
| 1.3 | Find næste ledige migrationsnummer | Simon | A §3 pkt. 3 |
| 1.4 | Noter antal rækker i `purchase_order_lines` før migration | Simon | A §11.9 |

**Stop hvis 1.2 afviger fra §1.** Spec'en er skrevet mod koden som den så ud 31.07.2026.

---

## Trin 2 — Deploy 1: migration (Simon, ~2 timer)

Additiv. Ingen adfærdsændring. Kan ligge i produktion uden at nogen mærker det.

- [ ] `NNN_indkob_fase_a.sql`: `purchase_order_lines` recreates, `goods_receipts.supplier_id`,
      `unit_mappings` (A §7)
- [ ] `routes/orders.js` indsætter de nye kolonner (A §7.1)
- [ ] Verificér: `item_id` er `notnull=0`, rækkeantal matcher 1.4

---

## Trin 3 — Deploy 2: den store (Simon, ~3-5 dage)

**Kan ikke splittes.** A5a omdøber parser-felter og bryder kaldere; A2 kræver A5a;
A1 ændrer route-signaturer og kræver frontend samtidig; A2 og A7 rører samme funktion;
varemodtagelsen skal med, ellers flytter A2 fejlen fra bestilling til lager.

| Rækkefølge | Opgave | Reference |
|---|---|---|
| 1 | **A5a** parser: nye feltnavne, `salesPricePerSalesUnit`, ingen `\|\| 0` | A §8.1 |
| 2 | **A1** leveringsdato som parameter + `_edd`-cookie uden caching | A §4 |
| 3 | **A5b** `indkob.js` regner på valgt enhed | A §8.2 |
| 4 | **A5c** `enrichWithAftale` beriger fuldt | A §8.3 |
| 5 | **A5d+e** kilopris fra Hoka, egen udregning som assertion | A §8.4–8.5 |
| 6 | **A2** enhedsvælger på chippen (4-trins default) | A §5.1–5.3 |
| 7 | **A2/A7** de tre `ordered_*`-userfields — **én ændring** | A §5.5 |
| 8 | **A2** varemodtagelsen kender enheden | A §5.4 |
| 9 | **A7** læsesiden matcher på id, falder tilbage til navn | A §10.2 |
| 10 | **A3** `basket/add`: ensartet format, dedup på enhed, `validate=true` | A §6 |
| 11 | **A8** afviste linjer + erstatning i samme bestilling | A §10b |
| 12 | **A9** draweren forudfylder + `unit_mappings` | A §10c |

Punkt 11 afhænger af 10 (`rejected[]`). Punkt 12 afhænger af 4 (berigede søgeresultater).

**Go-live-blockere for at genoptage normal bestilling:** punkt 3, 6 og 8.

---

## Trin 4 — Deploy 3: Fase B (Simon, ~1 dag)

Uafhængig af A. Kan tages parallelt eller efter.

- [ ] B1.1 "✓ Merget" → "Markér som håndteret"
- [ ] B1.2 "Bestillinger"-pill → "Bestil", forskellig `_ibViewMode` pr. pill
- [ ] B1.3 forecast-deeplink: enten få det til at virke eller fjern knappen
- [ ] B2.1–2.3 skjulte felter
- [ ] B3.1–3.3 død kode fjernes med begrundelse i commit

---

## Trin 5 — A6 uden A6 (løbende, ingen kode)

**Beslutningen er taget:** ingen batch-oprydning, hverken automatisk eller som liste.

Efter Deploy 2 viser chippen den forkerte enhed på gamle koblinger. Du vælger den rigtige,
og den gemmes. Efter et par bestillingsrunder er de varer du faktisk bruger rettet — og dem
du ikke bruger, betyder ikke noget.

- [ ] Kør §9.1-forespørgslen én gang for at kende omfanget (Simon)
- [ ] Sæt `indkob_trust_unit_userfields = 1` når tallet er faldet mærkbart (Leif)

Indtil flaget er sat, bruger A2 `isDefault` frem for de gemte userfields. Det er sikkert
i mellemtiden.

---

## Trin 6 — to ugers brug (Leif)

Efter Deploy 2. **Noter hvad der gør ondt — ikke hvad du tror mangler.**

Spørgsmål at holde øje med:

- Er kurven i browserhukommelsen faktisk irriterende, eller går det?
- Hvor tit skal du bruge "Søg erstatning"?
- Lærer `unit_mappings` hurtigt nok, eller gætter den forkert?
- Savner du et sted at se hvad der er bestilt?

Sidste spørgsmål afgør om Fase C's kladde-entitet overhovedet skal bygges.

---

## Trin 7 — opdatér ASIS (Simon, ~1 time)

Når Deploy 2 er ude: ret `../CLAUDE_INDKOB_ASIS.md` så den ikke beskriver rettede fejl.
Ellers fejlsøger nogen om tre måneder noget der er væk.

---

## Trin 8 — Fase C (ikke planlagt)

Kræver: to ugers brug + mockup + spec. **Bindingen fra ASIS §12.5 gælder** — varemodtagelsen
skal migreres i samme deploy som kladde-modellen, ellers står den med tom liste.

---

## Hvis noget skal skæres

Prioriteret nedefra:

| Kan udskydes | Kan ikke udskydes |
|---|---|
| A9 (forudfyldning) — friktion, ikke fejl | A5b — priser er 0 i dag |
| A8 (erstatning) — sjælden hændelse | A2 — bestiller forkert mængde |
| Fase B — irriterende, ikke farligt | A2 §5.4 — ellers flytter fejlen til lageret |
| A7 læsesiden | A1 — priser afhænger af datoen |
| | A3 — fejl forsvinder lydløst |

Skæres A9, skal `unit_mappings` **stadig** med i migrationen. Det er gratis nu og
besværligt senere.

---

## Det eneste der stadig er uafklaret

Intet blokerende. To ting kan Simon selv afgøre undervejs:

| Punkt | Hvor |
|---|---|
| Feltnavn for pris pr. salgsenhed i Hokas svar — verificér `ListPricePerSalesUnit` findes på alle varer | A §8.1 |
| Om `initProductCreate` kan tage flere felter, eller skal udvides | A §10c.1 |

---

*Skrevet august 2026. Trin 0 + 0b gennemført 17.08.2026.*
