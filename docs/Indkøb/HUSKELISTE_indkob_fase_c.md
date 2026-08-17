## Indkøb — Fase C (uafklaret, afventer drift af Fase A)

> Besluttet august 2026 under gennemgang af indkøbsmodulet.
> **Skriv ikke spec før Fase A har kørt i drift i ~2 uger.**
> Fase A retter bugs, Fase B fjerner det der lyver; først derefter ved vi hvilke af
> punkterne herunder der reelt er problemer, og hvilke der bare var symptomer.
> Se `CLAUDE_INDKOB_FASE_A.md` §13 og `CLAUDE_INDKOB_ASIS.md` §12 + §14.

### Diagnosen der stadig står

Modulet mangler en entitet. Det modellerer **behov** (Grocy `shopping_list`) og **afsendt
bestilling** (`purchase_orders`), men ikke det der ligger imellem: **den bestilling jeg er
ved at lave**. Derfor er kurven kun `_ibCartItems` i browserhukommelsen (`indkob.js:45`),
derfor er "Bestillinger" tvunget sammen med "Indkøbsliste", og derfor har et engangskøb
ingen indgang — alt skal først være et *behov* før det kan blive en *ordre*.

Tre lag i stedet for to:

| Lag | Ejer | Status |
|---|---|---|
| Behov | Grocy `shopping_list` | uændret |
| **Kladde** | `purchase_orders.status='draft'` | **mangler i brug** |
| Afsendt | samme tabel, `'sent'`+ | findes |

### ⚠️ Hård binding: varemodtagelsen skal med i samme deploy

Beslutningen om at `purchase_order_lines` bliver eneste sandhed om "bestilt", og at
`ordered_*` degraderes til en projektion vi skriver men aldrig læser, **kan ikke
gennemføres i indkøbsmodulet alene.**

`_vmBuildItemsFromShoppingList()` *læser* `ordered_*` — ikke kun til oprydning, men til at
bygge selve varelisten (ASIS §7). Migreres indkøb uden varemodtagelse, står modtagelsen
med en tom liste, og bestilte varer kommer aldrig på lager.

De to moduler migreres sammen. Det er en betingelse, ikke en anbefaling.

A7 i Fase A gør springet kortere: når matchningen allerede går på id frem for navn, er
vejen til at matche på `purchase_order_lines.id` kort.

### Punkter

| Punkt | Afhænger af | Findes allerede | Mangler |
|---|---|---|---|
| Kladde-entitet i brug | Fase A + varemodtagelse | `status='draft'` i CHECK (005); `GET /pending` filtrerer allerede på `'draft'` (`orders.js:74`); `PUT /pending/:id` kan sætte status + dato | `POST /pending` hardcoder `'sent'` (`orders.js:130`); intet UI |
| "Bestillinger" som ægte view | kladden | — | Kladder + afsendte som selvstændig skærm. Pill'en hedder midlertidigt "Bestil" efter Fase B (B1.2) — rul omdøbningen tilbage her |
| Engangskøb (vare uden Grocy-produkt) | A4, A5c | `item_id` nullable (A4); `/search` returnerer `salesUnits` (A5c); `product_name_snapshot`, `line_source` (A4) | UI: søg hos leverandør → linje direkte i kladde |
| Erstatning for udgået vare | kladden, A8 | `replaces_barcode` (A4); tilgængelighedsstatus (A8). **Hoka har selv "Vis forslag til erstatning"** — 17163019 foreslår 15582034 | Endpointet er ikke kortlagt. Byg ikke et eget lighedsforslag før vi ved om Hokas kan bruges |
| Persistér udgået-status | A1 | `_isHkCheckDead()` (`indkob_settings.js:1577`) | `_isDeadBarcodes` (linje 1604) lever kun i browserhukommelse — nulstilles ved hver kørsel. Skal gemmes, og vises på indkøbslisten frem for kun i settings |
| Kildefelt på `shopping_list` | — | — | `source` + `source_ref`. Se note nedenfor |
| Bestilling ↔ modtagelse kobles | kladden | — | PO står `sent` for evigt i dag; ingen afstemning bestilt vs. modtaget (ASIS §12.6) |

### Beslutninger taget (gentag ikke diskussionen)

| | |
|---|---|
| Kladden er **vores**, ikke Hokas kurv | Én eksplicit "send til kurv" til sidst. Ellers to steder der kan divergere hvis nogen rører kurven på hoka.dk |
| Enhedsvælger sidder på **chippen** | Bygget i A2. Hoka bruger selv radioknapper samme sted |
| `purchase_order_lines` er eneste sandhed om "bestilt" | `ordered_*` degraderes til projektion. **Kræver samtidig migrering af varemodtagelsen** — se binding ovenfor |
| Leveringsdato flytter fra `localStorage` op på kladden | Midlertidig bolig i A1 — se kodekommentar der |
| Kilopris hører til på (barcode × salgsenhed) | A5d. `supplier_price_per_kg` på produktet er en projektion, ikke en kilde |

### ASIS §14 spørgsmål 2 og 8 er ét spørgsmål

De behandles som to. Uden et kildefelt på `shopping_list`-linjen kan forecast aldrig skrive
til listen forsvarligt — to kørsler kan ikke skelnes fra hinanden, og der er intet at
afstemme mod. Med `source` + `source_ref` bliver et forecast-push idempotent: slet mine egne
tidligere forecast-linjer i vinduet, skriv de nye, rør intet andet.

Det ændrer ikke på at linjen slettes ved fuld levering. Kildefeltet lever kun så længe linjen
gør, og Grocys stock-log er stadig sporet over hvad der faktisk kom ind.

Overvej at skrive dem sammen til ét spørgsmål i §14.

### Før spec skrives

1. To ugers faktisk brug efter Deploy 2. **Noter hvad der gør ondt — ikke hvad du tror mangler.**
2. Interaktiv HTML-mockup til godkendelse. C er UI-tungt; spec uden mockup bliver forkert.
3. Opdatér `CLAUDE_INDKOB_ASIS.md` når Deploy 2 er ude, så den ikke beskriver rettede fejl.

### Åbent spørgsmål

Er kladden overhovedet nødvendig? Tre af fire smertepunkter i ASIS §12 viste sig at være bugs,
ikke arkitektur. Måske er engangskøb det eneste der reelt mangler — og det kan muligvis løses
med en søgeknap på indkøbslisten uden en ny entitet. **Afgøres af brugen, ikke af analysen.**
