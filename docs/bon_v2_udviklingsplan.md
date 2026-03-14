# Bon v2 — Overordnet udviklingsplan
*Opdateret: marts 2026*

---

## Hvad der allerede eksisterer

### Fundament (klar til brug)
| Artefakt | Status |
|----------|--------|
| Databaseskema — 6 migrationsfiler | ✅ Færdigt |
| Express server, SQLite, SSE, statusflow, changelog | ✅ Kører |
| Arkitekturbeslutninger (mail, settings, moduler, Grocy) | ✅ Besluttet |
| Designsystem + zone-struktur | ✅ Dokumenteret |
| Nano CRM prototype (`crm_server.py`) | ✅ Fungerende |
| CVR/EAN lookup tool | ✅ Bygget |

### Mockups (reference for implementation)
| Mockup | Version |
|--------|---------|
| Køkken I dag | v3.4 → implementeret |
| Dashboard | v1 |
| Varemodtagelse | v2 |
| Tilbud (office) | v3b |
| Bon-kort | v3.6 → implementeret |
| Nano CRM | mockup + overblik |

### Standalone tools (skal integreres)
| Tool | Integration |
|------|-------------|
| Formbuilder v6 | → Fase 4 |
| Leveringsberegner (intern + kunde) | → Fase 5 |
| Byekspressen prisberegner | → Fase 5 |
| Smartplan vagtplan-UI | → Fase 2 (dashboard) |
| Nano CRM prototype | → Fase 4 |
| CVR enrichment service + `cvr-opslag.html` | → Fase 4 (i brug som standalone allerede) |
| IMAP fetch-prototype (`fetch-mails.js`, imapflow) | → Fase 4 (forbindelse virker, parsing mangler) |

---

## Arkitekturlag
*Backend-services der er delt på tværs af zoner — bygges inden de bruges*

| Lag | Indhold | Bruges af |
|-----|---------|-----------|
| **Infrastruktur** | Express, SQLite, SSE, auth, roller | Alt |
| **Bon-kerne** | CRUD bons/linjer/kunder, statusflow, changelog | Alt |
| **Grocy adapter** | `getRecipes()`, `getProducts()`, `consumeRecipe()` | Køkken + Office |
| **Mail service** | SMTP udgående (bon-mail), IMAP polling (ind) | Køkken + Office |
| **Settings/admin** | Brugere, mail-skabeloner, Grocy-config | Alt |

---

## Udviklingsplan

### ✅ Fase 0 — Fundament
*Gennemført*

- Express app, SQLite, migrations, SSE
- Bon-kerne API (CRUD, statusflow, changelog, prep, notifications)
- `BonConfig.js` + `BonConfigBar.js` — konfigurerbart status-system
- `shared/sse.js`, `shared/api.js`, `shared/utils.js`, `shared/bon_kort.js`

---

### 🔧 Fase 0b — Backend refaktorering
*Gøres nu inden Fase 2 fortsætter — se separat opgavespec*

`server.js` splittes til modulær struktur:

```
db/database.js + db/helpers.js
routes/kitchen.js   ← /api/bons/today (monteres før bons.js)
routes/bons.js
routes/customers.js
routes/statuses.js
routes/settings.js
shared/sse.js       ← tages i brug (erstatter inline Set)
```

`triggers_json`-stub tilføjes i `routes/bons.js` — strukturen er klar til Grocy og mail.

---

### 🔲 Fase 1 — Bon-kerne komplet
*Systemet kan oprette og redigere rigtige bonner*

- Bon-opret formular (samme form som kunden bruger via Formbuilder)
- Kunde/firma-søgning ved bonoprettelse
- Auth + roller (admin, office, kitchen, logistics)
- Settings UI: brugere, Grocy-config, mail-skabeloner

---

### 🔲 Fase 2 — Køkken komplet *(i gang)*
*Køkkenet er selvforsynende — kan droppe Bon v1*

**Views:**
- **Køkken I dag** — bon-kort, SSE, statusknapper, prep-checks *(næsten klar)*
- **Kategori-overblik** — totaler pr. kategori for hele dagen
- **Køkken Dashboard** — tal for i dag, nærmeste dage frem/tilbage, vagter (Smartplan)
- **Køkken Senere** — kommende bonner til planlægning
- **Køkken Listview** — søgning på tværs af datoer
- **Opskrifter** — Grocy-data, skalering, ingredienser
- **Lager** — lagerstatus, tjek
- **Varemodtagelse** — temp-tjek, foto, 4 statusser (fødevarestyrelse-dok)
- **Indkøb** — shopping list fra Grocy, bedre UI end Grocy's built-in

**Delte services der bygges i denne fase:**
- **Grocy adapter** — `getRecipes()`, `getProducts()`, `getStock()`
- **`consumeRecipe()`** — trigger ved LEVERET (via `triggers_json`-handleren)
- **SMTP mail service** — udgående bon-mail til kunden (bekræftelse + ændringer)
- **Action-knapper på bon** — mail, lager, print m.fl. (nogle grayed out til senere)

---

