const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange, transaction } = require('../db/helpers');
const { enrich } = require('../services/cvrEnrichment');
const { buildCompanyDiff, FIELD_MAP } = require('../services/companyDiff');
const { syncPrimaryCache, validateContactValue } = require('../shared/contactPoints');
const { extractContacts } = require('../services/contactExtractor');

// GET /api/companies?q=
router.get('/', handle((req, res) => {
    const db = getDb();
    const q = req.query.q || '';
    if (q.length < 2) return res.json([]);
    const rows = db.prepare(`
        SELECT id, name, cvr, ean, phone, email,
               default_payment_type, default_price_category_id,
               discount_percent, invoice_method
        FROM companies
        WHERE is_active = 1
          AND (name LIKE '%'||?||'%'
            OR cvr LIKE '%'||?||'%'
            OR COALESCE(legal_name,'') LIKE '%'||?||'%'
            OR COALESCE(alternate_names,'') LIKE '%'||?||'%')
        ORDER BY name LIMIT 20
    `).all(q, q, q, q);
    res.json(rows);
}));

// GET /api/companies/:id
router.get('/:id', handle((req, res) => {
    const db = getDb();
    const row = db.prepare(`
        SELECT c.*, a.street_name, a.street_nr, a.postal_code, a.city
        FROM companies c
        LEFT JOIN addresses a ON c.address_id = a.id
        WHERE c.id = ?
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Ikke fundet' });
    res.json(row);
}));

// POST /api/companies — opret ny
router.post('/', handle((req, res) => {
    const db = getDb();
    const { name, cvr, ean, phone, email, invoice_method,
            default_payment_type, default_price_category_id, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Firmanavn mangler' });

    const result = db.prepare(`
        INSERT INTO companies (name, cvr, ean, phone, email, invoice_method,
                               default_payment_type, default_price_category_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, cvr || null, ean || null, phone || null, email || null,
           invoice_method || null, default_payment_type || null,
           default_price_category_id || null, notes || null);

    res.json({ id: result.lastInsertRowid });
}));

// PATCH /api/companies/:id/economic — opdater e-conomic firma-nr
router.patch('/:id/economic', handle((req, res) => {
    const db = getDb();
    const { id } = req.params;
    const { economic_customer_id } = req.body;

    const existing = db.prepare('SELECT economic_customer_id FROM companies WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Firma ikke fundet' });

    db.prepare('UPDATE companies SET economic_customer_id = ? WHERE id = ?')
      .run(economic_customer_id || null, id);

    logChange({
        entityType: 'company',
        entityId: Number(id),
        action: 'update',
        fieldName: 'economic_customer_id',
        oldValue: existing.economic_customer_id,
        newValue: economic_customer_id,
        userId: req.session?.user?.id,
    });

    res.json({ ok: true });
}));

