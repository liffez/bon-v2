# CLAUDE_BESTILLING_FORM.md — Embed-bestillingsformular
> Læs CLAUDE.md, BON_V2_PRINCIPPER.md og bon_v2_datamodel_v2.md først.
> Mockup: `bestilling_inline_v5.html` (artefakt fra Claude.ai-session)
> Opdateret: maj 2026

---

## Formål

En embed-bestillingsformular der erstatter JotForm på `ristetrug.dk/bestil`.
Lever på `bon.ristetrug.dk/embed/bestilling` og indlejres i WordPress (DIVI Code Module) via iframe.

**Nye UX-elementer ud over den eksisterende formbuilder-form:**

| Element | Hvorfor |
|---|---|
| "Sådan virker det" foldout | Forklarer at det IKKE er en webshop — første-gangs-kunder forstår flowet |
| Quick-chips for kostønsker | Strukturerer det kunder altid skriver (vegansk, glutenfri, allergi osv.) |
| Inline menu-picker | Kunder kan klikke retter direkte ind i ønske-feltet — opfattes som tilbud, ikke krav |
| Sandwichvalg med subtekst | "Køkkenet blander" / "Eget valg" — fjerner misforståelsen om at "RR vælger" betyder "vi bestemmer alt" |

**Pragmatisk valg:** disse elementer er hardcoded i `embed/bestilling.html` — ikke field-types i formbuilderen.
Migreres til ægte field-types ved den planlagte formbuilder-udvidelse.

---

## Arkitektur

```
WordPress (ristetrug.dk/bestil — DIVI Code Module)
        ↓  iframe src="https://bon.ristetrug.dk/embed/bestilling?menu=standard"
        ↓  postMessage høj-resizer (parent ↔ iframe)
Express route GET /embed/bestilling (routes/embed.js)
        ↓  Server-rendret med ?menu=<id> som default
        ↓  Statisk HTML med inline JS (én fil, ingen build-step)
Frontend (public/embed/bestilling.html)
        ↓  fetch('/menus/standard.json')  → menu-data
        ↓  fetch('https://api.dataforsyningen.dk/...') → DAWA
        ↓  fetch('https://router.project-osrm.org/...') → leveringsdistance
        ↓  Submit: POST /api/formbuilder/webhook
Backend (eksisterende formbuilder webhook)
        ↓  Honeypot, firma/kunde find/opret, EAN, DAWA-parsing
        ↓  INSERT INTO bons (status_id = NY)
        ↓  Mail-bekræftelse til kunde (eksisterende mail-service)
```

---

## Filer og placering

```
public/
├── embed/
│   └── bestilling.html          ← NY — selve formen (single-file, ~800 linjer)
└── menus/
    └── standard.json            ← NY — menu-data

routes/
├── embed.js                     ← NY — server route + headers
└── formbuilder_webhook.js       ← EKSISTERER — udvides med nye felt-mappings (se nedenfor)

docs/
└── wordpress_divi_snippet.html  ← NY — DIVI Code Module snippet til kopiering
```

**Vigtigt:** `embed/bestilling.html` er bevidst standalone — den loader IKKE `shared/bon-base.css` eller andre Bon v2 shared-filer, fordi den er embedded på en ekstern WordPress-side. Alt CSS er inline.

---

## Express route — `routes/embed.js`

```javascript
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const ALLOWED_MENUS = ['standard']; // udvides når flere menuer kommer

// CSP — tillad embed kun fra ristetrug.dk
function setEmbedHeaders(res) {
    res.setHeader('Content-Security-Policy',
        "frame-ancestors 'self' https://ristetrug.dk https://www.ristetrug.dk");
    res.removeHeader('X-Frame-Options'); // CSP frame-ancestors er moderne erstatning
}

// GET /embed/bestilling?menu=standard
router.get('/bestilling', (req, res) => {
    setEmbedHeaders(res);
    const menuId = req.query.menu || 'standard';
    if (!ALLOWED_MENUS.includes(menuId)) {
        return res.redirect('/embed/bestilling?menu=standard');
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'embed', 'bestilling.html'));
});

// GET /embed/menus/:id.json — eksplicit endpoint så vi kan tilføje cache-headers
router.get('/menus/:id.json', (req, res) => {
    const filePath = path.join(__dirname, '..', 'public', 'menus', `${req.params.id}.json`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'menu_not_found' });
    }
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min cache
    res.sendFile(filePath);
});

module.exports = router;
```

