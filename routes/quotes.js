/**
 * routes/quotes.js — Tilbud API (tilbud = bon med is_offer=1)
 *
 * Mount: app.use('/api/quotes', require('./routes/quotes'))
 *
 * Tilbud bor i bons-tabellen med is_offer=1.
 * "Konvertér til bon" = opret ÉN NY bon pr. dag (ét-dags = én bon) og lad
 * tilbuddet blive liggende som bilag, markeret 'won' og låst. `is_offer`
 * skifter ALDRIG værdi på en levende række — se migration 146 for hvorfor.
 */

const express = require('express');
const router  = express.Router();

const { getDb }    = require('../db/database');
const { handle, logChange, nextBonNumber, nextQuoteNumber, getStatusId, getDefaultLocationId, getBon, getBonLines, computeMomsFields, recalcBonTotalUnits, todayISO, createBon } = require('../db/helpers');
const { transaction } = require('../db/compat');
const { broadcast } = require('../shared/sse');

// ─── LÅS ───────────────────────────────────────────────────────────────────
//
// Et vundet tilbud er et bilag: det dokumenterer hvad kunden sagde ja til.
// Kunne man rette frit i det bagefter, ville prisen i bilaget og prisen i
// aftalen kunne skride fra hinanden uden at nogen kunne se hvornår — og
// bilaget ville ikke længere kunne bruges til det eneste det er til for.
//
// Låsen sættes af konverteringen og kan tages af igen (POST /:id/unlock): en
// aftale KAN ændre sig, og et system der tvinger brugeren til at bygge
// tilbuddet forfra bliver omgået i stedet for overholdt. Men det skal være en
// bevidst handling — aldrig en bivirkning af at trykke Gem.
//
// 409 og ikke 423: 423 Locked hører til WebDAV og håndteres ikke af nogen af
// vores klienter. `locked: true` i svaret er det frontenden reagerer på.
function lockedResponse(res) {
    return res.status(409).json({
        error: 'Tilbuddet er låst, fordi det er vundet og lavet om til en bon. Lås det op hvis aftalen har ændret sig.',
        locked: true,
    });
}

// ─── DAGE (#425) ───────────────────────────────────────────────────────────
//
// Et tilbud kan dække flere dage — tre dages konference med levering hver dag.
// Dagene ligger i `offer_days` (migration 145); kun datoen er påkrævet, resten
// er NULL = "arv fra tilbuddet".
//
// Ét tilbud UDEN dage er det normale og opfører sig præcis som før.

function getOfferDays(bonId) {
    return getDb().prepare(`
        SELECT id, sort_order, delivery_date, delivery_time, pickup_time, pax,
               delivery_address_id, label, note
          FROM offer_days WHERE bon_id = ?
         ORDER BY sort_order, delivery_date, id
    `).all(bonId);
}

/**
 * Dag-tilknytning på linjer — validering af `offer_day_id` i et linje-payload.
 *
 * `NULL` betyder **"alle dage"**, ikke "ingen dag", så en tom værdi er altid
 * lovlig og er den normale tilstand for et ét-dags-tilbud. Et id skal derimod
 * pege på en dag der hører til DETTE tilbud — ellers kan en linje enten blive
 * usynlig (den hænger på en dag der aldrig konverteres) eller havne på et andet
 * tilbuds dag.
 *
 * Hele listen valideres før der skrives noget, af samme grund som i `PUT /days`:
 * linjerne indsættes replace-all, så et halvt gyldigt payload ville efterlade
 * tilbuddet med færre varer end kunden ser i sit bilag.
 *
 * Returnerer `{ ids: [...] }` (parallelt med `lines`) eller `{ error }`.
 */
function resolveLineDayIds(bonId, lines) {
    const valid = new Set(getOfferDays(bonId).map(d => d.id));
    const ids = [];

    for (const [i, l] of lines.entries()) {
        const raw = l.offer_day_id;
        if (raw === '' || raw == null) { ids.push(null); continue; }

        const dayId = parseInt(raw);
        if (!Number.isInteger(dayId) || !valid.has(dayId)) {
            return {
                error: valid.size === 0
                    // Den typiske rækkefølgefejl: linjerne gemmes før dagene
                    // findes. Sig hvad der mangler frem for bare "ugyldig".
                    ? `Linje ${i + 1} peger på dag ${raw}, men tilbuddet har ingen dage endnu — gem dagene (PUT /days) først`
                    : `Linje ${i + 1}: dag ${raw} hører ikke til dette tilbud`,
            };
        }
        ids.push(dayId);
    }
    return { ids };
}

/**
 * PUT /:id/days — reconcile af tilbuddets dage.
 *
 * Klienten sender altid den fulde liste (samme mønster som `/forecast` og
 * event-modulets `/menu`): rækker med `id` opdateres, nye oprettes, og dem der
 * ikke er med, slettes.
 *
 * Hvorfor ikke bare slette alt og indsætte forfra: `bon_lines.offer_day_id`
 * peger på dagene. En sletning ville rive linjernes dag-tilknytning væk
 * (`ON DELETE SET NULL`), så alle dagens varer stille blev til fælles-varer og
 * dukkede op på hver eneste dag. Derfor bevares id'erne.
 *
 * Valideres FULDT ud før der skrives, så et halvt gyldigt payload ikke kan
 * efterlade dagene delvist opdaterede.
 */
