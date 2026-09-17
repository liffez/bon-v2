// routes/booking.js
// ==========================================
// Booking-modul (Fase 14):
//   - Public endpoints (ingen auth): meeting-types, contact-reasons, intro/thankyou
//   - Admin CRUD (requireAuth('admin')): meeting_types, contact_reasons, page_templates
//
// Slot-beregning, webhooks og token-endpoints tilføjes i senere milepæle.
// ==========================================

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { transaction } = require('../db/compat');
const { handle, logChange } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');

// Helper — læs setting
function getSetting(key) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value ?? '';
}

// Firma-kontaktinfo til "ikke tilgængelig"-fallback på de offentlige booking-sider.
// Hentes fra settings (migration 025) — aldrig hardcodet i HTML.
function contactInfo() {
    return {
        phone: getSetting('company_phone'),
        email: getSetting('company_email'),
    };
}

// ─── PUBLIC: meeting-types ─────────────────────────────────────────────────
// Bruges af booking/smagning.html (/book/smagning). Returnerer altid 200.
// Hvis modulet er deaktiveret eller default-ejer mangler: { available: false, ... }.

router.get('/meeting-types', handle((req, res) => {
    const enabled = getSetting('booking_smagning_enabled') === '1';
    const ownerSet = !!getSetting('booking_default_owner_user_id');

    const contact = contactInfo();
    if (!enabled) return res.json({ available: false, reason: 'disabled', meeting_types: [], contact });
    if (!ownerSet) return res.json({ available: false, reason: 'unconfigured', meeting_types: [], contact });

    const rows = getDb().prepare(`
        SELECT id, key, label, emoji, description, duration_min,
               fixed_guest_count, asks_event_type, needs_delivery_address
        FROM meeting_types
        WHERE is_active = 1 AND is_bookable = 1
        ORDER BY sort_order, id
    `).all();

    res.json({ available: true, meeting_types: rows, contact });
}));

// ─── PUBLIC: contact-reasons ───────────────────────────────────────────────

router.get('/contact-reasons', handle((req, res) => {
    const enabled = getSetting('booking_kontakt_enabled') === '1';
    const ownerSet = !!getSetting('booking_default_owner_user_id');

    const contact = contactInfo();
    if (!enabled) return res.json({ available: false, reason: 'disabled', contact_reasons: [], contact });
    if (!ownerSet) return res.json({ available: false, reason: 'unconfigured', contact_reasons: [], contact });

    const rows = getDb().prepare(`
        SELECT id, key, label, emoji, description
        FROM contact_reasons
        WHERE is_active = 1
        ORDER BY sort_order, id
    `).all();

    res.json({ available: true, contact_reasons: rows, contact });
}));

// ─── PUBLIC: slots ─────────────────────────────────────────────────────────
// GET /api/booking/slots?date=YYYY-MM-DD&meeting_type=smagning

router.get('/slots', handle((req, res) => {
    const { computeSlotsForDate } = require('../services/bookingMatcher');
    const date = (req.query.date || '').trim();
    const meetingType = (req.query.meeting_type || '').trim();

    if (!date || !meetingType) {
        return res.status(400).json({ error: 'date og meeting_type er påkrævet' });
    }

    const result = computeSlotsForDate(date, meetingType);
    res.json(result);
}));

// ─── AUTH: meeting-types/intent — alle aktive typer, til CRM mail-compose ─
// Sælgere kan pre-vælge intent når de indsætter {{booking_link}}, inkl.
// is_bookable=0 typer (gennemgang, smagning_gennemgang) som ikke vises på
// public siden men gerne må serveres som hint ved token-redirect.
router.get('/meeting-types/intent', requireAuth(), handle((req, res) => {
    const rows = getDb().prepare(`
        SELECT id, key, label, emoji, description, duration_min, is_bookable
        FROM meeting_types
        WHERE is_active = 1
        ORDER BY sort_order, id
    `).all();
    res.json({ meeting_types: rows });
}));

