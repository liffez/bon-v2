# CLAUDE_TILBUD_PRIS.md — Tilbud: prisbug, momshåndtering og leveringsoprydning

> Læs `CLAUDE.md`, `BON_V2_PRINCIPPER.md` og `bon_v2_datamodel_v2.md` FØR du starter.
> Opdateret: april 2026.
> Forfatter: Leif (i dialog med Claude). Implementeres af Simon.

---

## Formål

Én samlet opgave der løser fire sammenhængende problemer i tilbudsmodulet:

1. **Prisbug:** Tilbud viser totalpris ~25–50 % for høj. Skyldes en ældre version af `office/views/tilbud.js` på prod der lægger 25 % moms ovenpå priser der allerede er incl. moms. Plus dobbelttælling når levering både ligger som Grocy-linje og som `bon.delivery_price`.

2. **Manglende moms-doktrin:** Ingen autoritativ regel for hvor moms ligger gemt. Hver renderer regner selv ud fra rå priser → fejl spreder sig til alle nye renderere.

3. **Tre felter for samme info:** `bons.delivery_type`, `bons.delivery_method`, `bons.customer_collects` og frontend-state `_tDel.type` (med endnu et fjerde enum-sæt: `byx`/`taxa`/`rr`) overlapper. Plus en fjerde kanal: Grocy-recipes i kategorien `x-Levering` der kan vælges som menu-linjer.

4. **Hardcoded leveringsenum:** Kan ikke konfigureres uden kodeændring.

---

## Forudsætninger

- Grocy **salgspriser er ALTID incl. moms** (`SalespriceCatering`, `SalespriceButik`,
  `SalespriceFestival`, `Produktion`, `waiste` — alle userfields på `recipes`-entiteten).
  Grocy **råvarepriser** (på `products`) er ex moms.
  Den **`costprice` Grocy selv beregner pr. opskrift** (fulfillment `costs`, summen af
  ingredienser × deres ex-moms-pris) er **ex moms**.
  Userfield `costprice` på opskriften er fallback og forventes også ex moms.
  Bekræftet af Leif (april 2026) — autoritativ konvention, gæt ikke om det igen.

- Grocy har 5 priskategorier per opskrift (Catering, Butik, Festival, Produktion, Waiste) — det dækker pris-niveau-behovet. Tilbud skal IKKE skifte mellem Grocy-instanser for at få forskellige priser; det skal vælge mellem priskategorier.

- Bon v1 har `x-Levering`-opskrifter i Grocy (By-ekspressen leverer, RR leverer, Levering med El-Taxa, etc.). Alle Bon v1-bonner migreres til Bon v2, og en del af dem har levering som `bon_lines` (gennem disse opskrifter). Vi må ikke ødelægge migrerede data.

- Datamodellen har allerede dedikerede leveringsfelter på `bons` (`delivery_type`, `delivery_method`, `delivery_price`, `delivery_cost`, `courier_provider`, etc.). Datamodellen er rigtig — det er udfyldningen der er rod.

---

## Plan i seks dele

| Del | Hvad | Berørte filer |
|-----|------|---------------|
| 0 | Verificér deployet kode-version | (intet) |
| 1 | Moms-doktrin tilføjes ufravigeligt | `CLAUDE.md` + `BON_V2_PRINCIPPER.md` |
| 2 | Deploy korrigeret `tilbud.js` | `office/views/tilbud.js` |
| 3 | Backend leverer pre-beregnede moms-felter | `routes/quotes.js`, `routes/bons.js` |
| 4 | Levering — ÉN kilde, konfigurerbar | `settings`, frontend, evt. ny migration |
| 5 | Filter på menu-picker for `x-Levering` (med migrationshensyn) | `tilbud.js`, evt. helper |
| 6 | Test og rollout | Manuel test på 5 bonner |

---

# Del 0 — Verificér deployet kode-version

Inden noget deployes, bekræft at prod faktisk kører den ældre buggy version. Kør på serveren:

```bash
ssh bon@<server> "grep -nE 'tot \\* 1\\.25|sub \\* 1\\.25|tot / 1\\.25|sub / 1\\.25' \
  /home/bon/bon-v2/office/views/tilbud.js"
```

**Forventet udfald hvis prod er buggy:** Linjer der laver `* 1.25` (ganger med 1,25 for at få total) og **ingen** linjer med `/ 1.25`.

**Forventet udfald efter fix:** Linjer med `tot / 1.25` for at få ex-moms subtotal, og **ingen** linjer der ganger med 1,25.

Dokumentér i kommit-besked at det blev verificeret før deploy.

---

# Del 1 — Moms-doktrin (ufravigelig regel)

Disse tekstblokke tilføjes **ordret** til to filer — det er nok at vedligeholde teksten ét sted og linke i den anden, men begge skal indeholde reglen.

## 1.1 Tilføj til `BON_V2_PRINCIPPER.md`

Indsæt som ny sektion. Forslag til placering: efter sektionen om datamodel-principper, før integrationerne.

