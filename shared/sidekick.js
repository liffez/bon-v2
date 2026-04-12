/**
 * shared/sidekick.js
 * ════════════════════════════════════════════════════════════
 * Whiteboard Sidekick — tre-trins overlay i Bon v2 kitchen-zone.
 *
 * Trin 1: Flydende ikon med badge (antal uafsluttede opgaver)
 * Trin 2: Sidepanel (300px) — dagens opgaver, hurtig-tilføj, beskeder
 * Trin 3: Fuld skærm — lister, alle opgaver, beskeder, vagtplan
 *
 * API-kald går til WHITEBOARD_BASE_URL (cross-origin).
 * Config hentes fra /api/sidekick/config.
 * Degraderer lydløst ved manglende config eller API-fejl.
 * ════════════════════════════════════════════════════════════
 */

var _sk = {
  ok: false,
  mode: 'icon',       // 'icon' | 'panel' | 'full'
  tasks: [],
  lists: [],
  messages: [],
  users: [],
  shifts: [],
  activeList: null,    // list_id for fuld-visning filter
  undo: null,          // { id, title, timer }
  config: { whiteboardBase: '', sopBase: '' },
  pollTimer: null,
  initDone: false
};

/* ══════════════════════════════════════════════════════════
   API HELPERS
   ══════════════════════════════════════════════════════════ */
function _skFetch(path) {
  if (!_sk.config.whiteboardBase) return Promise.reject(new Error('No config'));
  return fetch(_sk.config.whiteboardBase + path, {
    credentials: 'include',
    headers: { 'Accept': 'application/json' }
  }).then(function(r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
}

function _skPost(path, body) {
  if (!_sk.config.whiteboardBase) return Promise.reject(new Error('No config'));
  return fetch(_sk.config.whiteboardBase + path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
}

function _skPatch(path, body) {
  if (!_sk.config.whiteboardBase) return Promise.reject(new Error('No config'));
  return fetch(_sk.config.whiteboardBase + path, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });
}

/* ══════════════════════════════════════════════════════════
   DATA LOADING
   ══════════════════════════════════════════════════════════ */
function _skLoadAll() {
  var today = new Date().toISOString().slice(0, 10);
  return Promise.all([
    _skFetch('/api/tasks?date=' + today).catch(function() { return []; }),
    _skFetch('/api/tasks/lists').catch(function() { return []; }),
    _skFetch('/api/board/messages?limit=20').catch(function() { return { messages: [] }; }),
    _skFetch('/api/users').catch(function() { return []; }),
    _skFetch('/api/smartplan/today').catch(function() { return []; })
  ]).then(function(results) {
    _sk.tasks = results[0] || [];
    _sk.lists = results[1] || [];
    _sk.messages = (results[2] && results[2].messages) ? results[2].messages : (Array.isArray(results[2]) ? results[2] : []);
    _sk.users = results[3] || [];
    _sk.shifts = results[4] || [];
    _sk.ok = true;
    _skUpdateBadge();
    if (_sk.mode === 'panel') _skRenderPanel();
    if (_sk.mode === 'full') _skRenderFull();
  }).catch(function() {
    _sk.ok = false;
    _skUpdateBadge();
  });
}

/* ══════════════════════════════════════════════════════════
   POLLING
   ══════════════════════════════════════════════════════════ */
function _skStartPolling() {
  _skStopPolling();
  _sk.pollTimer = setInterval(function() {
    if (_sk.mode !== 'icon') _skLoadAll();
  }, 30000);
}

function _skStopPolling() {
  if (_sk.pollTimer) { clearInterval(_sk.pollTimer); _sk.pollTimer = null; }
}

/* ══════════════════════════════════════════════════════════
   DOM INJECTION
   ══════════════════════════════════════════════════════════ */
function _skInjectDOM() {
  if (document.getElementById('sk-icon')) return;

  var html = '' +
    // Ikon
    '<div class="sk-icon" id="sk-icon" title="Whiteboard (opgaver)">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>' +
      '<div class="sk-badge" id="sk-badge">0</div>' +
    '</div>' +

    // Panel
    '<div class="sk-panel" id="sk-panel">' +
      '<div class="sk-panel-header">' +
        '<div class="sk-panel-title">' +
          '<div class="sk-status-dot" id="sk-dot"></div>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="8" y1="10" x2="16" y2="10"/><line x1="8" y1="14" x2="12" y2="14"/></svg>' +
          ' Tavle' +
        '</div>' +
        '<div class="sk-panel-actions">' +
          '<button class="sk-panel-btn" id="sk-expand" title="Fuld skærm">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>' +
          '</button>' +
          '<button class="sk-panel-btn" id="sk-close" title="Luk">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="sk-panel-body" id="sk-panel-body"></div>' +
      '<div class="sk-quick-add">' +
        '<input class="sk-quick-input" id="sk-quick-input" placeholder="Hurtig opgave...">' +
        '<button class="sk-quick-btn" id="sk-quick-btn">+</button>' +
      '</div>' +
    '</div>' +

    // Full overlay
    '<div class="sk-full" id="sk-full">' +
      '<div class="sk-full-header">' +
        '<div class="sk-full-title" id="sk-full-title">Tavle</div>' +
        '<button class="sk-full-close" id="sk-full-close">Tilbage til Bon</button>' +
      '</div>' +
      '<div class="sk-shift-bar" id="sk-shift-bar"></div>' +
      '<div class="sk-full-body">' +
        '<div class="sk-full-sidebar" id="sk-full-sidebar"></div>' +
        '<div class="sk-full-main" id="sk-full-main"></div>' +
        '<div class="sk-full-messages" id="sk-full-messages"></div>' +
      '</div>' +
    '</div>' +

    // Fortryd toast
    '<div class="sk-undo-toast" id="sk-undo-toast">' +
      '<span id="sk-undo-text">Opgave afsluttet</span>' +
      '<button class="sk-undo-btn" id="sk-undo-btn">Fortryd</button>' +
    '</div>';

  var container = document.createElement('div');
  container.id = 'sk-root';
  container.innerHTML = html;
  document.body.appendChild(container);

  // Wire events
  document.getElementById('sk-icon').addEventListener('click', function() { _skSetMode('panel'); });
  document.getElementById('sk-close').addEventListener('click', function() { _skSetMode('icon'); });
  document.getElementById('sk-expand').addEventListener('click', function() { _skSetMode('full'); });
  document.getElementById('sk-full-close').addEventListener('click', function() { _skSetMode('panel'); });
  document.getElementById('sk-undo-btn').addEventListener('click', _skUndo);

  document.getElementById('sk-quick-btn').addEventListener('click', _skQuickAdd);
  document.getElementById('sk-quick-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') _skQuickAdd();
  });

  // Escape lukker
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (_sk.mode === 'full') _skSetMode('panel');
      else if (_sk.mode === 'panel') _skSetMode('icon');
    }
  });
}

