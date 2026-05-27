# Bon v2 — Migrationsplan (v1 → v2 + Linode → Hetzner)

> Mål: Alt flyttes fra Linode til Hetzner. Bon v1 lukkes ned.
> Sidst opdateret: april 2026

---

## Systemer der flyttes

| System | Fra | Til | Note |
|--------|-----|-----|------|
| Bon v1 | Linode | — | Lukkes ned efter cutover |
| Bon v2 | (ny) | Hetzner | Bygges direkte på Hetzner |
| Grocy HQ | Linode | Hetzner | Data kopieres |
| Grocy Trailer | Linode(?) | Hetzner | Afklar om den kører på Linode |
| Grocy Test | — | Hetzner | Ny tom installation |
| Whiteboard | Linode | Hetzner | Kopi + ny URL |
| SOP | Linode | Hetzner | Kopi + ny URL |

---

## Shutdown-kriterier (Bon v1 må ikke lukkes før alle er opfyldt)

- [ ] Mail virker (udgående bekræftelse + IMAP polling)
- [ ] Bon v2 kører stabilt på Hetzner med SSL
- [ ] Grocy HQ kører på Hetzner og Bon v2 kan læse fra den
- [ ] Datamigration kørt og verificeret (v1 → v2)
- [ ] Kitchen-views testet på tablet i køkkenet
- [ ] Formbuilder webhook peger på Bon v2 og er testet end-to-end
- [ ] Whiteboard og SOP kører på Hetzner

---

## Fase 1 — Hetzner server setup

| # | Opgave | Ansvar | Status |
|---|--------|--------|--------|
| I1 | Hetzner VPS provisioneret (Ubuntu 24, Node 22 LTS, Docker til Grocy) | Simon | ⏳ |
| I2 | Nginx reverse proxy konfigureret til alle subdomæner | Simon | ⏳ |
| I3 | Let's Encrypt SSL på alle domæner (se liste nedenfor) | Simon | ⏳ |
| I4 | `.env` sat op med alle API-nøgler og hemmeligheder | Simon | ⏳ |
| I5 | GitHub deployment-script (git pull + npm install + migrate + restart) | Simon | ⏳ |
| I6 | SQLite WAL-mode + daglig backup-cron til ekstern lokation | Simon | ⏳ |

**Subdomæner der skal SSL-certifikater:**

| Domæne | System |
|--------|--------|
| `bon.ristetrug.dk` | Bon v2 |
| `grocy.ristetrug.dk` | Grocy HQ |
| `grocy-trailer.ristetrug.dk` | Grocy Trailer |
| `grocy-test.ristetrug.dk` | Grocy Test |
| `whiteboard.ristetrug.dk` | Whiteboard |
| `sop.ristetrug.dk` | SOP |

---

## Fase 2 — Grocy: 3 installationer på Hetzner

Alle tre er samme operation: ny Grocy-installation + SQLite-database kopieret fra Linode.

| # | Opgave | Ansvar | Status |
|---|--------|--------|--------|
| G1 | Grocy HQ installeret på Hetzner | Simon | ⏳ |
| G2 | Grocy HQ SQLite-database kopieret fra Linode og verificeret | Simon | ⏳ |
| G3 | Grocy Trailer installeret på Hetzner + database kopieret fra Linode | Simon | ⏳ |
| G4 | Grocy Test installeret på Hetzner + database kopieret fra Linode | Simon | ⏳ |
| G5 | Bon v2 Grocy-adapter opdateret med 3 URL'er + API-nøgler i `.env` | Simon | ⏳ |
| G6 | Adapter testet mod alle 3 installationer (`GET /api/grocy/products`) | Leif+Simon | ⏳ |

**Grocy-adapter konfiguration (`.env`):**
```
GROCY_HQ_URL=https://grocy.ristetrug.dk
GROCY_HQ_KEY=...
GROCY_TRAILER_URL=https://grocy-trailer.ristetrug.dk
GROCY_TRAILER_KEY=...
GROCY_TEST_URL=https://grocy-test.ristetrug.dk
GROCY_TEST_KEY=...
```

**Vigtigt:** Grocy HQ skal flyttes og verificeres *inden* Bon v2's Grocy-adapter testes på Hetzner — ellers tester vi mod den gamle Linode-instans.

---

## Fase 3 — Whiteboard & SOP flyttes

| # | Opgave | Ansvar | Status |
|---|--------|--------|--------|
| W1 | Whiteboard kopieres fra Linode til Hetzner | Simon | ⏳ |
| W2 | SOP kopieres fra Linode til Hetzner | Simon | ⏳ |
| W3 | Interne links verificeres (whiteboard ↔ SOP ↔ Bon v2 sidekick) | Leif | ⏳ |
| W4 | DNS opdateret for `whiteboard.ristetrug.dk` og `sop.ristetrug.dk` | Simon | ⏳ |

**Kan startes med det samme** — ingen afhængigheder til Bon v1/v2.

---

## Fase 4 — Datamigration (Bon v1 → Bon v2)

