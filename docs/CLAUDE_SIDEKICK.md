# CLAUDE_SIDEKICK.md
## Whiteboard Sidekick — Spec og implementationsguide

*Sidst opdateret: april 2026*

---

## Hvad er sidekick

Et tre-trins overlay der viser whiteboard-data inde i Bon v2 kitchen-zonen — uden at konkurrere med ordrevisningen. Kokkene behøver ikke skifte kontekst for at se dagens opgaver, tavlebeskeder eller hvem der er på vagt.

Princip: **Bon er primær. Sidekick er sekundær.** Bon-indholdet må aldrig blokeres.

---

## De tre trin

| Trin | Trigger | Hvad vises |
|------|---------|-----------|
| **① Ikon** | Default | Flydende ikon nederst højre + badge med antal uafsluttede opgaver |
| **② Panel** | Klik på ikon | Sidekolonne (~300px) — Bon shrinks. Dagens opgaver, hurtig-tilføj, seneste beskeder |
| **③ Fuld** | Expand-knap i panel | Fuld overlay — liste-navigation, alle opgaver, beskedtavle, vagtplan, sensorer (fremtid) |

Tilbage-flow: Fuld → Panel → Ikon (aldrig spring over).

---

## Placering i Bon v2

Sidekick implementeres som en selvstændig JS-komponent der inkluderes i kitchen-zonens HTML-filer — primært `today.html` og evt. `dashboard.html`.

```
/public/kitchen/
  today.html          ← inkluderer sidekick
  dashboard.html      ← inkluderer sidekick
/public/shared/
  sidekick.js         ← al logik
  sidekick.css        ← al styling (whiteboard-palette)
```

Inkluderes i bunden af `<body>` på relevante kitchen-sider:
```html
<link rel="stylesheet" href="/shared/sidekick.css">
<script>
  window.SIDEKICK_CONFIG = {
    whiteboardBase: '<%- process.env.WHITEBOARD_BASE_URL %>',
    sopBase: '<%- process.env.SOP_BASE_URL %>'
  };
</script>
<script src="/shared/sidekick.js"></script>
```

---

## Konfiguration

### Bon v2 `.env`
```
WHITEBOARD_BASE_URL=https://whiteboard.ristetrug.dk
SOP_BASE_URL=https://sop.ristetrug.dk
```

### Whiteboard `.env` (på Linode/Hetzner)
```
ALLOWED_ORIGINS=https://bon.ristetrug.dk,http://localhost:3000
```

> **Serverflytning:** Når whiteboard flyttes fra Linode til Hetzner ændres kun DNS.
> `ALLOWED_ORIGINS` forbliver uændret. `WHITEBOARD_BASE_URL` i Bon v2 forbliver uændret.
> Ingen kodeændringer nødvendige.

---

## API-kald (whiteboard-server)

Alle kald går til `WHITEBOARD_BASE_URL` — aldrig localhost, aldrig hardkodet.

| Endpoint | Hvad |
|----------|------|
| `GET /api/health` | Forbindelsescheck — vises som dot i UI |
| `GET /api/tasks/lists` | Alle lister |
| `GET /api/tasks?date=YYYY-MM-DD` | Dagens opgaver |
| `POST /api/tasks` | Opret opgave |
| `PATCH /api/tasks/:id` | Opdater status (genåbn) |
| `POST /api/tasks/:id/complete` | Markér udført |
| `GET /api/board/messages?limit=20` | Tavlebeskeder |
| `POST /api/board/messages` | Send besked |
| `GET /api/users` | Brugerliste |
| `GET /api/smartplan/today` | Vagtplan (fejler lydløst) |

---

## State-model

```js
const S = {
  ok: false,          // API-forbindelse
  lists: [],          // alle lister
  tasks: [],          // dagens opgaver
  messages: [],       // tavlebeskeder
  users: [],          // brugere
  shifts: [],         // vagter fra Smartplan
  activeList: null,   // valgt liste i fuld-visning
  mode: 'icon',       // 'icon' | 'panel' | 'full'
  undo: null          // { id, tid, iv } — aktiv fortryd-window
};
```

---

## Adfærd

**Polling:** Hvert 30. sekund — men kun når mode !== 'icon'. Sparer unødige kald.

**Badge:** Antal tasks med `status !== 'done'`. Orange baggrund hvis > 3.

**Opgave-afslutning:** Optimistisk UI-opdatering → 8 sekunders fortryd-toast → `POST /complete`. Hvis fortryd: revert lokalt, intet API-kald.

**Genåbn:** `PATCH { status: 'active' }` — Whiteboard-API'et understøtter dette.

**API-fejl:** Vises som rød forbindelsesdot + fejlbesked i panelet. Sidekick går aldrig ned — den degraderer lydløst.

**SOP-links:** Opgaver med `sop_url` viser SOP-tag. Klik åbner `${SOP_BASE}/?tag=${sop_url}` i nyt vindue.

---

## CSS-palette

Sidekick bruger whiteboard-paletten (lys baggrund) — visuelt adskilt fra Bon v2's mørke kitchen-tema.

```css
--wb-bg: #f6f4f0
--wb-surface: #ffffff
--wb-border: #e2ddd5
--wb-text: #2c2520
--wb-text-dim: #8a8078
--wb-accent: #e8a44a     /* delt med Bon — genkendelig */
--wb-green: #4a9f49
--wb-red: #d45548
```

Panel-bredde: `300px`. Bon-content shrinks med samme bredde via `.bon-shrunk` klasse på parent.

---

## Fremtidige udvidelser (ikke i scope nu)

- **Sensor-strip:** IoT-temperaturdata øverst i fuld-visning (placeholder er allerede i markup)
- **Bruger-identifikation:** "Udført af [navn]" — kobles til kitchen-bruger-valg (Fase 4b)
- **SSE:** Erstat polling med SSE fra whiteboard-server når det er implementeret der

---

## Implementationsrækkefølge til Simon

1. Opret `/public/shared/sidekick.css` og `sidekick.js` — udtræk fra `sidekick-functional.html`
2. Erstat hardkodet `API_BASE`/`SOP_BASE` med `window.SIDEKICK_CONFIG`
3. Tilføj `WHITEBOARD_BASE_URL` og `SOP_BASE_URL` til Bon v2 `.env` og server-config
4. Injicer config-objekt i relevante kitchen HTML-filer via template
5. Tilføj `https://bon.ristetrug.dk` til `ALLOWED_ORIGINS` på whiteboard-serveren
6. Test: ikon → panel → fuld → fortryd → hurtig-tilføj

**Prototype-fil:** `sidekick-functional.html` — al logik og markup er klar. Det er primært en extract + config-fix opgave.
