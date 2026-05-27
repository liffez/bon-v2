# Patch til BON_V2_PRINCIPPER.md — node:sqlite

> Bon v2 bruger Node v22.22.2's indbyggede `node:sqlite` modul (med `--experimental-sqlite` flaget),
> ikke npm-pakken `better-sqlite3`. Bekræftet via `package.json` + `db/database.js` (maj 2026).
> Disse to find/replace bringer principper-doc'et i sync med virkeligheden.

---

## ÆNDRING 1: § 2 STAK — INGEN ALTERNATIVER

**FIND** (i tabellen):

```
| Database | SQLite via better-sqlite3 | PostgreSQL, MySQL, MongoDB |
```

**ERSTAT MED:**

```
| Database | SQLite via `node:sqlite` (indbygget Node 22+) | PostgreSQL, MySQL, MongoDB, better-sqlite3 (native compile) |
```

---

## ÆNDRING 2: § 7 HVAD VI IKKE GØR

**FIND** (linjen):

```
- Ingen ORM (SQL skrives direkte med better-sqlite3)
```

**ERSTAT MED:**

```
- Ingen ORM (SQL skrives direkte med `node:sqlite`)
- Ingen native npm-pakker (vi droppede `better-sqlite3` til fordel for indbygget Node 22 SQLite)
```

---

## Hvorfor det er vigtigt

Bon v2's eget princip § 1: *"når noget ikke passer ind i strukturen, redesignes strukturen — der lappes ikke."*

Når dokumentet siger ét og koden gør noget andet, er det præcis den drift v2 blev skrevet for at undgå. En fremtidig udvikler (eller Claude Code-session) der følger principper-doc'et vil installere `better-sqlite3` som npm-afhængighed og bygge ovenpå det forkerte grundlag. Det er en lappeløsning der bare ikke er bygget endnu.

Synkron rettelse i `CLAUDE.md` (rod) er allerede gjort 4. maj 2026 — der står korrekt `node:sqlite` (indbygget Node 22+).

---

*Patch klar — april/maj 2026.*
