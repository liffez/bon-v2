# CLAUDE_CRM_MOBIL_HISTORIK.md — Aktivitetshistorik på mobil kundedetalje
> Læs `CLAUDE.md`, `mobile/views/crm.js` og `bon_v2_nano_crm_tables.sql` FØR du starter.
> Opdateret: maj 2026

---

## Formål

På mobil CRM → fanen **Kunder** → vælg en kunde, vises i dag stats, typiske produkter,
seneste ordrer og en "Log samtale"-formular. Den manglende brik er en **historik** — så
man kan se tidligere noter, opkald, mails og tilbud før man trykker 📞 Ring.

Service calls-fanen er ikke berørt af denne opgave.

---

## Arkitektur

```
Mobil CRM → Kunder → tap på kunde
        ↓
_mcShowCustomer(customerId)
        ↓  Promise.all (3 kald i stedet for 2)
        ├─ GET /api/crm/customer/:id           (eksisterende)
        ├─ GET /api/crm/customer-orders/:id    (eksisterende)
        └─ GET /api/crm/customer-activities/:id?limit=20   ← NY
        ↓
Render i denne rækkefølge:
  1. Kunde-header (urørt)
  2. Stats-strip (urørt)
  3. HISTORIK ← NY sektion
  4. Typiske produkter (urørt)
  5. Seneste ordrer (urørt)
  6. Log samtale (urørt)
```

Default vises 3 nyeste aktiviteter. "Vis alle X aktiviteter ▾" expander listen
i samme view (ingen ekstra navigation, ingen tabs).

---

## Skema-verificering inden start

`mobile/views/crm.js` POSTer i dag følgende felter til `/api/crm/activity`:
`type`, `text`, `result`, `sentiment`, `purpose_id`, `due_at`, `customer_id`, `bon_id`.

`bon_v2_nano_crm_tables.sql` viser kun: `id, customer_id, bon_id, type, text,
due_at, done_at, owner_user_id, created_at`.

Det betyder at `result`, `sentiment`, `purpose_id` enten er tilføjet via senere
migration, eller bliver smidt på gulvet i POST. **Verificér først:**

```bash
sqlite3 db/bon.db ".schema crm_activities"
sqlite3 db/bon.db "SELECT DISTINCT type FROM crm_activities"
```

Hvis `result/sentiment/purpose_id` mangler — tilføj migration `00X_crm_activities_extra.sql`:

```sql
ALTER TABLE crm_activities ADD COLUMN result TEXT;
ALTER TABLE crm_activities ADD COLUMN sentiment TEXT
    CHECK (sentiment IN ('positive', 'neutral', 'negative'));
ALTER TABLE crm_activities ADD COLUMN purpose_id INTEGER REFERENCES activity_purposes(id);
```

Hvis `type` CHECK-constraint ikke tillader `service_call`, skal den udvides.

Bekræft med Leif inden migration køres på prod.

---

## Backend

### routes/crm.js — nyt endpoint

```
GET /api/crm/customer-activities/:customerId?limit=20
```

Kræver auth (samme middleware som `/crm/customer/:id`).

**Query:**

```sql
SELECT
    a.id,
    a.type,
    a.text,
    a.result,
    a.sentiment,
    a.purpose_id,
    a.due_at,
    a.done_at,
    a.created_at,
    a.bon_id,
    b.bon_number,
    b.delivery_date,
    a.owner_user_id,
    u.name AS owner_name,
    p.label AS purpose_label,
    p.emoji AS purpose_emoji
FROM crm_activities a
LEFT JOIN bons b ON a.bon_id = b.id
LEFT JOIN users u ON a.owner_user_id = u.id
LEFT JOIN activity_purposes p ON a.purpose_id = p.id
WHERE a.customer_id = ?
ORDER BY a.created_at DESC
LIMIT ?
```

`limit` default 20, max 100. Returnér array — tom hvis ingen aktiviteter.

**Response-eksempel:**

```json
[
  {
    "id": 412,
    "type": "call",
    "text": "Vil høre om vegansk frokost næste tirsdag, 30 pax.",
    "result": "callback",
    "sentiment": "positive",
    "purpose_id": null,
    "due_at": "2026-05-06 10:00:00",
    "done_at": null,
    "created_at": "2026-05-03 14:32:11",
    "bon_id": null,
    "bon_number": null,
    "delivery_date": null,
    "owner_user_id": 2,
    "owner_name": "Leif Zeeberg",
    "purpose_label": null,
    "purpose_emoji": null
  },
  {
    "id": 408,
    "type": "email_in",
    "text": "Re: Frokost 12/3 — Tak for super levering ...",
    "result": null,
    "sentiment": "positive",
    "purpose_id": null,
    "due_at": null,
    "done_at": null,
    "created_at": "2026-04-30 09:12:04",
    "bon_id": 3242,
    "bon_number": "3242",
    "delivery_date": "2026-03-12",
    "owner_user_id": null,
    "owner_name": null,
    "purpose_label": null,
    "purpose_emoji": null
  }
]
```

