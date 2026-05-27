# Bestillingsformular — embed via DIVI

## Læs FØR du skriver kode

1. `CLAUDE.md` (rod) — stack, principper, status
2. `BON_V2_PRINCIPPER.md` — ufravigelige regler
3. `bon_v2_datamodel_v2.md` — skema (specifikt: `system_settings`, `bons.notes`, `bons.kitchen_info`)
4. **`CLAUDE_BESTILLING_FORM.md` — hovedspec for opgaven**

## Reference-filer (vedhæftet)

| Fil | Brug |
|---|---|
| `bestilling_inline_v5.html` | UX-mockup — kilden til CSS, smart-append-regex, menu-render-pattern, allergen-toggle |
| `bestilling_v2.html` | Nuværende formbuilder-output — kilden til DAWA-autocomplete, OSRM-kald, cutoff-warning, formbuilder-felter |
| `wordpress_embed_test.html` | Test-harness — bruges lokalt til at verificere iframe-rendering + postMessage høj-resizer |

## Opgave

Implementér embed-bestillingsformular der erstatter JotForm på `ristetrug.dk/bestil`.

Følg de **15 trin** i specens "Implementeringsrækkefølge"-sektion. Stop og bekræft ved disse check-points:

| Check-point | Hvad verificeres |
|---|---|
| Efter trin 3 | `curl /embed/config` returnerer korrekt JSON-struktur (base, cutoff, delivery) |
| Efter trin 6 | Form renderer i browser, henter menu-JSON og config-endpoint korrekt |
| Efter trin 9 | Webhook accepterer ny payload uden valideringsfejl, opretter bon med status NY |
| Efter trin 13 | `wordpress_embed_test.html` mod localhost virker, høj-resizer reagerer ved menu-åbning |

## Principper for DENNE opgave

- Embed-formen er bevidst **standalone** — ikke formbuilder-genereret. Det er den pragmatiske vej til at få noget i drift; migrering til ægte field-types sker ved formbuilder-udvidelsen
- Alle CONFIG-værdier kommer fra `system_settings` med `bestilling.*` prefix, hentes via `/embed/config`. **Hardcod intet.**
- Webhook-udvidelse (trin 9) er en del af denne opgave, ikke et separat ticket
- `valgte_retter` sendes **ikke** som strukturerede data — kun som tekst i `wishes`-feltet (præcis hvad smart-append i textareaen producerer)

## Ikke i scope nu

- Migration af foldout/chips/menu-picker til formbuilder field-types
- Settings-UI til redigering af `bestilling.delivery_config` (kontoret redigerer i database indtil videre)
- Multiple menuer ud over `standard` (men arkitekturen skal understøtte det — `?menu=<id>`)

## Når du er færdig

Opdatér `CLAUDE.md`:
- Tilføj `routes/embed.js` og `public/embed/bestilling.html` til "Hvad der er bygget"-listen
- Sæt status på "Formbuilder webhook-URL sat + HTML publiceret til ristetrug.dk/bestil" → ✅
- **Tilføj backlog-punkt:** "Formbuilder-udvidelse — ægte field-types (`info_box`, `chip_group`, `menu_picker`, `option_group` med subtekst). Erstatter den hardcodede `embed/bestilling.html`. Spec skrives separat. Ikke akut — den nuværende standalone-form fungerer indtil videre."
- Skriv næste opgave (forslag: ny menu — `festival.json` eller `event.json`)
