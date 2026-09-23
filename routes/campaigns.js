// routes/campaigns.js
// ==========================================
// Outreach-kampagner: kampagne-CRUD + medlems-CRUD.
// Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md Fase 1
//
// Jura-validering server-side (markedsføringslov §10):
//   - Ren B2C (kun customer_id) + marketing_consent=0 → BLOKERET
//   - do_not_contact=1 → BLOKERET uanset B2B/B2C
//   - B2B uden customer_id (kun company_id) → tilladt uden consent-tjek
// ==========================================

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange, transaction } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');
const { matchCompany } = require('../services/companyMatcher');
const { enrichContactContext, CONTEXT_FIELDS } = require('../services/crmContactContext');

// Outreach er CRM-følsom: ingen anonym adgang. Spec sektion 1.2 nævner ikke
// rolle-restriktion (alle indloggede må læse + skrive), så ingen rolle-args.
router.use(requireAuth());

// node:sqlite smider ERR_SQLITE_ERROR med errcode 2067 for UNIQUE
// (modsat better-sqlite3's SQLITE_CONSTRAINT_UNIQUE-kode). Brug helper.
function isUniqueViolation(e) {
    return e && (e.errcode === 2067 || /UNIQUE/.test(e.message || ''));
}

// member_status omdøbt i migration 085: quote_sent → contacted.
// "contacted" dækker bredere: alt initiativ ud til kunden (tilbud, præsentation,
// smagsprøver, opkald) — ikke kun "specifikt sendt et tilbud".
const ALLOWED_STATUS = ['lead', 'contacted', 'negotiating', 'won', 'lost'];

// ─── KAMPAGNER ──────────────────────────────────────────────

