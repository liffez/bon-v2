const express    = require('express');
const router     = express.Router();
const { getDb }  = require('../db/database');
const { handle, getUserId, logChange, transaction } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');
const { deactivateCompanies } = require('../services/companyCleanup');
const { logActivity, purposeIdByKey } = require('../services/crmActivity');

// GET /api/customers?q=&company_id=
router.get('/', handle((req, res) => {
    const db = getDb();
    const { q, company_id } = req.query;

    let where = 'WHERE c.is_active = 1';
    const args = [];

    if (q && q.length >= 2) {
        where += ` AND (
            c.first_name LIKE '%'||?||'%' OR
            c.last_name  LIKE '%'||?||'%' OR
            c.email      LIKE '%'||?||'%' OR
            co.name      LIKE '%'||?||'%' OR
            co.cvr       LIKE '%'||?||'%'
        )`;
        args.push(q, q, q, q, q);
    }

    if (company_id) {
        where += ' AND c.company_id = ?';
        args.push(parseInt(company_id));
    }

    res.json(db.prepare(`
        SELECT
            c.id AS customer_id,
            c.first_name, c.last_name,
            c.phone, c.email,
            co.id AS company_id,
            co.name AS company_name,
            co.cvr, co.ean,
            co.default_payment_type,
            co.default_price_category_id,
            co.discount_percent,
            a.city AS company_city
        FROM customers c
        LEFT JOIN companies co ON c.company_id = co.id
        LEFT JOIN addresses  a  ON co.address_id = a.id
        ${where}
        ORDER BY co.name, c.last_name, c.first_name
        LIMIT 20
    `).all(...args));
}));

// POST /api/customers — opret ny
router.post('/', handle((req, res) => {
    const db = getDb();
    const { first_name, last_name, phone, email, company_id, notes } = req.body;
    if (!first_name) return res.status(400).json({ error: 'Fornavn mangler' });

    const result = db.prepare(`
        INSERT INTO customers (first_name, last_name, phone, email, company_id, notes)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(first_name, last_name || null, phone || null, email || null,
           company_id || null, notes || null);

    res.json({ id: result.lastInsertRowid });
}));

// GET /api/customers/:id
router.get('/:id', handle((req, res) => {
    const db = getDb();
    const c = db.prepare(`
        SELECT c.*, co.name AS company_name, co.cvr, co.ean, co.invoice_method
        FROM customers c LEFT JOIN companies co ON c.company_id = co.id
        WHERE c.id = ?
    `).get(parseInt(req.params.id));
    if (!c) return res.status(404).json({ error: 'Kunde ikke fundet' });

    c.recent_bons = db.prepare(`
        SELECT b.id, b.bon_number, b.delivery_date, sd.code AS status_code, b.total_units
        FROM bons b JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.customer_id = ? ORDER BY b.delivery_date DESC LIMIT 10
    `).all(c.id);

    res.json(c);
}));

// PATCH /api/customers/:id   { first_name?, last_name?, company_id? }
//
// Retteventilen for en kontaktperson. Indtil nu kunne hverken navnet eller
// firmaet ændres: der fandtes kun /economic, /stage og /consent, og company_id
// kunne kun flyttes af merge-guiden (som kræver TO firmaer) eller af et script.
//
// Det ramte hver gang "Opret som lead" havde gættet — leadet får mailens
// afsendernavn og INTET firma (createPrivateLead), så en mail fra
// "Communication <communication@iuno.law>" blev til en kontakt ved navn
// Communication uden forbindelse til det IUNO-firma vi allerede kendte.
// Eneste udvej var at oprette personen forfra og lade leadet ligge.
//
// requireAuth() og ikke admin — samme begrundelse som mailtrådens /move: den
// der opdager at en kontakt sidder forkert, skal kunne rette det med det samme.
router.patch('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = getUserId(req);

    const cust = db.prepare(`
        SELECT c.id, c.first_name, c.last_name, c.company_id, co.is_personal
        FROM customers c LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.id = ? AND c.is_active = 1
    `).get(id);
    if (!cust) return res.status(404).json({ error: 'Kunde ikke fundet' });

    // Feltnavnet interpoleres ind i UPDATE'en nedenfor. Nøglerne kan kun komme
    // herfra og er dermed lukkede — men listen står eksplicit, så en fremtidig
    // udvidelse ikke kan åbne hullet ved et uheld (samme greb som SORT_WHITELIST
    // i routes/bons.js).
    const EDITABLE = ['first_name', 'last_name', 'company_id'];

    const b = req.body || {};
    const patch = {};

    if (b.first_name !== undefined) {
        const v = String(b.first_name || '').trim();
        // Fornavnet er kundens identitet i enhver liste og på enhver bon. Et tomt
        // felt ville efterlade en navnløs række der kun kan findes på sit id.
        if (!v) return res.status(400).json({ error: 'Fornavn må ikke være tomt' });
        patch.first_name = v;
    }
    if (b.last_name !== undefined) patch.last_name = String(b.last_name || '').trim() || null;

    if (b.company_id !== undefined) {
        if (b.company_id === null || b.company_id === '') {
            patch.company_id = null;                    // privatkunde
        } else {
            const cid = parseInt(b.company_id);
            if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Ugyldigt firma' });
            const co = db.prepare('SELECT id FROM companies WHERE id = ? AND is_active = 1').get(cid);
            if (!co) return res.status(400).json({ error: 'Firma ikke fundet' });
            patch.company_id = cid;
        }
    }

    // Kun felter der faktisk flytter sig. Ellers ville et Gem uden ændringer
    // fylde historikken med rækker der intet fortæller.
    const changed = Object.keys(patch).filter(k => (patch[k] ?? null) !== (cust[k] ?? null));
    if (!changed.length) return res.json({ ok: true, changed: [], company_cleanup: null });

    const oldCompanyId = cust.company_id;
    let cleanup = null;

    transaction(db, () => {
        for (const field of changed) {
            if (!EDITABLE.includes(field)) continue;   // kan ikke ske — se EDITABLE
            db.prepare(`UPDATE customers SET ${field} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(patch[field], id);
            logChange({
                entityType: 'customer', entityId: id, action: 'update',
                fieldName: field,
                oldValue: cust[field] == null ? null : String(cust[field]),
                newValue: patch[field] == null ? null : String(patch[field]),
                userId,
                notes: field !== 'company_id' ? null
                    : (patch.company_id == null ? 'fjernet fra firmaet — er nu privatkunde'
                                                : 'flyttet til andet firma'),
            });
        }

        // Efterlader vi et PERSONLIGT firma tomt, lægges det væk. De rækker er
        // ikke tastet af nogen — ensurePersonalCompanies (services/rfm.js) laver
        // et pr. kunde uden firma, så uden dette hober de sig op som spøgelser
        // med den flyttede persons navn.
        //
        // Kun is_personal. Et RIGTIGT firma må aldrig forsvinde som bivirkning
        // af at en kontaktperson flyttes — dertil findes CRM → Værktøjer →
        // "Ryd tomme firmaer", hvor det er en bevidst handling. deactivateCompanies
        // gentjekker desuden hele tom-reglen, så en bon eller en mailtråd på
        // rækken freder den.
        if (changed.includes('company_id') && oldCompanyId && cust.is_personal) {
            cleanup = deactivateCompanies(db, [oldCompanyId], userId);
        }
    });

    broadcast('customer_updated', { customer_id: id, changed });
    res.json({ ok: true, changed, company_cleanup: cleanup });
}));


