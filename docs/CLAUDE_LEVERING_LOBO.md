# CLAUDE_LEVERING_LOBO.md
## Byekspressen-integration (Lobo API v3.1) — booking fra logistik-modulet

> **Status:** Spec klar (rev. 2 — verificeret mod den publicerede Lobo-dokumentation 3. juni 2026) · ikke implementeret
> **Zone:** logistik · **Provider:** Byekspressen via Lobo API v3.1
> **Læs først:** `BON_V2_PRINCIPPER.md` (moms sekt. 6b+6c), `bon_v2_datamodel_v2.md`, `bon_v2_zoner_og_layout.md`, `docs/delivery/CLAUDE_DELIVERY_SPOR2.md`
> **Mockup:** `levering_byexpressen_lobo_mockup_v3.html` (kun retningsgivende — pris-JS bruger magisk `*1.25`, må IKKE kopieres; brug `shared/moms.js`)
> **API-reference (fixture):** `tests/fixtures/lobo/lobo_api_docs.json` (offentlige Postman-docs, 157 requests m. bodies/responses — kilde til alle shapes nedenfor)
> **Probe-værktøj:** `scripts/lobo-probe.js` (read-only discovery, læser creds fra env)

---

## 0. Hvad ændrede sig fra rev. 1 (verificeret mod docs/probe)

Rev. 1 var skrevet før Spor 1+2 og før API'et var afdækket. Følgende er rettet:

| Rev. 1 antog | Virkeligheden (verificeret) |
|--------------|------------------------------|
| Ny tabel `delivery_bookings` | **Findes ikke. Genbrug** `bons` (delivery_cost/_price/courier_provider/delivery_vehicle_id) + `delivery_events` + `snapshot_json`. |
| Config + creds i `settings` | Config i **`delivery_vehicles.booking_api_config_json`** på By-expressen-vognen (kolonnen findes); secret i **`.env`** (følger Grocy-mønstret korrekt). |
| Booking pr. "logistik-kø-enkeltlevering" | **Én bon = ét stop pr. Lobo-ordre.** Booking sker bag den eksisterende popout-knap pr. bon/stop (Spor 1/2). |
| Webhook: JSON-body + `?secret=` | **Query-params** `?ts=&event=&target=order&orderuuid=` + **HMAC-SHA256** (per-webhook `hmac_key`) + valgfri `header_authorization`. |
| Events: assigned/picked_up/delivered/failed | Reelle: `order.created/dispatched/changed/stopvisitedorsigned/finished/deleted/approved/accounted`. |
| Margin < 0 → hård blokering af knap | **Advarsel, aldrig blokering** (jf. delivery-princippet: office bestemmer). |
| Base `groupnet.at` | `byexpressen.lobolink.eu` (groupnet.at er alias). |
| Pris fra hardkodet model | **Ingen hardcode** — Lobo beregner; vi henter via orderdraft-tilbud (§8). |

---

## 1. Låste beslutninger

| Beslutning | Værdi |
|------------|-------|
| Booking-surface | **Logistik + bon-drawer**, bag eksisterende "Bestil bud"-popout. `booking_method='api'` på vognen gør knappen til et API-kald i stedet for clipboard. |
| Granularitet | **Én bon = ét stop = én Lobo-ordre** (HQ pickup + kundens leverings-stop). |
| Prisafdækning | **orderdraft som live-tilbud** (§8) — Lobo beregner, vi committer kun ved OK margin. Hardcode aldrig priser. |
| Ordreoprettelse | `POST /orders` **atomisk** (stops + ordersurchargequantities embedded) for kendte ordrer; orderdraft-flowet bruges til pris-tjek først. |
| Status | **Webhook** (queryparams + HMAC), `GET /orders/{uuid}` som fallback. |
| Margin-regel | Advarsel ved `kundepris_ex < kostpris_ex`. **Blokerer ikke.** |
| Fallback | Manuel popout (Spor 1) bevares — bruges hvis API fejler / sandbox / margin afvist. |
| Miljø | **Sandbox først**, derefter produktiv. Sandbox var nede 3. juni 2026 (skal verificeres oppe igen). |

---

## 2. Endpoints & auth

| Miljø | Base-URL |
|-------|----------|
| Produktiv | `https://byexpressen.lobolink.eu/lobo/api/v3/public/` |
| Sandbox | `https://byexpressen.lobolink.eu/lobo/sandbox/api/v3/public/` |

