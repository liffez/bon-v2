# CLAUDE_SETTINGS_REORG.md
## Omstrukturering af Settings + udflytning af 4 fejlplacerede views

> **Formål:** Settings-sidebaren er drevet fra 8 dokumenterede grupper (layout-doc §6) til 23 flade
> punkter med én "Admin"-divider. Denne spec (1) omgrupperer sidebaren i navngivne sektioner, og
> (2) flytter fire views der **ikke er konfiguration** ud til de moduler hvor arbejdet hører hjemme.
>
> **Princip:** Settings = installations-/konfiguration, sjældent brugt (layout-doc §6). Operationer og
> master-data der bruges løbende, hører ikke til her. Vi redesigner strukturen — lapper ikke.

---

## 0. Verificeret kildegrundlag

> ⚠️ **Linjenumre er allerede skredet.** Snapshottet var 5256 linjer; filen er nu **5365** (+109).
> **Anker på `id`/funktionsnavn, ikke linjenummer** — alle intervaller nedenfor er kun pejlemærker.
> Linjenumrene står tilbage som hint, men `grep` efter id/funktion er den autoritative måde at finde
> blokkene på. Filen ændres ugentligt.

### 0a. Bekræftede fakta (verificeret i repo 3. juni 2026)

Disse var åbne "verificér"-punkter i den oprindelige spec — nu afklaret:

| Fakta | Konsekvens |
|---|---|
| Office bruger **ikke faner** — det er `sidebar-section` → `.pills-row` → `SECTION_VIEW_MAP` (`office/index.html`) | En "ny fane" = ny pill i `SUBVIEWS[section]` + entry i `SECTION_VIEW_MAP` (+ evt. ny `views/*.js`) |
| **`office/views/purchasing.js` findes IKKE** (slettet i Office sidebar v2) | Indkøb-modulet er pills i `indkob`-sektionen, ikke en purchasing-fil |
| Indkøb-config er **allerede monteret i office**: pill "Leverandører" (`indkob-lev`) kalder `initIndkobSettings(contentEl, {mode:'page'})` (`office/index.html` ~991) | **DEL 2 er reduceret til ren sletning** i settings — intet skal bygges i office (se DEL 2) |
| `shared/indkob_settings.{js,css}` er **allerede globalt indlæst i office-shellen** (`office/index.html` ~37 + ~799) | CSS/JS-link skal IKKE flyttes/duplikeres |
| Per-firma enrich findes **allerede**: `POST /api/companies/:id/enrich` + `GET /:id/enrich-preview` (`routes/companies.js`) + "⟳ Berig fra CVR"-knap m. modal på Firma 360° (`office/views/crm-firma360.js` ~183) | **DEL 4C er IKKE ny funktionalitet — den er bygget** (se DEL 4C) |
| `indkob_settings.js` har i dag 3 tabs (Leverandører/Produkter/Hørkram) — **ingen Duplikater-tab** | DEL 3 = ny pill/tab, ikke en flytning ind i eksisterende tab |
| CRM har pills (Pipeline/Kontakter/Kampagner/Indbakke/Prospekter/Re-aktivering/Indsigt) — **ingen "Værktøjer"** | DEL 4A = ny CRM-pill + view-fil |

### 0b. Blokke der røres (anker på id/funktion)

| Element | Anker |
|---|---|
| Nav-knapper | `<nav class="st-sidebar" id="st-sidebar">` (~495) |
| Content-paneler | `<div class="st-section" id="sec-{section}">`, ét pr. nav-punkt |
| Section-switch + lazy-init | switch-handler (~1508) |
| Bootstrap-loaders (admin) | bootstrap-blok (~1539) |
| Admin-gating | `currentUser.role !== 'admin'`-blok (~1500) — `#st-admin-sep` + `#st-admin-label` skjules |

Blokke for de tre der **flyttes** + den ene der **bliver**:

| Sektion | Panel-anker | Primær JS (grep efter navn) |
|---|---|---|
| `indkob` | `#sec-indkob` (container) | `initIndkobSettings` + lazy-init |
| `duplicates` | `#sec-duplicates` | `loadDuplicates`, `dup-filter`-handler, `dup-body` |
| `merge-companies` | `#sec-merge-companies` | `mergeGotoStep*`, `mergeVerifyCvr`, `mergeBackToStep`, `mergeCancel`, `mergeExecute`, søge-wiring `merge-winner-q`/`merge-loser-q` |
| `batch-enrich` (BLIVER) | `#sec-batch-enrich` | `beReviewSelectAll/FilterHigh/Cancel/Apply`, `#be-running`-flow |

