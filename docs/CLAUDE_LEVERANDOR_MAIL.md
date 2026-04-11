# CLAUDE_LEVERANDOR_MAIL.md — Leverandørpost

> Læs CLAUDE.md + bon_v2_datamodel_v2.md FØR du rører denne feature.
> Denne spec bygger direkte oven på Fase 6d (SMTP ordremail til leverandør).

---

## Formål

Når systemet sender en bestilling til en leverandør via mail, skal svaret kunne
spores og vises — for både køkkenet (der laver bestillingen) og office (der
indimellem håndterer leverandørkontakt).

Kommunikationen lever **i kontekst af bestillingen**, ikke i en generisk indbakke.

---

## Princip

- Ordremail tagges med `#PO{id}` i emnefeltet
- Svar fra leverandør routes automatisk til den korrekte PO-tråd via IMAP-parseren
- `mail_threads` udvides med `purchase_order_id` FK
- Køkkenet ser tråden inline på PO-kortet i `indkob.js`
- Office får et dedikeret sidebar-punkt "Leverandørpost" (`supplier-inbox.js`)
- Al leverandørmail kører via `kontakt@`-transporten (allerede konfigureret)

---

## Del 1 — Database

### Migration 034

```sql
-- Tilføj purchase_order_id til mail_threads
ALTER TABLE mail_threads
  ADD COLUMN purchase_order_id INTEGER REFERENCES purchase_orders(id);

CREATE INDEX idx_mail_threads_po ON mail_threads(purchase_order_id)
  WHERE purchase_order_id IS NOT NULL;
```

`mail_threads` kan nu kobles til bon, kunde **eller** purchase_order.
De tre FK-kolonner er alle nullable og udelukkende hinanden i praksis.

---

## Del 2 — Backend

### 2a. `routes/orders.js` — opret tråd ved afsendelse

Når `POST /api/orders/pending` kaldes med `send_email: true` OG leverandøren
har en `contact_email`:

1. Tilføj `#PO{purchase_order.id}` til emnelinje i `order_email`-skabelonen
   - Eksempel: `"Bestilling til Hørkram — onsdag 16. april #PO42"`
   - Tag placeres sidst i emnefeltet
2. Kald `mailService.sendFromTemplate(...)` som hidtil
3. Opret `mail_thread`:
   ```js
   INSERT INTO mail_threads (subject, purchase_order_id, status)
   VALUES (?, ?, 'active')
   // subject = ren subject UDEN #PO-tag (gem det rent)
   ```
4. Opret udgående `mail_message` i tråden:
   ```js
   INSERT INTO mail_messages
     (thread_id, direction, from_email, to_email, subject,
      body_text, sent_at, created_by_user_id)
   VALUES (?, 'out', 'kontakt@ristetrug.dk', ?, ?, ?, CURRENT_TIMESTAMP, ?)
   ```
5. Opdater `purchase_orders.mail_thread_id`:
   ```sql
   -- Tilføj kolonnen i samme migration:
   ALTER TABLE purchase_orders ADD COLUMN mail_thread_id INTEGER
     REFERENCES mail_threads(id);
   ```
   Sæt `mail_thread_id` på PO'en så opslag er O(1) fra begge sider.

Leverandører **uden** `contact_email` → uændret manuelt flow (ingen tråd oprettes).

### 2b. `services/mailService.js` — IMAP-router udvidet

IMAP-parseren poller `kontakt@`-mailboxen hvert 5. minut.
Tilføj `#PO`-routing **før** `#K`-fallback:

```
Parser-rækkefølge (emne + In-Reply-To):
1. #B{num}   → bon_id        (eksisterende)
2. #K{num}   → customer_id   (eksisterende)
3. #PO{num}  → purchase_order_id  ← NY
4. Ingen match → crm_unmatched_emails (eksisterende)
```

Ved `#PO{num}` match:
- Find `mail_thread` via `purchase_order_id = num`
  (eller via `In-Reply-To` header mod udgående `mail_messages.message_id`)
- Indsæt indgående `mail_message` i tråden (`direction = 'in'`)
- Opdater `mail_threads.updated_at`
- Broadcast SSE-event: `po_mail_received` med `{ purchase_order_id, thread_id, unread: true }`

### 2c. Nye API-endpoints i `routes/orders.js`

```
GET  /api/orders/pending/:id/mail
     → { thread, messages[] } for PO'en
     → 200 med tom messages[] hvis ingen tråd endnu

POST /api/orders/pending/:id/mail
     Body: { body_text }
     → Sender svar via kontakt@-transport
     → Gemmer udgående mail_message i tråden
     → Opdaterer mail_threads.updated_at
     → SSE broadcast: po_mail_sent

PATCH /api/orders/pending/:id/mail/read
     → Markerer alle indgående beskeder i tråden som læst
     → (Tilføj read_at kolonne på mail_messages eller brug separat flag)
```

**Ulæst-tæller:** Tilføj til `GET /api/orders/pending`-response:
```js
unread_mail: COUNT af indgående mail_messages i tråden uden read_at
```

---

## Del 3 — Settings (leverandør e-mail)

