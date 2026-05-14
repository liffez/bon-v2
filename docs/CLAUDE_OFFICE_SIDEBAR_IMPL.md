# CLAUDE_OFFICE_SIDEBAR_IMPL.md
## Implementeringsplan — Office sidebar v2

> **Spec:** `CLAUDE_OFFICE_SIDEBAR.md` (autoritativ — læs først)
> **Mockup:** `office_sidebar_v3.html`
> **Plan-skribent + eksekutør:** Claude
> **Maj 2026**

---

## Mål

Implementér den 8-punkts office-sidebar fra spec'en uden at brække eksisterende deep-links, drawer-flow eller view-funktionalitet.

---

## Eksekveringsrækkefølge

Faserne er ordnet så hvert trin er testbart isoleret, og fejl i ét trin ikke breaker tidligere trin. Hver fase kan deployes til main hvis nødvendigt.

```
Fase 1: Foundation       (CSS + backend endpoint)
Fase 2: Shell scaffolding (HTML + switchView extension)
Fase 3: Routers          (5 router-filer i stigende kompleksitet)
Fase 4: Kitchen-side     (Tilbage til Office-knap)
Fase 5: Cleanup          (slet stubs, fjern gamle links)
Fase 6: SSE badges       (live opdatering)
Fase 7: Verifikation     (test-matrix)
```

---

## Fase 1 — Foundation

### 1.1 Pill CSS

**Fil:** `shared/components.css`

Tilføj:

```css
.pills-row {
  background: var(--color-surface, #fff);
  border-bottom: 1px solid var(--color-border);
  padding: 10px 24px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
  min-height: 52px;
}

.pill {
  padding: 7px 16px;
  background: var(--color-background);
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 700;
  color: var(--color-text-dim);
  cursor: pointer;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  user-select: none;
}
.pill:hover {
  background: white;
  color: var(--brand-primary);
  border-color: var(--color-border);
}
.pill.active {
  background: var(--brand-primary);
  color: white;
  box-shadow: 0 2px 6px rgba(142, 99, 31, 0.25);
}
.pill .pill-badge {
  background: var(--color-danger, #bc181b);
  color: white;
  font-size: 10px;
  font-weight: 900;
  padding: 1px 6px;
  border-radius: 10px;
  min-width: 16px;
  text-align: center;
}
.pill.active .pill-badge {
  background: white;
  color: var(--brand-primary);
}
```

**Verifikation:** Tilføj midlertidigt en `<div class="pills-row"><button class="pill active">Test</button></div>` til office content — bekræft visuelt.

### 1.2 Backend: `routes/nav.js`

**Ny fil.** Samler badges fra eksisterende endpoints til ét kald.

```javascript
import express from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../shared/auth.js';

export const navRouter = express.Router();
navRouter.use(requireAuth());

navRouter.get('/badges', (req, res) => {
  const db = getDb();
  const result = {
    bons_nye: 0,
    crm_indbakke: 0,
    tilbud_aktive: 0,
    indkob_leverandorpost: 0,
    okonomi_fakturering: 0,
  };

  try {
    // Nye bons (web_orders pending + status=NY)
    const nye = db.prepare(`
      SELECT COUNT(*) as c FROM web_orders
      WHERE status IS NULL OR status = 'pending'
    `).get();
    result.bons_nye = nye?.c || 0;

    // CRM indbakke (umatched mails)
    const inb = db.prepare(`
      SELECT COUNT(*) as c FROM mail_messages mm
      LEFT JOIN mail_threads mt ON mt.id = mm.thread_id
      WHERE mm.direction = 'inbound'
        AND mt.bon_id IS NULL AND mt.customer_id IS NULL
        AND mt.purchase_order_id IS NULL AND mt.supplier_id IS NULL
        AND (mm.resolved IS NULL OR mm.resolved = 0)
    `).get();
    result.crm_indbakke = inb?.c || 0;

    // Aktive tilbud
    const tilb = db.prepare(`
      SELECT COUNT(*) as c FROM bons
      WHERE is_offer = 1 AND (offer_status IS NULL OR offer_status NOT IN ('won','lost','expired'))
    `).get();
    result.tilbud_aktive = tilb?.c || 0;

    // Leverandørpost (ulæste mails fra leverandører)
    const post = db.prepare(`
      SELECT COUNT(*) as c FROM mail_messages mm
      JOIN mail_threads mt ON mt.id = mm.thread_id
      WHERE mm.direction = 'inbound'
        AND mm.is_read = 0
        AND (mt.purchase_order_id IS NOT NULL OR mt.supplier_id IS NOT NULL)
    `).get();
    result.indkob_leverandorpost = post?.c || 0;

    // Fakturering (LEVERET uden faktura)
    const fakt = db.prepare(`
      SELECT COUNT(*) as c FROM bons b
      JOIN status_definitions s ON s.id = b.status_id
      WHERE s.code = 'LEVERET'
        AND b.is_offer = 0
        AND b.is_internal = 0
        AND b.payment_type = 'invoice'
        AND b.invoice_number IS NULL
    `).get();
    result.okonomi_fakturering = fakt?.c || 0;

  } catch (err) {
    console.error('nav/badges error:', err);
  }

  res.set('Cache-Control', 'no-cache');
  res.json(result);
});
```

