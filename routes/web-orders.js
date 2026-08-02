/**
 * Web Orders — webhook + API for bestillinger fra hjemmesiden
 *
 * POST /webhook/bestilling     — modtager formular-data, opretter bon + web_order, sender bekræftelsesmail
 * GET  /api/web-orders         — liste over web-bestillinger (til fremtidigt indbakke-UI)
 */

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { createBon } = require('../db/helpers');

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

// Er en ISO-leveringsdato (YYYY-MM-DD) inden for en ferielukket periode?
// Læser bestilling.closed_dates ([{from,to,label}]); ISO-datoer sammenlignes
// leksikografisk (from <= dato <= to). Tåler tom/ugyldig JSON gracefully.
function isClosedDate(db, isoDate) {
  if (!isoDate) return false;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'bestilling.closed_dates'").get();
  if (!row?.value) return false;
  let ranges;
  try { ranges = JSON.parse(row.value); } catch (e) { return false; }
  if (!Array.isArray(ranges)) return false;
  return ranges.some(r => {
    const from = String(r.from || r.to || '').trim();
    const to   = String(r.to || r.from || '').trim();
    return from && to && isoDate >= from && isoDate <= to;
  });
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

  // 2b. Ferielukket — server-guard (formen spærrer allerede, men et direkte
  // API-kald skal ikke kunne snige en bestilling ind i en lukket periode).
  if (isClosedDate(db, data.delivery_date)) {
    console.warn('[web-order] Afvist — leveringsdato i ferielukket periode:', data.delivery_date);
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

  // 8. Opret bon (fælles helper — #237)
  const pax = data.pax ? parseInt(data.pax) : null;
  const customerWishes = buildCustomerWishes(data);

  // Saml leverings-info: extra-tekst (etage/indgang) gemmes i delivery_notes
  const deliveryNotes = data.delivery_extra?.trim() || null;

  const { bonId, bonNumber } = createBon({
    customer_id: customerId,
    company_id: companyId,
    delivery_date: data.delivery_date,
    delivery_time: data.delivery_time,
    delivery_type: deliveryType,
    delivery_address_id: addressId,
    pax,
    customer_wishes: customerWishes,
    invoice_info: eanInfo || null,
    day_contact_name: data.contact_person || null,
    day_contact_phone: data.contact_phone || null,
    delivery_notes: deliveryNotes,
    changelog_field: 'web_order',
    changelog_message: `Oprettet via web-bestilling (${data.email || fullName})`,
    broadcast_extra: { source: 'web_order' },
  });

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

  // 9b. Auto-generér bon-linjer fra kundens menu-valg (#382).
  //     Best-effort: en Grocy-fejl må ALDRIG vælte selve bestillingen — bonen er
  //     allerede oprettet. Linjerne er et startpunkt office retter/prissætter.
  try {
    await generateLinesFromMenuItems(db, bonId, data);
  } catch (lineErr) {
    console.error(`[web-order] Kunne ikke auto-generere linjer for bon #${bonNumber}:`, lineErr.message);
  }

  // 10. Send bekræftelsesmail til kunden + intern notifikation til ejer
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
      bonId,
      isSystem: true   // auto-bekræftelse → afsluttet, ikke "afventer kunde"
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
      bonId,
      isSystem: true   // intern auto-notifikation → ikke "afventer kunde"
    }).then(() => {
      console.log(`[web-order] Ejer-notifikation sendt til ${ownerEmail} for bon #${bonNumber}`);
    }).catch(mailErr => {
      console.error('[web-order] Kunne ikke sende ejer-notifikation:', mailErr.message);
    });
  }

  console.log(`[web-order] Bon #${bonNumber} oprettet (id=${bonId}, kunde=${fullName})`);
  return { bonId, bonNumber };
}

// ─── Auto-generér bon-linjer fra kundens menu-valg (#382) ────────────────────
// Kaldes fra handleWebOrder inde i en try/catch — må aldrig kaste videre.
async function generateLinesFromMenuItems(db, bonId, data) {
  const items = Array.isArray(data.menu_items)
    ? data.menu_items.filter(i => i && Number(i.count) > 0)
    : [];
  if (!items.length) return;

  const grocyAdapter = require('../services/grocyAdapter');
  const { resolveMenuItemLines } = require('../services/menuItemsToLines');
  const { recalcBonTotalUnits, recalcBonTotal, logChange } = require('../db/helpers');
  const { broadcast } = require('../shared/sse');

  // Bonens priskategori — festival-events rammer festival-prisen, ellers catering.
  const pcRow = db.prepare(`
    SELECT pc.code FROM bons b JOIN price_categories pc ON b.price_category_id = pc.id WHERE b.id = ?
  `).get(bonId);
  const priceCategory = pcRow?.code || 'catering';

  // Grocy-opskrifter til pris/kostpris/CO₂-snapshot (getRecipes har egen cache).
  const recipes = await grocyAdapter.getRecipes();
  const recipesById = new Map(recipes.map(r => [r.id, r]));

  // Menu-navne som fallback for ikke-Grocy-koblede items (sjældent i drift, hvor
  // menuen er importeret fra Grocy og id'erne er r<recipe_id>).
  const menuItemsById = new Map();
  try {
    const menuId = (data._form_meta && data._form_meta.menu_id) || 'standard';
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`bestilling.menu_${menuId}`);
    if (row) {
      const menu = JSON.parse(row.value);
      for (const it of (menu.items || [])) {
        menuItemsById.set(String(it.id), { name: it.name, category: it.category });
      }
    }
  } catch (_) { /* fallback-navne er valgfrie */ }

  const { lines, unmatched } = resolveMenuItemLines({ menuItems: items, recipesById, menuItemsById, priceCategory });
  if (unmatched.length) {
    console.warn(`[web-order] ${unmatched.length} menu-item(s) uden kobling på bon ${bonId}:`, unmatched);
  }
  if (!lines.length) return;

  const insert = db.prepare(`
    INSERT INTO bon_lines (bon_id, grocy_recipe_id, product_name, category, quantity, unit,
        cost_price, unit_price, line_total, sort_order, is_accessory, special_request, co2e, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let sort = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS mx FROM bon_lines WHERE bon_id = ?`).get(bonId).mx;
  for (const l of lines) {
    const lineTotal = (l.unit_price != null && l.quantity) ? l.quantity * l.unit_price : null;
    insert.run(
      bonId, l.grocy_recipe_id, l.product_name, l.category, l.quantity, l.unit,
      l.cost_price, l.unit_price, lineTotal, ++sort, 0, null, l.co2e, null
    );
  }

  // Server-autoritativ recalc (samme helpers som POST /:id/lines)
  recalcBonTotalUnits(db, bonId);
  recalcBonTotal(db, bonId, { logIfChanged: false });

  logChange({
    entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines',
    newValue: `${lines.length} linje(r) auto-genereret fra web-bestilling`,
    notes: 'Kundens menu-valg',
  });
  broadcast('bon_updated', { id: bonId });

  console.log(`[web-order] Auto-genererede ${lines.length} linje(r) på bon ${bonId} (priskategori=${priceCategory})`);
}

module.exports = router;
// Eksponeret til integrationstest (#382) — ikke del af det offentlige API.
module.exports._generateLinesFromMenuItems = generateLinesFromMenuItems;
