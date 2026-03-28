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

function deleteBonLine(bonId, lineId) {
    return apiFetch('/bons/' + bonId + '/lines/' + lineId, {
        method: 'DELETE',
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

function fetchPlanningIngredients(bonIds) {
    return apiFetch('/bons/planning/ingredients?ids=' + bonIds.join(','));
}

function fetchBonsPlanning(from, to, statuses) {
    var qs = '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    if (statuses) qs += '&status=' + encodeURIComponent(statuses);
    return apiFetch('/bons/planning' + qs);
}

/* ── SMARTPLAN ────────────────────────────────────────────── */

function fetchSmartplanShifts(from, to) {
    return apiFetch('/smartplan/shifts?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
}

/* ── SETTINGS ────────────────────────────────────────────── */

function fetchSettings() {
    return apiFetch('/settings');
}

function patchSetting(key, value) {
    return apiFetch('/settings/' + encodeURIComponent(key), {
        method: 'PATCH',
        body: JSON.stringify({ value }),
    });
}

/* ── USERS ───────────────────────────────────────────────── */

function fetchUsers() {
    return apiFetch('/users');
}

function createUser(data) {
    return apiFetch('/users', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function patchUser(id, fields) {
    return apiFetch('/users/' + id, {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

function setUserPassword(id, password) {
    return apiFetch('/users/' + id + '/password', {
        method: 'POST',
        body: JSON.stringify({ password }),
    });
}

/* ── MAIL ────────────────────────────────────────────────── */

function fetchMailTemplates() {
    return apiFetch('/mail/templates');
}

function patchMailTemplate(key, fields) {
    return apiFetch('/mail/templates/' + encodeURIComponent(key), {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

function sendTestMail(to, templateKey) {
    return apiFetch('/mail/test', {
        method: 'POST',
        body: JSON.stringify({ to, templateKey }),
    });
}

/* ── PRICE CATEGORIES (CRUD) ─────────────────────────────── */

function createPriceCategory(data) {
    return apiFetch('/price-categories', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function patchPriceCategory(id, fields) {
    return apiFetch('/price-categories/' + id, {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

/* ── PAYMENT TYPES (CRUD) ────────────────────────────────── */

function createPaymentType(data) {
    return apiFetch('/payment-types', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function patchPaymentType(id, fields) {
    return apiFetch('/payment-types/' + id, {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

/* ── LOCATIONS ───────────────────────────────────────────── */

function fetchLocations() {
    return apiFetch('/settings/locations');
}

/* ── GROCY — udvidet (recipe viewer + designer) ──────────── */

function fetchGrocyRecipesRaw() {
    return apiFetch('/grocy/recipes/raw');
}
function fetchGrocyRecipesPos() {
    return apiFetch('/grocy/recipes-pos/all');
}
function fetchGrocyRecipesNestings() {
    return apiFetch('/grocy/recipes-nestings');
}
function fetchGrocyProducts() {
    return apiFetch('/grocy/products');
}
function fetchGrocyStock() {
    return apiFetch('/grocy/stock');
}
function fetchGrocyQuantityUnits() {
    return apiFetch('/grocy/quantity-units');
}
function fetchGrocyQuantityUnitConversions() {
    return apiFetch('/grocy/quantity-unit-conversions');
}

// Write — recipes
function postGrocyRecipe(body) {
    return apiFetch('/grocy/recipes', { method: 'POST', body: JSON.stringify(body) });
}
function putGrocyRecipe(id, body) {
    return apiFetch('/grocy/recipes/' + id, { method: 'PUT', body: JSON.stringify(body) });
}
function putGrocyRecipeUserfields(id, fields) {
    return apiFetch('/grocy/recipes/' + id + '/userfields', { method: 'PUT', body: JSON.stringify(fields) });
}

// Write — recipe positions
function postGrocyRecipePos(body) {
    return apiFetch('/grocy/recipes-pos', { method: 'POST', body: JSON.stringify(body) });
}
function putGrocyRecipePos(id, body) {
    return apiFetch('/grocy/recipes-pos/' + id, { method: 'PUT', body: JSON.stringify(body) });
}
function deleteGrocyRecipePos(id) {
    return apiFetch('/grocy/recipes-pos/' + id, { method: 'DELETE' });
}

// Write — recipe nestings
function postGrocyRecipeNesting(body) {
    return apiFetch('/grocy/recipes-nestings', { method: 'POST', body: JSON.stringify(body) });
}
function putGrocyRecipeNesting(id, body) {
    return apiFetch('/grocy/recipes-nestings/' + id, { method: 'PUT', body: JSON.stringify(body) });
}
function deleteGrocyRecipeNesting(id) {
    return apiFetch('/grocy/recipes-nestings/' + id, { method: 'DELETE' });
}

// Stock — locations, groups, inventory
function fetchGrocyLocations() {
    return apiFetch('/grocy/locations');
}
function fetchGrocyProductGroups() {
    return apiFetch('/grocy/product-groups');
}
function postGrocyInventory(productId, amount, bestBeforeDate) {
    var body = { amount: amount };
    if (bestBeforeDate) body.best_before_date = bestBeforeDate;
    return apiFetch('/grocy/stock/' + productId + '/inventory', { method: 'POST', body: JSON.stringify(body) });
}
function putGrocyProductUserfields(productId, fields) {
    return apiFetch('/grocy/products/' + productId + '/userfields', { method: 'PUT', body: JSON.stringify(fields) });
}

// Consume — via recipe lines (auto-consume ved LEVERET)
function postGrocyConsume(lines) {
    return apiFetch('/grocy/consume', { method: 'POST', body: JSON.stringify({ lines }) });
}

// Consume — via per-produkt mængder (recipe viewer)
function postGrocyConsumeProducts(items) {
    return apiFetch('/grocy/consume-products', { method: 'POST', body: JSON.stringify({ items }) });
}

/* ── INDKØBSLISTE ────────────────────────────────────────── */

function fetchShoppingList() { return apiFetch('/grocy/shopping-list'); }
function deleteShoppingListItem(id) { return apiFetch('/grocy/shopping-list/' + id, { method: 'DELETE' }); }
function addShoppingListProduct(productId, amount, listId) {
    return apiFetch('/grocy/shopping-list/add-product', {
        method: 'POST', body: JSON.stringify({ product_id: productId, product_amount: amount, list_id: listId || 1 })
    });
}
function removeShoppingListProduct(productId, amount, listId) {
    return apiFetch('/grocy/shopping-list/remove-product', {
        method: 'POST', body: JSON.stringify({ product_id: productId, product_amount: amount, list_id: listId || 1 })
    });
}
function addMissingProducts(listId) {
    return apiFetch('/grocy/shopping-list/add-missing', { method: 'POST', body: JSON.stringify({ list_id: listId || 1 }) });
}
function addExpiredProducts(listId) {
    return apiFetch('/grocy/shopping-list/add-expired', { method: 'POST', body: JSON.stringify({ list_id: listId || 1 }) });
}
function addOverdueProducts(listId) {
    return apiFetch('/grocy/shopping-list/add-overdue', { method: 'POST', body: JSON.stringify({ list_id: listId || 1 }) });
}
function clearShoppingList(listId) {
    return apiFetch('/grocy/shopping-list/clear', { method: 'POST', body: JSON.stringify({ list_id: listId || 1 }) });
}
function fetchProductGroups() { return apiFetch('/grocy/product-groups'); }
function fetchShoppingLocations() { return apiFetch('/grocy/shopping-locations'); }

/* ── BON MAIL ───────────────────────────────────────────── */

function fetchBonMail(bonId) {
    return apiFetch('/bons/' + bonId + '/mail');
}

function sendBonMail(bonId, data) {
    return apiFetch('/bons/' + bonId + '/mail', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function markBonMailRead(bonId, msgId) {
    return apiFetch('/bons/' + bonId + '/mail/' + msgId + '/read', {
        method: 'PATCH',
        body: JSON.stringify({ is_read: 1 }),
    });
}