Mountes i `server.js`:
```javascript
app.use('/embed', require('./routes/embed'));
```

---

## Menu JSON-schema

Fil: `public/menus/standard.json`

```json
{
    "menu_id": "standard",
    "name": "Standard menu",
    "version": "2026-05",
    "categories": [
        { "id": "sandwich",     "name": "Sandwich" },
        { "id": "salater",      "name": "Salater" },
        { "id": "kage_dessert", "name": "Kage & Dessert" },
        { "id": "drikke",       "name": "Drikke" }
    ],
    "items": [
        {
            "id": "falaflen",
            "name": "Falaflen",
            "category": "sandwich",
            "tags": ["vegan"],
            "allergens": "Gluten, sesam",
            "active": true
        }
    ]
}
```

**Felt-regler:**

| Felt | Krav | Forklaring |
|---|---|---|
| `menu_id` | påkrævet, unik | Matcher URL-param og filnavn |
| `name` | påkrævet | Vises som overskrift i menu-picker |
| `version` | påkrævet | YYYY-MM. Cache-bust + audit-spor |
| `categories[].id` | påkrævet | Stabil ID — items refererer hertil |
| `categories[].name` | påkrævet | Vist navn (kan ændres uden at brække items) |
| `items[].id` | påkrævet, unik | Stabil ID — fremtidigt 1:1 mapping mod Grocy |
| `items[].name` | påkrævet | Vist navn |
| `items[].category` | påkrævet | Skal matche en `categories[].id` |
| `items[].tags` | array | Tilladte: `vegan`, `veg`, `gf` (vegansk, vegetar, glutenfri) |
| `items[].allergens` | string | Fri tekst, vises ved klik på ⓘ |
| `items[].active` | bool | `false` skjuler item uden at slette |

**Rækkefølge:** Bestemmes af array-rækkefølgen i `categories` og `items`. Ingen `order: 1, 2, 3` felt — det er bevidst enkelt.

**Hvem redigerer:** Leif/Simon i editor indtil videre. Migreres til settings-UI når flere menuer kommer i drift.

---

## Frontend — `public/embed/bestilling.html`

### Udgangspunkt

Tag mockup-filen `bestilling_inline_v5.html` (bygget i Claude.ai) som **strukturel basis**.
Den indeholder:
- Foldout "Sådan virker det"
- Sandwichvalg med subtekst (Køkkenet blander / Eget valg)
- Quick-chips (7 stk)
- Smart-append textarea med struct-header detection
- Inline menu-picker expand
- Allergen-row toggle pr. item

### Felter der SKAL tilføjes (fra eksisterende `bestilling_v2.html`)

Den nuværende formbuilder-form har følgende felter — alle skal med i den nye HTML:

| Felt-id | Type | Required | Show-when |
|---|---|---|---|
| `ordertype` | catering / pickup | ja | altid |
| `navn` | text | ja | altid |
| `email` | email | ja | altid |
| `tlf` | tel | ja | altid |
| `firma` | text | nej | altid |
| `ean` | textarea | nej | altid |
| `adresse` | DAWA-autocomplete | ja | ordertype=catering |
| `datetime` | dato + tid | ja | altid |
| `pax` | number | ja | altid |
| `wishes` | textarea (med chips + menu) | nej | altid |
| `kontaktperson` | navn + tlf | nej | altid |
| `accept` | checkbox | ja | altid |
| `website` (honeypot) | hidden | — | altid |

