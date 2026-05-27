# CLAUDE_OUTREACH_KAMPAGNER.md
> Spec for outreach-kampagner: cherry-picke leads fra eksisterende kunder/firmaer,
> manuel tilføjelse + paste-import, pipeline-board pr. kampagne.
> Mass-email har sin egen spec (se Fase 6 nedenfor).
> Læs `docs/BON_V2_PRINCIPPER.md`, `docs/bon_v2_datamodel_v2.md` (forældet — se faktiske
> migrationer i `db/migrations/`), `docs/CLAUDE_KONTAKTER.md`, og eksisterende
> `office/views/crm-dashboard.js` + `routes/crm.js`
> FØR du starter.
> Oprettet: maj 2026 (v3 — efter kode-validering + review-runde med Leif)

---

## Mål

Tre tæt-koblede problemer løses i samme stak:

1. **Cherry-picking fra lister** — vi har filtrerede kundelister men kan ikke vælge en delmængde til konkret outreach
2. **Eksisterende kunder som nye leads** — `crm_customer_meta.stage` er single-valued (`lead/active/dormant/vip`), så en VIP-kunde kan ikke samtidig være lead i en ny outreach uden at miste sin VIP-status
3. **Manglende kampagne-overblik** — pipelinen er global pr. kunde, ikke pr. outreach-runde, så indsatser blandes sammen

Løsningen er to nye tabeller (`outreach_campaigns` + `campaign_members`) der lever parallelt med eksisterende stage-modellen. En medlems-status er midlertidig og kampagne-bundet; en kundes stage er den varige relation. De to forveksles ikke.

---

## Designbeslutninger (afgjort med Leif)

> - **To nye tabeller:** `outreach_campaigns` (overordnet kampagne) + `campaign_members` (m:n mod companies/customers med egen status pr. medlem)
> - **Stage forbliver på kunden** — `crm_customer_meta.stage` ændres ikke når kunde tilføjes som medlem. En VIP-kunde kan være lead i en kampagne.
> - **Polymorfi via to nullable FK'er** (`company_id` + `customer_id`), ikke `entity_type/entity_id`. CHECK constraint sikrer at mindst én er sat. Matcher hvordan `bons` og `mail_threads` allerede modellerer det.
> - **Tre partial unique indexes** håndhæver "samme firma/kunde kan ikke være medlem to gange i samme kampagne" på server-niveau (ikke UI-disciplin) — SQLite's NULL-håndtering i standard UNIQUE laver et hul som almindelig UNIQUE-constraint ikke kan lukke.
> - **5 member-statusser:** `lead/quote_sent/negotiating/won/lost`. Matcher eksisterende pipeline-kolonner + `lost` så lost_reason-mønsteret virker.
> - **`lost_reason TEXT`** kun fri tekst i v1 — ikke FK til en reasons-tabel. Hvis det viser sig nyttigt at aggregere på lost-reasons, struktureres det i v2.
> - **`assigned_user_id` pr. medlem** — flere personer arbejder på samme kampagne, så ansvar tildeles pr. lead. `owner_user_id` på selve kampagnen er overordnet ejer.
> - **Stjerne genbruger `crm_customer_meta.tags`** — tilføj `"starred"` til JSON-arrayet. Ingen ny kolonne. `companies.tags` tilføjes parallelt (samme migration).
> - **`marketing_consent` + `do_not_contact` håndhæves server-side** med juridisk korrekt skelnen:
>   - Ren `customer_id` uden `company_id` (B2C) + `marketing_consent=0` → **BLOKERET** (markedsføringsloven §10)
>   - `company_id` sat (B2B) → tilladt; warning hvis underliggende kontakt har `do_not_contact=1` på sin meta
>   - Begge med `do_not_contact=1` → BLOKERET uanset B2B/B2C
> - **Consent-UI på Kunde 360°** tilføjes i Fase 1 — uden den kan privatkunder aldrig sættes til consent og dermed aldrig være medlem af kampagner. Checkbox-par + changelog-log.
> - **Pipeline-board bagudkompatibel** — `/api/crm/pipeline` udvides med `?campaign_id=X`. Uden parameter: medlemmer på tværs af aktive kampagner (default-visningen).
> - **Drag-drop ved multi-kampagne-medlemskab:** når et kort i global-visning repræsenterer en kunde der er i flere åbne kampagner, åbner drag-drop en lille modal: "I hvilken kampagne flytter du denne?" Visuelt: kortet får badge `⚠ N kamp.` Edge-case-håndtering, ikke standard-flow.
> - **`crm_activities.campaign_id` tilføjes som nullable kolonne** (review-rettelse v3) — så en aktivitet kan tilskrives en konkret kampagne uden at det er påkrævet. Eksisterende aktiviteter får NULL (ingen backfill nødvendig — de havde pr. definition ikke en kampagne). Løser "hvor mange touch points i kampagne X?" rent uden v2-omskrivning.
> - **`last_activity_at` opdateres på app-niveau, ikke via trigger** (review-rettelse v3) — `routes/crm.js` POST /activity-handler får en målrettet UPDATE med kendt `member_id` (eller `customer_id`-baseret hvis aktiviteten ikke kender medlemskabet). Trigger-tilgang ville UPDATE'e alle medlemmer hvor `customer_id` matcher, hvilket skalerer dårligt når en VIP-kunde er i flere kampagner og `crm_activities` vokser (booking-modul + mail-svar).
> - **"Vundet → bon" som manuel knap** (review-rettelse v3) — på medlems-detalje for `won`-medlemmer vises en "Konvertér til bon"-knap der åbner eksisterende `bon_opret_modal.js` med pre-fyldte kunde+firma-felter. Aldrig automatisk trigger. Bygges som del af Fase 4.
> - **`bon_v2_datamodel_v2.md` er 60+ migrationer bagud.** Denne spec tilføjer en sektion til sidst med "datamodel-tilføjelser" der kan klippes ind når dokumentet bliver opdateret. Princip 3-overtrædelsen i selve dokumentet er en separat oprydningsopgave (forslag: `scripts/dump-schema.js` i `BON_V2_HUSKELISTE.md`).

---

## Faser

| # | Fase | Risiko | Afhænger af |
|---|------|--------|-------------|
| 0 | Pre-step: udtræk `services/companyMatcher.js` fra `scripts/enrich-cvr.js` (mini-PR, ren refactor) | Lav | — |
| 1 | DB foundation: tabeller + partial unique indexes + `companies.tags` + `crm_activities.campaign_id` + CRUD-API + app-niveau `last_activity_at`-opdatering + consent-UI på Kunde 360° | Lav | — |
| 2 | List-action: "Tilføj valgte til kampagne" i Kunde- og Firma-lister | Lav | 1 |
| 3 | Paste-import: tabular paste → fuzzy-match → bekræft → opret | Mellem | 0, 1 |
| 4 | Pipeline-board med campaign-selector + multi-kampagne drag-drop-modal + "Konvertér til bon"-knap på won-medlemmer | Lav | 1 |
| 5 | Smart-forslag: generér kampagne fra sovende kunder (lost-reason-cron udskudt) | Lav | 1, 4 |
| 6 | Mass-email til kampagne-medlemmer — **afventer separat spec** (`docs/CLAUDE_OUTREACH_MAIL.md`, ikke skrevet endnu) | — | 1, 4 |

Hver fase er independent deploybar og testbar. Fase 2 og 3 kan udvikles parallelt efter Fase 0+1 er deployet.
Fase 6 er kun nævnt i denne spec som forretningsmål — selve implementeringen (queue-tabel, throttling, bounce-håndtering, unsubscribe-token, juridisk EU-flow) får sin egen spec inden kode skrives.

