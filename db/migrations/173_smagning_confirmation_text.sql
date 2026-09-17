-- 173_smagning_confirmation_text.sql
-- ---------------------------------------------------------------------------
-- Bekræftelsen inviterede kunden ind til os.
--
-- Skabelonen sagde "Hos os: {{firmaAdresse}}" — men en smagning køres UD til
-- kunden. Linjen var altså ikke bare uinformativ, den var forkert: den fortalte
-- kunden at hun selv skulle møde op.
--
-- Erstattes af {{leveringsAdresse}}, som fyldes af bookingens egen adresse
-- (migration 172). Som alle andre skabelon-migrationer røres teksten KUN hvis
-- den stadig står præcis som seedet i 051 — har nogen skrevet i den, er den
-- deres, og variablen ligger som chip i Settings.
-- ---------------------------------------------------------------------------

UPDATE mail_templates
   SET body_text = replace(
           body_text,
           '  Hos os:      {{firmaAdresse}}',
           '  Vi leverer:  {{leveringsAdresse}}'
       )
 WHERE key = 'booking_smagning_confirmation'
   AND body_text = 'Hej {{kundeFornavn}},

Tak for din booking — vi glæder os til at se dig.

  Mødetype:    {{moedeTypeLabel}}
  Dato:        {{datoFormatteret}}
  Tid:         {{tid}} ({{varighed}} min)
  Hos os:      {{firmaAdresse}}

Skulle der ske noget der gør at du er nødt til at flytte, så svar bare på denne mail eller ring til os på {{firmaTelefon}}.

På gensyn!';
