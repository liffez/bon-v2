# CLAUDE_PLANLAEGNING_DRILLDOWN.md — Planlægningen som drill-down

> Status: SPEC — klar til implementering
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
| Enhedstælling | `recipe_unit_counts` + `settings.unit_count_categories` | Sammentælling, dashboard, kitchen |
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

## 5. Bonvalg og ekstra (venstre kolonne)

Beholdes fra i dag, redesignet til smal kolonne:
- Status-chips (localStorage-persistens som i dag). TILBUD fra som default.
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
| 4 | Skal laves | underopskrifter: `2,08 kg × Æggesalat` + "bruges i …" + status | råvarer i den | resolver, **kun** underopskrifter |
| 5 | Råvarer | grupper → `6,99 kg × Kartofler` | — | resolver, fladt, grupperet |

Fanerne er direkte indgange — indkøberen går til 5 uden at gå gennem 1–4.

**Udfoldning af bokse (niveau 1–3):** et `recipes_nestings`-barn med `sellable = 1`
er en **vare** (niveau 1–3). Et barn uden `sellable` er et **halvfabrikat** (niveau 4).
`sellable` sidder kun på opskriftsniveau og betyder "kan stå på en bon / sælges".
Bevidst valg: en opskrift der både sælges alene og indgår i en anden vises som vare.

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
- Salg vises kun når office-wrapperen beder om det (`include_sale=1`). Kitchen beder
  ikke. Det er zone, ikke rolle.
- Den eksisterende pris-toggle (`show_prices_in_planning`, 6-kolonne-tabel, faktura-footer)
  **udgår** og erstattes af Vis-vælgeren. Settingen bestemmer fortsat om Salg/DB tilbydes.

**Kendt forskel:** niveau 1–3 bruger bonens snapshot, niveau 4–5 aktuelle priser.
Summen på niveau 3 og 5 kan derfor afvige. Kolonnehovedet på 4–5 skal sige
"aktuelle priser". Det er korrekt adfærd, ikke en fejl.

## 8. Indkøb på niveau 5

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

**Grupper på niveau 5:** i dag grupperes efter Grocy `ingredient_group` med
Emballage sidst, og næsten alt havner i "Øvrige". Nummererede grupper (30-serien,
fx 31 Krydderier) kommer. Hvis grupperne er nummererede, vises tier-hierarkiet
(30 › 31) uden ekstra konfiguration. → se åbent spørgsmål 1.

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
- `sale_ex`/DB returneres kun med `include_sale=true`.
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

1. **Råvaregrupper:** er 30-serien (31 Krydderier …) Grocy **product group** eller
   `ingredient_group` på opskriftspositionerne? Niveau 5 grupperer i dag efter
   `ingredient_group`.
2. **Tjekliste → `prep_ingredients_ready`:** skal en gennemgået tjekliste kunne sætte
   *Råvarer ✓* på alle valgte bons på én gang?
3. **Tjekliste-afvigelser:** når noget ikke er der — kun markering, eller skal det
   kunne føre til lagerkorrektion i Grocy?
4. **Oprunding:** hvor ligger `Math.ceil`-oprundingen bag 🛒 i dag (frontend/backend)?
   Hvis frontend → flyttes til backend-funktionen i §3.

## 17. Acceptance

- [ ] Samme bonvalg giver samme enheder i niveau 1 som Sammentælling gav før.
- [ ] Sum af `N` på niveau 2 = sum på niveau 1 (for kategorier med enhedstælling).
- [ ] Niveau 4 indeholder ingen købte varer.
- [ ] En boks (fx slider-boks) optræder som sine børn på niveau 2, ikke som boks.
- [ ] 🛒 lægger nettomangel i hele købsenheder på — og rækken skifter til "på listen"
      uden genindlæsning af hele siden.
- [ ] Efter 🛒 viser et nyt kald samme vare som "på listen", ikke "mangler".
- [ ] Manglende kostpris vises som `?`, tælles i "N ukendte", indgår ikke i sum.
- [ ] Kitchen-zonen modtager ingen `sale_ex` i svaret (tjek netværk, ikke kun UI).
- [ ] Ingen momsberegning i frontend (`grep 1.25` / `/ 1.25` i `shared/planning.js` = 0).
- [ ] Ingen aggregering i frontend (ingen summering af `bon_lines` i `planning.js`).
- [ ] iPad landskab: bonkolonne + 1 drill-kolonne, alle tryk-mål ≥ 44 px.
- [ ] 27": bonkolonne + 3 drill-kolonner.
- [ ] Periodevælger: Uge + ▶ fra uge 38 viser uge 39; "I dag" viser dags dato.
