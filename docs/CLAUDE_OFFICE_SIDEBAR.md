# CLAUDE_OFFICE_SIDEBAR.md
## Office sidebar v2 — konsolidering fra 23 til 8 punkter

> **Status:** Spec klar til implementering · Maj 2026
> **Beslutter:** Leif (designgennemgang afsluttet)
> **Autoritative dokumenter:** `BON_V2_PRINCIPPER.md`, `bon_v2_datamodel_v2.md`, `bon_v2_zoner_og_layout.md` (§4 Office)
> **Mockup:** `office_sidebar_v3.html` (klikbar reference)

---

## 1. Hvorfor

Office-sidebaren er vokset fra de oprindeligt besluttede 11 punkter (`bon_v2_zoner_og_layout.md` §4) til 23 punkter på ét niveau. Sidebaren scroller, sektionerne er rodede, og samme datatype (bons) optræder som flere top-level punkter (Bons, Kalender, Ugeoversigt, Planlægning, Nye bestillinger).

**Princip:** *Hovedpunkter i sidebaren = arbejdsområder. Views/filtre inden i området = pills i toppen af content-arealet.*

Resultat: 8 sidebar-punkter + kontekstuelle pills + sidekicks som ikoner i footer.

---

## 2. Sidebar-struktur (final)

```
SIDEBAR (mørk brun, 220px)
├── Header (klikbar — skifter til Køkken)
│     🍞 Ristet Rug
│     BON V2 · OFFICE              [⇄ KØKKEN]
│
├── OVERBLIK
│   └── 🏠 Dashboard
│
├── ORDRER
│   └── 📋 Bons                    [badge: nye bons]
│
├── SALG
│   ├── 👥 CRM                     [badge: indbakke umatched]
│   └── 💬 Tilbud
│
├── DRIFT
│   ├── 🚚 Logistik
│   └── 🛒 Indkøb
│
├── ØKONOMI
│   └── 💰 Økonomi
│
├── TEAM
│   └── 📅 Vagtplan
│
└── FOOTER (mørkere brun)
    ├── Ikon-række: 📋 Whiteboard · 📖 SOP · (spacer) · ⚙ Settings · ↩ Log ud
    └── 👤 Admin · Administrator
```

**Antal items:** 8 navigations-items (mod 23 i dag).

---

## 3. Pill-system

Hver sidebar-section (undtagen Dashboard og Vagtplan) har en række **pills** i toppen af content-arealet. Pills er kontekstuelle — de skifter helt baseret på hvilken section der er valgt.

| Section   | Pills (default først, rækkefølge bevares)                                          | Badge-kilder |
|-----------|------------------------------------------------------------------------------------|--------------|
| Dashboard | *(ingen pills)*                                                                    | — |
| Bons      | Liste · Kalender · Ugeoversigt · Planlægning · Nye                                 | `Nye` = count(bons WHERE status='NY') |
| CRM       | Pipeline · Kontakter · Indbakke · Prospekter · Re-aktivering · Indsigt             | `Indbakke` = count(crm_unmatched_emails WHERE resolved=0) |
| Tilbud    | Aktive · Sendt · Vundet · Tabt · Arkiv                                             | `Aktive` = count(bons WHERE is_offer=1 AND offer_status='open') |
| Logistik  | I dag · Ruter · Tracking · Bud                                                     | — |
| Indkøb    | Indkøbsliste · Bestillinger · Leverandører · Leverandørpost                        | `Leverandørpost` = count(unread supplier mails) |
| Økonomi   | Fakturering · Pengestrøm · Rapporter                                               | `Fakturering` = count(bons WHERE status='LEVERET' AND faktura_id IS NULL) |
| Vagtplan  | *(ingen pills — Smartplan iframe fylder hele content)*                             | — |

