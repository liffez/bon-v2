# CLAUDE_FASE1D.md — Fase 1d: Formbuilder webhook + VarePicker refaktorering
> Læs CLAUDE.md og docs/bon_v2_datamodel_v2.md FØR du starter.
> Fase 1a (auth) + Fase 1b (kunde_soeg) + Fase 1c (bon-opret) skal være på plads først.
> Opdateret: marts 2026

---

## Hvad denne opgave dækker

To ting:

1. **Formbuilder webhook** — modtager data fra bestillingsformularen og opretter bon
2. **`shared/vare_picker.js`** — refaktorering af picker ud af `bon_kort.js` + montering i drawer

Formbuilderen sender en POST til en webhook-URL ved submit.
URL'en sættes i formbuilderens admin-panel og bages ind i den publicerede HTML.

---

## Overblik over flow

```
Kunde udfylder bestilling.html
  → Submit → POST /api/webhooks/bestilling
    → Valider honeypot + påkrævede felter
    → Find eller opret kunde
    → Find eller opret firma (hvis firma-navn udfyldt)
    → Udtræk EAN fra faktura-info (hvis til stede)
    → Opret adresse (hvis levering)
    → Opret bon med status NY
    → Log til changelog
    → SSE broadcast bon_created
    → Returner 200 OK
Kunde ser "Tak for din bestilling"
```

---

## Feltmapping

Formbuilderen sender følgende felter (fra bestilling_v2.html):

| Formular-felt | Navn i POST-body | Mapper til |
|---------------|-----------------|------------|
| Ordertype | `ordertype` (hidden input, fallback `f1`) | `delivery_type` (`catering` → `delivery`, `pickup` → `pickup`) |
| Navn | `f2` | `customers.first_name` + `last_name` (split på mellemrum) |
| Email | `f3` | `customers.email` |
| Telefon | `f4` | `customers.phone` |
| Firma | `f5` | `companies.name` |
| Faktura info / EAN | `f12` | `bons.invoice_info` + udtræk 13-cifret EAN til `companies.ean` |
| Leveringsadresse | `validatedAddress` | `addresses`-tabel (objekt med postnr, by, lat, lon) |
| Dato | `f7_date` | `delivery_date` |
| Tid | `f7_time` | `delivery_time` |
| Antal personer | `f8` | `bons.pax` |
| Ønsker | `f9` | `bons.customer_wishes` |
| Kontaktperson navn | `f11_navn` | `bons.day_contact_name` |
| Kontaktperson tlf | `f11_tlf` | `bons.day_contact_phone` |
| Acceptér vilkår | `f10` | Checkbox — bruges ikke i webhook |
| Honeypot | `website` | Kassér hvis udfyldt |
| Tidsstempel | `submittedAt` | Log — bruges ikke til bon |

**Bemærk:** `validatedAddress` er et JSON-objekt bagt ind i POST-body af formularen:
```json
{
  "id": "0a3f50ab-...",
  "tekst": "Thorvaldsensvej 40, 1871 Frederiksberg",
  "postnr": "1871",
  "by": "Frederiksberg",
  "lat": 55.6789,
  "lon": 12.5234
}
```

---

## Trin 1 — `routes/webhooks.js` — ny fil

