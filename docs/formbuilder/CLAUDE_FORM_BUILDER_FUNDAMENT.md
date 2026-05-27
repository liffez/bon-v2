# CLAUDE_FORM_BUILDER_FUNDAMENT.md

> **Status:** Arbejdsdokument — fundament for Form Builder-modulet i Bon v2.
> **Dato:** maj 2026
> **Forhold til andre dokumenter:** Dette er det foundationale dokument. Den endelige arkitektur-spec (`CLAUDE_FORM_BUILDER.md`) skrives senere baseret på denne.
>
> **Formål:** Fange alle designbeslutninger, principper og kataloger der er udviklet under designsessionen i maj 2026, så ingen indsigter mistes.

---

## 1. Hvad Form Builder er — i én sætning

> Et generelt form-byggesystem som modul i Bon v2, hvor alle offentlige formularer (booking, bestilling, kontakt, frokostordning, voucher-registrering, lead capture, landing pages) er **konfigurationer af samme byggeklodser**, ikke individuelle hardkodede formularer.

## 2. De fundamentale principper

| # | Princip | Konsekvens |
|---|---------|------------|
| 1 | **Grocy er master for produktdata** | Allergener, kostprofil-muligheder, kategorier, tags lever i Grocy som userfields. Form Builder læser, redigerer ikke |
| 2 | **Hver kunde har sin egen Bon v2-installation** | Ingen multi-tenant-isolation behøves. Hver installation har sit eget Form Builder med sit eget komponent-katalog koblet til sin egen Grocy |
| 3 | **Forms er data, ikke kode** | En ny form = en ny JSON-konfiguration. Ingen ny webhook, ingen ny renderer, ingen ny kode |
| 4 | **Live edit, ingen versionering i V1** | Snapshot af sidst-publicerede til rollback, men ingen draft/published split. Tilføjes hvis behov opstår |
| 5 | **Forms behøver ikke røre Bon v2** | `mail_only` og `forward_webhook` handlers er førsteklasses borgere |
| 6 | **iframe-deployment nu, JS-widget senere** | Migration-path til shadow-DOM widget skal være klar fra start |
| 7 | **Submission-handlere er et fast katalog** | 6 handlers i V1, ikke kodbart. Kodbarhed kan komme senere som "advanced" |
| 8 | **Bon v2's etablerede mønstre genbruges** | Settings-rows, mail-skabeloner, SSE, honeypot, token-pre-fill — alt eksisterer allerede via booking-modulet |

## 3. Mental model — fem lag

```
┌─────────────────────────────────────────────────┐
│ LAG 0: Grocy                                    │
│   Sandheden om produkter, allergener, kost-     │
│   profil-muligheder. Eneste sted disse data     │
│   redigeres                                     │
├─────────────────────────────────────────────────┤
│ LAG 1: Bon v2 product-adapter                   │
│   Læser Grocy regelmæssigt, eksponerer som      │
│   intern API. Kan supplere med Bon v2-specifik  │
│   data hvis Grocy-userfields ikke rækker        │
├─────────────────────────────────────────────────┤
│ LAG 2: Byggeklodser (komponent-katalog)         │
│   Generiske, avancerede, logik-styret,          │
│   Bon v2-integrerede                            │
├─────────────────────────────────────────────────┤
│ LAG 3: Form-instans                             │
│   En specifik form: JSON-konfig der referer     │
│   til byggeklodser + handler-config + settings  │
├─────────────────────────────────────────────────┤
│ LAG 4: Renderer                                 │
│   Tager form-konfig + runtime data → genererer  │
│   den faktiske HTML/JS-form (server- eller      │
│   client-rendret)                               │
├─────────────────────────────────────────────────┤
│ LAG 5: Submission-handler                       │
│   Modtager submission, udfører action(s):       │
│   opret bon, opret CRM-event, send mail osv.    │
└─────────────────────────────────────────────────┘
```

Hver lag har klart definerede grænser. Hver byggeklods kan testes isoleret. Hver form-instans er bare data.

## 4. Konkurrent-positionering

**Jotform** er det bedste sammenligningsgrundlag (mere end WordPress eller Typeform).

