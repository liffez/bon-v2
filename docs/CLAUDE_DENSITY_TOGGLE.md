# CLAUDE_DENSITY_TOGGLE.md
*Per-device visningstæthed for Bon v2*

---

## Formål

Bon-kortet er for stort på små skærme (fx ThinkPad L14 G2, 1920×1080 @ 125% Windows-skala ≈ 1536×864 logisk viewport). Linjer afkortes i Senere-view fordi `.bon-card` har fast `width: 360px` og store font-sizes (`.unit-primary: 38px`, `.bon-menu-item: 18px`).

Vi indfører en density-indstilling der:
- Gemmes **per device** i `localStorage` (IKKE i `system_settings` server-side)
- Sættes via en ny **"Denne enhed"**-sektion i settings-zonen
- Er tilgængelig for **alle roller** (også `kok`)
- Påvirker `zone-kitchen` og `zone-office` (samt settings/logistik som lever inden for disse). `zone-mobile` er bevidst ekskluderet — mobil har sin egen touch-først CSS.

---

## Konceptuel placering

Settings-zonen får en ny sektion **"Denne enhed"** der adskiller sig fra de eksisterende settings-sektioner:

| | Eksisterende settings | Denne enhed (ny) |
|---|---|---|
| Storage | `system_settings` tabel | `localStorage` |
| Scope | Hele installationen | Kun denne browser |
| Adgang | Admin | Alle roller |

Sektionen er forberedt til at vokse over tid (kiosk-default, auto-refresh, foretrukken startside), men runde 1 indeholder kun **Tæthed**.

**Vigtig struktur-detalje:** Settings er **én SPA** (`settings/index.html`) med sektioner switched via `data-section`-knapper i `<nav class="st-sidebar">`. Der findes ikke separate HTML-filer per settings-område. "Denne enhed" tilføjes derfor som **en ny sektion i samme fil**, ikke som en ny HTML-fil.

---

## Tre modes

| Mode | Body-klasse | Skala | Anbefalet til |
|---|---|---|---|
| Komfort | `density-comfort` | 1.00 | Default. MacBook, store skærme |
| Kompakt | `density-compact` | ≈0.88 | ThinkPad L14, 14" laptops |
| Tæt | `density-dense` | ≈0.78 | Hvis kompakt ikke rækker |

Touch-targets:
- I `zone-kitchen` forbliver alle interaktive knapper ≥ 36px selv i Tæt (lavere end designsystemets `--touch-target-min: 44px`, men stadig brugbart med finger på laptop-touchscreen).
- I `zone-office` accepteres ≥ 28px (mus/trackpad).
- Hvis behov for en kitchen-tablet i Tæt-mode opstår, kan vi senere klemme en advarsel ind eller hindre kombinationen — ikke i runde 1.

---

## Auto-detect ved første besøg

Hvis brugeren aldrig har valgt en mode (`localStorage` mangler nøglen), vælger `Density.init()` en passende default:

- `innerWidth <= 1366` → `compact`
- ellers → `comfort`

Når brugeren senere eksplicit vælger noget i settings, gemmes valget i localStorage og auto-detect spilles ikke ind længere. Det betyder at ThinkPads får en fornuftig start uden manuel konfiguration, mens MacBook-brugere ikke mærker noget.

---

## Scope — hvad får density-overrides i runde 1

Spec'en dækker IKKE kun bon-kort. Følgende komponenter får density-overrides i runde 1 fordi de alle har hardcodede font-sizes og bruges på de samme små skærme:

| Komponent | CSS-fil | Hvorfor |
|---|---|---|
| Bon-kort | `shared/bon_kort.css` | Primær årsag — Senere-view |
| Bon-drawer | `shared/bon_drawer.css` | Åbnes i office og kitchen — bon-redigering |
| Modal | `shared/modal.css` | Info / Råvarer / Historik |
| VarePicker | `shared/vare_picker.css` | Inline picker på bon-kort |
| Kalender | `shared/calendar.css` | Tæt grid, kritisk på lille skærm |
| Indkøbsliste | `shared/indkob.css` | Mange linjer per side |

**Udenfor scope (runde 2):** Dashboard, fakturering, rapporter, CRM, planning, tilbud, stock_overview, recipes. Mekanikken er klar — overrides tilføjes ad hoc når brugeren melder at en bestemt side er for stor.

**Bevidst ekskluderet permanent:** `zone-mobile` (egen CSS, allerede touch-først).

