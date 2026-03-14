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

// POST /api/auth/pin — PIN-login
router.post('/pin', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'Mangler PIN' });

  const db = getDb();
  const user = db.prepare(
    'SELECT * FROM users WHERE pin = ? AND is_active = 1'
  ).get(pin);

  if (!user) return res.status(401).json({ error: 'Forkert PIN' });

  setSession(req, user);
  res.json({ id: user.id, name: user.name, role: user.role });
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
