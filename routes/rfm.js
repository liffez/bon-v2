// routes/rfm.js
// ==========================================
// RFM scoring, config, re-aktivering,
// prospekter og ICP-profil.
// ==========================================

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');
const { enrichContactContext } = require('../services/crmContactContext');
const { computeRfmScores, getRfmConfig, computeIcpProfile, computeProspectScores, getReactivationCandidates } = require('../services/rfm');

router.use(requireAuth());

// ─── GET /scores ────────────────────────────────────────────
// Liste over alle rfm_scores joined med companies.
router.get('/scores', handle((req, res) => {
    const db = getDb();
    const { stage, sort, limit, offset, q } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (stage) {
        where += ' AND s.stage = ?';
        params.push(stage);
    }

    if (q) {
        where += ' AND (c.name LIKE ? OR c.cvr LIKE ?)';
        params.push(`%${q}%`, `%${q}%`);
    }

    const sortCol = {
        rfm_total: 's.rfm_total DESC',
        r_score: 's.r_score DESC',
        f_score: 's.f_score DESC',
        m_score: 's.m_score DESC',
        order_count: 's.order_count DESC',
        total_guests: 's.total_guests DESC',
        total_revenue: 's.total_revenue DESC',
        days_since_last: 's.days_since_last ASC',
        name: 'c.name ASC',
    }[sort] || 's.rfm_total DESC';

    const lim = Math.min(parseInt(limit) || 500, 1000);
    const off = parseInt(offset) || 0;

    const rows = db.prepare(`
        SELECT s.*, c.name, c.cvr, c.branch, c.employee_count, c.company_type,
               c.is_personal, c.phone AS company_phone, c.email AS company_email,
               c.ean, c.legal_name,
               (SELECT first_name || ' ' || COALESCE(last_name,'')
                FROM customers WHERE company_id = c.id AND is_active = 1
                ORDER BY is_primary_contact DESC LIMIT 1) AS primary_contact_name,
               (SELECT phone FROM customers WHERE company_id = c.id AND is_active = 1
                ORDER BY is_primary_contact DESC LIMIT 1) AS primary_contact_phone,
               (SELECT email FROM customers WHERE company_id = c.id AND is_active = 1
                ORDER BY is_primary_contact DESC LIMIT 1) AS primary_contact_email,
               (SELECT id FROM customers WHERE company_id = c.id AND is_active = 1
                ORDER BY is_primary_contact DESC LIMIT 1) AS primary_customer_id
        FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id
        ${where}
        ORDER BY ${sortCol}
        LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    const countRow = db.prepare(`
        SELECT COUNT(*) AS total FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id ${where}
    `).get(...params);

    // Stage-fordeling
    const stages = db.prepare(`
        SELECT stage, COUNT(*) AS count FROM rfm_scores GROUP BY stage
    `).all();

    res.json({ rows, total: countRow.total, stages });
}));

// ─── GET /scores/:companyId ─────────────────────────────────
router.get('/scores/:companyId', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.companyId);

    const row = db.prepare(`
        SELECT s.*, c.name, c.cvr, c.branch, c.employee_count, c.company_type,
               c.is_personal, c.legal_name
        FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id
        WHERE s.company_id = ?
    `).get(id);

    if (!row) return res.status(404).json({ error: 'Firma ikke fundet i RFM' });
    res.json(row);
}));

// ─── GET /config ────────────────────────────────────────────
router.get('/config', handle((req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value, label FROM rfm_config ORDER BY rowid').all();
    res.json(rows);
}));

// ─── PATCH /config ──────────────────────────────────────────
router.patch('/config', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const updates = req.body;

    const validKeys = ['w_r', 'w_f', 'w_m', 'vip_pct', 'aktiv_pct', 'recency_days', 'monetary_mode', 'lookback_months'];
    const stmt = db.prepare('UPDATE rfm_config SET value = ?, updated_at = datetime(\'now\') WHERE key = ?');

    let changed = 0;
    for (const [key, value] of Object.entries(updates)) {
        if (!validKeys.includes(key)) continue;
        stmt.run(String(value), key);
        changed++;
    }

    broadcast('rfm_config_changed', { changed });
    res.json({ ok: true, changed });
}));

// ─── POST /compute ──────────────────────────────────────────
router.post('/compute', requireAuth('admin'), handle((req, res) => {
    const result = computeRfmScores();
    broadcast('rfm_computed', { computed: result.computed });
    res.json(result);
}));

// ─── PATCH /scores/:companyId/stage ─────────────────────────
// Manuel stage-override (sætter stage_locked)
router.patch('/scores/:companyId/stage', handle((req, res) => {
    const db = getDb();
    const companyId = parseInt(req.params.companyId);
    const { stage } = req.body;
    const userId = req.session.user?.id || null;

    if (!['lead', 'active', 'dormant', 'vip'].includes(stage)) {
        return res.status(400).json({ error: 'Ugyldigt stadie' });
    }

    // Opdater rfm_scores
    const existing = db.prepare('SELECT 1 FROM rfm_scores WHERE company_id = ?').get(companyId);
    if (existing) {
        db.prepare(`
            UPDATE rfm_scores
            SET stage = ?, stage_locked = 1, stage_locked_by = ?, stage_locked_at = datetime('now')
            WHERE company_id = ?
        `).run(stage, userId, companyId);
    } else {
        db.prepare(`
            INSERT INTO rfm_scores (company_id, stage, stage_locked, stage_locked_by, stage_locked_at)
            VALUES (?, ?, 1, ?, datetime('now'))
        `).run(companyId, stage, userId);
    }

    // Propager til crm_customer_meta for alle kunder i firmaet
    const customers = db.prepare(
        'SELECT id FROM customers WHERE company_id = ? AND is_active = 1'
    ).all(companyId);

    for (const cu of customers) {
        const meta = db.prepare('SELECT 1 FROM crm_customer_meta WHERE customer_id = ?').get(cu.id);
        if (meta) {
            db.prepare('UPDATE crm_customer_meta SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE customer_id = ?').run(stage, cu.id);
        } else {
            db.prepare('INSERT INTO crm_customer_meta (customer_id, stage) VALUES (?, ?)').run(cu.id, stage);
        }
        broadcast('crm_stage_changed', { customer_id: cu.id, stage });
    }

    res.json({ ok: true });
}));

// ─── PATCH /scores/:companyId/unlock ────────────────────────
router.patch('/scores/:companyId/unlock', handle((req, res) => {
    const db = getDb();
    const companyId = parseInt(req.params.companyId);

    db.prepare(`
        UPDATE rfm_scores SET stage_locked = 0, stage_locked_by = NULL, stage_locked_at = NULL
        WHERE company_id = ?
    `).run(companyId);

    res.json({ ok: true });
}));

// ─── GET /reactivation ──────────────────────────────────────
// Sovende firmaer med højt potentiale, sorteret efter F+M score.
// Tærskler (min. ordrer + karantæne) er justerbare — se services/rfm.js.
router.get('/reactivation', handle((req, res) => {
    const db = getDb();
    const result = getReactivationCandidates(db);
    // Rækken er et firma — konteksten hører til dets primære kontakt.
    enrichContactContext(db, result.rows, { customerKey: 'primary_customer_id' });
    res.json(result);
}));

// ─── GET /prospects ─────────────────────────────────────────
// Lead-firmaer med gradueret ICP-fit (branche + størrelse + afstand).
// Query: ?q= søgning, ?minKm/?maxKm= afstands-interval (overstyrer settings-default).
router.get('/prospects', handle((req, res) => {
    const result = computeProspectScores({ q: req.query.q, minKm: req.query.minKm, maxKm: req.query.maxKm });
    res.json(result);
}));

// ─── GET /icp ───────────────────────────────────────────────
router.get('/icp', handle((req, res) => {
    const source = req.query.source === 'top25' ? 'top25' : 'vip';
    const profile = computeIcpProfile(source);
    res.json(profile);
}));

module.exports = router;