// PATCH /api/companies/:id/identifiers — ret CVR / juridisk navn / EAN manuelt
// (UI'ets "Berig fra CVR" slår op på det gemte CVR — så et forkert CVR kan kun
//  rettes herfra. Efter rettelse kan brugeren berige fra det nye nummer.)
router.patch('/:id/identifiers', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ugyldigt firma-id' });

    const existing = db.prepare('SELECT cvr, legal_name, ean FROM companies WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Firma ikke fundet' });

    const body = req.body || {};
    const updates = {};

    // CVR: 8 cifre eller tom (rydder). Ikke-cifre frasorteres før validering.
    if (Object.prototype.hasOwnProperty.call(body, 'cvr')) {
        const raw = (body.cvr ?? '').toString().replace(/\D/g, '');
        if (raw !== '' && raw.length !== 8) {
            return res.status(400).json({ error: 'CVR skal være 8 cifre' });
        }
        updates.cvr = raw === '' ? null : raw;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'legal_name')) {
        const v = (body.legal_name ?? '').toString().trim();
        updates.legal_name = v === '' ? null : v;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'ean')) {
        const raw = (body.ean ?? '').toString().replace(/\D/g, '');
        if (raw !== '' && raw.length !== 13) {
            return res.status(400).json({ error: 'EAN skal være 13 cifre' });
        }
        updates.ean = raw === '' ? null : raw;
    }

    const keys = Object.keys(updates);
    if (keys.length === 0) {
        return res.status(400).json({ error: 'Ingen felter at opdatere (cvr, legal_name, ean)' });
    }

    transaction(db, () => {
        const setClauses = keys.map(k => `${k} = ?`);
        const args = keys.map(k => updates[k]);
        args.push(id);
        db.prepare(`UPDATE companies SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);

        for (const k of keys) {
            if ((existing[k] ?? null) === (updates[k] ?? null)) continue;
            logChange({
                entityType: 'company',
                entityId: id,
                action: 'update',
                fieldName: k,
                oldValue: existing[k],
                newValue: updates[k],
                userId: req.session?.user?.id ?? null,
                notes: 'manuel rettelse',
            });
        }
    });

    const updated = db.prepare('SELECT id, name, cvr, legal_name, ean FROM companies WHERE id = ?').get(id);
    res.json({ ok: true, company: updated });
}));

// GET /api/companies/:id/enrich-preview — kør enrichment uden at gemme
router.get('/:id/enrich-preview', handle(async (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!company) return res.status(404).json({ error: 'Firma ikke fundet' });

    // Hent eksisterende contact_points (til "already_exists"-markering i diff)
    const existingCps = db.prepare(`
        SELECT id, kind, value, source, is_public, is_primary, is_active
          FROM contact_points
         WHERE entity_type = 'company' AND entity_id = ? AND is_active = 1
    `).all(id);

    // Hent også kunde-emails for kendt-domæne lookup
    const customerEmail = db.prepare(`
        SELECT email FROM customers
         WHERE company_id = ? AND email IS NOT NULL AND TRIM(email) != ''
         LIMIT 1
    `).get(id)?.email;

    let result;
    try {
        result = await enrich({
            cvr: company.cvr,
            ean: company.ean,
            email: customerEmail,
            navn: company.name,
        });
    } catch (err) {
        console.error('CVR-enrichment fejlede:', err);
        return res.status(502).json({ error: 'Enrichment-service fejlede: ' + err.message });
    }

    if (!result.found) {
        return res.json({ found: false, besked: result.besked, low_match: result.low_match });
    }

    const diff = buildCompanyDiff(company, result, existingCps);
    res.json({
        found: true,
        konfidens: result.konfidens,
        kilde: result.kilde,
        diff,
    });
}));

// POST /api/companies/:id/enrich — anvend en delmængde af diff'en
router.post('/:id/enrich', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!company) return res.status(404).json({ error: 'Firma ikke fundet' });

    const {
        fields = [],
        contact_points = [],
        kilde = null,
        konfidens = null,
        proposed_data = {},   // udfyldte values fra diff (fx { legal_name: "...", industry: "..." })
    } = req.body || {};

    if (!Array.isArray(fields) || !Array.isArray(contact_points)) {
        return res.status(400).json({ error: 'fields og contact_points skal være arrays' });
    }

    // Whitelist: kun writable felter må opdateres
    const writableKeys = new Set(FIELD_MAP.filter(f => f.writable).map(f => f.key));
    const validFields = fields.filter(k => writableKeys.has(k));

    let fieldsUpdated = 0;
    let cpsCreated = 0;
    let cpsTouched = 0;

    transaction(db, () => {
        // Opdater felter
        if (validFields.length > 0) {
            const setClauses = [];
            const args = [];
            for (const key of validFields) {
                const newVal = proposed_data[key];
                if (newVal === undefined) continue;
                const oldVal = company[key];
                // Skriv også selvom værdien er identisk — så last_enriched_at flyttes,
                // men changelog kun ved reel ændring
                setClauses.push(`${key} = ?`);
                args.push(newVal === null || newVal === '' ? null : newVal);
                if (oldVal !== newVal && (oldVal ?? null) !== (newVal ?? null)) {
                    logChange({
                        entityType: 'company',
                        entityId: id,
                        action: 'enrich',
                        fieldName: key,
                        oldValue: oldVal,
                        newValue: newVal,
                        userId: req.session?.user?.id ?? null,
                        notes: `kilde=${kilde || 'ukendt'} konfidens=${konfidens || ''}`,
                    });
                    fieldsUpdated++;
                }
            }
            if (setClauses.length > 0) {
                args.push(id);
                db.prepare(`UPDATE companies SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);
            }
        }

        // Opdater last_enriched_at + source uanset om der var feltændringer
        db.prepare(`
            UPDATE companies
               SET last_enriched_at = CURRENT_TIMESTAMP,
                   last_enriched_source = ?,
                   updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(kilde || null, id);

        // Tilføj contact_points
        for (const cp of contact_points) {
            if (!cp || !cp.kind || !cp.value) continue;
            if (cp.kind !== 'email' && cp.kind !== 'phone') continue;

            const validation = validateContactValue(cp.kind, cp.value);
            if (!validation.ok) continue;

            const existing = db.prepare(`
                SELECT id, is_active FROM contact_points
                 WHERE entity_type = 'company' AND entity_id = ? AND kind = ? AND value = ?
            `).get(id, cp.kind, validation.normalized);

            const isPub = cp.is_public !== undefined ? (cp.is_public ? 1 : 0) : 1;

            if (existing) {
                // Idempotent: opdatér verified_at + sæt source=cvr hvis den var manuel
                db.prepare(`
                    UPDATE contact_points
                       SET source = CASE WHEN source = 'manual' THEN 'cvr' ELSE source END,
                           is_public = ?,
                           verified_at = CURRENT_TIMESTAMP,
                           last_seen_at = CURRENT_TIMESTAMP,
                           is_active = 1,
                           updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?
                `).run(isPub, existing.id);
                cpsTouched++;
            } else {
                db.prepare(`
                    INSERT INTO contact_points
                        (entity_type, entity_id, kind, value, source, is_public, is_primary, verified_at, last_seen_at)
                    VALUES ('company', ?, ?, ?, 'cvr', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).run(id, cp.kind, validation.normalized, isPub);
                cpsCreated++;
            }
            logChange({
                entityType: 'company',
                entityId: id,
                action: existing ? 'enrich_cp_touch' : 'enrich_cp_create',
                fieldName: cp.kind,
                newValue: validation.normalized,
                userId: req.session?.user?.id ?? null,
                notes: `source=cvr public=${isPub}`,
            });
        }
    });

    const updated = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    res.json({
        ok: true,
        fields_updated: fieldsUpdated,
        contact_points_created: cpsCreated,
        contact_points_updated: cpsTouched,
        company: updated,
    });
}));

