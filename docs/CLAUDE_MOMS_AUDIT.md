# CLAUDE_MOMS_AUDIT.md — Audit af pris/moms-håndtering i hele Bon v2

> Læs `CLAUDE.md`, `BON_V2_PRINCIPPER.md` (sektionen om moms) og `CLAUDE_TILBUD_PRIS.md` FØR du starter.
> Opdateret: april 2026.

---

## Formål

Tilbuds-bug'en (`tilbud.js` lægger 25 % moms ovenpå priser der allerede er incl. moms) kan eksistere kopieret eller genopfundet andre steder. Denne fil er:

1. **Engangs-audit:** Systematisk gennemgang af alle steder hvor pris vises, aggregeres eller eksporteres.
2. **Permanent forebyggelse:** Værktøjer og regler der gør det svært at lave samme fejl igen.

Audit'en skal **køres EFTER** `CLAUDE_TILBUD_PRIS.md` Del 1–3 er deployet (så `BON_V2_PRINCIPPER.md` har den autoritative regel og `computeMomsFields` findes som helper).

---

## De fire klassiske bug-mønstre

| ID | Mønster | Symptom | Hvor man oftest finder det |
|----|---------|---------|----------------------------|
| **A** | Behandler incl-moms-pris som ex moms og lægger 25 % på | Kunde-total +25 % | Renderere af tilbud, kvitteringer, faktura, mails |
| **B** | Glemmer at konvertere `cost_price` (ex moms) når det vises sammen med `unit_price` (incl moms) | Kostpris vises forkert lavt eller margin forkert høj | Bon-detalje, statistik, dækningsbidrag |
| **C** | Blander incl-moms og ex-moms i samme regnestykke | DB%-margin forkert (ofte +20 procentpoint) | `(unit_price - cost_price) / unit_price` uden konvertering |
| **D** | Sender incl-moms-pris til e-conomic som linjepris | Faktura er 25 % høj — virkelig synligt | E-conomic-adapter |

Korrekt dækningsbidrag-beregning til reference:

```javascript
const ltU  = lt / MOMS_FACTOR;       // ex moms
const dbP  = ltU > 0 ? ((ltU - lc) / ltU * 100) : 0;
//                       ^^^      ^^      ^^^
//                       ex-moms  ex      ex-moms
```

---

## Højrisiko-områder — komplet liste

Sorteret efter sandsynlighed for at indeholde fejl. Audit i denne rækkefølge.

### Tier 1 — Kunde-vendt, høj eksponering

| # | Område | Filer / endpoints | Bug-mønster at lede efter |
|---|--------|-------------------|---------------------------|
| 1 | **Tilbud-modulet** (allerede fixet i lokal kode, prod stadig buggy indtil deploy) | `office/views/tilbud.js`, `routes/quotes.js` | A, C |
| 1b | **Almindelige bons (`routes/bons.js`)** | `routes/bons.js:155-183` skriver `total_price` + `total_with_delivery` direkte fra request-body uden recalc — ingen `recalcTotal()` ækvivalent til `quotes.js`. Klienten kan i princippet sende hvad som helst | A (indirekte) — backend er ikke autoritativ for almindelige bons indtil J1 i CLAUDE_TILBUD_PRIS.md er implementeret |
| 2 | **Tilbuds-PDF-eksport** | `office/views/tilbud.js` `_tGenPDF`, evt. server-side PDF | A |
| 3 | **Tilbuds-mail** (when "Send til kunde") | `mail_templates`-rækker, `services/mailer.js` (eller hvad mail-koden hedder) | A — mail-skabelon kan have hardcoded × 1.25 |
| 4 | **Bestillings-bekræftelses-mail** | `mail_templates`, evt. trigger ved bon NY → GODKENDT | A |
| 5 | **Formbuilder-kvittering** (kundens ende) | `formbuilder/`, public route | A |
| 6 | **Faktura-generering** | `routes/invoicing.js` (eller tilsvarende) | A, D |
| 7 | **E-conomic-adapter** | `services/economic*.js` (når den bygges) | **D — kritisk** |
| 8 | **Public tilbud-link** (hvis kunden får et URL) | `routes/public.js` eller lign. | A |

