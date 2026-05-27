# CLAUDE_FASE1A.md — Fase 1a: Migrationer + Auth
> Læs CLAUDE.md og `docs/bon_v2_datamodel_v2.md` FØR du starter.
> Opdateret: marts 2026

---

## Hvad denne opgave dækker

To ting der skal på plads inden bon-opret kan bygges:

1. **Migration 011** — `payment_types`-tabel + `password_hash` på `users`
2. **Auth-backend** — session-middleware + login-routes
3. **Login UI** — Én login-side til alle (ingen PIN)

---

## Auth-arkitektur (besluttet)

| Hvad | Beslutning |
|------|------------|
| Login-system | Auto-detect: cifre → PIN, `@` → email + password |
| Køkken-devices (PC + tablet) | Fælles konto `kitchen@ristetrug.dk`, role `kitchen`, login via PIN |
| Hjemmeadgang | Samme PIN virker hjemmefra — eller personlig konto med password |
| Personlige konti | Oprettes manuelt af admin i Settings |
| Session-varighed | Konfigurerbar i settings per rolle — default: kitchen 365 dage, øvrige 30 dage |
| PIN-flow | Per bruger — `pin`-feltet på `users`-tabellen |
| "Sign as"-mønster | Noteret til senere (bruges allerede i whiteboard-appen) — ikke Fase 1 |

**Grocy er usynlig infrastruktur.** Medarbejdere logger ind i Bon v2 — ikke i Grocy.
Alle Grocy-handlinger sker via Bon v2's egne views og adapter.

---

## Trin 1 — Migration 011: `payment_types` + `users.password_hash`

**Fil:** `db/migrations/011_payment_types_and_auth.sql`

```sql
-- ==========================================
-- PAYMENT TYPES (ny tabel)
-- ==========================================

CREATE TABLE IF NOT EXISTS payment_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO payment_types (code, label, sort_order) VALUES
    ('invoice',   'Faktura',    1),
    ('card',      'Kort',       2),
    ('mobilepay', 'MobilePay',  3),
    ('cash',      'Kontant',    4),
    ('pos',       'POS/Zettle', 5);

-- ==========================================
-- USERS: tilføj password_hash
-- ==========================================

ALTER TABLE users ADD COLUMN password_hash TEXT;

-- ==========================================
-- SEED: startbrugere
-- Passwords sættes via script — se Trin 3
-- ==========================================

INSERT OR IGNORE INTO users (name, email, role, is_active)
VALUES ('Admin', 'admin@ristetrug.dk', 'admin', 1);

INSERT OR IGNORE INTO users (name, email, role, pin, is_active)
VALUES ('Køkken', 'kitchen@ristetrug.dk', 'kitchen', '1234', 1);
-- Fælles konto til alle køkken-devices, også hjemmefra.
-- PIN ændres via Settings → Brugere.

-- ==========================================
-- SETTINGS: session-varighed per rolle
-- ==========================================

INSERT OR IGNORE INTO settings (key, value, description) VALUES
    ('session_days_kitchen',  '365', 'Session-varighed i dage for kitchen-rolle'),
    ('session_days_office',   '30',  'Session-varighed i dage for office-rolle'),
    ('session_days_admin',    '30',  'Session-varighed i dage for admin-rolle'),
    ('session_days_delivery', '30',  'Session-varighed i dage for delivery-rolle');
```

**Vigtigt om `payment_type` CHECK constraint:**

SQLite tillader ikke at ændre eksisterende CHECK constraints uden at rekreere tabellen.
Vi beholder CHECK constraint på `bons.payment_type` og `companies.default_payment_type` som de er —
de eksisterende værdier matcher `payment_types.code` præcist.

`payment_types`-tabellen bruges af:
- Settings UI til at vise/redigere labels
- Bon-opret formular til at hente valgmuligheder via API

Konsistensregel: `payment_types.code`-værdierne må **aldrig** ændres — kun `label` og `is_active`.
Kodeværdierne er bundet til CHECK constraints i skemaet.

---

## Trin 2 — Auth-backend

### 2a. Ny npm-pakke (kræver godkendelse — er godkendt)

```bash
npm install bcrypt
npm install express-session
npm install connect-sqlite3
```

`connect-sqlite3` gemmer sessions i SQLite — ingen ekstra infra.
Sessions-filen: `db/sessions.db` (aldrig i git — tilføj til `.gitignore`).

### 2b. `.env` — tilføj