```js
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logChange, nextBonNumber, getStatusId } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

// POST /api/webhooks/bestilling
router.post('/bestilling', async (req, res) => {
  // Altid 200 retur til formular — fejl logges, vises ikke til kunden
  try {
    await handleBestilling(req.body);
  } catch (err) {
    console.error('[webhook/bestilling]', err);
  }
  res.json({ ok: true });
});

async function handleBestilling(data) {
  const db = getDb();

  // 1. Honeypot-tjek
  if (data.website) {
    console.log('[webhook] Honeypot triggered — ignoreret');
    return;
  }

  // 2. Påkrævede felter
  if (!data.f2 || !data.f7_date || !data.f7_time) {
    console.warn('[webhook] Mangler påkrævede felter:', { f2: data.f2, f7_date: data.f7_date });
    return;
  }

  // 3. Parse navn (f2 = "Fornavn Efternavn")
  const navnDele = (data.f2 || '').trim().split(/\s+/);
  const firstName = navnDele[0] || '';
  const lastName  = navnDele.slice(1).join(' ') || null;

  // 4. Find eller opret firma
  let companyId = null;
  if (data.f5?.trim()) {
    const existing = db.prepare(
      'SELECT id FROM companies WHERE name = ? AND is_active = 1 LIMIT 1'
    ).get(data.f5.trim());

    if (existing) {
      companyId = existing.id;
    } else {
      const res = db.prepare(
        'INSERT INTO companies (name, is_active) VALUES (?, 1)'
      ).run(data.f5.trim());
      companyId = res.lastInsertRowid;
    }
  }

  // 5. Udtræk EAN fra faktura-info
  // EAN-numre: 13 cifre, starter med 5
  const invoiceInfo = data.f10_ean || data.f9_ean || '';  // tjek faktisk felt-id
  const eanMatch = invoiceInfo.match(/\b5\d{12}\b/);
  const ean = eanMatch ? eanMatch[0] : null;

  // Gem EAN på firma hvis fundet og firma findes
  if (ean && companyId) {
    db.prepare('UPDATE companies SET ean = ? WHERE id = ? AND (ean IS NULL OR ean = "")')
      .run(ean, companyId);
  }

  // 6. Find eller opret kunde
  // Match på email (mest præcist) — fallback til navn + firma
  let customerId = null;
  if (data.f3?.trim()) {
    const existing = db.prepare(
      'SELECT id FROM customers WHERE email = ? AND is_active = 1 LIMIT 1'
    ).get(data.f3.trim());
    if (existing) customerId = existing.id;
  }

  if (!customerId) {
    const res = db.prepare(`
      INSERT INTO customers (first_name, last_name, email, phone, company_id, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(firstName, lastName, data.f3?.trim()||null, data.f4?.trim()||null, companyId);
    customerId = res.lastInsertRowid;
  }

  // 7. Opret adresse (hvis levering)
  const deliveryType = data.f1 === 'pickup' ? 'pickup' : 'delivery';
  let addressId = null;

  if (deliveryType === 'delivery' && data.validatedAddress) {
    const addr = typeof data.validatedAddress === 'string'
      ? JSON.parse(data.validatedAddress)
      : data.validatedAddress;

    if (addr?.tekst) {
      // Udtræk vejnavn og husnummer fra tekst (DAWA-format: "Vejnavn 42, postnr by")
      const vejMatch = addr.tekst.match(/^(.+?)\s+(\d+\S*),/);
      const streetName = vejMatch ? vejMatch[1] : addr.tekst;
      const streetNr   = vejMatch ? vejMatch[2] : null;

      const res = db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(streetName, streetNr, addr.postnr||null, addr.by||null,
             addr.lat||null, addr.lon||null);
      addressId = res.lastInsertRowid;
    }
  }

  // 8. Byg delivery_notes fra kontaktperson
  let deliveryNotes = null;
  if (data.f11_navn || data.f11_tlf) {
    const parts = [];
    if (data.f11_navn) parts.push(`Kontakt: ${data.f11_navn}`);
    if (data.f11_tlf)  parts.push(`Tlf: ${data.f11_tlf}`);
    deliveryNotes = parts.join(' · ');
  }

  // 9. Opret bon
  const statusId  = getStatusId('NY');
  const bonNumber = nextBonNumber();

  // Hent default location (HQ = id 1)
  const location = db.prepare("SELECT id FROM locations WHERE code = 'hq' LIMIT 1").get();
  const locationId = location?.id || 1;

  // Hent default priskategori
  const defaultCat = db.prepare(
    'SELECT id FROM price_categories WHERE code = ? LIMIT 1'
  ).get('catering');
  const priceCategoryId = defaultCat?.id || null;

  const bonRes = db.prepare(`
    INSERT INTO bons (
      bon_number, status_id, location_id,
      customer_id, company_id, price_category_id,
      order_date, delivery_date, delivery_time,
      delivery_type, delivery_address_id, delivery_notes,
      pax, customer_wishes, invoice_info,
      payment_type, created_at, updated_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      date('now'), ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      'invoice', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run(
    bonNumber, statusId, locationId,
    customerId, companyId, priceCategoryId,
    data.f7_date, data.f7_time,
    deliveryType, addressId, deliveryNotes,
    data.f8 ? parseInt(data.f8) : null,
    data.f9 || null,
    invoiceInfo || null
  );

  const bonId = bonRes.lastInsertRowid;

  // 10. Changelog
  logChange({
    entity_type: 'bon',
    entity_id: bonId,
    action: 'create',
    field_name: 'webhook',
    old_value: null,
    new_value: `Oprettet via bestillingsformular (${data.f3 || data.f2})`,
    user_id: null
  });

  // 11. SSE broadcast
  broadcast('bon_created', { id: bonId, bon_number: bonNumber });

  console.log(`[webhook] Bon #${bonNumber} oprettet (id=${bonId}, kunde=${firstName} ${lastName||''})`);
}