**Mount i `server.js`:**

```javascript
import { navRouter } from './routes/nav.js';
// ...
app.use('/api/nav', navRouter);
```

**Verifikation:**
```bash
curl http://localhost:3000/api/nav/badges --cookie "connect.sid=..."
# Forventer JSON med alle 5 nøgler
```

**Risiko:** SQL-queries afhænger af konkrete kolonnenavne der KAN være anderledes (`is_read`, `resolved`). Verificér mod faktisk skema før commit — kør `.schema mail_messages` mod produktions-DB hvis i tvivl.

---

## Fase 2 — Shell scaffolding

### 2.1 Ny sidebar HTML i `office/index.html`

**Ændringer i linje ~444-545** (den nuværende sidebar):

Erstat hele `<nav class="office-sidebar">` med:

```html
<nav class="office-sidebar">
  <div class="sidebar-brand" id="sidebar-zone-switch" title="Skift til Køkken">
    <div class="sidebar-brand-name">🍞 Ristet Rug</div>
    <div class="sidebar-brand-row">
      <span class="sidebar-brand-sub">BON V2 · OFFICE</span>
      <span class="sidebar-zone-pill">
        <span>⇄</span> KØKKEN
      </span>
    </div>
  </div>

  <div class="sidebar-nav">
    <div class="sidebar-group-label">Overblik</div>
    <button class="sidebar-link" data-view="dashboard">
      <span class="sidebar-icon">🏠</span> Dashboard
    </button>

    <div class="sidebar-group-label">Ordrer</div>
    <button class="sidebar-link" data-view="bons">
      <span class="sidebar-icon">📋</span> Bons
      <span class="sidebar-badge" data-badge="bons_nye" style="display:none"></span>
    </button>

    <div class="sidebar-group-label">Salg</div>
    <button class="sidebar-link" data-view="crm">
      <span class="sidebar-icon">👥</span> CRM
      <span class="sidebar-badge" data-badge="crm_indbakke" style="display:none"></span>
    </button>
    <button class="sidebar-link" data-view="tilbud">
      <span class="sidebar-icon">💬</span> Tilbud
      <span class="sidebar-badge gold" data-badge="tilbud_aktive" style="display:none"></span>
    </button>

    <div class="sidebar-group-label">Drift</div>
    <button class="sidebar-link" data-view="logistik">
      <span class="sidebar-icon">🚚</span> Logistik
    </button>
    <button class="sidebar-link" data-view="indkob">
      <span class="sidebar-icon">🛒</span> Indkøb
      <span class="sidebar-badge" data-badge="indkob_leverandorpost" style="display:none"></span>
    </button>

    <div class="sidebar-group-label">Økonomi</div>
    <button class="sidebar-link" data-view="okonomi">
      <span class="sidebar-icon">💰</span> Økonomi
      <span class="sidebar-badge gold" data-badge="okonomi_fakturering" style="display:none"></span>
    </button>

    <div class="sidebar-group-label">Team</div>
    <a class="sidebar-link" href="/kitchen/vagtplan.html" target="_blank">
      <span class="sidebar-icon">📅</span> Vagtplan
    </a>
  </div>

  <div class="sidebar-bottom">
    <div class="sidebar-icon-row">
      <a class="icon-btn" data-tip="Whiteboard" href="https://whiteboard.ristetrug.dk" target="_blank" rel="noopener">📋</a>
      <a class="icon-btn" data-tip="SOP" href="https://sop.ristetrug.dk" target="_blank" rel="noopener">📖</a>
      <div class="icon-btn-spacer"></div>
      <a class="icon-btn" data-tip="Settings" href="/settings/index.html">⚙</a>
      <button class="icon-btn" data-tip="Log ud" id="sidebar-logout">↩</button>
    </div>
    <div class="sidebar-user" id="sidebar-user"></div>
  </div>
</nav>
```

