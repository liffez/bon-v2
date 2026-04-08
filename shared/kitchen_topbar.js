/**
 * Shared Kitchen Topbar — renderKitchenTopbar(container, opts)
 *
 * Bygger topbar, bestemmer aktiv-link fra URL, kalder zone-switcher internt.
 * Kræver: shared/zone_switcher.js loaded først.
 *
 * Brug:
 *   renderKitchenTopbar(document.body, { user: currentUser });
 *   renderKitchenTopbar(document.body, { user: currentUser, rightSlot: '<button>KIOSK</button>' });
 */

var NAV_ITEMS = [
    { label: 'DASHBOARD',   href: '/kitchen/',              match: ['/kitchen/', '/kitchen/index.html'] },
    { label: 'I DAG',       href: '/kitchen/today.html',    match: ['/kitchen/today.html'] },
    { label: 'SENERE',      href: '/kitchen/later.html',    match: ['/kitchen/later.html'] },
    { label: 'KALENDER',    href: '/kitchen/calendar.html', match: ['/kitchen/calendar.html'] },
    { label: 'PLANLÆGNING', href: '/kitchen/planning.html', match: ['/kitchen/planning.html'] },
];

var MORE_ITEMS = [
    { label: 'Opskrifter',  href: '/kitchen/recipes.html' },
    { label: 'Lager',       href: '/kitchen/stock.html' },
    { label: 'Indkøb',      href: '/kitchen/purchasing.html' },
    { label: 'Vagtplan',    href: '/kitchen/vagtplan.html' },
];

/**
 * @param {HTMLElement} container - element to prepend topbar to (usually document.body)
 * @param {object} opts
 * @param {object} opts.user - currentUser from checkAuth() (needs .role)
 * @param {string|HTMLElement|Function} [opts.rightSlot] - extra content for .topbar-right
 * @param {boolean} [opts.showLiveDot=true]
 * @returns {HTMLElement} the created <header> element
 */
function renderKitchenTopbar(container, opts) {
    if (!container) return null;
    opts = opts || {};
    var user = opts.user || {};
    var showLiveDot = opts.showLiveDot !== false;

    var pathname = window.location.pathname;

    // Brand name from CSS variable
    var brandName = getComputedStyle(document.documentElement)
        .getPropertyValue('--brand-name').trim().replace(/^["']|["']$/g, '') || 'Bon v2';

    // Build header
    var header = document.createElement('header');
    header.className = 'topbar';

    // ── Left side ──
    var left = document.createElement('div');
    left.className = 'topbar-left';

    var logo = document.createElement('span');
    logo.className = 'topbar-logo';
    logo.textContent = brandName;
    left.appendChild(logo);

    var nav = document.createElement('nav');
    nav.className = 'topbar-nav';

    // Main nav items
    NAV_ITEMS.forEach(function(item) {
        var a = document.createElement('a');
        a.href = item.href;
        a.textContent = item.label;
        if (item.match.indexOf(pathname) !== -1) {
            a.className = 'active';
        }
        nav.appendChild(a);
    });

    // MERE dropdown
    var moreActive = false;
    var activeMoreHref = null;
    MORE_ITEMS.forEach(function(item) {
        if (pathname === item.href) {
            moreActive = true;
            activeMoreHref = item.href;
        }
    });

    var details = document.createElement('details');
    details.className = 'topbar-more';
    var summary = document.createElement('summary');
    summary.textContent = 'MERE \u25BE';
    if (moreActive) summary.className = 'active';
    details.appendChild(summary);

    var dropdown = document.createElement('div');
    dropdown.className = 'topbar-dropdown';
    MORE_ITEMS.forEach(function(item) {
        var a = document.createElement('a');
        a.href = item.href;
        a.textContent = item.label;
        if (item.href === activeMoreHref) {
            a.className = 'active-sub';
        }
        dropdown.appendChild(a);
    });
    details.appendChild(dropdown);
    nav.appendChild(details);

    left.appendChild(nav);

    // Zone switcher (integrated)
    if (typeof renderZoneSwitcher === 'function' && user.role) {
        renderZoneSwitcher('kitchen', user.role, left);
    }

    header.appendChild(left);

    // ── Right side ──
    var right = document.createElement('div');
    right.className = 'topbar-right';

    if (showLiveDot) {
        var dot = document.createElement('span');
        dot.className = 'live-dot';
        dot.textContent = 'Live';
        right.appendChild(dot);
    }

    // rightSlot
    if (opts.rightSlot) {
        if (typeof opts.rightSlot === 'function') {
            opts.rightSlot(right);
        } else if (typeof opts.rightSlot === 'string') {
            var tmp = document.createElement('div');
            tmp.innerHTML = opts.rightSlot;
            while (tmp.firstChild) right.appendChild(tmp.firstChild);
        } else if (opts.rightSlot instanceof HTMLElement) {
            right.appendChild(opts.rightSlot);
        }
    }

    header.appendChild(right);

    // Prepend to container
    container.prepend(header);

    // Close dropdown on outside click
    document.addEventListener('click', function(e) {
        if (!details.contains(e.target)) {
            details.removeAttribute('open');
        }
    });

    return header;
}
