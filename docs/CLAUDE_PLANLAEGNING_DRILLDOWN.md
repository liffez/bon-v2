# CLAUDE_PLANLAEGNING_DRILLDOWN.md — Planlægningen som drill-down

> Status: Fase 1–3 BYGGET side om side med den gamle (september 2026). Den gamle fjernes når køkkenet har testet. Se §18–21.
> Oprettet: 20. september 2026
> Mockup (klikbar, iPad + 27"): https://claude.ai/artifact/V9Sj2i3SnwuxrHxLx9b921
> Berører: `shared/planning.js/.css`, `kitchen/planning.html`, `office/views/planning.js`,
> `routes/kitchen.js`, `services/ingredientResolver.js`, `shared/api.js`

---

## 1. Hvorfor

Planlægningen (Fase 3D) giver i dag en flad produktionsliste + to modaler (Råvarer,
Sammentælling). Produktion- og Råvarer-fanen i Råvarer-modalen er næsten ens, fordi
Produktion viser *niveau 1 af opskriften* — og de fleste ingredienser er købte varer,
som står identisk begge steder. Den svarer ikke på "hvad skal vi lave?".

Målet er ét overblik man kan **trykke sig ned i**, fra "hvor mange slidere" til "hvad
mangler vi af salt", på iPad og 27" touch.

## 2. Grundprincip — planlægningen er en virtuel bon

| | Almindelig bon | Planlægning |
|---|---|---|
| Linjer | `bon_lines` | summen af valgte bons' linjer + ekstra-linjer |
| Kunde | kunde/adresse | ingen — i stedet **kilde-reference pr. linje** (`#B4297 · Daquma`) |
| Levetid | gemt | beregnes, forsvinder når man lukker. Intet gemmes. |

Planlægningen **laver ikke noget** — den giver overblik. Eneste skrivende handlinger:
🛒 til indkøbslisten (findes i dag) og evt. tjeklisten (se §9, åbent spørgsmål).

## 3. Genbrug — intet nyt regnes i planlægningen

Planlægningen må kun **sammensætte** data. Mangler den et tal, laves en delt
backend-funktion først, som også bruges alle andre steder. Intet regnes lokalt i
`planning.js`.

| Beregning | Én kilde | Bruges også af |
|---|---|---|
| Opløsning opskrift → underopskrift → råvare | `services/ingredientResolver.js` | bon, pakkeliste, lagertræk |
| Råvarestatus (🔴🟡🟢, "skal laves") | resolverens råvare-niveau (#349) | Råvarer-modal, bon-kort |
| **Nettomangel** = behov − lager − på listen − bestilt | **NY** backend-funktion | Indkøb (`shared/indkob.js`) skal over på den — separat opgave, men funktionen designes til det |
| Oprunding til hele købsenheder | den eksisterende oprunding bag 🛒 | 🛒 overalt. Ligger den i frontend i dag → flyt til backend |
| Enhedstælling | `recipe_unit_counts` + `settings.unit_count_categories` | Sammentælling, dashboard, kitchen, **ugeoversigtens kapacitet** (`routes/schedule.js`) — samme tal skal komme ud begge steder |
| Hvad skal laves (niveau 4) | produktionspolitikken (`productionTypeOf`/`buildProductionPolicy`) + resolverens `make_*`-felter | dashboardets "Lav snart" (`/api/bons/prep-ahead`) |
| Moms | `shared/moms.js` | alt |
| Kostpris | Grocy fulfillment `costs` (opskrift for producerede, 90-dages snit for købte, #557/#558) | kalkulation, tilbud |
| CO₂ | `co2e_per_kg` / opskriftens `Co2e` (F5-cache) | CO₂-modul |
| Periode fra/til | **NY** `shared/periodPicker.js` | driftsregnskab (migreres senere) |

**Nuværende brud der fjernes:** pris-toggle i planlægningen dividerer salgspriser med
1.25 i frontend (Migration 043-afsnittet). Det erstattes af backend-felter via
`shared/moms.js`.

## 4. Layout

```
┌ topbar ─────────────────────────────────────────────────────────┐
│ [Dag|3 dage|Uge|Periode] ◀ Uge 39 · 21.09–27.09 ▶ [I dag]  ◯ Pr. dag │
│ [1 Kategorier][2 Varer][3 Ønsker][4 Skal laves][5 Råvarer]   Vis: …  │
├──────────────┬──────────────────────────────────────────────────┤
│ BONS         │ brødkrumme: Kategorier › Sandwich › 52 × Kartoflen │
│ status-chips │ ┌ kolonne ┐ (┌ kolonne ┐ ┌ kolonne ┐ på 27")        │
│ ☑ #B4266 …   │ │ rækker  │                                        │
│ EKSTRA       │ └─────────┘                                        │
│ [Tjekliste]  │                                                    │
└──────────────┴──────────────────────────────────────────────────┘
```

| Skærm | Bonliste | Drill-down |
|---|---|---|
| iPad landskab (≈1180) | fast venstre, 430 px | 1 kolonne (den dybeste) |
| 27" (≥1600) | fast venstre, 560 px | 3 kolonner side om side (Finder-kolonner) |

Samme komponent — antal kolonner bestemmes af bredde (CSS/JS breakpoint), ikke af zone.

**Touch:** rækker ≥ 60 px, knapper ≥ 44 px, ingen long-press, ingen små fold-ud-pile.
Tryk på række = et niveau ned. Brødkrumme = tilbage til ethvert niveau.

**Vagtplanen** forbliver som i dag (kollapset sektion) — ikke en del af denne opgave.
Planlægningen viser **ingen** kapacitetsberegning; den findes i office' ugeoversigt.
Kravet er kun at enhedstallene regnes med samme funktion begge steder (§3).

## 5. Bonvalg og ekstra (venstre kolonne)

Beholdes fra i dag, redesignet til smal kolonne:
- Status-chips (localStorage-persistens som i dag).
- **Standard-statusser er en admin-indstilling** (Settings), fx `planning_default_statuses`.
  Udgangspunkt: LEVERET, FAKTURERET, BETALT, AFSLUTTET og AFLYST er **fra**. En leveret
  bon har trukket lageret, så med den i behovet tælles varerne to gange. Brugeren kan
  stadig slå chips til og fra; indstillingen styrer kun hvad der er valgt fra start.
- **Tilbud** vises indtil de er vundet. Et vundet tilbud bliver liggende som bilag
  (`is_offer = 1`, `offer_status = 'won'`) ved siden af den rigtige bon og skal derfor
  aldrig med — ellers tælles ordren to gange. `GET /api/bons/planning` filtrerer
  allerede `offer_status != 'won'` fra; det nye endpoint skal bruge samme filter.
- **Event-salgsbons** oprettes som BETALT (`routes/events.js`) og falder dermed ud med
  standardreglen. Kun prep-bonnen trækker lager. Ingen særregel nødvendig.
- Bonrækker på to linjer: `#nr · STATUS · dag` / `kunde` — `N enh` til højre.
- Checkbox pr. bon, Vælg alle / Fravælg alle.

**Ekstra — uden bon** (erstatter "Ekstra opskrifter"):
- "+ Tilføj menu" → VarePicker (sellable-opskrifter), antal.
- Vises som `N × navn` med ×-knap. Engangs — forsvinder ved luk/periode-skift.
- Tæller med i alle niveauer og totaler, med kilde "ekstra" i stedet for bon-ref.

## 6. Niveauerne

Visningsregel på **alle** niveauer: `N × navn` — antal, mellemrum, ×, mellemrum.
For vægt/volumen: `3,5 kg × Løvstikke Mayo`. Grupper uden mængde viser kun navn.

| # | Fane | Rækker | Tryk → | Kilde |
|---|---|---|---|---|
| 1 | Kategorier | `271 × Slider` | varer i kategorien | Sammentællingens kategori-logik (enhedstælling) |
| 2 | Varer | `52 × Kartoflen` + badge "2 ønsker" | standard + ønske-grupper | bonlinjer, bokse foldet ud (se nedenfor) |
| 3 | Ønsker | kun varer med ønsker: `7 × Falaflen · af 27` | ønske-grupper → bons | `special_request` |
| 4 | Skal laves | producerede varer: `2,08 kg × Æggesalat` + "bruges i …" + status | råvarer i den | produktionspolitikken via resolveren — samme kilde som "Lav snart" |
| 5 | Råvarer | grupper → `6,99 kg × Kartofler` | — | resolver, fladt, grupperet |

Fanerne er direkte indgange — indkøberen går til 5 uden at gå gennem 1–4.

**Udfoldning af bokse (niveau 1–3):** en boks (fx slider-boks 77/78) er indlejrede
opskrifter, og et `recipes_nestings`-barn med `sellable = 1` er en **vare** (niveau 1–3).
`sellable` sidder kun på opskriftsniveau og betyder "kan stå på en bon / sælges".
Bevidst valg: en opskrift der både sælges alene og indgår i en anden vises som vare.

**Niveau 4 bygger på produktionspolitikken (#270/#329), ikke på nestings.** Efter #270
er mellemprodukter **varer** på en almindelig ingredienslinje (Chili Mayo som produkt),
ikke indlejrede opskrifter — målt 20/9: 20 producerende opskrifter, ingen nestet. En
regel der kigger på `recipes_nestings` ville ikke finde dem. Niveau 4 skal derfor bruge
samme opløsning som lagertrækket og "Lav snart" gør. Der må ikke skrives ny logik;
mangler et tal, udvides den fælles funktion.

- **`to_stock`** (fx langtidsstegt gris, syltede rødløg): vises med behov mod varens
  lager og status (skal laves / dækket).
- **`on_demand`** (`RR produktion Hurtig` — mayo, dressing): vises også, som noget der
  **kan** laves, mærket *"laves automatisk ved levering"*. Køkkenet kan vælge at lave
  dem i forvejen.
- Grocys nesting-funktion er fortsat teknisk mulig (resolveren falder tilbage på den),
  men den tilbydes ikke som vej. Produktionspolitikken er modellen.

**Ønsker (niveau 2–3):** grupperes på `(vare, normaliseret special_request)` —
lowercase, trim, sammenpresset whitespace. Ingen parsing. "glutenfri" og
"glutenallergi" er to grupper — accepteret i v1. Hver gruppe viser sine bons
(`#nr · kunde · dag`).

**Niveau 4 vs. 5:** niveau 4 må **ikke** indeholde købte varer. Det er det der gør
den forskellig fra niveau 5 og til en egentlig prepliste.

**Pr. dag-knap:** tilføjer en linje under hver række: `Man 12 · Tir 14 · …`.
Kræver kun at `delivery_date` følger med i aggregeringen.

## 7. Vis-vælger — kost, CO₂, salg

`Vis: [Antal | Kost | CO₂ | Salg]` — ét tal ad gangen, til højre på rækken,
summeret i kolonnehovedet. `N × navn` står altid forrest.

| Tal | Niveau 1–3 | Niveau 4–5 | Moms | Zone |
|---|---|---|---|---|
| Kost | `bon_lines.cost_price` (snapshot) | aktuel kostpris via resolver | ex | begge |
| CO₂ | `bon_lines.co2e` (snapshot) | aktuel via resolver | — | begge |
| Salg | `bon_lines.unit_price` → ex via `shared/moms.js` | findes ikke | vises ex, mærket | **kun office** |
| DB | salg ex − kost | — | ex | kun office |

**Ekstra-linjer:** salg = menuens registrerede salgspris (standard-priskategori),
kost/CO₂ = aktuel. Mærkes **"listepris"**. En sum med både bon- og listepriser
mærkes **"inkl. listepriser"**.

**Regler (doktrin):**
- Manglende pris/CO₂ → `?`, udelades af summen, og kolonnehovedet siger det:
  *"Kost 4.210 kr ex · 3 ukendte"*.
- **Kost og Salg kan slås fra hver for sig** i Settings pr. **rolle** (rettigheds-matrixen,
  åbent spørgsmål 5). Er et tal slået fra, **sender serveren det ikke** — et flag i requesten
  (`include_sale`) kan enhver klient sætte, så det afgøres på serveren ud fra sessionen.
  Slået fra = knappen findes ikke i Vis-vælgeren. DB kræver både Kost og Salg.
- Den eksisterende pris-toggle (`show_prices_in_planning`, 6-kolonne-tabel, faktura-footer)
  **udgår** og erstattes af Vis-vælgeren + de to nye indstillinger.
- **Moms:** frontend regner ingen moms. Salg ex kommer færdigt fra serveren via
  `shared/moms.js`. Holdes under skarp observation i alle tre faser (§17).

**Kendt forskel:** niveau 1–3 bruger bonens snapshot, niveau 4–5 aktuelle priser.
Summen på niveau 3 og 5 kan derfor afvige. Kolonnehovedet på 4–5 skal sige
"aktuelle priser". Det er korrekt adfærd, ikke en fejl.

## 8. Indkøb på niveau 5

> **Afhænger af indkøbs-sessionen (24.09.2026).** Indkøb er et kapitel for sig og
> bygges i en anden session. Planlægningen bygger **ikke** nettomangel, tilstande eller
> indkøbsværdi selv. Indtil indkøbs-sessionen leverer en fælles funktion, viser niveau 5
> resolverens råvarestatus (🔴🟡🟢) og den eksisterende 🛒 — præcis som Råvarer-modalen i
> dag. Oprundingen bag 🛒 ligger allerede på serveren (`shortfall_purchase`,
> `services/ingredientResolver.js`). Nedenstående er målbilledet, ikke v1.

Hver råvare har en **tilstand**, beregnet af nettomangel-funktionen:

| Tilstand | Betingelse | Visning |
|---|---|---|
| Mangler | nettomangel > 0 | rød · `mangler 0,32 kg → 1 × sæk 10 kg` · 🛒 |
| På listen | `shopping_list.amount` dækker | blå · `på listen · 1 × sæk 10 kg` |
| Bestilt | `ordered_at` sat | lilla · `bestilt · {ordered_supplier} {dato}` |
| Dækket | lager ≥ behov | grøn |

- Der lægges altid på i **mindste hele købsenhed** (QU_purchase), rundet op.
- 🛒 pr. række lægger nettomanglen på listen — ikke bruttobehovet.
- **"Læg N manglende på listen"** i kolonnehovedet: på gruppeniveau = gruppen,
  på oversigten = alle. Kun rækker i tilstand *Mangler*.

**Indkøbsværdi — fast ekstra kolonne på niveau 5** (ikke i Vis-vælgeren):
nettomangel i hele købsenheder × leverandørpris, ex moms. `≈ 89 kr ex` pr. række,
sum pr. gruppe og i alt i kolonnehovedet. Manglende leverandørpris → `?`.

**Grupper på niveau 5:** grupperes efter varens **varegruppe** i Grocy, ikke efter
`ingredient_group` på opskriftslinjen. Nummerpræfikset styrer rækkefølgen, så
tier-hierarkiet (30 › 31) falder ud af navnet uden ekstra konfiguration.
`10 Emballage` sidst som i dag. Afgjort 23.09 — se åbent spørgsmål 1.

## 9. Tjekliste

Knap nederst i bonkolonnen: **"Lav tjekliste"**. Ikke en pakkeliste — en liste til
at gå lageret igennem og se om varerne **fysisk** er der (lageret kan være ude af
trit). Indhold: niveau 5 for det valgte grundlag, med afkrydsning pr. råvare.
Engangs, som resten af planlægningen. → se åbent spørgsmål 2 og 3.

Pakkeliste-til-events (gemt bon) er uændret og ikke en del af denne opgave.

## 10. Periodevælger — `shared/periodPicker.js` (NY, delt)

Bygger på driftsregnskabets vælger:

`[Dag | 3 dage | Uge | Periode]  ◀  {interval}  ▶  [I dag]`

- Modes er konfigurerbare pr. brug. Planlægningen: alle fire. Driftsregnskab: Dag/Uge/Periode.
- Hvert mode har en start-offset pr. brug. Planlægning: Dag = i morgen, Uge = næste uge,
  3 dage = fra i morgen. Driftsregnskab: i dag / denne uge.
- ◀ ▶ flytter ét interval. "I dag" → Dag, offset 0. Periode → Fra/Til-felter.
- Emitter `{from, to}` (ISO-datoer). Ingen datologik i forbrugerne.
- Driftsregnskabet migreres til komponenten når der alligevel arbejdes i det
  (ikke i denne opgave).

## 11. Backend

**NY:** `POST /api/bons/planning/tree` (i `routes/kitchen.js`, ved siden af de to
eksisterende planning-endpoints). POST fordi body indeholder ekstra-linjer — ingen
sideeffekter.

```json
// request
{ "bon_ids": [4266, 4297],
  "extras": [{ "grocy_recipe_id": 123, "quantity": 20 }],
  "include_sale": false }

// response
{ "levels": {
    "categories": [Node], "items": [Node], "requests": [Node],
    "prep": [Node], "raw": [Node] },
  "totals": { "units": 553, "cost_ex": 4210.5, "cost_unknown": 3,
              "co2e_kg": 812.3, "co2e_unknown": 1,
              "sale_ex": null, "sale_basis": null,
              "purchase_value_ex": 1850, "purchase_unknown": 0 } }

// Node
{ "id": "string, stabil inden for svaret",
  "name": "Kartoflen", "qty": 52, "unit": "stk", "qty_display": "52",
  "badge": { "text": "2 ønsker", "tone": "amber" } | null,
  "days": { "2026-09-21": 12, "...": 0 },
  "sources": [{ "bon_id": 4266, "bon_nr": "B4266", "customer": "Kvinderådet",
                "delivery_date": "2026-09-21", "quantity": 1 } | { "extra": true }],
  "values": { "cost_ex": 0, "co2e_kg": 0, "sale_ex": null,
              "sale_basis": "bon" | "liste" | "blandet" | null },
  "status": "ok|lav|mangler|skal_laves" | null,          // niveau 4–5
  "purchase": { "state": "mangler|listen|bestilt|daekket",
                "net_shortage": 0.32, "purchase_qty": 1, "purchase_unit": "sæk 10 kg",
                "purchase_value_ex": 89, "supplier": null, "ordered_at": null } | null,
  "used_in": ["Æggesalaten"] | null,                      // niveau 4
  "children": [Node] }
```

- Hele træet beregnes i ét kald. Frontend navigerer lokalt — ingen API-kald pr. tryk.
- Nye kald ved: bonvalg, ekstra, periode, statusfilter, SSE `bon_updated` på en valgt bon.
- `sale_ex`/DB og `cost_ex` returneres kun når indstillingen tillader det for sessionen
  (§7). `include_sale` i requesten kan kun bede om *mindre*, aldrig om mere.
- `purchase` er `null` i v1 (§8).
- Alle tal er færdigberegnede. Frontend formaterer kun (`qty_display`, valuta).
- `GET /api/bons/planning/ingredients` beholdes indtil Råvarer-modalen er fjernet
  fra planlægningen, derefter vurderes om andre bruger den.

## 12. Frontend

- `shared/planning.js` omskrives omkring: bonkolonne (eksisterende logik genbrugt),
  periodePicker, niveau-faner, brødkrumme, kolonne-render, Vis-vælger.
- Client-side aggregering (`grocy_recipe_id`-nøgle) **fjernes** — erstattes af træet.
- **Udgår fra planlægningen:** Råvarer-modal, Sammentællings-modal, pris-toggle/6-kolonne-tabel,
  "Aggregeret produktionsoversigt"-tabellen. (Modalerne kan fortsat bruges andre steder.)
- Kitchen og office bruger samme `shared/planning.js` — office sætter `include_sale`.

## 13. Afgrænsning v1

**Med:** alt ovenfor.

**Ikke med:**
- Tags/strukturerede ønsker (se §15).
- Stationsvisning (TRyeIT-behov senere — ét felt på produktet + "Gruppér efter").
- Where-used som selvstændig visning (kun "bruges i" som undertekst på niveau 4).
- Lead-time offset (sylt skal laves dagen før) — senere.
- Migrering af driftsregnskab og indkøb til de nye delte funktioner.

## 14. Kendte begrænsninger

- **Glutenfri m.fl.:** registreres i dag som `special_request`-tekst + separat linje
  (fx Glutenfri Bolle). Koblingen findes ikke i data, så kost/CO₂/råvarer regner
  stadig med rugbrød til den glutenfri. Overestimat — på den sikre side. Løses med tags.
- Snapshot vs. aktuelle priser mellem niveau 1–3 og 4–5 (§7).

## 15. Senere — tags til særlige ønsker (noteret, ikke v1)

Særlige ønsker skal være strukturerede tags på bonlinjen ved siden af
`special_request`. Et tag som `gf` skal kunne udløse substitution (rugbrød →
glutenfri bolle) og fjerne den separate bollelinje. Event-systemet har allerede
strukturerede varianter ("Tunen – Glutenfri Bolle") og embed-bestillingen sender
`menu_items[]` med tags/allergener — undersøg genbrug derfra før der designes nyt.

## 16. Åbne spørgsmål (afklares før/under implementering)

1. ~~**Råvaregrupper:** er 30-serien Grocy product group eller `ingredient_group`?~~
   ✅ **Afgjort 23.09.2026: varegruppen.** 30-serien er varegrupper i Grocy
   (`CLAUDE_LAGEROPTAELLING.md` §13), og `ingredient_group` på opskriftslinjen er
   reelt ubrugt. Målt på grocy-hq, 684 opskriftslinjer:

   | `ingredient_group` | Linjer |
   |---|---|
   | tom | 498 |
   | `Emballage` + `emballage` | 146 |
   | Dressing · krydderi · Tempty · topping · side dish | 40 |

   Derfor havner næsten alt i "Øvrige" i dag. Varegruppen dækker til gengæld alle
   varer: 11 grupper i brug, plus 61 varer på landingspladsen `Lager varer` som
   30-serien deler op, og 2 varer helt uden gruppe.

   Emballage-reglen er ikke i fare ved skiftet: `services/ingredientResolver.js`
   sammenligner med små bogstaver, så begge stavemåder fanges.
2. ~~**Tjekliste → `prep_ingredients_ready`:**~~ ✅ **Afgjort 25.09: ja, med et tryk** — se §21. skal en gennemgået tjekliste kunne sætte
   *Råvarer ✓* på alle valgte bons på én gang?
3. ~~**Tjekliste-afvigelser:**~~ ✅ **Afgjort 25.09: tast det rigtige tal, lageret rettes og logges** — se §21. når noget ikke er der — kun markering, eller skal det
   kunne føre til lagerkorrektion i Grocy?
4. ~~**Oprunding:** hvor ligger `Math.ceil`-oprundingen bag 🛒 i dag?~~
   ✅ **Backend.** `shortfall_purchase` regnes i `services/ingredientResolver.js`;
   Råvarer-modalen sender blot tallet videre. Intet at flytte.
5. ~~**Priser fra — pr. rolle eller pr. zone?**~~ ✅ **Afgjort 24.09.2026: pr. rolle.**
   Kost og Salg er to rettigheder i den eksisterende rettigheds-matrix
   (`role_permissions_*`, Settings), så serveren afgør det ud fra sessionen.

## 17. Acceptance

- [ ] Samme bonvalg giver samme enheder i niveau 1 som Sammentælling gav før.
- [ ] Sum af `N` på niveau 2 = sum på niveau 1 (for kategorier med enhedstælling).
- [ ] Niveau 4 indeholder ingen købte varer.
- [ ] En boks (fx slider-boks) optræder som sine børn på niveau 2, ikke som boks.
- [ ] Leverede/fakturerede/betalte/afsluttede/aflyste bons er fravalgt som standard;
      admin kan ændre standarden i Settings.
- [ ] Et vundet tilbud tæller aldrig med; et åbent tilbud kan vælges til.
- [ ] Niveau 4 viser de producerede varer (ikke tomt, selvom ingen er nestet), og
      `on_demand`-varer er mærket "laves automatisk ved levering".
- [ ] Niveau 4 og dashboardets "Lav snart" er enige om hvad der skal laves.
- [ ] Enhederne pr. dag = ugeoversigtens enheder for samme bons.
- [ ] 🛒 virker som i Råvarer-modalen i dag (indkøbs-tilstande: se §8).
- [ ] Manglende kostpris vises som `?`, tælles i "N ukendte", indgår ikke i sum.
- [ ] Er Salg/Kost slået fra for brugeren, er tallet ikke i svaret (tjek netværk,
      ikke kun UI) — heller ikke hvis klienten beder om det.
- [ ] Ingen momsberegning i frontend (`grep 1.25` / `/ 1.25` i `shared/planning.js` = 0).
- [ ] Ingen aggregering i frontend (ingen summering af `bon_lines` i `planning.js`).
- [ ] iPad landskab: bonkolonne + 1 drill-kolonne, alle tryk-mål ≥ 44 px.
- [ ] 27": bonkolonne + 3 drill-kolonner.
- [ ] Periodevælger: Uge + ▶ fra uge 38 viser uge 39; "I dag" viser dags dato.

## 18. Byggerækkefølge (afgjort 24. september 2026)

Tre faser, hver testes i drift fra branchen før den næste startes.

| Fase | Indhold | Afhænger af |
|---|---|---|
| **1 — Grundlag** | `POST /planning/tree` med niveau 1–3, `shared/periodPicker.js`, bonkolonne med status-standard fra Settings, Vis-vælger (Antal/Kost/CO₂/Salg) med de to pris-indstillinger. Fjerner client-side aggregering og momsberegningen i frontend. | — |
| **2 — Produktion og råvarer** | Niveau 4 (produktionspolitikken, samme kilde som "Lav snart") og niveau 5 (resolverens status + eksisterende 🛒). | #695 (kostpris koldt 9,4 s) bør være løst, ellers bliver første "Uge" en ventetid |
| **3 — Tjekliste** | Se §9 og åbent spørgsmål 2–3 | Beslutning om optælling vs. egen liste |

Indkøbets nettomangel/tilstande (§8) kommer fra indkøbs-sessionen og kobles på når den
findes — ikke en del af de tre faser.

## 19. Fase 1 — hvad der er bygget (24. september 2026)

Kører **side om side** med den gamle planlægning, så de to kan sammenlignes på samme
data: køkkenet `kitchen/planning-ny.html` (link fra den gamle side), office pillen
**Bons → Planlægning (ny)**. Når den nye er godkendt i drift, overtager den den gamles
plads, og den gamle kode fjernes i en separat PR.

| Del | Fil |
|---|---|
| Træet (niveau 1–3) | `services/planningTree.js` · `POST /api/bons/planning/tree` (`routes/kitchen.js`) |
| Enheder for ekstra-linjer | `db/helpers.js` `unitsForLines()` — samme SQL som `recalcBonTotalUnits` |
| Periodevælger | `shared/periodPicker.js/.css` |
| Frontend | `shared/planning_drill.js/.css`, `office/views/planning-ny.js` |
| Indstillinger | migration 190: `planning_default_statuses` + rettighederne `plan_kost`/`plan_salg` |
| Test | `npm run test:planning-tree` |

**Afvigelser fra §11 der er værd at kende:**
- Svaret er normaliseret: knuderne står én gang i `nodes`, og `levels`/`children` er
  id-lister. En vare står både under sin kategori og i Varer-fanen, og en kilde under
  både vare og ønske — ellers ville svaret sende det samme flere gange.
- `include_sale` findes ikke. Kost/salg afgøres alene af rollens rettigheder (§7).
- En boks' tal (enheder, kost, salg) fordeles på børnene med `splitOre` og nestingens
  `servings` — samme fordeling som e-conomic-udkastet. Summen ændres ikke en øre.
  CO₂ fordeles proportionalt.
- Et udfoldet barn står under sin egen Grocy-kategori (fx `04 Slider`), ikke under
  boksens. Den samlede enhedstal er uændret.
- Salg er efter bonens rabat (`bonDiscount.discountForLine`), og sponsorat/modregning
  (`counts_as_revenue = 0`) giver 0 kr — samme regler som rapporterne.

- **Pr. dag er en tabel** (afgjort 25.09): med knappen slået til vises kun den kolonne
  man står i, som en bred tabel med én kolonne pr. dag + "I alt" (+ den valgte Vis-værdi).
  Kun dage der har noget på (`tree.days`). Bundlinjen er forælderens dagstal, eller
  `totals.units_days` på øverste niveau — intet summeres i browseren.
- **Standardperioden er 10 dage fra i morgen** (afgjort 25.09): planlægger man om
  mandagen, skal hele næste arbejdsuge med — en kalenderuge rækker ikke. Knapperne er
  Dag · 3 dage · 10 dage · Uge · Periode. `periodPicker` forstår `'<N>days'` som
  rullende N dage.
- Status-knapperne har kalenderens udseende (udfyldt/bleg), men 44 px trykflade.

**Enheder mod den gamle sammentælling:** den gamle talte alle kategorier med
(`is_accessory` er aldrig sat), altså også emballage og drikke. Den nye bruger
enhedsreglen (`unit_count_categories`) — samme tal som `bons.total_units`, ugeoversigten
og kapaciteten. Emballage m.fl. vises dæmpet med "tæller ikke som enheder". Det er
derfor forventet at den nye viser færre enheder end den gamle sammentælling.

**Standarder sat af migration 190** (kan ændres i Settings → Rollerettigheder):
admin + office ser kost og salg; kitchen ser kost hvis den gamle "Vis priser i
planlægningsbon" var slået til, aldrig salg; kitchen_personal og delivery ser ingen af dem.

## 20. Fase 2 — niveau 4 og 5 (25. september 2026)

`services/planningProduction.js`, kaldt af træet. Regner intet selv:

| Tal | Kilde |
|---|---|
| Behov, lager, status, batches | `resolveIngredients` — samme som lagertræk og "Lav snart" |
| Hvem laver hvad | `buildProductionPolicy` (#329) |
| Kostpris (aktuel) | `recipeCost.lineUnitCost` — opskriften vinder for producerede varer (#558) |
| CO₂ (aktuel) | `co2Engine.resolveIngredient` (nu eksporteret) |
| "Bruges i" | `collectRecipeNeedsFlat` |
| 🛒-mængde | resolverens `shortfall_purchase` |

- **Niveau 4** = de varer resolveren kalder producerbare. Forud-producerede (`to_stock`)
  står først med status *dækket · kan laves (lav N batch) · mangler · udbytte mangler*;
  dem Bon laver ved levering (`on_demand`) står sidst, mærket "laves ved levering".
  Tryk → råvarerne i de batches der skal laves.
- **Niveau 5**: resolveren stopper ved en produceret vare, så råvarerne til den står ikke
  i råvarelisten af sig selv. Niveau 5 er derfor resolverens behov for bonlinjerne PLUS
  de batches der skal laves. Producerede varer udelades (de står på niveau 4). Grupperet
  efter varegruppe; uden varegruppe og emballage sidst.
- **Tre afsnit** (afgjort 25.09 efter første drifttest — listen var svær at overskue):
  *Skal laves i forvejen* · *Laves ved levering* · *Dækket af lager* (foldet sammen).
  Hovedtallet er **"lav N batches"**; under det "mangler X (behov Y · lager Z)" i samme
  enhed og skala (kg når et tal er over 1000 g), manglende råvarer med rødt, og
  "bruges i N retter" (navnene i tooltip når der er flere end to).
- Siden henter ikke træet igen mens en beregning er i gang — nye SSE-opdateringer venter
  og kører én gang bagefter (kold Grocy-cache gav seks samtidige kald ved start).
- En producent uden erklæret udbytte (#372) regnes ikke ind i niveau 5 — det siges i en
  advarsel frem for at blive gættet.
- Salg findes ikke på 4–5. Pr. dag heller ikke (behovet er samlet for perioden).
- **Rettet i den fælles resolver:** `shortfall_purchase` rundede 1,12 op til 1,13 og
  2,0000000000000004 sække op til 3. Epsilon før `Math.ceil` — gælder også Råvarer-modalen.

Test: `npm run test:planning-tree` (62 + 34, mutations-testet).

## 21. Fase 3 — tjeklisten (25. september 2026)

Fane **6 Tjekliste** i planlægningen, for samme bonvalg og periode. Afgjort 25.09:

| Spørgsmål | Svar |
|---|---|
| Hvilke varer | Råvarer (niveau 5) + de forud-producerede varer fra niveau 4 (`to_stock`). Ikke "laves ved levering" — de laves først når bonen leveres |
| Afvigelse | "passer ikke" → tast det talte tal → Grocy rettes med det samme og logges som optælling |
| Råvarer ✓ | Tilbydes med ét tryk når tjeklisten er afsluttet OG alle råvarer står dækket efter rettelserne |
| Placering | Fane 6; afkrydsninger huskes på tabletten for netop dette grundlag (periode + bons + ekstra) |

**Ingen ny lagerlogik** — tjeklisten kalder optællingens egne endpoints (#673):
- **✓ er der** → `POST /api/stock-counts/:id/lines` med udfald `unchanged` + `LastCheckedAt` (#613).
- **passer ikke** → `POST /api/grocy/stock/:id/inventory` med `count` — Grocy rettes, linjen logges
  først når Grocy tog imod (samme vej som optællingens "Gem og luk").
- **Én optælling pr. Grocy-lokation** (`products.location_id`), oprettet første gang en vare derfra
  tjekkes, lukket (`saved`) når tjeklisten afsluttes eller startes forfra. Den fysiske enhed er varens
  `LastCheckedUnit`, ellers "Tjekliste (planlægning)".
- Tal tastes og vises i **lager-enheden** (den Grocy rettes i); visningsenheden står i parentes når
  den er en anden ("0,6 kg (5 stk)").
- Træet henter serveren igen efter en rettelse, så lagertal og status er friske.

**`PATCH /api/bons/:id/prep`** skriver nu historik (kun felter der skifter, bruger fra sessionen,
valgfri `note`) og sender `bon_updated`. Det gjorde ruten aldrig — heller ikke fra køkkenkortenes
prep-badges, så et flueben hverken kunne ses live på andre skærme eller spores.

Test: `npm run test:planning-tree` (66 + 47).
