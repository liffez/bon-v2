# CLAUDE_PRODUKTION_MVP.md — Produktionsbatch (let MVP)

> Læs FØR kode: CLAUDE.md, BON_V2_PRINCIPPER.md (moms-doktrin §6b+6c), bon_v2_datamodel_v2.md.
> Relaterede docs: `docs/CLAUDE_PRODUKTION.md` (beslutning), `docs/CLAUDE_PRODUKTION_IMPL.md`
> (fuld spec m. saga + reversering), `docs/T_PRODUKTION.md` (testspor).
>
> **Dette er det trimmede MVP.** Den fulde IMPL-spec er korrekt, men tung. MVP'en rammer 90 % af
> smerten med ~30 % af arbejdet. Reversering, saga-state-machine og afvigelses-historik bygges
> KUN hvis MVP'en viser sig for tynd. Status: **klar til implementering.**

---

## 1. Problem (én sætning)

RR Produktion-opskrifter (sylt, stegt kylling, falafelmasse) afviger ofte på produktionsdagen — en
råvare var sluppet op, man kom for meget i, man byttede — men man vil **ikke** ændre originalopskriften.
Lagertrækket bliver forkert hvis det følger masteren i stedet for det faktiske.

**Mental model: en "log-opskrift" / batch record (som BeerSmith's brew session).** Opskriften er en
immutabel skabelon; hver produktion er en *kopi* med dagens faktiske tal. Skabelonen røres aldrig.

---

## 2. Kerne-indsigt: MVP'en rører ALDRIG Grocys recipe-consume

Grocys `POST /recipes/{id}/consume` er alt-eller-intet: mangler én råvare på lager → hele trækket
blokeres. Det er præcis afvigelses-dagen. Derfor driver MVP'en **hvert lagertræk manuelt**:

```
for hver råvare med faktisk_mængde > 0:
    POST /stock/products/{id}/consume   { amount: faktisk_mængde_i_stockenhed, transaction_type:'consume', spoiled:false }
til sidst:
    POST /stock/products/{producedId}/add
        { amount: faktisk_udbytte, transaction_type:'self-production', price, best_before_date }
```

- Grocy får aldrig en opskrift at "følge" → ingen alt-eller-intet-regel rammer os.
- "Råvaren manglede" = faktisk_mængde 0 = **intet consume-kald** → kan ikke blokere (det LETTE tilfælde).
- Self-production add lægger færdigvaren på lager **uden** recipe-validering (verificeret i
  `scripts/spike-produktion-grocy.js`, Grocy 4.6.0).

**Eneste reelle kant:** consume mere end på lager (kom for meget i + lavt lager) → Grocy kan blokere.
MVP-regel: forsøg trækket; ved Grocy-fejl på en linje → marker linjen, fortsæt de øvrige, vis advarsel.
Ingen rollback i MVP (se §7).

---

## 3. Hvad vi opgiver ved at gå manuelt (og hvorfor det er ok)

| Mister fra recipe-consume | Erstatning |
|---------------------------|------------|
| Auto-beregnet produkt-pris | Vi sætter `price` eksplicit (spike bekræftede det virker) — §5 |
| Grocys opskrifts-sporbarhed (produkt ← råvarer) | Bon v2's batch-record holder linket, mere præcist |
| Atomicitet (ét kald) | MVP accepterer ikke-atomisk + idempotens-vagt (§6). Fuld saga = senere |

---

## 4. Flow (UI)

Integreret i RR Produktion-opskriftsvisningen (`shared/recipe_viewer.js`), bag en **"Producér"**-knap.
Ingen separat skærm.

```
Åbn "Producér" på en RR Produktion-opskrift
  → alle linjer udfyldt med opskriftens master-tal (= tro kopi)
  → felt "Faktisk udbytte" forudfyldt med planlagt yield (1000 g × portioner)

INTET afveg?  → tryk "Producér som planlagt"  → færdig (90 % af gangene, nul ekstra arbejde)

Afveg noget?  → justér de 1-2 linjer:
     • "manglede"   → sæt til 0   (markeres som udeladt; kan lægges på indkøbsliste — §8)
     • "for meget"  → stepper op / skriv tal
     • "byttede"    → sæt original til 0 + tilføj erstatningsvare (søg Grocy)
  → ret "Faktisk udbytte" hvis svind (fx 870 g i stedet for 1000)
  → tryk "Producér batch (N ændringer)"
```

- **Portioner:** 1 portion = 1 kg færdigvare. Skalerer master + faktiske tal + udbytte proportionalt.
  Decimaler tilladt (1,3). Brug override-per-modellen fra IMPL §7 (gem afvigelse ved 1-portions-basis,
  beregn `actual = (override_per ?? per) × portioner` on the fly) — IKKE inkrementel `actual *= factor`
  (giver rundingsdrift).
- **Decimal-parse:** accepter både "1,3" og "1.3".
- Toggle/redigering rører ALDRIG data — produktion sker kun ved eksplicit klik på produktions-knappen.
- Metode-tekst vises read-only under linjerne.

---

## 5. Pris (R3, blokerende) — én formel, ex moms

```
faktisk_batch_kost     = Σ (faktisk_mængde_i_stockenhed × enhedskost_i_stockenhed)   // inkl. byttede + tilføjede
price_pr_produceret_enhed = faktisk_batch_kost / faktisk_udbytte                       // kr/stock-enhed, ex moms
```

- **Enhedskost fra SAMME kilde som resten af systemet:** Grocy fulfillment `costs` (ikke `costprice`
  userfield — jf. CLAUDE.md). Bekræft præcist felt ved kodning.
- **Ex moms.** Ingen `* 1.25` / `/ 1.25` — råvarekost er allerede ex moms i Grocy. Pre-commit-hook
  håndhæver det. Brug `shared/moms.js` hvis der overhovedet skal momses noget (det skal der ikke her).
- `faktisk_udbytte` ≠ ingrediens-vægt: prisen koncentreres ved svind (921 g ingrediens → 870 g udbytte
  → højere kr/g). Korrekt og bevidst.

---

## 6. QU-konvertering + idempotens (R6 + R7, blokerende)

**QU (R6 — samme klasse som 28%-cost-bug'en):**
- `recipes_pos.amount` er allerede i stock-enhed (verificeret). Manuelt indtastede actuals + tilføjede
  varer indtastes i display-enhed og **skal konverteres** før consume/add.
- Konvertér ÉT sted, server-side, via `quConvert.findConversionFactor(...)`. Stol aldrig på display-enheden.
- Log konverteringen pr. linje: `"RAW_A: 250 g → 0,250 kg (faktor 0.001)"`.
- Produkt uden konvertering hvor display≠stock → fejl kontrolleret, producér ikke.

**Idempotens (R7):**
- Klient genererer `batch_nonce` (UUID) ved åbning af produktions-tilstand; sendes med produktions-kaldet.
- Server: unique-constraint på `production_batches.batch_nonce`. Dobbelt-submit → 2. kald returnerer
  den allerede-oprettede batch i stedet for at trække igen (spejler `autoConsumeBonInventory`'s
  `inventory_deducted`-vagt).

---

## 7. Bevidst UDE af MVP (kommer i fuld IMPL hvis nødvendigt)

| Udeladt | Hvorfor ok i MVP | Hvis det bider |
|---------|------------------|----------------|
| Reversering / fortryd batch | Sjældent. Forkert batch rettes ved næste optælling (`inventory_check`) | Byg `reverseBatch` (IMPL §4, asymmetrisk) |
| Saga-state-machine m. rollback | MVP markerer fejlede linjer + advarer; trækker ikke halvt tavst (linje-status synlig) | Byg saga (IMPL §3) |
| Afvigelses-historik/analyse-UI | `production_batch_consumption` GEMMER allerede planned vs actual → data findes til senere | Byg view oven på eksisterende data |
| `partial`-genopretnings-UI | MVP-fejl er pr. linje + synlig straks | Byg `partial`-liste |

**MVP gemmer fuld data** (planned_qty, actual_qty, deviation_reason, grocy_transaction_id, unit_cost) —
så food-cost/svind-analyse + reversering kan bygges senere UDEN datatab. Vi bygger bare ikke UI'et nu.

---

## 8. Indkøbsliste-kobling (ny — Leifs idé)

Linjer markeret "manglede" (faktisk = 0, deviation_reason = 'udeladt') er signalet om at genbestille.

- Efter vellykket produktion: vis "Læg manglende råvarer på indkøbsliste?" med de udeladte linjer
  forudvalgt.
- Bekræft → `POST /api/grocy/shopping-list/add-product` pr. valgt råvare (genbruger eksisterende
  indkøbs-endpoint — ingen ny route).
- Mængde: master-mængden for linjen (det du *skulle* have brugt) som rimeligt gæt; brugeren kan justere
  i indkøbsvisningen som normalt.
- Valgfrit, ikke-blokerende. Springes der over, sker intet.

---

## 9. Datamodel — migration `086_production_batches.sql`

Samme tabeller som IMPL §10 (så MVP→fuld er rent additivt — ingen migration to gange). MVP bruger bare
ikke alle state-værdier endnu.

```sql
CREATE TABLE production_batches (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  grocy_recipe_id INTEGER NOT NULL,
  grocy_output_product_id INTEGER NOT NULL,
  portions REAL NOT NULL DEFAULT 1,
  planned_output_qty REAL NOT NULL,
  actual_output_qty REAL,
  output_unit TEXT NOT NULL,
  batch_nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft','produced','failed','partial','reversed')),  -- MVP bruger draft/produced/partial
  produce_transaction_id TEXT,
  master_cost REAL,    -- Σ master×enhedskost, ex moms (reference til svind-analyse)
  actual_cost REAL,    -- Σ actual×enhedskost, ex moms (= price×yield)
  notes TEXT,
  produced_at TEXT, produced_by_user_id INTEGER,
  reversed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE production_batch_consumption (
  id INTEGER PRIMARY KEY,
  production_batch_id INTEGER NOT NULL REFERENCES production_batches(id) ON DELETE CASCADE,
  grocy_product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,            -- snapshot
  planned_qty REAL NOT NULL,             -- master × portioner (0 = ikke i opskrift)
  actual_qty REAL NOT NULL,              -- reelt brugt, stock-enhed (0 = udeladt)
  unit TEXT NOT NULL,
  deviation_reason TEXT
    CHECK (deviation_reason IN ('justeret','udeladt','byttet','tilfoejet','spild') OR deviation_reason IS NULL),
  substitute_for_product_id INTEGER,
  grocy_transaction_id TEXT,             -- NULL hvis actual=0 (intet kald)
  unit_cost REAL,                        -- ex moms, snapshot fra Grocy fulfillment
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pbc_batch ON production_batch_consumption(production_batch_id);
```

---

## 10. Adapter — `services/grocyAdapter.js`

```
produceBatch({ consume: [{productId, amount}], produce: {productId, amount, price} })
   → sekventielle consumes (returnér transaction_id pr. linje) + self-production add
   → returnerer { state:'produced'|'partial', consumeTx:[{productId, transactionId}], produceTx, failedLines:[] }
```

- **Udvid `consumeProduct` + `addToStockFull` så de returnerer Grocy-svarets `transaction_id`**
  (de smider det væk i dag — verificeret). Spiken viste det ligger på `svar[0].transaction_id`.
- Consumes køres **sekventielt** (ikke `Promise.all`) så fejlede linjer er kendte.
- Ryd `_cache.delete('stock')` efter writes (eksisterende mønster).

---

## 11. Route — `routes/production.js` (mountes i server.js)

```
POST   /api/production/batches    { recipe_id, portions, lines[], actual_yield, batch_nonce, notes,
                                     add_missing_to_shopping_list: bool }
GET    /api/production/batches?recipe_id=&from=&to=     → historik (til senere analyse-UI)
GET    /api/production/batches/:id                      → detalje inkl. consumption-linjer
```

- `requireAuth()`. Changelog skrives af serveren (aldrig frontend). SSE `production_batch_created`.
- Validering server-side: portioner > 0, actual_yield > 0, alle product_id findes, location aktiv.
- QU-konvertering sker HER (server-side), før adapter-kald.

---

## 12. UI-modul — `shared/production_batch.js` (+ `.css`)

- Eget fokuseret modul som `recipe_viewer.js` *mounter* når "Producér" åbnes (recipe_viewer svulmer ikke).
- Operationer: justér (stepper), fjern (→0), byt (original→0 + parret ny linje), tilføj vare (søg Grocy),
  faktisk udbytte (ét felt).
- Knap: "Producér som planlagt" → "Producér batch (N ændringer)" når diff ≠ 0.
- Efter succes: indkøbsliste-prompt (§8) + toast med per-linje Grocy-resultat.

---

## 13. Go-live-blokkere

0 åbne fejl på: **R1** (dobbelttælling — verificér at menu-opskrifter forbruger mellemproduktet, ikke
råvaren, i jeres rigtige Grocy), **R3** (pris ex moms fra fulfillment), **R6** (QU-konvertering).
R5 (atomicitet/reversering) er nedgraderet i MVP — linje-fejl er synlige, ikke tavse.

**Re-kør spiken mod prod-Grocy (`grocycafe`) før go-live** — self-production-adfærd er instans-/versionsafhængig.

---

## 14. Byggerækkefølge

1. Migration 086 + adapter `produceBatch` (returnér tx-id) + QU-lag — med unit-tests (mocket adapter).
2. `routes/production.js` + server-validering + idempotens-vagt.
3. `shared/production_batch.js` mountet i recipe-viewer + indkøbsliste-kobling.
4. T_PRODUKTION-runner (delmængde: P5–P15, P19–P22, P24, P26–P30). Grønt på R1/R3/R6 før go-live.

*Grundlag: spike kørt mod grocytest 2026-05-30 (`scripts/spike-produktion-grocy.js`).*