- **Auth:** `POST /token` med **HTTP Basic Auth** (user+pass) **OG en JSON-body = array af ønskede scopes** → `201 {status:"ok", token}` (JWT). Verificeret live.
- **VIGTIGT (verificeret 4. juni 2026):** scopes ANMODES i token-body'en. Sender man ingen body → token får `scope:[]` → 403 på ALT. Serveren giver snittet af (anmodet, tilladt-i-frontend). `getToken()` sender derfor altid scope-arrayen (`DEFAULT_BOOKING_SCOPES`).
- Alle øvrige kald: `Authorization: Bearer <token>`.
- **Token-levetid ~10 min** (bekræftet). **Streng rate-limit på `/token`**, relaxed på auth'ede kald → cache token, re-auth kun ved expiry/401.
- **Granted scopes (live 4. juni 2026): 31/38.** IKKE tilladt: `order.delete`, `payment.read`, `statistic.read`, `place.read:all`, `embed.place:jcard`, `order.create:in_the_past`, `orderdrafts.order:in_the_past`. → `order.delete` mangler ⇒ **cancel-via-API virker ikke endnu** (bed Lobo slå den til).
- Konventioner: svar pakkes i `{data:[...], meta:{count,totalcount}}`. Bool = int 0/1. Datoer ISO-8601 (`2022-06-14T20:41:42+02:00`). Filtrering `?prop[eq]=`, paging `?_offset=&_limit=`, embed `?_embed=`.

---

## 3. Arkitektur

```
LOGISTIK / BON-DRAWER (Bestil bud, booking_method='api')
  │
  ▼
services/byExpressenAdapter.js ──────► Lobo API v3.1 (byexpressen.lobolink.eu)
  │  token-cache · verifyAddress · getProducts · priceQuote(orderdraft)
  │  bookOrder · getOrder · cancelOrder · downloadPod · registerWebhook
  ▼
bons (delivery_cost/_price/courier_provider/delivery_vehicle_id/external ref)
delivery_events (booked|assigned|picked_up|delivered|failed|cancelled) + snapshot_json
  ▲
  │  GET /api/webhooks/lobo?ts=&event=&target=order&orderuuid=  (HMAC-signeret)
  ▼
SSE: delivery_event {bon_id, ...}  →  logistik + bon-kort-strip
```

Adapteren er **søskende til `grocyAdapter.js`/`hokaAdapter.js`** — eneste sted der taler med Lobo.

---

## 4. Config

**Per-vogn** i `delivery_vehicles.booking_api_config_json` (By-expressen-vognen, `code='byekspressen'`; skift `booking_method` `manual_clipboard` → `api`):

```json
{
  "provider": "lobo",
  "base_url": "https://byexpressen.lobolink.eu/lobo/api/v3/public/",
  "sandbox_url": "https://byexpressen.lobolink.eu/lobo/sandbox/api/v3/public/",
  "use_sandbox": true,
  "customernumber": 18062101,   // RR's kundenummer (de bruger customernumber, ikke fkcustomer)
  "fkproduct": 39,              // Kbh-cykelbud (fra RR's egen eksempel-ordre)
  "hq_fkplace": 3233,           // Ristet Rug (Nørrebro) som gemt place
  "fkpayment": null             // valgfri — udelades hvis null (RR-eksemplet sætter den ikke)
}
```
> Værdierne er bekræftet **live** (productive `GET /products`/`/surcharges` 4. juni 2026):
> `fkproduct: 39` = produktet **"Food"** (det RR bruger). Ekstra-kasse-tillæg for Food =
> **`fksurcharge: 389`** ("størrelsestillæg", `unitcost: 50`); lørdagslevering = `273`.
> `payment.read` er ikke tilladt → `fkpayment` kan ikke læses, men er valgfri (RR sætter den ikke).
> `scopes` udelades typisk fra config (adapteren bruger `DEFAULT_BOOKING_SCOPES`); sæt kun for at override.

**Secret i `.env`** (aldrig i settings/frontend):
```
BY_EKS_USWER=ristetrug18062101     # (eksisterende nøglenavn — typo bevaret)
BY_EX_CODE=<password>
```
> Adapteren læser creds fra `.env`, resten fra `booking_api_config_json`. Webhook-HMAC-nøgler gemmes ved registrering (§10), fx i en settings-key pr. event eller i config-json.

---

## 5. Adapter-interface — `services/byExpressenAdapter.js`

