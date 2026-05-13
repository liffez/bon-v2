# PATCH_F_sse_broadcast_consolidation.md (v3 — omskrevet)

> Konsolideringspatch til Bon v2 — standardisér SSE payload-shape på tværs af
> `bon_*`/`notification`-events, OG tilføj manglende broadcasts på PUT/DELETE lines.
>
> Lukker tre findings i én sammenhængende ændring:
> - **F49** — `bon_status` + `notification` + POST lines bruger `bon_id` i stedet for `id`
> - **F57** — PUT `/api/bons/:id/lines/:lid` mangler broadcast
> - **F58** — DELETE `/api/bons/:id/lines/:lid` mangler broadcast
>
> **Bevidst udenfor scope:** Mail-events (`mail_received`, `mail_sent`,
> `po_mail_*`, `supplier_mail_*`) er polymorfe — de indeholder `bon_id`,
> `customer_id`, `purchase_order_id`, `supplier_id` som mulige FK'er. Her
> har `bon_id` semantisk værdi (det fortæller specifikt at det er bonens
> id, ikke trådens). Disse bevares uændret.
>
> **v3 omskrevet** efter Claude Codes andet review fandt 1 yderligere problem i v2:
> - F-5: v2 inkluderede `shared/utils.js` (linje 119, 150) i frontend-scope.
>   Disse forekomster læser `data.bon_id` fra **`mail_received`-event**, ikke
>   fra `bon_*`/`notification`-events. Hvis utils.js opdateres som beskrevet
>   i v2, knækker mail-toast + mail-badge på bon-kort. **utils.js er fjernet
>   fra scope i v3.**
>
> **v2 omskrevet** efter Claude Codes første review fandt 4 problemer i v1:
> - F-1: v1 pegede på `bons-list.js` for frontend-fix — den fil re-fetcher
>   og rører ikke event-payload
> - F-2: Reelt scope er ~22 forekomster i **4 filer** (kitchen/today.js,
>   kitchen/later.js, shared/bon_drawer.js, shared/flyver.js linje 128)
> - F-3: 2 af 4 test-case-opdateringer var defensive (PASS uanset broadcast).
>   Skal strammes til at REQUIRE broadcast
> - F-4: `grep "data\.bon_id"` fanger falske positive — DB-row properties som
>   `c.bon_id`, `notif.bon_id` må IKKE røres

---

## Sammenfattende

| # | Sted | Ændring |
|---|------|---------|
| 1 | `routes/bons.js:343` | `bon_status` payload: `bon_id` → `id` |
| 2 | `routes/bons.js:470` | `bon_updated` (POST lines): `bon_id` → `id` |
| 3 | `routes/bons.js:604` | `notification` payload: `bon_id` → `id` |
| 4 | `routes/bons.js:~503` | **Tilføj** `broadcast('bon_updated', { id: bonId })` (F57) |
| 5 | `routes/bons.js:~519` | **Tilføj** `broadcast('bon_updated', { id: bonId })` (F58) |
| 6 | **5 frontend-filer** (~25 forekomster) | Skift event-payload-læsning fra `data.bon_id` til `data.id`. **Manuel** vurdering pr. fil — IKKE auto-erstat |

---

## Ændring 1-5 — Backend (uændret fra v1)

Backend-ændringerne er **korrekt identificeret** i v1. Genciteres her for fuldstændighed.

### Ændring 1 af 6 — `bon_status`-payload (linje 343)

**Find:**
```javascript
    broadcast('bon_status', { bon_id: id, old: bon.current_code, new: status_code });
```

**Erstat med:**
```javascript
    broadcast('bon_status', { id, old: bon.current_code, new: status_code });
```

### Ændring 2 af 6 — `bon_updated`-payload på POST lines (linje 470)

**Find:**
```javascript
    broadcast('bon_updated', { bon_id: bonId });
```

**Erstat med:**
```javascript
    broadcast('bon_updated', { id: bonId });
```

