-- 138_inbox_link_handling_backfill.sql
--
-- Redder kunde-/bon-tråde der er blevet USYNLIGE i indbakken.
--
-- Baggrund: link-flowet i routes/mail.js ("Link til Kunde" / "Link til Bon" +
-- linkUnmatchedToCustomer) oprettede tråde UDEN handling_status. Hele indbakkens
-- tråd-visning filtrerer på `mt.handling_status IS NOT NULL` (routes/mail.js) —
-- det gælder også chippen "Alle" OG søgefeltet. En linket mail forsvandt derfor
-- fra Ufordelt uden nogensinde at dukke op i en anden visning, og
-- POST /api/mail/threads/:id/reply svarede 404 på den.
--
-- Migration 104 backfillede kun de tråde der fandtes DENGANG. Denne rydder op
-- efter dem der er lækket siden. Selve lækket er lukket i routes/mail.js.
--
-- PO-/leverandør-tråde har bevidst handling_status = NULL (CLAUDE_INDBAKKE.md §2)
-- og røres IKKE — derfor WHERE-klausulens purchase_order_id/supplier_id-filter.

-- ── 1. Håndterings-status på de tråde der mangler den ──
-- Ulæst indgående  → 'aaben' (uhåndteret arbejde).
-- Ellers m. svar   → 'afventer_kunde' (vi har svaret; bolden er hos kunden).
-- Ellers           → 'aaben'. Bevidst generøst: disse tråde er alle oprettet af
--                    link-flowet efter 104, altså nyere indgående mail vi ikke
--                    kan bevise er håndteret. Hellere synlig én gang for meget
--                    end tabt igen.
UPDATE mail_threads
SET handling_status = CASE
        WHEN EXISTS (SELECT 1 FROM mail_messages mm
                      WHERE mm.thread_id = mail_threads.id
                        AND mm.direction = 'in' AND mm.is_read = 0) THEN 'aaben'
        WHEN EXISTS (SELECT 1 FROM mail_messages mm
                      WHERE mm.thread_id = mail_threads.id
                        AND mm.direction = 'out')                   THEN 'afventer_kunde'
        ELSE 'aaben' END
WHERE handling_status IS NULL
  AND purchase_order_id IS NULL
  AND supplier_id IS NULL
  AND (bon_id IS NOT NULL OR customer_id IS NOT NULL);

-- ── 2. Genberegn de pre-computede felter for de samme tråde ──
-- Link-flowet indsatte beskeder med rå SQL og sprang bogføringen over, så
-- last_inbound_at/last_outbound_at/has_unread kan være forkerte selv på tråde
-- der havde en handling_status. Idempotent — regner altid ud fra beskederne.
UPDATE mail_threads SET
  last_inbound_at  = (SELECT MAX(COALESCE(mm.received_at, mm.created_at))
                        FROM mail_messages mm
                       WHERE mm.thread_id = mail_threads.id AND mm.direction = 'in'),
  last_outbound_at = (SELECT MAX(COALESCE(mm.sent_at, mm.created_at))
                        FROM mail_messages mm
                       WHERE mm.thread_id = mail_threads.id AND mm.direction = 'out'),
  has_unread       = CASE WHEN EXISTS (SELECT 1 FROM mail_messages mm
                                        WHERE mm.thread_id = mail_threads.id
                                          AND mm.direction = 'in' AND mm.is_read = 0)
                          THEN 1 ELSE 0 END
WHERE handling_status IS NOT NULL;
