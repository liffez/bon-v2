/**
 * Zone Switcher — viser links til andre zoner baseret på brugerens rolle.
 *
 * Brug:
 *   <script src="/shared/zone_switcher.js"></script>
 *   renderZoneSwitcher('kitchen', currentUser.role, document.querySelector('.topbar'));
 */

(function() {
    // Inject styles once
    const style = document.createElement('style');
    style.textContent = `
        /* ── Zone Switcher — topbar variant (mørk baggrund) ── */
        .zone-switcher--topbar {
            display: flex;
            gap: 6px;
            margin-left: 12px;
        }
        .zone-switcher--topbar .zone-switcher__link {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 600;
            color: rgba(255,255,255,0.85);
            background: rgba(255,255,255,0.1);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            text-decoration: none;
            transition: background 0.15s, color 0.15s;
            white-space: nowrap;
        }
        .zone-switcher--topbar .zone-switcher__link:hover {
            background: rgba(255,255,255,0.18);
            color: #fff;
        }

        /* ── Zone Switcher — sidebar variant ────────────────── */
        .zone-switcher--sidebar {
            display: flex;
            flex-direction: column;
            gap: 2px;
            padding: 0 8px;
            margin-bottom: 8px;
        }
        .zone-switcher--sidebar .zone-switcher__link {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 12px;
            font-size: 13px;
            font-weight: 500;
            color: rgba(255,255,255,0.8);
            background: rgba(255,255,255,0.06);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 6px;
            text-decoration: none;
            transition: background 0.15s, color 0.15s;
        }
        .zone-switcher--sidebar .zone-switcher__link:hover {
            background: rgba(255,255,255,0.12);
            color: #fff;
        }
    `;
    document.head.appendChild(style);
})();

function getAccessibleZones(role) {
    if (role === 'admin')  return ['kitchen', 'office', 'settings'];
    if (role === 'office') return ['kitchen', 'office'];
    return [role || 'kitchen'];
}

const ZONE_META = {
    kitchen:  { label: 'Køkken',       href: '/kitchen/',    icon: '🍳' },
    office:   { label: 'Office',        href: '/office/',     icon: '💼' },
    settings: { label: 'Indstillinger', href: '/settings/',   icon: '⚙' }
};

/**
 * Renderer zone-switch links i en container.
 * @param {string} currentZone  - 'kitchen' | 'office' | 'settings'
 * @param {string} userRole     - brugerens rolle fra /api/auth/me
 * @param {HTMLElement} container - element at appende links til
 * @param {object} [opts]       - { style: 'topbar' | 'sidebar' }
 */
function renderZoneSwitcher(currentZone, userRole, container, opts = {}) {
    if (!container) return;

    const zones = getAccessibleZones(userRole);
    const otherZones = zones.filter(z => z !== currentZone);
    if (otherZones.length === 0) return;

    const style = opts.style || 'topbar';

    const wrap = document.createElement('div');
    wrap.className = 'zone-switcher zone-switcher--' + style;

    otherZones.forEach(zone => {
        const meta = ZONE_META[zone];
        if (!meta) return;
        const a = document.createElement('a');
        a.href = meta.href;
        a.className = 'zone-switcher__link';
        a.title = meta.label;
        a.textContent = meta.icon + ' ' + meta.label;
        wrap.appendChild(a);
    });

    container.appendChild(wrap);
}
