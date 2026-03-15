# CLAUDE_FASE3A.md — Office Listview
> Læs CLAUDE.md og docs/bon_v2_datamodel_v2.md FØR du starter.
> Fase 1a-1d + bon_drawer skal være på plads først.
> Opdateret: marts 2026

---

## Hvad denne opgave dækker

Office listview — primær indgang til alle bonner fra office-zonen.

Tre use cases i ét view:
1. **"Min mad er ikke kommet"** — dagens bonner live med status + bud-tidspunkt
2. **"Jeg vil bestille igen"** — søg på bonnummer / navn / firma
3. **"Hvad har vi onsdag?"** — dato-filter + belastningsoverblik

Fil: `office/views/bons-list.js` (loadet dynamisk i office/index.html)

---

## Backend: udvid `GET /api/bons`

Eksisterende endpoint udvides med flere join-felter og sorteringsmuligheder.

### Query params

| Param | Type | Beskrivelse |
|-------|------|-------------|
| `q` | string | Søg på bonnummer, kundenavn, firmanavn (min 1 tegn) |
| `date` | YYYY-MM-DD | Filter på leveringsdato. `today` = i dag |
| `date_from` | YYYY-MM-DD | Fra-dato (range) |
| `date_to` | YYYY-MM-DD | Til-dato (range) |
| `status` | kommasepareret | F.eks. `NY,VENTER` |
| `unread_mail` | 1 | Kun bonner med ulæst mail |
| `sort` | string | Kolonne at sortere på — se nedenfor |
| `dir` | asc/desc | Sorteringsretning |
| `limit` | int | Default 100 |
| `offset` | int | Pagination |

### Sorterbare kolonner

`delivery_date`, `delivery_time`, `bon_number`, `customer_name`,
`company_name`, `pax`, `status`, `courier_arrival_time`, `total_price`

### SQL (basis)

```sql
SELECT
  b.id,
  b.bon_number,
  b.delivery_date,
  b.delivery_time,
  b.pickup_time,
  b.courier_arrival_time,
  b.pax,
  b.total_units,
  b.total_price,
  b.payment_type,
  b.delivery_type,
  b.kitchen_selects,
  b.price_category_id,
  pc.code  AS price_category_code,
  pc.label AS price_category_label,
  s.code   AS status_code,
  s.label  AS status_label,
  s.color  AS status_color,
  c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
  c.phone  AS customer_phone,
  c.email  AS customer_email,
  co.name  AS company_name,
  co.ean   AS company_ean,
  -- Mail: har bonen ulæst mail?
  (SELECT COUNT(*) FROM bon_mails m
   WHERE m.bon_id = b.id AND m.direction = 'inbound' AND m.is_read = 0
  ) AS unread_mail_count,
  -- Levering: seneste delivery_event
  (SELECT de.event_type FROM delivery_events de
   WHERE de.bon_id = b.id ORDER BY de.event_time DESC LIMIT 1
  ) AS latest_delivery_event,
  (SELECT de.event_time FROM delivery_events de
   WHERE de.bon_id = b.id ORDER BY de.event_time DESC LIMIT 1
  ) AS latest_delivery_event_time
FROM bons b
JOIN status_definitions s ON b.status_id = s.id
LEFT JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
LEFT JOIN price_categories pc ON b.price_category_id = pc.id
WHERE 1=1
  -- filtre tilføjes dynamisk
ORDER BY b.delivery_date ASC, b.delivery_time ASC
LIMIT ? OFFSET ?
```

Søgning tilføjes som:
```sql
AND (
  b.bon_number LIKE ? OR
  c.first_name || ' ' || COALESCE(c.last_name,'') LIKE ? OR
  co.name LIKE ?
)
```

**Bonnummer-søgning matcher fra første ciffer** — `LIKE '3342%'` ikke `'%3342%'`
hvis input kun er cifre. Hvis input indeholder bogstaver: fuld LIKE på begge sider.

---

