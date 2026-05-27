# CLAUDE_SYNC_MIGRATION.md
# Bon v1 → v2: Migration og daglig sync

> **Opgave til Simon**
> Én script, to tilstande. Læs dette dokument fra top til bund inden du skriver kode.

---

## Oversigt

```
scripts/sync-v1.js --full     ← Første kørsel: alt historisk data + alle mails
scripts/sync-v1.js            ← Daglig drift: delta siden last_run
```

Scriptet er idempotent i begge tilstande — kan køres igen uden dubletter.

---

## Kontekst: paralleldrift

Under paralleldrift kører v1 i køkkenet og v2 på kontoret (CRM).
Kontoret har brug for opdateret kundehistorik dagligt.

| Mailboks       | Ejer              | Synkes          |
|----------------|-------------------|-----------------|
| `bon@`         | v1 køkken         | Ja — via dette script |
| `kontakt@`     | v2 CRM (live)     | Nej — IMAP-poller håndterer det |

Ved v1 shutdown: kør scriptet én sidste gang, så er alt med.

---

## Skemaændringer (ny migration: `028_v1_sync.sql`)

```sql
ALTER TABLE bons ADD COLUMN v1_id INTEGER UNIQUE;
ALTER TABLE bons ADD COLUMN sync_source TEXT;

ALTER TABLE companies ADD COLUMN v1_id INTEGER UNIQUE;
ALTER TABLE customers ADD COLUMN v1_id INTEGER UNIQUE;
ALTER TABLE addresses ADD COLUMN v1_id INTEGER UNIQUE;

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('v1_sync_last_run', '', 'Seneste v1 data-sync (ISO dato)');
INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('v1_mail_sync_last_run', '', 'Seneste v1 mail-sync (ISO dato)');
```

Ingen nye tabeller — `mail_threads`, `mail_messages`, `mail_unmatched` er allerede i skemaet.

---

## Hvad synkes i hvilken tilstand

| Data              | `--full`                        | Delta (default)                    |
|-------------------|---------------------------------|------------------------------------|
| companies         | Alle                            | Alle (upsert, hurtigt)             |
| customers         | Alle                            | Alle (upsert, hurtigt)             |
| bons + bon_lines  | Alle med status i SYNC_STATUSES | Ændret siden `v1_sync_last_run`    |
| bon@ mails        | Alle (batches af 500)           | Modtaget siden `v1_mail_sync_last_run` |

Companies og customers er få rækker — de kører altid fuldt uden batching.

---

## Database-adgang

### v2 (skrive-mål)
```javascript
const { openDb, transaction } = require('../db/compat');
const db = openDb(path.join(__dirname, '..', 'db', 'bon_v2.db'));
```

### v1 (read-only kilde)
```javascript
const { DatabaseSync } = require('node:sqlite');
const v1 = new DatabaseSync(V1_DB_PATH, { readOnly: true });
```

**Vigtigt:** Begge bruger `node:sqlite` — ingen `better-sqlite3` eller andre native pakker.
v1-databasen åbnes med `readOnly: true` så der aldrig skrives til den.

v2 bruger `openDb()` fra `db/compat.js` for korrekt BigInt→Number konvertering.
v1 bruger rå `DatabaseSync` da vi kun læser og ikke behøver compat-laget.

Transactions på v2 via `transaction(db, fn)` fra `db/compat.js`.

---

## Mail-matching logik

### v1 emneformat
```
#Bon:cafe-3380          → modtaget
sendt:#Bon:cafe-3380    → sendt (v1's workaround for manglende sendt-mappe)
```

### Parser
```javascript
const V1_BON_PATTERN = /(?:sendt:)?#Bon:(?:cafe-)?(\d+)/i;

function parseV1Subject(subject) {
  const match = subject.match(V1_BON_PATTERN);
  if (!match) return null;
  return {
    v1BonId:   parseInt(match[1]),
    direction: /^sendt:/i.test(subject) ? 'out' : 'in',
  };
}
```

### Match til v2 bon
```sql
SELECT id, customer_id FROM bons WHERE v1_id = ? AND sync_source = 'v1'
```

### Hvad der skrives

**Match fundet:**
1. Find eller opret `mail_threads` med `bon_id` + `customer_id` (begge sættes)
2. Indsæt `mail_messages` med korrekt `direction`, `from_email`, `subject`, `body_text`, `received_at`
3. Deduplicer på `message_id` header — `INSERT OR IGNORE`

**Ingen match (bon ikke synket eller ukendt format):**
- Indsæt i `mail_unmatched` med `subject`, `from_email`, `received_at`, `body_text`

### customer_id på mail_threads
Mail knyttes til kunden via bonen — aldrig direkte email-match.
```javascript
// Når bon er fundet:
thread.bon_id      = v2Bon.id;
thread.customer_id = v2Bon.customer_id;  // kan være NULL hvis bon mangler kunde
```

---

## IMAP-hentning

### --full tilstand
```javascript
// imapflow: hent alle mails i INBOX
const messages = client.fetch('1:*', { envelope: true, source: true });
// Kør i batches af 500 (kun relevant for første kørsel)
```

