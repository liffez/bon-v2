# Specifikation: Kundeindsigt, RFM-scoring & Prospektering
**Ristet Rug – Bon v2 CRM**
*Tillæg til CRM_Design_Document_v2.md — april 2026*

---

## Overblik

**Dette er ikke et nyt system — det er tre ekstra sider i den eksisterende navigation.**

Den nuværende navigationsstruktur:
```
Daglig drift:  Dagsoverblik · Forslag · Ring tilbage · Mandagsliste
Salg:          Pipeline · Tilbud · Bons
Kunder:        Virksomheder · Kontakter
Indstillinger: (eksisterende)
```

Efter denne udvidelse:
```
Daglig drift:  Dagsoverblik · Forslag · Ring tilbage · Mandagsliste
Salg:          Pipeline · Tilbud · Bons
Kunder:        Virksomheder · Kontakter · Re-aktivering · Prospekter · Kundeindsigt  ← 3 nye sider
Indstillinger: ... · Aktivitetsformål  ← 1 ny admin-side
```

De tre nye sider følger samme layout-principper, farveskema og interaktionsmønstre som resten af CRM'et. Det eneste strukturelt nye er SQL-views og to nye tabeller i baggrunden (`rfm_config` og `activity_purposes`). Der introduceres ingen nye UI-koncepter.

---

## Hvad de tre sider gør

**Re-aktivering** — en prioriteret ringeliste over sovende kunder der engang var gode. Samme format som mandagslisten, men sorteret efter RFM-potentiale i stedet for leveringsdato.

**Prospekter** — leads der endnu ikke har bestilt. Opret via CVR-nummer, systemet scorer dem mod ICP-profilen og viser hvem der ligner jeres bedste kunder.

**Kundeindsigt** — RFM-dashboard med justerbare vægte og ICP-profil. Svarer på: hvem er vores bedste kunder, hvad kendetegner dem, og hvor finder vi flere af dem.

---

## To strategiske arbejdsflows

**Strategi 1 — Re-aktivering af tidligere kunder**
Rangér de 750 eksisterende firmaer automatisk via RFM-scoring, find dem der engang var gode men er faldet væk, og giv salgsteamet en prioriteret ringeliste med kontekst.

**Strategi 2 — Find nye kunder via ICP**
Byg en datadrevet profil af jeres idealkunde fra ordrehistorikken. Brug den til at identificere lookalikes i den sovende database og til at guide prospektering af helt nye kunder.

Begge strategier kræver **branchedata** for at blive præcise. Branchedata hentes automatisk fra CVR-registret der hvor vi har CVR-nummer, og manuelt tilføjes for resten efterhånden.

---

## Del 1 — Dataudvidelse: Branche via CVR

### 1.1 Ny kolonne på `companies`

```sql
ALTER TABLE companies ADD COLUMN branch TEXT;
ALTER TABLE companies ADD COLUMN branch_source TEXT; -- 'cvr_auto' | 'cvr_manual' | 'user'
ALTER TABLE companies ADD COLUMN branch_updated_at TEXT;
ALTER TABLE companies ADD COLUMN cvr_enriched_at TEXT;
-- Gemmer rå CVR-respons til fremtidig brug
ALTER TABLE companies ADD COLUMN cvr_raw_json TEXT;
-- Personligt firma: auto-oprettet for privatkunder (kundens navn som firmanavn)
ALTER TABLE companies ADD COLUMN is_personal INTEGER NOT NULL DEFAULT 0;
```

### 1.1a Privatkunder → personligt firma

**Problem:** RFM scorer per `company_id`. Kunder med `company_id = NULL` falder helt ud af scoringen — ingen RFM, ingen stage, usynlige i Re-aktivering og Kundeindsigt.

**Løsning:** Alle kunder skal have et firma. Privatkunder får automatisk et "personligt firma" ved oprettelse.

**Regler:**
- Når en kunde oprettes uden firma (Privatkunde-checkbox i `kunde_soeg.js`, webhook, etc.):
  1. Opret en `companies`-række med `name = kundens fulde navn`, `is_personal = 1`
  2. Knyt `customer.company_id` til det nye firma
- `is_personal = 1` firmaer:
  - Vises med "Privat"-badge i UI (ikke firmaikon)
  - Springes over i CVR-enrichment (`cvr = NULL`)
  - Indgår normalt i RFM-scoring (ingen special cases)
  - Vises i Kundeindsigt-tabellen med kundenavn i stedet for firmanavn
- Firmanavnet opdateres automatisk hvis kundens navn ændres
- Eksisterende kunder uden firma: en migration opretter personlige firmaer for dem

**Migration for eksisterende data:**
```sql
-- Opret personligt firma for alle kunder uden company_id
INSERT INTO companies (name, is_personal, created_at)
SELECT
  c.first_name || ' ' || COALESCE(c.last_name, ''),
  1,
  datetime('now')
FROM customers c
WHERE c.company_id IS NULL;

-- Knyt kunder til deres nye personlige firma
-- (kræver en UPDATE i applikationskode da vi har brug for last_insert_rowid per kunde)
```

**Implementeringsnote:** Migrationen er nemmest som et Node-script (ikke ren SQL) fordi hver kunde skal matches til sit eget nye firma. Se `scripts/`-mappen for pattern.

### 1.2 CVR API — automatisk opslag

**Endpoint:** `https://cvrapi.dk/api?country=dk&cvr=NUMMER`
*(Eksisterende CVR-integration i Bon v2 kan genbruges)*

**Relevant data vi henter:**

| CVR-felt | Gemmes som | Bruges til |
|----------|-----------|------------|
| `industrycode` / `industrycode_text` | `branch` | ICP, segmentering |
| `employees` | `companies.employee_count` (ny kolonne) | ICP firmastørrelse |
| `city` | allerede i `companies` | Geografi-ICP |
| `companytypetext` | `companies.company_type` (ny kolonne) | A/S vs. ApS vs. forening |

