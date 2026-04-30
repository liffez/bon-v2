# CLAUDE_KONTAKTER.md
> Spec for kontaktpunkter, CVR-berigelse, web-scraping, og navigation-refaktor (Kunder → Kontakter med Firmaer-fane).
> Læs `docs/BON_V2_PRINCIPPER.md`, `docs/bon_v2_datamodel_v2.md`, og eksisterende
> `office/views/crm-kunde360.js` + `routes/crm.js` + `routes/companies.js` + `routes/cvr.js`
> FØR du starter.
> Opdateret: april 2026

---

## Mål

Tre tæt-koblede problemer løses i samme stak:

1. **Datakvalitet** — gamle firmadata bliver forældet; vi skal nemt kunne berige fra CVR
2. **Outreach-juridik** — markedsføringsloven kræver at vi kan skelne mellem offentlige og personlige kontaktoplysninger inden cold outreach
3. **Manglende firma-overblik** — vi har en kunde-først CRM, men når 12 personer på Rigshospitalet bestiller fra os, mangler vi indgang via firmaet selv

Løsningen er en `contact_points`-tabel med kilde + offentlig/privat-flag, en runtime CVR-service med diff-UI, scraping af offentlige kontaktsider, og en ny Firma 360°-side parallelt med Kunde 360°.

---

## Designbeslutninger (afgjort med Leif)

> - **Kontaktpunkter:** ny `contact_points`-tabel, polymorf (entity_type = `company` | `customer`), én række per email/telefon med `source`, `is_public`, `purpose`, `is_primary`, `verified_at`
> - **`companies.email`/`phone` beholdes** som denormaliseret primær-cache (bagudkompatibilitet) — opdateres når en `contact_point` markeres `is_primary`. **SQLite-triggers fanger også legacy-writes direkte på `companies.email`/`phone` og `customers.email`/`phone`** så cachen ikke kan desyncs (se 1.5)
> - **Backfill-default:** alle eksisterende email/phone fra companies+customers → `source='manual'`, `is_public=0`, `is_primary=1` (sikker juridisk default)
> - **Berig-knap:** primær-knap nederst i firma-kortet i **Firma 360°** (Kunde 360° viser firmanavnet som klik-link der navigerer til Firma 360°). Berigelse er en firma-handling, ikke en person-handling.
> - **Diff-UI:** modal med felt-for-felt checkboxes; uændrede felter vises men er disabled
> - **CVR-kontaktpunkter:** alle emails/telefoner der kommer fra CVR/NemHandel markeres automatisk `is_public=1` (de er per definition offentlige)
> - **Web-scraping (Fase 4) downgraded til manuelt paste-flow:** ingen auto-fetch af URL'er. Bruger klistrer HTML/tekst ind, server kører email/telefon-regex + personlig/public-heuristik, viser kandidater til check-box-bekræftelse. Fjerner robots.txt-, anti-bot- og GDPR-risici.
> - **Aktiviteter på firma-niveau:** v1 aggregerer via kunder under firmaet (`crm_activities` får IKKE `company_id` i denne sprint)
> - **Pipeline:** forbliver per-kunde. Firma 360° er en alternativ vinkel der aggregerer kunder/bons/omsætning under firmaet — den dublerer ikke pipelinen.
> - **Source ved manuel oprettelse:** valgfrit dropdown med advarsel hvis tomt ("Du har ikke angivet en kilde — vil du gemme alligevel?"). Default-værdi `manual`
> - **Navigation:** sidebar-punkt `Kunder` omdøbes til `Kontakter`; ny side har to faner (`Personer` default | `Firmaer`)
> - **Firma 360°:** ny view `office/views/crm-firma360.js`, parallel til Kunde 360°. Cross-link begge veje
> - **Admin batch-CVR:** ny knap i Settings → "Berig alle firmaer mod CVR" der kører enrichment over hele basen og auto-markerer matches som PUB
> - **Merge-rollback:** før hver merge dumpes JSON-snapshot af alle berørte rækker (customers, bons, quotes, mail_threads, contact_points) med deres oprindelige `company_id` i changelog-payload. `scripts/undo-merge.js <changelog_id>` kan rulle tilbage. Loser hård-slettes ikke — kun soft-deleted (`is_active=0`) — så et fuldt undo er muligt.

---

## Faser

| # | Fase | Risiko | Afhænger af |
|---|------|--------|-------------|
| 1 | DB foundation: `contact_points` + backfill + cache-triggers + CRUD-API | Lav | — |
| 2 | Runtime CVR enrichment service + endpoints | Lav | 1 |
| 3 | UI: "Berig fra CVR"-modal i Firma 360° | Lav | 1, 2, 6 |
| 5 | Navigation: Kontakter med Personer/Firmaer-faner | Lav | — (kan parallelt) |
| 6 | Firma 360° view | Mellem | 1, 5 |
| 8 | Admin: Manuel firma-sammenlægning (m/ JSON-rollback) | Mellem | 1, 6 |
| 7 | Admin batch-CVR-berigelse | Lav | 2 |
| 4 | Manuel paste-flow til offentlige kontakter (downgraded fra scrape) | Lav | 1 |

Hver fase er independent deploybar og testbar. Fase 5 kan startes parallelt med 1. **Rækkefølge ændret:** Fase 8 (merge) prioriteres før Fase 4 (paste-flow), fordi merge er højere værdi og rydder duplikater op før de bliver beriget i fase 7. Berig-modal (Fase 3) flyttet til efter Fase 6 fordi knappen lever i Firma 360°.

---

## FASE 1 — Datamodel + CRUD for contact_points

### 1.1 Migration: `db/migrations/0XX_contact_points.sql`

> Næste ledige migration-nummer (tjek `db/migrations/` for det højeste eksisterende, formentligt `043+` baseret på CLAUDE.md).

```sql
-- ==========================================
-- Contact points: emails + telefoner med kilde, offentlig/privat-status, purpose
-- Polymorf: en kontaktpunkt tilhører enten et company eller en customer
-- ==========================================

CREATE TABLE contact_points (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL
                CHECK (entity_type IN ('company', 'customer')),
    entity_id INTEGER NOT NULL,
    kind TEXT NOT NULL
                CHECK (kind IN ('email', 'phone')),
    value TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual'
                CHECK (source IN ('cvr', 'nemhandel', 'website', 'form', 'mail', 'manual')),
    is_public INTEGER NOT NULL DEFAULT 0,
    is_primary INTEGER NOT NULL DEFAULT 0,
    purpose TEXT,                       -- fri tekst: "Faktura", "Hovednummer", "Kontaktperson"
    verified_at DATETIME,               -- senest bekræftet (typisk = sidste enrichment)
    last_seen_at DATETIME,              -- senest set i kilde (web-scrape, CVR, ...)
    is_active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, entity_id, kind, value)
);

CREATE INDEX idx_cp_entity   ON contact_points(entity_type, entity_id);
CREATE INDEX idx_cp_value    ON contact_points(value);
CREATE INDEX idx_cp_public   ON contact_points(is_public) WHERE is_active = 1;
CREATE INDEX idx_cp_primary  ON contact_points(entity_type, entity_id, kind) WHERE is_primary = 1;

-- ==========================================
-- Backfill fra companies
-- Default: source='manual', is_public=0, is_primary=1
-- ==========================================

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'company', id, 'email', email, 'manual', 0, 1, 'Hovedmail'
FROM companies
WHERE email IS NOT NULL AND TRIM(email) != '';

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'company', id, 'phone', phone, 'manual', 0, 1, 'Hovednummer'
FROM companies
WHERE phone IS NOT NULL AND TRIM(phone) != '';

-- invoice_email kun hvis forskellig fra email (og ikke tom)
INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'company', id, 'email', invoice_email, 'manual', 0, 0, 'Faktura'
FROM companies
WHERE invoice_email IS NOT NULL
  AND TRIM(invoice_email) != ''
  AND invoice_email != COALESCE(email, '');

-- ==========================================
-- Backfill fra customers
-- ==========================================

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'customer', id, 'email', email, 'manual', 0, 1, NULL
FROM customers
WHERE email IS NOT NULL AND TRIM(email) != '';

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'customer', id, 'phone', phone, 'manual', 0, 1, NULL
FROM customers
WHERE phone IS NOT NULL AND TRIM(phone) != '';
```

### 1.2 Routes: `routes/contact-points.js` (ny fil)

Mount i `server.js`:
```js
app.use('/api/contact-points', require('./routes/contact-points'));
```

#### `GET /api/contact-points?entity_type=company&entity_id=42`

Returnerer alle aktive kontaktpunkter for en entitet, sorteret med `is_primary` først.

**Response:**
```json
[
  {
    "id": 1234,
    "entity_type": "company",
    "entity_id": 42,
    "kind": "email",
    "value": "info@regionh.dk",
    "source": "cvr",
    "is_public": 1,
    "is_primary": 0,
    "purpose": "Officiel email",
    "verified_at": "2026-04-12T10:30:00Z",
    "last_seen_at": "2026-04-12T10:30:00Z",
    "created_at": "2026-04-12T10:30:00Z"
  }
]
```

#### `POST /api/contact-points`

```json
{
  "entity_type": "company",
  "entity_id": 42,
  "kind": "email",
  "value": "presse@regionh.dk",
  "source": "manual",
  "is_public": 1,
  "is_primary": 0,
  "purpose": "Pressekontakt"
}
```

