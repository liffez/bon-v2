/**
 * tests/playwright/T_OPTAELLING_UI.spec.js
 * ════════════════════════════════════════════════════════════
 * Frontend UI-tests for lageroptællingen (shared/inventory_check.js
 * på kitchen/stock.html, fanen "Optælling").
 *
 * Hvorfor denne spec findes: run_T_OPTAELLING.js dækker beslutnings-
 * logikken med 112 asserts uden browser — men den kan per definition
 * ikke se layout. To fejl slap igennem den og blev først fundet i
 * drift/manuel test:
 *
 *   - ⋯-menuen blev klippet af kortets egen overflow:hidden, så
 *     "Varen findes ikke mere" var halvt usynlig og uklikbar.
 *   - En søgning der kun ramte en sprunget vare viste "Ingen varer
 *     matcher", fordi tom-tilstanden overskrev de allerede tilføjede
 *     kort.
 *
 * Begge er render-fejl. Denne spec kører mod den rigtige side i en
 * rigtig browser og asserterer det unit-testene ikke kan se: at
 * elementer faktisk er synlige, klikbare og ikke dækket af naboer.
 *
 * Selectors er verificeret mod shared/inventory_check.js pr. juli 2026:
 *   #inventoryCheckContainer, #icLocSelect, #icUnitSelect, #icStartBtn,
 *   .ic-unit-chip(.ic-active), .ic-unit-chip-count, .ic-card,
 *   .ic-card-info, .ic-card-name, [data-action="more"|"skip"|"unskip"],
 *   [data-menu].ic-visible, .ic-card-note, .mf-input, .mf-field,
 *   .mf-multi, .ic-mf-sum, .ic-qty-confirm  (mængdefelterne, #665),
 *   .ic-search-empty, #icSearch, #icReceipt, #icProgText
 *
 * Usage:
 *   npx playwright test tests/playwright/T_OPTAELLING_UI.spec.js
 *
 * Forudsætninger:
 *   - test:server kører (default localhost:4322) mod grocytest
 *   - Køkken-rolle med PIN 1234 findes i test.db (seed)
 *   - Playwright + chromium installeret:
 *       npm i -D @playwright/test && npx playwright install chromium
 *
 * Spec'en opretter to fysiske enheder (T_OPT-1 / T_OPT-2) på den
 * Grocy-lokation der har flest produkter, og arkiverer dem igen
 * bagefter. Den SKRIVER ALDRIG til Grocy — der trykkes aldrig
 * "Gem og luk", så optællingen lever kun i localStorage.
 *
 * Reference: tests/specs/T_OPTAELLING.md · docs/CLAUDE_OPTAELLING.md
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const { test, expect } = require('@playwright/test');

const BASE_URL  = process.env.TEST_SERVER_URL || `http://localhost:${process.env.PORT || 4322}`;
const STOCK_URL = `${BASE_URL}/kitchen/stock.html`;
const PIN       = process.env.TEST_PIN || '1234';

const UNIT_A = 'T_OPT-1';
const UNIT_B = 'T_OPT-2';

// Fyldes i beforeAll: lokationen med flest produkter + de oprettede enheder.
let LOCATION_ID = null;
let createdUnitIds = [];

// ────────────────────────────────────────────────────────────
// Hjælpere
// ────────────────────────────────────────────────────────────

async function loginRole(requestCtx) {
    const res = await requestCtx.post(`${BASE_URL}/api/auth/pin`, { data: { pin: PIN } });
    if (!res.ok()) throw new Error(`Login fejlede: ${res.status()}`);
}

// Vælg den lokation der har flest produkter — hardkodede id'er ville
// binde spec'en til et bestemt grocytest-øjebliksbillede.
async function pickBusiestLocation(requestCtx) {
    const res = await requestCtx.get(`${BASE_URL}/api/grocy/products`);
    if (!res.ok()) throw new Error(`Kunne ikke hente produkter: ${res.status()}`);
    const counts = new Map();
    for (const p of await res.json()) {
        const active = p.active === 1 || p.active === '1' || p.active === true;
        const loc = parseInt(p.location_id);
        if (!active || !loc) continue;
        counts.set(loc, (counts.get(loc) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [loc, n] of counts) if (n > bestN) { best = loc; bestN = n; }
    if (!best) throw new Error('Ingen aktive produkter med location_id i grocytest');
    return best;
}

async function createUnits(requestCtx) {
    for (const name of [UNIT_A, UNIT_B]) {
        const res = await requestCtx.post(`${BASE_URL}/api/physical-units`, {
            data: { grocy_location_id: LOCATION_ID, name },
        });
        if (res.ok()) createdUnitIds.push((await res.json()).id);
    }
}

// Arkivér igen (der findes ingen DELETE — PATCH archived:true er vejen).
async function archiveUnits(requestCtx) {
    for (const id of createdUnitIds) {
        try {
            await requestCtx.patch(`${BASE_URL}/api/physical-units/${id}`, { data: { archived: true } });
        } catch (e) { /* best-effort cleanup */ }
    }
    createdUnitIds = [];
}

