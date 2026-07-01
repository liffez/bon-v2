-- 116_cashflow_drop_event_allocations.sql
-- ════════════════════════════════════════════════════════════
-- Pengestrøm §2.E (revideret 29. juni): event-indtægt går nu ALTID via en
-- salgsbon (target_type='bon'), ikke en "bar" event-allokering.
--
-- Hvorfor: en bar event-allokering (target_type='event') tagger bankpenge til et
-- event MEN indgår ikke i event-regnskabet (routes/events.js beregner P&L
-- udelukkende fra eventets bons). Resultatet var usynlige penge: allokeret i
-- pengestrøm, men ikke i eventets økonomi. Den rigtige vej er "Opret bon" der
-- laver en salgsbon (event_role='sales') OG bank-afstemmer i ét hug.
--
-- Denne migration rydder eksisterende bare event-allokeringer (oprettet under
-- test af §2.E). De berørte indbetalinger vender derved tilbage til "kan ikke
-- matches" og kan oprettes korrekt via "Opret bon".
--
-- target_type-CHECK beholder 'event' som tilladt no-op-værdi (SQLite kan ikke
-- ændre CHECK uden table-recreate; koden opretter den bare aldrig længere).
-- ════════════════════════════════════════════════════════════

DELETE FROM cf_allocations WHERE target_type = 'event';
