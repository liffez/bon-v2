-- Cashflow: lad umatchede banktransaktioner ignoreres + få en fri note.
-- Indgående posteringer der aldrig får en faktura (afvisninger, overførsler,
-- gebyrer) kunne tidligere ikke fjernes fra "kan ikke matches"-listen.

ALTER TABLE cf_transactions ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cf_transactions ADD COLUMN note TEXT;