**Visuelt design (CSS-tokens fra `shared/tokens.css`):**
- Border-radius: `999px` (fuldt rundede)
- Default: `background: var(--gray-light); color: var(--gray-dark); border: 1px solid transparent`
- Hover: `background: white; color: var(--brown); border-color: var(--gray)`
- Active: `background: var(--brown); color: white; box-shadow: 0 2px 6px rgba(142,99,31,0.25)`
- Pill-badge: rød cirkel `var(--red)`, hvid tekst, 10px font

---

## 4. URL-routing (deep links)

**Behold den nuværende querystring-model.** Tilføj `pill`-parameter til eksisterende `?view=X`.

Format: `?view=<section>&pill=<pill>` — alt valgfrit, drawer kombineres via `&bon=<id>`.

| URL                                       | Result |
|-------------------------------------------|--------|
| `/office/`                                | Default til `?view=dashboard` |
| `/office/?view=dashboard`                 | Dashboard |
| `/office/?view=bons`                      | Bons → default-pill (`liste`) |
| `/office/?view=bons&pill=kalender`        | Bons → Kalender-pill aktiv |
| `/office/?view=bons&pill=nye`             | Bons → Nye-pill aktiv |
| `/office/?view=crm&pill=indbakke`         | CRM → Indbakke-pill aktiv |
| `/office/?view=tilbud&pill=aktive`        | Tilbud → Aktive-pill aktiv |
| `/office/?view=okonomi&pill=pengestrom`   | Økonomi → Pengestrøm-pill aktiv |
| `/office/?view=bons&pill=liste&bon=139`   | Bons-liste + drawer på bon #139 |
| `/office/?view=bons&pill=ukendt`          | Fallback: Bons → default-pill |
| `/office/?view=ukendt`                    | Fallback: `?view=dashboard` |

**Hvorfor querystring i stedet for hash?**
- Bagudkompatibel: gamle bookmarks (`?view=fakturering`) virker uden ekstra kode
- `window.officeGoto()`, `openKunde360()`, drawer-deeplink (`?bon=139`) virker uændret
- Server kan lave 301-redirect ved behov (hash sendes ikke til serveren)
- Ingen praktisk fordel ved hash når vi har en backend-shell

**Implementering** i `office/index.html` shell:
- `switchView(viewName, pill?)` udvides med pill-parameter
- Eksisterende views beholder deres `init()`-funktion. **Vi rører IKKE de 6 CRM-filer, 3 økonomi-filer osv.** — i stedet laver vi tynde router-filer (se §7).
- URL synkroniseres via `history.pushState` som i dag.

---

## 5. Zone-switch i header

Hele logo-området `.sidebar-logo` er klikbart. Ét klik = `window.location.href = '/kitchen/'`.

```html
<div class="sidebar-logo" onclick="location.href='/kitchen/'" title="Skift til Køkken-zone">
  <div class="sidebar-logo-title">🍞 Ristet Rug</div>
  <div class="sidebar-logo-row">
    <span class="sidebar-logo-zone">BON V2 · OFFICE</span>
    <span class="sidebar-logo-switch">
      <span class="sidebar-logo-switch-icon">⇄</span>
      <span class="sidebar-logo-switch-label">KØKKEN</span>
    </span>
  </div>
</div>
```

**Visuel cue:** "⇄ KØKKEN"-pillen i højre side af header. Ved hover lyser den orange (`var(--orange)`).

### "Tilbage til Office"-knap i Kitchen-shell

I `shared/kitchen-topbar.html` tilføjes en knap der **kun vises for users med rolle `office`, `admin` eller `salg`**:

```html
<button class="back-to-office" id="back-to-office" style="display:none"
        onclick="location.href='/office/'">
  ← Tilbage til Office
</button>
```

Show-logikken sker via plain JS (vi bruger ikke Vue i kitchen-zonen):

```javascript
// I kitchen-shell efter checkAuth() har leveret user-objekt
if (['office','admin','salg'].includes(user.role)) {
  document.getElementById('back-to-office').style.display = '';
}
```

Placering: Venstre side af kitchen-topbar, før det første nav-punkt. Subtil styling (samme højde som topbar-knapper men sekundær farve).

