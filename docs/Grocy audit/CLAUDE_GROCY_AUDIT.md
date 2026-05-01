# CLAUDE_GROCY_AUDIT.md — Grocy data-audit (HQ)
> Læs `BON_V2_PRINCIPPER.md` og `KENDTE_DATABUGS.md` (#001 og #002) først.
> Dette dokument er en spec til Claude Code.
> Dato: maj 2026

---

## Formål

Auditere Grocy HQ's database for data-quality issues før Bon v2's
sync- og pris-logik kan stoles på.

**Audit handler om Grocy-data, ikke om Bon v2's kode.** Rettelser
af `scripts/sync-v1.js` (#001) sker i separat opgave bagefter.

**Scope:** Kun HQ Grocy. Trailer og Test auditeres separat senere.

---

## Workflow over weekenden

| Tid | Handling |
|-----|----------|
| Fredag aften | Scp prod-fil ned: `/var/www/grocycafe/data/grocy.db` → lokal arbejdsmappe |
| Fredag aften | Tag frossen backup: `cp grocy.db grocy-prod-frozen-YYYYMMDD.db` (rør IKKE) |
| Lørdag | Kør Fase 1–5 (read-only audit) — én ad gangen, stikprøve-verificér efter hver |
| Søndag formiddag | Beslut: hvilke fund cleanup'es, hvilke står over |
| Søndag eftermiddag | Kør cleanup-scripts mod arbejdskopi (ikke backup). Genkør Fase 1–5 — diff fund |
| Søndag aften | Fase 6: simulér sync mod Bon v2 testbon. Verificér at #001-bug nu er væk |
| Søndag aften | Beslutning: deploy mandag morgen ELLER rul tilbage og lad prod stå urørt |
| Mandag 06:00 | Skift fil ud (`mv grocy.db grocy.db.old && mv grocy-cleaned.db grocy.db` + restart Grocy) |

**Rollback:** Hvis ANY tvivl → ingen deploy. Backup-fil må ikke røres uanset hvad.

---

## Forudsætninger

### Filer

- Prod-fil: `/var/www/grocycafe/data/grocy.db` (på server)
- Lokal arbejdsmappe: `~/grocy-audit-YYYYMMDD/`
- Backup: `~/grocy-audit-YYYYMMDD/grocy-prod-frozen-YYYYMMDD.db` (read-only)
- Arbejdskopi: `~/grocy-audit-YYYYMMDD/grocy.db` (her køres cleanup mod)

### Stack

- Node.js + `better-sqlite3` direkte mod SQLite-fil
- INGEN Grocy API-kald — for hurtigt, offline, ingen rate-limits
- Markdown-rapporter med dato-stempel i filnavn

### npm-pakker

```
better-sqlite3
```

(Ingen andre. Holdes tæt på principperne.)

---

## Fil-struktur

```
scripts/grocy-audit/
├── README.md                    ← kort intro
├── lib/
│   ├── db.js                    ← openDb(path), readonly flag
│   ├── report.js                ← writeReport(name, sections)
│   └── schema.js                ← discoverSchema() — kortlæg tabeller
├── 01_inventar.js
├── 02_struktur.js
├── 03_priser.js
├── 04_enheder.js                ← KERNE for #001
├── 05_co2_allergener.js
├── 06_post_fix_verifikation.js
├── cleanup/
│   ├── README.md                ← genereres fra audit-fund
│   ├── 001_*.sql                ← genereres efter audit
│   └── ...
└── reports/
    ├── 2026-05-02_inventar.md
    ├── 2026-05-02_struktur.md
    └── ...
```

**Princip:** Hver fase = ét script + én markdown-rapport. Scripts kan
køres uafhængigt og er idempotente (ingen writes i audit-fasen).

---

## Fælles helpers

### `lib/db.js`

```javascript
const Database = require('better-sqlite3');

function openDb(path, { readonly = true } = {}) {
    const db = new Database(path, { readonly, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    return db;
}

module.exports = { openDb };
```

### `lib/report.js`

```javascript
const fs = require('fs');
const path = require('path');

function writeReport(name, sections) {
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(__dirname, '..', 'reports', `${date}_${name}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    
    const md = [
        `# ${name} — ${date}`,
        '',
        ...sections.flatMap(s => [`## ${s.title}`, '', s.body, ''])
    ].join('\n');
    
    fs.writeFileSync(file, md);
    console.log(`✓ Rapport: ${file}`);
    return file;
}

module.exports = { writeReport };
```

### `lib/schema.js` — kør først for at lære skemaet

```javascript
function discoverSchema(db) {
    const tables = db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
    `).all().map(r => r.name);
    
    const schema = {};
    for (const t of tables) {
        schema[t] = {
            columns: db.prepare(`PRAGMA table_info(${t})`).all(),
            count: db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n
        };
    }
    return schema;
}

module.exports = { discoverSchema };
```

**Kør først:** `node -e "console.log(JSON.stringify(require('./lib/schema').discoverSchema(require('./lib/db').openDb('./grocy.db')), null, 2))" > reports/schema.json`

Det giver os den faktiske skema-virkelighed inden vi skriver queries.

---

## FASE 1 — Inventar

**Formål:** Baseline. Hvor mange af hver ting findes der? Tal vi kan
sammenligne med efter cleanup.

### Tjekliste FØR (hvad du skal vide)

| Forventet niveau | Hvad det betyder hvis tallet er anderledes |
|------------------|--------------------------------------------|
| ~150–250 produkter | <100: data mangler. >500: gamle inaktive ligger og roder |
| ~50–100 opskrifter aktive (`active=1`) | Mange inaktive: oprydning trænger sig på |
| ~15–30 sellable opskrifter | Skal matche menukortet — hverken mere eller mindre |
| 5 priskategorier (Store, Catering, Festival, Produktion, Waiste) | Færre: userfield-definitioner mangler. Flere: gamle/ubrugte kategorier |
| ~13 kategorier i `grupper`-userfield | Skal matche kategoritræet i Bon v1 (01 Sandwich, 02 Salat, ...) |

### Script `01_inventar.js`

```javascript
const { openDb } = require('./lib/db');
const { writeReport } = require('./lib/report');

const db = openDb('./grocy.db');

const sections = [];

// 1.1 Tabel-tællinger
sections.push({
    title: 'Tabel-tællinger',
    body: '| Tabel | Antal rækker |\n|---|---|\n' +
        ['products', 'recipes', 'recipes_pos', 'quantity_units',
         'quantity_unit_conversions', 'product_groups', 'shopping_list',
         'stock', 'userfields'].map(t => {
            try {
                const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
                return `| ${t} | ${n} |`;
            } catch { return `| ${t} | (findes ikke) |`; }
        }).join('\n')
});

// 1.2 Aktive vs inaktive produkter
sections.push({
    title: 'Produkter — aktive vs inaktive',
    body: db.prepare(`
        SELECT 
            CASE WHEN active=1 THEN 'aktive' ELSE 'inaktive' END AS status,
            COUNT(*) AS n
        FROM products GROUP BY active
    `).all().map(r => `- ${r.status}: ${r.n}`).join('\n')
});

// 1.3 Opskrifter — aktive, sellable, kategorier
sections.push({
    title: 'Opskrifter — sellable/aktiv',
    body: 'TODO: tilpas SQL efter discoverSchema viser hvor sellable og active gemmes\n' +
          '(typisk userfield_values eller direkte kolonne)'
});

// 1.4 Userfield-definitioner
sections.push({
    title: 'Userfields i brug',
    body: db.prepare(`SELECT entity, name, caption, type FROM userfields ORDER BY entity, name`)
        .all()
        .map(r => `- \`${r.entity}.${r.name}\` (${r.type}) — ${r.caption}`)
        .join('\n')
});