---

## DEL 1 — Omgruppér Settings-sidebar

**Regel:** Behold alle `data-section`-id'er **uændret**. Skift kun (a) rækkefølge, (b) gruppe-labels,
(c) synlig knaptekst på to punkter. Switch-logikken og `#sec-*`-paneler røres ikke i denne del.

Erstat nav-blokken (495–519) med:

```html
<nav class="st-sidebar" id="st-sidebar">
  <button class="st-nav-item" data-section="this-device">Denne enhed</button>

  <div class="st-nav-label st-group">Adgang</div>
  <button class="st-nav-item" data-section="users">Brugere</button>
  <button class="st-nav-item" data-section="roles">Rollerettigheder</button>

  <div class="st-nav-label st-group">Team &amp; løn</div>
  <button class="st-nav-item" data-section="staff">Medarbejdere</button>
  <button class="st-nav-item st-admin-only" data-section="loen">Løn</button>

  <div class="st-nav-label st-group">Bon &amp; salg</div>
  <button class="st-nav-item" data-section="price-cats">Priskategorier</button>
  <button class="st-nav-item" data-section="pay-types">Betalingstyper</button>
  <button class="st-nav-item st-admin-only" data-section="tilbud">Tilbud — opbygning</button>
  <button class="st-nav-item st-admin-only" data-section="activity-purposes">Aktivitetsformål</button>
  <button class="st-nav-item st-admin-only" data-section="delivery-vehicles">Leveringsmetoder</button>
  <button class="st-nav-item st-admin-only" data-section="lego">Legoklods-kategorier</button>

  <div class="st-nav-label st-group">Formularer</div>
  <button class="st-nav-item st-admin-only" data-section="formbuilder">Formbuilder</button>
  <button class="st-nav-item st-admin-only" data-section="bestilling-menu">Bestilling — Menu</button>
  <button class="st-nav-item st-admin-only" data-section="booking-smagning">Booking — Smagsprøve</button>
  <button class="st-nav-item st-admin-only" data-section="booking-kontakt">Booking — Kontakt</button>

  <div class="st-nav-label st-group">Integrationer</div>
  <button class="st-nav-item st-admin-only" data-section="grocy">Grocy</button>
  <button class="st-nav-item st-admin-only" data-section="mail">Mail</button>

  <div class="st-nav-label st-group">System &amp; vedligehold</div>
  <button class="st-nav-item st-admin-only" data-section="system">System</button>
  <button class="st-nav-item st-admin-only" data-section="batch-enrich">Berig alle firmaer</button>
</nav>
```

**Bemærk:**
- `indkob`, `duplicates`, `merge-companies` er **fjernet** herfra (flyttes i Del 2–4).
- `batch-enrich` (Berig alle firmaer) **bliver i Settings** under "System & vedligehold" — det er en bevidst,
  tung bulk-operation der ikke skal være casual at udløse. Panel + JS uændret (se Del 4).
- Admin-gating pr. punkt er bevaret nøjagtigt som i originalen (kun `staff`, `users`, `roles`,
  `price-cats`, `pay-types`, `this-device` er ikke admin-only).
- To labels omdøbt for at undgå navnekollision med office-sidebaren:
  - `tilbud` → **"Tilbud — opbygning"** (SALG → Tilbud er selve listen; dette er blok-opbygningen)
  - `lego` → **"Legoklods-kategorier"** (selve rapporten ligger i office/Økonomi; dette er kun pax-kategori-config)
- Opdatér tilsvarende `<h2>` i `#sec-tilbud` (776) og `#sec-lego` (791) til de nye navne.

### Admin-gating skal opdateres (linje 1500–1502)

`#st-admin-sep` og `#st-admin-label` findes ikke længere → de to `getElementById(...).style` -linjer
**skal fjernes** (de kaster ellers på `null`). Erstat blokken med logik der også skjuler gruppe-labels
uden synlige punkter:

```js
if (currentUser.role !== 'admin') {
  document.querySelectorAll('.st-admin-only').forEach(el => el.style.display = 'none');
  // Skjul gruppe-label hvis alle dens punkter (frem til næste label) er skjult
  document.querySelectorAll('.st-sidebar .st-group').forEach(label => {
    let n = label.nextElementSibling, anyVisible = false;
    while (n && !n.classList.contains('st-group')) {
      if (n.classList.contains('st-nav-item') && n.style.display !== 'none') anyVisible = true;
      n = n.nextElementSibling;
    }
    if (!anyVisible) label.style.display = 'none';
  });
}
```

