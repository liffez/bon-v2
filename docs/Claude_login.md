## Næste opgave — Unified Login

### Formål
Én login-side på `bon.ristetrug.dk/login` der håndterer to brugertyper
uden at det fremgår hvad der sker bag kulisserne.

### Login-flow

**Køkken-tablet (delt bruger):**
- Brugeren taster kun PIN i password-feltet — email-felt efterlades tomt
- Backend finder bruger hvor `pin` matcher og `role = 'kitchen'`
- Session sættes til meget lang levetid (tablet logger aldrig ud af sig selv)
- Redirect → `/kitchen/`

**Kontor/hjemmefra (individuel bruger):**
- Brugeren taster email + password
- Backend: bcrypt-tjek af `password_hash`
- Session udløber efter 8 timer
- Redirect → brugerens `default_zone` (`/office/`, `/kitchen/`, `/settings/`)

### Backend-logik (routes/auth.js)

```js
POST /api/auth/login
body: { email?, password }

1. Hvis email er tom:
   → find user WHERE pin = password AND role = 'kitchen'
2. Ellers:
   → find user WHERE email = email
   → bcrypt.compare(password, user.password_hash)
3. Ved match: opret session, sæt req.session.user_id
4. Returner { redirect: default_zone_url }

POST /api/auth/logout
→ destroy session → redirect til /login
```

### Session-teknologi
`express-session` med SQLite-store (`better-sqlite3-session-store`).
Ingen JWT.

### Filer der skal oprettes/ændres

| Fil | Handling |
|-----|----------|
| `routes/auth.js` | Ny — login/logout endpoints |
| `public/login.html` | Ny — login-side (email + password, intet andet) |
| `server.js` | Tilføj `express-session` middleware + `require('./routes/auth')` |
| `db/migrations/0XX_auth.sql` | Tilføj `password_hash TEXT` til `users` hvis ikke findes |
| Alle beskyttede routes | Auth-middleware der tjekker `req.session.user_id` |

### users-tabellen

```sql
-- Køkken-bruger (delt)
INSERT INTO users (name, email, role, pin, password_hash)
VALUES ('Køkken HQ', null, 'kitchen', '1234', null);

-- Kontor-bruger
INSERT INTO users (name, email, role, pin, password_hash)
VALUES ('Leif', 'leif@ristetrug.dk', 'admin', null, '[bcrypt hash]');
```

### Login-siden
- Simpel formular: email-felt + password-felt + login-knap
- Ingen omtale af PIN, ingen hjælpetekst om køkken
- Fejlbesked ved forkert login: "Forkert email eller adgangskode"
- Ingen "Glemt kodeord"-link i første omgang

### Ikke i scope (første version)
- Password-reset flow
- "Husk mig"-checkbox
- 2FA
- Skift-bruger-knap i kitchen (håndteres stadig manuelt i dag)