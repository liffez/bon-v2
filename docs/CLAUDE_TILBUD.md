# CLAUDE_TILBUD.md — Tilbudsmodul

> Spec + status for tilbudsmodul i Bon v2 Office-zonen.
> Læs `BON_V2_PRINCIPPER.md`, `bon_v2_datamodel_v2.md` og `CLAUDE.md` inden du starter.
> Opdateret: 7. april 2026

---

## Placering i systemet

**Sidebar:** Separat punkt — efter CRM, før Fakturering.

```
├── CRM
│   ├── Pipeline
│   ├── Kunder
│   ├── Serviceopkald
│   └── Aktiviteter
├── Tilbud          ← her
├── Fakturering
└── Rapporter
```

**Kobling til CRM via deep links:**
- Kunde 360 grader => "Opret tilbud" => `switchView('tilbud', { customer_id })`
- Pipeline-kort => "Se tilbud" => `switchView('tilbud', { id: quoteId })`

---

## Arkitekturbeslutning — tilbud = bon med `is_offer=1`

Tilbud gemmes **ikke** i en separat `quotes`-tabel. De er bons med `is_offer=1`.

Fordele:
- Integrerer automatisk med kalender, planlægning, CRM pipeline
- Genbruger hele bon-infrastrukturen (changelog, SSE, KundeSoeg, drawer)
- Konvertering = `UPDATE bons SET is_offer=0, status_id=GODKENDT`

Filtrering:
- `GET /api/bons` ekskluderer `is_offer=1`
- CRM ordrer/stats ekskluderer `is_offer=1`
- `GET /api/quotes` er en wrapper der kun returnerer `is_offer=1` bons

Tilbudsnumre bruger separat T-nummerserie (`quote_number_prefix` + `quote_number_next` i settings).

---

## FASE 9 — Komplet (april 2026)

### Hvad der er bygget

**Migrations 020-023:**
- 020-021: `quotes`/`quote_lines` tabeller (midlertidigt, omskrevet i 022)
- 022: `offer_template`, `offer_price_mode`, `offer_discount_percent` pa bons + `block_type` pa bon_lines
- 023: `TILBUD` status i `status_definitions` med transitions (=> GODKENDT, => AFLYST, => NY)

**`routes/quotes.js`** — 11 endpoints (opererer pa bons med `is_offer=1`):
```
GET    /api/quotes                    Liste (filtre: status, customer_id, q)
GET    /api/quotes/next-number        { quote_number: 'T-42' }
GET    /api/quotes/:id                Enkelt tilbud med linjer + kunde + firma
POST   /api/quotes                    Opret nyt tilbud
PATCH  /api/quotes/:id                Opdater tilbud
DELETE /api/quotes/:id                Slet (kun draft)
POST   /api/quotes/:id/lines          Tilfoej linje
PUT    /api/quotes/:id/lines/:lid     Opdater linje
DELETE /api/quotes/:id/lines/:lid     Slet linje
PATCH  /api/quotes/:id/status         Skift status (draft/sent/won/lost/expired)
POST   /api/quotes/:id/convert        Tilbud => bon (saet is_offer=0)
```

**`office/views/tilbud.js` + `tilbud.css`:**
- Tilbudsliste med status-filtre (Kladde/Sendt/Vundet/Tabt), sogning, klik abner wizard
- 5-trins wizard:
  - Step 0: Skabelon (Event / Enkeltbestilling)
  - Step 1: Kunde og levering — KundeSoeg, dato, tid, pax, leveringstype, DAWA-adresse, priskategori, betaling, noter
  - Step 2: Sammensat — Grocy-recipes, event-blokke (morgen/amsnack/frokost/pmsnack), single-liste, fritekst
  - Step 3: Priser — prismode (total/blok/linje), rabat, gyldighed, levering, pristabel
  - Step 4: Preview + Gem + Download PDF + Konverter til bon
- Alle steps klikbare for eksisterende tilbud
- Ordrehistorik med kopier-bon
- PDF-generering med Ristet Rug logo (base64 PNG fra `assets/logo-b64.txt`)

**Ovrigt:**
- `office/index.html`: sidebar-punkt, jsPDF CDN, view-switcher, SSE-handlers
- `shared/api.js`: 8 nye funktioner (fetchQuotes, createQuote, updateQuote, deleteQuote, patchQuoteStatus, convertQuoteToBon, fetchNextQuoteNumber)
- CRM Kunde 360 grader: Tilbud-tab + "Opret tilbud" deep link
- Kitchen later-view: `OR b.is_offer = 1` tilfojet
- Kalender: tilbud vises med TILBUD-status badge

