# CRM Booking-modul — Patch til Spec v2

> Status: skal læses sammen med `CRM_Booking_Spec_v2.md`.
> Disse rettelser SKAL anvendes før implementering af Fase 14 påbegyndes.
>
> **Implementeringsstatus (28. apr 2026):** P1, P2, P3 anvendt under M1–M6. **P4 anvendt under M7** (idempotens-tjek i `generateBookingToken`). P5-helpers implementeret undervejs (`matchOrCreateCustomer`, `resolveSalesOwner` i M5+M6; `buildSmagningMailVars`, `buildKontaktMailVars`, `buildInternalNotificationVars`, `sendInternalNotification` i M7). Se [CLAUDE.md Fase 14](../CLAUDE.md) for milepælsbesked.

---

## Hvorfor denne patch?

Spec v2 blev skrevet uden at slå det faktiske `crm_activities`-skema op. Tre antagelser holder ikke:

1. Spec'en bruger en kolonne ved navn `outcome`. Den findes ikke — kolonnen hedder `result`.
2. Spec'en bruger værdien `'planned'`. CHECK-constraint på `result` tillader det ikke.
3. Spec'en 503'er offentlige GET-endpoints hvis owner mangler. Det giver kunden en fejlside i stedet for en pæn melding.

Derudover er slot-logikken (buffertider mod bons) underspecificeret, og token-genereringspolicyen mangler en idempotens-regel.

---

## P1 — Fejl: `outcome` findes ikke, brug `result` + `done_at` ✅ ANVENDT (M5+M6)

**Implementering:**
- Migration 051 tilføjer IKKE `outcome`-kolonne. Bruger `done_at IS NULL` som "planlagt".
- `handleSmagningBooking` (M5): INSERT bruger ingen `outcome`/`result` for meetings — `done_at IS NULL` betyder planlagt.
- `handleKontaktBooking` (M6): `result='callback'` KUN når `reason.key === 'ring_op'` → lander automatisk i `v_callbacks_pending`.
- Cron-erindring (M9 pending) vil bruge `WHERE done_at IS NULL` i stedet for `outcome='planned'`.

### Faktisk skema (migration 019)

```sql
CREATE TABLE crm_activities (
    ...
    result    TEXT CHECK (result IS NULL OR result IN (
                  'reached','no_answer','busy','voicemail','callback','email_instead')),
    due_at    DATETIME,    -- planlagt tidspunkt
    done_at   DATETIME,    -- udfyldt når afsluttet → "pending" = NULL
    ...
);
```

Der er INGEN `outcome`-kolonne. "Planlagt" udtrykkes via `done_at IS NULL`. Index `idx_crm_act_pending` er allerede bygget på det mønster.

### Rettelser i spec

**Sektion 5.2 (`handleSmagningBooking`) — INSERT'en bliver:**

```javascript
const dueAt = `${data.date} ${data.time}:00`;
const activityRes = db.prepare(`
    INSERT INTO crm_activities (
        customer_id, type, meeting_type_id, due_at, duration_min,
        guest_count, event_type, text, owner_user_id,
        booked_via, created_at
    ) VALUES (?, 'meeting', ?, ?, ?, ?, ?, ?, ?, 'public_smagning', datetime('now'))
`).run(
    customerId, mt.id, dueAt, mt.duration_min,
    data.guest_count || null, data.event_type || null,
    data.message || null, ownerId
);
```

`outcome`-kolonnen fjernes helt fra INSERT.

**Sektion 8 (Flow B kontakt-task) — bliver:**

```javascript
// type='task' for kontakt-flow
// "Ring mig op" → result='callback' (matcher v_callbacks_pending view)
// Andre årsager → result=NULL (almindelig task)
const result = (reason.key === 'ring_op') ? 'callback' : null;

db.prepare(`
    INSERT INTO crm_activities (
        customer_id, type, contact_reason_id, result, text, owner_user_id,
        booked_via, created_at
    ) VALUES (?, 'task', ?, ?, ?, ?, 'public_kontakt', datetime('now'))
`).run(customerId, reason.id, result, message, ownerId);
```

Bemærk: `due_at` sættes IKKE for kontakt-tasks (de har ikke et planlagt tidspunkt). Det matcher `v_callbacks_pending`-viewet, der finder tasks via `result='callback' AND done_at IS NULL`.

**Sektion 5.3 (cron-erindring) — WHERE-clause bliver:**

