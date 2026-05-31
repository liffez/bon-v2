-- ==========================================
-- Migration 087 — Finpuds Volvo Duett-ikonet: flad/lodret bagende
--
-- Migration 086's SVG havde en skrå hatchback-hæk. Duett'en er nærmest en
-- lille varevogn med lang tagline og en lodret, flad bagende. Denne migration
-- erstatter $.volvo.icon med den opdaterede silhuet (flad bag + stort
-- lastrums-vindue). Em-baseret, samme gule (#E2B33D).
--
-- json_set rører kun $.volvo.icon. SVG'en har hverken enkelt-anførselstegn
-- eller semikolon → SQL-sikker som streng-literal. Fresh installs får samme
-- SVG via koden (shared/delivery_icons.js DEFAULTS), derfor kun UPDATE.
-- ==========================================

UPDATE settings
SET value = json_set(
        value,
        '$.volvo.icon',
        '<svg viewBox="0 0 24 20" width="1.45em" height="1.45em" style="vertical-align:-0.32em" aria-hidden="true"><path d="M2 13 L2 10.8 Q2 9.7 3.2 9.5 L4.6 9.3 L6.8 5.6 Q7.1 5 7.9 5 L20.4 5 Q21.5 5 21.5 6.1 L21.5 12 Q21.5 13 20.5 13 Z" fill="#E2B33D" stroke="#9c6f28" stroke-width="0.7" stroke-linejoin="round"/><path d="M7.7 6.1 L12 6.1 L12 8.9 L6.95 8.9 Z" fill="#d6e6f0"/><path d="M12.8 6.1 L20.3 6.1 L20.5 8.9 L12.8 8.9 Z" fill="#d6e6f0"/><circle cx="6.9" cy="13.2" r="2.4" fill="#2c2c2c"/><circle cx="6.9" cy="13.2" r="0.95" fill="#dcdcdc"/><circle cx="18.3" cy="13.2" r="2.4" fill="#2c2c2c"/><circle cx="18.3" cy="13.2" r="0.95" fill="#dcdcdc"/></svg>'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE key = 'delivery_method_icons';
