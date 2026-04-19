# Hetzner deployment — step by step

**Server:** Hetzner CX23, Ubuntu 24.04
**Apps:** Bon v2, Whiteboard, SOP, Grocy x4
**Procesmanager:** systemd (ingen PM2)
**Bruger:** `leif` (alle apps under `/home/leif/`)

> Dette dokument erstatter det oprindelige `docs/HETZNER_OPSAETNING.md`
> som stadig henviser til PM2 og `/home/bon/`. Kør dette i stedet.

---

## Oversigt — hvad kører hvor

| App | Port | Systemd unit | Auto-start ved boot | Auth |
|-----|------|--------------|---------------------|------|
| Bon v2 | 4321 | `bon-v2.service` | Ja | Eget login |
| Whiteboard | 3847 | `whiteboard.service` | Ja | Via Bon v2 |
| SOP | 3005 | `sop.service` | Ja | Via Bon v2 |
| Grocy HQ | PHP-FPM sock | `php8.5-fpm.service` | Ja | Via Bon v2 |
| Grocy Trailer | PHP-FPM sock | `php8.5-fpm.service` | Ja | Via Bon v2 |
| Grocy Test | PHP-FPM sock | `php8.5-fpm.service` | Ja | Via Bon v2 |
| Grocy Kælder | PHP-FPM sock | `php8.5-fpm.service` | Ja | Eget login |

---

## Forudsætninger — forstå dette før du starter

### 1. Session-cookie-fixet SKAL deployes først

Bon v2's session-cookie er nu opdateret til at bruge `Domain=.ristetrug.dk`.
Uden denne ændring vil Nginx auth_request på subdomænerne altid få 401 →
uendelig redirect-loop når brugere besøger whiteboard/sop/grocy.

**På serveren — tilføj til `/home/leif/bon-v2/.env`:**

```
NODE_ENV=production
COOKIE_DOMAIN=.ristetrug.dk
SESSION_SECRET=<generér en stærk streng>
```

Generér secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Herefter:
```bash
cd /home/leif/bon-v2
git pull
sudo systemctl restart bon-v2
```

Verificér cookien i browserens DevTools — `connect.sid` skal nu have
`Domain=.ristetrug.dk` (med prik foran) og `Secure ✓`.

### 2. Transition-fase — hvad peger hvor

- `bon.ristetrug.dk` → Hetzner (allerede gjort)
- `whiteboard.ristetrug.dk`, `sop.ristetrug.dk`, `grocytest.ristetrug.dk` → Linode
  (forbliver indtil FVST-besøg)
- Nye subdomæner du opretter nu i parallel: `whiteboard-new.ristetrug.dk`,
  `grocy-hq.ristetrug.dk`, `grocy-trailer.ristetrug.dk`, `grocy-test.ristetrug.dk`,
  `kaelder.ristetrug.dk`. Test på disse inden DNS-switchen.

### 3. Whiteboards CORS på Linode (under transition)

Så længe Whiteboard kører på Linode og brugerne tilgår Bon v2 på Hetzner,
skal Linode-Whiteboards `.env` have:

```
ALLOWED_ORIGINS=http://localhost:3847,https://whiteboard.ristetrug.dk,https://bon.ristetrug.dk
```

Restart Whiteboard på Linode efter ændring.

---

## 1. Swap-fil (hvis ikke allerede sat)

```bash
free -h  # tjek om swap er 0

sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

free -h  # bekræft 2.0G swap
```

---

## 2. Node.js — tjek version

```bash
node --version    # skal være 22.x eller nyere (bruger node:sqlite)
```

Hvis ikke, installér:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 3. PHP 8.5 + moduler til Grocy

PHP 8.5 findes ikke i Ubuntu 24.04's standardrepo — brug Ondřej Surý's PPA:

```bash
sudo apt update
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:ondrej/php
sudo apt update

sudo apt install -y \
    php8.5 php8.5-fpm php8.5-sqlite3 php8.5-mbstring \
    php8.5-intl php8.5-gd php8.5-curl php8.5-zip php8.5-xml \
    unzip
```

