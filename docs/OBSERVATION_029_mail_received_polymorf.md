# OBSERVATION_029_mail_received_polymorf.md

> Observation der skal tilføjes til `docs/TEST_OBSERVATIONS.md` som #029.
>
> **Dette er ikke en bug** — det er en konvention der dokumenteres for at
> forhindre fremtidige patches i at "rydde op" i det fejlagtigt.

---

## Entry til TEST_OBSERVATIONS.md

```markdown
### #029 — Polymorfe mail-events bruger semantisk `bon_id` (bevidst-accepteret, konvention)

| | |
|--|--|
| **Kilde** | Claude Code review af `PATCH_F_sse_broadcast_consolidation.md` v1+v2 (maj 2026) |
| **Beskrivelse** | `services/mailService.js` udsender 5+ broadcasts der ALLE har polymorf payload: `mail_sent`, `mail_received`, `po_mail_sent`, `po_mail_received`, `supplier_mail_sent`, `supplier_mail_received`. Hver payload indeholder mellem 4-5 forskellige FK'er: `{bon_id, customer_id, purchase_order_id, supplier_id, thread_id, unread_count}`. Det er fordi en mail KAN handle om en bon, en kunde, en purchase-order eller en supplier (eller en kombination). |
| **Vurdering** | **Korrekt design** — semantiske felt-navne er nødvendige fordi events er polymorfe. At omdøbe `bon_id` til generisk `id` ville miste betydning og bryde mail-toast + mail-badge i `shared/utils.js:119,150`. |
| **Konvention** | `bon_*`-events bruger `{id}` (kun bon-kontekst). `mail_*`-events + andre polymorfe events bevarer semantiske FK-navne (`bon_id`, `customer_id`, etc.). Fremtidige patches der "rydder op" i SSE-konsistens skal **kun** ramme bon-kun events |
| **Berørte filer** | `services/mailService.js` (linje 318, 320, 323, 567, 613, 616, 619). Frontend `shared/utils.js` (linje 119, 150) bruger `data.bon_id` korrekt — IKKE en bug |
| **Foreslået action** | N/A — dokumentation af konvention. Patch F v3 respekterer dette ved kun at røre bon-events. |
| **Status** | `bevidst-accepteret` (maj 2026) |
```

---

## Konsekvenser for fremtidig kode

Når nye SSE-broadcasts tilføjes, brug disse regler:

| Event-type | Payload-konvention |
|---|---|
| `bon_*` (bon_created, bon_updated, bon_status) | `{id, ...metadata}` — id er altid bon-id |
| `mail_*` (mail_received, mail_sent, etc.) | Polymorft — flere semantiske FK'er, brug navngivne felter |
| `po_*`, `supplier_*` | Polymorft, samme konvention |
| `notification` | Bon-specifikt — `{id, notification, sender_client_id}` |

**Tommelfingerregel:** Hvis event'en kan handle om mere end ÉN entitet,
brug navngivne FK'er (`bon_id`, `customer_id`, etc). Hvis event'en altid
handler om præcis ÉN entitet, brug generisk `id` med klart event-navn.

---

## Konsekvenser for tests

Patch F v3's test-cases skal være forsigtige:

- **bon_*-events:** test for `data.id`
- **mail_*-events:** test for `data.bon_id` (eller hvilken FK der relevant)

T_BON_DRAWER_LINES_AND_RELATIONS §4.11 (mail read tests) bør verificere
at `bon_updated`-payload bruger `{id}` (det er en bon-event), MEN at
mail-receive-flowet bruger semantisk `bon_id` (det er en polymorf
mail-event).

---

## Slutstatus (efter denne entry)

```
29 observations total

Lukkede: 20 (#005, #006, #007, #010-#012, #013-#015, #017-#026, #028)
Bevidst-accepteret: 3 (#001, #016, #029)
Åbne lav-prio: 6 (#002, #003, #004, #008, #009, #027)
```

---

*Oprettet: maj 2026 — efter Claude Codes review af PATCH F v2 afdækkede
at polymorfe mail-events ikke er en del af SSE-konsistens-clean-up'en.*