// 1.5 Kategorier i grupper-userfield (forventet på recipes)
// TODO: kør når vi ved hvor userfield-værdier er gemt

writeReport('01_inventar', sections);
db.close();
```

### Verifikation — hvad jeg stikprøve-tjekker

- [ ] Antal produkter ser sundt ud (~150–250)
- [ ] Antal sellable opskrifter matcher menukortet
- [ ] 5 priskategorier findes som userfields
- [ ] 13 kategorier i `grupper`-userfield (eller hvad det nu hedder)
- [ ] Inaktive opskrifter ser ud som gamle der med rette er deaktiveret

### Output → næste fase

Schema.json + inventar-rapport bruges som reference i Fase 2–5.

---

## FASE 2 — Strukturelle problemer

**Formål:** Find rækker der bryder antagelser (manglende felter, dubletter,
brudte FK-relationer).

### Tjekliste FØR

| Symptom | Hvad jeg vil se |
|---------|-----------------|
| Aktive opskrifter uden alle priskategorier udfyldt | sellable=1 men Catering eller Festival mangler |
| Aktive produkter uden `qu_id_purchase` eller `qu_id_stock` | Brudt enheds-mapping |
| Dublet-produkter (samme navn, forskellige id'er) | Skaber forvirring i sync |
| Forældrede FK'er (recipes_pos peger på slettede produkter) | Brudte opskrifter |
| Userfield-værdier på slettede entities | Skrald i userfield-tabel |
| Recipes uden recipes_pos-rækker | Tomme opskrifter |

### Script `02_struktur.js`

```javascript
const { openDb } = require('./lib/db');
const { writeReport } = require('./lib/report');