Verificér:
```bash
php -v                              # skal vise 8.5.x
systemctl status php8.5-fpm
```

> Hvis den nye Grocy kræver PHP 8.5-specifikke features: tjek den seneste
> Grocy release mod kompatibilitet. Grocy udvikleren plejer at annoncere
> minimum PHP-version i release notes.

---

## 4. Hent og klon apps

### Whiteboard
```bash
cd /home/leif
git clone https://github.com/liffez/whiteboard.git
cd whiteboard
npm ci --omit=dev
cp .env.example .env
nano .env    # udfyld ALLOWED_ORIGINS + credentials
```

### SOP
```bash
cd /home/leif
# Enten fra git:
git clone https://github.com/liffez/SOP.git
# eller fra Linode:
# scp -r leif@139.162.152.53:/home/bon/SOP /home/leif/SOP
cd SOP
npm ci --omit=dev
cp .env.example .env 2>/dev/null || true
```

### Grocy x4
```bash
mkdir -p /home/leif/grocy
cd /home/leif/grocy

GROCY_VERSION=$(curl -s https://api.github.com/repos/grocy/grocy/releases/latest \
                 | grep tag_name | cut -d'"' -f4)
wget "https://github.com/grocy/grocy/releases/download/${GROCY_VERSION}/grocy_${GROCY_VERSION#v}.zip" \
    -O grocy.zip

for INSTANCE in hq trailer test kaelder; do
    mkdir -p "$INSTANCE"
    unzip -q grocy.zip -d "$INSTANCE"
    cp "$INSTANCE/config-dist.php" "$INSTANCE/data/config.php"
done

# Rettigheder — PHP-FPM kører som www-data og skal kunne skrive i data/
sudo chown -R leif:www-data /home/leif/grocy
sudo chmod -R g+w /home/leif/grocy/*/data
```

Rediger valuta/sprog i hver `data/config.php`:
```php
Setting('CURRENCY', 'DKK');
Setting('CULTURE', 'da');
```

---

## 5. Installer configs (én kommando)

```bash
cd /home/leif/bon-v2
git pull
sudo ./deploy/hetzner/scripts/install-configs.sh
```

Scriptet kopierer:
- systemd-units til `/etc/systemd/system/`
- Nginx snippets til `/etc/nginx/snippets/`
- Nginx vhosts til `/etc/nginx/sites-available/` + symlinks til `sites-enabled/`
- PHP-FPM pools til `/etc/php/8.5/fpm/pool.d/`

Det kører `nginx -t` til sidst. Hvis det viser OK:

```bash
sudo systemctl reload nginx
sudo systemctl restart php8.5-fpm
sudo systemctl daemon-reload
```

---

## 6. SSL-certifikater

```bash
sudo apt install -y certbot python3-certbot-nginx

# Alle domæner på én gang:
sudo certbot --nginx \
    -d bon.ristetrug.dk \
    -d whiteboard.ristetrug.dk \
    -d sop.ristetrug.dk \
    -d grocy-hq.ristetrug.dk \
    -d grocy-trailer.ristetrug.dk \
    -d grocy-test.ristetrug.dk \
    -d kaelder.ristetrug.dk
```

Certbot tilføjer SSL-blokke og `ssl_certificate`-linjer automatisk.

**Auto-renewal test:**
```bash
sudo certbot renew --dry-run
```

Systemd-timer `certbot.timer` aktiveres automatisk.

---

## 7. Start apps

```bash
# Bon v2 — burde allerede køre
sudo systemctl enable --now bon-v2

# Whiteboard
sudo systemctl enable --now whiteboard

# SOP
sudo systemctl enable --now sop

# Daglig backup
sudo systemctl enable --now bon-v2-backup.timer
systemctl list-timers | grep backup
```

---

## 8. Første gang — test alle endpoints

Fra din Mac (så du tester fra eksternt netværk):

