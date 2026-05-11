# T_INPUT — Test-spec for bon-oprettelse

> Verificerer at bonner kan oprettes via:
> - Manuel POST `/api/bons`
> - Linje-tilføjelse POST `/api/bons/:id/lines`
> - Formbuilder webhook `/api/webhooks/bestilling` (legacy felt-format)
> - Web-orders webhook `/webhook/bestilling` (nyt felt-format)
>
> Og at de oprettede bonner har korrekte felter (status NY, link til kunde/firma,
> changelog-entry, EAN-udtræk, total_price beregnet server-side).

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | POST-endpoints til bon-oprettelse + 2 webhooks |
| **Hvad testes IKKE** | Bon-oprettelse via UI (drawer/picker — kunne dækkes af Playwright senere) |
| **Forudsætninger** | T_BON og T_AGGR grøn. Test-server kører |

---

## 2. Test-cases

### 2.1 POST /api/bons — manuel oprettelse

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INPUT_M_01** | POST med minimal body (kun delivery_date) | 201, returneret bon har status_code=NY |
| **T_INPUT_M_02** | POST uden delivery_date | 400 |
| **T_INPUT_M_03** | POST genererer auto-bon_number | bon_number er en streng > 0 tegn |
| **T_INPUT_M_04** | POST med customer_id linker | returneret bon har customer_id sat |
| **T_INPUT_M_05** | POST opretter changelog 'create' | changelog-tabel har row med action='create' |
| **T_INPUT_M_06** | POST med klient-supplied total_price ignoreres | server beregner via recalcBonTotal — total_price=0 hvis ingen linjer |

### 2.2 POST /api/bons/:id/lines — tilføj linje

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INPUT_L_01** | Tilføj linje opdaterer bon.total_price | total_price = quantity × unit_price |
| **T_INPUT_L_02** | Linje uden product_name | 400 |
| **T_INPUT_L_03** | Linje med quantity=0 og unit_price=0 | 201 men line_total = 0 |

### 2.3 Formbuilder webhook (legacy felt-format)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INPUT_W_01** | POST med komplet body opretter bon | 200 OK, ny bon i DB med status NY |
| **T_INPUT_W_02** | Honeypot (`website`-felt udfyldt) ignoreres | 200 OK, ingen bon oprettet |
| **T_INPUT_W_03** | Manglende f2/f7_date/f7_time | 200 OK (altid), ingen bon oprettet |
| **T_INPUT_W_04** | EAN (13 cifre) udtrækkes fra f12 | firma.ean = '5798009811578' efter webhook |

### 2.4 Web-orders webhook (nyt felt-format)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_INPUT_O_01** | POST med komplet body opretter bon | 200 OK, ny bon med status NY |
| **T_INPUT_O_02** | Manglende delivery_date afvises | 400 eller 200 uden bon |

---

## 3. Filer der skal eksistere

| Fil | Status |
|-----|--------|
| `tests/specs/T_INPUT.md` | ✅ |
| `tests/scripts/run_T_INPUT.js` | ✅ |
| `tests/reports/T_INPUT_YYYY-MM-DD.md` | ✅ |

---

## 4. Status — første kørsel maj 2026

```
15 PASS · 0 FAIL · 0 SKIP

M  6/6  ✓  (manuel POST /api/bons: minimal, no-date, auto-bon-number, FK-link, changelog, total_price server-side)
L  3/3  ✓  (POST /:id/lines: total_price recalc, NOT NULL product_name, 0/0-linje accepteres)
W  4/4  ✓  (legacy webhook: opretter bon, honeypot, manglende felter, EAN-udtræk fra f12)
O  2/2  ✓  (web-orders webhook: opretter bon, manglende delivery_date)
```

T_INPUT-tracken er **færdig** for Fase 1. Ingen kode-bugs fundet — webhook-flows
fungerer som forventet, server-side total_price-beregning er autoritativ.

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