```
SESSION_SECRET=skift-dette-til-noget-langt-og-tilfaeldigt
```

### 2c. `server.js` — tilføj session-middleware

Indsæt **efter** `express.json()` og **før** route-mounting:

```js
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './db' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dage
    httpOnly: true,
    sameSite: 'lax'
  }
}));
```

### 2d. `db/helpers.js` — tilføj auth-helpers

```js
// Kræver: const bcrypt = require('bcrypt');
// Kræver: const { getDb } = require('./database');

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function getUserByEmail(email) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
}

function getUserById(id) {
  const db = getDb();
  return db.prepare('SELECT id, name, email, role, pin FROM users WHERE id = ? AND is_active = 1').get(id);
}

module.exports = {
  // ...eksisterende exports...
  hashPassword, verifyPassword, getUserByEmail, getUserById
};
```

### 2e. `routes/auth.js` — ny fil

```js
const express = require('express');
const router = express.Router();
const { getUserByEmail, verifyPassword } = require('../db/helpers');
const { getDb } = require('../db/database');

// Hjælpefunktion: sæt session med korrekt varighed fra settings
function setSession(req, user) {
  const db = getDb();
  const key = `session_days_${user.role}`;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const days = parseInt(row?.value || '30', 10);
  req.session.cookie.maxAge = days * 24 * 60 * 60 * 1000;
  req.session.userId = user.id;
  req.session.userRole = user.role;
}

// POST /api/auth/login — email + password
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Mangler email eller password' });

  const user = getUserByEmail(email);
  if (!user || !user.password_hash) return res.status(401).json({ error: 'Forkert email eller password' });

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Forkert email eller password' });

  setSession(req, user);
  res.json({ id: user.id, name: user.name, role: user.role });
});

// POST /api/auth/pin — PIN-login (virker fra alle devices)
router.post('/pin', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'Mangler PIN' });

  const db = getDb();
  const user = db.prepare(
    'SELECT * FROM users WHERE pin = ? AND is_active = 1'
  ).get(pin);

  if (!user) return res.status(401).json({ error: 'Forkert PIN' });

  setSession(req, user);
  res.json({ id: user.id, name: user.name, role: user.role });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// GET /api/auth/me — hvem er jeg?
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Ikke logget ind' });
  const { getUserById } = require('../db/helpers');
  const user = getUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: 'Bruger ikke fundet' });
  res.json(user);
});

module.exports = router;
```

### 2f. `shared/auth.js` — middleware (ny fil)

```js
// Bruges som: router.get('/beskyttet', requireAuth(), handler)
// Eller:      router.get('/admin', requireAuth('admin'), handler)

function requireAuth(role = null) {
  return (req, res, next) => {
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Ikke logget ind' });
    }
    if (role && req.session.userRole !== role && req.session.userRole !== 'admin') {
      return res.status(403).json({ error: 'Ingen adgang' });
    }
    next();
  };
}

module.exports = { requireAuth };
```

### 2g. `server.js` — mount auth-route

```js
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);
```

Monteres **før** de øvrige routes.

### 2h. `routes/payment_types.js` — ny fil

```js
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// GET /api/payment-types
router.get('/', (req, res) => {
  const db = getDb();
  const types = db.prepare(
    'SELECT id, code, label, sort_order FROM payment_types WHERE is_active = 1 ORDER BY sort_order'
  ).all();
  res.json(types);
});

module.exports = router;
```

Mount i `server.js`:
```js
app.use('/api/payment-types', require('./routes/payment_types'));
```

---

## Trin 3 — Sæt admin-password

**Script: `scripts/set-password.js`** (engangsbrug, ikke i produktion)

```js
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const db = new Database('./db/bon-v2.db');

const email = process.argv[2];
const plain = process.argv[3];

if (!email || !plain) {
  console.error('Brug: node scripts/set-password.js email@eksempel.dk mitpassword');
  process.exit(1);
}

const hash = bcrypt.hashSync(plain, 12);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hash, email);
console.log(`Password sat for ${email}`);
```

Passwords sættes via script:
```bash
node scripts/set-password.js admin@ristetrug.dk <admin-password>
```

PIN ændres direkte i databasen (eller via Settings UI når det bygges):
```bash
# Eksempel — skift køkken-PIN til 2580
sqlite3 db/bon-v2.db "UPDATE users SET pin = '2580' WHERE email = 'kitchen@ristetrug.dk';"
```

Start-PIN i seed-data er `1234` — **skift den inden produktionsbrug**.

