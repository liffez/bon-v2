# CLAUDE_DENSITY_TOGGLE.md
*Per-device visningstæthed for Bon v2*

> Implementeres EFTER `CLAUDE_BON_KORT_REDESIGN.md`. Density-overrides forudsætter den nye markup-struktur (`.bon-header-row1/2`, `.bon-pickup`, `.bon-units-label`, m.fl.).

---

## Formål

Bon-kortet er for stort på små skærme (fx ThinkPad L14 G2, 1920×1080 @ 125% Windows-skala ≈ 1536×864 logisk viewport). Vi indfører en density-indstilling der gemmes per device.

## Designprincip

**Chrome krymper, menu-linjer forbliver store.**

Density justerer kun det visuelle "chrome" omkring indholdet (header, kunde, prep, kitchen-info, actions). Menu-linjerne — det kokken faktisk læser og udfører — holdes på `comfort`-størrelse selv i `compact`-mode. Kun i `dense`-mode må linjer også krympe en smule.

## Konceptuel placering

Settings-zonen får en ny sektion **"Denne enhed"** der adskiller sig fra de eksisterende settings-sektioner:

| | Eksisterende settings | Denne enhed (ny) |
|---|---|---|
| Storage | `system_settings` tabel | `localStorage` |
| Scope | Hele installationen | Kun denne browser |
| Adgang | Admin | Alle roller |

Sektionen er forberedt til at vokse over tid (kiosk-default, auto-refresh, foretrukken startside), men runde 1 indeholder kun **Tæthed**.

---

## Tre modes

| Mode | Body-klasse | Pickup | Bon-id | Enheder | **Menu-linjer** | Pakke-linjer |
|---|---|---|---|---|---|---|
| Komfort | `density-comfort` | 24px | 20px | 26px | **16px** | 14px |
| Kompakt | `density-compact` | 22px | 18px | 22px | **16px** (uændret) | 14px (uændret) |
| Tæt | `density-dense` | 20px | 16px | 20px | 14px | 12px |

Touch-targets forbliver ≥ 30px selv i Tæt.

---

## Filer

### Ny fil: `shared/density.js`

```js
/**
 * shared/density.js
 * ════════════════════════════════════════════════════════════
 * Per-device visningstæthed. Gemmes i localStorage, gælder alle zoner.
 * Skal initialiseres FØR første render via Density.init().
 * ════════════════════════════════════════════════════════════
 */

const STORAGE_KEY = 'bon_v2_density';
const VALID_MODES = ['comfort', 'compact', 'dense'];
const DEFAULT_MODE = 'comfort';

const Density = {
    init() {
        const mode = this._read();
        this._applyToBody(mode);
    },

    set(mode) {
        if (!VALID_MODES.includes(mode)) return;
        localStorage.setItem(STORAGE_KEY, mode);
        this._applyToBody(mode);
        document.dispatchEvent(new CustomEvent('density:change', { detail: { mode } }));
    },

    current() {
        return this._read();
    },

    _read() {
        const v = localStorage.getItem(STORAGE_KEY);
        return VALID_MODES.includes(v) ? v : DEFAULT_MODE;
    },

    _applyToBody(mode) {
        const body = document.body;
        VALID_MODES.forEach(m => body.classList.remove(`density-${m}`));
        body.classList.add(`density-${mode}`);
    }
};

window.Density = Density;
```

### Ny fil: `shared/density.css`

Loades EFTER `bon_kort.css`. Comfort er default — ingen overrides nødvendige.

**Vigtigt:** Menu-linjer (`.bon-menu-item`) er IKKE overriddet i `compact`-mode. Kun chrome-elementer.