---

## Filer der ændres / oprettes

### 1. Ny fil: `shared/density.js`

```js
/**
 * shared/density.js
 * ════════════════════════════════════════════════════════════
 * Per-device visningstæthed. Gemmes i localStorage, gælder
 * zone-kitchen og zone-office (mobile er ekskluderet).
 * Skal initialiseres FØR første render via Density.init().
 * ════════════════════════════════════════════════════════════
 */

const STORAGE_KEY = 'bon_v2_density';
const VALID_MODES = ['comfort', 'compact', 'dense'];
const DEFAULT_MODE = 'comfort';
const AUTO_COMPACT_BREAKPOINT = 1366;

const Density = {
    init() {
        const stored = localStorage.getItem(STORAGE_KEY);
        let mode;
        if (VALID_MODES.includes(stored)) {
            mode = stored;
        } else {
            // Auto-detect: smal skærm → compact, ellers comfort
            mode = (window.innerWidth <= AUTO_COMPACT_BREAKPOINT) ? 'compact' : DEFAULT_MODE;
            // Gem ikke — så brugerens første eksplicitte valg vinder
        }
        this._applyToBody(mode);
    },

    set(mode) {
        if (!VALID_MODES.includes(mode)) return;
        localStorage.setItem(STORAGE_KEY, mode);
        this._applyToBody(mode);
        document.dispatchEvent(new CustomEvent('density:change', { detail: { mode } }));
    },

    reset() {
        localStorage.removeItem(STORAGE_KEY);
        this.init();
        document.dispatchEvent(new CustomEvent('density:change', { detail: { mode: this.current() } }));
    },

    current() {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (VALID_MODES.includes(stored)) return stored;
        return (window.innerWidth <= AUTO_COMPACT_BREAKPOINT) ? 'compact' : DEFAULT_MODE;
    },

    hasExplicitChoice() {
        return VALID_MODES.includes(localStorage.getItem(STORAGE_KEY));
    },

    _applyToBody(mode) {
        const body = document.body;
        VALID_MODES.forEach(m => body.classList.remove(`density-${m}`));
        body.classList.add(`density-${mode}`);
    }
};

window.Density = Density;
```

### 2. Ny fil: `shared/density.css`

Loades EFTER `bon_kort.css`, `bon_drawer.css`, `modal.css`, `vare_picker.css`, `calendar.css`, `indkob.css`. Comfort er default — ingen overrides nødvendige.

Reglerne er scoped til `body.density-X:not(.zone-mobile)` så mobile-zonen aldrig påvirkes.

