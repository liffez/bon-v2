-- 157_event_labor_settings.sql
-- ════════════════════════════════════════════════════════════════════════
-- Løn på eventet, første version (§18, "den billige model").
-- Spec: docs/CLAUDE_EVENT.md §18.3–§18.5.
--
-- Eventets P&L havde ingen løn overhovedet. Timerne findes allerede: Smartplan
-- bærer dem, wage_rates prissætter dem, og lokations-splittet (migration 122)
-- skiller HQ fra Festival & Events. Det der manglede var konteringen.
--
-- Men Smartplan dækker kun de BETALTE vagter på pladsen. Transport, op- og
-- nedtagning står ikke i vagtplanen — det er som regel Leif og Anne, og de
-- har faste tider for det. Derfor disse settings: standard-timer der ganges
-- med et antal personer, så tallet er der uden at nogen taster.
--
-- INGEN TABEL endnu. Alt beregnes live ved visning (som top-up-forslaget og
-- event-menuen), så et event ingen har rørt alligevel har et tal. Manuelle
-- rækker — frivillige, folk uden for Smartplan — og frys ved 'done' kommer i
-- næste skridt; se §18.6.
--
-- Timerne og kronerne er TO tal, ikke ét. En frivillig koster 0 kr men fylder
-- på pladsen; uden opdelingen ser et event med 10 frivillige ud som om det
-- blev drevet af 2 mand.
-- ════════════════════════════════════════════════════════════════════════

INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('event_labor_setup_hours', '2',
   'Event-løn: timer til opsætning på pladsen (pr. person). Ganges med "personer til op-/nedtagning".'),
  ('event_labor_teardown_hours', '2',
   'Event-løn: timer til nedtagning og oprydning (pr. person).'),
  ('event_labor_trailer_hours', '0.5',
   'Event-løn: timer til at hente traileren — og lige så mange til at sætte den på plads igen. Tælles altså to gange.'),
  ('event_labor_transport_hours', '',
   'Event-løn: køretid HQ → eventet ÉN vej, i timer. Tom = udled fra eventets adresse via ruteberegning (anbefalet). Udfyld kun som nødplan hvis adressen ikke kan geokodes.'),
  ('event_labor_default_persons', '2',
   'Event-løn: hvor mange der er med til transport og op-/nedtagning. Bruges til standard-timerne, ikke til Smartplan-vagterne (dem tæller vi enkeltvis).'),
  ('event_labor_owner_rate', '',
   'Event-løn: timeløn (ex moms) for de standard-timer der ikke står i Smartplan. Tom = gennemsnittet af de registrerede timelønninger. Eventets P&L er et ledelsestal — feltet rører hverken lønudbetaling eller e-conomic.');
