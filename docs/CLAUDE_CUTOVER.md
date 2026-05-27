# CLAUDE_CUTOVER.md — Linode → Hetzner migration

> Dokumentet er handlingsorienteret. Læs det fra top til bund inden eksekvering.
> Hver bølge er selvstændig og kan rulles tilbage uden at påvirke de andre.

---

## Oversigt

| Bølge | Systemer | Risiko | Tidsvindue | Forudsætning |
|-------|----------|--------|------------|---------------|
| **0** | Pre-flight prep | — | 2 dage før | Adgang til DNS, Hetzner SSH, Linode SSH |
| **1** | SOP + Whiteboard | Lav | ~30 min | Bølge 0 fuldført |
| **2** | Grocy (HQ + Test + Trailer + Kælder) + Bon v2 URL-opdatering | Mellem | ~60 min | Bølge 1 fuldført, FVST-kontrol overstået |
| **3** | Bon v1 → readonly + WordPress iframe-skift | Mellem | ~30 min + bløde dage | Bølge 2 fuldført, kontoret er klar |

**Princip:** ingen periode hvor Linode og Hetzner skriver til samme data. Hver bølge har et FREEZE-vindue.

---

## Bølge 0 — Pre-flight (gør 2 dage før)

### 0.1 Sæt DNS-TTL ned til 300s

Hos DNS-udbyderen, for hvert domæne der skal flyttes:

| Domæne | Skal pege på | Bølge |
|--------|--------------|-------|
| `whiteboard.ristetrug.dk` | Hetzner | 1 |
| `sop.ristetrug.dk` | Hetzner | 1 |
| `grocy-hq.ristetrug.dk` *(nyt navn)* | Hetzner | 2 |
| `grocy-test.ristetrug.dk` *(nyt navn)* | Hetzner | 2 |
| `grocy-trailer.ristetrug.dk` *(nyt navn)* | Hetzner | 2 |
| `kaelder.ristetrug.dk` | Hetzner | Separat (ikke Bon v2) |
| `bon.ristetrug.dk` | Hetzner (allerede) | — |
| `grocycafe.ristetrug.dk` *(gammelt)* | Lad dø — ingen redirect nødvendig | — |

> **Bemærk:** Bon v2's kode + `locations`-tabel refererer til de gamle URL'er (`grocycafe`/`grocytest`/`grocytrailer`). Nye domænenavne kræver opdatering — se Bølge 2.1+2.2.

### 0.2 Verificér Hetzner-NGINX

```bash
# SSH til Hetzner
sudo nginx -t                               # syntax-tjek
sudo systemctl status nginx                 # kører
ls /etc/nginx/sites-enabled/                # alle vhost-conf'er er linket
ls /etc/nginx/snippets/                     # ssl-common.conf + bon-auth.conf findes
sudo certbot certificates                   # alle certifikater er gyldige > 30 dage
```

### 0.3 Verificér `bon-auth.conf`-mekanikken

Whiteboard, Grocy-hq, Grocy-test bruger NGINX `auth_request` mod Bon v2. Test:

```bash
# Login i Bon v2 i browser → kopiér session-cookie

# Test SSO:
curl -I https://whiteboard.ristetrug.dk -H "Cookie: <session-cookie>"
# Forventet: 200 OK

curl -I https://whiteboard.ristetrug.dk
# Forventet: 401 eller redirect til login
```

**Hvis 401 selv med gyldig cookie** → Bon v2 sætter ikke session-cookie på `Domain=.ristetrug.dk`. Tjek `express-session` config:

```js
app.use(session({
  cookie: {
    domain: '.ristetrug.dk',  // SKAL være parent-domæne, ikke 'bon.ristetrug.dk'
    secure: true,
    httpOnly: true,
    sameSite: 'lax'
  }
}));
```

Dette skal være fixet **før** Bølge 1.

### 0.4 Snapshot Linode

Tag VM-snapshot af Linode (alle volumes) — lever som rollback-anker i 30 dage.

### 0.5 Smoke-test Hetzner uden DNS

Brug `/etc/hosts` på din lokale maskine til at pege manuelt:

```
<HETZNER-IP>  whiteboard.ristetrug.dk
<HETZNER-IP>  grocy-hq.ristetrug.dk
<HETZNER-IP>  sop.ristetrug.dk
```

Test login + en handling i hver app, før DNS-flip rammer rigtige brugere.

