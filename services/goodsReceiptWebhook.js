/**
 * services/goodsReceiptWebhook.js
 * ════════════════════════════════════════════════════════════
 * Sender varemodtagelse-data til Whiteboard via webhook.
 * Kun fødevarekontrol-data — intet om Grocy eller varemængder.
 *
 * Asynkron, non-blocking. Fejl logges i webhook_log.
 *
 * Test-mode (NODE_ENV='test'): send() auto-mock'es — fanger kald i en
 * in-memory buffer i stedet for at lave HTTP-kald. Buffer eksponeres via
 * _getSentWebhooks() + _clearSentWebhooks() og bruges af test-mail-route
 * (T_VAREMOD_F_FAIL_05). Samme pattern som services/mailService.js.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');

const _IS_TEST = process.env.NODE_ENV === 'test';
const _sentWebhooks = [];

/**
 * Er koblingen til Whiteboard tændt?
 *
 * Tom URL = `bonv2_only`-mode (spec §"Tre driftsmodes"). Det er et lovligt
 * valg — men det er også den tilstand der i praksis gjorde varemodtagelsen
 * usynlig: send() sprang stille over, og intet sted kunne man se hvorfor.
 * Derfor eksponeres tilstanden nu, så både API-svar og Settings kan vise den.
 *
 * @returns {string|null} URL'en, eller null når koblingen er slukket
 */
function getWebhookUrl() {
    try {
        const row = getDb().prepare(
            `SELECT value FROM settings WHERE key = 'whiteboard_webhook_url'`
        ).get();
        const url = (row?.value || '').trim();
        return url || null;
    } catch {
        return null;
    }
}

function isConfigured() {
    return getWebhookUrl() !== null;
}

/**
 * Send webhook til Whiteboard (fire-and-forget fra POST-stien).
 *
 * Returnerer et resultat-objekt så kaldere der VENTER på den (gensend fra
 * listen og backfill-scriptet) kan fortælle hvad der skete. POST-stien
 * ignorerer returværdien og forbliver ikke-blokerende.
 *
 * @param {Object} receipt  - goods_receipts row fra DB
 * @param {string} userName - navn på modtager
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, statusCode?:number, error?:string}>}
 */
async function send(receipt, userName) {
    // Test-mode: fang kald i in-memory buffer og returner tidligt.
    // Ingen HTTP-trafik, ingen DB-skrivning til webhook_log.
    if (_IS_TEST) {
        _sentWebhooks.push({
            receipt_id: receipt.id,
            receipt_number: receipt.receipt_number,
            user_name: userName,
            supplier_name: receipt.supplier_name,
            captured_at: new Date().toISOString(),
        });
        return { ok: true, mode: 'test' };
    }

    const db = getDb();

    const webhookUrl = getWebhookUrl();

    // bonv2_only mode — registreringen ligger kun i Bon v2.
    if (!webhookUrl) return { ok: false, skipped: true, reason: 'not_configured' };

    // Map Bon v2's deviation_type til Whiteboard-skemaets select-options
    const deviationMap = {
        returned:           'returned',
        no_risk:            'accepted_no_risk',
        discarded:          'discarded',
        supplier_contacted: 'supplier_contacted',
        other:              'other',
    };

    const data = {
        date_ok:         !!receipt.date_check_ok,
        label_ok:        !!receipt.labeling_check_ok,
        packaging_ok:    !!receipt.packaging_check_ok,
        deviation:       receipt.has_deviation
            ? (deviationMap[receipt.deviation_type] || 'other')
            : 'none',
        deviation_note:  receipt.deviation_note || null,
        photo_path:      receipt.photo_path
            ? `https://bon.ristetrug.dk${receipt.photo_path}`
            : null,
        bon_v2_receipt_id:     receipt.id,
        bon_v2_receipt_number: receipt.receipt_number,
    };

    // Temperaturer sendes kun når toggle er aktiv — Whiteboard beregner
    // temperature_ok/_status selv via limit_max i skemaet.
    if (receipt.temperature_cool_enabled) {
        data.temperature = receipt.temperature_cool_value;
    }
    if (receipt.temperature_frozen_enabled) {
        data.temperature_freezer = receipt.temperature_frozen_value;
    }

    const payload = {
        schema_name: 'varemodtagelse',
        user: userName,
        supplier: receipt.supplier_name,
        data,
    };

    let statusCode = null;
    let error = null;

    try {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000), // 10s timeout
        });

        statusCode = response.status;

        if (response.ok) {
            // Success — marker som synced
            db.prepare(`UPDATE goods_receipts SET whiteboard_synced_at = datetime('now') WHERE id = ?`)
                .run(receipt.id);
            console.log(`[webhook] Whiteboard notificeret for ${receipt.receipt_number}`);
        } else {
            error = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
            console.warn(`[webhook] Whiteboard fejl for ${receipt.receipt_number}:`, error);
        }
    } catch (err) {
        error = err.message;
        console.warn(`[webhook] Whiteboard utilgængelig for ${receipt.receipt_number}:`, err.message);
    }

    // Log i webhook_log uanset resultat
    try {
        db.prepare(`
            INSERT INTO webhook_log (url, payload, status_code, error, sent_at)
            VALUES (?, ?, ?, ?, datetime('now'))
        `).run(
            webhookUrl,
            JSON.stringify(payload),
            statusCode,
            error
        );
    } catch (logErr) {
        console.error('[webhook] Kunne ikke logge webhook:', logErr.message);
    }

    return { ok: !error, statusCode, error };
}

function _getSentWebhooks() {
    return _sentWebhooks.slice();
}

function _clearSentWebhooks() {
    _sentWebhooks.length = 0;
}

module.exports = { send, isConfigured, getWebhookUrl, _getSentWebhooks, _clearSentWebhooks };
