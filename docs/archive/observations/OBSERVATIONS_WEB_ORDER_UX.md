# OBSERVATIONS_WEB_ORDER_UX.md

> Fire UX-findings fra integration-test af web-bestillings-flow (14. maj 2026).
> Bestilling kom korrekt ind i `bons`-tabellen via `routes/web-orders.js`,
> men der er gabs i hvordan brugerne bliver gjort opmærksomme på den.
>
> **Status: noteret til senere implementering — denne session er udelukkende
> dokumentation.**

---

## Sammenfatning

Test-bestilling B3514 (Liffe Zeeberg, delivery_date=2026-05-15) kom korrekt
ind via webhook → `bons`-tabellen → web_orders audit-log → SSE bon_created
broadcast. Men:

| # | Finding | Sværhedsgrad |
|---|---------|--------------|
| **#040** | mobile/bons.js viser "Ukendt" + "?" — felt-navn-mismatch | Lav (UI cosmetic) |
| **#041** | Ingen notifikation når web-bestilling kommer ind | **Medium** (forretningsrisiko) |
| **#042** | Fremtidige bestillinger "gemmes væk" i later/calendar uden synlighed | **Medium** (samme rod-årsag som #041) |
| **#043** | Mail-notifikation til ejer mangler helt | **Medium** (samme rod-årsag) |

Alle 4 hænger sammen: web-ordrer kommer ind, men der er ingen aktiv signal
til at nogen skal handle på dem inden for SLA (2 dage max, helst samme dag).

---

## TEST_OBSERVATIONS-entries (klar til paste)

### #040 — Mobile bons-list viser "Ukendt" + "?" for nye bestillinger

```markdown
### #040 — Mobile/bons.js viser "Ukendt" og "?" for nye bestillinger (åben)

| | |
|--|--|
| **Kilde** | Manuel integration-test 14. maj 2026 — bestilling B3514 (Liffe Zeeberg) viste "Ukendt" i mobil-bons-list i stedet for kundenavn, og "?" i stedet for status-label |
| **Beskrivelse** | `mobile/views/bons.js` linje 159 læser `bon.customer_name`/`bon.company_name`. Men backend `GET /api/bons` returnerer kunde-navnet i feltet `contact_name_full` (jf. T_BONS_LIST T_BL_RESP_03). For status: BON_CONFIG.statuses kan have små bogstaver-keys mens server returnerer 'NY' i store bogstaver — fallback i `_mbStatusStyle` returnerer '?'. |
| **Vurdering** | Lille felt-navn-mismatch mellem frontend (mobile/bons.js) og backend (routes/bons.js). Office bons-list bruger samme endpoint men har sit eget felt-navn (`contact_name_full`). Mobil ramt fordi den blev kodet før T_BONS_LIST etablerede kontrakten. |
| **Foreslået action** | 2-linje fix i `mobile/views/bons.js`: skift `bon.customer_name \|\| bon.company_name` til `bon.contact_name_full \|\| bon.company_name \|\| 'Ukendt'`. Plus tjek `BON_CONFIG.statuses`-keys (case-insensitive lookup eller standardisér til store bogstaver). |
| **Status** | `åben — lav prio` |
```

### #041 — Web-bestillinger har ingen notifikation/alert

```markdown
### #041 — Web-bestillinger har ingen aktiv notifikation (åben)

| | |
|--|--|
| **Kilde** | Manuel integration-test 14. maj 2026 — bestilling B3514 kom korrekt ind via webhook, men der var ingen synlig "ny bestilling kom ind"-signal i Bon v2 |
| **Beskrivelse** | `routes/web-orders.js` udsender `bon_created`-event via SSE (linje 227), men ingen frontend lytter aktivt og viser banner/alert/toast. Dashboard har `alerts`-array i `/today`-endpoint men ingen 'new_web_order'-type. Listview re-fetcher men giver ingen visuel markering af nye bestillinger. |
| **Vurdering** | **Forretnings-risiko**: kunder skal have svar inden for 2 dage max (helst samme dag, jf. Leif). Hvis ingen ser den, falder bestillingen ud af synsfeltet og kunden venter på svar. Mest kritisk for fremtidige bestillinger der ikke er på "today"-view. |
| **Foreslået action** | Tilføj alert-type til `routes/dashboard.js /today`-endpoint: count bons med `source='web_order'` + status='NY' uden user-acknowledgment. Vis i dashboard topbar som "X ubehandlede bestillinger". Klik → går til en filtreret listview. Plus mail-notifikation (se #043) |
| **Status** | `åben — medium prio` |
```