**Rationale:** Køkkenrollerne (`kok`, `koekkenchef`) skal ikke kunne navigere til Office. Office-brugere der hopper ind for at se hvad der sker skal kunne komme retur uden at gå via en menu.

---

## 6. Footer-ikoner

Fire kompakte ikon-knapper (34x34px), grupperet med en `flex:1` spacer i midten:

```
┌────────────────────────────────────┐
│  📋   📖     ·     ⚙    ↩         │
│  WB   SOP        Set    Log out    │
└────────────────────────────────────┘
```

| Ikon | Tooltip | Action |
|------|---------|--------|
| 📋   | "Whiteboard" | `target="_blank"` til `https://whiteboard.ristetrug.dk` |
| 📖   | "SOP" | `target="_blank"` til `https://sop.ristetrug.dk` |
| ⚙    | "Settings" | `location.href = '/settings/'` |
| ↩    | "Log ud" | POST `/api/auth/logout`, redirect til login |

Whiteboard og SOP bevares som "åbn i nyt vindue"-links som i dag (i dagens sidebar er de allerede `<a target="_blank">`). Sidekick-overlay er en separat fremtidig opgave hvis vi vil have dem in-page — det ligger nu kun i kitchen-zonen (`shared/sidekick.js`).

Tooltips vises via CSS `::after` på hover (se mockup for implementation).

Under ikon-rækken: brugerinfo (avatar + navn + rolle).

---

## 7. Filer der skal røres

### Strategi: tynd per-section router

**Vi rører ikke de eksisterende view-filer.** I stedet laver vi en tynd router-fil pr. sidebar-section der vælger hvilken eksisterende init-funktion der skal kaldes baseret på pill.

Eksempel — `office/views/crm-router.js`:

```javascript
function initCRM(container, { pill }) {
  // Cleanup eventuel forrige pill-view
  if (typeof _crmCleanup === 'function') _crmCleanup();

  switch (pill) {
    case 'pipeline':   initCrmDashboard(container);     _crmCleanup = cleanupCrmDashboard;     break;
    case 'kontakter':  initKontakter(container);        _crmCleanup = cleanupKontakter;        break;
    case 'indbakke':   initCrmInbox(container);         _crmCleanup = cleanupCrmInbox;         break;
    case 'prospekter': initCrmProspekter(container);    _crmCleanup = cleanupCrmProspekter;    break;
    case 'reakt':      initCrmReaktivering(container);  _crmCleanup = cleanupCrmReaktivering;  break;
    case 'indsigt':    initCrmKundeindsigt(container);  _crmCleanup = cleanupCrmKundeindsigt;  break;
    default:           initCrmDashboard(container);     _crmCleanup = cleanupCrmDashboard;
  }
}
let _crmCleanup = null;
function cleanupCRM() { if (_crmCleanup) _crmCleanup(); _crmCleanup = null; }
```

Hver router er 30–50 linjer. Ingen eksisterende view-fil omskrives.

### Nye filer

| Fil | Ændring |
|-----|---------|
| `office/index.html` | Sidebar HTML reduceres til 8 punkter, footer-ikoner tilføjes, header zone-switch tilføjes, pills-container indsættes. `switchView()` udvides med pill-parameter |
| `office/views/bons-router.js` | Pills: liste, kalender, uge, planlægning, nye → kalder `initBonsList`, `initCalendar`, `initUgeoversigt`, `initPlanning`, `initWebOrders` |
| `office/views/crm-router.js` | Pills: pipeline, kontakter, indbakke, prospekter, reakt, indsigt → kalder eksisterende 6 init-funktioner |
| `office/views/indkob-router.js` | Pills: liste, best, lev, post → mounter `shared/indkob.js`, `shared/indkob_settings.js`, `shared/supplier_inbox.js` (genbrug, se §12) |
| `office/views/logistics-router.js` | Placeholder med "kommer snart"-side (se §13). Pills ignoreres indtil Spor 2 er bygget |
| `office/views/okonomi-router.js` | Pills: fakt, penge, rap → kalder `initFakturering`, `initCashflow`, `initRapporter` |
| `routes/nav.js` | Nyt backend-endpoint `GET /api/nav/badges` — samler `bons_nye`, `crm_indbakke`, `tilbud_aktive`, `indkob_leverandorpost`, `okonomi_fakturering` i ét kald (se §8) |
| `shared/tokens.css` | Tilføj pill-tokens hvis ikke allerede der (`--pill-radius: 999px` etc.) |
| `shared/components.css` | Tilføj `.pill`, `.pill.active`, `.pill-badge`, `.pills-row` |
| `shared/kitchen-topbar.html` | Tilføj "← Tilbage til Office"-knap (plain JS show/hide baseret på user.role) |

