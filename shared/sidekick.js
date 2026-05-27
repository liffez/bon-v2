/**
 * shared/sidekick.js
 * ════════════════════════════════════════════════════════════
 * Whiteboard Sidekick — to-trins overlay i Bon v2 kitchen-zone.
 *
 * Trin 1: Flydende ikon med badge (antal uafsluttede opgaver)
 * Trin 2: Sidepanel (320px) — dagens opgaver, hurtig-tilføj, beskeder
 * "Åbn Whiteboard"-knap i panelet åbner den rigtige app i ny fane.
 *
 * API-kald går til WHITEBOARD_BASE_URL (cross-origin).
 * Config hentes fra /api/sidekick/config.
 * Degraderer lydløst ved manglende config eller API-fejl.
 * ════════════════════════════════════════════════════════════
 */

var _sk = {
  ok: false,
  mode: 'icon',       // 'icon' | 'panel'
  visible: true,      // Pages kan kalde Sidekick.setVisible(false) for at skjule
  tasks: [],
  lists: [],
  messages: [],
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
  // Hent alle tasks (Whiteboard filtrerer daglige ud ved date=)
  // Sidekick filtrerer client-side: i dag + forfaldne + uden dato
  return Promise.all([
    _skFetch('/api/tasks').catch(function() { return []; }),
    _skFetch('/api/tasks/lists').catch(function() { return []; }),
    _skFetch('/api/board/messages?limit=20').catch(function() { return { messages: [] }; })
  ]).then(function(results) {
    var allTasks = results[0] || [];
    var todayStr = new Date().toISOString().slice(0, 10);
    _sk.tasks = allTasks.filter(function(t) {
      if (!t.due_date) return false;
      var d = t.due_date.slice(0, 10);
      if (d === todayStr) return true;
      if (d < todayStr && t.status !== 'done') return true;
      return false;
    });
    _sk.lists = results[1] || [];
    _sk.messages = (results[2] && results[2].messages) ? results[2].messages : (Array.isArray(results[2]) ? results[2] : []);
    _sk.ok = true;
    _skUpdateBadge();
    if (_sk.mode === 'panel') _skRenderPanel();
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
          '<button class="sk-panel-btn" id="sk-expand" title="Åbn Whiteboard i ny fane">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
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
  document.getElementById('sk-expand').addEventListener('click', function() {
    if (_sk.config.whiteboardBase) {
      window.open(_sk.config.whiteboardBase, '_blank', 'noopener');
    }
  });
  document.getElementById('sk-undo-btn').addEventListener('click', _skUndo);

  document.getElementById('sk-quick-btn').addEventListener('click', _skQuickAdd);
  document.getElementById('sk-quick-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') _skQuickAdd();
  });

  // Escape lukker
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && _sk.mode === 'panel') _skSetMode('icon');
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
  if (!icon) return;

  icon.classList.remove('visible');
  panel.classList.remove('visible');

  var mainContent = document.querySelector('.cards-grid, .today-content, .dash-grid');
  if (mainContent) {
    mainContent.classList.remove('sidekick-shrunk');
  }

  // Hvis siden har skjult sidekicken, vis intet — uanset mode.
  if (!_sk.visible) {
    _skStopPolling();
    return;
  }

  switch (mode) {
    case 'icon':
      icon.classList.add('visible');
      _skStopPolling();
      break;
    case 'panel':
      panel.classList.add('visible');
      if (mainContent) mainContent.classList.add('sidekick-shrunk');
      if (prev === 'icon') _skLoadAll();
      _skRenderPanel();
      _skStartPolling();
      break;
  }
}

/* ══════════════════════════════════════════════════════════
   PUBLIC API: setVisible / show / hide
   Pages kan toggle synlighed efter init.
   ══════════════════════════════════════════════════════════ */
function _skSetVisible(show) {
  var want = !!show;
  if (_sk.visible === want) return;
  _sk.visible = want;
  // Re-apply nuværende mode — _skSetMode respekterer _sk.visible
  _skSetMode(_sk.mode);
}

/* ══════════════════════════════════════════════════════════
   BADGE
   ══════════════════════════════════════════════════════════ */
function _skUpdateBadge() {
  var badge = document.getElementById('sk-badge');
  var dot = document.getElementById('sk-dot');
  if (!badge) return;

  var taskCount = _sk.tasks.filter(function(t) { return t.status !== 'done'; }).length;
  var msgCount = _sk.messages.length;
  var total = taskCount + msgCount;

  // Vis som "opgaver · beskeder" eller bare tallet
  if (taskCount > 0 && msgCount > 0) {
    badge.textContent = taskCount + '·' + msgCount;
  } else {
    badge.textContent = total;
  }
  badge.style.display = total > 0 ? 'flex' : 'none';
  badge.className = 'sk-badge' + (taskCount > 3 ? ' alert' : '');

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

    // Injicer DOM og vis ikon (medmindre siden har skjult sidekicken)
    _skInjectDOM();
    if (_sk.visible) {
      document.getElementById('sk-icon').classList.add('visible');
    }

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

// Public API — pages kan styre synlighed efter init
window.Sidekick = {
  setVisible: _skSetVisible,
  show: function() { _skSetVisible(true); },
  hide: function() { _skSetVisible(false); }
};