### 🔲 Fase 3 — Office basis
*Kontoret kan arbejde fuldt ud — Bon v1 kan lukkes ned*

- **Listview** — søg, filtrer, opret ny bon
- **Kalender** — totaler pr. dag, alle roller
- **Ugeoversigt** — vagter (Smartplan) + bonner
- **Office Dashboard** — dagens tal, alerts, leveringer, quick links
- **Tilbud** — tilbudsmodul med pipeline (is_offer felter i skema, mockup klar)
- Bon-opret/rediger fra office (genbruger Fase 1-formularen)

---

### 🔲 Fase 4 — Mail ind + CRM + Formbuilder
*Ordrer ind automatisk, salg og opfølgning i systemet*

**Mail ind:**
- IMAP polling: `bon@ristetrug.dk` (#B) + `kontakt@ristetrug.dk` (#K)
- Mail → bon/kunde matching via token-parsing
- Manuel indbakke for umatched mails

**CRM:**
- CRM-aktiviteter (opkald, noter, møder, opgaver, opfølgning)
- Nano CRM migration fra prototype til Bon v2
- CVR-lookup integration (Virk ElasticSearch API — afventer godkendelse)
- Smart suggestions: overdue regulars, sæsonpåmindelser, ubesvarede leads

**Formbuilder:**
- Formbuilder v6 integration (webhook → ny bon)

---

### 🔲 Fase 5 — Levering
*Logistik i systemet — arkitektur besluttet, se `leveringsbooking_beslutning.md`*

**Kernebeslutninger:**
- Leveringsbooking er separat spor fra bon-statusflow
- Trigger: leveringsvare tilføjes → automatisk bestilling (ikke statusskift)
- Én leverandørbestilling pr. bon

**Udbydere:**
| Udbyder | Metode |
|---------|--------|
| Byekspressen | Lobo API v3 — automatisk |
| Taxa | Clipboard-kopi + taxa.nu — manuel |
| Volvo | Intern log |
| Afhentning | Flag på bon |

**UI:** Leverings-strip altid synlig på bon-kort · Modal ved GODKENDT uden levering (ikke-blokerende)

**Database:** `delivery_bookings`-tabel inkl. `snapshot_json` — klar til migration

**Inden implementering:** Credentials + kundernr + produkt-ID fra Martin Ross (sebastian@by-expressen.dk) · Afklar webhook-support

**Views:** Bud-view med leveringsrækkefølge · Leveringsberegner (intern + kunde)

---

### 🔲 Fase 6 — Grocy skriv + Indkøb
*Lager og fødevarestyrelse-dokumentation — bygger på Grocy-adapteren fra Fase 2*

- `addToShoppingList()` — indkøbsbehov fra bonner
- Purchase order flow: bestilling → bekræftelse → modtagelse
- Indkøbsliste UI (kobles til Grocy shopping list)
- Multi-lokation support (HQ + Trailer — separate Grocy-instanser)
- Fødevarestyrelse: sporbarhed, temperaturer, goods receipt

---

### 🔲 Fase 7 — Integrationer
*Fakturering uden manuel håndtering*

- e-conomic integration: bon → faktura
- EAN-validering ved ordreregistrering (ikke ved fakturering)
- EAN learning system: fang succesfulde mønstre pr. EAN-nummer
- Statistik: omsætning, populære produkter, leveringsdata

---

## Parallelle spor
*Kan bygges uafhængigt af faserækkefølgen*

| Spor | Afhænger af | Note |
|------|-------------|------|
| **Whiteboard** (daglige opgaver, rengøring) | Intet | Selvstændigt system |
| **Opskrift-UI** (Vue.js, Grocy-data) | Grocy-oprydning | Prototype klar, data mangler |
| **Settings UI** | Fase 1 | Bygges løbende |
| **SOP-system** | Intet | Kører allerede |

---

## Vigtige deadlines og åbne punkter

| Punkt | Deadline / status |
|-------|-------------------|
| DAWA lukker 1. juli 2026 — formbuilder bruger allerede `api.dataforsyningen.dk` | ✅ Ingen handling nødvendig |
| CVR enrichment service (`cvrEnrichment.js`) | ✅ Bygget — klar til integration i Fase 4 |
| Virk ElasticSearch credentials | ⏳ Afventer godkendelse hos erst.dk (~3 uger) — fallback til cvrapi.dk virker allerede |
| Datafordeler HentCVRData — udfases | ✅ Ikke i brug — Virk ES er valgt i stedet |
node | Multi-lokation lageroverførsler (festival trailer) | 🔵 Udskudt til praktisk behov |

---

## Principper der styrer rækkefølgen

1. **Brugsværdi hurtigst muligt** — Fase 2 giver køkkenet noget de kan bruge nu
2. **Bon v1 kan droppes efter Fase 3** — det er det reelle mål for første release
3. **Delte services bygges én gang** — Grocy-adapter og mail-service hører i egne moduler, ikke i zoner
4. **`triggers_json` er knudepunktet** — Grocy og mail kobles på statusflow via triggers, ingen hardkodning
5. **Prototype-kode migreres, ikke genskrives** — CRM og CVR-tool er skemakompatible