For en `koekkenchef` (delvis adgang) giver det: Denne enhed, Adgang, Medarbejdere, Priskategorier,
Betalingstyper synlige — Team&løn-label vises (staff synlig), Formularer/Integrationer/System skjules helt.

---

## DEL 2 — Fjern Indkøb-config-duplikatet fra Settings (allerede i office)

> **Revideret:** Indkøb-config er **allerede monteret i office-Indkøb-modulet** (pill "Leverandører" =
> `indkob-lev`, der kalder `initIndkobSettings(contentEl, {mode:'page'})`). `shared/indkob_settings.{js,css}`
> er allerede globalt indlæst i office-shellen. **Der skal derfor INTET bygges i office** — DEL 2 er
> ren sletning af duplikatet i Settings.

Indkøb-config er master-data for indkøbsmodulet (leverandører, Grocy-lokation-kobling, produkter,
Hørkram) — ikke en installations-indstilling. Lige nu lever den **to steder** (Settings + office Indkøb).
Vi fjerner Settings-kopien så office er den eneste indgang.

**Fjern fra `settings/index.html`:**

| ❌ | Hvad | Anker |
|---|---|---|
| ❌ | Nav-knap `data-section="indkob"` | (allerede fjernet i Del 1) |
| ❌ | Panel `#sec-indkob` | `#sec-indkob`-container |
| ❌ | Lazy-init `if (sec === 'indkob') …` | switch-handler + `_indkobSettingsInit`-flag |

**I office: intet at gøre.** Verificér blot at office-Indkøb → "Leverandører"-pill stadig åbner
`initIndkobSettings(...)` korrekt efter Settings-kopien er fjernet (de deler global JS-scope, men ingen
delt DOM-state — sletningen i Settings påvirker ikke office).

**Note (CSS-link):** Det oprindelige punkt om at "flytte/duplikere `indkob_settings.css` til office" er
unødvendigt — linket findes allerede i `office/index.html` (~37). Rør det ikke.

---

## DEL 3 — Flyt Produkt-duplikater ind i Indkøb-modulet

`#sec-duplicates` er **produkt**-duplikater i Grocy (opdaget når samme Hørkram-varenr. bruges af flere
produkter) — produkt-datavedligehold, ikke firma-CRM. Hører til Indkøb-modulet.

**Fjern fra `settings/index.html`:**

| ❌ | Hvad | Anker |
|---|---|---|
| ❌ | Panel `#sec-duplicates` | `#sec-duplicates` |
| ❌ | `loadDuplicates()` + render i `dup-body` | grep `loadDuplicates` (udtræk hele funktionen) |
| ❌ | `dup-filter`-change-handler | grep `dup-filter` |
| ❌ | `loadDuplicates()`-kald i bootstrap | grep `loadDuplicates(` i bootstrap-blok |

**Tilføj i office Indkøb-modulet (pill, ikke "fane"):**

1. Ny pill i `SUBVIEWS.indkob`-arrayet (`office/index.html` ~1040):
   `{ id: 'dup', label: 'Duplikater' }`
2. Entry i `SECTION_VIEW_MAP.indkob` (~1081): `dup: 'indkob-dup'`
3. Ny view-handler `'indkob-dup'` i view-switcheren der renderer panel-markup + kalder en flyttet
   `loadDuplicates()`. Da office-views deler global JS-scope (loades som plain `<script>`), kan
   `loadDuplicates` + filter-handler + række-handlinger (merge/ignore-knapper i `dup-body`) flyttes
   stort set 1:1 — men **grep efter funktionsnavnene globalt i office FØR flytning** for at undgå
   navnekollision.

**Alternativ (lettere):** Hvis Duplikater konceptuelt hører til de øvrige indkøbs-config-tabs, kan den i
stedet tilføjes som en 4. tab i `indkob_settings.js` (`data-idx="3"`, ved siden af Leverandører/Produkter/
Hørkram). Det holder al indkøbs-config ét sted og kræver ingen ny pill/SECTION_VIEW_MAP-entry. Vælg denne
hvis brugeren foretrækker at Duplikater ligger under "Leverandører"-pillen frem for som egen pill.

**Verificér:** hvilke API-endpoints `loadDuplicates` og række-handlingerne kalder — de skal være uændrede
efter flytning.

---

## DEL 4 — Firma-operationer: split mellem CRM og Settings

