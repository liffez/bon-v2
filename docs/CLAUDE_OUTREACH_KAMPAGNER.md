# CLAUDE_OUTREACH_KAMPAGNER.md
> Spec for outreach-kampagner: cherry-picke leads fra eksisterende kunder/firmaer,
> manuel tilføjelse + paste-import, pipeline-board pr. kampagne, mass-email.
> Læs `docs/BON_V2_PRINCIPPER.md`, `docs/bon_v2_datamodel_v2.md` (forældet — se faktiske
> migrationer i `db/migrations/`), `docs/CLAUDE_KONTAKTER.md`, og eksisterende
> `office/views/crm-dashboard.js` + `routes/crm.js`
> FØR du starter.
> Oprettet: maj 2026 (v2 — efter kode-validering)

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
> - **`crm_activities.campaign_id` udelades bevidst** — aktiviteter knyttes til kunden, ikke til medlemskabet. Kendt begrænsning: "hvor mange touch points i kampagne X?" kan ikke besvares når en kunde er i flere kampagner samtidig. Hvis det rejser sig, kræver det historisk backfill — løses i v2.
> - **`bon_v2_datamodel_v2.md` er 60+ migrationer bagud.** Denne spec tilføjer en sektion til sidst med "datamodel-tilføjelser" der kan klippes ind når dokumentet bliver opdateret. Princip 3-overtrædelsen i selve dokumentet er en separat oprydningsopgave (forslag: `scripts/dump-schema.js` i `BON_V2_HUSKELISTE.md`).

---

## Faser

| # | Fase | Risiko | Afhænger af |
|---|------|--------|-------------|
| 0 | Pre-step: udtræk `services/companyMatcher.js` fra `shared/indkob_settings.js` + `scripts/enrich-cvr.js` (mini-PR, lav risiko) | Lav | — |
| 1 | DB foundation: tabeller + partial unique indexes + `companies.tags` + CRUD-API + consent-UI på Kunde 360° | Lav | — |
| 2 | List-action: "Tilføj valgte til kampagne" i Kunde- og Firma-lister | Lav | 1 |
| 3 | Paste-import: tabular paste → fuzzy-match → bekræft → opret | Mellem | 0, 1 |
| 4 | Pipeline-board med campaign-selector + multi-kampagne drag-drop-modal | Lav | 1 |
| 5 | Smart-forslag: generér kampagne fra sovende kunder (lost-reason-cron udskudt) | Lav | 1, 4 |
| 6 | Mass-email til kampagne-medlemmer | Mellem | 1, 4 |

Hver fase er independent deploybar og testbar. Fase 2 og 3 kan udvikles parallelt efter Fase 0+1 er deployet.

---

## FASE 0 — Udtræk `companyMatcher.js`

Eksisterende fuzzy-matching mod `companies` ligger inline to steder:

- `shared/indkob_settings.js` — brugt til at koble Hørkram-leverandører
- `scripts/enrich-cvr.js` — brugt til at parre Virk ES-resultater med firmaer

Begge har samme kerne-logik (dice-bigram + dansk-suffix-normalisering med `I/S`, `A/S`, `ApS`). Den skal udtrækkes så Fase 3 (paste-import) kan genbruge den uden duplikation.

### 0.1 Ny fil: `services/companyMatcher.js`

