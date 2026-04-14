// services/rfm.js
// ==========================================
// RFM batch-beregning og personlige firmaer.
// Bruges af routes/rfm.js og scripts/compute-rfm.js.
// ==========================================

const { getDb } = require('../db/database');
const { transaction } = require('../db/compat');

/**
 * Sikr at alle kunder har et company_id.
 * Privatkunder (company_id IS NULL) får et personligt firma.
 * Returnerer antal oprettede firmaer.
 */
function ensurePersonalCompanies(db) {
    const orphans = db.prepare(`
        SELECT id, first_name, last_name
        FROM customers
        WHERE company_id IS NULL AND is_active = 1
    `).all();

    let created = 0;
    for (const c of orphans) {
        const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Ukendt';
        const res = db.prepare(`
            INSERT INTO companies (name, is_personal, is_active)
            VALUES (?, 1, 1)
        `).run(name);
        const companyId = Number(res.lastInsertRowid);
        db.prepare('UPDATE customers SET company_id = ? WHERE id = ?').run(companyId, c.id);
        created++;
    }
    return created;
}

/**
 * Hent RFM-config som objekt.
 */
function getRfmConfig(db) {
    const rows = db.prepare('SELECT key, value FROM rfm_config').all();
    const cfg = {};
    for (const r of rows) cfg[r.key] = r.value;
    return {
        w_r: parseFloat(cfg.w_r) || 35,
        w_f: parseFloat(cfg.w_f) || 40,
        w_m: parseFloat(cfg.w_m) || 25,
        vip_pct: parseFloat(cfg.vip_pct) || 15,
        aktiv_pct: parseFloat(cfg.aktiv_pct) || 50,
        recency_days: parseInt(cfg.recency_days) || 180,
        monetary_mode: cfg.monetary_mode || 'pax',
        lookback_months: parseInt(cfg.lookback_months) || 24,
    };
}

/**
 * Beregn og gem RFM-scores for alle firmaer.
 * Returnerer { computed, personalCreated, elapsed_ms }.
 */