router.put('/:id/days', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const q = db.prepare('SELECT id, bon_number, is_offer, offer_locked_at FROM bons WHERE id = ? AND is_offer = 1').get(id);
    if (!q) return res.status(404).json({ error: 'Tilbud ikke fundet' });
    if (q.offer_locked_at) return lockedResponse(res);

    const items = Array.isArray(req.body?.days) ? req.body.days : null;
    if (!items) return res.status(400).json({ error: 'days (array) er påkrævet' });

    const existing = new Map(getOfferDays(id).map(d => [d.id, d]));
    const clean = [];
    const seenDates = new Set();

    for (const [i, d] of items.entries()) {
        const date = (d.delivery_date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ error: `Dag ${i + 1}: delivery_date skal være YYYY-MM-DD` });
        }
        // To dage med samme dato ville give to bons samme dag uden nogen måde at
        // skelne dem — næsten altid en fejlindtastning.
        if (seenDates.has(date)) {
            return res.status(400).json({ error: `Datoen ${date} står to gange` });
        }
        seenDates.add(date);

        const dayId = d.id ? parseInt(d.id) : null;
        if (dayId && !existing.has(dayId)) {
            return res.status(400).json({ error: `Dag ${dayId} hører ikke til dette tilbud` });
        }

        const pax = d.pax === '' || d.pax == null ? null : parseInt(d.pax);
        if (pax != null && (!Number.isInteger(pax) || pax < 0)) {
            return res.status(400).json({ error: `Dag ${i + 1}: pax skal være et positivt tal` });
        }

        clean.push({
            id: dayId,
            sort_order: i,
            delivery_date: date,
            delivery_time: d.delivery_time || null,
            pickup_time: d.pickup_time || null,
            pax,
            delivery_address_id: d.delivery_address_id ?? null,
            label: (d.label || '').trim() || null,
            note: (d.note || '').trim() || null,
        });
    }

    transaction(db, () => {
        const keep = new Set(clean.map(c => c.id).filter(Boolean));
        for (const oldId of existing.keys()) {
            if (!keep.has(oldId)) db.prepare('DELETE FROM offer_days WHERE id = ?').run(oldId);
        }

        const upd = db.prepare(`
            UPDATE offer_days SET sort_order=?, delivery_date=?, delivery_time=?, pickup_time=?,
                   pax=?, delivery_address_id=?, label=?, note=?, updated_at=CURRENT_TIMESTAMP
             WHERE id = ? AND bon_id = ?
        `);
        const ins = db.prepare(`
            INSERT INTO offer_days (bon_id, sort_order, delivery_date, delivery_time, pickup_time,
                                    pax, delivery_address_id, label, note)
            VALUES (?,?,?,?,?,?,?,?,?)
        `);
        for (const c of clean) {
            if (c.id) {
                upd.run(c.sort_order, c.delivery_date, c.delivery_time, c.pickup_time,
                        c.pax, c.delivery_address_id, c.label, c.note, c.id, id);
            } else {
                ins.run(id, c.sort_order, c.delivery_date, c.delivery_time, c.pickup_time,
                        c.pax, c.delivery_address_id, c.label, c.note);
            }
        }

        // Tilbuddets egen delivery_date holdes på den første dag, så lister,
        // kalender og kitchen-views viser noget der giver mening.
        if (clean.length) {
            db.prepare('UPDATE bons SET delivery_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
              .run(clean[0].delivery_date, id);
        }
    });

    broadcast('bon_updated', { id, bon_number: q.bon_number, is_offer: true });
    res.json({ days: getOfferDays(id) });
}));

/**
 * Konvertér et tilbud til bons — én pr. dag, og et ét-dags-tilbud er n = 1.
 *
 * Tilbuddet BLIVER liggende som tilbud (`is_offer` røres aldrig) og markeres
 * 'won' + låst. Det er bilaget kunden har sagt ja til — den aftalte pris,
 * rabatten og gyldigheden står der, og de skal kunne slås op bagefter. Bonnerne
 * peger tilbage via `source_quote_id`.
 *
 * Ét-dags gik indtil videre en anden vej: den flippede `is_offer` på tilbuddets
 * EGEN række, så tilbuddet holdt op med at eksistere i samme øjeblik det blev
 * vundet. Det vundne tilbud var dermed det eneste man bagefter ikke kunne
 * finde — hverken i tilbudslisten, under "Vundet" eller i CRM-pipelinen.
 * Særvejen er væk: forskellen på ét og flere dage er nu kun hvor mange bons der
 * kommer ud i den anden ende.
 *
 * Hver dagsbon arver alt fra tilbuddet med mindre dagen selv siger noget andet
 * (`?? q.…`-mønstret nedenfor). Linjer med `offer_day_id = NULL` er fælles og
 * kopieres til hver dag — kaffe og emballage skal ikke tastes tre gange for at
 * komme med tre gange.
 *
 * Alt sker i én transaktion: enten står alle dagene, eller ingen. Halvt
 * konverterede tilbud ville være værre end en fejlbesked.
 */
