# PATCH_E_partially_approved_status.md (v2 — omskrevet)

> Patch E til Bon v2 — tilføj ny status `'partially_approved'` på
> `goods_receipts` når mindst én item-Grocy-update fejler.
>
> Lukker F33 (status='approved' selv ved partial Grocy-failure).
>
> **v2 omskrevet** efter review mod faktisk kode:
> - E-1: Patch E forudsætter patch A er anvendt (indexeret loop). Tydeliggjort
> - E-2: `grocyResults`-filtrering præciseret med eksempel
> - E-3: Webhook-fix er valgfri (vi læser receipt fresh efter UPDATE i alle tilfælde)
> - E-4: Konkret schema-tjek-instruktion

---

## Forudsætninger

### Patch A SKAL være anvendt først

Patch E ændrer kode i Grocy-loopet (omkring linje 228-263). Patch A
omskrev samme loop fra `for (const item of items)` til indexeret
`for (let i = 0; i < items.length; i++)` for at fixe F35.

Hvis patch A IKKE er anvendt, vil find-blokken i E ikke matche koden —
ELLER E vil overskrive A's fix. Verificér før E anvendes:

```bash
grep "for (let i = 0; i < items.length; i++)" routes/goods-receipts.js
# Skal returnere mindst 1 linje. Hvis 0, anvend patch A først.

grep "const itemId = itemIds\[i\]" routes/goods-receipts.js
# Skal returnere 1 linje. Hvis 0, patch A er ikke anvendt korrekt.
```

### Schema-tjek for CHECK-constraint

Tjek om migration er nødvendig:

```bash
sqlite3 data/test.db ".schema goods_receipts" | grep -A1 status | head -5
```

**Hvis output viser `status TEXT` uden CHECK** → ingen migration nødvendig.
Patch'en virker out-of-the-box.

**Hvis output viser `CHECK (status IN ('pending', 'approved', ...))`** →
migration 060 skal med (template nedenfor).

Realistisk er det førstnævnte i Bon v2 — de fleste tabeller bruger fri tekst
til status. Men bekræft før patch.

---

## Hvad patch'en gør

### Server-side
Efter Grocy-loopet (trin 4) — tæl items hvor `shouldAddStock=true` men
addStock fejlede. Hvis count > 0, UPDATE goods_receipts SET
status='partially_approved'.

### Response
`status` re-læses fra DB efter UPDATE, så API'et returnerer den faktiske
værdi (kan være `'approved'` eller `'partially_approved'`). Nyt felt
`grocy_failure_count` tilføjes.

### Webhook
Webhook læser allerede `receiptRow` fra DB efter trin 4-5 (linje 305 i nuværende kode). Ingen ændring nødvendig — den får automatisk den nye status.

---

## Ændring 1 af 2 — Migration (BETINGET)

**Spring over hvis** `goods_receipts.status` ikke har CHECK-constraint.

Hvis CHECK findes:

```sql
-- db/migrations/060_partially_approved_status.sql
-- Tilføj 'partially_approved' som tilladt status på goods_receipts.

BEGIN;

-- Læs nuværende schema, tilføj 'partially_approved' til CHECK-listen.
-- Kopier struktur fra eksisterende — denne template skal udfyldes med
-- faktiske kolonner fra ".schema goods_receipts"-output.

CREATE TABLE goods_receipts_new (
    -- [paste alle kolonner fra eksisterende schema her]
    -- ...
    -- og opdatér status-linjen til:
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'partially_approved', 'rejected')),
    -- ...
);

INSERT INTO goods_receipts_new SELECT * FROM goods_receipts;

DROP TABLE goods_receipts;
ALTER TABLE goods_receipts_new RENAME TO goods_receipts;

-- Genskab indexes
-- [paste fra ".schema goods_receipts"-output]

COMMIT;
```

**Vigtigt:** Templaten skal udfyldes med faktisk schema. Kør først
`sqlite3 data/test.db ".schema goods_receipts" > schema.sql` og brug den
som basis.

Hvis ingen CHECK findes (det forventede), spring migration over.

---

## Ændring 2 af 2 — Server-side: sæt status efter Grocy-loop

Patch A har omskrevet Grocy-loopet til indexeret form. Vi indsætter status-
opdatering EFTER for-loopet og FØR foto-rename (trin 5).

### Find (efter patch A er anvendt — afslutning af for-loopet, omkring linje 295):

```javascript
        // Shopping list cleanup
        if (item.shopping_list_id) {
            // ... shopping list cleanup logik
        }
    }

    // 5. Omdøb foto hvis det er en temp-fil
    if (photo_path && photo_path.includes('vr-tmp-')) {
        // ... foto-rename logik (incl. patch A's null-fix)
    }
```

### Tilføj imellem trin 4 (Grocy-loop) og trin 5 (foto-rename):