/* ══════════════════════════════════════════════════════════
   MODE SWITCHING
   ══════════════════════════════════════════════════════════ */
function _skSetMode(mode) {
  var prev = _sk.mode;
  _sk.mode = mode;

  var icon = document.getElementById('sk-icon');
  var panel = document.getElementById('sk-panel');
  var full = document.getElementById('sk-full');
  if (!icon) return;

  // Reset
  icon.classList.remove('visible');
  panel.classList.remove('visible');
  full.classList.remove('visible');

  // Bon shrink
  var mainContent = document.querySelector('.cards-grid, .today-content, .dash-grid');
  if (mainContent) {
    mainContent.classList.remove('sidekick-shrunk');
  }

  switch (mode) {
    case 'icon':
      icon.classList.add('visible');
      _skStopPolling();
      break;
    case 'panel':
      panel.classList.add('visible');
      icon.classList.remove('visible');
      if (mainContent) mainContent.classList.add('sidekick-shrunk');
      if (prev === 'icon') _skLoadAll();
      _skRenderPanel();
      _skStartPolling();
      break;
    case 'full':
      full.classList.add('visible');
      icon.classList.remove('visible');
      panel.classList.remove('visible');
      if (mainContent) mainContent.classList.remove('sidekick-shrunk');
      _skRenderFull();
      _skStartPolling();
      break;
  }
}

/* ══════════════════════════════════════════════════════════
   BADGE
   ══════════════════════════════════════════════════════════ */
