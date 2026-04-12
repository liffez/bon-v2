/**
 * routes/sidekick.js
 * GET /api/sidekick/config — returnerer Whiteboard/SOP URLs fra .env
 */
const express = require('express');
const router = express.Router();

router.get('/config', (req, res) => {
  res.json({
    whiteboardBase: process.env.WHITEBOARD_BASE_URL || '',
    sopBase: process.env.SOP_BASE_URL || ''
  });
});

module.exports = router;