```sql
WHERE a.type = 'meeting'
  AND DATE(a.due_at) = ?
  AND a.done_at IS NULL                  -- erstatter a.outcome = 'planned'
  AND a.reminder_sent_at IS NULL
  AND c.email IS NOT NULL AND c.email != ''
```

**Sektion 13 (eksempel-flow) — sletfornem:** ingen referencer til `outcome='planned'` eller `outcome='callback'`. Erstat med "task lander på Ring-tilbage-listen via `result='callback'`".

### Konsekvens for migration 051

Migrationen tilføjer IKKE en `outcome`-kolonne. De nye kolonner forbliver:

```sql
ALTER TABLE crm_activities ADD COLUMN meeting_type_id     INTEGER REFERENCES meeting_types(id);
ALTER TABLE crm_activities ADD COLUMN contact_reason_id   INTEGER REFERENCES contact_reasons(id);
ALTER TABLE crm_activities ADD COLUMN duration_min        INTEGER;
ALTER TABLE crm_activities ADD COLUMN guest_count         INTEGER;
ALTER TABLE crm_activities ADD COLUMN event_type          TEXT;
ALTER TABLE crm_activities ADD COLUMN booked_via          TEXT;
ALTER TABLE crm_activities ADD COLUMN reminder_sent_at    DATETIME;
```

---

## P2 — Slot-beregning: konkret algoritme ✅ ANVENDT (M3+M5)

**Implementering:** algoritmen ligger i `services/bookingMatcher.js` som `computeSlotsForDate()` + `isSlotStillFree()`. Race-condition guard: `handleSmagningBooking` wrapper slot-tjek + INSERT i `transaction(db, ...)` fra `db/compat.js`. 10/10 testcases verificeret i M3 — almindelig dag, søndag (`weekday_blocked`), too_soon, too_far, ukendt mt, ugyldig dato, manglende params, lang mt (75 min), `meeting_conflict` (eksisterende meeting), `buffer_event` (bons-pickup/delivery + buffer). Race-test i M5 (T5): book samme slot to gange → `error: slot_conflict`.

Spec'en nævner buffertid mod event-leveringer men har ingen kode. Her er specifikationen:

### Endpoint
```
GET /api/booking/slots?date=YYYY-MM-DD&meeting_type=smagning[&token=...]
→ { slots: [ { time: "09:00", available: true }, { time: "09:30", available: false, reason: "buffer_before_event" }, ... ] }
```

### Algoritme

```javascript
function computeSlotsForDate(date, meetingTypeKey) {
    const db = getDb();

    // 1. Tjek ugedag spærret
    const blocked = JSON.parse(getSetting('booking_blocked_weekdays') || '[]');
    const dow = new Date(date + 'T12:00:00').getDay(); // 0=søn
    if (blocked.includes(dow)) return [];

    // 2. Tjek inden for tilladt vindue
    const minDays = parseInt(getSetting('booking_min_days_ahead') || '2');
    const maxDays = parseInt(getSetting('booking_max_days_ahead') || '90');
    const today = new Date(); today.setHours(0,0,0,0);
    const target = new Date(date + 'T00:00:00');
    const daysAhead = Math.round((target - today) / 86400000);
    if (daysAhead < minDays || daysAhead > maxDays) return [];

    // 3. Hent meeting type for varighed
    const mt = db.prepare('SELECT duration_min FROM meeting_types WHERE key = ? AND is_active = 1').get(meetingTypeKey);
    if (!mt) return [];
    const durationMin = mt.duration_min;

    // 4. Generér rå slots fra workday_start → workday_end i steps
    const startStr = getSetting('booking_workday_start') || '09:00';
    const endStr   = getSetting('booking_workday_end')   || '16:30';
    const stepMin  = parseInt(getSetting('booking_slot_step_min') || '30');
    const slots = []; // array af { time, startMin, endMin }
    let cur = toMin(startStr);
    const dayEnd = toMin(endStr);
    while (cur + durationMin <= dayEnd) {
        slots.push({ time: fromMin(cur), startMin: cur, endMin: cur + durationMin });
        cur += stepMin;
    }

    // 5. Hent dagens optagede intervaller fra crm_activities (planlagte møder)
    const meetings = db.prepare(`
        SELECT due_at, COALESCE(duration_min, 30) AS dur
        FROM crm_activities
        WHERE type = 'meeting'
          AND DATE(due_at) = ?
          AND done_at IS NULL
    `).all(date);
    const busy = meetings.map(m => {
        const t = new Date(m.due_at);
        const sm = t.getHours() * 60 + t.getMinutes();
        return { startMin: sm, endMin: sm + m.dur, reason: 'meeting_conflict' };
    });

    // 6. Hent dagens bons med pickup/delivery for buffer-zoner
    const bufBefore = parseInt(getSetting('booking_event_buffer_before_min') || '120');
    const bufAfter  = parseInt(getSetting('booking_event_buffer_after_min')  || '60');
    const bons = db.prepare(`
        SELECT pickup_time, delivery_time
        FROM bons
        WHERE delivery_date = ?
          AND status_id IN (SELECT id FROM status_definitions WHERE code NOT IN ('AFLYST','TILBUD'))
    `).all(date);
    for (const b of bons) {
        // Brug pickup_time hvis sat, ellers delivery_time
        const eventTime = b.pickup_time || b.delivery_time;
        if (!eventTime) continue;
        const em = toMin(eventTime);
        busy.push({ startMin: em - bufBefore, endMin: em + bufAfter, reason: 'buffer_event' });
    }

    // 7. Marker slots der overlapper busy-intervaller
    return slots.map(s => {
        const conflict = busy.find(b => s.startMin < b.endMin && s.endMin > b.startMin);
        return {
            time: s.time,
            available: !conflict,
            reason: conflict?.reason
        };
    });
}

function toMin(hhmm)  { const [h,m] = hhmm.split(':').map(Number); return h*60 + m; }
function fromMin(min) { return String(Math.floor(min/60)).padStart(2,'0') + ':' + String(min%60).padStart(2,'0'); }
```

