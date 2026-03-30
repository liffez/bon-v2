# Fase: Fakturering (`office/views/fakturering.js` + backend)

> Læs `docs/BON_V2_PRINCIPPER.md`, `docs/bon_v2_datamodel_v2.md` og `docs/bon_v2_zoner_og_layout.md` før du starter.

---

## Mål

En arbejdsliste til fakturering i office-zonen. Viser alle bonner med `status = LEVERET` og
`payment_type = 'invoice'`. Read-only bon-visning til højre — man kopierer data til e-conomic
og markerer derefter faktureret. Ingen redigering af bonen her.

Mockup-fil til reference: `fakturering_mockup.html` (i projektrod eller docs/)

---

## Layout: Master-detail (splitview)

```
┌─────────────────┬──────────────────────────────────────┐
│  LISTE (380px)  │  DETAIL PANEL (flex:1, scrollbar)    │
│  sticky top     │                                       │
│  overflow-y     │  Read-only bon + action-bar           │
├─────────────────┤                                       │
│  [søg]          │                                       │
│  ─ Afventer ─── │                                       │
│  #3327 Novo...  │                                       │
│  #3326 Mærsk..  │                                       │
│  ─ Faktureret ─ │                                       │
│  #3319 ✓        │                                       │
└─────────────────┴──────────────────────────────────────┘
```

Office-zonen bruger `<body class="zone-office">` og sidebar fra `office/index.html`.
Fakturering er en view der indlæses i office SPA-shell via `office/views/fakturering.js`.

---

## 1. Database — migrationscheck

Verificér at følgende kolonner findes i `db/migrations/001_core.sql`.
Hvis de mangler, opret `db/migrations/002_economic_ids.sql`:

```sql
-- companies
ALTER TABLE companies ADD COLUMN economic_customer_id TEXT;

-- customers  
ALTER TABLE customers ADD COLUMN economic_contact_id  TEXT;
ALTER TABLE customers ADD COLUMN economic_customer_id TEXT;
-- (economic_customer_id på customers bruges kun for privatkunder uden firma)
```

Kør `npm run migrate` efter oprettelse.

---

## 2. Nye API-endpoints

Tilføj i `routes/bons.js` og `routes/customers.js`:

### GET /api/bons/invoice-queue

```
Returnerer bonner klar til fakturering + nylig fakturerede.

Query params:
  ?include_done=1   → medtag FAKTURERET/AFSLUTTET (default: kun LEVERET)
  ?limit=50         → max antal fakturerede (default: 20)

WHERE:
  status = LEVERET AND payment_type = 'invoice'
  (+ FAKTURERET/AFSLUTTET hvis include_done=1, sorteret delivery_date DESC)

JOIN: customers, companies, addresses (delivery), status_definitions
Inkluder: alle bon_lines med product_name, quantity, unit_price, co2e
```

Response-format:

```json
{
  "pending": [ ...bons ],
  "done": [ ...bons ],
  "summary": {
    "pending_count": 7,
    "pending_amount": 68450,
    "done_count_month": 12,
    "done_amount_month": 142200,
    "ean_count": 3
  }
}
```

Bon-objekt skal indeholde:
```json
{
  "id": 3327,
  "bon_number": "3327",
  "delivery_date": "2026-03-28",
  "pickup_time": "09:30",
  "delivery_time": "10:00",
  "pax": 120,
  "total_units": 240,
  "payment_type": "invoice",
  "customer_note": "...",
  "invoice_note": "...",
  "internal_note": "...",
  "kitchen_note": "...",
  "status_code": "LEVERET",
  "days_since_delivery": 2,

  "customer": {
    "id": 42,
    "first_name": "Helle",
    "last_name": "Munk",
    "phone": "23456789",
    "email": "helle.munk@novonordisk.com",
    "economic_contact_id": "20187",
    "economic_customer_id": null
  },
  "company": {
    "id": 7,
    "name": "Novo Nordisk A/S",
    "cvr": "24256790",
    "ean": "5798001234567",
    "invoice_method": "ean",
    "economic_customer_id": "10042"
  },
  "delivery_address": {
    "street_name": "Novo Nordisk Park",
    "street_nr": "1",
    "postal_code": "2760",
    "city": "Måløv"
  },
  "delivery_notes": "Indgang C, 2. sal...",
  "delivery_method": "bike",
  "lines": [
    {
      "id": 1,
      "product_name": "Falaflen slider",
      "quantity": 60,
      "unit_price": 99,
      "line_total": 5940,
      "note": "Vegansk"
    }
  ],
  "line_total": 24800
}
```

