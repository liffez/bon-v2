// routes/admin-batch-enrich.js
// ==========================================
// Fase 7: Batch CVR-berigelse — admin-only.
//
// Finder firmaer der ikke er beriget de sidste N dage og kører
// services/cvrEnrichment.enrich() på hver. Eksisterende felter
// røres IKKE — kun tomme felter udfyldes. Kontaktpunkter fra CVR
// markeres automatisk som offentlige (PUB).
//
// Kun ét batch-job kan køre ad gangen (lock i settings.batch_enrich_running).
// Cancel via POST /cancel sætter et in-memory flag der tjekkes mellem
// firmaer. Lock auto-frigives efter 30 min hvis processen crasher.
//
// SSE-events:
//   batch_enrich_started   { total }
//   batch_enrich_progress  { current, total, company_id, status }
//   batch_enrich_done      { processed, matched, no_match, fields_updated, ... }
// ==========================================

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, transaction, logChange } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');
const { enrich } = require('../services/cvrEnrichment');
const { buildCompanyDiff, FIELD_MAP } = require('../services/companyDiff');

router.use(requireAuth('admin'));

// ─── In-memory state ───────────────────────────────────────────

let _job = null;   // { running, cancelRequested, summary, startedAt, proposals }
                   // proposals: array af { company_id, name, kilde, konfidens, fields, contact_points }

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 min

function getSetting(db, key) {
    return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}
function setSetting(db, key, value) {
    const exists = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
    if (exists) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(value ?? '', key);
    else        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value ?? '');
}

function lockHeld(db) {
    const ts = getSetting(db, 'batch_enrich_running');
    if (!ts) return false;
    const startedAt = parseInt(ts, 10);
    if (!Number.isFinite(startedAt)) return false;
    if (Date.now() - startedAt > LOCK_TTL_MS) {
        // Stale lock — auto-release
        setSetting(db, 'batch_enrich_running', '');
        return false;
    }
    return true;
}

function acquireLock(db) {
    setSetting(db, 'batch_enrich_running', String(Date.now()));
}
function releaseLock(db) {
    setSetting(db, 'batch_enrich_running', '');
}

// ─── GET /status ──────────────────────────────────────────────

router.get('/status', handle((req, res) => {
    const db = getDb();
    const held = lockHeld(db);
    res.json({
        running: !!_job?.running,
        lock_held: held,
        summary: _job?.summary ?? null,
        started_at: _job?.startedAt ?? null,
        cancel_requested: !!_job?.cancelRequested,
    });
}));

// ─── POST / — start batch ─────────────────────────────────────