**Validering:**
- `entity_type` + `entity_id` skal pege på eksisterende række
- `value` valideres som email eller telefon afhængigt af `kind`
- Ved unique-conflict: returnér 409 med eksisterende række
- Hvis `is_primary=1`: nulstil `is_primary` på alle andre med samme `entity_type+entity_id+kind` først
- Skriv changelog (`logChange` på entity)

#### `PATCH /api/contact-points/:id`

Felter der kan opdateres: `is_public`, `is_primary`, `purpose`, `notes`, `value`, `source`.

Ved `is_primary=1`: nulstil andres `is_primary` for samme entity+kind. Hvis `companies.email`/`phone` er den denormaliserede cache: opdatér også den.

#### `DELETE /api/contact-points/:id`

Soft-delete via `is_active=0`. Hvis `is_primary=1`: vælg næste tilgængelige som primær eller nulstil `companies.email`/`phone`.

#### `PATCH /api/contact-points/:id/toggle-public`

Convenience-endpoint til UI-toggle (logger separat changelog-action `make_public` / `make_private`).

### 1.3 Companies/customers cache-sync

Når en `contact_point` med `is_primary=1` ændres eller slettes:

```js
// shared/contactPoints.js (helper)
function syncPrimaryCache(db, entity_type, entity_id, kind) {
    const primary = db.prepare(`
        SELECT value FROM contact_points
        WHERE entity_type = ? AND entity_id = ? AND kind = ?
          AND is_primary = 1 AND is_active = 1
        LIMIT 1
    `).get(entity_type, entity_id, kind);
    
    const table = entity_type === 'company' ? 'companies' : 'customers';
    const column = kind;  // 'email' eller 'phone'
    
    db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`)
      .run(primary?.value || null, entity_id);
}
```

Kaldes fra POST + PATCH + DELETE-handlers i `routes/contact-points.js`.

### 1.5 SQLite-triggers (cache-sync den anden vej)

`syncPrimaryCache()` håndterer retningen `contact_points → companies/customers`. Men legacy-kode (sync-v1.js, webhooks, manuelle SQL-fixes, evt. `routes/companies.js` der ikke er migreret endnu) kan stadig direkte UPDATE'e `companies.email`/`phone`/`customers.email`/`phone` — det desyncer cachen den anden vej.

**Triggers fanger den retning, så vi ikke har et "kendt misforhold" hængende:**

```sql
-- Companies: email
CREATE TRIGGER trg_companies_email_to_cp
AFTER UPDATE OF email ON companies
WHEN COALESCE(NEW.email,'') != COALESCE(OLD.email,'')
BEGIN
    UPDATE contact_points
       SET value = NEW.email,
           updated_at = CURRENT_TIMESTAMP
     WHERE entity_type = 'company'
       AND entity_id = NEW.id
       AND kind = 'email'
       AND is_primary = 1
       AND is_active = 1;

    -- Hvis der ikke fandtes et primary email-cp endnu, opret det
    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
    SELECT 'company', NEW.id, 'email', NEW.email, 'manual', 0, 1, 'Hovedmail'
    WHERE NEW.email IS NOT NULL
      AND TRIM(NEW.email) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type='company' AND entity_id=NEW.id
            AND kind='email' AND is_primary=1 AND is_active=1
      );
END;

-- Companies: phone (samme mønster)
CREATE TRIGGER trg_companies_phone_to_cp
AFTER UPDATE OF phone ON companies
WHEN COALESCE(NEW.phone,'') != COALESCE(OLD.phone,'')
BEGIN
    UPDATE contact_points
       SET value = NEW.phone, updated_at = CURRENT_TIMESTAMP
     WHERE entity_type='company' AND entity_id=NEW.id
       AND kind='phone' AND is_primary=1 AND is_active=1;

    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
    SELECT 'company', NEW.id, 'phone', NEW.phone, 'manual', 0, 1, 'Hovednummer'
    WHERE NEW.phone IS NOT NULL AND TRIM(NEW.phone) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type='company' AND entity_id=NEW.id
            AND kind='phone' AND is_primary=1 AND is_active=1
      );
END;

-- Customers: email + phone (samme mønster, entity_type='customer')
CREATE TRIGGER trg_customers_email_to_cp
AFTER UPDATE OF email ON customers
WHEN COALESCE(NEW.email,'') != COALESCE(OLD.email,'')
BEGIN
    UPDATE contact_points
       SET value = NEW.email, updated_at = CURRENT_TIMESTAMP
     WHERE entity_type='customer' AND entity_id=NEW.id
       AND kind='email' AND is_primary=1 AND is_active=1;

    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary)
    SELECT 'customer', NEW.id, 'email', NEW.email, 'manual', 0, 1
    WHERE NEW.email IS NOT NULL AND TRIM(NEW.email) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type='customer' AND entity_id=NEW.id
            AND kind='email' AND is_primary=1 AND is_active=1
      );
END;

CREATE TRIGGER trg_customers_phone_to_cp
AFTER UPDATE OF phone ON customers
WHEN COALESCE(NEW.phone,'') != COALESCE(OLD.phone,'')
BEGIN
    UPDATE contact_points
       SET value = NEW.phone, updated_at = CURRENT_TIMESTAMP
     WHERE entity_type='customer' AND entity_id=NEW.id
       AND kind='phone' AND is_primary=1 AND is_active=1;

    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary)
    SELECT 'customer', NEW.id, 'phone', NEW.phone, 'manual', 0, 1
    WHERE NEW.phone IS NOT NULL AND TRIM(NEW.phone) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type='customer' AND entity_id=NEW.id
            AND kind='phone' AND is_primary=1 AND is_active=1
      );
END;
```

**Vigtigt:** Triggers indsætter med `is_public=0`, `source='manual'` — den juridisk sikre default. Hvis legacy-koden skriver en CVR-email direkte ind, vil den blive markeret som privat indtil nogen manuelt toggler PUB. Det er det rigtige fail-safe.

`syncPrimaryCache()` (1.3) bruger fortsat direkte UPDATE — triggers fanger ikke `contact_points → companies` retningen. Det er to-vejs cache-sync hvor hver retning har sin egen mekanisme.

### 1.4 `shared/api.js` — wrapper-funktioner

```js
async function fetchContactPoints(entity_type, entity_id) { ... }
async function createContactPoint(data) { ... }
async function updateContactPoint(id, patch) { ... }
async function deleteContactPoint(id) { ... }
async function toggleContactPublic(id) { ... }
```

### Test-spec for fase 1

| Test | Forventet resultat |
|------|-------------------|
| Migration kører på frisk DB | 0 contact_points |
| Migration kører på prod-snapshot | N rækker = COUNT(companies.email IS NOT NULL) + COUNT(companies.phone IS NOT NULL) + delvis invoice_email + COUNT(customers.email IS NOT NULL) + COUNT(customers.phone IS NOT NULL) |
| Migration er idempotent (kører to gange) | Migrationssystemet skal allerede afvise re-kørsel — verificér |
| `GET /api/contact-points?entity_type=company&entity_id=X` | Returnerer alle aktive contact_points for firma X, primary først |
| `POST` med duplikat værdi for samme entity | 409 conflict |
| `POST` med `is_primary=1` | Nulstiller andres `is_primary` for samme kind |
| `PATCH` med `value`-ændring der opdaterer primary | `companies.email` / `customers.email` opdateres tilsvarende |
| `DELETE` af primary | Næste tilgængelige bliver primary, ELLER `companies.email` bliver NULL hvis ingen flere |
| Manuel SQL: `UPDATE companies SET email='ny@firma.dk'` | Trigger opdaterer eksisterende primary-cp ELLER opretter ny cp med `source='manual'`, `is_public=0` |
| Manuel SQL: `UPDATE companies SET email=NULL` på firma uden cp'er | Ingen INSERT (NULL/tom-værdi springes over). Eksisterende primary-cp's value bliver dog `NULL` — verificér at det er ok, eller tilføj WHEN-clause der kun opdaterer hvis NEW != NULL |
| Manuel SQL på `customers.email`/`phone` | Samme adfærd som companies-triggers |

**Manuel test efter deploy:**
```bash
# Tjek backfill
sqlite3 prod.db "SELECT entity_type, kind, COUNT(*) FROM contact_points GROUP BY entity_type, kind"
# Forventet: company/email ~980, company/phone ~700, customer/email ~1400, customer/phone ~1200

# Tjek primary integritet  
sqlite3 prod.db "SELECT entity_type, entity_id, kind, COUNT(*) FROM contact_points WHERE is_primary=1 GROUP BY entity_type, entity_id, kind HAVING COUNT(*)>1"
# Forventet: tom (ingen entity har >1 primary per kind)
```

---

## FASE 2 — Runtime CVR enrichment service

### 2.1 `services/cvrEnrichment.js` (ny fil — extrakt fra `scripts/enrich-cvr.js`)

Refaktor `scripts/enrich-cvr.js`-logikken til en injicérbar service. Scriptet beholdes uændret men kalder den nye service.

**Interface:**

```js
const { enrich } = require('./services/cvrEnrichment');

// Hovedmetode — bruges fra route
const result = await enrich({ cvr, ean, email, navn });

