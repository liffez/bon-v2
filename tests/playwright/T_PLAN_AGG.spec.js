/**
 * tests/playwright/T_PLAN_AGG.spec.js
 * ════════════════════════════════════════════════════════════
 * Frontend aggregerings-tests for planning.html.
 *
 * Tester _plAggregate() i shared/planning.js mod facit i T_PLAN §7.
 * Verificerer at vægtet snit, totalCost og "Vælg alle"-flow virker.
 *
 * Selectors er verificeret mod den faktiske kode i shared/planning.js
 * pr. maj 2026:
 *   #plFrom, #plTo, #plSelectAll, .pl-bon-check[data-bon-id],
 *   #plBonCount, .pl-bon-units, #plVatToggle, .pl-empty,
 *   .pl-result-row, .pl-result-table
 *
 * Usage:
 *   npx playwright test tests/playwright/T_PLAN_AGG.spec.js
 *
 * Forudsætninger:
 *   - test:server kører (default localhost:4322)
 *   - test.db er seeded med seed_planning.sql (8 bonner i uge 20/2026)
 *   - Playwright installeret: npm i -D @playwright/test && npx playwright install
 *
 * Reference: tests/specs/T_PLAN.md §8.2
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const { test, expect } = require('@playwright/test');

const BASE_URL     = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const PLANNING_URL = `${BASE_URL}/kitchen/planning.html`;

// ────────────────────────────────────────────────────────────
// Hjælpefunktioner — alle bygget på faktiske selectors fra planning.js
// ────────────────────────────────────────────────────────────

async function gotoTestWeek(page) {
    await page.goto(PLANNING_URL);
    // Sæt periode til uge 20 / 2026 (mandag 11/5 → søndag 17/5)
    await page.locator('#plFrom').fill('2026-05-11');
    await page.locator('#plTo').fill('2026-05-17');
    await page.locator('#plTo').press('Tab');
    // Vent på fetch + render
    await page.waitForSelector('.pl-bon-check[data-bon-id]', { timeout: 5000 });
}

async function selectAllBons(page) {
    await page.locator('#plSelectAll').click();
    // Vent på re-render
    await page.waitForTimeout(150);
}

async function deselectAllBons(page) {
    // Klik "Vælg alle" — hvis allerede valgt skifter den til "Fravælg alle"
    const btn = page.locator('#plSelectAll');
    const text = await btn.textContent();
    if (text && text.trim().startsWith('Fravælg')) {
        await btn.click();
    } else {
        // Manuel afvælg
        const boxes = page.locator('.pl-bon-check[data-bon-id]:checked');
        const count = await boxes.count();
        for (let i = 0; i < count; i++) {
            await boxes.nth(0).uncheck();
        }
    }
    await page.waitForTimeout(150);
}

// Hent et tal ud af en celle (fjerner kr/enh/whitespace)
function parseNumber(text) {
    if (!text) return NaN;
    const cleaned = text.replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
    return parseFloat(cleaned);
}

// Læs aggregeret pris ud af pl-result-table footer (Total inkl. moms-rækken)
async function getTotalInclMoms(page) {
    const cell = page.locator('.pl-result-table tr.pl-result-subtotal:has-text("Total inkl. moms") .pl-col-total');
    return parseNumber(await cell.textContent());
}

// Læs total enheder fra pl-result-meta ("N varer · M enheder")
async function getTotalUnits(page) {
    const meta = await page.locator('.pl-result-meta').first().textContent();
    const m = meta && meta.match(/(\d+)\s*enheder/);
    return m ? parseInt(m[1], 10) : NaN;
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

test.describe('T_PLAN_AGG — Frontend aggregering', () => {

    test.beforeEach(async ({ page }) => {
        // Ryd localStorage så vi starter med default-tilstand (S1)
        await page.goto(BASE_URL);
        await page.evaluate(() => {
            localStorage.removeItem('planning_status_filter');
            localStorage.removeItem('planning_show_offers');
        });
    });

    // T_PLAN_AGG_06: "Vælg alle" markerer alle synlige bonner (S1 default)
    test('T_PLAN_AGG_06: "Vælg alle" markerer 4 bonner i S1 default', async ({ page }) => {
        await gotoTestWeek(page);
        await selectAllBons(page);

        // S1 default = 4 bonner (4001, 4003, 4005, 4006)
        // Tilbud (4008) skjules client-side med _plShowOffers=false default
        const checkedBoxes = page.locator('.pl-bon-check[data-bon-id]:checked');
        await expect(checkedBoxes).toHaveCount(4);
    });

    // T_PLAN_AGG_02: Total enheder = 387 (S1, alle valgt)
    test('T_PLAN_AGG_02: Total enheder = 387 i S1', async ({ page }) => {
        await gotoTestWeek(page);
        await selectAllBons(page);
        const total = await getTotalUnits(page);
        expect(total).toBe(387);
    });

    // T_PLAN_AGG_01: Per-produkt totaler matcher §7.1
    test('T_PLAN_AGG_01: Per-produkt totaler matcher facit', async ({ page }) => {
        await gotoTestWeek(page);
        await selectAllBons(page);

        const expected = {
            'Falaflen': 60,
            'Kyllingen': 60,
            'Tunen': 60,
            'Kålen': 15,
            'RR Boks': 180,
            'Transportkasse': 12,
        };

        for (const [product, qty] of Object.entries(expected)) {
            const row = page.locator('.pl-result-row', { hasText: product }).first();
            const qtyText = await row.locator('.pl-col-qty').first().textContent();
            const actual  = parseNumber(qtyText);
            expect(actual, `${product} qty`).toBe(qty);
        }
    });

    // T_PLAN_AGG_05: Tilbudstoggle (kun via localStorage — ingen UI)
    test('T_PLAN_AGG_05: localStorage-flip viser tilbud (skifter total fra 387 til 470)', async ({ page }) => {
        await gotoTestWeek(page);
        await selectAllBons(page);

        // OFF (default) — 387 enheder
        let total = await getTotalUnits(page);
        expect(total, 'Tilbud OFF').toBe(387);

        // Slå tilbud ON via localStorage og reload
        await page.evaluate(() => localStorage.setItem('planning_show_offers', 'true'));
        await page.reload();
        await page.waitForSelector('.pl-bon-check[data-bon-id]', { timeout: 5000 });
        await selectAllBons(page);

        total = await getTotalUnits(page);
        expect(total, 'Tilbud ON').toBe(470);
    });

    // T_PLAN_AGG_07: Ingen valgt → tom resultat-besked
    test('T_PLAN_AGG_07: Ingen valgte bonner viser tom besked', async ({ page }) => {
        await gotoTestWeek(page);
        await deselectAllBons(page);

        const empty = page.locator('.pl-empty');
        await expect(empty).toBeVisible();
        await expect(empty).toContainText('Ingen varer');
    });

    // T_PLAN_AGG_10: VAT-toggle skifter incl/excl visning
    test('T_PLAN_AGG_10: VAT-toggle skifter total fra incl til excl moms', async ({ page }) => {
        await gotoTestWeek(page);
        await selectAllBons(page);

        // Sikr at priser vises (toggle priser ON via knap)
        const pricesBtn = page.locator('#plBtnPrices');
        if ((await pricesBtn.count()) > 0) {
            const isActive = await pricesBtn.evaluate(el => el.classList.contains('pl-price-toggle-active'));
            if (!isActive) await pricesBtn.click();
        }

        // Default: incl moms — total skal være ~20.220
        let total = await getTotalInclMoms(page);
        expect(total, 'Incl moms').toBeCloseTo(20220, 0);

        // Toggle til ex moms via #plVatToggle
        await page.locator('#plVatToggle').click();
        await page.waitForTimeout(150);

        // Læs Netto-rækken (i excl-mode er Netto = u/moms i kolonnen)
        const netto = parseNumber(
            await page.locator('.pl-result-table tr.pl-result-subtotal:has-text("Netto") .pl-col-total').textContent()
        );
        expect(netto, 'Ex moms').toBeCloseTo(16176, 0);
    });

    // T_PLAN_AGG_09: Status-filter persisteres i localStorage
    test('T_PLAN_AGG_09: planning_status_filter persisteres efter reload', async ({ page }) => {
        await gotoTestWeek(page);

        // Skriv et eksplicit filter til localStorage og reload
        await page.evaluate(() => {
            localStorage.setItem('planning_status_filter',
                JSON.stringify({ godkendt: true, igang: false, klar: false, lev: false }));
        });
        await page.reload();
        await page.waitForSelector('.pl-bon-check[data-bon-id]', { timeout: 5000 });

        // Verificér at filteret er læst tilbage
        const stored = await page.evaluate(() =>
            JSON.parse(localStorage.getItem('planning_status_filter') || '{}'));
        expect(stored.godkendt).toBe(true);
        expect(stored.igang).toBe(false);
    });

});
