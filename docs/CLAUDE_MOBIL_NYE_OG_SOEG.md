# CLAUDE_MOBIL_NYE_OG_SOEG.md
*Spec til Claude Code · 14. maj 2026*

> Tilføj **"Nye"-tab** og **søg-overlay** til mobile shellet (`/mobile/`).
> Følg principperne i `BON_V2_PRINCIPPER.md` — ingen patches, redesign hvor nødvendigt.
> Schema-autoritet: `bon_v2_datamodel_v2.md`.
> Eksisterende mobile-spec: `CLAUDE_MOBIL.md` — denne fil supplerer den.

---

## 1. Mål

To nye sub-views inde i `mobile/views/bons.js`:

| View | Formål |
|---|---|
| **Nye** | Se bonner kommet ind siden sidst-set + bonner med ulæst mail siden sidst-set. Primær on-the-go inbox når man er væk fra kontoret |
| **Søg** | Find en specifik bon på tværs af alle datoer/statusser når kunden ringer. Søger i bonnummer, kunde, firma, telefon |

**Begge bor inde i Bons-tabben** — bottom-nav forbliver uændret (5 tabs).

---

## 2. UI-struktur

### Top-tabs udvides fra 3 til 4 + søg-ikon

```
┌─────────────────────────────────────────┐
│ I dag · I morgen · Overmorgen · Nye [🔍]│
└─────────────────────────────────────────┘
```

| Tab | View-state |
|---|---|
| I dag / I morgen / Overmorgen | Som i dag — uændret |
| **Nye** | Nyt view, se §4 |
| 🔍 (ikon) | Klik åbner søg-overlay, se §5 |

**Nye-tab badge:** Lille rød badge med antal uset (samme tal som bottom-nav-badge).

### Bottom-nav Bons-tab

Badge på Bons-tabben i `mobile/index.html` — vises kun når antal uset > 0.
Tal er identisk med Nye-tab-badge.

---

## 3. Datamodel ændring

### Migration: ny kolonne på `users`

```sql
-- db/migrations/NNN_users_new_bons_last_seen.sql
ALTER TABLE users ADD COLUMN new_bons_last_seen_at DATETIME;
```

**Semantik:** Tidsstempel for hvornår brugeren sidst åbnede Nye-listen eller trykkede "Marker alle læst". `NULL` = aldrig set (vis alle nye fra de seneste 7 dage som default).

**Schema-dokumentation:** Tilføj kolonnen til `bon_v2_datamodel_v2.md` under `users`-tabellen.

Ingen andre schema-ændringer. `bon_mails.is_read` bruges som det er.

---

## 4. Nye-view

### 4.1 Datakilder

Listen er en union af to event-typer, sorteret efter event-tidspunkt desc:

| Event-type | Kilde | Event-tidspunkt | Vis hvis |
|---|---|---|---|
| **Ny bon** | `bons` | `bons.created_at` | `created_at > user.new_bons_last_seen_at` ELLER `created_at > NOW() - 7 dage` (hvis last_seen_at IS NULL) |
| **Ulæst mail** | `bon_mails` | `bon_mails.received_at` | `is_read = 0 AND direction = 'inbound'` |

**Bemærk:** En bon kan optræde to gange — én gang som "ny bon" og én gang per "ulæst mail". Det er ønsket: hver event er sin egen handling.

### 4.2 Nyt endpoint: `GET /api/bons/new`

**Response:**

```json
{
  "last_seen_at": "2026-05-13T18:32:00",
  "count": 7,
  "events": [
    {
      "event_type": "new_bon",
      "event_at": "2026-05-14T15:48:00",
      "bon": {
        "id": 3387,
        "bon_number": 3387,
        "contact_name_full": "Liffe Zeeberg",
        "company_name": null,
        "delivery_date": "2026-07-15",
        "delivery_time": "11:30",
        "pax": 60,
        "status_code": "NY",
        "source": "web"
      },
      "seen": false
    },
    {
      "event_type": "unread_mail",
      "event_at": "2026-05-14T14:12:00",
      "bon": { /* samme felter som ovenfor */ },
      "mail": {
        "id": 4421,
        "subject": "Re: Frokost mandag",
        "preview": "Hej — kan I rykke leveringen frem til kl. 11:00?...",
        "from_address": "erika@novo.com"
      },
      "seen": false
    }
  ]
}
```