### Tier 2 — Intern visning, indirekte effekt

| # | Område | Filer / endpoints | Bug-mønster |
|---|--------|-------------------|-------------|
| 9 | **Bon-detalje-view (office)** | `office/views/bons.js`, `shared/bon_drawer.js` | A, B |
| 10 | **Bon-detalje-view (kitchen)** | `shared/bon_kort.js` — viser den priser? | A (hvis ja) |
| 11 | **Tilbud → bon-konvertering** | `POST /api/quotes/:id/convert` i `routes/quotes.js` | Værdier skal arve korrekt — tjek total_price før/efter |
| 12 | **Mobile shell** | `mobile/`-mappen | A — egen renderer |
| 13 | **Kalender-dagstotaler** | `office/views/calendar.js` (eller hvor det er) | A — aggregerer total_price |
| 14 | **Planning view** (uge-overblik) | Hvor det end ligger | A — aggregerer |

### Tier 3 — Rapporter, eksport, dashboards

| # | Område | Filer / endpoints | Bug-mønster |
|---|--------|-------------------|-------------|
| 15 | **Cashflow-dashboard** | `routes/cashflow.js`, `office/views/cashflow.js` | A — del af samme repo (IKKE separat kodebase). Aggregerer `total_price` (incl) → bekræft om "omsætning"-tal i UI er ex eller incl moms, og om de stemmer med ledelsesrapportering |
| 16 | **Statistik/rapporter** | Hvor det end ligger | A, C |
| 17 | **CSV/Excel-eksporter** | Søg efter `csv` / `xlsx` i kodebasen | A — eksporter beregner ofte selv totaler |
| 18 | **Dækningsbidrag pr. produkt** | Hvor end DB% vises | C — se mønster ovenfor |
| 19 | **Dashboard "Start dagen"** | `office/views/dashboard.js` | A — aggregerer |
| 20 | **Smartplan-relaterede pris-tal** (lønanalyse vs salg) | Smartplan-modul | Hvis pris og løn sammenlignes — pas på blanding |

### Tier 4 — Indkøb (anden konvention)

**Vigtig forskel:** Indkøbsmodulet bruger **leverandørpriser ex moms**. Det er en bevidst anden konvention end salg. Audit her handler IKKE om at finde "manglende moms" — men om at bekræfte at **salg-konventionen IKKE er sneget ind hvor leverandører skulle have været ex moms**.

| # | Område | Tjek |
|---|--------|------|
| 21 | **Indkøbsliste** | Leverandørpriser ex moms — bekræft |
| 22 | **Purchase order** (`purchase_orders` + `_lines`) | `price_per_pack` skal være ex moms (leverandørens pris) |
| 23 | **Goods receipt valuation** | Bruger leverandørpris ex moms til at opgøre lager — bekræft |
| 24 | **Grocy-cost_price-snapshot** | Når Bon v2 tager `cost_price` snapshot fra Grocy: Grocy-cost er ex moms — bekræft at intet steds adderes moms til cost |

### Tier 5 — Integrationer og eksterne kilder

| # | Område | Tjek |
|---|--------|------|
| 25 | **POS/iZettle-import** (BETALT-bons) | Hvilket format kommer total fra iZettle? Incl eller excl? Hvad gemmes som `total_price`? |
| 26 | **NemHandel/EAN-faktura** (offentlige kunder) | Format krav — typisk ex moms-linjer + moms-felt separat |
| 27 | **Whiteboard-sidekick** | Hvis det viser priser — ellers ikke relevant |
| 28 | **Menu-AI-agent** | Returnerer den priser? Hvis ja — incl eller excl? |

---

## Audit-værktøjskasse

### A. Code-grep — kør alle ti