router.post('/', handle(async (req, res) => {
    const db = getDb();
    if (lockHeld(db) || _job?.running) {
        return res.status(409).json({ error: 'Et batch-job kører allerede.' });
    }
    const maxAgeDays = parseInt(req.body?.max_age_days, 10) || 90;
    const dryRun = !!req.body?.dry_run;
    const limit = parseInt(req.body?.limit, 10) || null;
    const userId = req.session?.user?.id ?? null;

    // Find firmaer
    let candidatesSql = `
        SELECT id, name, cvr, ean,
               (SELECT email FROM customers c
                 WHERE c.company_id = co.id AND c.email IS NOT NULL AND TRIM(c.email) != ''
                 LIMIT 1) AS hint_email
          FROM companies co
         WHERE co.is_active = 1
           AND co.is_internal = 0
           AND (co.last_enriched_at IS NULL
                OR co.last_enriched_at < datetime('now', '-' || ? || ' days'))
         ORDER BY (co.cvr IS NOT NULL OR co.ean IS NOT NULL) DESC,
                  co.id ASC
    `;
    const args = [maxAgeDays];
    if (limit) { candidatesSql += ' LIMIT ?'; args.push(limit); }
    const candidates = db.prepare(candidatesSql).all(...args);

    if (candidates.length === 0) {
        return res.json({
            ok: true, total: 0, processed: 0, matched: 0, no_match: 0,
            besked: 'Ingen firmaer at berige.',
        });
    }

    // Acquire lock + start background job
    acquireLock(db);
    _job = {
        running: true,
        cancelRequested: false,
        startedAt: new Date().toISOString(),
        proposals: [],   // udfyldes per matchet firma — bruges af /proposals + /apply
        summary: {
            total: candidates.length, processed: 0, matched: 0, no_match: 0,
            fields_updated: 0, contact_points_created: 0, errors: 0,
            dry_run: dryRun, max_age_days: maxAgeDays,
        },
    };

    // Fyr svar af med det samme — selve jobbet kører i baggrunden
    res.json({
        ok: true,
        started: true,
        total: candidates.length,
        dry_run: dryRun,
        max_age_days: maxAgeDays,
    });

    broadcast('batch_enrich_started', { total: candidates.length, dry_run: dryRun });

    // ── Kør jobbet ──
    try {
        const writableKeys = new Set(FIELD_MAP.filter(f => f.writable).map(f => f.key));

        for (let i = 0; i < candidates.length; i++) {
            if (_job.cancelRequested) break;
            const co = candidates[i];

            let result;
            try {
                result = await enrich({
                    cvr: co.cvr, ean: co.ean, email: co.hint_email, navn: co.name,
                });
            } catch (err) {
                console.error(`[batch-enrich] enrich fejlede for #${co.id}:`, err.message);
                _job.summary.errors++;
                _job.summary.processed++;
                broadcast('batch_enrich_progress', {
                    current: _job.summary.processed, total: candidates.length,
                    company_id: co.id, status: 'error',
                });
                continue;
            }

            if (!result?.found) {
                _job.summary.no_match++;
                _job.summary.processed++;
                broadcast('batch_enrich_progress', {
                    current: _job.summary.processed, total: candidates.length,
                    company_id: co.id, status: 'no_match',
                });
                continue;
            }

            _job.summary.matched++;

            // Byg diff for både dry-run og live — så vi altid har et forslag at vise
            const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(co.id);
            const existingCps = db.prepare(`
                SELECT id, kind, value, source, is_public, is_primary, is_active
                  FROM contact_points
                 WHERE entity_type='company' AND entity_id=? AND is_active=1
            `).all(co.id);
            const diff = buildCompanyDiff(company, result, existingCps);

            // Filtrér til kun de "udfyld-tomt"-felter — det er det batch foreslår
            const proposalFields = [];
            for (const f of diff.fields) {
                if (!f.writable) continue;
                if (!writableKeys.has(f.key)) continue;
                const currentEmpty = f.current === null || f.current === undefined || f.current === '';
                const hasProposed = f.proposed !== null && f.proposed !== undefined && f.proposed !== '';
                if (currentEmpty && hasProposed) {
                    proposalFields.push({ key: f.key, label: f.label, proposed: f.proposed });
                }
            }
            const proposalCps = (diff.contact_points || []).filter(cp => !cp.already_exists);

            // Gem altid forslaget (også i live-mode — så review-UI'en kan vise hvad der blev gjort)
            _job.proposals.push({
                company_id: co.id,
                name: company.name,
                cvr: company.cvr,
                ean: company.ean,
                kilde: result.kilde,
                konfidens: result.konfidens,
                fields: proposalFields,
                contact_points: proposalCps,
            });

            if (!dryRun) {
                // Live-mode: anvend forslaget med det samme
                try {
                    const applyResult = _applyProposalForCompany(db, co.id, {
                        fields: proposalFields.map(f => f.key),
                        contact_points: proposalCps,
                        kilde: result.kilde,
                        konfidens: result.konfidens,
                        proposed_data: Object.fromEntries(proposalFields.map(f => [f.key, f.proposed])),
                        userId,
                    });
                    _job.summary.fields_updated += applyResult.fields_updated;
                    _job.summary.contact_points_created += applyResult.cps_created;
                } catch (err) {
                    console.error(`[batch-enrich] save fejlede for #${co.id}:`, err.message);
                    _job.summary.errors++;
                }
            }

            _job.summary.processed++;
            broadcast('batch_enrich_progress', {
                current: _job.summary.processed,
                total: candidates.length,
                company_id: co.id,
                status: 'matched',
                kilde: result.kilde,
                konfidens: result.konfidens,
            });

            // Lille pause så vi ikke hamrer Virk ES
            await new Promise(r => setTimeout(r, 200));
        }
    } catch (err) {
        console.error('[batch-enrich] fatal:', err);
    } finally {
        _job.running = false;
        const finalSummary = { ..._job.summary, cancelled: _job.cancelRequested, completed_at: new Date().toISOString() };
        broadcast('batch_enrich_done', finalSummary);
        releaseLock(db);
    }
}));

// ─── Helper: anvend ét forslag på ét firma ────────────────────
//
// Kaldes både fra live batch-mode og fra POST /apply (efter dry-run review).
// Returnerer { fields_updated, cps_created }.