| Metode | Lobo-kald | Returnerer / gør |
|--------|-----------|------------------|
| `getToken()` | `POST /token` (Basic Auth) | JWT fra modul-cache; re-auth kun ved expiry/401 |
| `verifyAddress({street,housenumber,zip,city,isocode})` | `POST /addresses/verify` | LOBO-internt format inkl. `fkplace` (krævet før stop) |
| `autocomplete(q)` | `GET /addresses/autocomplete/streetsandplaces?querystring=` | Adresseforslag |
| `getProducts()` | `GET /products?_embed=timemodel,surcharges,pricescales` | Produkter + priskala (V2 + estimat) |
| `getPayments()` | `GET /payments` | `fkpayment`-værdi |
| `priceQuote(payload)` | `POST /orderdrafts` (+ evt. `GET …?_embed=accounting`) | `{ cost_ex, cost_incl, routedistance, co2saving, uuid }` — **`costtotal_net` direkte fra svaret** (se §8). Lader draft udløbe (5 min) eller `DELETE`. |
| `buildOrderPayload(input)` | (ren funktion) | Bygger body: `customernumber`+`fkproduct`+`stops[]` (fkplace eller inline-adresse)+`external_api_id`+evt. `ordersurchargequantities`. |
| `extractCostEx(order)` | (ren funktion) | Læser `costtotal_net` (top-niveau eller `accounting`). |
| `bookOrder(payload)` | `POST /orders` (atomisk, embedded stops+surcharges) | `{uuid, numberformatted, ...}` — hele svaret som snapshot |
| `convertDraft(uuid)` | `PUT /orderdrafts/{uuid}/order` | (alt. flow) draft → rigtig ordre |
| `getOrder(uuid)` | `GET /orders/{uuid}?_embed=stops,downloadlinks,dispatchedto` | Status/fallback hvis webhook svigter |
| `cancelOrder(uuid)` | `DELETE /orders/{uuid}` | 204 ved succes; fejler hvis ordren er **locked** |
| `downloadPod(uuid)` | `GET /downloads/order/pod/{uuid}` (+ `/downloads/stop/signatures/{fkstop}`, `/downloads/stop/pictures/{fkstop}`) | POD-pdf / signatur / foto |
| `registerWebhook(event, url, headerAuth?)` | `POST /webhooks` | `{id, hmac_key, hmac_algorithm}` — **gem `hmac_key`** |
| `listWebhooks()` / `deleteWebhook(id)` | `GET` / `DELETE /webhooks` | Opsætnings-vedligehold |

**Token-cache:** modul-niveau `{token, expiresAt}`. Returnér cached hvis `now < expiresAt − 30s`. Ved `401`: én re-auth + retry.

---

## 6. Database — genbrug (ingen ny tabel)

| Felt | Tabel | Bruges til |
|------|-------|-----------|
| `delivery_cost` | `bons` | Lobo-kostpris (ex moms) — det vi betaler |
| `delivery_price` | `bons` | Kundepris (ex moms) — standardmodel |
| `courier_provider` | `bons` | `'byekspressen'` |
| `delivery_vehicle_id` | `bons` | By-expressen-vognen |
| `delivery_cost_source` | `bons` | `'api'` (CHECK tillader allerede) |
| `external_reference` | `delivery_events` | Lobo order-`uuid` |
| `provider` / `event_type` / `notes` / `event_time` | `delivery_events` | event-log (CHECK matcher allerede: booked/assigned/picked_up/delivered/failed/cancelled) |

**`snapshot_json`:** hele Lobo-svaret (order + verificeret adresse + pris-snapshot) skal gemmes. `delivery_events` har ikke et JSON-felt → **ny migration**: `ALTER TABLE delivery_events ADD COLUMN snapshot_json TEXT;` (eller på `bons`). Verificér før kodning.

> Lobo-ordren kan også bære **vores** reference: sæt `external_api_uuid`/`external_api_data` i `POST /orders`-body → vores bon-id ligger hos Lobo (to-vejs kobling).

---

## 7. Booking-flow (logistik / bon-drawer)