### Kendte begraensninger efter real-world test (april 2026)
- Blok-overskrifter er hardcodet (`morning`/`amsnack`/`lunch`/`pmsnack`) — ikke fleksibelt for andre installationer
- Pax er globalt for hele tilbuddet — kan ikke saettes pr. blok
- Leveringsadresse vises ikke pa PDF
- Ingen kundenote-felt der fremgar af PDF
- Priser pr. pax vises ikke per blok

---

## FASE 9b — Naeste opgave

> Baseret pa real-world test med rigtig kunde, april 2026.

### Oversigt

| # | Aendring | Migration | Backend | Frontend |
|---|---------|-----------|---------|----------|
| 1 | Kundenote pa PDF | `offer_note` pa bons | PATCH accept | Step 3 + PDF |
| 2 | Blok-overskrifter via settings | Seed `offer_block_types` | GET /api/settings | Wizard + Settings UI |
| 3 | Pax pr. blok (event) | `offer_block_metadata` JSON pa bons | PATCH accept | Step 1/2 |
| 4 | Blokpris pr. pax | — | — | Step 3 + PDF |
| 5 | Leveringsadresse pa PDF | — | — | genPDF() |

---

### 9b.1 Migration: `db/migrations/024_tilbud_v2.sql`

```sql
-- Kundenote der vises pa PDF
ALTER TABLE bons ADD COLUMN offer_note TEXT;

-- Per-blok metadata: pax (JSON)
-- Format: { "morning": { "pax": 50 }, "lunch": { "pax": 80 } }
-- Kun blokke der afviger fra globalt pax gemmes
ALTER TABLE bons ADD COLUMN offer_block_metadata TEXT;

-- Konfigurerbare blok-typer til event-tilbud
INSERT OR IGNORE INTO settings (key, value, description) VALUES (
  'offer_block_types',
  '[{"key":"morning","label":"Morgen","sort_order":1},{"key":"amsnack","label":"Formiddag","sort_order":2},{"key":"lunch","label":"Frokost","sort_order":3},{"key":"pmsnack","label":"Eftermiddag","sort_order":4}]',
  'Blok-typer til event-tilbud (JSON-array med key, label, sort_order)'
);
```

**Notat om `block_type`:** Er TEXT uden CHECK constraint pa `bon_lines` — gemmer blot `key`-vaerdien fra settings. Historiske tilbud pavorkes ikke hvis labels aendres (key forbliver stabil). Ukendt key viser key-vaerdien som fallback i UI og PDF.

---

### 9b.2 Settings UI — blok-overskrifter

**I `settings/index.html`** tilfojes ny sektion (placering: System-sektionen eller ny "Tilbud"-sektion):

```
Blok-typer til event-tilbud
---------------------------------------------
  [Morgen      ]  [op] [ned] [slet]
  [Formiddag   ]  [op] [ned] [slet]
  [Frokost     ]  [op] [ned] [slet]
  [Eftermiddag ]  [op] [ned] [slet]
  [+ Tilfoej blok]                    [Gem]
```

- Hvert input redigerer `label` — `key` aendres aldrig efter oprettelse
- `key` for nye blokke: `custom1`, `custom2` etc. (auto-increment pa eksisterende custom-keys)
- Rækkefølge styrer visning i wizard og pa PDF
- Gem: `PATCH /api/settings/offer_block_types` med opdateret JSON (eksisterende endpoint)

**Ingen nye backend-endpoints** — `GET /api/settings` og `PATCH /api/settings/:key` eksisterer allerede.

---

### 9b.3 Frontend — pax pr. blok

**Placering:** Step 1 (Kunde og levering) — kun synlig ved event-skabelon.

```
Antal gaester (samlet)    [50]

Pax pr. blok (kun udfyld hvis det afviger fra samlet):
  Morgen        [   ]     <- tom = anvend globalt pax (50)
  Frokost       [80 ]     <- udfyldt = 80 pax
  Eftermiddag   [   ]     <- tom = anvend globalt pax (50)
```

- Felterne er pre-filled med tomme vaerdier (ikke med globalt pax) for at undga forvirring
- Hjaeelpetext under feltet: "Tom = {globalPax} gaester"
- Kun event-skabelon — ikke single/custom

**I step 2** vises aktiv pax som pill pa blok-header:
```
[ Morgen · 50 pax ]    [ Frokost · 80 pax ]
```

**Beregning af effektiv pax:**
```javascript
function effectivePax(blockKey) {
  const meta = offer_block_metadata?.[blockKey];
  return meta?.pax ?? globalPax;
}
```

**Gem til DB:** Kun afvigende blokke gemmes i `offer_block_metadata`:
```json
{ "lunch": { "pax": 80 } }
```

---

### 9b.4 Frontend — blokpris pr. pax

**Kun synlig i step 3 nar `price_mode` er `block` eller `line`.**