Skel mellem **per-virksomhed** (kontekstuel, diskret) og **bulk** (bevidst, friktion):

| Operation | Karakter | Placering |
|---|---|---|
| Berig **én** virksomhed mod CVR | Lille, kontekstuel | **CRM — inline på firma-profil** (ny, se 4C) |
| **Sammenlæg firmaer** | Bevidst, men hører til hvor man browser firmaer | **CRM → Værktøjer** (4A) |
| **Berig alle firmaer** (bulk) | Tung — "ikke noget man bare gør" | **Bliver i Settings** (4B) |

### 4A — Flyt Sammenlæg firmaer → CRM → Værktøjer

**Fjern fra `settings/index.html`:**

| ❌ | Hvad | Anker |
|---|---|---|
| ❌ | Panel `#sec-merge-companies` | `#sec-merge-companies` |
| ❌ | `merge*`-funktioner | grep `mergeGotoStep`, `mergeVerifyCvr`, `mergeBackToStep`, `mergeCancel`, `mergeExecute` + søge-wiring `merge-winner-q`/`merge-loser-q` (udtræk hele familien) |
| ❌ | Nav-knap `data-section="merge-companies"` | (allerede fjernet i Del 1) |

**Tilføj i CRM som ny pill** (CRM-frontend er `office/views/crm-*.js`; backend `routes/crm.js` røres ikke):

1. Ny pill i `SUBVIEWS.crm`-arrayet (`office/index.html` ~1026):
   `{ id: 'verktoj', label: 'Værktøjer' }` (placeres sidst — det er en bevidst, sjælden handling, ikke en top-knap).
2. Entry i `SECTION_VIEW_MAP.crm` (~1065): `verktoj: 'crm-verktoj'`.
3. Ny view-handler `'crm-verktoj'` + (anbefalet) ny fil `office/views/crm-verktoj.js` der indeholder
   panel-markup + hele `merge*`-familien + søge-wiringen, registreret som `<script>` i `office/index.html`.
   Alternativt kan markup+JS lægges i en eksisterende CRM-fil, men egen fil holder den 5365-linjers
   monolit-arv ude af office.
- `undo-merge.js`-referencen i hjælpeteksten er gyldig — backend uændret.
- **Verificér:** søgning (`merge-winner-q`/`merge-loser-q`) + merge-endpoint virker uændret; identitet
  fra `req.session.userId`, aldrig fra body. Grep `merge*`-navnene globalt i office før flytning (kollision).

### 4B — Berig alle firmaer (bulk) BLIVER i Settings

- Panel `#sec-batch-enrich` (877–1058) + `beReview*`-familien (4034–~4092) + `#be-running`-flow: **uændret, flyttes ikke.**
- Vises i ny "System & vedligehold"-gruppe (Del 1), admin-only. Dry-run-default + bekræftelse bevares som
  friktion — det er bevidst at det ikke er en casual handling.

### 4C — Per-virksomhed berigelse i CRM — ✅ ALLEREDE BYGGET (ingen handling)

> **Revideret:** Den oprindelige spec antog at dette var ny funktionalitet, fordi `routes/crm.js` ikke har
> et enrich-endpoint. Men berigelsen ligger på `routes/companies.js`, ikke `crm.js` — og UI'et findes
> allerede præcis hvor specen foreslog at tilføje det. **Byg ikke noget her.**

Verificeret eksisterende:

- **Backend (findes):** `GET /api/companies/:id/enrich-preview` (CVR-diff uden gem) +
  `POST /api/companies/:id/enrich` (anvend delmængde, udfyld kun tomme felter, marker CVR-kontaktpunkter
  `is_public=1`, opdatér `last_enriched_at`) — `routes/companies.js`. Bruger `services/cvrEnrichment.js`.
- **Frontend (findes):** "⟳ Berig fra CVR"-knap (`#f3-enrich-btn`) med fuldt modal-flow + visning af
  `last_enriched_at` på Firma 360°'s Oversigt-fane — `office/views/crm-firma360.js`.

**Eneste opgave (valgfri):** Verificér at knappen + diff-modal stadig virker end-to-end. Hvis den gør,
er 4C lukket uden kode. Hvis ikke, er det en bugfix på eksisterende kode — ikke en del af denne reorg.

> **Bemærk:** Byg IKKE `POST /api/crm/company/:id/enrich` — det ville duplikere `companies.js`-endpointet
> og skabe to kilder til samme handling.

---

## DEL 5 — JS-oprydning i settings/index.html

