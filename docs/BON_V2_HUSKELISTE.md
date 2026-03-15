# BON_V2_HUSKELISTE.md — Visuelle krav og detaljer fra Bon v1
> Ting der ikke er specifikke nok til en fase-spec endnu,
> men som SKAL med inden Bon v1 kan lukkes ned.
> Opdateres løbende — tjekkes ved start af hver fase.

---

## Kalender / overblik

| Krav | Detalje | Data-kilde | Fase |
|------|---------|-----------|------|
| Produktions-bon — blå farve | Blå baggrundsfarve i kalender-blok | `price_category = 'produktion'` | 2/3 |
| Produktions-bon — ikon | 🔧 (svensk nøgle) vises på bon-blok | `price_category = 'produktion'` | 2/3 |
| Mail-ikon | ✉ konvolut vises når bon har tilknyttet mail | `bon_mails` tabel — COUNT > 0 | 2/3 |

---

## Bon-kort (kitchen)

| Krav | Detalje | Data-kilde | Fase |
|------|---------|-----------|------|
| *(tilføj her efterhånden)* | | | |

---

## Drawer / office bon-detalje

| Krav | Detalje | Data-kilde | Fase |
|------|---------|-----------|------|
| Kopier bon | Knap i drawer — kopierer alle felter til ny bon med status NY og nyt bon-nummer | `POST /api/bons/:id/copy` | 1e/3 |
| Mail-ikon i drawer | Vis ✉ + antal mails når bon_mails > 0 | `bon_mails` COUNT | 2/3 |

---

## Formbuilder (bestilling_v2.html)

| Krav | Detalje | Fase |
|------|---------|------|
| Faktura/EAN-felt | Textarea til EAN og faktura-info (f12) — mangler i nuværende version | 1e |
| Auto-kopi navn + tlf til kontaktperson | Kopierer fra bestiller-felterne, kan overskrives — logik bygget, mangler i formbuilder-admin | 1e |
| EAN-udtræk i webhook | Regex `5\d{12}` trækker EAN ud fra faktura-felt og gemmer på firma | ✅ Done i 1d |

---

## Levering / logistik

| Krav | Detalje | Fase |
|------|---------|------|
| Bud-tidspunkt auto-beregning | Byekspressen: leveringstid − 45 min. Taxa/Volvo: leveringstid − (OSRM køretid + 15 min). Systemet foreslår `courier_arrival_time`, kontoret kan justere | 5 |
| Listview: "Afleveret til bud"-kolonne | Timestamp fra `delivery_events` — vises i dagens overblik | 3 |

---

## Settings / ikoner

| Krav | Detalje | Fase |
|------|---------|------|
| Leveringsmetode-ikoner i settings | Ikoner for `delivery_method` (bike=🚲, taxi=🚕, volvo=🚛, pickup=🏠) er pt. hardcoded i `BL_DELIVERY_ICONS` i bons-list.js. Bør flyttes til en settings-tabel så kontoret kan definere ikoner + labels for nye metoder uden kodeændring. Bruges også i kalender og bon-kort. | 4+ |

---

## Generelt / andet

| Krav | Detalje | Fase |
|------|---------|------|
| Mobilvenlige views | Listview + drawer skal fungere på telefon — både office og kitchen-roller | 3 |
| Kopier bon | Knap i drawer — se Drawer-sektionen ovenfor | 1e/3 |

---

*Sidst opdateret: marts 2026 — kopier bon + mobilvisning tilføjet*
