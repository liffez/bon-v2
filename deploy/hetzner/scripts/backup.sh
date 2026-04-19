#!/bin/bash
# Daglig SQLite backup — Bon v2, Whiteboard, Grocy x4
# Kaldes af systemd timer: bon-v2-backup.timer

set -euo pipefail

BACKUP_DIR=/home/leif/backups
DATE=$(date +%Y-%m-%d)
RETENTION_DAYS=14

mkdir -p "$BACKUP_DIR"

backup_sqlite() {
    local src=$1
    local dest=$2
    if [[ -f "$src" ]]; then
        # Online backup — virker mens appen kører
        sqlite3 "$src" ".backup '$dest'"
        gzip -f "$dest"
        echo "✓ $src → $dest.gz"
    else
        echo "⚠ Springer over (findes ikke): $src"
    fi
}

# Bon v2
backup_sqlite /home/leif/bon-v2/data/bon.db "$BACKUP_DIR/bon-v2-$DATE.db"
backup_sqlite /home/leif/bon-v2/db/sessions.db "$BACKUP_DIR/bon-v2-sessions-$DATE.db"

# Whiteboard (tilpas sti hvis den ligger et andet sted)
if [[ -f /home/leif/whiteboard/db/whiteboard.sqlite ]]; then
    backup_sqlite /home/leif/whiteboard/db/whiteboard.sqlite "$BACKUP_DIR/whiteboard-$DATE.db"
elif [[ -f /home/leif/whiteboard/data/whiteboard.db ]]; then
    backup_sqlite /home/leif/whiteboard/data/whiteboard.db "$BACKUP_DIR/whiteboard-$DATE.db"
fi

# Grocy x4
for INSTANCE in hq trailer test kaelder; do
    backup_sqlite "/home/leif/grocy/$INSTANCE/data/grocy.db" \
                  "$BACKUP_DIR/grocy-$INSTANCE-$DATE.db"
done

# Oprydning
find "$BACKUP_DIR" -name "*.db.gz" -mtime +$RETENTION_DAYS -delete

# Statistik
TOTAL=$(find "$BACKUP_DIR" -name "*.db.gz" | wc -l)
SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "Backup done: $TOTAL filer, $SIZE total"
