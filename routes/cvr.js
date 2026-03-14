const express = require('express');
const router = express.Router();

// Fælles mapper fra cvrapi-response
function mapCvrResult(data) {
    return {
        cvr: data.vat ? String(data.vat) : null,
        name: data.name || null,
        address: data.address || null,
        zipcode: data.zipcode || null,
        city: data.city || null,
        phone: data.phone || null,
        email: data.email || null,
        industry: data.industrydesc || null,
        company_type: data.companydesc || null
    };
}

// GET /api/cvr/search?q= — søg firma via navn
router.get('/search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'Mindst 2 tegn' });

    try {
        const response = await fetch(`https://cvrapi.dk/api?country=dk&search=${encodeURIComponent(q)}`, {
            headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' }
        });

        if (!response.ok) {
            return res.json([]);
        }

        const data = await response.json();

        // cvrapi returnerer enten et enkelt objekt eller et array
        if (Array.isArray(data)) {
            res.json(data.map(mapCvrResult));
        } else if (data && data.vat) {
            res.json([mapCvrResult(data)]);
        } else {
            res.json([]);
        }
    } catch (err) {
        console.error('CVR-søgning fejlede:', err.message);
        res.status(502).json({ error: 'CVR-søgning fejlede' });
    }
});

// GET /api/cvr/:cvr — slå CVR-nummer op direkte
router.get('/:cvr', async (req, res) => {
    const cvr = req.params.cvr.replace(/\D/g, '');
    if (cvr.length !== 8) {
        return res.status(400).json({ error: 'CVR-nummer skal være 8 cifre' });
    }

    try {
        const response = await fetch(`https://cvrapi.dk/api?country=dk&vat=${cvr}`, {
            headers: { 'User-Agent': 'Bon v2 - ristetrug.dk' }
        });

        if (!response.ok) {
            return res.status(404).json({ error: 'CVR ikke fundet' });
        }

        const data = await response.json();
        res.json(mapCvrResult(data));
    } catch (err) {
        console.error('CVR-opslag fejlede:', err.message);
        res.status(502).json({ error: 'CVR-opslag fejlede' });
    }
});

module.exports = router;
