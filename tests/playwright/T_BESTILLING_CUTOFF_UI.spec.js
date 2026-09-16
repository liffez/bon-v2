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

test('"Skriv til os direkte" bærer det kunden allerede har udfyldt', async ({ page }) => {
    // Kunden har tastet hele bestillingen FØR deadline-notitsen rammer. En
    // mailto uden body ville bede hende taste alt om igen — og mailen ville
    // lande i bon@ uden navn, dato og antal.
    await page.locator('#first_name').fill('Anne');
    await page.locator('#last_name').fill('Hansen');
    await page.locator('#email').fill('anne@firma.dk');
    await page.locator('#phone').fill('12 34 56 78');
    await page.locator('#company').fill('Firma ApS');
    await page.locator('#pax').fill('25');
    await page.locator('#wishes').fill('3× Kyllingen\n2× Falaflen');
    await page.locator('#address-input').fill('Vestergade 1, 1456 København K');

    await page.locator('#date-input').fill(forSent());
    await expect(page.locator('#cutoff-notice')).toContainText('Deadline passeret');

    // href læses via getAttribute: det er dét HTML-parseren har lavet ud af
    // attributten, altså præcis hvad mailklienten får.
    const href = await page.locator('#cutoff-notice a').getAttribute('href');
    expect(href.startsWith('mailto:bon@ristetrug.dk?'), href.slice(0, 60)).toBe(true);

    const body = new URL(href).searchParams.get('body');
    expect(body).toContain('Navn: Anne Hansen');
    expect(body).toContain('E-mail: anne@firma.dk');
    expect(body).toContain('Telefon: 12 34 56 78');
    expect(body).toContain('Firma: Firma ApS');
    expect(body).toContain('Antal gæster: 25');
    expect(body).toContain('Adresse: Vestergade 1, 1456 København K');
    expect(body).toContain('3× Kyllingen');
    expect(body).toContain(`(${forSent()})`);          // ISO-datoen kontoret slår op på
    expect(body.trimEnd().endsWith('Anne Hansen')).toBe(true);
});