module.exports = router;
```

---

## Trin 2 — Mount i `server.js`

```js
app.use('/api/webhooks', require('./routes/webhooks'));
```

Monteres uden auth-middleware — formularen har ingen session.

---

## Trin 3 — Felt-ID'er verificeret ✅

Faktura/EAN-felt tilføjet som `f12` (textarea) i `tools/bestilling_v2.html`.
Kontaktperson mapper til `day_contact_name` / `day_contact_phone` (ikke delivery_notes).
Ordertype-felt hedder `ordertype` i FormData (hidden input), med fallback til `f1`.
`f10` er checkbox (acceptér vilkår) — bruges ikke i webhook.

---

## Trin 4 — Webhook URL i formbuilderen

Når endpointet er oppe:
1. Åbn formbuilder admin-panel
2. Indstillinger → Webhook URL: `https://bon.ristetrug.dk/api/webhooks/bestilling`
3. Aktiver webhook: ✅
4. Klik "Test webhook" — verificér 200 OK i response
5. Publicer ny HTML-fil → upload til ristetrug.dk/bestil

---

## Fejlhåndtering

Webhook returnerer **altid 200** til formularen — kunden skal aldrig se en fejl.

Fejl logges til konsollen med `[webhook/bestilling]`-præfix.
Overvej at tilføje til en `webhook_errors`-tabel på sigt (ikke Fase 1d).

**Kendte edge cases:**

| Situation | Håndtering |
|-----------|-----------|
| Honeypot udfyldt | Ignoreres silently |
| Manglende navn/dato | Logges, ignoreres |
| Ukendt firma | Oprettes som nyt firma |
| Eksisterende email | Genbruger eksisterende kunde (opdaterer ikke data) |
| Ingen adresse (pickup) | `delivery_address_id = null` — OK |
| Ingen EAN i faktura-felt | `companies.ean` ændres ikke |
| Dobbeltsend (kunden trykker to gange) | To bonner oprettes — acceptabelt, opdages let i listview |

---

## Del 2 — `shared/vare_picker.js` refaktorering

### Baggrund

`+`-pickeren er i dag bygget ind i `bon_kort.js` (Opgave 1 fra Fase 2).
Den skal trækkes ud som selvstændig komponent så både bon-kort og drawer
kan bruge den identisk.

### Arbejdsgang for Simon

**Trin A — Identificer picker-koden i `bon_kort.js`**

Find alt der vedrører:
- Åbn/luk `+`-knappen
- Kategori-kolonne (venstre)
- Vare-kolonne (højre) med priser
- Trin 2: inline expand med antal + special_request
- GEM / AFBRYD
- `POST /api/bons/:id/lines`

**Trin B — Flyt til `shared/vare_picker.js`**

```js
export class VarePicker {
  constructor({ bonId, priceCategory, container, onAdded }) {
    // bonId        — hvilken bon tilføjes til
    // priceCategory — bruges til at vise korrekt salgspris
    // container    — DOM-element picker renderes i
    // onAdded(line) — callback når linje er gemt succesfuldt
    this.bonId = bonId;
    this.priceCategory = priceCategory;
    this.container = container;
    this.onAdded = onAdded;
    this._visible = false;
  }

  toggle() { this._visible ? this.close() : this.open(); }
  open()   { this._visible = true;  this._render(); }
  close()  { this._visible = false; this.container.innerHTML = ''; }
}
```

**Trin C — Opdater `bon_kort.js`**

Erstat den interne picker-kode med:
```js
import { VarePicker } from '/shared/vare_picker.js';

// I createCard():
const picker = new VarePicker({
  bonId: data.id,
  priceCategory: data.price_category,
  container: card.querySelector('.vare-picker-slot'),
  onAdded: () => { /* SSE håndterer re-render */ }
});
card.querySelector('.btn-tilfoej').onclick = () => picker.toggle();
```