| Hvad Jotform mangler — og Form Builder kan | Hvorfor det er edge'en |
|--------------------------------------------|------------------------|
| Submission opretter en **bon** med rigtige produktlinjer fra **Grocy** | Jotform laver bare en CSV-row eller mail. Vi laver et levende dokument der flyder gennem produktion |
| Submission opretter et **CRM-aktivitet** med kobling til kunde og firma | Jotform har ingen idé om hvad en kunde er |
| Slot-picker der kender **eksisterende leveringer + møder + buffertid** | Jotform kan kun lave statiske tider |
| Menu-picker der spejler **live Grocy-data + offentlig kuration** | Jotform har ingen produktdatabase |
| Pre-fill via **token koblet til kundens historik** | Jotform har URL-params, men ingen kunde-kontekst |
| Form-submission triggerer **mail-skabelon med dynamisk indhold** (booking-link, bon-reference) | Jotform sender static auto-replies |

**Vi prøver ikke at konkurrere med Jotform på bredde** — vi konkurrerer på dybde. Form Builder er Bon v2's brugergrænseflade udadtil, ikke et standalone form-værktøj.

---

## 5. Use-cases (initial scope)

Disse er forms der alle bruger samme grund-byggeklodser, men med vidt forskellig orchestration:

| Use-case | Adskiller sig ved | Status |
|----------|-------------------|--------|
| **Catering bestilling** (`ristetrug.dk/bestil`) | Drawer med menu-picker, sandwich-choice, kontoret reviewer | Designet (denne session) |
| **Møde-booking / smage-booking** (`/book`) | Slot-picker, lander som CRM-meeting | Bygget (booking-modul) |
| **Kontakt-form** | Bare kontakt + besked, lander som CRM-lead | Mangler |
| **Forudbestilling/webshop** | Stripe Checkout, slot-picker, betaling op-front | Mangler |
| **Frokostordning (firma)** | Multi-afdelings-aggregation, faktura bagefter | Mangler |
| **Voucher-registrering (festival)** | Mobil-først UI, voucher som betalingsmetode | Mangler |
| **Festival/foodtruck-booking** | Dato range, lokation, type setup | Senere |
| **Newsletter signup** | Bare email + samtykke | Senere |
| **Feedback efter levering** | Rating, kommentar, bon-reference | Senere |
| **Job-ansøgning** | CV upload, motivationstekst | Senere |

**V1-scope**: Bestilling + Kontakt + Forudbestilling + Voucher. Booking er allerede bygget men migreres senere ind under Form Builder.

---

## 6. Byggeklods-katalog (~20 byggeklodser)

Hver byggeklods har:
- En **type** (unikt navn)
- En **konfigurations-skema** (hvilke params kan sættes)
- En **renderer** (hvordan den vises som HTML)
- En **validator** (server-side validering)
- En **submission-output** (hvad lander i submission-data)

### 6.1 Generiske felter (8 byggeklodser)

| Type | Beskrivelse | Output |
|------|-------------|--------|
| `text` | Almindelig text-input | string |
| `textarea` | Flerlinjet tekst | string |
| `email` | Email med format-validering | string |
| `phone` | Telefonnummer (DK-format-aware) | string |
| `number` | Tal med min/max/step | number |
| `select` | Dropdown med options | string |
| `radio` | Radio-knapper (1 valg fra liste) | string |
| `checkbox` | Single eller multi (1+ valg) | bool eller array |
| `file_upload` | Fil-upload til Bon v2 storage | URL eller path |

### 6.2 Avancerede felter (5 byggeklodser)

| Type | Beskrivelse | Output |
|------|-------------|--------|
| `dawa_address` | DAWA/Dataforsyningen address autocomplete (allerede bygget) | { vejnavn, husnr, postnr, by, ... } |
| `cutoff_datetime` | Datetime-picker med cutoff-logik (kan ikke vælge før X timer fra nu) | ISO datetime |
| `quantity_stepper` | +/- knapper, mobile-friendly | number |
| `signature` | Underskrift på touch-skærm | base64 image |
| `gdpr_consent` | Samtykke-checkbox med policy-link | bool + timestamp |

### 6.3 Bon v2-integrerede felter (5 byggeklodser)

Disse er **kernen** i differentiatoren — det er dem Jotform ikke kan lave.

