# CLAUDE_MOBILE_AUTH.md — Roller, rettigheder og mobilzone
> Tillæg til CLAUDE.md
> Implementeres som samlet opgave — rækkefølgen er vigtig.

---

## Kontekst

Bon v2 får en mobilzone (`/mobile/`) med PIN-baseret login via brugergrid.
Eksisterende roller (`admin`, `office`, `kitchen`, `delivery`) udvides med
`kitchen_personal` — personligt password-login til mobilvisning for køkkenpersonale.

Rollerettigheder defineres i `settings`-tabellen — ikke i koden.
Per-bruger undtagelser styres via `modules_json` på `users`.

---

## 1. Migration `041_users_role_expand.sql`

`users`-tabellen recreates for at opdatere `role`-constraint korrekt.
SQLite ignorerer `ALTER TABLE ... CHECK` — den eneste rene løsning er at genskabe tabellen.

```sql
-- 041_users_role_expand.sql

PRAGMA foreign_keys = OFF;

CREATE TABLE users_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    email            TEXT,
    role             TEXT NOT NULL DEFAULT 'kitchen'
                         CHECK (role IN ('admin','office','kitchen','kitchen_personal','delivery')),
    pin              TEXT,
    password_hash    TEXT,
    modules_json     TEXT DEFAULT NULL,
    is_active        INTEGER NOT NULL DEFAULT 1,
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_new
    SELECT id, name, email, role, pin, password_hash, NULL, is_active, created_at
    FROM users;

DROP TABLE users;
ALTER TABLE users_new RENAME TO users;

PRAGMA foreign_keys = ON;

-- Session-varighed for ny rolle
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('session_days_kitchen_personal', '30', 'Session-varighed for personlige køkken-brugere (dage)');

-- Rollerettigheder — én JSON-blob per rolle
-- Moduler: crm, tilbud, okonomi, rapporter, settings, modtag
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('role_permissions_admin',
     '{"crm":true,"tilbud":true,"okonomi":true,"rapporter":true,"settings":true,"modtag":true}',
     'Moduladgang for admin-rolle'),
    ('role_permissions_office',
     '{"crm":true,"tilbud":true,"okonomi":true,"rapporter":true,"settings":false,"modtag":true}',
     'Moduladgang for office-rolle'),
    ('role_permissions_kitchen',
     '{"crm":false,"tilbud":false,"okonomi":false,"rapporter":false,"settings":false,"modtag":true}',
     'Moduladgang for kitchen-rolle'),
    ('role_permissions_kitchen_personal',
     '{"crm":false,"tilbud":false,"okonomi":false,"rapporter":false,"settings":false,"modtag":false}',
     'Moduladgang for kitchen_personal-rolle'),
    ('role_permissions_delivery',
     '{"crm":false,"tilbud":false,"okonomi":false,"rapporter":false,"settings":false,"modtag":false}',
     'Moduladgang for delivery-rolle');
```

**Vigtigt:** Kør `PRAGMA wal_checkpoint(TRUNCATE)` før migration på produktionsdata.
**Vigtigt:** Verificer at `password_hash`-kolonnen eksisterer i `users` inden migration køres.

---

## 2. `shared/auth.js` — `userCan()` med settings-cache

Defaults læses fra `settings`-tabellen, ikke fra kode.
Cache invalideres efter 60 sekunder så ændringer i Settings-UI slår igennem uden genstart.

