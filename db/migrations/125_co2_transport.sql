-- 125_co2_transport.sql
-- ════════════════════════════════════════════════════════════════════════
-- Transport-CO₂ (docs/CLAUDE_CO2_TRANSPORT.md §1).
--
-- Fire faktor-felter pr. leveringsmetode. Transport-CO₂ beregnes on-the-fly
-- (intet snapshot i v1) af services/co2Transport.js ud fra km-data i
-- geo_calculations / delivery_routes + disse faktorer.
--
--   co2_g_per_km            g CO₂e pr. km (fx Volvo 250, el-taxa 60, cykelbud 5)
--   co2_g_fixed            fast g CO₂e pr. tur — fallback når km-data mangler
--   co2_distance_multiplier punkt-til-punkt: Volvo 2,0 (tur/retur), bud/taxa 1,0
--   co2_positioning_km      konstant km fra leverandørens base → HQ. Eksterne bud
--                           (By-expressen/Taxa) starter ikke fra HQ og positionerer
--                           først; egne vogne (Volvo/cykel) = 0.
--
-- Default 0 overalt → transport tæller 0 indtil Leif indtaster faktorer i
-- Settings → Leveringsmetoder. Ingen backfill nødvendig.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE delivery_vehicles ADD COLUMN co2_g_per_km REAL NOT NULL DEFAULT 0;
ALTER TABLE delivery_vehicles ADD COLUMN co2_g_fixed REAL NOT NULL DEFAULT 0;
ALTER TABLE delivery_vehicles ADD COLUMN co2_distance_multiplier REAL NOT NULL DEFAULT 1.0;
ALTER TABLE delivery_vehicles ADD COLUMN co2_positioning_km REAL NOT NULL DEFAULT 0;