```markdown
## Moms — én regel for hele systemet

Disse regler er ufravigelige og gælder hele Bon v2.

### Hvor moms ligger gemt

| Felt | Moms-status |
|------|-------------|
| Grocy salgspriser (`SalespriceCatering`, `SalespriceFestival`, etc.) | **Incl. 25 % moms** |
| Grocy råvare-/kostpriser | **Ex moms** |
| `bon_lines.unit_price` | **Incl. moms** (snapshot fra Grocy) |
| `bon_lines.cost_price` | **Ex moms** (snapshot fra Grocy) |
| `bon_lines.line_total` = `quantity × unit_price` | **Incl. moms** |
| `bons.delivery_price` | **Incl. moms** (kundepris) |
| `bons.delivery_cost` | **Ex moms** (intern kostpris) |
| `bons.total_price` | **Incl. moms** (sum af `line_total` + `delivery_price` − rabat) |
| `bons.total_with_delivery` | **Incl. moms** (= `total_price`, redundant — overvej at fjerne) |

### Hvordan moms vises

Frontends MÅ IKKE selv regne moms ud fra rå priser. Backend leverer pre-beregnede felter på alle bon- og tilbuds-API-svar:

```json
{
  "total_incl_moms": 23650,
  "total_excl_moms": 18920,
  "moms_amount":     4730
}
```

Ratioer:
- `total_excl_moms = total_incl_moms / 1.25`
- `moms_amount    = total_incl_moms − total_excl_moms` (svarer til 20 % af incl. moms / 25 % af ex moms)

Begrundelse: når hver renderer (wizard, preview, PDF, mail-skabelon, faktura, kundens portal) selv skal håndtere moms, kommer der fejl. Backend regner én gang. Frontend viser.

### E-conomic og fakturering

E-conomic kræver ex-moms-priser. Når faktura genereres, skal `unit_price` konverteres ex moms før den sendes:

```
unit_price_excl = unit_price_incl / 1.25
```

Dette gøres i e-conomic-adapteren, ikke i `bon_lines`-skemaet — der bevares incl. moms som autoritativ snapshot.
```

## 1.2 Tilføj til `CLAUDE.md`

Indsæt en kort henvisning under **Vigtige regler**:

```markdown
- **Moms-håndtering** — Grocy salgspriser ER incl. moms; kostpriser er ex moms.
  `bon_lines.unit_price` og `bons.total_price` ER incl. moms. Frontends regner ALDRIG
  selv moms — de bruger pre-beregnede felter (`total_incl_moms`, `total_excl_moms`,
  `moms_amount`) fra API-svaret. Se `BON_V2_PRINCIPPER.md` for komplet regel.
```

---

# Del 2 — Deploy korrigeret `tilbud.js`

Den uploadede fil `/office/views/tilbud.js` indeholder allerede den korrekte matematik. Implementér disse tre identiske beregninger på tre steder:

| Funktion | Linjer (ca.) | Brug |
|----------|--------------|-----|
| Wizard step 4 prisvisning | ~1100–1175 | Det redigerbare prisbillede |
| `_tRenderPreview` step 5 | ~1240–1300 | Polishet preview-side (det er den i screenshot) |
| `_tGenPDF` PDF-rendering | ~1500–1585 | Download PDF og evt. send til kunde |

Den korrekte matematik:

```javascript
// sub er sum af (unitPrice × qty) — Grocy-priser ER incl. moms → sub ER incl. moms
const dA       = sub * (_tDiscountPct / 100);
const tot      = sub - dA;       // stadig incl. moms
const subUMoms = tot / 1.25;     // ex moms
const moms     = tot - subUMoms; // momsbeløbet (= 20 % af tot)

// Display:
//   "Subtotal (u/moms)" → subUMoms
//   "Moms (25%)"        → moms
//   "Total inkl. moms"  → tot
```

**Bevidst valg:** Rabat trækkes mathematically i incl-moms-rummet, men det **viste rabatbeløb** skal være i ex-moms-rummet, så det er konsistent med dets placering mellem `Subtotal (u/moms)` og `Moms (25%)`. Slutbeløbene er identiske uanset hvilket rum man regner i:

```javascript
const dA       = sub * (_tDiscountPct / 100);    // intern: bruges til tot-beregning
const tot      = sub - dA;                        // total efter rabat (incl. moms)
const subUMoms = tot / 1.25;
const moms     = tot - subUMoms;

// Til visning af rabat-linjen mellem Subtotal (u/moms) og Moms:
const dA_excl  = (sub / 1.25) * (_tDiscountPct / 100);  // = dA / 1.25
```

I render-koden vises `_tFk(dA_excl)` på rabat-linjen, IKKE `_tFk(dA)`. Brugt til subtotal-, moms- og total-værdier er `dA` uændret.

Rabat anvendes sjældent i Ristet Rug — primært for kunder der videresælger. Funktionen skal stadig fungere korrekt i de få tilfælde.

**Acceptkriterie:** Tilbud T-5 (eksempel-bon med 60 Fisken + 70 Frikadellen + 70 Kartoflen + 8 Servicepersonale) skal efter deploy vise:

| Felt | Forventet værdi |
|------|----------------:|
| Subtotal (u/moms) | 18.920 kr |
| Moms (25%) | 4.730 kr |
| Total inkl. moms | 23.650 kr |
| Pr. pax inkl. moms | 118 kr |

(IKKE 23.650 / 5.913 / 29.563 / 148 — det er den buggy version.)

---

# Del 3 — Backend leverer pre-beregnede moms-felter

Frontend skal ikke længere selv dele med 1,25. Backend gør det én gang og udstiller det på alle relevante endpoints.

## 3.1 Fælles helper

Tilføj til `db/helpers.js`:

```javascript
/**
 * Beregn moms-felter ud fra incl-moms-total.
 * Bon v2-konvention: alle priser i DB er incl. moms.
 * Se BON_V2_PRINCIPPER.md.
 */
function computeMomsFields(totalInclMoms) {
    const incl = Math.round((totalInclMoms ?? 0) * 100) / 100;
    const excl = Math.round((incl / 1.25) * 100) / 100;
    const moms = Math.round((incl - excl) * 100) / 100;
    return {
        total_incl_moms: incl,
        total_excl_moms: excl,
        moms_amount:     moms,
    };
}

module.exports = { /* ... eksisterende eksports ... */, computeMomsFields };
```

## 3.2 Anvend i `routes/quotes.js`

I `GET /:id`-svaret, før `res.json(...)`:

```javascript
const { computeMomsFields } = require('../db/helpers');

// ...
const momsFields = computeMomsFields(bon.total_price);

res.json({
    /* ...eksisterende felter... */
    total_price: bon.total_price,        // incl. moms (uændret, baglæns kompatibel)
    ...momsFields,                       // total_incl_moms, total_excl_moms, moms_amount
    lines: lines,
});
```

Samme mønster i `GET /` (liste) — felterne tilføjes per række.

## 3.3 Anvend i `routes/bons.js`

Samme tilføjelse på `GET /api/bons/:id` og `GET /api/bons/today`.

## 3.4 Frontend-konsekvens

`tilbud.js` (og senere bon-kort, fakturaforslag, kundens preview) bør på sigt skifte til at bruge API-felterne i stedet for at regne selv:

```javascript
// FØR
const subUMoms = tot / 1.25;
const moms = tot - subUMoms;

// EFTER (når data kommer fra API)
const { total_incl_moms, total_excl_moms, moms_amount } = quoteData;
```

Men i wizarden, hvor brugeren live redigerer linjer og priserne ikke er gemt endnu, må frontend regne selv — det er OK fordi det er midlertidigt indtil næste save. Som hjælpefunktion:

```javascript
// office/views/tilbud.js — tilføj øverst
const MOMS_FACTOR = 1.25;

function momsFromIncl(incl) {
    const excl = incl / MOMS_FACTOR;
    return { incl, excl, moms: incl - excl };
}
```

Brug `momsFromIncl(tot)` i alle tre rendering-funktioner. Det fjerner duplikatet af `1.25` magic number.

---

# Del 4 — Levering konsolideret til ÉT konfigurerbart sted

## 4.1 Princip

`bons.delivery_method` bliver det eneste enum-felt. Det er **konfigurerbart via `settings`-tabellen** — ingen hardcoded enum i kode.

`bons.delivery_type` (`delivery`/`pickup`/`event`) og `bons.customer_collects` **droppes ikke fra databasen** (det ville ødelægge migration), men de **bruges ikke længere** af nye frontends. De udfyldes kun ved migration fra v1 og bevares for kompatibilitet.

## 4.2 Settings-data

Tilføj eller opdatér i `settings`-tabellen via ny migration `057_delivery_methods_config.sql`:

```sql
-- Konfigurerbar leverings-konfiguration
INSERT OR REPLACE INTO settings (key, value, description) VALUES
('delivery_methods_json', '[
  {
    "key": "pickup",
    "label": "Afhentning",
    "is_self": true,
    "show_in_kitchen": true,
    "default_cost": 0,
    "default_price": 0
  },
  {
    "key": "bike",
    "label": "Cykel — Byekspressen",
    "courier_provider": "byekspressen",
    "show_in_kitchen": true,
    "default_cost": 100,
    "default_price": 154,
    "extra_box_cost": 50,
    "extra_box_price": 50,
    "max_boxes": 4,
    "max_distance_km": 8
  },
  {
    "key": "taxi",
    "label": "El-taxa",
    "courier_provider": "taxa",
    "show_in_kitchen": true,
    "default_cost": 136,
    "cost_per_km": 19,
    "zones": [
      {"postcodes": ["2300","2720","2730","2820"], "customer_price": 425},
      {"postcodes": ["2800","2600","2605","2625"], "customer_price": 575},
      {"postcodes": ["2620","2760","2770"],         "customer_price": 650}
    ]
  },
  {
    "key": "volvo",
    "label": "RR leverer (Volvo)",
    "courier_provider": "intern",
    "show_in_kitchen": true,
    "default_cost": 0
  },
  {
    "key": "volvo_ev",
    "label": "RR leverer (elbil)",
    "courier_provider": "intern",
    "show_in_kitchen": true,
    "default_cost": 0
  },
  {
    "key": "event_onsite",
    "label": "Food truck / on-site",
    "show_in_kitchen": true,
    "default_cost": 0
  }
]',
'Leveringsmetoder — kan udvides eller justeres uden kodeændring');
```

## 4.3 Datamodel-konsekvens

`bons.delivery_method` har i dag en CHECK-constraint:

```sql
delivery_method TEXT CHECK (delivery_method IN ('bike', 'taxi', 'volvo', 'pickup', NULL))
```

Når enum bliver konfigurerbart, skal CHECK enten fjernes eller udvides. Anbefaling: **drop CHECK på `delivery_method`** og overlad validering til application-layer (mod listen i settings). SQLite tillader ikke `ALTER TABLE … DROP CONSTRAINT`, så det kræver tabel-rekreation. Migration skal håndtere det:

