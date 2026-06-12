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

## 6. Event-beholdning (beregnet) + de to forslag — top-up & retur (blokerende)

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

---

## 7. Event-P&L + CO₂  ✅ implementeret

- **P&L** = Σ salgsbon-omsætning − vareforbrug (kostpris ex moms) − udgiftsbon. Alt ex moms (moms-doktrin).
- **Udgiftsbon** tagges som omkostning — må **ikke** nette mod omsætning (ellers falder omsætningstallet).
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
  `/:id/return-suggestion` + `/:id/return` (addToStock til HQ).
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

**Tests:** `scripts/test-event-gate.js` (15) + `scripts/test-prep-packing.js` (12 — override + extras) +
`scripts/test-recipe-factor.js` (8 — underopskrift-skalering) +
`scripts/test-sales-prefill.js` (7 — prep-only union + festival-pris) +
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