**Pax og sandwichvalg flytter til toppen af "Specielle ønsker"** som mockup'en viser — ikke længere et separat field-id.

### Felt-rækkefølge i den endelige HTML

```
1. Foldout: "Sådan virker det"
2. Ordertype (catering/pickup)
3. Navn / Email / Tlf
4. Firma (valgfrit) / EAN (valgfrit)
5. Adresse (DAWA, kun ved catering) → leverings-estimat
6. Dato + tid + cutoff-warning
7. Antal personer + sandwichvalg (row2)
8. Sektion: Kostønsker og allergier
   - Quick-chips (7 stk)
   - Textarea (Specielle ønsker)
   - Menu-link "📋 Tilføj specifikke retter"
   - Inline menu-expand (når åbnet)
9. Kontaktperson på dagen
10. Accept-checkbox
11. Submit-knap
12. Honeypot
```

### Konfiguration — fra `system_settings`, ikke hardcoded

Cutoff-tider og leveringspriser ændres jævnligt — de må IKKE hardcodes i form-HTML.
De gemmes som rows i `system_settings`-tabellen og hentes af formen ved load.

#### Settings-keys der oprettes (migration eller seed)

| Key | Værdi-type | Eksempel | Beskrivelse |
|---|---|---|---|
| `bestilling.base_lat` | string (number) | `"55.6961"` | HQ-koordinat for OSRM-routing |
| `bestilling.base_lon` | string (number) | `"12.5574"` | HQ-koordinat |
| `bestilling.cutoff_time` | string (hour) | `"12"` | Sidste bestillingstime |
| `bestilling.cutoff_days_before` | string (int) | `"1"` | Antal hverdage før levering |
| `bestilling.delivery_config` | JSON-string | se nedenfor | Cykel + taxa-zoner som ét objekt |

`bestilling.delivery_config` indhold:
```json
{
    "cykel": {
        "basisPris": 154,
        "ekstraKassePris": 50,
        "gratisKasser": 2,
        "maxKasser": 4,
        "maxAfstand": 8,
        "paxPerKasse": 16
    },
    "taxa": {
        "zone3": { "postnumre": ["2300","2720","2730","2820"], "pris": 425 },
        "zone4": { "postnumre": ["2800","2600","2605","2625","2610","2650"], "pris": 575 },
        "zone5": { "postnumre": ["2620","2760","2770","2750"], "pris": 650 }
    }
}
```

#### Public config-endpoint — `GET /embed/config`

Et separat endpoint der KUN returnerer config-felter formularen behøver.
Vi eksponerer ikke hele `system_settings` til public iframe-kontekst.

```javascript
// routes/embed.js — tilføj denne route
router.get('/config', (req, res) => {
    setEmbedHeaders(res);
    const db = getDb();
    const rows = db.prepare(`
        SELECT key, value FROM system_settings
        WHERE key LIKE 'bestilling.%'
    `).all();

    const config = {};
    rows.forEach(r => {
        if (r.key === 'bestilling.delivery_config') {
            config.delivery = JSON.parse(r.value);
        } else if (r.key === 'bestilling.base_lat') {
            config.base = config.base || {};
            config.base.lat = parseFloat(r.value);
        } else if (r.key === 'bestilling.base_lon') {
            config.base = config.base || {};
            config.base.lon = parseFloat(r.value);
        } else if (r.key === 'bestilling.cutoff_time') {
            config.cutoff = config.cutoff || {};
            config.cutoff.time = parseInt(r.value, 10);
        } else if (r.key === 'bestilling.cutoff_days_before') {
            config.cutoff = config.cutoff || {};
            config.cutoff.daysBefore = parseInt(r.value, 10);
        }
    });

    res.setHeader('Cache-Control', 'public, max-age=60'); // 1 min cache — så ændringer slår igennem hurtigt
    res.json(config);
});
```

#### Frontend-loader

