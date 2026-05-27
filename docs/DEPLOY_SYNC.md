# Deploy: v1 → v2 Sync

## Oversigt

v1 kører på Linode, v2 kører på Hetzner. Sync-scriptet kører på Hetzner
og læser en lokal kopi af v1-databasen der hentes med rsync.

```
┌──────────┐   rsync/SSH    ┌──────────┐
│  Linode  │ ──────────────► │ Hetzner  │
│  v1 bon  │    bon.db       │  v2 bon  │
│  (live)  │   (~14 MB)      │  (live)  │
└──────────┘                 └──────────┘
                              sync-v1.js
                              læser v1.db → skriver v2.db
```

---

## Trin 1: SSH-nøgle på Hetzner

Generér et nøglepar **på Hetzner** (uden passphrase, til cron):

```bash
# På Hetzner
ssh-keygen -t ed25519 -f ~/.ssh/v1_sync_key -N "" -C "bon-v2-sync"
```

Vis public key:
```bash
cat ~/.ssh/v1_sync_key.pub
```

---

## Trin 2: Public key på Linode

Kopiér public key og tilføj den på Linode-serveren:

```bash
# På Linode (som den bruger v1 kører under)
echo "INDSÆT_PUBLIC_KEY_HER" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

**Begræns nøglen** (anbefalet) — tilføj foran nøglen i `authorized_keys`:
```
command="cat /path/to/bon-v1/resources/bon.db",no-pty,no-port-forwarding,no-X11-forwarding ssh-ed25519 AAAA...
```
Dette gør at nøglen KUN kan bruges til at læse bon.db, ikke til shell-adgang.

Alternativt, hvis du vil have fuld rsync-adgang (simplere men mindre sikkert):
```
# Bare tilføj nøglen uden restriktioner
ssh-ed25519 AAAA... bon-v2-sync
```

---

## Trin 3: Firewall på Linode

Åbn port 22 (SSH) for Hetzner-serverens IP:

```bash
# Find Hetzner IP
# På Hetzner:
curl -s ifconfig.me

# På Linode — tilføj firewall-regel
# Via Linode Cloud Manager:
#   Networking → Firewall → Inbound Rules → Add Rule
#   Protocol: TCP, Port: 22, Source: <Hetzner IP>/32

# Eller via CLI:
sudo ufw allow from <HETZNER_IP> to any port 22
```

---

## Trin 4: Test SSH-forbindelse

```bash
# På Hetzner
ssh -i ~/.ssh/v1_sync_key -o StrictHostKeyChecking=accept-new \
    <LINODE_USER>@<LINODE_IP> "echo OK"
```

Forventet output: `OK`

---

## Trin 5: Test rsync

```bash
# På Hetzner
rsync -az -e "ssh -i ~/.ssh/v1_sync_key" \
    <LINODE_USER>@<LINODE_IP>:/path/to/bon-v1/resources/bon.db \
    /opt/bon-v2/data/v1-readonly.db
```

Første kørsel henter hele filen (~14 MB). Efterfølgende kørsler sender kun diff.

---

## Trin 6: .env på Hetzner

Tilføj til `/opt/bon-v2/.env`:
```env
V1_DB_PATH=/opt/bon-v2/data/v1-readonly.db
```

---

## Trin 7: Kør sync manuelt (første gang)

```bash
# På Hetzner
cd /opt/bon-v2

# Test først (ingen ændringer)
node scripts/sync-v1.js --full --dry-run

# Kør for real
node scripts/sync-v1.js --full
```

Verificer med SQL-queries fra CLAUDE_SYNC_MIGRATION.md.

---

## Trin 8: Cron-job

Opret cron på Hetzner:

```bash
crontab -e
```

Tilføj:
```cron
# Bon v1 → v2 sync: dagligt kl. 05:00
0 5 * * * /opt/bon-v2/scripts/sync-v1-cron.sh >> /var/log/bon-sync.log 2>&1
```

Opret wrapper-script `/opt/bon-v2/scripts/sync-v1-cron.sh`:
```bash
#!/bin/bash
set -e

# Hent v1-database
rsync -az -e "ssh -i ~/.ssh/v1_sync_key" \
    <LINODE_USER>@<LINODE_IP>:/path/to/bon-v1/resources/bon.db \
    /opt/bon-v2/data/v1-readonly.db

# Kør sync
cd /opt/bon-v2
node scripts/sync-v1.js
```

Gør den eksekverbar:
```bash
chmod +x /opt/bon-v2/scripts/sync-v1-cron.sh
```

---

## Trin 9: Verificering

Efter første `--full` kørsel:

```bash
sqlite3 /opt/bon-v2/data/bon.db "
  SELECT sync_source, COUNT(*) FROM bons GROUP BY sync_source;
  SELECT COUNT(*) AS companies FROM companies WHERE v1_id IS NOT NULL;
  SELECT COUNT(*) AS customers FROM customers WHERE v1_id IS NOT NULL;
"
```

Forventet:
```
v1|~2897
(null)|0     (eller antal native v2-bons)
~1231
~1468
```

---

## Fejlfinding

| Problem | Løsning |
|---------|---------|
| `Permission denied (publickey)` | Tjek at public key er i authorized_keys på Linode |
| `Connection timed out` | Tjek firewall på Linode (port 22 åben for Hetzner IP) |
| rsync: `No such file or directory` | Tjek v1 database-sti på Linode |
| sync-v1.js: `UNIQUE constraint failed` | Scriptet er idempotent — kør igen |
| sync-v1.js: `database is locked` | Tjek at v2-serveren ikke har lukket DB |

---

## Placering af filer

```
/opt/bon-v2/
├── .env                          ← V1_DB_PATH=/opt/bon-v2/data/v1-readonly.db
├── data/
│   ├── bon.db                    ← v2 database (live)
│   └── v1-readonly.db            ← kopi af v1 database (rsync)
├── scripts/
│   ├── sync-v1.js                ← sync-script
│   └── sync-v1-cron.sh           ← wrapper med rsync + sync
└── ...

~/.ssh/
├── v1_sync_key                   ← privat nøgle (Hetzner)
└── v1_sync_key.pub               ← public nøgle (kopieret til Linode)
```

---

## Variabler der skal udfyldes

| Variabel | Beskrivelse | Eksempel |
|----------|-------------|---------|
| `<LINODE_IP>` | Linode serverens IP-adresse | `172.x.x.x` |
| `<LINODE_USER>` | Bruger på Linode | `bon` |
| `<HETZNER_IP>` | Hetzner serverens IP-adresse | `65.x.x.x` |
| `/path/to/bon-v1/resources/bon.db` | Sti til v1-database på Linode | `/home/bon/bonServer/resources/bon.db` |
