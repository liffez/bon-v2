# CLAUDE_hjaelpesystem.md — Hjælpesystemet (Bon v2 + Whiteboard)

> Kontekstuel hjælp direkte i grænsefladen, så nye medarbejdere kan finde ud af
> systemerne uden en separat vejledning der hurtigt bliver forældet.
>
> **Dette dokument findes ordret ens i begge repos** — `bon-v2/docs/CLAUDE_hjaelpesystem.md`
> og `whiteboard/CLAUDE_hjaelpesystem.md`. Ret begge når du retter det ene.
> Beskriver systemet som det er **bygget** (september 2026).

---

## To kopier af samme system

Systemet blev bygget i bon-v2 og kopieret til whiteboard. Kopierne er siden drevet fra
hinanden — bon-v2's er nået længst:

| | bon-v2 | whiteboard |
|---|---|---|
| Logik | `shared/help-system.js` | `public/help-system.js` |
| Styling | `shared/help-system.css` | `public/help-system.css` |
| Tekster | `data/help-content.json` | `data/help-content.json` |
| API | `routes/help.js` | `server/routes/help.js` |
| Gem (`POST /api/help-content`) | **kræver admin-login** (`requireAuth('admin')`) | **ingen adgangskontrol** ud over login-gaten foran tavlen |
| Delte hjælpesæt (`_shared` / `_include`) | ✅ | ❌ |
| Kun synlige elementer får badges | ✅ | ❌ (første match, også skjulte) |
| Panelet vælger side (⇄, husket i `localStorage`) | ✅ | ❌ (altid højre) |
| Mobil: klik i panelet lukker det og viser elementet | ✅ | ❌ |
| Brugsstatistik når hjælpen åbnes (`help_open`) | ❌ | ✅ |

**Ret bevidst.** En rettelse i den ene kopi hører næsten altid også hjemme i den anden.
Skal whiteboard have bon-v2's forbedringer, er det sikreste at kopiere bon-v2's filer over
og lægge `help_open`-linjen ind igen (i `show()`).

---

## Filerne og API'et

- **Logik og styling** er statiske filer, som sider inkluderer.
- **Teksterne** ligger i `data/help-content.json` — det eneste der ændres i drift. Filen
  serveres **ikke** statisk; den læses og skrives via API'et og ligger i `data/`, som ikke
  røres af deploy.
- `GET /api/help-content` — hele indholdet (offentligt).
- `POST /api/help-content` — erstatter **hele** filen med request-body.

---

## Integration på en side

1. Inkludér `help-system.css` i `<head>` og `help-system.js` nederst i `<body>`
   (bon-v2: `/shared/…`, whiteboard: `/…`).
2. Sæt sidenøgle og -navn på `<body>` eller en wrapper:
   ```html
   <body data-help-page="kitchen-today" data-help-page-name="Køkken — I dag">
   ```
3. **Single-page views:** kald `HelpSystem.setPage(nøgle, navn)` når visningen skifter.

En ny sidenøgle oprettes automatisk i indholdet første gang siden indlæses.
Elementerne markeres **ikke** i koden — det sker i browseren (se kortlægning).

---

## To tilstande

### H — hjælpetilstand
Nummererede badges på de kortlagte elementer, sidepanel med forklaringerne, tooltip ved
hover. `H` igen eller `Escape` lukker. Kan også åbnes med `?`-knappen.

### Ctrl+Shift+H — kortlægningstilstand
Til at *bygge* hjælpeteksterne, ikke til daglig brug. Elementer får stiplet kant
(grøn = allerede kortlagt). Klik på et element → popup med nøgle, label og tekst.
Ved gem genereres en **CSS-selector** (id > klasser > nth-child), som gemmes sammen med
teksten. Kortlægning gemmer altid i sidens egne `elements` — aldrig i et delt sæt.

Genvejene virker ikke mens fokus står i `input`, `textarea` eller `select`.
`Ctrl+Shift+H` (ikke `Ctrl+H`), fordi `Ctrl+H` åbner historikken i browseren.

