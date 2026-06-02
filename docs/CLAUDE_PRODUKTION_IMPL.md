# CLAUDE_PRODUKTION_IMPL.md — Implementerings-spec: produktionsbatch med afvigelse

> Læs FØR kode: CLAUDE.md, `docs/CLAUDE_PRODUKTION.md` (beslutnings-dokument), `docs/T_PRODUKTION.md`
> (testspor), bon_v2_datamodel_v2.md, BON_V2_PRINCIPPER.md (moms-doktrin §6b+6c).
>
> Dette dokument er **implementerings-specen**. `CLAUDE_PRODUKTION.md` traf beslutningen;
> her står *hvordan* den bygges — grundet i en spike mod jeres rigtige Grocy 4.6.0.
>
> Status: **klar til implementering.** Foundational Grocy-antagelser verificeret (se §1).

---

## 1. Spike-resultater — det vi nu VED (ikke gætter)

Kørt mod grocytest (Grocy 4.6.0) via `scripts/spike-produktion-grocy.js` (selv-oprydningende,
`ZZT_`-prefiks, kun mod `location.code==='test'`).

| Antagelse | Resultat | Følge for designet |
|-----------|----------|--------------------|
| `POST /stock/products/{id}/add` med `transaction_type:"self-production"` + `price` | ✅ **virker** | Prisen sætter sig på både `last_price` og `avg_price`. Vi kan altid sætte produkt-prisen eksplicit. |
| Add-svaret indeholder `transaction_id` | ✅ ja | Bruges til reversering af consumes. |
| `undo` af en **self-production add** | ❌ **400 "This booking cannot be undone"** | Produkt-add'en kan **ikke** undoes. Reversering er asymmetrisk (§4). |
| `undo` af en **purchase add** | ✅ kan | Bekræfter at self-production er specialtilfældet — ikke add generelt. |
| `undo` af en **consume** | ✅ kan (lager ruller tilbage) | Råvarer reverseres via gemt `transaction_id`. |
| Kompenserende `consume` af produceret mængde | ✅ ruller produkt-add tilbage til baseline | Den faktiske reverserings-vej for produkt-siden. |

**Konsekvens:** CLAUDE_PRODUKTION.md's `reverseBatch → tilbagefører pr. transaction_id` holder kun
for råvarerne. Produkt-siden reverseres med en kompenserende consume (§4).

---

## 2. Central designbeslutning: ÉN vej (altid manuel)

CLAUDE_PRODUKTION.md beskrev to veje: `diff=0 → recipe-consume`, `diff>0 → manuel`. **Denne spec
superseder det med én vej** — altid per-produkt consume + eksplicit-priset self-production add —
også når diff=0.

**Hvorfor (bevis-baseret):**

1. **Recipe-level consume er allerede forladt.** `grocyAdapter.consumeRecipes()` kører per-produkt
   netop fordi recipe-level var broken (CLAUDE.md, Fase 4). Diff=0-grenen ville genindføre det.
2. **Vi behøver ikke Grocys auto-pris.** Spiken viste at `price` kan sættes eksplicit. Den eneste
   grund til recipe-consume var atomicitet + auto-pris — begge er nu enten forladt eller unødvendige.
3. **Pris-kontinuitet gratis.** Én formel altid (§6) → ingen diskontinuitet når en batch går fra
   diff=0 til diff=0,001. (Lukker risikoen jeg flaggede ved review.)
4. **Én atomicitets-historie.** Saga'en (§3) dækker begge tilfælde; ingen dobbelt kodevej at teste.

Diff=0 er dermed **det trivielle tilfælde af den samme vej**: `actual == master` på alle linjer.

> Denne beslutning ændrer T_PRODUKTION's P1 (forventede "præcis ét recipe-consume-kald").
> Se §13 for opdateret forventning.

---

## 3. Saga — atomicitet (R5, blokerende)

