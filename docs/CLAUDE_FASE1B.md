# CLAUDE_FASE1B.md — Fase 1b: Kunde/firma-søgning
> Læs CLAUDE.md og `docs/bon_v2_datamodel_v2.md` FØR du starter.
> Fase 1a (auth) skal være på plads først.
> Opdateret: marts 2026

---

## Hvad denne opgave dækker

En genbrugelig søgekomponent (`shared/kunde_soeg.js`) der bruges overalt hvor
man skal vælge eller oprette en kunde/firma — primært bon-opret, men også CRM og tilbud.

Tre ting bygges:

1. **Backend** — udvidet søge-API + opret-endpoints
2. **`shared/kunde_soeg.js`** — selve komponenten
3. **`shared/kunde_soeg.css`** — styling

---

## Hvad komponenten skal kunne

```
Bruger taster i søgefelt
→ Live søgning fra 2 tegn (debounce 250ms)
→ Resultater viser firma + kontaktperson
→ Klik på resultat → komponent udfyldes + kalder callback
→ Ingen match → "Opret ny"-knap vises
→ Opret ny → mini-formular inline (firma + kontakt)
→ CVR-nummer → auto-berig firma-data
```

**Output til forælderen** (via callback):
```js
{
  customer_id: 42,
  company_id: 7,           // null hvis privatperson
  customer_name: 'Lars Hansen',
  company_name: 'Novo Nordisk A/S',
  phone: '12345678',
  email: 'lars@novo.dk',
  default_payment_type: 'invoice',
  default_price_category_id: 2
}
```

---

## Trin 1 — Backend

### 1a. Udvid `GET /api/customers` — søgning med firma-join

Nuværende endpoint returnerer kun kunder. Det udvides til at søge på tværs og returnere firma-data med.

CVR-opslag kalder GET /api/cvr/:cvr

**Query params:** `?q=` (min 2 tegn), `?company_id=` (filter på firma)

**SQL:**
```sql
SELECT
  c.id AS customer_id,
  c.first_name, c.last_name,
  c.phone, c.email,
  co.id AS company_id,
  co.name AS company_name,
  co.cvr, co.ean,
  co.default_payment_type,
  co.default_price_category_id,
  co.discount_percent
FROM customers c
LEFT JOIN companies co ON c.company_id = co.id
WHERE c.is_active = 1
  AND (
    c.first_name LIKE '%'||?||'%' OR
    c.last_name  LIKE '%'||?||'%' OR
    c.email      LIKE '%'||?||'%' OR
    co.name      LIKE '%'||?||'%' OR
    co.cvr       LIKE '%'||?||'%'
  )
ORDER BY co.name, c.last_name, c.first_name
LIMIT 20
```

**Response per resultat:**
```json
{
  "customer_id": 42,
  "first_name": "Lars",
  "last_name": "Hansen",
  "phone": "12345678",
  "email": "lars@novo.dk",
  "company_id": 7,
  "company_name": "Novo Nordisk A/S",
  "cvr": "24256790",
  "ean": null,
  "default_payment_type": "invoice",
  "default_price_category_id": 2,
  "discount_percent": null
}
```

### 1b. Tilføj `GET /api/companies` — ny route

```
GET /api/companies?q=
GET /api/companies/:id
```

Monteres i `server.js`:
```js
app.use('/api/companies', require('./routes/companies'));
```

**`routes/companies.js`** — ny fil:
```js
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/companies?q=
router.get('/', (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  const rows = db.prepare(`
    SELECT id, name, cvr, ean, phone, email,
           default_payment_type, default_price_category_id,
           discount_percent, invoice_method
    FROM companies
    WHERE is_active = 1
      AND (name LIKE '%'||?||'%' OR cvr LIKE '%'||?||'%')
    ORDER BY name LIMIT 20
  `).all(q, q);
  res.json(rows);
});

// GET /api/companies/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT c.*, a.street_name, a.street_nr, a.postal_code, a.city
    FROM companies c
    LEFT JOIN addresses a ON c.address_id = a.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ikke fundet' });
  res.json(row);
});

// POST /api/companies — opret ny
router.post('/', (req, res) => {
  const db = getDb();
  const { name, cvr, ean, phone, email, invoice_method,
          default_payment_type, default_price_category_id, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Firmanavn mangler' });

  const result = db.prepare(`
    INSERT INTO companies (name, cvr, ean, phone, email, invoice_method,
                           default_payment_type, default_price_category_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, cvr||null, ean||null, phone||null, email||null,
         invoice_method||null, default_payment_type||null,
         default_price_category_id||null, notes||null);

  res.json({ id: result.lastInsertRowid });
});