Tilføj `<div class="vare-picker-slot"></div>` i kort-skabelonen der hvor pickeren skal renderes.

**Trin D — Montér i `bon_drawer.js`**

```js
import { VarePicker } from '/shared/vare_picker.js';

// I _render():
const picker = new VarePicker({
  bonId: this.bonId,
  priceCategory: this.data.price_category,
  container: this.el.querySelector('.vare-picker-slot'),
  onAdded: () => this.load(this.bonId) // re-load drawer efter tilføjelse
});
this.el.querySelector('.btn-tilfoej-vare').onclick = () => picker.toggle();
```

### Vigtig regel

`VarePicker` kalder selv `POST /api/bons/:id/lines` — det er ikke drawerens ansvar.
Draweren lytter kun på `onAdded`-callbacket og re-loader data.

---

## Verifikation

```bash
# 1. Test webhook direkte
curl -X POST http://localhost:4321/api/webhooks/bestilling \
  -H "Content-Type: application/json" \
  -d '{
    "f1": "catering",
    "f2": "Lars Hansen",
    "f3": "lars@novo.dk",
    "f4": "12345678",
    "f5": "Novo Nordisk A/S",
    "f7_date": "2026-04-01",
    "f7_time": "11:30",
    "f8": "25",
    "f9": "Ingen svinekkød",
    "f11_navn": "Lars Hansen",
    "f11_tlf": "12345678",
    "validatedAddress": {
      "tekst": "Thorvaldsensvej 40, 1871 Frederiksberg",
      "postnr": "1871",
      "by": "Frederiksberg",
      "lat": 55.6789,
      "lon": 12.5234
    },
    "submittedAt": "2026-03-14T10:00:00.000Z"
  }'
# Forventet: {"ok":true}

# 2. Bon oprettet?
curl -b cookies.txt http://localhost:4321/api/bons?q=lars
# Forventet: bon med kunde Lars Hansen, status NY

# 3. Adresse gemt?
curl -b cookies.txt http://localhost:4321/api/bons/N
# Forventet: delivery_address_id sat, delivery_type = 'delivery'

# 4. Honeypot virker?
curl -X POST http://localhost:4321/api/webhooks/bestilling \
  -H "Content-Type: application/json" \
  -d '{"website":"spam","f2":"Bot","f7_date":"2026-04-01","f7_time":"11:00"}'
# Forventet: {"ok":true} men INGEN bon oprettet

# 5. EAN udtræk
curl -X POST http://localhost:4321/api/webhooks/bestilling \
  -H "Content-Type: application/json" \
  -d '{"f2":"Test","f7_date":"2026-04-02","f7_time":"12:00","f5":"KU","FAKTISK_EAN_FELT":"EAN: 5798000420526"}'
# Forventet: companies.ean = '5798000420526'
```

**Manuel test:**
- Udfyld bestilling_v2.html i browser med webhook-URL sat
- Verificér bon oprettes i office listview med SSE-opdatering
- Tjek at kontaktperson-info er i `delivery_notes`
- Tjek at EAN er trukket ud på firma

---

## Checkliste

- [ ] `routes/webhooks.js` oprettet
- [ ] `/api/webhooks` mountet i `server.js` (uden auth)
- [ ] Faktisk felt-ID for EAN/faktura verificeret og opdateret i koden
- [ ] Webhook-URL sat i formbuilder + webhook aktiveret
- [ ] "Test webhook" i formbuilder returnerer 200
- [ ] Ny HTML publiceret til ristetrug.dk/bestil
- [ ] Alle 5 curl-kommandoer giver forventet output
- [ ] Manuel test fra browser OK
- [ ] Dobbeltsend testet — to bonner oprettes, ingen fejl

VarePicker refaktorering:
- [ ] Picker-kode identificeret og trukket ud af bon_kort.js
- [ ] shared/vare_picker.js oprettet med VarePicker-klasse
- [ ] bon_kort.js opdateret til at bruge VarePicker
- [ ] bon_drawer.js monterer VarePicker via .btn-tilfoej-vare
- [ ] Picker virker identisk i kort og drawer
- [ ] onAdded-callback re-loader drawer korrekt