```javascript
async function loadConfig() {
    const r = await fetch('/embed/config');
    if (!r.ok) throw new Error('config_load_failed');
    return await r.json();
}

// Ved sidens load:
let CONFIG = null;
(async () => {
    CONFIG = await loadConfig();
    // Først nu kan formen render leverings-estimat og cutoff-warning
})();
```

#### Migration / seed

Tilføj til ny migration `db/migrations/0XX_bestilling_settings.sql`:

```sql
INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
    ('bestilling.base_lat', '55.6961', 'HQ-koordinat (latitude) til levering'),
    ('bestilling.base_lon', '12.5574', 'HQ-koordinat (longitude)'),
    ('bestilling.cutoff_time', '12', 'Sidste bestillingstime hverdage'),
    ('bestilling.cutoff_days_before', '1', 'Antal hverdage før levering'),
    ('bestilling.delivery_config', '{"cykel":{"basisPris":154,"ekstraKassePris":50,"gratisKasser":2,"maxKasser":4,"maxAfstand":8,"paxPerKasse":16},"taxa":{"zone3":{"postnumre":["2300","2720","2730","2820"],"pris":425},"zone4":{"postnumre":["2800","2600","2605","2625","2610","2650"],"pris":575},"zone5":{"postnumre":["2620","2760","2770","2750"],"pris":650}}}', 'Leveringspriser og zoner — JSON');
```

Når kontoret senere får et settings-UI til at redigere disse, skal `bestilling.delivery_config`
have en struktureret editor (JSON med tabel-visning) — ikke fri-tekst-felt.

### Menu-loader

```javascript
async function loadMenu() {
    const params = new URLSearchParams(window.location.search);
    const menuId = params.get('menu') || 'standard';
    try {
        const r = await fetch(`/embed/menus/${menuId}.json`);
        if (!r.ok) throw new Error(`menu ${menuId} not found`);
        return await r.json();
    } catch (e) {
        console.error('Menu load failed', e);
        // Fallback til hardcodet minimal-menu så formen ikke knækker
        return { menu_id: 'fallback', categories: [], items: [] };
    }
}
```

Loades én gang ved sidens load — menu-picker rendres når brugeren klikker "Tilføj specifikke retter".

---

## postMessage høj-resizer

### Iframe-side (i `embed/bestilling.html`)

```javascript
function postHeight() {
    const h = document.documentElement.scrollHeight;
    window.parent.postMessage({ type: 'rr-form-height', height: h }, '*');
}

// Send højde ved:
// 1. Initial load
// 2. Menu åbnes/lukkes
// 3. Drawer/foldout toggles
// 4. Window resize
window.addEventListener('load', postHeight);
window.addEventListener('resize', postHeight);

// MutationObserver fanger DOM-ændringer (chips tilføjet, menu åbnet osv.)
const observer = new ResizeObserver(postHeight);
observer.observe(document.documentElement);
```

### Parent-side (i WordPress DIVI Code Module)

```html
<iframe id="rr-bestil-iframe"
        src="https://bon.ristetrug.dk/embed/bestilling"
        scrolling="no"
        style="width:10px; min-width:100%; display:block; border:none; height:800px;"
        allow="geolocation"></iframe>

<script>
window.addEventListener('message', e => {
    if (!e.origin.startsWith('https://bon.ristetrug.dk')) return;
    if (e.data?.type !== 'rr-form-height') return;
    const iframe = document.getElementById('rr-bestil-iframe');
    iframe.style.height = (e.data.height + 20) + 'px';
});
</script>
```

**`width: 10px; min-width: 100%`** er iOS Safari-hack der får iframen til at fylde container-bredden.
Dette er nøjagtig samme pattern som JotForm bruger — bevist at virke i Ristet Rug's DIVI-setup.

---

## Webhook-integration — påkrævet udvidelse

Den eksisterende formbuilder-webhook (`routes/formbuilder_webhook.js`) håndterer:
- Honeypot-validering
- Firma/kunde find-eller-opret
- EAN-udtræk
- DAWA-validering