### Ændring 3 af 6 — `notification`-payload (linje 604)

**Find:**
```javascript
    broadcast('notification', { bon_id: bonId, notification: notif, sender_client_id: client_id ?? null });
```

**Erstat med:**
```javascript
    broadcast('notification', { id: bonId, notification: notif, sender_client_id: client_id ?? null });
```

### Ændring 4 af 6 — Tilføj broadcast på PUT lines (F57)

**Find** (omkring linje 500-504, lige før `res.json(...)`):
```javascript
    // Server-autoritativ recalc af bons.total_price
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: req.session?.userId ?? null });

    res.json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(lineId));
}));
```

**Erstat med:**
```javascript
    // Server-autoritativ recalc af bons.total_price
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: req.session?.userId ?? null });

    broadcast('bon_updated', { id: bonId });
    res.json(db.prepare(`SELECT * FROM bon_lines WHERE id = ?`).get(lineId));
}));
```

### Ændring 5 af 6 — Tilføj broadcast på DELETE lines (F58)

**Find** (omkring linje 517-520, lige før `res.json(...)`):
```javascript
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: req.session?.userId ?? null });
    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', oldValue: `${line.quantity}x ${line.product_name}`, notes: 'linje slettet' });
    res.json({ deleted: lineId });
}));
```

**Erstat med:**
```javascript
    recalcBonTotal(db, bonId, { logIfChanged: true, userId: req.session?.userId ?? null });
    logChange({ entityType: 'bon', entityId: bonId, action: 'update', fieldName: 'bon_lines', oldValue: `${line.quantity}x ${line.product_name}`, notes: 'linje slettet' });
    broadcast('bon_updated', { id: bonId });
    res.json({ deleted: lineId });
}));
```

---

## Ændring 6 — Frontend (REVIDERET fra v2)

**v1's fejl:** Pegede på `bons-list.js` som dækkende. Den fil **re-fetcher
hele listen** når den modtager `bon_created`/`bon_updated`-events.

**v2's fejl:** Inkluderede `shared/utils.js` i scope. Den fils `data.bon_id`-
forekomster er fra `mail_received`-event (polymorft) — udenfor patch'ens
scope. Hvis det opdateres, knækker mail-toast.

**v3's scope:** 4 frontend-filer der læser event-payload fra netop de
events patch'en omdøber (`bon_status`, `bon_updated`, `notification`):

### 6.1 — kitchen/today.js (linje 139, 140, 142, 154, 170, 171, 175)

Lytter på `bon_status`, `notification`, `bon_updated`. Mønster:
`suppress-cache + DOM-lookup + fetchBon`. Hver event-handler bruger
`data.bon_id` til at finde DOM-elementet eller fetche en specifik bon.

**Action:** Erstat `data.bon_id` med `data.id` på hver af de 7 forekomster.

### 6.2 — kitchen/later.js (linje 148, 170, 186, 187, 191)

Samme 3 events, samme mønster. 5 forekomster.

**Action:** Erstat `data.bon_id` med `data.id`.

### 6.3 — shared/bon_drawer.js (linje 948, 954)

Mønster:
```javascript
data.id == this.bonId || data.bon_id == this.bonId
```

Det er **fallback-pattern** — læser begge fordi backend var inkonsistent.
Efter patch er fallback unødvendig.

**Action:** Skift til
```javascript
data.id == this.bonId
```

### 6.4 — shared/flyver.js (KUN linje 128)

Linje 128 lytter på `notification`-event:
```javascript
if (data.bon_id && !notif.bon_number) {  // ← event-payload, skal opdateres
```

**Action:** Skift `data.bon_id` til `data.id`. KUN denne ene forekomst.

**IKKE røres:** linje 177, 179, 188, 190 bruger `notif.bon_id` — det er
**property på notification DB-row** (FK-kolonne), ikke event-payload.

### 6.5 — IKKE røres (verificeret)