// Returns:
{
  found: true,
  konfidens: 0.95,
  kilde: 'Virk ElasticSearch',  // eller 'NemHandel', 'cvrapi'
  data: {
    name: 'Region Hovedstaden',
    legal_name: 'Region Hovedstaden',
    cvr: '29190623',
    ean: '5798001021197',     // hvis fundet via NemHandel
    address: 'Blegdamsvej 9',
    zipcode: '2100',
    city: 'København Ø',
    industry: 'Hospitaler',
    industry_code: '861000',
    employees: 52124,
    website: 'www.regionh.dk',
    status: 'NORMAL',
    public_emails: ['info@regionh.dk'],   // automatisk PUB
    public_phones: ['38 66 60 00'],       // automatisk PUB
  }
}

// Hvis intet match:
{ found: false, besked: 'Ingen virksomhed fundet' }
```

### 2.2 Diff-builder: `services/companyDiff.js`

Tager et `company`-objekt fra DB + et enrichment-resultat og returnerer struktureret diff:

```js
const diff = buildCompanyDiff(currentCompany, enrichmentResult, existingContactPoints);

// Returns:
{
  fields: [
    {
      key: 'legal_name',
      label: 'Juridisk navn',
      current: null,
      proposed: 'Region Hovedstaden',
      changed: true,
      writable: true,    // false for derived fields som status
    },
    {
      key: 'address',
      label: 'Adresse',
      current: 'Blegdamsvej 9, 2100 København Ø',
      proposed: 'Blegdamsvej 9, 2100 København Ø',
      changed: false,
      writable: true,
    },
    // ...
  ],
  contact_points: [
    {
      kind: 'email',
      value: 'info@regionh.dk',
      already_exists: false,
      proposed_source: 'cvr',
      proposed_is_public: 1,
    },
    {
      kind: 'phone',
      value: '38 66 60 00',
      already_exists: true,         // findes allerede som contact_point
      existing_id: 5234,
      existing_is_public: 1,
    },
  ]
}
```

### 2.3 Routes — udvidelse af `routes/companies.js`

#### `GET /api/companies/:id/enrich-preview`

Kører enrichment uden at gemme noget. Returnerer diff klar til UI.

**Logik:**
1. Hent firma + dets contact_points
2. Kør `enrich({ cvr: company.cvr, ean: company.ean, navn: company.name })`
3. Byg diff
4. Returnér

**Response:**
```json
{
  "found": true,
  "konfidens": 0.95,
  "kilde": "Virk ElasticSearch",
  "diff": { ... som ovenfor ... }
}
```

Hvis `found: false`: returnér `{ "found": false, "besked": "..." }` med 200 (ikke fejl — UI viser bare "ingen match").

#### `POST /api/companies/:id/enrich`

Anvender en delmængde af diff'en. Body:

```json
{
  "fields": ["legal_name", "industry", "employees", "website"],
  "contact_points": [
    { "kind": "email", "value": "info@regionh.dk", "is_public": 1 }
  ],
  "kilde": "Virk ElasticSearch",
  "konfidens": 0.95
}
```

**Logik:**
1. Begin transaction
2. UPDATE companies med valgte felter
3. INSERT contact_points (med `source='cvr'`, `verified_at=NOW`, `is_public` fra request)
4. Skriv changelog (`action='enrich'` + payload)
5. Sæt `companies.last_enriched_at = NOW`, `companies.last_enriched_source = kilde`
6. Commit

Tilføj migration til `companies`:
```sql
ALTER TABLE companies ADD COLUMN last_enriched_at DATETIME;
ALTER TABLE companies ADD COLUMN last_enriched_source TEXT;
```

### Test-spec for fase 2

| Test | Forventet |
|------|-----------|
| `GET /api/companies/:id/enrich-preview` på firma med kendt CVR (Region Hovedstaden 29190623) | `found:true`, `konfidens > 0.9`, alle CVR-felter populated |
| Samme på firma uden CVR + uden EAN | `found:false` (kan ikke matche uden hint) |
| Samme på firma med kun EAN | `found:true` via NemHandel-strategi |
| `POST /api/companies/:id/enrich` med `fields=[legal_name]` | Kun `legal_name` opdateres, andre felter rørt urørt |
| `POST .../enrich` med ny `contact_points` | Ny contact_point oprettet med `source='cvr'`, `is_public=1` |
| `POST .../enrich` med eksisterende `contact_points` | 409 ELLER opdater `verified_at` på den eksisterende (vælg én strategi — anbefaler sidstnævnte: idempotent) |
| Changelog efter enrich | `action='enrich'` med payload-snippet |
| `companies.last_enriched_at` opdateret | NOW() efter enrich |

---

## FASE 3 — UI: "Berig fra CVR"-modal i Kunde 360°

### 3.1 Hvor lever det?

I den eksisterende `office/views/crm-kunde360.js`, i firma-sektionen af profilen (eller i en "Firma"-tab afhængig af nuværende layout). Mockup'en `berig_firma_mockup.html` viser layoutet.

### 3.2 Nye UI-funktioner i `crm-kunde360.js`

```js
function _k3RenderFirmaCard()       // udvides med "Berig fra CVR"-knap
function _k3OpenEnrichModal()       // åbner modal, kalder enrich-preview
function _k3RenderEnrichModal(diff) // bygger diff-UI med checkboxes
function _k3AcceptEnrich()          // samler valgte og kalder POST .../enrich
function _k3CloseEnrichModal()
```

### 3.3 Modal-struktur (jf. mockup)

```
┌─────────────────────────────────────────────────────────┐
│ ⟳ Berig fra CVR                                  [×]   │
│ CVR 29190623 · Region Hovedstaden · Virk ElasticSearch  │
├─────────────────────────────────────────────────────────┤
│ ✓ Match fundet · konfidens 95% · 6 felter har ny data  │
├─────────────────────────────────────────────────────────┤
│ STAMDATA                                                │
│ ☑ Juridisk navn   — ikke sat —    Region Hovedstaden    │
│ ☐ Adresse         (uændret — disabled)                  │
│ ☑ Branche         — ikke sat —    Hospitaler            │
│ ...                                                     │
├─────────────────────────────────────────────────────────┤
│ KONTAKTPUNKTER FRA CVR  (alle markeres som PUB)         │
│ ☑ ✉ info@regionh.dk        Officiel email              │
│ ☐ ☏ 38 66 60 00 (allerede registreret)                  │
├─────────────────────────────────────────────────────────┤
│ 5 ændringer vil blive gemt    [Annullér] [✓ Accepter]   │
└─────────────────────────────────────────────────────────┘
```

### 3.4 CSS

Tilføj til `crm-kunde360.css` (eller hvor firma-kort styling lever):

```css
.k3-enrich-btn { /* primær grøn */ }
.k3-enrich-modal { /* overlay + panel */ }
.k3-diff-row { display: grid; grid-template-columns: 28px 100px 1fr 1fr; ... }
.k3-diff-current { background: var(--color-line); text-decoration: line-through; }
.k3-diff-new { background: var(--color-pub-light); color: var(--color-pub); }
.k3-diff-row.unchanged { opacity: 0.55; }
```

Brug eksisterende design-tokens i `shared/styles/tokens.css`.

### 3.5 Toast efter accept

```js
showToast('✓ Firma beriget — 5 ændringer gemt, info@regionh.dk tilføjet som offentlig');
```

Reload firma-data + contact_points-listen.

### Test-spec for fase 3

| Test | Forventet |
|------|-----------|
| Klik "Berig fra CVR" → modal åbner | Loader vises, derefter diff |
| Match-fejl (`found:false`) | Modal viser "Ingen match" + lukker-knap |
| Default-state | Felter med `changed=true` har checkbox tjekket; uændrede er disabled |
| Accept med 0 valgte | Knap er disabled |
| Accept med valgte | API kaldes, modal lukker, toast vises, firma-kort genindlæses |
| Escape eller klik udenfor | Modal lukker uden at gemme |

---

## FASE 4 — Manuel paste-flow til offentlige kontakter

> **Downgraded fra auto-scraping.** Ingen `robots.txt`-respekt, ingen anti-bot-håndtering, ingen GDPR-vinkel om vi må fetche andres sider — bruger klistrer selv HTML eller tekst ind. Server kører kun parser+heuristik på det indsendte indhold.

### 4.1 Service: `services/contactExtractor.js`

```js
const { extractContacts } = require('./services/contactExtractor');

// Bruger har klistret HTML eller plain text ind i en textarea
const result = extractContacts({ text: pastedContent, sourceUrl: 'https://regionh.dk/kontakt' });

// Returns:
{
  ok: true,
  candidates: [
    {
      kind: 'email',
      value: 'info@regionh.dk',
      classification: 'public',     // 'public' | 'personal' | 'unknown'
      context_snippet: '...generelle henvendelser: info@regionh.dk...'
    },
    {
      kind: 'email',
      value: 'presse@regionh.dk',
      classification: 'public',
      context_snippet: '...pressehenvendelser: presse@regionh.dk...'
    },
    {
      kind: 'email',
      value: 'lars.hansen@regionh.dk',
      classification: 'personal',
      context_snippet: '...overlæge Lars Hansen: lars.hansen@regionh.dk...'
    },
    {
      kind: 'phone',
      value: '38 66 60 00',
      classification: 'unknown',    // telefoner får altid 'unknown' — bruger bestemmer
      context_snippet: '...hovednummer: 38 66 60 00...'
    }
  ],
  stats: {
    total_emails_found: 8,
    total_phones_found: 3,
    classified_public: 4,
    classified_personal: 4,
    unknown: 3
  }
}
```

### 4.2 Heuristikker

**Emails — klassificér i tre kategorier:**

```js
const PUBLIC_PREFIXES = [
  'info', 'kontakt', 'contact', 'mail', 'hello',
  'presse', 'press', 'media',
  'salg', 'sales', 'support',
  'admin', 'office', 'reception',
  'whistleblower', 'faktura', 'invoice', 'finance', 'okonomi'
];