**DB-branche-mapping** — CVR's branchekode oversættes til én af 10 kategorier:

| Branchekoder (eksempler) | Bon v2-kategori |
|--------------------------|-----------------|
| 620xxx, 582xxx | IT/Tech |
| 641xxx–649xxx | Finans |
| 721xxx, 731xxx | Pharma/Forskning |
| 701xxx, 702xxx | Konsulenter |
| 691xxx | Advokater |
| 261xxx–299xxx | Industri/Produktion |
| 493xxx–532xxx | Logistik |
| 351xxx, 353xxx | Energi |
| 900xxx–920xxx | Kultur/Event/Medie |
| øvrige | Øvrige |

Mapping-tabellen gemmes i kode (ikke DB) og kan justeres.

### 1.3 CVR-datakvalitet — audit før enrichment

**⚠️ Vigtigt: Kør denne audit INDEN enrichment-jobbet startes.**

Erfaringen viser at CVR-numre i eksisterende data kan indeholde fejl: forkert format, manglende nuller, gamle CVR-numre der ikke længere er aktive, eller blankt felt hvor der burde stå et nummer.

**Audit-query — kør manuelt og gennemgå output:**

```sql
-- Overblik over CVR-data-kvalitet
-- NB: SQLite understøtter ikke FILTER (WHERE ...) — brug SUM(CASE WHEN ... END) i stedet
SELECT
  COUNT(*)                                          AS firmaer_i_alt,
  COUNT(cvr)                                        AS har_cvr_felt,
  SUM(CASE WHEN cvr IS NULL OR cvr = '' THEN 1 ELSE 0 END) AS mangler_cvr,

  -- Format-tjek: dansk CVR er altid 8 cifre
  SUM(CASE WHEN cvr IS NOT NULL AND cvr != ''
    AND LENGTH(REPLACE(cvr,' ','')) != 8
    THEN 1 ELSE 0 END)                              AS forkert_laengde,

  -- Ikke-numeriske CVR-numre
  SUM(CASE WHEN cvr IS NOT NULL AND cvr != ''
    AND cvr GLOB '*[^0-9]*'
    THEN 1 ELSE 0 END)                              AS ikke_numerisk,

  -- Tilsyneladende gyldige
  SUM(CASE WHEN cvr IS NOT NULL AND cvr != ''
    AND LENGTH(REPLACE(cvr,' ','')) = 8
    AND NOT cvr GLOB '*[^0-9]*'
    THEN 1 ELSE 0 END)                              AS tilsyneladende_gyldige

FROM companies;
```

**Detailliste over problematiske CVR-numre:**

```sql
SELECT id, name, cvr,
  CASE
    WHEN cvr IS NULL OR cvr = ''         THEN 'Mangler'
    WHEN LENGTH(REPLACE(cvr,' ','')) != 8 THEN 'Forkert længde'
    WHEN cvr GLOB '*[^0-9]*'             THEN 'Ikke numerisk'
    ELSE 'OK'
  END AS status
FROM companies
WHERE cvr IS NULL OR cvr = ''
   OR LENGTH(REPLACE(cvr,' ','')) != 8
   OR cvr GLOB '*[^0-9]*'
ORDER BY name;
```

**Hvad der skal ske med listen:**
- `Mangler` → kig firmaet op manuelt og tilføj CVR, eller acceptér at det ikke enriches automatisk
- `Forkert længde` → sandsynligvis et manglende foranstillet 0 (f.eks. "1234567" → "01234567") — kan rettes med en migration
- `Ikke numerisk` → slettet bindestreg, mellemrum eller bogstav — rettes manuelt

**Migration til at normalisere format:**
```sql
-- Fjern mellemrum og bindestreger fra alle CVR-felter
UPDATE companies
SET cvr = REPLACE(REPLACE(cvr, ' ', ''), '-', '')
WHERE cvr IS NOT NULL;

-- Pad med foranstillet 0 hvor længde er 7
UPDATE companies
SET cvr = '0' || cvr
WHERE LENGTH(cvr) = 7 AND NOT cvr GLOB '*[^0-9]*';
```

Først når audit er gennemgået og åbenlyse fejl er rettet → kør enrichment.

### 1.5 CVR API — automatisk opslag

Et baggrundsjob der kører ved opstart og derefter 1x dagligt:

```
For hvert firma i companies hvor branch IS NULL og cvr IS NOT NULL:
  1. Opslag i CVR API (max 1 req/sek for at overholde rate limit)
  2. Gem branch, employee_count, company_type, cvr_raw_json
  3. Sæt branch_source = 'cvr_auto', cvr_enriched_at = now()
  4. Log antal opdaterede firmaer
```

Estimat: ~750 firmaer, ~12 minutter første kørsel. Baggrunden må ikke blokere UI.

**Endpoint til at trigge manuelt:**
`POST /api/admin/enrich-companies`
Response: `{ queued: 420, already_enriched: 280, missing_cvr: 50 }`

### 1.6 Manuel branche-tildeling

For firmaer uden CVR-nummer: branche kan sættes direkte fra firmakortet.

**UI-placering:** Firmakort → venstre panel → under firmanavn
```
Branche: [IT/Tech ▾]   Kilde: bruger
```

Dropdown med de 10 kategorier + "Øvrige".

Hvis `branch_source = 'cvr_auto'` vises en lille CVR-chip ved siden af — signalerer at det er automatisk udfyldt og kan overrides.

### 1.7 Dækning — hvornår er ICP brugbar?

ICP-profilen er kun meningsfuld når der er tilstrækkelig branchedata. Systemet viser:

```
Brancher udfyldt: 487 / 748 firmaer (65%)
ICP-branche-statistik: pålidelig ✓
```

