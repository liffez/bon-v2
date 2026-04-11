const express = require('express');
const router = express.Router();
const { getUserByEmail, getUserById, verifyPassword } = require('../db/helpers');
const { getDb } = require('../db/database');

// Hjælpefunktion: sæt session med korrekt varighed fra settings
function setSession(req, user) {
  const db = getDb();
  const key = `session_days_${user.role}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const days = parseInt(row?.value || '30', 10);
  req.session.cookie.maxAge = days * 24 * 60 * 60 * 1000;
  req.session.userId = user.id;
  req.session.userRole = user.role;
}

// POST /api/auth/login — email + password
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Mangler email eller password' });

  const user = getUserByEmail(email);
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Forkert email eller password' });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Forkert email eller password' });

  setSession(req, user);
  res.json({ id: user.id, name: user.name, role: user.role });
});

// POST /api/auth/pin — PIN-login (med valgfrit user_id for mobilshell)
const _pinAttempts = new Map(); // lockKey → { count, lockedUntil }
const PIN_MAX_ATTEMPTS = 3;
const PIN_LOCKOUT_MS = 30_000;

router.post('/pin', (req, res) => {
  const { pin, user_id } = req.body;
  if (!pin) return res.status(400).json({ error: 'Mangler PIN' });

  // Lockout check
  const lockKey = user_id ? `uid:${user_id}` : `pin:${pin}`;
  const attempt = _pinAttempts.get(lockKey);
  if (attempt && attempt.lockedUntil > Date.now()) {
    const secs = Math.ceil((attempt.lockedUntil - Date.now()) / 1000);
    return res.status(423).json({ error: 'locked', lockout_seconds: secs });
  }

  const db = getDb();
  let user;
  if (user_id) {
    // Mobilshell: bruger valgt fra liste, match på id + pin
    user = db.prepare(
      'SELECT * FROM users WHERE id = ? AND pin = ? AND is_active = 1'
    ).get(user_id, pin);
  } else {
    // Tablet/legacy: match på pin alene
    user = db.prepare(
      'SELECT * FROM users WHERE pin = ? AND is_active = 1'
    ).get(pin);
  }

  if (!user) {
    // Track failed attempt
    const entry = _pinAttempts.get(lockKey) || { count: 0, lockedUntil: 0 };
    entry.count++;
    if (entry.count >= PIN_MAX_ATTEMPTS) {
      entry.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
      entry.count = 0;
    }
    _pinAttempts.set(lockKey, entry);
    return res.status(401).json({ error: 'Forkert PIN' });
  }

  // Success — clear attempts
  _pinAttempts.delete(lockKey);
  setSession(req, user);
  res.json({ id: user.id, name: user.name, role: user.role });
});

// GET /api/auth/pin-users — aktive brugere med PIN (public, til mobilshell login)
router.get('/pin-users', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, name FROM users WHERE is_active = 1 AND pin IS NOT NULL AND pin != '' ORDER BY name"
  ).all();
  res.json(rows);
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// GET /api/auth/me — hvem er jeg?
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Ikke logget ind' });
  const user = getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });
  res.json(user);
});

module.exports = router;
