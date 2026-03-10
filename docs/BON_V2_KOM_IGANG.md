# Bon v2 — Kom I Gang

> Praktisk reference til alle der arbejder på Bon v2.
> Læs dette før du bygger noget.

---

## Hvem gør hvad

| Person | Rolle |
|--------|-------|
| **Leif** | Domæneekspert, design, krav, test |
| **Bror** | Lead developer — backend, database, deployment |

Beslutninger om arkitektur og principper tages i fællesskab og dokumenteres.

---

## De autoritative dokumenter

Disse tre dokumenter er sandheden. Alt andet er baggrund.

| Dokument | Indhold |
|----------|---------|
| `bon_v2_datamodel_v2.md` | Databaseskema, tabeller, kolonner, seed data |
| `bon_v2_zoner_og_layout.md` | Filstruktur, zoner, roller, designsystem |
| `BON_V2_PRINCIPPER.md` | Ufravigelige regler — læs dette først |

Før du bygger noget nyt: tjek at det passer med disse tre dokumenter.

---

## Første gang — setup

```bash
# 1. Klon repo
git clone <repo-url>
cd bon-v2

# 2. Node.js version — skal være v22 LTS
node --version   # skal starte med v22
# Hvis ikke: brew install node@22

# 3. Installer afhængigheder
npm install

# 4. Konfiguration
cp .env.example .env
# Åbn .env og sæt PORT og DB_PATH hvis nødvendigt

# 5. Opret database og kør seed
npm run setup    # = migrate + seed

# 6. Start server
npm start        # http://localhost:4321
```

---

## Daglig brug

```bash
npm start          # start server (produktion)
npm run dev        # start med auto-restart ved filændringer
```

---

## Database

SQLite-filen ligger i `data/bon.db`.

**Migrationsfiler** ligger i `db/migrations/` og nummereres fortløbende (`001_core.sql`, `002_bons.sql` osv.).

```bash
npm run migrate    # kør nye migrationsfiler (springer allerede kørte over)
npm run seed       # indsæt testdata (sletter og genindsætter)
```

Migrationsfiler køres **aldrig om**. Ændringer til skemaet laves som nye filer.

---

## API — hurtig reference

Alle endpoints starter med `/api/`.

### Køkken

```
GET  /api/bons/today                  → Dagens bonner med linjer og notifikationer
GET  /api/sse                         → SSE-stream til realtidsopdateringer
```

### Bonner

```
GET  /api/bons                        → Liste (filter: ?date= &status= &q= &location=)
GET  /api/bons/:id                    → Enkelt bon med linjer og leveringsadresse
POST /api/bons                        → Opret bon
PATCH /api/bons/:id/status            → Skift status { status_code, user_id, force? }
PATCH /api/bons/:id/prep              → Prep-checks { ingredients_ready, supplies_ready }
PATCH /api/bons/:id/kitchen-info      → Køkken-info { text }
GET  /api/bons/:id/changelog          → Ændringshistorik
```

### Linjer

```
POST   /api/bons/:id/lines            → Tilføj linje
PUT    /api/bons/:id/lines/:lid       → Opdater linje
DELETE /api/bons/:id/lines/:lid       → Slet linje
```

### Notifikationer (flyver)

```
POST /api/bons/:id/notifications      → Send flyver { type, message, priority }
GET  /api/bons/:id/notifications      → Hent notifikationer for bon
```

### Stamdata

```
GET  /api/statuses                          → Alle aktive statusser
GET  /api/statuses/:code/transitions        → Gyldige skift fra denne status
GET  /api/customers                         → Kundeliste (filter: ?q=)
GET  /api/customers/:id                     → Kunde med seneste bonner
GET  /api/settings                          → Alle settings
PATCH /api/settings/:key                    → Opdater én setting
```

### Force status-skift (admin)

Hvis en bon skal sættes til en status uden om det normale flow (fx fejlrettelse):

```json
PATCH /api/bons/:id/status
{ "status_code": "BETALT", "force": true, "user_id": 1 }
```

---

## Status-flow

```
NY → VENTER → GODKENDT → IGANG → KLAR → LEVERET → FAKTURERET → AFSLUTTET
                                                  ↘ BETALT    ↗
                                                  ↘ AFSLUTTET
↓ (fra alle normale statusser)
AFLYST
```

**Bemærk:** Flowet er vejledning. Med `force: true` kan admin sætte hvad som helst.
POS-ordrer (Zettle) sættes direkte til BETALT.

---

## Zoner og roller

| Zone | URL | Primær bruger | Tech |
|------|-----|---------------|------|
| Kitchen | `/kitchen/` | kok, koekkenchef | MPA (separate HTML-filer) |
| Office | `/office/` | kontor, salg, admin | SPA-lignende |
| Settings | `/settings/` | admin | Eget shell |

Roller i databasen: `kok`, `koekkenchef`, `kontor`, `salg`, `bud`, `admin`

---

## Designsystem

CSS-tokens defineres i `shared/tokens.css`. Alle farver og spacing hentes derfra.

```css
--brand-primary:     #8e631f;   /* Ristet Rug brun */
--brand-primary-light: #f1e6b2; /* Gul/creme */
```

Zones markeres på body: `<body class="zone-kitchen">` eller `<body class="zone-office">`.

---

## Eksterne systemer

| System | Forbindelse | Status |
|--------|-------------|--------|
| Grocy (HQ) | REST API, API-key | I brug |
| Grocy (Trailer) | REST API, API-key | I brug |
| Smartplan | OAuth via Express proxy | I brug |
| Byekspressen | REST API | Klar til integration |
| e-conomic | REST API | Planlagt (Blok E) |
| Simply.com mail | IMAP/SMTP | Planlagt (Blok C) |

Grocy-forbindelser konfigureres per lokation i `locations`-tabellen — ikke i `.env`.

---

## Når du er i tvivl

1. Læs `BON_V2_PRINCIPPER.md`
2. Tjek `bon_v2_datamodel_v2.md` for skema
3. Tjek `bon_v2_zoner_og_layout.md` for filplacering
4. Spørg Leif hvis domænelogikken er uklar
5. Lav ikke en lappeløsning og fortsæt

---

*Sidst opdateret: marts 2026*