### #042 — Fremtidige bestillinger "gemmes" i later/calendar uden synlighed

```markdown
### #042 — Fremtidige bestillinger forsvinder fra synsfeltet (åben)

| | |
|--|--|
| **Kilde** | Manuel integration-test 14. maj 2026 — bestilling B3514 (delivery_date=2026-05-15) blev korrekt klassificeret som "i morgen" men var derfor IKKE i `kitchen/today.html`. For bestillinger 2+ måneder frem ville de end ikke være i `later.html` |
| **Beskrivelse** | Bon v2's date-baserede views (today, later, calendar) skjuler fremtidige bons indtil de bliver "tidsmæssigt relevante". Det betyder at en bestilling til august 2026, modtaget i maj 2026, er teknisk i systemet men praktisk usynlig for bruger. Office's bons-list med "Alle" filter VISER dem, men ikke som "nye/ubekræftede" — bare som rows blandt mange. |
| **Vurdering** | **Forretnings-risiko**, samme rod-årsag som #041. Bestillinger der ligger langt frem kan miste tracking og kunden får ikke rettidig bekræftelse. |
| **Foreslået action** | Ny dedikeret "Nye bestillinger"-sektion (sidebar-punkt eller dashboard-card) der viser ALLE bons med `source='web_order' AND status='NY' AND no manual user_action`, uanset delivery_date. Sortér efter created_at DESC (nyeste først). Tilføj "Bekræft modtaget"-knap der markerer bonnen som set af en bruger (uden at ændre status). |
| **Status** | `åben — medium prio` |
```

### #043 — Mail-notifikation til ejer mangler

```markdown
### #043 — Ingen mail-notifikation til ejer ved ny web-bestilling (åben)

| | |
|--|--|
| **Kilde** | Manuel integration-test 14. maj 2026 — kunde fik bekræftelsesmail men ejer/Leif fik ingen besked om at handle |
| **Beskrivelse** | `routes/web-orders.js` sender bekræftelsesmail til kunden (linje 271-309) men har ingen pendant til ejer/intern modtager. Leif må aktivt åbne Bon v2 for at se nye bestillinger — der er ingen push til indbakke. |
| **Vurdering** | Komplementær til #041/#042 — selv hvis UI-alert virker, vil mail være tilgængelig udenfor arbejdstider og fra mobil. Især vigtigt fordi web-bestillinger kan komme om natten/weekend. |
| **Foreslået action** | Ny setting `web_order_notification_email` (default: `leifzeeberg@hotmail.dk`, redigerbar i Settings UI). Send fire-and-forget mail efter bon-INSERT i `web-orders.js`'s `handleWebOrder` (parallelt med kunde-bekræftelsesmailen). Indhold: bon-nummer, kundenavn, delivery-dato, link til drawer. Mail-template `web_order_owner_notification` administrérbar via mail-skabelon-management (Fase 12). |
| **Status** | `åben — medium prio` |
```

---

## Spec til fremtidig implementering

Når vi laver fixet, hænger #041 + #042 + #043 sammen som **ét feature**. Plan:

### Fase 1 — Mail-notifikation (#043)
*~30 min — laveste hængende frugt*

1. Settings-tabel: tilføj `web_order_notification_email` (default Leifs adresse, redigerbar i Settings UI)
2. Mail-template `web_order_owner_notification` med variabler:
   - `{{bonNummer}}`, `{{kundeNavn}}`, `{{leveringsDato}}`, `{{leveringsTid}}`, `{{drawerLink}}`, `{{oenskerBlok}}`
3. I `routes/web-orders.js` `handleWebOrder` efter linje 309: fire-and-forget mail til `web_order_notification_email`
4. Tjek `is_active`-flag på modtagermail før send (graceful disable)

### Fase 2 — Dashboard alert (#041)
*~1 time*

5. I `routes/dashboard.js /today`-endpoint: tilføj ny alert-type `new_web_orders`:
   ```sql
   SELECT COUNT(*) FROM bons b
   LEFT JOIN web_orders wo ON wo.bon_id = b.id
   WHERE wo.id IS NOT NULL
     AND b.status_id = (SELECT id FROM status_definitions WHERE code = 'NY')
     -- evt. AND b.acknowledged_at IS NULL (kræver ny kolonne)
   ```