```javascript
// services/companyMatcher.js
// Fuzzy-match mod companies-tabellen — bruges af:
//   - shared/indkob_settings.js (leverandør-kobling)
//   - scripts/enrich-cvr.js (Virk ES-berigelse)
//   - routes/campaigns.js (paste-import)

/**
 * Normalisér firmanavn for sammenligning.
 * Fjerner suffix (I/S, A/S, ApS, ...) og lowercaser.
 */
function normalizeName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/\b(a\/s|aps|i\/s|k\/s|p\/s|smba|amba)\b/g, '')
        .replace(/[.,]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Dice coefficient på bigrams (2-grams) af to strings.
 * Returns 0.0-1.0
 */
function diceCoefficient(a, b) {
    const aN = normalizeName(a);
    const bN = normalizeName(b);
    if (aN === bN) return 1.0;
    if (aN.length < 2 || bN.length < 2) return 0;
    
    const bigrams = (s) => {
        const out = new Map();
        for (let i = 0; i < s.length - 1; i++) {
            const bg = s.slice(i, i + 2);
            out.set(bg, (out.get(bg) || 0) + 1);
        }
        return out;
    };
    const ag = bigrams(aN);
    const bg = bigrams(bN);
    let inter = 0, total = 0;
    for (const [k, v] of ag) {
        total += v;
        if (bg.has(k)) inter += Math.min(v, bg.get(k));
    }
    for (const v of bg.values()) total += v;
    return (2 * inter) / total;
}

/**
 * Match input mod companies-tabellen.
 * Returnerer { match_type, company_id, confidence, company_name }
 *
 * Priority:
 *   1. CVR exact   → confidence 1.0, match_type 'cvr_exact'
 *   2. EAN exact   → confidence 1.0, match_type 'ean_exact'
 *   3. Email mod contact_points → confidence 0.95, match_type 'email_match'
 *   4. Navn fuzzy (dice ≥ 0.85) → confidence = dice, match_type 'name_fuzzy'
 *   5. Ingen → null
 */
function matchCompany(db, { name, cvr, ean, email, city }) {
    // 1. CVR
    if (cvr) {
        const r = db.prepare('SELECT id, name FROM companies WHERE cvr = ? AND is_internal = 0').get(cvr);
        if (r) return { match_type: 'cvr_exact', company_id: r.id, confidence: 1.0, company_name: r.name };
    }
    // 2. EAN
    if (ean) {
        const r = db.prepare('SELECT id, name FROM companies WHERE ean = ? AND is_internal = 0').get(ean);
        if (r) return { match_type: 'ean_exact', company_id: r.id, confidence: 1.0, company_name: r.name };
    }
    // 3. Email mod contact_points
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
    // 4. Navn fuzzy
    if (name) {
        const candidates = db.prepare(`
            SELECT id, name, city FROM companies WHERE is_internal = 0
        `).all();
        let best = null;
        for (const c of candidates) {
            const d = diceCoefficient(name, c.name);
            if (d >= 0.85 && (!city || !c.city || c.city.toLowerCase() === city.toLowerCase())) {
                if (!best || d > best.confidence) {
                    best = { match_type: 'name_fuzzy', company_id: c.id, confidence: d, company_name: c.name };
                }
            }
        }
        if (best) return best;
    }
    return null;
}

module.exports = { normalizeName, diceCoefficient, matchCompany };
```

### 0.2 Refactor — fjern inline-kode

`shared/indkob_settings.js` og `scripts/enrich-cvr.js` opdateres til at `require('../services/companyMatcher')`. Eksisterende test-coverage skal stadig passere. Hvis der ikke er tests på matching nu, tilføj `tests/companyMatcher.test.js` med:

| Test | Forventet |
|------|-----------|
| `matchCompany({name:'Magasin A/S', cvr:'12345678'})` med matchende cvr | `cvr_exact`, confidence 1.0 |
| `matchCompany({name:'Magasin'})` mod eksisterende "Magasin A/S" | `name_fuzzy`, confidence > 0.85 |
| `matchCompany({name:'Bagerens hus'})` mod eksisterende "Bagerhuset" | confidence < 0.85, returnerer null |
| Suffix-normalisering: "Mag I/S" og "Mag A/S" matcher hvis kernen er samme | dice høj |

**Risiko:** lav. Pure refactor med adfærdsbevarelse. Mini-PR.

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
-- Trigger: opdater last_activity_at når der logges en crm_activity
-- WHERE EXISTS sikrer at vi ikke skriver på alle activities, kun
-- dem hvor kunden faktisk er medlem af mindst én kampagne
-- ==========================================

