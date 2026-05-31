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
        '<svg viewBox="0 0 24 20" width="1.45em" height="1.45em" style="vertical-align:-0.32em" aria-hidden="true"><path d="M2 13.2 C1.5 13.2 1.2 12.8 1.2 12.3 L1.2 11 C1.2 10.3 1.7 9.8 2.5 9.7 L4.3 9.5 L6.2 6 C6.6 5.3 7.3 4.9 8.1 4.9 L17.6 4.9 C18.4 4.9 19.1 5.3 19.5 6 L20.8 9.3 L21.8 9.6 C22.6 9.9 23 10.6 23 11.4 L23 12.4 C23 12.8 22.7 13.2 22.2 13.2 Z" fill="#E2B33D" stroke="#9c6f28" stroke-width="0.7" stroke-linejoin="round"/><path d="M7.8 6.4 L12 6.4 L12 9 L6.3 9 Z" fill="#d6e6f0"/><path d="M13 6.4 L17.2 6.4 C17.7 6.4 18 6.6 18.3 7.1 L19.4 9 L13 9 Z" fill="#d6e6f0"/><circle cx="7.2" cy="13.4" r="2.4" fill="#2c2c2c"/><circle cx="7.2" cy="13.4" r="0.95" fill="#dcdcdc"/><circle cx="18.2" cy="13.4" r="2.4" fill="#2c2c2c"/><circle cx="18.2" cy="13.4" r="0.95" fill="#dcdcdc"/></svg>',
        '$.volvo.label',
        'Volvo'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'delivery_method_icons';
