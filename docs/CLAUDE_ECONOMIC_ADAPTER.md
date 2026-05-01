# CLAUDE_ECONOMIC_ADAPTER.md — E-conomic faktura-adapter
> Læs CLAUDE.md, docs/bon_v2_datamodel_v2.md og **BON_V2_PRINCIPPER.md sektion 6b+6c** FØR du starter.
> Status: ikke bygget. Spec oprettet maj 2026 som forberedelse.

---

## Formål

Når Bon v2 skal sende fakturaer til e-conomic, skal denne adapter konvertere
en Bon v2 `bon` til en e-conomic-faktura-payload og sende den via e-conomic API.

---

## MOMS-HÅNDTERING — kritisk

E-conomic kræver linje-priser **EX MOMS** + separat moms-felt på faktura-niveau.

Bon v2-konvention (jf. `BON_V2_PRINCIPPER.md` sektion 6b):
- `bon_lines.unit_price` er **INCL. moms**
- `bon_lines.line_total` er **INCL. moms**
- `bons.total_price` er **INCL. moms**
- `bons.delivery_price` er **INCL. moms**

**Konvertering:**

```javascript
const { inclToExcl, momsOfIncl } = require('../db/helpers');

function buildEconomicPayload(bon) {
    const lines = bon.lines.map(line => ({
        product_number: /* lookup fra Grocy-recipe */,
        description:    line.product_name,
        quantity:       line.quantity,
        unit_price:     inclToExcl(line.unit_price),   // EX moms til e-conomic
        line_total:     inclToExcl(line.line_total),   // EX moms
        // moms beregnes af e-conomic ud fra moms-koden
    }));

    return {
        customer_number: bon.customer_id_economic,
        date:            bon.delivery_date,
        currency:        'DKK',
        vat_zone:        25, // dansk standardmoms
        lines:           lines,
        // Levering som separat linje hvis delivery_price > 0
        ...(bon.delivery_price > 0 && {
            delivery_line: {
                description: `Levering ${bon.delivery_method || ''}`.trim(),
                unit_price:  inclToExcl(bon.delivery_price),
                quantity:    1,
            }
        }),
    };
}
```

**Vigtigt:**
- `bon_lines.cost_price` er allerede ex moms — skal IKKE konverteres igen
- E-conomic returnerer faktura-nummer ved success → gem på `bons.invoice_number`
- Ved success: skift `bons.status_id` til `FAKTURERET`

---

## Visnings-disciplin

Når der bygges et UI til at se "hvad sender vi til e-conomic" (preview/dryrun):

- Vis **både** ex moms + incl moms side om side
- Label tydeligt: `"Linje-priser (ex moms)"` og `"Total til kunde (incl moms)"`
- Følg de 7 regler i `BON_V2_PRINCIPPER.md` sektion 6c

---

## Test

Verifikations-suiten har en placeholder-test (#7) i
`tests/moms_audit_e2e.test.js` der venter på e-conomic-implementation.
Når koden bygges, skal denne assertion aktiveres:

```javascript
test('#7 — E-conomic-payload har ex-moms-linjer + separat moms-felt', () => {
    const payload = buildEconomicPayload(testBon);
    const linesSum = payload.lines.reduce((s, l) => s + l.line_total, 0);
    assert.ok(Math.abs(linesSum - T5.excl) < 1);
});
```

T-5 testbonen er der til formålet:
- 23.650 incl → 18.920 ex (linje-sum) + 4.730 moms

---

## Stop-betingelser

Hvis e-conomic API'et ændrer moms-format (fx kræver incl med separat moms),
**opdatér denne spec FØR koden ændres**. Hold tre dokumenter synkrone:
1. Denne fil
2. `BON_V2_PRINCIPPER.md` sektion 6b/6c
3. Verifikations-tests i `tests/moms_audit_e2e.test.js`

---

## Reference

- `docs/CLAUDE_TILBUD_PRIS.md` — samme moms-mønster i tilbud
- `docs/audit/moms_audit_fase3_2026-05-01.md` — dækning af moms-audit
- `shared/moms.js` — autoritativ kilde til alle moms-helpers

---

*Spec klar — vent på at e-conomic-integrationen bygges.*