```css
/**
 * shared/density.css
 * ════════════════════════════════════════════════════════════
 * Density overrides. Alle regler er body.density-X for at gælde
 * begge zoner og være zone-neutrale. Mobile-zonen er ekskluderet.
 * Touch-targets i kitchen forbliver ≥ 36px.
 * ════════════════════════════════════════════════════════════
 */

/* ═══════════════════════════════════════════════════════════ */
/* COMPACT (≈0.88)                                              */
/* ═══════════════════════════════════════════════════════════ */

/* — Bon-kort — */
body.density-compact:not(.zone-mobile) .bon-card        { width: 320px; }
body.density-compact:not(.zone-mobile) .bon-id          { font-size: 22px; }
body.density-compact:not(.zone-mobile) .bon-pickup      { font-size: 24px; }
body.density-compact:not(.zone-mobile) .bon-lev         { font-size: 13px; }
body.density-compact:not(.zone-mobile) .bon-date        { font-size: 12px; }
body.density-compact:not(.zone-mobile) .unit-primary    { font-size: 30px; }
body.density-compact:not(.zone-mobile) .unit-primary-label { font-size: 10px; }
body.density-compact:not(.zone-mobile) .unit-secondary  { font-size: 12px; }

body.density-compact:not(.zone-mobile) .bon-header      { padding: 10px 12px 8px 18px; }
body.density-compact:not(.zone-mobile) .bon-customer    { padding: 8px 12px 8px 18px; }
body.density-compact:not(.zone-mobile) .bon-customer-details { padding: 6px 12px 8px 18px; }
body.density-compact:not(.zone-mobile) .bon-prep        { padding: 8px 12px 8px 18px; }
body.density-compact:not(.zone-mobile) .bon-alert       { padding: 6px 12px 6px 18px; font-size: 12px; }
body.density-compact:not(.zone-mobile) .bon-actions     { padding: 8px 10px; }

body.density-compact:not(.zone-mobile) .bon-menu-item   { font-size: 16px; padding: 5px 12px 5px 18px; }
body.density-compact:not(.zone-mobile) .bon-menu-group  { margin: 5px 12px 5px 18px; }
body.density-compact:not(.zone-mobile) .bon-menu-group .bon-menu-item { font-size: 15px; padding: 5px 8px; }
body.density-compact:not(.zone-mobile) .bon-menu-qty    { min-width: 44px; }

body.density-compact:not(.zone-mobile) .action-btn      { width: 36px; height: 36px; }
body.density-compact:not(.zone-mobile) .action-btn svg  { width: 18px; height: 18px; }
body.density-compact:not(.zone-mobile) .select-toggle-btn { width: 36px; height: 36px; }

body.density-compact:not(.zone-mobile) .sbar-btn        { padding: 9px 5px; font-size: 11px; }
body.density-compact:not(.zone-mobile) .kstatus-btn     { padding: 11px 6px; font-size: 12px; }
body.density-compact:not(.zone-mobile) .prep-badge      { padding: 5px 12px; font-size: 12px; }

/* — Bon-drawer — */
body.density-compact:not(.zone-mobile) .bd-drawer       { width: min(720px, 100vw); }
body.density-compact:not(.zone-mobile) .bd-header h2    { font-size: 18px; }
body.density-compact:not(.zone-mobile) .bd-section h3   { font-size: 13px; }
body.density-compact:not(.zone-mobile) .bd-label        { font-size: 12px; }
body.density-compact:not(.zone-mobile) .bd-input,
body.density-compact:not(.zone-mobile) .bd-select,
body.density-compact:not(.zone-mobile) .bd-textarea     { font-size: 13px; padding: 7px 9px; }

/* — Modal — */
body.density-compact:not(.zone-mobile) .modal-content   { max-width: 720px; }
body.density-compact:not(.zone-mobile) .modal-header h2 { font-size: 18px; }
body.density-compact:not(.zone-mobile) .modal-body      { font-size: 13px; }

/* — VarePicker — */
body.density-compact:not(.zone-mobile) .vp-row         { font-size: 14px; padding: 5px 10px; }
body.density-compact:not(.zone-mobile) .vp-cat-tab     { font-size: 12px; padding: 5px 10px; }
body.density-compact:not(.zone-mobile) .vp-price       { font-size: 12px; }

/* — Kalender — */
body.density-compact:not(.zone-mobile) .cal-day        { min-height: 88px; padding: 4px 6px; }
body.density-compact:not(.zone-mobile) .cal-day-num    { font-size: 12px; }
body.density-compact:not(.zone-mobile) .cal-bon-pill   { font-size: 11px; padding: 2px 5px; }

/* — Indkøb — */
body.density-compact:not(.zone-mobile) .ib-row         { font-size: 13px; padding: 6px 10px; }
body.density-compact:not(.zone-mobile) .ib-product     { font-size: 14px; }
body.density-compact:not(.zone-mobile) .ib-chip        { font-size: 11px; padding: 2px 7px; }


/* ═══════════════════════════════════════════════════════════ */
/* DENSE (≈0.78)                                                */
/* ═══════════════════════════════════════════════════════════ */

/* — Bon-kort — */
body.density-dense:not(.zone-mobile) .bon-card          { width: 290px; }
body.density-dense:not(.zone-mobile) .bon-id            { font-size: 19px; }
body.density-dense:not(.zone-mobile) .bon-pickup        { font-size: 20px; }
body.density-dense:not(.zone-mobile) .bon-lev           { font-size: 12px; }
body.density-dense:not(.zone-mobile) .bon-date          { font-size: 11px; }
body.density-dense:not(.zone-mobile) .unit-primary      { font-size: 25px; }
body.density-dense:not(.zone-mobile) .unit-primary-label { font-size: 9px; }
body.density-dense:not(.zone-mobile) .unit-secondary    { font-size: 11px; }

body.density-dense:not(.zone-mobile) .bon-header        { padding: 8px 10px 6px 14px; }
body.density-dense:not(.zone-mobile) .bon-customer      { padding: 6px 10px 6px 14px; }
body.density-dense:not(.zone-mobile) .bon-customer-details { padding: 4px 10px 6px 14px; }
body.density-dense:not(.zone-mobile) .bon-prep          { padding: 6px 10px 6px 14px; }
body.density-dense:not(.zone-mobile) .bon-alert         { padding: 5px 10px 5px 14px; font-size: 11px; }
body.density-dense:not(.zone-mobile) .bon-actions       { padding: 6px 8px; }

body.density-dense:not(.zone-mobile) .bon-menu-item     { font-size: 14px; padding: 4px 10px 4px 14px; }
body.density-dense:not(.zone-mobile) .bon-menu-group    { margin: 4px 10px 4px 14px; }
body.density-dense:not(.zone-mobile) .bon-menu-group .bon-menu-item { font-size: 13px; padding: 4px 6px; }
body.density-dense:not(.zone-mobile) .bon-menu-qty      { min-width: 38px; }

body.density-dense:not(.zone-mobile) .action-btn        { width: 32px; height: 32px; }
body.density-dense:not(.zone-mobile) .action-btn svg    { width: 16px; height: 16px; }
body.density-dense:not(.zone-mobile) .select-toggle-btn { width: 32px; height: 32px; }

body.density-dense:not(.zone-mobile) .sbar-btn          { padding: 7px 4px; font-size: 10px; }
body.density-dense:not(.zone-mobile) .kstatus-btn       { padding: 9px 5px; font-size: 11px; }
body.density-dense:not(.zone-mobile) .prep-badge        { padding: 4px 10px; font-size: 11px; }

/* — Bon-drawer — */
body.density-dense:not(.zone-mobile) .bd-drawer         { width: min(640px, 100vw); }
body.density-dense:not(.zone-mobile) .bd-header h2      { font-size: 16px; }
body.density-dense:not(.zone-mobile) .bd-section h3     { font-size: 12px; }
body.density-dense:not(.zone-mobile) .bd-label          { font-size: 11px; }
body.density-dense:not(.zone-mobile) .bd-input,
body.density-dense:not(.zone-mobile) .bd-select,
body.density-dense:not(.zone-mobile) .bd-textarea       { font-size: 12px; padding: 6px 8px; }

/* — Modal — */
body.density-dense:not(.zone-mobile) .modal-content     { max-width: 640px; }
body.density-dense:not(.zone-mobile) .modal-header h2   { font-size: 16px; }
body.density-dense:not(.zone-mobile) .modal-body        { font-size: 12px; }

/* — VarePicker — */
body.density-dense:not(.zone-mobile) .vp-row           { font-size: 13px; padding: 4px 8px; }
body.density-dense:not(.zone-mobile) .vp-cat-tab       { font-size: 11px; padding: 4px 8px; }
body.density-dense:not(.zone-mobile) .vp-price         { font-size: 11px; }

/* — Kalender — */
body.density-dense:not(.zone-mobile) .cal-day          { min-height: 72px; padding: 3px 5px; }
body.density-dense:not(.zone-mobile) .cal-day-num      { font-size: 11px; }
body.density-dense:not(.zone-mobile) .cal-bon-pill     { font-size: 10px; padding: 1px 4px; }

/* — Indkøb — */
body.density-dense:not(.zone-mobile) .ib-row           { font-size: 12px; padding: 5px 8px; }
body.density-dense:not(.zone-mobile) .ib-product       { font-size: 13px; }
body.density-dense:not(.zone-mobile) .ib-chip          { font-size: 10px; padding: 2px 6px; }
```

