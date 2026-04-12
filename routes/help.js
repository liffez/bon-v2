/**
 * routes/help.js
 * GET  /api/help-content — læs hjælpetekster (public)
 * POST /api/help-content — gem hjælpetekster (admin-only)
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { requireAuth } = require('../shared/auth');

const HELP_FILE = path.join(__dirname, '..', 'data', 'help-content.json');

function readContent() {
  try {
    const raw = fs.readFileSync(HELP_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

router.get('/', (req, res) => {
  res.json(readContent());
});

router.post('/', requireAuth('admin'), (req, res) => {
  try {
    fs.writeFileSync(HELP_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Kunne ikke gemme: ' + e.message });
  }
});

module.exports = router;