### Race-condition guard ved submit

`isSlotAvailable(date, time, durationMin, token)` i `handleSmagningBooking` skal kalde `computeSlotsForDate(date, ...)` igen og verificere at det ønskede tidspunkt stadig står som `available: true`. Kør i transaction så INSERT + slot-tjek er atomisk:

```javascript
const result = transaction(db, () => {
    const slots = computeSlotsForDate(data.date, data.meeting_type);
    const slot = slots.find(s => s.time === data.time);
    if (!slot || !slot.available) {
        return { conflict: true };
    }
    // INSERT crm_activity her
    return { activityId };
});
if (result.conflict) {
    console.warn('[booking-smagning] Slot optaget ved submit');
    return null;
}
```

---

## P3 — UX: GET-endpoints må ikke 503'e ved manglende owner ✅ ANVENDT (M2)

**Implementering:** `GET /api/booking/meeting-types` og `/contact-reasons` returnerer `{available: false, reason: 'disabled' | 'unconfigured', meeting_types: []}` i stedet for 503. `tools/booking-smagning.html` + `tools/booking-kontakt.html` viser "Booking er ikke tilgængelig"-besked når `available: false`. Kun submit-webhooks (`POST /webhook/booking-smagning` + `/booking-kontakt`) returnerer 503 — verificeret i M5 T7. Token-baserede submits er undtaget (forventet implementeret i M7+M8).

Sektion 14.4 i specen vil 503'e `GET /meeting-types` og `GET /contact-reasons` hvis `booking_default_owner_user_id` er tom. Det betyder kunden får en fejlside.

### Rettelse

- **Webhook-endpoints** (`POST /webhook/booking-*`): 503 ved manglende owner. Webhook'en kan ikke køre meningsfuldt uden ejer.
- **GET-endpoints** (alle): returnerer altid 200 med data. Hvis `booking_*_enabled !== '1'` eller default owner mangler, returneres `{ available: false, reason: 'disabled' | 'unconfigured' }` så frontend kan vise en pæn melding ("Vi tager ikke imod bookings online lige nu — ring til os").
- **Token-baserede submits** (`POST /webhook/booking-smagning` med `?t=...`): tilladt selv hvis default owner mangler (bruger `sales_user_id` fra token).

### Frontend-håndtering

`tools/booking-smagning.html` ved init kalder `GET /api/booking/meeting-types` først. Hvis `available: false`, vises melding-kort i stedet for kalender. Ingen JS-fejl.

---

## P4 — Token-idempotens ✅ ANVENDT (M7)

**Implementering:** `generateBookingToken()` i `services/mailService.js` slår først eksisterende ubrugt token op via composite-key `(customer_id, sales_user_id, flow, intent_meeting_type_id)` med `booking_activity_id IS NULL` og `expires_at > now() + booking_token_reuse_min_days` (default 7). Hvis fundet → returnér uden at indsætte. `renderTemplate({{booking_link}})` kalder helperen, så samme mail genereret 5 gange i træk → kun én token-række. Verificeret via `scripts/test-m7a.js`: 2 kald = samme token + præcis 1 DB-række.