---

## FASE 0 — Udtræk `companyMatcher.js`

> **v3-rettelse:** spec v2 hævdede fejlagtigt at `shared/indkob_settings.js` og `scripts/enrich-cvr.js`
> havde "samme kerne-logik". Kode-validering viste at de to gør forskellige ting:
>
> - `shared/indkob_settings.js` ([linje 1729](shared/indkob_settings.js:1729)): matcher **PRODUKTNAVNE** (Hørkram-vare ↔ Grocy-produkt) med ren dice-bigram på lowercased strings, ingen suffix-normalisering. Andet domæne, andre constraints.
> - `scripts/enrich-cvr.js` ([linje 84](scripts/enrich-cvr.js:84)): matcher **FIRMANAVNE** (Virk ES-resultat ↔ companies-tabel) med token-set Jaccard + substring-check + juridisk-suffix-normalisering (`I/S`, `A/S`, `ApS`, `holding`, `group`, parenteser).
>
> Fase 0 udtrækker derfor **kun** firma-matcheren fra `enrich-cvr.js`. `indkob_settings.js`'s produkt-matcher røres ikke — det er en helt anden refactor.

### 0.1 Ny fil: `services/companyMatcher.js`

Bevarer den eksisterende algoritme fra `enrich-cvr.js` 1:1 — ingen adfærdsændring for CVR-berigelse. Tilføjer kun `matchCompany()`-wrapperen der bruges af paste-import (Fase 3).

```javascript
// services/companyMatcher.js
// Fuzzy-match mod companies-tabellen — bruges af:
//   - scripts/enrich-cvr.js (Virk ES-berigelse) — eksisterende
//   - routes/campaigns.js (paste-import) — nyt i Fase 3
//
// PRODUKTNAVN-matching (Hørkram ↔ Grocy) ligger fortsat i shared/indkob_settings.js
// og deler IKKE kode med denne fil. Forskelligt domæne, andre constraints.

const LEGAL_SUFFIXES = /\b(i\/s|a\/s|aps|s\/i|a\.m\.b\.a|f\.m\.b\.a|fond|forening|smba|ivs|p\/s|k\/s|holding|group|as|is)\b/gi;
const PARENS = /\(.*?\)/g;

/**
 * Normalisér firmanavn for sammenligning.
 * Fjerner parenteser, juridiske suffixer, ikke-alfanumeriske tegn.
 * (Bevaret 1:1 fra scripts/enrich-cvr.js for adfærdsbevarelse.)
 */
function normalizeName(name) {
    return (name || '').toLowerCase()
        .replace(PARENS, '')
        .replace(LEGAL_SUFFIXES, '')
        .replace(/[^a-zæøåé0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Similarity-score 0.0-1.0.
 * Bevaret 1:1 fra scripts/enrich-cvr.js — token-set Jaccard + substring-check.
 * (Bevidst IKKE dice-bigram — firmanavne har for kort gennemsnitslængde til at
 * dice giver gode resultater når suffix er fjernet.)
 */
function similarity(a, b) {
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (na === nb) return 1.0;
    if (na.includes(nb) || nb.includes(na)) return 0.95;
    const tokA = new Set(na.split(' ').filter(t => t.length > 1));
    const tokB = new Set(nb.split(' ').filter(t => t.length > 1));
    if (tokA.size === 0 || tokB.size === 0) return 0;
    let overlap = 0;
    for (const t of tokA) { if (tokB.has(t)) overlap++; }
    const smaller = Math.min(tokA.size, tokB.size);
    if (overlap === smaller && smaller >= 1) return 0.90;
    return (2 * overlap) / (tokA.size + tokB.size);
}

/**
 * Match input mod companies-tabellen.
 * Returnerer { match_type, company_id, confidence, company_name } eller null.
 *
 * Priority:
 *   1. CVR exact   → confidence 1.0, match_type 'cvr_exact'
 *   2. EAN exact   → confidence 1.0, match_type 'ean_exact'
 *   3. Email mod contact_points → confidence 0.95, match_type 'email_match'
 *   4. Navn fuzzy (similarity ≥ 0.85) → confidence = similarity, match_type 'name_fuzzy'
 *   5. Ingen → null
 *
 * Bemærk: `db` er node:sqlite DatabaseSync-instans. Brug getDb() fra db/database.js.
 */
function matchCompany(db, { name, cvr, ean, email, city }) {
    if (cvr) {
        const r = db.prepare('SELECT id, name FROM companies WHERE cvr = ? AND is_internal = 0').get(cvr);
        if (r) return { match_type: 'cvr_exact', company_id: r.id, confidence: 1.0, company_name: r.name };
    }
    if (ean) {
        const r = db.prepare('SELECT id, name FROM companies WHERE ean = ? AND is_internal = 0').get(ean);
        if (r) return { match_type: 'ean_exact', company_id: r.id, confidence: 1.0, company_name: r.name };
    }
    if (email) {
        const r = db.prepare(`
            SELECT co.id, co.name
            FROM contact_points cp
            JOIN companies co ON co.id = cp.entity_id
            WHERE cp.entity_type = 'company' AND cp.kind = 'email' AND cp.value = ?
              AND cp.is_active = 1 AND co.is_internal = 0
            LIMIT 1
        `).get(email.toLowerCase());
        if (r) return { match_type: 'email_match', company_id: r.id, confidence: 0.95, company_name: r.name };
    }
    if (name) {
        // Bemærk: scanner alle ikke-interne companies. På nuværende skala (~1.2k firmaer)
        // er det <10ms. Hvis basen vokser markant, tilføj prefix-filter på normaliseret navn.
        const candidates = db.prepare(`SELECT id, name, city FROM companies WHERE is_internal = 0`).all();
        let best = null;
        for (const c of candidates) {
            const s = similarity(name, c.name);
            if (s >= 0.85 && (!city || !c.city || c.city.toLowerCase() === city.toLowerCase())) {
                if (!best || s > best.confidence) {
                    best = { match_type: 'name_fuzzy', company_id: c.id, confidence: s, company_name: c.name };
                }
            }
        }
        if (best) return best;
    }
    return null;
}

module.exports = { normalizeName, similarity, matchCompany };
```

### 0.2 Refactor — fjern inline-kode i `enrich-cvr.js`

`scripts/enrich-cvr.js` skifter sin egen `normalize()` + `similarity()` ud med `require('../services/companyMatcher')`. Eksisterende kald-sites (`sim: similarity(co.name, r.navn)` på linje 360) bevarer samme signatur.

**Vigtigt:** Eftersom CVR-berigelse er kørt mod 653 firmaer med den nuværende algoritme, må adfærden IKKE ændres. Test før/efter mod et lille sample (5-10 kendte cases fra `data/cvr-virk-review.json`) viser identiske scores.

| Test | Forventet |
|------|-----------|
| `matchCompany(db, {cvr:'12345678'})` med matchende cvr | `cvr_exact`, confidence 1.0 |
| `matchCompany(db, {name:'Magasin'})` mod eksisterende "Magasin A/S" | `name_fuzzy`, confidence ≥ 0.90 (suffix fjernet → identisk → substring-match) |
| `matchCompany(db, {name:'Bagerens hus'})` mod eksisterende "Bagerhuset" | < 0.85, returnerer null |
| `similarity('Ristet Rug', 'Ristet Rug I/S')` | 0.95 (substring efter suffix-fjernelse) |
| Eksisterende `enrich-cvr.js` mod test-sample | Identiske scores før/efter refactor |

