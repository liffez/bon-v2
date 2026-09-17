const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { createBon, todayISO } = require('../db/helpers');
const { checkOrderTiming } = require('../services/orderCutoff');
const { resolveOrderCompany, appendWishesLine } = require('../services/orderCompanyResolver');
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
// Den GAMLE f-felt-formular. Uventede fejl logges og giver 200 som hidtil, men
// en bevidst afvisning (deadline passeret) siges højt — ellers ville en
// afsender tro bestillingen var modtaget.
router.post('/bestilling', async (req, res) => {
  try {
    const result = await handleBestilling(req.body);
    if (result?.rejected) {
      console.warn(`[webhook/bestilling] Afvist (${result.rejected}): ${result.message}`);
      return res.status(409).json({ ok: false, code: result.rejected, message: result.message });
    }
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

  // 2b. Deadline — samme regel som den nuværende formular håndhæves med
  // (services/orderCutoff). Fejler ÅBENT: kan deadline ikke beregnes, slipper
  // bestillingen igennem.
  const timing = checkOrderTiming(db, data.f7_date, { todayIso: todayISO() });
  if (!timing.ok) {
    return { rejected: timing.code, message: timing.message };
  }

  // 3. Parse navn (f2 = "Fornavn Efternavn")
  const navnDele = (data.f2 || '').trim().split(/\s+/);
  const firstName = navnDele[0] || '';
  const lastName  = navnDele.slice(1).join(' ') || null;

  // 4. Find bestilleren på email (før firmaet — reglen skal vide hvem der
  //    bestiller, så bestillerens eget firma kan beholdes)
  const emailTrimmed = data.f3?.trim() || '';
  const existingCustomer = emailTrimmed
    ? db.prepare('SELECT id, company_id FROM customers WHERE email = ? AND is_active = 1 LIMIT 1')
        .get(emailTrimmed) || null
    : null;

  // 5. Firma — samme delte regel som routes/web-orders.js (#567 + #607):
  //    forhandler → bestillerens eget firma → matcher (CVR → EAN → e-mail →
  //    navnelighed) → nyt firma. HTML-entiteter afkodes i resolveren.
  const invoiceInfo = data.f12 || '';
  const resolved = resolveOrderCompany(db, {
    typedName: data.f5,
    email: emailTrimmed,
    invoiceInfo,
    existingCustomer,
  });
  const companyId = resolved.companyId;
  const ean = resolved.ean;

  // Gem EAN på firma hvis fundet og firma findes — ikke på en forhandler, dér
  // hører EAN'et til slutkunden.
  if (ean && companyId && !resolved.reseller) {
    db.prepare("UPDATE companies SET ean = ? WHERE id = ? AND (ean IS NULL OR ean = '')")
      .run(ean, companyId);
  }

  // 6. Opret kunde hvis vi ikke kendte bestilleren
  let customerId = existingCustomer?.id || null;

  if (!customerId) {
    const res = db.prepare(`
      INSERT INTO customers (first_name, last_name, email, phone, company_id, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(firstName, lastName, emailTrimmed || null, data.f4?.trim() || null, companyId);
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

  // 8. Opret bon (fælles helper — #237)
  const { bonId, bonNumber } = createBon({
    customer_id: customerId,
    company_id: companyId,
    delivery_date: data.f7_date,
    delivery_time: data.f7_time,
    delivery_type: deliveryType,
    delivery_address_id: addressId,
    pax: data.f8 ? parseInt(data.f8) : null,
    customer_wishes: appendWishesLine(data.f9 || null, resolved.wishesLine),
    invoice_info: invoiceInfo || null,
    day_contact_name: data.f11_navn || null,
    day_contact_phone: data.f11_tlf || null,
    end_customer_name: resolved.endCustomerName,
    changelog_field: 'webhook',
    changelog_message: `Oprettet via bestillingsformular (${data.f3 || data.f2})` +
      (resolved.note ? ` — ${resolved.note}` : ''),
  });

  console.log(`[webhook] Bon #${bonNumber} oprettet (id=${bonId}, kunde=${firstName} ${lastName || ''})`);
}

module.exports = router;
module.exports.DEFAULT_FIELD_MAP = DEFAULT_FIELD_MAP;
