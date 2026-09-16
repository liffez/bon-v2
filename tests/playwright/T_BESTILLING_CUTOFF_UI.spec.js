// tests/playwright/T_BESTILLING_CUTOFF_UI.spec.js
// ════════════════════════════════════════════════════════════
// Deadline i selve bestillingsformularen.
//
// Fejlen der gjorde spec'en nødvendig: `checkCutoff` er bundet til ÉT event —
// `change` på datofeltet — og aflæser klokken dér. Er datoen valgt før kl. 12
// og formularen sendt om aftenen, blev der aldrig tjekket igen; knappens
// `disabled`-attribut var hele værnet, og den var sat på et forældet tidspunkt.
//
// Logik-tests kan ikke se det: hullet ER at et event ikke fyrer. Derfor
// browseren. Scenariet genskabes ved at sætte datofeltets værdi UDEN at
// udløse `change` — nøjagtig den tilstand en side har stået i siden formiddagen.
//
// Kør lokalt (ikke på serveren — Chromium hører ikke til i drift):
//   npx playwright test T_BESTILLING_CUTOFF_UI
// ════════════════════════════════════════════════════════════

const { test, expect } = require('@playwright/test');

const FORM = '/embed/bestilling';

// Dato hvis deadline med sikkerhed er passeret (deadline lå mindst i går kl. 12).
const forSent = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' }).format(new Date());

/** Sæt datofeltet som en side der HAR stået åben: værdi uden `change`. */
async function setDateSilently(page, iso) {
    await page.evaluate((v) => {
        document.getElementById('date-input').value = v;
    }, iso);
}

test.beforeEach(async ({ page }) => {
    await page.goto(FORM);
    await page.waitForFunction(() => !document.getElementById('cutoff-note')?.textContent.includes('Henter'));
});

test('en side der har stået åben kan ikke sende en for sen bestilling', async ({ page }) => {
    // Ingen `change` — knappen er derfor stadig aktiv, præcis som i drift.
    await setDateSilently(page, forSent());
    await expect(page.locator('#submit-btn')).toBeEnabled();

    let sendt = false;
    await page.route('**/webhook/bestilling', route => { sendt = true; route.abort(); });

    await page.locator('#submit-btn').click();

    await expect(page.locator('#cutoff-notice')).toContainText('Deadline passeret');
    expect(sendt, 'bestillingen må ikke være sendt').toBe(false);
    await expect(page.locator('#submit-btn')).toBeDisabled();
});

test('deadline vises stadig når datoen vælges på normal vis', async ({ page }) => {
    await page.locator('#date-input').fill(forSent());
    await expect(page.locator('#cutoff-notice')).toContainText('Deadline passeret');
    await expect(page.locator('#submit-btn')).toBeDisabled();
});

test('serverens afvisning vises for kunden i stedet for en generisk fejl', async ({ page }) => {
    // Sådan ser det ud når browseren har en forældet opfattelse af reglen —
    // eller når nogen sender uden om formularen: serveren siger nej, og
    // beskeden skal frem sammen med mailto-udvejen.
    await page.route('**/webhook/bestilling', route => route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, code: 'cutoff_passed', message: 'Deadline for levering var i går kl. 12:00.' }),
    }));

    await page.evaluate(() => {
        // Spring klientens egne tjek over — vi tester visningen af serverens svar.
        window.validateForm = () => true;
        document.getElementById('order-form').dispatchEvent(new Event('submit', { cancelable: true }));
    });

    const fejl = page.locator('#webhook-error');
    await expect(fejl).toBeVisible();
    await expect(fejl).toContainText('Bestillingen kunne ikke modtages');
    await expect(fejl).toContainText('Deadline for levering var i går kl. 12:00.');
    await expect(fejl.locator('a[href^="mailto:"]')).toHaveCount(1);
});