**Risiko:** lav. Pure refactor med adfærdsbevarelse, kun ét call-site. Mini-PR.

---

## FASE 1 — Datamodel + CRUD + Consent-UI

### 1.1 Migration: `db/migrations/084_outreach_campaigns.sql`

```sql
-- ==========================================
-- Migration 084 — Outreach-kampagner
-- Cherry-pick leads fra eksisterende kunder/firmaer + manuel tilføjelse
-- Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md
-- ==========================================

-- companies.tags — JSON-array, parallel til crm_customer_meta.tags
ALTER TABLE companies ADD COLUMN tags TEXT;
-- JSON-array: ["kantine","region-hovedstaden","oekologi","starred"]
-- NULL og "[]" behandles ens.

-- ==========================================
-- outreach_campaigns
-- ==========================================
CREATE TABLE outreach_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    owner_user_id INTEGER REFERENCES users(id),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME,
    notes TEXT
);

CREATE INDEX idx_oc_active ON outreach_campaigns(is_active) WHERE is_active = 1;

-- ==========================================
-- campaign_members
-- Polymorf via nullable FK'er — én af company_id/customer_id skal være sat
-- ==========================================
CREATE TABLE campaign_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
    company_id INTEGER REFERENCES companies(id),
    customer_id INTEGER REFERENCES customers(id),
    member_status TEXT NOT NULL DEFAULT 'lead'
        CHECK (member_status IN ('lead','quote_sent','negotiating','won','lost')),
    lost_reason TEXT,
    assigned_user_id INTEGER REFERENCES users(id),
    notes TEXT,
    added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    added_by_user_id INTEGER REFERENCES users(id),
    last_activity_at DATETIME,
    CHECK (company_id IS NOT NULL OR customer_id IS NOT NULL)
);

-- Almindelige indexes for query-performance
CREATE INDEX idx_cm_campaign ON campaign_members(campaign_id);
CREATE INDEX idx_cm_company  ON campaign_members(company_id) WHERE company_id IS NOT NULL;
CREATE INDEX idx_cm_customer ON campaign_members(customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX idx_cm_status   ON campaign_members(campaign_id, member_status);
CREATE INDEX idx_cm_assigned ON campaign_members(assigned_user_id) WHERE assigned_user_id IS NOT NULL;

-- ==========================================
-- Partial unique indexes — håndhæver dedup server-side
-- SQLite's standard UNIQUE behandler NULL som distinct, så
-- UNIQUE(campaign_id, company_id, customer_id) tillader dubletter
-- når en af FK'erne er NULL. De tre partial indexes lukker det hul:
-- ==========================================

-- B2B uden specifik kontakt: kun ét medlem pr. firma pr. kampagne
CREATE UNIQUE INDEX idx_cm_uniq_company_only
    ON campaign_members(campaign_id, company_id)
    WHERE customer_id IS NULL AND company_id IS NOT NULL;

-- Privatkunde: kun ét medlem pr. customer pr. kampagne
CREATE UNIQUE INDEX idx_cm_uniq_customer_only
    ON campaign_members(campaign_id, customer_id)
    WHERE company_id IS NULL AND customer_id IS NOT NULL;

-- B2B med kontakt: kun ét medlem pr. (firma, kontakt)-par pr. kampagne
CREATE UNIQUE INDEX idx_cm_uniq_both
    ON campaign_members(campaign_id, company_id, customer_id)
    WHERE company_id IS NOT NULL AND customer_id IS NOT NULL;

-- ==========================================
-- crm_activities.campaign_id — tilskrivning til kampagne (v3-rettelse)
-- Nullable: eksisterende og fremtidige ikke-kampagne-aktiviteter får NULL.
-- Sætter `last_activity_at` på medlemmer opdateres af `routes/crm.js`
-- POST /activity-handleren (app-niveau, ikke trigger — se designnoter).
-- ==========================================
ALTER TABLE crm_activities ADD COLUMN campaign_id INTEGER REFERENCES outreach_campaigns(id);
CREATE INDEX idx_crm_act_campaign ON crm_activities(campaign_id) WHERE campaign_id IS NOT NULL;
```

**Designnoter:**

- **Partial unique indexes** giver server-garanti uden at duplikere logik i hver INSERT-handler. Forsøg på at indsætte en dublet returnerer `SQLITE_CONSTRAINT_UNIQUE` som server-laget oversætter til 409 Conflict.
- **`ON DELETE CASCADE`** på campaign-FK: når en kampagne slettes, ryger medlemmer med. Kampagner *lukkes* normalt (`is_active=0`), ikke slettes — men cascade'en er der hvis nogen virkelig vil rydde op.
- **Ingen trigger på `crm_activities`** (v3-rettelse). Tidligere udkast brugte `AFTER INSERT`-trigger til at opdatere `campaign_members.last_activity_at`. Det blev fjernet fordi:
  1. Triggeren UPDATE'r *alle* medlemmer hvor `customer_id` matcher — en VIP-kunde i 5 kampagner får 5 UPDATE'er pr. aktivitet.
  2. `crm_activities` vokser hurtigt (booking-modul + mail-svar + manuelle noter).
  3. App-niveau-handler i `routes/crm.js` (se sektion 1.2.5 nedenfor) kan målrette UPDATE'en til netop den kampagne aktiviteten tilskrives, eller skippe det helt for ikke-kampagne-aktiviteter.
- **`crm_activities.campaign_id`** muliggør præcis "touch points i kampagne X"-rapportering. Eksisterende aktiviteter får NULL (de havde pr. definition ingen kampagne). Ingen backfill nødvendig.

### 1.2 `routes/campaigns.js` — endpoints

