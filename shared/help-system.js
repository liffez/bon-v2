/**
 * shared/help-system.js
 * ════════════════════════════════════════════════════════════
 * Kontekstuelt hjælpesystem til Bon v2 og Whiteboard.
 *
 * Tre tilstande:
 *   H             → Hjælpetilstand (overlay + sidepanel)
 *   Ctrl+Shift+H  → Kortlægningstilstand (admin: klik elementer, udfyld tekster)
 *   Admin-panel   → Rediger tekster i Settings
 *
 * Mapping gemmes i JSON som CSS-selectorer — ingen data-attributter i kildekoden.
 *
 * Integration:
 *   1. Inkludér help-system.css + help-system.js
 *   2. Sæt data-help-page="sidenøgle" og data-help-page-name="Sidenavn" på <body> eller wrapper
 *   3. For SPA: kald HelpSystem.setPage(key, name) ved view-switch
 * ════════════════════════════════════════════════════════════
 */

/* ══════════════════════════════════════════════════════════
   HELP CONTENT — loaded from API
   ══════════════════════════════════════════════════════════ */
var _helpContent = {};
var _helpLoaded = false;

function _helpLoadContent() {
  if (_helpLoaded) return Promise.resolve(_helpContent);
  return fetch('/api/help-content').then(function(r) {
    if (!r.ok) return {};
    return r.json();
  }).then(function(data) {
    _helpContent = data || {};
    _helpLoaded = true;
    return _helpContent;
  }).catch(function() {
    _helpContent = {};
    _helpLoaded = true;
    return _helpContent;
  });
}

function _helpSaveContent() {
  return fetch('/api/help-content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(_helpContent)
  }).then(function(r) { return r.json(); });
}

/* ══════════════════════════════════════════════════════════
   SELECTOR GENERATOR — auto-genererer CSS-selector for element
   ══════════════════════════════════════════════════════════ */
