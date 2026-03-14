# CLAUDE_FASE1C.md — Fase 1c: Bon-opret modal + Bon-detalje drawer
> Læs CLAUDE.md og docs/bon_v2_datamodel_v2.md FØR du starter.
> Fase 1a (auth) + Fase 1b (kunde_soeg) skal være på plads først.
> Opdateret: marts 2026

---

## Hvad denne opgave dækker

To UI-komponenter til office-zonen:

1. **Modal 1 — Hurtig opret** (`shared/bon_opret_modal.js`)
   Minimum info, bon oprettes, drawer åbnes automatisk

2. **Drawer — Bon-detalje** (`shared/bon_drawer.js` + `shared/bon_drawer.css`)
   Fuld redigering af alle felter. URL-synkroniseret.

---

## Del 1 — Hurtig opret modal

### Formål

Ny bon på under 30 sekunder. Kun det der er nødvendigt for at bonen eksisterer
og køkkenet ved hvad der sker. Alt andet udfyldes i draweren bagefter.

### Obligatoriske felter

| Felt | Kilde |
|------|-------|
| Kunde | KundeSoeg-komponenten (Fase 1b) |
| Leveringsdato | Dato-picker |
| Leveringstidspunkt | Tid-picker (kvartersintervaller 07:00-20:00) |
| Delivery type | Toggle: Levering / Afhentning / Event |

### Valgfrie felter i modal 1

| Felt | Default |
|------|---------|
| Pax | Tom |
| Priskategori | Fra firma's default_price_category_id, ellers 'catering' |

### Layout

```
+---------------------------------------------+
|  Ny bon                                 [X] |
+---------------------------------------------+
|  KUNDE                                      |
|  [KundeSoeg-komponent]                      |
|                                             |
|  LEVERING                                   |
|  [Dato____________] [Tid______]             |
|                                             |
|  TYPE                                       |
|  [Levering] [Afhentning] [Event]            |
|                                             |
|  PAX & PRISKATEGORI                         |
|  [Pax___] [Priskategori v]                 |
|                                             |
+---------------------------------------------+
|                  [Annuller] [Opret bon]     |
+---------------------------------------------+
```

- Delivery type: tre knapper, en aktiv ad gangen
- Priskategori: hentes fra GET /api/price-categories
- Dato-minimum: ingen (kontoret kan oprette backdaterede bonner)
- Modal lukkes med X, Escape eller Annuller

### Backend: POST /api/bons

Eksisterer allerede. Verificer at den accepterer og returnerer:

Request:
```json
{
  "customer_id": 42,
  "company_id": 7,
  "delivery_date": "2026-03-20",
  "delivery_time": "11:30",
  "delivery_type": "delivery",
  "pax": 25,
  "price_category_id": 2,
  "location_id": 1,
  "created_by_user_id": 1
}
```

Response:
```json
{ "id": 3242, "bon_number": "3242" }
```

Serveren saetter automatisk:
- status_id -> NY
- order_date -> i dag
- bon_number -> via nextBonNumber() fra db/helpers.js

### Efter opret

1. Modal lukkes
2. Drawer aabnes automatisk med den nye bon via openDrawer(bonId)
3. URL opdateres til office/?bon=3242
4. SSE broadcaster bon_created -> listview/kalender opdaterer

### shared/bon_opret_modal.js — struktur

```js
export class BonOpretModal {
  constructor({ onCreated }) {
    this.onCreated = onCreated; // callback(bonId)
    this.kundeSoeg = null;
    this._buildDOM();
  }

  open() { this._reset(); this.el.style.display = 'flex'; }
  close() { this.el.style.display = 'none'; }

  async _submit() {
    // Valider obligatoriske felter
    // POST /api/bons
    // this.onCreated(data.id)
  }
}
```

---

## Del 2 — Bon-detalje drawer

### Formaal

Fuld visning og redigering af alle felter pa en bon.
Aabnes fra: hurtig opret, listview, kalender, direkte URL.

### URL-sync