```
1. Bon med leveringsmetode = By-expressen, ingen aktiv booking.
2. Adresse: stop kan gives som INLINE-adresse (street/housenumber/zip/city/contactperson)
   — Lobo resolver selv. verifyAddress() er VALGFRI (brug ved tvivlsom adresse →
   fkplace + grøn "verificeret"). RR's eget eksempel sender inline uden verify.
3. priceQuote(bon)  → POST /orderdrafts (HQ fkplace=3233 pickup + kunde-stop + surcharges)
        → læs costtotal_net (kostpris ex moms) direkte fra svaret  (§8)
4. kundepris_ex = standardmodel (Settings)   [se §8]
5. MARGIN-VAGT (§9): margin = kundepris_ex − kostpris_ex
        margin < 0 → vis ADVARSEL (rød), men book-knap forbliver aktiv
6. "Book hos Byekspressen":
     a) draft-flow:  PUT /orderdrafts/{uuid}/order        (genbrug draften fra trin 3)
     b) eller atomisk: POST /orders (stops + ordersurchargequantities embedded)
7. Skriv:  bons.delivery_cost/_price/courier_provider/delivery_vehicle_id/delivery_cost_source='api'
           delivery_events (event_type='booked', external_reference=uuid, snapshot_json=svar)
8. SSE delivery_event {bon_id, external_reference, status:'booked'}  → kø + strip
```

**Dobbeltbooking:** har bonnen allerede en aktiv (ikke-cancelled) booking → vis eksisterende, blokér ny.
**Fallback:** API-fejl / sandbox-nede / margin afvist af bruger → tilbyd den manuelle popout (Spor 1).

**`POST /orders`-body (verificeret skabelon — se fixturen for fuldt eksempel):**
```json
{
  "fkcustomer": 18062101,
  "fkproduct": <cykelbud-id>,
  "fkpayment": <payment-id>,
  "reftime": "<ISO leveringstid>",
  "customerreferenceorder": "<bon_number>",
  "notepublic": "<leveringsinstruks>",
  "noteinhouse": "",
  "stops": [
    { "position": 1, "fkplace": <hq_fkplace> },
    { "position": 2, "fkplace": <kunde_fkplace fra verifyAddress>,
      "tw_fixed_end": "<ISO seneste leveringstid>", "notepublic": "<etage/kode>" }
  ],
  "ordersurchargequantities": [ { "fksurcharge": <id>, "quantity": <ekstra-kasser> } ]
}
```

---

## 8. Pris & moms — orderdraft som live-tilbud (ingen hardcode)

**Princip:** Lobo ejer kostprisen. Vi spørger, før vi forpligter os.

```
POST /orderdrafts (samme body som order)   → uuid + Lobo beregner pris i SVARET
  → læs costtotal_net (ex moms) direkte fra draft-svaret
  margin OK?  → PUT /orderdrafts/{uuid}/order    (committer, inden 5 min)
  ellers      → DELETE /orderdrafts/{uuid}        (eller lad udløbe)
```

- **Kostpris = `costtotal_net`** (ex moms) — Lobo leverer et færdigt felt på ordren/draften.
  Verificeret mod RR's egen ordre: `costtotal_net: 90`, `costtotal_gross: 112.5`,
  `vatrate: 25`, `vat: 22.5` (+ `routedistance`, `co2saving`). **Ingen formel, ingen
  kalibrering** — feltet er autoritativt. Ligger på top-niveau eller under embedded
  `accounting` → `extractCostEx()` tjekker begge.
- **Kundepris** = standardmodel i Settings (`delivery_std_price_ex` + `extra_box_price_ex × max(0, kasser−inkluderet)`). Dette er hvad vi opkræver kunden, uafhængigt af Lobos kostpris.
- **Bonus:** `co2saving` fra samme svar kan fødes til CO2-modulet (jf. `docs/CLAUDE_CO2.md`).
- **Moms:** alle DB-felter ex moms i bon-domænet undtagen visning. Fakturalinje for levering: `unit_price` **incl moms** (moms-doktrin §6b) → brug `shared/moms.js` `exclToIncl()`. **Ingen `*1.25`** (pre-commit-hook blokerer).
- Enhver prisvisning labels med ex/incl — aldrig bare "Total".

---

## 9. Margin-regel (advarsel, ikke blokering)

```js
const { inclToExcl, exclToIncl } = require('../shared/moms');
const included  = settings.delivery_included_boxes;            // fx 2
const extra     = Math.max(0, boxCount - included);
const customerEx = settings.delivery_std_price_ex + extra * settings.delivery_extra_box_price_ex;
const quote      = await adapter.priceQuote(payload);         // orderdraft → costtotal_net
const costEx     = quote.cost_ex;                             // Lobos kostpris ex moms
const margin     = customerEx - costEx;
if (margin < 0) {
  // VIS rød advarsel "vi taber på leveringen" — men book-knappen forbliver aktiv.
  // Office bestemmer (kunder betaler nogle gange for dyr levering).
}
```