CREATE TRIGGER trg_cm_activity_touch
AFTER INSERT ON crm_activities
WHEN EXISTS (SELECT 1 FROM campaign_members WHERE customer_id = NEW.customer_id)
BEGIN
    UPDATE campaign_members
    SET last_activity_at = NEW.created_at
    WHERE customer_id = NEW.customer_id;
END;
```

**Designnoter:**

- **Partial unique indexes** giver server-garanti uden at duplikere logik i hver INSERT-handler. Forsøg på at indsætte en dublet returnerer `SQLITE_CONSTRAINT_UNIQUE` som server-laget oversætter til 409 Conflict.
- **`ON DELETE CASCADE`** på campaign-FK: når en kampagne slettes, ryger medlemmer med. Kampagner *lukkes* normalt (`is_active=0`), ikke slettes — men cascade'en er der hvis nogen virkelig vil rydde op.
- **Trigger med `WHERE EXISTS`**: på små databaser er det trivielt, men det skalerer pænt så længe kunde-base ikke vokser med en faktor 10x. Hvis det viser sig at være en flaskehals, kan triggeren erstattes med app-niveau-opdatering i `routes/crm.js` POST /activity-handler.

### 1.2 `routes/campaigns.js` — endpoints

```javascript
// routes/campaigns.js
const express = require('express');
const router = express.Router();
const { getDb, handle } = require('../db/helpers');
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
    broadcast('campaign_created', { id: r.lastInsertRowid });
    res.json({ id: r.lastInsertRowid });
}));

// Genåbn en lukket kampagne
router.post('/:id/reopen', handle((req, res) => {
    const db = getDb();
    db.prepare('UPDATE outreach_campaigns SET is_active = 1, closed_at = NULL WHERE id = ?').run(req.params.id);
    broadcast('campaign_updated', { id: parseInt(req.params.id) });
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
               cu.contact_person, cu.email AS customer_email, cu.phone AS customer_phone,
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
    
    const tx = db.transaction(() => {
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
            } catch (e) {
                if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                    skipped.push({ reason: 'already_member', input: m });
                } else {
                    skipped.push({ reason: 'db_error', input: m, error: e.message });
                }
            }
        }
    });
    tx();
    
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
    args.push(req.params.memberId);
    
    db.prepare(`UPDATE campaign_members SET ${fields.join(', ')} WHERE id = ?`).run(...args);
    
    broadcast('campaign_member_updated', { 
        campaign_id: parseInt(req.params.campaignId), 
        member_id: parseInt(req.params.memberId),
        member_status 
    });
    res.json({ ok: true });
}));

router.delete('/:campaignId/members/:memberId', handle((req, res) => {
    const db = getDb();
    db.prepare('DELETE FROM campaign_members WHERE id = ?').run(req.params.memberId);
    broadcast('campaign_member_removed', {
        campaign_id: parseInt(req.params.campaignId),
        member_id: parseInt(req.params.memberId)
    });
    res.json({ ok: true });
}));