```bash
# Bon v2
curl -I https://bon.ristetrug.dk/login.html          # 200

# Ikke-logget-ind-test: /api/auth/me
curl -I https://bon.ristetrug.dk/api/auth/me         # 401

# Subdomæner — skal redirecte til bon/login når ikke logget ind
curl -I https://whiteboard.ristetrug.dk              # 302 → bon.../login
curl -I https://grocy-hq.ristetrug.dk                # 302 → bon.../login
curl -I https://kaelder.ristetrug.dk                 # 200 (ingen auth_request)
```

Log derefter ind i browseren på `bon.ristetrug.dk/login.html`, og verificér:
- DevTools → Application → Cookies → `.ristetrug.dk` → `connect.sid` har `Domain=.ristetrug.dk`, `Secure ✓`
- Besøg `whiteboard.ristetrug.dk` i samme browser → ingen redirect, Whiteboard åbner

---

## 9. Daglig drift

```bash
# Status
systemctl status bon-v2 whiteboard sop

# Logs
journalctl -u bon-v2 -f
journalctl -u whiteboard -f
journalctl -u sop --since today

# Restart efter kode-opdatering
cd /home/leif/bon-v2
git pull
sudo systemctl restart bon-v2

# Se næste backup-kørsel
systemctl list-timers bon-v2-backup.timer

# Manuel backup (test)
sudo systemctl start bon-v2-backup
ls -lh /home/leif/backups/

# Tjek at GDrive-synk virker
rclone ls gdrive:bon-v2-backups/ | tail
```

---

## 9b. Backup til Google Drive (valgfri — anbefalet)

Den daglige backup ligger lokalt under `/home/leif/backups/`. For at overleve
diskfejl på serveren bør kopier pushes til ekstern lagring. GDrive via `rclone`
er enkelt og gratis (du har den allerede).

### Engangsopsætning

1. **Installér rclone på serveren:**
    ```bash
    sudo apt install -y rclone
    ```

2. **Konfigurér GDrive-remote på din Mac** (OAuth kræver browser — kan ikke
    laves headless på serveren):
    ```bash
    # På Mac:
    rclone config
    # Vælg: n (new remote)
    # Name: gdrive
    # Storage: drive (Google Drive)
    # Client ID: (tom — brug rclone's default, fungerer fint)
    # Scope: 1 (full access) ELLER 2 (read/write, anbefalet)
    # Service account: n
    # Edit advanced: n
    # Auto config: y (åbner browser, login, godkend)
    # Team drive: n
    ```

3. **Kopiér config til serveren:**
    ```bash
    # Fra Mac:
    scp ~/.config/rclone/rclone.conf leif@<hetzner-ip>:/home/leif/.config/rclone/rclone.conf
    # (Opret mappen først hvis nødvendigt: mkdir -p ~/.config/rclone)
    ```

4. **Test fra serveren:**
    ```bash
    rclone lsd gdrive:    # skal liste GDrive-mapper
    rclone mkdir gdrive:bon-v2-backups
    ```

### Udvid backup.sh med GDrive-push

Tilføj i slutningen af `deploy/hetzner/scripts/backup.sh`:

```bash
# ─── Push til Google Drive ─────────────────────────────────────
if command -v rclone >/dev/null 2>&1; then
    rclone copy "$BACKUP_DIR" gdrive:bon-v2-backups/ \
        --include "*-$DATE.db.gz" \
        --quiet \
    && echo "✓ GDrive synkroniseret"

    # Ryd op i GDrive — behold 30 dage
    rclone delete --min-age 30d gdrive:bon-v2-backups/ --quiet
fi
```

Commit og pull på serveren. Næste natlige backup skubber automatisk til GDrive.

### Alternativ: Hetzner Storage Box

Hvis du senere vil have hurtigere og mere robust backup (~25 kr/mdr for 1 TB,
native SFTP), kan du oprette en Storage Box i Hetzner-konsollen og ændre
remote'en i `backup.sh` — samme script, andet mål. Men GDrive er fint at
starte med.

---

## 10. Databasemigrering (efter FVST)

**Dette er sidste skridt** — kør det når alt andet er testet og du er klar
til at skifte produktions-DNS.

