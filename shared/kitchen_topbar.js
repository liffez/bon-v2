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
    { label: 'Logistik',    href: '/kitchen/logistik.html' },
    { label: 'Vagtplan',    href: '/kitchen/vagtplan.html' },
];

/**
 * Byt-knap ⇄ på køkkenskærmen: giver Bon eller Whiteboard den store del af
 * skærmen. Selve bytningen sker på Pi'en (docs/kiosk/bin/kiosk-layout-server.py),
 * så knappen vises KUN når den svarer på 127.0.0.1. Vi spørger kun på en enhed
 * der er markeret som kiosk — ellers ville alle browsere ringe til localhost
 * og få Chromiums "vil du give adgang til lokale enheder?" i hovedet.
 */
var KIOSK_LAYOUT_URL = 'http://127.0.0.1:8765';

function _addKioskLayoutButton(right) {
    var device = null;
    try { device = localStorage.getItem('bon_kiosk_device'); } catch (e) { /* spærret */ }
    if (!device || typeof fetch !== 'function') return;

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ctrl) setTimeout(function() { ctrl.abort(); }, 1500);

    fetch(KIOSK_LAYOUT_URL + '/layout', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(state) {
            if (!state || !state.primary) return;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'kiosk-swap-btn';
            var label = state.primary === 'bon' ? '⇄ Whiteboard stor' : '⇄ Bon stor';
            btn.textContent = label;
            btn.title = 'Byt om på Bon og Whiteboard på skærmen';
            btn.addEventListener('click', function() {
                btn.disabled = true;
                btn.textContent = 'Bytter…';
                fetch(KIOSK_LAYOUT_URL + '/layout/swap', { method: 'POST', cache: 'no-store' })
                    .then(function(r) {
                        // Ved succes genstarter Pi'en dette vindue om et øjeblik.
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                    })
                    .catch(function() {
                        btn.disabled = false;
                        btn.textContent = label;
                        btn.title = 'Kunne ikke bytte — prøv igen';
                    });
            });
            right.insertBefore(btn, right.firstChild);
        })
        .catch(function() { /* ingen kiosk-server her — ingen knap */ });
}

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

    // Main nav items — gemmes så de kan flyttes ind/ud af MERE efter plads
    var navLinks = [];
    NAV_ITEMS.forEach(function(item) {
        var a = document.createElement('a');
        a.href = item.href;
        a.textContent = item.label;
        var isActive = item.match.indexOf(pathname) !== -1;
        if (isActive) a.className = 'active';
        nav.appendChild(a);
        navLinks.push({ el: a, item: item, active: isActive });
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

    // Sektion 1: hovedpunkter der ikke er plads til i baren (fyldes af fitNav)
    var overflowBox = document.createElement('div');
    overflowBox.className = 'topbar-dropdown-overflow';
    dropdown.appendChild(overflowBox);

    var sep = document.createElement('div');
    sep.className = 'topbar-dropdown-sep';
    sep.style.display = 'none';
    dropdown.appendChild(sep);

    // Sektion 2: de faste MERE-punkter
    MORE_ITEMS.forEach(function(item) {
        var a = document.createElement('a');
        a.href = item.href;
        a.textContent = item.label;
        if (item.href === activeMoreHref) {
            a.className = 'active-sub';
        }
        dropdown.appendChild(a);
    });
    // Log ud — nederst i MERE frem for som synlig knap, så ingen rammer den
    // med et forkert tryk på køkkenskærmen. Login-siden husker at enheden er
    // en kiosk og viser PIN-padden igen.
    var logoutSep = document.createElement('div');
    logoutSep.className = 'topbar-dropdown-sep';
    dropdown.appendChild(logoutSep);
    var logoutBtn = document.createElement('a');
    logoutBtn.href = '/login.html';
    logoutBtn.className = 'topbar-logout';
    logoutBtn.textContent = 'Log ud';
    logoutBtn.addEventListener('click', function(e) {
        e.preventDefault();
        fetch('/api/auth/logout', { method: 'POST' })
            .catch(function() {})
            .then(function() { window.location.href = '/login.html'; });
    });
    dropdown.appendChild(logoutBtn);

    details.appendChild(dropdown);
    nav.appendChild(details);

    left.appendChild(nav);

    // ── Overflow-tilpasning ──────────────────────────────────────
    // Måler den faktiske plads i stedet for at gætte breakpoints: topbarens
    // bredde afhænger af rolle (← Office vises kun for office/admin/salg),
    // sidens rightSlot (KIOSK, vejr) og density-mode. Vi flytter derfor
    // hovedpunkter fra højre ind i MERE indtil rækken passer.
    var fitting = false;
    function fitNav() {
        if (fitting || !nav.isConnected) return;
        fitting = true;

        // 1. Alt tilbage i baren (de udflyttede er altid et suffiks)
        for (var i = 0; i < navLinks.length; i++) {
            var L = navLinks[i];
            if (L.el.parentNode !== nav) {
                nav.insertBefore(L.el, details);
                L.el.className = L.active ? 'active' : '';
            }
        }

        // 2. Flyt fra højre indtil rækken passer
        var visible = navLinks.length;
        while (visible > 0 && nav.scrollWidth > nav.clientWidth + 1) {
            visible--;
            var M = navLinks[visible];
            overflowBox.insertBefore(M.el, overflowBox.firstChild);
            M.el.className = M.active ? 'active-sub' : '';
        }

        // 3. Etiket: er den aktive side røget ind i MERE, siger knappen hvor vi er
        var hiddenActive = null;
        for (var k = visible; k < navLinks.length; k++) {
            if (navLinks[k].active) hiddenActive = navLinks[k];
        }
        sep.style.display = visible < navLinks.length ? '' : 'none';
        summary.textContent = (hiddenActive ? hiddenActive.item.label : 'MERE') + ' \u25BE';
        summary.className = (hiddenActive || moreActive) ? 'active' : '';

        fitting = false;
    }

    // ── "Tilbage til Office"-knap (kun office/admin/salg) ───
    // Mere fremtrædende end den generiske zone-switcher — så office-brugere
    // der hopper ind i kitchen-zonen nemt kan finde retur til Office.
    if (user.role && ['office', 'admin', 'salg'].indexOf(user.role) !== -1) {
        var backBtn = document.createElement('a');
        backBtn.href = '/office/';
        backBtn.className = 'topbar-back-to-office';
        backBtn.textContent = '← Office';
        backBtn.title = 'Tilbage til Office-zonen';
        // Zone-skift er en fuld navigation og rammer derfor den fastlaaste
        // HTTP/2-forbindelse foerst. Se safeNavigate() i shared/utils.js (#423).
        if (typeof guardLink === 'function') guardLink(backBtn);
        left.appendChild(backBtn);
    } else if (typeof renderZoneSwitcher === 'function' && user.role) {
        // Fallback til generic zone-switcher for andre roller (settings m.fl.)
        renderZoneSwitcher('kitchen', user.role, left);
    }

    header.appendChild(left);

    // ── Right side ──
    var right = document.createElement('div');
    right.className = 'topbar-right';

    if (showLiveDot) {
        var dot = document.createElement('span');
        dot.className = 'live-dot';
        var dotLabel = document.createElement('span');
        dotLabel.className = 'live-dot-label';
        dotLabel.textContent = 'Live';
        dot.appendChild(dotLabel);
        right.appendChild(dot);
    }

    // Hjælp-knap i topbar
    var helpBtn = document.createElement('button');
    helpBtn.className = 'topbar-help-btn';
    helpBtn.textContent = '?';
    helpBtn.title = 'Hjælp (H)';
    helpBtn.addEventListener('click', function() {
        if (typeof HelpSystem !== 'undefined') HelpSystem.toggle();
    });
    right.appendChild(helpBtn);

    // SOP-genvej i topbar
    var sopLink = document.createElement('a');
    sopLink.className = 'topbar-sop-btn';
    sopLink.href = 'https://sop.ristetrug.dk';
    sopLink.target = '_blank';
    sopLink.rel = 'noopener';
    sopLink.title = 'SOP';
    sopLink.setAttribute('aria-label', 'SOP');
    sopLink.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
    right.appendChild(sopLink);

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

    _addKioskLayoutButton(right);

    header.appendChild(right);

    // Prepend to container
    container.prepend(header);

    // Close dropdown on outside click
    document.addEventListener('click', function(e) {
        if (clickedOutside(e, details)) {
            details.removeAttribute('open');
        }
    });

    // Tilpas nu og hver gang pladsen ændrer sig.
    // rAF-throttlet: fitNav læser layout (scrollWidth), og gør man det synkront
    // inde i en ResizeObserver-callback, tvinger man reflow midt i renderingen
    // ("ResizeObserver loop"-advarsler) og giver jank når vinduet trækkes.
    var rafId = null;
    function scheduleFit() {
        if (rafId !== null) return;
        rafId = requestAnimationFrame(function() {
            rafId = null;
            fitNav();
        });
    }

    fitNav();
    if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(scheduleFit);
        ro.observe(header);
    }
    window.addEventListener('resize', scheduleFit);
    window.addEventListener('orientationchange', scheduleFit);
    // Density skifter skriftstørrelse/padding uden at ændre topbarens bredde
    document.addEventListener('density:change', scheduleFit);
    // Webfonts ændrer tekstbredder efter første måling
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(scheduleFit).catch(function() {});
    }
    // requestAnimationFrame er sat på pause mens fanen er skjult. Ændres
    // vinduet i mellemtiden, ville rækken først rette sig ved næste resize —
    // så vi måler igen når siden bliver synlig.
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) scheduleFit();
    });

    return header;
}
