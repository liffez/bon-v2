# CLAUDE_INDBAKKE.md — Samlet indbakke (mail-klient)

> **Status:** Spec klar til implementering (rev. 21. juni 2026 — omskrevet til at bygge oven på det
> eksisterende mail-system fra migration `018_mail_threads.sql`). Mockup godkendt (`crm_indbakke_mockup_v2.html`).
> **Forankring:** Læs `BON_V2_PRINCIPPER.md`, `bon_v2_datamodel_v2.md` (afsnit *MAIL*),
> `docs/CLAUDE_MAIL.md` + `docs/CLAUDE_MAIL_IMPL.md` (det faktiske mail-flow) **før** implementering.

---

## 0. Vigtigt — udgangspunktet (læs FØRST)

En tidligere udgave af denne spec foreslog at *oprette* `mail_threads` + `mail_messages` og migrere fra
`bon_mails`. **Det er allerede sket** i [018_mail_threads.sql](../db/migrations/018_mail_threads.sql):

- `mail_threads`, `mail_messages`, `mail_attachments`, `mail_unmatched` **eksisterer og er i drift**.
- `bon_mails` + `customer_mails` blev **omdøbt til `_old_*`** dengang — de er døde.
- `crm_unmatched_emails` (migration 004) er ligeledes superseded af `mail_unmatched`.
- `mail_threads` er en **delt** tabel: den rummer bon-mail, kunde-mail, **PO/ordre-mail** (`purchase_order_id`,
  mig. 034) og **leverandør-mail** (`supplier_id`, mig. 052).

Denne opgave **udvider** altså det eksisterende system additivt. Vi opretter ingen mail-tabeller, og vi
rører **ikke** PO/leverandør-trådenes adfærd. Alt arbejde sker som `ALTER TABLE` + nye felter + ny status-dimension.

