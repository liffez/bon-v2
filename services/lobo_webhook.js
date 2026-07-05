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

const crypto = require('node:crypto');
const { verifyWebhookSignature, mapLoboEvent } = require('./byExpressenAdapter');

// ══════════════════════════════════════════════════════════════
// SELVKALIBRERENDE HMAC
// ══════════════════════════════════════════════════════════════
// Lobos docs siger IKKE hvad HMAC'en signeres over eller hvilken header den
// ligger i (bekræftet doc-hul). I stedet for at gætte: vi gemmer per-event
// hmac_key'erne ved registrering, og det FØRSTE rigtige callback brute-forcer
// vi kandidat-strenge × nøgler × headers — finder vi et match, gemmes formatet
// (header + signeret streng) og verifikation slås til automatisk. Samme
// navngivne kandidat-sæt bruges i kalibrering OG verifikation.

function signCandidates({ rawQuery = '', pathQuery = '', registeredUrl = '', body = '' } = {}) {
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const regFull = registeredUrl
        ? registeredUrl + (rawQuery ? (registeredUrl.includes('?') ? '&' : '?') + rawQuery : '')
        : '';
    return {
        query: rawQuery,
        path_query: pathQuery,
        full_url: regFull,
        full_url_no_scheme: regFull.replace(/^https?:\/\//, ''),
        body: bodyStr,
        body_query: bodyStr + rawQuery,
        query_body: rawQuery + bodyStr,
    };
}

// Auto-opdag signatur-formatet fra ét callback. keys = { event: hmac_key }.
// Returnerer { sig_header, sign_target, matched_event } ved match, ellers null.
function calibrateLoboSignature({ parts = {}, headers = {}, keys = {}, algorithm = 'sha256' }) {
    const cands = signCandidates(parts);
    const keyList = Object.entries(keys).filter(([, k]) => k);
    for (const [hk, hvRaw] of Object.entries(headers)) {
        const hv = Array.isArray(hvRaw) ? hvRaw.join('') : String(hvRaw || '');
        if (!hv) continue;
        const hvNorm = hv.toLowerCase().replace(/^.*=/, '');   // tål "sha256=..."-præfiks
        if (!/^[0-9a-f]{32,128}$/.test(hvNorm)) continue;      // skal ligne en hex-digest
        for (const [event, key] of keyList) {
            for (const [target, str] of Object.entries(cands)) {
                if (str === '') continue;
                const h = crypto.createHmac(algorithm, key).update(str, 'utf8').digest('hex').toLowerCase();
                if (hvNorm === h) return { sig_header: hk.toLowerCase(), sign_target: target, matched_event: event };
            }
        }
    }
    return null;
}

// Verificér et callback når formatet er kalibreret (lobo_webhook_verify='1').
// Vælger nøgle pr. event (multi-webhook) + bruger det opdagede format.
function verifyLoboRequest({ parts = {}, headers = {}, event, settings = {} }) {
    if (settings.verify !== '1') {
        return { ok: true, skipped: true, reason: 'verification_disabled' };
    }
    const header = (settings.sig_header || 'x-lobo-signature').toLowerCase();
    const sig = headers[header];
    let key = null;
    if (settings.keys) { try { key = (JSON.parse(settings.keys) || {})[event] || null; } catch { /* */ } }
    if (!key) key = settings.hmac_key || null;
    if (!key) return { ok: false, reason: 'no_hmac_key' };
    const cands = signCandidates(parts);
    const payload = cands[settings.sign_target] != null ? cands[settings.sign_target] : cands.query;
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

    if (broadcast) {
        broadcast('delivery_event', { bon_id: bonId, external_reference: uuid, status });
        // Live-push: lad bon-drawer + lister opdatere status-panelet via eksisterende
        // bon_updated-lytter (ingen ny SSE-plumbing nødvendig).
        broadcast('bon_updated', { id: bonId });
    }
    return { ok: true, reason: 'applied', status, bon_id: bonId };
}

module.exports = { verifyLoboRequest, applyWebhookEvent, calibrateLoboSignature, signCandidates };
