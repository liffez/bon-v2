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

// Outreach er CRM-følsom: ingen anonym adgang. Spec sektion 1.2 nævner ikke
// rolle-restriktion (alle indloggede må læse + skrive), så ingen rolle-args.
router.use(requireAuth());

// node:sqlite smider ERR_SQLITE_ERROR med errcode 2067 for UNIQUE
// (modsat better-sqlite3's SQLITE_CONSTRAINT_UNIQUE-kode). Brug helper.
function isUniqueViolation(e) {
    return e && (e.errcode === 2067 || /UNIQUE/.test(e.message || ''));
}

const ALLOWED_STATUS = ['lead', 'quote_sent', 'negotiating', 'won', 'lost'];

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

    const rows = db.prepare(`
        SELECT
            m.*,
            co.name AS company_name, co.cvr, co.ean, co.city AS company_city,
            co.tags AS company_tags,
            TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')) AS contact_person,
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

module.exports = router;