// GET /api/campaigns?active=0|1 (default: kun aktive)
router.get('/', handle((req, res) => {
    const db = getDb();
    const includeClosed = req.query.active === '0';
    const where = includeClosed ? '' : 'WHERE c.is_active = 1';

    const rows = db.prepare(`
        SELECT
            c.id, c.name, c.description, c.owner_user_id, c.is_active,
            c.created_at, c.closed_at, c.notes,
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

// GET /api/campaigns/pipeline?campaign_id=X
// Returnerer medlemmer grupperet pr. member_status (kanban-kolonner).
// Uden campaign_id: medlemmer på tværs af alle aktive kampagner.
// Med campaign_id: kun den ene kampagnes medlemmer.
//
// Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md Fase 4.
// VIGTIGT: Placeret før '/:id' for at undgå at Express matcher 'pipeline' som :id.
router.get('/pipeline', handle((req, res) => {
    const db = getDb();
    const campaignId = req.query.campaign_id ? parseInt(req.query.campaign_id) : null;

    let where = 'WHERE oc.is_active = 1';
    const args = [];
    if (campaignId) {
        where += ' AND m.campaign_id = ?';
        args.push(campaignId);
    }

    // member_in_n_open_campaigns: korreleret subquery for at vide om kunden er i flere
    // åbne kampagner samtidig (bruges i global-visning for at vise multi-kampagne-badge).
    // Tæller kun aktive kampagner og ikke-terminal-status (won/lost regnes ikke).
    const rows = db.prepare(`
        SELECT
            m.id AS member_id, m.campaign_id, m.member_status, m.lost_reason,
            m.assigned_user_id, m.notes, m.added_at, m.last_activity_at,
            m.company_id, m.customer_id,
            oc.name AS campaign_name,
            co.name AS company_name, co.cvr, co.ean,
            addr.city AS company_city, co.address_id AS company_address_id,
            cu.first_name, cu.last_name,
            cu.email AS customer_email, cu.phone AS customer_phone,
            co.email AS company_email, co.phone AS company_phone,
            meta.marketing_consent, meta.do_not_contact,
            u.name AS assigned_name,
            CASE
                WHEN m.customer_id IS NOT NULL THEN (
                    SELECT COUNT(*) FROM campaign_members m2
                    JOIN outreach_campaigns oc2 ON oc2.id = m2.campaign_id
                    WHERE m2.customer_id = m.customer_id
                      AND oc2.is_active = 1
                      AND m2.member_status NOT IN ('won','lost')
                )
                ELSE 1
            END AS in_n_open_campaigns
        FROM campaign_members m
        JOIN outreach_campaigns oc ON oc.id = m.campaign_id
        LEFT JOIN companies co ON co.id = m.company_id
        LEFT JOIN addresses addr ON addr.id = co.address_id
        LEFT JOIN customers cu ON cu.id = m.customer_id
        LEFT JOIN crm_customer_meta meta ON meta.customer_id = m.customer_id
        LEFT JOIN users u ON u.id = m.assigned_user_id
        ${where}
        ORDER BY m.added_at DESC
    `).all(...args);
    // Samme kontakt-kontekst som service-kald og ringelisten: stemning,
    // aktiviteter og afstand. Firmaets adresse er sidste udvej for afstanden.
    enrichContactContext(db, rows, { fallbackAddressKey: 'company_address_id' });

    // Klassificér kort-tilstand (firma alene / firma+kontakt / privatkunde).
    // Labels matcher forretningsproces:
    //   contacted = alt initiativ ud til kunden (tilbud, præsentation, smagsprøver, opkald)
    //   negotiating = "konstruktiv dialog" om detaljer
    //   won = bestilling lagt
    const columns = {
        lead:         { label: 'Lead',      members: [] },
        contacted:    { label: 'Kontaktet', members: [] },
        negotiating:  { label: 'Dialog',    members: [] },
        won:          { label: 'Vundet',    members: [] },
        lost:         { label: 'Tabt',      members: [] },
    };
    for (const r of rows) {
        const contact = ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || null;
        const cardType =
            r.company_id && r.customer_id ? 'b2b_with_contact' :
            r.company_id ? 'b2b_only' : 'b2c';

        const item = {
            member_id: r.member_id,
            campaign_id: r.campaign_id,
            campaign_name: r.campaign_name,
            member_status: r.member_status,
            lost_reason: r.lost_reason,
            company_id: r.company_id,
            customer_id: r.customer_id,
            company_name: r.company_name,
            company_city: r.company_city,
            contact_person: contact,
            assigned_user_id: r.assigned_user_id,
            assigned_name: r.assigned_name,
            added_at: r.added_at,
            last_activity_at: r.last_activity_at,
            card_type: cardType,
            in_n_open_campaigns: r.in_n_open_campaigns,
            // Kontaktdata blev hentet i forespørgslen, men aldrig lagt på kortet —
            // derfor kunne tavlen kun trække kort rundt, ikke ringe eller maile.
            // Firma-kolonnerne er cachen fra contact_points (is_primary), så
            // et firma uden kontaktperson stadig har noget at ringe til.
            notes: r.notes,
            customer_email: r.customer_email || null,
            customer_phone: r.customer_phone || null,
            company_email: r.company_email || null,
            company_phone: r.company_phone || null,
            marketing_consent: r.marketing_consent,
            do_not_contact: r.do_not_contact,
        };
        for (const k of CONTEXT_FIELDS) item[k] = r[k];
        const col = columns[r.member_status];
        if (col) col.members.push(item);
    }

    res.json({
        active_campaign_id: campaignId,
        columns,
    });
}));

// GET /api/campaigns/:id
router.get('/:id', handle((req, res) => {
    const db = getDb();
    const c = db.prepare(`
        SELECT c.*, u.name AS owner_name
        FROM outreach_campaigns c
        LEFT JOIN users u ON u.id = c.owner_user_id
        WHERE c.id = ?
    `).get(req.params.id);
    if (!c) return res.status(404).json({ error: 'not_found' });
    res.json(c);
}));

// POST /api/campaigns — opret kampagne
// Body: { name, description?, owner_user_id?, notes? }
// 409 name_in_use: navn brugt på aktiv kampagne
// 409 name_closed: navn brugt på lukket kampagne — kan genåbnes via /:id/reopen
router.post('/', handle((req, res) => {
    const { name, description, owner_user_id, notes } = req.body || {};
    if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'name required' });
    }
    const cleanName = String(name).trim();
    const userId = req.session?.userId ?? null;
    const db = getDb();

    const existing = db.prepare(
        'SELECT id, is_active FROM outreach_campaigns WHERE name = ?'
    ).get(cleanName);
    if (existing) {
        if (existing.is_active === 1) {
            return res.status(409).json({ error: 'name_in_use', existing_id: existing.id });
        }
        return res.status(409).json({
            error: 'name_closed',
            existing_id: existing.id,
            reopenable: true,
        });
    }

    const r = db.prepare(`
        INSERT INTO outreach_campaigns (name, description, owner_user_id, notes)
        VALUES (?, ?, ?, ?)
    `).run(cleanName, description || null, owner_user_id || userId, notes || null);

    logChange({
        entityType: 'outreach_campaign',
        entityId: r.lastInsertRowid,
        action: 'create',
        newValue: JSON.stringify({ name: cleanName }),
        userId,
    });
    broadcast('campaign_created', { id: r.lastInsertRowid });
    res.json({ id: r.lastInsertRowid });
}));

// PATCH /api/campaigns/:id — opdater felter
router.patch('/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = req.session?.userId ?? null;
    const { name, description, owner_user_id, notes } = req.body || {};

    const fields = [];
    const args = [];
    if (name !== undefined) { fields.push('name = ?'); args.push(String(name).trim()); }
    if (description !== undefined) { fields.push('description = ?'); args.push(description); }
    if (owner_user_id !== undefined) { fields.push('owner_user_id = ?'); args.push(owner_user_id); }
    if (notes !== undefined) { fields.push('notes = ?'); args.push(notes); }
    if (!fields.length) return res.status(400).json({ error: 'no_fields' });

    args.push(id);
    try {
        const r = db.prepare(`UPDATE outreach_campaigns SET ${fields.join(', ')} WHERE id = ?`).run(...args);
        if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
    } catch (e) {
        if (isUniqueViolation(e)) return res.status(409).json({ error: 'name_in_use' });
        throw e;
    }

    logChange({
        entityType: 'outreach_campaign', entityId: id,
        action: 'update', userId,
    });
    broadcast('campaign_updated', { id });
    res.json({ ok: true });
}));

// POST /api/campaigns/:id/close — luk kampagne
router.post('/:id/close', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = req.session?.userId ?? null;
    const r = db.prepare(`
        UPDATE outreach_campaigns
        SET is_active = 0, closed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND is_active = 1
    `).run(id);
    if (r.changes === 0) {
        return res.status(404).json({ error: 'not_found_or_already_closed' });
    }
    logChange({
        entityType: 'outreach_campaign', entityId: id,
        action: 'close', userId,
    });
    broadcast('campaign_updated', { id });
    res.json({ ok: true });
}));

// POST /api/campaigns/:id/reopen — genåbn lukket kampagne
router.post('/:id/reopen', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = req.session?.userId ?? null;
    const r = db.prepare(`
        UPDATE outreach_campaigns
        SET is_active = 1, closed_at = NULL
        WHERE id = ? AND is_active = 0
    `).run(id);
    if (r.changes === 0) {
        return res.status(404).json({ error: 'not_found_or_already_active' });
    }
    logChange({
        entityType: 'outreach_campaign', entityId: id,
        action: 'reopen', userId,
    });
    broadcast('campaign_updated', { id });
    res.json({ ok: true });
}));

// ─── MEDLEMMER ──────────────────────────────────────────────

// GET /api/campaigns/:id/members?status=lead
router.get('/:id/members', handle((req, res) => {
    const db = getDb();
    const { status } = req.query;
    const args = [req.params.id];
    let filter = '';
    if (status) {
        if (!ALLOWED_STATUS.includes(status)) {
            return res.status(400).json({ error: 'invalid_status' });
        }
        filter = 'AND m.member_status = ?';
        args.push(status);
    }

    // companies har ingen direkte city-kolonne — den ligger på addresses via address_id.
    // LEFT JOIN addresses så Fase 3 paste-import kan bruge by som tiebreaker.
    const rows = db.prepare(`
        SELECT
            m.*,
            co.name AS company_name, co.cvr, co.ean,
            addr.city AS company_city,
            co.tags AS company_tags,
            TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) AS contact_person,
            cu.email AS customer_email, cu.phone AS customer_phone,
            meta.marketing_consent, meta.do_not_contact, meta.tags AS customer_tags,
            u.name AS assigned_name
        FROM campaign_members m
        LEFT JOIN companies co ON co.id = m.company_id
        LEFT JOIN addresses addr ON addr.id = co.address_id
        LEFT JOIN customers cu ON cu.id = m.customer_id
        LEFT JOIN crm_customer_meta meta ON meta.customer_id = m.customer_id
        LEFT JOIN users u ON u.id = m.assigned_user_id
        WHERE m.campaign_id = ? ${filter}
        ORDER BY m.added_at DESC
    `).all(...args);
    res.json(rows);
}));

// POST /api/campaigns/:id/members
// Body: { members: [ { company_id?, customer_id?, assigned_user_id?, notes? }, ... ] }
// Returnerer { added: N, skipped: [...], member_ids: [...] }
// Skipped reasons: no_entity | no_marketing_consent_b2c | do_not_contact | already_member | db_error
router.post('/:id/members', handle((req, res) => {
    const db = getDb();
    const campaignId = parseInt(req.params.id);
    const userId = req.session?.userId ?? null;
    const members = Array.isArray(req.body?.members) ? req.body.members : [];
    if (!members.length) return res.status(400).json({ error: 'no_members' });

    // Tjek at kampagnen findes og er aktiv
    const camp = db.prepare('SELECT id, is_active FROM outreach_campaigns WHERE id = ?').get(campaignId);
    if (!camp) return res.status(404).json({ error: 'campaign_not_found' });
    if (camp.is_active === 0) return res.status(409).json({ error: 'campaign_closed' });

    const added = [];
    const skipped = [];

    const insertStmt = db.prepare(`
        INSERT INTO campaign_members
            (campaign_id, company_id, customer_id, assigned_user_id, notes, added_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const consentStmt = db.prepare(`
        SELECT marketing_consent, do_not_contact
        FROM crm_customer_meta WHERE customer_id = ?
    `);

    transaction(db, () => {
        for (const m of members) {
            const companyId  = m.company_id ? parseInt(m.company_id) : null;
            const customerId = m.customer_id ? parseInt(m.customer_id) : null;

            if (!companyId && !customerId) {
                skipped.push({ reason: 'no_entity', input: m });
                continue;
            }

            if (customerId) {
                const meta = consentStmt.get(customerId);
                // §10: ren B2C (ingen company_id) kræver EXPLICIT samtykke.
                // Manglende meta-row = "intet samtykke givet" → blokeret.
                // Kun marketing_consent=1 (positivt sat) tillader inddragelse.
                if (!companyId && (!meta || meta.marketing_consent !== 1)) {
                    skipped.push({ reason: 'no_marketing_consent_b2c', input: m });
                    continue;
                }
                if (meta && meta.do_not_contact === 1) {
                    skipped.push({ reason: 'do_not_contact', input: m });
                    continue;
                }
            }

            try {
                const r = insertStmt.run(
                    campaignId,
                    companyId,
                    customerId,
                    m.assigned_user_id || null,
                    m.notes || null,
                    userId,
                );
                added.push(r.lastInsertRowid);
                logChange({
                    entityType: 'campaign_member',
                    entityId: r.lastInsertRowid,
                    action: 'create',
                    newValue: JSON.stringify({
                        campaign_id: campaignId,
                        company_id: companyId,
                        customer_id: customerId,
                    }),
                    userId,
                });
            } catch (e) {
                if (isUniqueViolation(e)) {
                    skipped.push({ reason: 'already_member', input: m });
                } else {
                    skipped.push({ reason: 'db_error', input: m, error: e.message });
                }
            }
        }
    });

    if (added.length) {
        broadcast('campaign_members_added', { campaign_id: campaignId, count: added.length });
    }
    res.json({ added: added.length, skipped, member_ids: added });
}));

// PATCH /api/campaigns/:campaignId/members/:memberId
// Body: { member_status?, lost_reason?, assigned_user_id?, notes? }
router.patch('/:campaignId/members/:memberId', handle((req, res) => {
    const db = getDb();
    const memberId = parseInt(req.params.memberId);
    const campaignId = parseInt(req.params.campaignId);
    const userId = req.session?.userId ?? null;
    const { member_status, lost_reason, assigned_user_id, notes } = req.body || {};

    if (member_status !== undefined && !ALLOWED_STATUS.includes(member_status)) {
        return res.status(400).json({ error: 'invalid_status' });
    }
    if (member_status === 'lost' && !lost_reason && !req.body?.lost_reason) {
        // Tillad opdatering hvor lost_reason allerede er sat på rækken; tjek nedenfor
        const existing = db.prepare('SELECT lost_reason FROM campaign_members WHERE id = ?').get(memberId);
        if (!existing) return res.status(404).json({ error: 'not_found' });
        if (!existing.lost_reason) {
            return res.status(400).json({ error: 'lost_reason_required' });
        }
    }

    const fields = [];
    const args = [];
    if (member_status !== undefined)    { fields.push('member_status = ?');    args.push(member_status); }
    if (lost_reason !== undefined)      { fields.push('lost_reason = ?');      args.push(lost_reason); }
    if (assigned_user_id !== undefined) { fields.push('assigned_user_id = ?'); args.push(assigned_user_id); }
    if (notes !== undefined)            { fields.push('notes = ?');            args.push(notes); }
    if (!fields.length) return res.status(400).json({ error: 'no_fields' });

    const before = db.prepare(
        'SELECT campaign_id, member_status, assigned_user_id FROM campaign_members WHERE id = ?'
    ).get(memberId);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.campaign_id !== campaignId) {
        return res.status(404).json({ error: 'member_not_in_campaign' });
    }

    args.push(memberId);
    db.prepare(`UPDATE campaign_members SET ${fields.join(', ')} WHERE id = ?`).run(...args);

    if (member_status !== undefined && before.member_status !== member_status) {
        logChange({
            entityType: 'campaign_member', entityId: memberId,
            action: 'status_change', fieldName: 'member_status',
            oldValue: before.member_status, newValue: member_status,
            userId,
        });
    }
    if (assigned_user_id !== undefined && before.assigned_user_id !== assigned_user_id) {
        logChange({
            entityType: 'campaign_member', entityId: memberId,
            action: 'update', fieldName: 'assigned_user_id',
            oldValue: before.assigned_user_id, newValue: assigned_user_id,
            userId,
        });
    }

    broadcast('campaign_member_updated', {
        campaign_id: campaignId,
        member_id: memberId,
        member_status: member_status !== undefined ? member_status : before.member_status,
    });
    res.json({ ok: true });
}));