const db = openDb('./grocy.db');
const sections = [];

// 2.1 Aktive produkter med manglende qu-mapping
sections.push({
    title: 'Aktive produkter uden qu_id_purchase eller qu_id_stock',
    body: formatTable(db.prepare(`
        SELECT id, name, qu_id_purchase, qu_id_stock
        FROM products
        WHERE active=1 AND (qu_id_purchase IS NULL OR qu_id_stock IS NULL)
        ORDER BY name
    `).all())
});

// 2.2 Dublet-produkter
sections.push({
    title: 'Mulige dublet-produkter (samme navn)',
    body: formatTable(db.prepare(`
        SELECT name, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
        FROM products
        WHERE active=1
        GROUP BY LOWER(TRIM(name))
        HAVING n > 1
    `).all())
});

// 2.3 Recipes_pos der peger på slettede produkter
sections.push({
    title: 'Recipes_pos med brudte FK til products',
    body: formatTable(db.prepare(`
        SELECT rp.id, rp.recipe_id, rp.product_id
        FROM recipes_pos rp
        LEFT JOIN products p ON p.id = rp.product_id
        WHERE rp.product_id IS NOT NULL AND p.id IS NULL
    `).all())
});

// 2.4 Recipes uden ingredienser (tomme opskrifter)
sections.push({
    title: 'Aktive opskrifter uden ingredienser',
    body: formatTable(db.prepare(`
        SELECT r.id, r.name
        FROM recipes r
        LEFT JOIN recipes_pos rp ON rp.recipe_id = r.id
        WHERE r.id NOT IN (SELECT DISTINCT recipe_id FROM recipes_pos WHERE recipe_id IS NOT NULL)
        ORDER BY r.name
    `).all())
});

// 2.5 Sellable=1 uden Catering- og Festival-pris (fra userfields)
// TODO: skriv når vi ved hvor userfield-værdier er gemt

writeReport('02_struktur', sections);
db.close();

