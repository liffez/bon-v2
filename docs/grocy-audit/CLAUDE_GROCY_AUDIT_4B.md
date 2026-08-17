# CLAUDE_GROCY_AUDIT_4B.md — Pack-size triangulering

> Tillæg til `CLAUDE_GROCY_AUDIT.md`. Læs hovedspecen først.
> Køres som selvstændigt script i samme `scripts/grocy-audit/`-mappe.
> Kan tilføjes nu eller efter Fase 4 er gennemgået.
> Dato: maj 2026

---

## Formål

Find produkter hvor **pakke-vægten er kodet inkonsistent** på tværs af tre uafhængige steder i Grocy:

| # | Kilde | Bruges af |
|---|---|---|
| A | `product_barcodes.amount` + `qu_id` (pr. supplier-SKU) | Varemodtagelse, indkøbs-UI |
| B | `quantity_unit_conversions` (purchase-qu → stock-qu) | Grocy's egne kostpris-beregninger, sync-v1 |
| C | Hørkram-snapshot userfields (pack-pris + kg-pris) | `supplier_price_per_kg`-beregning i indkøbsmodulet |

**Triangulering:** Alle tre kilder skal pege på samme pakke-vægt i stock-enhed ±2%. Hvis ikke → flag.

### Baggrund

F12-fund (14. maj 2026) viste at **Brød Rug (pid 1)** har `1 Kasse = 10.8 Kilo` i `quantity_unit_conversions`, mens `product_barcodes` og Hørkram-snapshot begge siger 7.68 kg (64 stk × 0.12 kg). Adapteren risikerer at falback'e på 10.8 og beregne kr/kg = 8.78 i stedet for 12.34 — **29% fejl**, der forplanter sig til både kostpriser, faktura-grundlag og dækningsbidrag.

Hovedspecens Fase 4 fanger ikke dette, fordi den arbejder på **cost-fra-opskrift-stien**, ikke **supplier-pack-stien**. De to er forskellige pris-kæder i samme system.

---

## Forudsætninger

Samme som hovedspec:

- Arbejdskopi af HQ Grocy-DB i `~/grocy-audit-YYYYMMDD/grocy.db`
- `lib/db.js` og `lib/report.js` fra hovedspecen
- Read-only — ingen writes, ingen API-kald

Forudsætter at **Fase 1 (inventar) er kørt** så følgende er bekræftet i Grocy's faktiske schema:

| Hvad | Hvor det typisk ligger | Bekræftes via |
|---|---|---|
| Userfield-værdier pr. produkt | `userfield_values` (object_type='products', field_id, value) | Fase 1's tabel-listning |
| Hørkram-userfield navne | Læses fra `userfields`-tabel hvor `entity='products'` og `name LIKE 'horkram_%'` | Diagnostik-sektion i scriptet (se nedenfor) |
| product_barcodes-skema | `product_barcodes(product_id, barcode, amount, qu_id)` | Fase 1 |

**Hvis Hørkram-userfield navne afviger fra de antagne** (`horkram_varenr`, `horkram_price_per_pack_dkk`, `horkram_price_per_kg_dkk`): scriptet kortlægger faktiske navne i diagnostik-sektionen først. Juster JOIN'et og kør igen.

---

## Script `04b_pakkestoerrelser.js`

```javascript
// scripts/grocy-audit/04b_pakkestoerrelser.js
//
// Triangulerer pakke-vægt fra 3 uafhængige kilder pr. aktivt produkt
// der har Hørkram-snapshot. Read-only. Ingen API-kald.

const { openDb } = require('./lib/db');
const { writeReport, formatTable } = require('./lib/report');

const db = openDb({ readonly: true });
const TOLERANCE = 0.02; // ±2%
const sections = [];

// ─── Diagnostik først: hvilke horkram_*-userfields findes? ──────
const horkramFields = db.prepare(`
    SELECT uf.name, COUNT(uv.id) AS n_products
    FROM userfields uf
    LEFT JOIN userfield_values uv ON uv.field_id = uf.id
    WHERE uf.entity = 'products'
      AND uf.name LIKE 'horkram_%'
    GROUP BY uf.name
    ORDER BY uf.name