### `indkob_settings.js` — Leverandører-tab

`suppliers.contact_email` eksisterer allerede i databasen men er ikke
eksponeret i UI. Tilføj e-mail felt i leverandør-redigering:

- Felt: "Bestillingsmail" (`contact_email`)
- Placeholder: `bestilling@leverandoer.dk`
- Vis kun vist-som-tekst hvis tom: `Ingen mail — bestilling sker manuelt`
- Gem via eksisterende `PATCH /api/purchasing/suppliers/:id`
  (udvid endpoint til at acceptere `contact_email`)

Ingen ny tabel eller migration nødvendig til dette.

---

## Del 4 — Kitchen (`shared/indkob.js`)

### Badge på sendt PO

Når en PO har `sent_via = 'email'`:
- Vis mail-ikon (✉) ved siden af "Sendt"-status på PO-kortet
- Hvis `unread_mail > 0`: ikon får rød badge med antal

### Inline mail-tråd

Klik på mail-ikonet → expand sektion under PO-kortets linjeoversigt:

```
┌─────────────────────────────────────────────────────┐
│ ✉ Bestillingsmail                      [Svar]       │
├─────────────────────────────────────────────────────┤
│ → Du (kontakt@)          tirs 15. apr 09:14         │
│   "Bestilling til Hørkram — ons 16. april..."       │
│                                                     │
│ ← Hørkram               tirs 15. apr 10:33  🔴 Ny  │
│   "Hej, vi bekræfter levering onsdag..."            │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Skriv svar...                                   │ │
│ └─────────────────────────────────────────────────┘ │
│                                         [Send]      │
└─────────────────────────────────────────────────────┘
```

Detaljer:
- `GET /api/orders/pending/:id/mail` hentes ved klik (lazy load)
- Svar-felt: simpelt `<textarea>`, ingen formatering
- "Send" → `POST /api/orders/pending/:id/mail`
- Ved åbning: `PATCH /api/orders/pending/:id/mail/read`
- SSE-event `po_mail_received` → badge opdateres realtid
- Sektionen er skjult hvis `sent_via != 'email'`

---

## Del 5 — Office (`office/views/supplier-inbox.js`)

Nyt sidebar-punkt under "Drift"-gruppen: **Leverandørpost**

### Layout

To-kolonne split (identisk mønster som `crm-inbox.js`):

**Venstre: liste over aktive PO-tråde med mail**
- Sorteret: ulæste øverst, derefter nyeste `updated_at`
- Hver række:
  ```
  [Leverandørnavn]          [dato]
  Bestilling #PO42 · 3 varer
  "Hej, vi bekræfter lever..."    🔴 2 ulæste
  ```
- Klik → preview i højre kolonne

**Højre: tråd-preview**
- Leverandørnavn + PO-detaljer (dato, antal linjer, beløb)
- Fuld mailkæde (samme visning som kitchen, men bredere)
- Svar-felt
- Knap: "Gå til bestilling →" (navigerer til kitchen/purchasing.html med PO i fokus
  — eller åbner PO-detalje hvis office får en sådan visning)

### API til office-visningen

```
GET /api/orders/mail-threads?unread_only=0
→ Liste af purchase_orders med aktiv mail_thread
→ Inkluderer: supplier_name, po_id, expected_delivery_date,
              thread.updated_at, unread_count, latest_snippet
```

Implementeres i `routes/orders.js`.

---

## Del 6 — SSE events

| Event | Data | Modtages af |
|-------|------|-------------|
| `po_mail_received` | `{ purchase_order_id, thread_id, supplier_name }` | Kitchen indkob.js + office supplier-inbox.js |
| `po_mail_sent` | `{ purchase_order_id, thread_id }` | Begge (optimistisk UI fallback) |

Begge via eksisterende `broadcast()` i `shared/sse.js`.

---

## Rækkefølge for implementering

| # | Opgave | Fil | Note |
|---|--------|-----|------|
| 1 | Migration 034 | `db/migrations/034_po_mail.sql` | `mail_threads.purchase_order_id` + `purchase_orders.mail_thread_id` |
| 2 | Leverandør-email i settings | `routes/purchasing.js` + `indkob_settings.js` | Lille — felt eksisterer allerede |
| 3 | Tråd + tag ved afsendelse | `routes/orders.js` | Kernen |
| 4 | IMAP `#PO`-routing | `services/mailService.js` | Tilføj case i parser |
| 5 | Badge + inline tråd i kitchen | `shared/indkob.js` + `shared/indkob.css` | |
| 6 | Office supplier-inbox | `office/views/supplier-inbox.js` + sidebar-punkt | |

Trin 1–4 er ren backend og kan verificeres med curl/smoke-test inden frontend røres.

---

## Hvad der IKKE ændres

- `bon@`-mailboxen og `#B`-routing rører vi ikke
- `crm_unmatched_emails` bruges stadig til mails uden tag (uændret)
- `mail_templates`-tabellen: `order_email`-skabelonen opdateres kun med
  `{{poTag}}` placeholder — eksisterende skabelon-logik genbruges
- Ingen nye npm-pakker

---

*Oprettet: april 2026*