**Den skal udvides til at modtage og parse de nye felter** — det er en del af
denne implementeringsopgave, ikke et åbent punkt.

### Nye payload-felter

```json
{
    "ordertype": "catering",
    "navn": "Leif Zeeberg",
    "email": "leif@example.dk",
    "tlf": "40195471",
    "firma": "Ristet Rug",
    "ean": "5798000123456",
    "adresse": "Annettevej 5B, 2920 Charlottenlund",
    "validatedAddress": { /* DAWA-objekt */ },
    "leveringsdato": "2026-06-01",
    "leveringstid": "11:30",
    "pax": 60,
    "sandwichvalg": "rr_blander",
    "wishes": "Vegansk: 5\nGlutenfri: 2\nAllergi: nødder",
    "kontaktperson": { "navn": "...", "tlf": "..." },
    "accept": true,

    "_form_meta": {
        "menu_id": "standard",
        "menu_version": "2026-05",
        "form_version": "embed-v1"
    }
}
```

### Nye felter at parse

| Felt | Hvor i Bon v2 |
|---|---|
| `sandwichvalg` | Append til `bons.notes` som `Sandwichvalg: <værdi>` |
| `wishes` | `bons.notes` (samlet med sandwichvalg-prefix) |
| `_form_meta.menu_id` + `menu_version` | Audit-info: append til `bons.notes` som komment |
| `kontaktperson.navn` + `kontaktperson.tlf` | `bons.kitchen_info` (`Kontaktperson: Navn (tlf)`) |

**Vigtigt:** Den nye form sender IKKE `valgte_retter` som strukturerede data.
Når kunden klikker `+` på menu-picker bliver retten bare appendet til `wishes`-textarea
som `1× Falaflen`. Det er hvad webhook'en modtager. Office tager stilling til linjer
manuelt eller via menu-agenten.

Det er bevidst — Bon v2's bon-linjer skal matches mod Grocy-opskrifter, og det
sker bedst når kontoret/menu-agenten har et samlet billede.

### Konkrete ændringer i webhook-handleren

| # | Ændring |
|---|---|
| 1 | Acceptér `sandwichvalg` i payload — værdier: `rr_blander` eller `eget_valg` |
| 2 | Acceptér `_form_meta` objekt — log indhold til `bons.notes` som auditspor (eksempel: `[Form: standard menu v2026-05]`) |
| 3 | Acceptér `kontaktperson` som nested objekt (i stedet for flade `f11_navn` / `f11_tlf` felter) — formater til linje i `kitchen_info` |
| 4 | Notes-formatering: samles som flerlinje-tekst med klare sektioner (eksempel nedenfor) |
| 5 | Schema-validering: hvis hardcoded — udvid med de nye felter; hvis Joi/Zod — opdater schema |
| 6 | Backward-kompatibilitet: gamle JotForm-submissions er ikke længere relevante — kun den nye form bruges |

### Eksempel på `bons.notes` efter parsing

```
Sandwichvalg: Køkkenet blander

Kostønsker:
Vegansk: 5
Glutenfri: 2
Allergi: nødder (1 person)

[Form: standard menu v2026-05]
```

### Eksempel på `bons.kitchen_info`

```
Kontaktperson: Mette Nielsen (40123456)
```

### Webhook-endpoint

Sandsynligvis allerede mountet på `/api/formbuilder/webhook` eller lignende — Simon
verificerer det eksakte endpoint.

Submit-handleren i den nye HTML:

```javascript
const WEBHOOK_URL = '/api/formbuilder/webhook';

async function submitForm(data) {
    const r = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
```

---

## DIVI Code Module snippet

Filen `docs/wordpress_divi_snippet.html` (Leif kopierer ind i WordPress):