// DELETE /api/campaigns/:campaignId/members/:memberId
router.delete('/:campaignId/members/:memberId', handle((req, res) => {
    const db = getDb();
    const memberId = parseInt(req.params.memberId);
    const campaignId = parseInt(req.params.campaignId);
    const userId = req.session?.userId ?? null;

    const before = db.prepare(
        'SELECT campaign_id, company_id, customer_id FROM campaign_members WHERE id = ?'
    ).get(memberId);
    if (!before) return res.status(404).json({ error: 'not_found' });
    if (before.campaign_id !== campaignId) {
        return res.status(404).json({ error: 'member_not_in_campaign' });
    }

    db.prepare('DELETE FROM campaign_members WHERE id = ?').run(memberId);

    logChange({
        entityType: 'campaign_member', entityId: memberId,
        action: 'delete',
        oldValue: JSON.stringify({
            campaign_id: campaignId,
            company_id: before.company_id,
            customer_id: before.customer_id,
        }),
        userId,
    });
    broadcast('campaign_member_removed', { campaign_id: campaignId, member_id: memberId });
    res.json({ ok: true });
}));

// ─── PASTE-IMPORT (Fase 3) ──────────────────────────────────

// Sanér en input-række til canonical form. Returnerer null hvis intet brugbart.
function _cleanRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) {
        if (v == null) continue;
        const s = String(v).trim();
        if (s) out[k] = s;
    }
    // Mindst ét af firmanavn/CVR/EAN/email skal være sat for at det er brugbart
    if (!out.name && !out.cvr && !out.ean && !out.email) return null;
    return out;
}

