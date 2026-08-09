// Bruges som: router.get('/beskyttet', requireAuth(), handler)
// Eller:      router.get('/admin', requireAuth('admin'), handler)
// Eller:      router.get('/mixed', requireAuth('office', 'kitchen'), handler)
// Eller:      router.get('/crm-ting', requireModule('crm'), handler)
//
// Rolle-gate vs. modul-gate: requireAuth('admin') låser en flade til rollen
// admin for altid. requireModule('crm') spørger i stedet rettighedsmatricen
// (Settings → Roller), så adgangen kan ændres uden en udrulning. Brug modul-
// gaten til alt der har et modul i matricen — rolle-gaten er til ægte system-
// flader (mail-skabeloner, IMAP-status, poll) der ikke har et.

const { getDb } = require('../db/database');
const { getUserById } = require('../db/helpers');

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

/**
 * Gate på et modul i rettighedsmatricen i stedet for på en rolle.
 * admin slipper altid igennem (samme regel som requireAuth).
 * Per-bruger-overrides i users.modules_json vinder over rolle-defaulten —
 * derfor slås brugeren op pr. request; rolle-defaults er cachet 60s i userCan.
 */
function requireModule(module) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Ikke logget ind' });
    }
    if (req.session.userRole === 'admin') return next();
    const user = getUserById(req.session.userId);
    // Deaktiveret eller slettet bruger med levende session → behandl som udlogget.
    if (!user) return res.status(401).json({ error: 'Ikke logget ind' });
    if (!userCan(user, module)) {
      return res.status(403).json({ error: 'Ingen adgang', module });
    }
    next();
  };
}

// Ryd cache manuelt — kaldes fra settings-route efter opdatering
function invalidatePermCache() {
    _permCache = null;
}

module.exports = { requireAuth, requireModule, userCan, invalidatePermCache };
