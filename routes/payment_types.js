const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/payment-types
router.get('/', (req, res) => {
  const db = getDb();
  const types = db.prepare(
    'SELECT id, code, label, sort_order FROM payment_types WHERE is_active = 1 ORDER BY sort_order'
  ).all();
  res.json(types);
});

module.exports = router;