Under 40% → advarsel: "For lidt branchedata til pålidelig ICP — kør CVR-enrichment"

---

## Del 2 — RFM-scoring

### 2.1 Hvad er RFM?

**R — Recency:** Hvor nylig var seneste ordre? Nyere = bedre.
**F — Frequency:** Hvor mange ordrer i alt? Flere = bedre.
**M — Monetary:** Hvad er volumenet? Her bruges **antal gæster** (ikke kr.) da det afspejler reelt aktivitetsniveau bedre i catering.

### 2.2 Beregning

RFM beregnes som en **normaliseret vægtet sum** — alle tre dimensioner normaliseres til 0–100 inden de kombineres. Det betyder at absolute tal ikke afgør, men relativ position i kundebasen.

```sql
-- View: v_rfm_raw
-- Beregner rådata pr. firma
CREATE VIEW v_rfm_raw AS
SELECT
  c.id AS company_id,
  c.name,
  c.branch,
  c.employee_count,
  c.city,
  COUNT(DISTINCT b.id) AS order_count,
  -- Monetary: bruger bons.pax (antal gæster pr. bon), ikke bon_lines
  SUM(COALESCE(b.pax, 0)) AS total_guests,
  AVG(COALESCE(b.pax, 0)) AS avg_guests,
  -- NB: delivery_date — IKKE event_date (eksisterer ikke i skemaet)
  CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) AS days_since_last_order,
  MIN(b.delivery_date) AS first_order_date,
  MAX(b.delivery_date) AS last_order_date
FROM companies c
LEFT JOIN customers cu ON cu.company_id = c.id
LEFT JOIN bons b ON b.customer_id = cu.id
  AND b.is_offer = 0
  AND b.status_id NOT IN (SELECT id FROM status_definitions WHERE code IN ('AFLYST', 'TILBUD'))
GROUP BY c.id;
```

```sql
-- View: v_rfm_scores
-- Normaliserer og kombinerer med konfigurerbare vægte
-- Vægte og tærskler styres via rfm_config-tabellen (se 2.3)
CREATE VIEW v_rfm_scores AS
WITH raw AS (SELECT * FROM v_rfm_raw),
bounds AS (
  SELECT
    MAX(days_since_last_order) AS max_r, MIN(days_since_last_order) AS min_r,
    MAX(order_count) AS max_f,          MIN(order_count) AS min_f,
    MAX(total_guests) AS max_m,         MIN(total_guests) AS min_m
  FROM raw WHERE order_count > 0
),
normalized AS (
  SELECT
    r.company_id, r.name, r.branch, r.employee_count, r.city,
    r.order_count, r.total_guests, r.avg_guests,
    r.days_since_last_order, r.last_order_date,
    -- Recency: inverteret (færre dage = højere score)
    CASE WHEN b.max_r = b.min_r THEN 50
    ELSE CAST(100.0 * (b.max_r - r.days_since_last_order) / (b.max_r - b.min_r) AS INTEGER)
    END AS r_score,
    -- Frequency
    CASE WHEN b.max_f = b.min_f THEN 50
    ELSE CAST(100.0 * (r.order_count - b.min_f) / (b.max_f - b.min_f) AS INTEGER)
    END AS f_score,
    -- Monetary (gæster)
    CASE WHEN b.max_m = b.min_m THEN 50
    ELSE CAST(100.0 * (r.total_guests - b.min_m) / (b.max_m - b.min_m) AS INTEGER)
    END AS m_score
  FROM raw r, bounds b
  WHERE r.order_count > 0
),
config AS (
  SELECT
    CAST(value AS REAL) / 100.0 AS w
  FROM rfm_config
  -- returnerer w_r, w_f, w_m som tre rækker
)
SELECT
  n.*,
  CAST(
    n.r_score * (SELECT value FROM rfm_config WHERE key='w_r') / 100.0 +
    n.f_score * (SELECT value FROM rfm_config WHERE key='w_f') / 100.0 +
    n.m_score * (SELECT value FROM rfm_config WHERE key='w_m') / 100.0
  AS INTEGER) AS rfm_score
FROM normalized n;
```

### 2.2a Implementeringsnote: Materialiseret tabel i stedet for views

**⚠️ Anbefaling:** `v_rfm_raw` og `v_rfm_scores` bør IKKE implementeres som SQL views. SQLite har ingen materialiserede views, og beregningen kræver full table scan med joins (companies → customers → bons) + normalisering (MIN/MAX over hele datasættet) ved hvert query.

**I stedet:** Beregn RFM som et batch-job og gem resultatet i en `rfm_scores`-tabel:

```sql
CREATE TABLE rfm_scores (
  company_id    INTEGER PRIMARY KEY REFERENCES companies(id),
  order_count   INTEGER NOT NULL DEFAULT 0,
  total_guests  INTEGER NOT NULL DEFAULT 0,
  avg_guests    REAL NOT NULL DEFAULT 0,
  days_since_last_order INTEGER,
  first_order_date TEXT,
  last_order_date  TEXT,
  r_score       INTEGER NOT NULL DEFAULT 0,  -- 0–100 normaliseret
  f_score       INTEGER NOT NULL DEFAULT 0,
  m_score       INTEGER NOT NULL DEFAULT 0,
  rfm_score     INTEGER NOT NULL DEFAULT 0,  -- vægtet sum
  stage         TEXT,                         -- 'vip'/'aktiv'/'sovende'/'lead'
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Genberegning:** Kør ved:
1. Dagligt baggrundsjob (samme som auto-staging)
2. Manuel trigger via `POST /api/rfm/recalculate`
3. Når RFM-vægte ændres via settings

**Fordele:** Hurtigere queries (simpel SELECT), enklere debugging (inspicér tabellen direkte), og undgår at normalisering genberegnes ved hvert page load.

**Kundeindsigt-siden:** Henter hele `rfm_scores`-tabellen (max ~750 rækker) til browseren og scorer/sorterer client-side med sliderne. Det giver instant feedback ved slider-ændringer uden server-roundtrips. Kun ved "Gem vægte" sendes `POST /api/rfm/config` + trigger genberegning.

### 2.3 Konfigurations-tabel

```sql
CREATE TABLE rfm_config (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL,
  label TEXT
);

