/**
 * services/goodsReceiptWebhook.js
 * ════════════════════════════════════════════════════════════
 * Sender varemodtagelse-data til Whiteboard via webhook.
 * Kun fødevarekontrol-data — intet om Grocy eller varemængder.
 *
 * Asynkron, non-blocking. Fejl logges i webhook_log.
 *
 * Test-mode (NODE_ENV='test'): send() auto-mock'es — fanger kald i en
 * in-memory buffer i stedet for at lave HTTP-kald. Buffer eksponeres via
 * _getSentWebhooks() + _clearSentWebhooks() og bruges af test-mail-route
 * (T_VAREMOD_F_FAIL_05). Samme pattern som services/mailService.js.
 * ════════════════════════════════════════════════════════════
 */

const { getDb } = require('../db/database');

const _IS_TEST = process.env.NODE_ENV === 'test';
const _sentWebhooks = [];

/**
 * Er koblingen til Whiteboard tændt?
 *
 * Tom URL = `bonv2_only`-mode (spec §"Tre driftsmodes"). Det er et lovligt
 * valg — men det er også den tilstand der i praksis gjorde varemodtagelsen
 * usynlig: send() sprang stille over, og intet sted kunne man se hvorfor.
 * Derfor eksponeres tilstanden nu, så både API-svar og Settings kan vise den.
 *
 * @returns {string|null} URL'en, eller null når koblingen er slukket
 */
function getWebhookUrl() {
    try {
        const row = getDb().prepare(
            `SELECT value FROM settings WHERE key = 'whiteboard_webhook_url'`
        ).get();
        const url = (row?.value || '').trim();
        return url || null;
    } catch {
        return null;
    }
}

function isConfigured() {
    return getWebhookUrl() !== null;
}

/**
 * Den delte hemmelighed der lukker webhooken ind hos Whiteboard.
 *
 * Ligger i .env og ikke i settings-tabellen, af to grunde: modtageren har
 * ingen Settings-side og skal have værdien i SIN .env uanset hvad, så en
 * halvdel i browseren ville betyde at man kunne skifte den ene side og
 * bryde koblingen uden at opdage det. Og alle andre hemmeligheder i Bon v2
 * bor i .env (SMTP, ORS, Hørkram) — dev-databasen kopieres rundt til
 * analyse, hemmeligheder bør ikke følge med.
 *
 * @returns {string|null}
 */
function getWebhookSecret() {
    const secret = (process.env.GOODS_RECEIPT_WEBHOOK_SECRET || '').trim();
    return secret || null;
}

function isSecretConfigured() {
    return getWebhookSecret() !== null;
}

/**
 * Send webhook til Whiteboard (fire-and-forget fra POST-stien).
 *
 * Returnerer et resultat-objekt så kaldere der VENTER på den (gensend fra
 * listen og backfill-scriptet) kan fortælle hvad der skete. POST-stien
 * ignorerer returværdien og forbliver ikke-blokerende.
 *
 * @param {Object} receipt  - goods_receipts row fra DB
 * @param {string} userName - navn på modtager
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, statusCode?:number, error?:string}>}
 */
