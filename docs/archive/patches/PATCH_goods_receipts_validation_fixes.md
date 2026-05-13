# PATCH_goods_receipts_validation_fixes.md

> Patch B til `routes/goods-receipts.js` — tre relaterede validation- og
> klamping-fixes opdaget under T_VAREMODTAGELSE_FULL-kørsel.
>
> Bygger oven på patch A (kritiske fixes). Alle tre er små, isolerede
> ændringer der hører naturligt sammen: input-validation og state-konsistens.
>
> F33 (status='approved' ved partial Grocy-failure) hører IKKE til denne
> patch — det er en designdiskussion der tages separat.

---

## Sammenfattende

| # | Finding | Type | Fix |
|---|---|---|---|
| **F40** | `cool_enabled=true` uden `cool_value` crasher | Bug (5xx) | Eksplicit null-fallback: `value ?? null` |
| **F37** | `goods_receipt_items.product_name` NOT NULL crasher til 500 | UX-bug | Tilføj validation før INSERT |
| **F41** | `has_deviation=false` men type/note bevares | Konsistens-bug | Klamp type/note til null når has_deviation=false |

Alle tre er bagudkompatible — klienter der i forvejen sender korrekte data er
upåvirket. Klienter der lever af løs input-validation får nu pænere fejl-
beskeder eller konsistente DB-rækker.

---

## Patchen består af 3 ÆNDRINGER i samme fil

### Ændring 1 af 3 — F40: Null-fallback på temperature_value

**Problem:** Hvis `temperature_cool_enabled=true` men `temperature_cool_value`
mangler eller er `undefined`, videregives `undefined` til `db.prepare().run()`.
node:sqlite kaster en fejl fordi den ikke accepterer `undefined` som parameter
— kun `null`, tal eller strenge.

Resultat: 5xx-fejl, ingen receipt oprettet, counter rulles tilbage (transaktion
fanger det). UI'en ser bare en uforklarlig crash.

**Fix:** Brug `?? null`-operator så `undefined` eksplicit bliver til `null`.

**Find** (omkring linje 190–195 i `routes/goods-receipts.js` efter Patch A):

```javascript
        temperature_cool_enabled ? 1 : 0,
        temperature_cool_enabled ? temperature_cool_value : null,
        temperature_cool_enabled ? (temperature_cool_ok ? 1 : 0) : null,
        temperature_frozen_enabled ? 1 : 0,
        temperature_frozen_enabled ? temperature_frozen_value : null,
        temperature_frozen_enabled ? (temperature_frozen_ok ? 1 : 0) : null,
```

**Erstat med:**

```javascript
        temperature_cool_enabled ? 1 : 0,
        temperature_cool_enabled ? (temperature_cool_value ?? null) : null,
        temperature_cool_enabled ? (temperature_cool_ok ? 1 : 0) : null,
        temperature_frozen_enabled ? 1 : 0,
        temperature_frozen_enabled ? (temperature_frozen_value ?? null) : null,
        temperature_frozen_enabled ? (temperature_frozen_ok ? 1 : 0) : null,
```

**Hvorfor `??` og ikke `||`:**
`temperature_cool_value || null` ville klampe `0` (gyldig temperatur) til `null`.
Ikke godt for et kølerum der lige er 0°C. `??` rammer kun `undefined` og `null`.

---

### Ændring 2 af 3 — F37: Validation på items[].product_name

**Problem:** `goods_receipt_items.product_name` er NOT NULL. Hvis et item
mangler `product_name` (tom, undefined, null), kaster `insertItem.run()` en
SQLite constraint error → 500. UI får ingen meningsfuld feedback.

**Fix:** Validér før INSERT — gå alle items igennem og afvis med 400 hvis
nogen mangler `product_name`.

**Find** (omkring linje 137–141 i `routes/goods-receipts.js` efter Patch A —
eksisterende validation-blok):