---

## Trin 4 — Login UI

### `shared/login.html` — fælles for alle roller

Én login-side bruges af alle — office, kitchen, admin, hjemmefra.

**Design:**
- Cream baggrund (`--color-background: #f5f4f2`)
- Centreret kort, max-width 400px
- Ristet Rug logo øverst (`assets/logo.svg`)
- Undertekst: "Bon v2" i dæmpet farve
- Ét input-felt øverst — auto-detect styrer hvad der sker
- "Log ind"-knap i brand-brun (`--brand-primary`)
- Fejlbesked inline under knappen (ikke alert)
- Ingen topbar, ingen navigation
- Samme kortæstetik som `cvr-opslag.html`

**Auto-detect logik (ét felt, ingen tabs):**
```
Bruger taster i felt og trykker Enter/knap:

Kun cifre (PIN)
→ POST /api/auth/pin  { pin }
→ Ingen yderligere felter vises

Indeholder @ (email)
→ Password-felt glider ind under
→ POST /api/auth/login  { email, password }
```

Implementering: `input` event-listener på feltet. Regex `/^\d+$/` → PIN-mode.
Password-felt: `style="display:none"` → `display:block` med lille CSS transition.

**Ved success:** redirect baseret på role:
- `admin` / `office` → `/office/index.html`
- `kitchen` / `delivery` → `/kitchen/today.html`

**Vises automatisk** når `GET /api/auth/me` returnerer 401.

**Vigtigt:** Grocy-login må ikke være synligt eller omtales nogen steder i UI.
Brugerne logger ind i Bon v2 — ikke i Grocy.

### Auth-guard i alle zones

Tilføj til `shared/utils.js`:

```js
async function checkAuth(redirectTo = '/shared/login.html') {
  const res = await fetch('/api/auth/me');
  if (!res.ok) {
    window.location.href = redirectTo;
    return null;
  }
  return res.json();
}
```

Brug øverst i hvert view's `<script>`:
```js
const currentUser = await checkAuth();
// currentUser = { id, name, role } — bruges til at vise navn og styre adgang
```

---

## Verifikation

```bash
# 1. Migration kørt?
curl http://localhost:4321/api/payment-types
# Forventet: [{"id":1,"code":"invoice","label":"Faktura",...}, ...]

# 2a. Password-login virker?
curl -c cookies.txt -X POST http://localhost:4321/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@ristetrug.dk","password":"<dit-password>"}'
# Forventet: {"id":1,"name":"Admin","role":"admin"}

# 2b. PIN-login virker?
curl -c cookies2.txt -X POST http://localhost:4321/api/auth/pin \
  -H "Content-Type: application/json" \
  -d '{"pin":"1234"}'
# Forventet: {"id":2,"name":"Køkken","role":"kitchen"}

# 3. Session virker?
curl -b cookies.txt http://localhost:4321/api/auth/me
# Forventet: {"id":1,"name":"Admin","role":"admin",...}

# 4. Logout virker?
curl -b cookies.txt -X POST http://localhost:4321/api/auth/logout
curl -b cookies.txt http://localhost:4321/api/auth/me
# Forventet: 401
```

---

## Hvad der IKKE er i denne opgave

- Settings UI til brugerstyring (Fase 1e)
- Beskyttelse af eksisterende kitchen-routes (afventer beslutning om PIN-flow)
- Glem/nulstil password (ikke nødvendigt nu — admin sætter passwords manuelt)

---

## Checkliste

- [ ] `db/migrations/011_payment_types_and_auth.sql` oprettet og kørt
- [ ] `npm install bcrypt express-session connect-sqlite3`
- [ ] `SESSION_SECRET` tilføjet i `.env`
- [ ] `db/sessions.db` tilføjet til `.gitignore`
- [ ] Session-middleware i `server.js`
- [ ] `routes/auth.js` oprettet og mountet
- [ ] `routes/payment_types.js` oprettet og mountet
- [ ] `shared/auth.js` middleware oprettet
- [ ] `db/helpers.js` udvidet med auth-helpers
- [ ] Admin-password sat via script
- [ ] `shared/login.html` oprettet med Ristet Rug designsystem og auto-detect
- [ ] `checkAuth()` tilføjet til `shared/utils.js`
- [ ] Auth-guard (`await checkAuth()`) tilføjet til `office/index.html` og `kitchen/today.html`
- [ ] Alle 4 verifikations-curl-kommandoer giver forventet output