```bash
cd /home/bon/bon-v2/

# A1. Find ALLE multiplikationer med 1,25 — den tydeligste fejlsignatur
grep -rnE '\* *1[.,]25' --include="*.js" --include="*.html" --include="*.sql" \
  --exclude-dir=node_modules .

# A2. Find divisioner med 1,25 — hver enkelt skal verificeres som korrekt
grep -rnE '/ *1[.,]25' --include="*.js" --include="*.html" \
  --exclude-dir=node_modules .

# A3. Find magic 0.25 (momsrate) der ikke er fra helpers
grep -rnE '\* *0[.,]25|0[.,]25 *\*' --include="*.js" \
  --exclude-dir=node_modules . | grep -v 'helpers'

# A4. Find hvor cost_price og unit_price møder hinanden uden konvertering
grep -rnE 'cost_price.*unit_price|unit_price.*cost_price' --include="*.js" \
  --exclude-dir=node_modules .

# A5. Find alle moms-relaterede konstanter (skal helst kun være ÉN definition)
grep -rnE 'MOMS|momsFactor|momsRate|VAT_RATE' --include="*.js" \
  --exclude-dir=node_modules .

# A6. Routes/services der returnerer eller skriver total_price
grep -rn 'total_price\|total_with_delivery' routes/ services/ --include="*.js"

# A7. e-conomic-relateret kode — alt der eksporterer/importerer
grep -rni 'economic\|invoice\|faktura\|nemhandel' --include="*.js" \
  --exclude-dir=node_modules .

# A8. Find alle steder dækningsbidrag/margin beregnes
grep -rnE 'dækningsbidrag|margin|\bdb[A-Z_]|db_pct|db_percent|costRatio' \
  --include="*.js" --exclude-dir=node_modules .

# A9. Find PDF-genereringer (alle skal bruge samme moms-helper)
grep -rni 'jspdf\|pdf-lib\|puppeteer\|pdfmake\|pdfkit' \
  --include="*.js" --exclude-dir=node_modules .

# A10. Find mail-rendering — skabeloner kan have hardcoded forkerte beregninger
grep -rnE 'mail_template|sendMail|smtp|imap' --include="*.js" \
  --exclude-dir=node_modules .
```

**Hvordan man læser resultatet:**

- Hver match fra A1 (`× 1.25`) er **mistænkelig** og skal tjekkes manuelt — der findes legitime tilfælde (fx beregne incl ud fra en kendt ex), men de skal i givet fald gå gennem `exclToIncl()`-helperen ikke et bart `1.25`.
- Hver match fra A2 (`/ 1.25`) er **sandsynligvis korrekt** — bekræft at den henviser til en incl-moms-værdi.
- A3 fanger glemte momsbeløbs-beregninger — sjælden men muligt mønster.
- A4 er det mest subtile: hvis `cost_price` (ex) og `unit_price` (incl) bruges i samme udtryk uden `/ MOMS_FACTOR` på `unit_price`, er resultatet forkert.
- A5 skal helst kun pege på `db/helpers.js` efter oprydning. Andre steder = inkonsistens.

### B. SQL-queries til data-konsistens-check

Disse afslører om forkerte beregninger har efterladt skæve data i DB.

```sql
-- B1. Bons hvor total_price IKKE matcher sum af linjer + delivery_price
-- (fanger forældede beregninger eller manglende recalc)
SELECT
    b.id,
    b.bon_number,
    b.is_offer,
    b.total_price                                                AS gemt_total,
    (SELECT COALESCE(SUM(line_total),0) FROM bon_lines WHERE bon_id = b.id)
                                                                 AS lines_sum,
    COALESCE(b.delivery_price, 0)                                AS delivery,
    (SELECT COALESCE(SUM(line_total),0) FROM bon_lines WHERE bon_id = b.id)
        + COALESCE(b.delivery_price, 0)                          AS forventet
FROM bons b
WHERE ABS(
    b.total_price -
    ((SELECT COALESCE(SUM(line_total),0) FROM bon_lines WHERE bon_id = b.id)
        + COALESCE(b.delivery_price, 0))
) > 1
ORDER BY ABS(b.total_price - ((SELECT COALESCE(SUM(line_total),0) FROM bon_lines WHERE bon_id = b.id) + COALESCE(b.delivery_price, 0))) DESC
LIMIT 50;
```

```sql
-- B2. Bons med BÅDE x-Levering-linje OG delivery_price > 0 (korruptions-case)
SELECT
    b.bon_number,
    b.is_offer,
    b.delivery_price,
    bl.product_name,
    bl.line_total,
    bl.category
FROM bons b
JOIN bon_lines bl ON bl.bon_id = b.id
WHERE bl.category = 'x-Levering'
  AND COALESCE(b.delivery_price, 0) > 0
ORDER BY b.bon_number;
```

