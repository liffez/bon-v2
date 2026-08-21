-- 152_prep_ahead_days.sql
-- ============================================================
-- "Lav snart"-listen (#266 §4.3): hvor mange kalenderdage frem køkkenet
-- planlægger efter.
--
-- 3 dage er valgt fordi det dækker de lange lead-times i `RR Produktion`
-- (gris ~5 timer, sylt dagen før) uden at fylde listen med arbejde der først
-- skal gøres i næste uge. Kan ændres uden kodeændring.
-- ============================================================

INSERT OR IGNORE INTO settings (key, value, description)
VALUES ('prep_ahead_days', '3',
        'Antal kalenderdage frem (inkl. i dag) som "Lav snart"-listen planlægger efter');
