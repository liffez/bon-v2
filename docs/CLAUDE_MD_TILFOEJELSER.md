# Tilføjelser til CLAUDE.md

## 1. Filstruktur — tilføj i `shared/`-listen

Find linjen:
```
│   ├── varemodtagelse.js + varemodtagelse.css  ← Varemodtagelse
```

Tilføj EFTER:
```
│   ├── supplier_inbox.js + supplier_inbox.css  ← Leverandørpost (office sidebar-view)
```

---

## 2. Filstruktur — opdater `routes/orders.js`-beskrivelse

Find:
```
│   ├── orders.js     ← /api/orders/* (purchase_orders CRUD)
```

Erstat med:
```
│   ├── orders.js     ← /api/orders/* (purchase_orders CRUD + mail-tråd per PO)
```

---

## 3. API-oversigt — tilføj under orders-endpoints

Find blokken:
```
GET    /api/orders/archive                                 routes/orders.js
```

Tilføj EFTER:
```
GET    /api/orders/pending/:id/mail                        routes/orders.js
POST   /api/orders/pending/:id/mail                        routes/orders.js
PATCH  /api/orders/pending/:id/mail/read                   routes/orders.js
GET    /api/orders/mail-threads?unread_only=               routes/orders.js
```

---

## 4. Mail-sektion — opdater IMAP-linje

Find:
```
IMAP polling hvert 5. minut — router mails via `#B{num}` og `#K{num}` tags i emne.
```

Erstat med:
```
IMAP polling hvert 5. minut — router mails via `#B{num}`, `#K{num}` og `#PO{num}` tags i emne.
`#PO{num}` knyttes til purchase_orders via mail_threads.purchase_order_id.
```

Find:
```
| `smtp_kontakt` (kontakt@) | kontakt@ristetrug.dk | Leverandør-bestillinger, CRM-mail |
```

Erstat med:
```
| `smtp_kontakt` (kontakt@) | kontakt@ristetrug.dk | Leverandør-bestillinger, PO-tråde, CRM-mail |
```

---

## 5. Status — tilføj ny fase-sektion

Find sektionen `### Firma-oprydning og CVR-berigelse (april 2026)` og tilføj
følgende EFTER hele den sektion:

```markdown
### Fase 6e — Leverandørpost (🔲 ikke påbegyndt)
- [ ] Migration 034: `mail_threads.purchase_order_id` + `purchase_orders.mail_thread_id`
- [ ] `routes/purchasing.js` — PATCH supplier accepterer `contact_email`
- [ ] `shared/indkob_settings.js` — "Bestillingsmail"-felt i leverandør-redigering
- [ ] `routes/orders.js` — opret mail_thread + tag emne med `#PO{id}` ved `send_email: true`
- [ ] `routes/orders.js` — GET/POST /:id/mail + PATCH /:id/mail/read + GET /mail-threads
- [ ] `services/mailService.js` — IMAP-parser: `#PO\d+` → purchase_order_id routing
- [ ] `shared/indkob.js` + `shared/indkob.css` — mail-badge + inline tråd på PO-kort
- [ ] `office/views/supplier-inbox.js` — sidebar-view: liste + tråd-preview + svar
- [ ] `office/index.html` — "Leverandørpost" sidebar-punkt under Drift-gruppen
- [ ] SSE: `po_mail_received` + `po_mail_sent` events

Spec: `docs/CLAUDE_LEVERANDOR_MAIL.md`
```

---

## 6. Næste opgave — tilføj under `**Åbne design-beslutninger:**`

```
- Leverandørpost (Fase 6e): spec klar i CLAUDE_LEVERANDOR_MAIL.md.
  Prioriteres efter "Priser i planlægningsbon + Ugeoversigt".
```
