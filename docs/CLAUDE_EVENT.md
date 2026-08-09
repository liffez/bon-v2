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
  **API'et siger 0, modalen viser 1** — gen-modalens `addLine` har `min="1"`. Det er
  et bevidst valg (Leif, juli 2026): du satte retten på menuen fordi du regner med at
  sælge den, og alle prefill-tal er i forvejen START-gæt der justeres inden bonnen
  gemmes. 0 i API'et er den ærlige "der er ikke preppet noget til den".
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
