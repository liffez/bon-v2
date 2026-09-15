/**
 * office/views/kontakter.js
 * ════════════════════════════════════════════════════════════
 * Fane-shell for "Kontakter" sidebar-punktet.
 * To faner:
 *   • Personer  — eksisterende crm-kunde360 (kunde-listview + detalje)
 *   • Firmaer   — ny crm-firmaer (firma-listview, klik → Firma 360° i Fase 6)
 *
 * Fane-state ligger i ?tab=personer|firmaer (default: personer).
 * Eksisterende ?customer= og fremtidig ?company= URL-params lever
 * side om side i URL'en og bruges af de underliggende child-views.
 * ════════════════════════════════════════════════════════════
 */

let _kontShell = null;
let _kontMounted = null;   // 'personer' | 'firmaer'
let _kontOpts = {};

function initKontakter(container, opts = {}) {
    // Re-init fra openFirma360/closeFirma360 sender ingen opts. Behold dem vi
    // fik fra switchView (openDrawer m.fl.) i stedet for at nulstille — ellers
    // mister Firma 360° og Kunde 360° drawer-åbneren, og klik på en bon-række
    // gør ingenting. Sikkerhedsnet: window.openDrawer findes altid i office.
    _kontOpts = { ..._kontOpts, ...opts };
    if (typeof _kontOpts.openDrawer !== 'function' && typeof window.openDrawer === 'function') {
        _kontOpts.openDrawer = window.openDrawer;
    }

    const params = new URLSearchParams(window.location.search);
    let initialTab = params.get('tab');
    // Hvis ingen tab er sat men ?company= findes, default til firmaer
    if (!initialTab) {
        initialTab = params.get('company') ? 'firmaer' : 'personer';
    }
    if (initialTab !== 'personer' && initialTab !== 'firmaer') {
        initialTab = 'personer';
    }

    container.innerHTML = `
        <div class="kontakter-shell">
            <div class="kontakter-tabs">
                <button class="ktab ${initialTab === 'personer' ? 'active' : ''}" data-tab="personer">
                    <span class="ktab-icon">👤</span> Personer
                </button>
                <button class="ktab ${initialTab === 'firmaer' ? 'active' : ''}" data-tab="firmaer">
                    <span class="ktab-icon">🏢</span> Firmaer
                </button>
            </div>
            <div class="kontakter-content" id="kontakter-content"></div>
        </div>
    `;

    _kontShell = container;

    container.querySelectorAll('.ktab').forEach(btn => {
        btn.addEventListener('click', () => switchKontakterTab(btn.dataset.tab));
    });

    mountKontakterTab(initialTab);
}

function switchKontakterTab(tab) {
    if (tab !== 'personer' && tab !== 'firmaer') return;
    if (_kontMounted === tab) return;

    const url = new URL(window.location);
    url.searchParams.set('tab', tab);
    // Ryd modparts kontekst-params når man skifter tab
    if (tab === 'personer') url.searchParams.delete('company');
    if (tab === 'firmaer')  url.searchParams.delete('customer');
    history.replaceState({}, '', url);

    if (_kontShell) {
        _kontShell.querySelectorAll('.ktab').forEach(b =>
            b.classList.toggle('active', b.dataset.tab === tab)
        );
    }
    mountKontakterTab(tab);
}

function mountKontakterTab(tab) {
    const content = document.getElementById('kontakter-content');
    if (!content) return;

    // Cleanup forrige tab
    if (_kontMounted === 'personer' && typeof cleanupCrmKunde360 === 'function') {
        cleanupCrmKunde360();
    }
    if (_kontMounted === 'firmaer' && typeof cleanupCrmFirmaer === 'function') {
        cleanupCrmFirmaer();
    }
    content.innerHTML = '';

    _kontMounted = tab;

    const topTitle = document.getElementById('office-topbar-title');

    if (tab === 'personer') {
        // crm-kunde360 sætter selv topbar-titlen til "Kunde 360°"
        if (typeof initCrmKunde360 === 'function') {
            initCrmKunde360(content, _kontOpts);
        } else {
            content.innerHTML = '<div style="padding:20px;color:#888">Personer-viewet er ikke loadet.</div>';
        }
    } else if (tab === 'firmaer') {
        // Hvis ?company= er sat: mount Firma 360°. Ellers: listview.
        const params = new URLSearchParams(window.location.search);
        const companyId = params.get('company');
        if (companyId && typeof initCrmFirma360 === 'function') {
            if (topTitle) topTitle.textContent = 'Firma 360°';
            initCrmFirma360(content, { ..._kontOpts, companyId: parseInt(companyId, 10) });
        } else if (typeof initCrmFirmaer === 'function') {
            if (topTitle) topTitle.textContent = 'Firmaer';
            initCrmFirmaer(content, _kontOpts);
        } else {
            content.innerHTML = '<div style="padding:20px;color:#888">Firmaer-viewet er ikke loadet.</div>';
        }
    }
}

// Bruges af Firma 360° "Tilbage til liste"-knap og af klik fra crm-firmaer
window.openFirma360 = function openFirma360(companyId) {
    const url = new URL(window.location);
    url.searchParams.set('view', 'kontakter');
    url.searchParams.set('tab', 'firmaer');
    url.searchParams.set('company', companyId);
    history.pushState({}, '', url);
    if (window.switchView) {
        // Force re-init af kontakter-viewet
        if (typeof cleanupKontakter === 'function') cleanupKontakter();
        const contentEl = document.getElementById('office-content');
        if (contentEl) {
            contentEl.innerHTML = '';
            initKontakter(contentEl, _kontOpts);
        }
    }
};

window.closeFirma360 = function closeFirma360() {
    const url = new URL(window.location);
    url.searchParams.delete('company');
    history.pushState({}, '', url);
    if (typeof cleanupKontakter === 'function') cleanupKontakter();
    const contentEl = document.getElementById('office-content');
    if (contentEl) {
        contentEl.innerHTML = '';
        initKontakter(contentEl, _kontOpts);
    }
};

function cleanupKontakter() {
    if (_kontMounted === 'personer' && typeof cleanupCrmKunde360 === 'function') {
        cleanupCrmKunde360();
    }
    if (_kontMounted === 'firmaer' && typeof cleanupCrmFirmaer === 'function') {
        cleanupCrmFirmaer();
    }
    _kontShell = null;
    _kontMounted = null;
}

// Eksponér på window så office/index.html switchView kan kalde dem
window.initKontakter = initKontakter;
window.cleanupKontakter = cleanupKontakter;
window.switchKontakterTab = switchKontakterTab;