```js
function openDrawer(bonId) {
  const url = new URL(window.location);
  url.searchParams.set('bon', bonId);
  history.pushState({}, '', url);
  drawer.load(bonId);
  drawer.show();
}

function closeDrawer() {
  const url = new URL(window.location);
  url.searchParams.delete('bon');
  history.pushState({}, '', url);
  drawer.hide();
}

// Ved load: aabne automatisk hvis ?bon= i URL
window.addEventListener('load', () => {
  const bonId = new URLSearchParams(window.location.search).get('bon');
  if (bonId) openDrawer(bonId);
});

// Browser tilbage/frem
window.addEventListener('popstate', () => {
  const bonId = new URLSearchParams(window.location.search).get('bon');
  if (bonId) { drawer.load(bonId); drawer.show(); }
  else drawer.hide();
});
```

### Layout

Glider ind fra hoejre. Bredde: 520px desktop, fuld bredde mobil.
Overlay bag draweren daemper indholdet (klikbart, lukker drawer).

```
+--------------------------------------------------+----------------+
|  [Listview/kalender — daempet]                   | Bon #3242  [X] |
|                                                  |----------------|
|                                                  | [STATUS-BAR]   |
|                                                  |                |
|                                                  | LEVERINGSDATO  |
|                                                  | [Dato] [Tid]   |
|                                                  | Pickup: [Tid]  |
|                                                  |                |
|                                                  | LEVERING       |
|                                                  | [Type-toggle]  |
|                                                  | [DAWA-adresse] |
|                                                  | [Leveringsinfo]|
|                                                  |                |
|                                                  | KUNDE          |
|                                                  | [KundeSoeg]    |
|                                                  |                |
|                                                  | KOEKKEN        |
|                                                  | [] Koekkenet   |
|                                                  | Pax[_] Enh[__] |
|                                                  | Priskategori[v]|
|                                                  | Betaling[v]    |
|                                                  |                |
|                                                  | FIRMA          |
|                                                  | [Firmanavn]    |
|                                                  | [EAN]          |
|                                                  |                |
|                                                  | NOTER          |
|                                                  | Kundeonsker[ ] |
|                                                  | Faktura info[] |
|                                                  | Koekken info[] |
|                                                  | Interne noter[]|
|                                                  |                |
|                                                  |----------------|
|                                                  | [Slet]    [Gem]|
+--------------------------------------------------+----------------+
```

### Sektioner i draweren

**STATUS-BAR**
Samme statusknapper som bon_kort.js — genbruge BonConfigBar.js.
Klik pa status -> PATCH /api/bons/:id/status.
SSE-opdatering reflekteres automatisk.

**LEVERINGSDATO**
- Dato + leveringstid (kvartersintervaller)
- Pickup-tid: hvornaar maden skal vaere klar (tidsvaelger)

**LEVERING**
- Delivery type toggle: Levering / Afhentning / Event
- Leveringsadresse (DAWA autocomplete) — vises kun ved delivery_type = 'delivery'
  Genbruge adresse-logikken fra bestilling.html
- Leveringsinfo: fri tekst (etage, adgangskode, port etc.)
- Delivery method dropdown (Cykel / Taxa / Volvo / Afhentning) — vises ved delivery

**KUNDE**
KundeSoeg-komponenten i redigerbar tilstand.
Viser valgt kunde som pill — klik aabner soegning igen.

**KOEKKEN**
- Checkbox: Kokkenet vaelger menu (kitchen_selects)
- Pax + Enheder (total_units) side om side
- Priskategori dropdown fra GET /api/price-categories
- Betalingstype dropdown fra GET /api/payment-types

**FIRMA**
- Firmanavn (readonly — stammer fra KundeSoeg)
- EAN-nummer (redigerbart)
- Fakturametode (email / EAN / portal)

**NOTER — fire tekstfelter**
- Kundeonsker (customer_wishes)
- Faktura info (invoice_info)
- Koekken info (kitchen_info)
- Interne noter (internal_notes)

### Gem-logik

Ikke auto-save — en "Gem"-knap.

Aendringer markeres visuelt: header-bar skifter farve, Gem-knap aktiveres.
Ved luk med ugemte aendringer: bekraeftelsesdialog.

PATCH /api/bons/:id — ny endpoint der accepterer delvise opdateringer:

```json
{
  "delivery_date": "2026-03-20",
  "delivery_time": "11:30",
  "pax": 25,
  "kitchen_info": "Husk servietter",
  "payment_type": "invoice"
}
```

Serveren skriver logChange(...) for hvert aendret felt.
SSE broadcaster bon_updated.

### Backend: PATCH /api/bons/:id (ny)

Tilfoej i routes/bons.js.

Felter der ma patches:
```
delivery_date, delivery_time, pickup_time,
delivery_type, delivery_method, delivery_address_id,
delivery_notes, delivery_cost, delivery_price,
courier_provider, courier_arrival_time,
customer_id, company_id, price_category_id,
pax, total_units, boxes,
payment_type, kitchen_selects, customer_collects,
kitchen_info, customer_wishes, internal_notes, invoice_info
```

Felter der IKKE patches herfra:
```
bon_number, status_id, location_id, created_by_user_id,
prep_*, inventory_*, created_at
```

Logik:
```js
router.patch('/:id', (req, res) => {
  const allowed = ['delivery_date', 'delivery_time', 'pickup_time',
    'delivery_type', 'delivery_method', 'delivery_address_id',
    'delivery_notes', 'customer_id', 'company_id', 'price_category_id',
    'pax', 'total_units', 'boxes', 'payment_type',
    'kitchen_selects', 'customer_collects',
    'kitchen_info', 'customer_wishes', 'internal_notes', 'invoice_info'];

  const updates = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Ingen gyldige felter' });

  const db = getDb();
  const bon = getBon(req.params.id);
  if (!bon) return res.status(404).json({ error: 'Bon ikke fundet' });

  // Byg SET-clause dynamisk
  const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(updates), req.params.id];
  db.prepare(`UPDATE bons SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);

  // Log hvert aendret felt
  for (const [field, newVal] of Object.entries(updates)) {
    logChange({ entity_type: 'bon', entity_id: bon.id,
      action: 'update', field_name: field,
      old_value: String(bon[field] ?? ''), new_value: String(newVal ?? ''),
      user_id: req.session?.userId });
  }

  broadcast('bon_updated', { id: bon.id });
  res.json({ ok: true });
});
```

### Adresse-haandtering

Leveringsadresse gemmes i addresses-tabellen via delivery_address_id.

Nar bruger vaelger adresse fra DAWA:
1. POST /api/addresses med vejnavn, nr, postnr, by, lat, lon
2. Response giver address_id
3. PATCH /api/bons/:id med { delivery_address_id: address_id }

routes/addresses.js — ny fil:
```js
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.post('/', (req, res) => {
  const { street_name, street_nr, postal_code, city, lat, lon } = req.body;
  if (!street_name) return res.status(400).json({ error: 'street_name mangler' });
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(street_name, street_nr||null, postal_code||null, city||null, lat||null, lon||null);
  res.json({ id: result.lastInsertRowid });
});

module.exports = router;
```

### shared/bon_drawer.js — struktur

```js
export class BonDrawer {
  constructor() {
    this.bonId = null;
    this.data = null;
    this.dirty = false;
    this._buildDOM();
    this._bindSSE();
  }

  async load(bonId) {
    this.bonId = bonId;
    this.dirty = false;
    const res = await fetch(`/api/bons/${bonId}`);
    this.data = await res.json();
    this._render();
  }

  show() { this.el.classList.add('open'); }

  hide() {
    if (this.dirty && !confirm('Du har ugemte aendringer. Luk alligevel?')) return;
    this.el.classList.remove('open');
    this.dirty = false;
  }

  _markDirty() {
    this.dirty = true;
    this.el.querySelector('.drawer-header').classList.add('has-changes');
    this.el.querySelector('.btn-gem').disabled = false;
  }

