# CLAUDE_BON_KORT_REDESIGN.md
*Komprimering af bon-kort for at frigøre plads til menu-linjer*

> Implementeres FØR `CLAUDE_DENSITY_TOGGLE.md`. Density-overrides bygger ovenpå denne markup-struktur.

---

## Formål

På 14"-skærme (ThinkPad L14 G2, 1920×1080 @ 125% skala ≈ 1536×864 logisk viewport) tager bon-kortets header/chrome ~53% af kortets højde før menu-linjerne starter. Vi komprimerer chrome'et så hele bonnen kan ses uden at miste læsbarhed på det vigtige: **menu-linjerne** og **pickup-tiden**.

## Designprincip

**Chrome krymper, indhold står tydeligt.**

Hvad det betyder konkret:
- Header (bon-id, tid, dato, mode, flag) → fra 4-5 linjer til 2 linjer
- Pickup-tid → fremhævet som visuelt anker (~22-24px)
- Menu-linjer → store og roligt læselige (16px), uændret af density-mode
- Pakke-linjer (emballage) → visuelt afdæmpede i grå
- Linje-noter → inline under produktnavn i stedet for separat row
- Kunde-adresse → kontekst-afhængig synlighed
- Kitchen-info → åben default, lukbar når læst

---

## Ændringer i HTML-struktur

### Header — fra 4-5 linjer til 2 linjer

**Før:**
```
#cafe-3467                 35 ENHEDER
10:45
→ Lev 11:30
Ons 20. maj · Levering
🌷 Ikke planlagt endnu
```

**Efter:**
```
#cafe-3467                       35 ENH
[10:45] → 11:30 · Ons 20/5 · Lev · 🌷
```

Hvor `[10:45]` er fremhævet pickup-tid og resten er kompakt info på samme baseline.

**Markup:**
```html
<div class="bon-header">
  <div class="bon-header-row1">
    <div class="bon-id">#cafe-3467</div>
    <div class="bon-units">35<span class="bon-units-label">ENH</span></div>
  </div>
  <div class="bon-header-row2">
    <span class="bon-pickup">10:45</span>
    <span class="bon-lev-time">→ 11:30</span>
    <span class="bon-sep">·</span>
    <span class="bon-date">Ons 20/5</span>
    <span class="bon-sep">·</span>
    <span class="bon-mode">Levering</span>
    <span class="bon-flag">🌷 Ikke planlagt</span>
  </div>
</div>
```

**Dato-formatering:** `Ons 20/5` i stedet for `Ons 20. maj`. For "I dag" / "I morgen" vis disse i stedet for datoen.

**Flag:** Vis kun når relevant (`pickup_time_uncertain`, m.fl.). Skal ikke optage plads når ikke aktiv.

### Kitchen-info note — åben default, lukbar

Eksisterende adfærd: vises åben når der er indhold.

Ny adfærd:
- Tilføj `×` knap i øverste højre hjørne af noten
- Klik på `×` → noten kollapser til badge: `+ Køkkeninfo (læst)` med check-ikon
- Klik på badge → noten åbnes igen
- State er per-session (in-memory). Ikke persisteret til DB.
- Hvis bonnen genrenderes (efter SSE-opdatering), åbner noten igen — det er bevidst, så vigtig info ikke skjules ved ændringer

**Markup, åben:**
```html
<div class="kitchen-info-note">
  <button class="kitchen-info-close" title="Marker som læst">×</button>
  5x Kartoflen 5x Italieneren ...
</div>
```

**Markup, lukket:**
```html
<div class="kitchen-info-collapsed" title="Klik for at åbne">
  + Køkkeninfo (læst)
</div>
```

### Kunde-row — kontekst-afhængig

`createCard(cardData, context)` får allerede en context-parameter (`'kitchen-today'`, `'kitchen-later'`, m.fl.).