### Eksisterende view-filer (forbliver urørte)

Disse 13 filer beholdes præcis som de er — de kaldes bare fra de nye routere:

`bons-list.js`, `bons-calendar.js`, `ugeoversigt.js`, `planning.js`, `web-orders.js`,
`crm-dashboard.js`, `kontakter.js`, `crm-inbox.js`, `crm-prospekter.js`, `crm-reaktivering.js`, `crm-kundeindsigt.js`,
`tilbud.js`, `fakturering.js`, `rapporter.js`, `cashflow.js`, `dashboard.js`, `schedule.js`, `bon-detail.js`, `web-orders.js`, `mail.js`, `admin.js`

### Filer der slettes

| Fil | Hvad sker der |
|-----|---------------|
| `office/views/purchasing.js` (tom stub) | Slettes — erstattes af `indkob-router.js` |
| `office/views/logistics.js` (tom stub) | Slettes — erstattes af `logistics-router.js` |
| `office/views/offers.js` (tom stub) | Slettes — `tilbud.js` er den rigtige fil (intet pill-behov, ét view) |
| `office/views/invoicing.js` (tom stub) | Slettes — `fakturering.js` er den rigtige fil |
| `office/views/reports.js` (tom stub) | Slettes — `rapporter.js` er den rigtige fil |
| Køkken sidebar-link (read-only fra office) | Fjernes — zone-switch i header overtager |

---

## 8. Datakontrakter (badges)

Badges på sidebar-items og pills hentes via et samlet endpoint:

```
GET /api/nav/badges

Response:
{
  "bons_nye": 6,
  "crm_indbakke": 3,
  "tilbud_aktive": 12,
  "indkob_leverandorpost": 2,
  "okonomi_fakturering": 4
}
```

- Polles ved sidebar mount + når SSE event `nav:badges-changed` fires
- Cache-headers: `Cache-Control: no-cache`
- Tomme værdier (0) skjuler badgen visuelt

**SSE-trigger:** Backend emitter `nav:badges-changed` når:
- Bon-status ændrer til/fra NY
- Ny umatched mail i `crm_unmatched_emails`
- Tilbud skifter offer_status
- Leverandørmail modtages
- Bon når status LEVERET uden faktura

---

## 9. Acceptkriterier

- [ ] Sidebar har præcis 8 navigations-items + header + footer
- [ ] Køkken-punktet er fjernet fra sidebar
- [ ] Header er klikbar med "⇄ KØKKEN"-pill der lyser orange ved hover
- [ ] Klik på header navigerer til `/kitchen/`
- [ ] Kitchen-topbar viser "← Tilbage til Office" for office/admin/salg-roller (verificeret med rolle-skift)
- [ ] Hver sidebar-section (undtagen Dashboard og Vagtplan) viser de korrekte pills i toppen af content
- [ ] Pills er fuldt rundede, brun aktiv-state
- [ ] Pill-klik opdaterer URL'en til `?view=<section>&pill=<pill>`
- [ ] Deep links virker: `?view=bons&pill=kalender` lander direkte på Bons med Kalender-pill aktiv
- [ ] Drawer-deeplink virker stadig: `?view=bons&pill=liste&bon=139` åbner liste + drawer
- [ ] Gamle bookmarks virker: `?view=fakturering` lander på Økonomi → Fakturering-pill
- [ ] Ukendte URLs falder tilbage til default (section-default eller `?view=dashboard`)
- [ ] Badges på sidebar-items opdateres via SSE
- [ ] Pill-badges opdateres via SSE
- [ ] Footer-ikoner viser tooltips ved hover
- [ ] 📋 og 📖 åbner Whiteboard/SOP i ny fane (`target="_blank"`)
- [ ] ⚙ navigerer til `/settings/`
- [ ] ↩ logger brugeren ud
- [ ] Ingen hardcodede farver i ny CSS — alt via `--brand-*` og `--color-*` tokens
- [ ] Visuel match med `office_sidebar_v3.html` mockup