INSERT INTO rfm_config VALUES
  ('w_r',          35, 'Recency-vægt (%)'),
  ('w_f',          40, 'Frequency-vægt (%)'),
  ('w_m',          25, 'Monetary-vægt (%)'),
  ('vip_pct',      15, 'VIP-tærskel (top %)'),
  ('aktiv_pct',    50, 'Aktiv-tærskel (top %)'),
  ('recency_days', 180,'Recency cutoff (dage) — ældre tæller som "inaktiv" i R-score');
```

**Vigtig invariant:** `w_r + w_f + w_m` behøver ikke summere til 100 — de normaliseres automatisk i beregningen. Det betyder sliderne er uafhængige.

### 2.4 Auto-staging via RFM

Et job der kører 1x dagligt (eller ved manuel trigger) opdaterer stage i `rfm_scores`-tabellen:

**⚠️ Arkitektur-note:** `crm_customer_meta` er knyttet til `customer_id` (kontaktperson), men RFM scorer per `company_id` (firma). Stage-feltet i `rfm_scores` er den autoritative kilde for firma-staging. For kontaktpersoner uden firma bruges `crm_customer_meta.stage` som fallback.

```
For alle firmaer med rfm_score i rfm_scores-tabellen:
  Top vip_pct% → stage = 'vip'      (sættes kun hvis ikke allerede manuelt låst)
  Top aktiv_pct% men ikke VIP → stage = 'aktiv'
  Resten med ordrer → stage = 'sovende'
  Aldrig bestilt → stage = 'lead'
```

**Manuel override:** Medarbejdere kan altid manuelt overskrive den RFM-beregnede stage på et firma. Det er den korrekte løsning — RFM kender ikke hele historien, og salgsteamet gør.

Stage-lås gemmes direkte i `rfm_scores`-tabellen (ikke i `crm_customer_meta`):

```sql
-- Tilføj til rfm_scores-tabellen (se 2.2a):
--   stage_locked     INTEGER DEFAULT 0,
--   stage_locked_by  INTEGER REFERENCES users(id),
--   stage_locked_at  TEXT
```

**Regler:**
- Når en bruger manuelt sætter stage → `stage_locked = 1` sættes automatisk
- Auto-staging job springer firmaer med `stage_locked = 1` over
- UI viser en lille chip ved siden af stage-badget: `🔒 Manuelt sat`
- Chippen har en "Nulstil til RFM"-knap der sætter `stage_locked = 0` og lader auto-staging overtage igen
- Der logges en aktivitet ved manuel stage-ændring: "Stage ændret til VIP af Leif H."

### 2.5 API-endpoints for RFM

```
GET  /api/rfm/scores?filter=vip|aktiv|sovende|all&limit=50&offset=0
GET  /api/rfm/config
POST /api/rfm/config          body: { w_r, w_f, w_m, vip_pct, aktiv_pct, recency_days }
POST /api/rfm/recalculate     trigger manuel genberegning
```

---

## Del 3 — ICP (Ideal Customer Profile)

### 3.1 Hvad er ICP?

ICP beregnes automatisk fra de kunder der er i det valgte segment (VIP eller top 25%) og beskriver gennemsnitsprofilen. Det er ikke et statisk dokument — det opdateres automatisk når nye ordrer kommer ind eller RFM-scoren ændres.

### 3.2 Beregning

```sql
-- NB: Med materialiseret rfm_scores-tabel er dette en simpel query.
-- Beregnes server-side i ICP API-endpoint, ikke som SQL view.
-- VIP-firmaer hentes direkte fra rfm_scores.stage = 'vip'.

SELECT
  -- Bestillingsmønster
  AVG(s.order_count)                        AS avg_orders_total,
  AVG(CAST(s.order_count AS REAL) /
    MAX(1, (julianday('now') - julianday(s.first_order_date)) / 365.0))
                                             AS avg_orders_per_year,
  AVG(s.avg_guests)                         AS avg_guests_per_event,
  AVG(s.total_guests)                       AS avg_total_guests,

  -- Firmaprofil
  AVG(c.employee_count)                     AS avg_employees,

  -- Top kategori (bruger price_category_id FK, ikke tekst)
  (SELECT pc.code FROM bons b2
   JOIN customers cu2 ON cu2.id = b2.customer_id
   LEFT JOIN price_categories pc ON pc.id = b2.price_category_id
   WHERE cu2.company_id IN (SELECT company_id FROM rfm_scores WHERE stage = 'vip')
     AND b2.is_offer = 0
   GROUP BY pc.code ORDER BY COUNT(*) DESC LIMIT 1) AS top_category,

  COUNT(*) AS icp_company_count

FROM rfm_scores s
JOIN companies c ON c.id = s.company_id
WHERE s.stage = 'vip';
```

**Top brancher** beregnes som en separat query:
```sql
SELECT branch, COUNT(*) as n,
       CAST(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER () AS INTEGER) AS pct
FROM companies
WHERE id IN (SELECT company_id FROM rfm_scores WHERE stage = 'vip')
  AND branch IS NOT NULL
GROUP BY branch
ORDER BY n DESC
LIMIT 6;
```

**Sæsonmønster** — hvilke måneder bestilles mest:
```sql
-- NB: delivery_date — IKKE event_date
SELECT strftime('%m', b.delivery_date) AS month,
       COUNT(*) AS order_count