// POST /api/campaigns/:id/import-preview
// Body: { rows: [{ name, cvr, ean, email, phone, contact_person, city, postcode, address, notes }, ...] }
// Returnerer for hver række: match_type, match_company_id, match_company_name, match_confidence,
// suggested_action ∈ { use_existing | review | create_new | skip }, og dedup-tjek.
//
// suggested_action-regler:
//   confidence ≥ 0.95          → use_existing
//   0.85 ≤ confidence < 0.95   → review (kræver manuel bekræftelse)
//   ingen match                → create_new (hvis firmanavn er sat) ellers skip
router.post('/:id/import-preview', handle((req, res) => {
    const db = getDb();
    const campaignId = parseInt(req.params.id);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'no_rows' });
    if (rows.length > 5000) return res.status(400).json({ error: 'too_many_rows', max: 5000 });

    // Kampagnen skal eksistere og være aktiv
    const camp = db.prepare('SELECT id, is_active FROM outreach_campaigns WHERE id = ?').get(campaignId);
    if (!camp) return res.status(404).json({ error: 'campaign_not_found' });
    if (camp.is_active === 0) return res.status(409).json({ error: 'campaign_closed' });

    // Cache eksisterende kampagne-medlemmer for dedup-check
    const existingMembers = db.prepare(`
        SELECT company_id FROM campaign_members WHERE campaign_id = ? AND company_id IS NOT NULL
    `).all(campaignId);
    const existingCompanyIds = new Set(existingMembers.map(m => m.company_id));

    const preview = [];
    for (let i = 0; i < rows.length; i++) {
        const clean = _cleanRow(rows[i]);
        if (!clean) {
            preview.push({
                row_index: i,
                input: rows[i],
                match_type: null,
                suggested_action: 'skip',
                reason: 'empty_row',
            });
            continue;
        }
        const match = matchCompany(db, {
            name: clean.name,
            cvr: clean.cvr,
            ean: clean.ean,
            email: clean.email,
            city: clean.city,
        });

        let suggested_action;
        let already_member = false;
        if (match) {
            already_member = existingCompanyIds.has(match.company_id);
            if (already_member) {
                suggested_action = 'skip';
            } else if (match.confidence >= 0.95) {
                suggested_action = 'use_existing';
            } else {
                suggested_action = 'review';
            }
        } else {
            // Ingen match — kan vi oprette nyt firma? Kræver mindst et firmanavn.
            suggested_action = clean.name ? 'create_new' : 'skip';
        }

        preview.push({
            row_index: i,
            input: clean,
            match_type: match?.match_type || null,
            match_company_id: match?.company_id || null,
            match_company_name: match?.company_name || null,
            match_confidence: match?.confidence || null,
            already_member,
            suggested_action,
        });
    }

    res.json({ rows: preview, count: rows.length });
}));

