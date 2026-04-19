#!/bin/bash
# Installerer alle deploy/hetzner/ configs til de rigtige steder på serveren.
# Idempotent — kan køres flere gange. Ændringer kræver root.
#
# Brug:
#   cd /home/leif/bon-v2/deploy/hetzner
#   sudo ./scripts/install-configs.sh
#
# Kører IKKE apt install, certbot eller app-start — kun filer + symlinks + reload.

set -euo pipefail

DEPLOY_DIR=/home/leif/bon-v2/deploy/hetzner

if [[ $EUID -ne 0 ]]; then
    echo "Skal køres som root (sudo)"
    exit 1
fi

echo "─── systemd units ──────────────────────────────────────"
for unit in bon-v2.service whiteboard.service sop.service \
            bon-v2-backup.service bon-v2-backup.timer; do
    cp "$DEPLOY_DIR/systemd/$unit" "/etc/systemd/system/$unit"
    echo "  ✓ /etc/systemd/system/$unit"
done

echo "─── nginx snippets ─────────────────────────────────────"
mkdir -p /etc/nginx/snippets
for snippet in bon-auth.conf ssl-common.conf; do
    cp "$DEPLOY_DIR/nginx/snippets/$snippet" "/etc/nginx/snippets/$snippet"
    echo "  ✓ /etc/nginx/snippets/$snippet"
done

echo "─── nginx vhosts ───────────────────────────────────────"
for vhost in bon.ristetrug.dk whiteboard.ristetrug.dk sop.ristetrug.dk \
             grocy-hq.ristetrug.dk grocy-trailer.ristetrug.dk \
             grocy-test.ristetrug.dk kaelder.ristetrug.dk; do
    cp "$DEPLOY_DIR/nginx/sites-available/$vhost.conf" \
       "/etc/nginx/sites-available/$vhost.conf"
    ln -sf "/etc/nginx/sites-available/$vhost.conf" \
           "/etc/nginx/sites-enabled/$vhost.conf"
    echo "  ✓ /etc/nginx/sites-available/$vhost.conf"
done

echo "─── PHP-FPM pools ──────────────────────────────────────"
for pool in grocy-hq grocy-trailer grocy-test grocy-kaelder; do
    cp "$DEPLOY_DIR/php-fpm/$pool.conf" "/etc/php/8.5/fpm/pool.d/$pool.conf"
    echo "  ✓ /etc/php/8.5/fpm/pool.d/$pool.conf"
done
mkdir -p /var/log/php-fpm
chown www-data:www-data /var/log/php-fpm

echo "─── Reload ─────────────────────────────────────────────"
systemctl daemon-reload
nginx -t
echo "  (Kør 'systemctl reload nginx' og 'systemctl restart php8.5-fpm' når du er klar)"
echo ""
echo "Configs installeret. Næste skridt: se HETZNER_DEPLOY.md"