**Tilføj CSS** i samme fil (eller `office/office.css` hvis det er der) for `.sidebar-brand-row`, `.sidebar-zone-pill`, `.sidebar-icon-row`, `.icon-btn`, `.icon-btn-spacer` — kopiér fra mockup.

### 2.2 Pills-container

Lige under den nuværende topbar i `office/index.html`:

```html
<main id="office-main">
  <div class="office-topbar">
    <!-- eksisterende topbar -->
  </div>
  <div class="pills-row" id="office-pills" style="display:none"></div>
  <div id="office-content"><!-- views mounteres her --></div>
</main>
```

### 2.3 Pill-konfiguration

Tilføj i `<script>`-blokken i `office/index.html` (efter `views`-objektet):

```javascript
const PILLS = {
  dashboard: null,
  bons: [
    { id: 'liste', label: 'Liste', def: true },
    { id: 'kalender', label: 'Kalender' },
    { id: 'uge', label: 'Ugeoversigt' },
    { id: 'plan', label: 'Planlægning' },
    { id: 'nye', label: 'Nye', badge: 'bons_nye' },
  ],
  crm: [
    { id: 'pipeline', label: 'Pipeline', def: true },
    { id: 'kontakter', label: 'Kontakter' },
    { id: 'indbakke', label: 'Indbakke', badge: 'crm_indbakke' },
    { id: 'prospekter', label: 'Prospekter' },
    { id: 'reakt', label: 'Re-aktivering' },
    { id: 'indsigt', label: 'Indsigt' },
  ],
  tilbud: null,  // ét view, ingen pills
  logistik: [
    { id: 'idag', label: 'I dag', def: true },
    { id: 'ruter', label: 'Ruter' },
    { id: 'tracking', label: 'Tracking' },
    { id: 'bud', label: 'Bud' },
  ],
  indkob: [
    { id: 'liste', label: 'Indkøbsliste', def: true },
    { id: 'best', label: 'Bestillinger' },
    { id: 'lev', label: 'Leverandører' },
    { id: 'post', label: 'Leverandørpost', badge: 'indkob_leverandorpost' },
  ],
  okonomi: [
    { id: 'fakt', label: 'Fakturering', def: true, badge: 'okonomi_fakturering' },
    { id: 'penge', label: 'Pengestrøm' },
    { id: 'rap', label: 'Rapporter' },
  ],
};

function renderPills(viewName, activePill) {
  const pillsEl = document.getElementById('office-pills');
  const pills = PILLS[viewName];
  if (!pills) {
    pillsEl.style.display = 'none';
    pillsEl.innerHTML = '';
    return;
  }
  pillsEl.style.display = '';
  pillsEl.innerHTML = pills.map(p => `
    <button class="pill ${p.id === activePill ? 'active' : ''}" data-pill="${p.id}">
      ${p.label}
      ${p.badge ? `<span class="pill-badge" data-badge="${p.badge}" style="display:none"></span>` : ''}
    </button>
  `).join('');
  pillsEl.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => switchView(viewName, btn.dataset.pill));
  });
}

function getDefaultPill(viewName) {
  const pills = PILLS[viewName];
  if (!pills) return null;
  return pills.find(p => p.def)?.id || pills[0].id;
}

function resolvePill(viewName, requested) {
  const pills = PILLS[viewName];
  if (!pills) return null;
  if (requested && pills.some(p => p.id === requested)) return requested;
  return getDefaultPill(viewName);
}
```

### 2.4 Udvid `switchView()` med pill-parameter

I `office/index.html` — find `window.switchView = function switchView(viewName) {` og erstat hele funktionen med:

```javascript
let _currentPill = null;

window.switchView = function switchView(viewName, requestedPill) {
  // Backwards-compat: gamle view-navne mappes til nye section-navne
  const VIEW_REMAP = {
    'web-orders': { view: 'bons', pill: 'nye' },
    'calendar': { view: 'bons', pill: 'kalender' },
    'ugeoversigt': { view: 'bons', pill: 'uge' },
    'planning': { view: 'bons', pill: 'plan' },
    'crm-dashboard': { view: 'crm', pill: 'pipeline' },
    'kontakter': { view: 'crm', pill: 'kontakter' },
    'crm-inbox': { view: 'crm', pill: 'indbakke' },
    'crm-prospekter': { view: 'crm', pill: 'prospekter' },
    'crm-reaktivering': { view: 'crm', pill: 'reakt' },
    'crm-kundeindsigt': { view: 'crm', pill: 'indsigt' },
    'kunder': { view: 'crm', pill: 'kontakter' },
    'crm-kunde360': { view: 'crm', pill: 'kontakter' },
    'fakturering': { view: 'okonomi', pill: 'fakt' },
    'cashflow': { view: 'okonomi', pill: 'penge' },
    'rapporter': { view: 'okonomi', pill: 'rap' },
    'leverandorpost': { view: 'indkob', pill: 'post' },
  };
  if (VIEW_REMAP[viewName]) {
    requestedPill = requestedPill || VIEW_REMAP[viewName].pill;
    viewName = VIEW_REMAP[viewName].view;
  }

  const pill = resolvePill(viewName, requestedPill);
  const sameView = (_currentView === viewName && _currentPill === pill);
  if (sameView) return;

  // Cleanup previous
  if (_currentView && views[_currentView]?.cleanup) {
    views[_currentView].cleanup();
  }

  contentEl.innerHTML = '';
  _currentView = viewName;
  _currentPill = pill;

  // Sidebar active state
  document.querySelectorAll('.sidebar-link[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  // Render pills
  renderPills(viewName, pill);

  // URL sync
  const url = new URL(window.location);
  url.searchParams.set('view', viewName);
  if (pill) url.searchParams.set('pill', pill); else url.searchParams.delete('pill');
  history.pushState({}, '', url);

  // Help system page context
  // ... (eksisterende logik)

  // Init view (router-funktionen får pill som parameter)
  views[viewName]?.init({ pill });
};
```

### 2.5 Opdater initialView-logik

Erstat slutningen af script-blokken:

```javascript
const params = new URLSearchParams(window.location.search);
const initialView = params.get('view') || 'dashboard';
const initialPill = params.get('pill') || null;
switchView(views[initialView] ? initialView : 'dashboard', initialPill);
```

### 2.6 Acceptkriterier Fase 2

- [ ] Sidebar har 8 punkter + footer-ikoner + zone-switch i header
- [ ] Klik på "Dashboard" lander på `?view=dashboard` (ingen pill)
- [ ] Klik på "Bons" lander på `?view=bons&pill=liste` (default-pill)
- [ ] Pills-rækken vises kun for sections der har pills
- [ ] Pills er klikbare og opdaterer URL
- [ ] Gamle URL `?view=fakturering` redirecter til `?view=okonomi&pill=fakt`
- [ ] `?view=bons&bon=139` åbner drawer som før

**Risk:** Bons view init kalder muligvis fortsat noget der antager den var top-level. Test grundigt.

---

## Fase 3 — Routers

### 3.1 `office/views/okonomi-router.js` (simplest, gold standard)

```javascript
let _okCleanup = null;

window.initOkonomi = function(container, { pill }) {
  if (typeof _okCleanup === 'function') {
    _okCleanup();
    _okCleanup = null;
  }

  switch (pill) {
    case 'fakt':
      initFakturering(container, { openDrawer });
      _okCleanup = () => { if (typeof cleanupFakturering === 'function') cleanupFakturering(); };
      break;
    case 'penge':
      initCashflow(container);
      _okCleanup = () => { if (typeof cleanupCashflow === 'function') cleanupCashflow(); };
      break;
    case 'rap':
      initRapporter(container, { openDrawer });
      _okCleanup = () => { if (typeof cleanupRapporter === 'function') cleanupRapporter(); };
      break;
    default:
      initFakturering(container, { openDrawer });
      _okCleanup = () => { if (typeof cleanupFakturering === 'function') cleanupFakturering(); };
  }
};

window.cleanupOkonomi = function() {
  if (_okCleanup) _okCleanup();
  _okCleanup = null;
};
```

Inkluder via `<script src="../office/views/okonomi-router.js"></script>` i `office/index.html`.