| Type | Beskrivelse | Output |
|------|-------------|--------|
| `grocy_product_picker` | Drawer-baseret produktvælger med kategorier, tags, allergener, kostprofil-options, modifiers, ad-hoc-tilføjelse | array af `{ grocy_id?, name, kostprofil, modifiers, qty, snapshot_allergens, price }` |
| `slot_picker` | Tidspunkt-vælger der kender Bon v2's kalender (bons + meetings + buffertid). Brugt af booking | ISO datetime |
| `customer_lookup` | Email-baseret matching mod eksisterende kunder; pre-fill fra match | customer_id eller null |
| `bon_reference` | Drop-down af kundens egne bons (kræver token-pre-fill) | bon_id |
| `payment_method_picker` | Vælg mellem konfigurerbare metoder: kort, MobilePay, faktura, voucher | { method, voucher_code? } |

### 6.4 Logik-styret (3 byggeklodser)

| Type | Beskrivelse | Output |
|------|-------------|--------|
| `conditional_block` | Vis/skjul gruppe af felter baseret på andet felt's værdi (`showWhen`) | (intet — bare layout-logik) |
| `calculated_field` | Beregner værdi fra andre felter (fx samlet pris) | number eller string |
| `info_block` | Statisk info-tekst, evt. foldbar (allerede i formbuilder.html) | (intet — visning) |

### 6.5 Struktur (3 byggeklodser)

| Type | Beskrivelse | Output |
|------|-------------|--------|
| `section` | Visuel sektion med titel og underfelter | (intet — gruppering) |
| `multi_step` | Form opdeles i trin (wizard) | (intet — navigation) |
| `repeater` | "Tilføj endnu en" — gentagende gruppe af felter | array af objekter |

### 6.6 System (skjulte byggeklodser, automatisk på alle forms)

| Type | Beskrivelse |
|------|-------------|
| `honeypot` | Skjult felt der skal være tomt — anti-spam |
| `csrf_token` | CSRF-beskyttelse for autenticerede forms |
| `submission_metadata` | IP, user-agent, timestamp, form-version |

---

## 7. Submission-handler-katalog (6 handlers)

En form har **én primær handler** og kan have **N efter-handlers** (fx altid `send_mail_only` efter `create_bon`).

| Handler | Hvad den gør | Konfig-params | Brugs-eksempel |
|---------|--------------|---------------|----------------|
| `create_bon` | Opretter en bon med linjer fra `grocy_product_picker`. Matcher/opretter kunde. Flagger til review | `default_status`, `payment_method`, `auto_approve`, `mail_template` | Bestilling, frokostordning, voucher-form |
| `create_crm_meeting` | Opretter `crm_activity` med `type='meeting'` | `purpose_id`, `mail_template` | Booking, smage-booking |
| `create_crm_lead` | Opretter kunde med `stage='lead'`, optionelt `crm_activity` med `type='note'` | `lead_source`, `mail_template` | Kontakt-form, newsletter signup |
| `charge_stripe` | Sender til Stripe Checkout. Ved success → `create_bon` med `BETALT`-status | `success_url`, `cancel_url`, `success_template` | Forudbestilling/webshop |
| `send_mail_only` | Sender mail til en eller flere modtagere. Gemmer ikke i database | `to`, `template`, `from_mailbox` | Simpelt kontaktform, newsletter |
| `forward_webhook` | POST'er submission-data til ekstern URL | `url`, `auth_header`, `transform_jq?` | Lead til ekstern CRM, MailChimp |

### Vigtig adfærd der gælder alle handlers

| Adfærd | Begrundelse |
|--------|-------------|
| Honeypot-tjek altid først | Drop hvis udfyldt |
| Returnér altid 200 til offentlige endpoints | Anti-spam (gør det svært for bots at lære hvad der virker) |
| SSE-broadcast af relevante events | Realtime UI-opdatering i Bon v2 |
| Audit-log af alle submissions | Debugging, GDPR, compliance |

### Voucher-modellen — vigtig forenkling

Voucher er **ikke en separat handler**. Det er en betalings-metode som `create_bon` håndterer:

```json
{
  "handler": "create_bon",
  "config": {
    "default_status": "BETALT",
    "payment_method": "voucher"
  }
}
```

Submission gemmer `voucher_code` på bonnen. Senere kører en separat funktion i Bon v2 (ikke en form-handler) der aggregerer alle bons med en given voucher-kode til en faktura til event-arrangøren.

---

## 8. Datamodel-skitse

### 8.1 Form-tabeller (i Bon v2)