function _helpGenSelector(el) {
  // 1. ID
  if (el.id) return '#' + el.id;

  // 2. Unik klasse-kombination
  if (el.className && typeof el.className === 'string') {
    var classes = el.className.split(/\s+/).filter(function(c) {
      // Skip transient klasser
      return c && !/^(map-|help-|active|hover|focus|visible|open)/.test(c);
    });
    if (classes.length) {
      var sel = el.tagName.toLowerCase() + '.' + classes.join('.');
      if (document.querySelectorAll(sel).length === 1) return sel;
      // Prøv kun de to mest specifikke klasser
      if (classes.length >= 2) {
        sel = '.' + classes.slice(0, 2).join('.');
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }
  }

  // 3. Parent-kontekst
  var parent = el.parentElement;
  if (parent) {
    var parentSel = '';
    if (parent.id) {
      parentSel = '#' + parent.id;
    } else if (parent.className && typeof parent.className === 'string') {
      var pc = parent.className.split(/\s+/).filter(function(c) {
        return c && !/^(map-|help-|active|hover|focus|visible|open)/.test(c);
      });
      if (pc.length) parentSel = '.' + pc[0];
    }
    if (parentSel) {
      var tag = el.tagName.toLowerCase();
      var siblings = parent.querySelectorAll(':scope > ' + tag);
      if (siblings.length === 1) return parentSel + ' > ' + tag;
      // nth-child
      for (var i = 0; i < siblings.length; i++) {
        if (siblings[i] === el) {
          return parentSel + ' > ' + tag + ':nth-child(' + (i + 1) + ')';
        }
      }
    }
  }

  // 4. Fallback: tag + text content hint
  return el.tagName.toLowerCase() + '[title]';
}

/* ══════════════════════════════════════════════════════════
   DOM INJECTION — opretter panel, overlay, popup, banner
   ══════════════════════════════════════════════════════════ */
function _helpInjectDOM() {
  if (document.getElementById('help-hint')) return;

  var html = '' +
    // Floating ? knap
    '<div id="help-hint" title="Hjælp (H)">?</div>' +

    // Overlay
    '<div id="help-overlay"></div>' +

    // Side-panel
    '<div id="help-panel">' +
      '<div id="help-panel-header">' +
        '<div class="help-panel-top">' +
          '<div class="help-panel-title">Hjælp <span class="help-kbd">H</span></div>' +
          '<button class="help-dock-btn" onclick="HelpSystem.flipDock()" title="Flyt panelet til den anden side">⇄</button>' +
          '<button class="help-close-btn" onclick="HelpSystem.hide()">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="help-page-indicator">' +
          '<div class="help-page-dot"></div>' +
          '<div class="help-page-name">Side: <strong id="help-page-name-label">—</strong></div>' +
        '</div>' +
      '</div>' +
      '<div id="help-panel-body"></div>' +
    '</div>' +

    // Tooltip
    '<div class="help-tooltip" id="help-tooltip">' +
      '<div class="help-tooltip-label" id="help-tooltip-label"></div>' +
      '<div id="help-tooltip-text"></div>' +
    '</div>' +

    // Mapping banner
    '<div class="map-banner" id="map-banner">' +
      '<div class="map-banner-dot"></div>' +
      'Kortlægningstilstand — klik på et element for at tilføje hjælpetekst' +
    '</div>' +

    // Mapping popup
    '<div id="map-popup">' +
      '<div class="popup-title">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
        ' Tilføj hjælpetekst' +
      '</div>' +
      '<div class="popup-selector-preview" id="popup-selector-preview">—</div>' +
      '<label style="font-size:11px;font-weight:600;color:#888">Nøgle</label>' +
      '<input class="popup-input" id="popup-key" placeholder="fx ny-bon-knap" oninput="_helpUpdateKeyPreview()">' +
      '<div class="popup-key-preview" id="popup-key-preview">—</div>' +
      '<label style="font-size:11px;font-weight:600;color:#888">Label (kort navn)</label>' +
      '<input class="popup-input" id="popup-label" placeholder="fx Ny bon">' +
      '<label style="font-size:11px;font-weight:600;color:#888">Forklaring</label>' +
      '<textarea class="popup-textarea" id="popup-text" placeholder="Forklar hvad elementet gør..."></textarea>' +
      '<div class="popup-actions">' +
        '<button class="popup-save" onclick="MapMode.saveEntry()">Gem</button>' +
        '<button class="popup-cancel" onclick="MapMode.closePopup()">Annuller</button>' +
      '</div>' +
    '</div>';

  var container = document.createElement('div');
  container.id = 'help-system-root';
  container.innerHTML = html;
  document.body.appendChild(container);
}

function _helpUpdateKeyPreview() {
  var val = document.getElementById('popup-key').value.trim();
  document.getElementById('popup-key-preview').textContent = val || '—';
}

/* ══════════════════════════════════════════════════════════
   HELP SYSTEM — hovedmodul
   ══════════════════════════════════════════════════════════ */
var HelpSystem = (function() {
  var active = false;
  var badges = [];
  var _dock = 'right';
  var tooltip = null;
  var tooltipTimeout = null;
  var _pageKey = null;
  var _pageName = null;

  function init() {
    _helpInjectDOM();
    tooltip = document.getElementById('help-tooltip');
    document.getElementById('help-hint').addEventListener('click', toggle);

    document.addEventListener('keydown', function(e) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      // Ctrl+Shift+H → kortlægningstilstand
      if ((e.key === 'h' || e.key === 'H') && e.ctrlKey && e.shiftKey) {
        e.preventDefault(); MapMode.toggle(); return;
      }
      // H → hjælpetilstand
      if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        toggle();
      }
      // Escape
      if (e.key === 'Escape') {
        if (active) hide();
        if (MapMode.isActive()) MapMode.stop();
      }
    });

    // Hover tooltips via delegation
    document.addEventListener('mouseover', function(e) {
      if (!active) return;
      _showTooltipForEl(e);
    });
    document.addEventListener('mouseout', function(e) {
      if (!active) return;
      hideTooltip();
    });

    // Detect page fra data-attributter
    _detectPage();

    // Load content
    _helpLoadContent().then(function() {
      // Auto-registrer side i content hvis den ikke findes
      if (_pageKey && !_helpContent[_pageKey]) {
        _helpContent[_pageKey] = { _pageName: _pageName || _pageKey, elements: {} };
      }
    });
  }

  function _detectPage() {
    var el = document.querySelector('[data-help-page]');
    if (el) {
      _pageKey = el.getAttribute('data-help-page');
      _pageName = el.getAttribute('data-help-page-name') || _pageKey;
    }
  }

  function setPage(key, name) {
    _pageKey = key;
    _pageName = name || key;
    if (active) {
      _updatePanel();
    }
  }

  function getPageKey() { return _pageKey; }
  function getPageName() { return _pageName; }

  /*
   * Sidens egne punkter + eventuelle delte sæt.
   *
   * Delte komponenter (modal, bon-kort, indkøbs-chips) optræder på mange sider.
   * Uden dette skulle deres hjælpetekster kopieres ind under hver eneste
   * sidenøgle — og så driver kopierne fra hinanden, præcis som hjælpetekster
   * plejer. En side skriver i stedet "_include": ["modal"], og teksterne bor ét
   * sted under "_shared".
   *
   * Sidens egne punkter vinder ved navnesammenfald, så en side kan skrive en
   * delt tekst om uden at røre de andre. MapMode gemmer altid i sidens egne
   * elements — den kan ikke komme til at overskrive et delt sæt.
   */
  function getPageContent() {
    if (!_pageKey || !_helpContent[_pageKey]) return {};
    var page = _helpContent[_pageKey];
    var own = page.elements || {};
    var include = page._include;
    if (!include || !include.length) return own;

    var shared = _helpContent._shared || {};
    var merged = {};
    include.forEach(function(name) {
      var set = shared[name];
      if (!set) return;
      Object.keys(set).forEach(function(k) { merged[k] = set[k]; });
    });
    Object.keys(own).forEach(function(k) { merged[k] = own[k]; });
    return merged;
  }

  function toggle() { active ? hide() : show(); }

  function show() {
    _helpLoadContent().then(function() {
      active = true;
      document.getElementById('help-overlay').classList.add('visible');
      document.getElementById('help-panel').classList.add('visible');
      document.getElementById('help-hint').classList.add('active');
      _updatePanel();
    });
  }

  function hide() {
    active = false;
    document.getElementById('help-overlay').classList.remove('visible');
    document.getElementById('help-panel').classList.remove('visible');
    document.getElementById('help-hint').classList.remove('active');
    _removeBadges();
    hideTooltip();
  }

  function _updatePanel() {
    document.getElementById('help-page-name-label').textContent = _pageName || '—';
    _renderPanel();
    _placeBadges();
  }

  /*
   * Er elementet faktisk fremme på skærmen?
   *
   * querySelector finder også skjulte elementer, og flere flader mountes
   * permanent i DOM'en og skjules med display:none — bon-draweren ligger fx
   * i office-shellen hele tiden. Uden denne test dukkede drawerens syv punkter
   * op på hver eneste office-side, også når draweren slet ikke var åben.
   *
   * getClientRects() frem for offsetParent: draweren og modalerne er
   * position:fixed, og dér er offsetParent null selv når de ER synlige.
   */
  function _isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    // display:none / detached → ingen rects og nul areal
    if (!el.getClientRects().length) return false;
    // Højde 0 = viser intet (fx flag-strippen uden påmindelser).
    if (r.height === 0) return false;
    // Bredde 0 bruges IKKE som skjulthedskriterium. Et browservindue kan
    // rapportere bredde 0 for hele siden (kollapset/baggrundsfane), og så ville
    // hver eneste hjælpetekst forsvinde. Ingen hjælp er værre end lidt for
    // meget hjælp — så ved bredde 0 antager vi synlig og springer
    // positions-testen over, for den kan alligevel ikke beregnes.
    // Lukkede paneler parkeres uden for skærmen vandret (transform:
    // translateX(100%) — bon-draweren, indkøbsindstillinger). De har både
    // rects og areal, så kun positionen afslører dem.
    //
    // Kun VANDRET: noget under fold'en er legitimt på siden, og hjælpen skal
    // kunne pege på det (klik i panelet scroller derhen).
    // clientWidth FØRST: innerWidth tæller scrollbaren med, så et panel parkeret
    // på translateX(100%) lander ~15px inde i "viewporten" og slap igennem.
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    if (vw && r.width && (r.right <= 0 || r.left >= vw)) return false;
    return true;
  }

  /* Første SYNLIGE match for en selector — ikke bare første match. */
  function _findVisible(selector) {
    var list;
    try { list = document.querySelectorAll(selector); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) {
      if (_isVisible(list[i])) return list[i];
    }
    return null;
  }

  function _renderPanel() {
    var body = document.getElementById('help-panel-body');
    var content = getPageContent();
    var keys = Object.keys(content);

    // Filtrér til elementer der faktisk er SYNLIGE på siden
    var entries = [];
    var n = 0;
    keys.forEach(function(key) {
      var entry = content[key];
      var el = _findVisible(entry.selector);
      if (el) {
        n++;
        entries.push({ key: key, num: n, el: el, label: entry.label, text: entry.text, selector: entry.selector });
      }
    });

    // Vælg side FØR badges placeres, så et auto-flip ikke får dem til at hoppe.
    _applyDock(_savedDock() || _autoDock(entries));

    if (!entries.length) {
      body.innerHTML = '<div class="help-empty">Ingen hjælpetekster på denne side endnu.<br><br>' +
        '<span style="font-size:12px;color:#aaa">Tryk <strong>Ctrl+Shift+H</strong> for at tilføje.</span></div>';
      return;
    }

    body.innerHTML = entries.map(function(e) {
      return '<div class="help-entry" onclick="HelpSystem.scrollTo(\'' + _escAttr(e.selector) + '\')">' +
        '<div class="help-num">' + e.num + '</div>' +
        '<div class="help-entry-content">' +
          '<div class="help-entry-label">' + _esc(e.label) + '</div>' +
          '<div class="help-entry-text">' + _esc(e.text) + '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function _placeBadges() {
    _removeBadges();
    var content = getPageContent();
    var n = 0;
    Object.keys(content).forEach(function(key) {
      var entry = content[key];
      var el = _findVisible(entry.selector);
      if (!el) return;
      n++;
      if (window.getComputedStyle(el).position === 'static') el.style.position = 'relative';
      el.classList.add('help-highlight');
      var badge = document.createElement('div');
      badge.className = 'help-badge';
      badge.textContent = n;
      badge.style.animationDelay = (n * 25) + 'ms';
      el.appendChild(badge);
      badges.push({ el: el, badge: badge });
    });
  }

  function _removeBadges() {
    badges.forEach(function(b) {
      b.badge.remove();
      b.el.classList.remove('help-highlight');
      b.el.style.position = '';
    });
    badges = [];
  }

  function scrollTo(selector) {
    var el = _findVisible(selector);
    if (!el) return;
    // På mobil dækker panelet hele skærmen, så at scrolle til et element bag
    // det er meningsløst. Luk panelet og vis elementet — man kan altid trykke
    // ? igen. På desktop bliver panelet stående ved siden af.
    if (document.body.classList.contains('zone-mobile')) hide();
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    var orig = el.style.outlineColor;
    el.style.outlineColor = '#fff';
    setTimeout(function() { el.style.outlineColor = orig; }, 350);
  }

  function _showTooltipForEl(e) {
    // Find nærmeste element der har en help-entry
    var content = getPageContent();
    var target = e.target;
    // Walk up to find a matched element
    while (target && target !== document.body) {
      for (var key in content) {
        var entry = content[key];
        try {
          if (target.matches(entry.selector)) {
            _showTooltip(e, entry);
            return;
          }
        } catch(err) {}
      }
      target = target.parentElement;
    }
  }

  function _showTooltip(e, data) {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(function() {
      document.getElementById('help-tooltip-label').textContent = data.label;
      document.getElementById('help-tooltip-text').textContent = data.text;
      var top = e.clientY + 15;
      var left = e.clientX;
      if (top + 120 > window.innerHeight) top = e.clientY - 128;
      if (left + 270 > window.innerWidth - 380) left = window.innerWidth - 660;
      if (left < 10) left = 10;
      tooltip.style.top = top + 'px';
      tooltip.style.left = left + 'px';
      tooltip.classList.add('visible');
    }, 200);
  }

  function hideTooltip() {
    clearTimeout(tooltipTimeout);
    if (tooltip) tooltip.classList.remove('visible');
  }

  function refresh() {
    if (!active) return;
    _updatePanel();
  }

  /* ── Dock: hvilken side panelet ligger i ──────────────────
   *
   * Panelet dækkede det det forklarede. Værst når dét man kigger på SELV er
   * et højre-panel — bon-draweren ligger lige under hjælpen, og så er både
   * badges og felter usynlige.
   *
   * Løsningen er ikke at gøre panelet smallere; det er at lægge det i den
   * side hvor der ikke er noget at se. Siden vælges ud fra hvor de omtalte
   * elementer faktisk ligger, og kan altid vendes i hånden med ⇄.
   */
  var DOCK_KEY = 'bon_v2_help_dock';

  function _savedDock() {
    try {
      var v = localStorage.getItem(DOCK_KEY);
      return (v === 'left' || v === 'right') ? v : null;
    } catch (e) { return null; }
  }

  /*
   * Vælg den side der skjuler mindst. Begge sider vurderes — ikke kun den ene,
   * for der findes sider hvor begge er dårlige og man skal tage den mindst
   * ringe (køkkenets kort fylder hele bredden).
   *
   * Et element tælles kun som skjult hvis panelet dækker det MESTE af det.
   * Ellers ville et grid der spænder hele skærmen tælle med hver gang, selv om
   * det stadig er fint læsbart med 360px dækket i den ene side.
   */
  var PANEL_W = 360;
  var SKJULT_ANDEL = 0.6;

  function _skjulteVed(entries, side, vw) {
    var zoneStart = (side === 'right') ? vw - PANEL_W : 0;
    var zoneSlut  = (side === 'right') ? vw : PANEL_W;
    var n = 0;
    entries.forEach(function(e) {
      var r = e.el.getBoundingClientRect();
      if (!r.width) return;
      var overlap = Math.min(r.right, zoneSlut) - Math.max(r.left, zoneStart);
      if (overlap > 0 && (overlap / r.width) > SKJULT_ANDEL) n++;
    });
    return n;
  }

  function _autoDock(entries) {
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    if (!vw || !entries.length) return 'right';
    // Uafgjort → højre: det er den vante side, og et skift skal have en grund.
    return _skjulteVed(entries, 'left', vw) < _skjulteVed(entries, 'right', vw) ? 'left' : 'right';
  }

  function _applyDock(side) {
    _dock = side;
    var panel = document.getElementById('help-panel');
    if (panel) panel.classList.toggle('dock-left', side === 'left');
  }

  function flipDock() {
    var side = _dock === 'left' ? 'right' : 'left';
    try { localStorage.setItem(DOCK_KEY, side); } catch (e) { /* privat browsing */ }
    _applyDock(side);
  }

  function isActive() { return active; }

  function _esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function _escAttr(s) { return (s || '').replace(/'/g, "\\'").replace(/"/g, '&quot;'); }

  return {
    init: init, show: show, hide: hide, toggle: toggle,
    setPage: setPage, getPageKey: getPageKey, getPageName: getPageName,
    getPageContent: getPageContent, scrollTo: scrollTo,
    refresh: refresh, isActive: isActive, flipDock: flipDock
  };
})();