---

## 10. Out of scope

Ikke i denne opgave:

- Selve indholdet i hvert view (de eksisterer eller specces separat)
- Settings-zonens egen navigation (det er en separat shell)
- Bud-app routing
- Multi-language support
- Mobile-layout af office (office er desktop-first per `bon_v2_zoner_og_layout.md`)

---

## 11. Risici / opmærksomhedspunkter

| Risiko | Mitigation |
|--------|-----------|
| Bookmarks til gamle URLs (fx `?view=fakturering`) | Bagudkompatibel — querystring-modellen beholdes, så gamle bookmarks virker uændret. Kun nye pills-deeplinks tilføjes |
| Pill-badges kan blive ude af sync med sidebar-badges (samme tal vises to steder) | Ét endpoint (`GET /api/nav/badges`), ét opdateringsevent (`nav:badges-changed`) — aldrig dual source-of-truth |
| Office-brugere mister adgang til Køkken-read-only views (opskrifter, lager) | Disse views findes stadig — adgang sker via zone-switch til kitchen |
| Pills kan løbe ud på smalle skærme (CRM har 6, kan blade til 2 linjer) | `flex-wrap: wrap` er sat. Accepteret — vi ser an om det bliver et reelt problem |

---

## 12. Indkøb — genbrug af eksisterende komponenter

**Princip:** Vi bygger ikke en Office-specifik Indkøb-side. Vi genbruger de komponenter der allerede driver kitchen-zonen.

| Pill | Komponent | Hvor er den i dag |
|------|-----------|-------------------|
| Indkøbsliste | `shared/indkob.js` (mountes med default-state `view='liste'`) | Kitchen tab 1 (`kitchen/purchasing.html`) |
| Bestillinger | Samme `shared/indkob.js` (parameter `view='bestilt'` — filtrerer til bestilte items) | Samme komponent, scrolled til bestilt-sektion |
| Leverandører | `shared/indkob_settings.js` (`mode: 'page'`) | Settings → Indkøb (samme komponent) |
| Leverandørpost | `shared/supplier_inbox.js` | Office sidebar i dag — flyttes ind under Indkøb |

**Implementering — `office/views/indkob-router.js`:**

```javascript
let _ibCleanup = null;

function initIndkobOffice(container, { pill }) {
  if (typeof _ibCleanup === 'function') _ibCleanup();

  switch (pill) {
    case 'liste':
    case 'best':
      initIndkob(container, { initialView: pill === 'best' ? 'bestilt' : 'liste' });
      _ibCleanup = cleanupIndkob;
      break;
    case 'lev':
      initIndkobSettings(container, { mode: 'page' });
      _ibCleanup = cleanupIndkobSettings;
      break;
    case 'post':
      initSupplierInbox(container);
      _ibCleanup = cleanupSupplierInbox;
      break;
    default:
      initIndkob(container, { initialView: 'liste' });
      _ibCleanup = cleanupIndkob;
  }
}

function cleanupIndkobOffice() {
  if (_ibCleanup) _ibCleanup();
  _ibCleanup = null;
}
```

**Out of scope for office:** Varemodtagelse (kitchen tab 2). Den er touch-først (foto, temperaturer, FVST-toggles) og bør forblive i kitchen-zonen.

