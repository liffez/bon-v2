/**
 * Web Orders — webhook + API for bestillinger fra hjemmesiden
 *
 * POST /webhook/bestilling     — modtager formular-data, opretter bon + web_order, sender bekræftelsesmail
 * GET  /api/web-orders         — liste over web-bestillinger (til fremtidigt indbakke-UI)
 */

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db/database');
const { createBon, todayISO } = require('../db/helpers');
const { checkOrderTiming, isValidDeliveryDate, isValidDeliveryTime } = require('../services/orderCutoff');
const { transaction } = require('../db/compat');
const { requireAuth } = require('../shared/auth');
const { resolveOrderCompany, appendWishesLine } = require('../services/orderCompanyResolver');

// En afvisning kunden SKAL have at vide. Webhooken svarede historisk 200 uanset
// hvad, så en ordre der blev afvist (ferielukket, for sent) gav kunden
// "tak for din bestilling" mens intet blev oprettet. For en bestilling er det
// den værste af alle udgange: kunden tror maden kommer.
//
// Honeypot og manglende felter afvises fortsat i stilhed — det første bevidst
// (sig ikke til en bot at den er fanget), det andet fordi formularen har
// `required` på felterne, så et kald uden dem ikke kan komme fra en kunde.
class OrderRejected extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'OrderRejected';
        this.code = code;
    }
}

// ─── POST /webhook/bestilling ──────────────────────────────────────────────
// Offentligt endpoint — ingen auth

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
    if (err instanceof OrderRejected) {
      console.warn(`[web-order] Afvist (${err.code}): ${err.message}`);
      // 409 — formularen viser beskeden sammen med mailto-udvejen, så kunden
      // har en vej videre i stedet for en blindgyde.
      return res.status(409).json({ ok: false, code: err.code, message: err.message });
    }
    // Uventet fejl. Historisk svarede vi 200 her — kunden fik "tak for din
    // bestilling" mens intet blev oprettet, og formularens mailto-udvej fyrer
    // kun på !res.ok, så den udløstes aldrig (#638). For en madbestilling er
    // det den værste udgang: kunden tror maden kommer.
    //
    // Statuskoden er usynlig for kunden — formularen renderer kun `message`
    // (eller sin egen faldback-tekst), aldrig HTTP-statussen. Så beskeden her
    // ER det kunden ser, og den skal være SAND: har vi bestillingen liggende,
    // siger vi det; har vi ikke, lover vi det ikke.
    console.error('[web-order] Fejl:', err);
    const gemt = !!err.webOrderId;
    res.status(500).json({
      ok: false,
      code: gemt ? 'internal_error_saved' : 'internal_error',
      message: gemt
        ? 'Vi har modtaget dine oplysninger, men kunne ikke færdigbehandle '
          + 'bestillingen. Vi kontakter dig hurtigst muligt — eller'
        : 'Vi kunne ikke tage imod bestillingen lige nu. Prøv igen om lidt, eller',
    });
  }
});

// ─── POST /api/web-orders/:id/acknowledge ──────────────────────────────────
//
// Office kvitterer for en fejlet bestilling når kunden er ringet op. Uden den
// kunne listen aldrig ryddes, og et panel der altid viser det samme holder man
// op med at læse.
//
// requireAuth() er IKKE overflødig selvom /api ligger bag den globale gate:
// den SAMME router er også monteret offentligt på /webhook (server.js:154), så
// uden den her ville POST /webhook/:id/acknowledge være åben for internettet.
router.post('/:id/acknowledge', requireAuth(), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldigt id' });

  const row = db.prepare('SELECT id, acknowledged_at FROM web_orders WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Ukendt web-ordre' });
  if (row.acknowledged_at) return res.json({ id, acknowledged_at: row.acknowledged_at, already: true });

  db.prepare(`UPDATE web_orders
                 SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by_user_id = ?
               WHERE id = ?`).run(req.session?.userId || null, id);

  const fresh = db.prepare('SELECT acknowledged_at FROM web_orders WHERE id = ?').get(id);
  res.json({ id, acknowledged_at: fresh.acknowledged_at });
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