// POST /api/campaigns/:id/import-commit
// Body: { decisions: [{ row_index, action, company_id?, input? }, ...] }
//   action ∈ { use_existing | create_new | skip }
//   - use_existing kræver company_id
//   - create_new kræver input med mindst { name }
//
// Server kører ALT i én transaktion. Hvis nogen handling fejler, rulles ALT tilbage.
router.post('/:id/import-commit', handle((req, res) => {
    const db = getDb();
    const campaignId = parseInt(req.params.id);
    const userId = req.session?.userId ?? null;
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    if (!decisions.length) return res.status(400).json({ error: 'no_decisions' });

    const camp = db.prepare('SELECT id, is_active FROM outreach_campaigns WHERE id = ?').get(campaignId);
    if (!camp) return res.status(404).json({ error: 'campaign_not_found' });
    if (camp.is_active === 0) return res.status(409).json({ error: 'campaign_closed' });

    const result = {
        added: 0,
        new_companies_created: 0,
        skipped: [],
        new_company_ids: [],
        new_member_ids: [],
    };

    const insertCompany = db.prepare(`
        INSERT INTO companies (name, cvr, ean, phone, email, notes, is_active, is_internal)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0)
    `);
    const insertMember = db.prepare(`
        INSERT INTO campaign_members (campaign_id, company_id, notes, added_by_user_id)
        VALUES (?, ?, ?, ?)
    `);

    try {
        transaction(db, () => {
            for (const d of decisions) {
                const idx = d.row_index;
                let companyId = null;

                if (d.action === 'skip') {
                    result.skipped.push({ row_index: idx, reason: 'user_skipped' });
                    continue;
                }

                if (d.action === 'use_existing') {
                    if (!d.company_id) {
                        result.skipped.push({ row_index: idx, reason: 'missing_company_id' });
                        continue;
                    }
                    // Verificér firma findes og ikke er internt
                    const co = db.prepare('SELECT id FROM companies WHERE id = ? AND is_internal = 0').get(d.company_id);
                    if (!co) {
                        result.skipped.push({ row_index: idx, reason: 'company_not_found' });
                        continue;
                    }
                    companyId = co.id;
                } else if (d.action === 'create_new') {
                    const input = d.input || {};
                    const name = input.name && String(input.name).trim();
                    if (!name) {
                        result.skipped.push({ row_index: idx, reason: 'missing_name' });
                        continue;
                    }
                    const r = insertCompany.run(
                        name,
                        input.cvr || null,
                        input.ean || null,
                        input.phone || null,
                        input.email || null,
                        input.notes || null,
                    );
                    companyId = r.lastInsertRowid;
                    result.new_companies_created++;
                    result.new_company_ids.push(companyId);
                    logChange({
                        entityType: 'company',
                        entityId: companyId,
                        action: 'create',
                        newValue: JSON.stringify({ name, source: 'campaign_import' }),
                        userId,
                    });
                } else {
                    result.skipped.push({ row_index: idx, reason: 'invalid_action' });
                    continue;
                }

                // Tilføj som medlem (B2B alene — paste-import laver ikke privatkunder)
                try {
                    const r = insertMember.run(campaignId, companyId, d.input?.notes || null, userId);
                    result.added++;
                    result.new_member_ids.push(r.lastInsertRowid);
                    logChange({
                        entityType: 'campaign_member',
                        entityId: r.lastInsertRowid,
                        action: 'create',
                        newValue: JSON.stringify({ campaign_id: campaignId, company_id: companyId, source: 'import' }),
                        userId,
                    });
                } catch (e) {
                    if (isUniqueViolation(e)) {
                        result.skipped.push({ row_index: idx, reason: 'already_member' });
                    } else {
                        // Re-throw så transaktionen rulles tilbage
                        throw e;
                    }
                }
            }
        });
    } catch (err) {
        return res.status(500).json({
            error: 'commit_failed',
            message: err.message || 'database fejl',
        });
    }

    if (result.added > 0) {
        broadcast('campaign_members_added', { campaign_id: campaignId, count: result.added });
    }
    res.json(result);
}));