---

## 10. Webhook — `GET /api/webhooks/lobo`

| Aspekt | Beslutning (verificeret) |
|--------|--------------------------|
| Transport | Lobo kalder vores URL med **query-params**: `?ts=<unix>&event=<event>&target=order&orderuuid=<uuid>`. Ingen JSON-body. |
| Metode | Som konfigureret ved registrering (typisk GET med queryparams). |
| Sikkerhed | **HMAC-SHA256** med per-webhook `hmac_key` (returneres ved `POST /webhooks`). Verificér signatur. Sæt evt. også `header_authorization` ved registrering for ekstra lag. **Ingen session** (system-til-system). |
| Opsætning | Engangs `registerWebhook(event, url)` pr. relevant event → **gem `hmac_key`** pr. webhook. |
| Detaljer | Webhooken giver kun `orderuuid` → `GET /orders/{uuid}?_embed=stops,dispatchedto` for status/POD/stop-tilstand. |
| Idempotens | Dedupe på `(orderuuid, event, ts)`. |
| SSE | `delivery_event {bon_id, external_reference, status}` (polymorft → semantisk FK-navn, jf. konvention; **ikke** `bon_*`). |
| Fallback | `getOrder(uuid)` kan poll'es manuelt fra logistik. |

**Event-mapping (live `GET /webhookevents` 4. juni 2026 — 7 events):**

| Lobo-event | `delivery_events.event_type` | UI-strip |
|------------|------------------------------|----------|
| `order.dispatched` | `assigned` | Tildelt bud |
| `order.stopvisitedorsigned` | `picked_up` / `delivered` (disambiguér via `GET /orders/{uuid}` stop-tilstand: position 1 = afhentet, sidste = leveret) | Afhentet / Leveret |
| `order.finished` | `delivered` | Leveret (+ POD via `/downloads`) |
| `order.trashed` / `order.withdrawn` | `cancelled` | Annulleret |
| `order.changed` | (note-event, opdatér snapshot) | — |
| `order.accounted` | (regnskab — valgfrit) | — |

> Live-events afviger fra de generiske docs: der er **ingen** `order.created`/`order.deleted`/`order.approved` live — i stedet `order.trashed`/`order.withdrawn`. Vi logger selv `booked` ved oprettelse (intet created-event at lytte på). `failed` reserveres til vores egne booking-fejl. EVENT_MAP beholder doc-navnene som harmløs fallback.

---

## 11. Afbestilling & status-triggers

- Logistik/drawer "Afbestil bud" → `cancelOrder(uuid)` (`DELETE /orders/{uuid}`):
  - **OBS:** `order.delete`-scope er IKKE tilladt live (4. juni 2026) → kald giver 403 indtil Lobo slår den til. Indtil da: cancel falder tilbage til manuel popout / "ring til Byekspressen".
  - 204 → `delivery_events (cancelled)`, ryd vogn-tildeling, SSE. (Genbrug `services/delivery_log.js cancelBooking()`.)
  - Ordren **locked** → API afviser → "ring til Byekspressen" + log `failed`/note-event.
- Eksisterende AFLYST-trigger: hvis bonnen har aktiv Lobo-booking → kald `cancelOrder()`.
- `delivery_cost` (faktisk pris) bevares ved cancel (faktura ikke tabt) — jf. Spor 1.

---

## 12. Edge cases

| Case | Håndtering |
|------|-----------|
| Token udløbet / 401 | Re-auth én gang + retry |
| `/token` rate-limit (429) | Token kun ved expiry; backoff |
| `403 Not in scope` | Manglende scope i frontend (§14) — log tydeligt, fald tilbage til popout |
| Adresse-verify fejler | Blokér booking; autocomplete + manuel korrektion |
| orderdraft udløber (5 min) før convert | Re-POST draft eller brug atomisk `POST /orders` |
| Lobo-ordre locked ved cancel | Fallback-besked + log event |
| Sandbox nede (500) | Tydelig fejl; brug popout indtil oppe |
| Margin < 0 | Advarsel — book stadig muligt |
| Webhook-dublet | Idempotens-dedupe på (uuid,event,ts) |
| HMAC-mismatch | Afvis webhook (401), log |

---

## 13. Test

