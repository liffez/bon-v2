// services/bookingMatcher.js
// ==========================================
// Slot-beregning + kunde-matching for booking-modul.
//
// Følger CRM_Booking_Spec_v2_PATCH.md sektion P2.
// ==========================================

const { getDb } = require('../db/database');

function getSetting(key) {
    return getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? '';
}

function toMin(hhmm) {
    if (!hhmm || typeof hhmm !== 'string') return null;
    const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1]) * 60 + parseInt(m[2]);
}

function fromMin(min) {
    return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}

/**
 * Beregn ledige slots for en given dato + mødetype.
 *
 * Returnerer altid et objekt med { available, slots, reason? }:
 *   - available: false → modulet er deaktiveret eller dagen er ikke åben
 *   - available: true  → slots[] er en liste af { time, available, reason? }
 */
function computeSlotsForDate(date, meetingTypeKey) {
    const db = getDb();

    // 1. Modulet aktiveret + owner sat
    if (getSetting('booking_smagning_enabled') !== '1') {
        return { available: false, reason: 'disabled', slots: [] };
    }
    if (!getSetting('booking_default_owner_user_id')) {
        return { available: false, reason: 'unconfigured', slots: [] };
    }

    // 2. Validér dato-format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { available: false, reason: 'invalid_date', slots: [] };
    }
    const target = new Date(date + 'T12:00:00');
    if (isNaN(target.getTime())) {
        return { available: false, reason: 'invalid_date', slots: [] };
    }

    // 3. Inden for tilladt vindue (min/max dage frem)
    const minDays = parseInt(getSetting('booking_min_days_ahead') || '2');
    const maxDays = parseInt(getSetting('booking_max_days_ahead') || '90');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const targetMidnight = new Date(date + 'T00:00:00');
    const daysAhead = Math.round((targetMidnight - today) / 86400000);
    if (daysAhead < minDays) return { available: false, reason: 'too_soon',  slots: [] };
    if (daysAhead > maxDays) return { available: false, reason: 'too_far',   slots: [] };

    // 4. Spærret ugedag
    let blocked;
    try { blocked = JSON.parse(getSetting('booking_blocked_weekdays') || '[]'); }
    catch { blocked = []; }
    const dow = target.getDay(); // 0=søn, 6=lør
    if (Array.isArray(blocked) && blocked.includes(dow)) {
        return { available: false, reason: 'weekday_blocked', slots: [] };
    }

    // 5. Hent mødetype for varighed
    const mt = db.prepare(`
        SELECT id, duration_min FROM meeting_types
        WHERE key = ? AND is_active = 1 AND is_bookable = 1
    `).get(meetingTypeKey);
    if (!mt) return { available: false, reason: 'unknown_meeting_type', slots: [] };
    const durationMin = mt.duration_min;

    // 6. Generér rå slots fra workday_start → workday_end i steps
    const startStr = getSetting('booking_workday_start') || '09:00';
    const endStr   = getSetting('booking_workday_end')   || '16:30';
    const stepMin  = parseInt(getSetting('booking_slot_step_min') || '30');
    const dayStart = toMin(startStr);
    const dayEnd   = toMin(endStr);
    if (dayStart == null || dayEnd == null || stepMin < 1) {
        return { available: false, reason: 'config_error', slots: [] };
    }

    const slots = [];
    let cur = dayStart;
    while (cur + durationMin <= dayEnd) {
        slots.push({ time: fromMin(cur), startMin: cur, endMin: cur + durationMin });
        cur += stepMin;
    }

    // 7. Optagne intervaller fra crm_activities (planlagte møder, done_at IS NULL)
    const meetings = db.prepare(`
        SELECT due_at, COALESCE(duration_min, 30) AS dur
        FROM crm_activities
        WHERE type = 'meeting'
          AND DATE(due_at) = ?
          AND done_at IS NULL
    `).all(date);

    const busy = [];
    for (const m of meetings) {
        const t = new Date(m.due_at);
        if (isNaN(t.getTime())) continue;
        const sm = t.getHours() * 60 + t.getMinutes();
        busy.push({ startMin: sm, endMin: sm + m.dur, reason: 'meeting_conflict' });
    }

    // 8. Buffer-zoner omkring dagens bons (events)
    const bufBefore = parseInt(getSetting('booking_event_buffer_before_min') || '120');
    const bufAfter  = parseInt(getSetting('booking_event_buffer_after_min')  || '60');
    const bons = db.prepare(`
        SELECT b.pickup_time, b.delivery_time
        FROM bons b
        JOIN status_definitions sd ON b.status_id = sd.id
        WHERE b.delivery_date = ?
          AND b.is_offer = 0
          AND sd.code NOT IN ('AFLYST','TILBUD','AFSLUTTET')
    `).all(date);

    for (const b of bons) {
        // Brug pickup_time hvis sat, ellers delivery_time
        const eventTime = b.pickup_time || b.delivery_time;
        if (!eventTime) continue;
        const em = toMin(eventTime);
        if (em == null) continue;
        busy.push({
            startMin: em - bufBefore,
            endMin: em + bufAfter,
            reason: 'buffer_event'
        });
    }

    // 9. Marker slots der overlapper busy-intervaller
    const result = slots.map(s => {
        const conflict = busy.find(b => s.startMin < b.endMin && s.endMin > b.startMin);
        return {
            time: s.time,
            available: !conflict,
            reason: conflict?.reason
        };
    });

    return {
        available: true,
        meeting_type: { id: mt.id, duration_min: durationMin },
        slots: result
    };
}