```sql
-- B3. Bons med flere x-Levering-linjer (skulle aldrig forekomme)
SELECT b.bon_number, COUNT(*) AS antal_levering_linjer
FROM bons b
JOIN bon_lines bl ON bl.bon_id = b.id
WHERE bl.category = 'x-Levering'
GROUP BY b.id, b.bon_number
HAVING COUNT(*) > 1;
```

```sql
-- B4. Mistænkelige unit_price-til-cost_price-forhold (outliers)
-- Sandwich-margin er typisk 3-5×. Ratio < 1.5 eller > 8 = bør undersøges
SELECT
    bl.id,
    bl.product_name,
    bl.unit_price,
    bl.cost_price,
    ROUND(bl.unit_price / NULLIF(bl.cost_price, 0), 2) AS ratio
FROM bon_lines bl
WHERE bl.cost_price > 0 AND bl.unit_price > 0
  AND (bl.unit_price / bl.cost_price > 8 OR bl.unit_price / bl.cost_price < 1.5)
ORDER BY ratio DESC
LIMIT 50;
```

```sql
-- B5. Bons hvor unit_price ser ud til at have moms lagt på to gange
-- Sammenlign med kendt katalog: en incl-moms Catering sandwich er 99-130 kr
-- Hvis unit_price er > 145 for en kategori "01 Sandwich", er det suspekt
SELECT
    b.bon_number,
    bl.product_name,
    bl.category,
    bl.unit_price,
    bl.quantity,
    bl.line_total
FROM bon_lines bl
JOIN bons b ON b.id = bl.bon_id
WHERE bl.category LIKE '%Sandwich%'
  AND bl.unit_price > 145
ORDER BY bl.unit_price DESC
LIMIT 30;
```

```sql
-- B6. Tjek for delvise/inkomplete recalc — bon_lines.line_total != quantity * unit_price
SELECT
    bl.id,
    bl.product_name,
    bl.quantity,
    bl.unit_price,
    bl.line_total,
    bl.quantity * bl.unit_price AS forventet_line_total
FROM bon_lines bl
WHERE bl.line_total IS NOT NULL
  AND bl.unit_price IS NOT NULL
  AND ABS(bl.line_total - bl.quantity * bl.unit_price) > 0.5
LIMIT 50;
```

```sql
-- B7. Mail-skabeloner der nævner "moms" eller "total" eller "pris" — skal gennemlæses manuelt
SELECT id, name, subject, substr(body, 1, 300) AS preview
FROM mail_templates
WHERE body LIKE '%moms%'
   OR body LIKE '%total%'
   OR body LIKE '%pris%'
   OR body LIKE '%1.25%'
   OR body LIKE '%* 1,25%';
```

```sql
-- B8. Settings der har at gøre med pris/moms — skal også reviewes
SELECT key, value, description
FROM settings
WHERE key LIKE '%moms%'
   OR key LIKE '%price%'
   OR key LIKE '%vat%'
   OR description LIKE '%moms%';
```

### C. Browser-side / frontend-audit

Run i browseren (DevTools console) på en åben side:

```javascript
// C1. Verificér at API leverer pre-beregnede moms-felter
fetch('/api/quotes')
  .then(r => r.json())
  .then(quotes => {
    const missing = quotes.filter(q =>
      q.total_incl_moms === undefined ||
      q.total_excl_moms === undefined ||
      q.moms_amount === undefined
    );
    console.log('Quotes uden moms-felter:', missing.length, missing);
  });
```

```javascript
// C2. Spot-check: er total_incl_moms === total_excl_moms × 1.25 på alle?
fetch('/api/quotes').then(r => r.json()).then(qs => {
    const broken = qs.filter(q => {
        const expected = Math.round((q.total_excl_moms || 0) * 125) / 100;
        return Math.abs((q.total_incl_moms || 0) - expected) > 1;
    });
    console.log('Brudt moms-konsistens:', broken);
});
```

