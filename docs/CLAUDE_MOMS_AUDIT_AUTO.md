# CLAUDE_MOMS_AUDIT_AUTO.md — Automatiseret moms-audit
> Læs `CLAUDE_MOMS_AUDIT.md` FØRST. Dette dokument er udvidelsen der
> beskriver HVORDAN auditen automatiseres. Området-numrene (#1–#28),
> Tier 1–5 og bug-mønstrene A–D er defineret der og refereres herfra.
> Dato: maj 2026

---

## Formål

`CLAUDE_MOMS_AUDIT.md` definerer HVAD der skal auditeres. Estimatet er
16–21 timer manuelt arbejde.

Denne spec konverterer 24 ud af 28 områder til automatisk kørsel.
Reelt manuelt arbejde reduceres til **~3 timer Leif-tid**:

- 30 min review af Fase 1-rapport
- ~30 min × 3 GO/NO-GO-runder under Fase 2
- ~1 time visuel verifikation efter Fase 3

Resten er Claude Code's arbejde og kører i baggrunden.

---

## Hvilke områder kan automatiseres

| Tier | Områder | Automatiserings-grad |
|------|---------|---------------------|
| 1 | #1–#8 (kunde-vendt) | Fuldt — alle 8 har deterministiske outputs (PDF, mail, e-conomic-payload) der kan parses |
| 2 | #9–#14 (intern visning) | Fuldt — render + parse beløb fra HTML/JSON |
| 3 | #15–#20 (rapporter) | Fuldt — samme mønster |
| 4 | #21–#24 (indkøb) | Fuldt — assertion mod ex-moms-konvention |
| 5 | #25 iZettle/POS | Skip — ikke bygget (allerede verificeret 1. maj 2026) |
| 5 | #26 NemHandel | Skip — ikke bygget |
| 5 | #27 Whiteboard | Skip — viser ikke priser |
| 5 | #28 Menu-AI-agent | Fuldt — assertion at output ikke indeholder priser |

**24 fuldt automatiserbare** + 4 skips = hele tabellen er dækket.

---

## De tre faser

```
┌────────────────────────────────────────────────────────────┐
│  FASE 1 — Kortlægning (read-only)                          │
│  Claude Code arbejder selv → producerer rapport            │
│  Leif læser rapport → markerer GO/NO-GO pr. område         │
└────────────────────────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────┐
│  FASE 2 — Migration (write, én commit pr. område)          │
│  Claude Code: én commit ad gangen, smoke-tests grønne      │
│  Leif: GO/NO-GO mellem hvert commit                        │
└────────────────────────────────────────────────────────────┘
                            ↓
┌────────────────────────────────────────────────────────────┐
│  FASE 3 — Verifikations-suite (read-only test)             │
│  Claude Code: kører testbon gennem alle 24 områder         │
│  Leif: stikprøve-tjek visuelle outputs (PDF, mail render)  │
└────────────────────────────────────────────────────────────┘
```

---

## FASE 1 — Kortlægning

**Output:** `docs/audit/moms_audit_fase1_<dato>.md`
**Read-only:** Ingen kode-ændringer.
**Estimeret tid:** Claude Code 15–30 min. Leifs review 30 min.

### Hvad scriptet gør

For hvert område #1–#28 i `CLAUDE_MOMS_AUDIT.md`:

1. **Identificér filer** ud fra spec'ens "Filer / endpoints"-kolonne
   (hvis filen er gættet/uklar i spec'en — lokalisér den i kodebasen)

2. **Kør grep-arsenalet** fra spec'ens sektion A på de filer:
   - A1 (`* 1.25`), A2 (`/ 1.25`), A3 (`* 0.25`)
   - A4 (cost_price ↔ unit_price uden konvertering)
   - A5 (moms-konstanter — skal kun findes i `shared/moms.js` efter Commit 1–3)

3. **Kør B-queries** der relaterer til området (B1–B8 er allerede skrevet)

4. **Klassificér hvert fund:**

   | Status | Kriterium |
   |--------|-----------|
   | ✅ MIGRERET | Bruger `Moms.*` helpers — intet at gøre |
   | ⚠️ MIGRATION-KANDIDAT | Magic 1.25/0.25 fundet, kan trivielt erstattes |
   | 🔍 KRÆVER VURDERING | Uklart om inkl/ekskl er korrekt intent — Leif skal beslutte |
   | ⚪ IKKE-RELEVANT | Falsk positiv (fx "1.25 km" eller versionsnummer) |
   | ❌ IKKE FUNDET | Filen i spec'en findes ikke — skal opdateres |

### Output-format

Én sektion pr. område:

```markdown
## #2 — Tilbuds-PDF-eksport (Tier 1)

**Filer:** `office/views/tilbud.js` _tGenPDF (linje 1572), 
ingen server-side PDF fundet

**Bug-mønstre fra spec:** A

**Grep-fund:**
- `office/views/tilbud.js:1572` — `* 1.25` → ⚠️ MIGRATION-KANDIDAT
  Kontekst: `const moms = pre * 1.25 - pre;` (PDF totals-blok)
  Foreslået ændring: `const moms = momsOfIncl(pre);`

**SQL-fund:** B7 returnerer 0 rækker — ingen mail-skabeloner med 1.25

**Status:** ⚠️ ÉT migration-kandidat fundet
**Leif-beslutning:** [ ] GO migration / [ ] NO-GO / [ ] KRÆVER DISKUSSION
```

### Leif's review-form

Rapporten har en sammenfatningstabel øverst:

```markdown
## Sammenfatning

| # | Område | Status | Antal fund |
|---|--------|--------|-----------:|
| 1 | Tilbud-modulet | ✅ MIGRERET | 0 |
| 2 | Tilbuds-PDF | ⚠️ KANDIDAT | 1 |
| 3 | Tilbuds-mail | 🔍 VURDERING | 1 |
| ... | | | |
| 28 | Menu-AI-agent | ✅ MIGRERET | 0 |

Total kandidater: 7
Total kræver vurdering: 3
Total skips: 4
```

Leif markerer GO/NO-GO ved at redigere rapporten direkte (ændre check-bokse).

---

## FASE 2 — Migration

**Trigger:** Leif har redigeret Fase 1-rapporten med GO/NO-GO.
**Write-fase:** Hver migration = ét commit.
**Estimeret tid:** Claude Code ~15 min pr. område. Leif ~5 min pr. GO.

### Procedure pr. område

```
1. Læs Fase 1-rapporten — hvilke områder har GO?
2. For hvert område med GO (i Tier-rækkefølge):
   a. Lav den foreslåede ændring
   b. Kør tests/moms.test.js — skal være grønne (9 cases)
   c. Kør smoke på området hvis muligt:
      - Render et eksempel
      - Parse beløbene
      - Verificer mod kendt T-5
   d. Commit: "moms-audit: migrer #<nr> <områdenavn>"
   e. STOP og bed Leif om GO til næste område
3. For KRÆVER VURDERING-områder: spring over, log som åbne spørgsmål
4. Når alle GO-områder er migreret: STOP og bed om GO til Fase 3
```

### Commit-besked-format

```
moms-audit: migrer #<nr> <områdenavn>

Område: <Tier X #N — navn>
Bug-mønster: <A/B/C/D fra spec>
Filer ændret:
  - <fil>:<linje> → <ændring>

Verifikation:
  - tests/moms.test.js: 9/9 ✓
  - <evt. ekstra smoke-test>: ✓

Ref: CLAUDE_MOMS_AUDIT.md område #<nr>, CLAUDE_MOMS_AUDIT_AUTO.md Fase 2
```

### Hvis tests fejler

```
1. STOP migration — commit ikke
2. Rapportér: hvad ændredes, hvilken test fejlede, hvad var forventet vs faktisk
3. Vent på Leifs beslutning: rul tilbage / fix forward / skip område
```

---

## FASE 3 — Verifikations-suite

**Trigger:** Fase 2 er færdig (eller Leif siger "kør Fase 3 nu").
**Read-only:** Tester at alt giver konsistente tal.
**Estimeret tid:** Claude Code 30–60 min. Leifs visuelle stikprøve 1 time.

### Test-bonen

Genbrug T-5 fra `tests/moms.test.js`:

```
60 × 104 kr  (Catering sandwich type A)
70 × 114 kr  (Catering sandwich type B)
70 ×  99 kr  (Catering sandwich type C)
 8 × 312.50 kr (Levering)

Forventet:
  total_incl_moms: 23.650
  total_excl_moms: 18.920
  moms_amount:     4.730
```

Bonen oprettes som test-fixture (ikke i prod-DB) — fx via en SQLite-fil
i `tests/fixtures/moms_audit_testbon.db`.

### Test-suite

`tests/moms_audit_e2e.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');

// Setup: åbn testbon-fixture
const T5 = { incl: 23650, excl: 18920, moms: 4730 };

// === TIER 1 ===

test('#2 — Tilbuds-PDF viser T-5 korrekt', async () => {
    const pdfBuffer = await generateQuotePdf(testQuoteId);
    const text = extractTextFromPdf(pdfBuffer);
    assert.match(text, new RegExp(T5.incl.toLocaleString('da-DK')));
    assert.match(text, new RegExp(T5.moms.toLocaleString('da-DK')));
});

test('#3 — Tilbuds-mail render T-5 korrekt', async () => {
    const html = await renderQuoteEmail(testQuoteId);
    assert.match(html, new RegExp(T5.incl.toLocaleString('da-DK')));
});

test('#6 — Faktura-generering producerer korrekt total', async () => {
    const invoice = await generateInvoice(testBonId);
    assert.strictEqual(invoice.total_incl_moms, T5.incl);
});

test('#7 — E-conomic-payload har ex-moms-linjer + separat moms-felt', async () => {
    const payload = buildEconomicPayload(testBonId);
    const linesSum = payload.lines.reduce((s, l) => s + l.amount, 0);
    assert.ok(Math.abs(linesSum - T5.excl) < 1);
    assert.ok(Math.abs(payload.vat_amount - T5.moms) < 1);
});

// === TIER 2 ===

test('#9 — Bon-detalje (office) returnerer alle 3 moms-felter', async () => {
    const bon = await fetch(`/api/bons/${testBonId}`).then(r => r.json());
    assert.strictEqual(bon.total_incl_moms, T5.incl);
    assert.strictEqual(bon.total_excl_moms, T5.excl);
    assert.strictEqual(bon.moms_amount, T5.moms);
});

test('#11 — Tilbud→bon-konvertering bevarer total', async () => {
    const before = await getQuoteTotal(testQuoteId);
    const newBonId = await convertQuoteToBon(testQuoteId);
    const after = await getBonTotal(newBonId);
    assert.strictEqual(before, after);
});

test('#13 — Kalender-dagstotaler aggregerer korrekt', async () => {
    const day = await fetch('/api/calendar?date=2026-05-10').then(r => r.json());
    // Sum af alle bon.total_price for dagen — skal være konsistent
    assert.ok(day.total_incl_moms != null);
    assert.ok(day.total_excl_moms != null);
});

// === TIER 3 ===

test('#15 — Cashflow-dashboard rapporterer omsætning ex moms', async () => {
    const cf = await fetch('/api/cashflow/summary').then(r => r.json());
    // Forretningsregel: omsætning = ex moms til ledelsen
    // Skal stemme med b.total_excl_moms aggregeret
    assert.ok(cf.revenue_basis === 'ex_moms');
});

test('#18 — DB% beregnes på ex-moms-basis', async () => {
    const stats = await fetch(`/api/stats/db?bon_id=${testBonId}`).then(r => r.json());
    // (ltU - lc) / ltU * 100 hvor ltU = ex moms, lc = ex moms
    // Sandwich-DB skal være 60-80%, ikke 80-95% (det ville være moms-mismatch)
    assert.ok(stats.db_pct >= 50 && stats.db_pct <= 85);
});

// === TIER 4 (anden konvention) ===

test('#22 — Purchase order linjer er ex moms (leverandør-konvention)', async () => {
    const po = await getPurchaseOrder(testPoId);
    // Forretningsregel: leverandørpriser er ex moms
    // Skal IKKE konverteres til incl-moms nogen steder i PO-flowet
    assert.ok(po.price_basis === 'ex_moms');
});

test('#24 — Cost_price-snapshot fra Grocy er ex moms', async () => {
    // Bon_lines.cost_price antages ex moms.
    // Tjek: en sandwich med kostpris 25 kr i Grocy gemmes som 25, ikke 31.25
    const line = db.prepare('SELECT * FROM bon_lines WHERE id = ?').get(testLineId);
    assert.ok(line.cost_price < line.unit_price);  // ex < incl pr definition
});

// === TIER 5 ===

test('#28 — Menu-AI-agent returnerer ikke pris-felter direkte', async () => {
    const suggestion = await fetch('/api/bons/1/menu-suggestion', {method:'POST'})
        .then(r => r.json());
    // Agenten returnerer line-items med produkt-navn + quantity
    // Priser kommer fra Grocy-snapshot bagefter, ikke fra agenten
    suggestion.lines.forEach(l => {
        assert.ok(l.unit_price === undefined || l.unit_price === null,
            'Menu-agent skal ikke selv sætte unit_price');
    });
});
```

### Output

`docs/audit/moms_audit_fase3_<dato>.md`:

```markdown
# Moms-audit Fase 3 — Verifikations-resultater

Bon-version: <git-hash>
Test-fixture: tests/fixtures/moms_audit_testbon.db (T-5)

## Resultater

| Tier | # | Område | Test | Status |
|------|---|--------|------|--------|
| 1 | 2 | Tilbuds-PDF | T-5 i PDF-text | ✅ |
| 1 | 3 | Tilbuds-mail | T-5 i mail-HTML | ✅ |
| 1 | 6 | Faktura | total_incl_moms == 23650 | ✅ |
| 1 | 7 | E-conomic | ex-moms + separat vat_amount | ✅ |
| 2 | 9 | Bon-detalje API | 3 felter til stede | ✅ |
| 2 | 11 | Konvertering | total bevaret | ✅ |
| 3 | 15 | Cashflow | revenue_basis == 'ex_moms' | ⚠️ FAILED |
| ... | | | | |

## Fejlede tests

### #15 Cashflow-dashboard
**Forventet:** revenue_basis = 'ex_moms'
**Faktisk:** revenue_basis ikke udstillet i API
**Action:** Skal udstilles, eller cashflow-dashboard ændres
```

### Visuel verifikation (Leif)

Claude Code laver en mappe `docs/audit/visual_review_<dato>/` med:

| Fil | Hvad Leif skal tjekke |
|-----|----------------------|
| `tilbud_T5.pdf` | PDF ser korrekt ud — beløb læseligt og rigtige |
| `tilbud_mail_T5.html` | Åbn i browser, ser den ordentlig ud |
| `faktura_T5.pdf` | Læseligt, korrekt format |
| `bon_drawer_T5.png` (screenshot) | Beløb vises korrekt i UI |
| `cashflow_dashboard_T5.png` | Konsistent terminologi (omsætning ex moms) |

Leif kigger igennem og giver tommelfingre op/ned.

---

## Hvad vi IKKE auditerer i denne runde

| Område | Hvorfor |
|--------|---------|
| #25 iZettle/POS | Ikke bygget. Verificeret 1. maj 2026 i `KENDTE_DATABUGS.md` "Verificerede antagelser V1" |
| #26 NemHandel-faktura | Ikke bygget. Føjes til audit når den bygges |
| #27 Whiteboard | Viser ikke priser. Ingen risiko |
| #18 Specifik cost-bug fra v1-sync | Dokumenteret separat i `KENDTE_DATABUGS.md` #001. Ikke moms-relateret. |

---

## Forholdsregler

### Hvad scriptet IKKE må

- Ikke ændre noget i Fase 1 (read-only)
- Ikke deploye Fase 2-commits til prod (kun lokal/preview)
- Ikke commit'e KRÆVER VURDERING-områder uden Leif
- Ikke springe Fase 1 over og gå direkte til migration
- Ikke ændre noget i e-conomic, mail-server eller anden ekstern integration
  (kun parse hvad der VILLE være blevet sendt — mocking, ikke send)
- Ikke skrive til prod-DB i Fase 3 (testbon i fixture-fil)
- Ikke køre pre-commit-hook (`scripts/check-moms-magic.sh`) under Fase 2 før
  ALLE migrations er færdige — ellers blokeres egne migrations

### Stop-betingelser

| Trigger | Action |
|---------|--------|
| Smoke-tests fejler i Fase 2 | Stop, rapportér, vent på beslutning |
| Område mangler filer | Stop, rapportér, opdatér spec sammen med Leif |
| KRÆVER VURDERING fund | Skip område, log som åbent spørgsmål |
| Fase 1 finder MIGRERET status overalt | Hop til Fase 3 — der er intet at migrere |
| Test i Fase 3 fejler | Stop, log fejl, vent på beslutning før retry |

---

## Fil-struktur

```
docs/audit/
├── moms_audit_fase1_<dato>.md       ← Kortlægning + GO/NO-GO
├── moms_audit_fase3_<dato>.md       ← Verifikations-resultater
└── visual_review_<dato>/
    ├── tilbud_T5.pdf
    ├── tilbud_mail_T5.html
    ├── faktura_T5.pdf
    └── ...

tests/
├── moms.test.js                     ← Eksisterer (Commit 1)
├── moms_audit_e2e.test.js           ← Ny (Fase 3)
└── fixtures/
    └── moms_audit_testbon.db        ← T-5 testbon
```

---

## Aktivér pre-commit-hook (efter Fase 2)

`scripts/check-moms-magic.sh` er allerede defineret i den oprindelige
audit-spec sektion 3. Aktivér KUN efter Fase 2 er færdig — ellers
blokeres egne migrations.

```bash
# Kør først efter Fase 2 er færdig OG alle commits er pushed
chmod +x scripts/check-moms-magic.sh
ln -sf ../../scripts/check-moms-magic.sh .git/hooks/pre-commit
```

Verificer at den virker:

```bash
# Skal fejle:
echo "const x = price * 1.25;" >> /tmp/test.js
git add /tmp/test.js  # ← skal blokeres af hook
```

---

## Sammenhæng med andre audits

| Audit | Status | Kobling |
|-------|--------|---------|
| Moms-refaktorering Commit 1–3 | Klar til deploy | Forudsætning for denne audit |
| Denne audit (auto) | Spec klar | Kører efter Commit 1–3 er live |
| Grocy-data-audit (`CLAUDE_GROCY_AUDIT.md`) | Spec klar, kører weekenden | Uafhængig — fixer #001 cost-bug, ikke moms |
| KENDTE_DATABUGS.md | Lever | Logger fund fra alle tre |

---

## Næste skridt

1. **Verificér** at `CLAUDE_MOMS_AUDIT.md` område-numre stadig matcher virkeligheden
   (specielt #1 Tilbud-modulet — er det ✅ MIGRERET nu efter Commit 1–3?)
2. **Kør Fase 1** — bed Claude Code: *"Læs CLAUDE_MOMS_AUDIT.md og 
   CLAUDE_MOMS_AUDIT_AUTO.md, kør Fase 1"*
3. **Læs rapport**, marker GO/NO-GO på hvert område
4. **Kør Fase 2** — én GO ad gangen
5. **Kør Fase 3** — verifikations-suite
6. **Visuel review** — gå gennem `visual_review/`-mappen
7. **Aktivér pre-commit-hook** når alt er grønt

---

*Sidst opdateret: 1. maj 2026*