Grocy har **ingen** transaktion på tværs af produkter. N×consume + 1×add er N+1 separate kald.
Det løses med en eksplicit state-machine på `production_batches.state`, ikke ad-hoc try/catch.

```
draft ──produce()──▶ consuming ──(alle consumes ok)──▶ producing ──(add ok)──▶ produced
                         │                                  │
                         │ (en consume fejler)              │ (add fejler)
                         ▼                                  ▼
                    rollback consumes ─▶ failed       rollback consumes ─▶ failed
```

**Rækkefølge (kritisk — råvarer FØR produkt):**

```
1. state = 'consuming'
2. for hver linje med actual > 0 (i fast rækkefølge):
     tx = POST /stock/products/{id}/consume { amount: actual_i_stockenhed, transaction_type:'consume', spoiled:false }
     gem grocy_transaction_id på production_batch_consumption-rækken STRAKS (før næste kald)
   — fejler en linje:
       undo alle allerede-gemte consume-tx (i omvendt rækkefølge)
       state = 'failed'; log præcist hvad der nåede igennem; returnér fejl
3. state = 'producing'
4. tx = POST /stock/products/{producedId}/add { amount: faktisk_yield, transaction_type:'self-production', price }
     gem produce-transaction_id på production_batches
   — fejler add'en:
       undo alle consume-tx; state = 'failed'; returnér fejl
5. state = 'produced'
```

- **Aldrig tavst halvt træk.** Enten fuldt igennem (`produced`), eller fuldt rullet tilbage (`failed`).
- Hvis selve rollback'en fejler (netværk midt i): state = `partial` + log med alle kendte tx-id'er,
  så en operatør kan rydde op manuelt. `partial` er en synlig, alarmerende tilstand — ikke en stille.
- Consumes køres **sekventielt** (ikke `Promise.all`) så rollback-sættet altid er kendt.

---

## 4. Reversering (R5 — tilbageførsel) — asymmetrisk

Bygget på spike-fundene i §1. `reverseBatch(batchId)`:

```
forudsætning: batch.state === 'produced'
1. Tjek tilgængeligt lager af det producerede produkt:
     effektivt_lager >= actual_output_qty ?
       NEJ → fejl 'BATCH_OUTPUT_IN_USE' ("kan ikke fortrydes — produktet er allerede taget i brug")
             (P18: fejl kontrolleret, gæt ALDRIG)
2. Produkt-siden (kan ikke undoes):
     POST /stock/products/{producedId}/consume
       { amount: actual_output_qty, transaction_type:'consume', spoiled:false }
3. Råvare-siden (kan undoes):
     for hver consumption-række med grocy_transaction_id:
       POST /stock/transactions/{transaction_id}/undo
     — manglende transaction_id på en række → fejl + log; ingen blind gætte-tilbageførsel (P18)
4. state = 'reversed'; sæt reversed_at (idempotens-vagt: afvis hvis allerede reversed)
```

> `reversed_at`-vagten spejler `changelog.rolled_back_at`-mønstret (CLAUDE.md, migration 056) —
> samme batch kan ikke reverseres to gange.

---

## 5. QU-konvertering (R6, blokerende — samme klasse som 28%-cost-bug'en)

Opskrift-mængder vises i display-enhed (g, ml, stk); Grocy `consume`/`add` forventer **stock-enhed**.
Konvertér ÉT sted, server-side, før hvert kald — stol aldrig på display-enheden.

- Brug `quConvert.findConversionFactor(conversions, productId, fromQuId, toQuId)` (findes allerede).
- `recipes_pos.amount` er **allerede i stock-enhed** (CLAUDE.md — verificeret). Tilføjede varer +
  manuelt indtastede actuals indtastes i display-enhed og **skal konverteres**.
- **Log konverteringen eksplicit** pr. linje: `"RAW_A: 250 g → 0,250 kg (faktor 0.001)"`. Uden den
  log kan g/kg-fejl ske tavst — præcis det R6 fanger.