```html
<iframe id="rr-bestil-iframe"
        src="https://bon.ristetrug.dk/embed/bestilling"
        title="Ristet Rug — Bestillingsformular"
        scrolling="no"
        allow="geolocation"
        style="width:10px; min-width:100%; display:block; border:none; height:800px;"></iframe>

<script>
(function() {
    window.addEventListener('message', function(e) {
        if (!e.origin.startsWith('https://bon.ristetrug.dk')) return;
        if (!e.data || e.data.type !== 'rr-form-height') return;
        var iframe = document.getElementById('rr-bestil-iframe');
        if (iframe) iframe.style.height = (e.data.height + 20) + 'px';
    });
})();
</script>
```

**Migration fra JotForm:** Leif erstatter JotForm-iframe-blokken med ovenstående.
Formularen lever stadig på `ristetrug.dk/bestil` — kun source skifter.

---

## Test-checklist

### Lokalt (før deployment)

- [ ] `GET /embed/bestilling` returnerer HTML uden fejl
- [ ] `GET /embed/bestilling?menu=standard` matcher default
- [ ] `GET /embed/bestilling?menu=ukendt` redirecter til `?menu=standard`
- [ ] `GET /embed/menus/standard.json` returnerer valid JSON
- [ ] `GET /embed/config` returnerer kun `bestilling.*` keys, struktureret korrekt
- [ ] Ændring af `bestilling.cutoff_time` i database → reflekteres i form efter cache-udløb (1 min)
- [ ] CSP-header sat: `frame-ancestors 'self' https://ristetrug.dk`
- [ ] Form indlæses i `wordpress_embed_test.html` uden CSS-konflikter
- [ ] Foldout åbner/lukker
- [ ] Sandwichvalg-knapper toggle korrekt med subtekst
- [ ] Quick-chips appender korrekt format ("Vegansk: 1" → "Vegansk: 2")
- [ ] Menu-picker åbner inline (ikke drawer)
- [ ] Klik `+` appender til textarea uden at indsætte `--- Valgte retter ---` header når der ingen fritekst er
- [ ] Klik `ⓘ` toggler allergen-row, kun én ad gangen
- [ ] DAWA-autocomplete virker
- [ ] Leverings-estimat opdateres ved adresse + pax (bruger CONFIG fra `/embed/config`)
- [ ] Cutoff-warning vises ved tæt-på-deadline dato (bruger CONFIG fra `/embed/config`)
- [ ] Submit POST'er til webhook
- [ ] Webhook accepterer `sandwichvalg`, `_form_meta`, `kontaktperson`-objekt uden valideringsfejl
- [ ] postMessage sender højde ved menu-åbning/lukning

### På production (efter deployment)

- [ ] WordPress DIVI Code Module renderer iframen
- [ ] iframe-højden auto-resizer ved menu-åbning
- [ ] Submit fra iframen opretter en bon i Bon v2 med status NY
- [ ] Kunde modtager bekræftelses-mail
- [ ] Mail-tråd routes korrekt til `bon@ristetrug.dk` ved kundens svar

---

## Migrationsplan til formbuilder field-types

Når den planlagte formbuilder-udvidelse implementeres skal følgende migreres:

| Hardcoded element | Migreres til field-type |
|---|---|
| Foldout "Sådan virker det" | `info_box` (collapsible content) |
| Quick-chips | `chip_group` (count-chips med count/text-typer) |
| Inline menu-picker | `menu_picker` (loader fra menus/<id>.json) |
| Sandwichvalg | `option_group` med subtekst-property |

`embed/bestilling.html` rebygges på det tidspunkt som formbuilder-engine output.
Spec til den udvidelse skrives separat — ikke nu.

---

## Beslutninger — låst

