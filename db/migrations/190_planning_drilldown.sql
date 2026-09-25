-- 190: planlægningens drill-down, fase 1 (docs/CLAUDE_PLANLAEGNING_DRILLDOWN.md)
--
-- 1) Hvilke statusser planlægningen vælger fra start. Admin-indstilling;
--    brugeren kan stadig slå chips til og fra. LEVERET og frem er IKKE med:
--    en leveret bon har trukket lageret, så med den i behovet tælles varerne
--    to gange. Samme sæt som den gamle planlægning, minus LEVERET.
--
-- 2) To nye rettigheder i rollematricen: kostpris og salgspris i
--    planlægningen, hver for sig. Afgøres på serveren ud fra sessionen — et
--    tal brugeren ikke må se, bliver ikke sendt.
--
--    Standarder:
--      admin    kost ✓  salg ✓   (admin slipper altid igennem uanset)
--      office   kost ✓  salg ✓
--      kitchen  kost = den gamle "Vis priser i planlægningsbon"  ·  salg ✗
--      øvrige   kost ✗  salg ✗
--    Kun hvor nøglen ikke findes i forvejen — en rettighed nogen har sat,
--    overskrives ikke.

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('planning_default_statuses', '["GODKENDT","IGANG","KLAR"]',
   'Planlægning: statusser der er valgt fra start (JSON-array af statuskoder). Brugeren kan slå andre til.');

UPDATE settings
   SET value = json_set(value, '$.plan_kost', json('true'), '$.plan_salg', json('true'))
 WHERE key IN ('role_permissions_admin', 'role_permissions_office')
   AND json_valid(value)
   AND json_extract(value, '$.plan_kost') IS NULL;

UPDATE settings
   SET value = json_set(value,
         '$.plan_kost', json(CASE WHEN (SELECT value FROM settings WHERE key = 'show_prices_in_planning') = '1'
                                  THEN 'true' ELSE 'false' END),
         '$.plan_salg', json('false'))
 WHERE key = 'role_permissions_kitchen'
   AND json_valid(value)
   AND json_extract(value, '$.plan_kost') IS NULL;

UPDATE settings
   SET value = json_set(value, '$.plan_kost', json('false'), '$.plan_salg', json('false'))
 WHERE key IN ('role_permissions_kitchen_personal', 'role_permissions_delivery')
   AND json_valid(value)
   AND json_extract(value, '$.plan_kost') IS NULL;