// ─── LUK / GENDAN EN KONTAKTPERSON ─────────────────────────────
//
// customers.is_active har eksisteret siden 001 og filtreres på i hver eneste
// CRM-liste — men INGEN skærm kunne sætte den til 0. Kun scripts og
// merge-guiden kunne lukke en række, så en kontaktperson tilføjet ved en fejl
// kunne aldrig fjernes igen. Danner-firmaet viser prisen: fire dubletter
// (ida@danner.dl er en tastefejl i domænet, Eline Østergaard står to gange),
// som ingen kunne rydde op i uden SQL.
//
// Lukning er is_active = 0, aldrig DELETE — samme konvention som firmaer,
// leverandører og kontaktpunkter. Bons, tilbud og mailtråde peger fortsat på
// rækken og beholder navnet: ingen af bon-visningernes joins filtrerer på
// is_active (kontrolleret), så historikken er urørt.
//
// requireAuth() og ikke admin — samme begrundelse som PATCH ovenfor: den der
// opdager dubletten skal kunne rydde op med det samme.

/** Hvad hænger der på rækken? Vises i bekræftelsen og gemmes i changeloggen. */
function customerContentCounts(db, id) {
    const n = (sql) => db.prepare(sql).get(id).n;
    return {
        bons:        n(`SELECT COUNT(*) n FROM bons WHERE customer_id = ?
                          AND is_internal = 0 AND (is_offer = 0 OR is_offer IS NULL)`),
        tilbud:      n(`SELECT COUNT(*) n FROM bons WHERE customer_id = ? AND is_offer = 1`),
        traade:      n('SELECT COUNT(*) n FROM mail_threads WHERE customer_id = ?'),
        aktiviteter: n('SELECT COUNT(*) n FROM crm_activities WHERE customer_id = ?'),
    };
}

