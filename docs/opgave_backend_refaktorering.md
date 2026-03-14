# Opgave: Refaktorering af server.js
*Bon v2 — marts 2026*

---

## Baggrund

`server.js` er vokset til en monolitisk fil med ~520 linjer. Frontend er allerede
delt op (én fil pr. ansvar). Backend skal spejle samme princip inden Office-fasen
starter — ellers bliver vedligehold uoverskueligt.

Samtidig ryddes to kendte problemer op:
- SSE bruger et simpelt inline `Set` — `shared/sse.js` er det gennemtænkte modul med
  `broadcast()` og `sendTo()`, men bruges ikke endnu
- `triggers_json` returneres i status-response men håndteres ikke

---

## Målstruktur

```
server.js                  ← app setup, middleware, mount routes, listen — intet andet
db/
  database.js              ← getDb(), WAL + foreign_keys pragma
  helpers.js               ← logChange(), getBon(), getBonLines(), getStatusId()
routes/
  kitchen.js               ← GET /api/bons/today  (monteres FØR bons.js)
  bons.js                  ← /api/bons/*
  customers.js             ← /api/customers/*
  statuses.js              ← /api/statuses/*
  settings.js              ← /api/settings/*
shared/
  sse.js                   ← broadcast(), sendTo() — allerede lavet, bare tag i brug
```

---

## server.js efter refaktorering

```js
require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.static(path.join(__dirname)));

app.use('/api/sse',       require('./shared/sse'));
app.use('/api/bons',      require('./routes/kitchen'));   // /today matcher her
app.use('/api/bons',      require('./routes/bons'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/statuses',  require('./routes/statuses'));
app.use('/api/settings',  require('./routes/settings'));

app.listen(process.env.PORT || 4321, () =>
    console.log(`Bon v2 kører på port ${process.env.PORT || 4321}`)
);
```

---

## db/database.js

```js
const path     = require('path');
const Database = require('better-sqlite3');

let _db;

function getDb() {
    if (!_db) {
        _db = new Database(process.env.DB_PATH || path.join(__dirname, '../data/bon.db'));
        _db.pragma('journal_mode = WAL');
        _db.pragma('foreign_keys = ON');
    }
    return _db;
}

module.exports = { getDb };
```

---

## db/helpers.js

Flyt fra `server.js`:
- `logChange()` — omdøb fra `log()` til `logChange()` for klarhed
- `getBon(id)`
- `getBonLines(bonId)`
- `getStatusId(code)`
- `getDefaultLocationId()`

Tilføj én ny hjælper:

```js
// Wrapper der fanger sync exceptions og sender 500
function handle(fn) {
    return (req, res) => {
        try { fn(req, res); }
        catch (err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    };
}
```

---

## routes/kitchen.js

Indeholder **kun** køkken-specifikke endpoints — dem der ikke passer ind i generisk
bons.js. Monteres før bons.js.

```
GET  /api/bons/today          ← dagens bonner til køkken-view
GET  /api/bons/later          ← kommende bonner (bygges i næste fase)
```

`/api/bons/today` er allerede implementeret i `server.js` — flyt den direkte over.

---

## routes/bons.js

Alle øvrige `/api/bons/*` endpoints:

```
GET    /api/bons              ← liste med filtre
GET    /api/bons/:id
POST   /api/bons
PATCH  /api/bons/:id/status   ← se nedenfor: triggers_json
PATCH  /api/bons/:id/prep
PATCH  /api/bons/:id/kitchen-info
POST   /api/bons/:id/lines
PUT    /api/bons/:id/lines/:lid
DELETE /api/bons/:id/lines/:lid
GET    /api/bons/:id/changelog
POST   /api/bons/:id/notifications
GET    /api/bons/:id/notifications
```

---

## Håndtering af triggers_json (gøres klar nu, kobles til Grocy/mail senere)

I `PATCH /api/bons/:id/status` returneres allerede `triggers` i responsen.
Tilføj en stub-handler i `bons.js` så strukturen er på plads:

```js
// Efter db.prepare UPDATE status ...
const triggers = transition.triggers_json
    ? JSON.parse(transition.triggers_json)
    : [];

for (const trigger of triggers) {
    if (trigger.action === 'grocy_consume') {
        // TODO: kald grocyAdapter.consumeRecipe(bon)
        console.log(`[trigger] grocy_consume for bon ${id} — ikke implementeret endnu`);
    }
    if (trigger.action === 'send_mail') {
        // TODO: kald mailService.sendStatusMail(bon, trigger)
        console.log(`[trigger] send_mail for bon ${id} — ikke implementeret endnu`);
    }
}
```

Triggerne aktiveres ved at sætte `triggers_json` i `status_transitions`-tabellen —
f.eks. `[{"action":"grocy_consume"}]` på IGANG→LEVERET-transitionen.
Ingen kode skal ændres når Grocy-adapteren bygges — kun adapteren tilsluttes.

---

## Handlingsplan med tests

Serveren skal køre hele vejen igennem. Test efter hvert trin — stop og ret inden du går videre.

---

### Trin 1 — `db/database.js` + `db/helpers.js`