// POST /api/companies/:id/extract-contacts — paste-flow til offentlige kontakter (Fase 4)
router.post('/:id/extract-contacts', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Ugyldigt firma-id' });

    const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(id);
    if (!company) return res.status(404).json({ error: 'Firma ikke fundet' });

    const { text, source_url } = req.body || {};
    if (typeof text !== 'string') {
        return res.status(400).json({ error: 'text skal være en streng' });
    }
    if (text.length < 50) {
        return res.status(400).json({ error: 'Indhold for kort (mindst 50 tegn)' });
    }
    if (text.length > 500 * 1024) {
        return res.status(413).json({ error: 'Indhold for stort (max 500 KB)' });
    }

    const result = extractContacts({ text, sourceUrl: source_url });
    if (!result.ok) {
        return res.json({ ok: false, source_url: result.source_url, candidates: [], stats: result.stats });
    }

    // Krydsreferér mod eksisterende contact_points på firmaet
    const existingCps = db.prepare(`
        SELECT id, kind, lower(value) AS value, is_public
          FROM contact_points
         WHERE entity_type = 'company' AND entity_id = ? AND is_active = 1
    `).all(id);
    const existingByKey = new Map();
    for (const cp of existingCps) existingByKey.set(`${cp.kind}:${cp.value}`, cp);

    const candidates = result.candidates.map(c => {
        const key = `${c.kind}:${c.value.toLowerCase()}`;
        const existing = existingByKey.get(key);
        return {
            ...c,
            already_exists: !!existing,
            existing_id: existing?.id,
            existing_is_public: existing?.is_public,
        };
    });

    res.json({
        ok: true,
        source_url: result.source_url,
        candidates,
        stats: result.stats,
    });
}));

module.exports = router;