6. Frontend: dashboard topbar viser badge "X nye bestillinger" hvis count > 0
7. Klik → navigerer til filtreret listview eller dedikeret "Nye bestillinger"-side

### Fase 3 — Dedikeret "Nye bestillinger"-side (#042)
*~1-2 timer*

8. Ny route `GET /api/web-orders/pending` der returnerer alle bons med web_order-source der ikke er acknowledged
9. Ny sidebar-section "Nye bestillinger" i office (under Tilbud, før Drift)
10. Tilføj DB-kolonne `bons.acknowledged_at` + `acknowledged_by_user_id` (nullable)
11. PATCH-endpoint `/api/bons/:id/acknowledge` der sætter felterne
12. UI: liste-row med "Bekræft modtaget"-knap → fjerner row fra liste, opdaterer dashboard-tæller

### Fase 4 — Mobile fix (#040)
*~10 min*

13. `mobile/views/bons.js` linje 159: ændr `bon.customer_name` til `bon.contact_name_full`
14. `mobile/views/bons.js` linje 160-170 + `_mbStatusStyle`: brug `(code || '').toUpperCase()` så BON_CONFIG-lookup virker uanset case

---

## Sammenhæng med eksisterende test-suite

Test-suiten har ikke fanget #040-#043 fordi de er **integration-niveau**:

- T_BONS_LIST tester at endpoint returnerer `contact_name_full` ✅
- T_BONS_LIST tester ikke at frontend (mobil eller office) bruger korrekt feltnavn ❌
- T_DASHBOARD tester at alerts virker ✅
- T_DASHBOARD tester ikke at `source='web_order'` triggerer alert ❌ (typen findes ikke endnu)
- T_KITCHEN_TODAY tester at LEVERET ekskluderes ✅
- Hverken kitchen eller office tester at fremtidige bestillinger er synlige ❌

**Nyt track der kan skrives senere: T_WEB_ORDER_INTEGRATION** — end-to-end fra webhook til UI-synlighed. Inkluderer:
- POST webhook → verificér bon + web_orders + changelog rows
- Verificér SSE bon_created broadcast modtages
- Verificér mail sendt til ejer (mock transport)
- Verificér dashboard-alert tæller op
- Verificér acknowledge-flow fjerner fra alert

---

## Slutstatus (efter denne batch)

```
Pre-eksisterende:    40 obs (31 lukket / 3 bevidst / 6 lav-prio)

Nye fra denne session:
  #040  mobile felt-navn        åben — lav prio
  #041  dashboard alert mangler åben — medium prio
  #042  fremtidige skjulte      åben — medium prio
  #043  ejer-mail mangler       åben — medium prio

Slutstatus: 44 obs total
  Lukket: 31
  Bevidst: 3
  Åben lav-prio: 6
  Åben medium-prio: 4 (#040-#043 ALLE relateret til web-order-flow)
```

**Vigtigt:** Disse 4 medium-findings er **systemisk**, ikke spredt. De
hænger alle sammen omkring web-order-flowet og kan fixes som ét feature.
Det er bedre end 4 separate problemer i forskellige moduler.

---

## Prioritering vs T_CRM / T_CASHFLOW / T_V1_AFSTEMNING

Web-order UX-fix (#041-#043) er **vigtigere end T_CRM/T_CASHFLOW** fordi:

- Det er en **aktiv brugersituation** der allerede sker
- Kunder venter på svar uden at nogen ved det
- T_CRM/T_CASHFLOW er læseflader uden samme tids-kritiske aspekt

Men det er **mindre vigtigt end T_V1_AFSTEMNING** fordi:
- V1-afstemning er cutover-blokker
- Web-order-fixet kan vente til efter cutover

**Foreslået rækkefølge efter denne session:**

1. Weekenden: T_V1_AFSTEMNING (cutover-prep)
2. Lige efter cutover: Fase 1+4 (mail + mobile fix) — quick wins
3. Næste uge: Fase 2+3 (dashboard alert + dedikeret side)
4. Når tid: T_CRM, T_CASHFLOW, T_WEB_ORDER_INTEGRATION

---

*Oprettet: 14. maj 2026 — efter manuel test af web-bestillings-flow afdækkede
4 integration-niveau UX-findings (#040-#043). Alle noteret som åbne — fixed
senere i kommende session efter V1-afstemning er kørt.*
