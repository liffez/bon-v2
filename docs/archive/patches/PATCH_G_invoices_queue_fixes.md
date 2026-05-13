# PATCH_G_invoices_queue_fixes.md

> Lukker findings F62, F63, F64 + F65 i `routes/invoices.js`.
> Verificeret af `tests/scripts/run_T_FAKTURERING.js` (60 cases).
>
> Kontekst: T_FAKTURERING første kørsel (13. maj 2026) afdækkede 3 reelle
> bugs i `GET /api/invoices/queue`. F65 er en logisk konsekvens af F64 — fixet
> for F64 fjerner inkonsistensen automatisk.

---

## Findings der lukkes

| # | Symptom | Fix |
|---|---------|-----|
| **F62** | Tilbud (`is_offer=1`) kommer i pending-listen | Tilføj `(b.is_offer = 0 OR b.is_offer IS NULL)` til pending- + done- + doneMonth-querien |
| **F63** | `line_total`-aggregation inkluderer accessory-lines | SUM ekskluderer `is_accessory = 1` (matcher reports.js + dashboard.js konvention) |
| **F64** | BETALT ekskluderet fra done-list (kun FAKTURERET/AFSLUTTET) | Tilføj BETALT til `IN`-listen — matcher doneMonth-querien |
| **F65** | done_count_month INKLUDERER BETALT mens done-list IKKE | Fjernes automatisk når F64 er fixet (begge querier bruger samme set) |

---

## Konvention-tjek: hvorfor ekskluderer vi accessories?

Konventionen er konsistent i hele kodebasen:

| Fil | Linje | Logik |
|-----|-------|-------|
| `routes/dashboard.js` | 481 | `AND bl.is_accessory = 0` — revenue |
| `routes/reports.js` | 561, 576 | `AND bl.is_accessory = 0` — revenue + kategorier |
| `routes/bons.js` | 510, 544, 563 | `AND (is_accessory = 0 OR is_accessory IS NULL)` — total_units |
| `routes/quotes.js` | 392 | Samme — total_units |

Reglen: **`is_accessory=1`-lines hører til UI-gruppering (bestik, servietter)
og indgår IKKE i revenue/aggregat-totaler**. I praksis har accessories
typisk `unit_price=0` da tilbehør er prissat ind i hovedretten.

`invoices.js` afviger fra denne konvention — det rettes med F63-fixet.

**`bon.lines[]`-arrayet beholdes komplet** (inkl. accessories) så frontend
fortsat kan vise dem i en separat sektion under hovedretterne.

---

## Ændringer i `routes/invoices.js`

### F62: Tilføj is_offer-filter til alle 3 querier

**Pending-query (linje 87-89):**
```sql
WHERE sd.code = 'LEVERET'
  AND b.payment_type = 'invoice'
  AND (b.is_offer = 0 OR b.is_offer IS NULL)
ORDER BY b.delivery_date ASC
```

**Done-query (linje 127-129):**
```sql
WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
  AND b.payment_type = 'invoice'
  AND (b.is_offer = 0 OR b.is_offer IS NULL)
  AND b.delivery_date >= date(?, '-60 days')
```

**DoneMonth-query (linje 147-149):**
```sql
WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
  AND b.payment_type = 'invoice'
  AND (b.is_offer = 0 OR b.is_offer IS NULL)
  AND b.delivery_date >= ?
```

### F63: Ekskludér accessories fra line_total SUM

**Pending-loop (linje 99-102):**
```javascript
for (const bon of pending) {
    bon.lines = lineStmt.all(bon.id);
    bon.line_total = bon.lines
        .filter(l => !l.is_accessory)
        .reduce((sum, l) => sum + (l.line_total || 0), 0);
}
```

**Done-subquery (linje 118):**
```sql
(SELECT SUM(bl3.line_total) FROM bon_lines bl3
 WHERE bl3.bon_id = b.id
   AND (bl3.is_accessory = 0 OR bl3.is_accessory IS NULL)
) AS line_total
```

