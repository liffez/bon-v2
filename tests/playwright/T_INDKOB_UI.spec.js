/**
 * tests/playwright/T_INDKOB_UI.spec.js
 * ════════════════════════════════════════════════════════════
 * Frontend UI-tests for indkøbsliste (shared/indkob.js på
 * kitchen/purchasing.html).
 *
 * Backend-suiterne (T_INDKOB_LISTE/SETUP/ADMIN/HORKRAM) dækker
 * API-kontrakterne, men IKKE selve UI-flowet. Disse tests kører
 * mod den rigtige side i en browser og fanger frontend-regressioner
 * som backend-tests ikke kan se:
 *   - at siden overhovedet mounter (auth + initIndkob)
 *   - søgefelt beholder fokus under debounced re-render (6h-revision-fix)
 *   - søgning filtrerer varer
 *   - view-toggle (Efter kategori / Efter leverandør) + localStorage-persist
 *   - "+ Tilføj vare"-panel + Grocy-autocomplete
 *
 * Selectors er verificeret mod shared/indkob.js pr. juni 2026:
 *   #indkobContainer, .ib-toolbar, .ib-search[data-ib="search"],
 *   [data-ib="add-product"], [data-ib="view-combined"],
 *   [data-ib="view-order"], .ib-vt.on, .ib-item[data-product-id],
 *   .ib-item-name, .ib-cmb-cat, .ib-empty,
 *   #ibAddProdQ[data-ib="add-product-search"], .ib-add-ac-item[data-pid]
 *
 * Usage:
 *   npx playwright test tests/playwright/T_INDKOB_UI.spec.js
 *
 * Forudsætninger:
 *   - test:server kører (default localhost:4322) mod grocytest
 *   - Køkken-rolle med PIN 1234 findes i test.db (seed)
 *   - Playwright + chromium installeret:
 *       npm i -D @playwright/test && npx playwright install chromium
 *
 * Bemærk — grocytest har INGEN api-koblede leverandører, så
 * kurv-/checkout- og produktionsbon-flowet (api/intern-grupper)
 * kan ikke køres end-to-end her. Den logik er dækket af backend +
 * manuel verifikation. Denne spec fokuserer på render + interaktion
 * der virker uanset leverandør-kobling.
 *
 * Reference: tests/specs/T_INDKOB_LISTE.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const { test, expect } = require('@playwright/test');

const BASE_URL      = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const PURCHASING_URL = `${BASE_URL}/kitchen/purchasing.html`;
const PIN           = process.env.TEST_PIN || '1234';

// Kendt Grocy-testprodukt (jf. tests/fixtures/T_INDKOB_pids.json)
const SEED_PRODUCT = { id: 1, name: 'Brød Rug' };

// ────────────────────────────────────────────────────────────
// Hjælpere
// ────────────────────────────────────────────────────────────

// Login som rolle (køkken-PIN) i den givne request-context.
// page.request deler cookie-jar med page-navigationer, så efterfølgende
// page.goto() bærer sessionen — uden per-person-login.
async function loginRole(requestCtx) {
    const res = await requestCtx.post(`${BASE_URL}/api/auth/pin`, { data: { pin: PIN } });
    if (!res.ok()) throw new Error(`Login fejlede: ${res.status()}`);
}

async function addSeedItem(requestCtx) {
    await requestCtx.post(`${BASE_URL}/api/grocy/shopping-list/add-product`, {
        data: { product_id: SEED_PRODUCT.id, product_amount: 1, list_id: 1 },
    });
}

async function removeSeedItem(requestCtx) {
    // Fjern hele mængden igen (idempotent — fejl ignoreres)
    try {
        await requestCtx.post(`${BASE_URL}/api/grocy/shopping-list/remove-product`, {
            data: { product_id: SEED_PRODUCT.id, product_amount: 99, list_id: 1 },
        });
    } catch (e) { /* best-effort cleanup */ }
}