function convertToBons(req, res, q, days) {
    const db = getDb();
    const userId = req.session?.userId ?? null;
    const statusId = getStatusId('GODKENDT') || getStatusId('NY');

    const allLines = getBonLines(q.id);
    const shared = allLines.filter(l => !l.offer_day_id);
    const srcGroups = db.prepare(`
        SELECT id, title, note, sort_order FROM bon_menu_groups WHERE bon_id = ? ORDER BY sort_order
    `).all(q.id);

    // Uden dage bliver det én bon der arver alt. Den tomme dag er ikke et hack,
    // men netop pointen: hvert `day.x ?? q.x` nedenfor falder så tilbage på
    // tilbuddets egen værdi, og de to veje kan ikke skride fra hinanden med
    // tiden — sådan som de gjorde da ét-dags havde sin egen kodesti.
    const targets = days.length
        ? days.map(d => ({ day: d, lines: allLines.filter(l => l.offer_day_id === d.id).concat(shared) }))
        : [{ day: {}, lines: allLines }];

    const created = transaction(db, () => {
        const out = [];

        const insGroup = db.prepare(`
            INSERT INTO bon_menu_groups (bon_id, title, note, sort_order) VALUES (?,?,?,?)
        `);
        // `moms_included` skal med: uden den falder linjen tilbage på skemaets
        // default, og en linje der bevidst lå EX moms (migration 104) ville
        // blive læst som INCL i dagsbonnen.
        const ins = db.prepare(`
            INSERT INTO bon_lines
                (bon_id, block_type, grocy_recipe_id, product_name, category, quantity, unit,
                 unit_price, cost_price, line_total, sort_order, notes, special_request,
                 is_accessory, moms_included, menu_group_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);

        for (const { day, lines } of targets) {
            const { bonId, bonNumber } = createBon({
                status_id: statusId,
                location_id: q.location_id,
                customer_id: q.customer_id,
                company_id: q.company_id,
                price_category_id: q.price_category_id,
                price_category: q.price_category,

                // Dagens egne værdier vinder; NULL betyder "brug tilbuddets".
                delivery_date: day.delivery_date ?? q.delivery_date,
                delivery_time: day.delivery_time ?? q.delivery_time,
                pickup_time: day.pickup_time ?? q.pickup_time,
                pax: day.pax ?? q.pax,
                delivery_address_id: day.delivery_address_id ?? q.delivery_address_id,

                delivery_type: q.delivery_type,
                delivery_method: q.delivery_method,
                delivery_notes: q.delivery_notes,
                // Leveringsprisen hører til ÉN kørsel. Lægges den på hver dag,
                // ganges den op uden at nogen har aftalt det — så den følger
                // kun den første dag, og office kan flytte den hvis turen er delt.
                delivery_price: out.length === 0 ? (q.delivery_price ?? 0) : 0,

                payment_type: q.payment_type,
                customer_wishes: q.customer_wishes,
                invoice_info: q.invoice_info,
                kitchen_info: [day.label, q.kitchen_info].filter(Boolean).join(' · ') || null,
                internal_notes: q.internal_notes,
                day_contact_name: q.day_contact_name,
                day_contact_phone: q.day_contact_phone,

                source_quote_id: q.id,
                user_id: userId,
                changelog_field: 'create',
                changelog_message: `Oprettet fra tilbud ${q.bon_number}`
                    + (day.delivery_date ? ` (${day.delivery_date})` : ''),
                // Annonceres efter commit — se broadcast-løkken nedenfor.
                broadcast: false,
            });

            // Menu-grupperne hører til den bon de står på (`bon_menu_groups.bon_id`),
            // så linjernes `menu_group_id` kan ikke bare kopieres med — det ville
            // pege på TILBUDDETS grupper. De genskabes pr. bon og linjerne
            // oversættes gennem `groupMap`. Springes det over, mister bonnen den
            // menu-opdeling køkkenet netop har lavet for at kunne læse den.
            const groupMap = new Map();
            for (const g of srcGroups) {
                const gr = insGroup.run(bonId, g.title, g.note, g.sort_order);
                groupMap.set(g.id, Number(gr.lastInsertRowid));
            }

            lines.forEach((l, i) => {
                ins.run(bonId, l.block_type ?? null, l.grocy_recipe_id ?? null, l.product_name,
                        l.category ?? null, l.quantity, l.unit ?? 'stk',
                        l.unit_price ?? null, l.cost_price ?? null, l.line_total ?? null,
                        l.sort_order ?? i, l.notes ?? null, l.special_request ?? null,
                        l.is_accessory ?? 0, l.moms_included ?? 1,
                        l.menu_group_id ? (groupMap.get(l.menu_group_id) ?? null) : null);
            });

            recalcBonTotalUnits(db, bonId);
            recalcTotal(db, bonId);
            out.push({ bon_id: bonId, bon_number: bonNumber, delivery_date: day.delivery_date ?? q.delivery_date, lines: lines.length });
        }

        db.prepare(`
            UPDATE bons SET offer_status = 'won', offer_locked_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
             WHERE id = ?
        `).run(q.id);
        return out;
    });

    logChange({
        entityType: 'bon', entityId: q.id,
        action: 'update', fieldName: 'offer_status',
        oldValue: q.offer_status || 'draft', newValue: 'won',
        notes: created.length === 1
            ? `Konverteret til bon ${created[0].bon_number} — tilbuddet er låst`
            : `Konverteret til ${created.length} bons: ${created.map(c => c.bon_number).join(', ')} — tilbuddet er låst`,
        userId,
    });

    // Først her — efter commit — findes bonnerne. Havde `createBon` annonceret
    // dem undervejs, ville en fejl på sidste dag efterlade huset med besked om
    // bons der blev rullet tilbage.
    for (const c of created) {
        broadcast('bon_created', {
            id: c.bon_id, bon_number: c.bon_number,
            source: 'quote_convert', source_quote_id: q.id,
        });
    }

    // Tilbuddet skifter status (tilbudslisten), og der er kommet nye bons.
    broadcast('bon_updated', { id: q.id, bon_number: q.bon_number, is_offer: true });

    res.json({
        quote_id: q.id,
        multi_day: created.length > 1,
        bons: created,
        // Ét-dags-svaret bar før bon-nummeret i roden. Beholdt, så kaldere der
        // kvitterer med "konverteret til B-123" ikke skal skrives om.
        bon_id: created[0]?.bon_id ?? null,
        bon_number: created[0]?.bon_number ?? null,
    });
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

function formatOffer(row) {
    const moms = computeMomsFields(row.total_price);
    return {
        id: row.id,
        quote_number: row.bon_number,
        bon_number: row.bon_number,
        status: row.offer_status || 'draft',
        template: row.offer_template,
        price_mode: row.offer_price_mode || 'total',
        discount_percent: row.offer_discount_percent || 0,
        quote_date: row.order_date,
        valid_until: row.offer_valid_until,
        delivery_date: row.delivery_date,
        delivery_time: row.delivery_time,
        pax: row.pax,
        total_price: row.total_price,
        ...moms,                                 // total_incl_moms, total_excl_moms, moms_amount
        price_category: row.price_category,
        customer_name: row.customer_name,
        company_name: row.company_name,
        customer_id: row.customer_id,
        company_id: row.company_id,
        day_count: row.day_count ?? 0,
        locked: !!row.offer_locked_at,
        // Konverteret kendes på at der STÅR bons på tilbuddet — ikke på status.
        // Et tilbud kan trækkes til "Vundet" i pipelinen uden at nogen har
        // oprettet noget, og dét er en anden tilstand end en gennemført ordre.
        bon_count: row.bon_count ?? 0,
        bon_numbers: row.bon_numbers || null,
        converted_to_bon: (row.bon_count ?? 0) > 0,
    };
}

/**
 * recalcTotal — server-autoritativ recalc af tilbud-total fra bon_lines.
 *
 * Skriver til total_price (delivery_price tilføjes hvis sat). Frontenden
 * sender ALDRIG total_price i POST/PATCH — alt går gennem denne funktion.
 *
 * UNDTAGELSE — POS/Zettle (planlagt, ikke bygget pr. maj 2026):
 * Når POS-stien bygges (routes/pos.js eller webhook fra Zettle), skal
 * dén sandsynligvis SKIPPE recalc og diktere total_price direkte fra
 * Zettle-kvitteringen — Zettle er den eksterne sandhedskilde, ikke os.
 * (Ikke relevant for tilbud i dag — tilbud bliver aldrig POS-betalt — men
 * mønstret holdes konsistent med routes/bons.js recalcBonTotal.)
 *
 * Mønster:
 *   if (payment_type !== 'pos') recalcTotal(db, bonId);
 *
 * Ref: docs/Grocy audit/KENDTE_DATABUGS.md — moms-refaktorering, Commit 3 (1. maj 2026)
 *      verificerede at ingen eksisterende sti sender total_price.
 *
 * Quick-fix (Del 5.5 i CLAUDE_TILBUD_PRIS.md): hvis bonnen har en x-Levering-linje
 * (migreret fra Bon v1), bruges DEN som leverings-bidrag og bons.delivery_price
 * ignoreres så vi ikke dobbelttæller. Stopper dobbelttælling indtil sync-v1.js
 * mapper x-Levering til delivery_*-felter og data-migration har ryddet op (Del 5.4).
 */
function recalcTotal(db, bonId) {
    const bon = db.prepare('SELECT delivery_price, offer_discount_percent FROM bons WHERE id = ?').get(bonId);
    const lines = db.prepare('SELECT line_total, category FROM bon_lines WHERE bon_id = ?').all(bonId);
    const hasLeveringLine = lines.some(l => l.category === 'x-Levering');
    const linesSum = lines.reduce((s, l) => s + (l.line_total ?? 0), 0);
    const deliveryAdd = hasLeveringLine ? 0 : (bon.delivery_price ?? 0);
    const subtotal = linesSum + deliveryAdd;
    const discount = bon.offer_discount_percent ? subtotal * (bon.offer_discount_percent / 100) : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;
    db.prepare('UPDATE bons SET total_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(total, bonId);
    return total;
}

// ─── GET /next-number ──────────────────────────────────────────────────────

router.get('/next-number', handle((req, res) => {
    const db = getDb();
    const prefix = db.prepare(`SELECT value FROM settings WHERE key='quote_number_prefix'`).get()?.value ?? 'T-';
    const current = parseInt(db.prepare(`SELECT value FROM settings WHERE key='quote_number_next'`).get()?.value ?? '1');
    res.json({ quote_number: `${prefix}${current}` });
}));

// ─── GET / — liste af tilbud ──────────────────────────────────────────────

router.get('/', handle((req, res) => {
    const db = getDb();
    const where = ['b.is_offer = 1'];
    const args  = [];

    if (req.query.status) {
        const statuses = req.query.status.split(',').map(s => s.trim());
        where.push(`b.offer_status IN (${statuses.map(() => '?').join(',')})`);
        args.push(...statuses);
    }

    if (req.query.customer_id) {
        where.push('b.customer_id = ?');
        args.push(parseInt(req.query.customer_id));
    }

    if (req.query.company_id) {
        where.push('b.company_id = ?');
        args.push(parseInt(req.query.company_id));
    }

    if (req.query.q) {
        const term = `%${req.query.q}%`;
        where.push(`(b.bon_number LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR co.name LIKE ?)`);
        args.push(term, term, term, term);
    }

    const rows = db.prepare(`
        SELECT b.id, b.bon_number, b.is_offer, b.offer_status, b.offer_template,
               b.order_date, b.offer_valid_until, b.delivery_date, b.delivery_time,
               b.pax, b.total_price, b.price_category,
               b.offer_price_mode, b.offer_discount_percent, b.offer_locked_at,
               b.customer_id, b.company_id,
               -- Bonnerne der kom ud af tilbuddet. Uden dem er "Vundet" et
               -- arkiv man ikke kan komme videre fra: man kan se AT sagen blev
               -- vundet, men ikke hvor den blev af.
               (SELECT COUNT(*) FROM bons x WHERE x.source_quote_id = b.id) AS bon_count,
               (SELECT GROUP_CONCAT(x.bon_number, ', ') FROM bons x WHERE x.source_quote_id = b.id) AS bon_numbers,
               c.first_name || ' ' || COALESCE(c.last_name,'') AS customer_name,
               co.name AS company_name,
               -- Så listen kan sige "3 dage" uden et opslag pr. række. 0 = et
               -- almindeligt ét-dags-tilbud, som langt de fleste er.
               (SELECT COUNT(*) FROM offer_days od WHERE od.bon_id = b.id) AS day_count
        FROM bons b
        LEFT JOIN customers c  ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id  = co.id
        WHERE ${where.join(' AND ')}
        ORDER BY b.created_at DESC
    `).all(...args);

    res.json(rows.map(formatOffer));
}));

// ─── GET /:id — enkelt tilbud med linjer ─────────────────────────────────

router.get('/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const bon = db.prepare(`
        SELECT b.*,
               b.offer_status, b.offer_template, b.offer_price_mode,
               b.offer_discount_percent, b.offer_valid_until,
               c.first_name || ' ' || COALESCE(c.last_name,'') AS customer_name,
               c.email  AS customer_email,
               c.phone  AS customer_phone,
               co.name  AS company_name
        FROM bons b
        LEFT JOIN customers c  ON b.customer_id = c.id
        LEFT JOIN companies co ON b.company_id  = co.id
        WHERE b.id = ? AND b.is_offer = 1
    `).get(id);

    if (!bon) return res.status(404).json({ error: 'Tilbud ikke fundet' });

    // Address
    let delivery_address = null;
    if (bon.delivery_address_id) {
        const addr = db.prepare('SELECT street_name, street_nr, postal_code, city FROM addresses WHERE id = ?').get(bon.delivery_address_id);
        if (addr) delivery_address = [addr.street_name, addr.street_nr, addr.postal_code, addr.city].filter(Boolean).join(' ');
    }

    const lines = db.prepare(`
        SELECT id, bon_id, block_type, grocy_recipe_id, product_name, category,
               quantity, unit, unit_price, cost_price, line_total, sort_order, notes,
               offer_day_id
        FROM bon_lines WHERE bon_id = ? ORDER BY sort_order, id
    `).all(id);

    // Bonnerne tilbuddet blev til. Wizarden bruger dem til at vise vejen videre
    // ("Vundet → B-123") i stedet for bare at melde at sagen er lukket.
    const convertedBons = db.prepare(
        'SELECT id, bon_number, delivery_date FROM bons WHERE source_quote_id = ? ORDER BY delivery_date, id'
    ).all(id);

    res.json({
        days: getOfferDays(id),
        locked: !!bon.offer_locked_at,
        converted_bons: convertedBons,
        id: bon.id,
        quote_number: bon.bon_number,
        bon_number: bon.bon_number,
        customer_id: bon.customer_id,
        company_id: bon.company_id,
        price_category: bon.price_category || 'catering',
        customer_name: bon.customer_name,
        customer_email: bon.customer_email,
        customer_phone: bon.customer_phone,
        company_name: bon.company_name,
        status: bon.offer_status || 'draft',
        template: bon.offer_template,
        price_mode: bon.offer_price_mode || 'total',
        discount_percent: bon.offer_discount_percent || 0,
        delivery_date: bon.delivery_date,
        delivery_time: bon.delivery_time,
        pickup_time: bon.pickup_time,
        delivery_type: bon.delivery_type,
        delivery_method: bon.delivery_method,
        delivery_address_id: bon.delivery_address_id,
        delivery_address: delivery_address,
        delivery_price: bon.delivery_price || 0,
        delivery_note: bon.delivery_notes,
        day_contact_name: bon.day_contact_name,
        day_contact_phone: bon.day_contact_phone,
        pax: bon.pax,
        total_units: bon.total_units,
        total_price: bon.total_price,
        ...computeMomsFields(bon.total_price),   // total_incl_moms, total_excl_moms, moms_amount
        payment_type: bon.payment_type,
        customer_wishes: bon.customer_wishes,
        invoice_info: bon.invoice_info,
        kitchen_info: bon.kitchen_info,
        offer_note: bon.offer_note,
        offer_block_metadata: bon.offer_block_metadata ? JSON.parse(bon.offer_block_metadata) : null,
        valid_until: bon.offer_valid_until,
        quote_date: bon.order_date,
        notes: bon.internal_notes,
        lines: lines,
    });
}));

// ─── POST / — opret tilbud (= bon med is_offer=1) ───────────────────────

router.post('/', handle((req, res) => {
    const db = getDb();
    const b  = req.body;

    // Dag-tilknytning kan ikke findes på et tilbud der ikke er oprettet endnu.
    // Afvis FØR nummerserien trækkes og rækken skrives — ellers efterlader en
    // afvist oprettelse et tomt tilbud og et brugt T-nummer.
    if (Array.isArray(b.lines) && b.lines.some(l => l.offer_day_id != null && l.offer_day_id !== '')) {
        return res.status(400).json({
            error: 'offer_day_id kan først sættes når tilbuddet har dage — opret tilbuddet, gem dagene (PUT /days), og tildel derefter linjerne',
        });
    }

    const bonNumber = nextQuoteNumber();  // T-prefix, separat nummerserie
    const statusId  = getStatusId('TILBUD') || getStatusId('NY');
    const locationId = getDefaultLocationId();

    // Beregn valid_until
    const quoteDate = b.quote_date || todayISO();
    let validUntil = b.valid_until;
    if (!validUntil) {
        const d = new Date(quoteDate);
        d.setDate(d.getDate() + 30);
        validUntil = d.toISOString().slice(0, 10);
    }

    const result = db.prepare(`
        INSERT INTO bons (
            bon_number, status_id, location_id, customer_id, company_id,
            order_date, delivery_date, delivery_time, pickup_time,
            delivery_type, delivery_method, delivery_address_id,
            delivery_notes, delivery_price,
            pax, total_units, total_price,
            payment_type, customer_wishes, invoice_info, kitchen_info, internal_notes,
            price_category, day_contact_name, day_contact_phone,
            is_offer, offer_status, offer_valid_until,
            offer_template, offer_price_mode, offer_discount_percent,
            offer_note, offer_block_metadata,
            prep_ingredients_ready, prep_supplies_ready,
            created_by_user_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,0,0,?)
    `).run(
        bonNumber, statusId, locationId,
        b.customer_id ?? null, b.company_id ?? null,
        quoteDate, b.delivery_date ?? null, b.delivery_time ?? null, b.pickup_time ?? null,
        b.delivery_type ?? 'delivery', b.delivery_method ?? null, b.delivery_address_id ?? null,
        b.delivery_note ?? null, b.delivery_price ?? 0,
        b.pax ?? 0, b.payment_type ?? null,
        b.customer_wishes ?? null, b.invoice_info ?? null, b.kitchen_info ?? null, b.notes ?? null,
        b.price_category ?? 'catering', b.day_contact_name ?? null, b.day_contact_phone ?? null,
        'draft', validUntil,
        b.template ?? 'event', b.price_mode ?? 'total', b.discount_percent ?? 0,
        b.offer_note ?? null,
        b.offer_block_metadata ? JSON.stringify(b.offer_block_metadata) : null,
        req.session?.userId ?? null
    );

    const bonId = result.lastInsertRowid;

    // Indsæt linjer. Et nyt tilbud har endnu ingen dage, så `offer_day_id` kan
    // kun være NULL her — men det valideres frem for at blive ignoreret, så en
    // klient der sender en dag får det at vide i stedet for tavst at miste den.
    if (Array.isArray(b.lines)) {
        const days = resolveLineDayIds(bonId, b.lines);
        if (days.error) return res.status(400).json({ error: days.error });

        const insertLine = db.prepare(`
            INSERT INTO bon_lines (bon_id, block_type, grocy_recipe_id, product_name, category, quantity, unit, unit_price, cost_price, line_total, sort_order, notes, is_accessory, offer_day_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        b.lines.forEach((l, i) => {
            const qty = l.quantity ?? 1;
            const lineTotal = (l.unit_price != null && qty) ? qty * l.unit_price : null;
            insertLine.run(
                bonId, l.block_type ?? null,
                l.grocy_recipe_id ?? null, l.product_name ?? 'Ukendt',
                l.category ?? l.block_type ?? null,
                qty, l.unit ?? 'stk',
                l.unit_price ?? null, l.cost_price ?? null,
                lineTotal, l.sort_order ?? i,
                l.notes ?? null,
                l.is_accessory ? 1 : 0,
                days.ids[i]
            );
        });
    }

    recalcTotal(db, bonId);

    logChange({
        entityType: 'bon', entityId: bonId,
        action: 'create', newValue: bonNumber,
        notes: 'Tilbud oprettet',
        userId: req.session?.userId ?? null
    });

    broadcast('bon_created', { id: bonId, bon_number: bonNumber, is_offer: true });
    res.status(201).json({ id: bonId, quote_number: bonNumber, bon_number: bonNumber });
}));

// ─── PATCH /:id — opdater tilbud ─────────────────────────────────────────

router.patch('/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const b  = req.body;

    const existing = db.prepare('SELECT * FROM bons WHERE id = ? AND is_offer = 1').get(id);
    if (!existing) return res.status(404).json({ error: 'Tilbud ikke fundet' });
    if (existing.offer_locked_at) return lockedResponse(res);

    const fieldMap = {
        customer_id: 'customer_id', company_id: 'company_id',
        price_category: 'price_category',
        delivery_date: 'delivery_date', delivery_time: 'delivery_time',
        pickup_time: 'pickup_time',
        pax: 'pax', total_units: 'total_units',
        delivery_type: 'delivery_type', delivery_method: 'delivery_method',
        delivery_address_id: 'delivery_address_id',
        delivery_price: 'delivery_price', delivery_note: 'delivery_notes',
        day_contact_name: 'day_contact_name', day_contact_phone: 'day_contact_phone',
        payment_type: 'payment_type',
        template: 'offer_template', price_mode: 'offer_price_mode',
        discount_percent: 'offer_discount_percent',
        customer_wishes: 'customer_wishes', valid_until: 'offer_valid_until',
        invoice_info: 'invoice_info', kitchen_info: 'kitchen_info',
        notes: 'internal_notes', offer_note: 'offer_note',
    };

    const updates = {};
    for (const [inputKey, dbCol] of Object.entries(fieldMap)) {
        if (inputKey in b) updates[dbCol] = b[inputKey] ?? null;
    }

    // offer_block_metadata — validér JSON
    if ('offer_block_metadata' in b) {
        if (b.offer_block_metadata) {
            try {
                const parsed = typeof b.offer_block_metadata === 'string' ? JSON.parse(b.offer_block_metadata) : b.offer_block_metadata;
                if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Skal være et objekt');
                updates.offer_block_metadata = JSON.stringify(parsed);
            } catch (_) {
                return res.status(400).json({ error: 'offer_block_metadata skal være valid JSON-objekt' });
            }
        } else {
            updates.offer_block_metadata = null;
        }
    }

    // Update fields
    if (Object.keys(updates).length > 0) {
        const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const vals = [...Object.values(updates), id];
        db.prepare(`UPDATE bons SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...vals);

        for (const [col, newVal] of Object.entries(updates)) {
            const oldVal = existing[col];
            if (String(oldVal ?? '') !== String(newVal ?? '')) {
                logChange({
                    entityType: 'bon', entityId: id,
                    action: 'update', fieldName: col,
                    oldValue: String(oldVal ?? ''),
                    newValue: String(newVal ?? ''),
                    userId: req.session?.userId ?? null
                });
            }
        }
    }

    // Replace-all linjer.
    //
    // Fordi linjerne slettes og indsættes forfra, ejer payloadet dag-tilknytningen:
    // en linje uden `offer_day_id` bliver en fælles-linje ("alle dage"). Det er
    // korrekt for ét-dags-tilbud — de har ingen dage — men det betyder at en
    // klient der HAR dage skal sende feltet med hver gang, ellers falder alle
    // varer tilbage til at gælde alle dage. Dagene selv (`PUT /days`) er upåvirket.
    if (Array.isArray(b.lines)) {
        const days = resolveLineDayIds(id, b.lines);
        if (days.error) return res.status(400).json({ error: days.error });

        db.prepare('DELETE FROM bon_lines WHERE bon_id = ?').run(id);
        const insertLine = db.prepare(`
            INSERT INTO bon_lines (bon_id, block_type, grocy_recipe_id, product_name, category, quantity, unit, unit_price, cost_price, line_total, sort_order, notes, is_accessory, offer_day_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        b.lines.forEach((l, i) => {
            const qty = l.quantity ?? 1;
            const lineTotal = (l.unit_price != null && qty) ? qty * l.unit_price : null;
            insertLine.run(
                id, l.block_type ?? null,
                l.grocy_recipe_id ?? null, l.product_name ?? 'Ukendt',
                l.category ?? l.block_type ?? null,
                qty, l.unit ?? 'stk',
                l.unit_price ?? null, l.cost_price ?? null,
                lineTotal, l.sort_order ?? i,
                l.notes ?? null,
                l.is_accessory ? 1 : 0,
                days.ids[i]
            );
        });

        // Opdater total_units (kun kategorier i settings.unit_count_categories)
        recalcBonTotalUnits(db, id);
    }

    recalcTotal(db, id);

    broadcast('bon_updated', { id, bon_number: existing.bon_number, is_offer: true });
    const updated = getQuoteResponse(db, id);
    res.json(updated);
}));

function getQuoteResponse(db, id) {
    const bon = db.prepare('SELECT bon_number, offer_status FROM bons WHERE id = ?').get(id);
    return { id, quote_number: bon?.bon_number, status: bon?.offer_status };
}

// ─── DELETE /:id — slet tilbud (kun draft) ───────────────────────────────

router.delete('/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const q = db.prepare('SELECT id, offer_status, bon_number FROM bons WHERE id = ? AND is_offer = 1').get(id);
    if (!q) return res.status(404).json({ error: 'Tilbud ikke fundet' });
    if (q.offer_status !== 'draft') return res.status(400).json({ error: 'Kun kladder kan slettes' });

    db.prepare('DELETE FROM bon_lines WHERE bon_id = ?').run(id);
    db.prepare('DELETE FROM bons WHERE id = ?').run(id);
    logChange({ entityType: 'bon', entityId: id, action: 'delete', oldValue: q.bon_number, notes: 'Tilbud slettet', userId: req.session?.userId ?? null });
    res.json({ ok: true });
}));