### PATCH /api/bons/:id/status → FAKTURERET

Brug eksisterende status-endpoint:
```json
{ "status_code": "FAKTURERET", "user_id": 1 }
```

Ingen ny route. Changelog skrives automatisk af serveren.

### PATCH /api/companies/:id/economic

Ny route i `routes/customers.js` (eller separat `routes/companies.js` hvis den findes):

```
PATCH /api/companies/:id/economic
Body: { "economic_customer_id": "10042" }
Opdaterer companies.economic_customer_id
Skriv changelog: entity_type='company', action='update', field_name='economic_customer_id'
```

### PATCH /api/customers/:id/economic

```
PATCH /api/customers/:id/economic
Body: { "economic_contact_id": "20187" }
  ELLER: { "economic_customer_id": "10042" }   ← kun privatkunder
Opdaterer det relevante felt på customers-rækken
Skriv changelog
```

---

## 3. Frontend — `office/views/fakturering.js`

SPA-view der mountes i office-shell. Eksportér én funktion: `mountFakturering(container)`.

### Struktur

```
office/views/fakturering.js   ← al logik
office/views/fakturering.css  ← styles (importer i office/index.html)
```

### Init-flow

```
mountFakturering(container)
  → render skeleton HTML (summary-strip + master-detail)
  → loadQueue()
    → GET /api/bons/invoice-queue
    → renderSummary(data.summary)
    → renderList(data.pending, data.done)
    → selectFirst() hvis pending.length > 0
```

### Summary strip

Fire kort øverst (sticky under topbar):
- **Afventer fakturering** — `summary.pending_count` + "bonner · status Leveret"
- **Ufaktureret beløb** — `summary.pending_amount` formateret som "68.450 kr"
- **Heraf EAN** — `summary.ean_count` + "offentlige kunder"
- **Faktureret [månedsnavn]** — `summary.done_amount_month` + `summary.done_count_month` + " bonner"

### Liste-panel (venstre, 380px)

**Søgefelt** — filtrerer live på bon_number, kundenavn, firmanavn.

**Sektion: "Afventer fakturering · N"**
Bon-rækker sorteret efter delivery_date ASC (ældste øverst — det der haster mest):

```
[aldersprik] [bon_number] [beløb]
             [kundenavn]
             [dato · pax · EAN-badge ELLER Faktura-badge]
```

Aldersprik (cirkel):
- Grøn: 0–3 dage
- Orange: 4–7 dage  
- Rød: 8+ dage

**Sektion: "Faktureret — [måned] · N"** (under afventer)
Samme format men dæmpet (opacity: 0.55), gennemstreget kundenavn, grøn ✓-prik.

Klik på række → `selectBon(bon)` → render detail panel til højre.
Første afventer-bon er valgt automatisk ved load.

### Detail-panel (højre, flex:1)

**Read-only.** Al data vises — ingen felter er redigerbare undtagen e-conomic-numrene.

Rækkefølge oppefra:

1. **Top-bar**: `#bon_number` + EAN/Faktura-badge + "Åbn bon ↗"-knap (navigerer til bon-redigering)

2. **Action-bar** (øverst OG nederst):
   ```
   [✓ Markér faktureret]   [e-conomic teaser/knap]
   ```
   - Knap til venstre: grøn, stor
   - Teaser til højre: blå info-boks med tekst "e-conomic integration kommer"
   - Hvis bonen allerede er FAKTURERET: vis "Faktureret [dato]" i stedet for knappen

3. **Levering**:
   - Dato (stor tekst)
   - Pickup-tid → leveringstid
   - Adresse (fed)
   - Leveringsinfo/notes
   - Leveringsmetode

4. **Kunde & firma**:
   - Kontaktnavn, email, telefon
   - Firmanavn + CVR
   - EAN (hvis udfyldt, mono-font)
   - **e-conomic firma-nr** — inline-edit (se nedenfor)
   - **e-conomic kontakt-nr** — inline-edit (se nedenfor)
   - Betalingstype

5. **Ordre**: pax/enheder, priskategori

6. **Køkken info** (kun hvis udfyldt): gul highlight-boks, italic

7. **Varer**: tabel med quantity, product_name, note, line_total. Sum-række nederst.

8. **Noter** (kun vis sektioner der er udfyldt):
   - Kundeønsker (`customer_note`)
   - Faktura info (`invoice_note`) ← vigtigt for e-conomic reference
   - Interne noter (`internal_note`)