`).all();

sections.push({
    title: 'Hørkram-userfields fundet i schema',
    body: formatTable(horkramFields)
});

// Hvis kerne-felter mangler: stop her og bed Leif bekræfte navnene
const requiredFields = ['horkram_varenr', 'horkram_price_per_pack_dkk', 'horkram_price_per_kg_dkk'];
const foundNames = new Set(horkramFields.map(r => r.name));
const missing = requiredFields.filter(n => !foundNames.has(n));

if (missing.length) {
    sections.push({
        title: '⚠ Manglende forventede userfield-navne',
        body: 'Mangler: ' + missing.join(', ') +
              '\n\nJustér JOIN i scriptet til de faktiske navne og kør igen.'
    });
    writeReport('04b_pakkestoerrelser', sections);
    db.close();
    process.exit(0);
}

// ─── 1. Saml produkter med Hørkram-snapshot ─────────────────────
const horkramProducts = db.prepare(`
    SELECT
      p.id, p.name, p.qu_id_purchase, p.qu_id_stock,
      MAX(CASE WHEN uf.name='horkram_varenr'             THEN uv.value END)              AS horkram_varenr,
      MAX(CASE WHEN uf.name='horkram_price_per_pack_dkk' THEN CAST(uv.value AS REAL) END) AS pack_dkk,
      MAX(CASE WHEN uf.name='horkram_price_per_kg_dkk'   THEN CAST(uv.value AS REAL) END) AS kg_dkk
    FROM products p
    JOIN userfield_values uv ON uv.object_id = p.id
    JOIN userfields uf       ON uf.id = uv.field_id AND uf.entity='products'
    WHERE p.active = 1
      AND uf.name LIKE 'horkram_%'
    GROUP BY p.id
    HAVING horkram_varenr IS NOT NULL
`).all();

const findings = [];

for (const prod of horkramProducts) {
    // ─── Kilde A: product_barcodes (matchet via horkram_varenr) ──
    const barcode = db.prepare(`
        SELECT pb.amount, pb.qu_id
        FROM product_barcodes pb
        WHERE pb.product_id = ? AND pb.barcode = ?
    `).get(prod.id, prod.horkram_varenr);

    const weightFromBarcode = barcode
        ? convertToStockUnit(db, prod.id, barcode.amount, barcode.qu_id, prod.qu_id_stock)
        : null;

    // ─── Kilde B: quantity_unit_conversions (purchase → stock) ───
    let weightFromConv = null;
    if (prod.qu_id_purchase !== prod.qu_id_stock) {
        const conv = db.prepare(`
            SELECT factor
            FROM quantity_unit_conversions
            WHERE product_id = ? AND from_qu_id = ? AND to_qu_id = ?
        `).get(prod.id, prod.qu_id_purchase, prod.qu_id_stock);
        weightFromConv = conv ? conv.factor : null;
    }

    // ─── Kilde C: Hørkram-snapshot (pack_dkk / kg_dkk) ───────────
    const weightFromHorkram = (prod.pack_dkk && prod.kg_dkk && prod.kg_dkk > 0)
        ? prod.pack_dkk / prod.kg_dkk
        : null;

    // ─── Triangulér ─────────────────────────────────────────────
    const values = [weightFromBarcode, weightFromConv, weightFromHorkram]
        .filter(v => v !== null && !isNaN(v) && v > 0);

    if (values.length < 2) continue; // ikke nok kilder

    const max = Math.max(...values);
    const min = Math.min(...values);
    const spread = (max - min) / min;

    if (spread > TOLERANCE) {
        findings.push({
            pid: prod.id,
            name: prod.name,
            varenr: prod.horkram_varenr,
            barcode_kg: weightFromBarcode?.toFixed(3) ?? '—',
            qu_conv_kg: weightFromConv?.toFixed(3) ?? '—',
            horkram_kg: weightFromHorkram?.toFixed(3) ?? '—',
            spread_pct: (spread * 100).toFixed(1) + '%'
        });
    }
}

findings.sort((a, b) => parseFloat(b.spread_pct) - parseFloat(a.spread_pct));

sections.unshift({
    title: `Produkter med inkonsistent pakke-vægt (spread > ${TOLERANCE * 100}%)`,
    body: findings.length
        ? formatTable(findings)
        : '_(ingen fund — alle produkter triangulerer indenfor tolerance)_'
});

// ─── Sub-fund: produkter med qu_purchase ≠ qu_stock UDEN conversion ──
const missingConv = db.prepare(`
    SELECT p.id, p.name, p.qu_id_purchase, p.qu_id_stock
    FROM products p
    LEFT JOIN quantity_unit_conversions c
      ON c.product_id = p.id
     AND c.from_qu_id = p.qu_id_purchase
     AND c.to_qu_id   = p.qu_id_stock
    WHERE p.active = 1
      AND p.qu_id_purchase != p.qu_id_stock
      AND c.id IS NULL
    ORDER BY p.name