  async _save() {
    const payload = this._collectFields();
    await fetch(`/api/bons/${this.bonId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    this.dirty = false;
    this.el.querySelector('.drawer-header').classList.remove('has-changes');
  }

  _bindSSE() {
    // Lyt pa bon_updated — re-render hvis bonId matcher
    window.addEventListener('sse:bon_updated', e => {
      if (e.detail.id == this.bonId && !this.dirty) this.load(this.bonId);
    });
  }
}
```

---

## Nye API-endpoints (oversigt)

| Method | URL | Fil | Note |
|--------|-----|-----|------|
| POST | /api/bons | routes/bons.js | Eksisterer — verificer response |
| PATCH | /api/bons/:id | routes/bons.js | Ny — fuld felt-patch |
| GET | /api/price-categories | routes/price_categories.js | Ny |
| POST | /api/addresses | routes/addresses.js | Ny |

routes/price_categories.js:
```js
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

router.get('/', (req, res) => {
  const rows = getDb().prepare(
    'SELECT id, code, label FROM price_categories WHERE is_active = 1 ORDER BY id'
  ).all();
  res.json(rows);
});

module.exports = router;
```

Mount i server.js:
```js
app.use('/api/price-categories', require('./routes/price_categories'));
app.use('/api/addresses', require('./routes/addresses'));
```

---

## Verifikation

```bash
# 1. Opret bon
curl -b cookies.txt -X POST http://localhost:4321/api/bons \
  -H "Content-Type: application/json" \
  -d '{"customer_id":1,"delivery_date":"2026-03-25","delivery_time":"11:30","delivery_type":"delivery","location_id":1,"created_by_user_id":1}'
# Forventet: {"id":N,"bon_number":"XXXX"}

# 2. Patch bon
curl -b cookies.txt -X PATCH http://localhost:4321/api/bons/N \
  -H "Content-Type: application/json" \
  -d '{"pax":20,"kitchen_info":"Husk servietter","payment_type":"invoice"}'
# Forventet: {"ok":true}

# 3. Changelog skrevet?
curl -b cookies.txt http://localhost:4321/api/bons/N/changelog
# Forventet: entries for pax, kitchen_info, payment_type

# 4. Priskategorier
curl http://localhost:4321/api/price-categories
# Forventet: [{id,code,label}, ...]

# 5. Opret adresse
curl -b cookies.txt -X POST http://localhost:4321/api/addresses \
  -H "Content-Type: application/json" \
  -d '{"street_name":"Thorvaldsensvej","street_nr":"40","postal_code":"1871","city":"Frederiksberg"}'
# Forventet: {"id":N}
```

Manuel test:
- Opret bon via Modal 1 -> drawer aabner -> URL viser ?bon=XXXX
- Kopier URL -> aabne i nyt vindue -> drawer aabner automatisk
- Ret et felt -> Gem-knap aktiveres -> Gem -> changelog har entry
- Luk drawer med ugemte aendringer -> bekraeftelsesdialog vises
- Browser tilbage -> drawer lukker, URL ryddes

---

## Checkliste

Backend:
- [ ] POST /api/bons verificeret — returnerer { id, bon_number }
- [ ] PATCH /api/bons/:id implementeret med allowed-list + logChange per felt
- [ ] routes/price_categories.js oprettet og mountet
- [ ] routes/addresses.js oprettet og mountet
- [ ] SSE broadcaster bon_created ved POST
- [ ] SSE broadcaster bon_updated ved PATCH

Modal 1:
- [ ] shared/bon_opret_modal.js oprettet
- [ ] KundeSoeg monteret i modal
- [ ] Delivery type toggle (3 valg)
- [ ] Priskategori dropdown fra API
- [ ] Submit -> POST -> aabner drawer med ny bon

Drawer:
- [ ] shared/bon_drawer.js oprettet
- [ ] shared/bon_drawer.css oprettet
- [ ] URL-sync: ?bon= saettes ved aaben, ryddes ved luk
- [ ] Direkte URL aabner drawer automatisk ved load
- [ ] Browser tilbage/frem via popstate
- [ ] Alle felter fra bons-tabellen er med
- [ ] Status-bar genbruger BonConfigBar.js
- [ ] DAWA adresse-autocomplete (genbrug fra bestilling.html)
- [ ] Leveringsadresse vises kun ved delivery_type = 'delivery'
- [ ] Dirty-tracking: Gem-knap aktiveres ved aendringer
- [ ] Bekraeftelsesdialog ved luk med ugemte aendringer
- [ ] SSE lytter pa bon_updated — re-render ved match, ikke ved dirty
- [ ] Alle 5 curl-kommandoer giver forventet output
- [ ] Manuel URL-test OK