```javascript
// routes/campaigns.js
const express = require('express');
const router = express.Router();
const { getDb, handle, logChange } = require('../db/helpers');
const { transaction } = require('../db/compat');
const { broadcast } = require('../shared/sse');

// ---- Kampagner ----

router.get('/', handle((req, res) => {
    const db = getDb();
    const { active } = req.query;
    const where = active === '0' ? '' : 'WHERE c.is_active = 1';
    
    const rows = db.prepare(`
        SELECT c.*,
               u.name AS owner_name,
               (SELECT COUNT(*) FROM campaign_members WHERE campaign_id = c.id) AS member_count,
               (SELECT COUNT(*) FROM campaign_members WHERE campaign_id = c.id AND member_status = 'won') AS won_count,
               (SELECT COUNT(*) FROM campaign_members WHERE campaign_id = c.id AND member_status NOT IN ('won','lost')) AS open_count
        FROM outreach_campaigns c
        LEFT JOIN users u ON u.id = c.owner_user_id
        ${where}
        ORDER BY c.is_active DESC, c.created_at DESC
    `).all();
    res.json(rows);
}));

router.get('/:id', handle((req, res) => {
    const db = getDb();
    const c = db.prepare('SELECT * FROM outreach_campaigns WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
}));

router.post('/', handle((req, res) => {
    const { name, description, owner_user_id, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const db = getDb();
    
    // Lukket-kampagne-genåbning: hvis navn findes på lukket kampagne, foreslå genåbning
    const existing = db.prepare('SELECT id, is_active FROM outreach_campaigns WHERE name = ?').get(name);
    if (existing) {
        if (existing.is_active === 1) {
            return res.status(409).json({ error: 'name_in_use', existing_id: existing.id });
        }
        // Lukket kampagne — returnér med flag, UI tilbyder genåbning
        return res.status(409).json({ error: 'name_closed', existing_id: existing.id, reopenable: true });
    }
    
    const r = db.prepare(`
        INSERT INTO outreach_campaigns (name, description, owner_user_id, notes)
        VALUES (?, ?, ?, ?)
    `).run(name, description || null, owner_user_id || req.session.userId, notes || null);
    logChange({
        entity_type: 'outreach_campaign', entity_id: r.lastInsertRowid,
        action: 'create', user_id: req.session.userId,
        new_value: JSON.stringify({ name })
    });
    broadcast('campaign_created', { id: r.lastInsertRowid });
    res.json({ id: r.lastInsertRowid });
}));

// Genåbn en lukket kampagne
router.post('/:id/reopen', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    db.prepare('UPDATE outreach_campaigns SET is_active = 1, closed_at = NULL WHERE id = ?').run(id);
    logChange({
        entity_type: 'outreach_campaign', entity_id: id,
        action: 'reopen', user_id: req.session.userId
    });
    broadcast('campaign_updated', { id });
    res.json({ ok: true });
}));

// PATCH, POST .../close — straightforward, udeladt for kortheds skyld

// ---- Medlemmer ----

router.get('/:id/members', handle((req, res) => {
    const db = getDb();
    const { status } = req.query;
    const filter = status ? 'AND m.member_status = ?' : '';
    const args = [req.params.id];
    if (status) args.push(status);
    
    const rows = db.prepare(`
        SELECT m.*,
               co.name AS company_name, co.cvr, co.ean, co.tags AS company_tags,
               TRIM(cu.first_name || ' ' || COALESCE(cu.last_name, '')) AS contact_person,
               cu.email AS customer_email, cu.phone AS customer_phone,
               meta.marketing_consent, meta.do_not_contact, meta.tags AS customer_tags,
               u.name AS assigned_name
        FROM campaign_members m
        LEFT JOIN companies co ON co.id = m.company_id
        LEFT JOIN customers cu ON cu.id = m.customer_id
        LEFT JOIN crm_customer_meta meta ON meta.customer_id = m.customer_id
        LEFT JOIN users u ON u.id = m.assigned_user_id
        WHERE m.campaign_id = ? ${filter}
        ORDER BY m.added_at DESC
    `).all(...args);
    res.json(rows);
}));

// POST /api/campaigns/:id/members — tilføj én eller flere
// Body: { members: [{ company_id?, customer_id?, assigned_user_id?, notes? }, ...] }
router.post('/:id/members', handle((req, res) => {
    const db = getDb();
    const campaignId = parseInt(req.params.id);
    const members = req.body.members || [];
    if (!members.length) return res.status(400).json({ error: 'no members' });
    
    const added = [];
    const skipped = [];
    
    const stmt = db.prepare(`
        INSERT INTO campaign_members (campaign_id, company_id, customer_id, assigned_user_id, notes, added_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    // Server-side jura-validering
    const consentStmt = db.prepare(`
        SELECT marketing_consent, do_not_contact 
        FROM crm_customer_meta WHERE customer_id = ?
    `);
    
    // node:sqlite har ikke db.transaction() — brug helper fra db/compat.js
    transaction(db, () => {
        for (const m of members) {
            if (!m.company_id && !m.customer_id) {
                skipped.push({ reason: 'no_entity', input: m });
                continue;
            }

            // Tjek consent og DNC
            if (m.customer_id) {
                const meta = consentStmt.get(m.customer_id);
                if (meta) {
                    // Privatkunde uden consent: BLOKERET (§10)
                    if (!m.company_id && meta.marketing_consent === 0) {
                        skipped.push({ reason: 'no_marketing_consent_b2c', input: m });
                        continue;
                    }
                    // DNC: BLOKERET uanset
                    if (meta.do_not_contact === 1) {
                        skipped.push({ reason: 'do_not_contact', input: m });
                        continue;
                    }
                }
            }

            try {
                const r = stmt.run(
                    campaignId,
                    m.company_id || null,
                    m.customer_id || null,
                    m.assigned_user_id || null,
                    m.notes || null,
                    req.session.userId
                );
                added.push(r.lastInsertRowid);
                logChange({
                    entity_type: 'campaign_member', entity_id: r.lastInsertRowid,
                    action: 'create', user_id: req.session.userId,
                    new_value: JSON.stringify({ campaign_id: campaignId, company_id: m.company_id, customer_id: m.customer_id })
                });
            } catch (e) {
                if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    skipped.push({ reason: 'already_member', input: m });
                } else {
                    skipped.push({ reason: 'db_error', input: m, error: e.message });
                }
            }
        }
    });
    
    broadcast('campaign_members_added', { campaign_id: campaignId, count: added.length });
    res.json({ added: added.length, skipped, member_ids: added });
}));

// PATCH /api/campaigns/:campaignId/members/:memberId
router.patch('/:campaignId/members/:memberId', handle((req, res) => {
    const db = getDb();
    const { member_status, lost_reason, assigned_user_id, notes } = req.body;
    
    if (member_status === 'lost' && !lost_reason) {
        return res.status(400).json({ error: 'lost_reason required when member_status=lost' });
    }
    
    const fields = [];
    const args = [];
    if (member_status !== undefined) { fields.push('member_status = ?'); args.push(member_status); }
    if (lost_reason !== undefined)   { fields.push('lost_reason = ?');   args.push(lost_reason); }
    if (assigned_user_id !== undefined) { fields.push('assigned_user_id = ?'); args.push(assigned_user_id); }
    if (notes !== undefined)         { fields.push('notes = ?');         args.push(notes); }
    
    if (!fields.length) return res.status(400).json({ error: 'no fields to update' });
    const memberId = parseInt(req.params.memberId);
    const campaignId = parseInt(req.params.campaignId);

    // Snapshot før-værdier til changelog
    const before = db.prepare('SELECT member_status, assigned_user_id FROM campaign_members WHERE id = ?').get(memberId);
    args.push(memberId);

    db.prepare(`UPDATE campaign_members SET ${fields.join(', ')} WHERE id = ?`).run(...args);

    if (member_status !== undefined && before && before.member_status !== member_status) {
        logChange({
            entity_type: 'campaign_member', entity_id: memberId,
            action: 'status_change', field: 'member_status',
            old_value: before.member_status, new_value: member_status,
            user_id: req.session.userId
        });
    }

    broadcast('campaign_member_updated', {
        campaign_id: campaignId,
        member_id: memberId,
        member_status
    });
    res.json({ ok: true });
}));

router.delete('/:campaignId/members/:memberId', handle((req, res) => {
    const db = getDb();
    const memberId = parseInt(req.params.memberId);
    const campaignId = parseInt(req.params.campaignId);
    db.prepare('DELETE FROM campaign_members WHERE id = ?').run(memberId);
    logChange({
        entity_type: 'campaign_member', entity_id: memberId,
        action: 'delete', user_id: req.session.userId,
        old_value: JSON.stringify({ campaign_id: campaignId })
    });
    broadcast('campaign_member_removed', { campaign_id: campaignId, member_id: memberId });
    res.json({ ok: true });
}));

