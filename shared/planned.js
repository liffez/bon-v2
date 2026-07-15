/**
 * shared/planned.js — delte helpers for "Planlagt aktivitet" (CRM, Fase 2–4).
 * Rene funktioner, ingen DOM. Bruges af crm-kunde360.js, bon_drawer.js og modal.js.
 * Se docs/CLAUDE_CRM_PLANLAGT.md.
 */

// Lokal ISO-dato (YYYY-MM-DD) — undgår UTC-forskydning fra toISOString().
function plannedLocalDateISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * Beregn tilstand + due_at/done_at ud fra et Hvornår-valg.
 * whenVal: 'now' | 'tomorrow' | '3d' | '1w' | 'custom'
 * dateVal: 'YYYY-MM-DD' (kun ved 'custom'), timeVal: 'HH:MM' (valgfri)
 * → { mode: 'now'|'plan'|'backdate', due_at?, done_at?, incomplete? }
 */
function plannedComputeWhen(whenVal, dateVal, timeVal) {
    if (whenVal === 'now') return { mode: 'now' };
    if (whenVal === 'tomorrow' || whenVal === '3d' || whenVal === '1w') {
        const n = whenVal === 'tomorrow' ? 1 : (whenVal === '3d' ? 3 : 7);
        const d = new Date(); d.setDate(d.getDate() + n);
        return { mode: 'plan', due_at: plannedLocalDateISO(d) + (timeVal ? ' ' + timeVal : '') };
    }
    // custom
    if (!dateVal) return { mode: 'now', incomplete: true };
    const todayISO = plannedLocalDateISO(new Date());
    if (dateVal < todayISO) return { mode: 'backdate', done_at: dateVal };
    return { mode: 'plan', due_at: dateVal + (timeVal ? ' ' + timeVal : '') };  // i dag eller frem
}

/**
 * Formatér due_at → { label, overdue }. Lokal dato (ingen UTC-forskydning).
 * Klokkeslæt vises kun hvis sat og ≠ 00:00.
 */
function plannedFmtDue(dueAt) {
    if (!dueAt) return { label: '', overdue: false };
    const hasTime = /\d{2}:\d{2}/.test(dueAt) && !/00:00/.test(dueAt.slice(11, 16));
    const d = new Date(dueAt.replace(' ', 'T'));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dueDay = new Date(d); dueDay.setHours(0, 0, 0, 0);
    const overdue = dueDay < today;
    const diff = Math.round((dueDay - today) / 86400000);
    const DAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
    const MON = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
    let day;
    if (diff === 0) day = 'i dag';
    else if (diff === 1) day = 'i morgen';
    else if (diff === -1) day = 'i går';
    else day = DAYS[d.getDay()] + ' ' + d.getDate() + '. ' + MON[d.getMonth()];
    return { label: day + (hasTime ? ' · ' + dueAt.slice(11, 16) : ''), overdue };
}

// Type-labels/-emoji til visning af planlagte aktiviteter (uden for kunde360).
const PLANNED_TYPE_LABELS = { call: 'Opkald', service_call: 'Service-kald', meeting: 'Møde', task: 'Opgave', note: 'Note', followup: 'Opfølgning' };

if (typeof window !== 'undefined') {
    window.plannedLocalDateISO = plannedLocalDateISO;
    window.plannedComputeWhen = plannedComputeWhen;
    window.plannedFmtDue = plannedFmtDue;
    window.PLANNED_TYPE_LABELS = PLANNED_TYPE_LABELS;
}
