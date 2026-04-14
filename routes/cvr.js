const express = require('express');
const router = express.Router();

const VIRK_USER = process.env.VIRK_ES_USER;
const VIRK_PASS = process.env.VIRK_ES_PASS;
const VIRK_URL = 'http://distribution.virk.dk/cvr-permanent/_search';

// GET /api/cvr/virk-search?q= — søg via Virk ElasticSearch (bedre til fulde navne)
router.get('/virk-search', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.status(400).json({ error: 'Mindst 2 tegn' });
    if (!VIRK_USER || !VIRK_PASS) return res.status(503).json({ error: 'Virk ES credentials ikke konfigureret' });

    try {
        const body = {
            query: {
                bool: {
                    must: {
                        match: {
                            'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn': {
                                query: q,
                                fuzziness: 'AUTO',
                            }
                        }
                    }
                }
            },
            size: 10,
        };
        const r = await fetch(VIRK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(`${VIRK_USER}:${VIRK_PASS}`).toString('base64'),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return res.json([]);
        const data = await r.json();
        const results = (data.hits?.hits || []).map(hit => {
            const v = hit._source?.Vrvirksomhed;
            if (!v) return null;
            const meta = v.virksomhedMetadata || {};
            const adr = meta.nyesteBeliggenhedsadresse;
            return {
                cvr: v.cvrNummer ? String(v.cvrNummer) : null,
                name: meta.nyesteNavn?.navn || null,
                address: adr ? `${adr.vejnavn || ''} ${adr.husnummerFra || ''}`.trim() : null,
                zipcode: adr?.postnummer ? String(adr.postnummer) : null,
                city: adr?.postdistrikt || null,
                industry: meta.nyesteHovedbranche?.branchetekst || null,
                status: meta.sammensatStatus || null,
                score: hit._score,
            };
        }).filter(Boolean);
        res.json(results);
    } catch (err) {
        console.error('Virk ES søgning fejlede:', err.message);
        res.status(502).json({ error: 'Virk ES søgning fejlede' });
    }
});

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
