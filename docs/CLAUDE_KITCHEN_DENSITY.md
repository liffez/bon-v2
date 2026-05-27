# CLAUDE_KITCHEN_DENSITY.md

## Opgave

Kitchen-zonen er udviklet på MacBook Air 13" (~1470×956 effective viewport), men produktionshardwaren er en **Lenovo ThinkPad L14 G2, 14"** med markant lavere effektivt viewport. Resultatet er at indhold klippes lodret — særligt:

- KATEGORI-listen på dashboardet (kun 2–3 rækker synlige, resten klippes)
- Bon detail kræver scroll for at se hele bon'en

Vi tilpasser kitchen-zonen så ThinkPad'en bliver baseline. **Ingen device detection, ingen density-modes** — bare en bedre baseline der også ser fin ud på MacBook Air'en.

## Antaget target viewport

| Parameter | Værdi | Note |
|-----------|-------|------|
| Effective CSS viewport | **1366×728** | Worst case: HD-model, 100% scaling, F11 fullscreen, ingen taskbar |
| Faktiske tal | Skal måles | Leif måler i køkkenet næste arbejdsdag — opdater baseline hvis nødvendigt |

Designet skal fungere på 1366×728 og opefter. Hvis den faktiske ThinkPad viser sig at have mere lodret plads, justeres baseline kun nedad i ambition (mere luft) — aldrig opad.

## Princip

Følger `BON_V2_PRINCIPPER.md`:
- Ingen patches — redesign tæthed på de relevante elementer
- Ingen device detection / ingen `@media` baseret på user agent
- Standard media queries på viewport-størrelse er fint hvis nødvendigt, men foretræk en baseline der bare virker overalt

## Files

Claude Code finder selv de relevante filer i kitchen-zonen. Reference: `bon_v2_zoner_og_layout.md`.

Forventede berørte filer (verificér):
- Dashboard-siden (`/kitchen/` eller `/kitchen/index.html` / `dashboard.html`)
- Bon detail-siden
- Eventuelt fælles kitchen-CSS hvis padding/spacing er token-baseret

## Ændringer — Dashboard

Problemet i prioriteret rækkefølge:

### 1. KATEGORI-listen klippes (HØJ PRIORITET)

Containeren har sandsynligvis fast højde eller `overflow: hidden`. Lav den om så den:

```css
/* Container der holder KATEGORI-listen */
.kategori-container {  /* eller hvad den nu hedder */
    flex: 1 1 auto;
    min-height: 0;       /* kritisk for at flex-child kan shrinke */
    overflow-y: auto;    /* intern scroll når mange kategorier */
}
```

Den container hører til i et flex-column layout der fordeler plads mellem header-stats, kategori-liste og bons-chart. Hvis ikke det er sat op som flex column, skal det laves om.

### 2. Header-blokken fylder for meget

Reducér padding i "I DAG"-headeren:

| Element | Før (antaget) | Efter |
|---------|---------------|-------|
| Header container padding | ~24–32px | **12–16px** |
| Stats-blok margin/gap | rigeligt | **stram op** |
| Emoji (😊 / "rolig dag") | stor | **32px max, eller skjul ved højde < 800px** |

### 3. BONS 10 DAGE chart

Skal ikke vokse frit. Fast højde så den ikke æder plads fra kategori-listen:

```css
.bons-10-dage-chart {
    height: 140px;       /* eller hvad der ser rigtigt ud */
    flex: 0 0 auto;
}
```

### 4. Tjek højre sidebar

Sidebaren med Vagtplan / nye bestillinger / prep / action-buttons skal også passe i 728px lodret uden scroll. Hvis den klippes — samme principper: stram padding, sæt sektionshøjder, brug intern scroll på de sektioner der kan vokse (fx prep-listen).

## Ændringer — Bon detail

Send screenshot fra ThinkPad'en før der ændres her. Generelle retningslinjer:

- Header-padding reduceres
- Metadata-blok (kunde, adresse, tider) kompakteres — overvej 2-kolonne layout hvis pladsen tillader det
- Touch-targets bevares (min 44×44px) men afstand mellem dem reduceres
- Fontstørrelser bevares for læsbarhed — det er padding der skal stram, ikke tekst

## F11 fullscreen — rutine, ikke kode

Køkkenet bruger Chrome i F11 fullscreen som standard. Det giver ~80px ekstra lodret ved at fjerne Windows-titelbar og taskbar.

- **Ingen programmatisk fullscreen** (vi vil ikke kapre brugerens browser)
- Dokumentér i køkkenmanual / post-it på skærmen at F11 er default

## Test-protokol

1. I devtools → toggle device toolbar → custom dimension **1366×728**
2. Gå igennem alle kitchen-sider:
   - Dashboard — KATEGORI-listen er fuldt synlig (eller scroller pænt internt), header er kompakt
   - Bon detail — hele bonnen er synlig uden scroll på en gennemsnitsbon (5–10 linjer)
3. Verificér også på **1470×956** (MacBook Air) — det skal stadig se godt ud, bare med mere luft
4. Ingen horisontal scroll nogen steder

## Out of scope (separate runder)

- Prep-siden, lager-siden, opskrifter-siden — samme behandling senere
- Office-zonen — den bruges på desktop og er ikke berørt
- Mobile breakpoints — håndteres separat (`CLAUDE_MOBIL.md`)
- Device detection, density modes, CSS custom properties for density

## Acceptkriterier

- [ ] På 1366×728: KATEGORI-listen er synlig i sin helhed eller scroller pænt internt
- [ ] På 1366×728: Bon detail viser hele bonnen uden side-scroll på en typisk bon
- [ ] På 1470×956: Layout ser stadig korrekt ud, ingen knækkede sektioner
- [ ] Ingen horisontal scroll på nogen kitchen-side i 1366×728
- [ ] Touch-targets er stadig ≥44×44px
