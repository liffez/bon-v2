# BON_V2_HUSKELISTE.md — Visuelle krav og detaljer fra Bon v1
> Ting der ikke er specifikke nok til en fase-spec endnu,
> men som SKAL med inden Bon v1 kan lukkes ned.
> Opdateres løbende — tjekkes ved start af hver fase.

---

## Kalender / overblik

| Krav | Detalje | Data-kilde | Status |
|------|---------|-----------|--------|
| Produktions-bon — blå farve | Blå baggrundsfarve i kalender-blok | `price_category = 'produktion'` | ⚠ Bon-kort har styling (`shared/bon_kort.css:658`), kalender mangler |
| Produktions-bon — ikon | 🔧 (svensk nøgle) vises på bon-blok | `price_category = 'produktion'` | ✅ Done — kalender + bon-kort |
| Mail-ikon | ✉ konvolut vises når bon har tilknyttet mail | `bon_mails` COUNT > 0 | ✅ Done — kalender + bon-kort + listview |

---

## Bon-kort (kitchen)

| Krav | Detalje | Data-kilde | Status |
|------|---------|-----------|--------|
| *(tilføj her efterhånden)* | | | |

---

## Drawer / office bon-detalje

| Krav | Detalje | Data-kilde | Status |
|------|---------|-----------|--------|
| Kopier bon | Knap i drawer — kopierer alle felter til ny bon med status NY og nyt bon-nummer | `POST /api/bons/:id/copy` | ❌ Mangler — endpoint + UI ikke implementeret |
| Mail-ikon i drawer | Vis ✉ + antal mails når bon_mails > 0 | `bon_mails` COUNT | ✅ Done — mail-historik i drawer |

---

## Formbuilder (bestilling_v2.html)

| Krav | Detalje | Status |
|------|---------|--------|
| Faktura/EAN-felt | Textarea til EAN og faktura-info (f12) — mangler i nuværende version | ⚠ Tilføjet i `tools/bestilling_v2.html`, men ny embed-form (`public/embed/bestilling.html`) erstatter den — verificér at EAN-felt er med i embed-versionen |
| Auto-kopi navn + tlf til kontaktperson | Kopierer fra bestiller-felterne, kan overskrives — webhook gemmer i `day_contact_name`/`day_contact_phone` | ⚠ Webhook-mapping findes (`routes/webhooks.js:17-18`), men formbuilder-admin UI mangler |
| EAN-udtræk i webhook | Regex `5\d{12}` trækker EAN ud fra faktura-felt og gemmer på firma | ✅ Done (Fase 1d) |

---

## Levering / logistik

| Krav | Detalje | Status |
|------|---------|--------|
| Bud-tidspunkt auto-beregning | Byekspressen: leveringstid − 45 min. Taxa/Volvo: leveringstid − (OSRM køretid + 15 min). Systemet foreslår `courier_arrival_time`, kontoret kan justere | ❌ Mangler — `courier_arrival_time`-felt findes, men auto-beregning ikke implementeret. Byekspressen credentials ikke modtaget endnu |
| Listview: "Afleveret til bud"-kolonne | Timestamp fra `delivery_events` — vises i dagens overblik | ⚠ `delivery_events` joines i `routes/bons.js:160`, men kolonne ikke vist i listview |

---

## Settings / ikoner

| Krav | Detalje | Status |
|------|---------|--------|
| Leveringsmetode-ikoner i settings | Ikoner for `delivery_method` (bike=🚲, taxi=🚕, volvo=🚛, pickup=🏠) er pt. hardcoded i `BL_DELIVERY_ICONS` i `office/views/bons-list.js:63`. Bør flyttes til en settings-tabel så kontoret kan definere ikoner + labels for nye metoder uden kodeændring. Bruges også i kalender og bon-kort. | ❌ Mangler — stadig hardcoded |

---

## CRM

| Krav | Detalje | Data-kilde | Status |
|------|---------|-----------|--------|
| Verificér skema-udvidelser på `crm_activities` | `mobile/views/crm.js` POSTer `result`, `sentiment`, `purpose_id` til `/api/crm/activity` — verificér mod prod og opdatér `bon_v2_datamodel_v2.md` så det matcher virkeligheden | `crm_activities` | ⚠ Migration 019 har `result`, `sentiment`, `service_call` — men `purpose_id`/`activity_purposes` skal verificeres |
| `type` CHECK-constraint tillader `service_call` | Mobil CRM bruger typen `service_call` | `crm_activities.type` | ✅ Done — bekræftet i migration 019 (`db/migrations/019_crm_columns.sql:29`) |
| Aktivitetshistorik på mobil kundedetalje | Sektion mellem stats og typiske produkter — viser tidligere noter, opkald, mails, tilbud. Spec: `docs/CLAUDE_CRM_MOBIL_HISTORIK.md` | `crm_activities` JOIN `bons` + `users` + `activity_purposes` | ✅ Done — commit 7f921e9 (CRM mobil: Aktivitetshistorik på kundedetalje) |

---

## Generelt / andet

| Krav | Detalje | Status |
|------|---------|--------|
| Mobilvenlige views | Listview + drawer skal fungere på telefon — både office og kitchen-roller | ✅ Done — Fase 10 Mobil Shell (`mobile/`) komplet med PIN-login, 5-tab nav, bons/modtag/crm/oversigt-views |

---

## Stadig åbne huller (sammenfatning)

Sortér efter prioritet før Bon v1-nedlukning:

1. **Kopier bon** — drawer-knap + `POST /api/bons/:id/copy`-endpoint
2. **Bud-tidspunkt auto-beregning** — kræver Byekspressen-credentials (afventer)
3. **Listview "Afleveret til bud"-kolonne** — data findes, mangler bare UI
4. **Leveringsmetode-ikoner i settings** — flyt fra hardcoded til settings-tabel
5. **Produktions-bon blå farve i kalender** — bon-kort har det, kalender mangler
6. **EAN-felt i embed-bestillingsformularen** — verificér mod `public/embed/bestilling.html`
7. **Formbuilder-admin auto-kopi UI** — webhook understøtter det, men mangler i admin
8. **CRM `purpose_id` skemaverifikation** — bekræft mod prod

---

*Sidst opdateret: maj 2026 — merged med duplikat-fil, status verificeret mod kodebasen*
