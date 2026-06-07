// playwright.config.js
// ════════════════════════════════════════════════════════════
// Konfiguration for frontend UI-tests i tests/playwright/.
//
// Kør:
//   npm run test:ui            — alle UI-specs
//   npm run test:ui-indkob     — kun indkøbs-spec'en
//   npx playwright test <fil>  — enkelt fil
//
// Forudsætninger:
//   - @playwright/test + chromium installeret:
//       npm i -D @playwright/test && npx playwright install chromium
//   - .env.test peger på TEST-mål (NODE_ENV=test, test.db, grocytest)
//
// webServer starter test:server automatisk hvis den ikke allerede
// kører (reuseExistingServer lokalt). I CI startes en frisk server.
// ════════════════════════════════════════════════════════════

'use strict';

const { defineConfig } = require('@playwright/test');

const PORT = process.env.PORT || 4322;
const BASE_URL = process.env.TEST_SERVER_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
    testDir: './tests/playwright',
    timeout: 30000,
    expect: { timeout: 7000 },
    fullyParallel: false,   // deler test.db + grocytest — undgå races
    workers: 1,
    reporter: 'list',
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
    },
    webServer: {
        command: 'npm run test:server',
        url: `${BASE_URL}/api/statuses`,
        reuseExistingServer: !process.env.CI,
        timeout: 30000,
    },
});
