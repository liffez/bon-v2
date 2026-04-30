// routes/admin-merge.js
// ==========================================
// Manuel firma-sammenlægning (Fase 8) med fuld JSON-snapshot i changelog
// så scripts/undo-merge.js kan rulle tilbage.
//
// Endpoints:
//   GET  /api/admin/merge-companies/preview?winner_id=X&loser_id=Y
//        Returnerer hvad en merge ville gøre — uden at gemme noget.
//   POST /api/admin/merge-companies
//        Udfører merge. Body: { winner_id, loser_id, field_choices, force, user_notes }.
//
// Tabeller der berøres:
//   - customers, bons, booking_tokens, rfm_scores: company_id flyttes til winner
//   - contact_points (entity_type='company'): flyttes til winner, duplikater slettes
//   - companies: loser markeres is_active=0; winner får alternate_names + valgte felter
//   - changelog: action='merge' med komplet snapshot i notes (JSON)
// ==========================================

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { handle, transaction } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const { broadcast } = require('../shared/sse');

router.use(requireAuth('admin'));

// ─── Helpers ─────────────────────────────────────────────────

function getCompany(db, id) {
    return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function countCompanyMoves(db, loserId) {
    return {
        customers: db.prepare('SELECT COUNT(*) c FROM customers WHERE company_id = ? AND is_active = 1').get(loserId).c,
        bons:      db.prepare('SELECT COUNT(*) c FROM bons WHERE company_id = ?').get(loserId).c,
        bookingTokens: db.prepare("SELECT COUNT(*) c FROM booking_tokens WHERE company_id = ?").get(loserId).c,
        rfm:       db.prepare('SELECT COUNT(*) c FROM rfm_scores WHERE company_id = ?').get(loserId).c,
    };
}

// Find aktive bons for hvert firma de seneste 30 dage
function recentlyActive(db, companyId, days = 30) {
    const row = db.prepare(`
        SELECT COUNT(*) c FROM bons
         WHERE company_id = ?
           AND delivery_date >= date('now', '-' || ? || ' days')
    `).get(companyId, days);
    return row.c;
}

const FIELD_KEYS = [
    'name', 'cvr', 'ean', 'legal_name', 'phone', 'email', 'invoice_email',
    'invoice_method', 'address_id', 'economic_customer_id',
    'default_payment_type', 'default_price_category_id', 'discount_percent',
    'notes', 'branch', 'company_type', 'employee_count',
    'last_enriched_at', 'last_enriched_source',
];

// Findes også som FIELDS_TEXT_MERGE i merge — felter hvor "merge" giver mening
const TEXT_MERGE_FIELDS = new Set(['notes']);

function buildConflicts(winner, loser) {
    const conflicts = [];
    for (const key of FIELD_KEYS) {
        const w = winner[key];
        const l = loser[key];
        const wEmpty = w === null || w === undefined || w === '';
        const lEmpty = l === null || l === undefined || l === '';
        if (wEmpty && lEmpty) continue;
        if (wEmpty && !lEmpty) {
            conflicts.push({ field: key, winner_value: w ?? null, loser_value: l, recommendation: 'loser' });
            continue;
        }
        if (!wEmpty && lEmpty) {
            // Ikke en konflikt — winner har værdi, loser har ikke
            continue;
        }
        if (String(w).trim() === String(l).trim()) continue;
        // Forskellige værdier — bruger skal vælge
        if (TEXT_MERGE_FIELDS.has(key)) {
            conflicts.push({ field: key, winner_value: w, loser_value: l, recommendation: 'merge' });
        } else {
            conflicts.push({ field: key, winner_value: w, loser_value: l, recommendation: 'pick' });
        }
    }
    return conflicts;
}

function buildWarnings(db, winner, loser) {
    const warnings = [];
    if (winner.cvr && loser.cvr && winner.cvr !== loser.cvr) {
        warnings.push({
            code: 'cvr_mismatch',
            text: `Forskellige CVR-numre: vinder=${winner.cvr}, taber=${loser.cvr}. Sandsynligvis ikke samme firma.`,
        });
    }
    if (winner.ean && loser.ean && winner.ean !== loser.ean) {
        warnings.push({
            code: 'ean_mismatch',
            text: `Forskellige EAN-numre: vinder=${winner.ean}, taber=${loser.ean}. NemHandel-konflikt.`,
        });
    }
    const wActive = recentlyActive(db, winner.id, 30);
    const lActive = recentlyActive(db, loser.id, 30);
    if (wActive > 0 && lActive > 0) {
        warnings.push({
            code: 'both_recently_active',
            text: `Begge firmaer har bons inden for 30 dage (vinder: ${wActive}, taber: ${lActive}). Verificér at det virkelig er duplikater.`,
        });
    }
    if (loser.economic_customer_id && !winner.economic_customer_id) {
        warnings.push({
            code: 'loser_has_economic',
            text: `Taber har e-conomic-kobling (${loser.economic_customer_id}) — vinder mangler. Overvej at vælge taber-værdien.`,
        });
    }
    if (loser.cvr && !winner.cvr) {
        warnings.push({
            code: 'loser_has_cvr',
            text: `Taber har CVR (${loser.cvr}) — vinder mangler. Overvej at vælge taber-værdien.`,
        });
    }
    if (loser.ean && !winner.ean) {
        warnings.push({
            code: 'loser_has_ean',
            text: `Taber har EAN (${loser.ean}) — vinder mangler. Overvej at vælge taber-værdien.`,
        });
    }
    return warnings;
}

// Tæl contact_points der ville blive slettet som duplikater
function countCpsMoves(db, winnerId, loserId) {
    const loserCps = db.prepare(`
        SELECT id, kind, value FROM contact_points
         WHERE entity_type = 'company' AND entity_id = ? AND is_active = 1
    `).all(loserId);
    const winnerKeys = new Set(
        db.prepare(`
            SELECT kind || ':' || lower(value) AS k FROM contact_points
             WHERE entity_type = 'company' AND entity_id = ? AND is_active = 1
        `).all(winnerId).map(r => r.k)
    );
    let dups = 0, moved = 0;
    for (const cp of loserCps) {
        const k = cp.kind + ':' + cp.value.toLowerCase();
        if (winnerKeys.has(k)) dups++;
        else moved++;
    }
    return { moved, dups, total: loserCps.length };
}

// ─── GET /preview ─────────────────────────────────────────────

router.get('/preview', handle((req, res) => {
    const winnerId = parseInt(req.query.winner_id, 10);
    const loserId  = parseInt(req.query.loser_id, 10);

    if (!winnerId || !loserId) return res.status(400).json({ error: 'winner_id og loser_id er påkrævet' });
    if (winnerId === loserId) return res.status(400).json({ error: 'winner_id og loser_id må ikke være ens' });

    const db = getDb();
    const winner = getCompany(db, winnerId);
    const loser  = getCompany(db, loserId);
    if (!winner) return res.status(404).json({ error: `Firma #${winnerId} (vinder) findes ikke` });
    if (!loser)  return res.status(404).json({ error: `Firma #${loserId} (taber) findes ikke` });
    if (winner.is_active === 0 || loser.is_active === 0) {
        return res.status(400).json({ error: 'Begge firmaer skal være aktive (is_active=1)' });
    }

    const moves = countCompanyMoves(db, loserId);
    const cps = countCpsMoves(db, winnerId, loserId);
    const conflicts = buildConflicts(winner, loser);
    const warnings  = buildWarnings(db, winner, loser);

    res.json({
        winner: {
            id: winner.id, name: winner.name, cvr: winner.cvr, ean: winner.ean,
            legal_name: winner.legal_name, address_id: winner.address_id,
            economic_customer_id: winner.economic_customer_id,
            notes: winner.notes,
        },
        loser: {
            id: loser.id, name: loser.name, cvr: loser.cvr, ean: loser.ean,
            legal_name: loser.legal_name, address_id: loser.address_id,
            economic_customer_id: loser.economic_customer_id,
            notes: loser.notes,
        },
        moves: {
            customers: moves.customers,
            bons: moves.bons,
            booking_tokens: moves.bookingTokens,
            rfm_scores: moves.rfm,
            contact_points_total: cps.total,
            contact_points_moved: cps.moved,
            contact_points_duplicates: cps.dups,
        },
        conflicts,
        warnings,
    });
}));

// ─── POST / ───────────────────────────────────────────────────

router.post('/', handle((req, res) => {
    const {
        winner_id, loser_id,
        field_choices = {},
        merge_notes_separator,
        user_notes,
        force = false,
    } = req.body || {};

    const winnerId = parseInt(winner_id, 10);
    const loserId  = parseInt(loser_id, 10);
    if (!winnerId || !loserId) return res.status(400).json({ error: 'winner_id og loser_id er påkrævet' });
    if (winnerId === loserId) return res.status(400).json({ error: 'winner_id og loser_id må ikke være ens' });

    const db = getDb();
    const winner = getCompany(db, winnerId);
    const loser  = getCompany(db, loserId);
    if (!winner || !loser) return res.status(404).json({ error: 'Firma ikke fundet' });
    if (winner.is_active === 0 || loser.is_active === 0) {
        return res.status(400).json({ error: 'Begge firmaer skal være aktive' });
    }

    // Tjek warnings
    const warnings = buildWarnings(db, winner, loser);
    if (warnings.length > 0 && !force) {
        return res.status(409).json({
            ok: false,
            code: 'warnings_present',
            warnings,
            hint: 'Genindsend med force:true for at overstyre',
        });
    }

    const sep = merge_notes_separator || `\n\n--- Sammenlagt fra firma #${loserId} ---\n\n`;

    // Snapshot bygges INDE i transaction lige før mutationer
    let result;
    try {
        result = transaction(db, () => {
            // Build snapshot
            const snapshot = {
                schema_version: 1,
                winner_row: { ...winner },
                loser_row: { ...loser },
                moved_customers: db.prepare(`
                    SELECT id FROM customers WHERE company_id = ?
                `).all(loserId).map(r => ({ id: r.id, original_company_id: loserId })),
                moved_bons: db.prepare(`
                    SELECT id FROM bons WHERE company_id = ?
                `).all(loserId).map(r => ({ id: r.id, original_company_id: loserId })),
                moved_booking_tokens: db.prepare(`
                    SELECT token FROM booking_tokens WHERE company_id = ?
                `).all(loserId).map(r => ({ token: r.token, original_company_id: loserId })),
                rfm_scores: db.prepare(`
                    SELECT * FROM rfm_scores WHERE company_id = ?
                `).all(loserId),
                moved_contact_points: [],   // udfyldes nedenfor
                applied_field_choices: { ...field_choices },
            };

            // ── Flyt customers, bons, booking_tokens ──
            db.prepare('UPDATE customers SET company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE company_id = ?')
              .run(winnerId, loserId);
            db.prepare('UPDATE bons SET company_id = ?, updated_at = CURRENT_TIMESTAMP WHERE company_id = ?')
              .run(winnerId, loserId);
            db.prepare('UPDATE booking_tokens SET company_id = ? WHERE company_id = ?')
              .run(winnerId, loserId);

            // ── rfm_scores: hvis winner allerede har en, slet loser's; ellers flyt ──
            const winnerHasRfm = db.prepare('SELECT 1 FROM rfm_scores WHERE company_id = ?').get(winnerId);
            if (winnerHasRfm) {
                db.prepare('DELETE FROM rfm_scores WHERE company_id = ?').run(loserId);
            } else {
                db.prepare('UPDATE rfm_scores SET company_id = ? WHERE company_id = ?').run(winnerId, loserId);
            }

            // ── Contact_points: flyt med dedup ──
            const loserCps = db.prepare(`
                SELECT * FROM contact_points
                 WHERE entity_type = 'company' AND entity_id = ? AND is_active = 1
            `).all(loserId);
            for (const cp of loserCps) {
                const winnerCp = db.prepare(`
                    SELECT id FROM contact_points
                     WHERE entity_type = 'company' AND entity_id = ?
                       AND kind = ? AND lower(value) = lower(?) AND is_active = 1
                `).get(winnerId, cp.kind, cp.value);
                if (winnerCp) {
                    // Duplikat — soft-delete loser's cp
                    db.prepare(`
                        UPDATE contact_points
                           SET is_active = 0, is_primary = 0, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?
                    `).run(cp.id);
                    snapshot.moved_contact_points.push({
                        id: cp.id, action: 'deleted_dup',
                        original_entity_id: loserId,
                        existing_winner_cp_id: winnerCp.id,
                        snapshot_value: cp,
                    });
                } else {
                    // Flyt over til winner
                    db.prepare(`
                        UPDATE contact_points
                           SET entity_id = ?, is_primary = 0, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?
                    `).run(winnerId, cp.id);
                    snapshot.moved_contact_points.push({
                        id: cp.id, action: 'moved',
                        original_entity_id: loserId,
                        snapshot_value: cp,
                    });
                }
            }

            // ── Apply field_choices ──
            const setClauses = [];
            const args = [];
            for (const [field, choice] of Object.entries(field_choices)) {
                if (!FIELD_KEYS.includes(field)) continue;
                if (choice === 'loser') {
                    setClauses.push(`${field} = ?`);
                    args.push(loser[field] ?? null);
                } else if (choice === 'merge') {
                    if (!TEXT_MERGE_FIELDS.has(field)) continue;
                    const wVal = winner[field];
                    const lVal = loser[field];
                    if (wVal && lVal) {
                        setClauses.push(`${field} = ?`);
                        args.push(String(wVal) + sep + String(lVal));
                    } else if (lVal) {
                        setClauses.push(`${field} = ?`);
                        args.push(lVal);
                    }
                }
                // 'winner' = ingen ændring (winner beholder sin værdi)
            }

            // ── alternate_names: tilføj loser.name + dens egne alternate_names ──
            const winnerAlternateNames = JSON.parse(winner.alternate_names || '[]');
            const loserAlternateNames = JSON.parse(loser.alternate_names || '[]');
            const allNames = [...winnerAlternateNames, loser.name, ...loserAlternateNames];
            const dedupedNames = [...new Set(allNames.filter(n => n && n.trim() && n !== winner.name))];
            setClauses.push('alternate_names = ?');
            args.push(JSON.stringify(dedupedNames));

            if (setClauses.length > 0) {
                args.push(winnerId);
                db.prepare(`UPDATE companies SET ${setClauses.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...args);
            }

            // ── Markér loser inactive ──
            const loserInactiveNote = `\n[Sammenlagt med firma #${winnerId} ${new Date().toISOString().slice(0,10)}]`;
            db.prepare(`
                UPDATE companies
                   SET is_active = 0,
                       notes = COALESCE(notes,'') || ?,
                       updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?
            `).run(loserInactiveNote, loserId);

            // ── Skriv changelog ──
            const payload = {
                winner_id: winnerId,
                loser_id: loserId,
                loser_name: loser.name,
                moves: {
                    customers: snapshot.moved_customers.length,
                    bons: snapshot.moved_bons.length,
                    booking_tokens: snapshot.moved_booking_tokens.length,
                    rfm_scores: snapshot.rfm_scores.length,
                    contact_points_moved: snapshot.moved_contact_points.filter(m => m.action === 'moved').length,
                    contact_points_deleted_as_duplicate: snapshot.moved_contact_points.filter(m => m.action === 'deleted_dup').length,
                },
                field_choices,
                user_notes: user_notes || null,
                force,
                snapshot,
                schema_version: 1,
                created_at: new Date().toISOString(),
            };

            const userId = req.session?.user?.id ?? null;
            const insert = db.prepare(`
                INSERT INTO changelog (entity_type, entity_id, action, field_name, new_value, user_id, notes)
                VALUES ('company', ?, 'merge', NULL, ?, ?, ?)
            `).run(winnerId, String(loserId), userId, JSON.stringify(payload));

            return {
                changelog_id: Number(insert.lastInsertRowid),
                moves_executed: payload.moves,
            };
        });
    } catch (err) {
        console.error('Merge fejlede:', err);
        return res.status(500).json({ error: 'Merge fejlede: ' + err.message });
    }

    // SSE-broadcast så åbne views kan reagere
    try {
        broadcast('company_merged', { winner_id: winnerId, loser_id: loserId });
    } catch {}

    res.json({
        ok: true,
        winner_id: winnerId,
        loser_id: loserId,
        ...result,
    });
}));

module.exports = router;