module.exports = router;
```

### 1.2.5 App-niveau `last_activity_at`-opdatering (v3-rettelse)

Tidligere udkast brugte en SQL-trigger til at opdatere `campaign_members.last_activity_at` ved hver `crm_activities` INSERT. Det er fjernet til fordel for målrettet app-niveau-opdatering — se designnote under migration 084.

I `routes/crm.js`, eksisterende `POST /api/crm/activity`-handler udvides:

```javascript
// routes/crm.js — eksisterende handler udvides
router.post('/activity', handle((req, res) => {
    const db = getDb();
    const { customer_id, type, body, campaign_id, ...rest } = req.body;
    // ... eksisterende INSERT i crm_activities, nu også med campaign_id-felt ...
    const r = db.prepare(`
        INSERT INTO crm_activities (customer_id, type, body, campaign_id, /* ... */)
        VALUES (?, ?, ?, ?, /* ... */)
    `).run(customer_id, type, body, campaign_id || null, /* ... */);

    // Opdater last_activity_at — målrettet:
    // - Hvis campaign_id sat: kun det medlemskab i den kampagne
    // - Ellers: alle medlemmer hvor customer_id matcher (samme adfærd som den fjernede trigger
    //   ville have haft, men nu eksplicit og forudsigelig). For office-typisk skala (kunde
    //   sjældent i >2 åbne kampagner) er det stadig trivielt.
    if (campaign_id) {
        db.prepare(`
            UPDATE campaign_members
            SET last_activity_at = CURRENT_TIMESTAMP
            WHERE campaign_id = ? AND customer_id = ?
        `).run(campaign_id, customer_id);
    } else if (customer_id) {
        db.prepare(`
            UPDATE campaign_members
            SET last_activity_at = CURRENT_TIMESTAMP
            WHERE customer_id = ?
        `).run(customer_id);
    }

    broadcast('crm_activity_created', { customer_id, campaign_id });
    res.json({ id: r.lastInsertRowid });
}));
```

**Konsekvens for medlems-detalje-UI:** når en aktivitet logges fra Kunde 360° uden kampagne-kontekst, opdaterer alle kundens medlemskaber. Det er bevidst — vi ved ikke hvilken kampagne aktiviteten "hører til", så vi rører dem alle. Hvis brugeren logger fra kampagne-medlems-detalje, sender frontend `campaign_id` med, og kun det ene medlemskab opdateres.

Monteres i `server.js`: `app.use('/api/campaigns', require('./routes/campaigns'));`

### 1.3 Consent-UI på Kunde 360°

I `office/views/crm-kunde360.js` tilføjes en lille "Markedsføring & kontakt"-blok i kunde-info-sektionen:

```
┌──────────────────────────────────────────────────────────┐
│ Markedsføring & kontakt                                  │
│  ☐ Tilladelse til markedsføring                          │
│     (Sat af Mette · 14. mar 2026)                        │
│  ☐ Må ikke kontaktes                                     │
│     (ikke sat)                                           │
└──────────────────────────────────────────────────────────┘
```

To checkboxes der opdaterer `crm_customer_meta.marketing_consent` og `do_not_contact`. Hver ændring logges i `changelog`-tabellen (eksisterende tabel) med:

```json
{
  "entity_type": "crm_customer_meta",
  "entity_id": <customer_id>,
  "field": "marketing_consent" | "do_not_contact",
  "old_value": "0" | "1",
  "new_value": "0" | "1",
  "user_id": <session_user>,
  "created_at": <now>
}
```

Endpoint: `PATCH /api/crm/customer/:id/consent` med body `{ marketing_consent?, do_not_contact? }`. Hvis nogen af felterne ændres, fyrer SSE `crm_consent_updated` så åbne views re-renderer.

**UI på Firma 360°** (CLAUDE_KONTAKTER fase 6): viser en sammenfattende liste af kontakter under firmaet med ikoner for hver kontakts consent-status — `✓` for samtykke, `🚫` for DNC, `—` for ingen markering. Per-kontakt-edit sker via klik der åbner Kunde 360°.

### 1.4 SSE-events

| Event | Payload | Hvem reagerer |
|-------|---------|---------------|
| `campaign_created` | `{ id }` | Kampagne-listevisning, "tilføj til kampagne"-dropdown |
| `campaign_updated` | `{ id }` | Kampagne-detalje |
| `campaign_members_added` | `{ campaign_id, count }` | Pipeline-board, kampagne-detalje |
| `campaign_member_updated` | `{ campaign_id, member_id, member_status }` | Pipeline-board (re-render kolonne) |
| `campaign_member_removed` | `{ campaign_id, member_id }` | Pipeline-board |
| `crm_consent_updated` | `{ customer_id }` | Kunde 360°, Firma 360°, kampagne-medlems-kort |

### Test-spec for fase 1

| Test | Forventet |
|------|-----------|
| `POST /api/campaigns` med name | 200, returnerer id, SSE `campaign_created` |
| `POST /api/campaigns` uden name | 400 |
| `POST /api/campaigns` med name der eksisterer aktivt | 409 `name_in_use` |
| `POST /api/campaigns` med name på lukket kampagne | 409 `name_closed`, `reopenable:true` |
| `POST /api/campaigns/:id/reopen` på lukket | 200, is_active=1, closed_at=NULL |
| `POST /api/campaigns/:id/members` med company_id | 200, member oprettet |
| `POST /api/campaigns/:id/members` med kun customer_id (B2C) og `marketing_consent=0` | `skipped: [{reason:'no_marketing_consent_b2c'}]` |
| `POST /api/campaigns/:id/members` med kun customer_id (B2C) og `marketing_consent=1` | 200, member oprettet |
| `POST /api/campaigns/:id/members` med company_id + customer_id, hvor customer har `do_not_contact=1` | `skipped: [{reason:'do_not_contact'}]` |
| `POST /api/campaigns/:id/members` med company_id alene (B2B, ingen kontakt) | 200, ingen consent-tjek |
| `POST /api/campaigns/:id/members` med samme company_id to gange (samme kald) | Første: 200, andet: `skipped: [{reason:'already_member'}]` (partial unique index fanger) |
| `POST /api/campaigns/:id/members` med company_id der allerede er medlem (tidligere kald) | `skipped: [{reason:'already_member'}]` |
| `PATCH .../members/:m` med `member_status='lost'` uden lost_reason | 400 |
| `PATCH .../members/:m` med `member_status='lost'` + lost_reason | 200 |
| `PATCH /api/crm/customer/:id/consent` med `marketing_consent: 1` | 200, changelog-row oprettet, SSE broadcastet |
| `POST /api/crm/activity` med `campaign_id` for kunde der er medlem | `last_activity_at` opdateres KUN på det ene medlemskab; aktiviteten har `campaign_id` sat |
| `POST /api/crm/activity` uden `campaign_id` for kunde i 2 kampagner | `last_activity_at` opdateres på begge medlemskaber; aktiviteten har `campaign_id = NULL` |
| `POST /api/crm/activity` for kunde der IKKE er medlem af nogen kampagne | Ingen `campaign_members` opdateres (UPDATE påvirker 0 rows, harmløst) |
| `POST /api/crm/activity` med ugyldig `campaign_id` (kunde er ikke medlem) | Aktivitet oprettes, men ingen `campaign_members` opdateres — bevidst lenient, ikke fejl |
| `GET /api/campaigns/:id/members?status=lead` | Kun medlemmer i lead-status |
| Member-status-skift via PATCH logger til `changelog` med field='member_status', old/new | Changelog-row findes |
| `DELETE .../members/:m` | 200, SSE broadcastet, række fjernet, changelog-row med action='delete' |

---

## FASE 2 — List-action: "Tilføj valgte til kampagne"

### 2.1 Multi-select i listevisning

`office/views/crm-kunde360.js` (Personer-fane) og `office/views/crm-firma360.js` (Firmaer-fane — fra CLAUDE_KONTAKTER fase 5/6) får:

- Checkbox-kolonne yderst til venstre
- "Vælg alle på siden"-checkbox i header
- Footer-bar når noget er valgt: `"N valgt · [Tilføj til kampagne ▾] [Tilføj tag ▾] [Ryd valg]"`

Genbrug af mønstret fra `office/views/fakturering.js`. State pr. fane (skift fane → ryd valg).

### 2.2 `shared/add_to_campaign_modal.js`

```javascript
// shared/add_to_campaign_modal.js
window.AddToCampaignModal = {
    async open({ companies = [], customers = [], onDone }) {
        // 1. GET /api/campaigns?active=1
        // 2. Modal med:
        //    - Header: "Tilføj N firmaer + M kunder til kampagne"
        //    - Dropdown: aktive kampagner + "+ Opret ny..."
        //    - Hvis ny: name + description-felter
        //    - Tildel-felt: "Tildel til [bruger ▾]" (default: aktuel bruger)
        //    - Forhåndsvisning af skipped:
        //        ⚠ 2 privatkunder uden samtykke springes over
        //        ⚠ 1 kunde med "må ikke kontaktes" springes over
        //        ℹ 1 firma er allerede medlem
        //    - [Annullér] [Tilføj N]
        // 3. Submit:
        //    - Hvis ny kampagne: POST /api/campaigns først
        //    - Hvis name_closed med reopenable: confirm "X findes som lukket — genåben?"
        //      → POST /api/campaigns/:id/reopen, fortsæt
        //    - POST /api/campaigns/:id/members
        //    - Toast: "N tilføjet, M sprunget over"
    }
};
```

Server-side har vi allerede dedup + jura-validering, så modalen behøver ikke gentage logik — den viser bare resultatet pænt.

### Test-spec for fase 2

| Test | Forventet |
|------|-----------|
| Vælg 3 kunder, klik "Tilføj til kampagne" → vælg eksisterende | Modal lukker, toast "3 tilføjet" |
| Vælg 5 kunder hvor 2 er B2C uden consent | Modal viser advarsel før submit, toast "3 tilføjet, 2 sprunget over (mangler samtykke)" |
| Vælg "+ Opret ny" → indtast navn der findes som lukket kampagne | Confirm "Genåben kampagne X?" → klik ja → kampagne genåbnes + medlemmer tilføjes |
| Vælg "+ Opret ny" → indtast navn der findes som aktiv | 409, fejlmeddelelse "Navnet er i brug" |
| Skift fane mens valg er aktivt | Valg ryddes |

---

## FASE 3 — Paste-import

### 3.1 Paste-UI

`office/views/campaign-import.js` — view tilgængelig fra kampagne-detalje:

- `<textarea>` til paste fra Excel (tab-separeret)
- Auto-detect header-række
- Kolonne-mapping pr. kolonne: Ignorer / Firmanavn / CVR / EAN / Kontaktperson / E-mail / Telefon / Adresse / By / Postnr / Noter
- Mapping gemmes i `localStorage.bon_v2_campaign_import_mapping_v1`

### 3.2 `POST /api/campaigns/:id/import-preview`

Body: `{ rows: [ {firmanavn, cvr, email, ...}, ... ] }`

For hver række kalder server `companyMatcher.matchCompany()` fra `services/companyMatcher.js` (etableret i Fase 0). Returnerer:

```json
{
  "row_index": 0,
  "match_type": "cvr_exact" | "ean_exact" | "email_match" | "name_fuzzy" | null,
  "match_company_id": 123 | null,
  "match_confidence": 1.0 | 0.85 | 0.0,
  "match_company_name": "Magasin A/S" | null,
  "suggested_action": "use_existing" | "create_new" | "review"
}
```

- confidence ≥ 0.95 → `use_existing`
- confidence 0.85–0.95 → `review`
- Ingen match → `create_new`

### 3.3 Bekræft-trin

Tabel med pr. række:

| Række | Excel-data | Match | Action | ▾ |
|-------|-----------|-------|--------|---|
| 1 | Magasin A/S, CVR 12345678 | ✓ Magasin A/S (cvr_exact) | Brug eksisterende | ✓ |
| 2 | Kantine Glostrup | ⚠ Glostrup Kantine (fuzzy 0.87) | Brug eksisterende / Opret ny | dropdown |
| 3 | Ny Café ApS | — | Opret ny | ✓ |

Bulk-actions: "Brug alle high-confidence matches" / "Opret alle som nye". Final commit til `POST /api/campaigns/:id/import-commit` med pr-række beslutninger. Server kører i én transaktion: opret nye `companies`, tilføj alle som `campaign_members`.

Jura-validering kører her også — privatkunde-rækker uden `marketing_consent=1` afvises ved commit-tid (men kan ikke ske via paste-flow normalt, da paste tilføjer firmaer, ikke privatkunder).

### Test-spec for fase 3

| Test | Forventet |
|------|-----------|
| Paste 50 rækker fra Excel m. header | Header auto-detected, kolonner pre-mappet |
| Række med CVR der matcher | confidence 1.0, action `use_existing` |
| Række med navn fuzzy 0.87 til eksisterende | action `review`, kræver manuel bekræft |
| Række med ny CVR ikke i basen | action `create_new` |
| Commit 200 rækker | Transaktion: alle nye companies oprettet, alle medlemmer tilføjet, dubletter springes over |
| Commit fejler midt i | Rollback, ingen halve imports |

---

## FASE 4 — Pipeline-board med campaign-selector

### 4.1 Endpoint-udvidelse

`GET /api/crm/pipeline?campaign_id=X`:

- Med `campaign_id`: returnerer kampagnens medlemmer grupperet pr. `member_status`
- Uden: returnerer alle medlemmer på tværs af aktive kampagner

Output-format er pr. medlem (ikke pr. kunde): `{ member_id, campaign_id, campaign_name, company_id, customer_id, ... }`. Det betyder at samme kunde optræder som flere kort hvis i flere kampagner — bevidst valg, så det er visuelt klart hvor mange åbne fronter der er.

### 4.2 UI

```
┌─────────────────────────────────────────────────────────┐
│  Pipeline:  [Alle aktive kampagner    ▾]    [+ Ny]     │
├──────────┬──────────────┬───────────────┬───────────────┤
│   Lead   │ Tilbud sendt │  Forhandling  │    Vundet     │
│   (12)   │     (5)      │      (3)      │      (8)      │
├──────────┼──────────────┼───────────────┼───────────────┤
│ [card]   │   [card]     │    [card]     │    [card]     │
│ [card]   │   [card]     │    [card]     │                │
└──────────┴──────────────┴───────────────┴───────────────┘
                                              