// GET /api/customers/:id/content — hvad ville en lukning efterlade?
// Bekræftelsen spørger FØR den lukker; et tal man først ser bagefter er ingen
// hjælp. Samme opslag som lukningen selv bruger, så de to ikke kan blive uenige.
router.get('/:id/content', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const c = db.prepare('SELECT id, is_active FROM customers WHERE id = ?').get(id);
    if (!c) return res.status(404).json({ error: 'Kunde ikke fundet' });
    res.json({ id, is_active: !!c.is_active, counts: customerContentCounts(db, id) });
}));

// DELETE /api/customers/:id  { reason? }  — luk kontaktpersonen (soft)
router.delete('/:id', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = getUserId(req);
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500) || null;

    const cust = db.prepare(`
        SELECT c.id, c.first_name, c.last_name, c.company_id, c.is_active, co.is_personal
          FROM customers c LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.id = ?
    `).get(id);
    if (!cust) return res.status(404).json({ error: 'Kunde ikke fundet' });
    if (!cust.is_active) return res.status(400).json({ error: 'Kontaktpersonen er allerede lukket' });

    const counts = customerContentCounts(db, id);
    const oldCompanyId = cust.company_id;
    let cleanup = null;
    let closedPoints = [];

    transaction(db, () => {
        db.prepare(`UPDATE customers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

        // Kontaktpunkterne lukkes med. Ellers ville findCustomerByEmail stadig
        // kunne finde adressen — den filtrerer på BEGGE niveauer (kunde og
        // punkt), så en indgående mail ville lande på en lukket række hvis kun
        // det ene var lukket. Vi gemmer id + is_primary, så gendan kan åbne
        // præcis de punkter vi selv lukkede, og ikke dem der lå lukket i forvejen.
        closedPoints = db.prepare(`
            SELECT id, kind, value, is_primary FROM contact_points
             WHERE entity_type = 'customer' AND entity_id = ? AND is_active = 1
        `).all(id);
        if (closedPoints.length) {
            db.prepare(`UPDATE contact_points
                           SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP
                         WHERE entity_type = 'customer' AND entity_id = ? AND is_active = 1`).run(id);
        }

        // Var firmaet et PERSONLIGT (ensurePersonalCompanies i services/rfm.js
        // laver et pr. kunde uden firma), står det nu tomt og lægges væk. Kun
        // is_personal — et rigtigt firma må aldrig forsvinde som bivirkning af
        // at en kontaktperson lukkes. deactivateCompanies gentjekker desuden
        // hele tom-reglen, så en bon eller en mailtråd på rækken freder den.
        if (oldCompanyId && cust.is_personal) {
            cleanup = deactivateCompanies(db, [oldCompanyId], userId);
        }

        db.prepare(`
            INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes, payload)
            VALUES ('customer', ?, 'update', 'is_active', '1', '0', ?, ?, ?)
        `).run(id, userId ?? null,
            reason ? 'Kontaktperson lukket: ' + reason : 'Kontaktperson lukket',
            JSON.stringify({
                closed_contact_points: closedPoints.map(p => ({ id: p.id, is_primary: p.is_primary ? 1 : 0 })),
                company_id: oldCompanyId,
                company_closed: (cleanup && cleanup.deactivated) || [],   // rå id'er
                counts,
            }));
    });

    broadcast('customer_updated', { customer_id: id, changed: ['is_active'] });
    res.json({ ok: true, closed: true, counts, contact_points_closed: closedPoints.length, company_cleanup: cleanup });
}));

// POST /api/customers/:id/restore — luk op igen
//
// Uden den ville en fejlklikket lukning være en blindgyde: en lukket kunde
// står ikke i nogen liste og kan kun findes på sit id.
router.post('/:id/restore', requireAuth(), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const userId = getUserId(req);

    const cust = db.prepare('SELECT id, company_id, is_active FROM customers WHERE id = ?').get(id);
    if (!cust) return res.status(404).json({ error: 'Kunde ikke fundet' });
    if (cust.is_active) return res.status(400).json({ error: 'Kontaktpersonen er ikke lukket' });

    // Seneste lukning bærer hvilke kontaktpunkter og hvilket personligt firma
    // der fulgte med. Findes den ikke (rækken er lukket af et script før denne
    // rute fandtes), åbnes kunden alene — vi gætter ikke på hvad der hørte til.
    const last = db.prepare(`
        SELECT payload FROM changelog
         WHERE entity_type = 'customer' AND entity_id = ? AND field_name = 'is_active' AND new_value = '0'
         ORDER BY id DESC LIMIT 1
    `).get(id);
    let saved = {};
    try { saved = JSON.parse(last?.payload || '{}') || {}; } catch { saved = {}; }

    const reopened = [];
    const skipped = [];
    let companyReopened = null;

    transaction(db, () => {
        db.prepare(`UPDATE customers SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

        for (const p of (saved.closed_contact_points || [])) {
            const cp = db.prepare('SELECT id, kind, value, is_active FROM contact_points WHERE id = ?').get(p.id);
            if (!cp || cp.is_active) continue;
            // Adressen kan være blevet lært på en ANDEN kunde imens (#478
            // springer kun over når den er "optaget" af en AKTIV række). Åbner
            // vi den alligevel, får to kunder samme adresse, og
            // findCustomerByEmail bliver tvetydig — dens LIMIT 1 uden ORDER BY
            // ville route mailen til en tilfældig af de to.
            const taken = db.prepare(`
                SELECT cp.entity_id AS id FROM contact_points cp
                  JOIN customers c ON c.id = cp.entity_id
                 WHERE cp.entity_type = 'customer' AND cp.kind = ?
                   AND LOWER(cp.value) = LOWER(?) AND cp.is_active = 1 AND c.is_active = 1
                   AND cp.entity_id <> ?
                 LIMIT 1
            `).get(cp.kind, cp.value, id);
            if (taken) { skipped.push({ value: cp.value, taken_by: taken.id }); continue; }
            db.prepare(`UPDATE contact_points SET is_active = 1, is_primary = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(p.is_primary ? 1 : 0, cp.id);
            reopened.push(cp.value);
        }

        // Lukkede vi selv et personligt firma i samme greb, åbnes det med —
        // ellers ville kunden stå uden det firma hun havde før lukningen.
        for (const cid of (saved.company_closed || [])) {
            const co = db.prepare('SELECT id, is_active, is_personal FROM companies WHERE id = ?').get(cid);
            if (!co || co.is_active || !co.is_personal) continue;
            db.prepare('UPDATE companies SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(cid);
            companyReopened = cid;
        }

        db.prepare(`
            INSERT INTO changelog (entity_type, entity_id, action, field_name, old_value, new_value, user_id, notes, payload)
            VALUES ('customer', ?, 'update', 'is_active', '0', '1', ?, 'Kontaktperson gendannet', ?)
        `).run(id, userId ?? null, JSON.stringify({ contact_points_reopened: reopened, contact_points_skipped: skipped, company_reopened: companyReopened }));
    });

    broadcast('customer_updated', { customer_id: id, changed: ['is_active'] });
    res.json({ ok: true, restored: true, contact_points_reopened: reopened, contact_points_skipped: skipped, company_reopened: companyReopened });
}));

// PATCH /api/customers/:id/economic — opdater e-conomic kontakt/kunde-nr
router.patch('/:id/economic', handle((req, res) => {
    const db = getDb();
    const { id } = req.params;
    const { economic_contact_id, economic_customer_id } = req.body;

    const existing = db.prepare('SELECT economic_contact_id, economic_customer_id FROM customers WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Kunde ikke fundet' });

    if (economic_contact_id !== undefined) {
        db.prepare('UPDATE customers SET economic_contact_id = ? WHERE id = ?')
          .run(economic_contact_id || null, id);
        logChange({
            entityType: 'customer', entityId: Number(id), action: 'update',
            fieldName: 'economic_contact_id',
            oldValue: existing.economic_contact_id, newValue: economic_contact_id,
            userId: getUserId(req),
        });
    }

    if (economic_customer_id !== undefined) {
        db.prepare('UPDATE customers SET economic_customer_id = ? WHERE id = ?')
          .run(economic_customer_id || null, id);
        logChange({
            entityType: 'customer', entityId: Number(id), action: 'update',
            fieldName: 'economic_customer_id',
            oldValue: existing.economic_customer_id, newValue: economic_customer_id,
            userId: getUserId(req),
        });
    }

    res.json({ ok: true });
}));

/* ── CUSTOMER MAIL ────────────────────────────────────────── */

// GET /api/customers/:id/mail
router.get('/:id/mail', handle(async (req, res) => {
    const customerId = parseInt(req.params.id);
    const db = getDb();
    const threads = db.prepare(`
        SELECT * FROM mail_threads WHERE customer_id = ? ORDER BY updated_at DESC
    `).all(customerId);

    for (const t of threads) {
        t.messages = db.prepare(`
            SELECT mm.*,
                   (SELECT json_group_array(json_object('id', ma.id, 'filename', ma.filename, 'mime_type', ma.mime_type, 'size_bytes', ma.size_bytes, 'content_id', ma.content_id, 'is_inline', ma.is_inline))
                    FROM mail_attachments ma WHERE ma.message_id = mm.id) as attachments_json
            FROM mail_messages mm WHERE mm.thread_id = ? ORDER BY mm.created_at ASC
        `).all(t.id);
        t.messages.forEach(m => {
            m.attachments = m.attachments_json ? JSON.parse(m.attachments_json) : [];
            delete m.attachments_json;
        });
    }
    res.json({ threads });
}));

// POST /api/customers/:id/mail
//
// Body kan indeholde {{booking_link}} — substitueres server-side via
// renderTemplate så token genereres bundet til (customer, user, flow, intent).
// Signatur appendes IKKE — fritekst-mailen er fuldt brugerstyret.
//
// En sendt mail bliver ALTID til en `email_out`-aktivitet. Typen har eksisteret i
// crm_activities siden migration 019, men blev aldrig skrevet af nogen — mailen lå
// kun i sin tråd og talte derfor hverken som kontakt i tidslinjen eller i de køer
// der dedupe'r på aktivitet. Sendte man booking-linket til 40 kunder, stod alle 40
// på ringelisten dagen efter.
//
// Valgfri kontekst styrer hvor mailen tæller med:
//   bon_id       → mailen hænger på bonen (service-kald dedupe'r på den)
//   purpose_key  → formål (fx 'saesonoutreach') så sæson-/rytme-køen dedupe'r
//   campaign_id  → tilskriv kampagnen
router.post('/:id/mail', handle(async (req, res) => {
    const customerId = parseInt(req.params.id);
    const {
        to, subject, text, booking_flow, booking_intent_meeting_type, attachments,
        bon_id, purpose_key, campaign_id,
    } = req.body;
    if (!to || !text) return res.status(400).json({ error: 'to og text er påkrævet' });

    const { sendMail, renderTemplate, validateAttachments } = require('../services/mailService');

    const att = validateAttachments(attachments);
    if (att.error) return res.status(400).json({ error: att.error });

    const context = { type: 'customer', number: customerId };
    const userId = getUserId(req);

    // Validér booking-flow whitelist
    const flow = (booking_flow === 'kontakt') ? 'kontakt' : 'smagning';

    // Process body for {{booking_link}} (og evt. fremtidige universelle vars).
    // Signaturen sættes på i sendMail — ikke her.
    let renderedText, renderedSubject;
    try {
        renderedText = renderTemplate(text, {}, {
            customerId,
            userId,
            bookingFlow:   flow,
            bookingIntent: booking_intent_meeting_type || null
        });
        renderedSubject = renderTemplate(subject || '', {}, {
            customerId, userId, bookingFlow: flow,
            bookingIntent: booking_intent_meeting_type || null
        });
    } catch (err) {
        // Uopløseligt booking-link er brugerens at rette (typisk manglende
        // URL-base i Settings) — ikke en serverfejl. Beskeden skal ud i UI'et.
        if (err.code === 'booking_link_unresolvable') {
            return res.status(400).json({ error: err.message, code: err.code });
        }
        throw err;
    }

    const result = await sendMail({
        to, subject: renderedSubject, text: renderedText,
        customerId, context, smtpPrefix: 'smtp_kontakt', userId,
        attachments: att.list
    });

    // Aktiviteten skrives EFTER afsendelsen og må aldrig vælte den: mailen er den
    // uigenkaldelige del, aktiviteten er sporet. Fejler sporet, siges det højt i
    // svaret (activity_logged: false) frem for at svaret ser rent ud — samme
    // princip som #362's send_error.
    const db = getDb();
    let activityId = null;
    let activityError = null;
    try {
        activityId = logActivity(db, {
            customer_id: customerId,
            bon_id: bon_id ? parseInt(bon_id, 10) : null,
            type: 'email_out',
            text: 'Mail sendt: ' + (String(subject || '').trim() || '(uden emne)'),
            owner_user_id: userId,
            purpose_id: purposeIdByKey(db, purpose_key),
            campaign_id: campaign_id ? parseInt(campaign_id, 10) : null,
        });
    } catch (err) {
        activityError = err.message;
        console.error('[customers] Kunne ikke logge email_out-aktivitet:', err);
    }

    res.json({
        ok: true, messageId: result.messageId, threadId: result.threadId,
        activity_id: activityId,
        activity_logged: activityId !== null,
        activity_error: activityError,
    });
}));

module.exports = router;
