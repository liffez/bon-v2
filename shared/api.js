/**
 * shared/api.js
 * ════════════════════════════════════════════════════════════
 * API-klient for Bon v2 frontend.
 * Alle funktioner returnerer Promises.
 * ════════════════════════════════════════════════════════════
 */

const API_BASE = '/api';

async function apiFetch(path, options = {}) {
    const res = await fetch(API_BASE + path, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `API fejl: ${res.status}`);
    }
    return res.json();
}

/* ── BONS ─────────────────────────────────────────────────── */

function fetchBonsToday() {
    return apiFetch('/bons/today');
}

function fetchBonsLater(days) {
    const qs = days ? '?days=' + days : '';
    return apiFetch('/bons/later' + qs);
}

function fetchBons(params) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch('/bons' + (qs ? '?' + qs : ''));
}

function fetchBon(id) {
    return apiFetch('/bons/' + id);
}

function patchBonStatus(id, statusCode, userId) {
    return apiFetch('/bons/' + id + '/status', {
        method: 'PATCH',
        body: JSON.stringify({ status_code: statusCode, user_id: userId }),
    });
}

function patchBonPrep(id, ingredientsReady, suppliesReady) {
    return apiFetch('/bons/' + id + '/prep', {
        method: 'PATCH',
        body: JSON.stringify({
            ingredients_ready: ingredientsReady,
            supplies_ready:    suppliesReady,
        }),
    });
}

function patchBonKitchenInfo(id, text, userId) {
    return apiFetch('/bons/' + id + '/kitchen-info', {
        method: 'PATCH',
        body: JSON.stringify({ text: text, user_id: userId }),
    });
}

function createBon(data) {
    return apiFetch('/bons', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function patchBon(id, fields) {
    return apiFetch('/bons/' + id, {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

/* ── PRICE CATEGORIES ────────────────────────────────────── */

function fetchPriceCategories() {
    return apiFetch('/price-categories');
}

/* ── ADDRESSES ───────────────────────────────────────────── */

function createAddress(data) {
    return apiFetch('/addresses', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

/* ── PAYMENT TYPES ───────────────────────────────────────── */

function fetchPaymentTypes() {
    return apiFetch('/payment-types');
}

/* ── STATUSES ─────────────────────────────────────────────── */

function fetchStatuses() {
    return apiFetch('/statuses');
}

/* ── CUSTOMERS ────────────────────────────────────────────── */

function fetchCustomers(q) {
    return apiFetch('/customers' + (q ? '?q=' + encodeURIComponent(q) : ''));
}

/* ── CHANGELOG ────────────────────────────────────────────── */

function fetchBonChangelog(id) {
    return apiFetch('/bons/' + id + '/changelog');
}

/* ── GROCY ────────────────────────────────────────────────── */

function fetchGrocyRecipes() {
    return apiFetch('/grocy/recipes');
}

function postGrocyShoppingList(items) {
    return apiFetch('/grocy/shoppinglist', {
        method: 'POST',
        body: JSON.stringify({ items }),
    });
}

/* ── INGREDIENSER ────────────────────────────────────────── */

function fetchBonIngredients(id) {
    return apiFetch('/bons/' + id + '/ingredients');
}

/* ── BON LINES ───────────────────────────────────────────── */

function postBonLine(bonId, lineData) {
    return apiFetch('/bons/' + bonId + '/lines', {
        method: 'POST',
        body: JSON.stringify(lineData),
    });
}

/* ── FLYVERE / NOTIFIKATIONER ────────────────────────────── */

function postFlyver(bonId, message, clientId) {
    return apiFetch('/bons/' + bonId + '/notifications', {
        method: 'POST',
        body: JSON.stringify({
            type: 'flyver',
            message: message,
            priority: 'urgent',
            client_id: clientId,
        }),
    });
}

function markNotificationRead(bonId, notifId, clientId) {
    return apiFetch('/bons/' + bonId + '/notifications/' + notifId + '/read', {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId }),
    });
}

function fetchUnreadNotifications(clientId) {
    return apiFetch('/notifications/unread?client_id=' + encodeURIComponent(clientId));
}

/* ── KALENDER ─────────────────────────────────────────────── */

function fetchBonsCalendar(year, month, status) {
    var qs = '?year=' + year + '&month=' + month;
    if (status) qs += '&status=' + encodeURIComponent(status);
    return apiFetch('/bons/calendar' + qs);
}

/* ── SMARTPLAN ────────────────────────────────────────────── */

function fetchSmartplanShifts(from, to) {
    return apiFetch('/smartplan/shifts?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
}
