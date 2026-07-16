-- 123_fast_rytme_purpose.sql
-- CRM-triks (#232, #230): egen purpose til faste-rytme-listen, så kald derfra
-- kan rapporteres adskilt fra generel opfølgning. saesonoutreach (048) genbruges
-- af sæson-listen; her tilføjes kun fast_rytme.
INSERT OR IGNORE INTO activity_purposes (key, label, emoji, description, is_system, sort_order) VALUES
    ('fast_rytme', 'Fast rytme', '🔁', 'Nudge til kunde der er forsinket ift. eget bestillingssnit', 1, 45);
