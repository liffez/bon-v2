-- 145_economic_payments.sql
-- e-conomics betalingsposteringer — hvornår en faktura FAKTISK blev betalt.
--
-- Indtil nu havde vi kun to kilder til en betalingsdato, og begge var dårlige:
--   • cf_invoices.betalt_dato: for 2.539 af 2.842 betalte fakturaer er den lig
--     LEVERINGSDATOEN (sat af cashflowSync ved BETALT). Det er ikke en betaling.
--   • bankmatch: kun 303 fakturaer, og udvalget er skævt — auto-matcheren scorer
--     på nærhed til forfaldsdatoen, så en sen betaling uden fakturanr i teksten
--     bliver aldrig registreret. Netop de langsomme betalere var usynlige.
--
-- e-conomics finansposteringer har svaret hele tiden; vi manglede bare rollen
-- (Bookkeeping, åbnet 11. august 2026). En customerPayment-postering bærer dato,
-- beløb, kunde OG fakturanummer — altså "denne betaling lukkede den faktura, på
-- den dag". Målt: 1.693 af vores fakturaer får en ægte betalingsdato mod 303,
-- og 119 kunder får nok historik til en rytme.
--
-- Vi SPEJLER kun. e-conomic ejer posteringerne; vi bogfører aldrig.

CREATE TABLE IF NOT EXISTS cf_economic_payments (
    -- e-conomics eget posteringsnummer. Verificeret globalt unikt på tværs af
    -- regnskabsår (1.278/1.278 i 2025+2026), så det duer som nøgle og gør
    -- synken idempotent uden at skulle nøgle på (år, nummer).
    entry_number     INTEGER PRIMARY KEY,
    entry_date       DATE    NOT NULL,
    -- amountInBaseCurrency. NEGATIVT = penge modtaget (kredit på debitorkontoen).
    -- Positive findes også (62 af 1.278) — tilbagebetalinger og korrektioner.
    amount           REAL    NOT NULL,
    -- e-conomics bookedInvoiceNumber. Matcher cf_invoices.economic_number.
    -- Kan være NULL (49 af 1.278): en betaling uden fakturakobling.
    invoice_number   TEXT,
    customer_number  TEXT,
    text             TEXT,
    voucher_number   TEXT,
    accounting_year  TEXT,
    synced_at        TEXT    DEFAULT (datetime('now'))
);

-- Opslag fra faktura → betaling er den varme sti (rytme + bankmatch).
CREATE INDEX IF NOT EXISTS idx_cf_eco_pay_invoice ON cf_economic_payments(invoice_number);
-- Dato+beløb bruges til at genkende en bankpostering som den samme betaling.
CREATE INDEX IF NOT EXISTS idx_cf_eco_pay_date    ON cf_economic_payments(entry_date);