const PERSONAL_PATTERNS = [
  /^[a-zæøå]+\.[a-zæøå]+@/i,       // firstname.lastname@
  /^[a-zæøå]\.[a-zæøå]+@/i,         // f.lastname@
];

function classifyEmail(email) {
  const localPart = email.split('@')[0].toLowerCase();
  if (PUBLIC_PREFIXES.includes(localPart)) return 'public';
  if (PERSONAL_PATTERNS.some(p => p.test(email))) return 'personal';
  return 'unknown';  // bruger vælger
}
```

**Telefoner — alle får `classification: 'unknown'`:**
- Regex matcher DK-format: `(+45[\s.-]?)?(\d{2}[\s.-]?){3}\d{2}` eller `(+45)?\d{8}`
- Sværere at skelne offentlig fra personlig telefon → lad bruger bestemme via checkbox

**Context-snippet:** ±60 tegn omkring fundet i original-tekst (whitespace-collapsed). Hjælper brugeren huske hvad de klistrede ind.

**Falske positiver:** dedup på normaliseret værdi (lowercase email, whitespace-strippet phone). Filtrer telefon-strenge der også matcher CVR-format (8 cifre, men i kontekst med "CVR" eller "VAT" i de nærmeste 30 tegn).

### 4.3 Endpoint: `POST /api/companies/:id/extract-contacts`

**Body:**
```json
{
  "text": "...html eller plain text klistret af bruger...",
  "source_url": "https://regionh.dk/kontakt"
}
```

**Logik:**
1. Body skal være > 50 tegn og < 500 KB (rimeligt loft)
2. Strip HTML-tags hvis indholdet ligner HTML (basic regex — ikke fuld parser)
3. Kald `extractContacts({ text, sourceUrl })`
4. Krydsreferér mod eksisterende `contact_points` (markér `already_exists: true`)
5. Returnér kandidater — gem intet endnu

**Response:**
```json
{
  "ok": true,
  "source_url": "https://regionh.dk/kontakt",
  "candidates": [
    {
      "kind": "email",
      "value": "presse@regionh.dk",
      "classification": "public",
      "context_snippet": "...pressehenvendelser: presse@regionh.dk eller på telefon...",
      "already_exists": false,
      "proposed_is_public": 1
    },
    ...
  ],
  "stats": { ... }
}
```

Default checkbox-state ved render:
- `classification='public'` + `!already_exists` → checked
- `classification='unknown'` → unchecked (bruger vælger aktivt)
- `classification='personal'` → unchecked + dæmpet
- `already_exists=true` → disabled checkbox

### 4.4 UI: "Tilføj offentlige kontakter"-modal

Sekundær knap i Firma 360°. Modal viser to-trins flow:

**Trin 1 — paste:**
```
┌─────────────────────────────────────────────────────────┐
│ 📋 Tilføj offentlige kontakter                  [×]    │
├─────────────────────────────────────────────────────────┤
│ Klistr indhold fra firmaets kontaktside, footer eller   │
│ "Om os"-side ind. Vi finder emails og telefoner —       │
│ du vælger hvilke der skal gemmes som offentlige.        │
│                                                         │
│ Kilde-URL (valgfrit):                                   │
│ [https://regionh.dk/kontakt                          ]  │
│                                                         │
│ Klistret indhold:                                       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │                                                     │ │
│ │  (klistr HTML eller tekst her)                      │ │
│ │                                                     │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│                              [Annullér] [Find →]        │
└─────────────────────────────────────────────────────────┘
```

**Trin 2 — vælg kandidater:**
```
┌─────────────────────────────────────────────────────────┐
│ 📋 8 emails + 3 telefoner fundet                 [×]   │
├─────────────────────────────────────────────────────────┤
│ ✓ Foreslået offentlig (4)                               │
│ ☑ ✉ info@regionh.dk        "...generelle henvendel..."  │
│ ☑ ✉ presse@regionh.dk      "...pressehenvendelser..."   │
│ ☑ ✉ kontakt@regionh.dk     "...for kontakt skriv til..."│
│ ☐ ✉ info@regionh.dk (allerede registreret) [disabled]   │
│                                                         │
│ ? Ukendt — du vælger (3)                                │
│ ☐ ☏ 38 66 60 00            "...hovednummer..."          │
│ ☐ ☏ 35 45 35 45            "...patientvejledning..."    │
│ ☐ ✉ tilbud@firma.dk        "...send tilbud til..."      │
│                                                         │
│ ⚠ Ligner personlige (4) — markér selv hvis offentlige   │
│ ☐ ✉ lars.hansen@regionh.dk  "...overlæge..."            │
│ ☐ ✉ mette.jensen@regionh.dk "...afdelingsleder..."      │
│ ...                                                     │
├─────────────────────────────────────────────────────────┤
│ Kilde: regionh.dk · paste kørt nu                       │
│                       [← Tilbage] [✓ Tilføj 3 valgte]   │
└─────────────────────────────────────────────────────────┘
```

Accept → `POST /api/contact-points` for hver valgte med:
- `source='website'`
- `is_public=1`
- `verified_at=NOW`
- `notes='Indsat via paste-flow' + (source_url ? ' fra ' + source_url : '')`

### Test-spec for fase 4

| Test | Forventet |
|------|-----------|
| Paste tom tekst | Knap "Find →" disabled |
| Paste tekst < 50 tegn | 400 + besked "indhold for kort" |
| Paste tekst > 500 KB | 413 + besked "indhold for stort" |
| Paste HTML med 3 emails + 2 telefoner | Returnerer 5 kandidater med classification |
| `info@regionh.dk` i input | classification='public' |
| `lars.hansen@regionh.dk` i input | classification='personal' |
| `tilbud@firma.dk` i input (ikke i prefix-listen) | classification='unknown' |
| Telefon `38 66 60 00` | classification='unknown' |
| 8-cifret tal i kontekst med "CVR 12345678" | Filtreret væk (ikke telefon) |
| Email findes allerede som contact_point | `already_exists=true`, disabled checkbox |
| Accept med 3 valgte | 3 contact_points oprettes med `source='website'`, `is_public=1` |
| Default-state efter parse | Public emails forhåndsvalgte, alt andet unchecked |

**Manuel test:** Klistr footer/kontaktside fra 5 forskellige kunders hjemmesider — verificér at heuristikken fanger det rigtige.

---

## FASE 5 — Navigation: Kontakter med Personer/Firmaer-faner

### 5.1 Sidebar-ændring i `office/index.html`

```html
<!-- FØR -->
<a class="sidebar-item" data-view="kunder">👥 Kunder</a>

<!-- EFTER -->
<a class="sidebar-item" data-view="kontakter">👥 Kontakter</a>
```

View-navnet ændres fra `kunder` til `kontakter`. Backwards-compat: tilføj redirect-handler:

```js
// office/index.html — switchView
if (view === 'kunder') view = 'kontakter';  // backwards-compat for bookmarks
```

### 5.2 Ny view-shell: `office/views/kontakter.js`

Viewet er en thin wrapper med faner. Hver fane mounter en eksisterende child-view:

```js
function initKontakter(container) {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get('tab') || 'personer';
    
    container.innerHTML = `
        <div class="kontakter-tabs">
            <button class="ktab ${tab === 'personer' ? 'active' : ''}" data-tab="personer">
                👤 Personer
            </button>
            <button class="ktab ${tab === 'firmaer' ? 'active' : ''}" data-tab="firmaer">
                🏢 Firmaer
            </button>
        </div>
        <div id="kontakter-content"></div>
    `;
    
    document.querySelectorAll('.ktab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    mountTab(tab);
}

function switchTab(tab) {
    const url = new URL(window.location);
    url.searchParams.set('tab', tab);
    history.replaceState(null, '', url);
    document.querySelectorAll('.ktab').forEach(b => 
        b.classList.toggle('active', b.dataset.tab === tab)
    );
    mountTab(tab);
}

function mountTab(tab) {
    const content = document.getElementById('kontakter-content');
    if (tab === 'personer') {
        initCrmKunde360(content);   // eksisterende — ingen ændring
    } else if (tab === 'firmaer') {
        initCrmFirmaer(content);     // ny — fase 5.3
    }
}
```

**Vigtigt:** når man navigerer fra Personer-fanen ind i en specifik kunde (Kunde 360°-detalje), skal URL'en stadig kunne læses bagefter. Eksisterende `_k3CustomerId` URL-param-håndtering bibeholdes — fane-state og kunde-detalje-state lever side om side i URL'en (`?tab=personer&customer=42`).

### 5.3 `office/views/crm-firmaer.js` (ny — listview)

Spejler `crm-kunde360.js`'s søge-mode, men for firmaer.

**Layout:** ligner skærmbilledet du sendte (Kunder-listen) — én række per firma med:
- Firmanavn + tags (VIP, Active, Dormant — afledt fra aggregering af kunder)
- Branche + by
- Antal kontakter + antal bons + omsætning

Klik på række → switch til Firma 360° (fase 6).

### 5.4 Ny endpoint: `GET /api/crm/companies`

Aggregeret liste af firmaer med kunde- og bon-statistik.

```js
// routes/crm.js — tilføj efter eksisterende /customers-handler

router.get('/companies', handle((req, res) => {
    const db = getDb();
    const { stage, q, order_after, order_before } = req.query;
    const limit = parseInt(req.query.limit) || 50;
    
    const where = ["co.is_active = 1"];
    let bonFilter = "b.is_internal = 0";
    const having = [];
    const args = [];
    
    if (q) {
        where.push("(co.name LIKE ? OR co.cvr LIKE ? OR co.legal_name LIKE ?)");
        const s = '%' + q + '%';
        args.push(s, s, s);
    }
    if (order_after) { having.push("MAX(b.delivery_date) >= ?"); args.push(order_after); }
    if (order_before) { having.push("MAX(b.delivery_date) <= ?"); args.push(order_before); }
    
    const havingClause = having.length > 0 ? 'HAVING ' + having.join(' AND ') : '';
    args.push(limit);
    
    const rows = db.prepare(`
        SELECT co.id,
               co.name,
               co.legal_name,
               co.cvr,
               co.ean,
               COUNT(DISTINCT c.id) AS contact_count,
               COUNT(DISTINCT b.id) AS total_orders,
               COALESCE(SUM(b.total_price), 0) AS total_revenue,
               MAX(b.delivery_date) AS last_order_date,
               CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) AS days_since_last,
               -- Aggregeret stage: VIP hvis nogen kunde er VIP, ellers active/dormant ud fra senest bestilling
               CASE 
                   WHEN MAX(CASE WHEN cm.stage = 'vip' THEN 1 ELSE 0 END) = 1 THEN 'vip'
                   WHEN MAX(b.delivery_date) IS NULL OR julianday('now') - julianday(MAX(b.delivery_date)) > 180 THEN 'dormant'
                   ELSE 'active'
               END AS aggregated_stage
        FROM companies co
        LEFT JOIN customers c ON c.company_id = co.id AND c.is_active = 1
        LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
        LEFT JOIN bons b ON b.company_id = co.id AND ${bonFilter}
        WHERE ${where.join(' AND ')}
        GROUP BY co.id
        ${havingClause}
        ORDER BY total_revenue DESC
        LIMIT ?
    `).all(...args);
    
    res.json(rows);
}));
```

Filter på `?stage=vip|active|dormant` filtrerer efter `aggregated_stage` (HAVING).

### 5.5 CSS — `kontakter.css`

Genbrug eksisterende `kunde360`-styling for tabs + listview-rækker. Tabs:

```css
.kontakter-tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--color-line);
    margin-bottom: 16px;
}
.ktab {
    padding: 10px 16px;
    border: none;
    background: transparent;
    font-size: 14px;
    color: var(--color-text-dim);
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
}
.ktab.active {
    color: var(--color-text);
    border-bottom-color: var(--color-accent);
}
```

### Test-spec for fase 5

| Test | Forventet |
|------|-----------|
| Sidebar viser "Kontakter" i stedet for "Kunder" | ✓ |
| Default-fane er Personer | URL gets `?tab=personer` ved init |
| Klik Firmaer | URL `?tab=firmaer`, firmaer-listview render |
| Browser-back fra Firmaer → Personer | Personer-fane vises igen |
| Bookmark `/office/?view=kunder` | Redirecter til `/office/?view=kontakter&tab=personer` |
| Søg i firmaer med `?q=region` | Filtrerer på navn + legal_name + CVR |
| Stage-filter `?stage=vip` | Kun firmaer med mindst én VIP-kunde |
| Klik firma-række | Navigerer til Firma 360° (fase 6) |

---

## FASE 6 — Firma 360° view

### 6.1 Ny view: `office/views/crm-firma360.js`

Spejler `crm-kunde360.js`-strukturen. Sub-views (faner inde i Firma 360°):

| Fane | Indhold |
|------|---------|
| **Oversigt** | Firma-stamdata, kontaktpunkter, stat-strip (kunder, bons, omsætning) |
| **Kontakter** | Liste af alle `customers` under firmaet — klik → Kunde 360° |
| **Bons** | Alle bons aggregeret på firma-niveau |
| **Tilbud** | Alle tilbud aggregeret |
| **Mail** | Mail-tråde tværs af alle kunder under firmaet |
| **Aktivitet** | Aggregeret aktivitet fra `crm_activities` via firmaets kunder |

### 6.2 Ny endpoint: `GET /api/crm/company/:id`

Detaljeret firma-data inkl. aggregations:

```json
{
  "id": 42,
  "name": "Rigshospitalet, Hjertemedicinsk Klinik",
  "legal_name": "Region Hovedstaden",
  "cvr": "29190623",
  "ean": "5798001021197",
  "address": { "street": "Blegdamsvej 9", "zip": "2100", "city": "København Ø" },
  "industry": "Hospitaler",
  "employees": 52124,
  "website": "www.regionh.dk",
  "last_enriched_at": "2026-04-12T10:30:00Z",
  "last_enriched_source": "Virk ElasticSearch",
  
  "contact_points": [ ... contact_points array ... ],
  
  "aggregations": {
    "contact_count": 12,
    "active_contact_count": 8,
    "total_orders": 142,
    "total_revenue": 487520,
    "first_order_date": "2023-08-12",
    "last_order_date": "2026-04-15",
    "avg_order_value": 3433,
    "vip_count": 2,
    "dormant_count": 4
  }
}
```

### 6.3 Cross-linking

#### Fra Kunde 360° → Firma 360°

I `crm-kunde360.js`, firma-kortet:

```js
// Firmanavn bliver klikbart
'<a href="?view=kontakter&tab=firmaer&company=' + companyId + '" ' +
'class="k3-firma-link">' + firmaName + '</a>'
```

#### Fra Firma 360° → Kunde 360°

I `crm-firma360.js`, Kontakter-fane:

```js
// Bruger eksisterende /api/crm/customers?company_id=X
const customers = await fetch('/api/crm/customers?company_id=' + companyId);