/**
 * Race-condition guard ved submit: gen-tjek at slot stadig er ledigt
 * lige før vi inserter crm_activity.
 *
 * Returnerer { ok: true } eller { ok: false, reason }.
 */
function isSlotStillFree(date, time, meetingTypeKey) {
    const result = computeSlotsForDate(date, meetingTypeKey);
    if (!result.available) {
        return { ok: false, reason: result.reason };
    }
    const slot = result.slots.find(s => s.time === time);
    if (!slot) return { ok: false, reason: 'slot_not_in_grid' };
    if (!slot.available) return { ok: false, reason: slot.reason || 'occupied' };
    return { ok: true, meeting_type: result.meeting_type };
}

// ============================================================
// CUSTOMER MATCHING
// ============================================================
// Strategi (matcher web-orders.js + patch P5):
//   1. Hvis token: brug customer_id fra token (sælger valgte allerede kunden).
//   2. Ellers: match på email. Hvis fundet → brug eksisterende kunde.
//   3. Ellers: opret ny kunde + (valgfrit) ny company.
//
// Returnerer { customerId, companyId, source: 'token'|'email'|'created' }.

function matchOrCreateCustomer({ token, first_name, last_name, email, phone, company_name }) {
    const db = getDb();

    // 1. Token har præcedens
    if (token) {
        const t = db.prepare(
            'SELECT customer_id, company_id FROM booking_tokens WHERE token = ? AND expires_at > datetime(\'now\')'
        ).get(token);
        if (t?.customer_id) {
            return { customerId: t.customer_id, companyId: t.company_id, source: 'token' };
        }
    }

    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanFirst = (first_name || '').trim();
    const cleanLast  = (last_name  || '').trim() || null;
    const cleanPhone = (phone      || '').trim() || null;
    const cleanCo    = (company_name || '').trim();

    // 2. Email-match
    if (cleanEmail) {
        const existing = db.prepare(
            'SELECT id, company_id FROM customers WHERE LOWER(email) = ? AND is_active = 1 LIMIT 1'
        ).get(cleanEmail);
        if (existing) {
            return { customerId: existing.id, companyId: existing.company_id, source: 'email' };
        }
    }

    // 3. Find/opret company hvis firmanavn givet
    let companyId = null;
    if (cleanCo) {
        const existingCo = db.prepare(
            'SELECT id FROM companies WHERE name = ? AND is_active = 1 LIMIT 1'
        ).get(cleanCo);
        if (existingCo) {
            companyId = existingCo.id;
        } else {
            const r = db.prepare(
                'INSERT INTO companies (name, is_active) VALUES (?, 1)'
            ).run(cleanCo);
            companyId = Number(r.lastInsertRowid);
        }
    }

    // 4. Opret kunde
    const r = db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone, company_id, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
    `).run(cleanFirst, cleanLast, cleanEmail || null, cleanPhone, companyId);

    return { customerId: Number(r.lastInsertRowid), companyId, source: 'created' };
}

// ============================================================
// SALES OWNER RESOLUTION
// ============================================================
// Token har præcedens (sælger valgte allerede kunden).
// Ellers default-ejer fra settings — public webhook bør 503'e
// før vi når her hvis default mangler.

function resolveSalesOwner(token) {
    const db = getDb();
    if (token) {
        const t = db.prepare(
            'SELECT sales_user_id FROM booking_tokens WHERE token = ? AND expires_at > datetime(\'now\')'
        ).get(token);
        if (t?.sales_user_id) return t.sales_user_id;
    }
    const v = getSetting('booking_default_owner_user_id');
    return v ? parseInt(v) : null;
}

// ============================================================
// MAIL VARS BUILDERS (M7)
// ============================================================
// Hver builder returnerer det fulde sæt af {{variabler}} til den
// pågældende skabelon. Slår firma-info op fra settings (migration 025)
// og kunde/firma fra DB. Manglende værdier returneres som tom streng
// så renderTemplate ikke efterlader synlige placeholders.
//
// Datoformat: dansk locale, fx "torsdag 7. maj 2026". Matcher tilbud +
// fakturering. Tid-formatet er "HH:MM".

function fmtDanishDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr.length === 10 ? dateStr + 'T12:00:00' : dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('da-DK', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fullName(first, last) {
    return [first, last].filter(s => s && String(s).trim()).join(' ').trim();
}

function loadCustomerWithCompany(customerId) {
    const db = getDb();
    return db.prepare(`
        SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.company_id,
               co.name AS company_name
        FROM customers c
        LEFT JOIN companies co ON co.id = c.company_id
        WHERE c.id = ?
    `).get(customerId);
}

function buildCommonVars() {
    return {
        firmaNavn:    getSetting('company_name')    || 'Ristet Rug',
        firmaAdresse: getSetting('company_address') || '',
        firmaTelefon: getSetting('company_phone')   || '',
        firmaEmail:   getSetting('company_email')   || ''
    };
}

/**
 * Skabelon-vars til booking_smagning_confirmation + booking_smagning_reminder.
 *
 * @param {Object} args
 * @param {number} args.customerId
 * @param {Object} args.meetingType  { id, key, label, duration_min }
 * @param {string} args.date         YYYY-MM-DD
 * @param {string} args.time         HH:MM
 */
function buildSmagningMailVars({ customerId, meetingType, date, time }) {
    const cust = loadCustomerWithCompany(customerId) || {};
    return {
        ...buildCommonVars(),
        kundeFornavn:    cust.first_name || '',
        kundeNavn:       fullName(cust.first_name, cust.last_name) || cust.email || '',
        kundeEmail:      cust.email || '',
        kundeTelefon:    cust.phone || '',
        moedeTypeLabel:  meetingType?.label || '',
        varighed:        meetingType?.duration_min != null ? String(meetingType.duration_min) : '',
        datoFormatteret: fmtDanishDate(date),
        tid:             time || ''
    };
}

/**
 * Skabelon-vars til booking_smagning_reminder (M9 cron).
 *
 * @param {Object} meeting  Et resultat fra cron-query med fields:
 *   { id, due_at, duration_min, customer_id, first_name, last_name, email,
 *     meeting_label, meeting_key }
 */
function buildReminderVars(meeting) {
    const dueAt = meeting.due_at || '';
    const datePart = dueAt.slice(0, 10);   // YYYY-MM-DD
    const timePart = dueAt.slice(11, 16);  // HH:MM

    const cust = loadCustomerWithCompany(meeting.customer_id) || {};
    return {
        ...buildCommonVars(),
        kundeFornavn:    cust.first_name || meeting.first_name || '',
        kundeNavn:       fullName(cust.first_name, cust.last_name) || meeting.email || '',
        kundeEmail:      cust.email || meeting.email || '',
        kundeTelefon:    cust.phone || '',
        moedeTypeLabel:  meeting.meeting_label || '',
        varighed:        meeting.duration_min != null ? String(meeting.duration_min) : '',
        datoFormatteret: fmtDanishDate(datePart),
        tid:             timePart || ''
    };
}

/**
 * Skabelon-vars til booking_kontakt_confirmation.
 */
function buildKontaktMailVars({ customerId, contactReason }) {
    const cust = loadCustomerWithCompany(customerId) || {};
    return {
        ...buildCommonVars(),
        kundeFornavn:        cust.first_name || '',
        kundeNavn:           fullName(cust.first_name, cust.last_name) || cust.email || '',
        kundeEmail:          cust.email || '',
        kundeTelefon:        cust.phone || '',
        kontaktAarsagLabel:  contactReason?.label || ''
    };
}

/**
 * Skabelon-vars til booking_internal_notification.
 *
 * @param {Object} args
 * @param {number} args.customerId
 * @param {string} args.flow             'smagning' | 'kontakt'
 * @param {Object} [args.meetingType]    smagning-flow
 * @param {Object} [args.contactReason]  kontakt-flow
 * @param {string} [args.date]           smagning-flow
 * @param {string} [args.time]           smagning-flow
 * @param {Object} [args.formData]       Rå webhook-data (guest_count, message)
 */
function buildInternalNotificationVars({ customerId, flow, meetingType, contactReason, date, time, formData }) {
    const cust = loadCustomerWithCompany(customerId) || {};
    const flowLabel = flow === 'smagning' ? 'Smagsprøve' : (flow === 'kontakt' ? 'Kontakt' : flow);

    const baseUrl = (getSetting('booking_public_url_base') || '').replace(/\/+$/, '');
    const crmKundeUrl = baseUrl ? `${baseUrl}/office/?view=crm-kunde360&id=${customerId}` : '';

    const guestCount = formData?.guest_count ? String(formData.guest_count) : '';
    const message    = (formData?.message || '').trim();

    return {
        ...buildCommonVars(),
        kundeNavn:           fullName(cust.first_name, cust.last_name) || cust.email || '',
        firmaNavn:           cust.company_name || (buildCommonVars().firmaNavn),
        kundeEmail:          cust.email || '',
        kundeTelefon:        cust.phone || '',
        flowType:            flowLabel,
        moedeTypeLabel:      meetingType?.label || '',
        kontaktAarsagLabel:  contactReason?.label || '',
        datoFormatteret:     fmtDanishDate(date),
        tid:                 time || '',
        antalGaester:        guestCount,
        beskedFraKunde:      message,
        crmKundeUrl:         crmKundeUrl
    };
}

/**
 * Send intern notifikation til sælger ved ny booking.
 *
 * Springes over hvis:
 *   - booking_notify_owner_enabled !== '1'
 *   - ownerId er null (kan ske hvis ingen default-ejer er sat — public flow 503'er
 *     før vi når her, men token-flow uden sales_user_id kan ramme det)
 *   - owner mangler email
 *
 * Fire-and-forget — fejl logges men kastes ikke videre.
 */
async function sendInternalNotification({ ownerId, flow, customerId, meetingType, contactReason, date, time, formData }) {
    if (getSetting('booking_notify_owner_enabled') !== '1') return;
    if (!ownerId) {
        console.log('[booking] Intern notif sprunget over: ingen owner');
        return;
    }

    const db = getDb();
    const owner = db.prepare(
        'SELECT id, email, name FROM users WHERE id = ? AND is_active = 1'
    ).get(ownerId);
    if (!owner?.email) {
        console.log(`[booking] Intern notif sprunget over: owner #${ownerId} har ingen email`);
        return;
    }

    const vars = buildInternalNotificationVars({
        customerId, flow, meetingType, contactReason, date, time, formData
    });

    try {
        const { sendFromTemplate } = require('./mailService');
        await sendFromTemplate({
            templateKey: 'booking_internal_notification',
            to: owner.email,
            vars,
            customerId,
            smtpPrefix: 'smtp_kontakt',
            isSystem: true   // intern notif → rør ikke kundens handling_status
        });
        console.log(`[booking] Intern notif sendt til ${owner.email} (owner #${ownerId})`);
    } catch (err) {
        console.error('[booking] Intern notif fejl:', err.message);
    }
}

module.exports = {
    computeSlotsForDate,
    isSlotStillFree,
    matchOrCreateCustomer,
    resolveSalesOwner,
    buildSmagningMailVars,
    buildKontaktMailVars,
    buildInternalNotificationVars,
    buildReminderVars,
    sendInternalNotification,
    fmtDanishDate
};