```javascript
    if (!supplier_name) return res.status(400).json({ error: 'supplier_name er påkrævet' });
    if (!received_by_name && !received_by_user_id) return res.status(400).json({ error: 'received_by_name er påkrævet' });
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] er påkrævet' });
    }
```

**Erstat med:**

```javascript
    if (!supplier_name) return res.status(400).json({ error: 'supplier_name er påkrævet' });
    if (!received_by_name && !received_by_user_id) return res.status(400).json({ error: 'received_by_name er påkrævet' });
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items[] er påkrævet' });
    }

    // Validér at alle items har product_name (NOT NULL constraint)
    for (let i = 0; i < items.length; i++) {
        const name = items[i]?.product_name;
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({
                error: `items[${i}].product_name er påkrævet`
            });
        }
    }
```

**Note:** Validation kommer FØR `nextReceiptNumber()` (som de øvrige checks),
så counter ikke incrementeres ved fejl.

---

### Ændring 3 af 3 — F41: Klamping af deviation_type/note ved has_deviation=false

**Problem:** Hvis klient sender `has_deviation=false` men også sender
`deviation_type='temperatur'` og `deviation_note='for varm'`, persisterer
type og note i DB selvom has_deviation-flag siger der ikke er en afvigelse.
Inkonsistent state.

**Fix:** Klamp deviation_type og deviation_note til null når
has_deviation=false. Samme mønster som koden allerede bruger for
temperature-felterne (`enabled ? value : null`).

**Find** (omkring linje 199–201 i `routes/goods-receipts.js` efter Patch A):

```javascript
        has_deviation ? 1 : 0,
        deviation_type || null,
        deviation_note || null,
```

**Erstat med:**

```javascript
        has_deviation ? 1 : 0,
        has_deviation ? (deviation_type || null) : null,
        has_deviation ? (deviation_note || null) : null,
```

**Bemærk:** Vi beholder `|| null`-fallback inde i den ydre ternary, så tomme
strenge stadig bliver til `null` selv når `has_deviation=true`. Det matcher
koden's eksisterende konvention og forbliver bagudkompatibelt.

---

## Verificering efter patch

### 1. Regression — eksisterende tests

```bash
npm run test:reset
npm run test:server &

# Patch A's regression — F30/F31/F32/F35-fixes
npm run test:run-varemod-patch    # forventet: 26/26

# T_VAREMODTAGELSE_FULL — patch B's fixes bliver verificeret her
npm run test:run-varemod-full     # forventet: 59/59 (eller bedre — F40 var "OBSERVERET BUG" og PASSER nu med korrekt adfærd)

# Øvrige tracks der rører goods-receipts ikke-eksisterende, men bør stadig kunne køre
npm run test:run-stock            # forventet: 31/31
npm run test:inv                  # forventet: 13/13
```

**Forventet ændring i T_VAREMODTAGELSE_FULL:** F40-case'en ændrer status fra
"OBSERVERET BUG" (verificerer at koden crasher) til **forventet pæn adfærd**
(200, cool_value=null i DB). Spec'en skal opdateres som del af patch B —
eller test-case'en kan beholdes som regression-tjek (verifier nu det modsatte
af det den verificerede før). Anbefales: opdatér til regression-form.

### 2. F40-specifik manuel verifikation

```bash
# POST med cool_enabled=true men UDEN cool_value
curl -X POST http://localhost:4322/api/goods-receipts \
  -H "Content-Type: application/json" \
  -H "Cookie: <test-session>" \
  -d '{
    "supplier_name": "F40 Test",
    "received_by_name": "Test",
    "temperature_cool_enabled": true,
    "temperature_cool_ok": true,
    "items": [{
      "product_name": "Test Vare",
      "received_quantity": 1,
      "status": "ok"
    }]
  }'

# Før patch B: 500 server error
# Efter patch B: 200, receipt oprettet med temperature_cool_value=NULL i DB

# Tjek DB:
sqlite3 data/test.db "SELECT temperature_cool_value FROM goods_receipts WHERE supplier_name='F40 Test'"
# Forventet: (empty / null)
```