function computeRfmScores() {
    const db = getDb();
    const start = Date.now();

    // 1. Sikr personlige firmaer
    const personalCreated = transaction(db, () => ensurePersonalCompanies(db));

    // 2. Hent config
    const cfg = getRfmConfig(db);
    const lookbackDate = new Date();
    lookbackDate.setMonth(lookbackDate.getMonth() - cfg.lookback_months);
    const lookbackStr = lookbackDate.toISOString().slice(0, 10);

    // 3. Hent rå ordredata per company
    //    Monetary: pax (gæster) eller revenue (kr) afhængigt af config
    const rawRows = db.prepare(`
        SELECT
            b.company_id,
            COUNT(DISTINCT b.id) AS order_count,
            COALESCE(SUM(b.pax), 0) AS total_guests,
            ROUND(COALESCE(AVG(b.pax), 0), 1) AS avg_guests,
            COALESCE(SUM(b.total_price), 0) AS total_revenue,
            ROUND(COALESCE(AVG(b.total_price), 0), 0) AS avg_order_value,
            CAST(julianday('now') - julianday(MAX(b.delivery_date)) AS INTEGER) AS days_since_last,
            MIN(b.delivery_date) AS first_order_date,
            MAX(b.delivery_date) AS last_order_date
        FROM bons b
        WHERE b.company_id IS NOT NULL
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
          AND b.is_internal = 0
          AND b.status_id NOT IN (
              SELECT id FROM status_definitions WHERE code IN ('AFLYST', 'TILBUD')
          )
          AND b.delivery_date >= ?
        GROUP BY b.company_id
    `).all(lookbackStr);

    if (rawRows.length === 0) {
        return { computed: 0, personalCreated, elapsed_ms: Date.now() - start };
    }

    // 4. Beregn min/max for normalisering
    let maxR = 0, maxF = 0, maxM = 0;
    for (const r of rawRows) {
        if (r.days_since_last > maxR) maxR = r.days_since_last;
        if (r.order_count > maxF) maxF = r.order_count;
        const mVal = cfg.monetary_mode === 'revenue' ? r.total_revenue : r.total_guests;
        if (mVal > maxM) maxM = mVal;
    }
    // Undgå division med 0
    if (maxR === 0) maxR = 1;
    if (maxF === 0) maxF = 1;
    if (maxM === 0) maxM = 1;

    // 5. Normaliser og beregn scores
    const wTotal = cfg.w_r + cfg.w_f + cfg.w_m;
    const wR = cfg.w_r / wTotal;
    const wF = cfg.w_f / wTotal;
    const wM = cfg.w_m / wTotal;

    const scored = rawRows.map(r => {
        const mRaw = cfg.monetary_mode === 'revenue' ? r.total_revenue : r.total_guests;
        // R: inverteret (færre dage = bedre)
        const rScore = Math.round(Math.max(0, (1 - r.days_since_last / maxR)) * 100);
        const fScore = Math.round(Math.min(r.order_count / maxF, 1) * 100);
        const mScore = Math.round(Math.min(mRaw / maxM, 1) * 100);
        const rfmTotal = Math.round(rScore * wR + fScore * wF + mScore * wM);
        return { ...r, r_score: rScore, f_score: fScore, m_score: mScore, rfm_total: rfmTotal };
    });

    // 6. Sortér efter rfm_total for percentil-staging
    scored.sort((a, b) => b.rfm_total - a.rfm_total);
    const total = scored.length;
    const vipCutoff = Math.ceil(total * cfg.vip_pct / 100);
    const aktivCutoff = Math.ceil(total * cfg.aktiv_pct / 100);

    for (let i = 0; i < total; i++) {
        if (i < vipCutoff) scored[i].auto_stage = 'vip';
        else if (i < aktivCutoff) scored[i].auto_stage = 'active';
        else scored[i].auto_stage = 'dormant';
    }

    // 7. UPSERT ind i rfm_scores (i én transaction)
    transaction(db, () => {
        const upsert = db.prepare(`
            INSERT INTO rfm_scores (
                company_id, order_count, total_guests, avg_guests,
                total_revenue, avg_order_value, days_since_last,
                first_order_date, last_order_date,
                r_score, f_score, m_score, rfm_total,
                stage, computed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(company_id) DO UPDATE SET
                order_count = excluded.order_count,
                total_guests = excluded.total_guests,
                avg_guests = excluded.avg_guests,
                total_revenue = excluded.total_revenue,
                avg_order_value = excluded.avg_order_value,
                days_since_last = excluded.days_since_last,
                first_order_date = excluded.first_order_date,
                last_order_date = excluded.last_order_date,
                r_score = excluded.r_score,
                f_score = excluded.f_score,
                m_score = excluded.m_score,
                rfm_total = excluded.rfm_total,
                stage = CASE WHEN rfm_scores.stage_locked = 1 THEN rfm_scores.stage ELSE excluded.stage END,
                computed_at = datetime('now')
        `);

        for (const s of scored) {
            upsert.run(
                s.company_id, s.order_count, s.total_guests, s.avg_guests,
                s.total_revenue, s.avg_order_value, s.days_since_last,
                s.first_order_date, s.last_order_date,
                s.r_score, s.f_score, s.m_score, s.rfm_total,
                s.auto_stage
            );
        }

        // Firmaer uden ordrer i lookback → lead (kun hvis ikke locked)
        db.prepare(`
            INSERT INTO rfm_scores (company_id, stage, computed_at)
            SELECT c.id, 'lead', datetime('now')
            FROM companies c
            WHERE c.is_active = 1
              AND c.id NOT IN (SELECT company_id FROM rfm_scores)
            ON CONFLICT(company_id) DO UPDATE SET
                stage = CASE WHEN rfm_scores.stage_locked = 1 THEN rfm_scores.stage ELSE 'lead' END,
                computed_at = datetime('now')
        `).run();
    });

    // 8. Propager stage til crm_customer_meta
    transaction(db, () => {
        const companies = db.prepare(`
            SELECT company_id, stage FROM rfm_scores WHERE stage_locked = 0
        `).all();

        const upsertMeta = db.prepare(`
            INSERT INTO crm_customer_meta (customer_id, stage)
            VALUES (?, ?)
            ON CONFLICT(customer_id) DO UPDATE SET
                stage = excluded.stage,
                updated_at = CURRENT_TIMESTAMP
        `);

        for (const co of companies) {
            const customers = db.prepare(
                'SELECT id FROM customers WHERE company_id = ? AND is_active = 1'
            ).all(co.company_id);
            for (const cu of customers) {
                upsertMeta.run(cu.id, co.stage);
            }
        }
    });

    return {
        computed: scored.length,
        personalCreated,
        elapsed_ms: Date.now() - start,
    };
}

