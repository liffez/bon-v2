# Preorder / kunde-forudbestilling — sådan fungerer det NU (as-is)

> Formål: dette dokument beskriver **den nuværende faktiske tilstand** af kundens
> forudbestillings-flow (embed-formularen på `ristetrug.dk/bestil`), grounded i koden
> (august 2026), som grundlag for at rette dokumentations-drift og planlægge næste skridt.
> Det beskriver IKKE hvordan det *bør* være — kun hvordan det er.
> Skrevet så det kan læses koldt af en der ikke kender kodebasen (fx claude.ai).
>
> **Baggrund:** flowet blev specificeret i `CLAUDE_BESTILLING_FORM.md` (maj 2026) og skulle
> være del af det store `CLAUDE_FORM_BUILDER_FUNDAMENT.md`-projekt. Men koden er siden drevet
> markant fra begge specs: feltnavne, endpoints, menu-kilde og datamål er anderledes, og en
> række drifts-features (ferielukket, hastebestilling, ejer-notifikation) findes slet ikke i
> specs. Dette dokument er sandheden — læs det FØR du bruger de to ældre specs som opskrift.

---

## 1. Grundmodel: ét flow, ét endpoint — ingen "form builder"

Der findes præcis **én** kunde-forudbestillings-form, og den er **standalone hardcoded HTML** —
ikke output fra en form-builder-motor.

```
WordPress (ristetrug.dk/bestil — DIVI Code Module)
        │  <iframe src="https://bon.ristetrug.dk/embed/bestilling?menu=standard">
        │  postMessage høj-resizer (parent ↔ iframe)
        ▼
GET /embed/bestilling            (routes/embed.js) → serverer public/embed/bestilling.html
        │  fetch /embed/config    → cutoff, leveringszoner, ferie, hastebestilling
        │  fetch /embed/menus/standard.json → menu (settings ELLER Grocy)
        │  fetch DAWA + OSRM       → adresse + leverings-estimat
        ▼
POST /webhook/bestilling         (routes/web-orders.js)  ← IKKE /api/formbuilder/webhook
        │  honeypot · ferie-guard · find/opret firma+kunde · EAN · DAWA-parse
        │  createBon() (fælles helper, #237) → bon med status NY
        │  INSERT web_orders (audit) · SSE bon_created {source:'web_order'}
        ▼
Mail (services/mailService.js, fire-and-forget)
        │  web_order_confirmation        → kunden
        └  web_order_owner_notification  → ejer (hvis sat)
```

> ⚠️ **Kernefund:** `CLAUDE_FORM_BUILDER_FUNDAMENT.md` beskriver et generelt form-byggesystem
> (~20 byggeklodser, `forms`/`form_submissions`/`form_tokens`-tabeller, `routes/forms.js`,
> 6 submission-handlere, drag-drop builder). **Intet af dette er bygget.** Der findes ingen
> `forms`-tabel, ingen renderer, ingen byggeklodser. Fundamentet er et rent design-dokument.
> Den form der kører i drift er én håndskrevet HTML-fil. Brug fundamentet som visionsramme,
> ikke som beskrivelse af noget der eksisterer.

---

## 2. Hvor bor tingene

### Filer

