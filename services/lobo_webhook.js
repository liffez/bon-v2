// services/lobo_webhook.js
// ==========================================
// Indgående Lobo-webhooks (Byekspressen) → delivery_events + SSE.
//
// Lobo kalder vores URL med query-params: ?ts=&event=&target=order&orderuuid=
// og signerer med HMAC (per-webhook hmac_key). Den PRÆCISE signerede streng +
// header-navn kan først bekræftes mod sandbox → verifikationen er konfigurerbar
// og default FRA (advarsel logges) indtil formatet er verificeret.
//
// Logikken er adskilt fra route-laget (injiceret db/adapter/broadcast) så den
// kan unit-testes uden netværk. Spec: docs/CLAUDE_LEVERING_LOBO.md §10.
// ==========================================

const { verifyWebhookSignature, mapLoboEvent } = require('./byExpressenAdapter');

// Bestem om en webhook skal accepteres. Indtil signatur-formatet er bekræftet
// (setting lobo_webhook_verify='1') springes verifikationen over med en advarsel.
function verifyLoboRequest({ rawQuery, headers = {}, settings = {} }) {
    if (settings.verify !== '1') {
        return { ok: true, skipped: true, reason: 'verification_disabled' };
    }
    const header = (settings.sig_header || 'x-lobo-signature').toLowerCase();
    const sig = headers[header];
    const key = settings.hmac_key;
    if (!key) return { ok: false, reason: 'no_hmac_key' };
    // signeret streng: default query-strengen (alternativt fuld URL — verificeres live)
    const payload = settings.sign_target === 'fullurl' ? (settings.full_url || rawQuery) : rawQuery;
    const ok = verifyWebhookSignature(payload, sig, key, settings.algorithm || 'sha256');
    return { ok, reason: ok ? 'verified' : 'bad_signature' };
}

// Anvend et webhook-event. Returnerer { ok, status, reason }.
// status er delivery_events.event_type (eller null hvis ingen status-ændring).
async function applyWebhookEvent({ query, db, broadcast, getOrder = null }) {
    const target = query.target || 'order';
    const event = query.event;
    const uuid = query.orderuuid;
    const ts = query.ts;
    if (!event || !uuid) return { ok: false, reason: 'missing_params' };

    // Find bonnen via den oprindelige booking (external_reference = order-uuid).
    const link = db.prepare(
        `SELECT bon_id FROM delivery_events WHERE external_reference = ? ORDER BY id LIMIT 1`
    ).get(uuid);
    if (!link) return { ok: false, reason: 'unknown_order' };
    const bonId = link.bon_id;

    // Idempotens: samme (uuid, event, ts) må kun behandles én gang.
    const marker = `lobo:${event} ts=${ts || ''}`;
    const dup = db.prepare(
        `SELECT 1 FROM delivery_events WHERE external_reference = ? AND notes = ?`
    ).get(uuid, marker);
    if (dup) return { ok: true, reason: 'duplicate', status: null };

    // Map event → event_type. stopvisitedorsigned disambigueres via stops.
    let status = mapLoboEvent(target, event);
    let snapshot = null;
    if (event === 'stopvisitedorsigned' && getOrder) {
        try {
            const order = await getOrder(uuid);
            snapshot = order;
            const stops = (order && order.stops) || [];
            const maxPos = stops.reduce((m, s) => Math.max(m, Number(s.position) || 0), 0);
            const visited = stops.filter(s => s.visited || s.signatureuploaded);
            const lastVisited = visited.some(s => Number(s.position) === maxPos);
            status = lastVisited ? 'delivered' : 'picked_up';
        } catch {
            status = 'picked_up'; // kunne ikke hente detaljer — antag afhentet
        }
    }

    if (!status) {
        // changed/accounted o.l. — ingen status-ændring, men markér behandlet
        db.prepare(
            `INSERT INTO delivery_events (bon_id, event_type, provider, external_reference, notes, event_time)
             VALUES (?, 'booked', 'byekspressen', ?, ?, CURRENT_TIMESTAMP)`
        ).run(bonId, uuid, `[note] ${marker}`);
        return { ok: true, reason: 'no_status_change', status: null, bon_id: bonId };
    }

    db.prepare(
        `INSERT INTO delivery_events
            (bon_id, event_type, provider, external_reference, notes, snapshot_json, event_time)
         VALUES (?, ?, 'byekspressen', ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(bonId, status, uuid, marker, snapshot ? JSON.stringify(snapshot) : null);

    if (broadcast) broadcast('delivery_event', { bon_id: bonId, external_reference: uuid, status });
    return { ok: true, reason: 'applied', status, bon_id: bonId };
}

module.exports = { verifyLoboRequest, applyWebhookEvent };