- `node:test` adapter-unit mod **fixturen** `tests/fixtures/lobo/lobo_api_docs.json` + mocked `fetch`: token-cache, verifyAddress, priceQuote (orderdraft), bookOrder-body, margin-regel, webhook-HMAC-verifikation, event-mapping.
- Integration mod **sandbox** (når oppe): verifyAddress → orderdraft → margin → convert/cancel → webhook (T_DELIVERY_LOBO-track).
- Playwright: drawer/logistik booking-UI (margin-advarsel vises men spærrer ikke, status-strip på SSE).
- `scripts/lobo-probe.js`: kør med scopes for at fange live produkt/pris-værdier.

---

## 14. Implementeringscheckliste

### Fase 0 — Klar / blokeret
- [x] Sandbox + produktiv URL (`byexpressen.lobolink.eu`)
- [x] User + password (`.env`: `BY_EKS_USWER`/`BY_EX_CODE`), kundenr `18062101`
- [x] Auth-kontrakt verificeret (`POST /token` Basic + scope-body → 201)
- [x] API-shapes afdækket (fixture)
- [x] **Scopes virker** — anmodes i token-body; 31/38 tilladt live (4. juni 2026). Læse-/booking-kald verificeret (`GET /products` → 200).
- [x] **(V2)** `fkproduct: 39` (Food) + ekstra-kasse `fksurcharge: 389` (50 kr) bekræftet live.
- [ ] **Bed Lobo slå `order.delete` til** (mangler) — ellers virker cancel-via-API ikke. (Også `payment.read`/`statistic.read` hvis vi vil bruge dem.)
- [ ] **Sandbox oppe** igen (var 500 d. 3. juni 2026) — til write-/webhook-test.

**Scopes adapteren anmoder om (`DEFAULT_BOOKING_SCOPES`) — server giver snittet med frontend:**
```
embed.order:accounting · embed.order:downloadlinks · address.verify
address.autocomplete:streets_and_places · product.read · surcharge.read · pricescale.read
order.read · order.create · order.edit · order.delete
orderdraft.read · orderdraft.create · orderdraft.order · orderdraft.delete
ordersurchargequantity.read · ordersurchargequantity.set · orderpricescalequantity.read
stop.read · stop.create · customer.read · place.read:used_before
webhook.read · webhook.create · webhook.delete · webhookevent.read
```

### Fase A — Adapter (sandbox)
- [ ] `byExpressenAdapter.js`: `getToken()` + cache
- [ ] `verifyAddress` · `autocomplete` · `getProducts` · `getPayments` · `priceQuote`
- [ ] Config: `booking_api_config_json` på vognen + `.env`-creds
- [ ] Unit-tests mod fixture

### Fase B — Booking
- [ ] `priceQuote()` via orderdraft + margin-vagt (§8/§9)
- [ ] `bookOrder()` (atomisk `POST /orders`) + draft-convert
- [ ] Skriv `bons` + `delivery_events` + `snapshot_json` (ny migration verificeret)
- [ ] `booking_method='api'` gør "Bestil bud"-popout til API-kald + fallback til manuel

### Fase C — Webhook
- [ ] `GET /api/webhooks/lobo` + HMAC-SHA256-validering + idempotens
- [ ] `registerWebhook()` engangs pr. event + gem `hmac_key`
- [ ] Event-mapping → `delivery_events` + `getOrder` for stop-detaljer + SSE
- [ ] Strip + kø-tag opdaterer live

### Fase D — POD + cancel
- [ ] `cancelOrder()` + AFLYST-trigger (genbrug `delivery_log.cancelBooking`)
- [ ] `downloadPod()` + POD-link i UI
- [ ] (valgfrit) co2savings fra `/statistics/byinterval`

### Fase E — Go-live
- [ ] `use_sandbox` → false
- [ ] Smoke-test: én rigtig minimal ordre + cancel
- [ ] Opdater `CLAUDE.md` → modul i produktion

---

## 15. Åbne punkter til Leif

| Punkt | |
|-------|--|
| Bed Lobo slå `order.delete` til (mangler) — ellers ingen cancel-via-API | ⏳ |
| Sandbox 500 — Jürgen skal fikse før write-/webhook-test | ⏳ |
| ~~Login til frontend for scopes~~ — løst: scopes anmodes i token-body, 31/38 virker live | ✅ |
| Leveringslinje på faktura: incl moms vs. intern ex — bekræft reconciliation (V6) | ⏳ |
| Skal ekspres-/ladcykel-produkter være valgbare i UI, eller kun std-cykelbud? | ⏳ |
| `delivery_std_price_ex` / `extra_box_price_ex` / `included_boxes` — bekræft værdier i Settings | ⏳ |