FROM bons b
JOIN customers cu ON cu.id = b.customer_id
WHERE cu.company_id IN (SELECT company_id FROM rfm_scores WHERE stage = 'vip')
  AND b.is_offer = 0
GROUP BY month
ORDER BY order_count DESC;
```

### 3.3 ICP API

```
GET /api/icp/profile?source=vip|top25
```

Response:
```json
{
  "source": "vip",
  "company_count": 112,
  "avg_orders_per_year": 4.2,
  "avg_guests_per_event": 67,
  "avg_employees": 85,
  "top_category": "catering",
  "top_branches": [
    { "branch": "IT/Tech",    "pct": 24 },
    { "branch": "Finans",     "pct": 18 },
    { "branch": "Pharma",     "pct": 14 },
    { "branch": "Konsulenter","pct": 11 },
    { "branch": "Advokater",  "pct":  9 },
    { "branch": "Øvrige",     "pct": 24 }
  ],
  "peak_months": [11, 12, 3, 4],
  "geo_distribution": {
    "Storkøbenhavn": 68,
    "Sjælland øvrige": 19,
    "Jylland/Fyn": 13
  },
  "branch_coverage_pct": 65
}
```

---

## Del 4 — Strategi 1: Re-aktivering af tidligere kunder

### 4.1 Formål

Jeres database indeholder sandsynligvis 100–200 firmaer der engang bestilte jævnligt men er stoppet. Mange af dem kender jer og er ikke "tabt" — de er bare ikke blevet ringet op. Det er nemmere at genaktivere en gammel kunde end at vinde en ny.

### 4.2 Lookalike-sovende

De mest værdifulde sovende kunder er dem der **ligner jeres VIP'er** — høj F og M score, men lav R fordi de ikke har bestilt i lang tid.

```sql
-- NB: Med materialiseret rfm_scores-tabel (se 2.2a) er dette en simpel query,
-- ikke en view der genberegner ved hvert kald.
-- PERCENTILE_SCORE eksisterer ikke i SQLite — brug stage-kolonne fra rfm_scores i stedet.
SELECT
  s.*,
  c.branch, c.employee_count, c.city,
  -- Potentiale-score: ignorer R, vægt kun F og M
  CAST(s.f_score * 0.55 + s.m_score * 0.45 AS INTEGER) AS potential_score,
  -- Matcher ICP top-brancher?
  CASE WHEN c.branch IN (
    -- Top 3 brancher blandt VIP-kunder
    SELECT branch FROM companies
    WHERE id IN (SELECT company_id FROM rfm_scores WHERE stage = 'vip')
      AND branch IS NOT NULL
    GROUP BY branch ORDER BY COUNT(*) DESC LIMIT 3
  ) THEN 1 ELSE 0 END AS icp_match
FROM rfm_scores s
JOIN companies c ON c.id = s.company_id
WHERE s.stage = 'sovende'
  AND s.days_since_last_order > (SELECT value FROM rfm_config WHERE key = 'recency_days')
  AND s.order_count >= 2  -- minimum 2 ordrer historisk
ORDER BY potential_score DESC, icp_match DESC;
```

### 4.3 UI — Re-aktiveringsmodul

**Placering:** Ny fane under "Kunder" → "Re-aktivering"

**Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│  Re-aktivering                                              │
│  87 sovende kunder med høj potentiale · sorteret efter fit  │
│                                                             │
│  Filter: [Alle] [ICP-match] [Tidl. VIP] [Ikke kontaktet]   │
├─────┬──────────────────┬──────┬──────┬──────────┬───────────┤
│  #  │ Firma            │ Pot. │ Ord. │ Sidst    │ Handling  │
├─────┼──────────────────┼──────┼──────┼──────────┼───────────┤
│  1  │ Gorrissen Fed.   │  82  │  7   │ 14 mdr.  │ [📞 Ring] │
│     │ Advokater · KBH  │ ████ │      │          │           │
├─────┼──────────────────┼──────┼──────┼──────────┼───────────┤
│  2  │ Nordea Denmark   │  74  │  5   │ 18 mdr.  │ [📞 Ring] │
│     │ Finans · ICP ✓   │ ███  │      │          │           │
└─────┴──────────────────┴──────┴──────┴──────────┴───────────┘
```

**ICP-match badge** vises på firmaer hvis branche passer i top 3 ICP-brancher.

**"📞 Ring"-knap** → åbner standard opkalds-flow med pre-udfyldt formål "Re-aktivering" og en foreslået åbningslinje baseret på sidst bestilte produkt og årstid.

### 4.4 Foreslået åbningslinje (auto-genereret)

Systemet genererer en simpel tekst baseret på ordrehistorik — ingen AI nødvendig:

```
"Sidst I var hos os: Julefrokost 2024, 45 gæster.
Foreslået åbner: 'Hej [navn], vi har ikke talt siden jeres julefrokost i 2024 — 
tænkte bare vi skulle høre om I planlægger noget til i år?'"
```

Genereres ved at flette: `last_product_type` + `last_event_month` + `last_guest_count`.

### 4.5 Aktivitetslogning på re-aktiverings-opkald

Når opkaldet logges fra re-aktiverings-listen sættes `purpose_id` automatisk til den `activity_purposes`-række hvor `key = 're_aktivering'` (ingen ekstra klik). Det giver statistik på: hvor mange re-aktiverings-opkald → konvertering.

---

## Del 5 — Strategi 2: Find nye kunder via ICP

### 5.1 Formål

ICP-profilen beskriver jeres idealkunde. Nye kunder der matcher profilen har statistisk set højere sandsynlighed for at blive gode kunder. Dette modul hjælper med at prioritere prospektering.

### 5.2 Manuelt prospekt-flow

Nye firmaer kan tilføjes som **prospekter** — de er endnu ikke i systemet men matches mod ICP.