- Edge: produkt uden konvertering hvor display≠stock → fejl kontrolleret, producér ikke.

---

## 6. Pris (R3, blokerende) — én formel, ex moms

```
faktisk_batch_kost = Σ (actual_i_stockenhed × enhedskost_i_stockenhed)     // inkl. substitutter + tilføjede
price_pr_produceret_enhed = faktisk_batch_kost / faktisk_yield              // kr pr. stock-enhed af produktet
```

- **`enhedskost` skal komme fra SAMME Grocy-kilde som resten af systemet** — fulfillment-baseret
  kostpris (CLAUDE.md: "Kostpris fra Grocy fulfillment `costs`, ikke `costprice` userfield").
  Brug ikke et tilfældigt pris-felt; ellers driver food-cost mellem batches og menukort-margin.
- **Ex moms.** Alle priser sendt til Grocy er ex moms (§6b). Ingen `* 1.25` / `/ 1.25` — råvarekost
  er allerede ex moms i Grocy. Pre-commit-hook håndhæver dette.
- **Kontinuitets-test (sikrer §2-beslutningen):** ved diff=0 skal `price` = den kostpris Grocys
  fulfillment beregner for opskriften (modulo afrunding). Bevises i unit-test P10/P11-grænsen.
- `faktisk_yield` ≠ ingrediens-vægt: prisen koncentreres ved svind (921 g ingrediens → 870 g udbytte
  → højere kr/g). Det er korrekt og bevidst.

---

## 7. Skalering / afvigelses-model (R9)

Mockup'en skalerer `actual *= factor` ved hvert portions-skift → akkumulerer rundingsdrift (P22).
**Modellér i stedet afvigelsen ved 1-portions-basis og beregn `actual` on the fly:**

```
pr. ingrediens gemmes:  per (master pr. portion),  override_per (null = ingen afvigelse)
actual(portioner) = (override_per ?? per) × portioner
udeladt:            override_per = 0  → actual = 0 uanset portioner (P20)
```

- Skalering bliver deterministisk; 1→2→1 giver eksakt samme tal (P22, drift = 0).
- Decimal-parse: accepter både `"1,3"` og `"1.3"` → 1,3 (P21). Genbrug mockup'ens `num()`-mønster.
- Tilføjede varer: gem deres mængde ved 1-portions-basis, skalér tilsvarende.

---

## 8. Idempotens (R7)

- Klient genererer en `batch_nonce` (UUID) ved åbning af afvigelses-tilstand; sendes med `produce()`.
- Server: unique-constraint på `production_batches.batch_nonce`. Dobbelt-submit → 2. kald returnerer
  den allerede-oprettede batch i stedet for at trække igen (spejler `autoConsumeBonInventory`'s
  `inventory_deducted`-vagt).
- Toggle frem/tilbage rører ALDRIG data (P25) — kun visning. Produktion sker kun ved eksplicit klik.

---

## 9. Nesting (underopskrifter) på den manuelle vej

Falafel-opskriften har "Ingrid ærter udblødt" som underprodukt. **Beslutning:** på den manuelle vej
konsumeres hver linje som det **stock-produkt den er** — dekomponér IKKE rekursivt ned i
underopskriftens råvarer.

- Rekursiv dekomponering genindfører alt-eller-intet + dobbelttælling — det vi netop undgår.
- Forudsætning: underproduktet er en lagerbar vare (har egen stock). Verificér ved batch-load;
  er linjen en ren opskrift uden stock-produkt → markér og kræv at brugeren løser den (sjældent).
- `ingredientResolver` bruges KUN til at bygge den initiale master-liste (display), ikke til at
  fladgøre forbruget.

---

## 10. Datamodel — migration `086_production_batches.sql`

Bygger på CLAUDE_PRODUKTION.md's model + tilføjer state/nonce/reversering.

