-- Migration 093: Lobo/Byekspressen-integration (Fase B fundament)
--
-- 1) snapshot_json på delivery_events — gemmer hele Lobo-svaret (order + pris +
--    verificeret adresse) ved booking/webhook-events. delivery_events havde
--    ingen JSON-kolonne (jf. CLAUDE_LEVERING_LOBO.md §6).
-- 2) Udfylder By-expressen-vognens booking_api_config_json med de LIVE-bekræftede
--    værdier (4. juni 2026). booking_method FLIPPES IKKE til 'api' her — den
--    forbliver 'manual_clipboard' så den kørende app er upåvirket. Skiftet til
--    'api' sker som en bevidst go-live-handling (én UPDATE) når Fase B er klar +
--    sandbox/order.delete er på plads.
--
-- Secret (user/pass) ligger i .env (BY_EKS_USWER/BY_EX_CODE) — ALDRIG her.

ALTER TABLE delivery_events ADD COLUMN snapshot_json TEXT;

UPDATE delivery_vehicles
SET booking_api_config_json = json_object(
        'provider',     'lobo',
        'base_url',     'https://byexpressen.lobolink.eu/lobo/api/v3/public/',
        'sandbox_url',  'https://byexpressen.lobolink.eu/lobo/sandbox/api/v3/public/',
        'use_sandbox',  json('false'),
        'customernumber', 18062101,
        'fkproduct',    39,
        'hq_fkplace',   3233,
        'extra_box_surcharge_id', 389
    )
WHERE code = 'byekspressen';
