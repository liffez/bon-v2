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

### Terminal-statusser kan ikke annulleres via UI

Statusser `FAKTURERET`, `BETALT` og `AFSLUTTET` er **terminale** — de kan ikke skiftes til `AFLYST` via det normale status-PATCH-endpoint. `status_transitions`-tabellen indeholder ingen rækker hvor `from_status` er en af disse med `to_status='AFLYST'`. `T_BON_DB_06` verificerer dette automatisk.

**Hvorfor:** Kreditnotaer hører til regnskabsdomænet, ikke status-flowet. En faktureret ordre annulleres ved at oprette en kreditnota i e-conomic — ikke ved at sætte bonens status til AFLYST. Hvis status kunne hoppes tilbage, ville historikken blive uklar:

- "Var den her faktureret eller ej?"
- "Skal den med i året-til-dato regnskab?"
- "Skal momsen tilbage?"

**Hvis det alligevel skal gøres** (sjælden datafejl der kræver manuel rettelse): admin kan bruge `{force: true, user_id: <admin>}` på PATCH-endpointet eller direkte SQL-UPDATE. Begge logger automatisk i `changelog` så audit-trailen forbliver komplet.

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

## 6c. MOMS-VISNING — DISCIPLIN I UI

Moms-konventionen (sektion 6b) regulerer hvordan moms ligger gemt. Denne sektion regulerer **hvordan moms vises i UI**.

### Hovedregel

Hvert pris-tal i UI skal have moms-basis synligt i samme visuelle blok som tallet. Ikke i tooltip, ikke i help-tekst, ikke nederst på siden.

### De 7 operationelle regler

**Regel 1 — Moms-basis skal være SYNLIG i samme visuelle blok som tallet.**
- ✅ Acceptabelt: `"23.650 kr (incl moms)"`
- ✅ Acceptabelt: `"Indbetalinger (incl moms): 23.650 kr"`
- ✅ Acceptabelt: column-header `"Beløb (ex moms)"` hvor alle rækker arver
- ❌ IKKE acceptabelt: tooltip eller help-icon der skal hoveres
- ❌ IKKE acceptabelt: forklaring nederst på siden
- ❌ IKKE acceptabelt: bare `"23.650 kr"` eller `"Total"`

**Regel 2 — I tabeller arver rækker fra column-header.**
Hvis kolonnen hedder `"Beløb (ex moms)"`, skal alle tal i kolonnen være ex moms. Bland aldrig basis i samme kolonne.

**Regel 3 — KPI-kort viser basis ved siden af eller under tallet.**
Ikke i en separat overskrift langt væk. Tallet og basis hører sammen.

**Regel 4 — Når flere basis-typer vises i samme view, gør det klart:**
- Cashflow: `"Indbetalinger (incl moms)"` + `"Disponibelt (ex moms)"`
- Bon-detalje: `"Total til kunde (incl moms)"` + `"Pris ex moms"`

**Regel 5 — Labels for "moms-forpligtelse" skal være entydige.**
- `"Moms"` alene er tvetydigt (er det momsbeløbet eller momsraten?)
- Brug `"Moms (25%)"` eller `"Moms-forpligtelse"` eller `"Moms til SKAT"`

**Regel 6 — Print/PDF/mail har samme regler som UI.**
Tilbud, faktura, kvitteringer: hver pris-linje har eksplicit basis.

**Regel 7 — CSV/Excel-eksport: column-headers skal indeholde basis.**
`total_price` → `total_price_incl_moms` eller dokumentér i README.

### Konventioner pr. visningstype

| Sted | Default basis | Label |
|------|--------------|-------|
| **Bon-detalje (kunde-vendt)** | Total inkl. moms (kundepris) | `"Total til kunde (incl moms): X kr"` + separat `"Pris ex moms: Y kr"` + `"Moms (25%): Z kr"` |
| **Tilbud (kunde-vendt)** | Som bon-detalje | Samme — kunden ser hvad de skal betale |
| **Cashflow / pengestrømme** | INCL moms (faktiske bankbevægelser) | `"Indbetalinger (incl moms)"`, `"Bankbevægelser (incl moms)"`. Plus separat KPI `"Heraf moms-forpligtelse"` og `"Disponibelt for drift (ex moms)"` |
| **Rapporter / dashboards / analyse** | EX MOMS (regnskabskonvention) | `"Omsætning (ex moms)"`, `"Beløb (ex moms)"`, section-headers `"Top-produkter — alle tal ex moms"` |
| **Faktura / e-conomic-eksport** | EX MOMS pr. linje + separat moms-felt | E-conomic-konvention |

### Hvorfor

- **Cashflow er pengestrømme, ikke regnskab.** Bankkontoen er incl moms — det er reelle penge der er gået ind. Skal afspejles som de faktisk er.
- **Omsætning er et regnskabsbegreb.** Per definition rapporteres ex moms til revisor, e-conomic, og ledelse. Hvis "Omsætning" er ex moms, skal alt der summerer til omsætning også være ex moms (top-produkter, kategorier, charts).
- **Kundepris er incl moms.** Det er hvad kunden faktisk betaler. Kunde-vendte views (bon, tilbud, mail-bekræftelse) viser primært incl, med ex+moms-andel som supplement.

### Konsistens-regel

Hvis et view blander typer (fx dashboard der viser BÅDE omsætning OG likviditet): tydelig adskillelse med basis pr. blok. Aldrig en samlet "Total"-linje uden basis-label.

### API-kontrakt for analyse-endpoints

Alle aggregerings-endpoints (`/api/cashflow/stats`, `/api/reports/*`, `/api/dashboard/*`) skal udstille begge værdier så frontend ikke selv beregner:

```json
{
  "revenue_excl_moms": 18920,    // primær — det vi kalder "omsætning"
  "revenue_incl_moms": 23650,    // tilgængelig hvis nogen vil vise kundepris
  "vat_collected":      4730     // for momsindberetning
}
```

For cashflow tilføjes:
```json
{
  "revenue_incl_moms": 23650,    // bankbevægelser (primær for cashflow)
  "vat_liability":      4730,    // heraf moms-forpligtelse til SKAT
  "revenue_excl_moms": 18920     // disponibelt for drift
}
```

Default i frontend følger tabellen ovenfor (ex moms for analyse, incl for cashflow).

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
