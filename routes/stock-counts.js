/**
 * routes/stock-counts.js
 * ════════════════════════════════════════════════════════════
 * Optællingen som objekt (#673, spec §14.4). Monteres som /api/stock-counts.
 *
 * POST   /                  Start: opret optælling, svar med andre åbne på lokationen
 * GET    /open              Andre åbne optællinger (ved genoptaget session)
 * PATCH  /:id               Hvor tælleren står lige nu (fysisk enhed) — kun et hint
 * POST   /:id/lines         Log varer der IKKE gik gennem lagerkaldet (uændret,
 *                           lagerets tal beholdt, lagerskrivning fejlede)
 * POST   /:id/finish        "Gem og luk" lykkedes
 * POST   /:id/discard       Brugeren kasserede optællingen
 *
 * Rettede varer logges IKKE her, men i POST /api/grocy/stock/:id/inventory —
 * kun når Grocy tog imod. Bruger kommer altid fra sessionen (Patch D, #316).
 * ════════════════════════════════════════════════════════════
 */

const express = require('express');
const router  = express.Router();
const { getDb }       = require('../db/database');
const { handle }      = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const grocy = require('../services/grocyAdapter');
const log   = require('../services/stockCountLog');

router.post('/', requireAuth(), handle((req, res) => {
    const b = req.body || {};
    const db = getDb();
    let count;
    try {
        count = log.createCount(db, {
            grocyLocationId: b.grocy_location_id,
            physicalUnitId: b.physical_unit_id,
            physicalUnitName: b.physical_unit_name,
            userId: req.session && req.session.userId,
        });
    } catch (err) {
        return res.status(err.status || 500).json({ error: err.message });
    }
    res.json({ count, others: log.openOthers(db, { grocyLocationId: count.grocy_location_id, excludeId: count.id }) });
}));

router.get('/open', requireAuth(), handle((req, res) => {
    const loc = parseInt(req.query.grocy_location_id);
    if (!Number.isFinite(loc)) return res.status(400).json({ error: 'grocy_location_id påkrævet' });
    res.json({ others: log.openOthers(getDb(), { grocyLocationId: loc, excludeId: req.query.exclude }) });
}));

router.patch('/:id', requireAuth(), handle((req, res) => {
    const b = req.body || {};
    const c = log.setCurrentUnit(getDb(), req.params.id, {
        physicalUnitId: b.physical_unit_id, physicalUnitName: b.physical_unit_name,
    });
    if (!c) return res.status(404).json({ error: 'Optællingen findes ikke' });
    res.json({ count: c });
}));

router.post('/:id/lines', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const count = log.getCount(db, req.params.id);
    if (!count) return res.status(404).json({ error: 'Optællingen findes ikke' });
    const items = Array.isArray(req.body && req.body.products) ? req.body.products : [];
    if (!items.length) return res.json({ logged: 0, errors: [] });

    // Faktoren er serverens — derfor Grocys omregninger, ikke klientens.
    let products = [], conversions = [];
    try {
        [products, conversions] = await Promise.all([grocy.getProducts(), grocy.getQuantityUnitConversions()]);
    } catch (err) {
        return res.status(502).json({ error: 'Kunne ikke hente enheds-data fra Grocy: ' + err.message });
    }
    res.json(log.logProducts(db, { countId: count.id, items, products, conversions }));
}));

router.post('/:id/finish', requireAuth(), handle((req, res) => {
    const c = log.closeCount(getDb(), req.params.id, 'saved');
    if (!c) return res.status(404).json({ error: 'Optællingen findes ikke' });
    res.json({ count: c });
}));

router.post('/:id/discard', requireAuth(), handle((req, res) => {
    const c = log.closeCount(getDb(), req.params.id, 'discarded');
    if (!c) return res.status(404).json({ error: 'Optællingen findes ikke' });
    res.json({ count: c });
}));

module.exports = router;