// ─── PUBLIC: token info — pre-fill data ────────────────────────────────────
// GET /api/booking/token/:token
//   - Bumper open_count + sætter opened_at (hvis NULL)
//   - Returnerer kunde + intent + sælger til pre-fill på tools-siden
//   - Ukendt token → 404, udløbet → 410
//   - Allerede brugt (booking_activity_id sat) → returneres med used:true så
//     siden kan vise "Dit møde er allerede booket"-besked

router.get('/token/:token', handle((req, res) => {
    const token = String(req.params.token || '').trim();
    if (!/^[a-f0-9]{8,64}$/i.test(token)) {
        return res.status(400).json({ error: 'invalid_token_format' });
    }

    const db = getDb();
    const row = db.prepare(`
        SELECT t.token, t.flow, t.expires_at, t.opened_at, t.open_count, t.booking_activity_id,
               t.customer_id, t.sales_user_id, t.intent_meeting_type_id,
               c.first_name, c.last_name, c.email, c.phone,
               co.id AS company_id, co.name AS company_name,
               u.name AS sales_user_name,
               mt.key AS intent_meeting_type_key, mt.label AS intent_meeting_type_label
        FROM booking_tokens t
        LEFT JOIN customers c     ON c.id  = t.customer_id
        LEFT JOIN companies co    ON co.id = c.company_id
        LEFT JOIN users u         ON u.id  = t.sales_user_id
        LEFT JOIN meeting_types mt ON mt.id = t.intent_meeting_type_id
        WHERE t.token = ?
    `).get(token);

    if (!row) return res.status(404).json({ error: 'unknown_token' });

    // Udløbet?
    const expCheck = db.prepare("SELECT 1 AS ok WHERE datetime(?) > datetime('now')").get(row.expires_at);
    if (!expCheck?.ok) return res.status(410).json({ error: 'expired_token' });

    // Bump open-counter (kun ved hvert lookup — atomisk)
    db.prepare(`
        UPDATE booking_tokens
        SET open_count = open_count + 1,
            opened_at  = COALESCE(opened_at, datetime('now'))
        WHERE token = ?
    `).run(token);

    // M12 hardening: log advarsel ved usædvanligt mange opens (potentiel bot-probing).
    // Vi spærrer ikke endpointet — bare gør det synligt i ops-loggen.
    if (row.open_count >= 20 && row.open_count % 20 === 0) {
        console.warn(`[booking] Token ${token.slice(0, 8)}… har ${row.open_count + 1} opens (kunde #${row.customer_id})`);
    }

    res.json({
        token: row.token,
        flow:  row.flow,
        used:  !!row.booking_activity_id,
        customer: row.customer_id ? {
            id:         row.customer_id,
            first_name: row.first_name,
            last_name:  row.last_name,
            email:      row.email,
            phone:      row.phone,
            company:    row.company_id ? { id: row.company_id, name: row.company_name } : null
        } : null,
        intent_meeting_type: row.intent_meeting_type_id ? {
            id:    row.intent_meeting_type_id,
            key:   row.intent_meeting_type_key,
            label: row.intent_meeting_type_label
        } : null,
        sales_user: row.sales_user_id ? {
            id:   row.sales_user_id,
            name: row.sales_user_name
        } : null
    });
}));

// ─── PUBLIC: page-templates (intro + thankyou) ─────────────────────────────
// Returnerer rå template — frontend renderer {{variabler}} client-side
// for intro (statiske vars). For thankyou renderer server-side i webhook-respons.

router.get('/page-templates/:key', handle((req, res) => {
    const row = getDb().prepare(
        'SELECT key, label, title, body_text FROM page_templates WHERE key = ?'
    ).get(req.params.key);
    if (!row) return res.status(404).json({ error: 'Page template ikke fundet' });
    res.json(row);
}));

// ===========================================================================
// ADMIN ENDPOINTS — kræver admin-rolle
// ===========================================================================

// ─── ADMIN: meeting-types ──────────────────────────────────────────────────

router.get('/admin/meeting-types', requireAuth('admin'), handle((req, res) => {
    const rows = getDb().prepare(`
        SELECT id, key, label, emoji, description, duration_min, is_bookable, is_system, is_active, sort_order,
               fixed_guest_count, asks_event_type, needs_delivery_address
        FROM meeting_types
        ORDER BY sort_order, id
    `).all();
    res.json(rows);
}));

