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
        const err = new Error(body.error || `API fejl: ${res.status}`);
        err.status = res.status;
        if (body.code) err.code = body.code;
        err.body = body;   // hele fejl-payloaden (fx can_force) tilgængelig for kalderen
        throw err;
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

// Aktivitetslog: web-bestillinger + statusskift (routes/kitchen.js → /bons/log)
function fetchActivityLog(params = {}) {
    const clean = {};
    Object.entries(params).forEach(([k, v]) => { if (v != null && v !== '') clean[k] = v; });
    const qs = new URLSearchParams(clean).toString();
    return apiFetch('/bons/log' + (qs ? '?' + qs : ''));
}

function fetchBon(id) {
    return apiFetch('/bons/' + id);
}

function deleteBon(id) {
    return apiFetch('/bons/' + id, { method: 'DELETE' });
}

function patchBonStatus(id, statusCode, userId, force, confirmNoInvoice) {
    const payload = { status_code: statusCode, user_id: userId };
    if (force) payload.force = true;   // admin-override af ellers ugyldig status-vej
    // Fakturavagt (#319): bekræft at bonnen bevidst markeres faktureret uden faktura
    if (confirmNoInvoice) payload.confirm_no_invoice = true;
    return apiFetch('/bons/' + id + '/status', {
        method: 'PATCH',
        body: JSON.stringify(payload),
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

function copyBon(id, overrides) {
    return apiFetch('/bons/' + id + '/copy', {
        method: 'POST',
        body: JSON.stringify(overrides || {}),
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

function putBonLine(bonId, lineId, fields) {
    return apiFetch('/bons/' + bonId + '/lines/' + lineId, {
        method: 'PUT',
        body: JSON.stringify(fields),
    });
}

// Persistér menu-gruppering. groups = [{ title, note, line_ids: [] }, ...]
function saveMenuGroups(bonId, groups) {
    return apiFetch('/bons/' + bonId + '/menu-groups', {
        method: 'PUT',
        body: JSON.stringify({ groups }),
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

function fetchPlanningIngredients(bonIds, extraLines) {
    if (extraLines && extraLines.length) {
        return apiFetch('/bons/planning/ingredients', {
            method: 'POST',
            body: JSON.stringify({ bon_ids: bonIds, extra_lines: extraLines }),
        });
    }
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

// Interne afsendere (mail-routing): listen + de kunder den faktisk rammer.
function fetchInternalSenders() {
    return apiFetch('/settings/internal-senders');
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

function fetchRolePermissions() {
    return apiFetch('/settings/role-permissions');
}

function patchRolePermissions(role, perms) {
    return apiFetch('/settings/role-permissions/' + role, {
        method: 'PATCH',
        body: JSON.stringify(perms),
    });
}

/* ── MAIL ────────────────────────────────────────────────── */

function fetchMailTemplates() {
    return apiFetch('/mail/templates');
}

function createMailTemplate(data) {
    return apiFetch('/mail/templates', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function deleteMailTemplate(key) {
    return apiFetch('/mail/templates/' + encodeURIComponent(key), { method: 'DELETE' });
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
function fetchGrocyStockVolatile(dueSoonDays) {
    return apiFetch('/grocy/stock/volatile?due_soon_days=' + (dueSoonDays || 5));
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
function postGrocyStockAdd(productId, body) {
    return apiFetch('/grocy/stock/' + productId + '/add', { method: 'POST', body: JSON.stringify(body) });
}
function putGrocyProductUserfields(productId, fields) {
    return apiFetch('/grocy/products/' + productId + '/userfields', { method: 'PUT', body: JSON.stringify(fields) });
}

// Opret produkt + QU-konvertering + userfield-meta
function fetchGrocyUserfields() {
    return apiFetch('/grocy/userfields');
}
function postGrocyProduct(body) {
    return apiFetch('/grocy/products', { method: 'POST', body: JSON.stringify(body) });
}
function postGrocyQuConversion(body) {
    return apiFetch('/grocy/quantity-unit-conversions', { method: 'POST', body: JSON.stringify(body) });
}

// Idempotens-nonce til lagertræk (#361). Skal genereres én gang pr. HANDLING og
// genbruges ved retry — genererer man en ny for hvert forsøg, er beskyttelsen væk.
function grocyConsumeNonce() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'gc-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

// Consume — via recipe lines (auto-consume ved LEVERET)
function postGrocyConsume(lines, consumeNonce) {
    return apiFetch('/grocy/consume', {
        method: 'POST',
        body: JSON.stringify({ lines, consume_nonce: consumeNonce || grocyConsumeNonce() }),
    });
}

// Consume — via per-produkt mængder (recipe viewer)
function postGrocyConsumeProducts(items, consumeNonce) {
    return apiFetch('/grocy/consume-products', {
        method: 'POST',
        body: JSON.stringify({ items, consume_nonce: consumeNonce || grocyConsumeNonce() }),
    });
}

/* ── PRODUKTION (batch record) ───────────────────────────── */

function postProductionBatch(data) {
    return apiFetch('/production/batches', { method: 'POST', body: JSON.stringify(data) });
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
function fetchProductBarcodes() { return apiFetch('/grocy/product-barcodes'); }
function createProductBarcode(data) {
    return apiFetch('/grocy/product-barcodes', { method: 'POST', body: JSON.stringify(data) });
}
function updateShoppingListItem(id, fields) {
    return apiFetch('/grocy/shopping-list/' + id, { method: 'PUT', body: JSON.stringify(fields) });
}

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

/* ── CUSTOMER MAIL ──────────────────────────────────────── */

function fetchCustomerMail(customerId) {
    return apiFetch('/customers/' + customerId + '/mail');
}

function sendCustomerMail(customerId, data) {
    return apiFetch('/customers/' + customerId + '/mail', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

/* ── BOOKING (M11 mail-compose) ────────────────────────── */

// Hentes af "Indsæt booking-link"-popoveren — alle aktive mødetyper inkl.
// is_bookable=0 (sælger kan forvælge en intern type som intent).
function fetchBookingMeetingTypesIntent() {
    return apiFetch('/booking/meeting-types/intent');
}

/* ── BOOKING ADMIN (M10 settings UI) ──────────────────── */

// Mødetyper
function fetchBookingMeetingTypesAdmin() {
    return apiFetch('/booking/admin/meeting-types');
}
function createBookingMeetingType(data) {
    return apiFetch('/booking/admin/meeting-types', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}
function patchBookingMeetingType(id, data) {
    return apiFetch('/booking/admin/meeting-types/' + id, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

// Kontaktårsager
function fetchBookingContactReasonsAdmin() {
    return apiFetch('/booking/admin/contact-reasons');
}
function createBookingContactReason(data) {
    return apiFetch('/booking/admin/contact-reasons', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}
function patchBookingContactReason(id, data) {
    return apiFetch('/booking/admin/contact-reasons/' + id, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

// Page templates
function fetchBookingPageTemplates() {
    return apiFetch('/booking/admin/page-templates');
}
function patchBookingPageTemplate(key, data) {
    return apiFetch('/booking/admin/page-templates/' + encodeURIComponent(key), {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

/* ── ATTACHMENTS ─────────────────────────────────────────── */

async function uploadAttachment(file, entityType, entityId, filename) {
    var fd = new FormData();
    if (filename) {
        fd.append('file', file, filename);
    } else {
        fd.append('file', file);
    }
    if (entityType) fd.append('entity_type', entityType);
    if (entityId) fd.append('entity_id', String(entityId));
    var res = await fetch(API_BASE + '/attachments/upload', { method: 'POST', body: fd });
    if (!res.ok) {
        var body = await res.json().catch(function() { return {}; });
        throw new Error(body.error || 'Upload fejl: ' + res.status);
    }
    return res.json();
}

function mailAttachmentUrl(mailAttachmentId) {
    return API_BASE + '/attachments/mail/' + mailAttachmentId + '/download';
}

// Visnings-URL for inline (CID-refererede) billeder i HTML-mails.
function mailInlineUrl(mailAttachmentId) {
    return API_BASE + '/attachments/mail/' + mailAttachmentId + '/inline';
}

function attachmentUrl(attachmentId) {
    return API_BASE + '/attachments/' + attachmentId + '/download';
}

// Visnings-URL (billede/PDF i ny fane) for generiske vedhæftninger.
function attachmentInlineUrl(attachmentId) {
    return API_BASE + '/attachments/' + attachmentId + '/inline';
}

// Liste over vedhæftninger for en entitet (fx event).
function fetchAttachments(entityType, entityId) {
    return apiFetch('/attachments?entity_type=' + encodeURIComponent(entityType) +
                    '&entity_id=' + encodeURIComponent(entityId));
}

function deleteAttachment(attachmentId) {
    return apiFetch('/attachments/' + attachmentId, { method: 'DELETE' });
}

/* ── DASHBOARD ────────────────────────────────────────────── */

function fetchDashboardToday() {
    return apiFetch('/dashboard/today');
}

function fetchDashboardStats(daysBack, daysForward) {
    var params = [];
    if (daysBack != null) params.push('days_back=' + daysBack);
    if (daysForward != null) params.push('days_forward=' + daysForward);
    var qs = params.length ? '?' + params.join('&') : '';
    return apiFetch('/dashboard/stats' + qs);
}

// bucket: 'food' (default — kun varer der tæller som solgte enheder)
//         'other' (emballage, drikke, kager, tilbehør)
function fetchDashboardTopProducts(from, to, bucket) {
    var params = [];
    if (from) params.push('from=' + from);
    if (to) params.push('to=' + to);
    if (bucket) params.push('bucket=' + encodeURIComponent(bucket));
    var qs = params.length ? '?' + params.join('&') : '';
    return apiFetch('/dashboard/top-products' + qs);
}

/* ── Schedule (Ugeoversigt) ───────────────────────────────── */

function fetchScheduleWeek(from, to, status) {
    var qs = '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    if (status) qs += '&status=' + encodeURIComponent(status);
    return apiFetch('/schedule/week' + qs);
}

/* ── DRIFTSREGNSKAB ──────────────────────────────────────── */

function fetchDriftDay(date, mode) {
    return apiFetch('/drift/day?date=' + encodeURIComponent(date) + '&mode=' + encodeURIComponent(mode || 'realiseret'));
}
function fetchDriftDayBons(date, mode) {
    return apiFetch('/drift/day/bons?date=' + encodeURIComponent(date) + '&mode=' + encodeURIComponent(mode || 'realiseret'));
}
function refreezeDriftDay(date) {
    return apiFetch('/drift/refreeze', { method: 'POST', body: JSON.stringify({ date }) });
}
function fetchDriftPeriod(from, to, mode) {
    return apiFetch('/drift/period?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&mode=' + encodeURIComponent(mode || 'realiseret'));
}
// Produktions-sammentælling. Dagsvisningen kalder med from = to = dagen.
function fetchDriftItems(from, to, mode) {
    return apiFetch('/drift/items?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to || from) +
                    '&mode=' + encodeURIComponent(mode || 'realiseret'));
}

/* ── CRM ──────────────────────────────────────────────────── */

function fetchCrmStats() {
    return apiFetch('/crm/stats');
}

function fetchCrmBriefing() {
    return apiFetch('/crm/briefing');
}

function fetchCrmSuggestions(category) {
    var qs = category ? '?category=' + category : '';
    return apiFetch('/crm/suggestions' + qs);
}

function fetchCrmServiceCalls(days) {
    var qs = days ? '?days=' + days : '';
    return apiFetch('/crm/service-calls' + qs);
}

// Ringeliste-endpoints (#232) — fulde arbejdslister bag den fanebaserede Ringeliste.
function fetchCrmSeason() {
    return apiFetch('/crm/season');
}

function fetchCrmRytme(multiplier) {
    var qs = multiplier ? '?multiplier=' + multiplier : '';
    return apiFetch('/crm/rytme' + qs);
}

function fetchCrmColdOffers() {
    return apiFetch('/crm/cold-offers');
}

function fetchCrmCustomers(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/crm/customers' + qs);
}

function fetchCrmCustomer(id) {
    return apiFetch('/crm/customer/' + id);
}

function fetchCrmCustomerOrders(id, limit) {
    var qs = limit ? '?limit=' + limit : '';
    return apiFetch('/crm/customer-orders/' + id + qs);
}

function fetchCrmCallbacks() {
    return apiFetch('/crm/callbacks');
}

function fetchCrmUpcomingMeetings(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/crm/meetings/upcoming' + qs);
}

function fetchCrmDormant(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/crm/dormant' + qs);
}

function fetchCrmCallLog(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/crm/call-log' + qs);
}

function fetchCrmCallStats() {
    return apiFetch('/crm/call-stats');
}

function fetchCrmPipeline(category) {
    var qs = category ? '?category=' + category : '';
    return apiFetch('/crm/pipeline' + qs);
}

function movePipelineCard(bonId, column) {
    return apiFetch('/crm/pipeline/' + bonId + '/move', {
        method: 'PATCH',
        body: JSON.stringify({ column: column }),
    });
}

// Bulk-import af leads. payload = { rows, tag?, enrich?, dry_run? }
function importLeads(payload) {
    return apiFetch('/crm/leads/import', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

function postCrmActivity(data) {
    return apiFetch('/crm/activity', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// Åbne planlagte aktiviteter (inkl. møder) for én kunde ELLER én bon.
// params: { customer_id } eller { bon_id }
function fetchCrmPlanned(params) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch('/crm/planned?' + qs);
}

// Udfør en planlagt aktivitet med struktureret resultat.
// id + { result?, sentiment?, outcome?, note? }
function completeCrmActivity(id, data) {
    return apiFetch('/crm/activity/' + id + '/done', {
        method: 'PATCH',
        body: JSON.stringify(data || {}),
    });
}

// Dashboard "Mine opfølgninger" (Fase 4-datakilde): forfaldne/dagens planlagte + callbacks.
function fetchCrmFollowups() {
    return apiFetch('/crm/followups');
}

// Skjul (snooze) et smart-forslag i et antal dage (default 14 server-side).
// data: { customer_id, type, days? }
function snoozeSuggestion(data) {
    return apiFetch('/crm/suggestions/snooze', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// Aktive skjulte forslag (til "N skjult"-listen).
function fetchSnoozedSuggestions() {
    return apiFetch('/crm/suggestions/snoozed');
}

// Fortryd et skjul. data: { customer_id, type }
function unsnoozeSuggestion(data) {
    return apiFetch('/crm/suggestions/unsnooze', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// Outcome-måling for anbefalings-trikket (180 dage).
function fetchReviewStats() {
    return apiFetch('/crm/suggestions/review-stats');
}

function patchCrmCustomerStage(id, stage) {
    return apiFetch('/crm/customer/' + id + '/stage', {
        method: 'PATCH',
        body: JSON.stringify({ stage: stage }),
    });
}

// Outreach (CLAUDE_OUTREACH_KAMPAGNER.md sektion 1.3): markedsføring + DNC.
// Server håndhæver det samme ved POST /campaigns/:id/members, så ændringer her
// påvirker fremtidige kampagne-tilføjelser. SSE: crm_consent_updated.
function patchCrmCustomerConsent(id, payload) {
    return apiFetch('/crm/customer/' + id + '/consent', {
        method: 'PATCH',
        body: JSON.stringify(payload),
    });
}

/* ── OUTREACH-KAMPAGNER (CLAUDE_OUTREACH_KAMPAGNER.md) ───── */

function fetchCampaigns(includeClosed) {
    var qs = includeClosed ? '?active=0' : '';
    return apiFetch('/campaigns' + qs);
}

function fetchCampaign(id) {
    return apiFetch('/campaigns/' + id);
}

// POST /campaigns kan returnere 409 med error: 'name_in_use' eller 'name_closed'
// (sidstnævnte med reopenable:true). apiFetch eskalerer 409 til thrown Error med .status/.code.
function createCampaign(payload) {
    return apiFetch('/campaigns', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

function reopenCampaign(id) {
    return apiFetch('/campaigns/' + id + '/reopen', { method: 'POST' });
}

function closeCampaign(id) {
    return apiFetch('/campaigns/' + id + '/close', { method: 'POST' });
}

// POST /:id/members returnerer { added, skipped, member_ids }.
// skipped[].reason: 'no_entity' | 'no_marketing_consent_b2c' | 'do_not_contact' | 'already_member' | 'db_error'
function addCampaignMembers(campaignId, members) {
    return apiFetch('/campaigns/' + campaignId + '/members', {
        method: 'POST',
        body: JSON.stringify({ members: members }),
    });
}

function fetchCampaignMembers(campaignId, status) {
    var qs = status ? ('?status=' + encodeURIComponent(status)) : '';
    return apiFetch('/campaigns/' + campaignId + '/members' + qs);
}

// Pipeline-board (Fase 4): kanban-grupperede medlemmer.
// Uden campaign_id: alle aktive kampagners medlemmer (med campaign_name pr. kort).
// Returnerer { active_campaign_id, columns: { lead, quote_sent, negotiating, won, lost } }
function fetchCampaignPipeline(campaignId) {
    var qs = campaignId ? ('?campaign_id=' + campaignId) : '';
    return apiFetch('/campaigns/pipeline' + qs);
}

// Paste-import (Fase 3): preview + commit.
// preview returnerer match_type + suggested_action pr. række.
// commit modtager pr-række beslutning og kører alt i én transaktion.
function previewCampaignImport(campaignId, rows) {
    return apiFetch('/campaigns/' + campaignId + '/import-preview', {
        method: 'POST',
        body: JSON.stringify({ rows: rows }),
    });
}

function commitCampaignImport(campaignId, decisions) {
    return apiFetch('/campaigns/' + campaignId + '/import-commit', {
        method: 'POST',
        body: JSON.stringify({ decisions: decisions }),
    });
}

// Smart-forslag (Fase 5): opret kampagne fra sovende kunder.
// payload = { type: 'dormant', filter: { days_since_last, min_total_revenue },
//             campaign_name, description?, owner_user_id?, assigned_user_id? }
function createCampaignFromSuggestion(payload) {
    return apiFetch('/campaigns/from-suggestion', {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

function patchCampaignMember(campaignId, memberId, payload) {
    return apiFetch('/campaigns/' + campaignId + '/members/' + memberId, {
        method: 'PATCH',
        body: JSON.stringify(payload),
    });
}

function deleteCampaignMember(campaignId, memberId) {
    return apiFetch('/campaigns/' + campaignId + '/members/' + memberId, {
        method: 'DELETE',
    });
}

/* ── ENTITY FLAGS (påmindelser på kunder/firmaer) ────────── */

function fetchFlags(entityType, entityId, includeDismissed) {
    var qs = new URLSearchParams({ entity_type: entityType, entity_id: entityId });
    if (includeDismissed) qs.set('include_dismissed', '1');
    return apiFetch('/flags?' + qs.toString());
}

// showInKitchen: default true (vis for køkken). Sæt false for kontor-kun påmindelser.
function createFlag(entityType, entityId, title, body, showInKitchen) {
    return apiFetch('/flags', {
        method: 'POST',
        body: JSON.stringify({
            entity_type: entityType, entity_id: entityId,
            title: title, body: body || null,
            show_in_kitchen: showInKitchen === false ? 0 : 1,
        }),
    });
}

function patchFlag(flagId, fields) {
    return apiFetch('/flags/' + flagId, {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

function dismissFlagApi(flagId, bonId, note) {
    return apiFetch('/flags/' + flagId + '/dismiss', {
        method: 'POST',
        body: JSON.stringify({ bon_id: bonId || null, note: note || null }),
    });
}

function ackFlagApi(flagId, bonId, note) {
    return apiFetch('/flags/' + flagId + '/ack', {
        method: 'POST',
        body: JSON.stringify({ bon_id: bonId, note: note || null }),
    });
}

/* ── FAKTURERING ─────────────────────────────────────────── */

function fetchInvoiceQueue(includeDone) {
    var qs = includeDone ? '?include_done=1' : '';
    return apiFetch('/invoices/queue' + qs);
}

/* ── E-CONOMIC FAKTURAUDKAST (Spor 2) ───────────────────── */

// Dry-run: byg payloaden uden at sende. Returnerer { payload, readiness, ... }.
function previewEconomicDraft(bonId) {
    return apiFetch('/invoices/' + bonId + '/economic-preview');
}

// Opret fakturaudkast i e-conomic. opts: { oneoff_for_missing? }.
function createEconomicDraft(bonId, opts) {
    return apiFetch('/invoices/' + bonId + '/economic-draft', {
        method: 'POST',
        body: JSON.stringify(opts || {}),
    });
}

// Pre-flight: hvilke kø-bons ville blive blokeret + "kladder venter"-tæller.
function fetchEconomicReadiness() {
    return apiFetch('/invoices/economic-readiness');
}

// Slå bonens firma op i e-conomic (CVR/EAN/navn) + hent kontakter → forslag til kobling.
function suggestEconomicCustomer(bonId) {
    return apiFetch('/invoices/' + bonId + '/economic-customer-suggest');
}

// Opret bonens firma (+ kontakt) som ny kunde i e-conomic, skriv numrene tilbage.
function createEconomicCustomer(bonId, opts) {
    return apiFetch('/invoices/' + bonId + '/economic-create-customer', {
        method: 'POST',
        body: JSON.stringify(opts || {}),
    });
}

function patchCompanyEconomic(companyId, economicCustomerId) {
    return apiFetch('/companies/' + companyId + '/economic', {
        method: 'PATCH',
        body: JSON.stringify({ economic_customer_id: economicCustomerId }),
    });
}

function patchCompanyIdentifiers(companyId, fields) {
    // fields: { name?, cvr?, legal_name?, ean? } — kun medsendte felter opdateres
    return apiFetch('/companies/' + companyId + '/identifiers', {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

function patchCustomerEconomic(customerId, fields) {
    return apiFetch('/customers/' + customerId + '/economic', {
        method: 'PATCH',
        body: JSON.stringify(fields),
    });
}

/* ── MAIL (UNMATCHED) ───────────────────────────────────── */

function fetchUnmatchedMails(status) {
    var qs = status ? '?status=' + status : '';
    return apiFetch('/mail/unmatched' + qs);
}

function patchUnmatchedMail(id, data) {
    return apiFetch('/mail/unmatched/' + id, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

function bulkIgnoreUnmatchedMails(ids) {
    return apiFetch('/mail/unmatched/bulk', {
        method: 'POST',
        body: JSON.stringify({ ids: ids, action: 'ignored' }),
    });
}

// Opret afsenderen som privat lead + knyt mailen til den nye kunde
// useParsed=true opretter den VIDERESENDTE afsender som lead i stedet for
// kollegaen der trykkede videresend (mail_unmatched.parsed_*).
function createLeadFromUnmatchedMail(id, useParsed) {
    return apiFetch('/mail/unmatched/' + id + '/create-lead', {
        method: 'POST',
        body: JSON.stringify({ use_parsed: !!useParsed }),
    });
}

// Hent en ufordelt mail igen fra serveren (body_html + inline-billeder)
function refetchUnmatchedMail(id) {
    return apiFetch('/mail/unmatched/' + id + '/refetch', { method: 'POST' });
}

// Svar på en ufordelt mail (opretter lead hvis mailen ikke er knyttet til en kunde endnu)
function replyToUnmatchedMail(id, data) {
    return apiFetch('/mail/unmatched/' + id + '/reply', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

/* ── SAMLET INDBAKKE (mail_threads) ─────────────────────── */

// Liste over kunde/bon-tråde med handling_status. status: aabne|udsat|kunde|luk|mine|ikke_knyttet|alle
function fetchMailThreads(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/mail/threads' + qs);
}

function fetchMailThread(id) {
    return apiFetch('/mail/threads/' + id);
}

function fetchMailThreadCounts() {
    return apiFetch('/mail/threads/counts');
}

// Svar på en tråd. data: { body, remind_days? }
function replyMailThread(id, data) {
    return apiFetch('/mail/threads/' + id + '/reply', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// Opdatér tråd. data: { handling_status?, snooze_days?, snooze_until?, assigned_to? }
function patchMailThread(id, data) {
    return apiFetch('/mail/threads/' + id, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

// Prefill til bon-draweren (+ valgfri knytning via { bon_id })
function mailThreadCreateBon(id, data) {
    return apiFetch('/mail/threads/' + id + '/create-bon', {
        method: 'POST',
        body: JSON.stringify(data || {}),
    });
}

/* ── TILBUD ─────────────────────────────────────────────── */

function fetchQuotes(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/quotes' + qs);
}

function fetchQuote(id) {
    return apiFetch('/quotes/' + id);
}

function createQuote(data) {
    return apiFetch('/quotes', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function updateQuote(id, data) {
    return apiFetch('/quotes/' + id, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

function deleteQuote(id) {
    return apiFetch('/quotes/' + id, { method: 'DELETE' });
}

// Fler-dags-tilbud (#425). Reconcile: send ALTID den fulde liste — rækker med
// `id` opdateres, nye oprettes, og dem der ikke er med, slettes. Svaret bærer
// dagenes id'er, som linjernes `offer_day_id` skal pege på; derfor skal dette
// kald ligge FØR den PATCH der gemmer linjerne.
function putQuoteDays(id, days) {
    return apiFetch('/quotes/' + id + '/days', {
        method: 'PUT',
        body: JSON.stringify({ days }),
    });
}

function patchQuoteStatus(id, status) {
    return apiFetch('/quotes/' + id + '/status', {
        method: 'PATCH',
        body: JSON.stringify({ status: status }),
    });
}

function convertQuoteToBon(id) {
    return apiFetch('/quotes/' + id + '/convert', { method: 'POST' });
}

function unlockQuote(id) {
    return apiFetch('/quotes/' + id + '/unlock', { method: 'POST' });
}

function lockQuote(id) {
    return apiFetch('/quotes/' + id + '/lock', { method: 'POST' });
}

function fetchNextQuoteNumber() {
    return apiFetch('/quotes/next-number');
}

/* ── PURCHASING (leverandører + grocy-locations) ──────── */

function fetchPurchasingSuppliers(siteId) {
    var qs = siteId ? '?location_id=' + siteId : '';
    return apiFetch('/purchasing/suppliers' + qs);
}

function fetchPurchasingGrocyLocations() {
    return apiFetch('/purchasing/suppliers/grocy-locations');
}

function linkGrocyLocation(data) {
    return apiFetch('/purchasing/suppliers/grocy-locations', {
        method: 'POST', body: JSON.stringify(data),
    });
}

function unlinkGrocyLocation(grocyLocationId) {
    return apiFetch('/purchasing/suppliers/grocy-locations/' + grocyLocationId, { method: 'DELETE' });
}

function createSupplier(data) {
    return apiFetch('/purchasing/suppliers', { method: 'POST', body: JSON.stringify(data) });
}

function updateSupplier(id, data) {
    return apiFetch('/purchasing/suppliers/' + id, { method: 'PATCH', body: JSON.stringify(data) });
}

function deleteSupplier(id) {
    return apiFetch('/purchasing/suppliers/' + id, { method: 'DELETE' });
}

/* ── SUPPLIER MAIL — fri kommunikation med leverandør ─── */

function fetchSupplierMail(supplierId) {
    return apiFetch('/purchasing/suppliers/' + supplierId + '/mail');
}

function fetchSupplierMailThreads(supplierId) {
    return apiFetch('/purchasing/suppliers/' + supplierId + '/mail-threads');
}

function sendSupplierMail(supplierId, body) {
    return apiFetch('/purchasing/suppliers/' + supplierId + '/mail', {
        method: 'POST', body: JSON.stringify(body)
    });
}

function markSupplierMailRead(supplierId) {
    return apiFetch('/purchasing/suppliers/' + supplierId + '/mail/read', { method: 'PATCH' });
}

function fetchSupplierMailOverview(unreadOnly) {
    return apiFetch('/purchasing/suppliers/mail-overview' + (unreadOnly ? '?unread_only=1' : ''));
}

function updateProductBarcode(id, body) {
    return apiFetch('/grocy/product-barcodes/' + id, { method: 'PUT', body: JSON.stringify(body) });
}

function updateProductBarcodeUserfields(id, body) {
    return apiFetch('/grocy/userfields/product_barcodes/' + id, { method: 'PUT', body: JSON.stringify(body) });
}

function deleteProductBarcode(id) {
    return apiFetch('/grocy/product-barcodes/' + id, { method: 'DELETE' });
}

function putGrocyProduct(id, body) {
    return apiFetch('/grocy/products/' + id, { method: 'PUT', body: JSON.stringify(body) });
}

/* ── HOKA (Hørkram via /api/horkram — parsed data) ───── */

function fetchHokaStatus() { return apiFetch('/horkram/health'); }

/** Søg i Hoka-katalog — returnerer { totalResults, results: [{varenummer, name, ...}] } */
function fetchHokaSearch(q) { return apiFetch('/horkram/search?q=' + encodeURIComponent(q)); }

/** Hent enkelt produkt med fulde detaljer — returnerer parsed produkt */
function fetchHokaProduct(varenr) { return apiFetch('/horkram/product/' + varenr); }

/**
 * Validér et manuelt indtastet Hørkram-varenummer mod hoka.dk.
 * Kaster ALDRIG — returnerer { found:true, ...produkt } eller { found:false }.
 * Bruges i opret/kobl-draweren (CLAUDE_INDKOB_6H.md Del 5): ukendt nummer
 * advarer men blokerer ikke kobling.
 */
async function lookupHokaVarenr(varenr) {
    try {
        var p = await fetchHokaProduct(String(varenr).trim());
        return Object.assign({ found: true }, p);
    } catch (err) {
        return { found: false, error: err.message || '' };
    }
}

/** Batch snapshots — returnerer { products: [{varenummer, name, salesUnits, ...}] } */
function fetchHokaSnapshots(ids, date) {
    var qs = 'ids=' + ids.join(',');
    if (date) qs += '&date=' + date;
    return apiFetch('/horkram/snapshots?' + qs);
}

/** Favorit-lister — returnerer { lists: [{id, name, type}] } */
function fetchHokaFavorites() { return apiFetch('/horkram/favorites'); }

/** ALLE produkter i en favorit-liste (auto-pagineret) — returnerer { products: [...] } */
function fetchHokaFavoritesAll(listId) { return apiFetch('/horkram/favorites/' + encodeURIComponent(listId) + '/all'); }

/** Leveringsdatoer */
function fetchHokaDeliveryDates() { return apiFetch('/horkram/delivery-dates'); }

/** Dropsize-check — minimum ordrebeløb for levering */
function fetchHokaDropsize(subtotal, date) {
    var qs = 'subtotal=' + (subtotal || 0);
    if (date) qs += '&date=' + encodeURIComponent(date);
    return apiFetch('/horkram/dropsize?' + qs);
}

/** Læg varer i kurv — PUT /api/horkram/basket/add med CSRF-token */
function putHokaBasket(products) {
    return apiFetch('/horkram/basket/add', {
        method: 'PUT', body: JSON.stringify({ products: products }),
    });
}

function fetchHokaOrders() { return apiFetch('/horkram/orders'); }

/* ── PURCHASE ORDERS (/api/orders) ───────────────────── */

function fetchPendingOrders() { return apiFetch('/orders/pending'); }

function fetchPendingOrder(id) { return apiFetch('/orders/pending/' + id); }

function createPendingOrder(data) {
    return apiFetch('/orders/pending', {
        method: 'POST', body: JSON.stringify(data),
    });
}

function updatePendingOrder(id, data) {
    return apiFetch('/orders/pending/' + id, {
        method: 'PUT', body: JSON.stringify(data),
    });
}

/** Hent mail-tråd for en purchase order */
function fetchOrderMailThread(orderId) {
    return apiFetch('/orders/pending/' + orderId + '/mail');
}

/** Send svar i PO-mail-tråd */
function sendOrderReply(orderId, bodyText) {
    return apiFetch('/orders/pending/' + orderId + '/mail', {
        method: 'POST', body: JSON.stringify({ body_text: bodyText }),
    });
}

/** Markér PO-mails som læst */
function markOrderMailRead(orderId) {
    return apiFetch('/orders/pending/' + orderId + '/mail/read', {
        method: 'PATCH',
    });
}

/** Alle PO-tråde med mail (til supplier-inbox) */
function fetchOrderMailThreads(params) {
    var qs = '';
    if (params && params.unread_only) qs = '?unread_only=1';
    return apiFetch('/orders/mail-threads' + qs);
}

/* ── RECEIVING (/api/receiving) ──────────────────────── */

function postReceivingComplete(data) {
    return apiFetch('/receiving/complete', {
        method: 'POST', body: JSON.stringify(data),
    });
}

/* ── GOODS RECEIPTS (/api/goods-receipts) ────────────── */

function postGoodsReceiptPhoto(formData) {
    return fetch(API_BASE + '/goods-receipts/photo', {
        method: 'POST', body: formData,
    }).then(function(r) {
        if (!r.ok) return r.json().then(function(b) { throw new Error(b.error || 'Upload fejl'); });
        return r.json();
    });
}

function postGoodsReceipt(data) {
    return apiFetch('/goods-receipts', {
        method: 'POST', body: JSON.stringify(data),
    });
}

function fetchGoodsReceipts(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/goods-receipts' + qs);
}

function fetchGoodsReceiptUsers() {
    return apiFetch('/goods-receipts/users');
}

function fetchGoodsReceipt(id) {
    return apiFetch('/goods-receipts/' + id);
}

function fetchGoodsReceiptWebhookLog(limit) {
    return apiFetch('/goods-receipts/webhook-log' + (limit ? '?limit=' + limit : ''));
}

function resendGoodsReceiptWebhook(id) {
    return apiFetch('/goods-receipts/' + id + '/resend-webhook', { method: 'POST' });
}

/* ── STAFF (/api/staff) ─────────────────────────────── */

function fetchStaff(includeInactive) {
    var qs = includeInactive ? '?all=1' : '';
    return apiFetch('/staff' + qs);
}

function createStaff(data) {
    return apiFetch('/staff', {
        method: 'POST', body: JSON.stringify(data),
    });
}

function updateStaff(id, data) {
    return apiFetch('/staff/' + id, {
        method: 'PATCH', body: JSON.stringify(data),
    });
}

function deleteStaff(id) {
    return apiFetch('/staff/' + id, { method: 'DELETE' });
}

/* ── PHYSICAL UNITS (lageroptælling) ──────────────────── */

function fetchPhysicalUnits(locationId, includeArchived) {
    var qs = '?location_id=' + locationId + (includeArchived ? '&all=1' : '');
    return apiFetch('/physical-units' + qs);
}

function createPhysicalUnit(locationId, name, sortOrder) {
    return apiFetch('/physical-units', {
        method: 'POST',
        body: JSON.stringify({
            grocy_location_id: locationId,
            name: name,
            sort_order: sortOrder || 0,
        }),
    });
}

function updatePhysicalUnit(id, data) {
    return apiFetch('/physical-units/' + id, {
        method: 'PATCH', body: JSON.stringify(data),
    });
}

/* ── REPORTS ──────────────────────────────────────────── */

// Fælles rapport-filtre → query-param-fragmenter. filters = { from, to, exclude_cats }.
// Alle rapport-endpoints læser de samme parametre (routes/reports.js parseReportFilters);
// periode-uafhængige kort (månedssøjler, akkumuleret, legoklods) ignorerer bare from/to.
function _reportFilterQS(filters) {
    var qs = [];
    if (!filters) return qs;
    if (filters.from) qs.push('from=' + encodeURIComponent(filters.from));
    if (filters.to)   qs.push('to='   + encodeURIComponent(filters.to));
    if (filters.exclude_cats) qs.push('exclude_cats=' + encodeURIComponent(filters.exclude_cats));
    // Sammenlign år: eksplicit baseline-periode (år-mod-år)
    if (filters.cmp_from) qs.push('cmp_from=' + encodeURIComponent(filters.cmp_from));
    if (filters.cmp_to)   qs.push('cmp_to='   + encodeURIComponent(filters.cmp_to));
    return qs;
}

function fetchReportsYears() {
    return apiFetch('/reports/years');
}

function _reportUrl(path, params) {
    var qs = (params || []).filter(Boolean);
    return path + (qs.length ? '?' + qs.join('&') : '');
}

function fetchReportsSummary(filters) {
    return apiFetch(_reportUrl('/reports/summary', _reportFilterQS(filters)));
}

function fetchReportsMonthly(filters) {
    var params = _reportFilterQS(filters);
    // Sammenlign år: kalenderår A-vs-B mode
    if (filters && filters.monthly_year) {
        params.push('year=' + filters.monthly_year);
        if (filters.monthly_compare) params.push('compare_year=' + filters.monthly_compare);
    }
    return apiFetch(_reportUrl('/reports/monthly', params));
}

function fetchReportsTopCustomers(by, filters) {
    var params = _reportFilterQS(filters);
    if (by) params.unshift('by=' + by);
    return apiFetch(_reportUrl('/reports/top-customers', params));
}

function fetchReportsCategories(filters) {
    return apiFetch(_reportUrl('/reports/categories', _reportFilterQS(filters)));
}

function fetchReportsMonthlyTable(filters) {
    return apiFetch(_reportUrl('/reports/monthly-table', _reportFilterQS(filters)));
}

/**
 * Lego-rapporten. To kald-former:
 *   fetchReportsLego(months, year)         — backwards compat, vælg måneder i ét år
 *   fetchReportsLego({ periods: ['2026-05','2025-05'] })  — eksplicit periode-liste (år-mod-år)
 */
function fetchReportsLego(monthsOrOpts, year, filters) {
    var params = [];
    if (monthsOrOpts && typeof monthsOrOpts === 'object' && !Array.isArray(monthsOrOpts)) {
        // Object form: { periods: ['YYYY-MM',...] }
        if (monthsOrOpts.periods && monthsOrOpts.periods.length) {
            params.push('periods=' + monthsOrOpts.periods.join(','));
        }
    } else {
        var months = monthsOrOpts;
        if (months && months.length) params.push('months=' + months.join(','));
        if (year) params.push('year=' + year);
    }
    // Legoklods bruger kun exclude_cats (periode styres af dens egne måneds-vælgere).
    var ff = _reportFilterQS(filters);
    for (var i = 0; i < ff.length; i++) if (ff[i].indexOf('exclude_cats=') === 0) params.push(ff[i]);
    return apiFetch(_reportUrl('/reports/lego', params));
}

function fetchReportsCumulative(years, filters) {
    var params = [];
    if (years && years.length) params.push('years=' + years.join(','));
    // Akkumuleret bruger kun exclude_cats (periode = dens egne år-kurver).
    var ff = _reportFilterQS(filters);
    for (var i = 0; i < ff.length; i++) if (ff[i].indexOf('exclude_cats=') === 0) params.push(ff[i]);
    return apiFetch(_reportUrl('/reports/cumulative', params));
}

function fetchReportsTopCategories(filters) {
    return apiFetch(_reportUrl('/reports/top-categories', _reportFilterQS(filters)));
}

// Modregning/Sponsorat — ikke omsætning, men findbar (ægte beløb givet væk/byttet).
// Følger den globale periode + kategori-filter (filters = { from, to, exclude_cats }).
function fetchReportsGiveaways(filters) {
    return apiFetch(_reportUrl('/reports/giveaways', _reportFilterQS(filters)));
}

/* ── CASHFLOW ────────────────────────────────────────── */

async function uploadCashflowCSV(file) {
    var fd = new FormData();
    fd.append('file', file);
    var res = await fetch(API_BASE + '/cashflow/upload', { method: 'POST', body: fd });
    if (!res.ok) {
        var body = await res.json().catch(function() { return {}; });
        throw new Error(body.error || 'Upload fejlede');
    }
    return res.json();
}

function fetchCfStats() {
    return apiFetch('/cashflow/stats');
}

// e-conomic-afstemning (delta B): markér cf_invoices betalt fra e-conomics bogføring.
function reconcileCashflow(opts) {
    return apiFetch('/cashflow/reconcile', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts || {}),
    });
}
function fetchReconcileStatus() {
    return apiFetch('/cashflow/reconcile/status');
}

function fetchCfWeekly() {
    return apiFetch('/cashflow/weekly');
}

function fetchCfTransactions(opts) {
    var params = [];
    if (opts && opts.from) params.push('from=' + opts.from);
    if (opts && opts.to)   params.push('to=' + opts.to);
    if (opts && opts.unmatched) params.push('unmatched=1');
    if (opts && opts.limit) params.push('limit=' + opts.limit);
    if (opts && opts.q) params.push('q=' + encodeURIComponent(opts.q));
    if (opts && opts.includeFolded) params.push('include_folded=1');
    if (opts && opts.category) params.push('category=' + encodeURIComponent(opts.category));
    if (opts && opts.min) params.push('min=' + opts.min);
    if (opts && opts.sort) params.push('sort=' + opts.sort);
    var qs = params.length ? '?' + params.join('&') : '';
    return apiFetch('/cashflow/transactions' + qs);
}

function fetchCfInvoices(tab) {
    var qs = tab ? '?tab=' + tab : '';
    return apiFetch('/cashflow/invoices' + qs);
}

function createCfInvoice(data) {
    return apiFetch('/cashflow/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function patchCfInvoice(id, data) {
    return apiFetch('/cashflow/invoices/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function deleteCfInvoice(id) {
    return apiFetch('/cashflow/invoices/' + encodeURIComponent(id), { method: 'DELETE' });
}

function matchCfTransaction(txId, invoiceId) {
    return apiFetch('/cashflow/match/' + txId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invoice_id: invoiceId }) });
}

function unmatchCfTransaction(txId) {
    return apiFetch('/cashflow/match/' + txId, { method: 'DELETE' });
}

function patchCfTransaction(txId, data) {
    return apiFetch('/cashflow/transactions/' + txId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

function confirmCfInvoicePaid(invoiceId) {
    return apiFetch('/cashflow/invoices/' + encodeURIComponent(invoiceId) + '/confirm-paid', { method: 'POST' });
}

function rejectCfInvoiceMatch(invoiceId) {
    return apiFetch('/cashflow/invoices/' + encodeURIComponent(invoiceId) + '/reject-match', { method: 'POST' });
}

function bulkConfirmCfInvoicesPaid(olderThanDays, dryRun) {
    return apiFetch('/cashflow/invoices/bulk-confirm-paid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ older_than_days: olderThanDays, dry_run: !!dryRun })
    });
}

function fetchCfAnalyse() {
    return apiFetch('/cashflow/analyse');
}

function fetchCfPaymentBehavior() {
    return apiFetch('/cashflow/payment-behavior');
}

function fetchCfUpcoming() {
    return apiFetch('/cashflow/upcoming');
}

function fetchCfSuggestMatches() {
    return apiFetch('/cashflow/suggest-matches');
}

/* ── §2.F Split-allokering + universel kobling ─────────────── */
function fetchCfMatchTargets(q, opts = {}) {
    const p = new URLSearchParams({ q: q || '' });
    if (opts.date) p.set('date', opts.date);
    if (opts.limit) p.set('limit', opts.limit);
    return apiFetch('/cashflow/match-targets?' + p.toString());
}

function fetchCfAllocations(txId) {
    return apiFetch('/cashflow/transactions/' + txId + '/allocations');
}

function createCfAllocations(txId, allocations) {
    return apiFetch('/cashflow/allocations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: txId, allocations })
    });
}

function deleteCfAllocation(allocId) {
    return apiFetch('/cashflow/allocations/' + allocId, { method: 'DELETE' });
}

function patchCfAllocation(allocId, amount) {
    return apiFetch('/cashflow/allocations/' + allocId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount })
    });
}

function fetchCfEventsOnDate(date) {
    return apiFetch('/cashflow/events-on-date?date=' + encodeURIComponent(date || ''));
}

function fetchEventsList(status) {
    return apiFetch('/events' + (status ? '?status=' + encodeURIComponent(status) : ''));
}

function fetchCfEventIncome() {
    return apiFetch('/cashflow/event-income');
}

function createBonFromCfTx(data) {
    return apiFetch('/cashflow/create-bon-from-tx', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
}

function fetchCandidatesForEvent(eventId) {
    return apiFetch('/cashflow/candidates-for-event?event_id=' + encodeURIComponent(eventId));
}

/* ── RFM & KUNDEINDSIGT ────────────────────────────────────── */

function fetchRfmScores(params) {
    var qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return apiFetch('/rfm/scores' + qs);
}

function fetchRfmConfig() {
    return apiFetch('/rfm/config');
}

function patchRfmConfig(updates) {
    return apiFetch('/rfm/config', { method: 'PATCH', body: JSON.stringify(updates) });
}

function triggerRfmCompute() {
    return apiFetch('/rfm/compute', { method: 'POST' });
}

function patchRfmStage(companyId, stage) {
    return apiFetch('/rfm/scores/' + companyId + '/stage', {
        method: 'PATCH', body: JSON.stringify({ stage: stage })
    });
}

function unlockRfmStage(companyId) {
    return apiFetch('/rfm/scores/' + companyId + '/unlock', { method: 'PATCH' });
}

function fetchRfmReactivation() {
    return apiFetch('/rfm/reactivation');
}

function fetchRfmProspects(params) {
    var clean = {};
    if (params) for (var k in params) { if (params[k] != null && params[k] !== '') clean[k] = params[k]; }
    var qs = Object.keys(clean).length ? '?' + new URLSearchParams(clean).toString() : '';
    return apiFetch('/rfm/prospects' + qs);
}

function fetchRfmIcp(source) {
    return apiFetch('/rfm/icp?source=' + (source || 'vip'));
}

/* ── AKTIVITETSFORMÅL ──────────────────────────────────────── */

function fetchActivityPurposes(all) {
    return apiFetch('/activity-purposes' + (all ? '?all=1' : ''));
}

function createActivityPurpose(data) {
    return apiFetch('/activity-purposes', { method: 'POST', body: JSON.stringify(data) });
}

function patchActivityPurpose(id, data) {
    return apiFetch('/activity-purposes/' + id, { method: 'PATCH', body: JSON.stringify(data) });
}

/* ── KONTAKTPUNKTER (contact_points) ──────────────────────── */

function fetchContactPoints(entityType, entityId) {
    return apiFetch('/contact-points?entity_type=' + encodeURIComponent(entityType) +
                    '&entity_id=' + encodeURIComponent(entityId));
}

function createContactPoint(data) {
    return apiFetch('/contact-points', { method: 'POST', body: JSON.stringify(data) });
}

function updateContactPoint(id, patch) {
    return apiFetch('/contact-points/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
}

function deleteContactPoint(id) {
    return apiFetch('/contact-points/' + id, { method: 'DELETE' });
}

function toggleContactPublic(id) {
    return apiFetch('/contact-points/' + id + '/toggle-public', { method: 'PATCH' });
}

/* ── CVR-BERIGELSE ──────────────────────────────────────────── */

function fetchCompanyEnrichPreview(companyId) {
    return apiFetch('/companies/' + companyId + '/enrich-preview');
}

function applyCompanyEnrich(companyId, body) {
    return apiFetch('/companies/' + companyId + '/enrich', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

/* ── CRM-FIRMAER (listview) ─────────────────────────────────── */

function fetchCrmCompanies(params = {}) {
    const qs = new URLSearchParams();
    if (params.stage) qs.set('stage', params.stage);
    if (params.q)     qs.set('q', params.q);
    if (params.limit) qs.set('limit', params.limit);
    if (params.order_after)  qs.set('order_after', params.order_after);
    if (params.order_before) qs.set('order_before', params.order_before);
    const s = qs.toString();
    return apiFetch('/crm/companies' + (s ? '?' + s : ''));
}

function fetchCrmCompany(id) {
    return apiFetch('/crm/company/' + id);
}

/* ── BATCH-CVR-BERIGELSE (admin) ────────────────────────────── */

function fetchBatchEnrichStatus() {
    return apiFetch('/admin/batch-enrich/status');
}

function startBatchEnrich(opts = {}) {
    return apiFetch('/admin/batch-enrich', {
        method: 'POST',
        body: JSON.stringify(opts),
    });
}

function cancelBatchEnrich() {
    return apiFetch('/admin/batch-enrich/cancel', { method: 'POST' });
}

function fetchBatchEnrichProposals() {
    return apiFetch('/admin/batch-enrich/proposals');
}

function applyBatchEnrich(selections) {
    return apiFetch('/admin/batch-enrich/apply', {
        method: 'POST',
        body: JSON.stringify({ selections }),
    });
}

function extractCompanyContacts(companyId, text, sourceUrl) {
    return apiFetch('/companies/' + companyId + '/extract-contacts', {
        method: 'POST',
        body: JSON.stringify({ text, source_url: sourceUrl || null }),
    });
}

// ─── JOBTYPE & LØN (admin-only) ──────────────────────────────

function fetchRoleMap() {
    return apiFetch('/role-map');
}

function updateRoleClass(jobtypeUuid, roleClass) {
    return apiFetch('/role-map/' + encodeURIComponent(jobtypeUuid), {
        method: 'PATCH',
        body: JSON.stringify({ role_class: roleClass }),
    });
}

function fetchWageRates() {
    return apiFetch('/wage-rates');
}

function importWageRates(csv) {
    return apiFetch('/wage-rates/import', {
        method: 'POST',
        body: JSON.stringify({ csv }),
    });
}

// ─── DELIVERY (Spor 1: manuel bestilling) ────────────────────

function fetchDeliveryVehicles(includeInactive = false) {
    const qs = includeInactive ? '?include_inactive=1' : '';
    return apiFetch('/delivery/vehicles' + qs);
}

function fetchDeliveryVehicle(id) {
    return apiFetch('/delivery/vehicles/' + id);
}

function createDeliveryVehicle(data) {
    return apiFetch('/delivery/vehicles', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function patchDeliveryVehicle(id, data) {
    return apiFetch('/delivery/vehicles/' + id, {
        method: 'PATCH',
        body: JSON.stringify(data),
    });
}

function deleteDeliveryVehicle(id) {
    return apiFetch('/delivery/vehicles/' + id, { method: 'DELETE' });
}

function fetchDeliveryTemplateVariables() {
    return apiFetch('/delivery/template-variables');
}

function fetchBookingPayload(bonId, vehicleId) {
    return apiFetch('/delivery/booking-payload?bon_id=' + bonId + '&vehicle_id=' + vehicleId);
}

function bookDelivery(data) {
    return apiFetch('/delivery/book', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function setDeliveryActualCost(data) {
    return apiFetch('/delivery/actual-cost', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function cancelDelivery(data) {
    return apiFetch('/delivery/cancel', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function fetchDeliveryEvents(bonId) {
    return apiFetch('/delivery/events?bon_id=' + bonId);
}

// Foreslået kundepris for levering (By-ex-pris/kvittering + markup, incl moms).
function fetchDeliveryCustomerPrice(bonId) {
    return apiFetch('/delivery/customer-price?bon_id=' + bonId);
}

// Lobo/By-expressen — live kostpris for én bon (opretter + sletter en
// orderdraft hos Lobo; INGEN ordre bookes). Returnerer { cost_ex, cost_incl,
// customer_ex, margin, routedistance, co2saving }.
function fetchLoboQuote(bonId, boxes) {
    var qs = '/delivery/lobo/quote?bon_id=' + bonId;
    if (boxes != null && boxes !== '') qs += '&boxes=' + encodeURIComponent(boxes);
    return apiFetch(qs);
}

// Lobo/By-expressen — se-og-ret-panel: felter der sendes + vindue + pris.
// data: { bon_id, pickup_time?, boxes?, fkproduct?, contact?, note?, reference? }
function previewLoboBooking(data) {
    return apiFetch('/delivery/lobo/preview', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// Lobo/By-expressen — webhook-registrering + selvkalibrerings-status (admin).
function fetchLoboWebhookStatus() {
    return apiFetch('/delivery/lobo/webhooks');
}
function registerLoboWebhooks(publicBaseUrl) {
    return apiFetch('/delivery/lobo/webhooks/register', {
        method: 'POST',
        body: JSON.stringify(publicBaseUrl ? { public_base_url: publicBaseUrl } : {}),
    });
}
function unregisterLoboWebhooks() {
    return apiFetch('/delivery/lobo/webhooks', { method: 'DELETE' });
}

// Lobo/By-expressen — trin 3: on-demand status for booket ordre (status/ETA/POD/pris).
function fetchLoboOrderStatus(bonId) {
    return apiFetch('/delivery/lobo/order-status?bon_id=' + bonId);
}

// URL til kvitterings-PDF (POD) — åbnes i ny fane (server-proxy med bearer-token).
function loboPodUrl(bonId) {
    return '/api/delivery/lobo/pod?bon_id=' + bonId;
}

// Lobo/By-expressen — rigtig booking (dispatch). Mod productive kræves confirm:true.
// data: { bon_id, confirm?, ...overrides } — overrides = samme felter som preview.
function bookLoboDelivery(data) {
    return apiFetch('/delivery/lobo/book', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// Lobo/By-expressen — sandkasse-tilstand (til badge + Settings master-kontakt).
function fetchLoboStatus() {
    return apiFetch('/delivery/lobo/status');
}

// Lobo/By-expressen — master-kontakt (admin): slå sandkasse til/fra globalt.
function setLoboSandbox(enabled) {
    return apiFetch('/delivery/lobo/sandbox', {
        method: 'POST',
        body: JSON.stringify({ enabled: !!enabled }),
    });
}

// Spor 2 — leverings-forslag. data: { bon_id } eller
// { lat, lng, delivery_time?, boxes?, pax? }
function calculateDelivery(data) {
    return apiFetch('/delivery/calculate', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

// Hvad har vi historisk taget for at levere til et postnummer?
// Kilde: leveringslinjer på bons (INCL moms) — svaret bærer begge dele.
function fetchDeliveryPriceHistory(postalCode, limit) {
    var q = '/delivery/price-history?postal_code=' + encodeURIComponent(postalCode);
    if (limit) q += '&limit=' + limit;
    return apiFetch(q);
}

function deliveryHealth() {
    return apiFetch('/delivery/health');
}

function fetchDeliveryHistoryMap(from, to, method) {
    var qs = '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
    if (method) qs += '&method=' + encodeURIComponent(method);
    return apiFetch('/delivery/history-map' + qs);
}

// Spor 2 — ruter (Workflow B + A)
function fetchDeliveryOverview(date) {
    return apiFetch('/delivery/overview?date=' + encodeURIComponent(date));
}

function fetchDeliveryRoutes(date) {
    return apiFetch('/delivery/routes' + (date ? '?date=' + encodeURIComponent(date) : ''));
}

function createDeliveryRoute(data) {
    return apiFetch('/delivery/routes', { method: 'POST', body: JSON.stringify(data) });
}

function updateDeliveryRoute(id, data) {
    return apiFetch('/delivery/routes/' + id, { method: 'PUT', body: JSON.stringify(data) });
}

function deleteDeliveryRoute(id) {
    return apiFetch('/delivery/routes/' + id, { method: 'DELETE' });
}

function addDeliveryRouteStop(routeId, bonId) {
    return apiFetch('/delivery/routes/' + routeId + '/stops', {
        method: 'POST', body: JSON.stringify({ bon_id: bonId }),
    });
}

function removeDeliveryRouteStop(routeId, bonId) {
    return apiFetch('/delivery/routes/' + routeId + '/stops/' + bonId, { method: 'DELETE' });
}

function reorderDeliveryRouteStops(routeId, bonIds) {
    return apiFetch('/delivery/routes/' + routeId + '/stops/reorder', {
        method: 'PUT', body: JSON.stringify({ bon_ids: bonIds }),
    });
}

function computeDeliveryRoute(routeId) {
    return apiFetch('/delivery/routes/' + routeId + '/compute', { method: 'POST' });
}

function applyDeliveryRoute(routeId) {
    return apiFetch('/delivery/routes/' + routeId + '/apply', { method: 'POST' });
}

function setRoutePickupTime(routeId, data) {
    return apiFetch('/delivery/routes/' + routeId + '/pickup-time', {
        method: 'POST', body: JSON.stringify(data || {}),
    });
}

function setDeliveryRouteActualCost(routeId, data) {
    return apiFetch('/delivery/routes/' + routeId + '/actual-cost', {
        method: 'POST', body: JSON.stringify(data),
    });
}

function bookDeliveryRoute(routeId, data) {
    return apiFetch('/delivery/routes/' + routeId + '/book', {
        method: 'POST', body: JSON.stringify(data || {}),
    });
}

// ─── Delivery Spor 2 — courier (S2.3) ──────────────────────────

// date (valgfri, YYYY-MM-DD) — uden = i dag. Lader chaufføren bladre i dagene.
function fetchCourierToday(date) {
    return apiFetch('/delivery/courier/today' + (date ? '?date=' + encodeURIComponent(date) : ''));
}

function departDeliveryRoute(routeId) {
    return apiFetch('/delivery/routes/' + routeId + '/depart', { method: 'POST' });
}

function undoDepartDeliveryRoute(routeId) {
    return apiFetch('/delivery/routes/' + routeId + '/undo-depart', { method: 'POST' });
}

// Aktive brugere der kan tildeles en rute som chauffør.
function fetchDeliveryCouriers() {
    return apiFetch('/delivery/couriers');
}

// data: { status: 'leveret'|'problem', lat?, lng? }
function setDeliveryStopStatus(stopId, data) {
    return apiFetch('/delivery/stops/' + stopId + '/status', {
        method: 'POST', body: JSON.stringify(data || {}),
    });
}

// data: { bon_id, incident_type, route_stop_id?, description?,
//         location_lat?, location_lng?, photo?(File) }
async function logDeliveryIncident(data) {
    var fd = new FormData();
    fd.append('bon_id', String(data.bon_id));
    fd.append('incident_type', data.incident_type);
    if (data.route_stop_id != null) fd.append('route_stop_id', String(data.route_stop_id));
    if (data.description)   fd.append('description', data.description);
    if (data.location_lat != null) fd.append('location_lat', String(data.location_lat));
    if (data.location_lng != null) fd.append('location_lng', String(data.location_lng));
    if (data.photo)         fd.append('photo', data.photo);
    var res = await fetch(API_BASE + '/delivery/incidents', { method: 'POST', body: fd });
    if (!res.ok) {
        var body = await res.json().catch(function() { return {}; });
        throw new Error(body.error || 'Kunne ikke logge problem');
    }
    return res.json();
}

// ─── Web-orders (#042) ──────────────────────────────────────

function fetchPendingWebOrders() {
    return apiFetch('/web-orders/pending');
}

function acknowledgeBon(bonId, undo = false) {
    return apiFetch('/bons/' + bonId + '/acknowledge', {
        method: 'PATCH',
        body: JSON.stringify({ undo }),
    });
}

// Fælles "Nyt der kræver handling"-feed til office-topbarens indikator.
function fetchNavAttention() {
    return apiFetch('/nav/attention');
}

// ─── Opskrifter & priser ──────────────────────────────────────

function fetchRecipesOverview(params = {}) {
    const qs = new URLSearchParams();
    if (params.price_category) qs.append('price_category', params.price_category);
    if (params.period_days)    qs.append('period_days', params.period_days);
    if (params.category)       qs.append('category', params.category);
    if (params.include_inactive) qs.append('include_inactive', '1');
    const s = qs.toString();
    return apiFetch('/recipes/overview' + (s ? '?' + s : ''));
}

function refreshRecipeCosts() {
    return apiFetch('/recipes/refresh-costs', { method: 'POST' });
}

// Standard-medarbejdersats + overhead til kalkulationens løn-linje.
// { standard_hourly_rate: number|null, employee_count, labor_overhead_pct }
function fetchLaborRate() {
    return apiFetch('/recipes/labor-rate');
}

function forceRecipeBackfill(force = 1) {
    return apiFetch('/recipes/backfill?force=' + force, { method: 'POST' });
}

function putItemPrice(payload) {
    return apiFetch('/item-prices', {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

function fetchRecipeTargets() {
    return apiFetch('/recipes/targets');
}

function putRecipeTargets(targets) {
    return apiFetch('/recipes/targets', {
        method: 'PUT',
        body: JSON.stringify({ targets }),
    });
}

function patchRecipeTarget(category, target_pct) {
    return apiFetch('/recipes/targets/' + encodeURIComponent(category), {
        method: 'PATCH',
        body: JSON.stringify({ target_pct }),
    });
}

function deleteRecipeTarget(category) {
    return apiFetch('/recipes/targets/' + encodeURIComponent(category), {
        method: 'DELETE',
    });
}

function grocyRecipeLink(recipeId) {
    return '/api/recipes/grocy-recipe-link/' + recipeId;
}

// Råvarer + underopskrifter for én opskrift (drill-down i Opskrifter & priser).
function fetchRecipeComposition(recipeId) {
    return apiFetch('/recipes/' + recipeId + '/composition');
}

/* ── CO₂ — materiale-faktortabel + emballage-tildeler (F3) ─── */

function fetchCo2Materials(includeInactive = false) {
    return apiFetch('/co2/materials' + (includeInactive ? '?include_inactive=1' : ''));
}

function patchCo2Material(id, payload) {
    return apiFetch('/co2/materials/' + id, {
        method: 'PATCH',
        body: JSON.stringify(payload),
    });
}

function reresolveCo2Material(id) {
    return apiFetch('/co2/materials/' + id + '/reresolve', { method: 'POST' });
}

function fetchCo2Packaging() {
    return apiFetch('/co2/packaging');
}

function assignCo2Material(productId, material) {
    return apiFetch('/co2/assign', {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, material }),
    });
}

function clearCo2Material(productId) {
    return apiFetch('/co2/clear', {
        method: 'POST',
        body: JSON.stringify({ product_id: productId }),
    });
}

function hideCo2Product(productId) {
    return apiFetch('/co2/hide', {
        method: 'POST',
        body: JSON.stringify({ product_id: productId }),
    });
}

function unhideCo2Product(productId) {
    return apiFetch('/co2/unhide', {
        method: 'POST',
        body: JSON.stringify({ product_id: productId }),
    });
}

function fetchCo2Overview() {
    return apiFetch('/co2/overview');
}

// Periode: tal (months) ELLER objekt { months } / { from, to } (YYYY-MM-DD).
function _co2PeriodQuery(period) {
    if (period == null) return '';
    if (typeof period === 'number') return '?months=' + period;
    if (period.from && period.to) return '?from=' + encodeURIComponent(period.from) + '&to=' + encodeURIComponent(period.to);
    if (period.months) return '?months=' + period.months;
    return '';
}

function fetchCo2Timeseries(period) {
    return apiFetch('/co2/timeseries' + _co2PeriodQuery(period));
}

function fetchCo2Transport(period) {
    return apiFetch('/co2/transport' + _co2PeriodQuery(period));
}

function fetchCo2BonAccuracy(bonId) {
    return apiFetch('/co2/bon/' + bonId + '/accuracy');
}

function setCo2ManualFactor(productId, factor) {
    return apiFetch('/co2/manual-factor', {
        method: 'POST',
        body: JSON.stringify({ product_id: productId, factor }),
    });
}

function fetchCo2Synonyms() {
    return apiFetch('/co2/synonyms');
}

function addCo2Synonym(canonicalName, synonymName) {
    return apiFetch('/co2/synonyms', {
        method: 'POST',
        body: JSON.stringify({ canonical_name: canonicalName, synonym_name: synonymName }),
    });
}

function deleteCo2Synonym(id) {
    return apiFetch('/co2/synonyms/' + id, { method: 'DELETE' });
}

function fetchCo2RecipeBreakdown(id) {
    return apiFetch('/co2/recipe/' + id);
}
