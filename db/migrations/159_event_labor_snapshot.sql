-- 158_event_labor_snapshot.sql
-- ════════════════════════════════════════════════════════════════════════
-- Frys eventets løn når eventet er afsluttet (§18.10 trin 4).
--
-- Lønnen udledes fra Smartplan, som er et LEVENDE system: retter nogen en
-- vagt tre uger efter festivalen, flytter et afsluttet events resultat sig.
-- Samme problem som driftsregnskabet har for afsluttede dage, og samme
-- løsning (labor_day_snapshot, migration 091): frys ved første visning
-- efter at eventet er sat til 'done'.
--
-- KUN LØN-DELEN FRYSES — ikke resultatet. `result_on_site` regnes altid live
-- af den frosne løn og den AKTUELLE P&L. Frøs vi også resultatet, ville et
-- retur bogført bagefter (§18.9) få lønvisningen og /overview til at modsige
-- hinanden, og så er begge tal værdiløse.
--
-- Frys ved FØRSTE VISNING frem for ved status-skiftet: så bliver events der
-- allerede står som 'done' også frosset, og en fejlet PATCH kan ikke
-- efterlade et event uden snapshot.
--
-- Et event der genåbnes viser live tal igen; snapshottet bliver liggende og
-- tages i brug igen når eventet lukkes. Er der rettet i mellemtiden, skal
-- det genberegnes bevidst (POST /:id/labor/refreeze, admin) — samme regel
-- som driftens /refreeze.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE event_labor_snapshot (
    event_id           INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
    data_json          TEXT    NOT NULL,               -- frosset løn-del (uden resultat-felter)
    frozen_at          TEXT    NOT NULL DEFAULT (datetime('now')),
    frozen_by_user_id  INTEGER REFERENCES users(id)
);
