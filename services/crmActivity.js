/**
 * services/crmActivity.js
 * ════════════════════════════════════════════════════════════
 * Én kilde til "skriv en CRM-aktivitet".
 *
 * Reglerne om hvornår `done_at` sættes — og hvad der ellers skal følge med
 * (kundens `last_contact_at`, kampagne-medlemmets `last_activity_at`, SSE) —
 * lå indtil nu KUN inde i `POST /api/crm/activity`. Da mail-afsendelsen også
 * skulle skrive en aktivitet (`email_out`), stod valget mellem at kopiere
 * reglerne eller at trække dem ud. Kopien ville drive fra originalen — præcis
 * sådan `_buildMailVars` blev til tre uenige udgaver (se CLAUDE.md).
 *
 * Tilstandsmodellen (docs/CLAUDE_CRM_PLANLAGT.md §3):
 *   due_at sat              → planlagt: done_at forbliver NULL
 *   done_at i kaldet        → bagudrettet log (created_at er stadig nu — revisionsspor)
 *   result = 'callback'     → åben på callback-listen, aldrig auto-done
 *   ellers                  → logget nu
 * ════════════════════════════════════════════════════════════
 */

const { broadcast } = require('../shared/sse');

const OUTCOMES = ['success', 'partial', 'declined', 'no_response', 'pending'];

/**
 * Validér et aktivitets-kald. Returnerer en fejlstreng, eller null når alt er i orden.
 * Adskilt fra selve skrivningen, så routes kan svare 400 uden at røre databasen.
 */
function validateActivity({ customer_id, type, text, due_at, done_at, outcome }) {
    if (!customer_id || !type || !text) return 'Mangler customer_id, type eller text';
    if (outcome && !OUTCOMES.includes(outcome)) return 'ugyldig outcome';
    // De to udelukker hinanden — en aktivitet er enten planlagt ELLER logget, aldrig begge.
    if (due_at && done_at) return 'due_at og done_at kan ikke begge være sat';
    return null;
}

/**
 * Skriv aktiviteten + dens følgevirkninger. Kalderen har ansvaret for at have
 * kaldt validateActivity() først; her kastes der kun hvis databasen siger fra.
 *
 * @returns {number} den nye aktivitets id
 */
function logActivity(db, {
    customer_id, bon_id, type, result, sentiment, text,
    due_at, done_at, owner_user_id, purpose_id, campaign_id, outcome,
}) {
    const ins = db.prepare(`
        INSERT INTO crm_activities
            (customer_id, bon_id, type, result, sentiment, text, due_at, owner_user_id, purpose_id, campaign_id, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        customer_id, bon_id || null, type, result || null, sentiment || null,
        text, due_at || null, owner_user_id || null,
        purpose_id || null, campaign_id || null, outcome || null,
    );
    const activityId = ins.lastInsertRowid;

    db.prepare(`
        UPDATE crm_customer_meta SET last_contact_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE customer_id = ?
    `).run(customer_id);

    // Outreach (spec sektion 1.2.5): campaign_id sat → kun det ene medlemskab;
    // ellers alle kundens medlemskaber. 0 rows hvis kunden ikke er medlem — harmløst.
    if (campaign_id) {
        db.prepare(`
            UPDATE campaign_members SET last_activity_at = CURRENT_TIMESTAMP
            WHERE campaign_id = ? AND customer_id = ?
        `).run(campaign_id, customer_id);
    } else {
        db.prepare(`
            UPDATE campaign_members SET last_activity_at = CURRENT_TIMESTAMP
            WHERE customer_id = ?
        `).run(customer_id);
    }

    // Service-callbacks friholdes — de har eget flow og skal forblive åbne.
    if (!due_at && result !== 'callback') {
        if (done_at) {
            db.prepare('UPDATE crm_activities SET done_at = ? WHERE id = ?').run(done_at, activityId);
        } else {
            db.prepare('UPDATE crm_activities SET done_at = CURRENT_TIMESTAMP WHERE id = ?').run(activityId);
        }
    }

    broadcast('crm_activity_created', {
        id: activityId, customer_id, bon_id: bon_id || null, type,
        campaign_id: campaign_id || null,
    });

    return activityId;
}

/** Slå et purpose-id op på nøgle. Ukendt nøgle → null (aldrig en fejl). */
function purposeIdByKey(db, key) {
    if (!key) return null;
    const row = db.prepare('SELECT id FROM activity_purposes WHERE key = ?').get(key);
    return row ? row.id : null;
}

module.exports = { logActivity, validateActivity, purposeIdByKey, OUTCOMES };
