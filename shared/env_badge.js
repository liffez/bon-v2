/**
 * shared/env_badge.js
 * ════════════════════════════════════════════════════════════
 * Lille fixed badge i øverste højre hjørne der viser hvilket
 * miljø (LOCAL / PROD) du kigger på. Forhindrer forveksling
 * mellem lokal udvikling og deployed Hetzner-instans.
 *
 * Detektion (klient-side, ingen backend-call):
 *   - hostname starter med "localhost" eller "127." → LOCAL
 *   - alt andet                                     → PROD
 *
 * Override: <meta name="bon-env" content="staging"> i HTML'en.
 * ════════════════════════════════════════════════════════════
 */

(function () {
    function detectEnv() {
        // Eksplicit override via meta-tag
        const meta = document.querySelector('meta[name="bon-env"]');
        if (meta && meta.content) return meta.content.trim().toLowerCase();

        const h = (location.hostname || '').toLowerCase();
        if (h === 'localhost' || h.startsWith('127.') || h === '0.0.0.0' || h.endsWith('.local')) {
            return 'local';
        }
        return 'prod';
    }

    function envLabel(env) {
        return env.toUpperCase();
    }

    function envColors(env) {
        switch (env) {
            case 'local':   return { bg: '#1f8b4c', fg: '#fff' };  // grøn — trygt at lege
            case 'prod':    return { bg: '#c0392b', fg: '#fff' };  // rød — pas på
            case 'staging': return { bg: '#7a6f5f', fg: '#fff' };  // grå-brun
            default:        return { bg: '#555',    fg: '#fff' };
        }
    }

    function injectBadge() {
        if (document.getElementById('bon-env-badge')) return;  // idempotent

        const env = detectEnv();
        const { bg, fg } = envColors(env);
        const label = envLabel(env);

        // Prefix document.title så det er synligt i fane og taskbar
        if (!document.title.startsWith('[' + label + ']')) {
            document.title = '[' + label + '] ' + document.title;
        }

        const el = document.createElement('div');
        el.id = 'bon-env-badge';
        el.textContent = label;
        el.title = 'Bon v2 kører på ' + location.host + ' (' + env + ')';
        el.style.cssText = [
            'position:fixed',
            'top:6px',
            'right:8px',
            'z-index:99999',
            'padding:2px 8px',
            'background:' + bg,
            'color:' + fg,
            'font:600 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
            'letter-spacing:0.5px',
            'border-radius:3px',
            'box-shadow:0 1px 3px rgba(0,0,0,0.25)',
            'pointer-events:auto',
            'cursor:default',
            'user-select:none',
            'opacity:0.85'
        ].join(';');

        document.body.appendChild(el);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectBadge, { once: true });
    } else {
        injectBadge();
    }
})();