function _skUpdateBadge() {
  var badge = document.getElementById('sk-badge');
  var dot = document.getElementById('sk-dot');
  if (!badge) return;

  var count = _sk.tasks.filter(function(t) { return t.status !== 'done'; }).length;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'flex' : 'none';
  badge.className = 'sk-badge' + (count > 3 ? ' alert' : '');

  if (dot) {
    dot.className = 'sk-status-dot' + (_sk.ok ? '' : ' error');
  }
}

/* ══════════════════════════════════════════════════════════
   PANEL RENDERING
   ══════════════════════════════════════════════════════════ */
function _skRenderPanel() {
  var body = document.getElementById('sk-panel-body');
  if (!body) return;

  if (!_sk.ok) {
    body.innerHTML = '<div class="sk-offline">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
      '<div>Ikke forbundet til Whiteboard</div>' +
      '<div style="font-size:11px;margin-top:4px;color:#bbb">Tjek WHITEBOARD_BASE_URL</div>' +
    '</div>';
    return;
  }

  var active = _sk.tasks.filter(function(t) { return t.status !== 'done'; });
  var done = _sk.tasks.filter(function(t) { return t.status === 'done'; });

  var html = '';

  // Aktive opgaver
  html += '<div class="sk-section-label">I dag — ' + active.length + ' opgaver</div>';
  active.forEach(function(t) { html += _skTaskHtml(t); });

  // Afsluttede (foldet)
  if (done.length) {
    html += '<div class="sk-section-label" style="opacity:0.5">Afsluttet — ' + done.length + '</div>';
    done.forEach(function(t) { html += _skTaskHtml(t); });
  }

  // Beskeder
  if (_sk.messages.length) {
    html += '<div class="sk-section-label">Beskeder</div>';
    _sk.messages.slice(0, 5).forEach(function(m) {
      html += '<div class="sk-msg">' +
        '<div class="sk-msg-author">' + _skEsc(m.author || m.user || '?') + ' — ' + _skFormatTime(m.created_at) + '</div>' +
        '<div class="sk-msg-text">' + _skEsc(m.content || m.text || '') + '</div>' +
      '</div>';
    });
  }

  body.innerHTML = html;

  // Wire task clicks
  body.querySelectorAll('.sk-check').forEach(function(check) {
    check.addEventListener('click', function(e) {
      e.stopPropagation();
      var id = parseInt(this.closest('.sk-task').dataset.taskId);
      _skToggleTask(id);
    });
  });
}

function _skTaskHtml(t) {
  var isDone = t.status === 'done';
  var tags = '';
  if (t.sop_title || t.sop_file_id) tags += '<span class="sk-tag sop">SOP</span>';
  if (t.repeat_rule) tags += '<span class="sk-tag repeat">Gentag</span>';
  if (t.due_date && !isDone) {
    var due = new Date(t.due_date);
    var now = new Date();
    now.setHours(0,0,0,0);
    if (due < now) tags += '<span class="sk-tag overdue">Forfalden</span>';
  }
  var timeStr = t.due_time || (t.due_date ? t.due_date.slice(11, 16) : '');
  if (timeStr && timeStr !== '00:00') tags += '<span class="sk-tag">' + timeStr + '</span>';

  // Liste-farve
  var list = _sk.lists.find(function(l) { return l.id === t.list_id; });
  if (list) tags += '<span class="sk-tag" style="border-left:3px solid ' + (list.color || '#999') + '">' + _skEsc(list.title || list.name || '') + '</span>';

  return '<div class="sk-task' + (isDone ? ' done' : '') + '" data-task-id="' + t.id + '">' +
    '<div class="sk-check">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
    '</div>' +
    '<div class="sk-task-info">' +
      '<div class="sk-task-title">' + _skEsc(t.title) + '</div>' +
      (tags ? '<div class="sk-task-meta">' + tags + '</div>' : '') +
    '</div>' +
  '</div>';
}

/* ══════════════════════════════════════════════════════════
   FULL SCREEN RENDERING
   ══════════════════════════════════════════════════════════ */