```sql
CREATE TABLE production_batches (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  grocy_recipe_id INTEGER NOT NULL,
  grocy_output_product_id INTEGER NOT NULL,
  portions REAL NOT NULL DEFAULT 1,            -- decimaler tilladt (1.3)
  planned_output_qty REAL NOT NULL,            -- 1000 × portioner (deklareret nominel)
  actual_output_qty REAL,                      -- faktisk udbytte (svind)
  output_unit TEXT NOT NULL,                   -- stock-enhed
  batch_nonce TEXT NOT NULL UNIQUE,            -- idempotens (R7)
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','consuming','producing','produced','partial','failed','reversed')),
  produce_transaction_id TEXT,                 -- self-production add'ens tx (kan IKKE undoes)
  master_cost REAL,                            -- Σ master×enhedskost, ex moms (reference)
  actual_cost REAL,                            -- Σ actual×enhedskost, ex moms (= price×yield)
  notes TEXT,
  produced_at TEXT, produced_by_user_id INTEGER,
  reversed_at TEXT,                            -- idempotens-vagt mod dobbelt-reverse
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE production_batch_consumption (
  id INTEGER PRIMARY KEY,
  production_batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  grocy_product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,                  -- snapshot
  planned_qty REAL NOT NULL,                   -- master × portioner (0 = ikke i opskrift)
  actual_qty REAL NOT NULL,                    -- reelt brugt, i stock-enhed (0 = udeladt)
  unit TEXT NOT NULL,                          -- stock-enhed (efter QU-konvertering)
  deviation_reason TEXT
    CHECK (deviation_reason IN ('justeret','udeladt','byttet','tilfoejet','spild') OR deviation_reason IS NULL),
  substitute_for_product_id INTEGER,           -- parrer byt-linjer
  grocy_transaction_id TEXT,                   -- → undo (NULL hvis actual=0 → intet kald)
  unit_cost REAL,                              -- ex moms, snapshot fra Grocy fulfillment-kilde
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pbc_batch ON production_batch_consumption(production_batch_id);
```

`variance = planned_qty − actual_qty` → spild/food-cost gratis senere.

---

## 11. Adapter — `services/grocyAdapter.js`

Ét nyt orkestreringspunkt så ruten aldrig selv jonglerer transaction_types. Genbruger den
verificerede `addToStockFull` + `consumeProduct`-mønstre, men returnerer `transaction_id`.

```
produceBatch({ consume: [{productId, amount}], produce: {productId, amount, price} })
   → kører saga'en (§3): sekventielle consumes (returnér tx pr. linje), så self-production add
   → returnerer { state, consumeTx:[{productId, transactionId}], produceTx, error? }

reverseBatch({ producedProductId, producedAmount, consumeTransactionIds:[...] })
   → asymmetrisk reversering (§4): kompenserende consume af produkt + undo af råvare-tx
   → returnerer { reversed:true } eller fejl ('BATCH_OUTPUT_IN_USE' | 'MISSING_TX')
```

- **Vigtigt:** `consumeProduct`/`addToStockFull` returnerer i dag intet — udvid dem (eller lav
  interne varianter) så de returnerer Grocy-svarets `transaction_id`. Spiken viste det ligger på
  `svar[0].transaction_id`.
- Ryd `_cache.delete('stock')` efter writes (eksisterende mønster).

---

## 12. Routes — `routes/production.js` (mountes i server.js)

```
POST   /api/production/batches            { recipe_id, portions, lines[], actual_yield, batch_nonce, notes }
                                          → kører produceBatch-saga, gemmer batch + consumption
POST   /api/production/batches/:id/reverse → reverseBatch
GET    /api/production/batches?recipe_id=&from=&to=   → historik
GET    /api/production/batches/:id        → detalje inkl. consumption-linjer
```

- `requireAuth()`. Changelog skrives af serveren (aldrig frontend). SSE `production_batch_created`
  / `production_batch_reversed`.
- Validering server-side: portioner > 0, actual_yield > 0, alle product_id findes, location er aktiv.

