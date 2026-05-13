# T_BON_DRAWER_LINES_AND_RELATIONS — Test-spec for bon-detalje's relationer

> Søsterspec til `T_BON_DRAWER_CORE.md`. Tester **alle relations-endpoints**
> der bygger på en eksisterende bon:
>
> - `POST /api/bons/:id/lines` — opret bon-linje (recalcs total_price)
> - `PUT /api/bons/:id/lines/:lid` — opdater linje
> - `DELETE /api/bons/:id/lines/:lid` — slet linje
> - `GET /api/bons/:id/ingredients` — aggregeret Grocy-ingredienser
> - `GET /api/bons/:id/changelog` — audit-trail
> - `POST/GET /api/bons/:id/notifications` — flyvere (kitchen notifications)
> - `POST /api/bons/:id/notifications/:nid/read` — kvittér flyver
> - `GET/POST /api/bons/:id/mail` — mail-tråde
> - `PATCH /api/bons/:id/mail/:msgId/read` — markér mail som læst
>
> Hele drawer-views funktionalitet på relation-niveau.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | 9 endpoints. Server-autoritativ recalc ved linje-mutationer, SSE-broadcasts, audit-trail integritet, attachments-validering, mail-tråd-funktion |
| **Hvad testes IKKE** | Core CRUD (T_BON_DRAWER_CORE). UI-rendering. Faktisk SMTP-send (mailService allerede testet i T_INDKOB_HORKRAM). Grocy-ingrediens-resolver (forudsætter T_RECIPES-dækning) |
| **Forhold til T_BON_DRAWER_CORE** | Sekventiel — CORE skal være kørt grøn først (oprettelse virker) før denne kan teste line-CRUD |
| **Forhold til T_INDKOB_HORKRAM** | mailService er allerede testet — vi mock'er kun her at validere kontrakten |

---

## 2. Forudsætninger

### 2.1 Pre-eksisterende test-bons

Genbruger T_BD_BASE-bonen fra T_BON_DRAWER_CORE. Hvis kørt isoleret,
opretter denne suite sin egen T_BDR_-prefix bons.

### 2.2 mailService mock fra T_INDKOB_HORKRAM

`mailService._setMockTransport` allerede tilstede. Genbruges.

### 2.3 SSE-listener

Genbrug fra T_BONS_LIST.

### 2.4 Test-recipe i Grocy

For ingredients-test: en test-bon skal have mindst én line med
`grocy_recipe_id` der peger på en eksisterende test-recipe i Grocy
(fx 'Frikadeller' fra T_RECIPES). Hvis ikke tilgængeligt, springes
`INGR_*` cases over med SKIP.

### 2.5 Test-attachments

Mail-attachments kræver pre-uploadede attachment-rows. Skitsegruppe:
opret 1-2 test-rows via direkte INSERT i `mail_attachments` med kendte
id'er. Cleanup sletter dem.

---

## 3. Strategi

### 3.1 Linje-CRUD med recalc-verifikation

```
1. snapshot_total = bon.total_price (initial = 0 hvis ingen lines)
2. POST line med quantity=2, unit_price=100
3. ASSERT response: line_total=200, line.id sat
4. ASSERT DB: bons.total_units øget med 2, bons.total_price ≈ 200
5. ASSERT changelog: 'bon_lines'-entry tilføjet
6. ASSERT SSE: bon_updated modtaget
7. CLEANUP: DELETE line, snapshot_total restored
```

### 3.2 Notifications + mail

```
1. snapshot_notif_count + snapshot_mail_count
2. POST notification eller mail
3. ASSERT broadcast event + DB entry
4. PATCH read → verificér read-state
5. CLEANUP: DELETE
```

---

## 4. Test-cases

### 4.1 SETUP (4)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_BDR_SETUP_01** | T_BDR_BASE-bon eksisterer | NY-status, 0 lines |
| **T_BDR_SETUP_02** | mailService mock-transport sat | OK |
| **T_BDR_SETUP_03** | Test-recipe valgt (eller skip-marker) | grocy_recipe_id tilgængelig |
| **T_BDR_SETUP_04** | Test-attachment-rows oprettet | 2 mail_attachments med kendte id'er |