module.exports = router;
```

### 1c. Tilføj `POST /api/customers` — opret ny kunde

Tilføjes i `routes/customers.js`:
```js
// POST /api/customers — opret ny
router.post('/', (req, res) => {
  const db = getDb();
  const { first_name, last_name, phone, email, company_id, notes } = req.body;
  if (!first_name) return res.status(400).json({ error: 'Fornavn mangler' });

  const result = db.prepare(`
    INSERT INTO customers (first_name, last_name, phone, email, company_id, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(first_name, last_name||null, phone||null, email||null,
         company_id||null, notes||null);

  res.json({ id: result.lastInsertRowid });
});
```

### 1d

// routes/cvr.js
// GET /api/cvr/:cvr
router.get('/:cvr', async (req, res) => {
  const result = await cvrEnrichment.lookup(req.params.cvr);
  res.json(result);
});

---

## Trin 2 — `shared/kunde_soeg.js`

### Anvendelse (i forælderen)

```html
<div id="kunde-soeg-container"></div>

<script type="module">
import { KundeSoeg } from '/shared/kunde_soeg.js';

const soeg = new KundeSoeg({
  container: document.getElementById('kunde-soeg-container'),
  onSelect: (data) => {
    // data = { customer_id, company_id, customer_name, company_name,
    //          phone, email, default_payment_type, default_price_category_id }
    console.log('Valgt:', data);
  }
});
</script>
```

### States

Komponenten har fire states der styrer hvad der vises:

```
IDLE       → Søgefelt tomt, ingen resultater
SEARCHING  → Spinner, debounce kører
RESULTS    → Liste af matches + "Opret ny"-knap nederst
SELECTED   → Valgt kunde vises som pill med ✕-knap
CREATING   → Mini-formular til ny kunde/firma
```

### Layout — RESULTS state

```
┌─────────────────────────────────────────────┐
│ 🔍 Søg på navn, firma eller CVR...          │
├─────────────────────────────────────────────┤
│ Novo Nordisk A/S                            │
│   Lars Hansen  ·  lars@novo.dk              │
├─────────────────────────────────────────────┤
│ Novo Nordisk A/S                            │
│   Anna Skov  ·  anna@novo.dk                │
├─────────────────────────────────────────────┤
│ + Opret ny kunde                            │
└─────────────────────────────────────────────┘
```

- Firmanavn: fed, fuld bredde
- Kundenavn + email: dæmpet, samme linje
- Privatpersoner (company_id = null): vises uden firmalnavn
- Maks 20 resultater

### Layout — SELECTED state

```
┌──────────────────────────────────────┐
│ Novo Nordisk A/S — Lars Hansen  [✕] │
└──────────────────────────────────────┘
```

Klik på ✕ → tilbage til IDLE.

### Layout — CREATING state

To steps: **A) Firma** → **B) Kontakt**

**Step A — Firma:**
```
┌─────────────────────────────────────────────┐
│ Nyt firma                                   │
│                                             │
│ CVR-nummer  [________]  [Slå op]            │
│                                             │
│ Firmanavn * [________________________]      │
│ Telefon     [________________________]      │
│ Email       [________________________]      │
│                                             │
│ ○ Privatkunde (intet firma)                 │
│                                             │
│              [Annuller]  [Næste →]          │
└─────────────────────────────────────────────┘
```

- CVR-opslag kalder `GET /api/cvr/:cvr` (eksisterende `cvrEnrichment.js`)
- Udfylder Firmanavn, email automatisk ved match
- "Privatkunde" springer Step A over og går direkte til Step B

**Step B — Kontakt:**
```
┌─────────────────────────────────────────────┐
│ Ny kontakt  (Novo Nordisk A/S)              │
│                                             │
│ Fornavn *   [________________________]      │
│ Efternavn   [________________________]      │
│ Telefon     [________________________]      │
│ Email       [________________________]      │
│                                             │
│              [← Tilbage]  [Opret]           │
└─────────────────────────────────────────────┘
```

- "Opret" → `POST /api/companies` (hvis nyt firma) → `POST /api/customers`
- Ved success → SELECTED state med den nye kunde
- `onSelect`-callback kaldes med de nye IDs

### Kode-struktur

```js
export class KundeSoeg {
  constructor({ container, onSelect }) {
    this.container = container;
    this.onSelect = onSelect;
    this.state = 'IDLE';
    this.debounceTimer = null;
    this.selected = null;
    this.createStep = 'firma'; // 'firma' | 'kontakt'
    this.newFirma = {};
    this.render();
  }

  setState(state) { this.state = state; this.render(); }

  async search(q) {
    if (q.length < 2) return this.setState('IDLE');
    this.setState('SEARCHING');
    const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    this.results = data;
    this.setState('RESULTS');
  }

  select(item) {
    this.selected = {
      customer_id: item.customer_id,
      company_id: item.company_id,
      customer_name: `${item.first_name} ${item.last_name||''}`.trim(),
      company_name: item.company_name || null,
      phone: item.phone,
      email: item.email,
      default_payment_type: item.default_payment_type,
      default_price_category_id: item.default_price_category_id
    };
    this.setState('SELECTED');
    this.onSelect(this.selected);
  }

  clear() {
    this.selected = null;
    this.setState('IDLE');
    this.onSelect(null);
  }

  render() { /* bygger HTML ud fra this.state */ }
}
```

---

## Trin 3 — `shared/kunde_soeg.css`

Følger designsystemet fra `shared/tokens.css`:

```css
.ks-wrapper { position: relative; }

.ks-input {
  width: 100%;
  padding: 0.6rem 0.85rem;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface, #fff);
  font-size: 0.95rem;
}

.ks-input:focus {
  outline: none;
  border-color: var(--brand-primary);
}

.ks-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0; right: 0;
  background: var(--color-surface, #fff);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  z-index: 200;
  overflow: hidden;
}

.ks-result {
  padding: 0.65rem 1rem;
  cursor: pointer;
  border-bottom: 1px solid var(--color-border);
}

.ks-result:last-child { border-bottom: none; }
.ks-result:hover { background: var(--brand-primary-light, #f1e6b2); }

.ks-result-firma {
  font-weight: 600;
  color: var(--color-text);
  font-size: 0.9rem;
}

.ks-result-kontakt {
  color: var(--color-text-dim);
  font-size: 0.8rem;
  margin-top: 0.1rem;
}

.ks-create-btn {
  padding: 0.65rem 1rem;
  color: var(--brand-primary);
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
}

.ks-create-btn:hover { background: var(--brand-primary-light, #f1e6b2); }

.ks-selected {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.85rem;
  background: var(--brand-primary-light, #f1e6b2);
  border: 1px solid var(--brand-primary);
  border-radius: 8px;
  font-size: 0.9rem;
}

.ks-selected-clear {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-text-dim);
  font-size: 1rem;
  line-height: 1;
}

.ks-form { padding: 1rem; }
.ks-form-field { margin-bottom: 0.85rem; }
.ks-form-field label {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-dim);
  margin-bottom: 0.3rem;
}
.ks-form-field input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  font-size: 0.9rem;
}
.ks-form-actions {
  display: flex;
  gap: 0.5rem;
  justify-content: flex-end;
  margin-top: 1rem;
}
```

---

## Verifikation

```bash
# 1. Søgning returnerer firma-data med?
curl "http://localhost:4321/api/customers?q=novo"
# Forventet: array med company_name, default_payment_type etc.

# 2. Ny route virker?
curl "http://localhost:4321/api/companies?q=ristet"
# Forventet: array med Ristet Rug (fra seed)

# 3. Opret firma virker?
curl -X POST http://localhost:4321/api/companies \
  -H "Content-Type: application/json" \
  -d '{"name":"Testfirma A/S","cvr":"12345678"}'
# Forventet: {"id": N}

# 4. Opret kunde virker?
curl -X POST http://localhost:4321/api/customers \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Test","last_name":"Person","company_id":1}'
# Forventet: {"id": N}
```

**Manuel test af komponenten:**
Lav en simpel testside `office/test-kunde-soeg.html` der blot mounterer
komponenten og logger `onSelect`-callbacket til konsollen.

---

## Checkliste

- [ ] `GET /api/customers?q=` udvidet med firma-join og søgning på company.name
- [ ] `routes/companies.js` oprettet (GET `/`, GET `/:id`, POST `/`)
- [ ] `POST /api/customers` tilføjet i `routes/customers.js`
- [ ] `server.js` — `/api/companies` mountet
- [ ] `shared/kunde_soeg.js` oprettet med alle 5 states
- [ ] `shared/kunde_soeg.css` oprettet
- [ ] CVR-opslag integreret i CREATING Step A
- [ ] `office/test-kunde-soeg.html` — manuel test OK
- [ ] Alle 4 curl-kommandoer giver forventet output