### 0.6 Verificér Whiteboard's protokol

Tre måder, hurtigst først:

**A) Browser DevTools:**
Åbn Whiteboard → F12 → Network → reload.
- WS-filter med `101 Switching Protocols` → WebSocket
- `Content-Type: text/event-stream` (i Other-filter) → SSE
- Kun XHR/fetch hvert par sekunder → polling (ligegyldig)

**B) Kildekode:**
```bash
cd /home/leif/whiteboard  # juster sti
grep -rn --include="*.js" -E "new WebSocket|socket\.io|EventSource|text/event-stream" .
```

**C) `package.json`:**
```bash
cat /home/leif/whiteboard/package.json | grep -E "\"ws\"|\"socket.io\""
```

**Hvis Whiteboard kun bruger SSE:**

```nginx
# whiteboard.ristetrug.dk.conf — ret til:
proxy_set_header Connection "";
proxy_buffering off;
proxy_read_timeout 24h;
# (fjern Upgrade-headeren)
```

---

## Bølge 1 — SOP + Whiteboard

> Lavrisiko-bølge. Test af cutover-mekanikken.

### 1.1 SOP — kun statiske filer

```bash
# På Linode — find SOP's data-mappe
ls /path/to/sop/  # forventet: docs, excalidraw-filer, evt. videoer

# Stop Linode-SOP-server (npm-server)
# (find PID + stop)

# Kopiér til Hetzner
rsync -avz --delete /path/to/sop/ leif@hetzner:/home/leif/SOP/

# Verificér på Hetzner
sudo systemctl restart sop  # eller hvad service hedder
curl -I https://sop.ristetrug.dk -H "Cookie: <session>"
```

### 1.2 Whiteboard — én SQLite-fil

```bash
# På Linode — stop Whiteboard-processen
sudo systemctl stop whiteboard
# eller: pm2 stop whiteboard

# Kopiér database
scp /path/to/whiteboard.sqlite leif@hetzner:/home/leif/whiteboard/whiteboard.sqlite

# Kopiér eventuelle uploads/foto-filer
rsync -avz /path/to/whiteboard/uploads/ leif@hetzner:/home/leif/whiteboard/uploads/

# På Hetzner — fix ejerskab
sudo chown leif:leif /home/leif/whiteboard/whiteboard.sqlite
sudo systemctl start whiteboard

# Verificér
curl https://whiteboard.ristetrug.dk/api/health -H "Cookie: <session>"
```

### 1.3 DNS-flip

I DNS-panelet, for `whiteboard.ristetrug.dk` og `sop.ristetrug.dk`:
- Skift A-record til Hetzner-IP
- Vent 5 min på TTL-udløb
- Verificér: `dig whiteboard.ristetrug.dk` viser Hetzner-IP

### 1.4 Smoke-test (kontorets klassiske handlinger)

| Test | Forventet |
|------|-----------|
| Åbn Whiteboard, opret opgave | Gemt |
| Marker opgave som færdig | Stat-opdatering |
| Åbn et SOP-diagram | Excalidraw renderer |
| Klik fra Bon v2 til Whiteboard sidekick | Auth virker, ikke 401 |

### 1.5 Hvis det virker → mark Linode-Whiteboard som FROZEN

```bash
# På Linode — undgå at nogen kommer til at skrive til den
sudo systemctl disable whiteboard
sudo systemctl stop whiteboard
# Lad VM stå tændt så data kan tilgås hvis nødvendigt
```

### 1.6 Rollback (hvis nødvendigt)

```bash
# Skift DNS tilbage til Linode-IP (TTL er 300s)
# Start Linode-Whiteboard
sudo systemctl start whiteboard
```

Data-tab: ingen, så længe Linode-DB ikke er ændret efter kopi.

---

## Bølge 2 — Grocy + Bon v2 URL-opdatering

> Den vigtigste bølge for ordreflowet. Bon v2 → Grocy bruges hver gang en bon ændrer status.

### 2.1 Pre-cutover på Bon v2 — opdater locations-tabel

Bon v2's `locations`-tabel og settings refererer stadig til de gamle URL'er. Skal opdateres **inden** Grocy DNS-flip.