### 4.2 POST lines (10)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_LINES_01** | Minimal POST: `{product_name}` | 201, line.qty=1, unit_price=null, line_total=null, sort_order=1 |
| **T_BDR_LINES_02** | Med qty + unit_price | line_total = qty × unit_price (server-beregnet) |
| **T_BDR_LINES_03** | Klient sender `line_total: 9999` | IGNORERES — server beregner ud fra qty × unit_price |
| **T_BDR_LINES_04** | Uden product_name | 400 "product_name er påkrævet" |
| **T_BDR_LINES_05** | Ikke-eksisterende bon | 404 "Bon ikke fundet" |
| **T_BDR_LINES_06** | sort_order auto-tildeles | Første line: sort_order=1. Tilføj line nr 2: sort_order=2. Tredje: 3 |
| **T_BDR_LINES_07** | is_accessory=true | line indsat, total_units IKKE øget (`is_accessory = 0 OR IS NULL`-filter) |
| **T_BDR_LINES_08** | Recalc bon.total_units efter POST | SUM(quantity WHERE is_accessory=0) opdateret |
| **T_BDR_LINES_09** | Recalc bon.total_price efter POST | recalcBonTotal() trigger. Verificér nyt beløb |
| **T_BDR_LINES_10** | changelog entry + SSE | logChange('update', 'bon_lines', "tilføjet: X"). broadcast('bon_updated', {bon_id}) |

### 4.3 PUT lines (7)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_PUT_01** | PUT en eksisterende linje med ny qty | qty opdateret, line_total recalculated, bon.total_price opdateret |
| **T_BDR_PUT_02** | Klient sender `line_total` direkte | IKKE i allowed-listen — ignoreres. Server recalculer ud fra qty × unit_price |
| **T_BDR_PUT_03** | Tom body | 400 "Ingen gyldige felter" |
| **T_BDR_PUT_04** | line.id der ikke matcher bon.id | UPDATE rammer 0 rows. response.changes=0? Verificér |
| **T_BDR_PUT_05** | Sæt unit_price til null | line_total bliver null |
| **T_BDR_PUT_06** | is_accessory ændret fra false til true | bon.total_units genberegnet (nu uden denne line) |
| **T_BDR_PUT_07** | **MANGLER SSE broadcast** | PUT-handler har **IKKE** `broadcast('bon_updated', ...)`-kald (jf. linje 475-504). **Finding: F-kandidat**. Test: efter PUT, ingen bon_updated event modtaget. Frontend opdaterer ikke realtime — F-kandidat for fix |

### 4.4 DELETE lines (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_DEL_01** | DELETE eksisterende linje | 200 `{deleted: lid}`, line væk |
| **T_BDR_DEL_02** | Ikke-eksisterende linje | 404 "Linje ikke fundet" |
| **T_BDR_DEL_03** | Recalc total_units efter slet | total_units uden den slettede linje |
| **T_BDR_DEL_04** | Recalc total_price efter slet | Server-autoritativ |
| **T_BDR_DEL_05** | **MANGLER SSE broadcast** | Samme som PUT — DELETE-handler har IKKE broadcast. F-kandidat |

### 4.5 GET ingredients (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_INGR_01** | Bon uden recipe-lines | Empty `production`/`raw`/`sub_recipes`-objekter, lines_without_recipe array |
| **T_BDR_INGR_02** | Bon med recipe-line | Aggregerede ingredienser fra resolveIngredients |
| **T_BDR_INGR_03** | Bagudkompatibilitet | response.ingredients = response.raw.ingredients (alias) |
| **T_BDR_INGR_04** | Bon med både recipe-line og fritekst-line | Fritekst-line er i lines_without_recipe |
| **T_BDR_INGR_05** | is_accessory ekskluderes fra lines_without_recipe | `!l.is_accessory`-filter |

### 4.6 GET changelog (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_CL_01** | GET for bon med 3 changelog-rows | Returnerer 3 rows |
| **T_BDR_CL_02** | Sortering DESC efter created_at | Nyeste først |
| **T_BDR_CL_03** | JOIN på users.name | user_name-felt med navn (eller null hvis user_id=null) |
| **T_BDR_CL_04** | Filter entity_type='bon' | KUN bon-entries (ikke supplier/recipe/etc.) |