> **Note for udvider:** Når en ny komponent har for små/store font-sizes på små skærme, tilføjes overrides til denne fil under den relevante komponent-overskrift. Find class-navne ved at åbne komponentens CSS-fil og kig efter hardcodede `font-size:`-værdier.

### 3. Ændret: alle HTML-shells (undtagen `mobile/`)

I `kitchen/*.html`, `office/index.html`, `settings/*.html`, `tools/*.html` — tilføj efter de eksisterende stylesheet-links:

```html
<link rel="stylesheet" href="/shared/density.css">
```

…og før view-scripts (efter `<body>` eller umiddelbart før de funktionelle scripts):

```html
<script src="/shared/density.js"></script>
<script>Density.init();</script>
```

`mobile/index.html` og `mobile/login.html` skal IKKE have density-imports.

**Kritisk:** `Density.init()` skal køre før kort renderes, ellers blinker UI'et fra default → korrekt mode ved hver page load. Det er synkront (kun localStorage + body-classList) så det blokerer reelt ikke.

### 4. Ændret: `settings/index.html` — ny sektion

I `<nav class="st-sidebar">` indsættes et nyt punkt ØVERST (over alle eksisterende, så det er let at finde for ikke-admins):

```html
<button class="st-nav-item" data-section="this-device">Denne enhed</button>
<div class="st-nav-sep"></div>
<button class="st-nav-item active" data-section="users">Brugere</button>
<!-- ...resten uændret... -->
```