```sql
-- 057_delivery_methods_config.sql (fortsat)

-- Drop CHECK på delivery_method ved at rekreere bons-tabellen
PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE bons_new (
    -- alle kolonner som bons, men UDEN CHECK på delivery_method:
    -- delivery_method TEXT,    (ingen CHECK)
    -- ... resten uændret
);

INSERT INTO bons_new SELECT * FROM bons;
DROP TABLE bons;
ALTER TABLE bons_new RENAME TO bons;
-- Genskab indexes

COMMIT;
PRAGMA foreign_keys = ON;
```

(Komplet kolonnedefinition skal kopieres fra eksisterende skema. Gem en kopi af `bons` før migration.)

## 4.4 Frontend-konsekvens

`tilbud.js` (og lignende steder hvor levering vælges) skal hente listen dynamisk:

```javascript
// shared/api.js
async function getDeliveryMethods() {
    const r = await apiFetch('/settings/delivery_methods_json');
    try { return JSON.parse(r.value); } catch { return []; }
}

// tilbud.js
let _tDeliveryMethods = [];

async function _tInit() {
    _tDeliveryMethods = await getDeliveryMethods();
    // ...
}

// Brug i UI:
function _tRenderDeliveryPicker() {
    return _tDeliveryMethods.map(m =>
        `<option value="${m.key}">${m.label}</option>`
    ).join('');
}
```

Frontend-state `_tDel.type` skal sættes til **samme værdi som `bon.delivery_method`** — fjern det separate enum-univers (`byx`/`taxa`/`rr`).

## 4.5 Backwards-kompatibilitet

Migrerede v1-bonner kan have `delivery_method` = NULL eller med gamle værdier. Så længe CHECK er fjernet, virker frontend ved at:
1. Vise `delivery_method`-feltet hvis det matcher en kendt key — ellers vise `delivery_method` rå tekst
2. Tillade brugeren at vælge en aktuel value når bon redigeres

`delivery_type`-feltet (`delivery`/`pickup`/`event`) bevares for backwards-kompatibilitet men frontend læser det ikke længere som primær kilde til "hvordan kommer maden ud".

---

# Del 5 — Filter på menu-picker for `x-Levering` (m. migration in mente)

## 5.1 Problemet

Når man i tilbuds-wizardens step 3 (Sammensæt) søger efter "Levering", dukker Grocy-recipes som "By-ekspressen leverer" og "Levering med El-Taxa" op. Tilføjes de som linjer, dobbelttælles de med `bons.delivery_price` der sættes i step 4.

## 5.2 Begrænsning

Vi må ikke fjerne `x-Levering`-recipes fra Grocy — Bon v1 bruger dem stadig, og migrerede v1-bonner har dem som `bon_lines`.

## 5.3 Løsning

Filtrér recipes med kategori `x-Levering` ud af menu-pickeren i `tilbud.js` (og evt. andre steder hvor mad-linjer vælges, fx ved `bon_drawer`).

I `office/views/tilbud.js` `_tLoadMenu()`:

```javascript
async function _tLoadMenu() {
    try {
        const recipes = await apiFetch('/grocy/recipes');
        _tMenu = {};
        for (const r of recipes) {
            // Skip leveringsopskrifter — håndteres via bons.delivery_method
            if (r.category === 'x-Levering') continue;

            const cat = r.category || 'Øvrige';
            if (!_tMenu[cat]) _tMenu[cat] = [];
            _tMenu[cat].push({ /* ... uændret ... */ });
        }
    } catch (e) { /* ... */ }
}
```

Samme filter overvejes for `shared/bon_drawer.js` hvis vare-pickeren der også går via Grocy-recipes.

## 5.4 Migration-migration: konvertér v1-bonners `x-Levering`-linjer til `delivery_*`-felter

For at få et rent datasæt skal migrerede v1-bonner have deres `x-Levering`-linjer flyttet fra `bon_lines` til `bons.delivery_method` + `delivery_price`. Ny migration `058_convert_xlevering_lines_to_delivery_fields.sql`:

```sql
-- Find alle bonner der har en x-Levering-linje OG ikke allerede har delivery_price sat
-- Mapping: Grocy-recipe-navn → delivery_method-key

BEGIN;

-- 1. Mapping-tabel midlertidigt (kun under migration)
CREATE TEMP TABLE xlevering_mapping (
    recipe_name_pattern TEXT,
    delivery_method TEXT,
    courier_provider TEXT
);

INSERT INTO xlevering_mapping VALUES
    ('By-ekspressen leverer',         'bike',     'byekspressen'),
    ('By-ekspressen - Langt væk',     'bike',     'byekspressen'),
    ('By-ekspressen - Meget Langt væk','bike',    'byekspressen'),
    ('Levering med El-Taxa',          'taxi',     'taxa'),
    ('RR leverer',                    'volvo',    'intern'),
    ('RR leverer (elbil HQ)',         'volvo_ev', 'intern');

-- 2. Find bonner med x-Levering-linjer der ikke har delivery_method sat
-- Tag den FØRSTE x-Levering-linje per bon (skulle kun være én)
UPDATE bons SET
    delivery_method = (
        SELECT m.delivery_method FROM bon_lines bl
        JOIN xlevering_mapping m ON bl.product_name LIKE m.recipe_name_pattern || '%'
        WHERE bl.bon_id = bons.id AND bl.category = 'x-Levering'
        LIMIT 1
    ),
    courier_provider = COALESCE(courier_provider, (
        SELECT m.courier_provider FROM bon_lines bl
        JOIN xlevering_mapping m ON bl.product_name LIKE m.recipe_name_pattern || '%'
        WHERE bl.bon_id = bons.id AND bl.category = 'x-Levering'
        LIMIT 1
    )),
    delivery_price = COALESCE(NULLIF(delivery_price, 0), (
        SELECT SUM(bl.line_total) FROM bon_lines bl
        WHERE bl.bon_id = bons.id AND bl.category = 'x-Levering'
    ))
WHERE EXISTS (
    SELECT 1 FROM bon_lines bl
    WHERE bl.bon_id = bons.id AND bl.category = 'x-Levering'
)
AND (delivery_method IS NULL OR delivery_method = '');

-- 3. Slet x-Levering-linjer (de er nu repræsenteret i delivery_*-felterne)
DELETE FROM bon_lines
WHERE category = 'x-Levering';

-- 4. Recalc total_price på alle berørte bonner
-- (forenklet — den eksisterende recalcTotal-helper kan kaldes pr. bon hvis migrationen
-- køres som JS-script i stedet for ren SQL)
UPDATE bons SET total_price = (
    SELECT COALESCE(SUM(bl.line_total), 0) + COALESCE(bons.delivery_price, 0)
    FROM bon_lines bl WHERE bl.bon_id = bons.id
)
WHERE 1=1;

COMMIT;
```