function _skRenderFull() {
  _skRenderFullSidebar();
  _skRenderFullMain();
  _skRenderFullMessages();
  _skRenderShiftBar();

  var d = new Date();
  var days = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
  var months = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];
  var titleEl = document.getElementById('sk-full-title');
  if (titleEl) titleEl.textContent = 'Tavle — ' + days[d.getDay()] + ' ' + d.getDate() + '. ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function _skRenderFullSidebar() {
  var el = document.getElementById('sk-full-sidebar');
  if (!el) return;

  // "Alle" item
  var allCount = _sk.tasks.filter(function(t) { return t.status !== 'done'; }).length;
  var html = '<div class="sk-sidebar-item' + (_sk.activeList === null ? ' active' : '') + '" data-list-id="all">' +
    'Alle <span class="sk-sidebar-count">' + allCount + '</span></div>';

  _sk.lists.forEach(function(l) {
    var count = _sk.tasks.filter(function(t) { return t.list_id === l.id && t.status !== 'done'; }).length;
    html += '<div class="sk-sidebar-item' + (_sk.activeList === l.id ? ' active' : '') + '" data-list-id="' + l.id + '"' +
      ' style="border-left-color:' + (l.color || 'transparent') + '">' +
      _skEsc(l.title || l.name || '?') + ' <span class="sk-sidebar-count">' + count + '</span></div>';
  });

  el.innerHTML = html;

  el.querySelectorAll('.sk-sidebar-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var id = this.dataset.listId;
      _sk.activeList = id === 'all' ? null : parseInt(id);
      _skRenderFullSidebar();
      _skRenderFullMain();
    });
  });
}

function _skRenderFullMain() {
  var el = document.getElementById('sk-full-main');
  if (!el) return;

  var filtered = _sk.tasks;
  if (_sk.activeList !== null) {
    filtered = _sk.tasks.filter(function(t) { return t.list_id === _sk.activeList; });
  }

  var active = filtered.filter(function(t) { return t.status !== 'done'; });
  var done = filtered.filter(function(t) { return t.status === 'done'; });

  var listName = 'Alle opgaver';
  if (_sk.activeList !== null) {
    var list = _sk.lists.find(function(l) { return l.id === _sk.activeList; });
    if (list) listName = list.title || list.name || '?';
  }

  var html = '<div class="sk-full-main-title">' + _skEsc(listName) + ' — ' + active.length + ' aktive</div>';
  active.forEach(function(t) { html += _skTaskHtml(t); });

  if (done.length) {
    html += '<div class="sk-section-label" style="margin-top:16px;opacity:0.5">Afsluttet — ' + done.length + '</div>';
    done.forEach(function(t) { html += _skTaskHtml(t); });
  }

  el.innerHTML = html;

  el.querySelectorAll('.sk-check').forEach(function(check) {
    check.addEventListener('click', function(e) {
      e.stopPropagation();
      var id = parseInt(this.closest('.sk-task').dataset.taskId);
      _skToggleTask(id);
    });
  });
}

function _skRenderFullMessages() {
  var el = document.getElementById('sk-full-messages');
  if (!el) return;

  var html = '<div class="sk-full-msg-label">Tavle-beskeder</div>';
  if (!_sk.messages.length) {
    html += '<div style="font-size:13px;color:var(--wb-text-dim)">Ingen beskeder</div>';
  }
  _sk.messages.forEach(function(m) {
    html += '<div class="sk-msg">' +
      '<div class="sk-msg-author">' + _skEsc(m.author || m.user || '?') + ' — ' + _skFormatTime(m.created_at) + '</div>' +
      '<div class="sk-msg-text">' + _skEsc(m.content || m.text || '') + '</div>' +
    '</div>';
  });

  el.innerHTML = html;
}

