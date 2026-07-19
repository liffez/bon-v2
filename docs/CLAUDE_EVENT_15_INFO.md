# §15 — Event info-side (tillæg til CLAUDE_EVENT.md)

> Læs FØR kode: `CLAUDE.md`, `BON_V2_PRINCIPPER.md`, `bon_v2_datamodel_v2.md`, `CLAUDE_EVENT.md` §8–9, §14.
> Status: SPEC — klar til implementering.

---

## Problem (én sætning)

Praktisk event-info (telefonnumre, åbningstider, kasseapparat-vejledning, kort, filer/billeder) ligger
spredt; det skal samles ét sted på event-entiteten — mens opgaver/tjeklister forbliver i Whiteboard,
som Bon v2 kun linker til (samme mønster som SOP-deep-links, ingen integration).

---

## Beslutninger (Leif, jul 2026)

| Beslutning | Valg |
|------------|------|
| Tjeklister/opgaver | Whiteboard — Bon v2 linker kun (manuel URL pr. event) |
| Info-format | Fritekst, skabelon-forudfyldt — INGEN strukturerede felter, ingen sync fra bons |
| Filer | Eksisterende `attachments`-tabel, `entity_type='event'` |
| `events.notes` | Berøres ikke — korte driftsnoter og info-side er to forskellige ting |

---

## Migration `116_event_info.sql`

```sql
ALTER TABLE events ADD COLUMN info TEXT;
ALTER TABLE events ADD COLUMN whiteboard_url TEXT;
```

**Verificér før kørsel (grep):** at `attachments`-tabellen fra `bon_v2_datamodel_v2.md` faktisk er
oprettet i en kørt migration (`grep -rn "CREATE TABLE attachments" db/migrations/`). Hvis IKKE:
inkludér tabel + index (ordret fra datamodellen) i 116.

Migrationer genkøres aldrig. Begge kolonner nullable — eksisterende events uberørte.

---

## Settings

| Nøgle | Default |
|-------|---------|
| `event_info_template` | Skelet-tekst, se nedenfor |

```
## Kontakt
(navn · telefon · rolle)

## Åbningstider
(salgstider pr. dag · adgang til pladsen)

## Kasseapparat
(login · procedure · fejlsøgning)

## Adresse & kort
(pladsens adresse · standplads-nr · kørselsvejledning)

## Praktisk
(strøm · vand · koder · parkering)
```

Skabelonen indsættes **client-side** i textarea'en når info-feltet åbnes og er tomt/NULL.
Den gemmes først når brugeren trykker Gem — et event der aldrig får udfyldt info, forbliver NULL.
Ren tekst hele vejen; `##`-linjerne er visuel konvention, ikke parset markdown.

---

## Backend (`routes/events.js`)

| Endpoint | Gør |
|----------|-----|
| `PATCH /api/events/:id` | Udvid eksisterende update med `info` + `whiteboard_url` (whitelist-felter, changelog via `logChange`) |
| `GET /api/events/:id/attachments` | Liste fra `attachments` WHERE `entity_type='event' AND entity_id=:id` |
| `POST /api/events/:id/attachments` | Upload — se filhåndtering nedenfor |
| `DELETE /api/events/:id/attachments/:attId` | Slet række + fil på disk (verificér `entity_type='event'` og `entity_id` matcher — ingen cross-entity-sletning) |

- Identitet altid fra `req.session.userId` (`uploaded_by_user_id`) — aldrig request body.
- Changelog på upload/slet (`entity_type='event'`, action create/delete).
- SSE: ikke nødvendigt i v1 (info-siden er ikke realtid-kritisk). Kan tilføjes senere.

### Filhåndtering — ingen ny npm-pakke

Node/Express har ingen indbygget multipart-parser, og nye pakker kræver godkendelse.
Derfor: **raw body-upload** i stedet for multipart:

```
POST /api/events/:id/attachments?filename=kort.pdf
Content-Type: application/pdf
<rå filbytes som body>
```

- `express.raw({ type: '*/*', limit: '20mb' })` kun på denne route.
- `filename` fra querystring — sanitér (basename, whitelist-tegn, max-længde).
- MIME-whitelist: billeder (jpg/png/webp/heic), pdf, txt/md. Afvis resten med 415.
- Diskplacering: `data/uploads/events/<event_id>/<timestamp>_<safe_filename>` — relativ sti gemmes i `attachments.file_path`.
- `GET /api/attachments/:id/file` (eller genbrug eksisterende serve-mekanisme hvis mail-attachments allerede har én — **grep først**) med korrekt `Content-Type` + `Content-Disposition`.

Hvis Simon hellere vil have multer: kræver Leifs godkendelse (BON_V2_PRINCIPPER: nye pakker).

---

## UI (`office/views/events.js` + `.css`)

Ny pill i event-viewet: `Overblik · Pakkeliste · Salg pr. dag · Retur & afstemning · Økonomi · **Info**`

Info-siden (top til bund):

1. **Whiteboard-knap** — vises kun hvis `whiteboard_url` er sat. Åbner i ny fane. Lille ✎ ved siden af til at sætte/rette URL (prompt eller inline-felt).
2. **Info-tekst** — visning: escaped tekst, linjeskift bevaret, URL'er auto-linkes (vanilla regex, `target=_blank rel=noopener`). `##`-linjer renderes med fed/større via simpel klasse. Redigér-knap → textarea (skabelon-prefill hvis tom) → Gem/Annuller.
3. **Filer** — liste (filnavn, størrelse, dato, uploader) med download-link + slet (confirm). Upload-knap: `<input type="file">` → fetch med rå body. Billeder kan vises som thumbnails (senere — ikke krav i v1).

Touch-hensyn: siden skal fungere på tablet/mobil (man står på pladsen og slår kassekoden op).
Ingen ny densitet — genbrug tokens.

---

## Genbruger / Nyt

**Genbruger:** `attachments`-tabellen (datamodel), `logChange`, events-CRUD, pill-navigation i events-viewet.
**Nyt:** migration 116 (2 kolonner) · upload/serve/delete-endpoints · Info-pill · `event_info_template`-setting.

---

## Tests

`scripts/test-event-attachments.js` (node:test):
- upload → række i `attachments` + fil på disk → GET-liste indeholder den → DELETE fjerner begge.
- Afvist MIME (415) · filnavn-sanitering (`../../etc/passwd` → safe basename) · fremmed `entity_id` kan ikke slettes via event-endpoint.
- PATCH info/whiteboard_url skriver changelog.

---

## Afgrænsning (bevidst IKKE med)

- Ingen strukturerede info-felter, ingen felt-sync fra bons — skabelonen er strukturen.
- Ingen Whiteboard-API-integration — kun link.
- Ingen markdown-parser, ingen WYSIWYG.
- Ingen thumbnails/preview i v1.