// ─── PATCH /:id/status — skift offer_status ─────────────────────────────

router.patch('/:id/status', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { status } = req.body;

    // 'won' kan IKKE sættes direkte — kræver POST /:id/convert, som opretter
    // bonnen og låser bilaget. Uden den regel ville "vundet" kunne betyde to
    // forskellige ting: én med en bon bagved, én uden. Patch I (maj 2026, F68).
    const valid = ['draft', 'sent', 'lost', 'expired'];
    if (!status || !valid.includes(status)) {
        return res.status(400).json({
            error: 'Ugyldig status. Brug POST /:id/convert for at markere som won.'
        });
    }

    const q = db.prepare('SELECT id, offer_status, bon_number, offer_locked_at FROM bons WHERE id = ? AND is_offer = 1').get(id);
    if (!q) return res.status(404).json({ error: 'Tilbud ikke fundet' });
    if (q.offer_locked_at) return lockedResponse(res);

    const updates = { offer_status: status };
    if (status === 'sent') updates.offer_sent_at = new Date().toISOString();

    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE bons SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...Object.values(updates), id);

    logChange({
        entityType: 'bon', entityId: id,
        action: 'status_change', fieldName: 'offer_status',
        oldValue: q.offer_status, newValue: status,
        userId: req.session?.userId ?? null
    });

    broadcast('bon_updated', { id, bon_number: q.bon_number, is_offer: true });
    res.json({ id, status });
}));

