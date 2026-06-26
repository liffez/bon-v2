const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logChange, nextBonNumber, getStatusId } = require('../db/helpers');
const { broadcast } = require('../shared/sse');
const { verifyLoboRequest, applyWebhookEvent, calibrateLoboSignature } = require('../services/lobo_webhook');

// ==========================================
// POST/GET /api/webhooks/lobo  (Byekspressen status-events)
// System-til-system (ingen session). SELVKALIBRERENDE HMAC: indtil formatet er
// opdaget brute-forcer vi det første callback mod de gemte per-event-nøgler;
// ved match gemmes formatet + verifikation slås til automatisk. Indtil da
// accepteres events (verify=0) så intet tabes — trin 3-pollingen dækker status.
// Svarer ALTID 200 så Lobo ikke re-køer ved vores fejl.
// ==========================================
router.all('/lobo', async (req, res) => {
    try {
        const db = getDb();
        const rawQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
        const query = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
        const event = query.event;

        const get = (k) => { const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
        const setS = (k, v) => db.prepare(
            `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).run(k, String(v));

        const parts = {
            rawQuery,
            pathQuery: req.originalUrl,
            registeredUrl: get('lobo_webhook_url') || '',
            body: typeof req.body === 'string' ? req.body
                : (req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : ''),
        };
        const algorithm = get('lobo_webhook_algorithm') || 'sha256';
        const keysJson = get('lobo_webhook_keys');

        // ── Selvkalibrering: opdag formatet fra første callback ──
        if ((get('lobo_webhook_verify') || '0') !== '1' && keysJson) {
            try {
                const keys = JSON.parse(keysJson) || {};
                const hit = calibrateLoboSignature({ parts, headers: req.headers, keys, algorithm });
                if (hit) {
                    setS('lobo_webhook_sig_header', hit.sig_header);
                    setS('lobo_webhook_sign_target', hit.sign_target);
                    setS('lobo_webhook_verify', '1');
                    console.warn(`[webhook/lobo] ✓ HMAC AUTO-KALIBRERET: header='${hit.sig_header}', signeret='${hit.sign_target}' (match via event ${hit.matched_event}). Verifikation slået TIL.`);
                } else {
                    console.warn('[webhook/lobo] kalibrering: intet HMAC-match endnu — callback accepteret, format stadig ukendt.');
                }
            } catch (e) { console.warn('[webhook/lobo] kalibrering fejlede:', e.message); }
        }

        // ── Verificér (kun aktivt når kalibreret) ──
        const v = verifyLoboRequest({
            parts, headers: req.headers, event,
            settings: {
                verify: get('lobo_webhook_verify') || '0',
                sig_header: get('lobo_webhook_sig_header'),
                sign_target: get('lobo_webhook_sign_target'),
                keys: keysJson,
                hmac_key: get('lobo_webhook_hmac_key'),
                algorithm,
            },
        });
        if (!v.ok) { console.warn('[webhook/lobo] afvist:', v.reason); return res.json({ ok: false }); }
        if (v.skipped) console.warn('[webhook/lobo] HMAC-verifikation sprunget over (afventer kalibrering)');

        // getOrder til stopvisitedorsigned-disambiguering (lazy — kun hvis nødvendigt)
        let getOrder = null;
        if (event === 'stopvisitedorsigned') {
            try { getOrder = require('../services/byExpressenAdapter').getByExpressenAdapter().getOrder; }
            catch (e) { console.warn('[webhook/lobo] kunne ikke bygge adapter til getOrder:', e.message); }
        }

        const result = await applyWebhookEvent({ query, db, broadcast, getOrder });
        if (!result.ok) console.warn('[webhook/lobo] ikke anvendt:', result.reason);
    } catch (err) {
        console.error('[webhook/lobo]', err);
    }
    res.json({ ok: true });
});

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
