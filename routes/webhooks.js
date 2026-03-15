const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logChange, nextBonNumber, getStatusId } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

// Default formular-felt → bon-felt mapping (bruges i Settings UI til nulstilling)
const DEFAULT_FIELD_MAP = {
    f2: 'customer_name',
    f3: 'customer_email',
    f4: 'customer_phone',
    f5: 'company_name',
    f7_date: 'delivery_date',
    f7_time: 'delivery_time',
    f8: 'pax',
    f9: 'customer_wishes',
    f11_navn: 'day_contact_name',
    f11_tlf: 'day_contact_phone',
    f12: 'invoice_info'
};

// POST /api/webhooks/bestilling
// Altid 200 retur — fejl logges, vises ikke til kunden
router.post('/bestilling', async (req, res) => {
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
    console.warn('[webhook] Mangler påkrævede felter:', {
      f2: data.f2, f7_date: data.f7_date, f7_time: data.f7_time
    });
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
      companyId = Number(res.lastInsertRowid);
    }
  }

  // 5. Udtræk EAN fra faktura-info (13 cifre)
  const invoiceInfo = data.f12 || '';
  const eanMatch = invoiceInfo.match(/\b\d{13}\b/);
  const ean = eanMatch ? eanMatch[0] : null;

  // Gem EAN på firma hvis fundet og firma findes
  if (ean && companyId) {
    db.prepare("UPDATE companies SET ean = ? WHERE id = ? AND (ean IS NULL OR ean = '')")
      .run(ean, companyId);
  }

  // 6. Find eller opret kunde
  // Match på email (mest præcist)
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
    `).run(firstName, lastName, data.f3?.trim() || null, data.f4?.trim() || null, companyId);
    customerId = Number(res.lastInsertRowid);
  }

  // 7. Opret adresse (hvis levering)
  const orderType = data.ordertype || data.f1 || 'catering';
  const deliveryType = orderType === 'pickup' ? 'pickup' : 'delivery';
  let addressId = null;

  if (deliveryType === 'delivery' && data.validatedAddress) {
    const addr = typeof data.validatedAddress === 'string'
      ? JSON.parse(data.validatedAddress)
      : data.validatedAddress;

    if (addr?.tekst) {
      // Udtræk vejnavn og husnummer fra DAWA-format: "Vejnavn 42, postnr by"
      const vejMatch = addr.tekst.match(/^(.+?)\s+(\d+\S*),/);
      const streetName = vejMatch ? vejMatch[1] : addr.tekst.split(',')[0];
      const streetNr   = vejMatch ? vejMatch[2] : null;

      const res = db.prepare(`
        INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(streetName, streetNr, addr.postnr || null, addr.by || null,
             addr.lat || null, addr.lon || null);
      addressId = Number(res.lastInsertRowid);
    }
  }

  // 8. Opret bon
  const statusId  = getStatusId('NY');
  const bonNumber = nextBonNumber();

  // Default location (HQ)
  const location = db.prepare("SELECT id FROM locations WHERE code = 'hq' LIMIT 1").get();
  const locationId = location?.id || 1;

  // Default priskategori (catering)
  const defaultCat = db.prepare(
    "SELECT id FROM price_categories WHERE code = 'catering' LIMIT 1"
  ).get();
  const priceCategoryId = defaultCat?.id || null;

  const bonRes = db.prepare(`
    INSERT INTO bons (
      bon_number, status_id, location_id,
      customer_id, company_id, price_category_id,
      order_date, delivery_date, delivery_time,
      delivery_type, delivery_address_id,
      pax, customer_wishes, invoice_info,
      day_contact_name, day_contact_phone,
      payment_type, created_at, updated_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      date('now'), ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      'invoice', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run(
    bonNumber, statusId, locationId,
    customerId, companyId, priceCategoryId,
    data.f7_date, data.f7_time,
    deliveryType, addressId,
    data.f8 ? parseInt(data.f8) : null,
    data.f9 || null,
    invoiceInfo || null,
    data.f11_navn || null,
    data.f11_tlf || null
  );

  const bonId = Number(bonRes.lastInsertRowid);

  // 9. Changelog
  logChange({
    entityType: 'bon',
    entityId: bonId,
    action: 'create',
    fieldName: 'webhook',
    oldValue: null,
    newValue: `Oprettet via bestillingsformular (${data.f3 || data.f2})`,
    userId: null
  });

  // 10. SSE broadcast
  broadcast('bon_created', { id: bonId, bon_number: bonNumber });

  console.log(`[webhook] Bon #${bonNumber} oprettet (id=${bonId}, kunde=${firstName} ${lastName || ''})`);
}

module.exports = router;
module.exports.DEFAULT_FIELD_MAP = DEFAULT_FIELD_MAP;