**Opret prospekt:**
1. Indtast firmanavn eller CVR-nummer
2. CVR-lookup henter automatisk: branche, ansatte, by, firmatype
3. Systemet scorer "ICP-fit" (0–100) baseret på branche-match, størrelse og geografi
4. Prospektet oprettes som firma med `stage = 'lead'` og første aktivitet "Prospekt oprettet"

**ICP-fit score:**
```
Branche i top 3 ICP-brancher:  +40 point
Ansatte 25–200 (ICP-interval):  +30 point
By: Storkøbenhavn:               +20 point
Firmatype: A/S eller ApS:        +10 point
```

### 5.3 Prospekt-liste med ICP-fit

**Placering:** "Kunder" → "Prospekter" (fane)

```
┌──────────────────────────────────────────────────────────────┐
│  Prospekter                          [+ Tilføj fra CVR]      │
│  23 leads · sorteret efter ICP-fit                           │
│                                                              │
│  ICP: IT/Tech (24%) · Finans (18%) · Pharma (14%)  [Justér] │
├─────┬──────────────────┬──────────┬────────┬─────────────────┤
│  #  │ Firma            │ ICP-fit  │ Kilde  │ Handling        │
├─────┼──────────────────┼──────────┼────────┼─────────────────┤
│  1  │ Trifork A/S      │ 90 ████  │ Manuel │ [📞 Ring]       │
│     │ IT/Tech · 180 ans│          │        │                 │
├─────┼──────────────────┼──────────┼────────┼─────────────────┤
│  2  │ Kapital Partners │ 80 ███   │ CVR    │ [📞 Ring]       │
│     │ Finans · 45 ans  │          │        │                 │
└─────┴──────────────────┴──────────┴────────┴─────────────────┘
```

### 5.4 Aktivitets-formål for nye kunder

Opkald til nye prospekter logges med `purpose = 'nyt_lead'`. Giver statistik på:
- Nyt lead → salgsfrokost tilbudt → ordre

---

## Del 6 — Aktivitetslogning: Formål-felt

*(Se separat mockup: crm-log-formaal.html)*

### 6.1 Nyt felt på `crm_activities`

```sql
ALTER TABLE crm_activities ADD COLUMN purpose_id INTEGER REFERENCES activity_purposes(id);
```

`purpose_id` er en FK til en konfigurerbar opslagstabel i stedet for en hardkodet enum. Det giver fuld fleksibilitet til at tilpasse, tilføje og deaktivere formål uden DB-migration.

### 6.1a Ny tabel: `activity_purposes`

```sql
CREATE TABLE activity_purposes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,     -- maskin-id, ændres aldrig efter oprettelse
  label       TEXT NOT NULL,            -- vises i UI
  emoji       TEXT,                     -- valgfri ikon
  description TEXT,                     -- tooltip/hjælpetekst i UI
  is_system   INTEGER DEFAULT 0,        -- 1 = systemformål, kan ikke slettes eller deaktiveres
  is_active   INTEGER DEFAULT 1,        -- 0 = deaktiveret (skjult i UI, bevaret i historik)
  sort_order  INTEGER DEFAULT 100,      -- rækkefølge i dropdown
  created_at  TEXT DEFAULT (datetime('now'))
);
```

**Seed-data (standard-formål):**

```sql
INSERT INTO activity_purposes (key, label, emoji, description, is_system, sort_order) VALUES
  ('opfoelgning',   'Opfølgning',    '🔁', 'Generel opfølgning på tidligere kontakt',      1, 10),
  ('nyt_lead',      'Nyt lead',      '👤', 'Første kontakt med ny potentiel kunde',         1, 20),
  ('salgsfrokost',  'Salgsfrokost',  '🥗', 'Tilbud om eller afholdelse af salgsfrokost',   1, 30),
  ('saesonoutreach','Sæson',         '🌸', 'Sæsonbaseret outreach: jul, sommer, påske',    1, 40),
  ('re_aktivering', 'Re-aktivering', '💤', 'Genoptagelse af kontakt til sovende kunde',    1, 50),
  ('service',       'Service',       '🔧', 'Serviceopkald efter levering',                 1, 60);
```

**Regler:**
- `is_system = 1` → kan ikke slettes og kan ikke deaktiveres (forhindres i applikationslaget)
- `is_system = 0` (brugeroprettet) → kan deaktiveres med `is_active = 0`; kan ikke slettes hvis der er aktiviteter knyttet til formålet — i stedet deaktiveres det
- Deaktiverede formål (`is_active = 0`) vises **ikke** i log-formularen, men bevares fuldt i aktivitetshistorik og statistik — historiske data forbliver intakte
- `key` sættes ved oprettelse og ændres aldrig — bruges i kode og views til at identificere formålet sikkert uanset om `label` ændres

### 6.1b Administrations-UI for formål

**Placering:** Indstillinger → "Aktivitetsformål"

```
┌─────────────────────────────────────────────────────┐
│  Aktivitetsformål                  [+ Nyt formål]   │
├──────┬─────────────────┬───────┬────────────────────┤
│ Ikon │ Navn            │ Type  │ Handling           │
├──────┼─────────────────┼───────┼────────────────────┤
│  🔁  │ Opfølgning      │ System│ —                  │
│  👤  │ Nyt lead        │ System│ —                  │
│  🥗  │ Salgsfrokost    │ System│ —                  │
│  🌸  │ Sæson           │ System│ —                  │
│  💤  │ Re-aktivering   │ System│ —                  │
│  🔧  │ Service         │ System│ —                  │
│  🍾  │ Event-opfølgning│ Bruger│ [Rediger] [Sluk]   │
├──────┴─────────────────┴───────┴────────────────────┤
│  ⚠️  Systemformål kan ikke ændres eller deaktiveres  │
└─────────────────────────────────────────────────────┘
```