`).all();

sections.push({
    title: 'Aktive produkter med qu_purchase ≠ qu_stock men ingen conversion',
    body: formatTable(missingConv)
});

writeReport('04b_pakkestoerrelser', sections);
db.close();

// ─── Helper ─────────────────────────────────────────────────────
function convertToStockUnit(db, productId, amount, fromQuId, stockQuId) {
    if (fromQuId === stockQuId) return amount;
    const conv = db.prepare(`
        SELECT factor FROM quantity_unit_conversions
        WHERE product_id = ? AND from_qu_id = ? AND to_qu_id = ?
    `).get(productId, fromQuId, stockQuId);
    return conv ? amount * conv.factor : null;
}
```

---

## Edge cases

| Situation | Håndtering |
|---|---|
| Produkt har Hørkram-snapshot men intet matching barcode | Triangulering med 2 kilder (B+C). Stadig nyttigt |
| `horkram_price_per_kg_dkk` indeholder Hørkrams "normaliserede kr/kg" (UI-bug: faktisk karton-prisen) | Falsk-positiv. Marker i rapport, fix manuelt |
| Produkt sælges i grundenheden (purchase_qu = stock_qu) | Ingen qu-conversion forventet. Kun A+C sammenlignes |
| Flere SKU'er fra Hørkram for samme produkt | Nuværende script ser kun på `horkram_varenr` (én pr. produkt). Multi-SKU-håndtering er separat opgave |
| `pack_dkk` mangler men `kg_dkk` findes | Skip — kan ikke beregne kg-fra-Hørkram med kun ét tal |

---

## Verifikation

- [ ] **Brød Rug (pid 1)** optræder øverst i fund-listen med ~29% spread
- [ ] Spread-procenter er under 1000% (ellers er scriptets enheds-konvertering selv buggy)
- [ ] Diagnostik-sektionen viser alle forventede Hørkram-felter
- [ ] Antal `missingConv`-rækker er overskueligt (< 20 — ellers er det et større problem end ét enkelt fund)
- [ ] Stikprøve: pluk 3 fund og verificér manuelt i Grocy-UI

---

## Output → cleanup-handlinger

Hvert fund i fund-tabellen bliver én af tre handlinger:

| Mønster | Handling | Cleanup-fil |
|---|---|---|
| `qu_conv_kg` afviger, `barcode_kg` og `horkram_kg` matcher | RET eller SLET conversion-rækken | `cleanup/004b_fix_qu_conversions.sql` |
| `barcode_kg` afviger | RET `product_barcodes.amount` | `cleanup/004b_fix_barcodes.sql` |
| `horkram_kg` afviger (sandsynlig UI-bug i Hørkram) | Manuel verifikation — re-fetch snapshot næste gang | Ingen SQL — manuel |
| Alle tre afviger | Manuel undersøgelse pr. produkt | Pr. produkt |

Cleanup-scripts skrives **først efter** fund-listen er gennemgået. Samme princip som hovedspecens cleanup-fase.

---

## Hvad scriptet IKKE gør

- Skriver ikke til DB
- Kalder ikke Grocy API
- Foreslår ikke selv fix-værdier — kun rapporterer hvad der ikke matcher
- Tjekker kun Hørkram. Andre leverandører (Inco, AB Catering osv.) får evt. egne audit-scripts senere — samme mønster, andre userfield-navne

---

## Næste skridt efter Fase 4B

1. **Manuel gennemgang** af fund-listen. Hvis < 30 produkter: pr.-produkt mod Hørkram-UI. Hvis flere: gruppér efter mønster og batch-cleanup
2. **F13-guard** i `services/horkramAdapter.js` (eller hvor batch-prisopdatering bor): når Hørkram returnerer ny `pack_size`, opdatér **både** `product_barcodes.amount` OG `quantity_unit_conversions.factor` — eller log advarsel hvis de divergerer fra hinanden. Skrives som separat lille spec efter cleanup er kørt
3. **Smoke-test** i Fase 6: tilføj assert "antal produkter med inkonsistent triangulering < 5% af aktive Hørkram-produkter"

---

*Tillæg til CLAUDE_GROCY_AUDIT.md — maj 2026*
