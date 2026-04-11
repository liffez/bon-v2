/**
 * services/goodsReceiptWebhook.js
 * ════════════════════════════════════════════════════════════
 * Sender varemodtagelse-data til Whiteboard via webhook.
 * Kun fødevarekontrol-data — intet om Grocy eller varemængder.
 *
 * Asynkron, non-blocking. Fejl logges i webhook_log.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');

/**
 * Send webhook til Whiteboard (fire-and-forget).
 * @param {Object} receipt  - goods_receipts row fra DB
 * @param {string} userName - navn på modtager
 */
async function send(receipt, userName) {
    const db = getDb();

    const webhookUrl = db.prepare(
        `SELECT value FROM settings WHERE key = 'whiteboard_webhook_url'`
    ).get()?.value;

    if (!webhookUrl) return; // bonv2_only mode

    const payload = {
        schema_name: 'varemodtagelse',
        user: userName,
        supplier: receipt.supplier_name,
        data: {
            temperature_cool_enabled:   !!receipt.temperature_cool_enabled,
            temperature_cool_value:     receipt.temperature_cool_value,
            temperature_cool_ok:        !!receipt.temperature_cool_ok,
            temperature_frozen_enabled: !!receipt.temperature_frozen_enabled,
            temperature_frozen_value:   receipt.temperature_frozen_value,
            temperature_frozen_ok:      !!receipt.temperature_frozen_ok,
            date_check:                 !!receipt.date_check_ok,
            labeling_check:             !!receipt.labeling_check_ok,
            packaging_check:            !!receipt.packaging_check_ok,
            photo_path:                 receipt.photo_path
                ? `https://bon.ristetrug.dk${receipt.photo_path}`
                : null,
            deviation:                  receipt.has_deviation ? (receipt.deviation_type || 'unknown') : 'none',
            deviation_note:             receipt.deviation_note || null,
            bon_v2_receipt_id:          receipt.id,
            bon_v2_receipt_number:      receipt.receipt_number,
        }
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
}

module.exports = { send };