router.post('/admin/meeting-types', requireAuth('admin'), handle((req, res) => {
    const { key, label, emoji, description, duration_min, is_bookable, sort_order } = req.body;

    if (!key || !label) return res.status(400).json({ error: 'key og label er påkrævet' });
    if (!/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ error: 'key må kun indeholde a-z, 0-9 og _' });

    const dur = parseInt(duration_min);
    if (!Number.isFinite(dur) || dur < 1 || dur > 600) {
        return res.status(400).json({ error: 'duration_min skal være 1-600 minutter' });
    }

    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM meeting_types WHERE key = ?').get(key);
    if (exists) return res.status(409).json({ error: 'Nøgle eksisterer allerede' });

    const result = db.prepare(`
        INSERT INTO meeting_types (key, label, emoji, description, duration_min, is_bookable, is_system, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
        key, label, emoji || null, description || null,
        dur,
        is_bookable === 0 ? 0 : 1,
        sort_order || 100
    );

    res.json({ id: Number(result.lastInsertRowid), ok: true });
}));

router.patch('/admin/meeting-types/:id', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const row = db.prepare('SELECT * FROM meeting_types WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Mødetype ikke fundet' });

    const { label, emoji, description, duration_min, is_bookable, is_active, sort_order,
            fixed_guest_count, asks_event_type, needs_delivery_address } = req.body;

    if (row.is_system && is_active === 0) {
        return res.status(400).json({ error: 'Systemmødetype kan ikke deaktiveres' });
    }

    const updates = [];
    const params  = [];
    if (label !== undefined)        { updates.push('label = ?');        params.push(label); }
    if (emoji !== undefined)        { updates.push('emoji = ?');        params.push(emoji); }
    if (description !== undefined)  { updates.push('description = ?');  params.push(description); }
    if (duration_min !== undefined) {
        const d = parseInt(duration_min);
        if (!Number.isFinite(d) || d < 1 || d > 600) {
            return res.status(400).json({ error: 'duration_min skal være 1-600' });
        }
        updates.push('duration_min = ?'); params.push(d);
    }
    if (is_bookable !== undefined)  { updates.push('is_bookable = ?');  params.push(is_bookable ? 1 : 0); }
    if (asks_event_type !== undefined) { updates.push('asks_event_type = ?'); params.push(asks_event_type ? 1 : 0); }
    if (needs_delivery_address !== undefined) { updates.push('needs_delivery_address = ?'); params.push(needs_delivery_address ? 1 : 0); }
    if (fixed_guest_count !== undefined) {
        // Tom streng og null betyder begge "spørg kunden" — feltet ryddes.
        const g = (fixed_guest_count === '' || fixed_guest_count === null) ? null : parseInt(fixed_guest_count);
        if (g !== null && (!Number.isFinite(g) || g < 1 || g > 500)) {
            return res.status(400).json({ error: 'fixed_guest_count skal være 1-500 eller tom' });
        }
        updates.push('fixed_guest_count = ?'); params.push(g);
    }
    if (sort_order !== undefined)   { updates.push('sort_order = ?');   params.push(parseInt(sort_order) || 100); }
    if (is_active !== undefined && !row.is_system) {
        updates.push('is_active = ?'); params.push(is_active ? 1 : 0);
    }

    if (updates.length === 0) return res.json({ ok: true });

    params.push(id);
    db.prepare(`UPDATE meeting_types SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
}));

// ─── ADMIN: contact-reasons ────────────────────────────────────────────────

router.get('/admin/contact-reasons', requireAuth('admin'), handle((req, res) => {
    const rows = getDb().prepare(`
        SELECT id, key, label, emoji, description, is_system, is_active, sort_order
        FROM contact_reasons
        ORDER BY sort_order, id
    `).all();
    res.json(rows);
}));

