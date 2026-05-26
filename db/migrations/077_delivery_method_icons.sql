-- Migration 077: delivery_method_icons setting
--
-- Flytter de hardcodede ikoner for leveringsmetoder (bike/taxi/volvo/pickup)
-- fra `office/views/bons-list.js:66` (BL_DELIVERY_ICONS), `shared/bon_kort_builder.js`,
-- `shared/bon_drawer.js`, `shared/logistik.js` til settings. Frontends loader
-- via `/api/settings/delivery-icons` og falder tilbage til defaults nedenfor.

INSERT INTO settings (key, value, description)
VALUES (
    'delivery_method_icons',
    '{"bike":{"icon":"🚲","label":"Cykel"},"taxi":{"icon":"🚕","label":"Taxa"},"volvo":{"icon":"🚛","label":"Volvo"},"pickup":{"icon":"🏠","label":"Afhentning"}}',
    'Ikoner og labels for delivery_method-værdier. Editerbar via Settings → System.'
)
ON CONFLICT(key) DO NOTHING;