// Åbn Optælling-fanen og start en optælling i UNIT_A.
// Rydder localStorage først, så hver test begynder på en tom session.
async function startCount(page) {
    await loginRole(page.request);
    await page.goto(STOCK_URL);

    await page.evaluate(() => {
        Object.keys(localStorage)
            .filter(k => k.indexOf('ic_') === 0)
            .forEach(k => localStorage.removeItem(k));
    });
    await page.goto(STOCK_URL);

    await page.click('a:has-text("Optælling")');
    await page.waitForSelector('#icLocSelect', { timeout: 15000 });

    await page.selectOption('#icLocSelect', String(LOCATION_ID));
    await page.waitForFunction(
        () => document.querySelectorAll('#icUnitSelect option').length > 1,
        null, { timeout: 15000 }
    );
    await page.selectOption('#icUnitSelect', UNIT_A);
    await page.click('#icStartBtn');

    // Kortene er bygget når mindst ét er i DOM'en
    await page.waitForSelector('.ic-card', { timeout: 20000 });
}

// Navnet på et kort (uden prioritets-ikon og badges)
function cardName(card) {
    return card.locator('.ic-card-name').innerText();
}

// Kun selve produktnavnet. .ic-card-name indeholder også prioritets-knappen
// og badges ("Udløbet", ⏰, ⏳) som elementer — navnet er de rene tekst-noder
// imellem dem. innerText ville give "Cherry Tomater Udløbet", som ikke er
// noget man kan søge efter.
function bareName(card) {
    return card.locator('.ic-card-name').evaluate(el =>
        Array.from(el.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent)
            .join(' ')
            .trim()
    );
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

test.describe('T_OPTAELLING_UI — Optælling frontend', () => {

    test.beforeAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        await loginRole(ctx);
        LOCATION_ID = await pickBusiestLocation(ctx);
        await createUnits(ctx);
        await ctx.dispose();
    });

    test.afterAll(async ({ playwright }) => {
        const ctx = await playwright.request.newContext();
        await loginRole(ctx);
        await archiveUnits(ctx);
        await ctx.dispose();
    });

    // ── 01: siden mounter overhovedet ────────────────────────
    test('T_OPT_UI_01: optællingen mounter med enheds-chips og kort', async ({ page }) => {
        const fejl = [];
        page.on('pageerror', e => fejl.push(e.message));

        await startCount(page);

        const chips = page.locator('.ic-unit-chip');
        await expect(chips).toHaveCount(2);
        await expect(page.locator('.ic-unit-chip.ic-active')).toHaveText(new RegExp(UNIT_A));
        expect(await page.locator('.ic-card').count()).toBeGreaterThan(0);
        expect(fejl, 'ingen uncaught JS-fejl').toEqual([]);
    });

    // ── 02: ⋯-menuen må ikke klippes af kortet ───────────────
    // Den fejl der motiverede hele spec'en. Kortet har overflow:hidden
    // for de runde hjørner; uden .ic-menu-open blev menuen skåret over.
    test('T_OPT_UI_02: ⋯-menuen er fuldt synlig og klikbar, ikke klippet', async ({ page }) => {
        await startCount(page);

        // Et kort MIDT i listen — det kritiske tilfælde, hvor kortet
        // nedenunder ellers tegner ovenpå menuen.
        const card = page.locator('.ic-card').nth(2);
        await card.locator('[data-action="more"]').click();

        const menu = card.locator('[data-menu]');
        await expect(menu).toHaveClass(/ic-visible/);
        await expect(card).toHaveClass(/ic-menu-open/);

        // Klipning slås fra mens menuen er åben
        expect(await card.evaluate(el => getComputedStyle(el).overflow)).toBe('visible');

        // Begge valg skal være hit-testbare: elementFromPoint på midten
        // skal ramme knappen selv — ikke et kort der ligger ovenpå.
        const items = menu.locator('button');
        await expect(items).toHaveCount(2);
        for (let i = 0; i < 2; i++) {
            const btn = items.nth(i);
            await expect(btn).toBeVisible();
            const rammer = await btn.evaluate(el => {
                const r = el.getBoundingClientRect();
                const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return el === top || el.contains(top);
            });
            expect(rammer, `menupunkt ${i} er dækket af et andet element`).toBe(true);
        }

        // Menuen stikker ud under kortet — det er netop det overflow:hidden
        // forhindrede, så assertionen fanger en tilbagerulning af fixet.
        const stikkerUd = await card.evaluate(el => {
            const m = el.querySelector('[data-menu]');
            return m.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
        });
        expect(stikkerUd, 'menuen skal kunne rage ud over kortet').toBeGreaterThan(0);
    });

    // ── 03: klik udenfor lukker menuen igen ──────────────────
    test('T_OPT_UI_03: klik udenfor lukker menuen og fjerner ic-menu-open', async ({ page }) => {
        await startCount(page);

        const card = page.locator('.ic-card').nth(2);
        await card.locator('[data-action="more"]').click();
        await expect(card).toHaveClass(/ic-menu-open/);

        await page.locator('#icProgText').click();

        await expect(card.locator('[data-menu]')).not.toHaveClass(/ic-visible/);
        await expect(card).not.toHaveClass(/ic-menu-open/);
        // Klipningen skal være tilbage, ellers lækker et åbent-layout
        expect(await card.evaluate(el => getComputedStyle(el).overflow)).toBe('hidden');
    });

    // ── 04: enheds-chips bevarer tællingen ───────────────────
    test('T_OPT_UI_04: skift af enhed bevarer tællingen pr. enhed', async ({ page }) => {
        await startCount(page);

        const card = page.locator('.ic-card').first();
        const navn = await cardName(card);
        const pid  = await card.getAttribute('data-product-id');

        await card.locator('.ic-card-info').click();
        // Første felt er lager-enheden når intet er husket (§14.3)
        await card.locator('.mf-input').first().fill('3');
        await card.locator('.ic-qty-confirm').click();

        // Chippen for den aktive enhed får en tæller
        await expect(page.locator('.ic-unit-chip.ic-active .ic-unit-chip-count')).toHaveText('1');

        // Skift til den anden enhed — tællingen må ikke følge med
        await page.locator('.ic-unit-chip', { hasText: UNIT_B }).click();
        await expect(page.locator('.ic-unit-chip.ic-active')).toHaveText(new RegExp(UNIT_B));

        const gemt = await page.evaluate((k) => {
            const raw = localStorage.getItem('ic_counts_' + k.loc);
            return raw ? JSON.parse(raw).counts[k.pid] : null;
        }, { loc: LOCATION_ID, pid });

        expect(gemt, `tælling for ${navn} skal være gemt`).toBeTruthy();
        expect(gemt.units[UNIT_A]).toBe(3);
        expect(gemt.units[UNIT_B]).toBeUndefined();
        expect(gemt.total).toBe(3);

        // Tilbage igen: tallet står der stadig
        await page.locator('.ic-unit-chip', { hasText: UNIT_A }).click();
        await expect(page.locator('.ic-unit-chip.ic-active')).toHaveText(new RegExp(UNIT_A));
    });

    // ── 05: spring over dæmper kortet i stedet for at skjule det ──
    test('T_OPT_UI_05: sprunget vare bliver stående med Fortryd', async ({ page }) => {
        await startCount(page);

        const card = page.locator('.ic-card').first();
        const navn = await cardName(card);

        await card.locator('[data-action="skip"]').click();

        // Kortet findes stadig — nu dæmpet, med en note og en Fortryd
        const sprunget = page.locator('.ic-card.ic-skipped').first();
        await expect(sprunget).toBeVisible();
        await expect(sprunget.locator('.ic-card-note')).toContainText('Sprunget over i ' + UNIT_A);
        await expect(sprunget.locator('[data-action="unskip"]')).toBeVisible();
        // ✓/⏭ er væk mens den er sprunget over
        await expect(sprunget.locator('[data-action="skip"]')).toHaveCount(0);

        // Progress lyver ikke: sprungne tælles ikke som tjekket
        await expect(page.locator('#icProgText')).toContainText('1 sprunget over');
        await expect(page.locator('#icProgText')).toContainText('0 / ');

        // Fortryd bringer den tilbage
        await sprunget.locator('[data-action="unskip"]').click();
        await expect(page.locator('.ic-card.ic-skipped')).toHaveCount(0);
        await expect(page.locator('#icProgText')).not.toContainText('sprunget over');
        expect(await cardName(page.locator('.ic-card').first())).toBe(navn);
    });

    // ── 06: søgning må ikke skjule en sprunget vare ──────────
    // Anden fejl unit-testene ikke kunne se: tom-tilstanden overskrev
    // de allerede indsatte sprungne kort med "Ingen varer matcher".
    test('T_OPT_UI_06: søgning finder en sprunget vare', async ({ page }) => {
        await startCount(page);

        const card = page.locator('.ic-card').first();
        const navn = await bareName(card);
        expect(navn.length, 'kunne ikke udlede produktnavn').toBeGreaterThan(1);

        await card.locator('[data-action="skip"]').click();
        await expect(page.locator('.ic-card.ic-skipped')).toHaveCount(1);

        await page.fill('#icSearch', navn);

        // Varen skal stadig kunne findes — og Fortryd skal være inden for rækkevidde
        await expect(page.locator('.ic-card.ic-skipped')).toHaveCount(1);
        await expect(page.locator('.ic-search-empty')).toHaveCount(0);
        await expect(page.locator('.ic-card.ic-skipped [data-action="unskip"]')).toBeVisible();

        // Et navn der ikke findes SKAL derimod give tom-tilstanden
        await page.fill('#icSearch', 'zzzqqqxyz');
        await expect(page.locator('.ic-search-empty')).toHaveCount(1);
        await expect(page.locator('.ic-card')).toHaveCount(0);
    });

    // ── 07: flere enheder på én gang (§14.6, #665) ──────────
    // Det logik-testene ikke kan se: at felterne faktisk står på ÉN linje, at
    // summen vises i lager-enhed, og at det tastede gemmes som poster.
    test('T_OPT_UI_07: tæl i flere enheder — summen i lager-enhed, poster gemt', async ({ page }) => {
        await startCount(page);

        const card = page.locator('.ic-card').filter({ has: page.locator('.mf-multi') }).first();
        if (await card.count() === 0) {
            test.skip(true, 'ingen produkter med mere end én tællbar enhed i grocytest');
        }
        const pid = await card.getAttribute('data-product-id');

        await card.locator('.ic-card-info').click();
        const felter = card.locator('.mf-field');
        expect(await felter.count()).toBeGreaterThan(1);

        // Brøkknapperne er væk
        await expect(card.locator('.ic-fraction-btn')).toHaveCount(0);

        // Felterne står på én linje — ellers er de tre felter tre rækker
        const y0 = (await felter.nth(0).boundingBox()).y;
        const y1 = (await felter.nth(1).boundingBox()).y;
        expect(Math.abs(y0 - y1)).toBeLessThan(4);

        // Ryd lager-feltet, tast 2,5 i det næste
        await felter.nth(0).locator('.mf-input').fill('');
        // Dansk komma: et type=number-felt ville give et TOMT value her
        await felter.nth(1).locator('.mf-input').fill('2,5');
        await expect(card.locator('.ic-mf-sum')).toContainText('=');

        await card.locator('.ic-qty-confirm').click();

        const gemt = await page.evaluate((k) => {
            const raw = localStorage.getItem('ic_counts_' + k.loc);
            return raw ? JSON.parse(raw).counts[k.pid] : null;
        }, { loc: LOCATION_ID, pid });
        expect(gemt, 'tællingen skal være gemt').toBeTruthy();
        const poster = gemt.entries[UNIT_A];
        expect(poster.length).toBe(1);
        expect(poster[0].qty).toBe(2.5);
        expect(poster[0].factor_used).toBeGreaterThan(0);
        // Tallet der skrives er summen i lager-enhed, ikke "2,5"
        expect(gemt.units[UNIT_A]).toBeCloseTo(2.5 * poster[0].factor_used, 2);
    });

    // ── 08: kvitteringen ryddes når en ny optælling starter ──
    test('T_OPT_UI_08: kvittering fra sidste optælling ryddes ved ny start', async ({ page }) => {
        await loginRole(page.request);
        await page.goto(STOCK_URL);

        await page.evaluate(() => {
            Object.keys(localStorage).filter(k => k.indexOf('ic_') === 0)
                .forEach(k => localStorage.removeItem(k));
            localStorage.setItem('ic_receipt', JSON.stringify({
                text: 'Gemt. GAMMEL kvittering.', at: new Date().toISOString(),
            }));
        });
        await page.goto(STOCK_URL);
        await page.click('a:has-text("Optælling")');
        await page.waitForSelector('#icLocSelect', { timeout: 15000 });

        // Før start: kvitteringen står der
        await expect(page.locator('#icReceipt')).toHaveClass(/ic-visible/);
        await expect(page.locator('#icReceiptText')).toContainText('GAMMEL');

        await page.selectOption('#icLocSelect', String(LOCATION_ID));
        await page.waitForFunction(
            () => document.querySelectorAll('#icUnitSelect option').length > 1,
            null, { timeout: 15000 }
        );
        await page.selectOption('#icUnitSelect', UNIT_A);
        await page.click('#icStartBtn');
        await page.waitForSelector('.ic-card', { timeout: 20000 });

        // Efter start: væk, så den ikke ligner en kvittering for det
        // man er i gang med
        await expect(page.locator('#icReceipt')).not.toHaveClass(/ic-visible/);
        expect(await page.evaluate(() => localStorage.getItem('ic_receipt'))).toBeNull();
    });
});