// Hver række er klikbar:
'<a href="?view=kontakter&tab=personer&customer=' + c.id + '">' + c.name + '</a>'
```

### 6.4 Berig + scrape fra Firma 360°

Knapperne lever **kun i Firma 360°** og IKKE længere i Kunde 360°. Begrundelse: berigelse er en firma-handling, ikke en person-handling. Hvis bruger er i Kunde 360° og vil berige, klikker de på firmanavnet → går til Firma 360° → beriger der.

> **Bemærk:** Dette er en lille korrektion fra mockup'en hvor knapperne stod i Kunde 360°. Cleaner UX at lade Firma 360° være den eneste indgang til berigelse.

### 6.5 Tabs i Firma 360°

Genbrug fane-mønster fra Kunde 360°. Hver tab har sin egen render-funktion:

```js
function _f3RenderTab(tab) {
    const el = document.getElementById('f3-tab-content');
    if (tab === 'oversigt')   _f3RenderOversigt(el);
    if (tab === 'kontakter')  _f3RenderKontakter(el);
    if (tab === 'bons')       _f3RenderBons(el);
    if (tab === 'tilbud')     _f3RenderTilbud(el);
    if (tab === 'mail')       _f3RenderMail(el);
    if (tab === 'aktivitet')  _f3RenderAktivitet(el);
}
```

Bons og Tilbud kan genbruge eksisterende API-endpoints med `?company_id=` filter (tilføj filter i `routes/bons.js` og `routes/quotes.js` hvis ikke der allerede).

### Test-spec for fase 6

| Test | Forventet |
|------|-----------|
| Naviger til firma med 0 kunder | Firma 360° loader; Kontakter-fane viser "Ingen kontakter" |
| Aggregeringer | Match `total_orders` og `total_revenue` mod direkte SQL-query |
| Klik på kontakt i Kontakter-fane | Navigerer til Kunde 360° med korrekt customer_id |
| Klik på firmanavn i Kunde 360° | Navigerer til Firma 360° |
| Berig-knap i Firma 360° | Åbner samme modal som specced i fase 3 |
| Bons-fane med filter `?from=2026-01-01` | Filtrerer korrekt |
| Mail-fane | Viser tråde aggregeret tværs af alle kunder under firmaet |

---

## FASE 7 — Admin batch-CVR-berigelse

### 7.1 Knap i Settings

I `settings/index.html`, sektion "Data-værktøjer" (eller ny sektion "Berigelse"):

```html
<button class="btn-primary" id="btn-batch-enrich">
    Berig alle firmaer mod CVR
</button>
<div class="settings-help">
    Kører CVR-opslag på alle firmaer der ikke er beriget de sidste 90 dage.
    Officielle emails og telefoner fra CVR markeres automatisk som offentlige (PUB).
    Eksisterende data overskrives ikke — kun nye felter udfyldes.