### Anbefalet regel

Ved generering: tjek først for eksisterende token med samme `(customer_id, sales_user_id, flow, intent_meeting_type_id)` og `expires_at > now() + 7 days`. Genbrug hvis fundet.

```javascript
const existing = db.prepare(`
    SELECT token FROM booking_tokens
    WHERE customer_id = ?
      AND COALESCE(sales_user_id, 0) = COALESCE(?, 0)
      AND flow = ?
      AND COALESCE(intent_meeting_type_id, 0) = COALESCE(?, 0)
      AND booking_activity_id IS NULL
      AND expires_at > datetime('now', '+7 days')
    ORDER BY created_at DESC
    LIMIT 1
`).get(customer_id, sales_user_id, flow, intentId);

if (existing) return existing.token;

// ellers generér nyt som beskrevet i spec
```

Tokens der allerede er brugt (`booking_activity_id IS NOT NULL`) genbruges ikke — så hvis kunden har booket og sælger sender en ny mail, får de et nyt link til en ny booking.

---

## P5 — Manglende helpers ✅ ANVENDT (M5+M6+M7)

**Implementeret i M5+M6:**
- `matchOrCreateCustomer({ token, first_name, last_name, email, phone, company_name })` i `services/bookingMatcher.js` — token > email-match > opret. Returnerer `{ customerId, companyId, source }`.
- `resolveSalesOwner(token)` i `services/bookingMatcher.js` — token > `booking_default_owner_user_id` > null.

**Implementeret i M7 (alle i `services/bookingMatcher.js`):**
- `buildSmagningMailVars({ customerId, meetingType, date, time })` — fuldt sæt `{{variabler}}` til `booking_smagning_confirmation` (firmaNavn/Adresse/Telefon/Email fra settings, kunde-felter fra DB, datoFormatteret via `toLocaleDateString('da-DK', { weekday, day, month, year })`).
- `buildKontaktMailVars({ customerId, contactReason })` — vars til `booking_kontakt_confirmation`.
- `buildInternalNotificationVars({ customerId, flow, meetingType, contactReason, date, time, formData })` — vars til `booking_internal_notification` inkl. `flowType` ('Smagsprøve'/'Kontakt'), `crmKundeUrl`.
- `sendInternalNotification({ ownerId, flow, customerId, ... })` — slår owner-email op fra `users`-tabellen, kalder `sendFromTemplate('booking_internal_notification', ...)` via `smtp_kontakt`. Springes hvis `booking_notify_owner_enabled !== '1'`, owner mangler email, eller kald skipper eksplicit (token-flow).

**Pending (M9):** `buildReminderVars(meetingRow)` til erindrings-cron.

Specen kalder disse uden at definere dem:

- `buildSmagningMailVars(customerId, companyId, mt, data)` — skal returnere objekt med alle `{{variabler}}` for `booking_smagning_confirmation`. Slår firmaTelefon/firmaAdresse op fra `settings`.
- `buildReminderVars(meetingRow)` — samme for erindring.
- `sendInternalNotification(ownerId, flow, ctx)` — slår owner-email op fra `users`-tabellen, kalder `sendFromTemplate` med `booking_internal_notification`.
- `matchOrCreateCustomer({ token, ... })` — i `services/bookingMatcher.js`. Følger mønstret fra `web-orders.js`: token > email-match > opret. Privatkunder: opret company med `is_personal=1` hvis `company_name` er tom.
- `resolveSalesOwner(token)` — token > `booking_default_owner_user_id` > null (allerede 503'et før vi når her).

Disse implementeres direkte under Dag 2-3 i 6-dages-planen. Ingen ændring til specen, men nævnt så de ikke overses.

---

## Tjekliste — anvendelsesstatus

- [x] Migration 051 fjerner alle `outcome`-referencer (M1)
- [x] `routes/booking.js` bruger `done_at IS NULL` for "planlagt" og `result='callback'` for ring-tilbage (M5+M6)
- [x] Slot-algoritmen i sektion P2 kopieres ind i `services/bookingMatcher.js` (M3)
- [x] GET-endpoints returnerer `{available: false}` i stedet for 503 når modulet ikke er konfigureret (M2)
- [x] `mailService.generateBookingToken()` genbruger eksisterende ubrugte tokens (M7)
- [ ] `cron`-scriptet bruger den korrigerede WHERE-clause (`done_at IS NULL`) (afventer M9)

**5 af 6 punkter anvendt.** Det sidste anvendes i M9.