module.exports = router;
```

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
| Indsæt `crm_activities`-row for kunde der ER medlem | `last_activity_at` opdateres på medlemmet (trigger) |
| Indsæt `crm_activities`-row for kunde der IKKE er medlem | Ingen `campaign_members` opdateres (trigger filtrerer via WHERE EXISTS) |
| `GET /api/campaigns/:id/members?status=lead` | Kun medlemmer i lead-status |
| `DELETE .../members/:m` | 200, SSE broadcastet, række fjernet |

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

### Test-spec for fase 4

| Test | Forventet |
|------|-----------|
| Åbn pipeline uden valgt kampagne | Alle aktive medlemmer på tværs af kampagner, hver med kampagne-label |
| Vælg kampagne A i dropdown | Board re-renderer kun A, URL får `?campaign_id=A`, kort uden label |
| Drag kort fra Lead → Tilbud sendt (én kampagne) | `member_status='quote_sent'`, SSE broadcastet |
| Drag kort i global-visning hvor kunden er i 2 åbne kampagner | Modal åbner med radio-valg |
| Drop på Tabt | Lost-reason-modal, ingen flytning før reason er udfyldt |
| Drop på Vundet | `member_status='won'`. Ingen automatisk bon-oprettelse (åbent spørgsmål — manuel knap i medlems-detalje, ikke trigger) |
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

Cherry-pick + pipeline uden en outreach-action er halvbygget. Fase 6 lukker hullet.

### 6.1 Mail-skabelon med kampagne-variabler

Tilføj ny `mail_templates`-row: `campaign_outreach` med variabler:

| Variabel | Kilde |
|----------|-------|
| `{{firmanavn}}` | `companies.name` |
| `{{kontaktperson}}` | `customers.contact_person` (eller "team" hvis ingen) |
| `{{kampagne_navn}}` | `outreach_campaigns.name` |
| `{{afsender_navn}}` | `users.name` for `assigned_user_id` |
| `{{personlig_pitch}}` | Fri tekst pr. medlem (på kampagne-niveau eller pr. medlem) |
| `{{unsubscribe_url}}` | Genereret per-modtager-token til `/unsubscribe/:token` |

Genbrug eksisterende `mail_templates`-editor på Settings → Mail. Skabelon-typen `campaign_outreach` registreres i `routes/mail.js` så variabel-chips er klikbare i editoren.

### 6.2 Send-flow: `POST /api/campaigns/:id/send-mail`

Body:
```json
{
  "template_key": "campaign_outreach",
  "recipient_filter": { "member_status": ["lead"] },
  "subject_override": null,
  "personal_pitches": { "<member_id>": "Tekst pr. modtager...", ... },
  "throttle": { "per_minute": 6, "spread_hours": 4 }
}
```

Server:
1. Validerer at template findes og er aktiv
2. Henter modtagere via members + LEFT JOIN på meta — filtrerer:
   - `marketing_consent=0` for ren B2C → undlad (selvom de er medlemmer, ekstra safeguard)
   - `do_not_contact=1` → undlad
   - Manglende `customer_email` og fallback `contact_points`-email → marker som "ingen email" og undlad
3. Køer mails i ny `campaign_mail_queue`-tabel med `scheduled_at` spredt over throttle-vinduet
4. Cron-job (`scripts/campaign-mail-sender.js`) tager køen og sender via `kontakt@`-transport
5. Efter send: opdater `member_status` fra `lead` → `contacted` (eller hold uændret hvis allerede længere fremme)
6. Log i `crm_activities` med `type='email_out'`, koblet til kunden (eksisterende activity-mønster)

### 6.3 Bounce + reply-håndtering

Eksisterende IMAP-polling (`pollMailbox`) router mails via `#K{num}`-tags. Tilføj nyt tag-format: `#C{campaign_id}-{member_id}` på `Reply-To` eller i body-footer. Når svar kommer tilbage:
- Match til `campaign_members` → opdater `last_activity_at`
- Log som `crm_activity` `type='email_in'`
- Auto-status-update: hvis member er i `lead`, bumper til `contacted`? Eller bevidst manuel? **Åbent spørgsmål — foreslår manuel, så vi ikke fejlfortolker out-of-office-svar**

Bounces (delivery-failure) parses via bounce-headers og logges som `crm_activity` `type='note'` med "Email bounced: <reason>". Member-status uændret men flag på medlemmet ("⚠ email bounced") så office kan vurdere.

### 6.4 Preview-flow

Inden submit: knap "Forhåndsvis 3 modtagere" → server returnerer 3 rendrede mails (subject + body) med variabler erstattet. Office tjekker at intet ser galt ud (manglende navne, kontaktpersoner der er ikke-eksisterende), kan rette template/pitches, og sender derefter.

### Test-spec for fase 6