</div>
```

### 7.2 Endpoint: `POST /api/admin/batch-enrich-companies`

**Logik:**
1. Find firmaer hvor `last_enriched_at IS NULL OR last_enriched_at < NOW - 90 days`
2. For hvert firma: kør samme logik som `POST /api/companies/:id/enrich-preview`, accepter alle nye felter (ikke ændringer på eksisterende), opret kontaktpunkter med `is_public=1`
3. Stream progress via SSE-event `batch_enrich_progress`
4. Returnér summary

**Body:**
```json
{
  "max_age_days": 90,
  "dry_run": false
}
```

**Response (efter ~N minutter):**
```json
{
  "ok": true,
  "total": 980,
  "processed": 980,
  "matched": 622,
  "no_match": 358,
  "fields_updated": 1842,
  "contact_points_created": 384,
  "errors": 0,
  "duration_ms": 142000
}
```

**SSE-events undervejs:**
```json
{ "event": "batch_enrich_progress", "data": { "current": 142, "total": 980, "company_id": 73, "status": "matched" } }
```

### 7.3 UI — progress-modal

Frontend lytter på SSE og opdaterer:

```
┌──────────────────────────────────────────────┐
│  Beriger firmaer mod CVR…                    │
├──────────────────────────────────────────────┤
│  ████████████░░░░░░░░░░░  142 / 980          │
│  ✓ 89 berigede · ⚠ 53 uden match             │
│                                              │
│  [Annullér]                                  │
└──────────────────────────────────────────────┘
```

**Annullér** sender `POST /api/admin/batch-enrich-companies/cancel` → server sætter cancel-flag, jobbet stopper efter næste firma.

### 7.4 Sikkerhed

- Endpoint kræver `requireAuth({ role: 'admin' })`
- Concurrency: kun ét batch-job kan køre ad gangen (lock i settings: `batch_enrich_running=1`, `batch_enrich_started_at=NOW`)
- Ved server-crash undervejs: lock auto-frigives efter 30 min (settings tjekkes ved næste start)

### Test-spec for fase 7

| Test | Forventet |
|------|-----------|
| Klik "Berig alle" som ikke-admin | 403 forbidden |
| Job kører på 50 test-firmaer | Progress-events streames live |
| Annullér midt i job | Stopper efter næste firma; status returnerer "cancelled" |
| Kør to jobs samtidig | Anden returnerer 409 conflict |
| Job crashe | Lock auto-frigives efter 30 min |
| Idempotens: kør twice | Anden kørsel finder 0 firmaer (alle nyligt berigede) |
| Dry-run mode | Returnerer summary uden at gemme noget |

---

## FASE 8 — Admin: Manuel firma-sammenlægning

EAN-merge-scriptet (`scripts/merge-ean-duplicates.js`) håndterede de sikre tilfælde i én batch-kørsel. Tilbage er de ikke-trivielle dubletter: stavefejl ("Rigshospitalts"), forkortelser ("RH" vs "Rigshospitalet"), firmaer uden EAN, samme firma oprettet to gange fra to forskellige formularer. De skal kunne fusioneres manuelt fra UI'et med fuld synlighed over hvad der flyttes hvor.

### 8.1 Knap i Settings

I samme sektion som batch-berig (fase 7):

```html
<button class="btn-secondary" id="btn-merge-companies">
    Sammenlæg firmaer
</button>
<div class="settings-help">
    Brug når to firmaer i basen i virkeligheden er det samme firma 
    (stavefejl, forkortelser, dobbeltoprettelse). Alle kunder, bons, 
    tilbud og kontaktpunkter flyttes til vinderen, og taberen 
    deaktiveres (ikke slettet). En JSON-snapshot af alle berørte rækker
    gemmes i changelog, så <code>scripts/undo-merge.js &lt;changelog_id&gt;</code>
    kan rulle handlingen tilbage hvis nødvendigt.
</div>
```

### 8.2 Endpoint: `GET /api/admin/merge-companies/preview`

Query: `?winner_id=42&loser_id=87`

**Logik:** sammenlign de to firmaer og returnér hvad en merge ville resultere i — uden at gemme noget.

**Response:**
```json
{
  "winner": {
    "id": 42,
    "name": "Rigshospitalet, Hjertemedicinsk",
    "cvr": "29190623",
    "ean": "5798001021197",
    ...
  },
  "loser": {
    "id": 87,
    "name": "Rigshospitalts Hjertemed.",
    "cvr": null,
    "ean": null,
    ...
  },
  "moves": {
    "customers": 3,
    "bons": 12,
    "quotes": 1,
    "contact_points_new": 2,
    "contact_points_duplicates": 1,
    "activities_via_customers": 8,
    "mail_threads": 4
  },
  "conflicts": [
    { 
      "field": "name", 
      "winner_value": "Rigshospitalet, Hjertemedicinsk",
      "loser_value": "Rigshospitalts Hjertemed.",
      "recommendation": "winner"
    },
    { 
      "field": "cvr",
      "winner_value": "29190623",
      "loser_value": null,
      "recommendation": "winner"
    },
    { 
      "field": "notes",
      "winner_value": "VIP-kunde siden 2023",
      "loser_value": "Husker stort set altid faktura-ref",
      "recommendation": "merge"  // begge tekster bevares
    }
  ],
  "warnings": [
    "Begge firmaer har aktive bons i de sidste 30 dage — verificér at det virkelig er duplikater",
    "Loser har e-conomic_customer_id sat — sørg for at vinderen også har en e-conomic-kobling før merge"
  ]
}
```

**Konflikt-typer:**
- `winner` — winner har værdi, loser har ikke (eller samme) → ingen konflikt strengt taget, men vises hvis `recommendation` er ikke-triviel
- `loser` — kun loser har værdi → anbefaling: brug loser's
- `merge` — begge har tekstværdi (notes, address-noter) → anbefaling: append begge med separator
- `pick` — begge har forskellig værdi → bruger skal vælge

**Warnings:** soft-warnings der ikke blokerer merge, men advarer om risiko:
- Aktive bons i begge inden for 30 dage
- Forskellige CVR-numre (sandsynligvis IKKE samme firma)
- Forskellige EAN-numre (NemHandel-konflikt — hvert EAN er unikt)
- Loser har data som winner mangler (e-conomic ID, EAN, CVR)

### 8.3 Endpoint: `POST /api/admin/merge-companies`

**Body:**
```json
{
  "winner_id": 42,
  "loser_id": 87,
  "field_choices": {
    "name": "winner",
    "legal_name": "winner",
    "cvr": "winner",
    "ean": "winner",
    "address_id": "winner",
    "notes": "merge"
  },
  "merge_notes_separator": "\n\n--- Sammenlagt fra firma #87 ---\n\n",
  "user_notes": "Stavefejl: 'Rigshospitalts' rettet til 'Rigshospitalet'",
  "force": false
}
```

`force: true` overstyrer warnings (fx forskellige CVR'er). Hvis `force: false` og der er warnings, returnér 409 med warnings-listen.

**Logik:**
```
BEGIN TRANSACTION

1. Validér: begge firmaer findes, begge er is_active=1
2. Hvis warnings og !force: ROLLBACK + return 409
3. Hvis ingen warnings eller force: fortsæt

4. BYG SNAPSHOT (FØR der ændres noget):
   snapshot = {
     winner_row: { ...alle kolonner fra companies WHERE id=winner_id... },
     loser_row:  { ...alle kolonner fra companies WHERE id=loser_id... },
     moved_customers: [
       { id: c.id, original_company_id: loser_id }
       for c in customers WHERE company_id=loser_id
     ],
     moved_bons: [
       { id: b.id, original_company_id: loser_id }
       for b in bons WHERE company_id=loser_id
     ],
     moved_quotes: [...],
     moved_mail_threads: [...],   // hvis tabellen har company_id
     moved_contact_points: [
       { id: cp.id, action: 'moved'|'deleted_dup',
         original_entity_id: loser_id,
         existing_winner_cp_id: winner_cp.id|null }
       for cp in contact_points WHERE entity_type='company' AND entity_id=loser_id
     ]
   }
   // Stuff'es i changelog-payload i trin 12

5. UPDATE customers SET company_id = winner_id WHERE company_id = loser_id
6. UPDATE bons SET company_id = winner_id WHERE company_id = loser_id
7. UPDATE quotes SET company_id = winner_id WHERE company_id = loser_id
8. UPDATE mail_threads SET company_id = winner_id WHERE company_id = loser_id
   (hvis tabellen har company_id)

9. Flyt contact_points med dedup:
   FOR each cp IN contact_points WHERE entity_type='company' AND entity_id=loser_id:
     IF EXISTS(entity_type='company', entity_id=winner_id, kind=cp.kind, value=cp.value):
       SLET cp (duplikat) — record action='deleted_dup' i snapshot
     ELSE:
       UPDATE cp SET entity_id = winner_id — record action='moved' i snapshot

10. Apply field_choices på winner:
    FOR each (field, choice) IN field_choices:
      IF choice == 'loser': UPDATE companies SET {field} = loser.{field} WHERE id = winner_id
      IF choice == 'merge' (kun for notes-felter):
        UPDATE companies SET notes = winner.notes || separator || loser.notes WHERE id = winner_id

11. Markér loser som inactive + tilføj alternate name:
    UPDATE companies SET 
        is_active = 0,
        notes = COALESCE(notes,'') || '\n[Sammenlagt med firma #' || winner_id || ' den ' || NOW || ']'
    WHERE id = loser_id

12. Tilføj loser's navn som alternate_name på winner (for søgbarhed):
    Eksisterende migration: tilføj kolonne hvis ikke der
    ALTER TABLE companies ADD COLUMN alternate_names TEXT  -- JSON array
    
    UPDATE companies SET alternate_names = json_insert(
        COALESCE(alternate_names, '[]'),
        '$[#]',
        loser.name
    ) WHERE id = winner_id