```sql
-- Backup først
.backup data/bon-pre-grocy-cutover.db

-- Opdater locations-tabel
UPDATE locations
   SET grocy_api_url = 'https://grocy-hq.ristetrug.dk/api'
 WHERE code = 'hq';

UPDATE locations
   SET grocy_api_url = 'https://grocy-test.ristetrug.dk/api'
 WHERE code = 'test';

UPDATE locations
   SET grocy_api_url = 'https://grocy-trailer.ristetrug.dk/api'
 WHERE code = 'trailer';

-- Verificér
SELECT id, name, code, grocy_api_url FROM locations;
```

> **Kælder:** Tilhører en separat vinlager-app, ikke Bon v2. Skal IKKE i `locations`-tabellen. Flyttes som standalone Grocy-instans (se 2.3).
>
> **Trailer:** Bruges aktivt fra sommer-sæsonen. Flyttes nu samtidig med HQ for at få det overstået i ét vindue.

> **Vigtigt:** Skift IKKE `default_grocy_location_id` endnu — det skal stadig pege på Test indtil Grocy HQ er live.

### 2.2 Sourcecode-grep

```bash
cd /home/leif/bon-v2
grep -rn "grocycafe.ristetrug.dk" --exclude-dir=node_modules .
grep -rn "grocytest.ristetrug.dk" --exclude-dir=node_modules .
grep -rn "grocytrailer.ristetrug.dk" --exclude-dir=node_modules .
```

Alle hits skal opdateres til de nye URL'er. Forventede steder:
- `.env` (`GROCY_*_URL` hvis brugt)
- `services/grocyAdapter.js`
- Eventuelle hardcoded URL'er i frontend

### 2.3 Stop Linode-Grocy + kopiér data

```bash
# På Linode — stop PHP-FPM (alle Grocy-pools på én gang)
sudo systemctl stop php8.x-fpm
# Verificér: ingen processer skriver længere

# Kopiér alle 4 instanser samtidig (HQ + Test + Trailer + Kælder)
# Linode mappenavne (verificér først): grocy-cafe (HQ), grocy-test, grocy-trailer, grocy-kaelder
# Hetzner-stier: /home/leif/grocy/{hq,test,trailer,kaelder}/data

# HQ
rsync -avz /var/www/html/grocy-cafe/data/grocy.db    leif@hetzner:/home/leif/grocy/hq/data/
rsync -avz /var/www/html/grocy-cafe/data/storage/    leif@hetzner:/home/leif/grocy/hq/data/storage/
rsync -avz /var/www/html/grocy-cafe/data/plugins/    leif@hetzner:/home/leif/grocy/hq/data/plugins/

# Test, Trailer, Kælder — samme mønster, ret kun mappenavn
for INST in test trailer kaelder; do
  case $INST in
    kaelder) LINODE_DIR=grocy-kaelder ;;
    *)       LINODE_DIR=grocy-$INST ;;
  esac
  SRC=/var/www/html/$LINODE_DIR/data
  DST=leif@hetzner:/home/leif/grocy/$INST/data
  rsync -avz $SRC/grocy.db $DST/grocy.db
  rsync -avz $SRC/storage/ $DST/storage/
  rsync -avz $SRC/plugins/ $DST/plugins/
done

# IKKE kopiér: grocy-old.db, grocy.db-ok, custom_js.htmlold*, backups/, viewcache/
# (gamle backups eller skrald — viewcache regenereres automatisk)

# config.php — verificér INDEN kopi (kan have anden DB-sti eller pool-navn).
# For HQ:
scp /var/www/html/grocy-cafe/config.php leif@hetzner:/home/leif/grocy/hq/config-from-linode.php
ssh leif@hetzner "diff /home/leif/grocy/hq/config-from-linode.php /home/leif/grocy/hq/config.php"
# Merge custom-keys (API_KEY, default_locale, evt. plugins) manuelt — gentag for andre instanser
```

### 2.4 Fix ejerskab + permissions på Hetzner

```bash
# På Hetzner
cd /home/leif/grocy/hq
sudo chown -R www-data:www-data data/   # eller den bruger PHP-FPM kører som
sudo chmod 644 data/grocy.db
sudo chmod -R 755 data/storage data/plugins
```

> **Tjek `/etc/php/8.x/fpm/pool.d/grocy-hq.conf` for at finde præcis hvilken bruger pool'en kører som.**

### 2.5 Start PHP-FPM + verificér