/* ══════════════════════════════════════════════════════════
   MAP MODE — kortlægningstilstand
   ══════════════════════════════════════════════════════════ */
var MapMode = (function() {
  var active = false;
  var targetEl = null;
  var targetSelector = '';

  function toggle() { active ? stop() : start(); }
  function isActive() { return active; }

  function start() {
    _helpLoadContent().then(function() {
      active = true;
      if (HelpSystem.isActive()) HelpSystem.hide();
      document.getElementById('map-banner').classList.add('visible');
      document.getElementById('help-hint').classList.add('map-mode');
      document.getElementById('help-hint').classList.remove('active');
      _markElements();
      document.addEventListener('click', _onMapClick, true);
    });
  }

  function stop() {
    active = false;
    document.getElementById('map-banner').classList.remove('visible');
    document.getElementById('help-hint').classList.remove('map-mode');
    closePopup();
    _unmarkElements();
    document.removeEventListener('click', _onMapClick, true);
  }

  function _markElements() {
    _unmarkElements();
    var content = HelpSystem.getPageContent();
    var mappedSelectors = {};
    for (var key in content) {
      if (content[key].selector) mappedSelectors[content[key].selector] = true;
    }

    // Find alle interaktive elementer
    var candidates = document.querySelectorAll(
      'button, input, select, a, [onclick], [class*="btn"], [class*="card"], [class*="toggle"], [class*="filter"], [class*="tab"]'
    );
    candidates.forEach(function(el) {
      // Skip hjælpesystemets egne elementer
      if (el.closest('#help-system-root')) return;
      if (el.closest('#help-panel')) return;

      var sel = _helpGenSelector(el);
      if (mappedSelectors[sel]) {
        el.classList.add('map-mapped');
      } else {
        el.classList.add('map-mappable');
      }
    });
  }

  function _unmarkElements() {
    document.querySelectorAll('.map-mappable, .map-mapped').forEach(function(el) {
      el.classList.remove('map-mappable', 'map-mapped');
    });
  }

  function _onMapClick(e) {
    var popup = document.getElementById('map-popup');
    if (popup.contains(e.target)) return;
    if (e.target.closest('#help-system-root') && !e.target.closest('#help-hint')) return;

    e.preventDefault();
    e.stopPropagation();

    var el = e.target.closest('.map-mappable, .map-mapped, button, [class*="btn"], [class*="card"]');
    if (!el || el.closest('#help-system-root')) return;

    targetEl = el;
    targetSelector = _helpGenSelector(el);

    // Check om elementet allerede er mappet
    var content = HelpSystem.getPageContent();
    var existing = null;
    var existingKey = '';
    for (var key in content) {
      if (content[key].selector === targetSelector) {
        existing = content[key];
        existingKey = key;
        break;
      }
    }

    document.getElementById('popup-selector-preview').textContent = targetSelector;
    document.getElementById('popup-key').value = existingKey;
    document.getElementById('popup-label').value = existing ? existing.label : '';
    document.getElementById('popup-text').value = existing ? existing.text : '';
    _helpUpdateKeyPreview();

    // Positionér popup
    var rect = el.getBoundingClientRect();
    var top = rect.bottom + 10;
    var left = rect.left;
    if (top + 320 > window.innerHeight) top = Math.max(10, rect.top - 340);
    if (left + 350 > window.innerWidth) left = window.innerWidth - 360;
    if (left < 10) left = 10;
    popup.style.top = top + 'px';
    popup.style.left = left + 'px';
    popup.classList.add('visible');
    document.getElementById('popup-key').focus();
  }

  function closePopup() {
    document.getElementById('map-popup').classList.remove('visible');
    targetEl = null;
    targetSelector = '';
  }

  function saveEntry() {
    var key = document.getElementById('popup-key').value.trim();
    var label = document.getElementById('popup-label').value.trim();
    var text = document.getElementById('popup-text').value.trim();
    if (!key || !label || !text) { alert('Alle felter skal udfyldes.'); return; }

    var pageKey = HelpSystem.getPageKey();
    if (!pageKey) { alert('Ingen side registreret (mangler data-help-page).'); return; }

    if (!_helpContent[pageKey]) {
      _helpContent[pageKey] = { _pageName: HelpSystem.getPageName(), elements: {} };
    }
    if (!_helpContent[pageKey].elements) _helpContent[pageKey].elements = {};

    _helpContent[pageKey].elements[key] = {
      selector: targetSelector,
      label: label,
      text: text
    };

    // Gem til server
    _helpSaveContent().then(function() {
      if (targetEl) {
        targetEl.classList.remove('map-mappable');
        targetEl.classList.add('map-mapped');
      }
      closePopup();

      // Bekræftelse i banner
      var banner = document.getElementById('map-banner');
      var orig = banner.innerHTML;
      banner.innerHTML = '<div class="map-banner-dot" style="background:#6abf69"></div> "' + label + '" gemt';
      setTimeout(function() { banner.innerHTML = orig; }, 2000);
    }).catch(function(err) {
      alert('Kunne ikke gemme: ' + err.message);
    });
  }

  return { toggle: toggle, start: start, stop: stop, isActive: isActive, closePopup: closePopup, saveEntry: saveEntry };
})();

/* ══════════════════════════════════════════════════════════
   AUTO-INIT
   ══════════════════════════════════════════════════════════ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { HelpSystem.init(); });
} else {
  HelpSystem.init();
}