function _applyProposalForCompany(db, companyId, p) {
    let fieldsUpdated = 0;
    let cpsCreated = 0;
    const writableKeys = new Set(FIELD_MAP.filter(f => f.writable).map(f => f.key));

    transaction(db, () => {
        const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
        if (!company) throw new Error(`Firma #${companyId} findes ikke`);

        const setClauses = [];
        const args = [];
        for (const key of (p.fields || [])) {
            if (!writableKeys.has(key)) continue;
            const newVal = p.proposed_data?.[key];
            if (newVal === undefined || newVal === null || newVal === '') continue;
            const oldVal = company[key];
            const oldEmpty = oldVal === null || oldVal === undefined || oldVal === '';
            // Beskytter mod overskrivning af eksisterende data — batch må kun udfylde tomme felter
            if (!oldEmpty) continue;
            setClauses.push(`${key} = ?`);
            args.push(newVal);
            fieldsUpdated++;
            logChange({
                entityType: 'company', entityId: companyId,
                action: 'enrich', fieldName: key,
                oldValue: null, newValue: newVal,
                userId: p.userId ?? null,
                notes: `batch kilde=${p.kilde || ''} konfidens=${p.konfidens || ''}`,
            });
        }
        // Altid sæt last_enriched_at + source
        setClauses.push('last_enriched_at = CURRENT_TIMESTAMP');
        setClauses.push('last_enriched_source = ?');
        args.push(p.kilde || null);
        args.push(companyId);
        db.prepare(`UPDATE companies SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);

        for (const cp of (p.contact_points || [])) {
            if (!cp || !cp.kind || !cp.value) continue;
            const dup = db.prepare(`
                SELECT id FROM contact_points
                 WHERE entity_type='company' AND entity_id=? AND kind=? AND lower(value)=lower(?)
            `).get(companyId, cp.kind, cp.value);
            if (dup) continue;
            db.prepare(`
                INSERT INTO contact_points
                    (entity_type, entity_id, kind, value, source,
                     is_public, is_primary, verified_at, last_seen_at)
                VALUES ('company', ?, ?, ?, 'cvr', 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(companyId, cp.kind, cp.value);
            cpsCreated++;
            logChange({
                entityType: 'company', entityId: companyId,
                action: 'enrich_cp_create', fieldName: cp.kind,
                newValue: cp.value, userId: p.userId ?? null,
                notes: 'batch source=cvr public=1',
            });
        }
    });

    return { fields_updated: fieldsUpdated, cps_created: cpsCreated };
}

// ─── GET /proposals ───────────────────────────────────────────
//
// Returnerer alle forslag fra det seneste job (dry-run såvel som live).
// Bruges af review-UI til at vise hvad batch ville/lige har gjort.

router.get('/proposals', handle((req, res) => {
    if (!_job) return res.json({ proposals: [], summary: null });
    res.json({
        proposals: _job.proposals || [],
        summary: _job.summary,
        started_at: _job.startedAt,
        running: _job.running,
    });
}));

// ─── POST /apply ──────────────────────────────────────────────
//
// Anvender et udvalg af forslag fra det seneste dry-run.
// Body: { selections: [{ company_id, fields: ['legal_name'], contact_points: [{kind,value}] }] }
// Felter-array er en delmængde af forslagets fields. Tilsvarende for cps.

router.post('/apply', handle(async (req, res) => {
    const db = getDb();
    if (!_job || !_job.proposals || _job.proposals.length === 0) {
        return res.status(400).json({ error: 'Ingen forslag at anvende. Kør dry-run først.' });
    }
    if (_job.running) {
        return res.status(409).json({ error: 'Et batch-job kører — vent til det er færdigt.' });
    }

    const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
    if (selections.length === 0) {
        return res.status(400).json({ error: 'Ingen valgte forslag.' });
    }

    // Indeksér originale forslag
    const proposalsById = new Map(_job.proposals.map(p => [p.company_id, p]));

    let totalFields = 0, totalCps = 0, errors = 0, applied = 0;
    const userId = req.session?.user?.id ?? null;

    for (const sel of selections) {
        const orig = proposalsById.get(sel.company_id);
        if (!orig) continue;
        // Filtrér til kun valgte
        const allowedFieldKeys = new Set(orig.fields.map(f => f.key));
        const fieldKeys = (sel.fields || []).filter(k => allowedFieldKeys.has(k));
        const proposed_data = Object.fromEntries(orig.fields.filter(f => fieldKeys.includes(f.key)).map(f => [f.key, f.proposed]));
        const cpKeys = new Set((sel.contact_points || []).map(c => `${c.kind}:${(c.value || '').toLowerCase()}`));
        const cps = orig.contact_points.filter(c => cpKeys.has(`${c.kind}:${(c.value || '').toLowerCase()}`));

        if (fieldKeys.length === 0 && cps.length === 0) continue;

        try {
            const r = _applyProposalForCompany(db, orig.company_id, {
                fields: fieldKeys,
                contact_points: cps,
                proposed_data,
                kilde: orig.kilde,
                konfidens: orig.konfidens,
                userId,
            });
            totalFields += r.fields_updated;
            totalCps += r.cps_created;
            applied++;
        } catch (err) {
            console.error(`[batch-apply] firma #${orig.company_id} fejlede:`, err.message);
            errors++;
        }
    }

    // Ryd forslagene efter apply, så review-UI ikke viser stale data
    _job.proposals = [];

    res.json({
        ok: true,
        applied,
        fields_updated: totalFields,
        contact_points_created: totalCps,
        errors,
    });
}));

// ─── POST /cancel ─────────────────────────────────────────────

router.post('/cancel', handle((req, res) => {
    if (!_job?.running) {
        return res.status(409).json({ error: 'Intet job kører.' });
    }
    _job.cancelRequested = true;
    res.json({ ok: true, cancel_requested: true });
}));

module.exports = router;