| Test | Forventet |
|------|-----------|
| `POST /api/campaigns/:id/send-mail` med template_key | 200, kø oprettet med N entries, throttle anvendt |
| Forhåndsvisning af 3 modtagere | 3 rendrede mails returneret, ingen send |
| Kandidat med DNC | Springes over, indgår i "skipped"-rapport |
| B2C-modtager uden consent | Springes over (ekstra safeguard ud over Fase 1) |
| Kandidat uden email | Springes over |
| Send → cron tager kø → mail sendt | `crm_activities` row oprettet, `member_status` ændret hvis var lead |
| Modtager svarer på mail | IMAP fanger via `#C{id}-{mid}`-tag, `last_activity_at` opdateres, ny activity logget |
| Mail bouncer | Bounce parses, `crm_activity` med note, badge på medlem |
| Unsubscribe-link klikkes | `do_not_contact=1` sættes, member behandles ikke i fremtidige sends |

---

## Kendte begrænsninger

1. **`crm_activities.campaign_id` udeladt.** Aktiviteter knyttes til kunden, ikke til medlemskabet. Konsekvens: "hvor mange touch points i kampagne X?" kan ikke besvares præcist når en kunde er i flere kampagner samtidig. Hvis dette rejser sig som vigtigt for kampagne-rapportering, kræver det historisk backfill (kompliceret, ikke gratis).

2. **Aktivitet på medlems-niveau aggregerer på kunde-niveau.** Når en kunde er i to kampagner og du logger en aktivitet, vises den i begge kampagners medlems-detalje. `last_activity_at` opdateres på alle kunders medlemskaber via trigger — det er bevidst, men det betyder at "denne kampagnes aktivitetsfrekvens" er løs.

3. **Privatkunder kan ikke tilføjes via paste-import** — paste-flow opretter `companies`, ikke `customers`. Manuel privatkunde-tilføjelse sker via Kunde 360°'s eksisterende "+ Ny kunde"-flow + derefter "Tilføj til kampagne". Dette er bevidst — privatkunde-leads er sjældne for Ristet Rug og kræver manuelt consent-tjek alligevel.

4. **Last-write-wins ved samtidig editering.** To brugere der dragger samme kort til forskellige kolonner: sidste vinder, ingen lås. Edge-case, men nævnes så folk ved det.

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
- `last_activity_at` opdateres via trigger på `crm_activities` INSERT
- **Tre partial unique indexes** håndhæver dedup
- ON DELETE CASCADE fra campaign

**`campaign_mail_queue`** (Fase 6) — pending mail-sends pr. medlem

### Ændrede tabeller

**`companies`** — ny kolonne `tags TEXT` (JSON-array)

### Nye triggers

`trg_cm_activity_touch` på `crm_activities` AFTER INSERT — opdaterer `campaign_members.last_activity_at`

### SSE-events tilføjet

`campaign_created`, `campaign_updated`, `campaign_members_added`, `campaign_member_updated`, `campaign_member_removed`, `crm_consent_updated`

---

## Åbne spørgsmål

1. **"Vundet" → bon-oprettelse**: ikke automatisk trigger. Foreslår: knap "Konvertér til bon" på medlems-detalje for vundne medlemmer, der åbner eksisterende `bon_opret_modal.js` med pre-fyldte kunde+firma-felter. Bygges først når Fase 4 har kørt med rigtige data.

2. **Auto-status efter mail-reply (Fase 6.3)**: lead → contacted automatisk, eller bevidst manuel? Foreslår manuel for at undgå fejltolkning af out-of-office. Diskuteres når Fase 6 implementeres.

3. **"Snooze"-medlemmer**: skal `parked`-status tilføjes til CHECK-listen så medlemmer kan ligges på pause uden at være tabt? Ikke i v1 — tilføjes hvis behov opstår.

4. **`scripts/dump-schema.js`** — auto-genereret datamodel-fil så `bon_v2_datamodel_v2.md` ikke drifter igen. Skal med på `BON_V2_HUSKELISTE.md` som quick win, separat fra dette spec.

---

*Spec v2 oprettet maj 2026 efter kode-validering. 7 faser (0+1-6), hver fase deploybar separat. Estimat: 5-7 dages fokuseret arbejde, anbefalet rækkefølge 0 → 1 → 2 → 4 → 3 → 5 → 6.*