function formatTable(rows) {
    if (!rows.length) return '_(intet at rapportere)_';
    const cols = Object.keys(rows[0]);
    return '| ' + cols.join(' | ') + ' |\n| ' + cols.map(() => '---').join(' | ') + ' |\n' +
        rows.map(r => '| ' + cols.map(c => r[c] ?? '').join(' | ') + ' |').join('\n');
}
```

### Verifikation

- [ ] Listen over aktive produkter uden qu-mapping er overskuelig (< 20)
- [ ] Eventuelle dubletter giver mening (ikke bare stavevarianter)
- [ ] Brudte recipes_pos-rækker er kandidater til sletning
- [ ] Tomme opskrifter er kandidater til deaktivering

### Output → cleanup-kandidater

Hver fund bliver en row i cleanup-listen. Du beslutter hvad der skal
fixes, og Claude Code genererer cleanup-scripts.

---

## FASE 3 — Pris-konsistens

**Formål:** Verificér at sellable opskrifter har konsistente priser i
alle relevante priskategorier.

### Tjekliste FØR

**Pris-konvention** (autoritativ — bekræftet af Leif):
Alle Grocy-priser i userfield-felter er **inkl. moms**.

| Symptom | Hvad jeg vil se |
|---------|-----------------|
| Sellable opskrift uden Catering-pris | Bon v2 kan ikke prissætte den i catering-bonner |
| Festival-pris < Catering-pris med >20% | Sandsynligt — festival er typisk billigere — men ekstreme udslag er mistænkelige |
| Catering-pris < Cost-pris (negativ margin) | Tab på salget — datafejl eller kalkuleringsfejl |
| Pris med øre (89.50, 94.95) | Inkonsistent format — vi kører på hele kroner |
| Pris = 0 | Skal være eksplicit (gratis tilbehør?) eller mangler udfyldning |

### Script `03_priser.js`

Scriptet skal:

1. Læse alle sellable opskrifter
2. Læse userfield-værdier for hver: Store, Catering, Festival, Produktion, Waiste
3. Beregne kostpris pr. portion fra `recipes` (Grocy beregner den selv — kolonne `calc_ingredient_costs` eller lignende)
4. Rapportere:
   - Sellable opskrifter uden alle 5 priser udfyldt
   - Catering-pris < kostpris (negativ margin)
   - Festival vs Catering ratio outliers
   - Pris-fordeling: histogram over salgspriser i Catering
   - Inkonsistent format (decimaler)

### Verifikation

- [ ] Alle aktuelle menu-opskrifter har Catering-pris udfyldt
- [ ] Ingen opskrift sælges under kostpris
- [ ] Festival-priser er konsistent lavere end Catering (eller med god grund)
- [ ] Ingen øre-priser

### Output

Liste over opskrifter der skal pris-opdateres. Du går manuelt gennem
listen i Grocy-UI og retter — eller vi laver et batch-update script.

---

## FASE 4 — Enheds-konsistens (KERNE for #001)

**Formål:** Find kilden til at sync-v1 importerer kostpriser 35–150×
for høje. Hypotesen er at det er enheds-mismatch.

### Tjekliste FØR

| Symptom | Hvad jeg vil se |
|---------|-----------------|
| `qu_id_purchase ≠ qu_id_stock` uden konvertering i `quantity_unit_conversions` | Bug-kilde #1 — beregnet kostpris bliver forkert |
| `amount_for_this_recipe` outliers (>500 eller <0.001) | Sandsynligt enheds-fejl i opskrift |
| Beregnet kostpris pr. portion > 50× salgspris | Bekræfter import-bug rammer |
| `recipes.servings` = 1 men opskriften er klart batch-baseret | Kan også give 35× faktor |
| Konverterings-faktorer der ikke giver mening (1 stk = 1000 g men der står 1) | Forkert kalibreret konvertering |

### Script `04_enheder.js`

Dette er det vigtigste script. Skal:

1. For hver sellable opskrift:
   - Hent salgspris (fra Catering userfield)
   - Hent Grocy's beregnede kostpris pr. portion
   - Beregn ratio = cost / sales
   - Flag opskrifter med ratio > 1.0 (cost ≥ sales — umiddelbart mistænkeligt)
   - Flag opskrifter med ratio > 5.0 (klart bug)

2. For hver flagged opskrift:
   - List ingredienserne (fra `recipes_pos`)
   - For hver ingrediens: vis `amount`, `qu_id`, produktets `qu_id_purchase`,
     `qu_id_stock`, og om der findes en `quantity_unit_conversions` mellem dem
   - Identificér ingrediensen med højest cost-bidrag (sandsynlig synder)

3. Output prioriteret liste:

```
═══ Top 20 mistænkelige opskrifter ═══

#1 Italieneren (id 42)
   Salgspris: 89 kr (Catering)
   Beregnet kostpris: 8.041 kr
   Ratio: 90×
   Højeste cost-ingrediens: "Mozzarella" (id 156)
       amount=200, qu_id=4 (gram)
       product.qu_id_purchase=2 (kg), product.qu_id_stock=4 (gram)
       quantity_unit_conversions: 1 kg = 1000 gram (findes)
   Mistanke: konvertering anvendes ikke ved kostpris-beregning?
            ELLER recipes.servings=1 (skulle være ~30)
