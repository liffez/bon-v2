-- 174_smagning_thankyou_text.sql
-- ---------------------------------------------------------------------------
-- Takkesiden sagde det samme forkerte som bekræftelsen gjorde.
--
-- "Adresse: {{firmaAdresse}}" er VORES adresse — men en smagning køres ud til
-- kunden. Variablen blev oven i købet aldrig fyldt (booking/smagning.html
-- hardkodede den til tom streng), så linjen stod bare som "Adresse:" uden
-- noget efter, og "ring til os på ." manglede telefonnummeret.
--
-- Begge dele fyldes nu af siden. Teksten rettes her — kun hvis skabelonen
-- stadig står præcis som seedet i 051. Har nogen skrevet i den, er den deres.
-- ---------------------------------------------------------------------------

UPDATE page_templates
   SET body_text = replace(body_text, 'Adresse: {{firmaAdresse}}', 'Vi leverer til: {{leveringsAdresse}}')
 WHERE key = 'thankyou_smagning'
   AND body_text = 'Vi glæder os til at se dig {{datoFormatteret}} kl {{tid}}.

Mødetype: {{moedeTypeLabel}} ({{varighed}} min)
Adresse: {{firmaAdresse}}

Skulle du være forhindret, så ring til os på {{firmaTelefon}} eller svar på bekræftelsesmailen.

På gensyn!';
