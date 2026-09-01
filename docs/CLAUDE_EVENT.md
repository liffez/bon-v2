# CLAUDE_EVENT.md — Event-modul (let event: alt fra HQ)

> Læs FØR kode: `CLAUDE.md`, `BON_V2_PRINCIPPER.md` (moms-doktrin §6b+6c), `bon_v2_datamodel_v2.md`.
> Relaterede docs: `CLAUDE_PRODUKTION_MVP.md` (produktionsbon/batch), festival-spec-sættet (multi-lokation).
>
> **Afgrænsning:** Dette er den **lette event-model** — flerdags-event hvor *alt hentes fra HQ og intet købes
> ind på pladsen*. Festival (lokalt indkøb → sporet event-lager i egen Grocy) er en separat, allerede specet model.
> Et per-event-valg (`events.model`) afgør hvilken.
>
> **STATUS: IMPLEMENTERET (jun 2026).** Hele livscyklussen er bygget og verificeret end-to-end:
> events-CRUD + generator (prep/topup/salg/udgift) · §5 no-deduct-gate (Vej B) · §6 forecast pr. kategori,
> editbar pakkeliste m/buffer-override, retur til HQ, top-up-måltal · §7 P&L + CO₂-eksklusion. Se §14 for
> den faktiske implementering (filer, migrationer, afvigelser fra denne spec).

---

## 1. Problem (én sætning)

Vi tager ud til et flerdags-event, gætter på salget, prepper i køkkenet og pakker en kasse med varer + lidt
buffer; på pladsen sælges menuer (POS); der er lidt spild; resten køres hjem på HQ-lager — eller vi henter
mere ind til næste dag. Det skal kunne styres uden dobbelt lagertræk og uden en ekstra Grocy-installation.

---

## 2. Kerne-indsigt: skillelinjen er *lokalt indkøb*, ikke logistik

| | Indkøb | Event-lager | Model |
|---|--------|-----------|-------|
| Festival | Kan ske på pladsen | Eksternt input → **skal spores** (egen Grocy) | festival-spec |
| **Let event** | Kun til HQ | Fuldt bestemt af HQ-bevægelser → **implicit, beregnes** | **denne spec** |

Et lokalt indkøb bryder beregneligheden. Uden det er eventet bare en midlertidig forlængelse af HQ:
HQ forbliver korrekt så længe hver fysisk bevægelse (ud via prep/top-up, hjem via retur) logges, og
event-beholdningen ser man fysisk. **Event = festival minus den anden Grocy.**

Event-viewet er en **generator/orkestrator**, ikke bare en visning: det opretter bonnerne og binder dem
med `event_id`. "Magien" er en foreign key + en query — intet andet.

---

## 3. Fire roller, bundet af `event_id`

| Rolle | Genereres som | Lagertræk | Økonomi |
|-------|---------------|-----------|---------|
| Prep / pakkeliste | Produktionsbon (`price_category='produktion'`) | **Træk HQ** ved LEVERET | 0 kr (0-pris) |
| Top-up | Opfølgende produktionsbon | **Træk HQ** | 0 kr |
| Dagssalg | Salgsbon (`price_category='festival'`) → **LEVERET** (kontant/faktura), **event-scoped no-deduct** | Intet | Omsætning |
| Udgifter (fee, benzin, bro) | Negative `bon_lines` | Intet | Omkostning |
| Retur / hjemkomst | Varemodtagelse til HQ | **Tilbageførsel** | — |

Prep-bonnerne ejer lagertrækket. Alt andet i eventet rører ikke HQ-lageret undtagen returen.

**Flere prep-bons pr. event (migration 101):** Et flerdags-event kan have én prep-bon pr. dag
(køkkenet prepper løbende afhængigt af hvordan eventet er sat sammen). Rollen persisteres på
`bons.event_role` ved generering — generatorens valg (prep/topup/sales/expense) er autoritativt.
Bons fra før migrationen (event_role IS NULL) klassificeres med fallback-heuristik: første
produktionsbon pr. `delivery_date` = prep, efterfølgende samme dag = top-up. Prep og top-up
opfører sig i øvrigt identisk (HQ-træk, pakkeliste, packing-overrides, vareforbrug i P&L) —
forskellen er ren betydning: prep = planlagt pakning, top-up = opfølgende indhentning.

**FVST-sporbarhed:** prep-/top-up-bonnerne er samtidig logbogen over hvad der fysisk forlod huset
(hvad, hvornår via LEVERET-timestamp, evt. batch/temp). Returen er en varemodtagelse. Begge ender er
dermed FVST-dokumenteret — en selvstændig grund til at load-out skal være en bon, ikke bare en seddel.

---

## 4. Flow (event-viewet som generator)

```
1. Forecast (forventede menuer + buffer-råvarer)
     → generér PREP-produktionsbon (price_category='produktion')
     → køkkenet prepper efter den · pakkeliste = linjerne (evt. eksploderet til råvarer)
2. (valgfrit, dag 2+) generér OPFØLGENDE prep-bon for det der hentes ind  → trækker HQ
     forslag = forecast_dag_N − rest_på_eventet (§6)
3. På pladsen: generér/knyt SALGSBONNER (→ LEVERET, kontant/faktura)  → omsætning, intet træk (gated §5)
4. Udgifter: negativ-linje-bon  → omkostning
5. Hjemkomst: generér RETUR-FORSLAG → varemodtagelse til HQ
```

---

## 5. Den ene nye regel: event-scoped no-deduct (blokerende)

**Flaskehals-princip (verificeret i status_transitions):** `LEVERET` er det eneste punkt hvor lagertræk
besluttes. Ingen bon når en betalt/faktureret slut-status uden at passere LEVERET først —
`FAKTURERET` kommer kun fra LEVERET; `BETALT` kun fra LEVERET eller FAKTURERET; **ingen vej til BETALT
springer LEVERET over.** `autoConsumeBonInventory(id)` kaldes på `status_code === 'LEVERET'`
([routes/bons.js](../routes/bons.js)) **uafhængigt af betalingstype**. Derfor er betalingstype (kontant/faktura)
og slut-status irrelevante for lageret — trækket (eller no-deduct-skippet) afgøres én gang, i flaskehalsen,
*før* betalings-splittet. `consumeRecipes()` er rent opskriftsbaseret og uafhængig af priskategori.

Da POS/salg generelt *skal* kunne trække, kan no-deduct ikke hænges på status. Den hænges på
**event-medlemskab + model**:

> I `autoConsumeBonInventory(bonId)`: slå `event_id`, `events.model` og priskategori-kode op
> (`price_categories.code` via FK — **ikke** den stale `bons.price_category`-TEXT-kolonne). Hvis
> `event_id` er sat **og** `events.model = 'light'` **og** `price_category_code !== 'produktion'`
> → spring lagertrækket over. Sæt `inventory_deducted = 1` med grund `'event_prep_owns_stock'` så
> idempotens-vagten og changelog er entydige.

Hvorfor `model='light'`: en **festival**-event har et sporet lokalt lager (egen Grocy-lokation) og salget
SKAL trække — fra festival-lokationen, når den model bygges. Den må derfor *ikke* gates. Kun den lette model
(intet lokalt lager) springer over. Prep-/top-up-bonnerne (`price_category='produktion'`) trækker altid.
Alt uden `event_id` trækker normalt (butikssalg → HQ). Bruger udelukkende eksisterende felter + `events.model`.

**Fremtid — Zettle/POS (ikke sat op endnu, HUSK ved opsætning):** POS skal *som standard* kunne trække
(butikssalg → HQ; festival-salg → festival-lokation). Kun den lette event-model gater. Det stiller to krav
til Zettle-integrationen når den bygges:
> 1. En POS-salgsbon skal **routes gennem LEVERET** (ikke springe direkte til BETALT) — ellers omgår den
>    flaskehalsen og trækker aldrig. (Ingen sådan genvej findes i dag.)
> 2. En POS-salgsbon skal **tagges med event-kontekst** (`event_id` sat for event-salg) så gaten kan se
>    `model` — ellers behandles den som butikssalg og trækker fra HQ.

---

## 6. Event-beholdning (beregnet) + de to forslag — top-up & retur  ✅ implementeret

Eventet har intet sporet lager, men event-viewet **beregner** en løbende rest af de loggede bevægelser
(ingen ekstra Grocy). Samme beregning driver både top-up- og retur-forslaget:

```
rest_på_eventet (pr. råvare) = (prep + top-ups)  −  solgt (eksploderet via Grocy-BOM)  −  spild

top-up-forslag (morgen dag N) = forecast_dag_N (eksploderet)  −  rest_på_eventet
retur-forslag  (hjemkomst)    = rest_på_eventet
```