async function send(receipt, userName) {
    // Test-mode: fang kald i in-memory buffer og returner tidligt.
    // Ingen HTTP-trafik, ingen DB-skrivning til webhook_log.
    if (_IS_TEST) {
        _sentWebhooks.push({
            receipt_id: receipt.id,
            receipt_number: receipt.receipt_number,
            user_name: userName,
            supplier_name: receipt.supplier_name,
            captured_at: new Date().toISOString(),
        });
        return { ok: true, mode: 'test' };
    }

    const db = getDb();

    const webhookUrl = getWebhookUrl();

    // bonv2_only mode — registreringen ligger kun i Bon v2.
    if (!webhookUrl) return { ok: false, skipped: true, reason: 'not_configured' };

    // Map Bon v2's deviation_type til Whiteboard-skemaets select-options.
    // Tabellen bor i receiptSchema.js sammen med den modsatte retning —
    // frontenden bruger samme oversættelse når den bygger valgene fra skemaet,
    // og to kopier ville før eller siden blive to forskellige tabeller.
    const deviationMap = require('./receiptSchema').DEVIATION_TO_WHITEBOARD;

    const data = {
        date_ok:         !!receipt.date_check_ok,
        label_ok:        !!receipt.labeling_check_ok,
        packaging_ok:    !!receipt.packaging_check_ok,
        deviation:       receipt.has_deviation
            ? (deviationMap[receipt.deviation_type] || 'other')
            : 'none',
        deviation_note:  receipt.deviation_note || null,
        photo_path:      receipt.photo_path
            ? `https://bon.ristetrug.dk${receipt.photo_path}`
            : null,
        bon_v2_receipt_id:     receipt.id,
        bon_v2_receipt_number: receipt.receipt_number,
    };

    // Temperaturer sendes kun når toggle er aktiv — Whiteboard beregner
    // temperature_ok/_status selv via limit_max i skemaet.
    //
    // Produktnavnet følger sin temperatur: er toggle slået fra, er der intet
    // målt og dermed heller ikke noget at have målt PÅ. Feltnavnene er
    // tavlens egne id'er (whiteboard migration 026), så FVST-loggen viser
    // dem uden at nogen skal oversætte noget.
    if (receipt.temperature_cool_enabled) {
        data.temperature = receipt.temperature_cool_value;
        if (receipt.temperature_cool_product) {
            data.temp_product = receipt.temperature_cool_product;
        }
    }
    if (receipt.temperature_frozen_enabled) {
        data.temperature_freezer = receipt.temperature_frozen_value;
        if (receipt.temperature_frozen_product) {
            data.temp_product_freezer = receipt.temperature_frozen_product;
        }
    }

    // Felter tavlen har i skemaet, som Bon v2 ikke har en egen kolonne til.
    // De blev filtreret mod skemaet ved modtagelsen, så det er tavlens egne
    // felt-id'er der står her — derfor kan de lægges direkte i data.
    //
    // Skrives FØR de kendte felter ville de kunne overskrive dem; derfor
    // sættes de kun hvor der ikke allerede står noget. Et defekt skema skal
    // ikke kunne slette en temperatur på vej til FVST-loggen.
    if (receipt.extra_fields_json) {
        try {
            const extra = JSON.parse(receipt.extra_fields_json);
            for (const [key, value] of Object.entries(extra || {})) {
                if (!(key in data)) data[key] = value;
            }
        } catch (err) {
            console.warn('[webhook] extra_fields_json kunne ikke læses for receipt',
                receipt.id, '—', err.message);
        }
    }

    const payload = {
        schema_name: 'varemodtagelse',
        user: userName,
        supplier: receipt.supplier_name,
        data,
    };

    // occurred_at: hvornår varen blev modtaget. Sendes ALTID.
    //
    // Første udgave sendte det kun når bilaget var baguddateret, ud fra at
    // "nu" ellers er det rigtige tidspunkt og tavlens datetime('now') derfor
    // ramte plet. Det holder kun når kaldet sker i samme sekund som
    // registreringen. Ved en gensendelse — efter nedetid, efter en fejl, efter
    // en login-gate der slugte sytten bilag — er "nu" uger forkert. Ti
    // modtagelser tilbage til 18. maj landede som 17. august i FVST-loggen.
    //
    // Afsenderen kender tidspunktet. Så send det, hver gang.
    //
    // To formater, fordi received_at bærer to slags sandhed:
    //   baguddateret  → kun datoen. Klokkeslættet er opdigtet (12:00 sat af
    //                   POST-ruten), og tavlen sætter selv middag så datoen
    //                   lander rigtigt i begge tidszoner.
    //   almindelig    → hele tidsstemplet. Kolonnen er skrevet af SQLites
    //                   CURRENT_TIMESTAMP og er altså UTC, deraf 'Z'.
    //
    // Skelnen sker mod created_at, ikke mod dagens dato: de to kolonner
    // skrives af samme sætning ved en almindelig modtagelse, så de er ens
    // uanset tidszone. Sammenlignede vi med todayISO(), ville en modtagelse
    // mellem midnat og kl. 2 se baguddateret ud.
    const receivedRaw  = String(receipt.received_at || '');
    const receivedDate = receivedRaw.slice(0, 10);
    const createdDate  = String(receipt.created_at || '').slice(0, 10);
    if (receivedDate) {
        payload.occurred_at = (createdDate && receivedDate !== createdDate)
            ? receivedDate
            : receivedRaw.replace(' ', 'T') + 'Z';
    }

    let statusCode = null;
    let error = null;

    // Modtagerens webhook-sti ligger uden for login-gaten og lukker kun op
    // for den der kender hemmeligheden. Mangler den, sender vi alligevel —
    // så svaret bliver et 401 vi kan forklare, i stedet for en tavshed her
    // på afsenderens side.
    const secret = getWebhookSecret();
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers['X-Webhook-Secret'] = secret;

    try {
        // redirect: 'manual' er ikke en detalje — det er hele forskellen på
        // "sendt" og "det så ud som om".
        //
        // whiteboard.ristetrug.dk lå bag en login-gate i nginx, som svarede
        // 302 → bon.ristetrug.dk/login.html. fetch() følger som standard en
        // omdirigering og laver POST om til GET, så kaldet endte på vores egen
        // login-side, der svarer 200. response.ok var true, receiptet blev
        // stemplet som sendt, og loggen viste en pæn 200 — mens FVST-loggen
        // aldrig så leverancen. Sytten registreringer stod som "alle sendt".
        //
        // En omdirigering er aldrig et gyldigt svar på en webhook: modtageren
        // er en maskine uden session. Nu fejler den højlydt og siger hvorhen.
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            redirect: 'manual',
            signal: AbortSignal.timeout(10000), // 10s timeout
        });

        statusCode = response.status;

        if (statusCode >= 300 && statusCode < 400) {
            const target = response.headers.get('location') || 'ukendt mål';
            error = `HTTP ${statusCode}: omdirigeret til ${target} — `
                  + 'modtageren kræver login. Webhooken har ingen session og kan '
                  + 'aldrig komme igennem en login-gate.';
            console.warn(`[webhook] Whiteboard omdirigerede ${receipt.receipt_number}:`, error);
        } else if (response.ok) {
            // Success — marker som synced
            db.prepare(`UPDATE goods_receipts SET whiteboard_synced_at = datetime('now') WHERE id = ?`)
                .run(receipt.id);
            console.log(`[webhook] Whiteboard notificeret for ${receipt.receipt_number}`);
        } else {
            error = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;

            // Et 401/403 på webhook-stien betyder næsten altid at de to
            // .env-filer ikke er enige. Sig det, i stedet for at lade
            // driften gætte ud fra en statuskode.
            if (statusCode === 401 || statusCode === 403) {
                error += secret
                    ? ' — Whiteboard afviste hemmeligheden. Tjek at '
                      + 'GOODS_RECEIPT_WEBHOOK_SECRET er den SAMME i begge .env-filer.'
                    : ' — GOODS_RECEIPT_WEBHOOK_SECRET mangler i Bon v2\'s .env, '
                      + 'så kaldet blev sendt uden legitimation.';
            }
            console.warn(`[webhook] Whiteboard fejl for ${receipt.receipt_number}:`, error);
        }
    } catch (err) {
        error = err.message;
        console.warn(`[webhook] Whiteboard utilgængelig for ${receipt.receipt_number}:`, err.message);
    }

    // Log i webhook_log uanset resultat
    try {
        db.prepare(`
            INSERT INTO webhook_log (url, payload, status_code, error, sent_at)
            VALUES (?, ?, ?, ?, datetime('now'))
        `).run(
            webhookUrl,
            JSON.stringify(payload),
            statusCode,
            error
        );
    } catch (logErr) {
        console.error('[webhook] Kunne ikke logge webhook:', logErr.message);
    }

    return { ok: !error, statusCode, error };
}

function _getSentWebhooks() {
    return _sentWebhooks.slice();
}

function _clearSentWebhooks() {
    _sentWebhooks.length = 0;
}

module.exports = {
    send, isConfigured, getWebhookUrl, isSecretConfigured,
    _getSentWebhooks, _clearSentWebhooks,
};