I `<div class="st-content">` tilføjes en ny sektion (placeres øverst, før `sec-users`):

```html
<div class="st-section" id="sec-this-device">
  <h2>Denne enhed</h2>
  <div class="device-info-banner">
    💡 Indstillingerne på denne side gemmes kun på denne browser/enhed.
    De gælder for alle brugere der logger ind her, men ikke når du logger
    ind fra en anden computer.
  </div>

  <section class="st-form-section">
    <h3>Tæthed</h3>
    <p class="st-desc">
      Juster hvor meget plads bon-kort og UI fylder.
      Vælg en mindre tæthed hvis hele bonnen ikke kan vises på skærmen.
    </p>

    <div class="density-options">
      <label class="density-option">
        <input type="radio" name="density" value="comfort">
        <div class="density-option-body">
          <div class="density-option-title">Komfort</div>
          <div class="density-option-desc">Anbefales til store skærme og MacBook.</div>
        </div>
      </label>

      <label class="density-option">
        <input type="radio" name="density" value="compact">
        <div class="density-option-body">
          <div class="density-option-title">Kompakt</div>
          <div class="density-option-desc">Anbefales til 14"-laptops (ThinkPad L14 osv.).</div>
        </div>
      </label>

      <label class="density-option">
        <input type="radio" name="density" value="dense">
        <div class="density-option-body">
          <div class="density-option-title">Tæt</div>
          <div class="density-option-desc">Kun hvis Kompakt ikke giver nok plads.</div>
        </div>
      </label>
    </div>

    <button class="st-btn st-btn-secondary" id="resetDensity" style="margin-top:12px;">
      Nulstil til standard
    </button>
  </section>

  <section class="st-form-section">
    <h3>Preview</h3>
    <p class="st-desc">Eksempel på bon-kort med den valgte tæthed.</p>
    <div id="density-preview-host"></div>
  </section>
</div>
```

**Preview-strategi:** Brug `BonKortBuilder.createCard(fakeData, 'kitchen-today')` til at rendere et rigtigt bon-kort med dummy-data. Det sikrer at preview altid følger den faktiske komponent — ingen drift fra statisk HTML.

Eksempel på dummy-data (placeres som JS i scripts-blokken):

```js
const DEMO_BON = {
  id: 9999,
  bon_number: 'cafe-9999',
  status_code: 'IGANG',
  customer_name: 'Eksempel Kunde A/S',
  delivery_address: 'Demovej 1, 2920 Charlottenlund',
  pickup_time: '10:00',
  delivery_time: '10:00',
  delivery_date: '2026-05-19',
  delivery_type: 'pickup',
  total_units: 42,
  pax: 8,
  lines: [
    { id: 1, product_name: 'Falaflen', quantity: 5, unit: 'stk', unit_price: 94 },
    { id: 2, product_name: '"Tunen"',  quantity: 10, unit: 'stk', unit_price: 94 },
    { id: 3, product_name: 'Frikadellen', quantity: 8, unit: 'stk', unit_price: 94 },
  ],
};
```

Sektionens script-logik:

```js
function initThisDeviceSection() {
  const current = Density.current();
  document.querySelector(`input[name="density"][value="${current}"]`).checked = true;

  document.querySelectorAll('input[name="density"]').forEach(radio => {
    radio.addEventListener('change', e => {
      if (e.target.checked) Density.set(e.target.value);
    });
  });

  document.getElementById('resetDensity').addEventListener('click', () => {
    Density.reset();
    const newMode = Density.current();
    document.querySelector(`input[name="density"][value="${newMode}"]`).checked = true;
  });

  // Render dummy bon-kort
  const host = document.getElementById('density-preview-host');
  host.innerHTML = '';
  const card = BonKortBuilder.createCard(
    Utils.mapApiBonToCardData(DEMO_BON),
    'kitchen-today'
  );
  host.appendChild(card);
}
```