- Prep, top-up og salg er alle i menuer/opskrifter → eksplodér til råvarer via samme BOM som `consumeRecipes`.
- Spild indtastes (evt. som `waiste`-priskategori-linjer eller frit felt).
- Begge forslag er **forudfyldte og frit justerbare**: top-up'en redigeres før den hentes, returen før den bogføres.
- Retur bogføres som varemodtagelse mod HQ; QU-actuals indtastes i display-enhed → konvertér server-side før
  Grocy-add (samme klasse som F13/28%-bug'en).

**Top-up-forslag — implementeret (jun 2026):** `computeTopupSuggestion(event, date)` i
`routes/events.js` + `GET /api/events/:id/topup-suggestion?date=`. Beregner på TO niveauer:

- **Datofiltre:** produktion (prep+topup) med `delivery_date ≤ dato` = "er på pladsen";
  salg med `delivery_date < dato` = "solgt indtil i morges" (dagens salg er ikke sket endnu).
  En allerede oprettet topup-bon på dagen reducerer dermed forslaget (idempotent-agtigt).
- **Kategori/produkt-niveau:** `rest = prepped − solgt` pr. kategori, `forslag = max(0, forecast − rest)`.
  Forecasten er pr. KATEGORI — forslaget fordeles pro-rata på de produkter der faktisk er preppet
  i kategorien (largest-remainder-afrunding via `allocateInteger`). Forecast-kategori uden prep-mix
  → warning ("vælg selv produkter").
- **Råvare-niveau:** `behov = BOM(allokerede produkter)` mod `rest_råvare = BOM(produktion m/pakke-
  overrides) − BOM(salg)` → **fetch** ("hent mere fra HQ") og **surplus** ("rigeligt på pladsen —
  behøver ikke hentes"). Degraderer gracefully til kun kategori-niveau hvis Grocy er nede
  (kategori-delen er ren SQL).
- **Antagelses-ærlighed:** resten er et GÆT ud fra registrerede salgsbons ("vi er trætte om
  aftenen" — salget er ikke altid tastet). `sales_bon_count` sendes med; UI'en viser antagelsen
  eksplicit (⚠-banner ved 0 salgsbons) og alt er frit justerbart.
- **UI:** "+ Top-up"-modalen (office events-view) pre-fylder linjerne med de allokerede produkter,
  viser kategori-tabel (Forecast/Preppet/Solgt/Rest/Forslag) + foldbart råvare-tjek. Default-dato =
  i dag hvis midt i eventet (lokal dato, ikke `toISOString` — UTC-buggen). Dato-skift genberegner
  og erstatter linjerne.
- **Test:** `scripts/test-topup-suggestion.js` (35 asserts — mockede Grocy/BOM-kald, ægte helper).

---

## 7. Event-P&L + CO₂  ✅ implementeret

- **P&L** = Σ salgsbon-omsætning − vareforbrug (kostpris ex moms) − udgiftsbon. Alt ex moms (moms-doktrin).
- **Udgiftsbon** tagges som omkostning — må **ikke** nette mod omsætning (ellers falder omsætningstallet).
- **Udgifts-moms pr. linje:** udgiftslinjer er ikke altid incl moms — et Grocy-produkt brugt som
  udgift har kostpris ex moms, og en service-fee er momsfri. `bon_lines.moms_included` (migration 104)
  markerer pr. linje om beløbet er incl (1) eller ex (0) moms. `computeEventExpenses` summerer
  udgiftslinjer og konverterer incl→ex via `inclToExcl` (kun for `moms_included=1`), så P&L'en
  forbliver ex moms uanset hvordan beløbet er tastet. Generator-modalen har en moms-vælger pr.
  udgiftslinje (default **uden moms**, fremhævet amber) + Grocy-picker. Grocy-valget fylder **kun
  linjenavnet** (udgifts-menuer i Grocy tiltænkt at dække ekstra udgifter) — beløb tastes manuelt og
  moms vælges pr. linje; recipe-id/kategori/cost/co2e kobles bevidst IKKE på, så udgiften ikke tæller
  som enheder eller bærer menuens CO₂ ind i event-footprintet.
  P&L-strippens udgifts-celle er mærket **"Udgifter (ex moms)"**.
- **Udeluk produktion fra event-tal:** omsætning selv-udelukkes via 0-pris (prep/topup = 0 kr).
  **CO₂ er ikke pris-gated** → event-CO₂ ekskluderer `price_category='produktion'` EKSPLICIT, ellers
  tælles prep-footprintet dobbelt (co2e ligger på både prep- og salgsbons fra samme opskrifter).
- Implementering: `computeEventPnL` + `computeEventCost` + `computeEventCO2` i `routes/events.js`.
  P&L-strip har 6 celler: omsætning incl/ex, vareforbrug, udgifter, resultat, 🌱 CO₂e.
  Verificeret: prep 4 + salg 3 af co2e=2.49-vare → event-CO₂ = 7.47 (kun salg), ikke 17.43.

---

## 8. Datamodel — migration `095_events.sql` (næste ledige nummer, verificeret)

```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),   -- HQ for let event
  model TEXT NOT NULL DEFAULT 'light'
    CHECK (model IN ('light','festival')),                 -- per-event-gaten
  start_date DATE NOT NULL,
  end_date DATE,
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning','active','done','cancelled')),
  notes TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE bons ADD COLUMN event_id INTEGER REFERENCES events(id);
CREATE INDEX idx_bons_event ON bons(event_id);
```

Migrationer genkøres aldrig. `event_id` er nullable — eksisterende bons uberørte.

---

## 9. UI — event-modul i Office-sidebaren

- Ny sidebar-sektion **Events** (gruppe *Drift*), med pills: `Overblik · Pakkeliste · Salg pr. dag · Retur & afstemning · Økonomi`.
- **Overblik:** event-header (model-badge let/festival, datoer, status) · P&L-strip · de fire roller som kort
  (genbrug `bon_kort` + `.bon-production`/🔧) · retur-tabel.
- **Generator-knapper:** "Generér prep-bon (fra forecast)", "Generér top-up-bon (fra dag-N forecast)", "Opret salgsbon", "Lav retur-forslag".
- Identitet altid fra `req.session.userId` ved generering — aldrig fra request body.
- Mockup: `event_overblik_mockup.html` (godkendt af Leif).

---

## 10. Genbruger / Nyt

**Genbruger (intet nyt):** produktionsbon (`price_category='produktion'` fra Grocy-userfield `SalespriceProduktion`),
LEVERET→consume-vej, `consumeRecipes`/`autoConsumeBonInventory`, varemodtagelse, negative linjer som omkostning.

**Nyt at bygge:** `events`-tabel + `event_id` på bons · event-view + generator-endpoints · no-deduct-gate (§5)
· beregnet `rest_på_eventet` der driver **både** top-up- og retur-forslag (§6) · CO₂-eksklusion af produktion
i event-tal (§7).

---

## 11. Go-live-blokkere — verificeret mod prod-DB (`scripts/verify-event-prereqs.js`)

Read-only forudsætnings-script kørt mod prod 6. jun 2026. Resultat:

1. 🔴 **`inventory_auto_deduct = '0'` på prod** — auto-lagertræk har **aldrig** kørt i drift. Dette er den
   ene reelle blokker, og det er en **forretningsbeslutning** (ikke en flip): tændes det globale flag,
   begynder ALLE LEVERET-bons i hele forretningen at trække fra Grocy. To veje (åben beslutning):
   - **Vej A** — tænd flaget `'1'`: prep-bonnen trækker via den normale LEVERET-sti, men hele forretningen
     begynder at trække. Kræver at Grocy-lageret er præcist nok.
   - **Vej B** — lad flaget stå `'0'`: event-modulet trækker KUN sine egne prep/top-up-bons eksplicit
     (dedikeret consume-sti, uafhængig af flaget). Resten af forretningen uberørt. Mest isoleret.
2. 🟢 **deduct-sti verificeret** — `autoConsumeBonInventory` kaldes på LEVERET (uafhængigt af betaling).
   Flaskehals-princippet (§5) bekræftet: ingen vej til BETALT springer LEVERET over. Gaten hænges præcist.
3. 🟢 **`produktion`-priskategori findes** (prod: `id=4`, aktiv). Generatoren kan oprette prep-bon ved at
   sætte `price_category_id` = produktion-rækken + snapshotte Grocy-priser (`SalespriceProduktion`=0 + kostpris).
4. 🟡 **price_category-dualitet** — prod har 49 bons hvor `bons.price_category`-TEXT ≠ FK→code. Gaten SKAL
   bruge `price_categories.code` (join), ikke TEXT-kolonnen. (Indbygget i §5-gaten.)

R1 (ingen dobbelttælling), R6 (QU-konvertering i retur), §5 (no-deduct-gate) skal være grønne før go-live.

**Beslutning truffet: Vej B.** Event-modulet ejer sit eget træk uafhængigt af det globale flag (forbliver `'0'`).
Resten af forretningen er uberørt. Idempotens-vagten fanger en evt. senere Vej A-flip (intet dobbelttræk).
Read-only forudsætnings-script: `scripts/verify-event-prereqs.js`.

---

## 12. Byggerækkefølge

1. Migration `095_events.sql` + `event_id` på bons. ✅ skrevet (verificeret: migration kører rent på prod-kopi).
2. No-deduct-gate i `autoConsumeBonInventory` (§5) ✅ skrevet (event_id + `model='light'` + ikke-produktion,
   FK→code). Unit-test der REQUIRER at en let-event-salgsbon **routet gennem LEVERET** ikke trækker —
   (testen skal forcere `inventory_auto_deduct='1'` i isoleret test-DB for at ramme deduct-stien).
3. Event-route + generator-endpoints (prep / top-up / salg) — server-side, changelog, SSE. ✅
4. Retur-forslags-query (§6). ✅ (varemodtagelses-*registrering* af returen udestår — pt. ren Grocy stock-add).
5. Event-view i office (mount efter mockup) + P&L/CO₂-eksklusion (§7). ✅

**Alle trin implementeret + verificeret end-to-end (jun 2026). Se §14.**

---

## 13. CLAUDE.md — opdatering (skal gøres ved merge)

Tilføj til `CLAUDE.md`:
- Pointer under spec-oversigten: `CLAUDE_EVENT.md — let event-model (alt fra HQ), generator + no-deduct + retur`.
- Filstruktur: `routes/events.js`, `office/views/events.{js,css}`.
- Note ved festival-spec'en: let event og festival deler mental model; skilles ad på `events.model` (light/festival).

---

## 14. Faktisk implementering (jun 2026)

**Migrationer:** `095_events.sql` (events + bons.event_id) · `096_event_forecast.sql` (forecast pr. dato+kategori)
· `097_prep_packing_overrides.sql` (manuelle pakke-justeringer pr. bon+produkt).

**Filer:**
- `routes/events.js` — CRUD + `/:id/overview` (bons, P&L, CO₂, forecast, days, categories, prepped) +
  `/:id/bons` (generator: prep/topup/salg/udgift) + `/:id/forecast` (PUT reconcile) +
  `/:id/return-suggestion` + `/:id/return` (addToStock til HQ) +
  `/:id/topup-suggestion?date=` (§6: forecast − beregnet rest, kategori- + råvare-niveau).
- `db/helpers.js` — `autoConsumeBonInventory` (§5-gate + Vej B-override) + `getPrepPackingOverrides`.
- `services/grocyAdapter.js` — `consumeRecipes(lines, overrides)` (override erstatter beregnet mængde).
- `routes/bons.js` — `GET/PUT /:id/packing` (pakke-overrides, låst efter LEVERET).
- `office/views/events.{js,css}` — liste + detalje (P&L-strip, forecast-tabel, generator-modal m/måltal,
  rolle-sektioner, retur-sektion).
- `shared/modal.js` — pakkeliste-modal (råvarer/produktionsmål-toggle, editbare buffer-mængder).
- `shared/bon_kort_builder.js` + `shared/utils.js` — event-badge 🎪 + pakkeliste-knap (kun event-prep).
- `routes/kitchen.js` — joiner events for event_name/_model på /today + /later.

**Afvigelser fra spec (design-opdatering m. Leif 2026-06-06):**
- **Forecast er i færdig-produkt-enheder** (80 sandwich), ikke råvarer — sandwich laves on-the-spot på
  pladsen. Pakkelisten eksploderer til råvarer (det fysiske pakkearbejde). `rest_på_eventet` (§6) beregnes
  i råvare-enheder, fordi det er det man fysisk kan tælle på pladsen.
- **Editbar pakkeliste m/buffer:** køkkenet kan justere de pakkede råvare-mængder ("tag hele brødposen").
  Den OVERRIDEDE mængde trækkes fra HQ ved LEVERET (forretnings-sand). Buffer kommer hjem i returen.
- **Top-up = preppe videre mod forecast:** generator-måltal viser allerede-prepped (baseline) + det man
  tilføjer, pr. kategori pr. dag.
- **Retur parent-redirect:** Grocy-parents (no_own_stock=1, fx kål) kan ikke modtage lager → returen
  omdirigeres til det barn der har mest lager (Hvidkål/Spidskål).
- **Bon-kort:** produktionsbons (inkl. event-prep) får blå venstre-stribe (status-::before overstyret).
- **Salgs-pris = festival, ikke catering (Leif, 2026-06-13):** event-/festivalsalg sælges til
  festival-pris. Salgs-/udgiftsbonner defaulter til `price_category='festival'` (POST `/:id/bons`),
  og salgs-modalens prisopslag (`priceMode`) + pre-fill bruger `prices.festival`. §5-gaten er uberørt
  (festival ≠ produktion → stadig no-deduct på light-model).
- **Salgs-bon pre-fill (2026-06-13):** "+ Salgsbon" pre-udfylder linjerne fra eventets **prep-bonner**
  (kun prep-rollen, ikke top-up — union på tværs af eventet, summeret pr. produkt). Vi sælger hele
  menuer, ikke pakkelistens råvarer, så kilden er prep-bonnernes `bon_lines` (færdig-produkt-niveau).
  Antal = preppet (start-gæt, justeres NED for spild/smagsprøver). Pris = festival fra Grocy.
  Endpoint: `GET /api/events/:id/sales-prefill`. Frontend fylder via eksisterende `addLine`.

- **Top-up-forslag (2026-06-13):** "+ Top-up" pre-udfylder fra `GET /api/events/:id/topup-suggestion?date=`
  — se §6 for formler, datofiltre, pro-rata-allokering og graceful Grocy-degradering.

**Tests:** `scripts/test-event-gate.js` (15) + `scripts/test-prep-packing.js` (12 — override + extras) +
`scripts/test-recipe-factor.js` (8 — underopskrift-skalering) +
`scripts/test-sales-prefill.js` (7 — prep-only union + festival-pris) +
`scripts/test-topup-suggestion.js` (35 — §6 top-up: kategori-math, datofiltre, allokering, råvare-fetch/surplus, degradering) +
`scripts/verify-event-prereqs.js` (read-only prod-forudsætningstjek).

**Endnu ikke bygget:** varemodtagelses-*registrering* af returen (returen er pt. en ren Grocy stock-add,
ikke en `goods_receipts`-post). Spild som eksplicit felt (pt. implicit = forslag − faktisk talt).

### 14b. Pakkeliste v2 — produktions-niveau + buffer-mekanismer (jun 2026)

Driftsfeedback: råvare-niveauet eksploderede dressinger/Frisk Grønt til salt, peber,
tahini osv. — men de blandes færdige hjemmefra. Pakkelisten viser nu **produktions-
niveau**: direkte varer + underopskrifter som ét færdigt item (ikke eksploderet).

**Tre buffer-mekanismer** (alle forretnings-sande — trækkes fra HQ ved LEVERET):
1. **override** (`097_prep_packing_overrides`, pr. produkt): ERSTATTER en direkte vares
   mængde. Buffer-in-place på fx Brød Rug.
2. **extra** (`102_prep_packing_extras`, pr. produkt): LÆGGER en konkret vare OVENI
   opskrifterne (fx 1 kg ekstra mayonnaise ved siden af). "➕ Tag ekstra med"-vælger.
3. **recipe-factor** (`103_prep_packing_recipe_overrides`, pr. underopskrift): SKALERER
   en underopskrifts råvarer proportionalt. Justeres Frisk Grønt fra 13,63→16 kg, gemmes
   `factor = 16/13,63`; ved LEVERET ganges faktoren på underopskriftens råvare-multiplier
   i `resolveConsumeItems` (kål, spinat … skaleres tilsvarende).

**Read-only forhåndsvisning** (`GET /:id/packing/consume-preview` → `grocyAdapter.planConsume`):
viser PRÆCIS hvad LEVERET ville trække fra HQ (komponenter + overrides + extras + recipe-
faktorer) uden at røre lageret — så drift kan verificere før de trykker. Consume-logikken er
udtrukket til delte helpers (`applyPackingAdjustments` + `makeEffectiveStock`) som BÅDE det
rigtige `consumeRecipes` OG preview'en bruger → garanteret match.

**Filer (udover §14):** `services/ingredientResolver.js` (`resolveConsumeItems(lines, recipeFactors)`
+ `weight_grams` på production sub_recipes) · `grocyAdapter.js` (`planConsume`, delte helpers,
`consumeRecipes(lines, overrides, extras, recipeFactors)`) · `db/helpers.js` (`getPrepPackingExtras`,
`getPrepPackingRecipeFactors`) · `routes/bons.js` (packing GET/PUT m. extras+recipe_overrides +
consume-preview) · `shared/modal.{js,css}` (produktions-niveau pakkeliste, "tag ekstra med",
redigerbare underopskrifter, preview-tabel).

**Tests:** `scripts/test-recipe-factor.js` (8 — faktor-skalering i resolveren: ×1,5 på Frisk Grønt,
rekursion ned i nestet dressing, uafhængige/komponerende faktorer) + `scripts/test-prep-packing.js`
udvidet til 12 (S6–S9: extras adderer/ny vare/override+extra/ugyldige). Browser-verificeret end-to-end +
backend-roundtrip (overrides/extras/recipe_overrides). Live Grocy-skalering verificeres via preview på grocytest.

*Grundlag: design-session m. Leif (jun 2026) + kodeverifikation: grocyAdapter.js, routes/grocy.js, bon_kort_builder.js, reports.js, bon_v2_datamodel_v2.md. Implementeret + verificeret end-to-end jun 2026.*

---

## 15. Prep-kapacitet — rå prep-tider + låst design (juli 2026, IKKE bygget)

> Kom op i forlængelse af Smartplan-lokations-splittet (HQ vs Festival & Events).
> Rå data fra Leif — **omtrentlige, admin-justerbare tal**, ikke facit. Skrevet ned så
> de ikke går tabt. Modellen er **ikke bygget** — det er design-noter til et senere spor.

### 15.1 Kerne-indsigt: prep har TO former
En enkelt "prep-faktor" på enhederne holder ikke, fordi prep-arbejde deler sig i:

- **Per-enhed** (skalerer med festivalstørrelse) — dobbelt så stor festival ≈ dobbelt tid.
- **Per-batch** (fast tid, ~uafhængig af mængde) — sylt/dressing tager det samme uanset 1.000 eller 3.000 enheder.

Ærlig model-form: `prep-timer = Σ(enheder × min/enhed) + Σ(faste batch-timer)`.

### 15.2 Rå prep-tider (Leif, juli 2026 — ca.-tal, skal kunne justeres af Admin)

**Per-enhed:**

| Opgave | Rate | ≈ pr. enhed | ≈ pr. time |
|--------|------|-------------|------------|
| Skære sandwich-brød | 1 kasse = 64 emner / 15 min | ~14 sek | ~256 |
| Skære slider-brød | 1 kasse = **128 slidere** (halv størrelse, samme kasse brød) / 40 min | ~19 sek | ~192 |
| Skære frikadeller / fiskefrikadeller | 100 stk / 15 min | ~9 sek | ~400 |

**Per-batch (fast tid):**

| Opgave | Tid | Note |
|--------|-----|------|
| Sylt | ~2 t **pr. slags** · typisk 3 slags → ~6 t | ~uafhængig af festivalstørrelse |
| Blande dressing / mayonnaise | 10 min pr. 2 kg | (semi-per-enhed på kg, men små tal) |
| Skære kartofler | ~15 min (Leif, juli 2026) | ⚠️ **enhed uafklaret** — se note |
| Snitte purløg | ~10 min (Leif, juli 2026) | ⚠️ **enhed uafklaret** — se note |

> ⚠️ **Kartofler + purløg — enhed skal verificeres ved kalibrering.** Leif gav tallene
> som bare "ca. 15 min" / "ca. 10 min" uden enhed. Prototypen antog oprindeligt kartofler
> *pr. kg*, men 15 min pr. kg ville være urealistisk stort for et event → tolket her som
> **faste batch-tider** (som sylt: én kort opgave uanset mængde). Behandles derfor som
> per-batch indtil køkkenet bekræfter om det skalerer med mængden. Det er præcis den slags
> "blødt tal uden enhed" der bliver en skjult fejl hvis den ikke flagges — derfor står den her.

**Holdbarhed / kan laves i forvejen:**
- Skåret brød: kan **fryses**.
- Frikadeller: kan **fryses**.
- Sylt: holder ~**1 måned**.
- **Caveat:** "kan laves langt i forvejen" betyder IKKE at det *gøres* en måned før. Timingen
  er elastisk, ikke fast — derfor passer prep dårligt ind i en *daglig* kapacitets-ratio.

### 15.3 Besluttet retning (design-session Leif, juli 2026)

1. **Smartplan er sandhed** for hvem der er på HQ vs. festival (én vagt = én lokation; vi
   splitter ikke timer inden i en vagt). ✅ implementeret som lokations-split.
2. **Ingen ratio på festival-bemanding** — festival er salg/service, ikke HQ-produktion.
   En rigtig festival-kapacitet kræver ordre-fordeling pr. time, som vi kun får fra eget
   POS (Zettle). ✅ implementeret (festival vist adskilt, ingen ratio).
3. **Prep hører til som time-budget på EVENTET** (pulje af timer med deadline "klar til
   samling"), ikke en daglig enh/persontime-ratio. Admin-justerbar hele vejen, seedet fra
   prep-tider pr. opskrift (min/enhed + fast batch-tid). **Ikke bygget.**
4. **Ugeoversigt / dags-ratio:** kun **event-prep-bons** (`event_id` + `event_role='prep'`)
   skal ud af dags-ratioen — automatisk efter type, **intet per-bon flag**. Almindelige
   HQ-bons tæller som før (ægte samme-dags-belastning). Flaget eftermonteres kun hvis en
   *ægte* ikke-event flerdages-undtagelse dukker op. **Ikke bygget** (latent: rammer først
   når en HQ-vagt falder samme dag som en event-prep-bon; i testdata var prep-dagene ubemandede).

   **NB — nuværende adfærd (verificeret i `db/helpers.js`):** `countsAsWorkload` ekskluderer
   KUN `WORKLOAD_EXCLUDED_EVENT_ROLES = ['sales','expense']`. **`prep` + `topup` TÆLLER MED**
   som produktions-workload i dag (bevidst: salget er ekskluderet fordi det "allerede er talt
   i prep-bonnen"). Så en event-prep-bon lander med sit fulde enheds-tal på sin `delivery_date`
   (fx B4100 = 2250 enh på 08.07 i PROD-rækken). At trække prep ud af *dags-ratioen* uden
   spredt time-budget ville få festival-produktionen til at forsvinde helt fra kapaciteten —
   "misvisende rød" byttet til "misvisende tom". Derfor: gør det som time-budget (punkt 3),
   ikke som en simpel eksklusion.

### 15.4 Besluttet design — klar til byg (design-session Leif, 19. juli 2026)

De tre huller fra 15.3 er nu lukket. Modellen er stadig **ikke bygget**, men designet er
låst — nedenstående er hvad der skal implementeres, ikke længere åbne spørgsmål.

**Kerne-beslutning: modellen kan ikke være rent kategori-baseret.** Prototype-kørsel
(`scripts/prep-estimate.js`) på et mellemstort event (500 sandwich · 300 slider · 400
frikadeller · 3 slags sylt) gav ~11 t, fordelt:

| Del | Timer | Kilde |
|-----|-------|-------|
| Brød-skæring (per-enhed) | 3,5 t | forecast-kategorien direkte |
| Frikadeller | 1,0 t | komponent, manuel |
| Sylt + dressing (batch) | 6,7 t | batch, manuel |

**Kun ~⅓ af prep-tiden kommer fra forecast-kategorierne.** Sylt/dressing/frikadeller mapper
ikke til "01 Sandwich / 02 Salat" og skalerer ikke med forecasten. En ren "min/enhed pr.
kategori"-model ville derfor være blind for ⅔ af arbejdet.

**1. Datakilde: indtast batch pr. event (Vej 1), IKKE opskrift-BOM (Vej 2).** Vej 2
(prep-tider pr. opskrift + BOM-eksplosion af forecasten) er mere præcis og selvvedligeholdende,
men markant mere at bygge og kræver en prep-tid pr. opskrift. Valgt Vej 1 for at komme i drift
— men Leif flaggede eksplicit: **manuel indtastning der starter tomt bliver ikke brugt.** Derfor:

**2. Friktionen løses med forudfyldning (afgørende — ikke valgfrit pynt).** Feltet må aldrig
starte tomt. Samme mønster som top-up, salgs-prefill og event-menuen (§16): systemet gætter
kvalificeret, brugeren retter kun ved afvigelse. To lag:
   - **Per-enhed (brød): auto-beregnet fra forecasten.** Nul indtastning. Retter man forecasten,
     følger prep-tiden med.
   - **Batch (sylt/dressing/frikadeller/kartofler/purløg): forudfyldt fra admin-settings**,
     justerbart pr. event. Laver man ikke sylt denne gang → sæt til 0.

   I den normale hverdag åbner man eventet, ser "≈ N timers prep" stå færdigt, og gør intet.

**3. Rater bor i admin-settings — ikke hardkodet, ikke (endnu) Grocy-userfields.** Leif: "helst
ikke noget hardkodet." Settings-tabellen (som `production_start_time` + kapacitets-tærsklerne).
Køkkenet sætter deres typiske sylt/dressing-mønster + raterne én gang; hvert event arver dem.
Grocy-userfield-vejen holdes åben hvis prep-tider senere skal bo pr. opskrift (Vej 2).

**4. Prep-vindue: felt pr. event**, forudfyldt med en default (event `start_date` minus N dage
fra en setting). Fleksibelt nok til at sylt kan laves en uge før mens salat kun dagen før —
uden at låse én global regel. "Preppes der *under* eventet (rullende)?" er ikke afgjort, men
blokerer ikke: et felt pr. event kan rumme det senere.

**5. Ugeoversigt (uændret fra 15.3 pkt. 4):** kun event-prep-bons (`event_id` +
`event_role='prep'`) ud af *dags*-ratioen — automatisk efter type, intet per-bon flag. Prep
vises i stedet som time-budget på eventet (budget vs. bemandede event-prep-timer fra Smartplans
Festival & Events-lokation). At trække prep ud *uden* budgettet ville bytte "misvisende rød"
til "misvisende tom" — så de to dele skal bygges sammen.

**Stadig ikke afklaret (blokerer ikke byg):**
- Kartoffel- + purløgs-enhed (batch vs. pr. kg) — verificeres ved kalibrering, se note i 15.2.
- Rullende prep *under* eventet — feltet pr. event kan rumme det når behovet opstår.

*Grundlag: to design-sessioner m. Leif (juli 2026), efter Smartplan-lokations-split. Rå tal +
låst design nedskrevet; model ikke bygget. Prototype: `scripts/prep-estimate.js`. Issue #276.*

---

## 16. Event-menu — eventets prisliste (#314) ✅ implementeret (juli 2026)

> Bygget forud for et event 30. juli 2026. Design låst i issue #314; denne sektion
> beskriver hvad der rent faktisk står i koden.

### 16.1 Problemet menuen løser

Menuen fandtes før kun **implicit**: produkterne var unionen af prep-bonnens linjer,
og prisen var hvad `computeSalesPrefill` tilfældigvis hentede fra Grocys
`SalespriceFestival` den dag den første salgsbon blev oprettet. Tre driftsproblemer:

1. **Prisen fandtes ikke før første salg.** Skiltet på vognen skal stå klar inden vi
   kører — men indtil en salgsbon var oprettet, lå prisen ingen steder.
2. **On-site-justeringen overlevede ikke dagen.** Rettede man prisen på pladsen, levede
   rettelsen kun i den ene salgsbons linjer. Næste dags salgsbon faldt lydløst tilbage
   til Grocys pris. Et flerdags-event krævede manuel rettelse hver dag.
3. **En ret fundet på pladsen havde intet hjem** og skulle tastes som fritekst hver dag.

### 16.2 Datamodel — `event_menu_items` (migration 131)

```
id, event_id → events(id) ON DELETE CASCADE
grocy_recipe_id  NULL = fritekst-linje
product_name, category, unit
unit_price       INCL MOMS
sort_order, note
UNIQUE(event_id, grocy_recipe_id) WHERE grocy_recipe_id IS NOT NULL
```

⚠️ **`unit_price` er INCL moms.** Det er hvad gæsten betaler, og det matcher
`bon_lines.unit_price` (§6b), så prefill ikke skal konvertere. Den eksisterende
`item_prices`-tabel (migration 068) gemmer derimod **EX moms** — "retter" nogen
denne kolonne til at matche den, går alle eventpriser 25 % galt. De to tabeller har
bevidst hvert sit momsgrundlag.

`grocy_recipe_id` bæres med hvor det kan: prissammenligning på tværs af events er en
aktiv arbejdsgang, og navne driver over tid mens id'er ikke gør. Fritekst-linjer kan
kun matches på navn — accepteret begrænsning. Matchnøglen er
`recipeId ? 'r:<id>' : 'n:<navn i lowercase>'` (`menuKey` i `routes/events.js`).

### 16.3 Generér = resync, ikke additiv

`POST /:id/menu/generate`:

- **genskaber manglende prep-afledte linjer — også dem der er slettet.** Det er
  reset-knappen.
- **rører ALDRIG prisen på linjer der findes.** Ellers ville et tryk på "generér"
  (fordi nogen tilføjede en vare til prep-bonnen) nulstille alle on-site-justerede
  priser tilbage til Grocys festivalpris. Dette er feature'ens vigtigste invariant og
  er dækket af tests.
- **manuelle linjer overlever** — de er ikke i prep-sættet og røres derfor ikke.
- kilden er **prep-rollen alene** (ikke top-up) og **aldrig aflyste bons** (#303).

Nye linjer lægges efter de eksisterende i `sort_order`, så en manuelt sat rækkefølge
ikke rykker rundt ved hver resync. Er Grocy nede, oprettes linjerne med pris 0 og
svaret bærer en `warnings`-linje — men kun når der faktisk blev oprettet noget
(ellers havde Grocy-fejlen ingen konsekvens, og advarslen ville være støj).

### 16.4 Ingen prisversionering

Prisændringer midt i et event sker sjældent; normalt ligger prisen fast når vi først
er i gang, og salgsbonnerne har allerede snapshottet prisen pr. dag. Menuen holder
"prisen nu". Fordi den også bruges som historisk opslag, ét billigt sikkerhedsnet:
**afviger en salgsbons linjepris fra menuprisen, markeres menurækken diskret** (⚠ med
de faktisk solgte priser i tooltip). Fanger de sjældne tilfælde uden at bygge
versionering.

### 16.5 Retter fundet på pladsen

Lægges ind som menulinje **uden `grocy_recipe_id`**. Ingen BOM ⇒ ingen kostpris, ingen
CO₂, ingen påvirkning af rest-/retur-beregningen. Omsætningen tæller. Er der købt
råvarer lokalt til den, går de ind som almindelig udgiftsbon.

**Den må IKKE bagud-tilføjes til prep-bonnen.** Prep-bonnen betyder "hvad der fysisk
forlod huset" (FVST-logbog, §3). Tilføjes en linje efter bonnen er trukket, tæller
dens kostpris med i vareforbruget mens idempotens-vagten blokerer et matchende
lagertræk → fantomlinje: omkostning uden bevægelse. Inden bonnen er trukket er det
derimod bare planlægning og helt fint.

### 16.6 Kobling til salgs-prefill

`computeSalesPrefill` henter nu **antal fra prep-bonnerne** og **pris fra menuen**.
Svaret bærer `price_source: 'menu' | 'grocy'`.

- Findes ingen menu, falder den tilbage til Grocys festivalpris nøjagtig som før —
  bagudkompatibelt for events oprettet inden menuen fandtes.
- Menupunkter **uden** prep (typisk en ret fundet på pladsen) kommer med i prefillen
  med antal 0, så de ikke skal tastes som fritekst hver dag.
  **API'et siger 0, og modalen viser nu også 0** — gen-modalens `addLine` har `min="0"`
  (ændret sept. 2026, Leif). Der er dage hvor en vare simpelthen ikke bliver solgt, og
  `min="1"` gjorde det umuligt at nulstille en prefill-linje: browseren afviste feltet
  med "Værdien skal være større end eller lig med 1". Rækken bliver stående som
  huskeseddel, men **linjer med antal 0 sendes ikke med** når bonnen oprettes — knappen
  tæller kun de linjer der faktisk bliver til noget ("Opret salgsbon (4 linjer)"), og
  står alle på 0 hedder den "Sæt antal på mindst én linje" og er slået fra.
- Kostpris og CO₂ er stadig Grocy-snapshots; menuen holder kun salgsprisen.

### 16.7 Endpoints

```
GET    /api/events/:id/menu            # items + afvigelses-markering
PUT    /api/events/:id/menu            # reconcile (delete+insert), samme mønster som /forecast
POST   /api/events/:id/menu/generate   # seed/resync fra prep-bons + Grocy-priser
```

PUT validerer **hele** payloadet før den rører databasen (tomt navn, negativ pris,
dubletnøgle), så et halvt gyldigt payload ikke kan efterlade menuen delvist skrevet.

### 16.8 UI

Ét sammenklappeligt **Plan**-felt med to paneler: *Forecast* og *Menu & priser*.
De kan ikke blive én tabel — forecast er pr. kategori pr. dag, menuen er pr. produkt
uden dagsdimension, og man kan ikke sætte én pris på en kategori når produkterne i den
har forskellige priser. Men de hører sammen som "planlægning inden vi kører ud", og de
fylder begge for meget når eventet er i gang. Foldes derfor sammen som default når
eventets status er `active` eller `done`; header-preview viser
"N forventet · M menupunkter" så man ikke behøver folde ud for at se om planen er lagt.

Menuen auto-gemmer (debounced). Fordi vores egne skrivninger broadcaster
`event_updated`, som kommer retur og re-renderer detaljen, sætter menu-handlingerne et
kort suppressions-vindue (`_evMarkLocalAction`, 1,5 s) — ellers rev SSE-ekkoet
kvitteringen væk igen med det samme.

**Rækkefølge:** ▲▼ pr. række flytter linjen i DOM'en og gemmer. `sort_order`
nummereres efter DOM-position (`_evCollectMenuItems`), så det man ser er det der
gemmes. Resync lægger nye linjer bagerst og rører ikke den satte orden.

### 16.8b Print — skiltet til vognen

`🖨 Print menu` bygger et rent udskriftsark i `#ev-print-root` (appended til `body`)
og kalder `window.print()`. Ingen `window.open` — dermed ingen popup-blokering, og
arket kan ikke komme ud af sync med det man ser på skærmen.

`@media print` i `office/views/events.css` skjuler alt andet
(`body.ev-printing > *:not(.ev-print-root)`), så office-shellen ikke følger med på
papiret. `body.ev-printing` fjernes på `afterprint` — med en 8-sekunders
timeout-fallback, fordi Safari ikke altid fyrer eventet og klassen ellers ville
skjule hele shellen på skærmen bagefter.

Arket grupperer efter kategori **i menuens egen rækkefølge**: den orden man har sat
med ▲▼ er præcis den man vil læse ovenfra og ned på et skilt. Linjer uden kategori
(fritekst) samles under "Øvrigt". Marginer kommer fra `@page { margin: 18mm 16mm }`.

Varer uden pris kommer med som "0 kr" — de fjernes **ikke** i stilhed, for så ville
skiltet lyve om sortimentet. I stedet siger panelet det højt før print:
"⚠ N varer uden pris kommer med som 0 kr: …".

### 16.9 Tests

`scripts/test-event-menu.js` — 42 asserts mod de ægte endpoints over HTTP (isoleret
temp-DB, spawned server). Dækker: generering fra prep, top-up og aflyste bons holdes
ude, idempotens, **prisbevarelse ved resync**, genskabelse af slettet linje, manuelle
linjers overlevelse, PUT-validering + at menuen er uændret efter afviste PUTs,
prefill-priskilde, manuel linje med antal 0 i prefill, afvigelses-markering,
rækkefølge (sort_order rundtur + bevaret ved resync), Grocy-fallback og
ON DELETE CASCADE. Print-arket er ren klient-side og dækkes af browser-verifikation,
ikke af runneren.

Assertions er bevidst uafhængige af Grocys faktiske festivalpriser — vi tester at
menuen bliver *kilden* til prisen, ikke hvilket tal Grocy gav.

*Grundlag: issue #314 (design låst med Leif, juli 2026). Bygget + browser-verificeret juli 2026.*

---

## 17. Kontaktperson på eventet ✅ implementeret (august 2026)

### 17.1 Problemet

Event-genererede bons stod uden kunde. Køkkenets kort viste "Ukendt", og kontoret
tastede den samme person ind i hånden på hver enkelt bon — også selvom kontakten er
den *samme for hele eventet*. Kontakten hører til eventet, ikke til den enkelte bon.

### 17.2 Datamodel — migration 139

Fire nullable kolonner på `events`:

| Kolonne | Rolle |
|---|---|
| `customer_id`, `company_id` | Bestilleren. Spejler bons' egne to felter (og det `KundeSoeg` leverer), så generatoren kopierer direkte uden opslag. |
| `day_contact_name`, `day_contact_phone` | Kontakten **på pladsen**. Ofte samme person, men behøver ikke være det. |

Alt nullable → et event uden kontaktperson opfører sig præcis som før.

### 17.3 Arv ned på bons

`eventContactFields(event)` i [routes/events.js](../routes/events.js) er den ene
regel: kunden kopieres råt, og dagskontakten falder tilbage til kundens navn/telefon
når den ikke er sat separat. Både event-generatoren (`POST /:id/bons`) og
**event-broen** ([routes/event-bridge.js](../routes/event-bridge.js)) bruger den —
broen importerer helperen frem for at have sin egen kopi, så de to ikke kan drive
fra hinanden.

Et eksplicit `customer_id` i payloadet vinder over eventets (`??`, ikke `||` — så
`0`/tom streng ikke tolkes som "ikke angivet").

### 17.4 Bons der blev lavet før kontakten fandtes

Netop de bons man kigger på, er dem der allerede er genereret. `GET /:id/overview`
returnerer derfor `bons_missing_contact`, og `POST /:id/apply-contact` udfylder dem.

Den rører **kun tomme felter** (`COALESCE`), så en bon hvor kontoret selv har sat en
anden kunde eller en anden dagskontakt står urørt. Den er en **eksplicit handling**
med bekræftelse — ikke en bivirkning af at gemme eventet; at skrive på tværs af
eksisterende bons skal være noget man beder om. Idempotent: anden kørsel rører intet.

### 17.5 UI

Kontaktpersonen vælges i event-modalen med samme `KundeSoeg` som bon-draweren — én
komponent, samme data, og "+ Ny kunde" virker derfra. Under event-headeren står en
kontaktlinje: hvem, kontakt på dagen, og "Udfyld på N bons uden kunde" når der er
noget at udfylde. Uden kontaktperson står der i stedet en opfordring med "Tilføj".

> **Fælde:** `KundeSoeg` må **ikke** stå inde i et `<label>`. Label-aktivering
> videresender klikket til labelens første formularkontrol — som efter valget er
> ✕ ("skift kunde") — så valget blev ryddet i præcis samme klik. Fundet ved
> browser-verifikation; unit-tests kan ikke se det.

### 17.6 Tests

`scripts/test-event-contact.js` — 26 asserts mod de ægte endpoints over HTTP
(isoleret temp-DB, spawned server). Dækker: arv til alle roller, fallback fra kunde
til dagskontakt, separat dagskontakt vinder, payload-override, tælleren for bons
uden kunde, apply-contact (inkl. at håndrettede felter overlever + idempotens),
afvisning når eventet ingen kontakt har, og at kontakten kan ryddes igen.

*Grundlag: driftsfeedback (Leif, august 2026) efter at have udfyldt kunden i hånden
på et 2-dages event.*

---

## 18. Event-løn + faktisk vareforbrug (august 2026)

> Design-session Leif, 22. august 2026. Udspringer af ét spørgsmål — "hvordan får vi
> timeforbruget med i eventets økonomi?" — men undervejs viste to nabofejl sig, som
> hører til samme beslutning: hvem ejer timen, og hvem ejer varen. Modellen er
> **ikke bygget**; nedenstående er hvad der skal implementeres.

### 18.1 Problemet (én sætning)

Eventets P&L viser omsætning, vareforbrug og udgifter — men **ingen løn**, og
vareforbruget er *hvad vi pakkede*, ikke *hvad der blev brugt*.

Størrelsesordenen: Vig Festival omsatte 153.757 kr incl. moms med 31.333 kr i udgifter.
Løn på pladsen er formodentlig i samme størrelsesorden som udgiftsposten, så "0 kr løn"
er ikke en afrunding. Og pakket-vs-solgt afviger 13.318 kr (32 %) på samme event.

### 18.2 Timerne skal ikke registreres — de skal konteres

Alt bortset fra selve konteringen findes:

| Del | Hvor | Status |
|---|---|---|
| Timer pr. medarbejder pr. dag (planlagt + fremmøde) | `smartplanAdapter.getLaborRows` | ✅ |
| Timeløn, tidsversioneret | `wage_rates` (26 medarbejdere, snit 149 kr/t) | ✅ |
| Arbejdsgiver-overhead | `settings.labor_overhead_pct` = 15 | ✅ |
| HQ vs. Festival-vagt | `location_class: 'hq' \| 'events'` (migr. 122) | ✅ |
| Batch-hent over interval | `laborAdapter.getLaborMap` — ét Smartplan-kald | ✅ |
| Frys af afsluttet periode | `labor_day_snapshot` | ✅ mønster |
| Rolle-filter (bud ud) | `smartplan_role_map` | ⚠️ kun 3 jobtyper mappet i drift |

En manuel timeseddel pr. event ville være at bygge et andet system oven på Smartplan —
og §15.4's advarsel gælder: **manuel indtastning der starter tomt bliver ikke brugt.**

> **Blokering — ✅ løst (august 2026):** `_transformRow` i `services/laborAdapter.js` byggede
> sin returværdi felt for felt og **tabte `location` + `location_class`**. Smartplan-adapteren
> satte dem; drift-adapteren smed dem væk. Konsekvensen var større end den lyder: feltet lå
> derfor heller ikke i de frosne `labor_day_snapshot`-rækker, så historiske dage aldrig kunne
> konteres bagud. Bæres nu igennem i begge veje (`getLabor` + `getLaborMap`), med ukendt klasse
> → `'hq'` — samme konservative regel som `_classifyLocation`, så en uklassificeret vagt aldrig
> tilskrives et event. Dækket af `npm run test:labor` (6 asserts, mutationstestet).
>
> **Snapshots frosset før dette er stadig uden feltet** og kan ikke konteres bagud. Det er
> tabt, ikke udskudt.

### 18.3 Tre kilder, hver med sin sandhedsværdi ✅ to af tre bygget (august 2026)

Smartplan har kun **to** lokationer ("Ristet Rug" + "Festivaler og Events") — ikke én pr.
event. Lokationen siger *"det er event-arbejde"*, ikke *hvilket* event; datoerne klarer
resten. Og fordi hverken transport eller frivillige står i Smartplan, er de manuelle
rækker ikke en nødudgang — de er hoveddelen.

| Kilde | Hvad | Sandhedsværdi | Lagres? |
|---|---|---|---|
| **Smartplan** (`location_class='events'` + eventets datospænd) | Betalt personale på pladsen | Målt fremmøde | Nej — udledes live |
| **Standard-tider** (settings) | Opsætning, nedtagning, trailer | Estimat, justerbart pr. event | Kun ved afvigelse |
| **Beregnet transport** (ORS) | Kørsel HQ ↔ eventadresse | Beregnet | Kun ved afvigelse |
| **Manuelle rækker** | Anne/Leif, frivillige, folk uden for Smartplan | Indtastet | Ja |

**Kobling event ↔ vagt: dato + lokation (model A).** Knækker først når to events overlapper
i tid. I driftsdata i dag overlapper ingen af de otte events — men det er held, ikke en
garanti (august har fire events på 18 dage). Korrektionslaget (ekskludér/flyt enkeltvagt)
bygges når det første overlap opstår, ikke før.

**Implementeret som `services/eventLabor.js` + `GET /api/events/:id/labor`** (migration 158
for standard-tiderne). Alt beregnes **live ved visning** — ingen tabel, som top-up-forslaget og
event-menuen — så et event ingen har rørt alligevel har et tal. De manuelle rækker (frivillige,
folk uden for vagtplanen) og frys ved `done` er næste skridt; datamodellen i 18.6 er uændret.

**Køretiden udledes.** `routing.getDistance` (samme ORS-kald og samme adresse-cache som
leveringsmodulet) mod eventets geokodede `event_address_id`, ganget med 2. Kan den ikke udledes,
bruges nødplans-settingen — og findes den heller ikke, kommer transporten **slet ikke med**, og
det siges. 0 timer ville se ud som en sandhed.

**Fire afgrænsninger, hver testet:**

| Ude | Hvorfor |
|---|---|
| HQ-vagter (`location_class = 'hq'`) | De bliver i driftsregnskabet (18.7) |
| Bud (`role_class = 'delivery'`) | Afregnes separat — samme regel som driften (§6a) |
| Frivillige, folk uden for vagtplanen | ✅ kan skrives ind pr. event (18.6) — men kun hvis nogen gør det |
| HQ-prep-timer | 18.7 |

**Vagtplanen bag tallet.** Et samlet timetal kan man ikke se en fejl i — er der en vagt for
meget eller for lidt, opdages det kun ved at kigge på listen. Derfor et sammenklappeligt panel
(`👤 Vagtplan & opsætning`) under P&L-strippen: hvem stod på pladsen hvornår, grupperet pr. dag,
med jobtype, mødetid, timer og kroner. Standard-tiderne står i deres eget afsnit nedenunder med
udregningen synlig (`2 t × 2 pers.`) — de er ikke vagter, de er et skøn, og de to må ikke se ens ud.

To ting markeres i listen frem for kun i totalen, fordi de forklarer et tal der ellers ser
forkert ud: en vagt uden registreret timeløn (ravgul række, `ingen sats`) og en vagt hvor
fremmødet endnu ikke er registreret (`planlagt`). Afgrænsningerne gælder også listen — bud og
HQ-vagter er hverken i summen eller i visningen, så de to ikke kan fortælle hver sin historie.

**Løn er rolle-gated på serveren** (`requireAuth('admin','office')`, som driftsregnskabet).
`/overview` er åbent for alle roller og bærer derfor **ikke** løn — derfor et selvstændigt
endpoint frem for et felt på P&L'en. Skjules tallet kun i frontenden, kan det stadig hentes.

**Strippen har nu to resultat-tal.** `Resultat før løn` (åbent for alle) og
`Resultat på pladsen · efter løn` (kun for dem der må se lønnen). To utvetydige etiketter frem
for ét ord der betyder to ting alt efter hvem der kigger.

**Test:** `npm run test:event-labor` — 67 asserts, plus `npm run test:labor` (9) for adapter-reglen mod det ægte endpoint (in-process, isoleret
temp-DB; Smartplan og ORS stubbet, `getStandardHourlyRate` ægte). Dækker de fire afgrænsninger,
overhead på begge kilder, sats-fallback til gennemsnittet, køretid der ikke kan udledes,
vagtplan der er nede, rolle-gaten, og hele frys-adfærden. Mutationstestet: 13 bevidste fejl,
alle fældet af navngivne asserts.

### 18.3b Frivillige — de var der hele tiden ✅ (august 2026)

**De frivillige står allerede i Smartplan**, så deres timer blev talt med fra dag ét. Det der
var galt, var kronerne: uden en timeløn blev de flagget *"mangler timeløn"* — præcis som en
ansat hvis sats ikke er tastet ind. To modsatte ting så ens ud:

| | Hvad tallet betyder |
|---|---|
| Frivillig | 0 kr **er** det rigtige tal |
| Manglende sats | lønnen er for lav, og nogen skal rette det |

Målt på Smartplan juni–september 2026: **18 personer** har vagter på event-lokationen,
**10 uden timeløn**. 8 af de 10 ses aldrig på HQ (typiske frivillige), 2 har også HQ-vagter
(ansatte der mangler en sats). Advarslen druknede altså de 2 ægte tilfælde i 8 falske.

**Løst med en jobtype.** Smartplan får en `Frivillig`-jobtype, som mappes til
`role_class = 'volunteer'` (migration 161). Reglen bor i `laborAdapter._transformRow`, så
**både** driftsregnskabet og event-lønnen får det rigtige svar uden hver især at kende til
frivillige: `sats = 0`, `kostpris = 0`, `rate_missing = false`. **Vagten afgør, ikke personen**
— en der både er ansat og frivillig får ikke løn for sit frivillige arbejde.

Det skalerer af sig selv: næste sæsons frivillige kræver ingen oprydning, de skal bare
planlægges på den rigtige jobtype.

> **Udgangspunktet var ekstremt:** hele 2026 havde **én** jobtype i Smartplan —
> `Salgsassistent`, ét og samme uuid, 505 vagter, 20 personer, brugt på BEGGE lokationer.
> Der var altså bogstaveligt talt intet at skelne på; lokationen var det eneste signal
> systemet havde. Jobtyperne `Frivillige` og `Bud` er oprettet 23. august 2026.

> ⚠️ **En ny jobtype dukker først op i Settings når den er i brug.** Smartplans API har intet
> jobtype-endpoint (verificeret: `/jobtypes/`, `/job-types/`, `/jobtype/`, `/positions/` giver
> alle 404), så `syncRoleMap` udleder dem fra vagterne. Rækkefølgen er derfor: opret jobtypen
> → planlæg mindst én vagt på den → synkronisér i Settings → sæt kategorien. Sync-vinduet er
> et år tilbage og 60 dage frem.

> **Fravalgt: en `wage_rates`-række med 0 kr.** Den ville virke — men
> `getStandardHourlyRate` midler ALLE satser, og den middelværdi bruges både til eventets
> standardtimer og til opskrift-kalkulationen (`routes/recipes_overview.js`). Ti nuller ville
> halvere "standard-medarbejderens" timeløn et helt andet sted i systemet, og ingen ville
> koble dét til frivillige på en festival.

I vagtplan-panelet står de som et grønt `frivillig`-mærke, ikke det ravgule `ingen sats` —
den farve er forbeholdt tilfældet hvor tallet faktisk er for lavt.

**Konsekvens for §18.6:** `event_labor`-tabellen skulle bl.a. bære frivillige. Det behøver den
ikke længere. Tilbage står kun folk der slet ikke er i Smartplan — og det er nu undtagelsen,
ikke reglen.

### 18.3c Ledige vagter tæller ikke ✅ (august 2026)

En vagt uden ejer er **udlagt, men ikke taget**. Ingen har arbejdet den, så den er hverken
mandetimer eller løn — og der er ingen person at sætte en timeløn på.

Den talte alligevel med: 7 timer på et event blev til mandetimer, trak driftens
kapacitetsrate ned som om nogen stod der, og dukkede op i advarslen som et navnløst `?`
der bad om en timeløn til et hul i bemandingen.

**Reglen lå to steder med to definitioner.** Ugeoversigten (`routes/schedule.js`) testede på
NAVN og gjorde det rigtige; driften og eventets løn testede slet ikke. En vagt med ejer men
uden udfyldt navn ville dermed være ledig ét sted og taget et andet.

Nu bor den i `smartplanAdapter._isOpenShift(owner)`, hvor alle tre normaliseringer
(`_normalizeShift`, `_normalizeWorklog`, `_normalizeLabor`) går igennem. **`owner.uuid` er
signalet, ikke navnet.** Ugeoversigten læser flaget i stedet for at udlede det selv.

| Forbruger | Før | Nu |
|---|---|---|
| Ugeoversigt | ✅ ekskluderet (egen navne-test) | ✅ læser flaget |
| Driftsregnskab | ❌ talt i persontimer + `rate_missing` | ✅ ekskluderet, `open_shift_count` med i svaret |
| Event-løn | ❌ talt i mandetimer + advarsel | ✅ ekskluderet, vist som `ikke taget` |

Vagten forsvinder ikke fra listen — et hul i bemandingen er værd at se når man planlægger.
Den vises dæmpet med overstreget timetal, og dagsoverskriften siger `· 1 ledig`.

**Test:** `npm run test:labor` — `tests/open_shift.test.js` (3) tester reglen dér hvor den
bestemmes, `tests/labor_location.test.js` (11) at flaget bæres igennem og ikke tælles som
manglende sats. Mutationstestet: reglen fjernet, navnet som signal, og tom `uuid` som ejer
fælder hver sine asserts.

### 18.3d To events samme weekend ✅ bygget (august 2026)

Lønnen hentes på **dato + lokation** (Model A ovenfor). Kører to events samtidig,
ser de derfor BEGGE alle vagter på event-lokationen, og begge P&L'er tæller de
samme kroner. Fejlen er usynlig i tallet — begge ser rigtige ud.

**Smartplan kan ikke svare på det.** Der er én event-lokation, og noten er
fritekst til medarbejderen. Målt 24. august 2026 på 417 vagter:

| | |
|---|---|
| uden note | **366** (88 %) |
| med note | 51 — blandet sted, sygemelding og arbejdsbesked |

Og noterne er ikke ensartede: *"Pokemon Go Festsival i Fælledparken"* ved siden
af *"pokemon Go festival I Fælledparken"*. To vagter dækkede oven i købet to
steder på én gang (*"I HQ 8–11 og Tivoli bagefter"*) og kan principielt ikke
tilskrives ét event.

> Feltet bruges rigtigt — til beskeder som *"der skal laves 49 slidere i alt :-)"*.
> Det skal ikke kapres til at bære et lønregnskab.

**Derfor fordeles vagterne i Bon** (`event_shift_assignments`, migration 165),
hvor vi allerede har dem i spejlet. Tre tilstande, alle med betydning:

| | |
|---|---|
| ingen række | alle overlappende events tæller vagten — **uændret adfærd** |
| `event_id = N` | kun event N |
| `event_id = NULL` | intet event (fx en HQ-vagt der ligger forkert) |

**Vælgeren vises kun når et andet event overlapper.** De fleste weekender har ét
event, og dér er der intet at vælge — en dropdown pr. vagt ville være støj.

Er der overlap og uafklarede vagter, står det som en advarsel med timetal: en
vagt der stille tælles to steder er værre end en synlig uafklaret. En vagt der
hører til det andet event bliver **stående i listen**, dæmpet og overstreget —
man skal kunne se at den er fordelt væk, ikke at den er forsvundet. Dagssummen
og panel-headeren tæller kun det der faktisk hører til eventet; ellers ville
listen modsige sin egen total.

**Test:** `npm run test:event-shift-assign` — 24 asserts, herunder invarianten
*en fordelt vagt tælles præcis ét sted* (1.200 + 1.160 = 2.360, ikke 4.720).

> **Rettet undervejs:** `_evLoadLabor` erstattede sit eget anker med `outerHTML`
> og kunne derfor kun køre én gang pr. sidevisning. Enhver løn-ændring var
> usynlig indtil man genindlæste — og et tal der ikke flytter sig, ligner en
> handling der ikke virkede.

### 18.4 Timer og kroner er to forskellige tal

Den vigtigste skelnen i modellen, og den er tvunget frem af de frivillige: **en frivillig
koster 0 kr men fylder på pladsen.** Uden opdelingen ser et event med 10 frivillige ud
som om det blev drevet af 2 mand.

P&L-strippen får derfor **to** nye felter — `Mandetimer` og `Løn (ex moms)` — med en
foldbar nedbrydning pr. kilde. Ikke ét lønfelt.

Frivilliges armbånd o.l. hører **ikke** i lønrækken: de er allerede en almindelig
udgiftsbon på eventet (fast festivalomkostning).

### 18.5 Standard-tider (Leif, august 2026)

| Opgave | Tid | Note |
|---|---|---|
| Opsætning | 2 t | pr. vej — se transport |
| Nedtagning | 2 t | |
| Hente trailer | ½ t | |
| Sætte trailer på plads | ½ t | |
| Transport HQ ↔ eventadresse | beregnet | ORS, tur/retur |

**Transporttiden foreslås automatisk.** `services/routing.js` (`getDistance`/`getRoute`) og
eventets geokodede `event_address_id` findes begge; HQ → eventadresse × 2 giver køretiden
uden at nogen taster. Kun opsætning/nedtagning/trailer er faste settings.

Alle rækker er `timer × antal personer` = mandetimer. Anne og Leif står som regel for
transport og op-/nedtagning, ofte sammen med folk der ER på Smartplan — de sidste kommer
med automatisk via 18.3, de to andre som manuelle rækker.

**Ejer-løn: registrér timerne ubetinget, gør satsen til et bevidst valg.** Eventets P&L er
et ledelsestal, ikke bogføring — det rører hverken lønudbetaling eller e-conomic. Sats 0
får eventet til at se bedre ud end det er, men timerne står der stadig, så man kan se at
det kostede to personer tre dage. `settings.event_labor_owner_rate` defaulter til snittet
af `wage_rates` (149 kr/t i drift), admin-justerbart.

### 18.6 Datamodel

```sql
-- event_labor (manuelle + afvigende rækker; Smartplan-rækker gemmes IKKE)
id        INTEGER PRIMARY KEY
event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE
kind      TEXT NOT NULL   -- 'setup'|'teardown'|'trailer'|'transport'|'onsite'|'other'
source    TEXT NOT NULL   -- 'standard' (rettet default) | 'manual'
label     TEXT            -- "Opsætning", "Frivillige", navn
date      TEXT            -- nullable
persons   REAL NOT NULL DEFAULT 1
hours     REAL NOT NULL   -- pr. person
rate      REAL            -- kr/t ex moms. NULL = standardsats. 0 = frivillig.
```

**Standard- og Smartplan-rækker beregnes live indtil eventet fryses** — først en *rettelse*
skriver en række. Så har et event ingen har rørt alligevel et tal, og en ændret setting
rammer ikke lukkede events. Samme mønster som top-up, salgs-prefill og event-menuen (§16).

**✅ Bygget som migration 162** — med den forskel at `source` udgik: en række i tabellen ER en
rettelse, og for `onsite`/`other` er den pr. definition manuel. Kolonnen ville kun kunne
modsige `kind`.

`PUT /api/events/:id/labor/:kind` (rolle-gated som resten af løn-delen). Felterne i
vagtplan-panelet står på standarden og gemmes på blur — ingen gem-knap at glemme, og man
retter kun det der faktisk afveg.

Tre ting reglen skal kunne:

- **En rettelse ERSTATTER sin linje**, den lægges ikke ved siden af. Unique-indekset er
  partielt (kun de fire standard-linjer), så `onsite`/`other` kan have flere rækker — og
  upserten gentager derfor indeksets `WHERE`, ellers matcher SQLite ikke conflict-målet.
- **0 timer er et gyldigt svar** ("vi hentede ikke traileren denne gang") og vises stadig.
  Skjulte vi den, ville det ligne at rettelsen ikke blev gemt.
- **"Tilbage til standard" er sin egen handling** (`{ reset: true }`), ikke en magisk værdi.
  Ellers kunne man ikke skelne "nul timer" fra "brug Settings igen".

En rettelse **rydder et frosset snapshot**, så ændringen slår igennem også på et lukket event;
næste visning fryser på det nye grundlag. Uden det ville brugeren se sin egen rettelse blive
ignoreret.

### Frie rækker — folk uden for vagtplanen

Frivillige der ikke er oprettet i Smartplan, en nabo der gav en hånd, jer selv når I ikke står
på planen. Uden dem står deres timer ingen steder, og mandetimerne er for lave.

`POST/PUT/DELETE /api/events/:id/labor/rows`. Samme tabel som rettelserne — det er samme slags
række, ikke en ny model. Derfor er unique-indekset partielt: `onsite`/`other` kan have flere
rækker pr. event, standard-linjerne præcis én.

**Satsen er tre-delt og skal vælges eksplicit**, aldrig udledes:

| Valg | `rate` | Betyder |
|---|---|---|
| Frivillig | `0` | Ulønnet — 0 kr er **svaret** |
| Standardsats | `NULL` | Brug eventets sats |
| Egen sats | `> 0` | Denne person koster noget andet |

`0` og `NULL` betyder modsatte ting — det ene er et svar, det andet et manglende svar — så de
må ikke kunne forveksles. Samme skelnen som 18.3b. I brugerfladen er det en vælger, ikke et
tal man skal vide betydningen af, og sats-feltet vises kun ved "egen sats" så et udfyldt felt
ikke kan modsige et valg om standardsats.

**De vises i deres eget afsnit**, ikke sammen med standardtiderne: det er indtastede timer for
rigtige mennesker, ikke et skøn fra en fast tid. `manual`, ikke `estimated`.

**Et navn er påkrævet.** En række uden navn kan ikke forsvares bagefter — og til forskel fra en
*rettelse*, hvor 0 timer er et gyldigt svar, afvises 0 timer på en fri række: en person der ikke
arbejdede er ikke en række.

`event_id` står i WHERE på både PUT og DELETE, så et id fra et andet event ikke kan rettes
eller slettes herfra.

**Test:** `npm run test:event-labor` — 101 asserts. Mutationstestet: rettelser ignoreret, lagt
til frem for at erstatte, 0-timer skjult, reset der ikke sletter, manglende rolle-gate,
negative timer, "frivillig" der bliver til standardsats, `rate 0` læst som "ingen sats",
manuelle rækker markeret som skøn, navn ikke påkrævet, og manglende `event_id` i WHERE — alle
fælder deres egne asserts.

Settings: `event_labor_setup_hours` (2) · `event_labor_teardown_hours` (2) ·
`event_labor_trailer_hours` (0,5 hver vej) · `event_labor_default_persons` ·
`event_labor_owner_rate` · `event_labor_transport_hours` (fallback når ORS ikke svarer).

**Frys ved `status='done'`** — samme mønster som `labor_day_snapshot`, ellers skrider et
afsluttet events resultat når nogen retter en vagt i Smartplan bagefter.

**Rolle-gating på serveren.** Alle endpoints i `routes/events.js` kører i dag `requireAuth()`
uden rolle. Løn-delen skal have sit eget endpoint med `requireAuth('admin','office')` — som
driftsregnskabet. Skjules den kun i frontenden, kan tallet stadig hentes.

### 18.7 Konteringen: prep bliver i driften

**Besluttet:** HQ-prep-lønnen bliver i driftsregnskabet. Eventets lønlinje er *på pladsen*.

Det gør modellen billig og ærlig, og fjerner §15.4/#276 fra den kritiske vej. Konsekvensen
skal stå på skærmen: eventets resultat bærer HQ's **varer** men ikke HQ's **arbejde**. Det
er forsvarligt (varerne kørte med traileren, arbejdet gjorde ikke), men linjen skal hedde
**"Resultat på pladsen"** — ellers læses tallet som fuld fortjeneste.

**Besluttet: drift = alt, event = et snit + lokations-toggle i driften.** Én motor, to
visninger. Reglen der skal skrives ét sted: **de to tal må aldrig lægges sammen.**

#### Lokations-toggle ✅ bygget (august 2026)

`Alt · 🏠 HQ · 🎪 Event` i driftsregnskabets værktøjslinje, på alle tre visninger
(dag/uge/periode). Invarianten der bærer det hele:

> **hq + events = alt**, krone for krone, på hver eneste metrik.

Holder den ikke, er et snit ikke et snit men et selvstændigt regnskab — og så kan et tal
falde ud mellem de to visninger uden at nogen opdager det. Den er derfor testet direkte,
ikke udledt.

**To kilder svarer på "hvor foregik arbejdet", og begge respekterer valget:**

| Side | Kilde | Regel |
|------|-------|-------|
| Bonner | `bons.event_role` | `sales`/`expense` = event · alt andet (inkl. `prep`) = HQ |
| Løn | `labor_rows[].location_class` | Smartplans lokation (migration 122) |

Snittes kun den ene, viser HQ-visningen festivalens løn sammen med HQ's omsætning — et tal
der ser rigtigt ud og er forkert. Prædikatet bor ét sted, `driftLocationSql()` i
`db/helpers.js`, så bon-aggregat, drill-down og sammentælling ikke kan blive uenige.

**Tre ting der er lette at gøre forkert:**

1. **HQ-snittet ser tabsgivende ud på en eventdag** — prep-bonnens vareforbrug ligger dér
   uden nogen omsætning, mens indtægten ligger i event-snittet. Det er ikke en fejl, det er
   konsekvensen af beslutningen ovenfor. Derfor står der et banner så snart et snit er
   valgt, og derfor nulstilles snittet til **Alt** hver gang viewet åbnes: et halvt regnskab
   skal vælges bevidst, ikke arves fra sidste besøg.
2. **Et snit må aldrig fryse en halv dag.** Første visning af en afsluttet dag fryser den
   (migration 091). Sker det gennem et snit, fryses stadig **hele** dagen — ellers ville
   "Alt" bagefter vise halvdelen, permanent, uden at nogen kunne se hvorfor.
3. **Et snit af en frosset dag** bruger snapshottets **frosne løn-rækker** (det er dem der
   skrider når Smartplan rettes) men regner bon-siden **live** — den ligger i vores egen
   base. Svaret bærer `bons_live: true`, så en afvigelse kan forklares frem for at se ud
   som en fejl.

Ukendt `location` falder tilbage til hele driften — aldrig et tomt regnskab. Svaret bærer
`location`, så en visning ikke kan forveksles med en anden.

**Test:** `npm run test:drift-location` — 60 asserts mod de ægte endpoints (isoleret temp-DB,
spawnet server). Løn-siden stubbes på **kilden**, ikke på logikken: `laborAdapter` leverer
rigtige rækker med `location_class`, ellers ville løn-halvdelen af snittet være stubbet væk
og testen måle ingenting. Mutations-testet: seks kerneregler rulles hver især tilbage og
fælder hver sin navngivne assert.

> **Fundet undervejs, ikke løst:** en frivillig har `role_class = 'volunteer'`, ikke
> `'production'`. Timerne tæller derfor **ikke** i kapacitetsraten, selvom personen står og
> arbejder — raten på en festivaldag bliver for høj. Det er en egenskab ved at `role_class`
> er ét felt, ikke ved snittet, og det gælder uændret med og uden lokations-valg. Pinnet af
> en assert, så det er synligt frem for at være en overraskelse.

### 18.8 Nabofejl 1 — driften talte event-vareforbrug to gange ✅ løst (august 2026)

Verificeret med `computeDay`'s egne filtre (`realiseret`-status, `is_offer`/`is_internal`
ude), Musik i Gentofte:

| Dato | Hvad | Omsætning (incl) | Vareforbrug (ex) |
|---|---|---|---|
| 30/7 | event: prep | 0 | **15.083** |
| 31/7 | event: salg | 12.306 | **2.239** |
| 1/8 | event: salg | 26.631 | **4.870** |

**Omsætningen er rigtig** — prep bidrager 0 kr (unit_price er 0), salg bidrager fuldt.
Vareforbruget er 22.192 kr hvor det sande lagertræk er 15.083. De 7.109 fra salgsbonnerne
er et spøgelse: `VarePicker` snapshotter `cost_price` på *enhver* bonlinje, og `computeDay`
summerer den uden at spørge om bonnen overhovedet rørte lageret. Målt på alle events:
137.251 kr (prep) + 68.742 kr (salg).

**Prædikatet findes allerede** — `db/helpers.js:149`:

```
event_id != null && event_model='light' && price_category != 'produktion'
    → 'event_prep_owns_stock'
```

Driften skal bruge samme regel på omkostningssiden: *en bon der ikke trak lager, må ikke
bidrage vareforbrug.* Så bliver prep-dagen dyr og salgsdagene "gratis" — det er **datering**,
ikke dobbelttælling, og det er præcis hvad lokations-toggle'et i 18.7 er til for.

**Implementeret.** Reglen bor ét sted som `bonOwnsStockCostSql(alias)` i `db/helpers.js`,
ved siden af `workloadRoleSql` — begge drifts-queries (aggregatet + per-bon-nedbrydningen) bruger
den, så de ikke kan drive fra hinanden. Prædikatet er skrevet selvstændigt (subqueries frem for
joins), så det kan bruges i en aggregat-query uden at tvinge kalderen til at joine to tabeller.

**Festival-modellen gates ikke** — dér trækker salgsbonnen fra sin egen lokation og ejer altså
sin omkostning. Derfor står `events.model` med i prædikatet.

> **`inventory_deduct_status` kan IKKE bruges som genvej,** selvom kolonnen findes og siger
> præcis det rigtige (`'event_prep_owns_stock'`). Den er NULL på alle event-salgsbons fra før
> migration 141, så et opslag ville give det forkerte svar på præcis de historiske dage man
> kigger på. Reglen skal genberegnes, ikke aflæses.

**Det udeladte rapporteres** (`cost_excluded_ex_moms` på dagen, vist som "ekskl. N kr event-salg"
under Vareforbrug). Et tal der bare er blevet mindre får folk til at lede efter en fejl i
bonnerne i stedet for at kunne se hvad reglen gjorde.

**Test:** `npm run test:drift-cost` — 13 asserts mod de ægte endpoints (in-process, isoleret
temp-DB, Smartplan stubbet). Dækker at omsætningen er urørt, at drill-down summerer til pillen
krone for krone, at festival-modellen er undtaget, og at en dag uden events er uændret.
Mutationstestet: seks bevidste fejl, alle fældet — heriblandt "omsætningen gates ved en fejl",
som er den nærliggende måde at overskyde målet på.

*(Beslægtet, mindre: udgiftsbons har negative `line_total` og trækker derfor fra driftens
omsætning i stedet for at være en omkostning. Bundlinjen bliver den samme, men løn-% og
DB-% skævvrides.)*

### 18.9 Nabofejl 2 — returen ændrede ikke vareforbruget ✅ løst (august 2026)

`POST /:id/return` ([routes/events.js:1313](routes/events.js:1313)) kalder udelukkende
`grocy.addToStock()` pr. produkt og skriver en changelog-linje. Der oprettes **ingen bon,
ingen bonlinje, ingen modpost** i Bon v2. `computeEventCost` summerer prep/topup-bonnernes
linjer og er dermed uberørt af at varerne kom hjem.

**Lageret bliver rigtigt. Regnskabet gør ikke.** Og funktionen er aldrig blevet brugt —
0 rækker i changelog på tværs af alle otte events.

**Målingen skal være optællingen ved hjemkomst, ikke salget:**

```
faktisk vareforbrug = prep + top-up − retur (talt fysisk)
```

Salget kan ikke være målingen — registreringen svigter netop når der sælges mest
(Pokemon Go, juni 2026: hentede flere varer hjemme, nåede ikke at registrere det fordi der
var travlt). Optællingen på vej hjem er derimod én rolig, samlet handling.

**Byttemad falder automatisk rigtigt ud** — den kom ikke hjem, altså blev den brugt. Skal
den kunne ses særskilt, registreres den som salgsbon med betalingstype **Modregning**
(`barter`, `counts_as_revenue = 0`, migr. 129 — findes i drift): enhederne tælles, kronerne
ikke. Ingen ny kode.

> ⚠️ **Returen er kun så god som udleveringen.** Hentes varer fra HQ uden en top-up-bon,
> blev lageret aldrig reduceret — og bogføres returen så, *lægges* der varer på lager der
> aldrig blev taget af. Retur-forslaget skal derfor sammenligne talt mod beregnet rest, og
> når det talte er større, sige det højt og bede om den manglende top-up-bon i stedet for
> stille at addere. Ellers er det samme fejlklasse som #305/#319: handlingen påstår,
> bivirkningen lyver.

Konkret: returen bogføres som **modpost på eventet** (negativ produktions-linje eller en
`return`-rolle-bon), så `computeEventCost` trækker den fra af sig selv. Grocy-tilbageførslen
bliver bivirkningen frem for hele handlingen — som resten af huset, hvor bonnen er
registreringen og lageret er konsekvensen.

**Løst i to omgange, af to spor der løb parallelt.** #537 (migration 157) gav returen et
**spor**: hvad kom hjem, hvornår, af hvem. Forslaget trækker siden det allerede returnerede fra,
så en gentagen bogføring foreslår 0. Migration 160 lægger **værdien** oveni — tre kolonner på
samme tabel — så `computeEventCost` = `computeEventCostPacked − computeEventReturns`.
Nedbrydningen (`cost_packed`, `cost_returned`) kommer med i `/overview`, så et vareforbrug der
pludselig falder kan forklares.

> **Den oprindelige plan om en `return`-rolle-bon blev forkastet.** `bons.event_role` har en
> CHECK-constraint, og SQLite kræver hele `bons`-tabellen genskabt for at ændre den — med
> 3 triggers og 11 views hængende på sig. **Konsekvensen:** driften får ikke retur-datoens
> negative vareforbrug automatisk; det hører til 18.8's lokations-kontering.

Tre ting modposten skal kunne, og som hver især er testet:

- **Prisen er et snapshot** (`unit_cost`/`cost_total`, slået op via
  `grocy.getProductUnitCosts()` ved bogføringen). Råvarepriser ændrer sig, og et afsluttet
  events regnskab må ikke skride fordi nogen køber rødløg til en anden pris næste måned.
- **Ukendt pris → 0 kr, ikke et gæt.** Varen lægges stadig på lager (det er den vigtige
  del), men modposten bliver 0, og det *rapporteres* (`missing_price`). Vareforbruget bliver
  hellere for højt end forkert lavt — og tavshed ville gøre det til et regnskab ingen opdager.
- **Kun det der faktisk landede hos Grocy bogføres** (#537's regel, uændret).

**Værnet** afviser med `409 return_exceeds_computed` og viser pakket, solgt, allerede
returneret, tilbage og talt ved siden af hinanden. `settings.event_return_tolerance_pct`
(default 10) holder fysisk måle-upræcished ude — men den beregnede rest er 0 i netop det
tilfælde værnet er til for, så det fyrer uanset. Der KAN bogføres alligevel (`force: true`):
valget er kontorets, men det træffes bevidst, rækken mærkes `forced`, og changelog forklarer.

> **Ingen separat idempotens-nøgle.** Fordi forslaget siden #537 trækker det allerede
> returnerede fra, er resten 0 ved anden bogføring — og de samme mængder overskrider den.
> Værnet ER dermed dobbelt-bogførings-værnet. En nonce oveni ville dække det samme to gange.

**Test:** `npm run test:event-return-cost` — 35 asserts. In-process mod en isoleret temp-DB med
Grocy stubbet; den ÆGTE route-handler monteres på en bar express-app. Grunden er ikke hastighed:
den rigtige sti kalder `grocy.addToStock()`, og en test mod en spawnet server ville flytte lager
i grocytest. Attrappen gør desuden de tilfælde testbare der er svære at fremprovokere — at ét
produkt fejler hos Grocy, og at et andet ingen kendt pris har. Mutationstestet: seks bevidste
fejl, alle fældet. Sporet i sig selv er dækket af `npm run test:event-retur` (#537).

### 18.10 Byggerækkefølge

1. ~~Lad `location` + `location_class` overleve `_transformRow`~~ ✅ **udført** (august 2026,
   `npm run test:labor`). Alt andet afhænger af den, og uden den kan historikken aldrig
   konteres bagud.
2. Udfyld `smartplan_role_map` — **data, ikke kode.** Kun 3 jobtyper er mappet i drift, og
   ingen bud-jobtyper, så bud-timer tæller i dag med i driftsresultatet som `other`.
   `syncRoleMap()` findes; den skal køres og listen udfyldes. Uden det bliver ethvert nyt
   lønstal forkert på samme måde.
3. ~~settings + Smartplan-kilden + strip med `Mandetimer` / `Løn`, rolle-gated endpoint~~
   ✅ **udført** (august 2026, migration 158, `npm run test:event-labor`). `event_labor`-tabellen
   (frivillige + manuelle rækker) udestår — indtil da er tallet et estimat, og det siges.
4. ~~Frys ved `status='done'`~~ ✅ **udført** (august 2026, migration 159). Frys ved **første
   visning** efter at eventet er lukket — så bliver events der allerede står som `done` også
   frosset, og en fejlet PATCH kan ikke efterlade et event uden snapshot.

   **Kun løn-delen fryses**, aldrig resultatet: `result_on_site` regnes altid af den frosne løn
   og den AKTUELLE P&L. Frøs vi også resultatet, ville et retur bogført bagefter (18.9) få
   lønvisningen og `/overview` til at modsige hinanden — og så er begge tal værdiløse.

   > **Vi fryser aldrig et tal vi ved er forkert.** Kunne vagtplanen ikke hentes, skrives der
   > intet snapshot; ellers ville "0 timer fordi Smartplan var nede" blive permanent, og ingen
   > ville nogensinde opdage hvorfor. `/labor/refreeze` afvises af samme grund (503).

   Et genåbnet event viser live tal igen; snapshottet bliver liggende og tages i brug når
   eventet lukkes. Er der rettet i mellemtiden, skal det genberegnes bevidst —
   `POST /:id/labor/refreeze` (admin, som driftens `/refreeze`), med en knap i frys-noten.
5. ~~*Eget issue:* driftens vareforbrug respekterer `event_prep_owns_stock` (18.8)~~ ✅ **udført**
   (august 2026, `npm run test:drift-cost`) — inkl. lokations-toggle'et, se 18.7
   (`npm run test:drift-location`).
6. ~~*Eget issue:* retur som modpost + advarsel ved talt > beregnet (18.9).~~ ✅ **udført**
   (august 2026, migration 160, `npm run test:event-return-cost`).

Alle seks trin er på plads: driften tæller ikke længere eventets varer to gange,
"Vareforbrug" er *hvad der blev brugt* så snart returen bogføres — et event hvor returen
ikke er bogført viser stadig hvad vi pakkede — og HQ-dagen kan ses uden eventet via
lokations-toggle'et.

### 18.11 Stadig ikke afklaret (blokerer ikke byg)

- **Transport pr. person eller pr. tur?** Kører der tre med i bilen, er det tre mandetimer
  men én køretur. Foreslået: `hours × persons`, felt pr. event, default 2 personer.
- **Står Anne og Leif i Smartplan?** Hvis ja, kan deres vagter blive talt både som udledt
  og som manuel række. Skal afklares før 18.3 og de manuelle rækker mødes.
- **Overlappende events** — korrektionslaget (model B) bygges når det første overlap opstår.

*Grundlag: design-session Leif, 22. august 2026. Tal verificeret mod en kopi af driftsdata
(kopien slettet efter brug). Ingen kode ændret.*

---

## 19. Rest-prep — to prep-bons må ikke tælles dobbelt (august 2026) ✅ implementeret

> Migration 166. Driftsfeedback fra Ungdommens folkemøde (2.–3. sep 2026): køkkenet
> kunne ikke se hvor meget der skulle laves, fordi der lå **to** prep-bons på samme dag.

### 19.1 Problemet

På et event med event-ordre-kobling (§ broen, `docs/CLAUDE_EVENT_BON_BRIDGE.md`) findes
der to prep-bons pr. dag:

| Bon | Kilde | Karakter |
|-----|-------|----------|
| B4166 | event-broen | kundernes **forudbestillinger** — allerede solgt, vokser ved hver ordre |
| B4147 | office' `+ Prep` | **forecasten** for dagen |

Forecasten er dagens **totale** forventede salg og indeholder altså de forudbestilte.
Men overlappet stod kun som fritekst i broens køkkeninfo — *"indgår disse i den (lav dem
ikke oveni)"*. Ingen kolonne, intet flag, ingen beregning kendte det.

Målt i drift 2. sep: forecast 400, forudbestilt 332, registreret produktion **732**.

Fire konsekvenser, i rækkefølge efter alvor:

1. **HQ-lageret trækkes dobbelt.** `autoConsumeBonInventory` undtager let-event prep-bons
   fra §5-gaten — de trækker uanset det globale flag. Begge bons sat til LEVERET trak
   råvarer for 732 mens der forlod huset 400. Fejlen dukker først op ved næste optælling.
2. **Top-up og retur regner forkert.** `computeTopupSuggestion` og `computeReturnSuggestion`
   summerer `prepped` over alle produktion-bons. Retur ville bogføre 332 for meget tilbage.
3. **Ugeoversigt og kapacitet lyver.** 732 enh onsdag → falsk "Understaffed".
4. **Køkkenet ser to kort** og skal selv regne ud at det ene er en delmængde af det andet.

Fejlklassen er den kendte (memory `project_silent_sideeffect_failures`, jf. #305/#319):
to systemer er uenige, uenigheden er usynlig, og intet sted mødes de to.

### 19.2 Reglen

```
mål for dagen  =  max(forecast, forudbestilt)      ← pr. KATEGORI, pr. DAG
rest-bonnen    =  mål − alt andet preppet den dag
```

`max()` er Leifs egen formulering: *"forecasten styrer, med mindre den bliver overhalet af
de faktiske ordrer."* Så behøver forecasten aldrig blive rettet automatisk bag office' ryg.

**Pr. dag og ikke på summen.** Summerede man først, kunne en dag hvor ordrerne har
overhalet blive udlignet af en dag hvor de ikke har — og målet ville være for lavt netop
på den dag der er presset.

### 19.3 Hvorfor det genberegnes frem for at blive rettet i hånden

Forudbestillinger kan komme ind helt frem til bestillingsfristen (30. aug for eventet
2.–3. sep). En manuel rettelse er forældet dagen efter, og så gentager præcis den drift
der skabte problemet. Der findes ikke noget godt tidspunkt at rette på: for tidligt bliver
forkert igen, for sent efterlader køkkenet uden grundlag.

Derfor holder office' bon **resten**, og den genberegnes hver gang målet flytter sig.
Summen af de to bons er altid dagens mål.

### 19.4 Værn

- **Opt-in pr. bon** (`bons.event_prep_auto_rest`). En prep-bon office har sammensat i
  hånden må ikke pludselig begynde at flytte sig. Fluebenet i prep-modalen er slået til
  når dagen faktisk har forudbestillinger — ellers vises det ikke.
- **Frys.** Genberegningen stopper når bonnen forlader `NY`/`GODKENDT` eller har trukket
  lager. Listen spejler broens egen `BRIDGE_ROLES.prep.reconcile` med vilje: gik de fra
  hinanden, kunne broen opdatere SIN bon på en dag hvor resten er frosset. Efter frysen er
  bonnen køkkenets, og nye ordrer bliver til en **top-up** — hvilket er den rigtige historie.
- **Kun kategorier med et mål røres.** `Tilbehør & Bokse` (ingen forecast) er office' egen
  linje og står urørt. Vi opfinder heller aldrig produkter: har en kategori et mål men
  ingen linjer på rest-bonnen, rapporteres det som en advarsel.
- **Mixet bevares proportionalt** (`allocateInteger`). Det er office' valg af *hvad* der
  laves ekstra og må ikke overskrives af hvad kunderne tilfældigvis har bestilt. Er alt
  nulstillet, findes der intet forhold at bevare, og en jævn fordeling er det ærligste gæt.
- **Kun ÉN rest-bon pr. (event, pakkedag)** — partielt unique-indeks. To overlappende ville
  trække hinanden fra og kunne svinge frem og tilbage.
- **En fejlet genberegning må aldrig koste kundens ordre.** Broen kalder den i try/catch og
  rapporterer fejlen i svaret; forudbestillingen er allerede landet. Samme princip som
  `goodsReceiptWebhook`.

### 19.5 Rest = 0

Når forudbestillingerne dækker hele målet, bliver bonnen **stående** med sine linjer på 0
og en køkkentekst der peger på den bon der skal laves efter:

> `⟳ 0 — hele dagens mål er forudbestilt. Det er B4166 I skal lave efter.`

Beslutning (Leif): *"de har set på 2 bonner i lang tid, så det vil nok være mærkeligt hvis
den pludselig forsvandt."* At aflyse den automatisk ville også være en destruktiv bivirkning
af at en kunde bestilte — og annulleres ordren, skal tallet kunne komme op igen.

0-mængde-linjer skjules på køkkenkortet (`mapApiBonToCardData`): de er ikke arbejde, og
"0 × Tunen" tre gange er støj. Der findes **nul** 0-linjer i driftshistorikken, så filteret
kan ikke skjule noget der plejede at være synligt.

### 19.6 Den oprindelige forecast bevares

`event_forecast.original_qty`. Forecasten korrigeres løbende efterhånden som rigtige ordrer
kommer ind; uden feltet gik *"hvad gættede vi egentlig på?"* tabt i samme øjeblik tallet
blev rettet, og eventet kunne ikke evalueres bagefter.

`PUT /:id/forecast` sletter og genindsætter alt, så værdien bæres eksplicit med over.
**NULL = aldrig korrigeret** — vi backfiller ikke eksisterende rækker, for vi ved ikke om
de er rettet, og et gæt ville se ud som en måling. Feltet fyldes første gang et tal
*faktisk* ændrer sig, og overskrives aldrig af den næste rettelse.

### 19.7 Synligt for office

Forecast-tabellen viser regnestykket pr. dag under datoen:

- normalt: `🔗 332 forudbestilt · 400 preppet · mål 400`
- skredet: `⚠ 732 preppet mod mål 400 — 332 for meget`

Advarslen bygger udelukkende på SQL (`prepped` + `bridge_prepped`), ikke på Grocy. Derfor
falder forecast-tabellen nu tilbage på de kategorier der allerede står på eventet når Grocy
er nede — før forsvandt hele tabellen, og dermed også advarslen, præcis når man ikke kunne
se hvorfor.

**Handlingen ligger i selve advarslen**, ikke kun i bon-listen: `⚠ 732 preppet mod mål 400 —
332 for meget · ⟳ Ret B4147`. Prep-listen ligger langt nede på siden, og en advarsel uden
vej videre er bare en konstatering. Findes der flere office-prep-bons på dagen, gætter vi
IKKE hvilken der skal holde resten — så henvises der til listen.

Bon-listen mærker rollerne (`🔗 forudbestilt` / `⟳ holder resten`) og har sin egen
`⟳ Hold resten`-knap. Begge knapper deler handler. De vises kun når de kan virke — broens
egen bon og en frosset bon får dem ikke; en knap der kun kan fejle er værre end ingen knap.

### 19.8 Filer

| Fil | Rolle |
|-----|-------|
| `db/migrations/166_event_rest_prep.sql` | `bons.event_prep_auto_rest` + unique-indeks + `event_forecast.original_qty` |
| `routes/events.js` | `computeDayTargets`, `preppedExcept`, `reconcileRestBon`, `reconcileRestBonsForEvent`, `restKitchenText`, `applyKitchenMark` + `POST /:id/bons/:bonId/rest-prep` |
| `routes/event-bridge.js` | genberegner efter hver prep-push (try/catch) |
| `office/views/events.{js,css}` | dagsregnskab, flueben, mærker, knap |
| `shared/utils.js` | 0-mængde-linjer skjules på kortet |

**Tre triggere:** broens prep-push · `PUT /:id/forecast` · oprettelse/toggle af rest-bonnen.

### 19.9 Tests

`npm run test:event-rest-prep` (59 in-process, inkl. den ægte `/webhook/event-prep`-route
med Grocy stubbet) + `npm run test:event-rest-prep-http` (36 over HTTP mod en spawnet
server). **Mutations-testet:** 12 mutationer — de syv kerneregler og de fem wiring-punkter
— rulles hver især tilbage og fælder hver sin navngivne assert.

### 19.10 Kendte afgrænsninger

- **Fritekst-linjer uden kategori genberegnes ikke.** Vi ved ikke hvilket mål de hører til.
- **Flerdags-pakning:** en bon tælles med hvis dens `delivery_date` ligger i intervallet.
  En bon der rækker ud over intervallet tælles fuldt med — vi kender ikke fordelingen pr.
  dag (samme grund som `computeCoveredDays` ikke fordeler mængder), og et pro-rata-gæt
  ville forplante sig ind i målet som var det en måling.
- **Sættes en forecast-kategori til 0, slettes rækken** (eksisterende PUT-semantik), og
  dermed også dens `original_qty`.

*Grundlag: driftsfeedback + design-session Leif, 26.–27. august 2026. Tal verificeret mod
en kopi af driftsdata; syntetisk testdata i dev-DB oprettet og ryddet igen.*