### 3. F37-specifik manuel verifikation

```bash
# POST med item uden product_name
curl -X POST http://localhost:4322/api/goods-receipts \
  -d '{
    "supplier_name": "F37 Test",
    "received_by_name": "Test",
    "items": [{
      "grocy_product_id": 28,
      "received_quantity": 2,
      "status": "ok"
    }]
  }'

# Før patch B: 500 (SQLite constraint error)
# Efter patch B: 400 "items[0].product_name er påkrævet"

# Verificér også at counter IKKE er øget:
sqlite3 data/test.db "SELECT value FROM settings WHERE key='goods_receipt_number_next'"
# Skal være uændret før og efter POST'en
```

### 4. F41-specifik manuel verifikation

```bash
# POST med has_deviation=false men type/note sat
curl -X POST http://localhost:4322/api/goods-receipts \
  -d '{
    "supplier_name": "F41 Test",
    "received_by_name": "Test",
    "has_deviation": false,
    "deviation_type": "skulle-ikke-gemmes",
    "deviation_note": "skulle-heller-ikke-gemmes",
    "items": [{"product_name": "X", "received_quantity": 1, "status": "ok"}]
  }'

# Tjek DB:
sqlite3 data/test.db "SELECT has_deviation, deviation_type, deviation_note FROM goods_receipts WHERE supplier_name='F41 Test'"

# Før patch B: 0 | skulle-ikke-gemmes | skulle-heller-ikke-gemmes
# Efter patch B: 0 | NULL | NULL
```

---

## Konsekvenser for tests

| Test | Effekt |
|------|--------|
| T_VAREMODTAGELSE_PATCH_REGRESSION | PASS (uændret — rører ikke disse felter) |
| T_VAREMODTAGELSE_FULL — `T_VAREMOD_F_TEMP_06` (F40-case) | **Skal omskrives** fra "verificerer crash (5xx)" til "verificerer null-klamping (200 + DB.cool_value=null)" |
| T_VAREMODTAGELSE_FULL — `T_VAREMOD_F_VAL_06` (F37-case) | **Skal omskrives** fra "verificerer 500" til "verificerer 400 med besked `items[0].product_name er påkrævet`" |
| T_VAREMODTAGELSE_FULL — `T_VAREMOD_F_DEV_02` (F41-case) | **Skal omskrives** — runneren har en eksplicit FAIL-gren der trigges af clamping (`F41 lukket: clamping tilføjet — opdater spec og denne assertion`). Vend assertions så type=null + note=null bliver PASS-grenen |
| T_INVENTORY, T_STOCK, T_INDKOB_* | PASS (uændret — rører ikke goods-receipts) |

### Tests der skal opdateres som del af patch B

Som del af samme PR der lander koden, skal disse spec/runner-ændringer med:

```diff
# tests/specs/T_VAREMODTAGELSE_FULL.md

  | **T_VAREMOD_F_TEMP_06** | cool_enabled=true men cool_value mangler i body |
- cool_value=undefined → DB.cool_value=null. Tjek om validation skal være strengere
- **OBSERVERET BUG (F40)**: koden crasher med 5xx — undefined videregives til node:sqlite
+ F40 lukket (patch B): (value ?? null) klamping → 200 + DB.cool_value=null

  | **T_VAREMOD_F_VAL_06** | POST med item uden product_name |
- Hvad sker der? NOT NULL constraint på product_name? Dokumentér
- **OBSERVERET BUG (F37)**: 500 i stedet for pæn 400
+ F37 lukket (patch B): 400 "items[0].product_name er påkrævet" — counter ikke øget

  | **T_VAREMOD_F_DEV_02** | has_deviation=false + type='other' + note='zombie' |
- Faktisk adfærd: koden clampe IKKE — inkonsistent DB-row
+ F41 lukket (patch B): clamping tilføjet — type=null, note=null trods client-værdier
```