| Beslutning | Værdi |
|---|---|
| Embedding-metode | iframe via DIVI Code Module |
| Drawer eller inline | Inline expand (drawer afvist pga. iframe scroll-problemer) |
| Allergen-visning | Klik ⓘ → expand row, én ad gangen |
| Sticky kategori-headers | Behold |
| Sandwichvalg-tekst | "🌟 Køkkenet blander" / "✏️ Eget valg" + subtekst |
| Quick-chips antal/rækkefølge | 7 stk: Vegansk / Vegetar / Glutenfri / Laktosefri / Kød / Fisk / Allergi |
| Chip-typer | Alle count-type undtagen Allergi (text-type) |
| Menu-link tekst | "📋 Tilføj specifikke retter" — ens i begge sandwichvalg-states |
| Menu-data kilde | `public/menus/<id>.json` |
| URL-param | `?menu=<id>`, default `standard` |
| Default ved ukendt menu | Redirect til `?menu=standard` |
| Smart-append header | Indsættes kun ved ægte fritekst (ikke når kun ret-linjer findes) |
| Menu max-height | `min(60vh, 500px)` med intern scroll |
| `valgte_retter` i webhook | Sendes IKKE som strukturerede data — kun som tekst i `wishes` |
| CONFIG-værdier (cutoff, leveringspriser) | `system_settings` med `bestilling.*` prefix, hentes via `/embed/config` |
| Webhook-udvidelse | Påkrævet del af denne opgave (ikke separat ticket) |

---

## Åbne punkter Simon skal afklare

| Punkt | Spørgsmål |
|---|---|
| Webhook endpoint | Eksakt URL? `/api/formbuilder/webhook` eller andet? |
| Webhook schema-validering | Bruger eksisterende webhook Joi/Zod/manuel validering? Det afgør hvordan udvidelsen kodes. |
| Server.js mount-rækkefølge | `/embed` route skal mountes FØR auth-middleware (offentlig adgang) |
| Settings-UI til `bestilling.delivery_config` | Skal kontoret kunne redigere fra UI nu, eller venter det til settings-UI udvides? |

---

## Mockup-reference

Den endelige UX-adfærd er beskrevet i mockup-filen `bestilling_inline_v5.html`.
Tag den som referencen for:
- Præcise CSS-værdier (farver, padding, transition-tider)
- Smart-append regex og logik
- Menu-render struktur
- postMessage-pattern (skal tilføjes — er ikke i mockup'en)

Mockup'en er ikke produktionskode — den mangler:
- De fulde formbuilder-felter (ordertype, navn, email, etc.)
- DAWA-autocomplete
- OSRM leverings-estimat
- Cutoff-warning
- Submit-handler
- postMessage høj-resizer

Disse skal tilføjes ved at kopiere fra `bestilling_v2.html` (eksisterende formbuilder-output).

---

## Implementeringsrækkefølge

1. **Migration `db/migrations/0XX_bestilling_settings.sql`** — opret de 5 settings-keys med default-værdier
2. **`public/menus/standard.json`** — opret med alle nuværende retter (kopier fra mockup)
3. **`routes/embed.js`** — server route + headers + `/config`-endpoint + mount i `server.js` (FØR auth-middleware)
4. **`public/embed/bestilling.html`** — basisstruktur fra mockup v5
5. **Tilføj formbuilder-felter** — kopier fra `bestilling_v2.html`
6. **Loader-logik** — `loadConfig()` + `loadMenu()` ved sidens load
7. **Tilføj postMessage høj-resizer**
8. **Submit-handler** — POST til webhook
9. **Udvid webhook** — tilføj `sandwichvalg`, `_form_meta`, `kontaktperson`-parsing til `routes/formbuilder_webhook.js`
10. **Verificér end-to-end** — sender den nye payload korrekt en bon med status NY?
11. **`docs/wordpress_divi_snippet.html`** — kopier-klar snippet
12. **Lokal test** — wordpress_embed_test.html + iframe pegende på localhost
13. **Deploy til Hetzner**
14. **Leif skifter DIVI Code Module fra JotForm til ny iframe**
15. **Production-test** — én bestilling end-to-end, verificér mail-bekræftelse + bon i listview

---

*Sidst opdateret: maj 2026*