```javascript
// C3. Find inline price-rendering i DOM der mistænkeligt slutter på "kr" + et stort tal
// Brug i DevTools på en åben tilbud/bon-side
$$('*').filter(el => /\b\d{4,}\s*kr\b/.test(el.textContent || '') && el.children.length === 0)
       .map(el => ({el, text: el.textContent.trim().slice(0, 60)}));
```

### D. Grocy-side audit

```javascript
// D1. Hent alle sælgbare opskrifter og find dem med suspekt prisstruktur
fetch('/api/grocy/recipes')
  .then(r => r.json())
  .then(recipes => {
    // Margin-analyse: catering-pris bør være 3-5× kostpris
    const issues = recipes.filter(r => {
        if (!r.cost_price || r.cost_price <= 0) return false;
        if (!r.prices?.catering) return false;
        const ratio = r.prices.catering / r.cost_price;
        return ratio > 8 || ratio < 1.5;
    });
    console.table(issues.map(r => ({
        navn: r.name,
        cat_pris: r.prices.catering,
        kostpris: r.cost_price,
        ratio: (r.prices.catering / r.cost_price).toFixed(2)
    })));
  });

// D2. Find recipes hvor catering-pris < butik-pris (oftest fejl)
fetch('/api/grocy/recipes')
  .then(r => r.json())
  .then(recipes => {
    const issues = recipes.filter(r =>
      r.prices?.catering > 0 &&
      r.prices?.store > 0 &&
      r.prices.catering < r.prices.store
    );
    console.log('Catering-pris under butik-pris:', issues);
  });

// D3. Find recipes hvor festival-pris er højere end catering (typisk skal festival være lavere)
fetch('/api/grocy/recipes')
  .then(r => r.json())
  .then(recipes => {
    const issues = recipes.filter(r =>
      r.prices?.festival > 0 &&
      r.prices?.catering > 0 &&
      r.prices.festival > r.prices.catering
    );
    console.log('Festival-pris over catering-pris:', issues);
  });
```

### E. Manuelt review — hvor grep ikke fanger

| Sted | Hvad du leder efter | Hvordan |
|------|---------------------|---------|
| Mail-skabeloner | Hardcoded ×1,25 i tekst, eller forkerte placeholders | Login som admin → Settings → Mail-skabeloner. Læs hver enkelt |
| PDF-genereringer | Hardcoded moms-formel i jsPDF-blok | Åbn hver fil fra grep #A9, læs `Subtotal`/`Total`-blokken |
| E-conomic-adapter | Pris sendes UDEN /1.25-konvertering | Når den bygges: `unit_price` skal divideres med MOMS_FACTOR før send. **Skriv test** |
| iZettle-import | Hvad er `gross_amount` vs `net_amount` i iZettle's webhook? | Læs iZettle-dokumentation, log et indkommende payload, sammenlign med hvad vi gemmer |
| Cashflow dashboard | Aggregerer den `total_price` (incl) og kalder det "omsætning"? Omsætning rapporteres typisk EX moms til ledelsen | Åbn modul, sammenlign med en kendt periode |

---

## Strukturel forebyggelse

Audit'en finder de nuværende fejl. Disse fire foranstaltninger forhindrer nye.

### 1. ÉN moms-konstant i hele kodebasen

Tilføj til `db/helpers.js`:

```javascript
// ─── Moms — ÉN definition for hele Bon v2 ─────────────────────────
// Se BON_V2_PRINCIPPER.md for komplet regel.
const MOMS_RATE   = 0.25;
const MOMS_FACTOR = 1 + MOMS_RATE;   // 1.25

function inclToExcl(incl)      { return (incl ?? 0) / MOMS_FACTOR; }
function exclToIncl(excl)      { return (excl ?? 0) * MOMS_FACTOR; }
function momsOfIncl(incl)      { return (incl ?? 0) - (incl ?? 0) / MOMS_FACTOR; }
function computeMomsFields(totalInclMoms) {
    const incl = Math.round((totalInclMoms ?? 0) * 100) / 100;
    const excl = Math.round((incl / MOMS_FACTOR) * 100) / 100;
    const moms = Math.round((incl - excl) * 100) / 100;
    return { total_incl_moms: incl, total_excl_moms: excl, moms_amount: moms };
}

module.exports = {
    /* ...eksisterende... */,
    MOMS_RATE, MOMS_FACTOR,
    inclToExcl, exclToIncl, momsOfIncl, computeMomsFields,
};
```