```sql
-- Form-instanser
CREATE TABLE forms (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,             -- bestilling, kontakt, voucher-foo-festival
  title           TEXT NOT NULL,                    -- "Bestil din mad"
  description     TEXT,
  config_json     TEXT NOT NULL,                    -- hele form-konfig som JSON (felter, handlers, settings)
  last_published_snapshot TEXT,                     -- backup af sidste publicerede config (rollback)
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_public       INTEGER NOT NULL DEFAULT 1,       -- 0 = kun via token-link
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by      INTEGER REFERENCES users(id)
);

-- Submissions (audit-log)
CREATE TABLE form_submissions (
  id              INTEGER PRIMARY KEY,
  form_id         INTEGER NOT NULL REFERENCES forms(id),
  form_version_hash TEXT NOT NULL,                  -- hash af config_json på submit-tidspunkt
  submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address      TEXT,
  user_agent      TEXT,
  data_json       TEXT NOT NULL,                    -- alt fra submission
  handler_results_json TEXT,                        -- hvad blev gjort (bon_id=123, mail_sent=true)
  status          TEXT NOT NULL,                    -- 'success'|'failed'|'spam_dropped'
  error_message   TEXT
);

CREATE INDEX idx_form_submissions_form ON form_submissions(form_id, submitted_at);

-- Form-tokens (pre-fill, samme mønster som booking_tokens)
CREATE TABLE form_tokens (
  token              TEXT PRIMARY KEY,
  form_id            INTEGER NOT NULL REFERENCES forms(id),
  customer_id        INTEGER REFERENCES customers(id),
  prefill_json       TEXT,                          -- ekstra felter der skal pre-fill'es
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at         TEXT NOT NULL,
  opened_at          TEXT,
  open_count         INTEGER NOT NULL DEFAULT 0,
  submission_id      INTEGER REFERENCES form_submissions(id),
  notes              TEXT
);
```

### 8.2 Grocy-userfields (på `products`-tabellen i Grocy)

| Userfield | Type | Default | Beskrivelse |
|-----------|------|---------|-------------|
| `public_visible` | bool | false | Synlig på offentlige forms |
| `public_name` | string | — | Override af interne navn (valgfri) |
| `public_description` | text | — | Beskrivelse til drawer |
| `public_category` | string | — | Kategori-grupperinger |
| `public_sort_order` | int | 0 | Rækkefølge i drawer |
| `kostprofiler_tilgængelige` | CSV | — | `vegan,vegetar,kød,fisk` — hvilke versioner findes |
| `kostprofil_default` | enum | — | Default visning (`vegan`, `kød`, ...) |
| `modifier_lactosefri` | bool | false | Kan denne ret laves laktosefri? |
| `modifier_glutenfri` | bool | false | Kan denne ret laves glutenfri? |
| `allergens_default` | CSV | — | EU-14 allergen-keys (`gluten,sesame,milk`) |
| `allergens_glutenfri` | CSV | — | Allergen-liste hvis glutenfri-variant vælges (overrider default) |
| `allergens_lactosefri` | CSV | — | Allergen-liste hvis laktosefri-variant vælges |

**EU-14 allergen-keys** (skal være konsistente — bruges som identifier overalt):

```
gluten, crustaceans, eggs, fish, peanuts, soy, milk,
nuts, celery, mustard, sesame, sulphites, lupin, molluscs
```

### 8.3 Form-config JSON-format (eksempel)

```json
{
  "version": 1,
  "title": "Bestil din mad",
  "submit_button_label": "Send forespørgsel",
  "components": [
    {
      "id": "info-1",
      "type": "info_block",
      "config": { "foldable": true, "title": "Sådan virker det", "body": "..." }
    },
    {
      "id": "pax-1",
      "type": "number",
      "config": { "label": "Antal gæster (pax)", "required": true, "min": 1, "max": 1600 }
    },
    {
      "id": "sandwich-choice-1",
      "type": "radio",
      "config": {
        "label": "Sandwichvalg",
        "options": [
          { "value": "rr_vælger", "label": "🌟 RR vælger" },
          { "value": "eget_valg", "label": "✏️ Eget valg" }
        ],
        "default": "rr_vælger"
      }
    },
    {
      "id": "menu-picker-1",
      "type": "grocy_product_picker",
      "config": {
        "categories": ["Sandwich", "Salater", "Drikke"],
        "show_link_only_when": { "field": "sandwich-choice-1", "equals": "eget_valg" },
        "allow_ad_hoc": false,
        "drawer_title": "Vores menu"
      }
    },
    {
      "id": "wishes-1",
      "type": "textarea",
      "config": { "label": "Specielle ønsker", "placeholder": "..." }
    },
    {
      "id": "address-1",
      "type": "dawa_address",
      "config": { "label": "Leveringsadresse", "required": true }
    },
    {
      "id": "delivery-1",
      "type": "cutoff_datetime",
      "config": { "label": "Leveringstidspunkt", "cutoff_hours": 24, "blocked_weekdays": [0] }
    }
  ],
  "handlers": [
    {
      "type": "create_bon",
      "config": {
        "default_status": "VENTER",
        "auto_approve": false,
        "mail_template": "bestilling_modtaget"
      }
    }
  ],
  "deployment": {
    "modes": ["standalone", "iframe"],
    "embed_styles": "minimal"
  }
}
```