13. Skriv changelog (action='merge') — payload indeholder fuld snapshot:
    {
      "winner_id": 42,
      "loser_id": 87,
      "loser_name": "Rigshospitalts Hjertemed.",
      "moves": { customers: 3, bons: 12, ... },
      "field_choices": {...},
      "user_notes": "Stavefejl...",
      "snapshot": { ...se trin 4... },
      "schema_version": 1
    }
    
    Snapshot kan være 10–500 KB. Changelog-tabellen bør håndtere TEXT op til ~1 MB pr.
    række — verificér ved test af stort merge (100+ bons).

14. SSE-broadcast: 'company_merged' med begge IDs (så åbne views kan refreshe)

COMMIT
```

### 8.3.1 Rollback-script: `scripts/undo-merge.js`

Standalone CLI-værktøj til at fortryde en merge. Bruger `db/compat.js` `openDb()` og `transaction()`.

**Kald:**
```bash
node --experimental-sqlite scripts/undo-merge.js <changelog_id> [--dry-run]
```

**Logik:**
```
1. Hent changelog-rækken med id=changelog_id, action='merge'
   Fejl hvis ikke fundet, eller hvis allerede markeret som rolled-back
   (ny kolonne på changelog: rolled_back_at)

2. Parse snapshot fra payload (verificér schema_version)

3. Sanity-tjek FØR rollback:
   - winner_id findes stadig og er is_active=1 (ellers fejl: "winner mangler/inaktiv")
   - loser_id findes stadig (ellers fejl: "loser slettet permanent")
   - Hvis nogen af de moved_* rækker er flyttet videre til et tredje firma siden:
     log warning, men fortsæt (rollback peger dem tilbage til loser_id, hvor de oprindeligt var)

4. Hvis --dry-run: print plan og afslut.

5. BEGIN TRANSACTION
   a) UPDATE customers SET company_id = original_company_id 
      WHERE id IN (snapshot.moved_customers IDs)
      (kun hvis nuværende company_id = winner_id — undgå at overskrive senere flytninger)
   b) Samme for bons, quotes, mail_threads
   c) For moved_contact_points med action='moved': UPDATE entity_id = original_entity_id
      (kun hvis nuværende entity_id=winner_id)
   d) For moved_contact_points med action='deleted_dup': INSERT genskabt række 
      med samme felter som loser-cp havde (rekonstrueret fra snapshot).
      Sæt nyt id (auto-increment).
   e) UPDATE companies SET is_active = 1 WHERE id = loser_id
   f) UPDATE companies SET 
        alternate_names = json_remove(alternate_names, '$[?(@==loser.name)]')
      WHERE id = winner_id
      (eller simplere: filtrér loser-name ud i JS, write back)
   g) Restore winner row hvis field_choices var anvendt:
      UPDATE companies SET {field} = snapshot.winner_row.{field} 
      WHERE id = winner_id AND field IN (alle felter der var i field_choices)
   h) Skriv changelog (action='merge_rollback', payload={ original_changelog_id })
   i) UPDATE changelog SET rolled_back_at = NOW WHERE id = changelog_id
   COMMIT

6. Print summary: "Rollback gennemført. X kunder, Y bons, Z contact_points sat tilbage til firma #loser_id."
```

**Migration:** tilføj `rolled_back_at DATETIME` på `changelog`-tabellen (eller hvad den hedder i nuværende skema — verificér).

**Begrænsninger der dokumenteres i scriptets help-tekst:**
- Kan ikke rulle tilbage hvis loser-firmaet er hård-slettet (men det sker aldrig fra UI)
- Hvis nogen rækker er flyttet videre til et tredje firma efter merge, vil rollback overstyre den senere flytning — warning printes
- Nye contact_points oprettet på winner efter merge bevares (røres ikke)
- Bons der har fået linjer eller status-ændringer efter merge bevares — kun `company_id` rulles tilbage

**Response (success):**
```json
{
  "ok": true,
  "winner_id": 42,
  "loser_id": 87,
  "moves_executed": {
    "customers": 3,
    "bons": 12,
    "quotes": 1,
    "contact_points_moved": 2,
    "contact_points_deleted_as_duplicate": 1,
    "mail_threads": 4
  },
  "changelog_id": 9134
}
```

**Response (warnings + !force):**
```json
{
  "ok": false,
  "code": "warnings_present",
  "warnings": [...],
  "hint": "Genindsend med force:true for at overstyre"
}
```

### 8.4 UI-flow: tre-trins wizard

#### Trin 1 — Vælg de to firmaer

```
┌─────────────────────────────────────────────────────────┐
│ 🔀 Sammenlæg firmaer — Trin 1 af 3              [×]    │
├─────────────────────────────────────────────────────────┤
│ Vælg det firma der skal BEHOLDES (vinderen):            │
│ [🔍 Søg firma...                                     ]  │
│   ✓ Rigshospitalet, Hjertemedicinsk                     │
│     CVR 29190623 · 12 bons · seneste 14. apr 2026       │
│                                                         │
│ Vælg det firma der skal SLETTES (taberen):              │
│ [🔍 Søg firma...                                     ]  │
│   ✓ Rigshospitalts Hjertemed.                           │
│     CVR — · 4 bons · seneste 28. mar 2026               │
│                                                         │
│                              [Annullér] [Næste →]       │
└─────────────────────────────────────────────────────────┘
```

Søgebokse bruger samme logik som `crm-firmaer.js`-listview (eller eksisterende `/api/companies?q=`). Forhindrer at vælge samme firma to gange.

#### Trin 2 — Preview + felt-valg

Kalder `GET /api/admin/merge-companies/preview?winner_id=X&loser_id=Y` ved load.

```
┌─────────────────────────────────────────────────────────┐
│ 🔀 Trin 2 af 3 — Hvad sker der?                  [×]   │
├─────────────────────────────────────────────────────────┤
│ Følgende flyttes til vinderen:                          │
│   3 kontakter · 12 bons · 1 tilbud · 4 mailtråde        │
│   2 kontaktpunkter (1 duplikat slettes)                 │
├─────────────────────────────────────────────────────────┤
│ ⚠️ Begge har aktive bons inden for 30 dage              │
├─────────────────────────────────────────────────────────┤
│ FELTER MED FORSKEL — vælg hvilken værdi der gemmes:     │
│                                                         │
│ Navn:    (•) Rigshospitalet, Hjertemedicinsk            │
│          ( ) Rigshospitalts Hjertemed.                  │
│                                                         │
│ CVR:     (•) 29190623                                   │
│          ( ) — ikke sat —                               │
│                                                         │
│ Noter:   ( ) Behold kun vinderens                       │
│          (•) Sammenfat begge (anbefales)                │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ Valgfri note om denne fusion:                           │
│ [Stavefejl — 'Rigshospitalts' var en typo               ]│
│                                                         │
│                        [← Tilbage] [Næste →]            │
└─────────────────────────────────────────────────────────┘
```

#### Trin 3 — Bekræft

```
┌─────────────────────────────────────────────────────────┐
│ 🔀 Trin 3 af 3 — Bekræft                          [×]  │
├─────────────────────────────────────────────────────────┤
│ Du er ved at sammenlægge firma #87 ind i firma #42.     │
│                                                         │
│ Dette kan IKKE fortrydes automatisk.                    │
│ Handlingen logges i changelog.                          │
│                                                         │
│ Skriv vinderens navn for at bekræfte:                   │
│ [                                                     ] │
│ (Skriv "Rigshospitalet, Hjertemedicinsk")               │
│                                                         │
│ [⚠ Overstyr advarsler (force)]  ☐                       │
│                                                         │
│            [← Tilbage] [✗ Annullér] [✓ Sammenlæg]      │
└─────────────────────────────────────────────────────────┘
```

Submit-knap er disabled indtil vinderens navn er skrevet eksakt. Force-checkbox skal aktivt tjekkes hvis der er warnings i trin 2.

### 8.5 Migration: `companies.alternate_names`

Hvis kolonnen ikke findes i forvejen:

```sql
ALTER TABLE companies ADD COLUMN alternate_names TEXT;  -- JSON array, fx ["Rigshospitalts Hjertemed.", "RH HM"]
```

`crm-firmaer.js`-listview og `routes/companies.js`-søg udvides til også at matche på `alternate_names`:

```sql
WHERE name LIKE '%' || ? || '%' 
   OR cvr LIKE '%' || ? || '%'
   OR alternate_names LIKE '%' || ? || '%'