### Delta tilstand
```javascript
// SINCE filtrerer på dato — ikke tidspunkt, men godt nok
const lastRun = getSetting('v1_mail_sync_last_run'); // ISO dato
const messages = client.fetch(
  { since: new Date(lastRun) },
  { envelope: true, source: true }
);
```

**Vigtigt:** IMAP er read-only. Marker ikke mails som læst. Flyt ikke mails.

### Hvilken mailboks
Kun `bon@ristetrug.dk` — `kontakt@` røres ikke.

---

## Bon-delta logik

I v1 kan en bon skifte status efter forrige sync (fx approved → invoiced).
`ON CONFLICT(v1_id) DO UPDATE` håndterer dette automatisk — ingen særlig logik nødvendig.

Delta-filter på bons:
```sql
-- v1: hent bons der er opdateret siden last_run
SELECT ... FROM bons
WHERE status IN (...)
AND updated_at > ?   -- v1_sync_last_run
```

Hvis v1 ikke har `updated_at`: hent alle (upsert er billig med ~3.000 rækker).

---

## Kørsel og output

### Kommandoer
```bash
# Første migration
node scripts/sync-v1.js --full

# Daglig drift (cron)
node scripts/sync-v1.js

# Test uden at skrive til DB
node scripts/sync-v1.js --dry-run
```

### Cron på Hetzner
```bash
# Dagligt kl. 05:00
0 5 * * * node /opt/bon-v2/scripts/sync-v1.js >> /var/log/bon-sync.log 2>&1
```

### Output-format (verification report)
```
=== Bon v1 → v2 sync [2026-04-07T05:00:00Z] (delta) ===

companies  : 312 behandlet  (0 nye, 312 opdateret)
customers  : 487 behandlet  (3 nye, 484 opdateret)
bons       : 28 behandlet   (12 nye, 16 opdateret)
  FAKTURERET: 18
  AFSLUTTET:   8
  BETALT:      2
bon_lines  : 184 behandlet  (96 nye, 88 slettet+genopbygget)

mails (bon@)
  fundet på IMAP : 67
  matchet → v2   : 61
  → mail_unmatched: 6  (ingen matchende bon)
  duplikater skip: 4

last_run opdateret: 2026-04-07T05:00:12Z
=== Sync færdig (12.4 sek) ===
```

`--full` viser de samme kategorier men med totaler.

---

## Verifikation efter --full

Kør disse queries manuelt for at bekræfte:

```sql
-- Antal bons per sync-kilde
SELECT sync_source, COUNT(*) FROM bons GROUP BY sync_source;
-- Forventet: v1 ~2.900, NULL = native v2-bons

-- Mails matchet til bon + kunde
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN bon_id IS NOT NULL THEN 1 ELSE 0 END) AS med_bon,
  SUM(CASE WHEN customer_id IS NOT NULL THEN 1 ELSE 0 END) AS med_kunde
FROM mail_threads;

-- Ufordelte mails (bør undersøges)
SELECT subject, from_email, received_at FROM mail_unmatched
ORDER BY received_at DESC LIMIT 20;

-- Stikprøve: én kunds ordrehistorik
SELECT b.bon_number, b.delivery_date, b.status_id, COUNT(bl.id) AS linjer
FROM bons b
LEFT JOIN bon_lines bl ON bl.bon_id = b.id
WHERE b.customer_id = (SELECT id FROM customers WHERE email = 'test@kunde.dk')
GROUP BY b.id
ORDER BY b.delivery_date DESC;
```

---

## Afhængigheder

| Pakke | Allerede i brug? | Formål |
|-------|-----------------|--------|
| `node:sqlite` | Ja (kerne) | v1 (read-only) + v2 via `openDb()` |
| `imapflow` | Ja (mailService.js) | IMAP hentning |
| `mailparser` | Ja (package.json) | Parse raw mail til struktureret data |

**Ingen nye npm-pakker nødvendige. Ingen native/compiled pakker.**

---

## Filplacering

```
scripts/sync-v1.js                ← hovedscript (--full / delta / --dry-run)
scripts/sync-v1-cron.sh           ← wrapper: rsync v1.db + kør sync (Hetzner cron)
db/migrations/028_v1_sync.sql     ← v1_id + sync_source kolonner + settings-nøgler
docs/DEPLOY_SYNC.md               ← ops-guide (SSH-nøgle, rsync, cron setup)
```

---

## Rækkefølge for Simon

1. `028_v1_sync.sql` — tilføj v1_id/sync_source kolonner + settings-nøgler
2. Opret `sync-v1.js` med `--full` flag + batch-logik
   - Brug `openDb()` fra `db/compat.js` til v2-database
   - Brug `DatabaseSync` fra `node:sqlite` med `readOnly: true` til v1-database
   - Brug `transaction(db, fn)` fra `db/compat.js` til batch-writes
3. Tilføj mail-trin sidst i scriptet (efter bons)
4. Test `--dry-run` mod rigtig v1-DB
5. Kør `--full` og verificer med queries ovenfor
6. Sæt cron op: dagligt kl. 05:00