| Fil | Hvorfor |
|-----|---------|
| `office/views/bons-list.js` | Re-fetcher, læser ikke event-payload (verificeret: `_blHandleBonCreated`/`_blHandleBonUpdated` ignorerer data) |
| **`shared/utils.js` linje 119, 150** | **Lytter på `mail_received`-event (polymorft, udenfor scope). Skift ville knække mail-toast/badge** |
| `shared/flyver.js` linje 177/179/188/190 | `notif.bon_id` — DB-row property på notification-objekt |
| `office/views/crm-dashboard.js:773, 793` | `data.bon_id = bonId` — sender som body til API, ikke event-payload |
| `mobile/views/crm.js:367, 396` | Samme som crm-dashboard.js |
| Alle SQL-queries på `bon_id`-kolonne | DB-schema, ikke event-payload |

---

## Verifikations-grep (efter ændringer)

Klar til at validere at intet er glemt eller fejlagtigt ændret:

```bash
# Skal returnere 0 — alle event-payload-læsninger på bon_*/notification er nu data.id
grep -rn "data\.bon_id\b" kitchen/today.js kitchen/later.js shared/bon_drawer.js

# shared/flyver.js skal IKKE returnere linje 128 (ændret) — men 177/179/188/190 forbliver
grep -rn "data\.bon_id\b" shared/flyver.js
# Forventet output: ingen — kun notif.bon_id (DB-row) er tilbage

# shared/utils.js skal returnere 2 forekomster — det er mail_received (udenfor scope)
grep -rn "data\.bon_id\b" shared/utils.js
# Forventet output: linje 119 + 150 (begge mail_received-relateret, bevidst uændret)

# Skal returnere de 4 "ikke-røres"-steder (crm-dashboard, mobile/crm)
grep -rn "data\.bon_id\b" office/views/crm-dashboard.js mobile/views/crm.js

# Skal returnere DB-row properties (notif.bon_id, c.bon_id, etc.) — uændret
grep -rn "\.bon_id" routes/ services/ db/

# Skal returnere 0 — alle event-payloads i routes/bons.js er nu {id}
grep -n "broadcast('bon_\\|broadcast('notification'" routes/bons.js | grep "bon_id"
```

---

## Test-cases — strammet (REVIDERET fra v1)

### Skal strammes til at REQUIRE broadcast

**T_BDR_PUT_07** og **T_BDR_DEL_05** var i v1 markeret som "vipper retning"
men er faktisk **defensive** — de asserter ikke at broadcast IKKE er der.
Efter patch skal de eksplicit REQUIRE at broadcast er der.

**Før strammen:**
```javascript
// T_BDR_PUT_07 (defensiv version — PASS uanset)
const events = await collectEvents(timeoutMs);
// no assertion on event count → PASS even if broadcast missing
```

**Efter strammen:**
```javascript
// T_BDR_PUT_07 (eksplicit krav — kun PASS hvis broadcast modtaget)
await waitForEvent('bon_updated', e => e.id === bonId, 2000);
// Throws if event not received within 2s
```

### Eksplicit retnings-skift

**T_BD_C_SSE_02** — skifter assertion:
- Før: `assert(data.bon_id === bonId)` (verificerede F49-bug)
- Efter: `assert(data.id === bonId)` (verificerer fix)

**T_BL_SSE_UPDATE_02** — skifter assertion:
- Før: dokumenterede `{bon_id}` form
- Efter: forventer `{id}` form

### Nye cases at tilføje

```
T_PATCH_F_01: PUT line → bon_updated event modtages indenfor 2s med {id: bonId}
T_PATCH_F_02: DELETE line → bon_updated event modtages med {id: bonId}
T_PATCH_F_03: PATCH status → bon_status event payload har id (ikke bon_id)
T_PATCH_F_04: POST notification → notification event payload har id (ikke bon_id)
T_PATCH_F_05: Regression — POST line → bon_updated event har id (skiftet fra bon_id)
```

Disse 5 cases samles i `tests/scripts/run_T_PATCH_F_REGRESSION.js`.

