-- ==========================================
-- Migration 086 — Gul Volvo Duett-ikon (SVG) i delivery_method_icons
--
-- delivery_method-ikonet for 'volvo' var 🚛 (lastbil) — det matcher ikke
-- Ristet Rugs klassiske gule Volvo Duett stationcar. Vi erstatter det med en
-- inline-SVG i den gule farve. Em-baseret størrelse så den skalerer med teksten.
--
-- json_set rører kun $.volvo (bike/taxi/pickup bevares). SVG'en har hverken
-- enkelt-anførselstegn eller semikolon, så den er SQL-sikker som streng-literal.
-- Fresh installs uden settings-rækken får samme SVG via koden
-- (shared/delivery_icons.js DEFAULTS) — derfor kun UPDATE her.
--
-- Brugeren kan altid overstyre ikonet igen via en PATCH til
-- settings-nøglen 'delivery_method_icons'.
-- ==========================================

UPDATE settings
SET value = json_set(
        value,
        '$.volvo.icon',
        '<svg viewBox="0 0 24 24" width="1.15em" height="1.15em" style="vertical-align:-0.22em" aria-hidden="true"><rect x="1.5" y="10" width="21" height="5" rx="1.3" fill="#E2B33D"/><path d="M6 10 L8.5 6.4 Q8.9 6 9.6 6 L17.5 6 Q18.4 6 18.9 6.8 L20.8 10 Z" fill="#E2B33D"/><path d="M9.4 7.3 L16.7 7.3 Q17.2 7.3 17.5 7.8 L18.5 9.3 L9.4 9.3 Z" fill="#fff" opacity="0.9"/><line x1="13" y1="7.3" x2="13" y2="9.3" stroke="#E2B33D" stroke-width="0.8"/><circle cx="7" cy="15.3" r="2.1" fill="#333"/><circle cx="7" cy="15.3" r="0.85" fill="#cfcfcf"/><circle cx="17.6" cy="15.3" r="2.1" fill="#333"/><circle cx="17.6" cy="15.3" r="0.85" fill="#cfcfcf"/></svg>',
        '$.volvo.label',
        'Volvo'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'delivery_method_icons';
