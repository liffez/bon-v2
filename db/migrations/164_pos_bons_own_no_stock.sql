-- 164_pos_bons_own_no_stock.sql
-- ============================================================
-- POS-salgsbons trækker aldrig lager — markér de eksisterende.
--
-- En POS/Zettle-bon bygges af dagens kassesalg og oprettes direkte som BETALT.
-- Den må ALDRIG trække lager: prep-bonnen ejer trækket (CLAUDE_EVENT.md §5),
-- og bonens egen køkkeninfo siger det.
--
-- Gaten der skulle markere det står i `autoConsumeBonInventory`, som kun kaldes
-- ved LEVERET. POS-bonnen passerer aldrig dér, så flaget forblev 0 og statussen
-- tom — præcis som en bon hvor trækket var gået galt. Vagthunden (#305/#359)
-- meldte dem derfor som manglende træk hver eneste nat: #B4202 og #B4207 den
-- 24.08.2026.
--
-- `services/posSync.js` sætter felterne ved oprettelsen fremover. Denne
-- migration retter dem der allerede findes.
--
-- Afgrænsning: KUN bons oprettet af POS-synken (event_role 'sales' med
-- betalingstype 'pos'). En almindelig event-salgsbon der reelt mangler sit træk
-- skal stadig kunne findes af vagthunden — vi rydder ikke op i noget vi ikke
-- kan begrunde.
-- ============================================================

UPDATE bons
   SET inventory_deducted       = 1,
       inventory_deducted_at    = COALESCE(inventory_deducted_at, created_at),
       inventory_deduct_status  = 'event_prep_owns_stock'
 WHERE event_id IS NOT NULL
   AND event_role = 'sales'
   AND payment_type = 'pos'
   AND COALESCE(inventory_deducted, 0) = 0;