**Vigtigt:**
- Migrationen skal **køres EFTER** at alle v1-bonner er importeret. Den må ikke køre som standard-migration på en frisk database, men som engangs-data-migration. Læg den i en `db/data-migrations/`-mappe og kør manuelt: `node db/data-migrations/run.js 058`.
- Test først på `bon-v2.db` i `migrations/`-mappen (kopi).
- Backup `bon.db` før kørsel.

## 5.5 Alternativ light approach (hvis du ikke vil rede migration)

Behold `x-Levering`-linjer på migrerede bonner. Kun nye tilbud i v2 bruger `delivery_*`-felter. `recalcTotal()` skal så være smart:

```javascript
function recalcTotal(db, bonId) {
    const bon = db.prepare('SELECT delivery_price, offer_discount_percent FROM bons WHERE id = ?').get(bonId);
    const lines = db.prepare(`
        SELECT line_total, category FROM bon_lines WHERE bon_id = ?
    `).all(bonId);

    // Hvis der findes x-Levering-linjer, brug DEM som delivery — ignorér delivery_price
    const hasLeveringLine = lines.some(l => l.category === 'x-Levering');
    const linesSum = lines.reduce((s, l) => s + (l.line_total ?? 0), 0);
    const deliveryAdd = hasLeveringLine ? 0 : (bon.delivery_price ?? 0);

    const subtotal = linesSum + deliveryAdd;
    const discount = bon.offer_discount_percent ? subtotal * (bon.offer_discount_percent / 100) : 0;
    const total = Math.round((subtotal - discount) * 100) / 100;

    db.prepare('UPDATE bons SET total_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(total, bonId);
    return total;
}
```

Det er et lap, men det stopper dobbelttællingen øjeblikkeligt og giver tid til at planlægge den rigtige migration. Anbefaling: **brug 5.5 som hurtig fix nu, og 5.4 som planlagt rydningsmigration når der er tid**.

---

# Del 6 — Test og rollout

## 6.1 Testbonner

Find eller opret følgende fem cases i test-DB:

| # | Case | Forventet `total_incl_moms` |
|---|------|----------------------------:|
| 1 | T-5 (Foodtruck Kgl. Bibliotek) — 60 Fisken + 70 Frikadellen + 70 Kartoflen + 8 Servicepersonale, ingen levering | 23.650 kr |
| 2 | Tilbud med 10 % rabat på case 1 | 21.285 kr |
| 3 | Migreret v1-bon med `x-Levering`-linje "Levering med El-Taxa" (230 kr), `delivery_price = 0` | linjer + 230 kr |
| 4 | Nyt v2-tilbud med `delivery_method = 'taxi'`, `delivery_price = 250`, ingen `x-Levering`-linje | linjer + 250 kr |
| 5 | Korruption-case: både `x-Levering`-linje (230 kr) OG `delivery_price = 250 kr` | Skal IKKE dobbelttælles. Med `5.5`-fixen: linjer + 0 kr (linjen vinder). Med `5.4`-migration: kun én af dem er der efter migration |

## 6.2 Manuel testflow

1. Åbn hver bon i wizardens preview-step (5).
2. Sammenlign `Total inkl. moms` med forventet værdi.
3. Download PDF — sammenlign tallet med UI.
4. Genberegn ved at åbne, gemme uden ændringer, åbne igen — værdien skal være stabil.
5. For case 5: bekræft at dobbelttælling er løst (5.5) eller at migration er kørt (5.4).

## 6.3 Rollout-rækkefølge

1. **Del 0** — verificér prod-version (5 min)
2. **Del 1** — opdater de to MD-filer (10 min)
3. **Del 2** — deploy `tilbud.js`-fix (15 min, kræver Simon)
4. **Del 6.1–6.2** — verificér case 1, 2 på prod (10 min)
5. **Del 3** — backend moms-felter (1–2 timer, Simon)
6. **Del 5.5** — quick fix af `recalcTotal()` (30 min, Simon)
7. **Del 5.6** — opdatér nattligt sync-script så `x-Levering` mappes til `delivery_*`-felter ved import (1–2 timer, Simon)
8. **Del 6.1–6.2** — verificér case 3, 4, 5 (15 min)
9. **Del 4** — leverings-konsolidering (½ dag, Simon — kan vente til efter trin 1–8 er stabile)
10. **Del 5.4** — data-migration for resterende `x-Levering`-linjer i bon_lines. **Kan først køres EFTER Bon v1-shutdown** — ellers genimporteres linjerne ved næste nattlige sync. Engangsoperation.