---

## 9. Deployment-modes

| Mode | Hvordan | Implementeret |
|------|---------|---------------|
| **A1. iframe i WordPress** | Bon v2 serverer på `bon.ristetrug.dk/forms/{slug}/embed` | V1 |
| **A2. Standalone URL hosted med Bon** | Bon v2 serverer på `bon.ristetrug.dk/forms/{slug}` | V1 |
| **A3. Static download** | Eksporteret som standalone HTML-fil, uploades manuelt. Kan ligge på et andet domæne, webhook tilbage til Bon v2 | V1 (med webhook) |
| **A4. JS widget med shadow DOM** | `<script src="bon.../widget.js"></script>` injecter shadow-DOM form. Auto-resize, ingen iframe-pinligheder | V2 |
| **A5. App embed (komponent-niveau)** | Apps som event-systemet bruger Form Builder's *primitiver* (felt-komponenter), ikke hele formen | V2+ |

A1+A2 er normalflowet. A3 dækker fx event-bestillingssider hos ristetrug.dk hvor formen er statisk men submission går til Bon v2.

---

## 10. Migration: eksisterende forms ind under Form Builder

| Eksisterende form | Status | Migration-plan |
|-------------------|--------|----------------|
| **Booking-modul** (`tools/booking.html`) | Bygget med dedikeret kode | Forbliver som-er i V1. Migreres til Form Builder-instans i V2 når slot-picker-byggeklodsen er moden |
| **Bestillingsformular** | Eksisterer på Linode (formbuilder v6) | Re-implementeres som Form Builder-instans i V1. Designet i denne session |
| **Kontakt-form** | Eksisterer evt. på hjemmesiden | Re-implementeres som Form Builder-instans. Lille opgave når Form Builder kører |
| **Event-bestillingsside** (forudbestillings-systemet) | Selvstændigt system med Stripe + multi-vendor | Forbliver selvstændigt i V1. Senere: vendor-portal kan bruge Form Builder-komponenter til at lade vendors selv definere deres bestillingsform |

---

## 11. Implementerings-prioritet (groft)

Dette er ikke en endelig roadmap — det skrives senere — men en grov prioritering:

### Fase 1: Fundament
- Datamodel (forms, form_submissions, form_tokens)
- Backend route-struktur (`routes/forms.js`)
- Renderer (server-side eller client-side)
- 8 generiske byggeklodser (text, email, phone, textarea, number, select, radio, checkbox)
- Honeypot + submission-metadata (system-byggeklodser)
- `send_mail_only`-handler
- iframe + standalone deployment

### Fase 2: Bon v2-integration
- `customer_lookup`, `dawa_address`, `cutoff_datetime`, `gdpr_consent`
- `create_bon`-handler + `create_crm_lead`-handler
- Token-pre-fill-system
- Settings-UI til form-administration

### Fase 3: Den store byggeklods
- `grocy_product_picker` (drawer med kategorier, tags, allergener, kostprofil-options, ad-hoc)
- Grocy-userfields tilføjes
- Voucher-handler-config på `create_bon`

### Fase 4: Builder-UI
- Drag-drop builder
- Live preview
- Template-bibliotek (kopier eksisterende form)

### Fase 5: Avanceret
- `slot_picker` (booking migreres ind)
- `multi_step`, `repeater`, `conditional_block`, `calculated_field`
- `charge_stripe`-handler
- JS widget med shadow DOM

---

## 12. Bevidste fravalg / udskudt