// ─── web_orders-rækken: sporet der skal overleve en fejl ────────────────────
//
// Rækken blev historisk skrevet EFTER bonen. Gik noget galt undervejs, efterlod
// bestillingen derfor INTET spor — hverken en række eller en bon (#638). Den
// skrives nu først, i sin egen commit uden for transaktionen, og opdateres når
// bonen findes. Ligger den inde i transaktionen, ruller den tilbage sammen med
// fejlen, og så er vi tilbage ved udgangspunktet.
function insertWebOrderRow(db, data, { status = 'ny', failureReason = null } = {}) {
  const addr = data.validatedAddress || {};
  const orderType = data.ordertype === 'pickup' ? 'pickup' : 'catering';
  const fullName = [(data.first_name || '').trim(), (data.last_name || '').trim()]
    .filter(Boolean).join(' ');

  const res = db.prepare(`
    INSERT INTO web_orders (
      order_type, customer_name, customer_email, customer_phone,
      company, delivery_date, delivery_time,
      address_text, address_lat, address_lon, address_postnr,
      pax, wishes, ean_info, raw_data, bon_id, status, failure_reason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, NULL, ?, ?)
  `).run(
    orderType,
    fullName || null,
    data.email?.trim() || null,
    data.phone?.trim() || null,
    // Det RÅ firmanavn som kunden tastede. Firma-resolveren (#567) kører først
    // inde i transaktionen, så det afkodede navn kendes ikke endnu — og sporet
    // skal ligge klar før dét punkt. Opdateres når resolveren har svaret.
    data.company?.trim() || null,
    data.delivery_date || null,
    data.delivery_time || null,
    addr.tekst || data.address_text || null,
    addr.lat || null,
    addr.lon || null,
    addr.postnr || null,
    data.pax ? parseInt(data.pax) : null,
    data.wishes || null,
    data.ean_info || null,
    JSON.stringify(data),
    status,
    failureReason
  );
  return Number(res.lastInsertRowid);
}