### 4.7 POST + GET notifications (6)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_NOT_01** | POST minimal: `{message: 'Tjek glutenfri'}` | 201, type='flyver' default, priority='normal' default |
| **T_BDR_NOT_02** | POST uden message | 400 "message er påkrævet" |
| **T_BDR_NOT_03** | POST med client_id → auto-kvittér | INSERT i notification_reads. Sender ser ikke sin egen flyver ved reload |
| **T_BDR_NOT_04** | POST → SSE 'notification' broadcast | `{bon_id, notification, sender_client_id}` |
| **T_BDR_NOT_05** | POST → changelog entry | action='create', fieldName='notification', notes=message |
| **T_BDR_NOT_06** | GET sorted DESC | Nyeste først |

### 4.8 Notification read (3)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_READ_01** | POST read med client_id | 200, INSERT i notification_reads. INSERT OR IGNORE: dobbelt-kvittér giver 200 men ingen extra row |
| **T_BDR_READ_02** | Uden client_id | 400 "client_id er påkrævet" |
| **T_BDR_READ_03** | Ikke-eksisterende notif_id | 404 |

### 4.9 GET mail (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_MAIL_GET_01** | Bon uden mail | response `{threads: []}` |
| **T_BDR_MAIL_GET_02** | Bon med 1 tråd og 2 messages | Tråd med messages-array (2 entries) |
| **T_BDR_MAIL_GET_03** | Sortering tråde: updated_at DESC | Sidst opdaterede tråd først |
| **T_BDR_MAIL_GET_04** | Sortering messages: created_at ASC (i hver tråd) | Ældste message først |
| **T_BDR_MAIL_GET_05** | Attachments-array parses fra json_group_array | Hver message har `attachments: [{id, filename, mime_type, size_bytes}, ...]` |

### 4.10 POST mail — udgående (8)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_MAIL_POST_01** | POST minimal: `{to, text}` | 200 `{ok, messageId, threadId}`. mailService.sendMail kaldt |
| **T_BDR_MAIL_POST_02** | POST med templateKey | sendFromTemplate kaldt (ikke sendMail) |
| **T_BDR_MAIL_POST_03** | Uden to | 400 "to og text/templateKey er påkrævet" |
| **T_BDR_MAIL_POST_04** | Uden text OG templateKey | 400 |
| **T_BDR_MAIL_POST_05** | Med attachments-array | Hver attachment valideres (parseInt + >0) |
| **T_BDR_MAIL_POST_06** | attachments med >5 items | 400 "Max 5 vedhæftninger per mail" |
| **T_BDR_MAIL_POST_07** | attachments ikke array (`{}`) | 400 |
| **T_BDR_MAIL_POST_08** | Ikke-eksisterende bon | 404 "Bon ikke fundet" |

### 4.11 PATCH mail read (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_MAIL_READ_01** | PATCH msg → is_read=1 | DB-felt sat |
| **T_BDR_MAIL_READ_02** | Response inkluderer unread_mail_count | Numerisk |
| **T_BDR_MAIL_READ_03** | SSE bon_updated med unread_mail_count | `{id: bonId, unread_mail_count}` |
| **T_BDR_MAIL_READ_04** | Allerede læst → idempotent | Anden PATCH returnerer samme respons |

### 4.12 EDGE_CASES (4)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_EDGE_01** | POST line med qty=0 | line indsat, line_total=0 (qty × unit_price = 0) |
| **T_BDR_EDGE_02** | POST line med negativ qty | Accepteres (ingen validation). F-kandidat: skal vi afvise? |
| **T_BDR_EDGE_03** | DELETE alle lines på en bon | total_units = 0, total_price = 0 |
| **T_BDR_EDGE_04** | Notification med tom message-string | `if (!message)` = true → 400 |

### 4.13 CLEANUP (5)