```

### 8.6 Sikkerhed + audit

- Endpoint kræver `requireAuth({ role: 'admin' })`
- Hvert merge logger fuld payload i changelog (winner-row, action='merge')
- SSE-broadcast så åbne Kunde 360°/Firma 360°-views kan re-loade hvis brugeren ser den merget loser
- Hvis én bruger har taberen åben mens en anden bruger merger: SSE'en triggrer "Dette firma er blevet sammenlagt med #42" + auto-redirect

### Test-spec for fase 8

| Test | Forventet |
|------|-----------|
| Preview to firmaer uden konflikter | 0 conflicts, alle moves talt korrekt |
| Preview firmaer med forskellig CVR | Warning om CVR-mismatch |
| Preview firmaer med EAN på begge | Warning om EAN-konflikt |
| Merge med `force=false` + warnings | 409 conflict |
| Merge med `force=true` + warnings | Gennemfører |
| Contact_points-dedup: loser har samme email som winner | Loser's slettes, winner's bevares |
| Customers flyttes | `customer.company_id = winner_id` for alle 3 |
| Bons flyttes | `bon.company_id = winner_id` |
| Loser markeres inaktiv | `is_active = 0`, ikke slettet fysisk |
| Winner får alternate_name | JSON-array indeholder loser's navn |
| Søg på loser's gamle navn efter merge | Finder winner (via alternate_names) |
| Changelog | Indeholder fuld payload + user_notes |
| SSE-event broadcastes | `company_merged` modtages af åbne views |
| Bekræftelses-tekst er forkert | Submit-knap forbliver disabled |
| Naviger til loser efter merge (gammel URL) | Vis "Dette firma er sammenlagt med [winner-link]" |
| Changelog-payload indeholder snapshot | `payload.snapshot.moved_customers`, `moved_bons`, `moved_contact_points` arrays er populated |
| `undo-merge.js <changelog_id> --dry-run` | Print plan, gemmer ingenting |
| `undo-merge.js <changelog_id>` (rigtig kørsel) | Customers/bons/quotes peger igen på loser_id, loser is_active=1, alternate_names rensetn |
| `undo-merge.js` på et allerede rolled-back changelog | Fejl: "merge er allerede rullet tilbage [timestamp]" |
| Mid-rollback: kunde flyttet til 3. firma efter merge | Warning loggges, kunden røres ikke (current company_id != winner_id) |
| Contact_point der blev `deleted_dup` | Genindsættes ved rollback med samme value, source, is_public, purpose |

**Manuel test efter deploy:**
1. Lav to test-firmaer "Test A" og "Test A " (med trailing space) — opret kunder + bon på begge
2. Kør merge i UI
3. Verificér at alt er flyttet korrekt
4. Verificér at "Test A " ikke længere kommer op i søg, men dens gamle navn kan stadig findes via søg
5. Kør `node --experimental-sqlite scripts/undo-merge.js <changelog_id> --dry-run` og verificér plan
6. Kør samme uden `--dry-run` og verificér at de to firmaer er tilbage i oprindelig stand

---



Tilføj følgende i `Misforhold og kendt teknisk gæld`-sektionen (eller opret den hvis den ikke findes):

```markdown
### Kontaktpunkter vs companies/customers cache

`companies.email`, `companies.phone`, `companies.invoice_email`, `customers.email`, 
`customers.phone` er denormaliserede caches af det primære `contact_points`-rækker 
(hvor `is_primary = 1`).

To-vejs sync:
- **CP → cache:** Ved INSERT/UPDATE/DELETE i `contact_points` med `is_primary=1`:
  `syncPrimaryCache()` i `shared/contactPoints.js` opdaterer companies/customers
- **Cache → CP:** SQLite-triggers (`trg_companies_email_to_cp`, ...) fanger 
  direkte UPDATE'er på companies/customers og opdaterer det primære cp 
  (eller opretter et nyt med `source='manual'`, `is_public=0`)

Resultat: cachen kan ikke desyncs, uanset om koden går via det nye API eller 
laver en direkte UPDATE.

Fremtidig refaktor (lavprioritet):
- Drop `companies.email`/`phone`-kolonner og lad alle læs gå via contact_points
- Kræver gennemgang af ~30 steder i kodebasen og fjernelse af triggers
```

Tilføj nye fase-sektioner i status:

```markdown
### Fase 14 — Kontaktpunkter, CVR-berigelse, Firma 360° (april 2026)

- [ ] Migration 0XX: `contact_points` tabel + backfill + cache-triggers (companies + customers, email + phone)
- [ ] `routes/contact-points.js` — CRUD + toggle-public
- [ ] `shared/contactPoints.js` — `syncPrimaryCache()` helper
- [ ] `services/cvrEnrichment.js` — extrakt fra `scripts/enrich-cvr.js`
- [ ] `services/companyDiff.js` — diff-builder
- [ ] `routes/companies.js` — `/enrich-preview` + `/enrich`
- [ ] Migration: `companies.last_enriched_at` + `last_enriched_source`
- [ ] `services/contactExtractor.js` — paste-flow heuristik (emails + phones)
- [ ] `routes/companies.js` — `/extract-contacts` (paste, ingen auto-fetch)
- [ ] `office/index.html` — sidebar "Kunder" → "Kontakter"
- [ ] `office/views/kontakter.js` — fane-shell (Personer | Firmaer)
- [ ] `office/views/crm-firmaer.js` — firmaer listview
- [ ] `routes/crm.js` — `GET /companies` aggregeret listview
- [ ] `office/views/crm-firma360.js` — Firma 360° med 6 faner
- [ ] `routes/crm.js` — `GET /company/:id` aggregeret detail
- [ ] `routes/bons.js` + `routes/quotes.js` — `?company_id=` filter
- [ ] `routes/admin.js` — `/batch-enrich-companies` + cancel + SSE
- [ ] `settings/index.html` — admin-knap "Berig alle firmaer mod CVR"
- [ ] Migration: `companies.alternate_names` (JSON array — for søgbarhed efter merge)
- [ ] Migration: `changelog.rolled_back_at` (DATETIME — markering af fortrudte merges)
- [ ] `routes/admin.js` — `/merge-companies/preview` + `/merge-companies` (m/ JSON-snapshot i payload)
- [ ] `scripts/undo-merge.js` — CLI rollback af et changelog-id
- [ ] `office/views/admin-merge-companies.js` — tre-trins wizard
- [ ] `settings/index.html` — admin-knap "Sammenlæg firmaer"
- [ ] `routes/companies.js` — søg udvidet til at matche `alternate_names`
```

---

## Anbefalet rækkefølge for Simon

| Sprint | Faser | Estimeret indsats |
|--------|-------|-------------------|
| 1 | Fase 1 (DB + CRUD + cache-triggers) | 1-2 dage |
| 2 | Fase 2 (CVR-service + endpoints) + Fase 5 (Navigation) parallelt | 2-3 dage |
| 3 | Fase 6 (Firma 360°) | 3-4 dage |
| 4 | Fase 3 (Berig-UI i Firma 360°) | 1-2 dage |
| 5 | Fase 8 (Manuel merge m/ JSON-rollback + undo-merge.js) | 2-3 dage |
| 6 | Fase 7 (Admin batch-CVR) | 1 dag |
| 7 | Fase 4 (Manuel paste-flow til kontakter) | 1-2 dage |

Total: ~2-3 ugers udvikling. Deploy efter hver sprint så Leif kan teste inkrementelt.

**Rækkefølge-rationale:** Fase 8 (merge) prioriteres før Fase 7 (batch-CVR), så vi rydder op i duplikater før vi beriger dem (ellers beriger vi 5 versioner af samme firma). Fase 4 (paste-flow) er sidst fordi den er lavest værdi og lavest risiko nu hvor scrape-tilgangen er droppet.

---

## Spørgsmål Simon kan stille undervejs

Hvis noget er uklart eller en design-beslutning skal tages midt i implementeringen, skriv det her i denne fil og ping Leif. Eksempler:

- **Hvad gør vi hvis Virk ES er nede under enrich?** (Forslag: fall back til cvrapi.dk hvis konfidens stadig acceptabel)
- **Skal contact_points have et `language`-felt?** (For internationale leverandører — ikke nu)
- **Web-scraping af PDF-kontaktsider?** (Ikke nu — kun HTML)
- **Hvad sker der hvis brugeren markerer en personlig email som PUB manuelt?** (Tillad det — bruger ved bedst, men log med extra opmærksomhed i changelog)

---

## Åbne tekniske noter (under implementering)

### Adresseverifikation via Datafordeleren (Fase 6)

`companies.address_id` peger på normaliseret `addresses`-tabel. Når Fase 6 (Firma 360°) tilføjer adresse-enrichment, skal adresser verificeres mod **Datafordelerens åbne API** (`api.dataforsyningen.dk` — DAWA, samme service der bruges ved kunde-oprettelse i `office/views/crm-kunde360.js` og opret-kunde-flowet). Konkret: når Virk ES leverer en adresse, slå den op via DAWA autocomplete + validering, og link til/opret en `addresses`-række via det normaliserede flow — ikke som flad tekst.

Endpoints der allerede bruges i basen:
- `https://api.dataforsyningen.dk/autocomplete?q=...` — autocomplete
- `https://api.dataforsyningen.dk/adresser?...` — fuld adresse-validering

Adresse-felter er bevidst skippet fra `services/companyDiff.js` FIELD_MAP indtil dette flow bygges.

### Konsolidering af enrichment-timestamps

Companies har TO timestamp-kolonner for enrichment efter Fase 2:
- `cvr_enriched_at` — legacy fra `scripts/enrich-cvr.js` (sat ved batch-berig)
- `last_enriched_at` + `last_enriched_source` — nye fra migration 055 (sat ved runtime-berig via API)

Ny logik skriver kun til de nye, gammelt script kun til det gamle. **Konsolideres i Fase 7** (batch-CVR-berigelse), hvor scriptet alligevel skal refaktoreres til at kalde `services/cvrEnrichment.js`. Når det er gjort: drop `cvr_enriched_at`-kolonnen i en migration, eller migrer eksisterende værdier ind i `last_enriched_at` og drop bagefter.

---

*Dokument oprettet: 29. april 2026*
*Mockup-reference: `berig_firma_mockup.html`*