**Regel:** Ingen kode i Bon v2 må have et bart `1.25` eller `0.25` udenfor `db/helpers.js` og test-filer. Alt går gennem helpers.

### 2. Smoke-test der låser kontrakten

Opret `tests/moms.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const {
    MOMS_FACTOR, MOMS_RATE,
    inclToExcl, exclToIncl, momsOfIncl, computeMomsFields,
} = require('../db/helpers');

test('MOMS_FACTOR er 1.25 — den fundamentale konstant', () => {
    assert.strictEqual(MOMS_FACTOR, 1.25);
    assert.strictEqual(MOMS_RATE, 0.25);
});

test('Grocy-pris 104 incl. moms giver korrekt opsplit', () => {
    const r = computeMomsFields(104);
    assert.strictEqual(r.total_incl_moms, 104);
    assert.strictEqual(r.total_excl_moms, 83.20);
    assert.strictEqual(r.moms_amount, 20.80);
});

test('T-5 case: 60×104 + 70×114 + 70×99 + 8×312.5 → 23.650/18.920/4.730', () => {
    const total = 60*104 + 70*114 + 70*99 + 8*312.5;
    const r = computeMomsFields(total);
    assert.strictEqual(r.total_incl_moms, 23650);
    assert.strictEqual(r.total_excl_moms, 18920);
    assert.strictEqual(r.moms_amount, 4730);
});

test('inclToExcl og exclToIncl er reversible', () => {
    const incl = 1234.56;
    assert.strictEqual(Math.round(exclToIncl(inclToExcl(incl)) * 100) / 100, incl);
});

test('momsOfIncl giver 20% af incl-beløb', () => {
    assert.strictEqual(momsOfIncl(125), 25);
});
```

Køres via `node --test tests/moms.test.js` eller `npm test` hvis den er i `package.json` scripts.

### 3. Pre-commit-hook der fanger nye magic-numre

Opret `scripts/check-moms-magic.sh`:

```bash
#!/usr/bin/env bash
# Fejl hvis nogen committer kode med bart 1.25 eller 0.25 uden for helpers/tests
set -e

forbidden=$(git diff --cached --name-only --diff-filter=ACM \
    -- '*.js' '*.html' \
    | grep -v 'db/helpers.js' \
    | grep -v 'tests/' \
    | grep -v 'node_modules/' \
    | xargs -r grep -nE '(\* *1[.,]25|/ *1[.,]25|\* *0[.,]25|0[.,]25 *\*)' \
    || true)

if [ -n "$forbidden" ]; then
    echo "❌ FEJL: Magic moms-konstant fundet uden for db/helpers.js og tests/:"
    echo ""
    echo "$forbidden"
    echo ""
    echo "Brug i stedet:"
    echo "  const { MOMS_FACTOR, inclToExcl, exclToIncl, momsOfIncl } = require('./db/helpers');"
    echo ""
    echo "Hvis du har en legitim grund til at bruge tallet direkte, tilføj fil til whitelisten i scripts/check-moms-magic.sh"
    exit 1
fi
```

Aktivér som git hook:

```bash
chmod +x scripts/check-moms-magic.sh
ln -sf ../../scripts/check-moms-magic.sh .git/hooks/pre-commit
```

Eller integrer i `package.json` hvis I bruger Husky/lint-staged senere.

### 4. Single source of truth — API-kontrakt

**Regel:** Når en frontend skal vise moms-relaterede tal, kommer de fra backend. Backend regner én gang og udstiller dem som felter i JSON-svar.

| Endpoint-type | SKAL inkludere |
|--------------|----------------|
| `GET /api/bons/:id` | `total_incl_moms`, `total_excl_moms`, `moms_amount` |
| `GET /api/bons` (liste) | Samme tre felter på hver række |
| `GET /api/quotes/:id` | Samme tre felter |
| `GET /api/quotes` (liste) | Samme tre felter på hver række |
| `GET /api/bons/today` (kitchen) | Samme tre felter — kitchen viser dem ikke nu, men hvis det skulle ske, er feltet der |
| Fakturer/eksport | Pris ex moms + moms-beløb separat (e-conomic-konvention) |