---

## 13. UI — integreret i RR Produktion-opskriftsvisningen

- Logikken i **eget modul** `shared/production_batch.js` (+ `.css`) som `recipe_viewer.js`
  *mounter* når "Juster mængder"-toggle slås til — så `recipe_viewer.js` ikke svulmer.
  Matcher mønstret med fokuserede shared-komponenter.
- Toggle = rent visnings-skift, rører aldrig data (P25). Default fra (ren opskrift).
- Operationer: justér (stepper), fjern (→0, udeladt), byt (original→0 + parret ny linje),
  tilføj vare (søg Grocy). Knap skifter til "Producér batch (N ændringer)" ved diff ≠ 0.
- Portioner: decimaler (§7). Tre vægtbegreber adskilt (ingrediens-vægt / planlagt yield / faktisk
  udbytte) — som mockup'en allerede gør korrekt.
- Metode-tekst vises read-only under linjerne.
- Mockup'en (`docs/rediger_produktion_mockup.html`) er referencen — men dens inkrementelle
  `actual *= factor` udskiftes med override-per-modellen (§7).

---

## 14. Test → T_PRODUKTION (P1–P30)

Mapping af spec-ændringer ind i testsporet:

| Test | Justering pga. denne spec |
|------|---------------------------|
| **P1** (diff=0) | Forventning ændret: **ikke** recipe-consume. Diff=0 = trivielt tilfælde af manuel vej — per-produkt consume(master) + 1 self-production add med `price`=fulfillment-kost. |
| **P10/P11** | Tilføj eksplicit **kontinuitets-assert**: price(diff=0) == Grocy fulfillment-kost (§6). |
| **P16/P17/P18** | Reversering er asymmetrisk (§4): produkt via kompenserende consume, råvarer via undo. P18: manglende tx-id + 'output in use' fejler kontrolleret. |
| **P23** | Saga-state-machine (§3): `produced` eller `failed` (rollback), `partial` kun ved rollback-fejl med fuld log. |
| **P24** | `batch_nonce` unique-constraint (§8). |
| **P19–P22** | Override-per-model (§7), ikke inkrementel skalering. |
| **P26/P27** | QU-lag med eksplicit log (§5). |

Integrationstests kører **kun** mod grocytest (`assert location.code==='test'`) med `ZZT_`-prefiks +
teardown — samme mønster som `scripts/spike-produktion-grocy.js`.

**Go-live-blokkere (jf. T_PRODUKTION §7):** 0 åbne findings på R1, R3, R5, R6.

---

## 15. Åbne punkter

| Punkt | Status |
|-------|--------|
| `self-production` add + price på Grocy 4.6.0 | ✅ verificeret (spike A) |
| Reversering (undo virker ikke på self-production) | ✅ afklaret → asymmetrisk (spike B, §4) |
| Enhedskost-kilde = fulfillment `costs` (ikke `costprice`) | ⏳ bekræft præcist felt ved kodning (§6) |
| `actual_yield` vs `inventory_auto_deduct`-interaktion | ⏳ verificér separat (T_PRODUKTION §7) — bon forbruger produktet, batch producerer det → ingen dobbelttælling (R1), men test eksplicit |
| Underprodukt uden eget stock-produkt | ⏳ sjælden edge — markér + kræv manuel løsning (§9) |

---

## 16. Byggerækkefølge (anbefalet)

1. Migration 086 + adapter `produceBatch`/`reverseBatch` (returnér tx-id) + QU-lag.
2. `routes/production.js` + saga-state-machine — med unit-tests (mocket adapter) FØR UI.
3. `shared/production_batch.js` mountet i recipe-viewer.
4. T_PRODUKTION-runner: unit først, så grocytest-integration. Grønt på R1/R3/R5/R6 før go-live.

*Grundlag: spike kørt mod grocytest 2026-05-30, `scripts/spike-produktion-grocy.js`.*