router.post('/admin/contact-reasons', requireAuth('admin'), handle((req, res) => {
    const { key, label, emoji, description, sort_order } = req.body;
    if (!key || !label) return res.status(400).json({ error: 'key og label er påkrævet' });
    if (!/^[a-z0-9_]+$/.test(key)) return res.status(400).json({ error: 'key må kun indeholde a-z, 0-9 og _' });

    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM contact_reasons WHERE key = ?').get(key);
    if (exists) return res.status(409).json({ error: 'Nøgle eksisterer allerede' });

    const result = db.prepare(`
        INSERT INTO contact_reasons (key, label, emoji, description, is_system, sort_order)
        VALUES (?, ?, ?, ?, 0, ?)
    `).run(key, label, emoji || null, description || null, sort_order || 100);

    res.json({ id: Number(result.lastInsertRowid), ok: true });
}));

router.patch('/admin/contact-reasons/:id', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const row = db.prepare('SELECT * FROM contact_reasons WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Kontaktårsag ikke fundet' });

    const { label, emoji, description, is_active, sort_order } = req.body;

    if (row.is_system && is_active === 0) {
        return res.status(400).json({ error: 'System-kontaktårsag kan ikke deaktiveres' });
    }

    const updates = [];
    const params  = [];
    if (label !== undefined)       { updates.push('label = ?');       params.push(label); }
    if (emoji !== undefined)       { updates.push('emoji = ?');       params.push(emoji); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (sort_order !== undefined)  { updates.push('sort_order = ?');  params.push(parseInt(sort_order) || 100); }
    if (is_active !== undefined && !row.is_system) {
        updates.push('is_active = ?'); params.push(is_active ? 1 : 0);
    }

    if (updates.length === 0) return res.json({ ok: true });

    params.push(id);
    db.prepare(`UPDATE contact_reasons SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ ok: true });
}));

// ─── ADMIN: page-templates ─────────────────────────────────────────────────

router.get('/admin/page-templates', requireAuth('admin'), handle((req, res) => {
    const rows = getDb().prepare(
        'SELECT id, key, label, title, body_text, is_system, updated_at FROM page_templates ORDER BY id'
    ).all();
    res.json(rows);
}));

router.patch('/admin/page-templates/:key', requireAuth('admin'), handle((req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM page_templates WHERE key = ?').get(req.params.key);
    if (!row) return res.status(404).json({ error: 'Page template ikke fundet' });

    const { label, title, body_text } = req.body;

    const updates = [];
    const params  = [];
    if (label !== undefined)     { updates.push('label = ?');     params.push(label); }
    if (title !== undefined)     { updates.push('title = ?');     params.push(title); }
    if (body_text !== undefined) { updates.push('body_text = ?'); params.push(body_text); }

    if (updates.length === 0) return res.json({ ok: true });

    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(req.params.key);
    db.prepare(`UPDATE page_templates SET ${updates.join(', ')} WHERE key = ?`).run(...params);
    res.json({ ok: true });
}));

// ===========================================================================
// PUBLIC WEBHOOK — POST /webhook/booking-smagning (også på /api/booking/booking-smagning)
// ===========================================================================
// Mønster: kopierer web-orders.js — honeypot-tjek, altid 200, fire-and-forget.
// Webhook 503'er hvis modulet ikke er konfigureret (default-ejer mangler).

router.post('/booking-smagning', async (req, res) => {
    try {
        // 503-tjek: modul aktiveret + default-ejer sat (medmindre token brugt)
        const enabled = getSetting('booking_smagning_enabled') === '1';
        if (!enabled) {
            return res.status(503).json({ error: 'Booking-modulet er ikke aktiveret' });
        }
        const tokenInBody = req.body?.token;
        if (!tokenInBody && !getSetting('booking_default_owner_user_id')) {
            return res.status(503).json({ error: 'Booking-modulet er ikke fuldt konfigureret' });
        }

        const result = handleSmagningBooking(req.body);
        res.json({
            ok: true,
            activity_id: result?.activityId || null,
            error: result?.error || null
        });
    } catch (err) {
        console.error('[booking-smagning] Fejl:', err);
        res.json({ ok: true });  // Altid 200 til klienten
    }
});

/**
 * Skriv bookingens leveringsadresse til `addresses` og returnér id'et.
 *
 * Samme felter som POST /api/addresses tager imod, og samme fire-and-forget
 * geokodning: DAWA må aldrig kunne blokere eller vælte en booking. Klienten
 * sender coords med fra autocompleten, så opslaget er som regel unødvendigt.
 */
function createDeliveryAddress(db, data) {
    const street = String(data.address_street || '').trim();
    if (!street) return null;

    const lat = Number(data.address_lat), lon = Number(data.address_lon);
    const res = db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(
        street,
        String(data.address_nr   || '').trim() || null,
        String(data.address_zip  || '').trim() || null,
        String(data.address_city || '').trim() || null,
        Number.isFinite(lat) ? lat : null,
        Number.isFinite(lon) ? lon : null
    );
    const id = Number(res.lastInsertRowid);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        require('../services/geocode').geocodeAddress(id)
            .catch(err => console.warn(`[booking] geokodning af adresse #${id} fejlede:`, err.message));
    }
    return id;
}