Opret filerne. `server.js` ændres endnu ikke — begge filer eksisterer blot.

**Test:** Node kan require dem uden fejl.
```bash
node -e "const { getDb } = require('./db/database'); console.log('db ok:', typeof getDb)"
node -e "const h = require('./db/helpers'); console.log('helpers ok:', Object.keys(h))"
```
Forventet output:
```
db ok: function
helpers ok: [ 'logChange', 'getBon', 'getBonLines', 'getStatusId', 'getDefaultLocationId', 'handle' ]
```

---

### Trin 2 — `shared/sse.js` tages i brug

I `server.js`: erstat det inline `Set` med import af `shared/sse`.
`broadcast()` og `sendTo()` fra modulet bruges i stedet for den lokale implementation.

**Test:** SSE-forbindelsen virker og kitchen/today.html modtager stadig events.
```bash
curl -N http://localhost:4321/api/sse
# Hold forbindelsen åben — skal ikke fejle
# Skift en bon-status i et andet terminal-vindue
# → event skal dukke op i curl-outputtet
```

---

### Trin 3 — `routes/statuses.js`

Flyt alle `/api/statuses/*` endpoints ud af `server.js` og ind i filen.
Monter i `server.js`: `app.use('/api/statuses', require('./routes/statuses'))`.

**Test:**
```bash
curl http://localhost:4321/api/statuses
# Skal returnere samme JSON som før
curl http://localhost:4321/api/statuses/transitions
# Skal returnere transitions-liste
```

---

### Trin 4 — `routes/settings.js`

Flyt alle `/api/settings/*` endpoints.
Monter i `server.js`.

**Test:**
```bash
curl http://localhost:4321/api/settings
# Skal returnere settings-objekt uden fejl
```

---

### Trin 5 — `routes/customers.js`

Flyt alle `/api/customers/*` endpoints.
Monter i `server.js`.

**Test:**
```bash
curl http://localhost:4321/api/customers
# Skal returnere liste (evt. tom)
curl http://localhost:4321/api/customers/1
# Skal returnere 404 eller kunde — ikke 500
```

---

### Trin 6 — `routes/kitchen.js`

Flyt `GET /api/bons/today` hertil.
Monter i `server.js` **før** `routes/bons.js`.

**Test — kritisk:**
```bash
curl http://localhost:4321/api/bons/today
# Skal returnere dagens bonner — identisk med før

# Dobbeltcheck at monteringsrækkefølge er rigtig:
curl http://localhost:4321/api/bons/today
curl http://localhost:4321/api/bons          # må ikke fejle
curl http://localhost:4321/api/bons/1        # må ikke fejle
```

Hvis `/api/bons` eller `/api/bons/:id` giver 404 — tjek at `kitchen.js` er monteret
med `app.use('/api/bons', ...)` og ikke `app.use('/api/bons/today', ...)`.

---

### Trin 7 — `routes/bons.js`

Flyt alle øvrige `/api/bons/*` endpoints.
Tilføj `triggers_json`-stub (se afsnittet ovenfor).
Monter i `server.js` **efter** `routes/kitchen.js`.

**Test — kritisk:**
```bash
# Læs
curl http://localhost:4321/api/bons
curl http://localhost:4321/api/bons/1
curl http://localhost:4321/api/bons/1/changelog

# Statusskift — skal trigge SSE + logChange + triggers-stub i console
curl -X PATCH http://localhost:4321/api/bons/1/status \
  -H "Content-Type: application/json" \
  -d '{"status_code":"IGANG","user_id":1}'
# → check at server-console viser [trigger]-linjer hvis transition har triggers_json

# Prep-check
curl -X PATCH http://localhost:4321/api/bons/1/prep \
  -H "Content-Type: application/json" \
  -d '{"check_id":1,"checked":true,"user_id":1}'
```

---

### Trin 8 — `server.js` renses

`server.js` må nu kun indeholde: dotenv, express-setup, middleware, route-mounts, listen.
Ingen db-logik, ingen route-handlers, ingen SSE-kode.

**Sluttest — den fulde suite:**
```bash
# Alle endpoints
curl http://localhost:4321/api/bons/today
curl http://localhost:4321/api/bons
curl http://localhost:4321/api/bons/1
curl http://localhost:4321/api/statuses
curl http://localhost:4321/api/customers
curl http://localhost:4321/api/settings

# SSE
curl -N http://localhost:4321/api/sse &
SSE_PID=$!

# Statusskift mens SSE lytter
curl -X PATCH http://localhost:4321/api/bons/1/status \
  -H "Content-Type: application/json" \
  -d '{"status_code":"KLAR","user_id":1}'

# SSE-outputtet skal vise en event — ellers er broadcast() ikke koblet rigtigt
kill $SSE_PID

# Åbn kitchen/today.html i browser — siden skal loade og vise bonner
```

Hvis alt dette virker er refaktoreringen færdig.

---

## Hvad der ikke ændres

- Ingen database-ændringer
- Ingen ændringer i frontend-filer
- Alle URL-stier forbliver identiske
- `kitchen/api.js` er allerede slettet — intet at gøre der