// Et spor må aldrig vælte det det sporer: fejler opdateringen, siges det i
// loggen, men fejlen kastes ikke videre.
function updateWebOrderRow(db, id, fields) {
  if (!id) return;
  try {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE web_orders SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map(k => fields[k]), id);
  } catch (e) {
    console.error(`[web-order] Kunne ikke opdatere web_orders #${id}:`, e.message);
  }
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

  // 2a. Format på leveringstidspunktet (#644)
  //
  // Feltet blev kun tjekket for at VÆRE der og gik derfra direkte i bonen.
  // "i morgen" gav en bon der var halvt synlig: Senere og Planlægning viser
  // den (tekst-sortering — `i` > `2`), mens I dag og Kalender ikke gør. Og
  // cut-off-guarden fejler bevidst ÅBENT på en dato den ikke kan læse, så en
  // ugyldig dato var den ene vej helt uden om deadline. Derfor FØR de to
  // guards nedenfor.
  //
  // Rækken gemmes ikke her. En dato vi ikke kan læse giver ingen brugbar
  // bestilling at følge op på, og formularens <input type="date"> kan ikke
  // producere den — det er et direkte POST. Samme doktrin som manglende
  // felter lige ovenfor.
  if (!isValidDeliveryDate(data.delivery_date)) {
    throw new OrderRejected('invalid_date',
      'Leveringsdatoen kunne ikke læses. Vælg en dato i kalenderen, eller');
  }
  if (!isValidDeliveryTime(data.delivery_time)) {
    throw new OrderRejected('invalid_time',
      'Leveringstidspunktet kunne ikke læses. Angiv det som fx 11:30, eller');
  }

  // 2b. Gem bestillingen FØR noget andet røres (#638).
  //
  // Herfra og ned kan alt gå galt — og uanset hvad har vi nu kundens ordre
  // liggende i rå form. Placeringen er et valg: efter honeypot og validering,
  // så bot-spam og ulæselige kald ikke fylder tabellen, men før den første
  // sideeffekt.
  const webOrderId = insertWebOrderRow(db, data);

  // 2c. Ferielukket — server-guard (formen spærrer allerede, men et direkte
  // API-kald skal ikke kunne snige en bestilling ind i en lukket periode).
  if (isClosedDate(db, data.delivery_date)) {
    updateWebOrderRow(db, webOrderId,
      { status: 'afvist', failure_reason: 'closed_period: ferielukket på leveringsdatoen' });
    throw new OrderRejected('closed_period',
      'Vi holder lukket på den valgte leveringsdato.');
  }

  // 2d. Deadline — server-guard. Formularen tjekker i det øjeblik datoen vælges
  // og aldrig igen, så en side der har stået åben siden formiddagen kunne sende
  // en bestilling til i morgen om aftenen. Reglen ligger i services/orderCutoff
  // og fejler ÅBENT: kan deadline ikke beregnes, slipper bestillingen igennem.
  const timing = checkOrderTiming(db, data.delivery_date, { todayIso: todayISO() });
  if (!timing.ok) {
    // Gemt som afvist, ikke kastet væk: en ordre vi siger nej til er stadig
    // en kunde der ville handle, og antallet siger noget om hvad reglen koster.
    updateWebOrderRow(db, webOrderId,
      { status: 'afvist', failure_reason: `${timing.code}: ${timing.message}` });
    throw new OrderRejected(timing.code,
      `${timing.message} Ring til os, så finder vi en løsning.`);
  }

  // ── Sideeffekterne i ÉN transaktion (#638) ───────────────────────────
  //
  // Trin 3–9 skriver fem steder: firma (resolveren kan oprette en række),
  // kunde, adresse, bon og til sidst koblingen på sporet. Uden en transaktion
  // efterlod en fejlet createBon en halvfærdig kunde- og adresserække som
  // affald — og ingen kunne se hvorfor de lå der.
  //
  // web_orders-rækken ligger bevidst UDEN FOR (indsat ovenfor): den er sporet,
  // og et rollback må ikke tage den med sig. Koblingen til bonen sker derimod
  // INDE i transaktionen, så bon og spor commit'er sammen — der findes aldrig
  // et øjeblik hvor bonen er oprettet mens sporet stadig siger "ikke færdig".
  //
  // transaction() er indlejrbar (db/compat.js), hvilket er nødvendigt her:
  // createBon åbner sin egen for at låse nummerserien.
  //
  // Menu-linjerne (trin 10b) venter på Grocy over netværket og bliver derfor
  // UDEN FOR — en SQLite-transaktion må ikke spænde over et netværkskald.
  let tx;
  try {
    tx = transaction(db, () => {
    // 3. Parse navn
    const firstName = (data.first_name || '').trim();
    const lastName  = (data.last_name || '').trim() || null;
    const fullName  = [firstName, lastName].filter(Boolean).join(' ');

    // 4. Find bestilleren på email
    //
    // Email er den eneste identitet formularen giver os der IKKE er fri tekst.
    // Opslaget lå tidligere længere nede (trin 6); det er rykket herop fordi
    // forhandler-reglen nedenfor skal vide hvem der bestiller, før firmaet
    // afgøres. Samme forespørgsel, samme række — kun rækkefølgen er ændret.
    const emailTrimmed = data.email?.trim() || '';
    const existingCustomer = emailTrimmed
      ? db.prepare(
          'SELECT id, company_id FROM customers WHERE email = ? AND is_active = 1 LIMIT 1'
        ).get(emailTrimmed) || null
      : null;

    // 5. Firma — én delt regel for begge indgange (#567 + #607)
    //
    // services/orderCompanyResolver.js afgør det, i denne rækkefølge:
    //   forhandler (migration 167) → bestillerens eget firma → matcher
    //   (CVR → EAN → e-mail → navnelighed) → nyt firma.
    //
    // Før lå der et eksakt navne-opslag her, som oprettede en firma-række pr.
    // skrivemåde ("University of Copenhagen" ved siden af "Københavns
    // Universitet", `LANDBRUG &amp; FØDEVARER` ved siden af "Landbrug &
    // Fødevarer"). Kunden blev derimod slået op på e-mail og ramte altid rigtigt
    // — så bonnen lå på ét firma og kunden på et andet.
    const resolved = resolveOrderCompany(db, {
      typedName: data.company,
      email: emailTrimmed,
      invoiceInfo: data.ean_info,
      cvr: data.cvr,
      ean: data.ean,
      // Bevidst INGEN by som tiebreaker: leveringsadressen er ikke firmaets
      // adresse, og matcheren ville diskvalificere et firma i Frederiksberg der
      // får leveret i København.
      existingCustomer,
    });

    const reseller        = resolved.reseller;
    const typedCompany    = resolved.typedName;   // afkodet — aldrig `&amp;`
    const companyId       = resolved.companyId;
    const endCustomerName = resolved.endCustomerName;

    // 6. EAN fra faktura-info
    const eanInfo = data.ean_info || '';
    const ean = resolved.ean;

    // Ikke på en forhandler: et EAN i en forhandler-ordre hører til SLUTKUNDEN,
    // ikke til forhandleren. Skrev vi det på forhandlerens firma-række, ville
    // næste faktura til dem gå til en fremmed EAN-modtager.
    if (ean && companyId && !reseller) {
      db.prepare("UPDATE companies SET ean = ? WHERE id = ? AND (ean IS NULL OR ean = '')")
        .run(ean, companyId);
    }

    // 7. Opret kunde hvis vi ikke kendte bestilleren
    let customerId = existingCustomer?.id || null;

    if (!customerId) {
      const res = db.prepare(`
        INSERT INTO customers (first_name, last_name, email, phone, company_id, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(firstName, lastName, data.email?.trim() || null, data.phone?.trim() || null, companyId);
      customerId = Number(res.lastInsertRowid);
    }

    // 8. Opret adresse (kun catering/levering)
    const orderType = data.ordertype || 'catering';
    const deliveryType = orderType === 'pickup' ? 'pickup' : 'delivery';
    let addressId = null;
    let addressUnverified = false;

    if (deliveryType === 'delivery' && data.validatedAddress) {
      const addr = typeof data.validatedAddress === 'string'
        ? JSON.parse(data.validatedAddress)
        : data.validatedAddress;

      if (addr?.tekst) {
        // Gade + husnummer: første tal efter gadenavnet. Kommaet er ikke
        // krævet — en adresse skrevet i hånden (nødudgangen) har det ikke altid.
        const vejMatch = addr.tekst.match(/^(.+?)\s+(\d+[A-Za-zÆØÅæøå]?)(?=[\s,]|$)/);
        const streetName = vejMatch ? vejMatch[1] : addr.tekst.split(',')[0];
        const streetNr   = vejMatch ? vejMatch[2] : null;

        const res = db.prepare(`
          INSERT INTO addresses (street_name, street_nr, postal_code, city, lat, lon)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(streetName, streetNr, addr.postnr || null, addr.by || null,
               addr.lat || null, addr.lon || null);
        addressId = Number(res.lastInsertRowid);

        // Adressen kom uden om listen, fordi adresseopslaget ikke svarede hos
        // kunden (nødudgangen i formularen). Den har ingen koordinater, og
        // ingen har set den matche en rigtig adresse — så kontoret skal vide
        // det, og geokodningen prøver bagefter. Fire-and-forget: den må
        // aldrig vælte bestillingen.
        if (addr.unverified) {
          addressUnverified = true;
          const aid = addressId;
          setImmediate(() => {
            require('../services/geocode').geocodeAddress(aid).catch(err => {
              console.warn('[web-order] geokodning af ikke-verificeret adresse fejlede:', err.message);
            });
          });
        }
      }
    }

    // 9. Opret bon (fælles helper — #237)
    const pax = data.pax ? parseInt(data.pax) : null;
    const customerWishes = appendWishesLine(buildCustomerWishes(data), resolved.wishesLine);

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
      end_customer_name: endCustomerName,
      delivery_notes: deliveryNotes,
      internal_notes: addressUnverified
        ? '⚠ Leveringsadressen er ikke verificeret — adresseopslaget svarede ikke hos kunden. Tjek at adressen findes.'
        : null,
      changelog_field: 'web_order',
      // Forklarer HVORFOR bonnen ligger hvor den ligger, når det ikke er det
      // firmanavn der blev tastet. Uden linjen ser det ud som om nogen har
      // rettet firmaet i hånden.
      changelog_message: `Oprettet via web-bestilling (${data.email || fullName})` +
        (resolved.note ? ` — ${resolved.note}` : ''),
      broadcast_extra: { source: 'web_order' },
    });


      // 10. Kobl sporet til bonen — samme commit som bonen selv.
      updateWebOrderRow(db, webOrderId, {
        bon_id: bonId,
        status: 'konverteret',
        // Resolveren kan have fundet et andet firma end det kunden tastede
        // (#567). Sporet skal vise det navn bonen faktisk ligger på.
        company: typedCompany || null,
      });

      return {
        firstName, lastName, fullName, resolved, reseller, typedCompany,
        companyId, endCustomerName, eanInfo, ean, customerId, orderType,
        deliveryType, addressId, pax, customerWishes, deliveryNotes,
        bonId, bonNumber,
      };
    });
  } catch (err) {
    // Sporet ER skrevet — bestillingen er ikke tabt. Marker hvorfor den ikke
    // blev til en bon, og lad routen vide at vi har den, så beskeden til
    // kunden kan være sand.
    err.webOrderId = webOrderId;
    updateWebOrderRow(db, webOrderId, { failure_reason: String(err && err.message || err) });
    console.error(`[web-order] Bon kunne ikke oprettes (web_order #${webOrderId}):`, err);
    throw err;
  }

  const {
    fullName, resolved, reseller, typedCompany, endCustomerName,
    orderType, deliveryType, pax, bonId, bonNumber,
  } = tx;
  const addr = data.validatedAddress || {};

  // 10b. Auto-generér bon-linjer fra kundens menu-valg (#382).
  //     Best-effort: en Grocy-fejl må ALDRIG vælte selve bestillingen — bonen er
  //     allerede oprettet. Linjerne er et startpunkt office retter/prissætter.
  try {
    await generateLinesFromMenuItems(db, bonId, data);
  } catch (lineErr) {
    console.error(`[web-order] Kunne ikke auto-generere linjer for bon #${bonNumber}:`, lineErr.message);
  }

  // 11. Send bekræftelsesmail til kunden + intern notifikation til ejer
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
    // Forhandler-ordre: mailen skal sige begge dele — hvem der betaler, og hvem
    // maden er til. Ellers står der bare slutkundens navn under "Firma", og
    // læseren tror bonnen ligger dér.
    const firmaBlok = reseller
      ? `Firma: ${reseller.name} (formidler)` + (endCustomerName ? `\nSlutkunde: ${endCustomerName}` : '')
      : resolved.companyName
        // Firmaet bonnen ligger på — og det kunden skrev, når det er noget andet.
        ? `Firma: ${resolved.companyName}` + (resolved.typedDiffers ? `\nKunden skrev: ${typedCompany}` : '')
        : (typedCompany ? `Firma: ${typedCompany}` : '');
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
  const { resolveMenuItemLines, chipItemsFromWishes } = require('../services/menuItemsToLines');
  const items = Array.isArray(data.menu_items)
    ? data.menu_items.filter(i => i && Number(i.count) > 0)
    : [];

  // Kost-knapper der svarer til en vare ("Glutenfri: 2" → 2 glutenfri boller).
  // Har kunden selv valgt samme vare i menuen, er dét hendes antal — vi lægger
  // ikke knappens tal oveni.
  let chipRecipes = null;
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'bestilling.chip_recipes'").get();
    if (row?.value) chipRecipes = JSON.parse(row.value);
  } catch (e) {
    console.warn('[web-order] bestilling.chip_recipes kan ikke læses:', e.message);
  }
  const chosen = new Set(items.map(i => String(i.id)));
  for (const c of chipItemsFromWishes(data.wishes, chipRecipes)) {
    if (!chosen.has(c.id)) items.push(c);
  }
  if (!items.length) return;

  const grocyAdapter = require('../services/grocyAdapter');
  const { insertBonLines } = require('../db/helpers');

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

  insertBonLines(db, bonId, lines, {
    changelogMessage: `${lines.length} linje(r) auto-genereret fra web-bestilling`,
    notes: 'Kundens menu-valg',
  });

  console.log(`[web-order] Auto-genererede ${lines.length} linje(r) på bon ${bonId} (priskategori=${priceCategory})`);
}

module.exports = router;
// Eksponeret til integrationstest (#382) — ikke del af det offentlige API.
module.exports._generateLinesFromMenuItems = generateLinesFromMenuItems;