```javascript
    }
    // ^ slutning af for-loopet

    // 4b. Hvis nogen items fejlede i Grocy (vi prøvede, men addStock returnerede fejl),
    // markér receipt'en som 'partially_approved'.
    //
    // grocyResults entries:
    //   {grocy_added: true,  error: null}             → succes
    //   {grocy_added: false, error: <msg>}            → FEJL (vi prøvede, ramte op)
    //   {grocy_added: false, error: null, skipped: true} → bevidst skip (no pid, missing, 0 qty)
    //
    // 'partially_approved' triggeres KUN af reelle fejl, ikke bevidste skips.
    const grocyFailures = grocyResults.filter(
        r => r.grocy_added === false && r.skipped !== true
    );

    if (grocyFailures.length > 0) {
        db.prepare(
            `UPDATE goods_receipts SET status = 'partially_approved' WHERE id = ?`
        ).run(receiptId);
        console.warn(
            `[goods-receipts] Receipt ${receiptId} markeret partially_approved — ` +
            `${grocyFailures.length}/${items.length} items fejlede i Grocy`
        );
    }

    // 5. Omdøb foto hvis det er en temp-fil
    if (photo_path && photo_path.includes('vr-tmp-')) {
```

### Opdater response-objektet — find (omkring linje 320):

```javascript
    // 7. Response
    res.json({
        id: receiptId,
        receipt_number: receiptNumber,
        status: 'approved',
        grocy_results: grocyResults,
        webhook_sent: true,         // bevares for klient-kompatibilitet (patch A)
        webhook_dispatched: true    // korrekt navn (patch A)
    });
```

### Erstat med:

```javascript
    // 7. Response — re-fetch status så vi returnerer den faktiske værdi
    // (kan være 'approved' eller 'partially_approved' alt efter Grocy-resultater)
    const finalRow = db.prepare(
        `SELECT status FROM goods_receipts WHERE id = ?`
    ).get(receiptId);

    res.json({
        id: receiptId,
        receipt_number: receiptNumber,
        status: finalRow.status,
        grocy_results: grocyResults,
        grocy_failure_count: grocyFailures.length,
        webhook_sent: true,
        webhook_dispatched: true
    });
```

---

## Webhook — automatisk korrekt (ingen ændring nødvendig)

Den eksisterende webhook-blok læser `receiptRow` fra DB efter eventuelt
UPDATE (linje 305-309 i nuværende kode efter patch A):

```javascript
    // 6. Fire-and-forget webhook
    const userName = receiverName || 'Ukendt';
    const receiptRow = db.prepare(`SELECT * FROM goods_receipts WHERE id = ?`).get(receiptId);
    webhook.send(receiptRow, userName).catch(...);
```

Bemærk at `receiptRow` re-fetches på linje 307. Vores nye 4b-blok har
allerede sat `status='partially_approved'` (hvis relevant) FØR denne
re-fetch. Så `receiptRow.status` indeholder den faktiske værdi automatisk —
ingen patch nødvendig på webhook-side.

Verificér ved manuel test (se §Verificering nedenfor).

---

## Test-cases der skal opdateres

### Eksisterende cases at justere

**T_VAREMOD_FAIL_04** i `T_VAREMODTAGELSE_FULL.md`:

```diff
- | **T_VAREMOD_FAIL_04** | Receipt-status er stadig 'approved' (hardcoded ved INSERT) |
-   Selvom Grocy delvist fejlede, er Bon v2 status='approved'. Dokumentér som finding F33 |
+ | **T_VAREMOD_FAIL_04** | Receipt-status='partially_approved' ved partial Grocy-fail |
+   Når mindst én item har grocy_added=0 og ikke er skipped, UPDATE'es status. Response viser den nye værdi |
```

### Nye cases til `T_PATCH_E_REGRESSION` (eller integreret i T_VAREMOD_FULL):

```
T_PATCH_E_01: 3 items alle OK → status='approved', grocy_failure_count=0
T_PATCH_E_02: 3 items, 1 fejler i Grocy (invalid pid) → status='partially_approved',
              grocy_failure_count=1
T_PATCH_E_03: 3 items, alle fejler → status='partially_approved', grocy_failure_count=3
              (IKKE 'rejected' — 'rejected' er reserveret til afviste leverancer,
              ikke Grocy-fejl)
T_PATCH_E_04: 3 items, 1 har grocy_product_id=null (skipped) → status='approved',
              grocy_failure_count=0 (skipped tæller ikke som failure)
T_PATCH_E_05: Mix: 1 OK + 1 fejler + 1 skipped → status='partially_approved',
              grocy_failure_count=1
T_PATCH_E_06: status='missing' med qty>0 → skipped (per shouldAddStock logik) →
              tæller IKKE som Grocy-failure. status forbliver 'approved'
T_PATCH_E_07: Response.status matcher DB.status (re-fetch verifikation)
T_PATCH_E_08: Webhook payload har korrekt status (mock-tjek)
```