// Åbn indkøbssiden, logget ind, og vent på at indkob.js har renderet toolbaren.
async function gotoPurchasing(page) {
    await loginRole(page.request);
    await page.goto(PURCHASING_URL);
    // initIndkob renderer toolbaren når data er hentet
    await page.waitForSelector('.ib-toolbar', { timeout: 15000 });
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

test.describe('T_INDKOB_UI — Indkøbsliste frontend', () => {

    test.beforeAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        await loginRole(ctx);
        await addSeedItem(ctx);
        await ctx.dispose();
    });

    test.afterAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        await loginRole(ctx);
        await removeSeedItem(ctx);
        await ctx.dispose();
    });

    // T_INDKOB_UI_01: Siden mounter (auth + initIndkob) uden JS-fejl
    test('T_INDKOB_UI_01: siden mounter med toolbar og ingen uncaught fejl', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));

        await gotoPurchasing(page);

        // Vi blev IKKE redirectet til login (rolle-session holdt)
        expect(page.url()).toContain('purchasing.html');
        await expect(page.locator('.ib-toolbar')).toBeVisible();
        await expect(page.locator('.ib-search[data-ib="search"]')).toBeVisible();
        await expect(page.locator('[data-ib="add-product"]')).toBeVisible();
        expect(errors, `uncaught JS-fejl: ${errors.join(' | ')}`).toHaveLength(0);
    });

    // T_INDKOB_UI_02: Den seedede vare renderes som et varekort
    test('T_INDKOB_UI_02: seedet vare vises i listen', async ({ page }) => {
        await gotoPurchasing(page);
        const item = page.locator('.ib-item-name', { hasText: SEED_PRODUCT.name }).first();
        await expect(item).toBeVisible({ timeout: 10000 });
    });

    // T_INDKOB_UI_03: Søgefelt beholder fokus under debounced re-render
    // (regression: 6h-revision "Søgefelt-fokus-bug rettet")
    test('T_INDKOB_UI_03: søgefelt beholder fokus mens man skriver', async ({ page }) => {
        await gotoPurchasing(page);
        const search = page.locator('.ib-search[data-ib="search"]');
        await search.click();
        await search.type('Brød', { delay: 60 });   // udløser debounced re-render undervejs
        await page.waitForTimeout(400);              // lad debounce + re-render køre

        const isFocused = await page.evaluate(() => {
            const el = document.activeElement;
            return !!el && el.classList && el.classList.contains('ib-search');
        });
        expect(isFocused, 'søgefeltet mistede fokus efter re-render').toBe(true);
        await expect(search).toHaveValue('Brød');
    });

    // T_INDKOB_UI_04: Søgning filtrerer varer
    test('T_INDKOB_UI_04: søgning filtrerer listen', async ({ page }) => {
        await gotoPurchasing(page);
        const search = page.locator('.ib-search[data-ib="search"]');

        // Match: seedet vare synlig
        await search.fill('Brød');
        await page.waitForTimeout(400);
        await expect(page.locator('.ib-item-name', { hasText: SEED_PRODUCT.name }).first()).toBeVisible();

        // No-match: ingen varekort
        await search.fill('zzzqxnomatch');
        await page.waitForTimeout(400);
        await expect(page.locator('.ib-item')).toHaveCount(0);
    });

    // T_INDKOB_UI_05: View-toggle skifter gruppering + persisterer i localStorage
    // (regression: 6h-revision "én liste, to grupperinger")
    test('T_INDKOB_UI_05: view-toggle (kategori/leverandør) + persist', async ({ page }) => {
        await gotoPurchasing(page);

        // Skift til "Efter leverandør"
        await page.locator('[data-ib="view-order"]').click();
        await page.waitForTimeout(200);
        await expect(page.locator('[data-ib="view-order"]')).toHaveClass(/on/);
        let mode = await page.evaluate(() => localStorage.getItem('ib_view_mode'));
        expect(mode).toBe('order');

        // Skift til "Efter kategori"
        await page.locator('[data-ib="view-combined"]').click();
        await page.waitForTimeout(200);
        await expect(page.locator('[data-ib="view-combined"]')).toHaveClass(/on/);
        mode = await page.evaluate(() => localStorage.getItem('ib_view_mode'));
        expect(mode).toBe('combined');

        // Kategori-visning har kategori-headers
        await expect(page.locator('.ib-cmb-cat').first()).toBeVisible();
    });

    // T_INDKOB_UI_06: "+ Tilføj vare"-panel + Grocy-autocomplete
    test('T_INDKOB_UI_06: tilføj-vare-panel viser autocomplete-resultater', async ({ page }) => {
        await gotoPurchasing(page);

        await page.locator('[data-ib="add-product"]').click();
        const q = page.locator('#ibAddProdQ[data-ib="add-product-search"]');
        await expect(q).toBeVisible();

        await q.fill('Brød');
        // Autocomplete filtrerer _ibProducts client-side (ingen netværk)
        await expect(page.locator('.ib-add-ac-item').first()).toBeVisible({ timeout: 5000 });
    });
});