**"Nyt formål"-flow:** Popup med navn, emoji (valgfri) og beskrivelse. `key` genereres automatisk fra navn (lowercase, no-spaces).

### 6.2 Salgsfrokost-funnel

Salgsfrokost er et mini-pipeline i sig selv og trackes med to aktiviteter:

**Trin 1 — Frokost tilbudt** (`purpose = 'salgsfrokost'`, `result = 'reached'`)
- Logges når man ringer og tilbyder frokosten
- Note-feltet udfyldes med kundens reaktion
- Hvis accepteret: sæt `follow_up_at` til aftalt dato

**Trin 2 — Frokost holdt** (ny aktivitet, `type = 'meeting'`, `purpose = 'salgsfrokost'`)
- Logges når frokosten er afholdt
- Knyttes til `bon_id` hvis ordre efterfølgende oprettes
- Sentiment registreres

**Statistik-view:**
```sql
-- NB: purpose_id bruges som FK til activity_purposes — join for at matche på key
CREATE VIEW v_sales_lunch_funnel AS
SELECT
  SUM(CASE WHEN ap.key = 'salgsfrokost' THEN 1 ELSE 0 END) AS tilbudt,
  SUM(CASE WHEN ap.key = 'salgsfrokost' AND a.type = 'meeting' THEN 1 ELSE 0 END) AS holdt,
  SUM(CASE WHEN ap.key = 'salgsfrokost' AND a.bon_id IS NOT NULL THEN 1 ELSE 0 END) AS konverteret,
  ROUND(100.0
    * SUM(CASE WHEN ap.key = 'salgsfrokost' AND a.type = 'meeting' THEN 1 ELSE 0 END)
    / MAX(1, SUM(CASE WHEN ap.key = 'salgsfrokost' THEN 1 ELSE 0 END)), 1) AS accept_rate_pct,
  ROUND(100.0
    * SUM(CASE WHEN ap.key = 'salgsfrokost' AND a.bon_id IS NOT NULL THEN 1 ELSE 0 END)
    / MAX(1, SUM(CASE WHEN ap.key = 'salgsfrokost' THEN 1 ELSE 0 END)), 1) AS conversion_rate_pct
FROM crm_activities a
LEFT JOIN activity_purposes ap ON ap.id = a.purpose_id
WHERE a.created_at >= date('now', '-365 days');
```

### 6.3 Konverterings-statistik pr. formål

```sql
CREATE VIEW v_conversion_by_purpose AS
SELECT
  ap.key AS purpose,
  ap.label AS purpose_label,
  COUNT(*) AS aktiviteter,
  COUNT(DISTINCT a.customer_id) AS unikke_kunder,
  SUM(CASE WHEN a.bon_id IS NOT NULL THEN 1 ELSE 0 END) AS direkte_bon,
  ROUND(100.0 * SUM(CASE WHEN a.bon_id IS NOT NULL THEN 1 ELSE 0 END)
    / MAX(1, COUNT(*)), 1) AS direkte_konvertering_pct
FROM crm_activities a
JOIN activity_purposes ap ON ap.id = a.purpose_id
WHERE a.created_at >= date('now', '-365 days')
GROUP BY ap.key
ORDER BY direkte_konvertering_pct DESC;
```

---

## Del 7 — UI: Kundeindsigt-side

### 7.1 Placering

Ny side i navigationen under "Kunder":
```
Kunder
  ├── Virksomheder
  ├── Kontakter
  ├── Re-aktivering        ← ny
  ├── Prospekter           ← ny
  └── Kundeindsigt         ← ny (RFM + ICP dashboard)
```

### 7.2 Kundeindsigt-layout

**Venstre panel (300px) — Justeringsknapper:**
- RFM-vægte: tre sliders (R/F/M), normaliserede
- VIP-tærskel slider (5–30%)
- Aktiv-tærskel slider (20–70%)
- Recency cutoff slider (60–365 dage)
- ICP-filter toggle: VIP / Top 25%
- CVR-enrichment status + "Kør enrichment"-knap

**Hoved-panel:**
- Stat-strip: Firmaer i alt / VIP / Aktive / Sovende / Leads
- RFM-tabel med live-filtrering og sortering
- ICP-profil-panel (højre side)

**Alle ændringer til sliders** → `POST /api/rfm/config` + re-render tabel.
Konfigurationen persisterer i DB — næste gang siden åbnes husker den indstillingerne.

### 7.3 Kundeprofil-integration

På det individuelle firmakort tilføjes:

**Venstre panel, under tags:**
```
RFM-score: 78  [🏆 VIP]
R: 82  F: 74  M: 71
```

RFM-score opdateres automatisk dagligt. Vis sidst opdateret-tidsstempel.

---

## Del 8 — Udviklingsplan og prioritering

### Fase A — Fundament (kræves af alt andet)
1. CVR-audit køres og fejl rettes (se Bilag C)
2. `rfm_config`-tabel + seed-data
3. `v_rfm_raw` og `v_rfm_scores` views
4. `branch`-kolonner + `employee_count` + `company_type` på `companies`
5. CVR auto-enrichment job
6. `activity_purposes`-tabel + seed-data
7. `purpose_id`-felt på `crm_activities` (FK til `activity_purposes`)
8. `stage_locked`-kolonner på `crm_customer_meta`

Estimat: 1–1½ dag

### Fase B — Scoring og indsigt
6. Auto-staging job (daily)
7. `v_icp_profile` og ICP API
8. Kundeindsigt-side med sliders (kan genbruge mockup-logikken direkte)
9. RFM-score på firmakort

Estimat: 2 dage

### Fase C — Strategisk workflow
10. Re-aktiverings-liste med potentiale-score
11. Prospekt-flow med CVR-opslag og ICP-fit score
12. Salgsfrokost-funnel tracking
13. `v_conversion_by_purpose` statistik-view