## Frontend: `office/views/bons-list.js`

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│  [🔍 Søg bon#, navn, firma...]        [Kolonner ▾] [+ Ny]  │
├─────────────────────────────────────────────────────────────┤
│  [ I DAG ]  [ NY ]  [ ULÆST MAIL ]  [Dato: ________] [Alle]│
├──────┬────────────────┬──────────┬───────┬─────┬────────────┤
│  Bon │ Kunde / Firma  │ Dato     │  Tid  │ Pax │ Status     │
├──────┼────────────────┼──────────┼───────┼─────┼────────────┤
│ 3342 │ Lars H.        │ i dag    │ 11:30 │  60 │ 🟡 IGANG   │
│      │ Novo Nordisk   │          │       │     │ Bud: 10:45 │
├──────┼────────────────┼──────────┼───────┼─────┼────────────┤
│ 3351 │ Heidi K.  ✉1  │ i dag    │ 11:00 │   9 │ 🟢 KLAR    │
│      │ 108 Yoga       │          │       │     │            │
├──────┼────────────────┼──────────┼───────┼─────┼────────────┤
│ 3358 │ Silja T.       │ man 23/3 │ 10:30 │  33 │ 🟠 GODKENDT│
│      │ Gate 21        │          │       │     │            │
└──────┴────────────────┴──────────┴───────┴─────┴────────────┘
```

### Filtre — én aktiv ad gangen (undtagen dato)

| Filter | Hvad det gør |
|--------|-------------|
| **I DAG** | `date=today` — default ved load |
| **NY** | `status=NY` — alle datoer |
| **ULÆST MAIL** | `unread_mail=1` — alle datoer |
| **Dato-picker** | `date=YYYY-MM-DD` — specifik dag |
| **Alle** | Ingen dato-filter — seneste 90 dage |

Aktivt filter markeres visuelt. Dato-picker er et `<input type="date">`.

### Kolonner

**Faste (kan ikke skjules):**
- Bon# (klikbar → åbner drawer)
- Status (farvet badge)
- Dato + Tid

**Valgfrie (toggle via kolonnevælger):**

| Kolonne | Default | localStorage-nøgle |
|---------|---------|-------------------|
| Kunde | ✅ | `col_customer` |
| Firma | ✅ | `col_company` |
| Pax | ✅ | `col_pax` |
| Bud-tidspunkt | ✅ | `col_courier` |
| ✉ Ulæst mail | ✅ | `col_mail` |
| Priskategori | ❌ | `col_price_cat` |
| Betalingstype | ❌ | `col_payment` |
| Leveringstype | ❌ | `col_delivery_type` |
| Total pris | ❌ | `col_total_price` |

### Kolonnevælger UI

Knap øverst til højre: `Kolonner ▾`

Klik åbner en dropdown med checkboxes:
```
☑ Kunde
☑ Firma
☑ Pax
☑ Bud-tidspunkt
☑ ✉ Mail
☐ Priskategori
☐ Betalingstype
☐ Leveringstype
☐ Total pris
```

Ændringer gemmes øjeblikkeligt i `localStorage` og tabellen re-renderes.
Nøgle: `office_listview_columns` → JSON-objekt med boolean per kolonne.

### Sortering

Klik på kolonneoverskrift → sorter på den kolonne.
Klik igen → vend retning.
Pil op/ned vises i overskriften.
Sortering gemmes i `localStorage`: `office_listview_sort` → `{ col, dir }`.

### Søgning

- Søgefelt øverst til venstre
- Debounce: 300ms
- Minimum 1 tegn
- Bonnummer: matches fra start hvis kun cifre
- Rydder aktivt dato-filter og viser alle resultater
- ESC rydder søgning og vender tilbage til aktivt filter

### Rækkelayout

To linjer per bon (kompakt):
```
Linje 1: [Bon#]  [Kunde + ✉-ikon]  [Dato]  [Tid]  [Pax]  [Status-badge]
Linje 2:         [Firma]            [      ]       [     ]  [Bud: HH:MM]
```

Bud-tidspunkt vises kun hvis `courier_arrival_time` er sat.
✉-ikon vises kun hvis `unread_mail_count > 0` — med tæller hvis > 1.
Produktions-bon: blå venstre border + 🔧 efter bon-nummer.

### SSE

Listview lytter på `bon_created` og `bon_updated`:
- `bon_created` → tilføj række øverst hvis indenfor aktivt filter
- `bon_updated` → opdater eksisterende række in-place

```js
window.addEventListener('sse:bon_created', e => {
  if (matchesCurrentFilter(e.detail)) prependRow(e.detail);
});
window.addEventListener('sse:bon_updated', e => {
  updateRow(e.detail.id);
});
```

### Klik på række → åbner drawer

```js
row.addEventListener('click', () => openDrawer(bon.id));
```

Drawer-logikken er allerede bygget i `shared/bon_drawer.js`.

### "Ny bon"-knap

Øverst til højre — åbner `BonOpretModal` (allerede bygget i Fase 1c).

### Responsiv (mobil)

På skærme under 768px:
- Kolonnevælger skjuler automatisk: Firma, Bud-tidspunkt, Total pris
- To-linje rækkelayout kollapser til ét kompakt kort per bon
- Søgefelt fylder fuld bredde
- Filter-knapper scroller horisontalt

Mobilbrugere kan stadig justere kolonner via kolonnevælger.

---

## Belastningsoverblik (dato-filter)

Når et dato-filter er aktivt (specifik dag eller I DAG) vises en
kompakt summary-linje øverst i tabellen:

```
┌─────────────────────────────────────────────────────────┐
│  Fredag 20. marts · 4 bonner · 118 pax · 340 enheder   │
└─────────────────────────────────────────────────────────┘
```

Data beregnes fra de hentede bonner — ingen ekstra API-kald.

---

## Verifikation

```bash
# 1. Basis listview
curl -b cookies.txt "http://localhost:4321/api/bons?date=today&sort=delivery_time&dir=asc"
# Forventet: array med status_code, status_color, customer_name, company_name etc.

# 2. Søgning på bonnummer
curl -b cookies.txt "http://localhost:4321/api/bons?q=3342"
# Forventet: exact match eller nær-match

# 3. Søgning på navn
curl -b cookies.txt "http://localhost:4321/api/bons?q=Lars"
# Forventet: bonner med Lars i kundenavn

# 4. NY-filter
curl -b cookies.txt "http://localhost:4321/api/bons?status=NY"
# Forventet: kun NY-bonner, alle datoer

# 5. Ulæst mail
curl -b cookies.txt "http://localhost:4321/api/bons?unread_mail=1"
# Forventet: kun bonner med unread_mail_count > 0

# 6. Dato-range
curl -b cookies.txt "http://localhost:4321/api/bons?date_from=2026-03-20&date_to=2026-03-27"
# Forventet: bonner i den uge
```

**Manuel test:**
- Load listview → I DAG-filter aktiv, bonner sorteret efter tid
- Søg "334" → matcher bonnumre der starter med 334
- Søg "Lars" → matcher kundenavne
- ESC → rydder søgning, vender tilbage til I DAG
- Skift kolonne → sorteringspil vises, gemmes ved reload
- Kolonnevælger → slå Firma fra → kolonne forsvinder, huskes ved reload
- Klik på række → drawer åbner
- SSE-test: opret ny bon i andet vindue → vises øjeblikkeligt i listen
- Mobiltest (< 768px): layout kollapser, søgning virker

---

## Checkliste

Backend:
- [ ] `GET /api/bons` udvidet med alle join-felter (status_color, customer_name, company_name, unread_mail_count, latest_delivery_event)
- [ ] Søgning: bonnummer matches fra start ved kun cifre
- [ ] Alle query params implementeret (q, date, date_from, date_to, status, unread_mail, sort, dir, limit, offset)
- [ ] Alle 6 curl-kommandoer giver forventet output

Frontend:
- [ ] `office/views/bons-list.js` oprettet
- [ ] Fem filtre implementeret (I DAG, NY, ULÆST MAIL, Dato-picker, Alle)
- [ ] To-linje rækkelayout med firma på linje 2
- [ ] ✉-ikon med tæller ved unread_mail_count > 0
- [ ] 🔧 + blå border på produktions-bonner
- [ ] Bud-tidspunkt vises kun hvis sat
- [ ] Belastningsoverblik-linje ved dato-filter
- [ ] Kolonnevælger med dropdown + checkboxes
- [ ] Kolonnevalg gemmes i localStorage
- [ ] Sortering på alle valgfrie kolonner + gemmes i localStorage
- [ ] Søgefelt med debounce 300ms + ESC rydder
- [ ] SSE: bon_created + bon_updated opdaterer listen in-place
- [ ] Klik på række → openDrawer(id)
- [ ] "Ny bon"-knap → BonOpretModal
- [ ] Responsiv: kollapser korrekt under 768px
- [ ] Manuel test OK