[ Tabte (5) ▸ ]  ← collapsible sektion under boardet
```

I global-visning får hvert kort en lille kampagne-label øverst (`"Forår 2026 — Kantiner"`) så det er klart hvilken kampagne kortet hører til.

I kampagne-specifik visning: ingen label nødvendig.

**Tre kort-tilstande** (v3-tilføjelse) — UI skal håndtere alle pænt:

| Tilstand | `company_id` | `customer_id` | Visning |
|----------|--------------|---------------|---------|
| Firma alene (B2B uden specifik kontakt) | sat | NULL | Firmanavn fed, by/branche som undertekst, ikon 🏢 |
| Firma + kontakt (B2B med kontaktperson) | sat | sat | Firmanavn fed, kontaktperson som undertekst (`Anne — Magasin A/S`), ikon 👤 |
| Privatkunde (B2C) | NULL | sat | Kundenavn fed, "Privatkunde" som undertekst, ikon 👤 |

Klik på kort åbner Kunde 360° (hvis `customer_id` sat) eller Firma 360° (hvis kun `company_id`).

### 4.3 Drag-drop med multi-kampagne-håndtering

Når et kort dragges:

**Tilfælde 1: Kortet har et entydigt `member_id`** (kampagne-specifik visning, eller kunde i kun én åben kampagne)
→ `PATCH /api/campaigns/:c/members/:m` med `member_status` direkte

**Tilfælde 2: Global visning, kortet repræsenterer kunde i flere åbne kampagner**
→ Inden drag aktiveres viser kortet et badge: `⚠ 2 kamp.`
→ Drop åbner modal:
  ```
  ┌────────────────────────────────────────────┐
  │  I hvilken kampagne flytter du            │
  │  "Magasin A/S" til "Tilbud sendt"?        │
  │                                            │
  │  ○ Forår 2026 — Kantiner                  │
  │  ○ Reaktivering — sovende kunder          │
  │                                            │
  │  [Annullér]              [Bekræft]        │
  └────────────────────────────────────────────┘
  ```
→ Submit kalder den valgte kampagnes member endpoint

**Tilfælde 3: Drop på "Tabt"-kolonne**
→ Modal: "Hvorfor tabt?" med `lost_reason` påkrævet (fri tekst eller kvik-valg: "Pris", "Timing", "Ikke budget", "Bruger anden leverandør", "Andet")
→ Kortet flyttes til collapsible lost-sektion under boardet

### 4.4 "Konvertér til bon" — knap på won-medlemmer (v3-tilføjelse)

Når et medlem rykkes til **Vundet**, vises en grøn "Konvertér til bon →"-knap nederst på kortet samt i medlems-detalje-panelet.

Klik åbner **eksisterende `bon_opret_modal.js`** (fra Fase 1c) med pre-fyldte felter:

- `customer_id` → fra medlemmet
- `company_id` → fra medlemmet (hvis sat)
- Default `delivery_date` = i dag + 7 dage (kan ændres)
- Andre felter (pax, tid, priskategori) udfyldes manuelt af brugeren

Når bonen er oprettet:
- `crm_activities`-row logges med `type='note'`, `body='Bon #N oprettet fra kampagne X'`, `campaign_id` sat
- Knappen på medlems-kortet ændres til `→ Se bon #N` (henviser til den oprettede bon, åbner BonDrawer)
- Medlemmet forbliver i `won`-status — ingen yderligere automatik