| Fil | Rolle |
|-----|-------|
| `public/embed/bestilling.html` | HELE formen — én fil, ~1500 linjer, inline CSS+JS, ingen build-step. Loader IKKE Bon v2 shared-filer (den er embedded på et fremmed domæne) |
| `public/embed/test-harness.html` | Lokal WordPress-mock til iframe-test |
| `routes/embed.js` | Serverer formen + `/embed/config` + `/embed/menus/:id.json` + `/embed/grocy-preview` |
| `routes/web-orders.js` | Webhook-modtager + `GET /api/web-orders` + `GET /api/web-orders/pending` |
| `db/helpers.js` `createBon()` | Fælles bon-oprettelse (#237) — webhook'en opretter bonnen herigennem |
| `docs/wordpress_divi_snippet.html` | Kopier-klar iframe-snippet til WordPress |

> **Bemærk:** `routes/formbuilder_webhook.js` og `public/menus/standard.json` — som begge
> ældre specs refererer — **findes ikke**. De var planlagte navne der aldrig blev til noget.

### Mount + CORS (server.js)

- Webhooken mountes på `app.use('/webhook', webhookCors, webOrdersRouter)` **før** den globale
  `/api`-auth-gate → derfor er den public.
- `GET /api/web-orders*` mountes separat EFTER gaten (kræver login).
- CORS `WEBHOOK_ALLOWED_ORIGINS`: `https://ristetrug.dk`, `https://www.ristetrug.dk`,
  `https://bestil-form.netlify.app`.
- En tidligere utilsigtet public kopi af webhooken (`/api/web-orders/bestilling`) er lukket.

### Settings-keys (alle med prefix `bestilling.` — migration 058, 059, 120)

| Key | Betydning |
|-----|-----------|
| `bestilling.base_lat` / `base_lon` | HQ-koordinat til OSRM-leverings-estimat |
| `bestilling.cutoff_time` | Sidste bestillingstime (time-tal) |
| `bestilling.cutoff_lead_days` | Antal *tælle-dage* frem der kræves før levering |
| `bestilling.cutoff_days` | CSV af ugedage der TÆLLER som lead-dage (fx `mon,tue,wed,thu,fri`) |
| `bestilling.delivery_days` | CSV af ugedage der tager imod levering (weekend kan slås til/fra) |
| `bestilling.delivery_config` | JSON: cykel + taxa-zoner (priser, postnumre, maxafstand) |
| `bestilling.cutoff_override_date` | Hastebestilling: ISO-dato. Aktiv KUN når den == dagens danske dato → selv-nulstillende |
| `bestilling.closed_dates` | JSON `[{from,to,label}]` — ferielukkede intervaller |
| `bestilling.menu_source` | `'manual'` eller `'grocy'` |
| `bestilling.menu_<id>` | Selve menuen som JSON (manuel mode) — fx `bestilling.menu_standard` |

Andre relevante settings: `webhook_secret` (valgfri header-validering),
`web_order_notification_email` (ejer-modtager), `booking_public_url_base` (bygger drawer-link i ejer-mail).

### Migrations

| Migration | Indhold |
|-----------|---------|
| 044 | `web_orders`-tabel + `web_order_confirmation`-skabelon + `webhook_secret` |
| 045 | Fix: mail-skabeloner bruger `{{tag}}` (IMAP-routing) |
| 058 | 8 `bestilling.*` settings (base, cutoff, delivery, `menu_standard`) |
| 059 | `bestilling.menu_source` (`manual`/`grocy`) |
| 062 | `web_order_owner_notification`-skabelon + `web_order_notification_email`-setting |
| 063 | `bons.acknowledged_at` + `acknowledged_by_user_id` |
| 120 | `bestilling.closed_dates` (ferielukket) |

---

## 3. Felt-kontrakten — hvad formen faktisk sender

Formen sender et fladt JSON-objekt (`Object.fromEntries(FormData)`) + nogle tilføjede felter.
**Feltnavnene afviger fra `CLAUDE_BESTILLING_FORM.md`** (som brugte `navn`, `tlf`, `leveringsdato`, …):

| Faktisk feltnavn | Type | Note |
|------------------|------|------|
| `first_name`, `last_name` | text | (spec sagde ét felt `navn`) |
| `email`, `phone` | text | (spec sagde `tlf`) |
| `company` | text | valgfrit |
| `ean_info` | text | faktura/EAN-fritekst; 13-cifret EAN udtrækkes med regex |
| `ordertype` | `catering`\|`pickup` | styrer om adresse kræves |
| `validatedAddress` | DAWA-objekt | `{tekst, postnr, by, lat, lon}` |
| `delivery_date`, `delivery_time` | ISO / HH:MM | (spec sagde `leveringsdato`/`leveringstid`) |
| `delivery_extra` | text | etage/indgang/kode → `bons.delivery_notes` |
| `pax` | number | |
| `sandwichvalg` | `rr_blander`\|`eget_valg` | (også `rr_vælger` accepteres bagudkompat) |
| `wishes` | textarea | fritekst-ønsker |
| `menu_items` | array `[{id,count}]` | struktureret — se §6 |
| `contact_person`, `contact_phone` | text | kontakt på dagen |
| `_form_meta` | objekt | `{menu_id, menu_version, form_version}` audit |
| `website` | honeypot | skal være tom |

Fejl-fallback i formen: hvis POST fejler, viser den en `mailto:bon@ristetrug.dk` med hele
bestillingen i body, så kunden aldrig taber sin indtastning.

---

## 4. Hvor lander data i bonnen

`handleWebOrder()` kalder `createBon()` og mapper felterne sådan her — **ikke** som de to
specs beskrev (`bons.notes` / `kitchen_info`):

| Kilde | Bon-felt |
|-------|----------|
| `sandwichvalg` + `wishes` + `_form_meta` | `bons.customer_wishes` (samlet flerlinje-blok, se nedenfor) |
| `ean_info` | `bons.invoice_info` |
| `contact_person` / `contact_phone` | `bons.day_contact_name` / `day_contact_phone` |
| `delivery_extra` | `bons.delivery_notes` |
| `ordertype` | `bons.delivery_type` (`delivery`\|`pickup`) |
| DAWA-adresse | ny `addresses`-række → `bons.delivery_address_id` |
| — | `bons.status_id` = **NY** |

`customer_wishes` sammensættes som:
```
Sandwichvalg: Køkkenet blander

<kundens fritekst-ønsker>

[Form: standard v2026-05]
```

Firma matches/oprettes på `name`; kunde matches/oprettes på `email`. EAN skrives kun på firmaet
hvis feltet er tomt (overskriver ikke).

---

## 5. Webhook-flow trin for trin (routes/web-orders.js)

1. **Secret** — hvis `webhook_secret` er sat, kræves matchende `x-webhook-secret`-header (ellers 401).
2. **Honeypot** — `website` udfyldt → drop stille, returnér null.
3. **Påkrævet** — `first_name` + `delivery_date` + `delivery_time` skal findes.
4. **Ferie-guard** — server tjekker `bestilling.closed_dates`; et direkte API-kald kan ikke snige
   en bestilling ind i en lukket periode (formen spærrer allerede i UI).
5. Firma find/opret · EAN-udtræk · kunde find/opret · adresse (kun ved levering).
6. `createBon()` → bon med status NY + changelog + SSE `bon_created {source:'web_order'}`.
7. INSERT i `web_orders` (audit), status hardcodet til `'konverteret'`, hele payloaded gemt i `raw_data`.
8. Fire-and-forget: kundebekræftelse + (hvis sat) ejer-notifikation.
9. **Altid HTTP 200** til klienten — fejl logges server-side, vises aldrig til kunden (anti-spam).

---

## 6. Menu: to kilder, styret af én setting

`GET /embed/menus/:id.json` vælger kilde ud fra `bestilling.menu_source`:

- **`manual`** (default): læser menu-JSON fra `settings.bestilling.menu_<id>`. Redigeres i
  Settings → Bestilling — Menu (kategorier, items, tags, allergener). Har en "Importér fra Grocy"-knap.
- **`grocy`**: bygger menuen live fra `grocyAdapter.getRecipes()` (kun `sellable=1`), mapper
  `grupper` → kategori, og læser optionelle userfields `bestil_tags` (CSV), `bestil_allergens`,
  `bestil_skjul` (`'1'` = skjul). Falder automatisk tilbage til `manual` hvis Grocy er nede.

`GET /embed/grocy-preview` tvinger Grocy-render (kræver login) — bruges af import-flowet i Settings.

> ⚠️ **Kernefund — `menu_items[]` er struktureret men INERT.** Formen sender faktisk
> `menu_items: [{id, count}]` (kundens klik i menu-pickeren), og hele payloaded — inkl.
> `menu_items` — gemmes i `web_orders.raw_data`. **Men intet backend-kode parser dem.** De
> bliver ikke til bon-linjer; kun `wishes`-fritekst ender i `customer_wishes`. Dvs. det
> `CLAUDE_BESTILLING_FORM.md` kalder et bevidst fravalg ("`valgte_retter` sendes IKKE
> struktureret") er forkert: dataet ER der ved grænsen, det bliver bare ikke brugt.
> Det er den største uindfriede mulighed i flowet — se §9.

> **Note:** `ALLOWED_MENUS = ['standard']` er hardcodet i `routes/embed.js`. Trods `?menu=<id>`-
> arkitekturen virker kun `standard` i praksis; alt andet redirecter/404'er.

---

## 7. Config-features der IKKE står i nogen spec

Disse kører i drift men mangler i både `CLAUDE_BESTILLING_FORM.md` og fundamentet:

| Feature | Hvordan |
|---------|---------|
| **Ferielukket** | `bestilling.closed_dates` `[{from,to,label}]`. Formen spærrer datoer + viser label; server-guard i webhook (migration 120) |
| **Hastebestilling** | `bestilling.cutoff_override_date` = ISO-dato. Aktiv KUN på dagens danske dato → selv-nulstillende. Åbnes manuelt i Settings |
| **Per-ugedag cutoff** | `cutoff_lead_days` tæller kun gennem dage i `cutoff_days` (CSV); `delivery_days` styrer hvilke ugedage der modtager levering. Mere avanceret end spec'ens simple `cutoff_days_before` |
| **Ejer-notifikation** | `web_order_owner_notification`-mail til `web_order_notification_email` med drawer-link (migration 062) — løser observation #043 |
| **Grocy-menu** | `menu_source='grocy'` (migration 059) |

---

## 8. Synlighed af nye bestillinger (observations #040–#043)

De fire UX-findings i `docs/archive/observations/OBSERVATIONS_WEB_ORDER_UX.md` er i vid
udstrækning adresseret siden de blev skrevet:

| # | Finding | Status nu |
|---|---------|-----------|
| #040 | Mobil viste "Ukendt"/"?" | Løst — `customer_name`-fallback (commit c1274b9) |
| #041 | Ingen aktiv notifikation | Grundlag på plads: office web-order-toast (SSE `bon_created`), mobil "Nye"-inbox |
| #042 | Fremtidige ordrer skjult | `bons.acknowledged_at` (063) + `GET /api/web-orders/pending` (alle uacknowledgede, uanset dato) |
| #043 | Ejer-mail manglede | Løst — `web_order_owner_notification` (062) |

`/api/web-orders/pending` returnerer rig payload (kunde, dato, pax, ønsker, adresse, status)
for alle bons med `acknowledged_at IS NULL`. **Åbent:** en eksplicit "bekræft modtaget"-knap
der sætter `acknowledged_at` er ikke bekræftet wired i alle UI-flader — pending-listen findes,
men acknowledge-handlingen bør verificeres i drift.

---

## 9. Åbne huller / hvad en restrukturering bør tage stilling til

1. **`menu_items[]` er inert (§6).** Kunden vælger konkrete retter, men office skal taste dem
   som bon-linjer i hånden. Koblingen til menu-agenten (spec findes) er den største gevinst
   der ligger og venter — dataet er der allerede i `raw_data`.
2. **Doc-drift mod de to ældre specs.** `CLAUDE_BESTILLING_FORM.md` peger på ikke-eksisterende
   filer/endpoints/feltnavne. Enten opdateres den, eller den markeres som "afløst af dette
   as-is-dokument" (anbefalet — den er en implementerings-guide til noget der allerede er bygget anderledes).
3. **Form Builder-fundamentet er ubygget.** Beslut om det stadig er retningen (parkeret per
   roadmap) eller om embed-formen skal forblive standalone. Byg ikke den generelle motor før
   der er flere konkrete formularer der retfærdiggør abstraktionen.
4. **`grocy_product_picker` + Grocy-userfields** (fra fundamentet) er et data-projekt så meget
   som kode: `bestil_tags`/`bestil_allergens`/`bestil_skjul` skal udfyldes i Grocy før
   Grocy-menuen er kurateret. Samme sekvenserings-fælde som CO₂-modulet.
5. **Acknowledge-flow (§8)** bør færdiggøres som ét sammenhængende "uhåndterede preorders"-sted
   med eksplicit bekræft-tilstand — ikke kun en transient toast der misser nat/weekend-ordrer.

---

*Oprettet: august 2026. Grounded i koden (routes/embed.js, routes/web-orders.js,
public/embed/bestilling.html, migrations 044–063+120). Afløser som sandhedskilde de
implementerings-detaljer i `CLAUDE_BESTILLING_FORM.md` der er drevet fra virkeligheden.*