T_PATCH_E_04 og T_PATCH_E_06 er **vigtige edge-cases** der adskiller
"reelt fejlede" fra "bevidst skipped". Hvis disse to passer, er filtreringen
korrekt.

---

## Verificering efter patch

### 1. Regression

```bash
npm run test:reset
npm run test:server &

# Alle eksisterende tracks skal stadig PASS
npm run test:run-varemod-patch      # 26/26
npm run test:run-varemod-full       # 59/59 (T_VAREMOD_FAIL_04 justeret)

# Patch E's nye tests
npm run test:run-patch-e            # 8/8 forventet
```

### 2. Manuel verifikation — partial-fail med invalid pid

```bash
curl -X POST http://localhost:4322/api/goods-receipts \
  -H "Content-Type: application/json" -H "Cookie: <test-session>" \
  -d '{
    "supplier_name": "Patch E Test",
    "received_by_name": "Test",
    "items": [
      {"grocy_product_id": 28, "product_name": "Spinat", "received_quantity": 2, "status": "ok"},
      {"grocy_product_id": 999999, "product_name": "Invalid pid", "received_quantity": 1, "status": "ok"},
      {"grocy_product_id": 1, "product_name": "Brød Rug", "received_quantity": 1, "status": "ok"}
    ]
  }'

# Response forventet:
# {
#   "id": <N>,
#   "receipt_number": "VR-2026-NNN",
#   "status": "partially_approved",    ← ikke 'approved'!
#   "grocy_results": [...],
#   "grocy_failure_count": 1,
#   "webhook_sent": true,
#   "webhook_dispatched": true
# }

# DB-tjek:
sqlite3 data/test.db "SELECT status FROM goods_receipts WHERE supplier_name='Patch E Test'"
# Forventet: partially_approved

# Webhook-tjek (hvis mock kører):
# Mock-payload.status = 'partially_approved' (re-læst korrekt)
```

### 3. Manuel verifikation — bevidste skips tæller ikke

```bash
curl -X POST http://localhost:4322/api/goods-receipts \
  -d '{
    "supplier_name": "Skip Test",
    "received_by_name": "Test",
    "items": [
      {"product_name": "Manuel vare (ingen grocy)", "received_quantity": 2, "status": "ok"},
      {"grocy_product_id": 28, "product_name": "Spinat", "received_quantity": 2, "status": "ok"}
    ]
  }'

# Første item har ingen grocy_product_id → skipped: true
# Andet item lykkes → grocy_added: true
# Forventet: status='approved' (ikke partially_approved — skipped tæller ikke)
# grocy_failure_count: 0
```

---

## Konsekvenser for UI (fremtidigt arbejde)

Når patch E er anvendt, kan UI'en udvides til at:

1. **Receipt-liste** (Fase 3): vis ⚠️-badge ved `status='partially_approved'`
2. **Receipt-detalje**: per-item ✓/✗ + `grocy_error`-tekst
3. **"Genprøv Grocy"-knap** på partial receipts: trigger retry-flow (senere)

Ingen del af denne patch — kun server-foundation.

---

## Markering i TEST_OBSERVATIONS

```markdown
### F33 — status='approved' selv ved partial Grocy-failure (lukket)
| | |
|--|--|
| **Beslutning** | B (Leif, maj 2026) — tilføj 'partially_approved'-status |
| **Status** | `lukket` |
| **Fix** | `PATCH_E_partially_approved_status.md` v2 — server tæller grocy_failures (excl. skipped) og UPDATE'er status. Response re-fetcher status. Webhook læser automatisk korrekt værdi |
```

---

## v1 → v2 lektioner

1. **Forudsætning-tracking** — patches der bygger på hinanden bør have
   eksplicitte forudsætnings-checks (grep-kommando der verificerer at
   tidligere patch er anvendt)
2. **Migration kun hvis nødvendigt** — vi har en tendens til at antage
   constraints. Tjek schema først, og spring migration over hvis koden
   tillader fri tekst
3. **Re-læs altid DB efter UPDATE** — i stedet for at antage værdier i
   variabler. Det er hvad eksisterende kode gør (webhook læser receiptRow
   efter alle muligvis-skrivninger) og det fanger automatisk patch-
   ændringer der opdaterer rækker

---

## Rollback

```sql
UPDATE goods_receipts SET status = 'approved' WHERE status = 'partially_approved';
```

Derefter `git revert <commit-sha>`. Migration 060 (hvis kørt) skal håndteres
separat — SQLite DROP COLUMN er begrænset, så restore fra backup hvis nødvendigt.

---

*v2 oprettet: maj 2026 — efter review af faktisk kode bekræftede at
webhook re-læser receiptRow efter UPDATE'er. Ingen webhook-patch nødvendig.*