**Eventuelle udvidelser af komponenterne:**
- `shared/indkob.js` kan have brug for en `initialView`-parameter hvis den ikke allerede har det (tjek ved implementering — `_ibCurrentView` state findes muligvis allerede)
- `shared/indkob_settings.js` har allerede `mode: 'panel' | 'page'` — ingen ændring

---

## 13. Logistik — placeholder indtil Spor 2

**I dag findes ingen Logistik-side.** Leverings-features:
- "📦 BESTIL BUD"-sektion i bon-drawer (Spor 1 — manuel booking af By-expressen/Taxa)
- Per-bon "🗺 Kort"-action (Google Maps med leveringsadresse)

Spec'ens pills "I dag · Ruter · Tracking · Bud" hører alle til Spor 2 og er ikke bygget endnu.

**Strategi:** Logistik er top-level i sidebaren, men viser en placeholder-side med klart "kommer snart" + liste over planlagt indhold. Når Spor 2 udvikles, udskifter vi pill-by-pill uden at ændre sidebar-strukturen.

**Implementering — `office/views/logistics-router.js`:**

```javascript
function initLogistics(container, { pill }) {
  container.innerHTML = `
    <div class="page-title">Logistik</div>
    <div class="page-heading">Kommer snart</div>
    <div class="placeholder">
      <div class="placeholder-icon">🚚</div>
      <div class="placeholder-title">Logistik-modulet er under udvikling</div>
      <div class="placeholder-desc">
        Indtil videre bookes bud direkte fra hver bon — åbn en bon
        og brug "📦 BESTIL BUD"-sektionen i drawer.
      </div>
    </div>
    <div class="info-box">
      <b>Planlagt indhold (Spor 2):</b>
      <ul>
        <li><b>I dag</b> — dagens leveringer med live-status</li>
        <li><b>Ruter</b> — auto-genererede ruter via OSRM/VROOM</li>
        <li><b>Tracking</b> — live position fra mobile-courier app</li>
        <li><b>Bud</b> — egne cyklister + eksterne services</li>
      </ul>
    </div>
  `;
}

function cleanupLogistics() { /* nothing to clean */ }
```

**Per-bon-funktioner uændret:**
- BESTIL BUD i bon-drawer beholdes præcis som i dag (Spor 1)
- Google Maps-link på bon-kort beholdes
- Disse er per-bon actions — de hører ikke hjemme i sidebaren

**Når Spor 2 starter:** Spec'ens pills aktiveres en ad gangen (først "I dag", så "Ruter" osv.). Sidebar-strukturen ændrer sig ikke.

---

*Når implementering er klar: opdater `bon_v2_zoner_og_layout.md` §4 til at reflektere den nye 8-punkts struktur (i dag står 11). Beslutningsloggen tilføjes: "Maj 2026 — Office sidebar konsolideret fra 23 til 8 punkter, pills i toppen af content-areal, zone-switch flyttet til header."*

---

## Implementeringsbeslutninger (maj 2026)

Truffet efter spec-gennemgang:

1. **Routing**: Querystring (`?view=X&pill=Y`), ikke hash. Bagudkompatibel med eksisterende deep-links og drawer-URL'er.
2. **View-orkestrering**: Tynde per-section router-filer (`*-router.js`) der vælger eksisterende init-funktioner. Ingen omskrivning af de 13+ eksisterende view-filer.
3. **Indkøb**: Genbrug `shared/indkob.js`, `shared/indkob_settings.js`, `shared/supplier_inbox.js`. Varemodtagelse forbliver kitchen-only.
4. **Logistik**: Placeholder-side med "kommer snart" + planlagt indhold. Spor 1 (BESTIL BUD i bon-drawer) forbliver uændret.
5. **Backend**: Nyt `routes/nav.js` med `GET /api/nav/badges` samler de nuværende 3 badge-kald.
6. **Kitchen-topbar "Tilbage til Office"-knap**: Plain JS show/hide (ikke Vue) baseret på `user.role`.
7. **Whiteboard/SOP-ikoner**: `target="_blank"`-links som i dag — ingen in-page sidekick i office for nu.