Runneren opdateres tilsvarende så test-cases verificerer den nye adfærd.

---

## Rollback

Alle 3 ændringer er bagudkompatible:
- F40-fix: gør koden mere tolerant overfor undefined input
- F37-fix: tilføjer validation der før gav 500 (intet bryder)
- F41-fix: klamper inkonsistent state (intet bryder for klienter der i forvejen sender korrekte data)

Hvis problemer: `git revert <commit-sha>`.

---

## Markering i TEST_OBSERVATIONS efter patch er anvendt

```markdown
### #022 — temperature_value=undefined crasher receipt-oprettelse (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F40 (maj 2026) |
| **Beskrivelse** | Hvis klient sender `temperature_cool_enabled=true` men ingen `temperature_cool_value`, blev `undefined` videregivet til `db.prepare().run()`. node:sqlite kastede fejl, counter rullede tilbage via transaction. 5xx til klient. |
| **Vurdering** | Bug. Fixed maj 2026 via `PATCH_goods_receipts_validation_fixes.md` — eksplicit `?? null`-fallback. Samme fix anvendt på frozen_value. |
| **Status** | `lukket` |

### #023 — items[].product_name=null gav 500 i stedet for 400 (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F37 (maj 2026) |
| **Beskrivelse** | NOT NULL constraint på `goods_receipt_items.product_name` boblede op som 500 SQLite-fejl. Ingen meningsfuld besked til UI. |
| **Vurdering** | UX-bug. Fixed maj 2026 — validation tilføjet før INSERT med pæn 400-besked. |
| **Status** | `lukket` |

### #024 — has_deviation=false klampede ikke deviation_type/note (lukket)

| | |
|--|--|
| **Kilde** | T_VAREMODTAGELSE_FULL F41 (maj 2026) |
| **Beskrivelse** | Hvis klient sendte `has_deviation=false` men også deviation_type og _note, persisterede de i DB. Inkonsistent state — rækken sagde "ingen afvigelse" men havde alligevel data. |
| **Vurdering** | Konsistens-bug. Fixed maj 2026 — type/note klampes til null når has_deviation=false. Samme mønster som temperature-felterne. |
| **Status** | `lukket` |
```

---

## Status efter patch B er landet

Forventet finding-tabel efter applikation:

| # | Status | Note |
|---|--------|------|
| F26 | LUKKET (patch A) | Counter-bump + INSERTs wrap'et i én transaction. Ruller tilbage ved CHECK- og FK-violations. (Tidligere markeret som "droppet — forkert analyse"; det var en misforståelse — fix'en var en del af Patch A's transaction-wrap) |
| F27 | ÅBEN | Design-diskussion: missing-status + qty>0 |
| F28 | ÅBEN | Design-diskussion: ukendt item-status |
| F29 | ÅBEN | Design-diskussion: over-receive → full delete |
| F30 | LUKKET (patch A) | |
| F31 | LUKKET (patch A) | |
| F32 | LUKKET (patch A) | |
| F33 | ÅBEN | Design-diskussion: status='approved' ved partial Grocy-fail |
| F34 | LUKKET (verificeret) | ACID-test PASS i CONC-cases (3 parallel POST'er får unikke numre, counter +3) |
| F35 | LUKKET (patch A) | |
| F36 | ÅBEN | Design-diskussion: server-side idempotens |
| **F37** | **LUKKET (patch B)** | Validation før INSERT |
| **F40** | **LUKKET (patch B)** | `?? null`-klamping |
| **F41** | **LUKKET (patch B)** | Clamping af deviation_type/note |

**Tilbage som åbne: 5 design-diskussioner** (F27/F28/F29/F33/F36). Ingen
flere "bugs der venter på fix" — kun designvalg der venter på beslutning.

---

*Oprettet: maj 2026 — patch B med 3 validation/klamping-fixes opdaget under
T_VAREMODTAGELSE_FULL første kørsel.*