| ID | Action | Forventet |
|----|--------|-----------|
| **T_BDR_CLEANUP_01** | Alle test-bon's lines slettet | Count = 0 |
| **T_BDR_CLEANUP_02** | Test-bon's notifications + reads slettet | Count = 0 |
| **T_BDR_CLEANUP_03** | Test-bon's mail-tråde + messages slettet | Count = 0 |
| **T_BDR_CLEANUP_04** | Test-attachments slettet | Count = 0 |
| **T_BDR_CLEANUP_05** | Changelog-rows for test-bons slettet | Count = 0 |

---

## 5. Konkret eksempel — T_BDR_LINES_03 (klient kan ikke diktere total)

```
Setup:
- T_BDR_BASE-bon, 0 lines, total_price=0

1. POST /api/bons/:id/lines med
   { product_name: "Frikadeller",
     quantity: 2,
     unit_price: 100,
     line_total: 99999  ← klient prøver at sætte forkert total }

2. ASSERT response:
   - line.line_total = 200 (server beregnet)
   - line.line_total ≠ 99999

3. ASSERT DB:
   - SELECT line_total FROM bon_lines WHERE id = last_line_id
   - Værdi: 200, IKKE 99999

4. ASSERT bon.total_price ≈ 200 (recalculated)

5. CLEANUP: DELETE line

PASS — klient kan ikke manipulere beløb
```

---

## 6. Fejlsignaler

| Symptom | Sandsynlig årsag |
|---------|------------------|
| PUT line uden SSE broadcast | KORREKT — det er F-finding (manglende broadcast). Test asserterer at det IKKE er der |
| DELETE line uden SSE broadcast | Samme F-finding |
| Klient-sat line_total persisterer | Bug — `allowed`-liste filtrerer ikke. Verificér linje 482 |
| total_price ikke recalculated efter POST line | recalcBonTotal-kald glemt. Tjek linje 467 |
| attachments validering springer over | Ikke-Array attachments accepteres. Tjek linje 668 |
| Notification.client_id ikke auto-kvitteret | INSERT OR IGNORE-blok glemt. Tjek linje 599-602 |
| Tom mail-tråd returnerer null i stedet for tom array | json_group_array-handling i SQLite |

---

## 7. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_BON_DRAWER_LINES_AND_RELATIONS.md` | Denne fil | 🔲 |
| `tests/scripts/run_T_BON_DRAWER_LINES_AND_RELATIONS.js` | Test-runner | 🔲 |

npm-script:
```json
"test:run-bon-drawer-rel": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_BON_DRAWER_LINES_AND_RELATIONS.js"
```

---

## 8. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| Line-CRUD + recalc er server-autoritativt | Klient kan ikke manipulere beløb via lines |
| sort_order auto-tildeles | UI's drag-and-drop kan trygt sætte rækkefølge |
| is_accessory ekskluderes fra total_units | Tilbehør tæller ikke som hovedretter |
| Ingredients-resolver virker for både recipe og fritekst-lines | Køkken kan se aggregeret bestilling |
| Changelog viser hele audit-trail | Compliance OK |
| Notifications + auto-kvittér virker | Flyver-flow stabil |
| Mail-tråde med attachments virker | Kundekorrespondance dokumenteret |
| Mail-read trigger SSE med count | Realtime mail-badge i listview |

---

## 9. Findings — afventer første kørsel

| # | Reference | Spørgsmål | Hvordan tjekkes |
|---|-----------|-----------|-----------------|
| **F57** | §4.3 (PUT_07) | PUT lines mangler SSE broadcast | Verificér eksplicit. Kandidat til fix |
| **F58** | §4.4 (DEL_05) | DELETE lines mangler SSE broadcast | Samme — kandidat til fix |
| **F59** | §4.12 (EDGE_02) | Negative qty accepteres på lines | Bør valideres? |
| **F60** | §4.10 (MAIL_POST_05) | attachments parseInt → 0 hvis tom string | Validation accepterer mystiske inputs? |
| **F61** | §4.4 (DEL_04) | line.id+bon.id mismatch UPDATE/DELETE rammer 0 rows men returnerer 200 | Bør være 404 |

---

*Oprettet: maj 2026 — del 2 af T_BON_DRAWER-split. F57/F58 (manglende broadcasts) er klare kandidater til consolidation-patch sammen med F49.*