```css
/**
 * shared/density.css
 * ════════════════════════════════════════════════════════════
 * Density overrides. Chrome krymper, menu-linjer forbliver store
 * (undtagen i dense-mode hvor linjer også må krympe lidt).
 * Touch-targets forbliver ≥ 30px.
 * ════════════════════════════════════════════════════════════
 */

/* ── COMPACT — chrome krymper, linjer holdes store ──────── */
body.density-compact .bon-card        { width: 320px; }

/* Header */
body.density-compact .bon-id          { font-size: 18px; }
body.density-compact .bon-units       { font-size: 22px; }
body.density-compact .bon-pickup      { font-size: 22px; }
body.density-compact .bon-header-row2 { font-size: 11px; }
body.density-compact .bon-header      { padding: 8px 12px 6px 16px; }

/* Kunde, prep, kitchen-info */
body.density-compact .bon-customer    { padding: 6px 12px; font-size: 12px; }
body.density-compact .bon-prep        { padding: 6px 12px; }
body.density-compact .prep-badge      { padding: 5px 10px; font-size: 12px; }
body.density-compact .kitchen-info-note { margin: 6px 12px 0; font-size: 11px; }

/* Actions */
body.density-compact .bon-actions     { padding: 6px 12px; }
body.density-compact .action-btn      { width: 32px; height: 32px; }
body.density-compact .action-btn svg  { width: 16px; height: 16px; }

/* MENU-LINJER: bevidst IKKE overridet — beholder comfort-størrelse */

/* ── DENSE — alt krymper, også linjer (men touch-target ≥ 30px) ── */
body.density-dense .bon-card          { width: 290px; }

/* Header */
body.density-dense .bon-id            { font-size: 16px; }
body.density-dense .bon-units         { font-size: 20px; }
body.density-dense .bon-pickup        { font-size: 20px; }
body.density-dense .bon-header-row2   { font-size: 10px; }
body.density-dense .bon-header        { padding: 6px 10px 5px 14px; }

/* Kunde, prep, kitchen-info */
body.density-dense .bon-customer      { padding: 5px 10px; font-size: 11px; }
body.density-dense .bon-prep          { padding: 5px 10px; }
body.density-dense .prep-badge        { padding: 4px 8px; font-size: 11px; }
body.density-dense .kitchen-info-note { margin: 5px 10px 0; padding: 5px 24px 5px 8px; font-size: 11px; }

/* Menu-linjer i dense: lidt mindre, men ikke aggressivt */
body.density-dense .bon-menu-item     { font-size: 14px; padding: 3px 12px 3px 14px; }
body.density-dense .bon-menu-item.is-packaging { font-size: 12px; }
body.density-dense .bon-menu-qty      { min-width: 26px; }

/* Actions */
body.density-dense .bon-actions       { padding: 5px 10px; }
body.density-dense .action-btn        { width: 30px; height: 30px; }
body.density-dense .action-btn svg    { width: 14px; height: 14px; }
```

> Office-specifikke komponenter (tabeller, lister, kalender, sidebars) tilføjes til denne fil ad hoc når behovet opstår. Mekanikken er klar.

### Ændret: alle HTML-shells

I `kitchen/*.html`, `office/index.html`, `settings/*.html`, `logistik/*.html` — tilføj efter eksisterende stylesheet-links og **før** view-scripts:

```html
<link rel="stylesheet" href="/shared/density.css">
<script src="/shared/density.js"></script>
<script>Density.init();</script>
```

**Kritisk:** `Density.init()` skal køre før kort renderes, ellers blinker UI'et fra default → korrekt mode ved hver page load.

### Ny fil: `settings/this-device.html`

Følg navngivnings- og struktur-konvention fra de eksisterende settings-sider.

```html
<!DOCTYPE html>
<html lang="da">
<head>
    <meta charset="UTF-8">
    <title>Denne enhed — Bon v2 Settings</title>
    <!-- Standard settings-imports + density-imports -->
</head>
<body class="zone-settings">

    <!-- Standard settings shell/sidebar -->

    <main class="settings-content">
        <h1>Denne enhed</h1>

        <div class="device-info-banner">
            💡 Indstillingerne på denne side gemmes kun på denne browser/enhed.
            De gælder for alle brugere der logger ind her, men ikke når du logger
            ind fra en anden computer.
        </div>

        <section class="settings-section">
            <h2>Tæthed</h2>
            <p class="settings-desc">
                Juster hvor meget plads bon-kortets header og kanter fylder.
                Menu-linjerne forbliver store og roligt læselige i alle tæthedsgrader.
                Vælg en mindre tæthed hvis hele bonnen ikke kan vises på skærmen.
            </p>

            <div class="density-options">
                <label class="density-option">
                    <input type="radio" name="density" value="comfort">
                    <div class="density-option-body">
                        <div class="density-option-title">Komfort</div>
                        <div class="density-option-desc">
                            Anbefales til store skærme og MacBook.
                        </div>
                    </div>
                </label>

                <label class="density-option">
                    <input type="radio" name="density" value="compact">
                    <div class="density-option-body">
                        <div class="density-option-title">Kompakt</div>
                        <div class="density-option-desc">
                            Mindre header og kanter, menu-linjer i samme størrelse.
                            Anbefales til 14"-laptops (ThinkPad L14 osv.).
                        </div>
                    </div>
                </label>

                <label class="density-option">
                    <input type="radio" name="density" value="dense">
                    <div class="density-option-body">
                        <div class="density-option-title">Tæt</div>
                        <div class="density-option-desc">
                            Alt mindre, også menu-linjer.
                            Kun hvis Kompakt ikke giver nok plads.
                        </div>
                    </div>
                </label>
            </div>

            <button class="btn-secondary" id="resetDensity">
                Nulstil til standard (Komfort)
            </button>
        </section>

        <section class="settings-section">
            <h2>Preview</h2>
            <p class="settings-desc">
                Eksempel på bon-kort med den valgte tæthed.
            </p>
            <div class="density-preview">
                <!--
                  Dummy bon-card med statisk HTML der bruger samme klasser som
                  rigtige bon-kort, så body.density-X CSS-reglerne påvirker det
                  direkte. Brug samme struktur som CLAUDE_BON_KORT_REDESIGN.md
                  specificerer (bon-header-row1/2, bon-pickup, etc.).
                -->
                <div class="bon-card context-later" data-status="igang">
                    <div class="bon-header">
                        <div class="bon-header-row1">
                            <div class="bon-id">#cafe-9999</div>
                            <div class="bon-units">42<span class="bon-units-label">ENH</span></div>
                        </div>
                        <div class="bon-header-row2">
                            <span class="bon-pickup">10:00</span>
                            <span class="bon-lev-time">→ 10:45</span>
                            <span class="bon-sep">·</span>
                            <span class="bon-date">Eksempel</span>
                            <span class="bon-sep">·</span>
                            <span class="bon-mode">Levering</span>
                        </div>
                    </div>
                    <div class="bon-customer">
                        <div class="customer-name">Eksempel Kunde A/S</div>
                        <div class="customer-address">Demovej 1, 2920 Charlottenlund</div>
                    </div>
                    <div class="bon-menu">
                        <div class="bon-menu-item"><span class="bon-menu-qty">5</span><span class="bon-menu-name">Falaflen</span></div>
                        <div class="bon-menu-item"><span class="bon-menu-qty">10</span><span class="bon-menu-name">"Tunen"</span></div>
                        <div class="bon-menu-item"><span class="bon-menu-qty">8</span><span class="bon-menu-name">Frikadellen</span></div>
                        <div class="bon-menu-item is-packaging"><span class="bon-menu-qty">23</span><span class="bon-menu-name">RR Boks</span></div>
                    </div>
                </div>
            </div>
        </section>
    </main>

    <script src="/shared/density.js"></script>
    <script>
        Density.init();

        // Set initial radio state
        const current = Density.current();
        document.querySelector(`input[name="density"][value="${current}"]`).checked = true;

        // Wire up radios
        document.querySelectorAll('input[name="density"]').forEach(radio => {
            radio.addEventListener('change', e => {
                if (e.target.checked) Density.set(e.target.value);
            });
        });

        // Reset button
        document.getElementById('resetDensity').addEventListener('click', () => {
            Density.set('comfort');
            document.querySelector('input[name="density"][value="comfort"]').checked = true;
        });
    </script>
</body>
</html>
```