```

4. Cross-check: hent en kendt v1-bon med Italieneren og se hvad
   sync-v1 importerede som `bon_lines.cost_price` — matcher det
   Grocy's beregnede kostpris, eller er der et yderligere lag fejl?

### Verifikation

- [ ] Top 20 mistænkelige opskrifter har en identificerbar synder pr. opskrift
- [ ] Synderne falder i 1–3 mønstre (ikke 20 forskellige bugs)
- [ ] Vi kan beslutte: er det Grocy-data der er forkert, sync-script, eller begge?

### Output

Den centrale output fra hele auditen. Bestemmer:
- Hvad cleanup-scripts skal fixe i Grocy-data
- Om sync-v1 også skal rettes (#001)

---

## FASE 5 — Co2e + allergener

**Formål:** Bløde data-felter der ikke knækker noget, men som vi gerne
vil have rene før e-conomic-integration og menu-agent.

### Tjekliste FØR

| Symptom | Konsekvens |
|---------|-----------|
| Sellable opskrift uden Co2e | Bon v2 kan ikke vise CO₂-tal i kalender (se v1-screenshot) |
| Co2e i forskellig enhed (kg vs g) | Tal-skala bliver inkonsistent |
| Co2e åbenlyst forkert (sandwich = 50 kg CO₂) | Datafejl |
| Manglende allergen-flag på sellable opskrifter | Kunde-spørgsmål kan ikke besvares automatisk |
| Inkonsistent allergen-format (komma-separeret vs JSON-array) | Parser-fejl i Bon v2 |

### Script `05_co2_allergener.js`

Read-only listing — ingen forsøg på at gætte rigtige værdier. Producerer
bare en liste over hvad der mangler så du manuelt kan udfylde i Grocy.

### Verifikation

- [ ] Listen er overskuelig
- [ ] Alle aktuelle menu-opskrifter er på listen hvis de mangler felter

### Output

To-do liste til manuel udfyldning i Grocy-UI. Ikke et cleanup-script.

---

## FASE 6 — Post-fix verifikation

**Formål:** Efter cleanup-scripts er kørt mod arbejdskopien, verificér
at #001-bugen er væk.

### Test-strategi

1. **Genkør Fase 1–5** mod den cleanede DB. Diff rapporterne.
   Skal vise færre fund, ingen nye fund.

2. **Simuleret sync mod testbon:**
   - Vælg en kendt v1-bon med Italieneren (eller anden synder fra Fase 4)
   - Kør sync-logikken (eller en kopi der pegers mod cleaned DB) mod den
   - Verificér: er `bon_lines.cost_price` nu sundt? (cost < unit_price)

3. **Smoke-test scripts:**
   ```sql
   -- Skal være < 1% efter fix (var 28% før)
   SELECT 
     ROUND(100.0 * SUM(CASE WHEN cost >= sales THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_inverted
   FROM (
     SELECT 
       <cost-beregning-for-sellable-opskrifter> AS cost,
       <Catering-pris> AS sales
     FROM <relevant join>
     WHERE <sellable=1>
   );
   ```

### Go/No-go beslutning

| Resultat | Handling |
|----------|----------|
| pct_inverted < 1% AND ingen nye fund | GO — deploy mandag morgen |
| pct_inverted forbedret men ikke nok | NO-GO — log som videre arbejde, lad prod stå |
| pct_inverted uændret eller værre | NO-GO — undersøg om cleanup ramte forkert |
| Crash eller nye fejl | NO-GO — rul tilbage |

---

## Cleanup-scripts (mønster)

Cleanup-scripts skrives KUN efter audit. De er **ikke** del af den indledende
audit. Mønster:

```
scripts/grocy-audit/cleanup/
├── README.md                         ← genereret oversigt
├── 001_dedupe_products.sql           ← én SQL-fil pr. fund
├── 002_fix_qu_mapping.sql
├── 003_fix_servings_on_recipe_X.sql
└── apply.js                          ← orchestrator
```

`apply.js` skal:

1. Tage `--dry-run` flag som default
2. Print hver SQL der ville køres + forventet antal rækker påvirket
3. Først ved `--apply` faktisk køre dem
4. Tage backup INDEN apply: `cp grocy.db grocy.db.pre-cleanup-<timestamp>`
5. Køre alle SQL i én transaktion — alt eller intet
6. Logge til `cleanup/log_<timestamp>.txt`

### Cleanup-typer vi kan forvente

| Type | Hvad det fixer |
|------|----------------|
| Dedupe products | Slet dublet-produkter, oprydning af FK |
| Fix qu_mapping | Sæt `qu_id_stock` på produkter hvor det mangler |
| Fix recipes.servings | Sæt korrekt antal portioner på batch-opskrifter |
| Fix konverterings-faktorer | Korrigér kg ↔ g, l ↔ ml, etc. |
| Deaktivér tomme opskrifter | `active=0` på recipes uden ingredienser |
| Fjern brudte recipes_pos | DELETE hvor product_id peger på slettet produkt |

---

## Rollback-plan

### Hvis NOGET går galt

```bash
# Backup-filen er sandheden — den må ikke være rørt
cp ~/grocy-audit-YYYYMMDD/grocy-prod-frozen-YYYYMMDD.db /var/www/grocycafe/data/grocy.db
sudo systemctl restart grocy   # eller hvad der nu starter Grocy
```

### Tjek inden mandag morgen

- [ ] Backup-fil eksisterer og er identisk med den oprindelige (sammenlign md5)
- [ ] Cleaned-fil kan åbnes og lister samme antal opskrifter som baseline
- [ ] Test-Grocy-instance kan køre med cleaned-fil et par timer søndag aften
- [ ] Rollback-kommandoen er testet (på test, ikke prod)

---

## Weekend-tjekliste

### Fredag aften

- [ ] Scp prod-fil ned
- [ ] Tag frossen backup, sæt readonly-permissions
- [ ] Lav `~/grocy-audit-YYYYMMDD/` mappe-struktur
- [ ] `npm install better-sqlite3`
- [ ] Kør schema-discovery: `node lib/schema.js > reports/schema.json`
- [ ] Stikprøve-læs schema.json — find userfield-tabel og pris-kolonner

### Lørdag

- [ ] Kør Fase 1 — verificér tal
- [ ] Kør Fase 2 — gennemgå strukturelle fund
- [ ] Kør Fase 3 — gennemgå pris-fund
- [ ] Beslut: går vi videre med cleanup eller er fundene så små at vi springer over?
- [ ] Kør Fase 4 — gennemgå enheds-fund (det vigtigste)
- [ ] Kør Fase 5 — gennemgå Co2e/allergener (kan udsættes)

### Søndag formiddag

- [ ] Generér cleanup-scripts ud fra fund
- [ ] Læs hvert script igennem manuelt (Claude Code må ikke selvstændigt apply'e)
- [ ] Kør cleanup mod arbejdskopi med `--dry-run`
- [ ] Kør cleanup rigtig mod arbejdskopi

### Søndag eftermiddag

- [ ] Genkør Fase 1–5 — diff mod fredag-rapporterne
- [ ] Kør Fase 6 — sync-simulation
- [ ] Beslutning: deploy eller rul tilbage

### Mandag 06:00

- [ ] Stop Grocy
- [ ] Backup nuværende prod-fil med tidsstempel
- [ ] Skift fil ud
- [ ] Start Grocy
- [ ] Tjek at vagtplaner, opskrifter, lager ser rigtige ud i UI
- [ ] Lav første test-bon i Bon v2 og verificér priser

### Hvis noget ser galt ud

- [ ] Stop Grocy
- [ ] Kopiér backup tilbage
- [ ] Start Grocy
- [ ] Log fejlen i `KENDTE_DATABUGS.md` som ny bug

---

## Hvad der ER og IKKE ER i scope

### I scope

- Kortlægning af Grocy-data quality (alle 5 faser)
- Cleanup af Grocy-data (efter Leifs godkendelse)
- Verifikation af at #001-bug forsvinder efter cleanup

### IKKE i scope

- Ændringer i Bon v2-koden (`scripts/sync-v1.js`, `routes/`, etc.)
- Ny migration eller skema-ændring i Bon v2
- Trailer- eller Test-Grocy
- Re-import af eksisterende v1-data i Bon v2 (separat opgave)

---

## Næste skridt efter denne audit

1. Audit-resultater dokumenteres som nye bugs i `KENDTE_DATABUGS.md`
   (#003, #004, ...) hvis der er fund der ikke kan fixes nu
2. Hvis #001-bug er væk i Grocy-data: vurdér om sync-v1 kan re-køre
   mod cleanede Grocy-data og overskrive forkerte v2-rækker
3. Trailer-Grocy: planlæg separat audit (samme spec, andet sted)
4. Test-Grocy: kan opdateres med samme cleanup hvis relevant

---

*Sidst opdateret: 1. maj 2026*