Hvis Simon eller fremtidig kode skriver `* 1.25` i en frontend, er det et hint om at backend mangler at udstille feltet. Det er en **proces-regel**, ikke kun en kode-regel.

---

## Audit-rapport — skabelon

Brug denne tabel til at dokumentere hvad der er auditeret. Kommit i repo som `docs/moms_audit_<dato>.md`.

```markdown
# Moms-audit gennemført <DATO>

Auditør: <navn>
Bon v2 commit: <git-hash>
Helpers-version: db/helpers.js commit <hash>

## Resultater

| Tier | # | Område | Status | Fundet | Action |
|------|---|--------|--------|--------|--------|
| 1 | 1 | Tilbud-modulet | ✅ ren | (forventet — fix fra CLAUDE_TILBUD_PRIS.md) | – |
| 1 | 2 | Tilbuds-PDF | ☐ | | |
| 1 | 3 | Tilbuds-mail | ☐ | | |
| 1 | 4 | Bestillings-bekræftelses-mail | ☐ | | |
| 1 | 5 | Formbuilder-kvittering | ☐ | | |
| 1 | 6 | Faktura-generering | ☐ | | |
| 1 | 7 | E-conomic-adapter | ☐ | | |
| 1 | 8 | Public tilbud-link | ☐ | | |
| 2 | 9 | Bon-detalje-view (office) | ☐ | | |
| 2 | 10 | Bon-detalje-view (kitchen) | ☐ | | |
| 2 | 11 | Tilbud → bon-konvertering | ☐ | | |
| 2 | 12 | Mobile shell | ☐ | | |
| 2 | 13 | Kalender-dagstotaler | ☐ | | |
| 2 | 14 | Planning view | ☐ | | |
| 3 | 15 | Cashflow-dashboard | ☐ | | |
| 3 | 16 | Statistik | ☐ | | |
| 3 | 17 | CSV/Excel-eksport | ☐ | | |
| 3 | 18 | DB% pr. produkt | ☐ | | |
| 3 | 19 | Dashboard | ☐ | | |
| 3 | 20 | Smartplan-relaterede tal | ☐ | | |
| 4 | 21 | Indkøbsliste | ☐ | | |
| 4 | 22 | Purchase order | ☐ | | |
| 4 | 23 | Goods receipt | ☐ | | |
| 4 | 24 | Cost-snapshot | ☐ | | |
| 5 | 25 | iZettle/POS | ☐ | | |
| 5 | 26 | NemHandel-faktura | ☐ | | |
| 5 | 27 | Whiteboard | n/a | | |
| 5 | 28 | Menu-AI-agent | ☐ | | |

## Strukturel forebyggelse

- [ ] `db/helpers.js` opdateret med MOMS_FACTOR + helpers
- [ ] `tests/moms.test.js` oprettet og kører grønt
- [ ] `scripts/check-moms-magic.sh` aktiveret som pre-commit
- [ ] Backend leverer moms-felter på alle relevante endpoints (jf. tabel ovenfor)

## Kørte SQL-queries (B-sektion)

| Query | Antal rækker | Action |
|-------|-------------:|--------|
| B1 (total_price-mismatch) | | |
| B2 (x-Levering + delivery_price) | | |
| B3 (flere x-Levering-linjer) | | |
| B4 (suspekte ratio) | | |
| B5 (sandwich > 145 kr) | | |
| B6 (line_total-mismatch) | | |
| B7 (mail-skabeloner med "moms"/"total"/"pris") | | |
| B8 (relevante settings) | | |

## Konklusion

<sammenfatning af hvad der blev fundet og fixet>
```

---

## Ad-hoc dokumentationsregel — for nye moduler

Når et nyt modul der håndterer pris bygges (faktura, e-conomic, ny rapport, ny mail-skabelon), skal det starte med at en **én-paragrafs noter** i toppen af filen:

