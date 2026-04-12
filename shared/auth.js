// Bruges som: router.get('/beskyttet', requireAuth(), handler)
// Eller:      router.get('/admin', requireAuth('admin'), handler)
// Eller:      router.get('/mixed', requireAuth('office', 'kitchen'), handler)

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