**Faktisk skema i dag** (kilde: migration 018, brug disse navne — ikke spec'ens gamle):

| Tabel | Nøglefelter (uddrag) |
|---|---|
| `mail_threads` | `id, subject (NOT NULL), bon_id, customer_id, purchase_order_id, supplier_id, status('active'\|'closed'\|'archived'), created_at, updated_at` |
| `mail_messages` | `id, thread_id, message_id, in_reply_to, direction('in'\|'out'), from_email, from_name, to_email, to_name, cc, subject, body_text, body_html, has_attachments, is_read, is_flagged, imap_uid, mailbox, sent_at, received_at, created_by_user_id` |
| `mail_attachments` | `id, message_id, unmatched_id, filename, mime_type, size_bytes, file_path, content_id, is_inline` |
| `mail_unmatched` | `id, mailbox, message_id, imap_uid, from_email, from_name, subject, body_text, body_html, received_at, parsed_*, status('open'\|'linked'\|'ignored'), linked_customer_id, linked_bon_id, handled_by_user_id` |

> ⚠︎ **`direction` er `'in'`/`'out'`** — ikke `inbound`/`outbound`. Brug `'in'`/`'out'` i al ny kode.

---

## 1. Problem & beslutning

Mails overses fordi systemet mangler **én vedvarende håndterings-status pr. tråd**: `mail_threads.status`
(`active/closed/archived`) udtrykker om en tråd er teknisk åben, ikke om *vi skal gøre noget*. Samtidig er
indbakken split-brain: kendt inbound lander i `mail_threads`, ukendt i `mail_unmatched` — office
[crm-inbox.js](../office/views/crm-inbox.js) limer allerede de to sammen i frontend med en
`kind='unmatched'`/`kind='thread'`-hack. På mobil findes ingen indbakke; mail er `mailto:`-links der
sender brugeren ud i telefonens egen mail-app.

**Løsning:** Én autoritativ indbakke oven på `mail_threads`. Kunde-360 og bon-tråd bliver *projektioner*
af samme lager. Kerneregel: **læst ≠ håndteret** — en tråd forlader "Åbne" når den besvares, udsættes
eller afsluttes. Ukendt inbound bliver en **rigtig tråd** (`customer_id=NULL`), så `mail_unmatched`
udfases og split-brain forsvinder.

| Beslutning | Valg |
|-----------|------|
| Ét inbox m. filter (bon@/kontakt@) | ✅ — `mailbox` ligger på `mail_messages` (allerede) |
| Håndterings-status pr. **tråd** | ✅ — **nyt felt** `handling_status`, additivt ved siden af `status` |
| Rør PO/leverandør-tråde | ❌ — `handling_status` sættes kun på kunde/bon-tråde |
| Ukendt inbound → rigtig tråd (`customer_id=NULL`) | ✅ — afløser `mail_unmatched` (faset) |
| Mobil-hjem | **3. fane i CRM-viewet** (genbruger `crm`-permission, intet nyt nav-ikon) |
| Snooze | ✅ — `snooze_until`, ortogonal til status |
| Sendt-synlighed | ✅ — `last_outbound_at` + `is_system`-flag på beskeder |
| Tildeling/"Mine" | Felt klar nu, **UI bag flag** (`inbox_assignment_enabled`, default 0) |

---

## 2. Datamodel — additiv udvidelse af migration 018

> Ingen nye mail-tabeller. Brug **næste ledige fortløbende migrationsnummer** (seneste er ≥103 → typisk `104`).
> Migrationer køres aldrig om (jf. KOM_IGANG).

### Migration — `db/migrations/1NN_inbox_handling.sql`

```sql
-- ── Håndterings-dimension på mail_threads (additiv — status urørt) ──
-- handling_status er NULL for PO/leverandør-tråde; sættes kun på kunde/bon-tråde.
ALTER TABLE mail_threads ADD COLUMN handling_status TEXT
    CHECK (handling_status IN ('aaben','afventer_kunde','afsluttet'));   -- se note hvis SQLite afviser CHECK
ALTER TABLE mail_threads ADD COLUMN snooze_until     DATETIME;          -- NULL = ikke udsat. <= now → behandles som 'aaben'
ALTER TABLE mail_threads ADD COLUMN assigned_to      INTEGER REFERENCES users(id);  -- tildeling (UI bag flag)
ALTER TABLE mail_threads ADD COLUMN last_inbound_at  DATETIME;          -- pre-computed
ALTER TABLE mail_threads ADD COLUMN last_outbound_at DATETIME;          -- pre-computed ("hvornår svarede vi")
ALTER TABLE mail_threads ADD COLUMN has_unread       INTEGER NOT NULL DEFAULT 0;    -- pre-computed

-- is_system: 1 = auto-bekræftelse (booking-mail o.l.), ikke menneske-svar
ALTER TABLE mail_messages ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_mail_threads_handling ON mail_threads(handling_status);
CREATE INDEX IF NOT EXISTS idx_mail_threads_snooze   ON mail_threads(snooze_until);

-- ── Backfill: kun kunde/bon-tråde (PO/leverandør forbliver NULL) ──
UPDATE mail_threads
SET handling_status = CASE
      WHEN status IN ('closed','archived') THEN 'afsluttet'
      WHEN EXISTS (SELECT 1 FROM mail_messages mm
                   WHERE mm.thread_id = mail_threads.id
                     AND mm.direction = 'in' AND mm.is_read = 0) THEN 'aaben'
      ELSE 'afsluttet' END
WHERE purchase_order_id IS NULL
  AND supplier_id IS NULL
  AND (bon_id IS NOT NULL OR customer_id IS NOT NULL);

-- ── Pre-compute timestamps + unread for de samme tråde ──
UPDATE mail_threads SET
  last_inbound_at  = (SELECT MAX(COALESCE(mm.received_at, mm.created_at))
                        FROM mail_messages mm WHERE mm.thread_id = mail_threads.id AND mm.direction = 'in'),
  last_outbound_at = (SELECT MAX(COALESCE(mm.sent_at, mm.created_at))
                        FROM mail_messages mm WHERE mm.thread_id = mail_threads.id AND mm.direction = 'out'),
  has_unread       = CASE WHEN EXISTS (SELECT 1 FROM mail_messages mm
                                       WHERE mm.thread_id = mail_threads.id
                                         AND mm.direction = 'in' AND mm.is_read = 0)
                          THEN 1 ELSE 0 END
WHERE handling_status IS NOT NULL;

-- ── Settings ──
INSERT OR IGNORE INTO settings (key, value, description) VALUES
  ('inbox_snooze_default_days', '3', 'Standard rykker-interval for "Afventer kunde"'),
  ('inbox_assignment_enabled',  '0', '1 = vis tildeling + "Mine" i indbakke (flere brugere)');
```

> **Note (CHECK ved ADD COLUMN):** node:sqlite tillader normalt CHECK på en tilføjet kolonne. Hvis migrationen
> alligevel fejler i drift, drop CHECK-klausulen og håndhæv de tre værdier i backend (samme pragmatik som
> migration 054, hvor en CHECK blev fjernet for at undgå RENAME-blokeringer). `snooze_until` + `assigned_to`
> er nullable og giver ingen ADD COLUMN-problemer.

### Hvorfor `handling_status` ved siden af `status` (og ikke i stedet for)

`mail_threads.status` slås op af **fire** læsere på `'active'`: [services/mailService.js](../services/mailService.js)
(thread-matching for bon/kunde/PO/leverandør), [routes/mail.js](../routes/mail.js),
[routes/orders.js](../routes/orders.js), [routes/purchasing.js](../routes/purchasing.js) (+ `supplier_inbox.js`,
`indkob.js` i frontend). At skifte CHECK-vokabularet på `status` ville ramme alle fire og er unødvendigt.
`handling_status` er en **ny, isoleret dimension** der kun gælder kunde-vendte tråde — blast-radius = indbakken alene.

---

## 3. Status-model & transitions

`handling_status` har tre værdier. **Snooze er ortogonal** (`snooze_until`-felt), ikke en status — en udsat
tråd er stadig `aaben`, men skjules fra Åbne til datoen. `status` (`active/closed/archived`) lever videre
uberørt som teknisk trådstatus.

```
                 ny inbound (ukendt/kendt)
                          │
                          ▼
   ┌──────────────────  AABEN  ──────────────────┐
   │  (vises i "Åbne" hvis snooze_until er NULL/passeret)
   │                                              │
   │  vi sender svar (composer)                   │  "Afslut"
   ▼                                              ▼
AFVENTER_KUNDE  ────────────────────────────►  AFSLUTTET
   │   (auto: snooze_until = now + rykker-dage)     │   (arkiv — fuldt søgbar)
   │                                                │
   └──────────  inbound fra kunde  ◄───────────────┘
                 → handling_status = AABEN, snooze_until = NULL  (AUTO-GENÅBNING)
```

**Regler (backend håndhæver — kun for tråde hvor `handling_status IS NOT NULL`):**
- Ny inbound på en `afsluttet`/`afventer_kunde`/snoozet tråd → `aaben`, `snooze_until=NULL`, `has_unread=1`.
  *Dette fanger "det uforudsete".*
- Snooze passeret (`snooze_until <= now`) → behandles som `aaben` i alle visninger (lazy-evalueres i query;
  valgfri cron til at nulstille feltet).
- Auto-bekræftelse (booking o.l.) → message med `is_system=1`; tråden sættes `handling_status='afsluttet'`
  (intet svar forventet → fylder ikke i Åbne). Svarer kunden → auto-genåbnes.
- Sender svar via composer → `out`-message, `handling_status='afventer_kunde'`,
  `snooze_until = now + inbox_snooze_default_days` (hvis "rykk mig"-toggle til).
- **Læst ≠ håndteret:** at åbne en tråd sætter `is_read=1` på inbound-beskeder + `has_unread=0`, men ændrer
  **ikke** `handling_status`.
- Når et svar sendes/afsluttes opdateres også `status` til `active` hhv. `closed` for konsistens med de gamle
  læsere (additivt — bryder intet).

---

## 4. Backend — API

Alle endpoints under `/api/mail` (udvid [routes/mail.js](../routes/mail.js), som allerede har thread-endpoints).
**Identitet altid fra `req.session.userId`** — aldrig fra body (princip fra patch-audit). Backend pre-computer
alt afledt (`snoozed`, `last_outbound_at`, badge-tal); frontends beregner intet. Alle thread-queries filtrerer
på `handling_status IS NOT NULL` så PO/leverandør-tråde aldrig lækker ind i indbakken.

| Metode & rute | Funktion |
|---|---|
| `GET /api/mail/threads?status=&mailbox=&q=&limit=` | Liste over kunde/bon-tråde. `status=aabne` skjuler snoozede; `status=udsat` returnerer kun snoozede (`snooze_until > now`); `status=kunde`/`luk` → `afventer_kunde`/`afsluttet`; `q` søger på tværs af **alt inkl. afsluttede og beskedtekst**. `mailbox` filtrerer via `mail_messages.mailbox`. Hver tråd returnerer pre-computed: `handling_status, snoozed(bool), last_inbound_at, last_outbound_at, has_unread, link{type,label}, assignee`. |
| `GET /api/mail/threads/:id` | Tråd + beskeder (sorteret, `direction in/out`, `is_system`). **Markerer inbound som læst** (`is_read=1`, `has_unread=0`). |
| `POST /api/mail/threads/:id/reply` | `{ body, template_id?, remind_days? }` → send via `mailService.sendMail/sendFromTemplate` (emne får `{{tag}}` så svar routes), append `out`-message, `handling_status='afventer_kunde'`, `status='active'`, sæt `snooze_until` hvis `remind_days`. |
| `PATCH /api/mail/threads/:id` | `{ handling_status?, snooze_until?, assigned_to? }` → afslut (`afsluttet`+`status='closed'`) / udsæt / manuel tildeling. |
| `POST /api/mail/threads/:id/create-bon` | Returnér prefill `{ customer_id, company_id, name, email }` (matchet på afsenderadresse) til bon-draweren; ved gem knyttes tråden (`mail_threads.bon_id`). |
| `GET /api/mail/threads/count?scope=open` | Badge-tal: tråde m. `handling_status='aaben'` og ikke-snoozet. Bruges af CRM-pill + mobil-fane. |

**Indgående IMAP-routing** ([services/mailService.js](../services/mailService.js) — ændr den eksisterende
unmatched-gren, l. ~589–632):
1. Parse emne for tag (`#b-`/`#k-`/`#t-` via settings-prefixes) + `In-Reply-To`-header.
2. Match tråd via tag eller `message_id`/`in_reply_to` → append + auto-genåbn (regel §3).
3. Intet match, **kendt** kunde-email → ny tråd, `customer_id` sat, `handling_status='aaben'`,
   `mailbox` = modtager (bon@/kontakt@).
4. Intet match, **ukendt** → **ny tråd** (`customer_id=NULL`, `handling_status='aaben'`) — *i stedet for*
   `mail_unmatched`. "⚠︎ ikke knyttet"-filteret i UI erstatter den gamle ufordelt-liste.

**SSE:** behold `mail_received`. Tilføj `mail_thread_updated { thread_id, handling_status, has_unread }`.
Office- og mobil-handlere re-loader liste + badge (debounced, jf. mønster i `mobile/index.html`).
`mail_unmatched`-eventet udfases sammen med tabellen (se §8).

---

## 5. Frontend — Office (opgradering af eksisterende Indbakke)

Office har allerede en Indbakke under CRM-topbaren ([crm-inbox.js](../office/views/crm-inbox.js)).
Den skifter fra `mail_unmatched`+`kind`-hacket til den rene `mail_threads`-model:

- **Filter-chips:** Åbne · ⏰ Udsat · Afventer kunde · Afsluttet · Alle + kilde (bon@/kontakt@).
  "Mine" kun når `inbox_assignment_enabled=1`.
- **3-panel:** filtre → trådliste (gruppe-render via [shared/mail_thread.js](../shared/mail_thread.js)) → læserude m. composer.
- **Læserude-handlinger:** ✓ Afslut · ⏰ Udsæt (i morgen / 3 dage / 1 uge / 1 mdr) · 📋 Opret bon fra mail ·
  🔗 Knyt (hvis `customer_id`/`bon_id` mangler).
- **Sendt-synlighed:** `out`-beskeder vises m. *"↗ Sendt {tid} · {navn}"*; `is_system=1` vises m.
  *"⚙︎ Auto-sendt · system"*. Liste-rækker i Afventer/Afsluttet viser `last_outbound_at`.
- "⚠︎ ikke knyttet"-markør på tråde uden `bon_id`/`customer_id` (afløser ufordelt-listen).

---

## 6. Frontend — Mobil (`mobile/views/crm.js`)

Tilføj **3. fane** til den eksisterende `_mcTab`-router (i dag `'calls' | 'search'` → tilføj `'inbox'`):

```
CRM:  [ Service calls ]  [ Kunder ]  [ Indbakke • ]
```

- **Undertabs:** Åbne · ⏰ Udsat · Afventer · Afsluttet (badge = open-count fra `/api/mail/threads/count`).
- **Rækker:** afsender (fed=ulæst via `has_unread`), emne, kilde-tag, status-pill, snooze-chip,
  *"↗ Sendt …"* på besvarede.
- **Swipe:** genbrug bons-viewets rigtige touch-swipe-mønster (mockup'ens swipe er kun demo) →
  venstre: ✓ Afslut / ⏰ Udsæt.
- **Tap → bottom-sheet læser** m. tråd (genbrug `shared/mail_thread.js`) + hurtigsvar + Afslut/Udsæt.
  **Afløser `mailto:`-bouncet** i service-calls og Kunde-360 — disse linker nu ind i læseren.
- **Snooze-presets:** genbrug `_MC_DUE_CHIPS` — samme UX som "ring tilbage".
- **SSE:** udvid `_mcrmHandleSSE` til `mail_thread_updated` → re-render aktiv undertab + badge.
  Bons-nav-badgen (pending-inbox) er uændret den globale tæller.
- Aktivitets-timeline (`email_in`/`email_out`) er fortsat read-only historik pr. kunde — uændret.

---

## 7. Edge cases & kendt begrænsning

| Situation | Håndtering |
|-----------|-----------|
| Kunde svarer uden emne-tag | Match via `In-Reply-To`/`message_id` (fallback) |
| Mail fra kendt kunde uden tag | Ny tråd m. `customer_id` sat (§4 pkt. 3) |
| Mail fra ukendt afsender | Ny tråd `customer_id=NULL`, vises under "⚠︎ ikke knyttet" |
| Samme mail relevant for flere bonner | Primær `bon_id` i tråden; manuel ekstra-knytning senere |
| PO/leverandør-tråd skal aldrig i indbakken | Sikret af `handling_status IS NOT NULL`-filteret — de har NULL |
| **Svar sendt fra Outlook/Apple Mail i stedet for composer** | Systemet kan **ikke** sætte `afventer_kunde` automatisk. Afhjælpning (senere): poll Sendt-mappen og match på `Message-ID`/`In-Reply-To`. **Indtil da: opfordr til at svare i appen.** |

---

## 8. Uden for scope (senere)

- **Drop af `mail_unmatched`-tabellen.** Ny routing (§4) skriver ukendt inbound som tråde, men de
  **eksisterende åbne `mail_unmatched`-rækker** skal migreres til tråde i en opfølgende migration —
  inkl. at re-pointe `mail_attachments.unmatched_id` → `message_id`. Behold tabellen + crm-inbox.js'
  unmatched-gren indtil migreringen er kørt og verificeret. (Samme forsigtighed som `_old_bon_mails`.)
- Poll af Sendt-mappe (ekstern-svar-detektion).
- Fuld "Mine"/team-tildeling som default (afventer flere salgsbrugere).

---

## Næste opgave (kopiér til CLAUDE.md)

```
### Næste opgave: Samlet indbakke (CLAUDE_INDBAKKE.md)
0. Bygger oven på migration 018 (mail_threads/mail_messages findes). Opret INGEN mail-tabeller.
1. Migration 1NN_inbox_handling.sql: ALTER mail_threads (+handling_status/snooze_until/assigned_to/
   last_inbound_at/last_outbound_at/has_unread) + ALTER mail_messages (+is_system) + backfill
   (kun kunde/bon-tråde, PO/leverandør forbliver NULL) + settings-nøgler.
2. Backend /api/mail/threads* (liste/tråd/reply/patch/create-bon/count) — identitet fra session,
   filtrér handling_status IS NOT NULL, direction 'in'/'out', alt afledt pre-computed.
3. IMAP-routing (mailService): ukendt inbound → ny tråd (customer_id=NULL) i stedet for mail_unmatched;
   auto-genåbning. SSE: mail_thread_updated.
4. Office crm-inbox.js: skift fra mail_unmatched+kind-hack til ren mail_threads-model (filtre, snooze,
   sendt-synlighed, ⚠︎ ikke knyttet).
5. Mobil crm.js: 3. fane "Indbakke" (undertabs, rigtig swipe, bottom-sheet læser) — afløs mailto-bounce.
Flag: inbox_assignment_enabled=0 (tildeling skjult).
Følger senere (§8): migrér eksisterende åbne mail_unmatched-rækker → tråde + drop tabellen.
Begrænsning: eksterne svar (Outlook/Apple Mail) opdaterer ikke status automatisk.
```