function _skRenderShiftBar() {
  var el = document.getElementById('sk-shift-bar');
  if (!el) return;

  if (!_sk.shifts.length) {
    el.style.display = 'none';
    return;
  }

  el.style.display = 'flex';
  var html = '<span style="font-weight:600">På vagt:</span>';
  _sk.shifts.forEach(function(s) {
    var name = s.first_name || s.employee_name || '?';
    var initial = name.charAt(0).toUpperCase();
    var from = (s.start || '').slice(11, 16);
    var to = (s.end || '').slice(11, 16);
    html += '<div class="sk-shift-person">' +
      '<div class="sk-shift-avatar">' + initial + '</div>' +
      '<span class="sk-shift-name">' + _skEsc(name) + '</span>' +
      (from ? '<span class="sk-shift-time">(' + from + '–' + to + ')</span>' : '') +
    '</div>';
  });

  el.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════
   TASK ACTIONS
   ══════════════════════════════════════════════════════════ */
function _skToggleTask(id) {
  var task = _sk.tasks.find(function(t) { return t.id === id; });
  if (!task) return;

  if (task.status === 'done') {
    // Genåbn
    task.status = 'todo';
    _skPatch('/api/tasks/' + id, { status: 'todo' }).catch(function() {});
    _skRefreshViews();
    return;
  }

  // Afslut med fortryd
  var origStatus = task.status;
  task.status = 'done';
  _skRefreshViews();

  // Vis fortryd-toast
  var toast = document.getElementById('sk-undo-toast');
  var text = document.getElementById('sk-undo-text');
  if (toast && text) {
    text.textContent = '"' + task.title + '" afsluttet';
    toast.classList.add('visible');
  }

  // Cancel evt. eksisterende undo
  if (_sk.undo && _sk.undo.timer) clearTimeout(_sk.undo.timer);

  _sk.undo = {
    id: id,
    origStatus: origStatus,
    timer: setTimeout(function() {
      // Commit til server
      _skPost('/api/tasks/' + id + '/complete', { user: 'Køkken' }).catch(function() {});
      _sk.undo = null;
      if (toast) toast.classList.remove('visible');
    }, 8000)
  };
}

function _skUndo() {
  if (!_sk.undo) return;
  var task = _sk.tasks.find(function(t) { return t.id === _sk.undo.id; });
  if (task) task.status = _sk.undo.origStatus || 'todo';
  clearTimeout(_sk.undo.timer);
  _sk.undo = null;

  var toast = document.getElementById('sk-undo-toast');
  if (toast) toast.classList.remove('visible');

  _skRefreshViews();
}

function _skRefreshViews() {
  _skUpdateBadge();
  if (_sk.mode === 'panel') _skRenderPanel();
  if (_sk.mode === 'full') { _skRenderFullMain(); _skRenderFullSidebar(); }
}

/* ══════════════════════════════════════════════════════════
   QUICK ADD
   ══════════════════════════════════════════════════════════ */
function _skQuickAdd() {
  var input = document.getElementById('sk-quick-input');
  if (!input) return;
  var title = input.value.trim();
  if (!title) return;

  // Find første liste (eller brug null)
  var listId = _sk.lists.length ? _sk.lists[0].id : null;

  // Optimistisk UI
  var tempTask = {
    id: -Date.now(),
    title: title,
    status: 'todo',
    list_id: listId,
    due_date: new Date().toISOString().slice(0, 10)
  };
  _sk.tasks.unshift(tempTask);
  input.value = '';
  _skRefreshViews();

  // Server
  _skPost('/api/tasks', {
    title: title,
    list_id: listId,
    due_date: new Date().toISOString().slice(0, 10),
    user: 'Køkken'
  }).then(function(created) {
    // Erstat temp med rigtig
    var idx = _sk.tasks.indexOf(tempTask);
    if (idx >= 0 && created) _sk.tasks[idx] = created;
    _skRefreshViews();
  }).catch(function() {
    // Fjern temp ved fejl
    var idx = _sk.tasks.indexOf(tempTask);
    if (idx >= 0) _sk.tasks.splice(idx, 1);
    _skRefreshViews();
  });
}

/* ══════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════ */
function _skEsc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function _skFormatTime(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  var h = d.getHours();
  var m = d.getMinutes();
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

/* ══════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════ */
function initSidekick() {
  if (_sk.initDone) return;
  _sk.initDone = true;

  // Hent config
  fetch('/api/sidekick/config').then(function(r) {
    return r.json();
  }).then(function(cfg) {
    if (!cfg.whiteboardBase) return; // Ikke konfigureret — degradér lydløst
    _sk.config = cfg;

    // Injicer DOM og vis ikon
    _skInjectDOM();
    document.getElementById('sk-icon').classList.add('visible');

    // Hent initial data (for badge)
    _skLoadAll();
  }).catch(function() {
    // Config fejlede — ingen sidekick
  });
}

// Auto-init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSidekick);
} else {
  initSidekick();
}