| Context | Visning |
|---|---|
| `kitchen-today` | Kun customer-name. Klik på lille `▾ adresse` for at folde adresse ud. |
| `kitchen-later` | Customer-name + adresse synlig (som nu) |
| `office-*` | Som `kitchen-later` (adresse synlig) |

**Markup:**
```html
<div class="bon-customer">
  <div class="customer-name">
    Chantal van der Wulp · NL Embassy Copenhagen
    <span class="customer-toggle">▾ adresse</span>  <!-- kun i today-context -->
  </div>
  <div class="customer-address">Toldbodgade 33, 2, 1253 København</div>
</div>
```

CSS:
```css
/* Today-context: skjul adresse default */
.bon-card.context-today .customer-address { display: none; }
.bon-card.context-today.show-address .customer-address { display: block; }

/* Later-context (og office): adresse altid synlig, ingen toggle */
.bon-card.context-later .customer-toggle,
.bon-card.context-office .customer-toggle { display: none; }
```

### Menu-linjer — pakke-linjer visuelt adskilt

Backend-felt: `bon_lines.is_accessory` (boolean) er allerede defineret som "Transportkasse, servietter etc". Bruges som primær indikator. Fallback: `category === '06 Emballage'`.

**Markup:**
```html
<div class="bon-menu">
  <div class="bon-menu-item">
    <span class="bon-menu-qty">5</span>
    <span class="bon-menu-name">Kartoflen
      <span class="bon-menu-note">2 skal være Glutenfri</span>
    </span>
  </div>
  ...
  <div class="bon-menu-item is-packaging">
    <span class="bon-menu-qty">35</span>
    <span class="bon-menu-name">RR Boks (emballage)</span>
  </div>
</div>
```

**Linje-note:** `bon_lines.special_request` rendres inline under produktnavn i lille font.

---

## CSS-ændringer

Følgende klasser/properties skal opdateres i `shared/bon_kort.css`:

```css
/* Header — kompakt 2-linjers layout */
.bon-header { padding: 10px 14px 8px 18px; }
.bon-header-row1 {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 4px;
}
.bon-id { font-size: 20px; font-weight: 700; color: var(--brand-primary); }
.bon-units { font-size: 26px; font-weight: 700; }
.bon-units-label {
  font-size: 10px; font-weight: 700;
  color: var(--color-text-dim); text-transform: uppercase;
  letter-spacing: 0.5px;
}
.bon-header-row2 {
  display: flex; align-items: baseline; gap: 6px;
  font-size: 12px; color: var(--color-text-dim);
  font-weight: 600; flex-wrap: wrap;
}
.bon-pickup {
  font-size: 24px; font-weight: 700;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px; line-height: 1;
}
.bon-lev-time {
  color: var(--color-text); font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.bon-sep { opacity: 0.4; }
.bon-mode {
  background: var(--color-background);
  padding: 1px 6px; border-radius: 3px;
  font-size: 11px;
}
.bon-flag {
  font-size: 11px; color: var(--color-orange); font-weight: 700;
}

/* Kitchen-info close-knap */
.kitchen-info-note { position: relative; padding-right: 28px; }
.kitchen-info-close {
  position: absolute; top: 4px; right: 4px;
  width: 22px; height: 22px;
  background: rgba(107, 90, 31, 0.1);
  border: none; border-radius: 50%;
  font-size: 14px; font-weight: 700; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.kitchen-info-collapsed {
  margin: 8px 14px 0;
  padding: 4px 10px;
  font-size: 12px; color: var(--color-text-dim);
  background: var(--color-background);
  border-radius: 4px;
  cursor: pointer;
  display: flex; align-items: center; gap: 6px;
  font-weight: 600;
}
.kitchen-info-collapsed::before {
  content: '✓'; color: var(--color-green-dark); font-weight: 700;
}

/* Menu-linjer — store og rolige */
.bon-menu-item {
  padding: 5px 14px 5px 18px;
  display: flex; align-items: baseline; gap: 10px;
  font-size: 16px;
}
.bon-menu-qty {
  font-weight: 700; min-width: 30px; text-align: right;
  font-variant-numeric: tabular-nums;
}
.bon-menu-name { font-style: italic; font-weight: 600; }
.bon-menu-note {
  display: block;
  font-size: 11px; color: var(--color-text-dim);
  font-weight: 400; font-style: normal;
  margin-top: 1px;
}

/* Pakke-linjer (emballage) */
.bon-menu-item.is-packaging .bon-menu-name {
  font-style: normal; font-weight: 500;
}
.bon-menu-item.is-packaging {
  color: var(--color-text-dim);
  font-size: 14px;
}

/* Kunde — kontekst-afhængig */
.bon-card.context-today .customer-address { display: none; }
.bon-card.context-today.show-address .customer-address { display: block; }
.bon-card.context-later .customer-toggle,
.bon-card.context-office .customer-toggle { display: none; }
.customer-toggle {
  display: inline-block; margin-left: 4px;
  font-size: 11px; color: var(--brand-primary); cursor: pointer;
  font-weight: 700;
}
```