```bash
sudo systemctl start php8.x-fpm
sudo systemctl status php8.x-fpm

# Test direkte mod socket (inden DNS):
echo "Modify /etc/hosts: <HETZNER-IP> grocy-hq.ristetrug.dk"
curl -k https://grocy-hq.ristetrug.dk/api/system/info -H "GROCY-API-KEY: <key>"
# Forventet: JSON med version, opsætning
```

### 2.6 Smoke-test fra Bon v2

```bash
# Bon v2 kører stadig — tjek at den nu kan tale med ny Grocy
curl http://127.0.0.1:4321/api/grocy/recipes/today  # eller relevant endpoint
# Forventet: liste af opskrifter, ingen 5xx
```

### 2.7 DNS-flip Grocy-domæner

Pr. domæne i DNS-panelet:
- `grocy-hq.ristetrug.dk` → Hetzner-IP
- `grocy-test.ristetrug.dk` → Hetzner-IP
- `grocy-trailer.ristetrug.dk` → Hetzner-IP
- `kaelder.ristetrug.dk` → Hetzner-IP

For det gamle `grocycafe.ristetrug.dk`: enten lad det dø (DNS udløber) eller redirect via en simpel NGINX-conf på Hetzner (nice-to-have, ikke nødvendig).

### 2.8 Skift `default_grocy_location_id` til HQ

```sql
-- Find HQ's id
SELECT id FROM locations WHERE code = 'hq';
-- Antaget: 1

UPDATE settings
   SET value = '1', updated_at = CURRENT_TIMESTAMP
 WHERE key = 'default_grocy_location_id';

-- Verificér
SELECT * FROM settings WHERE key = 'default_grocy_location_id';
```

### 2.9 Smoke-test (rigtig produktion)

| Test | Forventet |
|------|-----------|
| Åbn `kitchen/today.html`, klik på en bon → Råvarer | Lagerstatus vises (røde/gule/grønne pills) |
| Køkken: skift status til LEVERET | Lagertræk i Grocy-HQ |
| Indkøb: åbn shopping list | Genereret fra rigtig HQ |
| Varemodtagelse: registrér en vare | Lagertilgang i HQ |

### 2.10 Hvis det virker → mark Linode-Grocy som FROZEN

```bash
# Linode
sudo systemctl disable php8.x-fpm
sudo systemctl stop php8.x-fpm
```

### 2.11 Rollback (hvis nødvendigt)

```sql
-- I Bon v2 SQLite
.restore data/bon-pre-grocy-cutover.db

-- Skift DNS tilbage
-- Start Linode-Grocy igen
```

Data-tab: ordrer registreret i den korte cutover-vinduet hvor Linode var stoppet og Hetzner ikke endnu virkede.

---

## Bølge 3 — Bon v1 → readonly + iframe-skift

> Bygger på iframe-strategien: Bon v1 forbliver tilgængelig i readonly mens du gradvist skifter formularer.

### 3.1 Sidste sync-v1 + verifikation

```bash
# På Hetzner — kør manuelt, ikke via cron
node /home/leif/bon-v2/scripts/sync-v1.js --full

# Spot-check 5 nyere bonner (fra de seneste dage på Linode)
sqlite3 /home/leif/bon-v2/data/bon.db \
  "SELECT bon_number, delivery_date, total_price FROM bons ORDER BY id DESC LIMIT 5;"
# Sammenlign med Bon v1 — alt skal matche
```

### 3.2 Stop sync-v1 cron

```bash
crontab -e
# Kommentér ud (eller slet):
# 0 4 * * * /home/leif/bon-v2/scripts/sync-v1.js
```

> **Fra dette punkt skriver Bon v2 selvstændigt — Linode er ikke længere kilde.**

### 3.3 Sæt Bon v1 i readonly

To muligheder:

**A) NGINX-niveau (anbefalet):**

```nginx
# På Linode's nginx-config for Bon v1
location / {
    if ($request_method !~ ^(GET|HEAD|OPTIONS)$) {
        return 503 "Bon v1 is in readonly mode. Use Bon v2 at https://bon.ristetrug.dk";
    }
    # ... eksisterende proxy_pass
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**B) App-niveau:**

Sæt en miljøvariabel som `READONLY=true` og lad Bon v1 returnere 503 på alle skrivende endpoints.

### 3.4 Banner i Bon v1

Tilføj en gul banner-stripe øverst på alle Bon v1-sider:

> ⚠ **Bon v1 er i readonly-tilstand. Nye ordrer går til [Bon v2](https://bon.ristetrug.dk). Denne version er kun til opslag.**

### 3.5 Iframe-skift på hjemmesiden

Dette er det rigtige cutover-punkt for nye ordrer:

```html
<!-- WordPress DIVI Code Module — UDSKIFT: -->