```bash
# Stop apps på Hetzner for at undgå dobbelt-skriv
sudo systemctl stop whiteboard sop bon-v2

# Hent databaser fra Linode
scp leif@139.162.152.53:/home/bon/whiteboard/db/whiteboard.sqlite \
    /home/leif/whiteboard/db/whiteboard.sqlite

for INSTANCE in hq trailer test; do
    scp "leif@139.162.152.53:/path/to/grocy/$INSTANCE/data/grocy.db" \
        "/home/leif/grocy/$INSTANCE/data/grocy.db"
done

# Korrekte rettigheder på Grocy-databaser
sudo chown leif:www-data /home/leif/grocy/*/data/grocy.db
sudo chmod g+w /home/leif/grocy/*/data/grocy.db

# Start alt igen
sudo systemctl start bon-v2 whiteboard
```

**Bon v1 → v2-migrering** håndteres via `scripts/sync-v1.js` som allerede
kører via cron daglig.

---

## 11. Opdater locations-tabel i Bon v2

Når Grocy kører på Hetzner under `grocy-hq.ristetrug.dk`, `grocy-trailer.ristetrug.dk`
osv., skal `locations`-tabellen i Bon v2 opdateres så adaptoren rammer de nye URLs.

Indtil FVST: behold de gamle `grocycafe.ristetrug.dk` og `grocytest.ristetrug.dk`
URLs. Opdater først når DNS skifter og gamle Grocy-instanser er nedlagt.

```sql
-- Kør i /home/leif/bon-v2/data/bon.db
UPDATE locations SET api_url = 'https://grocy-hq.ristetrug.dk/api' WHERE name = 'HQ';
UPDATE locations SET api_url = 'https://grocy-trailer.ristetrug.dk/api' WHERE name = 'Trailer';
UPDATE locations SET api_url = 'https://grocy-test.ristetrug.dk/api' WHERE name = 'Test';
```

---

## 12. Troubleshooting

### "502 Bad Gateway" på whiteboard/sop
App'en kører ikke. Tjek:
```bash
systemctl status whiteboard
journalctl -u whiteboard --since "5 min ago"
```

### "500 Internal Server Error" på grocy
PHP-FPM pool har et problem:
```bash
sudo tail -f /var/log/php-fpm/grocy-hq-error.log
sudo systemctl status php8.5-fpm
```

### Redirect-loop på whiteboard.ristetrug.dk
Cookie-domain er forkert. Tjek:
- `.env` på Hetzner har `COOKIE_DOMAIN=.ristetrug.dk` og `NODE_ENV=production`
- Genstart bon-v2: `sudo systemctl restart bon-v2`
- Log ud og log ind igen (gamle cookies er host-only)
- DevTools bekræfter `Domain=.ristetrug.dk` + `Secure ✓`

### Certbot-fornyelse fejler
```bash
sudo certbot renew --dry-run -v
```

### SSE fungerer ikke (fx flyver-system)
Nginx bufferer. Bekræft at `proxy_buffering off` er sat i bon.ristetrug.dk-vhost.

---

## Filoversigt

```
deploy/hetzner/
├── HETZNER_DEPLOY.md           ← denne fil
├── systemd/
│   ├── bon-v2.service
│   ├── whiteboard.service
│   ├── sop.service
│   └── bon-v2-backup.service + .timer
├── nginx/
│   ├── snippets/
│   │   ├── bon-auth.conf       ← auth_request mod /api/auth/me
│   │   └── ssl-common.conf
│   └── sites-available/
│       ├── bon.ristetrug.dk.conf
│       ├── whiteboard.ristetrug.dk.conf
│       ├── sop.ristetrug.dk.conf
│       ├── grocy-hq.ristetrug.dk.conf
│       ├── grocy-trailer.ristetrug.dk.conf
│       ├── grocy-test.ristetrug.dk.conf
│       └── kaelder.ristetrug.dk.conf
├── php-fpm/
│   ├── grocy-hq.conf
│   ├── grocy-trailer.conf
│   ├── grocy-test.conf
│   └── grocy-kaelder.conf
└── scripts/
    ├── install-configs.sh      ← kopierer alle configs på plads
    └── backup.sh               ← daglig SQLite-backup
```