**Felter:**
- `seen` per event: `event_at <= user.new_bons_last_seen_at`
- `preview` på mail: første ~120 tegn af `bon_mails.body_text`, stripped af signatur/quoted text hvis muligt (simpel heuristic: cut ved `\n>` eller `\n--`)
- `source` på bon: udled fra `bons.created_by_user_id IS NULL` (= web/automatisk) vs. har værdi (= manuel). Web-form-bonner identificeres via `bons.external_ref IS NOT NULL` ELLER metadata fra `web_orders`-tabellen (Claude Code bestemmer den mest pålidelige heuristic — dokumentér valget)

**Pagination:**
- Default `limit=30`, `offset=0`
- `?limit=30&offset=30` for "Vis flere ældre"

**Sortering:** `event_at DESC`

### 4.3 Endpoints til at markere som set

**Auto-mark per event** (kaldes af IntersectionObserver):

```
POST /api/bons/:id/mark-seen
Body: { event_type: 'new_bon' | 'unread_mail', mail_id?: int }
```

For `new_bon` events: opdater `user.new_bons_last_seen_at` til `MAX(current_value, bon.created_at)` — så timestamp kun rykker fremad.

For `unread_mail` events: sæt `bon_mails.is_read = 1` på den specifikke mail.

**Bulk-marker alle som læst** (kaldes af "Marker alle læst"-knap):

```
POST /api/bons/mark-all-seen
```

- Sætter `user.new_bons_last_seen_at = NOW()`
- Sætter `bon_mails.is_read = 1 WHERE direction = 'inbound' AND received_at <= NOW()`

### 4.4 Frontend — `mobile/views/bons.js`

#### Tab-rendering

Udvid eksisterende tab-array:

```js
var TABS = ['today', 'tomorrow', 'dayafter', 'new'];
var TAB_LABELS = { today: 'I dag', tomorrow: 'I morgen', dayafter: 'Overmorgen', new: 'Nye' };
```

Når `_mbTab === 'new'`: hent fra `/api/bons/new` i stedet for `/api/bons?date=…`.

#### Liste-rendering

Gruppér events i 4 sektioner baseret på `event_at`:

| Sektion | Tidsvindue |
|---|---|
| Lige nu | < 1 time siden |
| Tidligere i dag | I dag, men > 1 time siden |
| I går | I går |
| Ældre | > i går |

Hver section-header rendres som `<div class="m-section-head">Lige nu</div>`.

#### Event-kort

3 visuelle varianter — alle bruger samme grundstruktur:

| Variant | Source-ikon | Border-left | Baggrund |
|---|---|---|---|
| Ny bon (web) | SVG-globus | rød hvis !seen, ellers brand-primary | hvid |
| Ny bon (manuel) | SVG-pen | rød hvis !seen, ellers brand-primary | hvid |
| Ulæst mail | SVG-konvolut | brand-primary | let gul (#fbf6e9) |

**SVG-paths** (24×24, stroke-width 2):

```html
<!-- Konvolut (mail) — samme som 10_koekken_idag action-button -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
    <polyline points="22,6 12,13 2,6"/>
</svg>

<!-- Globus (web) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="12" cy="12" r="10"/>
    <line x1="2" y1="12" x2="22" y2="12"/>
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
</svg>

<!-- Pen (manuel) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M12 20h9"/>
    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
</svg>

<!-- Lup (søg) -->
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="11" cy="11" r="8"/>
    <line x1="21" y1="21" x2="16.65" y2="16.65"/>
</svg>
```

**Kort-indhold:**

```
[ikon] Kilde-label            [STATUS-BADGE]
Kundenavn — Firma (hvis findes)
"Mail-preview…" (kun for mail-events)
For 12 min siden
#3387 · Lev. 15/7 kl. 11:30 · 60 pax
```

#### Auto-mark-som-set (IntersectionObserver)

```js
var observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
        if (entry.intersectionRatio > 0.5) {
            // Start 2-sekund-timer hvis ikke allerede markeret
            var el = entry.target;
            if (el.dataset.seenTimer || el.dataset.alreadySeen === '1') return;
            el.dataset.seenTimer = setTimeout(function() {
                _mbMarkEventSeen(el.dataset.eventType, el.dataset.bonId, el.dataset.mailId);
                el.classList.remove('unseen');
                el.dataset.alreadySeen = '1';
            }, 2000);
        } else {
            // Annullér timer hvis brugeren scroller forbi før 2 sek
            var el = entry.target;
            if (el.dataset.seenTimer) {
                clearTimeout(el.dataset.seenTimer);
                delete el.dataset.seenTimer;
            }
        }
    });
}, { threshold: 0.5 });

// Observer hvert event-kort efter render
document.querySelectorAll('.m-bon-item.unseen').forEach(function(el) {
    observer.observe(el);
});
```

CSS-transition: `border-left-color` med 400ms transition for blød fade.

#### "Marker alle læst"-knap

I `.m-meta`-baren øverst:

```html
<div class="m-meta">
    <span>7 nye siden i går kl 18:32</span>
    <button class="m-meta-action">Marker alle læst</button>
</div>
```

Klik → `POST /api/bons/mark-all-seen` → reload Nye-listen.

#### "Vis flere ældre"-knap

Vises nederst når der er flere events end vist. Klik → fetch næste 30 → append til listen.

#### Badge-opdatering

Tæller skal opdateres på:
- Top-tab "Nye" — `7` eller blank
- Bottom-nav Bons-tab — samme tal

Implementation:
- Ved boot: `GET /api/bons/new?count_only=1` returnerer kun `{ count: N }` for hurtigt badge-load
- Ved SSE-event `bon_created` eller `mail_received`: increment badge
- Ved auto-mark eller bulk-marker: re-fetch count

---

## 5. Søg-overlay

### 5.1 UI-state

Søg er en alternativ "tilstand" af Bons-viewet — top-tabs replacement, ikke et popup.

| Element | Til normal | Til søg-mode |
|---|---|---|
| `.m-tabs-row` | Tabs + lup-ikon | Tilbage-pil + søgefelt |
| `.m-meta` | Skjult eller "X nye siden..." | Skjult, erstattes af resultat-tæller |
| `.m-content` | Tabs-baseret liste | Søg-resultater |

### 5.2 Aktivering

Klik på lup-ikon i `.m-tabs-row`:
1. Skift `_mbTab = 'search'`
2. Render søge-row med autofokus på input
3. Hvis input er tomt: fetch seneste 30 bonner via `/api/bons?sort=delivery_date_desc&limit=30`
4. Tastatur popper op automatisk (autofokus)

### 5.3 Søg-feltet

```html
<div class="m-search-row">
    <button class="m-search-back" aria-label="Tilbage">
        <svg><!-- arrow-left --></svg>
    </button>
    <div class="m-search-input-wrap">
        <span class="m-search-input-icon"><svg><!-- lup --></svg></span>
        <input type="text" class="m-search-input"
               placeholder="Søg bonnummer, kunde, firma, telefon…"
               autofocus>
        <button class="m-search-clear" aria-label="Ryd">×</button>
    </div>
</div>
```

- Tilbage-pil → tilbage til sidste tab (`_mbTab` huskes som `_mbLastTab` før skift)
- `×`-knap → ryd input, fokus tilbage på felt
- Live-søg med **300ms debounce**
- Hvis input bliver tomt under søg: fald tilbage til "seneste 30"

### 5.4 Backend-endpoint

Genbrug eksisterende `GET /api/bons?q=…`. **Verificér først** at endpointet søger i alle de nødvendige felter:

| Felt | Skal være med |
|---|---|
| `bons.bon_number` | Ja — prefix-match eller eksakt |
| `customers.first_name` | Ja — `LIKE %q%` |
| `customers.last_name` | Ja — `LIKE %q%` |
| `customers.first_name \|\| ' ' \|\| last_name` | Ja — fuld navn-søgning |
| `companies.name` | Ja — `LIKE %q%` |
| `customers.phone` | Kun hvis q er rent tal (`/^\d+$/.test(q)`) |
| `bons.bon_number = q` | Hvis q er rent tal ≥ 4 cifre |

Hvis nuværende `?q=` ikke dækker alle disse: udvid `routes/bons.js`. **Skriv kommentar i koden** der dokumenterer dækningen.

**Query-parametre tilføjes:**
- `?limit=30` — paginering
- `?offset=0` — paginering
- `?sort=delivery_date_desc` — eksplicit sortering (default i søg-context)

Søg dækker **alle bonner** — ingen status- eller dato-filtrering. Tilbud (`is_offer=1`) skal også med.

### 5.5 Resultat-rendering

Hver match-row:

```html
<div class="m-result-item" data-bon-id="3362">
    <div class="m-result-row1">
        <span class="m-result-bonnr">#3362</span>
        <span class="m-result-customer"><mark>Novo</mark> Nordisk</span>
        <span class="m-result-status s-godkendt">GODKENDT</span>
    </div>
    <div class="m-result-meta">Lev. man 18/3 kl. 12:00 · 60 pax · Erika Hansen</div>
</div>
```

**Match-highlight:** Wrap matchende substring i `<mark>` på client-side. Case-insensitive. Highlight på de felter der faktisk matchede (kunde-navn, firma-navn, bonnummer).

Implementation:
```js
function _mbHighlight(text, query) {
    if (!query || !text) return _mbEsc(text);
    var safe = _mbEsc(text);
    var safeQ = _mbEsc(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp('(' + safeQ + ')', 'gi'), '<mark>$1</mark>');
}
```

**Tom resultat:**

```
Ingen bonner fundet for "xyz"
```

**Klik på resultat:** Åbn bon-detalje (eksisterende `_mbShowDetail`). Tilbage-pil fra detalje → tilbage til søgeresultater (ikke til Nye-listen).

### 5.6 Pagination

"Vis 30 ældre"-knap i bunden. Klik → fetch næste 30 med `offset` + append.

---

## 6. Status-farver til badges

Tilføj manglende status-farver i `BonConfig.js` (verificer at de allerede er der):

| Status | Farve | Tekstfarve |
|---|---|---|
| NY | `#d63031` | `#fff` |
| VENTER | `#999` | `#fff` |
| GODKENDT | `#5fa050` | `#fff` |
| IGANG | `#e8a83a` | `#4a3a0a` |
| KLAR | `#2d6a2a` | `#fff` |
| LEVERET | `#888` | `#fff` |
| FAKTURERET | `#3a7abc` | `#fff` |
| AFSLUTTET | `#555` | `#fff` |
| BETALT | `#3a7abc` | `#fff` |
| AFLYST | `#b04a4a` | `#fff` |

Hvis disse allerede er korrekte i `BonConfig.js`: lad dem være.

---

## 7. CSS — nye styles i `mobile/mobile.css`

Genbrug eksisterende `--brand-primary`-tokens. Nye klasser:

```css
.m-tab-badge { /* lille rød cirkel ved siden af "Nye"-label */ }
.m-search-btn { /* lup-ikon-knap til højre for tabs */ }
.m-search-row { /* erstatter tabs-row i søg-mode */ }
.m-search-back { /* tilbage-pil */ }
.m-search-input-wrap { /* relativ container for input + ikoner */ }
.m-search-input-icon { /* lup inde i feltet */ }
.m-search-input { /* selve text-feltet */ }
.m-search-clear { /* × cirkel */ }
.m-meta { /* gul info-bar */ }
.m-meta-action { /* "Marker alle læst"-knap */ }
.m-section-head { /* "Lige nu" / "I går" headers */ }
.m-bon-item.unseen { border-left-color: #d63031; transition: border-left-color 400ms; }
.m-bon-item.mail { background: #fbf6e9; }
.m-bon-source svg { width: 14px; height: 14px; color: var(--brand-primary); }
.m-result-item { /* kompakt søg-result-kort */ }
mark { background: #fff3a8; color: inherit; padding: 0 2px; border-radius: 2px; font-weight: 700; }
.m-show-more { /* "Vis flere"-knap nederst */ }
.m-nav-badge { /* rød tal-badge på Bons-tab i bottom-nav */ }
```

Brug mockup-filerne som visuel reference:
- `mobile_nye_mockup_v2.html` — Nye-listen (autoritativ for layout)
- `mobile_soeg_mockup_v1.html` — Søg-overlay

---

## 8. `mobile/index.html`-ændringer

To ændringer:

### 8.1 Badge på Bons-tab i bottom-nav

I `NAV_DEFS.forEach(...)`-løkken, tilføj badge-rendering for `view === 'bons'`:

```js
if (d.view === 'bons') {
    var badge = document.createElement('span');
    badge.className = 'm-nav-badge';
    badge.id = 'mNavBadgeBons';
    badge.style.display = 'none';
    btn.appendChild(badge);
}
```

Global helper:
```js
window._mUpdateNewBadge = function(count) {
    var badge = document.getElementById('mNavBadgeBons');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count;
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
};
```

### 8.2 Initial badge-load ved boot

I boot-sektionen efter auth-check:

```js
// Hent initial badge-tæller
fetch('/api/bons/new?count_only=1')
    .then(function(r) { return r.json(); })
    .then(function(d) { window._mUpdateNewBadge(d.count); })
    .catch(function() { /* ignorér */ });
```

### 8.3 Default-tab-valg

Behold nuværende default (`bons` / `today`). **Ikke** automatisk skift til Nye-tabben ved boot — det er for støjende. Brugeren ser badge og vælger selv.

---

## 9. SSE-events

Hvis SSE er aktivt (verificér i `shared/utils.js → connectSSE`):

| Event | Handling |
|---|---|
| `bon_created` | Increment Nye-badge, hvis bruger er på Nye-tab: prepend kort til listen |
| `mail_received` | Increment Nye-badge, hvis bruger er på Nye-tab: prepend kort |
| `bon_status` | Hvis bonnen er synlig i Nye-listen: opdater status-badge |

Hvis SSE ikke er aktivt på mobile shellet endnu: drop dette — pull-to-refresh dækker. Skriv det i koden som `// TODO: hook into SSE when enabled`.

---

## 10. Test-scenarier

Manuelle test der skal verificeres efter implementering:

1. **Tom database, ny bruger:** Nye-listen viser 0 events, badge skjult, "Ingen nye"-empty-state
2. **Webformular sender ny bon:** Bonnen dukker op i Nye inden for 5 sek (SSE) eller ved refresh
3. **Ulæst mail kommer ind:** Mail-event dukker op separat, selvom samme bon allerede er listed som "ny bon"
4. **Scroll forbi et kort i 2 sek:** Rød kant fader væk, badge-tæller decrementer
5. **Tryk "Marker alle læst":** Alle kort mister rød kant, badge går til 0, top-tab-badge forsvinder
6. **Søg på "novo":** Returnerer alle bonner hvor kunde eller firma indeholder "novo" — også historiske
7. **Søg på "3362":** Eksakt bonnummer-match som første resultat, eventuelle delvise matches efter
8. **Søg på "40195471":** Telefon-match prioriteres når input er rent tal
9. **Bon-detalje fra søgresultat → tilbage-pil:** Returnerer til søgresultatet, ikke til Nye

---

## 11. Filer der ændres

| Fil | Ændring |
|---|---|
| `db/migrations/NNN_users_new_bons_last_seen.sql` | **Ny** — ALTER TABLE |
| `bon_v2_datamodel_v2.md` | **Opdater** — dokumentér ny kolonne på `users` |
| `routes/bons.js` | **Udvid** — `GET /api/bons/new`, `POST /api/bons/:id/mark-seen`, `POST /api/bons/mark-all-seen`, evt. udvid `?q=` |
| `mobile/views/bons.js` | **Udvid** — Nye-tab + søg-overlay-mode |
| `mobile/index.html` | **Udvid** — badge på Bons-tab + initial badge-load |
| `mobile/mobile.css` | **Udvid** — nye klasser fra §7 |
| `BonConfig.js` | **Verificér** — status-farver fra §6 |
| `CLAUDE_MOBIL.md` | **Opdater** — tilføj Nye + søg til "Views"-sektion, fjern udsving fra eksisterende implementering (3 datotabs, 5 bottom-nav-punkter, Mig i header-dropdown) |

---

## 12. Visuel reference

To mockup-filer ligger i projekt-roden — brug dem som autoritativ kilde til layout og styling:

- `mobile_nye_mockup_v2.html` — Nye-listen
- `mobile_soeg_mockup_v1.html` — Søg-overlay

Hvis koden afviger fra mockup'en: spørg før du implementerer afvigelsen.

---

## 13. Ikke-mål

- Push-notifikationer (kræver PWA service worker — separat fase)
- Marker enkelt bon som ulæst igen
- Filtrér søg på status eller dato (kan tilføjes senere hvis nødvendigt)
- Avancerede søge-operatorer (`from:`, `before:` osv.)
- Sletning af bonner fra Nye-listen uden at åbne dem (swipe-delete)

---

## 14. Beslutninger taget (14. maj 2026)

Efter Q&A med Leif:

1. **Source-heuristik** — JOIN mod `web_orders.bon_id` afgør om en bon stammer fra webformular. Match → "Web-bestilling" (globus-ikon). Ingen match → "Manuel" (pen-ikon). Booking-flow ekskluderes (booking opretter `crm_activity`, ikke bon).

2. **`mark-all-seen` rører IKKE `mail_messages.is_read`** — kun `users.new_bons_last_seen_at` opdateres til NOW(). Mails forsvinder fra mobile Nye-listen pga. timestamp-filter på `received_at > last_seen_at`, men forbliver "ulæste" i office's mail-filtre. Undgår at træde på Karla/Anne's flow.

   **Yderligere sikring mod v1-mails:** `GET /api/bons/new` filtrerer ALTID mail-events på `received_at > since` (samme tærskel som bons.created_at). Det betyder at v1-migrerede gamle mails (eller mails der aldrig blev markeret læst i et tidligere UI) IKKE pludselig dukker op i Nye-feedet. Default fallback (7 dage) gælder også for mails — ved første brug efter deploy vises kun mails fra de seneste 7 dage.

3. **`bon_mails.is_read` forbliver globalt** for nu. Per-bruger-tabel `mail_reads` kan migreres på senere tidspunkt hvis behov opstår.

4. **Booking-events vises IKKE i Nye-listen.** Kun bons + mails. Booking har sit eget panel på CRM-dashboardet.

5. **Default-tab ved boot: I dag** (uændret). Ingen automatisk skift til Nye selv ved højt badge-tal.

6. **Empty-state-tekst:** "🎉 Du er fanget op — ingen nye bonner eller mails siden sidst."

7. **Telefon-søg i backend** — udvid `routes/bons.js` `?q=`-håndtering. Da bonnumre er **præcis 4 cifre**, gælder:
   - `q` har bogstaver → kun `customer.first_name + last_name + company.name` (LIKE %q%)
   - `q` er rent tal med ≤ 4 cifre → `bon_number LIKE q%` (prefix-match — bonnummer-prioritet)
   - `q` er rent tal > 4 cifre → `customers.phone LIKE %q%` (kan ikke være bonnummer)

8. **Auto-mark respekterer `document.visibilityState`** — IntersectionObserver-2s-timer udløser kun hvis dokumentet er synligt. Lukker edge case hvor skærmen er tændt i lommen.

9. **Index på `bon_mails`** — partial index tilføjes i samme migration: `CREATE INDEX idx_bon_mails_unread_inbound ON bon_mails(received_at) WHERE is_read=0 AND direction='inbound';`. Bon-side index på `created_at` tilføjes også: `CREATE INDEX idx_bons_created_at ON bons(created_at);`.

10. **Set-kort bliver liggende indtil næste fetch** — efter auto-mark eller "Marker alle læst" forsvinder rød kant, men kortet bliver i listen så længe brugeren ser Nye-tabben. Først ved tab-skift + tilbage (eller pull-to-refresh) filtreres set-kort ud via `event_at > last_seen_at`.

    **Revideret 14. maj 2026 (beslutning 11):** Det viste sig at MAX-update på `last_seen_at` ved auto-mark gjorde at scrolling forbi ÉN ny bon filtrerede ALLE ældre uset bons væk på næste fetch (fordi listen er sorteret nyeste først → den nyeste bons `created_at` blev hele baselinen). Beslutning 11 erstatter denne adfærd.

11. **Auto-mark er rent visuel feedback (revideret 14. maj 2026)** — IntersectionObserver-2s-timer fader stadig den røde kant, men ændrer IKKE serverstatus. Hverken `last_seen_at` eller `mail_messages.is_read` opdateres via auto-mark. Det betyder:
    - Listen viser alle events siden sidste "Marker alle læst" (eller seneste 7 dage hvis aldrig brugt) — uafhængigt af hvad brugeren har scrollet forbi
    - Badge tæller den fulde serverside-mængde indtil eksplicit "Marker alle læst"
    - Brugeren kan scrolle, gå ud af Nye-tabben, komme tilbage → alle events er der stadig
    - Visual seen-state nulstilles ved tab-skift (DOM rebuild) — første-iteration tradeoff; persistent visual seen-state ville kræve per-user-per-event tracking
    - Mails markeres aldrig som læst fra mobilen → office's mail-filtre er upåvirkede

    **Endpoint adfærd:**
    - `POST /api/bons/:id/mark-seen` er bevaret som no-op for bagudkompatibilitet med cachede klient-builds; returnerer `{ ok: true }` uden state-ændring
    - `POST /api/bons/mark-all-seen` er uændret — den eksplicitte "jeg er færdig"-handling der advancer `last_seen_at = NOW()`

---

*Spec slutter her. Beslutninger ovenfor er autoritative ved implementering.*