// ─── POST /:id/convert — opret bon(s) ud fra tilbuddet ─────────────────

router.post('/:id/convert', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    // Hele rækken: bonnerne skal arve alt fra tilbuddet (kunde, tider,
    // betaling, noter), ikke bare de fire felter det gamle flag-flip havde
    // brug for.
    const q = db.prepare('SELECT * FROM bons WHERE id = ?').get(id);
    if (!q) return res.status(404).json({ error: 'Tilbud ikke fundet' });
    if (!q.is_offer) return res.status(400).json({ error: 'Denne bon er ikke et tilbud' });

    // Dobbelt-konvertering kendes på at der ALLEREDE står bons på tilbuddet —
    // ikke på at status er 'won'. Pipelinen kan trække et tilbud til "Vundet"
    // uden at oprette noget (routes/crm.js), og det tilbud skal stadig kunne
    // blive til en bon.
    const existing = db.prepare('SELECT bon_number FROM bons WHERE source_quote_id = ? ORDER BY id').all(id);
    if (existing.length) {
        return res.status(400).json({
            error: `Tilbuddet er allerede lavet om til ${existing.map(b => b.bon_number).join(', ')}`,
        });
    }

    return convertToBons(req, res, q, getOfferDays(id));
}));

// ─── POST /:id/unlock + /:id/lock — åbn og luk bilaget ─────────────────
//
// Oplåsning er en selvstændig handling med sit eget endpoint, ikke et felt man
// kan sende med i en PATCH. Ellers ville "ret prisen" og "bryd bilaget" kunne
// ske i samme kald, og changeloggen ville ikke kunne skelne dem.

