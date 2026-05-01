# Bon v2 — Principper & Ufravigelige Regler

> Dette dokument beskriver de beslutninger der er taget én gang og ikke diskuteres igen.
> Formål: forhindre at vi genopfinder hjulet, laver lappeløsninger, eller bygger noget der ikke passer ind.
> Opdateres kun når en beslutning bevidst ændres — og det kræver at begge (Leif + bror) er enige.

---

## 1. HVORFOR BON V2 EKSISTERER

Bon v1 endte med for mange lappeløsninger. Bon v2 er skrevet fra bunden for at undgå det samme.
Det betyder: **når noget ikke passer ind i strukturen, redesignes strukturen — der lappes ikke.**

---

## 2. STAK — INGEN ALTERNATIVER

| Lag | Valg | Må ikke erstattes med |
|-----|------|-----------------------|
| Backend | Node.js / Express | Python, PHP, andet |
| Database | SQLite via better-sqlite3 | PostgreSQL, MySQL, MongoDB |
| Frontend kitchen | Vanilla HTML/CSS/JS (MPA) | React, Vue, Next.js |
| Frontend office | Vanilla JS + selectiv Vue.js | Fuldt framework |
| Realtid | SSE (Server-Sent Events) | WebSockets, polling |
| Styling | Vanilla CSS med tokens | Tailwind, Bootstrap, CSS-in-JS |

**Rationale:** Ingen build-step, ingen afhængighedshelvede, kører på en simpel VPS, kan vedligeholdes af én udvikler.

---

## 3. DATAMODELLEN ER SANDHEDEN

`bon_v2_datamodel_v2.md` er den autoritative kilde til databaseskemaet.

- **Ingenting bygges der afviger fra dette dokument uden at dokumentet opdateres først.**
- Kolonnenavne, tabelnavne og relationer følges præcist.
- Hvis et felt mangler i skemaet, tilføjes det i dokumentet og i en ny migrationsfil — ikke inline i koden.
- Migrationsfiler nummereres fortløbende og køres aldrig om.

Vigtige navne at huske (tidligere kilde til forvirring):

| Korrekt | Må ikke kaldes |
|---------|----------------|
| `delivery_date` | `event_date` |
| `total_units` | `enheder` |
| `prep_ingredients_ready` | `prep_raavarer` |
| `prep_supplies_ready` | `prep_emballage` |
| `product_name` (på bon_lines) | `name` |
| `quantity` (på bon_lines) | `qty` |
| `status_id FK → status_definitions` | `status TEXT` |
| `delivery_address_id FK → addresses` | inline adressefelter |

---

## 4. STATUS-FLOW — VEJLEDNING, IKKE FÆNGSEL

Status-transitions i databasen definerer det **normale flow** og hvad der vises af knapper til køkkenet.

**Men:**
- En admin kan altid sætte en hvilken som helst status med `force: true` i API-kaldet.
- Virkeligheden kræver fleksibilitet: en bon kan hoppe fra VENTER til IGANG og tilbage, eller springe direkte til LEVERET.
- POS-ordrer (Zettle) sættes direkte til BETALT — det er en lovlig operation.
- Transitions er ikke sikkerhed — de er UX-hjælp.

**Regel:** Tilføj transitions når du opdager at en reel arbejdsgang kræver dem. Fjern dem ikke uden grund.

---

## 5. FILSTRUKTUR FØLGES

Filstrukturen er defineret i `bon_v2_zoner_og_layout.md`. Nye filer placeres der de hører hjemme.

```
bon-v2/
├── shared/       ← alt der bruges af mere end én zone
├── kitchen/      ← kun køkken-views (MPA)
├── office/       ← office shell + views
├── settings/     ← settings zone
├── db/           ← migrate.js, seed.js, helpers
├── server.js     ← én server, ikke flere
└── .env          ← aldrig i git
```

Nye views der deles mellem kitchen og office placeres i `shared/views/` — ikke kopieres.

---

## 6. KODE-PRINCIPPER

**Ingen eksterne afhængigheder uden godkendelse af begge.**
Hver ny npm-pakke er en fremtidig vedligeholdelsesopgave. Spørg: kan det løses med stdlib?

**Changelog på alle ændringer.**
Enhver statusskift, feltændring eller linje-opdatering på en bon skrives til `changelog`-tabellen automatisk af serveren — ikke af frontenden.

**Frontenden stoler ikke på sig selv.**
Validering sker i serveren. Frontenden er convenience, ikke sikkerhed.

**SSE til realtid — ikke polling.**
Kitchen-views abonnerer på `/api/sse`. Der polles ikke med setInterval.

