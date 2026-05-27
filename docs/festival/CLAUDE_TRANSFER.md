# CLAUDE_TRANSFER.md — Vareflyt mellem lokationer (HQ ↔ Trailer)

> **Mål:** Flytte varer mellem to fysiske lokationer (HQ ↔ Trailer) med svind-registrering
> og fuld sporbarhed. To trin: send → modtag. Symmetrisk, så retur virker gratis.
>
> **Hviler på:** §6d klon-doktrin (identiske Grocy-instanser → **identiske id'er**) og
> `CLAUDE_LOKATION.md` (`getGrocyConnection(locationId)`).
> **Forenklet af:** identiske id'er — ingen cross-instans produkt-bro nødvendig.

---

## 1. Produkt-opslag — klon-klar og kæde-klar på samme tid

To driftsmønstre bruger transfer (se §6d): **festival** (klon → identiske id'er) og **kæde**
(permanente instanser, fælles katalog via sync → id'er *ikke* nødvendigvis identiske).

For at virke i begge **slår `transferStock` altid op via `global_key`** (userfield på produkter),
ikke rå `product_id`:

| Mønster | Id-identitet | global_key |
|---|---|---|
| Festival (klon) | id'er matcher 1:1 | opslag overflødigt men harmløst — billig forsikring |
| Kæde (sync) | id'er matcher ikke | opslag **nødvendigt** — den eneste stabile bro |

Ved at gøre `global_key`-opslag til den primære vej allerede nu virker transfer uændret den
dag den anden instans ikke er en klon. Koster næsten intet i festival; sparer omskrivning ved kæde.

> Festival forenkler stadig alt det andet: samme enheder, samme opskrifter, ingen drift —
> fordi klonen er identisk. Det er kun *opslags-vejen* der holdes generel.

---

## 2. Tilstandsmaskine

Symmetrisk: `from_location_id` / `to_location_id` er generiske, så HQ→Trailer og Trailer→HQ
er **samme maskine**.

| State | Betyder | Grocy-effekt ved indgang (via API) | Sat hvor |
|-------|---------|-----------------------------------|----------|
| `kladde` | bygger pakken | intet | fra-lokation |
| `sendt` | undervejs (i bilen) | book **UD** af fra-Grocy (`qty_sent`) | ved afsendelse |
| `modtaget` | ankommet | book **IND** i til-Grocy (`qty_received`) | ved modtagelse |
| `annulleret` | rullet tilbage | hvis var `sendt`: book ind igen i fra-Grocy | fra/admin |

Overgange: `kladde→sendt` (book ud) · `sendt→modtaget` (book ind + registrér modtaget) ·
`sendt→annulleret` (book tilbage) · `kladde→annulleret` (intet at rulle tilbage).

---

## 3. Skema (nye tabeller i Bon v2)

> Følger §3: tilføjes i `bon_v2_datamodel_v2.md` + ny migrationsfil før kode.

**`stock_transfers`** (hoved)

| Kolonne | Note |
|---------|------|
| `id` | PK |
| `from_location_id`, `to_location_id` | FK → `locations` (symmetrisk) |
| `state` | kladde \| sendt \| modtaget \| annulleret |
| `created_by`, `created_at` | |
| `sent_by`, `sent_at` | |
| `received_by`, `received_at` | |
| `notes` | |

**`stock_transfer_lines`** (linjer — derfor fanges svind)

| Kolonne | Note |
|---------|------|
| `id` | PK |
| `transfer_id` | FK → `stock_transfers` |
| `global_key` | **opslags-nøgle** (userfield) — resolver produkt i hver instans; virker for klon (id matcher) og kæde (id matcher ikke) |
| `grocy_product_id` | snapshot af id i fra-instansen (reference/log) — ikke opslags-nøgle på tværs |
| `product_name` | snapshot |
| `unit` | baseenhed |
| `qty_sent` | bookes ud |
| `qty_received` | NULL indtil modtaget |
| `best_before` | læses fra fra-Grocys lagerpost, bæres med ved book-ind |
| `booked_out`, `booked_in` | idempotens-flag pr. linje |
| `svind` | afledt: `qty_sent − qty_received` |
| `notes` | |

Changelog skrives af serveren ved hver state-overgang (§6).

---

## 4. Adapter / flow

Bruger `getGrocyConnection(locationId)` fra `CLAUDE_LOKATION.md`. Alle Grocy-kald går via
**API** (§6) — book ud = consume, book ind = inventory/add.

```
sendTransfer(id):
    conn = getGrocyConnection(from_location_id)
    for hver linje: pid = conn.resolveByGlobalKey(global_key)
                    conn.consume(pid, qty_sent)                 → booked_out=1
    state = sendt

receiveTransfer(id, modtagne_mængder):
    operatør sætter qty_received pr. linje (default = qty_sent, juster ned ved skade)
    conn = getGrocyConnection(to_location_id)
    for hver linje hvor booked_in=0:
        pid = conn.resolveByGlobalKey(global_key)
        conn.inventory(pid, qty_received, best_before)          → booked_in=1
    state = modtaget

cancelTransfer(id):
    hvis sendt: conn=getGrocyConnection(from_location_id)
                conn.inventory(conn.resolveByGlobalKey(global_key), qty_sent)
    state = annulleret
```

> `resolveByGlobalKey` slår produktet op pr. instans via userfield. I festival-klonen
> returnerer den samme id som fra-instansen (gratis); i en kæde returnerer den til-instansens
> eget id. Samme kode, begge mønstre. Umatchet global_key → fejl + log (produkt findes ikke
> i mål-instansen — skal oprettes i masteren først).

**Idempotens:** `booked_out`/`booked_in` pr. linje. Fejler book-ind midt i en batch, bliver
transferen i `sendt` (= varerne er reelt stadig undervejs), og `receiveTransfer` kører kun
linjer hvor `booked_in=0` ved retry. Aldrig dobbelt-book.

---

## 5. UI

| Skærm | Hvor | Genbrug |
|-------|------|---------|
| **Send** (pakkeliste + mængder → "Send til X") | fra-lokation (office/logistik) | — |
| **Modtag** (qty_received-justering, svind live) | til-lokation (enhedens `session.location_id`) | `varemodtagelse.js` — traileren "modtager fra HQ = leverandør" |

Retur: ny transfer `from=trailer, to=hq`; modtagelsen sker så på en HQ-enhed. Samme skærme,
ingen særkode — `from`/`to` er generiske.

---

## 6. Hvorfor svind går op af sig selv

Der bookes `qty_sent` ud af fra-Grocy, men kun `qty_received` ind i til-Grocy. Differencen
forsvinder — korrekt, for den blev tabt undervejs. `svind` står i linjen til Fødevarestyrelse-/
spild-log. Ingen kunstig rebalancering.

---

## 7. Afgrænsning

- Uafhængigt af festival-salg og af planlægnings-koblingen. Transfer er ren intern flytning.
- Den direkte leverandør-leverance til traileren er **ikke** transfer — det er almindelig
  varemodtagelse med `location = trailer` (se `CLAUDE_FESTIVAL.md`). Begge bookes ind i
  Trailer-Grocy og summer i samme ledger.

---

## 8. Verifikation

```
# Produkt-opslag (klon-klar + kæde-klar)
resolveByGlobalKey i klon → returnerer samme id ; consume HQ + inventory Trailer gyldigt
resolveByGlobalKey hvor id'er IKKE matcher (simuleret kæde) → returnerer mål-instansens eget id
umatchet global_key → fejl + log, ingen book

# To-trins
sendTransfer → fra-Grocy lager falder med qty_sent, state=sendt
receiveTransfer (qty_received < qty_sent) → til-Grocy stiger med qty_received, svind = differencen

# Idempotens
receiveTransfer kørt to gange → linjer bookes kun ind én gang
book-ind fejler på 1 linje → state forbliver sendt, retry fuldfører kun den linje

# Retur
transfer from=trailer to=hq → samme maskine, modtages på HQ-enhed

# Cancel
cancel af sendt transfer → qty_sent bookes tilbage i fra-Grocy, state=annulleret
```