**DoneMonth-query (linje 143-144):**
```sql
SELECT COUNT(DISTINCT b.id) AS count,
       COALESCE(SUM(bl.line_total), 0) AS amount
FROM bons b
JOIN status_definitions sd ON sd.id = b.status_id
JOIN bon_lines bl ON bl.bon_id = b.id
WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
  AND b.payment_type = 'invoice'
  AND (b.is_offer = 0 OR b.is_offer IS NULL)
  AND (bl.is_accessory = 0 OR bl.is_accessory IS NULL)
  AND b.delivery_date >= ?
```

### F64 (+ F65): Inkludér BETALT i done-list

**Done-query (linje 127):**
```sql
WHERE sd.code IN ('FAKTURERET','AFSLUTTET','BETALT')
```

DoneMonth-querien indeholder allerede BETALT (linje 147) — ingen ændring
der. Inkonsistensen mellem de to querier forsvinder automatisk.

---

## Test-assertion-opdateringer i `run_T_FAKTURERING.js`

Da fixet ændrer endpointets adfærd, skal de 4 FAIL/SKIP assertions vendes:

| Case | Før | Efter |
|------|-----|-------|
| `T_FAK_PEND_05` | FAIL hvis tilbud i pending | PASS: tilbud filtreret korrekt |
| `T_FAK_LINES_04` | FAIL ved line_total=620 | PASS hvis line_total=600 (accessory ekskluderet) |
| `T_FAK_SUM_03` | FAIL ved bidrag 620 | PASS hvis bidrag 600 |
| `T_FAK_DONE_03` | FAIL hvis BETALT ekskluderet | PASS: BETALT inkluderet i done-list |
| `T_FAK_SUM_07` | SKIP/FAIL (inkonsistens) | PASS: BETALT i begge querier (konsistent) |

Hvor F-bekræftelses-loggen tidligere var "F62 BEKRÆFTET" osv. bliver
PASS-detaljen nu "F62 lukket — tilbud filtreret korrekt" mv. — så
rapporten dokumenterer at fixet virker.

---

## Regression-områder

| Område | Forventet adfærd |
|--------|------------------|
| Tilbud (`is_offer=1` + status=LEVERET) | Tidligere kom i queue. Efter fix: filtreret bort. Tilbud konverteres til bon (`is_offer=0`) inden de når faktureringsflowet — ingen reel UX-regression |
| Accessory-lines (bestik, servietter) | Vises stadig i `bon.lines[]`-arrayet med deres egen pris. Men bidrager IKKE til `bon.line_total` eller `pending_amount`. Hvis accessory har pris > 0 → forskel mellem `bons.total_price` (inkl. accessory via recalcBonTotal) og `bon.line_total` (ekskl.) — dokumentér som ny observation #032 |
| BETALT-bons | Kommer nu med i done-listen — synlige i historikken. Tidligere "forsvandt" de efter status-skift til BETALT, hvilket var forvirrende UX |
| Frontend `office/views/fakturering.js` | Bruger `bon.line_total` til visning. Værdien falder hvis bon havde priced accessories — frontend rendrer korrekt |

---

## Bagvedliggende moms-disciplin (ikke ændret af denne patch)

Patch G rører IKKE `bon.line_total`'s status som INCL-moms-tal. Det er
fortsat udelukkende incl-moms via konventionen i §6b. Modtager (frontend
+ e-conomic-adapter) konverterer selv via `Moms.inclToExcl()` ved behov.

**Mulig følge-observation:** `office/views/fakturering.js:388` labeller
`bon.line_total` som "Sum ekskl. moms" — det er forkert (værdien er INCL).
Foreslås som ny observation #032 (label-bug, ikke ændret her).

---

## Acceptance-tests (kør efter patch)

```bash
npm run test:reset
npm run test:server  # i baggrund
npm run test:run-fakturering
# Forventet: 60 PASS · 0 FAIL · 0 SKIP

npm run test:run-bons-list           # regression
npm run test:run-bon-drawer-core     # regression
npm run test:run-bon-drawer-rel      # regression
npm run test:run-patch-f             # SSE-regression
# Alle skal fortsat være 100% PASS
```

---

*Oprettet: 13. maj 2026 — efter T_FAKTURERING første kørsel.*