<!-- GAMMEL (Jotform → Bon v1): -->
<iframe src="https://form.jotform.com/..." ...></iframe>

<!-- NY (Bon v2 embed-formular): -->
<!-- Indhold fra docs/wordpress_divi_snippet.html -->
```

Sav i WordPress, clear cache.

### 3.6 Smoke-test

| Test | Forventet |
|------|-----------|
| Gå til ristetrug.dk/bestil | Ny formular vises |
| Indsend en testbon | Lander i Bon v2 (`bons`-tabel + `web_orders`-tabel) |
| Kontoret: åbn Bon v2 → Listview | Testbon synlig som NY |
| Bon v1: prøv at oprette en ordre | 503 eller spærret |
| Bon v1: åbn historisk bon | Virker (readonly) |

### 3.7 Lyt og monitorér 1-2 uger

- Tjek `web_orders`-tabel for fejl
- Verificér mail-modtagelse på `bon@`/`kontakt@`
- Se efter 5xx i NGINX-logs på Hetzner: `tail -f /var/log/nginx/error.log`

### 3.8 Linode-shutdown (4 uger efter)

```bash
# Endnu en snapshot for sikkerhed
# Stop alle Linode-services
sudo systemctl stop nginx php8.x-fpm whiteboard
# Power-off VM via Linode-konsol
# Vent yderligere 4 uger
# Slet VM hvis intet er gået galt
```

---

## Tjekliste — kør igennem inden start

- [ ] DNS-TTL sat til 300s (Bølge 0.1)
- [ ] Hetzner-NGINX, certifikater, snippets verificeret (0.2)
- [ ] Bon v2 session-cookie sat på `.ristetrug.dk` (0.3)
- [ ] Linode VM-snapshot taget (0.4)
- [ ] `/etc/hosts`-smoke-test af alle Hetzner-domæner (0.5)
- [ ] Whiteboard SSE/WebSocket-protokol bekræftet (0.6)
- [ ] Bon v2's `locations`-tabel **ikke** opdateret endnu (vent til 2.1)
- [ ] Sourcecode-grep efter gamle Grocy-URL'er kørt (2.2)
- [ ] Kontoret er informeret om cutover-tidspunkter

---

## Spørgsmål der skal afklares før Bølge 2

1. ~~**Hvad er `kaelder`?**~~ Afklaret: separat vinlager-app, ikke Bon v2. Flyttes som standalone Grocy-instans, ikke i `locations`-tabel
2. ~~**Bruges `grocy-trailer` aktivt?**~~ Afklaret: bruges til sommer — flyttes nu sammen med HQ
3. **Hvilken DB-fil-version bruger Linode-Grocy?** Kør `system/info` på begge før Bølge 2:
   ```bash
   # På Linode (via gammelt domæne eller IP)
   curl https://grocycafe.ristetrug.dk/api/system/info -H "GROCY-API-KEY: <key>" | jq .grocy_version

   # På Hetzner (via /etc/hosts override hvis DNS endnu ikke skiftet)
   curl https://grocy-hq.ristetrug.dk/api/system/info -H "GROCY-API-KEY: <key>" | jq .grocy_version
   ```
   Hvis forskellige → kør Grocy's UI én gang efter copy, lad den auto-migrere
4. **Eksisterer `grocy.db` userfields/custom fields som Bon v2 peger på?** (Fx Hørkram-userfields nævnt i memory: `hk_organic` mfl.) Verificér efter copy — burde virke automatisk hvis hele `grocy.db` kopieres

---

## Hvad er ikke i denne plan (bevidst)

- **e-conomic / Smartplan / By-expressen credentials** — ingen migration, ligger i `.env` som kopieres separat
- **Mail-skabeloner** — ligger i Bon v2's egen DB, flytter med Bon v2
- **Cron-jobs på Hetzner** — `booking-reminders.js`, `sync-v1.js` (deaktiveret efter Bølge 3) — sættes manuelt op i `crontab -e` ifølge eksisterende dokumentation
- **CDN/cache invalidation** — ikke i brug (statisk WordPress)

---

*Skrevet maj 2026 — opdatér efter hver bølge med noter om hvad der gik anderledes end forventet.*
