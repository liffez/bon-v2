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

function attachmentUrl(attachmentId) {
    return API_BASE + '/attachments/' + attachmentId + '/download';
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

function fetchDashboardTopProducts(from, to) {
    var params = [];
    if (from) params.push('from=' + from);
    if (to) params.push('to=' + to);
    var qs = params.length ? '?' + params.join('&') : '';
    return apiFetch('/dashboard/top-products' + qs);
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

function postCrmActivity(data) {
    return apiFetch('/crm/activity', {
        method: 'POST',
        body: JSON.stringify(data),
    });
}

function patchCrmCustomerStage(id, stage) {
    return apiFetch('/crm/customer/' + id + '/stage', {
        method: 'PATCH',
        body: JSON.stringify({ stage: stage }),
    });
}

/* ── FAKTURERING ─────────────────────────────────────────── */

function fetchInvoiceQueue(includeDone) {
    var qs = includeDone ? '?include_done=1' : '';
    return apiFetch('/invoices/queue' + qs);
}

function patchCompanyEconomic(companyId, economicCustomerId) {
    return apiFetch('/companies/' + companyId + '/economic', {
        method: 'PATCH',
        body: JSON.stringify({ economic_customer_id: economicCustomerId }),
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

function patchQuoteStatus(id, status) {
    return apiFetch('/quotes/' + id + '/status', {
        method: 'PATCH',
        body: JSON.stringify({ status: status }),
    });
}

function convertQuoteToBon(id) {
    return apiFetch('/quotes/' + id + '/convert', { method: 'POST' });
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

function updateProductBarcode(id, body) {
    return apiFetch('/grocy/product-barcodes/' + id, { method: 'PUT', body: JSON.stringify(body) });
}

function updateProductBarcodeUserfields(id, body) {
    return apiFetch('/grocy/userfields/product_barcodes/' + id, { method: 'PUT', body: JSON.stringify(body) });
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

/* ── RECEIVING (/api/receiving) ──────────────────────── */

function postReceivingComplete(data) {
    return apiFetch('/receiving/complete', {
        method: 'POST', body: JSON.stringify(data),
    });
}

/* ── REPORTS ──────────────────────────────────────────── */

function fetchReportsSummary() {
    return apiFetch('/reports/summary');
}

function fetchReportsMonthly() {
    return apiFetch('/reports/monthly');
}

function fetchReportsTopCustomers(by) {
    var qs = by ? '?by=' + by : '';
    return apiFetch('/reports/top-customers' + qs);
}

function fetchReportsCategories() {
    return apiFetch('/reports/categories');
}

function fetchReportsMonthlyTable() {
    return apiFetch('/reports/monthly-table');
}

function fetchReportsLego(months, year) {
    var params = [];
    if (months && months.length) params.push('months=' + months.join(','));
    if (year) params.push('year=' + year);
    var qs = params.length ? '?' + params.join('&') : '';
    return apiFetch('/reports/lego' + qs);
}

function fetchReportsCumulative(years) {
    var qs = years && years.length ? '?years=' + years.join(',') : '';
    return apiFetch('/reports/cumulative' + qs);
}

function fetchReportsTopCategories() {
    return apiFetch('/reports/top-categories');
}