Efter Del 2–4A skal bootstrap-blokken (1539–1557) og switch-handleren (1508–1536) ryddes:

| Handling | Detalje |
|---|---|
| ❌ Fjern | `loadDuplicates()` fra bootstrap (1555) |
| ❌ Fjern | `_indkobSettingsInit` + indkob-lazy-init (1506, 1517–1520) |
| ❌ Fjern | `merge*`-funktionsfamilien (flyttet til CRM i 4A) |
| ✅ Behold | `beReview*` + batch-enrich (bliver i Settings, 4B) |
| ✅ Behold | `loadLegoCats()` (2702) og `loadActivityPurposes()` (2866) — config, bliver i Settings |
| ✅ Behold | `loadStaffMembers`, `loadPriceCategories`, `loadPaymentTypes`, `loadWageRates` osv. |
| ❌ Verificér | ingen efterladte referencer til de flyttede funktioner/elementer (grep efter `sec-indkob`, `sec-duplicates`, `merge-`, `dup-` i settings — **men ikke** `be-`/`batch-enrich`, de bliver) |

---

## Hvad Claude Code SKAL verificere i repo

Afklaret i §0a (verificeret 3. juni 2026):

| ✅ | Afklaret |
|---|---|
| ✅ | Office-mekanik = pills + `SECTION_VIEW_MAP`, ikke faner. `office/views/purchasing.js` findes ikke |
| ✅ | CRM-frontend = `office/views/crm-*.js`. `routes/crm.js` er backend |
| ✅ | `shared/indkob_settings.{js,css}` er allerede globalt indlæst i office-shellen |
| ✅ | Indkøb-config er allerede monteret i office (pill "Leverandører") → DEL 2 = ren sletning |
| ✅ | Per-firma enrich findes allerede (`companies.js` + Firma 360°) → DEL 4C = ingen kode |

Stadig at verificere før patch:

| ❌ | Punkt |
|---|---|
| ❌ | Re-grep alle id/funktionsnavne — linjenumre er forældede (5256 → 5365) |
| ❌ | Præcise API-endpoints brugt af `loadDuplicates` og `merge*` (skal være uændrede efter flytning) |
| ❌ | Ingen global navnekollision når `loadDuplicates`/`merge*` flyttes ind i office (delt `<script>`-scope) |
| ❌ | At de flyttede paneler arver office-zonens densitet (`body.zone-office`) korrekt — `indkob_settings.css` gør det allerede |

---

## Status: ✅ GENNEMFØRT (3. juni 2026)

Hele reorg'en er implementeret, browser-verificeret og merget til main:

| Trin | PR | Indhold |
|---|---|---|
| Hotfix | #148 | Dobbelt `ROLE_LABELS` brækkede hele settings-scriptet (fundet undervejs, prod-bug) |
| DEL 1 | #149 | Grupperet sidebar (6 grupper) + admin-gating-fix + 2 omdøbninger |
| DEL 2 | #150 | Fjern indkøb-config-dublet (var allerede i office) |
| DEL 3 | #151 | Duplikater → office Indkøb, 4. tab i Indkøbsindstillinger |
| DEL 4A | #152 | Sammenlæg firmaer → CRM → Værktøjer (`office/views/crm-verktoj.js`) |
| DEL 4B | — | Berig alle firmaer: urørt, bliver bevidst i Settings |
| DEL 4C | — | Per-firma enrich: var allerede bygget, ingen kode |

Besluttede åbne valg: Duplikater = 4. tab (ikke egen pill); Leveringsmetoder + Bestilling-Menu bliver i Settings (se "Oversete kandidater").

---

## Acceptkriterier