// ─── SMART-FORSLAG (Fase 5) ─────────────────────────────────

// POST /api/campaigns/from-suggestion
// Body: {
//   type: 'dormant',
//   filter: { days_since_last, min_total_revenue },
//   campaign_name,
//   description?,
//   owner_user_id?,
//   assigned_user_id?,
// }
// Opretter kampagne + tilføjer alle sovende kunder der opfylder filteret.
// Jura-regler (§10 + DNC) håndhæves serverside — samme regler som POST /members.
// Kunder med company_id → tilføjes som B2B (company_id + customer_id).
// Kunder uden company_id → tilføjes som B2C (kræver explicit marketing_consent).
router.post('/from-suggestion', handle((req, res) => {
    const db = getDb();
    const userId = req.session?.userId ?? null;
    const {
        type, filter, campaign_name, description,
        owner_user_id, assigned_user_id,
    } = req.body || {};

    const SUPPORTED_TYPES = ['dormant', 'seasonal', 'rytme'];
    if (!SUPPORTED_TYPES.includes(type)) {
        return res.status(400).json({ error: 'unsupported_type', message: `kun ${SUPPORTED_TYPES.join(', ')} understøttes` });
    }
    if (!campaign_name || !String(campaign_name).trim()) {
        return res.status(400).json({ error: 'campaign_name_required' });
    }

    const name = String(campaign_name).trim();

    // 1. Tjek for navn-konflikter (samme regler som POST /api/campaigns)
    const existing = db.prepare(
        'SELECT id, is_active FROM outreach_campaigns WHERE name = ?'
    ).get(name);
    if (existing) {
        if (existing.is_active === 1) {
            return res.status(409).json({ error: 'name_in_use', existing_id: existing.id });
        }
        return res.status(409).json({
            error: 'name_closed',
            existing_id: existing.id,
            reopenable: true,
        });
    }

    // 2. Hent kandidater efter type. Hver gren returnerer SAMME kolonner
    // (customer_id, company_id, marketing_consent, do_not_contact) så consent/DNC/
    // dedup-loopet nedenfor er uændret uanset trik.
    let candidates;
    let defaultDesc;

    if (type === 'dormant') {
        const minDays = parseInt(filter?.days_since_last) || 180;
        const minRevenue = parseFloat(filter?.min_total_revenue) || 0;
        candidates = db.prepare(`
            SELECT c.id AS customer_id, c.company_id,
                   COALESCE(SUM(b.total_price), 0) AS total_revenue,
                   cm.marketing_consent, cm.do_not_contact
              FROM customers c
         LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
         LEFT JOIN bons b ON b.customer_id = c.id AND b.is_internal = 0 AND (b.is_offer = 0 OR b.is_offer IS NULL)
             WHERE c.is_active = 1
          GROUP BY c.id
            HAVING CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) > ?
               AND total_revenue >= ?
        `).all(minDays, minRevenue);
        defaultDesc = `Auto-genereret reaktivering · ${minDays}+ dage uden ordre · min ${Math.round(minRevenue)} kr omsætning`;

    } else if (type === 'seasonal') {
        // Bestilte på denne tid sidste år, intet de sidste 60 dage. Samme detektion
        // som GET /api/crm/season, men returnerer kun consent-kolonnerne.
        candidates = db.prepare(`
            SELECT c.id AS customer_id, c.company_id,
                   cm.marketing_consent, cm.do_not_contact
              FROM customers c
              JOIN bons b1 ON b1.customer_id = c.id
                          AND b1.is_internal = 0 AND (b1.is_offer = 0 OR b1.is_offer IS NULL)
         LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
             WHERE c.is_active = 1
               AND b1.delivery_date BETWEEN date('now','-14 months') AND date('now','-10 months')
               AND NOT EXISTS (
                   SELECT 1 FROM bons b2
                    WHERE b2.customer_id = c.id AND b2.is_internal = 0
                      AND b2.delivery_date > date('now','-60 days')
               )
          GROUP BY c.id
        `).all();
        defaultDesc = 'Sæson-gentagelse · bestilte på denne tid sidste år';

    } else { // rytme
        // Fast rytme (≥5 ordrer), forsinket ift. eget snit — men ikke så længe væk
        // at de er reelt sovende (det dækker dormant-typen). Samme øvre grænse ×3
        // som GET /api/crm/rytme.
        const mult = parseFloat(filter?.interval_multiplier) || 1.3;
        candidates = db.prepare(`
            SELECT c.id AS customer_id, c.company_id,
                   cm.marketing_consent, cm.do_not_contact
              FROM customers c
         LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
              JOIN (
                  SELECT b1.customer_id,
                         CAST(julianday('now') - julianday(MAX(b1.delivery_date)) AS INTEGER) AS days_since,
                         ROUND(CAST(julianday(MAX(b1.delivery_date)) - julianday(MIN(b1.delivery_date)) AS REAL)
                               / NULLIF(COUNT(*) - 1, 0), 0) AS avg_interval
                    FROM bons b1
                   WHERE b1.is_internal = 0
                GROUP BY b1.customer_id
                  HAVING COUNT(*) >= 5
              ) o ON o.customer_id = c.id
             WHERE c.is_active = 1
               AND o.avg_interval > 0
               AND o.days_since > o.avg_interval * ?
               AND o.days_since < o.avg_interval * 3
        `).all(mult);
        defaultDesc = `Faste-rytme-nudge · forsinket >${mult}× eget bestillingssnit`;
    }

    if (candidates.length === 0) {
        return res.status(400).json({ error: 'no_candidates', message: 'Ingen kunder matcher filteret.' });
    }

    // 3. Opret kampagne + tilføj medlemmer i ÉN transaktion
    let campaignId;
    const skipped = [];
    const memberIds = [];

    try {
        transaction(db, () => {
            const campRow = db.prepare(`
                INSERT INTO outreach_campaigns (name, description, owner_user_id, notes)
                VALUES (?, ?, ?, ?)
            `).run(
                name,
                description || defaultDesc,
                owner_user_id || userId,
                null,
            );
            campaignId = campRow.lastInsertRowid;
            logChange({
                entityType: 'outreach_campaign', entityId: campaignId,
                action: 'create',
                newValue: JSON.stringify({ name, source: 'from_suggestion', type, filter: filter || null }),
                userId,
            });

            const insertMember = db.prepare(`
                INSERT INTO campaign_members
                    (campaign_id, company_id, customer_id, assigned_user_id, added_by_user_id)
                VALUES (?, ?, ?, ?, ?)
            `);

            // Dedup på company_id: når flere kontakter under samme firma er sovende, tilføj kun
            // én B2B-medlemskab pr. firma. Det matcher pipelinens forventning om at en kampagne-
            // medlemskab repræsenterer et lead, ikke en kontaktperson.
            const seenCompanies = new Set();

            for (const c of candidates) {
                // Jura: DNC blokerer altid
                if (c.do_not_contact === 1) {
                    skipped.push({ customer_id: c.customer_id, reason: 'do_not_contact' });
                    continue;
                }
                // Ren B2C (ingen company_id) kræver explicit consent
                if (!c.company_id && c.marketing_consent !== 1) {
                    skipped.push({ customer_id: c.customer_id, reason: 'no_marketing_consent_b2c' });
                    continue;
                }

                let companyId = null;
                let customerId = null;
                if (c.company_id) {
                    // B2B alene (ingen specifik kontakt) — dedupe pr. firma
                    if (seenCompanies.has(c.company_id)) {
                        skipped.push({ customer_id: c.customer_id, reason: 'duplicate_company' });
                        continue;
                    }
                    seenCompanies.add(c.company_id);
                    companyId = c.company_id;
                } else {
                    customerId = c.customer_id;
                }

                try {
                    const r = insertMember.run(
                        campaignId,
                        companyId,
                        customerId,
                        assigned_user_id || userId,
                        userId,
                    );
                    memberIds.push(r.lastInsertRowid);
                    logChange({
                        entityType: 'campaign_member', entityId: r.lastInsertRowid,
                        action: 'create',
                        newValue: JSON.stringify({ campaign_id: campaignId, company_id: companyId, customer_id: customerId, source: 'from_suggestion' }),
                        userId,
                    });
                } catch (e) {
                    if (isUniqueViolation(e)) {
                        skipped.push({ customer_id: c.customer_id, reason: 'already_member' });
                    } else {
                        throw e;
                    }
                }
            }
        });
    } catch (err) {
        return res.status(500).json({
            error: 'commit_failed',
            message: err.message || 'database fejl',
        });
    }

    broadcast('campaign_created', { id: campaignId });
    if (memberIds.length > 0) {
        broadcast('campaign_members_added', { campaign_id: campaignId, count: memberIds.length });
    }

    res.json({
        campaign_id: campaignId,
        added: memberIds.length,
        candidates_count: candidates.length,
        skipped,
    });
}));

module.exports = router;
