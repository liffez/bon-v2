# T_DB — Test-spec for database-integritet

> Verificerer fundamentet for alle øvrige tracks: at migrations producerer en konsistent
> DB, at FK'er er gyldige, at constraints håndhæves, at views virker, og at seed kan
> reproduceres deterministisk.
>
> Køres FØR alle andre tracks — hvis T_DB FAIL'er har det ingen mening at køre T_BON, T_PLAN etc.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Schema-integritet på `data/test.db` efter `npm run test:reset` |
| **Hvad testes IKKE** | Forretningslogik (det er T_BON, T_PLAN m.fl.). Trigger-side-effekter dækkes af T_BON |
| **Forudsætninger** | `npm run test:reset` er kørt (test.db findes med alle 58 migrations + seed_planning) |
| **Køretid** | < 5 sekunder. Ingen server, ingen Grocy |

---

## 2. Faktiske forventede tal (efter test:reset, maj 2026)

| Element | Antal |
|---------|------:|
| Migrations i `_migrations`-tabellen | 58 |
| User-tables (ekskl. `_*` og `sqlite_*`) | 58 |
| Legacy `_old_*` tables (også ekskl.) | 2 |
| Views (`v_*`) | 11 |
| Triggers | 4 |
| Bonner i seed_planning | 8 |
| Bon-linjer i seed_planning | 30 |

Hvis tallene ændrer sig (ny migration, ny tabel) skal facit opdateres.

---

## 3. Test-cases

### 3.1 Schema-inventory

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_DB_INV_01** | Antal migrations | `SELECT COUNT(*) FROM _migrations` = 58 |
| **T_DB_INV_02** | Antal user-tables | 58 |
| **T_DB_INV_03** | Antal views | 11 |
| **T_DB_INV_04** | Antal triggers | 4 |
| **T_DB_INV_05** | `_migrations` har unikke filenames | `SELECT COUNT(DISTINCT filename) = COUNT(*)` |
| **T_DB_INV_06** | Migration-filer matcher kørte migrations | Filer i `db/migrations/*.sql` = filenames i `_migrations` |

### 3.2 FK-integritet

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_DB_FK_01** | `PRAGMA foreign_key_check` returnerer ingen overtrædelser | tom liste |
| **T_DB_FK_02** | `PRAGMA foreign_keys` er ON | 1 |

### 3.3 Views

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_DB_VIEW_01** | Alle 11 views kan SELECTe uden fejl | `SELECT 1 FROM <view> LIMIT 1` virker for alle |

### 3.4 Constraints (regel-tests)

Disse tests laver INSERT'er i en transaction og rollback'er — DB røres ikke permanent.

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_DB_CHK_01** | CHECK på `bons.delivery_type` | INSERT med `delivery_type='ulovligt'` fejler |
| **T_DB_CHK_02** | CHECK på `users.role` | INSERT med `role='hacker'` fejler |
| **T_DB_NN_01** | NOT NULL på `bons.bon_number` | INSERT uden bon_number fejler |
| **T_DB_NN_02** | NOT NULL på `bon_lines.product_name` | INSERT uden product_name fejler |
| **T_DB_UQ_01** | UNIQUE på `bons.bon_number` | Duplikeret bon_number fejler |

### 3.5 Determinisme (seed reproducerbar)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_DB_DET_01** | `npm run test:reset` to gange giver samme data | Row-count pr. tabel uændret efter rerun |

### 3.6 Indexes (kritiske)

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_DB_IDX_01** | Index på `bons.delivery_date` findes | sqlite_master har match |
| **T_DB_IDX_02** | Index på `bon_lines.bon_id` findes | sqlite_master har match |
| **T_DB_IDX_03** | Index på `changelog.entity_id` findes | sqlite_master har match |

---

## 4. Filer der skal eksistere

| Fil | Status |
|-----|--------|
| `tests/specs/T_DB.md` | ✅ |
| `tests/scripts/run_T_DB.js` | ✅ |
| `tests/reports/T_DB_YYYY-MM-DD.md` | ✅ |

---

## 5. Bugs fundet via T_DB

| ID | Bug | Sted | Status |
|----|-----|------|--------|
| infra | `npm run test:reset` ryddede ikke `data/test.db-wal` og `-shm` → "database is locked" når reset kørtes to gange | `package.json` test:reset | ✅ **Fixet** maj 2026 — `rm -f data/test.db data/test.db-wal data/test.db-shm` |

---

## 6. Status — første kørsel maj 2026

```
18 PASS · 0 FAIL · 0 SKIP

INV   6/6   ✓  (migrations, tables, views, triggers)
FK    2/2   ✓  (foreign_key_check, PRAGMA on)
VIEW  1/1   ✓  (alle 11 v_* views queryable)
CHK   2/2   ✓  (delivery_type, users.role)
NN    2/2   ✓  (bons.bon_number, bon_lines.product_name)
UQ    1/1   ✓  (bons.bon_number)
IDX   3/3   ✓  (bons.delivery_date, bon_lines.bon_id, changelog.entity_id)
DET   1/1   ✓  (test:reset reproducerbar)
```

T_DB-tracken er **færdig** for Fase 1.

---

*Sidst opdateret: maj 2026 — efter første kørsel.*