Trin 1–7 fjerner pris-bug og dobbelttælling. Trin 8 verificerer. Trin 9–10 er rydning og kommer efter Bon v1 er lukket ned (hvilket er bundet op på køkkenets v2-overgang).

---

## Følgevirkninger

| Hvor | Hvad ændres |
|------|-------------|
| `office/views/tilbud.js` | Ny moms-matematik (Del 2), filter på menu-picker (Del 5.3), dynamisk leveringsenum (Del 4.4) |
| `routes/quotes.js` | `computeMomsFields` på alle responses (Del 3.2), evt. opdateret `recalcTotal` (Del 5.5) |
| `routes/bons.js` | `computeMomsFields` på alle responses (Del 3.3) |
| `db/helpers.js` | Ny `computeMomsFields`-funktion |
| `settings`-tabel | Ny `delivery_methods_json`-værdi (Del 4.2) |
| `bons`-skema | Drop CHECK på `delivery_method` (Del 4.3) — kræver tabel-rekreation |
| `bon_lines` data | Migration der flytter `x-Levering`-linjer (Del 5.4) — kun ved fuld rydning |
| `CLAUDE.md` | Ny regel om moms-håndtering |
| `BON_V2_PRINCIPPER.md` | Komplet moms-doktrin |

---

## Beslutninger (afklaret april 2026)

1. **Levering vises som linje i kunde-tilbuddet** — ja. Filteret i Del 5.3 fjerner kun `x-Levering`-recipes fra menu-pickeren. Den faktiske leveringslinje "🚚 Levering: …" rendres stadig i preview/PDF baseret på `delivery_method` + `delivery_price`.

2. **`bons.total_with_delivery` fjernes** — ja. Marker som deprecated nu, fjern når der ikke længere er læsere af feltet. Søg gennem kodebasen efter `total_with_delivery` før migration der dropper kolonnen.

3. **Rabat-placering** — bevares som ex-moms-beløb mellem `Subtotal (u/moms)` og `Moms (25%)`. Math er numerisk identisk uanset om rabatten regnes i incl- eller ex-moms-rummet, men **det viste rabatbeløb skal være konsistent med dets placering**. Justering til Del 2:

   ```javascript
   const dA       = sub * (_tDiscountPct / 100);    // rabat i incl-moms-rum (intern brug)
   const tot      = sub - dA;                        // total efter rabat (incl. moms)
   const subUMoms = tot / 1.25;                      // ex moms efter rabat
   const moms     = tot - subUMoms;                  // moms på reduceret beløb

   // VIST rabat-beløb (ex moms, så det er konsistent med placeringen mellem
   // Subtotal (u/moms) og Moms-linjen):
   const dA_excl  = (sub / 1.25) * (_tDiscountPct / 100);
   ```

   I render-koden bruges `_tFk(dA_excl)` som visningsværdi for rabat-linjen — IKKE `_tFk(dA)`. Tot- og moms-værdierne er uændret.

   **Note:** Rabat bruges sjældent. Det er primært relevant for kunder der videresælger produktet. Det skal stadig fungere korrekt i de få tilfælde det forekommer.

4. **5.5 først, 5.4 udskydes til efter Bon v1-shutdown** — Bon v1 kører stadig i køkkenet og data synces fra v1 til v2 hver nat. En data-migration der sletter `x-Levering`-linjer i v2 vil blive overskrevet ved næste nattlige sync så længe v1 leverer dem. Derfor:

   - **NU:** Del 5.5 (quick fix i `recalcTotal`) — uskadelig for sync, virker både på nattligt importerede og nyoprettede bonner.
   - **EFTER Bon v1-shutdown:** Del 5.4 (data-migration) som engangskørsel for at få et rent datasæt.

   Den nattlige sync skal også opdateres så den **ikke længere importerer `x-Levering`-linjer som `bon_lines`** — i stedet mappes de til `delivery_method` + `delivery_price` ved import. Det fjerner korruptionsrisikoen ved kilden. Tilføj som ekstra punkt i Del 5:

### 5.6 Sync-script opdateres til at mappe `x-Levering` ved import

Det nattlige sync-script (formentlig `db/sync_v1.js` eller lignende) skal ved import af hver v1-bon:

1. Detektere om den indkommende bon har en `x-Levering`-linje.
2. I så fald: udfyld `delivery_method`, `courier_provider` og `delivery_price` på v2-bonnen ud fra mapping-tabellen i Del 5.4 — og **indsæt IKKE linjen i `bon_lines`**.
3. Hvis bonnen ikke har `x-Levering`-linje: Lad `delivery_method` være NULL, importér linjer som normalt.

Pseudokode:

```javascript
const XLEVERING_MAP = {
    'By-ekspressen leverer':         { method: 'bike',     provider: 'byekspressen' },
    'By-ekspressen - Langt væk':     { method: 'bike',     provider: 'byekspressen' },
    'By-ekspressen - Meget Langt væk':{method: 'bike',     provider: 'byekspressen' },
    'Levering med El-Taxa':          { method: 'taxi',     provider: 'taxa' },
    'RR leverer':                    { method: 'volvo',    provider: 'intern' },
    'RR leverer (elbil HQ)':         { method: 'volvo_ev', provider: 'intern' },
};

function importV1Bon(v1Bon) {
    const v1Lines = v1Bon.lines;

    // Detektér x-Levering-linje
    const leveringLine = v1Lines.find(l => l.category === 'x-Levering');
    let deliveryMethod = null, courierProvider = null, deliveryPrice = 0;

    if (leveringLine) {
        const m = XLEVERING_MAP[leveringLine.product_name];
        if (m) {
            deliveryMethod   = m.method;
            courierProvider  = m.provider;
            deliveryPrice    = leveringLine.line_total;
        }
    }

    // Importér linjer EKSKL. x-Levering
    const filteredLines = v1Lines.filter(l => l.category !== 'x-Levering');

    // INSERT bon med delivery_*-felter
    // INSERT filteredLines (ingen x-Levering)
}
```

Når denne opdatering er live, vil **alle nye/synced bonner i v2 være rene** (intet dobbeltlag). Quick-fixen i 5.5 fungerer samtidig som sikkerhedsnet for de få bonner der allerede er fejlimporteret. Til sidst — efter v1-shutdown — ryddes resterne med 5.4.

---

## Justeringer efter kode-review (april 2026)

Disse punkter er fundet ved at læse den faktiske kodebase. De skal ind i implementeringen — specs ovenfor er suppleret, ikke erstattet.

### J1. `routes/bons.js` recalcer IKKE total — Del 3 dækker ikke almindelige bons

`routes/bons.js:155–183` skriver `total_price` og `total_with_delivery` direkte fra request-body. Der er **ingen** `recalcTotal()` der spejler `routes/quotes.js:43`. Det betyder at "backend som single source of truth" er punkteret for almindelige bons så længe klienten frit må sende et tal.

**Skal med i Del 3:** Tilføj en `recalcTotal()` (eller flyt den til `db/helpers.js` og genbrug) der kaldes efter:

- POST/PUT/DELETE `/api/bons/:id/lines` (linje-mutationer)
- PATCH `/api/bons/:id` når `delivery_price`, `offer_discount_percent` eller andre pris-relevante felter ændres
- Server skal **ignorere `total_price` og `total_with_delivery` fra request-body** og altid genberegne. Klienten får aldrig lov at diktere totalen.

Samme princip for `bon_lines.line_total` — backend skal altid sætte `line_total = quantity × unit_price` ved POST/PUT, aldrig stole på klientens værdi.

### J2. CHECK på `delivery_method` — udvid in-place i stedet for tabel-rekreation

Spec'ens Del 4.3 foreslår at rekreere hele `bons`-tabellen for at droppe CHECK. `bons` har FKs både ind (mange tabeller med `bon_id`) og ud (customer_id, address_id, status_id, payment_type m.fl.) plus indekser plus læses af views (CRM 360°). Tabel-rekreation er en hold-vejret-operation.

**Bedre fremgang:** udvid CHECK in-place i 057-migrationen til at inkludere de nye keys (`volvo_ev`, `event_onsite`):

```sql
-- 057_delivery_methods_config.sql
-- Erstat CHECK ved at rekreere KUN delivery_method-kolonnen, ikke hele bons
-- (SQLite tillader ikke ALTER TABLE … DROP CHECK, men udvidet enum er tilstrækkeligt)
```

Konsekvens: `delivery_methods_json` er stadig konfigurerbar, men keys i den skal matche CHECK-listen. Hvis nogen tilføjer en helt ny key i settings, skal de også køre en migration der udvider CHECK. Det er et lille teknisk loft men acceptabelt — leveringsmetoder ændres sjældent.

Alternativt hvis du absolut vil væk fra CHECK: brug `PRAGMA writable_schema=1; UPDATE sqlite_master ...` (hacky men én linje, kræver omhyggelig backup).

### J3. Sync-v1-fix MÅ deployes samtidig med 5.5

Hvis 5.5 (`recalcTotal`-fallback) deployes uden 5.6 (sync mapping) i samme commit eller samme deploy-vindue, vil den nattlige sync genimportere `x-Levering`-linjer som forurener nye bons inden næste fix.

**Hård rækkefølge:** 5.5 og 5.6 er ÉT skridt, ikke to.

### J4. `total_with_delivery` er ikke deprecated — den er primær læser

`shared/modal.js:501` bruger `bon.total_with_delivery` som **primær kilde** med `total_price + delivery_price` som fallback. "Marker som deprecated" er ikke nok — den læses aktivt.

**Konkret oprydning:**

1. Skift `shared/modal.js:501` til `total_incl_moms` (når API leverer det, jf. Del 3.2/3.3) eller `total_price` (med fallback for migrerede rækker)
2. Søg efter alle læsere: `grep -rn "total_with_delivery" --include="*.js"` — der er én primær læser nu, men efter Del 3 må der ingen være
3. Sæt feltet til samme værdi som `total_price` ved alle nye writes (eller drop kolonnen helt i en senere migration)

### J5. Verificér `cost_price` ex moms-antagelsen i data før låsning

Antagelsen er at `bon_lines.cost_price` er ex moms (jf. Grocy-konvention). Margin-beregningen i `shared/planning.js:616` afhænger af det. Hvis migrerede v1-rækker har incl-moms i `cost_price`, er hele dækningsbidragstabellen forkert.