Bemærk: Owner-initialer beregnes i frontend (`getInitials(owner_name)`) — ikke i SQL.
Det er nemmere at justere logikken hvis vi senere skal vise fulde navne ved tap.

---

## Frontend

### `mobile/views/crm.js` — ændringer i `_mcShowCustomer()`

**1. Udvid `Promise.all`-blokken:**

```javascript
var results = await Promise.all([
    apiFetch('/crm/customer/' + customerId),
    apiFetch('/crm/customer-orders/' + customerId + '?limit=5').catch(function() { return []; }),
    apiFetch('/crm/customer-activities/' + customerId + '?limit=20').catch(function() { return []; })
]);
var resp = results[0];
var ordersWithLines = results[1] || [];
var activities = results[2] || [];
```

**2. Ny sektion `_mcRenderHistorik(activities)` — placeres mellem stats-strip
og "Typiske produkter".**

Se render-mapping nedenfor.

**3. Initialer-helper (ny lokal funktion i crm.js):**

```javascript
function _mcInitials(name) {
    if (!name) return '';
    var parts = String(name).trim().split(/\s+/);
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
```

**4. Bon-pill click:**

```javascript
wrap.querySelectorAll('.m-tl-bon-link[data-id]').forEach(function(el) {
    el.addEventListener('click', function(e) {
        e.preventDefault();
        window._mSwitchView('bons');
        setTimeout(function() {
            if (typeof _mbShowDetail === 'function') _mbShowDetail(parseInt(el.dataset.id));
        }, 100);
    });
});
```

(Samme pattern som eksisterende ordre-klik.)

**5. "Vis alle"-toggle:**

```javascript
var showMoreBtn = wrap.querySelector('.m-tl-show-more');
if (showMoreBtn) {
    showMoreBtn.addEventListener('click', function() {
        wrap.querySelector('.m-timeline').classList.add('show-all');
        showMoreBtn.style.display = 'none';
    });
}
```

CSS sørger for at items med `display:none` (alle ud over de første 3) bliver synlige
når `.show-all` er sat.

**6. Efter Gem af ny samtale:**
I dag tømmes formularfelterne efter save. Kald i stedet `_mcShowCustomer(customerId)`
igen så historikken refresher med den nye aktivitet øverst.

---

### Render-mapping pr. `type`

| `type` | Ikon | Header-tekst | CSS-klasse på `.m-tl-icon` |
|--------|------|--------------|----------------------------|
| `call` | 📞 | "Opkald" + `result`-pill | `t-call` (blå) |
| `note` | 📝 | "Note" | `t-note` (grå) |
| `meeting` | 📅 | "Møde" | `t-meeting` (grøn) |
| `task` | ✓ | "Opgave" + due-pill hvis `due_at` | `t-task` (grøn) |
| `followup` | 🔔 | "Opfølgning" + due-pill hvis `due_at` | `t-followup` (orange) |
| `email_in` | ✉ | "Mail ind" | `t-email_in` (brun) |
| `email_out` | 📨 | "Mail ud" | `t-email_out` (brun, lys baggrund) |
| `offer_sent` | 🤝 | "Tilbud sendt" | `t-offer_sent` (orange, lys baggrund) |
| `service_call` | 📞 | "Service call" + `result`-pill | `t-call` (blå) |

### Result-pill (kun ved `type='call'` eller `'service_call'`)

| `result` | Label | CSS |
|----------|-------|-----|
| `reached` | "Svar" | `r-reached` (brand-light) |
| `no_answer` | "Ikke fat" | `r-no_answer` (rød-light) |
| `voicemail` | "Besked" | `r-voicemail` (grå) |
| `callback` | "Ring tb" | `r-callback` (orange-light) |
| `email_instead` | "Mail i stedet" | `r-email_instead` (brun-light) |

### Sentiment-emoji

| `sentiment` | Emoji |
|-------------|-------|
| `positive` | 😊 |
| `neutral` | 😐 |
| `negative` | 😟 |
| `null` | (ikke vist) |