Sektionen registreres i settings' eksisterende sektionsskifter, men:
- Den er synlig for **alle roller** (ingen `st-admin-only` klasse).
- `initThisDeviceSection()` kaldes når sektionen aktiveres (lazy init), så `BonKortBuilder` ikke skal være loadet før den faktisk bruges.

`settings/index.html` skal nu også loade `bon_kort.css`, `bon_kort_builder.js`, `bon_kort.js`, `utils.js`, `BonConfig.js`, `BonConfigBar.js` for at preview kan rendere. Hvis de allerede er der, skip.

### 5. Eksplicit navn-konvention i sidebaren

Det nye punkt "Denne enhed" placeres øverst og adskilles fra resten med `<div class="st-nav-sep"></div>`. Eksisterende admin-separator + label flyttes ikke. Læseren ser:

```
Denne enhed              ← per-device, alle roller
─────────────
Brugere
Rollerettigheder
Medarbejdere
Priskategorier
Betalingstyper
─── Admin ───
Indkøb
Grocy
...
```

---

## Implementeringsrækkefølge

1. Opret `shared/density.js` og `shared/density.css` (med alle 6 komponent-sektioner som listet ovenfor).
2. Tilføj density-imports + `Density.init()` i én enkelt kitchen-side (`later.html`). Test manuelt: åbn DevTools, kør `Density.set('compact')` i konsollen, verificer at bon-kort krymper.
3. Hvis (2) virker — rul ud til alle øvrige HTML-shells (excl. `mobile/`).
4. Tilføj "Denne enhed"-sektion i `settings/index.html` med radio-UI + dummy preview via `BonKortBuilder`.
5. Verificer auto-detect: ryd localStorage, sæt `window.innerWidth` til 1366 via DevTools device emulation → reload → bekræft `body` har klasse `density-compact`.
6. Verificer at `mobile/index.html` IKKE påvirkes — åbn på telefon, bekræft ingen body-klasser fra density.

---

## Test

1. Åbn `bon.ristetrug.dk/settings/` på køkken-laptoppen som `kok`-bruger → verificer "Denne enhed" er tilgængelig.
2. Vælg "Kompakt" → verificer preview-bon-kort ændres med det samme.
3. Naviger til `/kitchen/later.html` → verificer rigtige bon-kort er kompakte og at en lang bon (10+ linjer) er fuldt synlig.
4. Vælg "Tæt" → verificer 3 kort kan stå i bredden ved 1536px logisk viewport.
5. Refresh siden → verificer mode huskes.
6. Åbn samme bon i office bon-drawer → verificer drawer-felter også reflekterer density.
7. Klar localStorage (`localStorage.clear()`) → reload på smal skærm (≤1366) → verificer auto-compact. Reload på MacBook (>1366) → verificer comfort.
8. Sæt density til "Tæt" på køkken-laptop → åbn MacBook → verificer MacBook stadig er Komfort (forskellige localStorages).
9. Åbn `/mobile/` på en telefon → verificer at `body` IKKE har `density-*` klasse og at mobile-UI er uændret.
10. Klik "Nulstil til standard" → verificer at auto-detect tager over igen (afhænger af skærmstørrelse).

---

## Ikke i scope

- Office-specifikke komponenter (dashboard, fakturering, rapporter, CRM, planning, tilbud, stock_overview, recipes). Mekanikken er klar — overrides tilføjes til `density.css` ad hoc når en bruger melder behov.
- Topbar-knap (besluttet: kun via settings).
- Synkronisering på tværs af devices (det er bevidst per-device).
- Server-side override / låsning (alle roller styrer deres egen device).

---

## Følgespørgsmål til senere (runde 2+)

- **Tokens-refaktorering:** På sigt bør hardcodede font-sizes i komponent-CSS migreres til `var(--font-size-*)` fra `tokens.css`, og tokens.css selv defineres med `calc(N * var(--density-scale, 1))`. Så ville en ny komponent automatisk arve density uden at kræve egne overrides. Stort arbejde — ikke i runde 1.
- Skal admin kunne "låse" en density per device (fx via fingerprint eller server-side override)?
- Skal density også afspejles i `<html style="--density-scale: 0.88">` så enkeltstående CSS-filer kan bruge `calc()` lokalt uden tokens-refaktorering?
- Office-komponenter: Hvilke skal i runde 2 have density-overrides? Sandsynligvis fakturering (mange tabeller) og rapporter (mange tal i grids).
