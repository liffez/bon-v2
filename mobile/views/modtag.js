/**
 * mobile/views/modtag.js
 * ════════════════════════════════════════════════════════════
 * Varemodtagelse wrapper — monterer shared/varemodtagelse.js.
 * ════════════════════════════════════════════════════════════
 */

async function initMobileModtag(container) {
    // Auth er allerede tjekket i shell — initVaremodtagelse's interne
    // checkAuth() finder den gyldige session og returnerer uden redirect.
    await initVaremodtagelse(container);
}