```js
// shared/auth.js

const { getDb } = require('../db/database');

// Cache: { data: {...}, fetchedAt: timestamp }
let _permCache = null;
const PERM_CACHE_TTL = 60_000; // 60 sekunder

function _getRolePermissions() {
    const now = Date.now();
    if (_permCache && (now - _permCache.fetchedAt) < PERM_CACHE_TTL) {
        return _permCache.data;
    }
    const db = getDb();
    const roles = ['admin', 'office', 'kitchen', 'kitchen_personal', 'delivery'];
    const result = {};
    roles.forEach(role => {
        const row = db.prepare(
            'SELECT value FROM settings WHERE key = ?'
        ).get(`role_permissions_${role}`);
        try {
            result[role] = row ? JSON.parse(row.value) : {};
        } catch {
            result[role] = {};
        }
    });
    _permCache = { data: result, fetchedAt: now };
    return result;
}

function userCan(user, module) {
    const allPerms = _getRolePermissions();
    const roleDefaults = allPerms[user.role] || {};

    if (!user.modules_json) return roleDefaults[module] ?? false;
    try {
        const overrides = JSON.parse(user.modules_json);
        return module in overrides ? overrides[module] : (roleDefaults[module] ?? false);
    } catch {
        return roleDefaults[module] ?? false;
    }
}

// Bruges som: router.get('/beskyttet', requireAuth(), handler)
function requireAuth(...roles) {
    return (req, res, next) => {
        if (!req.session?.userId) {
            return res.status(401).json({ error: 'Ikke logget ind' });
        }
        if (roles.length === 0) return next();
        const userRole = req.session.userRole;
        if (userRole === 'admin') return next();
        if (!roles.includes(userRole)) {
            return res.status(403).json({ error: 'Ingen adgang' });
        }
        next();
    };
}

// Ryd cache manuelt — kaldes fra settings-route efter opdatering
function invalidatePermCache() {
    _permCache = null;
}

module.exports = { requireAuth, userCan, invalidatePermCache };
```

---

## 3. `routes/auth.js` — `GET /me` returnerer `permissions`

Frontend behøver ikke kende til rolle-defaults — den spørger serveren.

```js
// routes/auth.js — GET /api/auth/me
const { userCan } = require('../shared/auth');

const MODULES = ['crm', 'tilbud', 'okonomi', 'rapporter', 'settings', 'modtag'];

router.get('/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Ikke logget ind' });
    const user = getUserById(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });

    const permissions = {};
    MODULES.forEach(m => { permissions[m] = userCan(user, m); });

    res.json({ ...user, permissions });
});
```

---

## 4. `routes/settings.js` — GET/PATCH rollerettigheder

```js
const { invalidatePermCache } = require('../shared/auth');

// GET /api/settings/role-permissions
// Returnerer matrix: { admin: {...}, office: {...}, ... }
router.get('/role-permissions', requireAuth('admin'), (req, res) => {
    const db = getDb();
    const roles = ['admin', 'office', 'kitchen', 'kitchen_personal', 'delivery'];
    const result = {};
    roles.forEach(role => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?')
            .get(`role_permissions_${role}`);
        try { result[role] = row ? JSON.parse(row.value) : {}; }
        catch { result[role] = {}; }
    });
    res.json(result);
});

// PATCH /api/settings/role-permissions/:role
// Body: { crm: true, tilbud: false, ... }
router.patch('/role-permissions/:role', requireAuth('admin'), (req, res) => {
    const VALID_ROLES = ['office', 'kitchen', 'kitchen_personal', 'delivery'];
    // admin kan ikke begrænses
    if (!VALID_ROLES.includes(req.params.role)) {
        return res.status(400).json({ error: 'Ugyldig rolle eller admin kan ikke begrænses' });
    }
    const db = getDb();
    db.prepare(
        'UPDATE settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?'
    ).run(JSON.stringify(req.body), `role_permissions_${req.params.role}`);

    invalidatePermCache();
    res.json({ ok: true });
});
```

---

## 5. Nav-tabs i `/mobile/index.html`

Nav renderes dynamisk ud fra `permissions` returneret af `/api/auth/me`.

```js
// Nav-definitionen — hvilke views kræver hvilken permission
// requires: null = altid tilladt
const NAV_DEFS = [
    { view: 'bons',     icon: '📋', label: 'Bons',     requires: null },
    { view: 'modtag',   icon: '📦', label: 'Modtag',   requires: 'modtag' },
    { view: 'crm',      icon: '📞', label: 'CRM',      requires: 'crm' },
    { view: 'oversigt', icon: '📊', label: 'Overblik',  requires: null },
    { view: 'mig',      icon: '👤', label: 'Mig',      requires: null },
];

var _mUser = await checkAuth('/mobile/login.html');

var allowedViews = NAV_DEFS
    .filter(d => d.requires === null || _mUser.permissions[d.requires])
    .map(d => d.view);

var nav = document.querySelector('.m-nav');
nav.innerHTML = '';
NAV_DEFS
    .filter(d => allowedViews.includes(d.view))
    .forEach(function(d) {
        var btn = document.createElement('button');
        btn.className = 'm-nav-btn';
        btn.dataset.view = d.view;
        btn.innerHTML = '<span class="m-nav-icon">' + d.icon + '</span>' + d.label;
        nav.appendChild(btn);
    });
```