| ✅ | Kriterium | Leveret af |
|---|---|---|
| ✅ | Settings-sidebar viser 1 standalone + 6 navngivne grupper; ingen flad "Admin"-blok | DEL 1 (#149) |
| ✅ | Alle tilbageblevne nav-punkter skifter til korrekt `#sec-*`-panel (data-section-id'er uændret) | DEL 1 (#149) |
| ✅ | Ikke-admin ser kun tilladte punkter; tomme gruppe-labels skjules; ingen JS-fejl på `null` | DEL 1 (#149) — verificeret med kitchen-rolle (3 grupper) |
| ✅ | Indkøb-config åbner i Indkøb-modulet via `initIndkobSettings(el,{mode:'page'})` og fungerer fuldt | Allerede i office; Settings-dublet fjernet i DEL 2 (#150) |
| ✅ | Produkt-duplikater fungerer som fane i Indkøb-modulet (liste, filter, merge/ignore) | DEL 3 (#151) — 4. tab |
| ✅ | Sammenlæg firmaer fungerer under CRM → Værktøjer (søgning, 3-trins wizard, undo) | DEL 4A (#152) |
| ✅ | Berig alle firmaer (bulk) fungerer uændret i Settings → System & vedligehold | DEL 4B — urørt |
| ✅ | (4C) Per-firma "Berig fra CVR" findes allerede på Firma 360° (`companies.js`-endpoint) | Allerede bygget — ingen kode |
| ✅ | "Tilbud — opbygning" og "Legoklods-kategorier" er omdøbt i både nav og `<h2>` | DEL 1 (#149) |
| ✅ | Ingen efterladte/døde referencer i `settings/index.html` (grep rent) | Verificeret i DEL 2/3/4A |
| ✅ | Ingen console-fejl i settings-/indkøb-/CRM-zonen efter flytning | Verificeret (eneste fejl = lokal `GROCY_HQ_KEY`, miljø-specifik) |

---

## Anbefalet PR-rækkefølge (split, ikke én stor ændring)

Specen rører tre uafhængige ting med vidt forskellig risiko. Split for at holde blast-radius lav:

1. **PR 1 — DEL 1 (omgruppering) + admin-gating-fix.** Ingen logik rørt, kun nav-markup + den `null`-crash-
   sikre gating-blok. Lav-risiko, giver straks værdi. Kan merges alene.
2. **PR 2 — DEL 2 (slet indkøb-duplikat) + DEL 5 (JS-oprydning for indkob).** Ren sletning, intet bygges.
3. **PR 3 — DEL 3 (Duplikater → office) + DEL 4A (Merge firmaer → CRM).** Den egentlige JS-ekstraktion ud af
   monolitten — den risikable del. Verificér navnekollision + endpoints. Hold den adskilt så den kan
   rulles tilbage uden at tabe PR 1+2.

DEL 4C kræver ingen PR (allerede bygget). DEL 4B rører intet (bliver hvor den er).

---

## Åbne valg

- **Sammenlæg firmaer → CRM → Værktøjer.** Det er en bevidst handling (wizard + undo), ikke en top-knap.
  Hvis du hellere vil have den i Settings ved siden af bulk-enrich, så sig til.
- **Duplikater: egen pill vs. 4. tab i `indkob_settings`** (se DEL 3-alternativet). Vælg ét.

## Oversete kandidater (konsistens-tjek mod princippet) — BESLUTTET

Princippet er "Settings = sjælden installations-config; løbende master-data/operationer hører i modulet".
To punkter ligner master-data der burde flytte ud — men begge **bliver i Settings** efter bevidst vurdering:

### Leveringsmetoder → BLIVER i Settings

Ægte installations-config, ikke operation:
- Lille, **fast sæt** (Volvo, cykel, By-expressen, Taxa) der sættes op **én gang** med template, prisformel
  og `booking_fields_json` — derefter sjældent rørt.
- Den **operationelle** brug (booke et bud) sker i bon-draweren + logistik, ikke her.

Den optiske lighed med leverandører (også master-data, men flyttes UD) opløses af frekvens + kobling:
leverandør-config redigeres *løbende som del af indkøbsworkflowet*, køretøjer er statiske. **Ingen flytning.**

### Bestilling — Menu → BLIVER i Settings, under "Formularer"-gruppen (DEL 1)

- Embed-bestillingen **er** en formular; dens menu + cutoff + `delivery_days` er formularens konfiguration.
  "Formularer"-gruppen (Formbuilder, Bestilling-Menu, Booking ×2) er et sammenhængende, korrekt hjem.
- Der findes **intet menu-/drift-modul i office** — en flytning koster en ny office-sektion uden oplagt hjem,
  og editoren er allerede bygget og fungerer i Settings.
- Menuen skifter sæsonvis, ikke dagligt → tættere på config end operation. **Ingen flytning, intet nyt modul.**
  Revisitér kun hvis menu-redigering reelt bliver hyppig nok til at det generer.

### Hvis discoverability bekymrer (let mellemvej, valgfri)

Problemet er i så fald "kan ikke findes fra modulet" — løses med **deep-links**, ikke flytning:
- "✏️ Rediger menu" fra relevant office-sted → Settings → Bestilling-Menu
- "🚚 Leveringsmetoder" fra logistik → Settings → Leveringsmetoder

Giver findbarhed uden at splitte config to steder. Ikke en del af denne reorg — noteret som mulighed.