**Preview-strategi:** Da `body.density-X` påvirker hele siden, opdaterer dummy bon-kortet sig automatisk når man vælger en anden radio-knap. Ingen iframe eller scoped CSS nødvendigt.

### Ændret: settings-navigation

Tilføj "Denne enhed" som synligt menupunkt i settings-sidebaren/-menuen. Skal være synligt for **alle roller**, ikke kun admin.

Visuel markering anbefales — fx separator eller subtitel "Per enhed" over punktet — så det er klart at det er anderledes end de øvrige sektioner.

---

## Implementeringsrækkefølge

1. Opret `shared/density.js` og `shared/density.css`.
2. Tilføj density-imports + `Density.init()` i én enkelt kitchen-side (fx `later.html`). Test manuelt: åbn DevTools, kør `Density.set('compact')` i konsollen, verificer at bon-kortets chrome krymper men menu-linjer forbliver samme størrelse.
3. Hvis (2) virker — rul ud til alle øvrige HTML-shells.
4. Opret `settings/this-device.html` med radio-UI og dummy preview.
5. Tilføj menupunkt i settings-navigation, synligt for alle roller.

---

## Test

1. Åbn `bon.ristetrug.dk/settings/this-device.html` på køkken-laptoppen som `kok`-bruger → verificer siden er tilgængelig (ikke admin-blokeret).
2. Vælg "Kompakt" → verificer dummy preview ændres med det samme.
   - Header krymper
   - Menu-linjer **forbliver samme størrelse** (16px)
3. Vælg "Tæt" → verificer at også menu-linjer nu er mindre.
4. Naviger til `/kitchen/later.html` → verificer rigtige bon-kort er kompakte og at en lang bon (10+ linjer) er fuldt synlig.
5. Refresh siden → verificer mode huskes.
6. Åbn samme bon i office bon-drawer → verificer kortet i drawer også reflekterer density.
7. Klar localStorage (`localStorage.clear()`) → verificer fallback til Komfort.
8. Sæt density til "Tæt" på køkken-laptop → åbn MacBook → verificer MacBook stadig er Komfort.

---

## Ikke i scope

- Office-specifikke komponenter (tabeller, lister, kalender, dashboard, sidebars). Mekanikken er klar — overrides tilføjes til `density.css` ad hoc når behov opstår.
- Topbar-knap (besluttet: kun via settings).
- Automatisk media-query fallback baseret på viewport-størrelse.
- Andre device-settings (kiosk-default, auto-refresh, startside) — sektionen er forberedt, men runde 1 har kun Tæthed.
- Synkronisering på tværs af devices (det er bevidst per-device).
