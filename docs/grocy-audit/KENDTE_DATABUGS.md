# KENDTE_DATABUGS.md — Data-quality issues i Bon v2
> Log over identificerede data-bugs der ikke blokerer drift,
> men som skal fixes før de bliver til lapninger.
> Følger samme princip som BON_V2_PRINCIPPER.md punkt 1: når noget
> ikke passer ind i strukturen, redesignes strukturen — der lappes ikke.
>
> Bugs nummereres fortløbende (#001, #002, ...) og lukkes ikke før
> de er reelt fixet — ikke bare omgået.

---

---

## Verificerede antagelser (ikke bugs)

### V1 — POS/Zettle ikke implementeret pr. 1. maj 2026

Verificeret under moms-refaktoreringen:
- Ingen route, script eller webhook der opretter bons med payment_type='pos'
- 0 bons med payment_type='pos' i prod-DB
- 0 bon_lines med pos_product_id i prod-DB
- BETALT-status defineret i 001_core.sql:224 men oprettes ikke fra kode

Konsekvens: server-autoritativ recalc gælder ALLE eksisterende flow.
Når POS bygges, skal undtagelsesspor tilføjes (doc-kommentar i 
shared/moms.js og routes/bons.js har detaljerne).

---
---

## #003 — Mail-vars beregner moms forkert (ALVORLIG)

**Identificeret:** 1. maj 2026 (under Fase 0 af automatiseret moms-audit)
**Status:** Fundet, ikke fixet (afventer omfang-verifikation)
**Blokker:** Auditen — fix skal ind FØR Fase 1 fortsætter

### Symptom

`shared/bon_drawer.js:937` og `shared/bon_kort.js:508` beregner moms 
som `totalExMoms * 0.25` hvor `totalExMoms` faktisk er incl moms 
(SUM af bon_lines.line_total, som per doktrinen er incl moms).

Resultat: 25% af incl-summen bliver kaldt "moms" — det er for højt.
Korrekt moms = `momsOfIncl(incl)` = 20% af incl-summen.

### Eksempel (T-5: sub = 23.650 kr incl)

| | Beregning | Resultat |
|---|-----------|----------|
| Korrekt | `momsOfIncl(23650)` | 4.730 kr |
| Buggy | `23650 × 0.25` | 5.912,50 kr |
| Buggy total | `23650 + 5912.50` | 29.562,50 kr (25% for høj) |

### Hvor bruges resultatet

Begge filer bruger felterne i `_buildMailVars(bon)`. Returneres som 
`moms` og `totalInkl` til mail-skabeloner. Sendes til kunder hvis 
skabelonerne bruger `{{moms}}` og `{{totalInkl}}` placeholders.

### Skadens omfang

[TBD efter SQL-verifikation — se queries ovenfor]

- Mail-skabeloner der bruger felterne: ?
- Antal udgående mails siden bug'ens introduktion: ?
- Tidligste forekomst (git blame): ?
- Eksisterer i v1 også: ?

### Fix

`const moms = window.Moms.momsOfIncl(totalExMoms);` (begge steder)
+ omdøb variabel `totalExMoms` → `totalInclMoms` så koden ikke lyver.

### Næste skridt

- [ ] Kør de tre SQL-queries — bestem omfang
- [ ] git blame for at finde introduktionsdato
- [ ] Fix begge linjer (Claude Code anbefaling A)
- [ ] Verificér at fix ikke knækker andre callere af `_buildMailVars`
- [ ] Hvis kunder har fået forkerte tal: incident-kommunikation
- [ ] Genstart moms-audit Fase 1


---

## #001 — sync-v1 cost_price enheds-mismatch

**Identificeret:** 1. maj 2026 (under moms-refaktorering, Commit 3-spotcheck)
**Status:** Diagnosticeret, ikke fixet
**Blokker:** Nej for moms-arbejdet. Ja for e-conomic-integration.

### Symptom

4.454 ud af 16.024 prissatte v1-migrerede `bon_lines` har
`cost_price >= unit_price`. Max ratio 150×. Eksempler:

| Produkt | unit_price | cost_price | Ratio |
|---------|-----------|-----------|-------|
| Kartoflen | 89 kr | 3.078 kr | 35× |
| Fisken | 94 kr | 7.805 kr | 83× |
| Italieneren | 89 kr | 8.041 kr | 90× |
| Skinken | 94 kr | 5.394 kr | 57× |

På de "plausible" linjer (cost < unit, n=11.570) er gns. ratio 0.244 —
hvilket matcher en sund margin (~75 % DB). Det bekræfter at de 28 %
afvigende ikke er et moms-problem.

### Diagnose

Ikke et moms-problem (moms ville give konstant 1.25 ratio).
Multiplikatorerne varierer 1.0–150×, hvilket peger på **enheds-mismatch**
i `scripts/sync-v1.js` ved import:

- Sandsynligt: `qu_id_purchase` (kr/kg) bliver brugt hvor `qu_id_stock`
  (kr/portion) forventes — eller omvendt
- Eller: `amount_for_this_recipe` (gram) bliver ganget på `unit_price`
  uden konvertering til portion-enhed
- Eller: kostpris hentes fra forkert Grocy-felt (fx `last_price` på et
  råvare-produkt i stedet for opskriftens beregnede kostpris)

### Konsekvens i UI

DB%-kolonner i `shared/planning.js` og `tilbud.js` viser allerede skæve
tal for de 28 % af linjer. Brugeren kan se fx "DB: -3400 %" eller
lignende meningsløse værdier i historiske bonner og tilbud genereret
fra historiske data.

### Hvorfor ikke fixet nu

1. Det er en **import-bug**, ikke en runtime-bug — nye v2-native bons
   rammes ikke
2. Fix kræver gennemgang af `sync-v1.js` + Grocy-data først (relateret
   til Grocy-audit, bug #002)
3. Skal ikke blandes ind i moms-refaktoreringen — separate spor

### Påvirker ikke

- Server-autoritativ recalc (`recalcBonTotal`) — bruger kun
  `quantity × unit_price`
- Moms-beregning — bruger kun `unit_price`
- Salgs-totaler i kalender og dashboards
- Commit 3 i moms-refaktoreringen

### Næste skridt

- [ ] Grocy-data-audit (separat spec — `CLAUDE_GROCY_AUDIT.md`)
- [ ] Gennemgang af `scripts/sync-v1.js` linje ~533 og omkring kostpris-import
- [ ] Bestem fix-strategi: re-import vs. SQL-korrektion på eksisterende rækker
- [ ] Test mod backup af prod-DB før kørsel
- [ ] Tilføj smoke-test der fanger fremtidige import-bugs (assert: cost < unit på >95 % af linjer)

### Spotcheck-queries til reference

```sql
-- Q1: Hvor mange linjer har cost_price >= unit_price?
SELECT COUNT(*) FROM bon_lines
WHERE cost_price IS NOT NULL AND unit_price IS NOT NULL
  AND cost_price >= unit_price;
-- Resultat 1. maj 2026: 4.454 ud af 16.024 (28 %)

-- Q2: Ratio-fordeling på alle v1-migrerede prissatte linjer
SELECT
  ROUND(AVG(cost_price/unit_price), 3) AS avg_ratio,
  ROUND(MIN(cost_price/unit_price), 3) AS min_ratio,
  ROUND(MAX(cost_price/unit_price), 3) AS max_ratio
FROM bon_lines
WHERE cost_price > 0 AND unit_price > 0;
-- Resultat 1. maj 2026: avg 2.38, min 0.004, max 150

-- Q3: Worst offenders — top 20
SELECT product_name, unit_price, cost_price, quantity,
       ROUND(cost_price/unit_price, 1) AS ratio
FROM bon_lines
WHERE cost_price > unit_price * 5
ORDER BY ratio DESC
LIMIT 20;
```

---

## #002 — Grocy data-quality (forventet)

**Identificeret:** 1. maj 2026 (afledt af #001)
**Status:** Ikke kortlagt — afventer audit
**Blokker:** Nej for noget aktuelt. Ja for fix af #001.

### Symptom

Bug #001 peger på at sync-v1's kostpris-import er forkert, men det er
ikke afklaret om fejlen ligger i:

- Sync-scriptet (forkert mapping mellem Grocy-felter og bon_lines)
- Grocy-data selv (forkerte enheder, manglende konverteringsfaktorer,
  forkerte priskategorier udfyldt)
- Begge

### Hvad der skal auditeres

Se `CLAUDE_GROCY_AUDIT.md` (separat spec). Forventede fund:

- `qu_id_purchase` vs. `qu_id_stock` konsistens på opskrifter
- `amount_for_this_recipe` enhed-konsistens
- Userfield-priser (Catering, Festival, Produktion, Store, Waiste, Produktion)
  udfyldt på alle aktive `sellable=1` opskrifter
- `grupper`-userfield konsistens (samme labels på tværs)
- Co2e-felt udfyldt og i konsistent enhed
- Allergener komplette på aktive opskrifter

### Næste skridt

- [ ] Lav `CLAUDE_GROCY_AUDIT.md`-spec
- [ ] Kør audit mod HQ Grocy
- [ ] Log fund som specifikke bugs (#003, #004, ...) i denne fil
- [ ] Fix Grocy-data først, derefter genbesøg #001

---

*Sidst opdateret: 1. maj 2026*
