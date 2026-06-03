# Tidszone-audit (3. juni 2026)

> Princip: **gem timestamps som UTC i DB, konvertér til dansk lokal tid (Europe/Copenhagen) ved visning.**
> Klokkeslæt/kalenderdatoer der repræsenterer en lokal hændelse (leveringstid, mødetid) gemmes
> derimod som lokal tid uden marker og må **ikke** Z-konverteres.

## Hjælpere (brug altid disse)

| Lag | Helper | Hvad |
|-----|--------|------|
| Frontend | `parseServerDate(s)` (`shared/utils.js`) | Tilføjer `Z` til bare SQLite-timestamps (`"YYYY-MM-DD HH:MM:SS"`). **Idempotent** — strings der allerede har `Z`/offset røres ikke. Sikker på ethvert UTC-timestamp. |
| Backend  | `todayISO()` / `offsetISO(days)` (`db/helpers.js`) | Dansk kalenderdato i dag / ±N dage. Brug i stedet for `new Date().toISOString().slice(0,10)` (= UTC-dato → forkert dag nær midnat). |
| Backend  | `_sqliteUtcToIso(ts)` (`routes/recipes_overview.js`) | Samme som parseServerDate, men server-side ved API-svar. |

## Hvornår er et felt UTC vs. lokalt?

- **UTC** (Z-konvertér ved visning): alt skrevet med `CURRENT_TIMESTAMP` / `datetime('now')` / `new Date().toISOString()`.
  Fx `created_at`, `updated_at`, `received_at`, `sent_at`, `delivery_events.event_time`,
  `crm_activities.created_at`, `recipe_cost_cache.refreshed_at`, Whiteboard `board_messages.created_at`.
- **Lokalt** (rå parse, ingen Z): klokkeslæt/datoer der repræsenterer en lokal hændelse.
  Fx `bons.delivery_time`/`pickup_time`/`courier_arrival_time` (`"HH:MM"`),
  `bons.delivery_date` (`"YYYY-MM-DD"`), `crm_activities.due_at` (mødetid, skrevet som `"${date} ${time}:00"`).

---

## Rettet 3. juni 2026

| Fil | Felt (kilde) | Fix |
|-----|--------------|-----|
| `office/views/bons-list.js:322` (`_blFormatHandover`) | `delivery_events.event_time` (UTC) | `parseServerDate` |
| `mobile/views/bons.js:593` (event-gruppering) | `event_at` (UTC) | `parseServerDate` |
| `mobile/views/bons.js:625` (`_mbFormatRelative`) | UTC-timestamp | `parseServerDate` |
| `mobile/views/crm.js:898` (`_mcTimelineTime`) | `crm_activities.created_at` (UTC) | `parseServerDate` |
| `shared/inventory_check.js:647,842` | `LastCheckedAt` — vi skriver UTC (`toISOString`); Grocy kan strippe `Z` ved retur | `parseServerDate` (idempotent begge veje) |
| `shared/sidekick.js:455` (`_skFormatTime`) | Whiteboard `board_messages.created_at` — bekræftet `TEXT DEFAULT CURRENT_TIMESTAMP` (UTC) | `parseServerDate` |
| `routes/cashflow.js:785` (`/invoices/bulk-confirm-paid`) | `cutoffDate` ramte forkert dag nær midnat | `offsetISO(-olderThanDays)` |
| `routes/wage_rates.js:206` (`/import`) | `today` default for `valid_from` | `todayISO()` |

## Verificeret OK (ingen rettelse — var falske positiver)

- `office/views/cashflow.js:221` (`last_upload`) — lagres med `toISOString()` (har `Z`).
- `office/views/opskrifter.js:695` (`cost_refreshed_at`) — API konverterer allerede via `_sqliteUtcToIso`.
- `office/views/crm-dashboard.js:856` + `crm-kunde360.js:2173` (`due_at`) — mødetider er **lokale** (`"${date} ${time}:00"`); rå parse er korrekt.
- `routes/quotes.js:232` (`valid_until`) — beregningen er UTC-konsistent og giver rigtig dato.
- `shared/indkob_settings.js:1414` (`hk_scraped_at`) — skrives af `services/hokaParser.js:72` via `toISOString()` (UTC med `Z`), lagres som `text_single_line` → bevarer `Z`.

---

## Follow-up runde 2 (3. juni 2026)

- [x] **#1 Dato-kun labels** — `office/views/crm-firma360.js:1049` (`_f3FormatDate`) + `settings/index.html:2800` rettet til `parseServerDate`.
- [x] **#2 `_mcTimeAgo`** — verificeret: `last_contact_at` = `CURRENT_TIMESTAMP` (UTC), callback-listen eksponerer `created_at` (UTC); `due_at` (lokal) bruges ikke her. Rettet til `parseServerDate`.
- [x] **#6 `services/cashflowSync.js`** — gennemgået: `computeDueDate` + `isBeyondAssumePaidThreshold` er allerede UTC-konsistente (rent UTC dato-aritmetik via `new Date(date + 'T00:00:00Z')`), og 90-dages-tærsklen er grovkornet. Ingen rettelse — ændring ville indføre inkonsistens uden gevinst.

## Åbne follow-ups (lav prioritet — bevidst ikke rettet)

1. **Uge/ISO-uge-beregninger** der starter fra `new Date()` + lokale `getDay/setDate` — anden mekanisme,
   dækket af bestående tests; omskrivning risikerer regression. Kan være forkert uge lige omkring midnat:
   - `routes/kitchen.js:119-120`, `routes/cashflow.js:560-577` (`/weekly`), `routes/schedule.js:34-63`, `routes/dashboard.js:36`
   - **Vurdér individuelt** hvis nogen ser forkert uge nær midnat.

2. **`services/rfm.js:70`** (lookback-vindue i måneder) — `toISOString().slice(0,10)` på et lokal-afledt
   Date-objekt. Off-by-one ved måneds-grænsen er negligibelt for et måneder-langt vindue.

3. **Eksterne API-dato-parametre** (separat kontrakt-spørgsmål — handler om hvad *modtager-API'et* forventer):
   - `services/smartplanAdapter.js:284,285,435` (Smartplan `start_date`/`end_date`)
   - `routes/horkram.js:179,277` + `services/hokaAdapter.js` (Hørkram leverings-/dropsize-datoer)
   - **Afklar:** forventer Smartplan/Hørkram dansk lokal dato eller UTC? Hvis lokal → brug `todayISO()`.

---

*Relaterer til PR #54 + #118 (#67) der fiksede backend "i dag"-udledning, og commit `1f4b551`
(changelog/mail-historik UTC→lokal). Se også CLAUDE.md "Småfixes" + memory `project_utc_today_bug.md`.*
