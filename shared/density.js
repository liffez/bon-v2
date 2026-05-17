/**
 * shared/density.js
 * ════════════════════════════════════════════════════════════
 * Per-device visningstæthed. Gemmes i localStorage, gælder
 * zone-kitchen og zone-office (mobile er ekskluderet).
 * Skal initialiseres FØR første render via Density.init().
 * ════════════════════════════════════════════════════════════
 */

(function() {
    'use strict';

    const STORAGE_KEY = 'bon_v2_density';
    const VALID_MODES = ['comfort', 'compact', 'dense'];
    const DEFAULT_MODE = 'comfort';
    const AUTO_COMPACT_BREAKPOINT = 1366;

    function readStored() {
        try {
            const v = localStorage.getItem(STORAGE_KEY);
            return VALID_MODES.includes(v) ? v : null;
        } catch (e) {
            return null;
        }
    }

    function autoMode() {
        return (window.innerWidth <= AUTO_COMPACT_BREAKPOINT) ? 'compact' : DEFAULT_MODE;
    }

    const Density = {
        init() {
            const stored = readStored();
            const mode = stored || autoMode();
            this._applyToBody(mode);
        },

        set(mode) {
            if (!VALID_MODES.includes(mode)) return;
            try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) {}
            this._applyToBody(mode);
            document.dispatchEvent(new CustomEvent('density:change', { detail: { mode } }));
        },

        reset() {
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
            this.init();
            document.dispatchEvent(new CustomEvent('density:change', { detail: { mode: this.current() } }));
        },

        current() {
            return readStored() || autoMode();
        },

        hasExplicitChoice() {
            return readStored() !== null;
        },

        _applyToBody(mode) {
            const body = document.body;
            if (!body) return;
            VALID_MODES.forEach(m => body.classList.remove('density-' + m));
            body.classList.add('density-' + mode);
        }
    };

    window.Density = Density;

    // Auto-init: anvend på <html> straks (mod first-paint flash),
    // og på <body> så snart den er parset.
    function applyToHtml(mode) {
        const html = document.documentElement;
        if (!html) return;
        VALID_MODES.forEach(m => html.classList.remove('density-' + m));
        html.classList.add('density-' + mode);
    }

    const initialMode = Density.current();
    applyToHtml(initialMode);

    if (document.body) {
        Density._applyToBody(initialMode);
    } else {
        document.addEventListener('DOMContentLoaded', function() {
            Density._applyToBody(Density.current());
        });
    }
})();
