# SPEC_007_planning_tilbuds_toggle.md

> Lille UI-spec til Simon — gør tilbuds-visning i køkken-planlægning til en
> synlig knap, ikke kun localStorage.
>
> Lukker #007.

---

## Baggrund

`shared/planning.js` har en `_plShowOffers`-toggle der bestemmer om tilbud
(`is_offer=1`) vises i planlægningsbonnen. Toggle læses fra
`localStorage.planning_show_offers` men der er ingen synlig UI-knap.

Bruger ville skulle åbne devtools og manuelt sætte localStorage for at se
tilbud. Beslutning (Leif, maj 2026): **køkkenet skal kunne vælge**, da det
er aktivt under diskussion med dem.

---

## Hvad der skal bygges

### 1. Synlig toggle-knap i planlægnings-headeren

Ved siden af status-filter-knapperne i `shared/planning.js`'s render-loop,
tilføj en knap:

```html
<button class="pl-toggle-offers" data-pl="toggle-offers">
  <span class="pl-toggle-label">Tilbud</span>
  <span class="pl-toggle-state">×</span>  <!-- × eller ✓ -->
</button>
```

### 2. Adfærd

- **Default state:** OFF (matcher nuværende default i localStorage)
- **Klik:** toggle ON/OFF
- **Persistens:** Skriv til `localStorage.planning_show_offers` (eksisterer
  allerede — bare gør det synligt at det skifter)
- **Re-render:** Trigger samme re-render som status-filter-knapperne gør

### 3. Visuel styling

Match eksisterende status-filter-knapper i samme blok:
- Når OFF: grå baggrund, ikon `×` eller `✕`
- Når ON: blå/lilla baggrund (matcher `is_offer`-farve fra UI-tokens), ikon `✓`
- Hover-state som de andre knapper

### 4. Aria/a11y

```html
<button
  class="pl-toggle-offers"
  data-pl="toggle-offers"
  aria-pressed="false"
  aria-label="Vis tilbud i planlægning"
>
```

`aria-pressed` skal opdateres ved toggle. `aria-label` skifter til "Skjul
tilbud i planlægning" når ON.

---

## Hvor i koden

`shared/planning.js` har en render-funktion der bygger headeren med
status-filter-knapperne. Tilføj toggle-knappen lige efter sidste status-knap.

Implementeringen er nok:
- 1 ekstra HTML-blok i render-funktionen
- 1 event-listener på `data-pl="toggle-offers"` der toggler localStorage + re-renderer
- 1 CSS-blok i `shared/planning.css` med 2 states

---

## Tests

Da det er ren UI-feature, ingen runner-tests. Verificér manuelt:

| Test | Forventet |
|------|-----------|
| Initial load med tom localStorage | Knap viser OFF, tilbud ikke synlige |
| Klik på knap | Knap viser ON, tilbud rendres med `is_offer=1`-badge |
| Refresh side | Knap viser ON (persistens fra localStorage) |
| Klik igen | Knap viser OFF, tilbud forsvinder |
| Tjek `localStorage.planning_show_offers` | "true" når ON, "false" eller fjernet når OFF |

---

## Markering i TEST_OBSERVATIONS efter implementering

```markdown
### #007 — Tilbuds-toggle i planlægning kun localStorage (lukket)

| | |
|--|--|
| **Beslutning** | Implementér synlig toggle-knap (Leif, maj 2026) |
| **Status** | `lukket` |
| **Fix** | `shared/planning.js` + `shared/planning.css` — synlig toggle-knap ved siden af status-filter |
```

---

*Oprettet: maj 2026 — lille UI-task til Simon. Kan implementeres parallelt
med patch C/D/E.*
