# CLAUDE_MENU_AGENT.md — Menu-agent (AI-forslag til bon-linjer)
> Læs CLAUDE.md, docs/bon_v2_datamodel_v2.md og **BON_V2_PRINCIPPER.md sektion 6b+6c** FØR du starter.
> Opdateret: marts 2026, moms-note tilføjet maj 2026

---

## MOMS-HÅNDTERING (kritisk fra dag 1)

Menu-agenten **må IKKE selv beregne eller udstille priser**. Den returnerer kun:
- `product_name` (fra Grocy-recipe)
- `quantity`
- `grocy_recipe_id`
- evt. `category` / `block_type`

**Priser sættes af serveren** når linjen indsættes via `POST /api/bons/:id/lines` —
serveren snapshot'er `unit_price` (incl moms) og `cost_price` (ex moms) fra Grocy.

Hvis agenten på sigt skal vise priser i preview-panelet:
- Brug `window.Moms.inclToExcl()` / `Moms.computeMomsFields()` — aldrig bart `* 1.25` eller `× 0.25`
- Følg de 7 visningsregler i `BON_V2_PRINCIPPER.md` sektion 6c
- Hvis preview viser "Total" → label skal være "Total inkl. moms" eller "(ex moms)"

Verifikations-tests i `tests/moms_audit_e2e.test.js` har en assertion (#28) der
forventer at agenten IKKE returnerer `unit_price` direkte — overhold det.

---

## Formål

En AI-agent der oversætter kundens fritekst-ønsker (eller bare pax + price_category)
til et konkret menu-forslag med bon-linjer og emballage.

Forslaget vises som et preview-panel — kontoret godkender, justerer eller afviser.
Godkendte linjer importeres til `bon_lines` via eksisterende `POST /api/bons/:id/lines`.

Agenten virker selv om der ingen særlige ønsker er — den laver et standard forslag
baseret på pax og price_category alene.

---

## Arkitektur

```
Frontend (drawer / bon-opret)
        ↓  POST /api/bons/:id/menu-suggestion
Backend (routes/menu_agent.js)
        ↓  Henter bon + Grocy-opskrifter
        ↓  Kalder Anthropic API med system-prompt + kontekst
        ↓  Parser JSON-svar
        ↓  Matcher Grocy-navne (eksakt match)
        ↓  Returnerer forslag + evt. unresolved-liste
Frontend
        ↓  Viser preview-panel
        ↓  Kontoret godkender/justerer
        ↓  POST /api/bons/:id/lines for hver linje (eksisterende endpoint)
```

API-nøgle til Anthropic ligger i `.env` — aldrig i frontend.

---

## .env

```
ANTHROPIC_API_KEY=
MENU_AGENT_MODEL=claude-sonnet-4-5
```

---

## npm-pakker

```
@anthropic-ai/sdk
```

Kræver godkendelse.

---

## routes/menu_agent.js

### POST /api/bons/:id/menu-suggestion

Kræver auth (office + admin).

**Hvad den gør:**

1. Hent bon via `getBon(id)` — henter `pax`, `price_category`, `notes`, `kitchen_info`,
   `customer_notes` (alle tekstfelter der kan indeholde kundens ønsker)
2. Hent Grocy-opskrifter via `grocyAdapter.getRecipes()` — kun `sellable = 1`
   Byg produktkatalog: `{ name, category, prices, unit }`
3. Byg system-prompt (se nedenfor)
4. Kald Anthropic API med kontekst-besked
5. Parser JSON-svar
6. Eksakt Grocy-match på `name` for hver linje
7. Returnér forslag

**Request body:** ingen (alt hentes fra bon)

**Response:**

```json
{
  "suggestion": {
    "lines": [
      {
        "grocy_recipe_id": 42,
        "product_name": "Kyllingen",
        "category": "01 Sandwich",
        "quantity": 60,
        "unit": "stk",
        "unit_price": 94,
        "cost_price": 23.55,
        "co2e": 0.42,
        "remarks": ""
      },
      {
        "grocy_recipe_id": null,
        "product_name": "RR Boks",
        "category": "06 Emballage",
        "quantity": 60,
        "unit": "stk",
        "unit_price": 0,
        "cost_price": 0,
        "co2e": 0,
        "remarks": "Emballage"
      }
    ],
    "totals": {
      "sandwiches": 60,
      "sliders": 0,
      "RR_bokse": 60,
      "transportkasser": 4
    },
    "unresolved": [],
    "agent_notes": "Standard frokostmenu til 60 pax med 1/3 vegetar."
  }
}
```

**`unresolved`** — liste over produktnavne agenten foreslog men som ikke findes i Grocy:

```json
"unresolved": [
  {
    "suggested_name": "Hummus sandwich",
    "category": "01 Sandwich",
    "quantity": 10,
    "reason": "Navn ikke fundet i Grocy — mulig stavefejl eller udgået vare"
  }
]
```

Disse vises i UI'et som gule advarsler — kontoret vælger manuelt hvad de skal erstattes med.

**Emballage-linjer:**
Beregnes i backend efter reglerne fra systemdokumentet — ikke af agenten.
Agenten returnerer kun mad-linjer. Backend tilføjer emballage til `suggestion.lines`
efter agentens svar er parset.

Grocy-match på emballage: RR Boks, Sliderboks, Receptionsskinne, Transportkasse
skal eksistere som Grocy-produkter (ikke opskrifter) — eller som hardcodede emballage-linjer
uden `grocy_recipe_id`.

---

## System-prompt til agenten

Gemmes som `services/menuAgentPrompt.js` — eksporterer en funktion der returnerer
den færdige system-prompt med det aktuelle produktkatalog injiceret.

Basis-prompten gemmes som `services/menuAgentPromptBase.txt` — en manuelt redigeret
version af `Regler_for_automatisk_menu-sammensætning.md` hvor følgende er fjernet:

| Fjernet | Grund |
|---------|-------|
| Sektion 8 — produkttabellen | Erstattes af dynamisk Grocy-katalog |
| Sektion 7 — logistikberegningseksempel + emballage i totals | Backend beregner emballage |
| Sektion 9 — output-eksempel | Erstattes af vores JSON-format nedenfor |

Derudover tilføjes øverst i basis-prompten:
```
VIGTIGT: Beregn og inkludér IKKE emballage (RR Boks, Sliderboks,
Transportkasse, Receptionsskinner) i dit output.
Emballage beregnes automatisk af systemet bagefter.
```

```javascript
const fs = require('fs');
const promptBase = fs.readFileSync(
    path.join(__dirname, 'menuAgentPromptBase.txt'), 'utf8'
);

function buildSystemPrompt(productCatalog) {
    return `
${promptBase}

PRODUKTKATALOG (kun disse varer må bruges — hentet live fra Grocy):
${JSON.stringify(productCatalog, null, 2)}

OUTPUT-FORMAT:
Returnér KUN valid JSON. Ingen markdown. Ingen øvrig tekst.

{
  "lines": [
    {
      "name": "<eksakt navn fra produktkatalog>",
      "category": "<kategori fra produktkatalog>",
      "quantity": <heltal>,
      "diet": ["vegetar","vegansk","halal-ok","pescatar","glutenfri"],
      "remarks": "<valgfri tekst, fx 'uden løg' eller 'glutenfri'>"
    }
  ],
  "totals": {
    "sandwiches": <heltal>,
    "sliders": <heltal>
  },
  "agent_notes": "<kort forklaring af valg>"
}
`;
}
```

**Kontekst-besked (user-turn) bygges dynamisk:**

```javascript
function buildUserMessage(bon, productCatalog) {
    return `
Lav et menu-forslag til følgende ordre:

Antal pax: ${bon.pax || 'ukendt'}
Priskategori: ${bon.price_category_code}
${bon.notes ? `Kundens ønsker: ${bon.notes}` : 'Ingen særlige ønsker — lav standard forslag.'}
${bon.kitchen_info ? `Køkken-info: ${bon.kitchen_info}` : ''}
`;
}
```

---

## Emballage-beregning (backend)

Efter agentens svar er parset, beregner backend emballage og tilføjer til linjerne.
Logik fra systemdokumentet implementeret som ren funktion `calculatePackaging(lines)`:

```javascript
function calculatePackaging(lines) {
    const sandwiches = lines
        .filter(l => l.category === '01 Sandwich')
        .reduce((sum, l) => sum + l.quantity, 0);

    const sliders = lines
        .filter(l => l.category === '04 Slider')
        .reduce((sum, l) => sum + l.quantity, 0);

    const rrBokse = sandwiches; // 1 RR boks per sandwich
    const sliderbokse = Math.ceil(sliders / 3); // 3 sliders per boks
    const transportkasser = Math.ceil(rrBokse / 17) + Math.ceil(sliderbokse / 10);

    return {
        lines: [
            rrBokse > 0 && { product_name: 'RR Boks', category: '06 Emballage', quantity: rrBokse, unit: 'stk' },
            sliderbokse > 0 && { product_name: 'Sliderboks', category: '06 Emballage', quantity: sliderbokse, unit: 'stk' },
            transportkasser > 0 && { product_name: 'Transportkasse', category: '06 Emballage', quantity: transportkasser, unit: 'stk' },
        ].filter(Boolean),
        totals: { sandwiches, sliders, rrBokse, sliderbokse, transportkasser }
    };
}
```

---

## Frontend — preview-panel

Vises i:
- `shared/bon_drawer.js` — knap i VARER-sektionen
- `shared/bon_opret_modal.js` — knap efter oprettelse (step 2)

### Knap

```
[🤖 Foreslå menu]
```

Vises altid når `pax > 0`. Grayed out hvis bon allerede har linjer
(med confirm: "Bon har allerede linjer — erstat eller tilføj?").

### Preview-panel (inline i drawer under VARER)

```
┌─────────────────────────────────────────────────────┐
│ 🤖 Foreslået menu              [✕ Afvis forslag]   │
│                                                     │
│  60 × Kyllingen          (01 Sandwich)   94 kr      │
│  35 × Falaflen           (01 Sandwich)   94 kr      │
│  25 × Frikadellen        (01 Sandwich)   94 kr      │
│  60 × RR Boks            (06 Emballage)   0 kr      │
│   4 × Transportkasse     (06 Emballage)   0 kr      │
│                                                     │
│  Agent: Standard frokostmenu til 60 pax             │
│         med ca. 1/3 vegetar.                        │
│                                                     │
│  ⚠ Ikke fundet i Grocy: "Hummus sandwich" (10 stk) │
│    Erstat med: [Falaflen ▾]  [Tilføj manuelt]      │
│                                                     │
│  [✓ Importer alle linjer]  [Rediger før import]    │
└─────────────────────────────────────────────────────┘
```

**Loading-state:** Spinner + "Genererer forslag..." mens API-kald kører (~3-8 sek).

**Unresolved-håndtering:** Hver uløst vare vises med en dropdown over kendte Grocy-varer
i samme kategori. Kontoret vælger erstatning inden import — eller trykker "Tilføj manuelt"
for at springe den over.

**"Importer alle linjer":** Kalder `POST /api/bons/:id/lines` for hver linje i forslaget
(inkl. emballage). Bruger eksisterende endpoint og snapshot-logik.

**"Rediger før import":** Åbner en redigerbar tabel over linjerne (quantity kan justeres)
inden import.

---

## shared/api.js — ny funktion

```javascript
async function getMenuSuggestion(bonId) {
    const res = await fetch(`/api/bons/${bonId}/menu-suggestion`, { method: 'POST' });
    return res.json();
}
```

---

## server.js — mount

```javascript
const menuAgent = require('./routes/menu_agent');
app.use('/api/bons', menuAgent); // POST /:id/menu-suggestion
```

---

## Rækkefølge

1. `.env` — tilføj `ANTHROPIC_API_KEY` + `MENU_AGENT_MODEL`
2. `npm install @anthropic-ai/sdk`
3. `services/menuAgentPrompt.js` — system-prompt builder
4. `routes/menu_agent.js` — endpoint, Anthropic-kald, Grocy-match, emballage-beregning
5. `shared/api.js` — `getMenuSuggestion()`
6. Preview-panel i `shared/bon_drawer.js`
7. Preview-panel i `shared/bon_opret_modal.js`

---

## Test-kommandoer

```bash
# Standard forslag (ingen ønsker)
curl -s -X POST http://localhost:4321/api/bons/1/menu-suggestion \
  -H "Content-Type: application/json" | jq

# Tjek at unresolved håndteres
# Sæt notes på bon til "vi vil gerne have hummus sandwich"
# og kør forslaget igen — agent_notes + unresolved skal udfyldes
```

---

## Åbne punkter

| Punkt | Status |
|-------|--------|
| `ANTHROPIC_API_KEY` i `.env` | ⏳ Simon tilføjer |
| Emballagevarer i Grocy (RR Boks, Sliderboks, Transportkasse) | ⏳ Skal oprettes som produkter i Grocy hvis de ikke findes |
| Systemdokument-justeringer | Prompt bruger dokumentet som-er — kan finjusteres efter første tests |
| Receptionsskinner | Beregnes ikke i første version (sjælden pakkeform) — tilføjes ved behov |