> Reference: en interaktiv mockup ligger som `bon_kort_kompakt_mockup.html` med disse styles implementeret. Brug den til at sammenligne resultatet.

---

## Filer der ændres

### `shared/bon_kort.css`
- Erstat header-CSS med nye værdier
- Tilføj `.bon-pickup`, `.bon-lev-time`, `.bon-mode`, `.bon-sep`, `.bon-flag`, `.bon-units-label`
- Opdater `.bon-menu-item` font-size til 16px
- Tilføj `.bon-menu-item.is-packaging` styling
- Tilføj `.bon-menu-note` inline styling
- Tilføj `.kitchen-info-close`, `.kitchen-info-collapsed` styling
- Tilføj context-afhængige customer-row regler

### `shared/bon_kort_builder.js`
- Restrukturér header-rendering til 2-linjers layout
- Split pickup-tid og lev-tid i separate spans
- Brug korte dato-formater (`Ons 20/5`, eller `I dag`/`I morgen` når relevant)
- Marker emballage-linjer med `is-packaging` klasse baseret på `is_accessory` (primært) eller `category === '06 Emballage'` (fallback)
- Render `special_request` som inline `.bon-menu-note` under produktnavn
- Tilføj `×` knap til kitchen-info note
- Tilføj context-klasse på kort: `context-today` / `context-later` / `context-office`
- Tilføj `▾ adresse` toggle for today-context

### `shared/bon_kort.js` (event handlers)
- Klik på `.kitchen-info-close` → erstat noten med `.kitchen-info-collapsed`
- Klik på `.kitchen-info-collapsed` → erstat med noten igen
- Klik på `.customer-toggle` → toggle `.show-address` på `.bon-card`

State håndteres per-session (in-memory). Ingen DB-skrivning.

---

## Test

1. Åbn `/kitchen/later.html` på køkken-laptop (1536×864).
   Verificer at en lang bon (10+ linjer) viser hele indholdet uden at klippe.
2. Klik `×` på kitchen-info note → verificer den kollapser til "+ Køkkeninfo (læst)".
3. Klik badge → verificer noten åbner igen.
4. Åbn `/kitchen/today.html` → verificer at bons kun viser customer-name, ikke adresse.
5. Klik "▾ adresse" → verificer adresse folder ud.
6. Verificer at pakke-linjer (`RR Boks`, `Transportkasse`) vises i grå/mindre.
7. Verificer at linjer med `special_request` viser noten inline under produktnavnet.
8. Office bon-drawer → verificer ny markup også virker dér (skal automatisk pga. shared/).

---

## Ikke i scope

- Density-toggle mekanik (separat spec: `CLAUDE_DENSITY_TOGGLE.md`).
- Sticky bon-id ved scroll inde i kortet.
- Persistering af kitchen-info "læst" state til DB.
- Mobile-shell ændringer (kort vises anderledes i mobile/views/).