/**
 * Beregn ICP-profil fra top-firmaer.
 * source: 'vip' eller 'top25'
 */
function computeIcpProfile(source) {
    const db = getDb();

    const stageFilter = source === 'top25'
        ? `rfm_total >= (SELECT rfm_total FROM rfm_scores WHERE order_count > 0 ORDER BY rfm_total DESC LIMIT 1 OFFSET (SELECT COUNT(*)/4 FROM rfm_scores WHERE order_count > 0))`
        : `stage = 'vip'`;

    const profile = db.prepare(`
        SELECT
            COUNT(*) AS company_count,
            ROUND(AVG(s.order_count), 1) AS avg_orders,
            ROUND(AVG(s.avg_guests), 0) AS avg_guests_per_event,
            ROUND(AVG(s.total_guests), 0) AS avg_total_guests,
            ROUND(AVG(s.total_revenue), 0) AS avg_total_revenue,
            ROUND(AVG(c.employee_count), 0) AS avg_employees
        FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id
        WHERE s.order_count > 0 AND ${stageFilter}
    `).get();

    // Top brancher
    const branches = db.prepare(`
        SELECT c.branch, COUNT(*) AS n,
               CAST(COUNT(*) * 100.0 / MAX(1, SUM(COUNT(*)) OVER ()) AS INTEGER) AS pct
        FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id
        WHERE s.order_count > 0 AND ${stageFilter}
          AND c.branch IS NOT NULL
        GROUP BY c.branch
        ORDER BY n DESC
        LIMIT 6
    `).all();

    // Sæsonmønster
    const seasonality = db.prepare(`
        SELECT strftime('%m', b.delivery_date) AS month, COUNT(*) AS order_count
        FROM bons b
        JOIN customers cu ON cu.id = b.customer_id
        WHERE cu.company_id IN (
            SELECT company_id FROM rfm_scores WHERE order_count > 0 AND ${stageFilter}
        )
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
          AND b.is_internal = 0
        GROUP BY month
        ORDER BY order_count DESC
    `).all();

    // Top priskategori
    const topCategory = db.prepare(`
        SELECT pc.code, COUNT(*) AS n
        FROM bons b
        JOIN customers cu ON cu.id = b.customer_id
        LEFT JOIN price_categories pc ON pc.id = b.price_category_id
        WHERE cu.company_id IN (
            SELECT company_id FROM rfm_scores WHERE order_count > 0 AND ${stageFilter}
        )
          AND (b.is_offer = 0 OR b.is_offer IS NULL)
          AND b.is_internal = 0
        GROUP BY pc.code
        ORDER BY n DESC
        LIMIT 1
    `).get();

    // Branch-dækning
    const coverageRow = db.prepare(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN branch IS NOT NULL THEN 1 ELSE 0 END) AS with_branch
        FROM companies WHERE is_active = 1
    `).get();
    const branchCoveragePct = coverageRow.total > 0
        ? Math.round(coverageRow.with_branch * 100 / coverageRow.total)
        : 0;

    return {
        source,
        ...profile,
        top_branches: branches,
        peak_months: seasonality.slice(0, 4).map(s => parseInt(s.month)),
        top_category: topCategory?.code || null,
        branch_coverage_pct: branchCoveragePct,
    };
}

module.exports = {
    ensurePersonalCompanies,
    getRfmConfig,
    computeRfmScores,
    computeIcpProfile,
};