Tilføj i `views` objektet:
```javascript
okonomi: {
  init: ({ pill }) => initOkonomi(contentEl, { pill }),
  cleanup: () => cleanupOkonomi(),
},
```

**Vigtig finesse:** når brugeren klikker en pill INDEN FOR samme section, kalder `switchView` cleanup på den FORRIGE view (også via `views.okonomi.cleanup`). Det er det rigtige — routeren sørger så for at re-initialisere med ny pill.

Faktisk er der en subtilitet: `switchView` cleans op kun når `viewName` ændrer sig. Vi skal håndtere pill-skift inden for samme section uden at gå gennem switchView's view-skift-logik.

**Korrektion til Fase 2.4:**

```javascript
window.switchView = function switchView(viewName, requestedPill) {
  // ... (remap som før)
  const pill = resolvePill(viewName, requestedPill);
  const sameView = (_currentView === viewName);
  const samePill = (sameView && _currentPill === pill);
  if (samePill) return;

  // Hvis kun pill ændrer sig: cleanup + re-init samme view
  if (sameView) {
    if (views[_currentView]?.cleanup) views[_currentView].cleanup();
    contentEl.innerHTML = '';
    _currentPill = pill;
    renderPills(viewName, pill);
    // URL update
    const url = new URL(window.location);
    url.searchParams.set('pill', pill);
    history.pushState({}, '', url);
    views[viewName]?.init({ pill });
    return;
  }

  // Ellers fuldt view-skift
  if (_currentView && views[_currentView]?.cleanup) {
    views[_currentView].cleanup();
  }
  // ... (resten som før)
};
```

Opdatér Fase 2.4-koden tilsvarende inden eksekvering.

### 3.2 `office/views/bons-router.js`

```javascript
let _bnCleanup = null;

window.initBons = function(container, { pill }) {
  if (typeof _bnCleanup === 'function') { _bnCleanup(); _bnCleanup = null; }

  switch (pill) {
    case 'liste':
      initBonsList(container, { openDrawer });
      _bnCleanup = () => { if (typeof cleanupBonsList === 'function') cleanupBonsList(); };
      break;
    case 'kalender':
      initBonsCalendar(container, { openDrawer });
      _bnCleanup = () => { if (typeof cleanupBonsCalendar === 'function') cleanupBonsCalendar(); };
      break;
    case 'uge':
      initUgeoversigt(container, { openDrawer });
      _bnCleanup = () => { if (typeof cleanupUgeoversigt === 'function') cleanupUgeoversigt(); };
      break;
    case 'plan':
      initPlanning(container, { openDrawer });
      _bnCleanup = () => { if (typeof cleanupPlanning === 'function') cleanupPlanning(); };
      break;
    case 'nye':
      initWebOrders(container, { openDrawer });
      _bnCleanup = () => { if (typeof cleanupWebOrders === 'function') cleanupWebOrders(); };
      break;
    default:
      initBonsList(container, { openDrawer });
      _bnCleanup = () => { if (typeof cleanupBonsList === 'function') cleanupBonsList(); };
  }
};

window.cleanupBons = function() {
  if (_bnCleanup) _bnCleanup();
  _bnCleanup = null;
};
```

**Risk:** `bons-list.js` kan have URL-state-håndtering der antager den er den eneste view (`?filter=today`, `?date=2026-06-01`). Verificér og evt. flyt state ind i pill-systemet eller behold som querystring-suffix.

### 3.3 `office/views/crm-router.js`

```javascript
let _crmCleanup = null;

window.initCRM = function(container, { pill }) {
  if (typeof _crmCleanup === 'function') { _crmCleanup(); _crmCleanup = null; }

  const map = {
    pipeline:   [() => initCrmDashboard(container),     () => typeof cleanupCrmDashboard === 'function' && cleanupCrmDashboard()],
    kontakter:  [() => initKontakter(container),        () => typeof cleanupKontakter === 'function' && cleanupKontakter()],
    indbakke:   [() => initCrmInbox(container),         () => typeof cleanupCrmInbox === 'function' && cleanupCrmInbox()],
    prospekter: [() => initCrmProspekter(container),    () => typeof cleanupCrmProspekter === 'function' && cleanupCrmProspekter()],
    reakt:      [() => initCrmReaktivering(container),  () => typeof cleanupCrmReaktivering === 'function' && cleanupCrmReaktivering()],
    indsigt:    [() => initCrmKundeindsigt(container),  () => typeof cleanupCrmKundeindsigt === 'function' && cleanupCrmKundeindsigt()],
  };

  const [init, cleanup] = map[pill] || map.pipeline;
  init();
  _crmCleanup = cleanup;
};

window.cleanupCRM = function() {
  if (_crmCleanup) _crmCleanup();
  _crmCleanup = null;
};
```