| # | Opgave | Ansvar | Status |
|---|--------|--------|--------|
| D1 | `scripts/sync-v1.js` køres mod produktions-v1 på Linode (dry-run først) | Simon | ⏳ |
| D2 | Verificer kundetal, bonantal og statusfordeling stemmer | Leif | ⏳ |
| D3 | Spot-check 10 tilfældige bonner — sammenlign v1 og v2 side om side | Leif | ⏳ |
| D4 | Migrationsfil `020_v1_sync.sql` klar og idempotent (kan køres igen uden fejl) | Simon | ⏳ |
| D5 | Alle eksisterende brugere fra v1 oprettet i v2 med korrekte roller | Simon | ⏳ |

**Blokerende afhængigheder:** I1 + Bon v2 database på Hetzner

---

## Fase 5 — Formbuilder & bestillingsformular

| # | Opgave | Ansvar | Status |
|---|--------|--------|--------|
| F1 | `bestilling.html` lægges på `ristetrug.dk/bestil` | Leif | ⏳ |
| F2 | Webhook-URL sættes til `https://bon.ristetrug.dk/api/webhooks/formbuilder` | Simon | ⏳ |
| F3 | Webhook-route i Bon v2 verificeres (opretter bon korrekt) | Simon | ⏳ |
| F4 | End-to-end test: udfyld formular → tjek bon dukker op i v2 | Leif | ⏳ |
| F5 | Gammel webhook på Bon v1 deaktiveres (undgår dobbelt-oprettelse) | Simon | ⏳ |

---

## Fase 6 — Test & verifikation

| # | Opgave | Ansvar | Note |
|---|--------|--------|------|
| T1 | `scripts/smoke-test.sh` køres mod prod | Simon | Alle API endpoints |
| T2 | `tests/migrations.test.js` kører rent | Simon | |
| T3 | Kitchen-views på tablet i køkkenet | Leif | Rigtig tablet, ikke browser |
| T4 | Office-views på desktop (listview, bon-detalje, mail) | Leif | |
| T5 | Reel ordre ind via formular → verificer bon i v2 | Leif | |
| T6 | Statusskift i køkkenet → SSE opdaterer office live | Leif+Simon | |
| T7 | Grocy-data synlig i kitchen-views | Leif | |
| T8 | 5 gamle bonner sammenlignet v1 vs. v2 manuelt | Leif | |

---

## Fase 7 — Cutover

Cutover sker på et roligt tidspunkt — tidlig morgen eller weekend.

| # | Rækkefølge | Ansvar |
|---|------------|--------|
| C1 | Giv besked til køkken og kontor om tidspunkt | Leif |
| C2 | Kør en **final** `sync-v1.js` (hent de seneste bonner fra Linode) | Simon |
| C3 | Verificer tællingerne stemmer | Leif |
| C4 | DNS: `bon.ristetrug.dk` peger på Hetzner | Simon |
| C5 | SSL verificeret efter DNS-skift | Simon |
| C6 | Kort funktionstest i Bon v2 (opret bon, skift status) | Leif |
| C7 | Bon v1 sættes i read-only mode ← **irreversibelt punkt** | Simon |
| C8 | Formbuilder webhook verificeres peger på v2 | Simon |

**Rollback:** Inden C7 — DNS peges tilbage på Linode. Ingen data tabt.
Efter C7 — restore Linode-backup + manuel flytning af de få nye bonner.

---

## Fase 8 — Linode shutdown

Tidligst 2 uger efter cutover, når alt kører stabilt.

| # | Opgave | Ansvar |
|---|--------|--------|
| S1 | Bon v1 database arkiveres (zip, gem 12 måneder) | Simon |
| S2 | Grocy HQ-data på Linode arkiveres | Simon |
| S3 | Linode-server lukkes ned | Simon |
| S4 | Eventuelle gamle bookmarks/links opdateres | Leif |

---

## Anbefalet rækkefølge

```
Fase 1 — Server setup
    │
    ├── Fase 2 — Grocy (3 installationer) ──┐
    ├── Fase 3 — Whiteboard + SOP ←nu       │
    ├── Fase 4 — Datamigration              ├── Fase 6 — Test
    └── Fase 5 — Formbuilder ───────────────┘
                                             │
                                        Fase 7 — Cutover
                                             │
                                        Fase 8 — Linode shutdown
```

Fase 3 (Whiteboard + SOP) kan startes **allerede nu** — ingen afhængigheder.

---

## Åbne afhængigheder

| Punkt | Ansvarlig | Note |
|-------|-----------|------|
| Byekspressen credentials (sebastian@by-expressen.dk) | Leif | Rykke for svar |
| Virk ElasticSearch credentials (erst.dk) | Leif | Afventer godkendelse |
| DMI API-nøgle (vejr) | Leif | Leif lokaliserer |
| Bon v2 Fase 3C komplet (kalender + tilbud) | Simon | Forudsætning for at kontoret kan droppe v1 |
| Mail UI live | Simon | Shutdown-kriterie |

---

## Hvad der IKKE er del af denne migration

- Byekspressen Lobo API (blokeret af credentials)
- e-conomic integration
- Grocy skrive-operationer (`consumeRecipe()`)
- Grocy multi-lokation vare-flytning (HQ ↔ Trailer)
- Grocy vinkælder/drikkevarer (separat fremtidigt projekt)
- Menu-agent (Anthropic API)

---

*Hører hjemme i `docs/MIGRATION_V1_V2.md` i bon-v2 repo.*