| Fravalgt | Hvorfor |
|----------|---------|
| Versionering med draft/published | Kompleks. Live-edit + last_published_snapshot dækker 90% af behovet |
| Multi-tenant component-bibliotek | Hver Bon v2-installation er sin egen tenant — ingen behov for delt katalog |
| Kodbart submission-handlers | Fast katalog dækker V1+V2 use-cases. Kodbarhed er Jotform-territory |
| Multi-language | Dansk only. Tilføjes hvis kunder kræver det |
| A/B-testing af forms | Niche-feature. Kan tilføjes via duplikeret form + analytics |
| Tilbagevendende submissions / bookings | Out of scope — håndteres i kalender-app eller manuelt |
| Realtime collaboration (flere redigerer samme form) | Single-user antagelse. Last-write-wins er acceptabelt |
| Direct database-skrivning til Grocy | Form Builder læser kun. Grocy redigeres i Grocy admin |

---

## 13. Åbne spørgsmål til senere afklaring

| # | Spørgsmål | Status |
|---|-----------|--------|
| 1 | Skal `grocy_product_picker` håndtere kostprofil-valg (vegansk/vegetar/kød/fisk) som radio i selve drawer-rækken eller som sub-modal? | Foreslået: A for retter uden options, B for retter med |
| 2 | Hvor lever offentlige menu-overrides hvis Grocy-userfields ikke er nok? | Foreslået: `product_overrides`-tabel i Bon v2, men gem dette til behov opstår |
| 3 | Hvordan håndterer vi menu-builder vs Grocy-redigering? | Foreslået: Menu Builder bliver kuration- og preview-værktøj, ikke data-redigering. Data redigeres i Grocy |
| 4 | Permission-model: hvem kan redigere forms? Hvem kan se submissions? | Til senere. Sandsynligvis simpel role-baseret først |
| 5 | Form-template-bibliotek: indbyggede starter-templates eller bare "kopier eksisterende form"? | Til senere |
| 6 | Skal forms understøtte fil-upload (CV til job-form, billede af festival-event til voucher)? | Ja i `file_upload`-byggeklodsen, men implementering deferred til Fase 4+ |

---

## 14. Designsessions-historik

Dette dokument er produktet af en designsession i maj 2026:

| Faze | Beslutning |
|------|------------|
| Start | Tilføjelser til eksisterende bestillingsformular (form-helper for udfyldning, menu-visning) |
| → | Menu-drawer med smart-append (mockups v1-v3) |
| → | Iframe-embedding på WordPress (embed-mode CSS) |
| → | Strukturerede data: 3 tags (vegan/vegetar/glutenfri) + 14 EU-allergener |
| → | Menu Builder UI som søsterværktøj til Form Builder |
| → | Embed direkte i form (ikke separat menu.json) — formbuilder + menubuilder kombineres |
| → | **Pivot**: dette skal ikke være standalone værktøjer — det skal være Bon v2-modul |
| → | Form Builder = generelt system, ikke bestilling-specifikt |
| → | Booking-modulet eksisterer allerede og definerer mønstret |
| → | Multi-tenant: hver kunde har egen installation (forenkler markant) |
| → | Grocy er master for alt produktdata inklusive allergener og kostprofil-muligheder |
| → | Voucher er bare en betalingsmetode på `create_bon`, ikke en separat handler |
| Slut | Tre artefakter samlet i dette fundament-dokument |

---

## 15. Hvad dokumentet IKKE er

- ❌ Ikke en endelig arkitektur-spec — den skrives som `CLAUDE_FORM_BUILDER.md` senere
- ❌ Ikke en implementerings-guide — Simon skal vente på arkitektur-spec'en
- ❌ Ikke en låst beslutning på alt — flere åbne spørgsmål skal afklares
- ✅ ER fundamentet vi byggede sammen — udgangspunkt for arkitektur-spec'en
- ✅ ER referenceramme for fremtidige design-diskussioner om forms
- ✅ ER samling af principper der skal bevares uanset implementerings-detaljer

---

*Dokument oprettet i designsession, maj 2026. Skal læses sammen med:*
- `BON_V2_PRINCIPPER.md` (Grocy-master-princip)
- `bon_v2_datamodel_v2.md` (eksisterende skema)
- `CRM_Booking_Spec.md` (mønster for offentlige forms — bygget)
- `bestilling_drawer_mockup_v3.html` (design-reference for catering-bestilling)
- `menubuilder.html` (design-reference for menu-kuration)