Estimat: 2 dage

**Samlet estimat: ~5 dages arbejde for fuld implementering**

---

## Bilag A — Datakvalitet og fallbacks

| Situation | Håndtering |
|-----------|-----------|
| Firma mangler CVR | Kan ikke auto-enriches — vises i "Mangler CVR"-liste |
| CVR API nede | Job sætter `cvr_enriched_at = NULL`, prøver igen næste dag |
| CVR-branche ikke i mapping | Sættes til "Øvrige" |
| Firma med 0 ordrer | Ingen RFM-score — tæller som "lead" |
| Firma med 1 ordre | Inkluderes med lav F-score |
| `purpose` IS NULL | Bagudkompatibelt — vises som "Ikke angivet" i statistik |

## Bilag B — Standard-formål (seed-data)

Disse seks formål seedes ved installation og er markeret `is_system = 1`. De kan ikke slettes eller deaktiveres, men deres `label` og `emoji` kan redigeres. Nye brugeroprettede formål kan tilføjes og deaktiveres frit.

| key | Label | Emoji | System? |
|-----|-------|-------|---------|
| `opfoelgning` | Opfølgning | 🔁 | Ja |
| `nyt_lead` | Nyt lead | 👤 | Ja |
| `salgsfrokost` | Salgsfrokost | 🥗 | Ja |
| `saesonoutreach` | Sæson | 🌸 | Ja |
| `re_aktivering` | Re-aktivering | 💤 | Ja |
| `service` | Service | 🔧 | Ja |

Aktiviteter med `purpose_id = NULL` (ældre data) vises som "Ikke angivet" i statistik og er fuldt bagudkompatible.

## Bilag C — CVR-audit tjekliste

Gennemgå dette inden enrichment-job startes:

- [ ] Kør audit-queryen og gem output
- [ ] Ret firmaer med "Forkert længde" (manglende foranstillet 0)
- [ ] Kør normaliserings-migrationen (fjern mellemrum/bindestreger)
- [ ] Gennemgå "Mangler CVR"-listen — slå de vigtigste op manuelt
- [ ] Bekræft at CVR API-nøgle/token er konfigureret korrekt
- [ ] Kør enrichment på 5 test-firmaer og bekræft output før fuld kørsel

---

## Bilag D — Implementeringsnoter (tilføjet efter review)

### D.1 Rettede fejl i denne spec

| Fejl | Rettelse |
|------|----------|
| `b.event_date` brugt i SQL | Rettet til `b.delivery_date` (korrekt kolonnenavn) |
| `bl.guests` (eksisterer ikke) brugt til Monetary | Rettet til `b.pax` (antal gæster er på bon-niveau, ikke bon_lines) |
| `FILTER (WHERE ...)` syntaks | Rettet til `SUM(CASE WHEN ... END)` (SQLite-kompatibelt) |
| `PERCENTILE_SCORE` funktion | Fjernet — bruger `stage`-kolonne fra materialiseret `rfm_scores` i stedet |
| `v_icp_vip_ids` reference | Erstattet med `rfm_scores WHERE stage = 'vip'` |
| `b.status NOT IN ('AFLYST','TILBUD')` (tekst) | Rettet til `status_id NOT IN (SELECT ...)` (bruger FK korrekt) |
| `crm_customer_meta.stage_locked` | Flyttet til `rfm_scores`-tabel (RFM scorer per firma, ikke per kontakt) |
| `purpose = 'salgsfrokost'` som rå string | Rettet til join via `purpose_id` FK til `activity_purposes` |
| `price_category` som tekst i ICP | Rettet til join via `price_category_id` FK |
| Privatkunder (`company_id = NULL`) faldt ud af RFM | Løst med personlige firmaer (`is_personal = 1` på `companies`) |

### D.2 Arkitektur-anbefalinger

**Materialiseret rfm_scores-tabel:**
SQL views i SQLite genberegner ved hvert query. Med joins over companies → customers → bons → bon_lines er det unødvendigt tungt. `rfm_scores`-tabellen beregnes som batch-job og giver O(1) opslag.

**Client-side scoring for live-sliders:**
Kundeindsigt-siden henter hele `rfm_scores`-tabellen (~750 rækker, ~50 KB) til browseren. Slider-ændringer re-scorer og re-sorterer lokalt i JS — instant feedback uden server-roundtrips. Kun "Gem vægte" trigger server-side genberegning.

**CVR-enrichment robusthed:**
- cvrapi.dk kan throttle aggressivt — tilføj retry med eksponentiel backoff (1s, 2s, 4s, max 3 forsøg)
- Gem progress (seneste enriched company_id) så jobbet kan genoptages efter crash
- `cvr_raw_json` kan udelades hvis pladsbesparelse ønskes — de felter vi bruger gemmes allerede i dedikerede kolonner

**Privatkunder og RFM:**
Alle kunder har et `company_id` (privatkunder får et personligt firma med `is_personal = 1`). Det giver ensartet RFM-scoring uden special cases. `crm_customer_meta.stage` bruges ikke længere til staging — `rfm_scores.stage` er den eneste kilde.

### D.3 Hvad mockuppen viser vs. hvad der skal bygges

HTML-mockuppen (`tools/crm-rfm-icp.html`) demonstrerer korrekt:
- Slider-mekanik med live re-scoring
- Normalisering (min-max) og vægtet sum
- Stage-tildeling med percentil-cutoffs
- ICP-panel med branche-tags og lookalike-tæller

Mockuppen mangler:
- API-integration (bruger hardcoded fake data)
- Søgning/filtrering i tabel
- Klik på firma → navigér til Kunde 360°
- Pagination (viser max 20 — med 750 firmaer skal der enten pagineres eller virtualiseres)
- "Gem vægte" knap (sliders persisterer ikke)