`_mViews`-objektet bibeholdes uændret — views der ikke er i `allowedViews` initialiseres blot aldrig.

---

## 6. Settings UI — permission matrix

Placering: Settings → Brugere → fane "Rollerettigheder"

Layout: tabel hvor rækker = roller, kolonner = moduler.
`admin`-rækken vises som read-only (alle ✅, ingen checkboxes).

```
             CRM   Tilbud  Økonomi  Rapporter  Settings  Modtag
Admin         ✅    ✅      ✅       ✅          ✅        ✅   (read-only)
Office        ☑     ☑       ☑        ☑          ☐         ☑
Kitchen       ☐     ☐       ☐        ☐          ☐         ☑
K. personlig  ☐     ☐       ☐        ☐          ☐         ☐
Levering      ☐     ☐       ☐        ☐          ☐         ☐
```

Kolonneoverskrifter er danske visningsnavne — ikke nøglenavne.
Gem sker ved `change`-event på hver checkbox — ingen gem-knap.
Hvert klik sender det fulde opdaterede objekt for rækken via
`PATCH /api/settings/role-permissions/:role`.

Under matrixen: sektion "Individuelle overrides" — liste over brugere
der har `modules_json` sat, med link til redigering.

---

## 7. `getDefaultZone` — to steder

### `login.html` (desktop)

```js
function getDefaultZone(role) {
    if (role === 'admin' || role === 'office') return '/office/';
    if (role === 'kitchen_personal') return '/mobile/';
    return '/kitchen/';
}
```

### `server.js` — root redirect

```js
app.get('/', (req, res) => {
    if (req.session?.userId) {
        const role = req.session.userRole || 'kitchen';
        if (role === 'admin' || role === 'office') return res.redirect('/office/');
        if (role === 'kitchen_personal') return res.redirect('/mobile/');
        return res.redirect('/kitchen/');
    }
    res.redirect('/login.html');
});
```

---

## Rækkefølge for Simon

| Trin | Hvad | Fil |
|------|------|-----|
| 1 | Migration 041 — recreate users + settings-rækker | `db/migrations/041_users_role_expand.sql` |
| 2 | `userCan()` + `invalidatePermCache()` | `shared/auth.js` |
| 3 | `GET /me` med `permissions` | `routes/auth.js` |
| 4 | `GET/PATCH /api/settings/role-permissions` | `routes/settings.js` |
| 5 | `getDefaultZone()` opdateret | `login.html` + `server.js` |
| 6 | Dynamisk nav | `mobile/index.html` |
| 7 | Matrix-UI i Settings | `settings/index.html` |

Trin 1–4 er ren backend og kan deployes og testes via curl/smoke-test
inden frontend røres.

---

## Smoke-test

```bash
# Verificer settings-rækker efter migration
curl -s http://localhost:4321/api/settings/role-permissions \
  -H "Cookie: $ADMIN_SESSION" | jq .

# Opdater kitchen — fjern modtag-adgang
curl -s -X PATCH http://localhost:4321/api/settings/role-permissions/kitchen \
  -H "Content-Type: application/json" \
  -H "Cookie: $ADMIN_SESSION" \
  -d '{"crm":false,"tilbud":false,"okonomi":false,"rapporter":false,"settings":false,"modtag":false}'

# Verificer at /me returnerer korrekte permissions for en kitchen-bruger
curl -s http://localhost:4321/api/auth/me \
  -H "Cookie: $KITCHEN_SESSION" | jq .permissions
```

---

*Oprettet: april 2026*
