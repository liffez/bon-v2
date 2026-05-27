# CLAUDE.md — Tillæg: Hjælpesystem

## Formål

Et letvægts hjælpesystem der kan bruges på tværs af alle sider i Bon og Whiteboard.
Formålet er at nye medarbejdere kan få kontekstuel hjælp direkte i grænsefladen,
uden at der skal laves separate vejledninger der hurtigt bliver forældede.

---

## Tre filer — én gang at skrive, aldrig røre igen

```
/public/help-system.css      ← styling, rør ikke
/public/help-system.js       ← al logik, rør ikke
/public/help-content.json    ← ALLE tekster, det eneste der redigeres
```

`help-content.json` serveres som statisk fil.
Gem-knappen i admin-panelet sender filen til serveren via:

```
POST /api/help-content
Body: JSON.stringify(HELP_CONTENT)
```

Server-side handler (5 linjer):
```js
app.post('/api/help-content', (req, res) => {
  fs.writeFileSync(
    path.join(__dirname, 'public/help-content.json'),
    JSON.stringify(req.body, null, 2)
  );
  res.json({ ok: true });
});
```

---

## Integration på en side — to trin

### Trin 1: Inkludér i `<head>`
```html
<link rel="stylesheet" href="/help-system.css">
<script src="/help-system.js" defer></script>
```

### Trin 2: Markér siden
Sæt to attributter på body-tag eller hoved-wrapper:
```html
<body data-help-page="bon-ordrer" data-help-page-name="Bon — Ordrer">
```

Siden er nu registreret. Hjælpesystemet starter automatisk.

### Trin 3: Markér elementer (gøres i browseren, ikke i koden)
Brug kortlægningstilstand (se nedenfor) — ingen manuel kodeændring nødvendig.

---

## Tre tilstande

### H — Hjælpetilstand
Overlay med numre på alle registrerede elementer.
Side-panel glider ind med alle forklaringer i DOM-rækkefølge.
Hover over element → tooltip.
Tryk H igen eller Escape → lukker.

### Ctrl+H — Kortlægningstilstand
Alle interaktive elementer på siden får lilla stiplet kant.
Grøn kant = allerede kortlagt.
Klik på et element → popup med tre felter:
- `nøgle` — unik ID (fx `btn-gem-ordre`)
- `label` — kort navn (fx `Gem ordre`)
- `tekst` — forklarende tekst

Gem → `data-help="nøgle"` sættes på elementet og teksten gemmes i HELP_CONTENT.
Popup bekræfter og kortlægningstilstand fortsætter til næste element.

**Kortlægningstilstand bruges til at bygge hjælpeteksterne — ikke til daglig brug.**

### ⚙ Admin-panel
Separat side (eller fane i whiteboard-admin) på `/admin/help`.
Viser alle sider og alle tekster.
Rød boks øverst: elementer der har `data-help` men mangler tekst i JSON-filen.
Rediger inline. Gem-knap sender til `POST /api/help-content`.

---

## help-content.json struktur

```json
{
  "tavle": {
    "ny-opgave": {
      "label": "Ny opgave",
      "text": "Opretter en ny opgave i den aktive liste..."
    },
    "check-box": {
      "label": "Afkrydsning",
      "text": "Klik for at markere opgaven som udført..."
    }
  },
  "bon-ordrer": {
    "ny-ordre": {
      "label": "Ny ordre",
      "text": "Opret en ny ordre manuelt..."
    }
  }
}
```

Nøglen øverst matcher `data-help-page` på siden.
Nøglen inderst matcher `data-help` på elementet.

---

## Sidenavne / data-help-page nøgler

| Side                        | `data-help-page`  | `data-help-page-name`     |
|-----------------------------|-------------------|---------------------------|
| Whiteboard / Tavle          | `tavle`           | `Tavle`                   |
| Bon — Ordrer                | `bon-ordrer`      | `Bon — Ordrer`            |
| Bon — Indkøb                | `bon-indkob`      | `Bon — Indkøb`            |
| Bon — Leveringer            | `bon-leveringer`  | `Bon — Leveringer`        |
| Whiteboard — Admin          | `wb-admin`        | `Whiteboard — Admin`      |

Tilføj nye sider til denne tabel når de oprettes.

---

## Tastatur-genveje (overblik)

| Genvej    | Funktion                                      |
|-----------|-----------------------------------------------|
| `H`       | Slå hjælpetilstand til/fra                    |
| `Ctrl+H`  | Slå kortlægningstilstand til/fra              |
| `Escape`  | Luk aktiv tilstand                            |

`H` ignoreres automatisk når fokus er i et input- eller textarea-felt.
`Ctrl+H` bruger `e.preventDefault()` så browseren ikke åbner historik-panelet.

---

## Hvad der IKKE er implementeret (bevidste fravalg)

- **Rollestyring**: alle kan se hjælp. Kortlægningstilstand og admin bør på sigt
  beskyttes bag admin-login — det samme login der beskytter whiteboard-admin.
  Kan implementeres når password-beskyttelse af admin er på plads.

- **Versionering af tekster**: HELP_CONTENT er én aktiv JSON. Ingen historik.
  Tilstrækkeligt for dette use case.

- **Automatisk scan af umærkede elementer**: admin-panelet viser kun elementer
  der allerede har `data-help` men mangler tekst. Det finder ikke elementer
  der slet ikke har `data-help` endnu — dem finder man via kortlægningstilstand.

---

## Arbejdsflow ved ny side

1. Tilføj `data-help-page` og `data-help-page-name` på siden
2. Deploy
3. Åbn siden i browseren, tryk **Ctrl+H**
4. Klik rundt på alle vigtige elementer og udfyld nøgle + tekst
5. Gå til admin-panelet, finpuds teksterne
6. Tryk Gem

Ingen kodeændringer i trin 3–6. Alt sker i browseren.

---

## Reference: demo-fil

`help-system-demo-v3.html` indeholder en fuldt fungerende prototype med:
- Tavle-side med 14 kortlagte elementer
- Bon Ordrer-side med 5 elementer
- Admin-panel med missing-banner
- Kortlægningstilstand med popup
- Al CSS og JS inline (skal splittes til tre filer ved produktion)

Filen kan bruges som direkte reference for Claude Code.
