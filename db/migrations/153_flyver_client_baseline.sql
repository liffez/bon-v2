-- 153_flyver_client_baseline.sql
-- ============================================================
-- #521: en ny skærm fik alle flyvere der nogensinde er sendt.
--
-- "Ulæst" var defineret som *ikke i notification_reads*, og reads er
-- nøglet på et localStorage-UUID. En frisk browser har nul rækker og
-- arvede derfor hele historikken — også flyvere på bons der for længst
-- var leveret og faktureret.
--
-- Her lægges nulpunktet: første gang et client_id spørger, stemples det,
-- og derefter ser skærmen kun flyvere sendt siden da. O(1) pr. klient —
-- modsat at skrive en read-række for hver eksisterende flyver ved første
-- besøg, som ville vokse med klienter × flyvere.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_clients (
    client_id     TEXT PRIMARY KEY,
    first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Kendte skærme beholder deres RIGTIGE nulpunkt: tidspunktet for deres
-- første kvittering. Uden dette ville hver eksisterende skærm få sat
-- nulpunktet til deploy-tidspunktet og dermed tabe en flyver der lige nu
-- ligger uklikket på en aktiv bon.
--
-- `read_at` og `notifications.created_at` skrives begge med
-- CURRENT_TIMESTAMP, altså samme `YYYY-MM-DD HH:MM:SS`-format. De
-- sammenlignes som tekst, så to skrivemåder ville sortere forkert
-- (jf. migration 150).
INSERT OR IGNORE INTO notification_clients (client_id, first_seen_at)
    SELECT client_id, MIN(read_at)
      FROM notification_reads
     WHERE client_id IS NOT NULL
     GROUP BY client_id;

-- Hvor længe efter leveringsdatoen en flyver stadig hentes frem.
-- Status-filteret fanger normalt en afsluttet bon, men køkkenet når ikke
-- altid at trykke LEVERET — og ved midnat er datoen teknisk passeret.
-- Marginen er der for ikke at tabe en besked i det hul.
INSERT OR IGNORE INTO settings (key, value, description)
VALUES ('flyver_grace_days', '2',
        'Antal dage efter leveringsdatoen hvor en flyver stadig vises som ulæst');