/** Adressen som én læsbar linje til bekræftelsesmailen. */
function formatAddress(db, addressId) {
    if (!addressId) return '';
    const a = db.prepare('SELECT street_name, street_nr, postal_code, city FROM addresses WHERE id = ?').get(addressId);
    if (!a) return '';
    const vej = [a.street_name, a.street_nr].filter(Boolean).join(' ');
    const by  = [a.postal_code, a.city].filter(Boolean).join(' ');
    return [vej, by].filter(Boolean).join(', ');
}

function handleSmagningBooking(data) {
    const db = getDb();
    const {
        matchOrCreateCustomer,
        resolveSalesOwner,
        isSlotStillFree
    } = require('../services/bookingMatcher');

    // 1. Honeypot
    if (data.website) {
        console.log('[booking-smagning] Honeypot triggered — ignoreret');
        return null;
    }

    // 2. Påkrævede felter
    const required = ['first_name', 'email', 'date', 'time', 'meeting_type'];
    for (const k of required) {
        if (!data[k] || String(data[k]).trim() === '') {
            console.warn('[booking-smagning] Mangler felt:', k);
            return { error: 'missing_fields' };
        }
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return { error: 'invalid_date' };
    if (!/^\d{2}:\d{2}$/.test(data.time))       return { error: 'invalid_time' };

    // Leveringsadresse — kun for de mødetyper der skal leveres. En smagning
    // KØRES UD; uden en adresse kan hverken bekræftelsen, køkkenet eller
    // Logistik gøre deres arbejde. Kravet står på mødetypen (migration 172),
    // ikke i formularen, så en manipuleret POST ikke kan springe det over.

    // 3. Hent meeting_type
    const mt = db.prepare(`
        SELECT id, label, duration_min, fixed_guest_count, asks_event_type, needs_delivery_address
        FROM meeting_types
        WHERE key = ? AND is_active = 1 AND is_bookable = 1
    `).get(data.meeting_type);
    if (!mt) {
        console.warn('[booking-smagning] Ukendt mødetype:', data.meeting_type);
        return { error: 'unknown_meeting_type' };
    }

    if (mt.needs_delivery_address && !String(data.address_street || '').trim()) {
        console.warn('[booking-smagning] Mangler leveringsadresse til', mt.label);
        return { error: 'missing_address' };
    }

    // 4. Atomisk: re-tjek slot er ledigt + opret crm_activity i samme transaction.
    //    Forhindrer race-condition hvor to brugere booker samme slot samtidigt.
    // Adressen skrives FØR aktiviteten, så dens id kan gemmes med i samme
    // transaktion. Slår slot-tjekket fejl, står en ubrugt adresserække tilbage
    // — det er harmløst, og alternativet (adressen mistes) er det ikke.
    let addressId = null;
    if (mt.needs_delivery_address) {
        addressId = createDeliveryAddress(db, data);
    }

    let activityId, customerId, companyId, ownerId;
    try {
        const txResult = transaction(db, () => {
            const slotCheck = isSlotStillFree(data.date, data.time, data.meeting_type);
            if (!slotCheck.ok) return { conflict: true, reason: slotCheck.reason };

            const match = matchOrCreateCustomer({
                token: data.token,
                first_name: data.first_name,
                last_name:  data.last_name,
                email:      data.email,
                phone:      data.phone,
                company_name: data.company
            });

            const owner = resolveSalesOwner(data.token);

            const dueAt = `${data.date} ${data.time}:00`;
            // Mødetypen bestemmer, ikke formularen. Felterne er skjult i
            // siden når typen selv svarer på dem, men en POST kan sende hvad
            // som helst — så vi tager svaret fra databasen, ikke fra klienten.
            const guestCount = mt.fixed_guest_count != null
                ? mt.fixed_guest_count
                : (data.guest_count ? parseInt(data.guest_count) : null);
            const eventType  = mt.asks_event_type
                ? ((data.event_type || '').trim() || null)
                : null;
            const message    = (data.message    || '').trim() || `Online booking: ${mt.label}`;

            const r = db.prepare(`
                INSERT INTO crm_activities (
                    customer_id, type, meeting_type_id, due_at, duration_min,
                    guest_count, event_type, text, owner_user_id,
                    booked_via, delivery_address_id, created_at
                ) VALUES (?, 'meeting', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(
                match.customerId, mt.id, dueAt, mt.duration_min,
                guestCount, eventType, message, owner,
                data.token ? 'token_link' : 'public_smagning',
                addressId
            );

            const newId = Number(r.lastInsertRowid);

            // Hvis brugt token: marker som forbrugt
            if (data.token) {
                db.prepare('UPDATE booking_tokens SET booking_activity_id = ? WHERE token = ?')
                  .run(newId, data.token);
            }

            return {
                conflict: false,
                activityId: newId,
                customerId: match.customerId,
                companyId:  match.companyId,
                ownerId:    owner
            };
        });

        if (txResult.conflict) {
            console.warn('[booking-smagning] Slot konflikt:', txResult.reason);
            return { error: 'slot_conflict', reason: txResult.reason };
        }

        activityId = txResult.activityId;
        customerId = txResult.customerId;
        companyId  = txResult.companyId;
        ownerId    = txResult.ownerId;
    } catch (err) {
        console.error('[booking-smagning] DB-fejl:', err);
        throw err;
    }

    // 5. Changelog
    logChange({
        entityType: 'crm_activity',
        entityId: activityId,
        action: 'create',
        fieldName: 'booking',
        oldValue: null,
        newValue: `Online booking: ${mt.label} ${data.date} kl ${data.time}`,
        userId: null
    });

    // 6. SSE broadcast — sælgerens office-view opdaterer live
    broadcast('crm_activity_created', {
        activity_id: activityId,
        customer_id: customerId,
        type: 'meeting',
        booked_via: data.token ? 'token_link' : 'public_smagning'
    });

    // 7. Bonen — så køkkenet kan pakke smagsprøven og Logistik kan køre den ud.
    //
    // Fire-and-forget. En smagning er aftalt i det øjeblik aktiviteten står i
    // databasen; bonen er en afledt ting vi kan lave igen fra CRM. Kunden må
    // ALDRIG få en fejl på formularen fordi Grocy er nede.
    if (mt.needs_delivery_address) {
        require('../services/smagningBon')
            .createSmagningBon({
                activityId, customerId, companyId,
                date: data.date, time: data.time,
                addressId,
                guestCount: mt.fixed_guest_count ?? (data.guest_count ? parseInt(data.guest_count) : null),
                meetingTypeLabel: mt.label,
            })
            .then(r => { if (r.created) broadcast('crm_activity_created', { activity_id: activityId, customer_id: customerId, type: 'meeting' }); })
            .catch(err => console.error('[booking-smagning] Bon kunne ikke oprettes:', err.message));
    }

    // 8. Mails (fire-and-forget — webhook returnerer altid 200 til kunden).
    //    a) Bekræftelse til kunden via kontakt@
    //    b) Intern notifikation til sælger — ALTID, også ved token-flow.
    //
    // Token-flow var tidligere undtaget ud fra "sælgeren sendte jo linket, hun
    // ved det". Den holder ikke i en kampagne: sendes der tyve links på en uge,
    // kan ingen huske hvem der har booket. Notifikationen er netop dét systemet
    // er bedre til end hukommelsen. {{bookingKilde}} fortæller hvilken af delene
    // det var, så et kampagne-svar kan skelnes fra en der selv fandt siden.
    sendBookingMails({
        flow: 'smagning',
        customerEmail: data.email,
        customerId,
        ownerId,
        meetingType: mt,
        date: data.date,
        time: data.time,
        formData: data,
        deliveryAddress: formatAddress(db, addressId),
        guestCount: mt.fixed_guest_count ?? (data.guest_count ? parseInt(data.guest_count) : null),
        viaToken: !!data.token
    }).catch(err => console.error('[booking-smagning] Mail-orkestrering:', err.message));

    console.log(`[booking-smagning] Booking oprettet: activity #${activityId}, kunde=${customerId}, ejer=${ownerId}`);

    return { activityId, customerId, companyId };
}

/**
 * Orkestrer kunde-bekræftelse + intern notifikation for en booking.
 * Kaldes fire-and-forget fra webhook-handlers så mail-fejl ikke vælter responset.
 */
async function sendBookingMails({ flow, customerEmail, customerId, ownerId, meetingType, contactReason, date, time, formData, deliveryAddress = '', guestCount = null, viaToken = false }) {
    const {
        buildSmagningMailVars,
        buildKontaktMailVars,
        sendInternalNotification
    } = require('../services/bookingMatcher');
    const { sendFromTemplate } = require('../services/mailService');

    // a) Kunde-bekræftelse
    //    userId: ownerId binder evt. {{booking_link}}-token til samme sælger
    //    der lige håndterede bookingen, så banneret viser "du booker hos ...".
    if (customerEmail && customerId) {
        try {
            if (flow === 'smagning') {
                const vars = buildSmagningMailVars({ customerId, meetingType, date, time, deliveryAddress });
                await sendFromTemplate({
                    templateKey: 'booking_smagning_confirmation',
                    to: customerEmail,
                    vars,
                    customerId,
                    userId: ownerId,
                    context: { type: 'customer', number: customerId },
                    smtpPrefix: 'smtp_kontakt',
                    isSystem: true
                });
                console.log(`[booking-smagning] Bekræftelse sendt til ${customerEmail}`);
            } else if (flow === 'kontakt') {
                const vars = buildKontaktMailVars({ customerId, contactReason });
                await sendFromTemplate({
                    templateKey: 'booking_kontakt_confirmation',
                    to: customerEmail,
                    vars,
                    customerId,
                    userId: ownerId,
                    context: { type: 'customer', number: customerId },
                    smtpPrefix: 'smtp_kontakt',
                    isSystem: true
                });
                console.log(`[booking-kontakt] Bekræftelse sendt til ${customerEmail}`);
            }
        } catch (err) {
            console.error(`[booking-${flow}] Kunde-bekræftelse fejl:`, err.message);
        }
    }

    // b) Intern notifikation til sælger — uanset hvordan bookingen kom ind.
    await sendInternalNotification({
        ownerId,
        flow,
        customerId,
        meetingType,
        contactReason,
        date,
        time,
        formData,
        guestCount,
        viaToken
    });
}

// ===========================================================================
// PUBLIC WEBHOOK — POST /webhook/booking-kontakt
// ===========================================================================
// Flow B: Ingen kalender. Formular med navn/email/telefon/firma/årsag/besked.
// Resulterer i crm_activity med type='task'. Hvis reason='ring_op' sættes
// result='callback' så tasken lander på "Ring tilbage"-listen.

router.post('/booking-kontakt', async (req, res) => {
    try {
        const enabled = getSetting('booking_kontakt_enabled') === '1';
        if (!enabled) {
            return res.status(503).json({ error: 'Kontaktformularen er ikke aktiveret' });
        }
        if (!getSetting('booking_default_owner_user_id')) {
            return res.status(503).json({ error: 'Booking-modulet er ikke fuldt konfigureret' });
        }

        const result = handleKontaktBooking(req.body);
        res.json({
            ok: true,
            activity_id: result?.activityId || null,
            error: result?.error || null
        });
    } catch (err) {
        console.error('[booking-kontakt] Fejl:', err);
        res.json({ ok: true });
    }
});

function handleKontaktBooking(data) {
    const db = getDb();
    const {
        matchOrCreateCustomer,
        resolveSalesOwner
    } = require('../services/bookingMatcher');

    // 1. Honeypot
    if (data.website) {
        console.log('[booking-kontakt] Honeypot triggered — ignoreret');
        return null;
    }

    // 2. Påkrævede felter
    const required = ['first_name', 'email', 'reason'];
    for (const k of required) {
        if (!data[k] || String(data[k]).trim() === '') {
            console.warn('[booking-kontakt] Mangler felt:', k);
            return { error: 'missing_fields' };
        }
    }

    // 3. Valid contact_reason
    const reason = db.prepare(
        'SELECT id, key, label FROM contact_reasons WHERE key = ? AND is_active = 1'
    ).get(data.reason);
    if (!reason) {
        console.warn('[booking-kontakt] Ukendt kontaktårsag:', data.reason);
        return { error: 'unknown_reason' };
    }

    // 4. Match/opret kunde — token har præcedens over email-match
    const match = matchOrCreateCustomer({
        token: data.token,
        first_name: data.first_name,
        last_name:  data.last_name,
        email:      data.email,
        phone:      data.phone,
        company_name: data.company
    });

    const owner = resolveSalesOwner(data.token);

    // 5. result='callback' KUN hvis "Ring mig op" — så lander den i v_callbacks_pending
    const result = (reason.key === 'ring_op') ? 'callback' : null;
    const message = (data.message || '').trim() || `Kontaktforespørgsel: ${reason.label}`;
    const bookedVia = data.token ? 'token_link' : 'public_kontakt';

    const r = db.prepare(`
        INSERT INTO crm_activities (
            customer_id, type, contact_reason_id, result, text, owner_user_id,
            booked_via, created_at
        ) VALUES (?, 'task', ?, ?, ?, ?, ?, datetime('now'))
    `).run(match.customerId, reason.id, result, message, owner, bookedVia);

    const activityId = Number(r.lastInsertRowid);

    // Hvis brugt token: marker som forbrugt
    if (data.token) {
        db.prepare('UPDATE booking_tokens SET booking_activity_id = ? WHERE token = ?')
          .run(activityId, data.token);
    }

    // 6. Changelog
    logChange({
        entityType: 'crm_activity',
        entityId: activityId,
        action: 'create',
        fieldName: 'kontakt',
        oldValue: null,
        newValue: `Kontakt-formular: ${reason.label}`,
        userId: null
    });

    // 7. SSE — refresher CRM Dashboard, briefing, callbacks-panel
    broadcast('crm_activity_created', {
        activity_id: activityId,
        customer_id: match.customerId,
        type: 'task',
        booked_via: bookedVia
    });

    // 8. Mails (fire-and-forget). Intern notif sendes også ved token-flow — se
    //    begrundelsen i smagnings-handleren ovenfor.
    sendBookingMails({
        flow: 'kontakt',
        customerEmail: data.email,
        customerId: match.customerId,
        ownerId: owner,
        contactReason: reason,
        formData: data,
        viaToken: !!data.token
    }).catch(err => console.error('[booking-kontakt] Mail-orkestrering:', err.message));

    console.log(`[booking-kontakt] Task oprettet: activity #${activityId}, kunde=${match.customerId}, årsag=${reason.key}, result=${result || '(none)'}`);

    return { activityId, customerId: match.customerId, reasonKey: reason.key };
}

// Express bruger router-funktionen som default eksport. Vi vedhæfter handlers
// som properties så test-scripts kan kalde dem direkte uden HTTP-roundtrip.
module.exports = router;
module.exports.handleSmagningBooking = handleSmagningBooking;
module.exports.handleKontaktBooking  = handleKontaktBooking;
module.exports.sendBookingMails      = sendBookingMails;