9. **Action-bar** (gentaget)

### E-conomic inline-edit

To rækker i Kunde & firma-sektionen:

```
e-conomic    [10042]  [rediger]
firma-nr

e-conomic    [Ikke angivet]  [+ Tilføj]
kontakt-nr
```

Klik på [rediger] / [+ Tilføj] → vis input-felt inline:
```
[input felt]  [Gem]  [✕]
```

- Enter → gem
- Escape → annullér
- [Gem] → `PATCH /api/companies/:id/economic` eller `PATCH /api/customers/:id/economic`
- Ved success: opdater lokalt data-objekt, re-render feltet, vis kort "Gemt ✓" flash
- Fejl: vis "Kunne ikke gemme" inline

**Logik for hvilke felter der vises:**

```
Har bonen company_id?
  JA → vis "e-conomic firma-nr" (companies.economic_customer_id)
      + "e-conomic kontakt-nr" (customers.economic_contact_id)
  NEJ → vis "e-conomic kunde-nr" (customers.economic_customer_id)
         (privatkunde — kontakten ER debitoren)
```

### "Markér faktureret"-handling

```javascript
async function markFaktureret(bon) {
  // 1. Bekræftelsesdialog — ikke mandatory fakturaref
  const ref = await confirmDialog(
    `Markér bon #${bon.bon_number} som faktureret?`,
    { label: 'Fakturanummer (valgfrit)', placeholder: 'F-2026-0042' }
  );
  if (ref === null) return; // bruger trykkede Annuller

  // 2. PATCH status → FAKTURERET
  await api.patchStatus(bon.id, 'FAKTURERET', currentUserId);

  // 3. Hvis ref udfyldt: gem som internal_note eller separat felt
  //    (MVP: tilføj til internal_note med prefix "Fakturanr: ")
  if (ref.trim()) {
    await api.patchInternalNote(bon.id, `Fakturanr: ${ref.trim()}`);
  }

  // 4. Fjern fra pending-liste med fade-animation
  // 5. Vælg næste pending bon automatisk
  // 6. Opdater summary-tæller
}
```

**Bekræftelsesdialog** — simpel custom dialog (ikke browser confirm):
```
┌─────────────────────────────────────┐
│  Markér bon #3327 som faktureret?   │
│                                     │
│  Fakturanummer (valgfrit)           │
│  [________________________]         │
│                                     │
│  [Annuller]   [✓ Markér faktureret] │
└─────────────────────────────────────┘
```

Dialog vises som overlay — ikke browser `confirm()`.

---

## 4. Hvad der IKKE skal bygges nu

- e-conomic API-kald (kommer i Fase 7)
- Afsend EAN-faktura
- PDF-generering
- Batch-fakturering (markér flere på én gang)

---

## 5. Filplacering

```
office/views/fakturering.js    ← mount-funktion + al logik
office/views/fakturering.css   ← styles (importer i office/index.html <head>)
routes/companies.js            ← PATCH /api/companies/:id/economic (ny fil hvis ikke findes)
                                  ELLER tilføj til routes/customers.js
```

Tilføj til `server.js`:
```javascript
const companiesRouter = require('./routes/companies');
app.use('/api/companies', companiesRouter);
```

Tilføj til office navigation i `office/index.html`:
```html
<a class="sidebar-item" data-view="fakturering" href="#">
  <span class="icon">💰</span> Fakturering
  <span class="badge" id="invoice-badge"></span>
</a>
```

Badge opdateres ved load med antal afventende.

---

## 6. Test

Manuel smoke-test:
1. Load `/office/` → klik Fakturering
2. Summary-strip viser korrekte tal
3. Første bon vælges automatisk i listen
4. Klik anden bon → detail skifter
5. Søg på kundenavn → filtrerer listen
6. Klik "rediger" på e-conomic firma-nr → input vises → skriv nummer → Gem → felt opdateres
7. Escape i edit → felt vender tilbage uændret
8. Klik "Markér faktureret" → dialog vises → skriv fakturanr → bekræft → bon forsvinder fra pending → næste vælges automatisk
9. Bon dukker op i "Faktureret"-sektionen med ✓
10. Verificér `GET /api/bons/:id/changelog` har status_change til FAKTURERET

---

## 7. Prioritering

Rækkefølge inden for denne fase:
1. Migration-check + nye API-endpoints
2. Basis master-detail layout med liste + static detail
3. Dynamic detail render fra API
4. E-conomic inline-edit
5. Markér faktureret med dialog
6. Summary-strip live
7. Søgefilter