**Grocy ejer lager og opskrifter.**
Bon v2 læser fra Grocy via adapter-pattern. Bon v2 skriver aldrig direkte til Grocy's database.

---

## 6b. MOMS — ÉN REGEL FOR HELE SYSTEMET

Disse regler er ufravigelige og gælder hele Bon v2.

### Hvor moms ligger gemt

| Felt | Moms-status |
|------|-------------|
| Grocy salgspriser (`SalespriceCatering`, `SalespriceFestival`, `SalespriceStore`, `SalespriceProduktion`, `SalespriceWaiste`) | **Incl. 25 % moms** |
| Grocy råvare-/kostpriser (på `products`) | **Ex moms** |
| Grocy fulfillment `costs` på opskrifter (sum af ingredienser × ex-moms-pris) | **Ex moms** |
| Grocy userfield `costprice` på opskrifter (fallback) | **Ex moms** |
| `bon_lines.unit_price` | **Incl. moms** (snapshot fra Grocy) |
| `bon_lines.cost_price` | **Ex moms** (snapshot fra Grocy) |
| `bon_lines.line_total` = `quantity × unit_price` | **Incl. moms** |
| `bons.delivery_price` | **Incl. moms** (kundepris) |
| `bons.delivery_cost` | **Ex moms** (intern kostpris) |
| `bons.total_price` | **Incl. moms** (sum af `line_total` + `delivery_price` − rabat) |
| `bons.total_with_delivery` | **Incl. moms** (= `total_price`, redundant — under afvikling) |
| Indkøb (purchase_orders, leverandørpriser) | **Ex moms** (bevidst anden konvention end salg) |

Konventionen er bekræftet af Leif (april 2026) — autoritativ, gæt ikke om det igen.

### Hvordan moms vises og beregnes

**Frontends MÅ IKKE selv regne moms ud fra rå priser.** Backend leverer pre-beregnede felter på alle bon- og tilbuds-API-svar:

```json
{
  "total_incl_moms": 23650,
  "total_excl_moms": 18920,
  "moms_amount":     4730
}
```

Ratioer:
- `total_excl_moms = total_incl_moms / 1.25`
- `moms_amount    = total_incl_moms − total_excl_moms` (= 20 % af incl. moms / 25 % af ex moms)

### ÉN definition af MOMS_FACTOR

Hele kodebasen bruger `shared/moms.js` til moms-beregninger. Dual-export:
- **Node:** `const { MOMS_FACTOR, inclToExcl, computeMomsFields, applyDiscount } = require('../shared/moms')`
- **Browser:** `window.Moms.inclToExcl(...)`, `window.Moms.computeMomsFields(...)`

`db/helpers.js` re-eksporterer fra `shared/moms.js` så route-filer kan importere derfra som hidtil.

**Regel:** Ingen kode i Bon v2 må have et bart `1.25` eller `0.25` udenfor `shared/moms.js` og `tests/`. Brug helpers.

### E-conomic og fakturering

E-conomic kræver ex-moms-priser. Når faktura genereres, skal `unit_price` konverteres ex moms før den sendes:

```javascript
const { inclToExcl } = require('../shared/moms');
const unit_price_excl = inclToExcl(bonLine.unit_price);
```

Konverteringen sker i e-conomic-adapteren — `bon_lines`-skemaet bevarer incl. moms som autoritativ snapshot.

### Begrundelse

Når hver renderer (wizard, preview, PDF, mail-skabelon, faktura, kundens portal) selv håndterer moms, kommer der fejl. Backend regner én gang. Frontend viser. Magic-numre forsvinder.

---

## 7. HVAD VI IKKE GØR

- Ingen multi-tenant løsning (hver installation har sin egen SQLite-fil)
- Ingen cloud-database (SQLite på lokal VPS)
- Ingen email-tjeneste (IMAP/SMTP direkte mod Simply.com)
- Ingen full-stack framework (ingen Next.js, Remix, osv.)
- Ingen ORM (SQL skrives direkte med better-sqlite3)
- Ingen Python-server som erstatning for Node.js-backenden

---

## 8. NÅR NOGET IKKE PASSER IND

Rækkefølgen er:

1. Forstå hvorfor det ikke passer — er det fordi designet er forkert, eller fordi løsningen er forkert?
2. Hvis designet skal ændres: opdater det relevante dokument først, diskutér med den anden part.
3. Implementér derefter.
4. Lav aldrig en midlertidig løsning med planen om at "fikse det senere" — det er sådan Bon v1 endte.

---

*Sidst opdateret: marts 2026*