---

## Verificering efter patch

### 1. Backend-fix uden frontend

Forventet: backend grøn, frontend brækket
```bash
npm run test:reset
npm run test:server &

# Backend regression — alle skal PASS
npm run test:run-bon              # 25/25
npm run test:run-bons-list        # 77/78
npm run test:run-bon-drawer-core  # 61/61 efter SSE_02 update
npm run test:run-bon-drawer-rel   # 69/70 efter PUT_07/DEL_05 strammen
```

### 2. Frontend-fix anvendt

```bash
# Verifikations-grep skal returnere de forventede resultater
# (se §"Verifikations-grep" ovenfor)

# Manuel browser-test:
# - Åbn /kitchen/today.html i én fane
# - Åbn /office/index.html i en anden
# - Foretag PATCH bon status i fane 2
# - Verifier at fane 1 reagerer i realtid
```

### 3. Patch F regression-suite

```bash
npm run test:run-patch-f          # 5/5 forventet
```

---

## Status-opdatering i TEST_OBSERVATIONS

```markdown
### #027 — SSE payload-inkonsistens på bon-events (lukket)
| | |
|--|--|
| **Status** | `lukket` (maj 2026) |
| **Fix** | `PATCH_F_sse_broadcast_consolidation.md` v2 — alle 6 bon-events bruger nu `{id, ...metadata}`. bon_id-fallback fjernet fra 5 frontend-filer (~25 forekomster). CRM service-calls bevares (de sender bon_id som body-felt til API, ikke event-payload). Konsoliderede F49, F57, F58 i samme patch. |

### #030 — PUT lines manglede SSE broadcast (lukket)
| | |
|--|--|
| **Kilde** | T_BDR_PUT_07 (maj 2026) |
| **Vurdering** | UX-gap. Fixed maj 2026 via `PATCH_F_sse_broadcast_consolidation.md` v2 — broadcast tilføjet før response. T_PATCH_F_01 dækker regression. |
| **Status** | `lukket` (maj 2026) |

### #031 — DELETE lines manglede SSE broadcast (lukket)
| | |
|--|--|
| **Kilde** | T_BDR_DEL_05 (maj 2026) |
| **Vurdering** | UX-gap. Fixed maj 2026 — samme patch som #030. T_PATCH_F_02 dækker regression. |
| **Status** | `lukket` (maj 2026) |
```

---

## Rollback

Backend-fix + frontend-opdatering bør være **én commit** (eller én PR med
multiple commits i rækkefølge backend → frontend). `git revert` reverter
alt sammen.

**Bagudkompatibilitets-overvejelse:** Hvis nogen klient har gemt en åben
SSE-forbindelse i en browser-fane før upgrade, vil den fane modtage `{id}`-
events efter upgrade men måske stadig læse `e.bon_id`. Det er en kortvarig
issue indtil siden reloades. Acceptabel for et internt værktøj.

---

## v1 → v2 lektioner

Tre lektioner fra Claude Codes review:

1. **Frontend-scope skal verificeres eksplicit** — det er ikke nok at sige
   "find alle steder" uden at have set hvilke filer der faktisk læser
   event-payloads. v1 antog `bons-list.js` var dækkende fordi det er
   listview, men den fil re-fetcher
2. **Test-cases der "vipper retning" skal verificeres** — defensive cases
   (PASS uanset adfærd) skifter ikke retning, de bare fortsætter med at
   PASSE. Skal strammes for at have værdi
3. **Grep'er giver falske positive** — `data.bon_id` matcher både event-
   payload-læsning OG DB-row properties. Auto-erstat kan bryde fungerende
   kode. **Manuel review pr. fil**

---

*v2 oprettet: maj 2026 — efter Claude Codes review af v1 fandt 4 reelle
problemer (forkert frontend-fil, undervurderet scope, defensive tests,
falske positive i grep). v1's backend var korrekt — kun frontend-scope og
test-stramning er nødvendig at justere.*