Under hver bloks samlede pris tilfojes en sekundaer linje:
```
Morgen                       3.100 kr
                                62 kr/pax    <- ny linje
```

Beregning:
```javascript
const blockTotal = lines
  .filter(l => l.block_type === blockKey)
  .reduce((sum, l) => sum + l.line_total, 0);
const pricePerPax = blockPax > 0
  ? Math.round(blockTotal / blockPax)
  : null;
```

**Pa PDF** (kun ved price_mode block/line):
```
Morgen  .......................  3.100 kr  (62 kr/pax)
```

---

### 9b.5 Frontend — kundenote pa PDF

**Nyt felt i step 3**, under eksisterende indstillinger:

```
Note til kunden (vises pa tilbuddet):
+------------------------------------------+
| Vi ser frem til at byde jer velkommen    |
| og skabe en god oplevelse.               |
+------------------------------------------+
```

- Fritekst textarea, ca. 3-4 linjer
- Vises pa PDF under kundeinformation, over varelisten
- Adskilt fra interne noter (kokken/faktura) — de ma ikke pa PDF

**Gem:** `offer_note` felt i PATCH-payload.

---

### 9b.6 Frontend — leveringsadresse pa PDF

I `genPDF()` tilfojes en leveringssektion under kundeinformation:

```
Levering
Torsdag 15. maj 2026  kl. 11:30
Vester Voldgade 10, 1552 Kobenhavn V
Byekspressen  450 kr
```

Ved `delivery_type = 'pickup'`:
```
Afhentning
Prinsesse Charlottesgade 16, 2200 Kobenhavn N
Torsdag 15. maj 2026  kl. 11:30
```

Felter der indgar (spring over hvis tomme):
- `delivery_date` + `delivery_time` — formateret dansk dato
- `delivery_address` — fra addresses-join
- `delivery_note` — bud-info
- `delivery_price` — kun hvis > 0

---

### 9b.7 Opdateringer til `routes/quotes.js`

`PATCH /api/quotes/:id` skal acceptere de to nye felter — tilfoj til eksisterende whitelist:
```javascript
'offer_note',
'offer_block_metadata',  // Validaer at det er valid JSON inden gem
```

`GET /api/quotes/:id` skal returnere de to nye felter i response.

---

### 9b.8 Implementeringsraekkefolge

1. Migration `024_tilbud_v2.sql`
2. `routes/quotes.js` — tilfoej `offer_note` og `offer_block_metadata` til PATCH whitelist og GET response
3. `settings/index.html` — blok-type editor sektion
4. `office/views/tilbud.js`:
   - Hent `offer_block_types` fra settings ved init (cache i modulscope)
   - Brug blok-labels fra settings overalt hvor blok-navne vises (erstatter hardcodede strings)
   - Step 1: pax-pr-blok felter
   - Step 2: pax-pill pa blok-headers
   - Step 3: blokpris pr. pax + kundenote textarea
5. `genPDF()`:
   - Leveringsadresse-sektion
   - Kundenote under kundeinformation
   - Blokpris + pris pr. pax i parentes

---

### 9b.9 Testplan

| # | Test | Forventet |
|---|------|-----------|
| 1 | Migration korer | `offer_note`, `offer_block_metadata` oprettet, `offer_block_types` i settings |
| 2 | Settings: tilfoej blok "Aftensnak" | Ny blok med `custom1` key, vises i wizard |
| 3 | Settings: omdob "Morgen" til "Morgenbuffet" | Wizard + PDF viser ny label, `block_type` key uaendret |
| 4 | Settings: slet blok | Linjer med slettet key viser key-navn som fallback |
| 5 | Pax pr. blok — tom | Effektiv pax = global pax, pill viser global vaerdi |
| 6 | Pax pr. blok — udfyldt | Pill viser blok-pax, beregning korrekt |
| 7 | Blokpris pr. pax | Vises kun ved price_mode block/line, korrekt beregning |
| 8 | Kundenote gem og genaabn | Note bevares, vises korrekt i preview |
| 9 | PDF — leveringsadresse | Adresse, dato, tid, budinfo pa PDF |
| 10 | PDF — afhentning | Viser afhentningsadresse og tidspunkt |
| 11 | PDF — kundenote | Note vises under kundeinformation |
| 12 | PDF — pris pr. pax | Vises i parentes ved blok-priser nar price_mode = block/line |
| 13 | Eksisterende tilbud | Abner uden fejl, manglende felter er null/tom |

---

## Fase 2 (ikke i denne spec)

- Send mail med PDF som vedhaegtning (via mailService)
- `#T-NNN` email-tag-routing i mailService
- Priskategori-valg per tilbud (dropdown i step 1)
- Tilbud som "ghost"-blokke i kalender-view
