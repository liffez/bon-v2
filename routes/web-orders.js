/**
 * Web Orders — webhook + API for bestillinger fra hjemmesiden
 *
 * POST /webhook/bestilling     — modtager formular-data, opretter bon + web_order, sender bekræftelsesmail
 * GET  /api/web-orders         — liste over web-bestillinger (til fremtidigt indbakke-UI)
 */

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { logChange, nextBonNumber, getStatusId } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

// ─── POST /webhook/bestilling ──────────────────────────────────────────────
// Offentligt endpoint — ingen auth, altid 200 (fejl logges, vises ikke til kunden)

router.post('/bestilling', async (req, res) => {
  try {
    // Optionel secret-validering
    const db = getDb();
    const secretRow = db.prepare("SELECT value FROM settings WHERE key = 'webhook_secret'").get();
    const secret = secretRow?.value;

    if (secret && secret.length > 0) {
      const provided = req.headers['x-webhook-secret'];
      if (provided !== secret) {
        console.warn('[web-order] Forkert webhook secret');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const result = await handleWebOrder(req.body);
    res.json({ ok: true, bon_number: result?.bonNumber || null });
  } catch (err) {
    console.error('[web-order] Fejl:', err);
    res.json({ ok: true }); // Altid 200 til klienten
  }
});

// ─── GET /api/web-orders ───────────────────────────────────────────────────

router.get('/', (req, res) => {
  const db = getDb();
  const status = req.query.status || null;

  let sql = `SELECT wo.*, b.bon_number
             FROM web_orders wo
             LEFT JOIN bons b ON wo.bon_id = b.id`;
  const args = [];

  if (status) {
    sql += ' WHERE wo.status = ?';
    args.push(status);
  }

  sql += ' ORDER BY wo.created_at DESC LIMIT 100';

  const rows = db.prepare(sql).all(...args);
  res.json(rows);
});

// ─── GET /api/web-orders/pending ───────────────────────────────────────────
// Alle web-order bons der endnu ikke er bekræftet, uanset delivery_date eller
// status. Bruges af dashboard-alert (#041) og dedikeret "Nye bestillinger"-
// side (#042). Returnerer rig payload så frontend kan vise nok info til at
// vurdere uden at åbne drawer.

router.get('/pending', (req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      b.id              AS bon_id,
      b.bon_number,
      b.delivery_date,
      b.delivery_time,
      b.delivery_type,
      b.pax,
      b.customer_wishes,
      b.delivery_notes,
      b.created_at,
      sd.code           AS status_code,
      sd.label          AS status_label,
      sd.color          AS status_color,
      COALESCE(NULLIF(TRIM(c.first_name || ' ' || COALESCE(c.last_name, '')), ''), '(uden navn)') AS customer_name,
      c.email           AS customer_email,
      c.phone           AS customer_phone,
      co.name           AS company_name,
      a.street_name || COALESCE(' ' || a.street_nr, '') AS address_text,
      a.postal_code,
      a.city,
      wo.id             AS web_order_id,
      wo.order_type,
      wo.ean_info
    FROM bons b
    JOIN web_orders wo          ON wo.bon_id = b.id
    JOIN status_definitions sd  ON b.status_id = sd.id
    LEFT JOIN customers c       ON b.customer_id = c.id
    LEFT JOIN companies co      ON b.company_id = co.id
    LEFT JOIN addresses a       ON b.delivery_address_id = a.id
    WHERE b.acknowledged_at IS NULL
    ORDER BY b.created_at DESC
    LIMIT 200
  `).all();

  res.json(rows);
});

// ─── HANDLER ───────────────────────────────────────────────────────────────

// Sandwichvalg-koder → labels (vises i customer_wishes)
const SANDWICH_LABELS = {
  rr_blander: 'Køkkenet blander',
  'rr_vælger': 'Køkkenet blander',  // bagudkompatibel med eksisterende formular
  eget_valg:   'Eget valg'
};

function buildCustomerWishes(data) {
  // Saml sandwichvalg + wishes + _form_meta-marker
  const parts = [];

  if (data.sandwichvalg && SANDWICH_LABELS[data.sandwichvalg]) {
    parts.push(`Sandwichvalg: ${SANDWICH_LABELS[data.sandwichvalg]}`);
  }

  if (data.wishes?.trim()) {
    parts.push(data.wishes.trim());
  }

  // Form-meta som audit-spor (kort markering nederst)
  const meta = data._form_meta;
  if (meta?.menu_id && meta?.menu_version) {
    parts.push(`[Form: ${meta.menu_id} v${meta.menu_version}]`);
  } else if (meta?.form_version) {
    parts.push(`[Form: ${meta.form_version}]`);
  }

  return parts.length ? parts.join('\n\n') : null;
}

async function handleWebOrder(data) {
  const db = getDb();

  // 1. Honeypot
  if (data.website) {
    console.log('[web-order] Honeypot triggered — ignoreret');
    return null;
  }

  // 2. Påkrævede felter
  if (!data.first_name || !data.delivery_date || !data.delivery_time) {
    console.warn('[web-order] Mangler påkrævede felter:', {
      first_name: data.first_name, delivery_date: data.delivery_date, delivery_time: data.delivery_time
    });
    return null;
  }

  // 3. Parse navn
  const firstName = (data.first_name || '').trim();
  const lastName  = (data.last_name || '').trim() || null;
  const fullName  = [firstName, lastName].filter(Boolean).join(' ');

  // 4. Find eller opret firma
  let companyId = null;
  if (data.company?.trim()) {
    const existing = db.prepare(
      'SELECT id FROM companies WHERE name = ? AND is_active = 1 LIMIT 1'
    ).get(data.company.trim());

    if (existing) {
      companyId = existing.id;
    } else {
      const res = db.prepare(
        'INSERT INTO companies (name, is_active) VALUES (?, 1)'
      ).run(data.company.trim());
      companyId = Number(res.lastInsertRowid);
    }
  }

  // 5. EAN fra faktura-info
  const eanInfo = data.ean_info || '';
  const eanMatch = eanInfo.match(/\b\d{13}\b/);
  const ean = eanMatch ? eanMatch[0] : null;

  if (ean && companyId) {
    db.prepare("UPDATE companies SET ean = ? WHERE id = ? AND (ean IS NULL OR ean = '')")
      .run(ean, companyId);
  }

  // 6. Find eller opret kunde (match på email)
  let customerId = null;
  if (data.email?.trim()) {
    const existing = db.prepare(
      'SELECT id FROM customers WHERE email = ? AND is_active = 1 LIMIT 1'
    ).get(data.email.trim());
    if (existing) customerId = existing.id;
  }

  if (!customerId) {
    const res = db.prepare(`
      INSERT INTO customers (first_name, last_name, email, phone, company_id, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(firstName, lastName, data.email?.trim() || null, data.phone?.trim() || null, companyId);
    customerId = Number(res.lastInsertRowid);
  }

  // 7. Opret adresse (kun catering/levering)
  const orderType = data.ordertype || 'catering';
  const deliveryType = orderType === 'pickup' ? 'pickup' : 'delivery';
  let addressId = null;

  if (deliveryType === 'delivery' && data.validatedAddress) {
    const addr = typeof data.validatedAddress === 'string'
      ? JSON.parse(data.validatedAddress)
      : data.validatedAddress;

    if (addr?.tekst) {
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

  const location = db.prepare("SELECT id FROM locations WHERE code = 'hq' LIMIT 1").get();
  const locationId = location?.id || 1;

  const defaultCat = db.prepare(
    "SELECT id FROM price_categories WHERE code = 'catering' LIMIT 1"
  ).get();
  const priceCategoryId = defaultCat?.id || null;

  const pax = data.pax ? parseInt(data.pax) : null;
  const customerWishes = buildCustomerWishes(data);

  // Saml leverings-info: extra-tekst (etage/indgang) gemmes i delivery_notes
  const deliveryNotes = data.delivery_extra?.trim() || null;

  const bonRes = db.prepare(`
    INSERT INTO bons (
      bon_number, status_id, location_id,
      customer_id, company_id, price_category_id,
      order_date, delivery_date, delivery_time,
      delivery_type, delivery_address_id,
      pax, customer_wishes, invoice_info,
      day_contact_name, day_contact_phone,
      delivery_notes,
      payment_type, created_at, updated_at
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      date('now'), ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?,
      ?,
      'invoice', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `).run(
    bonNumber, statusId, locationId,
    customerId, companyId, priceCategoryId,
    data.delivery_date, data.delivery_time,
    deliveryType, addressId,
    pax,
    customerWishes,
    eanInfo || null,
    data.contact_person || null,
    data.contact_phone || null,
    deliveryNotes
  );

  const bonId = Number(bonRes.lastInsertRowid);

  // 9. Gem i web_orders
  const addr = data.validatedAddress || {};
  db.prepare(`
    INSERT INTO web_orders (
      order_type, customer_name, customer_email, customer_phone,
      company, delivery_date, delivery_time,
      address_text, address_lat, address_lon, address_postnr,
      pax, wishes, ean_info, raw_data, bon_id, status
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'konverteret')
  `).run(
    orderType,
    fullName,
    data.email?.trim() || null,
    data.phone?.trim() || null,
    data.company?.trim() || null,
    data.delivery_date || null,
    data.delivery_time || null,
    addr.tekst || data.address_text || null,
    addr.lat || null,
    addr.lon || null,
    addr.postnr || null,
    pax,
    data.wishes || null,
    eanInfo || null,
    JSON.stringify(data),
    bonId
  );

  // 10. Changelog
  logChange({
    entityType: 'bon',
    entityId: bonId,
    action: 'create',
    fieldName: 'web_order',
    oldValue: null,
    newValue: `Oprettet via web-bestilling (${data.email || fullName})`,
    userId: null
  });

  // 11. SSE broadcast
  broadcast('bon_created', { id: bonId, bon_number: bonNumber, source: 'web_order' });

  // 12. Send bekræftelsesmail til kunden + intern notifikation til ejer
  //     (fire-and-forget — blokerer ikke response)
  const dagnavne = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
  const maaneder = ['januar','februar','marts','april','maj','juni','juli','august','september','oktober','november','december'];
  const d = new Date(data.delivery_date + 'T12:00:00');
  const pænDato = `${dagnavne[d.getDay()]} d. ${d.getDate()}. ${maaneder[d.getMonth()]} ${d.getFullYear()}`;

  const adresseBlok = deliveryType === 'delivery' && (addr.tekst || data.address_text)
    ? `Leveringsadresse: ${addr.tekst || data.address_text}`
    : deliveryType === 'pickup'
      ? 'Afhentning: Prinsesse Charlottesgade 16, 2200 København N'
      : '';

  const oenskerBlok = data.wishes?.trim()
    ? `Dine ønsker: ${data.wishes.trim()}`
    : '';

  const { sendFromTemplate } = require('../services/mailService');
  const bonContext = { type: 'bon', number: parseInt(bonNumber.replace(/\D/g, '')) };

  // 12a. Kundens bekræftelse
  if (data.email?.trim()) {
    sendFromTemplate({
      templateKey: 'web_order_confirmation',
      to: data.email.trim(),
      context: bonContext,
      vars: {
        kundeNavn: fullName,
        bonNummer: bonNumber,
        ordreType: orderType === 'pickup' ? 'Afhentning' : 'Levering',
        leveringsDato: pænDato,
        leveringsTid: data.delivery_time,
        pax: String(pax || '?'),
        adresseBlok,
        oenskerBlok
      },
      bonId
    }).then(() => {
      console.log(`[web-order] Bekræftelsesmail sendt til ${data.email.trim()} for bon #${bonNumber}`);
    }).catch(mailErr => {
      console.error('[web-order] Kunne ikke sende bekræftelsesmail:', mailErr.message);
    });
  }

  // 12b. Intern notifikation til ejer (#043)
  const ownerEmail = db.prepare("SELECT value FROM settings WHERE key = 'web_order_notification_email'").get()?.value?.trim();
  if (ownerEmail) {
    const baseUrl = (db.prepare("SELECT value FROM settings WHERE key = 'booking_public_url_base'").get()?.value || '').replace(/\/+$/, '');
    const drawerLink = baseUrl ? `${baseUrl}/office/?bon=${bonId}` : `Bon-id: ${bonId}`;
    const firmaBlok = data.company?.trim() ? `Firma: ${data.company.trim()}` : '';
    const ownerOenskerBlok = data.wishes?.trim() ? `Ønsker:\n${data.wishes.trim()}` : '(Ingen ønsker)';

    sendFromTemplate({
      templateKey: 'web_order_owner_notification',
      to: ownerEmail,
      context: bonContext,
      vars: {
        bonNummer: bonNumber,
        kundeNavn: fullName,
        kundeEmail: data.email?.trim() || '(ingen)',
        kundeTlf: data.phone?.trim() || '(ingen)',
        firmaBlok,
        ordreType: orderType === 'pickup' ? 'Afhentning' : 'Levering',
        leveringsDato: pænDato,
        leveringsTid: data.delivery_time,
        pax: String(pax || '?'),
        adresseBlok,
        oenskerBlok: ownerOenskerBlok,
        drawerLink
      },
      bonId
    }).then(() => {
      console.log(`[web-order] Ejer-notifikation sendt til ${ownerEmail} for bon #${bonNumber}`);
    }).catch(mailErr => {
      console.error('[web-order] Kunne ikke sende ejer-notifikation:', mailErr.message);
    });
  }

  console.log(`[web-order] Bon #${bonNumber} oprettet (id=${bonId}, kunde=${fullName})`);
  return { bonId, bonNumber };
}

module.exports = router;