**Risk:** `kontakter.js` har komplekst state-flow (Personer/Firmaer-tabs, Kunde 360°, Firma 360°). Pill-skift til "kontakter" skal lande på toppen af kontakter-viewet — det gør den allerede via existing `?tab=personer` håndtering.

### 3.4 `office/views/logistics-router.js`

```javascript
window.initLogistics = function(container, { pill }) {
  container.innerHTML = `
    <div class="page-title">Logistik</div>
    <div class="page-heading">Kommer snart</div>
    <div class="placeholder">
      <div class="placeholder-icon">🚚</div>
      <div class="placeholder-title">Logistik-modulet er under udvikling</div>
      <div class="placeholder-desc">
        Indtil videre bookes bud direkte fra hver bon — åbn en bon
        og brug "📦 BESTIL BUD"-sektionen i drawer.
      </div>
    </div>
    <div class="info-box">
      <b>Planlagt indhold (Spor 2):</b>
      <ul style="margin-top:8px;padding-left:20px;">
        <li><b>I dag</b> — dagens leveringer med live-status</li>
        <li><b>Ruter</b> — auto-genererede ruter via OSRM/VROOM</li>
        <li><b>Tracking</b> — live position fra mobile-courier app</li>
        <li><b>Bud</b> — egne cyklister + eksterne services</li>
      </ul>
    </div>
  `;
};

window.cleanupLogistics = function() { /* nothing to clean */ };
```

### 3.5 `office/views/indkob-router.js`

```javascript
let _ibCleanup = null;

window.initIndkob = function(container, { pill }) {
  if (typeof _ibCleanup === 'function') { _ibCleanup(); _ibCleanup = null; }

  switch (pill) {
    case 'liste':
    case 'best':
      // Genbrug shared/indkob.js (samme som kitchen)
      // Hvis komponenten ikke har initialView-param: åbn på liste, scroll til bestilt-sektion
      window.initIndkobComponent(container, { initialView: pill === 'best' ? 'bestilt' : 'liste' });
      _ibCleanup = () => typeof window.cleanupIndkobComponent === 'function' && window.cleanupIndkobComponent();
      break;
    case 'lev':
      initIndkobSettings(container, { mode: 'page' });
      _ibCleanup = () => typeof cleanupIndkobSettings === 'function' && cleanupIndkobSettings();
      break;
    case 'post':
      initSupplierInbox(container, { openDrawer });
      _ibCleanup = () => typeof cleanupSupplierInbox === 'function' && cleanupSupplierInbox();
      break;
    default:
      window.initIndkobComponent(container);
      _ibCleanup = () => typeof window.cleanupIndkobComponent === 'function' && window.cleanupIndkobComponent();
  }
};

window.cleanupIndkob = function() {
  if (_ibCleanup) _ibCleanup();
  _ibCleanup = null;
};
```

**Risk:** `shared/indkob.js` eksponerer i dag `initIndkob(container)` (uden options). Hvis vi kalder vores router-funktion også `initIndkob`, kolliderer navnene. Løsning:
- Omdøb router-funktionen til `initIndkobOffice` og bind til `views.indkob.init`
- ELLER omdøb `shared/indkob.js` eksport til `initIndkobComponent` (og opdater kitchen-side)

**Anbefaling:** omdøb router til `initIndkobOffice` for at minimere ripple.

```javascript
// I router:
window.initIndkobOffice = function(container, { pill }) { ... };

// I office/index.html views-objekt:
indkob: {
  init: ({ pill }) => initIndkobOffice(contentEl, { pill }),
  cleanup: () => cleanupIndkobOffice(),
},
```

**Risk 2:** `shared/indkob.js` har muligvis ikke en `cleanup`-funktion. Verificér; tilføj hvis manglende.

**Risk 3:** `shared/indkob.js` antager muligvis at den kun mountes ét sted ad gangen (SSE-handlers globale). Verificér.

### 3.6 Tilbud-view (uændret)

`tilbud.js` er allerede ét view uden pills. `PILLS.tilbud = null` så ingen pills vises. Behold eksisterende `views.tilbud` definition.