```javascript
/**
 * routes/invoicing.js
 *
 * MOMS-HÅNDTERING:
 * - Læser bon.total_price (incl. moms) og bon_lines.unit_price (incl. moms).
 * - Konverterer til ex moms via inclToExcl() før send til e-conomic
 *   (e-conomic forventer ex moms + separat moms-felt).
 * - Returnerer et "invoice"-objekt med felterne `lines_excl_moms` (array)
 *   og `moms_amount` (sum) — IKKE incl-moms-felter, da modtager (e-conomic)
 *   ikke bruger dem.
 *
 * Se BON_V2_PRINCIPPER.md sektionen om moms.
 */
```

Det tvinger forfatteren til at tænke det igennem og giver fremtidige læsere en kortfattet forklaring uden at skulle læse hele koden.

---

## Estimeret omfang

| Aktivitet | Estimeret tid |
|-----------|---------------|
| Engangs-audit Tier 1 (kunde-vendt) | 4–6 timer |
| Engangs-audit Tier 2 (intern visning) | 3–4 timer |
| Engangs-audit Tier 3–5 (rapporter, integration) | 4–6 timer |
| SQL-konsistens-checks (B-queries) | 1 time |
| Implementering af `MOMS_FACTOR`-helpers | 1 time |
| Smoke-test + pre-commit-hook | 2 timer |
| Audit-rapport-skrivning | 1 time |
| **I alt** | **16–21 timer** |

Kan deles op over flere uger. Tier 1 er prioriteret højest — det er der kunderne ser pengene.

---

## Justeringer efter kode-review (april 2026)

Disse er fundet ved at læse den faktiske kodebase og er suppleret til specs ovenfor:

### Faktuelle korrektioner

- **Cashflow er IKKE separat kodebase.** Den ligger i `routes/cashflow.js` + `office/views/cashflow.js` i samme repo som resten. Tier 3 #15 i tabellen er rettet — bug-mønster A kan ramme den lige så let som andre office-views.
- **`tools/tilbud-standalone-v2.html` findes allerede** (jf. git-status). Det udfylder Tier 1 #8 ("Public tilbud-link") som **eksisterende fil**, ikke hypotese — skal med fra start.

### Steder hvor `/ 1.25` allerede findes (kode-grep, lokal april 2026)

| Fil | Linje | Skal migreres til `inclToExcl()` |
|-----|-------|----------------------------------|
| `office/views/tilbud.js` | 1120, 1139, 1163, 1291, 1572 | Ja (Del 2 dækker det) |
| `shared/modal.js` | 505 (`grand * 25 / 125`) | Ja — overset i Del 2 |
| `shared/planning.js` | 614 (`totalSales / 1.25`) | Ja — overset i Del 2 |

Audit'ens pre-commit-hook vil fejle på de tre filer indtil de migreres til `shared/moms.js`-helpers. Plan dem ind sammen med Del 3 så der ikke er et vindue hvor hooken er deaktiveret.

### Cost_price-konvention skal valideres på data

Spec'ens antagelse "`bon_lines.cost_price` er ex moms" er **ikke verificeret på faktiske rækker**. Bon v1 kan have haft anden konvention som er kommet med i sync. Tilføj som første skridt i Tier 3 #18 (DB% pr. produkt):

```sql
SELECT
    bl.product_name,
    bl.unit_price                                AS salg_incl,
    bl.cost_price                                AS kost,
    ROUND(bl.unit_price / 1.25, 2)               AS salg_excl,
    ROUND((bl.unit_price/1.25) / NULLIF(bl.cost_price,0), 2) AS ratio_excl_basis
FROM bon_lines bl
WHERE bl.cost_price > 5 AND bl.unit_price > 50
ORDER BY ratio_excl_basis ASC LIMIT 20;
```

Forventet ratio for sandwich med ex-moms-kost: 3–5×. Hvis tallet systematisk er ~2.4–4×, er `cost_price` faktisk incl moms i v1-importerede rækker, og DB%-formlen i `shared/planning.js:616` skal revideres.

### `total_with_delivery` har stadig en aktiv læser

`shared/modal.js:501` læser `total_with_delivery` som **primær** kilde med `total_price + delivery_price` som fallback. Audit'en skal flagge feltet som "i brug, læs/skriv", ikke som "deprecated kandidat". Konkret oprydning ligger i CLAUDE_TILBUD_PRIS.md J4.

---

*Slut på audit-spec.*