**Skal valideres FØR Del 3 låser API-kontrakten:**

```sql
-- Spot-check: typisk sandwich har ratio salgspris/kostpris ~3-5×
-- Hvis cost_price er incl moms, vil ratio'en være systematisk lavere
SELECT
    bl.product_name,
    bl.unit_price                                AS salg_incl,
    bl.cost_price                                AS kost,
    ROUND(bl.unit_price / 1.25, 2)               AS salg_excl,
    ROUND((bl.unit_price/1.25) / NULLIF(bl.cost_price,0), 2) AS ratio_excl_basis
FROM bon_lines bl
WHERE bl.cost_price > 5 AND bl.unit_price > 50
ORDER BY ratio_excl_basis ASC
LIMIT 20;
```

Hvis ratio for kendte produkter ligger i 3–5× med ex-moms-basis, holder antagelsen. Hvis ratio er ~2.4–4× (= 3–5 × 0.8), er cost_price faktisk incl moms og hele audit'en skifter retning.

### J6. Frontend/backend skal dele moms-helper

Spec'ens Del 3.4 foreslår en `momsFromIncl(tot)` lokal helper i `tilbud.js`. Det fragmenterer logikken: én definition i `db/helpers.js` (Node), én i `tilbud.js`, og snart én i hver renderer.

**Bedre:** lav `shared/moms.js` der eksporterer både til Node og browser:

```javascript
// shared/moms.js
const MOMS_RATE   = 0.25;
const MOMS_FACTOR = 1 + MOMS_RATE;
function inclToExcl(incl) { return (incl ?? 0) / MOMS_FACTOR; }
function exclToIncl(excl) { return (excl ?? 0) * MOMS_FACTOR; }
function momsOfIncl(incl) { return (incl ?? 0) - (incl ?? 0) / MOMS_FACTOR; }
function computeMomsFields(incl) { /* som specs */ }

// Dual export — Node og browser
if (typeof module !== 'undefined') module.exports = { MOMS_RATE, MOMS_FACTOR, inclToExcl, exclToIncl, momsOfIncl, computeMomsFields };
if (typeof window !== 'undefined') window.Moms = { MOMS_RATE, MOMS_FACTOR, inclToExcl, exclToIncl, momsOfIncl, computeMomsFields };
```

`db/helpers.js` re-eksporterer fra `shared/moms.js`. Frontends loader `shared/moms.js` via `<script>` (eller dynamisk import). Én definition, ingen drift.

### J7. Changelog-spor når 5.5 ændrer total_price

Når quick fix'en aktiveres, vil bonner med dobbelttælling pludselig vise et lavere total. Brugeren der åbner en bon dagen efter har ingen forklaring.

**Anbefaling:** når `recalcTotal` ændrer `total_price` for en eksisterende bon med en delta > 1 kr, log en linje i `changelog`:

```javascript
logChange({ bon_id, action: 'recalc', field: 'total_price',
            old_value: oldTotal, new_value: newTotal,
            note: 'Auto-recalc efter pris/levering-fix' });
```

Det giver et spor uden at lave støj for normale operationer.

### J8. Rabat-koden bør bruge en helper, ikke to dA-værdier

Spec'ens Del 2 + beslutning #3 har:

```javascript
const dA       = sub * (_tDiscountPct / 100);            // intern
const dA_excl  = (sub / 1.25) * (_tDiscountPct / 100);   // vist
```

Math er korrekt (`dA_excl = dA / 1.25`), men to næsten-identiske udtryk i samme blok inviterer til fejl. Erstat med en helper:

```javascript
// shared/moms.js
function applyDiscount(subInclMoms, pctOfIncl) {
    const discountIncl = subInclMoms * pctOfIncl / 100;
    const discountExcl = discountIncl / MOMS_FACTOR;
    const totalIncl    = subInclMoms - discountIncl;
    return { discountIncl, discountExcl, totalIncl };
}

// I tilbud.js:
const { discountExcl, totalIncl } = applyDiscount(sub, _tDiscountPct);
const subUMoms = totalIncl / MOMS_FACTOR;
const moms     = totalIncl - subUMoms;
// _tFk(discountExcl) på rabat-linjen, _tFk(subUMoms / moms / totalIncl) på resten
```

### J9. Public tilbuds-link findes allerede

Audit Tier 1 #8 nævner public-link som "hvis kunden får et URL". `tools/tilbud-standalone-v2.html` findes allerede (jf. git-status). Den fil skal indgå i Tier 1-audit fra start, ikke som hypotese.

### J10. Andre `/ 1.25`-steder ud over tilbud

Kode-grep (lokal kodebase, april 2026):

| Fil | Linje | Kontekst |
|-----|-------|----------|
| `office/views/tilbud.js` | 1120, 1139, 1163, 1291, 1572 | Wizard + preview + PDF |
| `shared/modal.js` | 505 | `grand * 25 / 125` (ækvivalent med `/ 1.25`) i bon-info-modal |
| `shared/planning.js` | 614 | Planlægningsbon priser (faktura-format) |

Når `shared/moms.js` er på plads, skal alle tre filer migreres til at bruge `inclToExcl()` / `momsOfIncl()` så pre-commit-hook'en (CLAUDE_MOMS_AUDIT.md sektion 3) ikke fejler på dem.

---

*Slut på spec.*