### 3.7 Acceptkriterier Fase 3

For hver router (okonomi, bons, crm, logistik, indkob):
- [ ] Alle pills er klikbare
- [ ] Hver pill åbner den korrekte underliggende view
- [ ] URL opdaterer korrekt ved pill-skift
- [ ] Tilbage-knap i browseren navigerer mellem pills
- [ ] Ingen console errors
- [ ] Drawer-deeplink `?view=X&pill=Y&bon=N` åbner drawer

---

## Fase 4 — Kitchen-side

### 4.1 Tilbage til Office-knap

**Fil:** `shared/kitchen-topbar.html`

Tilføj som første element efter `<header>` eller `<nav>`:

```html
<button class="back-to-office" id="back-to-office" style="display:none"
        onclick="location.href='/office/'">
  ← Office
</button>
```

CSS i samme fil eller i `shared/tokens.css`:

```css
.back-to-office {
  background: rgba(255,255,255,0.1);
  border: 1px solid rgba(255,255,255,0.2);
  color: white;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  margin-right: 12px;
}
.back-to-office:hover {
  background: rgba(255,255,255,0.18);
}
```

Show-logik i `shared/utils.js` (eller hvor checkAuth lever):

```javascript
// Efter user-objekt er hentet
const backBtn = document.getElementById('back-to-office');
if (backBtn && user && ['office','admin','salg'].includes(user.role)) {
  backBtn.style.display = '';
}
```

**Acceptkriterie:** Office-bruger i kitchen-zonen ser knappen. Køkken-bruger (kok, koekkenchef) ser den ikke.

---

## Fase 5 — Cleanup

### 5.1 Slet stub-filer

```bash
rm office/views/purchasing.js
rm office/views/logistics.js
rm office/views/offers.js
rm office/views/invoicing.js
rm office/views/reports.js
```

### 5.2 Fjern script-tags i office/index.html

Find og fjern `<script src="...">` tags der refererer til de slettede filer.

### 5.3 Verifikation af backwards-compat

Test følgende gamle URLs lander på de korrekte nye lokationer:
- `?view=fakturering` → `?view=okonomi&pill=fakt`
- `?view=cashflow` → `?view=okonomi&pill=penge`
- `?view=rapporter` → `?view=okonomi&pill=rap`
- `?view=kontakter` → `?view=crm&pill=kontakter`
- `?view=crm-inbox` → `?view=crm&pill=indbakke`
- `?view=calendar` → `?view=bons&pill=kalender`
- `?view=web-orders` → `?view=bons&pill=nye`
- `?view=ugeoversigt` → `?view=bons&pill=uge`
- `?view=planning` → `?view=bons&pill=plan`
- `?view=leverandorpost` → `?view=indkob&pill=post`

---

## Fase 6 — SSE badges

### 6.1 Badge-loader

I `office/index.html`:

```javascript
let _badgesCache = {};

async function loadNavBadges() {
  try {
    const data = await apiFetch('/api/nav/badges');
    _badgesCache = data;
    renderBadges();
  } catch (e) { console.warn('badge load failed', e); }
}

function renderBadges() {
  document.querySelectorAll('[data-badge]').forEach(el => {
    const key = el.dataset.badge;
    const val = _badgesCache[key] || 0;
    if (val > 0) {
      el.textContent = val;
      el.style.display = '';
    } else {
      el.style.display = 'none';
    }
  });
}

// Init load
loadNavBadges();
// Reload hver gang pills re-renderes (så pill-badges også opdateres)
const _origRenderPills = renderPills;
renderPills = function(...args) { _origRenderPills(...args); renderBadges(); };
```

### 6.2 SSE-handler

I `office/index.html` — i SSE-event-handleren:

```javascript
// Eksisterende SSE-handlers ...

// Tilføj badge-refresh på relevante events
const BADGE_RELOAD_EVENTS = [
  'bon_created', 'bon_updated', 'bon_status',
  'mail_unmatched', 'mail_received', 'po_mail_received', 'supplier_mail_received',
  'crm_activity_created', 'web_order_created',
];

BADGE_RELOAD_EVENTS.forEach(ev => {
  sseSource.addEventListener(ev, () => {
    // Debounce — flere events i hurtig rækkefølge skal kun trigge ét reload
    clearTimeout(_badgeReloadTimer);
    _badgeReloadTimer = setTimeout(loadNavBadges, 300);
  });
});
let _badgeReloadTimer = null;
```