### Due-pill

Vises kun hvis `due_at` er sat OG `done_at` er null:
- `due_at >= now` → orange baggrund: "Ring tb 6/5 kl 10"
- `due_at < now` → rød baggrund: samme tekst (overdue)

Format: dansk dato + klokkeslæt (`6/5 kl 10`).

### Tids-format

Genbrug eksisterende `_mcTimeAgo(iso)` i crm.js — tilføj klokkeslæt for "i dag" og "i går":
- `i dag 14:32`
- `i går 09:15`
- `3 d`
- `2 mdr`

### Tekst-truncation

Default 2 linjer (CSS `-webkit-line-clamp: 2`). Tap på item-row toggler `expanded`
klasse der fjerner clamping. Mailtekst kan være meget lang — vis op til 6 linjer
i expanded mode.

### Empty state

```html
<div class="m-tl-empty">Ingen aktiviteter endnu</div>
```

---

## CSS — `shared/components.css`

Nye klasser tilføjes under nyt afsnit:

```
/* ════════════════════════════════════════════
   CRM activity timeline (kunde-detalje)
   Bruges af mobile/views/crm.js og senere
   office desktop kunde-view.
   ════════════════════════════════════════════ */
```

Klasse-præfix `m-tl-*` (matcher `m-svc-*`, `m-cust-*`-konventionen).

Tokens skal bruges — ingen hardcodede farver. Fuld CSS-specifikation findes i
mockup'en `crm_kunde_historik_mockup.html` (variant A) — kopier de relevante
`m-tl-*`, `m-timeline*` regler derfra.

---

## Test

1. **Kunde uden aktiviteter** → empty state vises, intet "Vis alle"-knap
2. **Kunde med 1–3 aktiviteter** → vises alle, intet "Vis alle"-knap
3. **Kunde med 5+ aktiviteter** → 3 nyeste vises, "Vis alle X aktiviteter ▾" knap
4. **Klik på bon-pill** `#3242` → hopper til mobil bon-detalje (samme som ordre-klik)
5. **Aktivitet med `bon_id` men ingen `bon_number`** (bon slettet?) → vis ikke pill
6. **Aktivitet uden owner** (fx `email_in` automatisk genereret) → ingen initialer
7. **Callback med `due_at` i fortiden** → rød due-pill
8. **Log ny samtale → Gem** → ny aktivitet dukker op øverst i historikken
9. **Render alle 9 typer** (call, note, meeting, task, followup, email_in, email_out,
   offer_sent, service_call) — verificér ikon + farve + label

---

## Rækkefølge

1. Skema-tjek + evt. migration (`result`, `sentiment`, `purpose_id`, `service_call`)
2. `routes/crm.js` — nyt endpoint `GET /customer-activities/:id`
3. `shared/components.css` — `m-tl-*` regler
4. `mobile/views/crm.js`:
   - Udvid `Promise.all` i `_mcShowCustomer`
   - Tilføj `_mcRenderHistorik()` + `_mcInitials()`
   - Wire "Vis alle"-toggle og bon-pill clicks
   - Refresh historik efter Gem af ny samtale
5. Manuel test i mobil-browser (DevTools mobile mode)

---

## Out of scope (parkeret)

| Feature | Bemærkning |
|---------|------------|
| Filter-chips (Alle / 📞 / ✉ / 📝) | Parkeret til efter MVP — vurder behov efter 1-2 ugers brug |
| Redigér / slet aktiviteter | Vi tilføjer kun, vi retter ikke historie |
| SSE realtidsopdatering | Ikke nødvendig — refresh ved Gem dækker mobilbrug |
| Desktop kunde-view (office) | Senere fase — `m-tl-*` klasser er forberedt til genbrug |
| Søgning i historik | Sjælden case — Cmd+F i browseren rækker |

---

## Åbne punkter

| Punkt | Status |
|-------|--------|
| Skema-verificering: findes `result`, `sentiment`, `purpose_id` på `crm_activities`? | ⏳ Tjek inden start |
| Skema: tillader `type` CHECK-constraint `service_call`? | ⏳ Tjek inden start |
| `activity_purposes` skema (label, emoji, description) | ⏳ Bekræft kolonnenavne i SELECT-query |
| Owner-initialer ved system-genererede aktiviteter (fx email_in fra IMAP) | Vis bare intet — ikke kritisk |

---

## Designreferencer

- `crm_kunde_historik_mockup.html` — variant A (anbefalet, og det vi bygger)
- `nano_crm_mockup.html` — desktop-version, samme datamodel
