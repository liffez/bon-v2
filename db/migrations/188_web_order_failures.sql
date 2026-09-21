-- 188: web_orders skal kunne bære en ordre der IKKE blev til en bon (#638)
--
-- Rækken blev historisk skrevet EFTER bonen. Gik createBon galt, efterlod
-- bestillingen derfor intet spor overhovedet — kunden fik "tak for din
-- bestilling", og ingen kunne bagefter se at ordren var væk. Rækken skrives nu
-- FØRST, og `failure_reason` bærer hvorfor den ikke blev til noget.
--
-- To tilstande bruger kolonnen, og de betyder ikke det samme:
--   status='ny'     + failure_reason  → teknisk fejl. Kunden fik besked om at
--                                       skrive til os; office skal følge op.
--   status='afvist' + failure_reason  → bevidst afvist (deadline, ferielukket).
--                                       Kunden fik en forklaring. Gemt så vi
--                                       kan se hvor mange ordrer reglerne koster.
--
-- Bagudkompatibel: kolonnen er NULL på alle eksisterende rækker, og en NULL
-- betyder præcis det den plejede — ingen kendt fejl.

ALTER TABLE web_orders ADD COLUMN failure_reason TEXT;

-- Office kvitterer for en fejlet ordre når kunden er ringet op. Uden den ville
-- listen aldrig kunne ryddes, og et panel der altid viser det samme holder man
-- op med at læse — samme svigt som vagthunden i #359.
ALTER TABLE web_orders ADD COLUMN acknowledged_at DATETIME;
ALTER TABLE web_orders ADD COLUMN acknowledged_by_user_id INTEGER REFERENCES users(id);

-- Opslaget office-panelet laver: ordrer der ikke nåede at blive en bon og som
-- ingen har kvitteret for endnu.
CREATE INDEX IF NOT EXISTS idx_web_orders_unconverted
    ON web_orders(created_at) WHERE bon_id IS NULL AND acknowledged_at IS NULL;