### 6.3 Fjern de tre gamle badge-update-funktioner

I `office/index.html` — slet:
- `updateInvoiceBadge()` + dens kald
- `updateWebOrdersBadge()` + dens kald
- `updateSiBadge()` + dens kald

Disse er nu erstattet af det samlede `loadNavBadges()`.

---

## Fase 7 — Verifikation

### Test-matrix

| Test | Forventet |
|------|-----------|
| Klik hvert af de 8 sidebar-items | Sidebar active state + pills render + content vises |
| Klik hver pill i hver section | URL opdaterer + content skifter + ingen flicker |
| Browser tilbage-knap mellem pills | Navigation tilbage til forrige pill |
| Browser tilbage-knap mellem sections | Navigation tilbage til forrige section |
| `?view=fakturering` direkte i URL | Lander på Økonomi → Fakturering |
| `?view=crm-inbox` direkte | Lander på CRM → Indbakke |
| `?view=bons&pill=liste&bon=139` | Bons-liste + drawer åbnet |
| `?view=okonomi&pill=fakt&bon=42` | Fakturering + drawer åbnet |
| Klik zone-switch i header | Navigerer til /kitchen/ |
| Office-bruger i kitchen | Ser "← Office"-knap øverst |
| Kitchen-only bruger i kitchen | Ser IKKE knappen |
| Sidebar-badges (5 stk) | Opdaterer live via SSE |
| Pill-badges (4 stk) | Opdaterer live via SSE |
| Whiteboard-ikon i footer | Åbner whiteboard.ristetrug.dk i ny fane |
| SOP-ikon i footer | Åbner sop.ristetrug.dk i ny fane |
| ⚙ Settings-ikon | Navigerer til /settings/ |
| ↩ Log ud-ikon | Logger ud + redirect til /login |
| Logistik-pill (alle 4) | Viser placeholder (samme indhold) |
| Indkøb → Indkøbsliste | Mounter shared/indkob.js korrekt |
| Indkøb → Leverandører | Mounter shared/indkob_settings.js i page-mode |
| Indkøb → Leverandørpost | Mounter shared/supplier_inbox.js |

---

## Afslut: dokumentation

### Opdatér `CLAUDE.md`

- Sektion "Status" — tilføj ny linje: "Fase X — Office sidebar v2" med detaljer
- Sektion "Næste opgave" — opdatér resterende-listen

### Opdatér `bon_v2_zoner_og_layout.md`

§4 Office — opdatér fra 11 til 8 punkter, tilføj pill-system.

### Beslutningslog

Tilføj til relevant decisions-log: "Maj 2026 — Office sidebar konsolideret fra 23 til 8 punkter, pills i toppen af content-areal, zone-switch flyttet til header."

---

## Estimeret varighed

| Fase | Tid |
|------|-----|
| 1. Foundation | 30 min |
| 2. Shell scaffolding | 1-2 timer |
| 3. Routers (5 stk) | 1 time |
| 4. Kitchen-side | 15 min |
| 5. Cleanup | 15 min |
| 6. SSE badges | 30 min |
| 7. Verifikation | 30 min |
| **Total** | **~4-5 timer** |

---

## Kendte risici (med plan)

| Risiko | Plan |
|--------|------|
| `shared/indkob.js` har ikke `initialView`-param | Tilføj parameter; default eksisterende adfærd |
| `shared/indkob.js` har ikke cleanup-funktion | Tilføj `cleanupIndkob` der fjerner SSE-handlers og DOM |
| `bons-list.js` URL-state-håndtering kolliderer med `&pill=` | Verificér og namespace bons-list's egne params (fx `&filter=`) |
| Pill-skift mens drawer er åben | Drawer skal forblive åben på tværs af pill-skift (er per definition global, ikke view-bundet) |
| `kontakter.js` deep-links (`?tab=personer&customer=42`) | Behold tab+customer-params, tilføj kun pill |
| SSE-handler dobblet-binding ved hyppigt pill-skift | Cleanup-funktioner SKAL fjerne deres SSE-handlers |
| Gamle bookmarks ramt af VIEW_REMAP men derefter direkte klik på samme view | `samePill` early-return håndterer det |

---

*Klar til eksekvering. Start med Fase 1 og fortsæt sekventielt. Hver fase er testbar isoleret.*