**Bevidst manuelt:** "Vundet" betyder ikke nødvendigvis at en konkret ordre er klar. Det kan også betyde "kunden vil gerne — vi vender tilbage med dato". Brugeren beslutter selv hvornår knappen klikkes.

**Edge case:** hvis medlemmet ikke har `customer_id` (B2B uden kontakt), åbner modalen først kunde-vælger ("Hvem skal være kunde-kontakt på denne bon?") med søgning blandt firmaets eksisterende kunder, eller "+ Opret ny kunde under firmaet".

### Test-spec for fase 4

| Test | Forventet |
|------|-----------|
| Åbn pipeline uden valgt kampagne | Alle aktive medlemmer på tværs af kampagner, hver med kampagne-label |
| Vælg kampagne A i dropdown | Board re-renderer kun A, URL får `?campaign_id=A`, kort uden label |
| Drag kort fra Lead → Tilbud sendt (én kampagne) | `member_status='quote_sent'`, SSE broadcastet |
| Drag kort i global-visning hvor kunden er i 2 åbne kampagner | Modal åbner med radio-valg |
| Drop på Tabt | Lost-reason-modal, ingen flytning før reason er udfyldt |
| Drop på Vundet | `member_status='won'`, kortet får grøn "Konvertér til bon"-knap |
| Klik "Konvertér til bon" på won-medlem med customer_id | `bon_opret_modal.js` åbner pre-fyldt med customer+company |
| Klik "Konvertér til bon" på won-medlem uden customer_id (B2B alene) | Kunde-vælger åbner først (firmaets kunder + "Opret ny") |
| Efter bon oprettet | `crm_activities` med campaign_id sat + body henviser til bon-nummer; knap ændres til "→ Se bon #N" |
| Kort viser firma alene | Ikon 🏢, "Firmanavn" fed, by/branche undertekst |
| Kort viser firma + kontakt | Ikon 👤, "Firmanavn" fed, "Kontaktperson — Firmanavn" undertekst |
| Kort viser privatkunde | Ikon 👤, kundenavn fed, "Privatkunde" undertekst |
| Two users redigerer samtidigt | SSE re-render, last-write-wins (bevidst) |

---

## FASE 5 — Smart-forslag: reaktiveringskampagne fra sovende

V1 dækker kun "sovende kunder → kampagne". Lost-reason-cron og krydssalg-segmentering udskydes — de bygges først når der er data fra reelle kampagner at validere mod.

### 5.1 Endpoint: `POST /api/campaigns/from-suggestion`

```json
{
  "type": "dormant",
  "filter": {
    "days_since_last": 180,
    "min_total_revenue": 5000
  },
  "campaign_name": "Reaktivering — sovende Q3",
  "owner_user_id": 1,
  "assigned_user_id": 1
}
```

Server:
1. Opretter kampagnen (samme regler som POST /api/campaigns, inkl. lukket-genåbning)
2. Henter kandidater via samme query som `/api/crm/dormant`
3. Filtrerer iflg. samme jura-regler som POST /members
4. Indsætter dem som `campaign_members` med `member_status='lead'`, `source` impliceret reaktivering
5. Returnerer `{ campaign_id, member_count, skipped }`

### 5.2 UI: "Reaktivér sovende"-knap

På CRM-dashboard's eksisterende "Smart forslag"-panel tilføjes én knap: 🔄 **Reaktivér sovende**

Klik åbner modal: dage siden ordre, min. omsætning, kampagne-navn, tildel-til-bruger → opret. Toast viser "N tilføjet, M sprunget over".

### 5.3 Dashboard-forslag-cache

`GET /api/crm/suggestions` re-fetcher aggressivt fra dashboardet (efter SSE-events, view-skift, polling). Reaktiverings-kandidat-tællingen (fx "47 sovende kunder klar til reaktivering") cache'es i serveren med 5 minutters TTL:

```javascript
// I routes/crm.js, helper:
let dormantCountCache = { value: null, expires: 0 };
function getDormantCount(db) {
    if (Date.now() < dormantCountCache.expires) return dormantCountCache.value;
    const r = db.prepare(`
        SELECT COUNT(*) AS c FROM customers cu
        JOIN crm_customer_meta meta ON meta.customer_id = cu.id
        WHERE meta.stage = 'dormant' AND meta.do_not_contact = 0
    `).get();
    dormantCountCache = { value: r.c, expires: Date.now() + 5 * 60 * 1000 };
    return r.c;
}
```

Aktivt forarbejde indvilger UI-ydelse på dashboardet uden at koste mere end 5-minutters forsinkelse på et tal der alligevel ikke ændrer sig markant pr. minut.

### Test-spec for fase 5

| Test | Forventet |
|------|-----------|
| Klik "Reaktivér sovende" → 180 dage → opret | Kampagne oprettet med N medlemmer fra sovende-listen |
| Reaktivering filtrerer DNC + manglende consent | Antal i resultat < antal i `/dormant` hvis nogle har DNC eller B2C-uden-consent |
| Dashboard viser 47 sovende → opret kampagne → re-fetch | Tallet kan stadig være 47 i op til 5 min (cached); skifter efter cache-expiry |

---

## FASE 6 — Mass-email til kampagne-medlemmer

> **Status: ikke i denne spec.** Får sit eget dokument `docs/CLAUDE_OUTREACH_MAIL.md` inden kode skrives. Cherry-pick + pipeline (Fase 0-5) er fuldt brugbar uden mass-mail — manuelle 1-til-1 mails sendes via eksisterende CRM Kunde 360° mail-compose.

