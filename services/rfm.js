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

// ─── Prospekt-fit (CRM Prospekter) ──────────────────────────
// Gradueret ICP-fit for lead-firmaer ud fra tre signaler:
//   branche-match (vægtet efter VIP-andel), firmastørrelse (blød),
//   leveringsafstand (fugleflugt fra HQ). Kører server-side så Indsigt
//   og Prospekter deler kilde. Vægte/filtre konfigureres via settings
//   (migration 105) — få knapper nu, klar til flere senere.

const EARTH_KM = 6371;
const RAD = Math.PI / 180;
// Reference-afstand: emner inden for så mange km får fuld afstands-score,
// derover aftager den lineært til 0. Stor-København-skala.
const DISTANCE_DECAY_KM = 25;

function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * RAD;
    const dLon = (lon2 - lon1) * RAD;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** HQ-koordinater fra settings (samme kilde som delivery-modulet). */
function getHqCoords(db) {
    const rows = db.prepare(
        "SELECT key, value FROM settings WHERE key IN ('delivery_hq_lat','delivery_hq_lon')"
    ).all();
    const m = {};
    for (const r of rows) m[r.key] = r.value;
    const lat = Number(m.delivery_hq_lat);
    const lon = Number(m.delivery_hq_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
}

/** Prospekt-fit konfiguration fra settings (vægte + filtre). */
function getProspectFitConfig(db) {
    const rows = db.prepare(`
        SELECT key, value FROM settings WHERE key IN (
            'prospect_fit_w_branch','prospect_fit_w_size','prospect_fit_w_distance',
            'prospect_distance_max_km','prospect_branch_blacklist'
        )`).all();
    const m = {};
    for (const r of rows) m[r.key] = r.value;

    let blacklist = [];
    try {
        const parsed = JSON.parse(m.prospect_branch_blacklist || '[]');
        if (Array.isArray(parsed)) blacklist = parsed.filter(Boolean).map(s => String(s));
    } catch { /* ignorér ugyldig JSON → ingen blacklist */ }

    const rawMax = m.prospect_distance_max_km;
    const maxKm = rawMax != null && String(rawMax).trim() !== '' ? parseFloat(rawMax) : null;

    return {
        w_branch: parseFloat(m.prospect_fit_w_branch) || 50,
        w_size: parseFloat(m.prospect_fit_w_size) || 20,
        w_distance: parseFloat(m.prospect_fit_w_distance) || 30,
        distance_max_km: Number.isFinite(maxKm) && maxKm > 0 ? maxKm : null,
        branch_blacklist: blacklist,
    };
}

/**
 * Reference-profil af VIP-firmaer brugt til fit-scoring:
 *  - shares: branche → andel (0..1) af VIP-firmaer i den branche
 *  - maxShare: største branche-andel (til normalisering)
 *  - avgEmployees: gns. antal ansatte blandt VIP'er (til størrelses-match)
 */
function getVipReference(db) {
    const branchRows = db.prepare(`
        SELECT c.branch AS branch, COUNT(*) AS n
        FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id
        WHERE s.stage = 'vip' AND s.order_count > 0 AND c.branch IS NOT NULL
        GROUP BY c.branch
    `).all();

    const totalBranch = branchRows.reduce((a, r) => a + r.n, 0);
    const shares = {};
    let maxShare = 0;
    for (const r of branchRows) {
        const sh = totalBranch ? r.n / totalBranch : 0;
        shares[r.branch] = sh;
        if (sh > maxShare) maxShare = sh;
    }

    const avgRow = db.prepare(`
        SELECT AVG(c.employee_count) AS avg_emp
        FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id
        WHERE s.stage = 'vip' AND s.order_count > 0
          AND c.employee_count IS NOT NULL AND c.employee_count > 0
    `).get();

    return { shares, maxShare, avgEmployees: avgRow?.avg_emp || null };
}

/**
 * Beregn fit-breakdown for ét lead mod VIP-reference + HQ.
 * Hvert signal er enten et tal 0..1 eller null (= mangler → udelades fra
 * vægtningen, så manglende data ikke straffer). Branche er altid til stede
 * (0 = ingen match er informativt). Returnerer { fit, branch, size, distance, distance_km }.
 */
function scoreProspect(lead, ref, hq, cfg) {
    // Branche: andel hos VIP normaliseret så den hyppigste VIP-branche = 1.0
    let branch = 0;
    if (lead.branch && ref.maxShare > 0 && ref.shares[lead.branch]) {
        branch = ref.shares[lead.branch] / ref.maxShare;
    }

    // Størrelse: blød nærhed til VIP-gennemsnit (skalafri, peak ved ratio=1)
    let size = null;
    if (lead.employee_count > 0 && ref.avgEmployees > 0) {
        const ratio = lead.employee_count / ref.avgEmployees;
        size = 1 / (1 + Math.abs(Math.log(ratio)));
    }

    // Afstand: fugleflugt fra HQ, lineært aftagende til DISTANCE_DECAY_KM
    let distance = null;
    let distance_km = null;
    if (hq && Number.isFinite(lead.lat) && Number.isFinite(lead.lon)) {
        distance_km = haversineKm(hq.lat, hq.lon, lead.lat, lead.lon);
        distance = Math.max(0, 1 - distance_km / DISTANCE_DECAY_KM);
    }

    // Vægtet gennemsnit over de signaler der faktisk er til stede
    const parts = [
        { v: branch, w: cfg.w_branch },
        { v: size, w: cfg.w_size },
        { v: distance, w: cfg.w_distance },
    ].filter(p => p.v != null && p.w > 0);

    const wSum = parts.reduce((a, p) => a + p.w, 0);
    const fit = wSum > 0 ? Math.round(parts.reduce((a, p) => a + p.v * p.w, 0) / wSum * 100) : 0;

    return {
        fit,
        branch: Math.round(branch * 100),
        size: size == null ? null : Math.round(size * 100),
        distance: distance == null ? null : Math.round(distance * 100),
        distance_km: distance_km == null ? null : Math.round(distance_km * 10) / 10,
    };
}

/**
 * Hent lead-firmaer med gradueret ICP-fit.
 * opts: { q?, maxKm? } — maxKm overstyrer settings-filteret (UI-slider).
 * Returnerer { rows, meta } hvor meta beskriver scoring-grundlaget.
 */
function computeProspectScores(opts = {}) {
    const db = getDb();
    const cfg = getProspectFitConfig(db);
    const ref = getVipReference(db);
    const hq = getHqCoords(db);

    // Afstands-filter: eksplicit opts.maxKm vinder over settings-default
    let maxKm = cfg.distance_max_km;
    if (opts.maxKm != null && String(opts.maxKm).trim() !== '') {
        const m = parseFloat(opts.maxKm);
        maxKm = Number.isFinite(m) && m > 0 ? m : null;
    }

    const params = [];
    let searchWhere = '';
    if (opts.q) {
        searchWhere = ' AND (c.name LIKE ? OR c.branch LIKE ? OR c.cvr LIKE ?)';
        params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
    }

    const leads = db.prepare(`
        SELECT s.*, c.name, c.cvr, c.branch, c.employee_count, c.company_type,
               c.is_personal, c.phone AS company_phone, c.email AS company_email,
               a.lat AS lat, a.lon AS lon,
               (SELECT first_name || ' ' || COALESCE(last_name,'')
                FROM customers WHERE company_id = c.id AND is_active = 1
                ORDER BY is_primary_contact DESC LIMIT 1) AS primary_contact_name,
               (SELECT phone FROM customers WHERE company_id = c.id AND is_active = 1
                ORDER BY is_primary_contact DESC LIMIT 1) AS primary_contact_phone,
               (SELECT id FROM customers WHERE company_id = c.id AND is_active = 1
                ORDER BY is_primary_contact DESC LIMIT 1) AS primary_customer_id
        FROM rfm_scores s
        JOIN companies c ON c.id = s.company_id
        LEFT JOIN addresses a ON a.id = c.address_id
        WHERE s.stage = 'lead'
          AND c.is_active = 1
          AND c.is_personal = 0
          ${searchWhere}
    `).all(...params);

    const blacklist = new Set(cfg.branch_blacklist);
    const rows = [];
    let hiddenBlacklist = 0;
    let hiddenDistance = 0;
    let hiddenNoCoords = 0;

    for (const lead of leads) {
        if (lead.branch && blacklist.has(lead.branch)) { hiddenBlacklist++; continue; }

        const sc = scoreProspect(lead, ref, hq, cfg);

        if (maxKm != null) {
            // Distance-filter aktivt: kun firmaer vi kan bekræfte er i range.
            if (sc.distance_km == null) { hiddenNoCoords++; continue; }
            if (sc.distance_km > maxKm) { hiddenDistance++; continue; }
        }

        lead.icp_fit = sc.fit;
        lead.fit_breakdown = { branch: sc.branch, size: sc.size, distance: sc.distance };
        lead.distance_km = sc.distance_km;
        delete lead.lat;
        delete lead.lon;
        rows.push(lead);
    }

    // Sortér: bedste fit først, derefter nærmest (kendt afstand før ukendt)
    rows.sort((a, b) => {
        if ((b.icp_fit || 0) !== (a.icp_fit || 0)) return (b.icp_fit || 0) - (a.icp_fit || 0);
        const da = a.distance_km == null ? Infinity : a.distance_km;
        const dbb = b.distance_km == null ? Infinity : b.distance_km;
        return da - dbb;
    });

    return {
        rows,
        meta: {
            total: rows.length,
            distance_max_km: maxKm,
            hq_available: !!hq,
            vip_branch_count: Object.keys(ref.shares).length,
            vip_avg_employees: ref.avgEmployees == null ? null : Math.round(ref.avgEmployees),
            with_distance: rows.filter(r => r.distance_km != null).length,
            hidden_blacklist: hiddenBlacklist,
            hidden_distance: hiddenDistance,
            hidden_no_coords: hiddenNoCoords,
            weights: { branch: cfg.w_branch, size: cfg.w_size, distance: cfg.w_distance },
            blacklist: cfg.branch_blacklist,
        },
    };
}

module.exports = {
    ensurePersonalCompanies,
    getRfmConfig,
    computeRfmScores,
    computeIcpProfile,
    getProspectFitConfig,
    getVipReference,
    getHqCoords,
    haversineKm,
    scoreProspect,
    computeProspectScores,
};
