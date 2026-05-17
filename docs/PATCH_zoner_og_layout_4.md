# Patch til `bon_v2_zoner_og_layout.md` §4 — Office Sidebar

> **Mål:** (1) Bringe docs i overensstemmelse med faktisk implementeret sidebar i
> `office/index.html` (grupperede sektioner, pills inden i sektioner, ikon-row i bunden),
> og (2) tilføje "Opskrifter & priser" som nyt sidebar-punkt under Økonomi-gruppen.

---

## Ændring 1 — Sidebar-struktur (linje 121–154)

**Erstat den eksisterende blok:**

````markdown
### Sidebar-struktur

> **Status: Besluttet · Marts 2026**

```
OFFICE SIDEBAR
│
├── Dashboard                    ← daglig briefing, alerts, serviceopkald-påmindelse
│
├── Bons                         ← listview + kalender (views deles med kitchen)
│
├── CRM
│   ├── Pipeline                 ← kanban på forespørgsler og tilbud
│   ├── Tilbud                   ← filtreret bon-visning (is_offer=1), PDF, send
│   ├── Kunder                   ← liste, 360°-profil, sovende
│   ├── Serviceopkald            ← mandagsliste, callbacks, svære-at-nå
│   └── Aktiviteter              ← mine opgaver i dag
│
├── Planlægning / Logistik       ← ruter, leveringer, tracking, bud-QR (senere)
│
├── Køkken                       ← opskrifter + lagerstatus (read-access fra office)
│
├── Indkøb                       ← leverandørpriser, aftaler, Hørkram-mapping
│
├── Vagtplan                     ← Smartplan embed
│
├── Fakturering                  ← e-conomic integration, EAN-håndtering
│
├── Rapporter
│
├── 📋 Whiteboard                ← sidekick-panel ELLER fuld side; link til SOP herfra
│
└── ⚙ Settings                  ← installations-konfiguration (eget shell)
```
````

**Med denne blok der matcher faktisk implementation:**

````markdown
### Sidebar-struktur

> **Status: Besluttet · Marts 2026 · Opdateret maj 2026 (matcher faktisk implementation)**

Office-sidebaren er grupperet i sektioner. Hvert sidebar-link åbner en
section-view; hvor sektionen har undersider, vises de som **pills** øverst i
content-området (ikke som nestede sidebar-punkter).

```
OFFICE SIDEBAR
│
├── OVERBLIK
│   └── 🏠 Dashboard
│
├── ORDRER
│   └── 📋 Bons                     pills: Liste · Kalender · Uge · Plan · Nye web-ordrer
│
├── SALG
│   ├── 👥 CRM                      pills: Pipeline · Kontakter · Indbakke · Prospekter · Reaktivering · Indsigt
│   └── 💬 Tilbud
│
├── DRIFT
│   ├── 🚚 Logistik
│   └── 🛒 Indkøb                   pills: Indkøbsliste · Bestillinger · Leverandører · Leverandørpost
│
├── ØKONOMI
│   ├── 💰 Økonomi                  pills: Fakturering · Pengestrøm · Rapporter
│   └── 📊 Opskrifter & priser     ← NY · margin-analyse, kost vs. salg, DB%-mål
│
└── TEAM
    └── 📅 Vagtplan                 ← eksternt link til /kitchen/vagtplan.html

SIDEBAR-BOTTOM (ikon-row, ikke navigation):
[📋 Whiteboard]  [📖 SOP]  ···  [⚙ Settings]  [↩ Log ud]
```

**Routing-mekanik** (i `office/index.html`):
- `PILLS[section]` definerer underviser pr. section
- `SECTION_VIEW_MAP[section]` mapper (section, pill) → internt view-navn
- Sidebar-knapper bruger `data-view="<section>"` — pillen sættes via URL-hash eller default
````

---

## Ændring 2 — Principper (linje 156–162)

**Tilføj følgende punkter** til listen:

````markdown
- Undersider af en sektion vises som pills øverst i content-området, ikke som
  nestede sidebar-punkter (max ét niveau i sidebar)
- Whiteboard, SOP, Settings og Log ud er ikon-knapper i sidebar-bottom, ikke
  almindelige nav-links
- ØKONOMI-sektionen samler alt der vedrører penge — cashflow, fakturering,
  rapporter (alle pills i Økonomi-viewet) og margin pr. opskrift (separat
  punkt grundet egen URL og selvstændig viewstørrelse). Alle analyse-views
  i sektionen viser tal ex moms per `shared/moms.js`-doktrin
````

---

## Ændring 3 — Ny undersektion efter "Logistik i Office"

**Tilføj efter "Logistik i Office"-blokken (omkring linje 170):**

````markdown
### Opskrifter & priser i Office
Margin-analyse-view i ØKONOMI-sektionen. Eget sidebar-punkt (ikke pill i
Økonomi-viewet) grundet selvstændig viewstørrelse:

- Tabel-overblik over alle Grocy-opskrifter med kostpris, salgspris, DB% og
  12 mdr salgs-sparkline
- Klikbare KPI-filtre (under mål, mangler pris, ikke solgt, øko)
- Drill-down side-panel med ingrediens-breakdown, volumengraf og inline
  redigering af salgspriser pr. priskategori
- Alle priser ex moms — basis-pill `[ALLE PRISER EX MOMS]` tydeligt vist i topbaren
- Cached kostpriser fra Grocy fulfillment (manuel + nightly refresh)

Se `CLAUDE_OPSKRIFTER.md` for komplet spec.
````

---

## Ændring 4 — Beslutningslog (§12)

**Tilføj følgende rækker** øverst i tabellen:

````markdown
| Maj 2026 | Office-sidebar docs opdateret til at matche faktisk grupperet implementation (6 sektioner + sidebar-bottom ikon-row) |
| Maj 2026 | Opskrifter & priser tilføjet under ØKONOMI som eget sidebar-punkt (ikke pill) — selvstændig view-størrelse retfærdiggør egen URL |
| Maj 2026 | `item_prices` cementeret som single source of truth for salgspriser (Grocy-userfield kun til engangs-migration) |
````

---

## Konkret kode-ændring i `office/index.html`

To steder skal røres:

### 1) Tilføj sidebar-link (efter linje 616, før `<div class="sidebar-group-label">Team</div>`)

```html
          <button class="sidebar-link" data-view="opskrifter">
            <span class="sidebar-icon">📊</span> Opskrifter & priser
          </button>
```

### 2) Tilføj til `SECTION_VIEW_MAP` (efter `okonomi:` blokken, omkring linje 967)

```javascript
        opskrifter: { _default: 'opskrifter' },
```

`PILLS`-objektet skal **ikke** udvides (ingen pills i denne view).

Det interne view-navn `'opskrifter'` registreres i viewets egen mount-fil
(`office/views/opskrifter.js`) sammen med de andre views.

---

## Validering efter merge

- [ ] Sidebar viser nyt punkt 📊 under "Økonomi"-gruppe
- [ ] Klik på punktet routes til `office/views/opskrifter.js`
- [ ] `data-view="opskrifter"` matcher i sidebar og `SECTION_VIEW_MAP`
- [ ] Ingen pill-bar over content (Økonomi-viewet har stadig sine 3 pills)
- [ ] Docs og kode matcher — andre afvigelser bør fixes i samme PR