### Forretningsmål (placeholder — udfoldes i CLAUDE_OUTREACH_MAIL.md)

Når Fase 0-5 har kørt et stykke tid, og vi har data fra rigtige kampagner, bygges mass-mail som lukket-loop ovenpå:

- Mail-skabelon med kampagne-variabler (`{{firmanavn}}`, `{{kontaktperson}}`, `{{kampagne_navn}}`, `{{afsender_navn}}`, `{{personlig_pitch}}`, `{{unsubscribe_url}}`)
- `POST /api/campaigns/:id/send-mail` med throttle-spredning
- Ny `campaign_mail_queue`-tabel + cron-sender
- Bounce-håndtering via IMAP-polling + nyt `#C{cid}-{mid}`-tag-format
- Unsubscribe-token-mekanik (juridisk EU-krav — påkrævet i hver markedsføringsmail)
- Preview-flow ("vis 3 rendrede mails inden send")

### Hvorfor separat spec

Disse fire mekanikker er nye oven på eksisterende mail-stak:

1. Queue-tabel + cron-sender er ny infrastruktur
2. `#C{cid}-{mid}` er nyt tag-format ved siden af `#B{n}`, `#K{n}`, `#PO{n}`, `#S{n}`
3. Unsubscribe-token er ny mekanik der skal være sikker (juridisk konsekvens hvis brudt)
4. Bounce-parsing er nyt felt — vi har aldrig håndteret det i v2 endnu

Estimat: 3-4 dages fokuseret arbejde alene, ikke 5-7 timer som tidligere udkast antydede. Spec'en skal også afklare:

- **Sender-domæne:** sendes via `kontakt@` (eksisterende) eller dedikeret `markedsforing@` med separat SPF/DKIM? Markedsføringsmail med højere bounce-rate kan skade `kontakt@`'s leveringsdygtighed.
- **Reply-håndtering:** auto-bump fra `lead` → `contacted` ved svar, eller manuel? (Out-of-office-svar er en kendt fælde.)
- **Throttle-default:** Ristet Rugs IP-omdømme er ukendt — start konservativt (6/min, spredt over 4 timer) og juster.
- **Unsubscribe-flow:** statisk side eller integreret i v2? Token-TTL? GDPR-konsekvens hvis nogen unsubscriber for en kunde der er aktiv i flere kampagner?

Når disse er afklaret skrives `CLAUDE_OUTREACH_MAIL.md` og bygges som Fase 6.

---

## Kendte begrænsninger

1. **Aktivitet uden `campaign_id` opdaterer alle medlemskaber.** Når en aktivitet logges fra Kunde 360° uden kampagne-kontekst, opdaterer `routes/crm.js` POST /activity-handleren `last_activity_at` på alle kundens medlemskaber (samme adfærd som den fjernede trigger). Når der logges fra kampagne-medlems-detalje, sender frontend `campaign_id` med, og kun det relevante medlemskab opdateres. Det betyder at "denne kampagnes aktivitetsfrekvens" er præcis hvis brugerne logger fra medlems-detalje, mindre præcis hvis fra Kunde 360°. Aktivitets-tællingen via `crm_activities.campaign_id` ER præcis i begge tilfælde.

2. **Privatkunder kan ikke tilføjes via paste-import** — paste-flow opretter `companies`, ikke `customers`. Manuel privatkunde-tilføjelse sker via Kunde 360°'s eksisterende "+ Ny kunde"-flow + derefter "Tilføj til kampagne". Dette er bevidst — privatkunde-leads er sjældne for Ristet Rug og kræver manuelt consent-tjek alligevel.

3. **Last-write-wins ved samtidig editering.** To brugere der dragger samme kort til forskellige kolonner: sidste vinder, ingen lås. Edge-case, men nævnes så folk ved det.

4. **Mass-email er ikke i denne spec** — får sit eget dokument før kode skrives. 1-til-1 mails fra CRM Kunde 360° fungerer som hidtil.

---

## Datamodel-tilføjelser (til opdatering af bon_v2_datamodel_v2.md)

Når datamodel-dokumentet opdateres næste gang, skal følgende ind:

### Nye tabeller

**`outreach_campaigns`** — overordnede outreach-kampagner
- `name` UNIQUE
- `owner_user_id` FK → users
- `is_active` (1=aktiv, 0=lukket), `closed_at` sat når lukket

**`campaign_members`** — medlemmer af en kampagne
- M:N mellem campaigns og (companies ∪ customers)
- Polymorf via `company_id`+`customer_id` nullable FK'er, CHECK at mindst én er sat
- `member_status` ∈ `{lead, quote_sent, negotiating, won, lost}`
- `lost_reason` (TEXT, kun udfyldt når status=lost)
- `assigned_user_id` FK → users
- `last_activity_at` opdateres på app-niveau fra `routes/crm.js` POST /activity-handler (ikke via trigger — v3-rettelse, se sektion 1.2.5)
- **Tre partial unique indexes** håndhæver dedup
- ON DELETE CASCADE fra campaign

**`campaign_mail_queue`** (Fase 6 — får sin egen spec, ikke i denne) — pending mail-sends pr. medlem

### Ændrede tabeller

**`companies`** — ny kolonne `tags TEXT` (JSON-array)

**`crm_activities`** — ny kolonne `campaign_id INTEGER` (nullable FK → outreach_campaigns) + partial index på ikke-NULL værdier

### Nye triggers

Ingen. `campaign_members.last_activity_at` opdateres på app-niveau i `routes/crm.js` POST /activity-handler — se sektion 1.2.5.

### SSE-events tilføjet

`campaign_created`, `campaign_updated`, `campaign_members_added`, `campaign_member_updated`, `campaign_member_removed`, `crm_consent_updated`

---

## Åbne spørgsmål

1. **"Snooze"-medlemmer**: skal `parked`-status tilføjes til CHECK-listen så medlemmer kan ligges på pause uden at være tabt? Ikke i v1 — tilføjes hvis behov opstår.

2. **`scripts/dump-schema.js`** — auto-genereret datamodel-fil så `bon_v2_datamodel_v2.md` ikke drifter igen. Skal med på `BON_V2_HUSKELISTE.md` som quick win, separat fra dette spec.

3. **Mass-email-spec** (`CLAUDE_OUTREACH_MAIL.md`) — skrives når der er data fra Fase 0-5 i drift. Se Fase 6 ovenfor for de fire afklaringer der skal med.

> Tidligere åbent spørgsmål om "Vundet → bon-oprettelse" er afklaret i v3: manuel knap "Konvertér til bon" på won-medlemmer, åbner eksisterende `bon_opret_modal.js`. Se Fase 4.4.

---

*Spec v3 oprettet maj 2026 efter review-runde. v1-v2 hævdede fejlagtigt at `shared/indkob_settings.js`-matcheren delte logik med `enrich-cvr.js` — den matcher PRODUKTER, ikke firmaer, og røres ikke. Andre v3-rettelser: `crm_activities.campaign_id` tilføjet (præcis kampagne-rapportering), `last_activity_at`-trigger erstattet med app-niveau-handler (skalering), "Konvertér til bon"-knap på won-medlemmer er nu del af Fase 4 scope, Fase 6 mass-email udskudt til separat spec. 6 faser (0-5) deploybare separat. Estimat: 4-5 dages fokuseret arbejde, anbefalet rækkefølge 0 → 1 → 2 → 4 → 3 → 5.*
