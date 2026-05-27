# Hetzner — Komplet serveropsætning

**Server:** CX23, Ubuntu 24.04  
**Mål:** Bon v2 (allerede installeret) + Whiteboard + SOP + Grocy x4  
**Alle apps:** `/home/bon/` eller `/home/leif/bon-v2/`

---

## Indholdsfortegnelse

1. [Swap-fil](#1-swap-fil)
2. [PHP og Grocy](#2-php-og-grocy)
3. [Whiteboard](#3-whiteboard)
4. [SOP](#4-sop)
5. [Nginx — auth_request + reverse proxy](#5-nginx--auth_request--reverse-proxy)
6. [SSL — certbot for alle domæner](#6-ssl--certbot-for-alle-domæner)
7. [PM2 — startup og cron](#7-pm2--startup-og-cron)
8. [DNS-oversigt](#8-dns-oversigt)
9. [Databasemigrering fra Linode](#9-databasemigrering-fra-linode)

---

## 1. Swap-fil

Hetzner CX23 har ingen swap som standard. Tilføj 2GB som sikkerhedsnet:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Verificer
free -h
```

---

## 2. PHP og Grocy

Grocy er en PHP-applikation. Fire instanser kører i separate mapper med hver sin SQLite-database.

### Installer PHP

```bash
sudo apt update
sudo apt install -y php8.3 php8.3-fpm php8.3-sqlite3 php8.3-mbstring \
  php8.3-intl php8.3-gd php8.3-curl php8.3-zip php8.3-xml
```

### Download og opsæt Grocy x4

```bash
# Opret mappe
sudo mkdir -p /home/bon/grocy
cd /home/bon/grocy

# Download seneste Grocy release
GROCY_VERSION=$(curl -s https://api.github.com/repos/grocy/grocy/releases/latest | grep tag_name | cut -d'"' -f4)
wget "https://github.com/grocy/grocy/releases/download/${GROCY_VERSION}/grocy_${GROCY_VERSION#v}.zip"

# Udpak til alle 4 instanser
for INSTANCE in hq trailer test kaelder; do
  unzip -q "grocy_*.zip" -d "$INSTANCE"
  cp "$INSTANCE/config-dist.php" "$INSTANCE/data/config.php"
done

# Sæt korrekte rettigheder
sudo chown -R www-data:www-data /home/bon/grocy
sudo chmod -R 755 /home/bon/grocy
```

### Konfigurer hver instans

Rediger `data/config.php` i hver mappe. Minimalt:

```php
// /home/bon/grocy/hq/data/config.php
Setting('CURRENCY', 'DKK');
Setting('CULTURE', 'da');
```

### PHP-FPM pools (en per instans)

Opret `/etc/php/8.3/fpm/pool.d/grocy-hq.conf`:

```ini
[grocy-hq]
user = www-data
group = www-data
listen = /run/php/grocy-hq.sock
listen.owner = www-data
listen.group = www-data
pm = dynamic
pm.max_children = 5
pm.start_servers = 1
pm.min_spare_servers = 1
pm.max_spare_servers = 3
```

Gentag for `grocy-trailer`, `grocy-test`, `grocy-kaelder` (skift navn og sock-sti).

```bash
sudo systemctl restart php8.3-fpm
```

---

## 3. Whiteboard

```bash
cd /home/bon
git clone <whiteboard-repo-url> whiteboard
cd whiteboard
npm install --production

# Kopiér .env fra Linode eller opret ny
cp .env.example .env
nano .env
# ALLOWED_ORIGINS=http://localhost:3847,https://whiteboard.ristetrug.dk,https://bon.ristetrug.dk
```

Tilføj til PM2:

```bash
pm2 start /home/bon/whiteboard/server/index.js --name whiteboard
pm2 save
```

---

## 4. SOP

```bash
cd /home/bon
# SOP ligger under bon-mappen på Linode — kopier over:
scp -r bon@<linode-ip>:/home/bon/SOP /home/bon/SOP

cd /home/bon/SOP
npm install --production
```

**Bemærk:** SOP starter kun 8-17 på hverdage via cron (se afsnit 7). Start den IKKE permanent i PM2.

---

## 5. Nginx — auth_request + reverse proxy

Bon v2's `/api/auth/me` returnerer **401** når ikke logget ind — perfekt til `auth_request`.

### Princippet

```
Browser → nginx → auth_request → /api/auth/me (Bon v2)
                                      ↓ 200 OK
                              → proxy_pass til app
                                      ↓ 401
                              → redirect til bon.ristetrug.dk/login
```

### Delte snippets

Opret `/etc/nginx/snippets/bon-auth.conf`:

```nginx
auth_request /bon-auth;
auth_request_set $auth_status $upstream_status;
error_page 401 = @bon_login_redirect;

location = /bon-auth {
    internal;
    proxy_pass https://bon.ristetrug.dk/api/auth/me;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header X-Original-URI $request_uri;
}

location @bon_login_redirect {
    return 302 https://bon.ristetrug.dk/login;
}
```

### whiteboard.ristetrug.dk

```nginx
server {
    listen 443 ssl;
    server_name whiteboard.ristetrug.dk;

    include /etc/nginx/snippets/bon-auth.conf;

    location / {
        proxy_pass http://localhost:3847;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### sop.ristetrug.dk

```nginx
server {
    listen 443 ssl;
    server_name sop.ristetrug.dk;

    include /etc/nginx/snippets/bon-auth.conf;

    location / {
        proxy_pass http://localhost:3005;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
```

### grocy-hq.ristetrug.dk (gentages for trailer, test)

```nginx
server {
    listen 443 ssl;
    server_name grocy-hq.ristetrug.dk;

    root /home/bon/grocy/hq/public;
    index index.php;

    include /etc/nginx/snippets/bon-auth.conf;

    location / {
        try_files $uri $uri/ /index.php$is_args$args;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/run/php/grocy-hq.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

### kaelder.ristetrug.dk (INGEN auth_request — egen app)

```nginx
server {
    listen 443 ssl;
    server_name kaelder.ristetrug.dk;

    root /home/bon/grocy/kaelder/public;
    index index.php;

    location / {
        try_files $uri $uri/ /index.php$is_args$args;
    }

    location ~ \.php$ {
        fastcgi_pass unix:/run/php/grocy-kaelder.sock;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 6. SSL — certbot for alle domæner

```bash
sudo apt install -y certbot python3-certbot-nginx

sudo certbot --nginx -d whiteboard.ristetrug.dk
sudo certbot --nginx -d sop.ristetrug.dk
sudo certbot --nginx -d grocy-hq.ristetrug.dk
sudo certbot --nginx -d grocy-trailer.ristetrug.dk
sudo certbot --nginx -d grocy-test.ristetrug.dk
sudo certbot --nginx -d kaelder.ristetrug.dk
```

Certbot opdaterer nginx-config automatisk med SSL-blokke.

---

## 7. PM2 — startup og cron

### PM2 startup (kører ved reboot)

```bash
pm2 startup
# Kør den kommando PM2 udskriver
pm2 save
```

### SOP på tidsstyring (8-17, man-fre)

SOP startes ikke permanent — kun i åbningstiden. Tilføj til root's crontab:

```bash
crontab -e
```

```
# SOP — start kl. 8, stop kl. 17 (man-fre)
0 8  * * 1-5 /usr/local/bin/pm2 start sop
0 17 * * 1-5 /usr/local/bin/pm2 stop sop && /usr/local/bin/pm2 save
```

Find korrekt PM2-sti med `which pm2`.

### SQLite backup (daglig)

```bash
sudo mkdir -p /home/bon/backups
```

Opret `/home/bon/scripts/backup.sh`:

```bash
#!/bin/bash
DATE=$(date +%Y-%m-%d)
BACKUP_DIR=/home/bon/backups

# Bon v2
sqlite3 /home/leif/bon-v2/data/bon.db ".backup '$BACKUP_DIR/bon-v2-$DATE.db'"

# Whiteboard
sqlite3 /home/bon/whiteboard/db/whiteboard.sqlite ".backup '$BACKUP_DIR/whiteboard-$DATE.db'"

# Grocy
for INSTANCE in hq trailer test kaelder; do
  sqlite3 /home/bon/grocy/$INSTANCE/data/grocy.db ".backup '$BACKUP_DIR/grocy-$INSTANCE-$DATE.db'"
done

# Behold kun 14 dage
find $BACKUP_DIR -name "*.db" -mtime +14 -delete
```

```bash
chmod +x /home/bon/scripts/backup.sh
crontab -e
# Tilføj:
0 3 * * * /home/bon/scripts/backup.sh
```

---

## 8. DNS-oversigt

Alle peger på Hetzner-serverens IP:

| Subdomain | App | Auth |
|-----------|-----|------|
| `bon.ristetrug.dk` | Bon v2 | Eget login |
| `whiteboard.ristetrug.dk` | Whiteboard | Via Bon v2 |
| `sop.ristetrug.dk` | SOP | Via Bon v2 |
| `grocy-hq.ristetrug.dk` | Grocy HQ | Via Bon v2 |
| `grocy-trailer.ristetrug.dk` | Grocy Trailer | Via Bon v2 |
| `grocy-test.ristetrug.dk` | Grocy Test | Via Bon v2 |
| `kaelder.ristetrug.dk` | Grocy Kælder | Eget login |

DNS-ændringer sættes i Simply.com (kun til A-records — ingen mail-ændringer).

---

## 9. Databasemigrering fra Linode

Når alt er testet og klar:

```bash
# Fra Linode — eksportér databaser
sqlite3 /home/bon/bonServer/data/bon.db ".backup 'bon-v1-export.db'"

# Kopiér til Hetzner
scp bon-v1-export.db leif@<hetzner-ip>:/home/bon/backups/

# Grocy-databaser
for INSTANCE in hq trailer test; do
  scp /path/to/grocy/$INSTANCE/data/grocy.db leif@<hetzner-ip>:/home/bon/grocy/$INSTANCE/data/
done
```

**Bon v1 → v2 databasemigrering** er et separat projekt og håndteres ikke her.

---

## Hurtig statustjek

```bash
pm2 list                          # Node.js apps
sudo systemctl status php8.3-fpm  # PHP/Grocy
sudo nginx -t                     # Nginx config OK
free -h                           # RAM/swap
df -h                             # Diskplads
```