---

## `data/help-content.json`

```json
{
  "_shared": {
    "modal": {
      "modal-historik": { "selector": ".changelog-list", "label": "Historik", "text": "…" }
    }
  },
  "kitchen-today": {
    "_pageName": "Køkken — I dag",
    "_include": ["modal", "bon-kort"],
    "elements": {
      "filter-leverede": { "selector": "#btnLev", "label": "Vis leverede", "text": "…" }
    }
  }
}
```

- Yderste nøgle = sidenøglen. Elementer findes via `selector`.
- **Delte sæt (kun bon-v2):** komponenter der går igen på mange sider (modal, bon-kort,
  bon-drawer, indkøbs-chips, varemodtagelse, optælling) har deres tekster ét sted under
  `_shared`. En side trækker dem ind med `"_include": [...]`. Sidens egne punkter vinder
  ved navnesammenfald, så én side kan skrive en delt tekst om uden at røre de andre.
- **Selectorer er skrøbelige:** et omdøbt `id` eller en ændret DOM-struktur får en
  hjælpetekst til stille at forsvinde. Tjek med hjælpetilstand efter større ændringer i
  markup, og kortlæg elementet igen hvis det mangler.

### Sidenøgler

| App | Nøgler |
|---|---|
| bon-v2 køkken | `kitchen-today`, `-later`, `-calendar`, `-planning`, `-purchasing`, `-recipes`, `-stock`, `-logistik`, `-vagtplan`, `-dashboard` |
| bon-v2 office (SPA) | `office-<view>`, fx `office-bons`, `office-planning`, `office-fakturering`, `office-tilbud` |
| bon-v2 mobil (SPA) | `mobile-<view>`, fx `mobile-bons`, `mobile-modtag`, `mobile-lager` |
| whiteboard | `whiteboard-tavle`, `whiteboard-vagtplan`, `whiteboard-rapport-hygiene`, `whiteboard-rapport-drift`, `whiteboard-rapport-deviations` |

bon-v2 settings og whiteboards `/admin` bruger ikke hjælpesystemet.

---

## Arbejdsgang for en ny side

1. Tilføj `data-help-page` / `data-help-page-name` (eller `setPage` for et view) og deploy.
2. Åbn siden, tryk **Ctrl+Shift+H**, klik de vigtige elementer og skriv teksterne.
   (bon-v2: log ind som admin først, ellers afvises gem.)
3. Går en komponent igen på flere sider (bon-v2), så flyt teksterne til `_shared` og brug
   `_include` i stedet for at kortlægge den på hver side.
4. Tryk **H** og læs det hele igennem som en ny medarbejder ville.

---

## Kendte begrænsninger

- **Ingen historik.** Et gem erstatter hele filen. Tag en kopi af `data/help-content.json`
  før større omskrivninger.
- **Sidste gem vinder.** To der kortlægger samtidig, overskriver hinanden.
- **Intet admin-panel til teksterne.** Tekster rettes ved at kortlægge elementet igen, eller
  direkte i JSON-filen. `_shared` / `_include` redigeres kun i filen.
- **whiteboard: gem kræver ikke admin** (se tabellen øverst).

---

## Forskelle fra det oprindelige design (juni 2026)

Systemet blev bygget ud fra en prototype, nu i `whiteboard/docs/prototypes/help-system-demo-v3.html`.
Det første tillæg beskrev prototypens design; det blev ændret sådan her:

| Oprindeligt | Bygget |
|---|---|
| `data-help="nøgle"` på elementerne i HTML | CSS-selector gemt i JSON — ingen attributter i kildekoden |
| `public/help-content.json` som statisk fil | `data/help-content.json` via `GET/POST /api/help-content` |
| `Ctrl+H` til kortlægning | `Ctrl+Shift+H` |
| Admin-panel på `/admin/help` med "mangler tekst"-liste | Ikke bygget |
| Nøgler som `tavle`, `bon-ordrer`, `wb-admin` | Se "Sidenøgler" |
