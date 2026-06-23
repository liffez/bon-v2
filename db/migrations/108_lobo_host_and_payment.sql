-- Migration 108: Lobo/Byekspressen — ny host + fkpayment
-- ════════════════════════════════════════════════════════════
-- Baggrund (verificeret live mod sandbox + productive 22. juni 2026):
--
-- 1) HOST FLYTTET. Lobo's kanoniske host er nu `byexpressen.groupnet.at`
--    (den gamle `byexpressen.lobolink.eu` i migration 093 er legacy/alias).
--    Sandboxen — som var HTTP 500 i hele juni — er nu OPPE på groupnet og
--    hele booking-kæden (token → address.verify → orderdraft → pris → delete)
--    er verificeret end-to-end derimod.
--
-- 2) fkpayment MANGLEDE. Alle 100 seneste productive-ordrer bruger
--    fkpayment=1 (faktura). Sættes nu eksplicit så buildOrderPayload sender
--    den med (ellers udelades feltet og Lobo defaulter).
--
-- Uændret (bekræftet stadig gyldigt på groupnet): fkproduct=39 (Food),
-- hq_fkplace=3233 (RR-afhentning — draft m. dette fkplace resolver korrekt
-- til Prinsesse Charlottes Gade), extra_box_surcharge_id=389, customernumber.
--
-- json_set bevarer alle øvrige nøgler — kun de tre felter røres.
-- booking_method forbliver 'manual_clipboard' (go-live = separat UPDATE til 'api').
-- ════════════════════════════════════════════════════════════

UPDATE delivery_vehicles
SET booking_api_config_json = json_set(
        booking_api_config_json,
        '$.base_url',    'https://byexpressen.groupnet.at/lobo/api/v3/public/',
        '$.sandbox_url', 'https://byexpressen.groupnet.at/lobo/sandbox/api/v3/public/',
        '$.fkpayment',   1
    )
WHERE code = 'byekspressen';