router.post('/:id/unlock', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const q = db.prepare('SELECT id, bon_number, offer_locked_at FROM bons WHERE id = ? AND is_offer = 1').get(id);
    if (!q) return res.status(404).json({ error: 'Tilbud ikke fundet' });
    if (!q.offer_locked_at) return res.json({ id, locked: false });

    db.prepare('UPDATE bons SET offer_locked_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    logChange({
        entityType: 'bon', entityId: id,
        action: 'update', fieldName: 'offer_locked_at',
        oldValue: q.offer_locked_at, newValue: null,
        notes: 'Tilbuddet låst op — bilaget kan rettes igen',
        userId: req.session?.userId ?? null,
    });

    broadcast('bon_updated', { id, bon_number: q.bon_number, is_offer: true });
    res.json({ id, locked: false });
}));

router.post('/:id/lock', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);

    const q = db.prepare('SELECT id, bon_number, offer_locked_at FROM bons WHERE id = ? AND is_offer = 1').get(id);
    if (!q) return res.status(404).json({ error: 'Tilbud ikke fundet' });
    if (q.offer_locked_at) return res.json({ id, locked: true, locked_at: q.offer_locked_at });

    db.prepare('UPDATE bons SET offer_locked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    logChange({
        entityType: 'bon', entityId: id,
        action: 'update', fieldName: 'offer_locked_at',
        oldValue: null, newValue: 'locked',
        notes: 'Tilbuddet låst',
        userId: req.session?.userId ?? null,
    });

    broadcast('bon_updated', { id, bon_number: q.bon_number, is_offer: true });
    res.json({ id, locked: true });
}));

module.exports = router;
