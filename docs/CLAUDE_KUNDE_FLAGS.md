# CLAUDE_KUNDE_FLAGS.md
> Påmindelser ("flags") på kunder og firmaer der hejses på fremtidige bonner.
> Læs `docs/BON_V2_PRINCIPPER.md`, `docs/bon_v2_datamodel_v2.md`, `docs/CLAUDE_KONTAKTER.md`
> og eksisterende `office/views/crm-kunde360.js` + `office/views/crm-firma360.js` + `shared/bon_drawer.js`
> FØR du starter.
> Opdateret: maj 2026

---

## Mål

En lille men ofte savnet feature: stående eller engangs-påmindelser på kunder og firmaer, der **hejses ved bon-oprettelse og bon-åbning**. Eksempler:

- "Send cookies som tak næste gang" *(engangs — handles én gang)*
- "Tjek altid leveringstidspunkt — skriver konsekvent forkert" *(stående — minder office hver gang)*
- "Fakturaer skal til Anne, IKKE faktura@-adressen" *(stående firma-flag)*

Forskellen fra `crm_activities` (type `note`/`task`): et flag er en **aktiv tilstand** der lever indtil dismissed, ikke en historisk log-post.

---

## Designbeslutninger (afgjort med Leif)

> - **Polymorf datamodel** — `entity_flags(entity_type, entity_id)` matcher `contact_points`-mønstret. Et flag tilhører ENTEN en kunde ELLER et firma (XOR), aldrig begge.
> - **Ingen severity-niveauer** — alle flag er ens. Kan tilføjes senere uden migration hvis behov opstår.
> - **To handlinger:** `Set` (per-bon-ack, flag lever videre) og `Gjort` (permanent dismiss). Ingen `auto_dismiss`-felt — brugeren vælger pr. gang.
> - **Per-bon-ack** i separat tabel `flag_acks` — én række pr. (flag, bon). UPSERT-idempotent.
> - **Synlighed:**
>   - Strip øverst i bon-drawer (kun office, ikke kitchen)
>   - 🚩-badge i `customer`-kolonnen i `bons-list.js`
>   - Sidebar-sektion i Kunde 360° (erstatter `.k3-quick-note` med kombineret note/påmindelse)
>   - Sidebar-sektion i Firma 360° (samme komponent)
>   - 🚩-badge i `crm-firmaer.js` listview
> - **Opret/redigér** sker kun fra Kunde 360° og Firma 360°. Ikke fra bon-kontekst.
> - **Klikbart kundenavn/firmanavn i bon-drawer** → cross-link til Kunde 360°/Firma 360° via `?view=kontakter&tab=...` (samme mønster som `CLAUDE_KONTAKTER.md` §6.3)
> - **Strip-defaults:** Expanded når 1 flag, collapsed når 2+. Klik på 🚩-badge i listview åbner drawer med strip force-expanded.
> - **Genbrug af "Hurtig note":** den eksisterende `.k3-quick-note` ombygges til kombineret "TILFØJ"-sektion med radio-toggle. Default: `Påmindelse`. Toggle til `Note` for at gemme i `crm_activities` som hidtil.
> - **Aktivitet-tab:** dismissed flag vises som læse-only timeline-items i Aktivitet-fanen (nyt `dismissed_flag`-icon-mønster) — så fuld kunde-historik bevares ét sted.
> - **Zone-isolation:** CRM-views er allerede office-only. Drawer-strip og listview-badge skjules i kitchen via CSS-klassen `.zone-kitchen`.
> - **Cutover-blokker:** Nej. Dette er en kvalitets-tilføjelse efter cutover.

---

## Faser

| # | Fase | Risiko | Afhænger af |
|---|------|--------|-------------|
| 1 | DB + CRUD-API for `entity_flags` + `flag_acks` | Lav | — |
| 2 | Integration i `routes/bons.js` (flag-array + flag_count) | Lav | 1 |
| 3 | Drawer-strip-komponent `shared/flag_strip.js` + patch i `bon_drawer.js` | Lav | 2 |
| 4 | Listview-badge i `bons-list.js` | Lav | 2 |
| 5 | Sidebar-integration i `crm-kunde360.js` + klikbart navn i bon-drawer | Lav | 1, 3 |
| 6 | Sidebar-integration i `crm-firma360.js` + 🚩-badge i `crm-firmaer.js` | Lav | 5 |
| 7 | Dismissed flag som læse-only timeline-items i Aktivitet-fanen | Lav | 5 |

Hver fase er independent deploybar. Fase 5–7 kan rulles trinvist.

---

## FASE 1 — Datamodel + CRUD

### 1.1 Migration: `db/migrations/0XX_entity_flags.sql`

> Næste ledige migration-nummer (tjek `db/migrations/` — formentlig `069+` baseret på den seneste vi har set).

```sql
-- ==========================================
-- entity_flags: stående/engangs-påmindelser på kunder og firmaer
-- Polymorf — én flag tilhører enten et company eller en customer
--
-- Spec: docs/CLAUDE_KUNDE_FLAGS.md
-- ==========================================

CREATE TABLE entity_flags (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type           TEXT NOT NULL
                          CHECK (entity_type IN ('company', 'customer')),
    entity_id             INTEGER NOT NULL,
    title                 TEXT NOT NULL,
    body                  TEXT,
    created_by_user_id    INTEGER REFERENCES users(id),
    created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dismissed_at          DATETIME,
    dismissed_by_user_id  INTEGER REFERENCES users(id),
    dismissed_on_bon_id   INTEGER REFERENCES bons(id),
    dismiss_note          TEXT
);

-- Partial index: kun aktive flag (hot path)
CREATE INDEX idx_eflags_active
    ON entity_flags(entity_type, entity_id)
    WHERE dismissed_at IS NULL;

-- Full index for historik-queries
CREATE INDEX idx_eflags_entity
    ON entity_flags(entity_type, entity_id);

-- ==========================================
-- flag_acks: per-bon "Set"-handling
-- Bruges til at vise "Set på bon #B3201, #B3219" på kundekortet
-- ==========================================

CREATE TABLE flag_acks (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    flag_id           INTEGER NOT NULL REFERENCES entity_flags(id),
    bon_id            INTEGER NOT NULL REFERENCES bons(id),
    acked_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acked_by_user_id  INTEGER REFERENCES users(id),
    note              TEXT,
    UNIQUE(flag_id, bon_id)
);

CREATE INDEX idx_flag_acks_bon  ON flag_acks(bon_id);
CREATE INDEX idx_flag_acks_flag ON flag_acks(flag_id);
```

### 1.2 Routes: `routes/flags.js` (ny fil)

Følger stil fra `routes/customers.js` og `routes/contact-points.js` (handle-wrapper, `db.prepare()`, `req.session?.user?.id`, `logChange`, `broadcast`).

```javascript
const express   = require('express');
const router    = express.Router();
const { getDb } = require('../db/database');
const { handle, logChange } = require('../db/helpers');
const { broadcast } = require('../shared/sse');

/* ──────────────────────────────────────────
   GET /api/flags?entity_type=&entity_id=&include_dismissed=
   ────────────────────────────────────────── */
router.get('/', handle((req, res) => {
    const db = getDb();
    const { entity_type, entity_id, include_dismissed } = req.query;
    if (!entity_type || !entity_id) {
        return res.status(400).json({ error: 'entity_type og entity_id påkrævet' });
    }
    if (!['company', 'customer'].includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type skal være company eller customer' });
    }

    const where = ['entity_type = ?', 'entity_id = ?'];
    const args  = [entity_type, parseInt(entity_id)];
    if (include_dismissed !== '1') where.push('dismissed_at IS NULL');

    const flags = db.prepare(`
        SELECT f.*,
               u_c.name AS created_by_name,
               u_d.name AS dismissed_by_name,
               b.bon_number AS dismissed_on_bon_number
        FROM entity_flags f
        LEFT JOIN users u_c ON f.created_by_user_id    = u_c.id
        LEFT JOIN users u_d ON f.dismissed_by_user_id  = u_d.id
        LEFT JOIN bons  b   ON f.dismissed_on_bon_id   = b.id
        WHERE ${where.join(' AND ')}
        ORDER BY f.dismissed_at IS NULL DESC, f.created_at DESC
    `).all(...args);

    // Hent ack-historik (bon_numbers + timestamps) for hvert flag
    for (const f of flags) {
        f.ack_bons = db.prepare(`
            SELECT b.id, b.bon_number, fa.acked_at, fa.note
            FROM flag_acks fa
            JOIN bons b ON fa.bon_id = b.id
            WHERE fa.flag_id = ?
            ORDER BY fa.acked_at DESC
        `).all(f.id);
    }
    res.json(flags);
}));

/* ──────────────────────────────────────────
   POST /api/flags
   Body: { entity_type, entity_id, title, body? }
   ────────────────────────────────────────── */
router.post('/', handle((req, res) => {
    const db = getDb();
    const { entity_type, entity_id, title, body } = req.body;

    if (!['company', 'customer'].includes(entity_type)) {
        return res.status(400).json({ error: 'entity_type skal være company eller customer' });
    }
    if (!entity_id) return res.status(400).json({ error: 'entity_id påkrævet' });
    if (!title || !title.trim()) return res.status(400).json({ error: 'title påkrævet' });

    // Verificér entity findes
    const tbl = entity_type === 'company' ? 'companies' : 'customers';
    const exists = db.prepare(`SELECT id FROM ${tbl} WHERE id = ?`).get(entity_id);
    if (!exists) return res.status(404).json({ error: entity_type + ' ikke fundet' });

    const userId = req.session?.user?.id || null;
    const result = db.prepare(`
        INSERT INTO entity_flags (entity_type, entity_id, title, body, created_by_user_id)
        VALUES (?, ?, ?, ?, ?)
    `).run(entity_type, entity_id, title.trim(), body || null, userId);

    const id = result.lastInsertRowid;
    logChange({
        entityType: entity_type,
        entityId:   entity_id,
        action:     'flag_created',
        fieldName:  'flag',
        oldValue:   null,
        newValue:   title.trim(),
        userId
    });
    broadcast('flag_created', { id, entity_type, entity_id });
    res.json({ id });
}));

/* ──────────────────────────────────────────
   PATCH /api/flags/:id
   Body: { title?, body? }
   ────────────────────────────────────────── */
router.patch('/:id', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const existing = db.prepare('SELECT * FROM entity_flags WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Flag ikke fundet' });
    if (existing.dismissed_at) {
        return res.status(400).json({ error: 'Flag er dismissed — kan ikke redigeres' });
    }

    const { title, body } = req.body;
    const sets = [];
    const args = [];
    if (title !== undefined) {
        if (!title.trim()) return res.status(400).json({ error: 'title må ikke være tom' });
        sets.push('title = ?'); args.push(title.trim());
    }
    if (body !== undefined) {
        sets.push('body = ?'); args.push(body || null);
    }
    if (!sets.length) return res.json({ ok: true });

    args.push(id);
    db.prepare(`UPDATE entity_flags SET ${sets.join(', ')} WHERE id = ?`).run(...args);

    const userId = req.session?.user?.id || null;
    logChange({
        entityType: existing.entity_type,
        entityId:   existing.entity_id,
        action:     'flag_updated',
        fieldName:  'flag',
        oldValue:   existing.title,
        newValue:   title || existing.title,
        userId
    });
    broadcast('flag_updated', { id, entity_type: existing.entity_type, entity_id: existing.entity_id });
    res.json({ ok: true });
}));

/* ──────────────────────────────────────────
   POST /api/flags/:id/dismiss     ("Gjort"-action)
   Body: { bon_id?, note? }
   ────────────────────────────────────────── */
router.post('/:id/dismiss', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const flag = db.prepare('SELECT * FROM entity_flags WHERE id = ?').get(id);
    if (!flag) return res.status(404).json({ error: 'Flag ikke fundet' });
    if (flag.dismissed_at) return res.status(400).json({ error: 'Allerede dismissed' });

    const { bon_id, note } = req.body;
    const userId = req.session?.user?.id || null;
    db.prepare(`
        UPDATE entity_flags
        SET dismissed_at         = CURRENT_TIMESTAMP,
            dismissed_by_user_id = ?,
            dismissed_on_bon_id  = ?,
            dismiss_note         = ?
        WHERE id = ?
    `).run(userId, bon_id || null, note || null, id);

    logChange({
        entityType: flag.entity_type,
        entityId:   flag.entity_id,
        action:     'flag_dismissed',
        fieldName:  'flag',
        oldValue:   flag.title,
        newValue:   note || 'dismissed',
        userId
    });
    broadcast('flag_dismissed', {
        id, entity_type: flag.entity_type, entity_id: flag.entity_id, bon_id: bon_id || null
    });
    res.json({ ok: true });
}));

/* ──────────────────────────────────────────
   POST /api/flags/:id/ack         ("Set"-action — flag lever videre)
   Body: { bon_id, note? }
   ────────────────────────────────────────── */
router.post('/:id/ack', handle((req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id);
    const { bon_id, note } = req.body;
    if (!bon_id) return res.status(400).json({ error: 'bon_id påkrævet' });

    const flag = db.prepare('SELECT * FROM entity_flags WHERE id = ?').get(id);
    if (!flag) return res.status(404).json({ error: 'Flag ikke fundet' });
    if (flag.dismissed_at) return res.status(400).json({ error: 'Flag er dismissed' });

    const userId = req.session?.user?.id || null;
    // UPSERT — idempotent
    db.prepare(`
        INSERT INTO flag_acks (flag_id, bon_id, acked_by_user_id, note)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(flag_id, bon_id) DO UPDATE SET
            acked_at         = CURRENT_TIMESTAMP,
            acked_by_user_id = excluded.acked_by_user_id,
            note             = excluded.note
    `).run(id, bon_id, userId, note || null);

    broadcast('flag_acked', {
        id, bon_id, entity_type: flag.entity_type, entity_id: flag.entity_id
    });
    res.json({ ok: true });
}));

module.exports = router;
```

### 1.3 Mount i `server.js`

```javascript
app.use('/api/flags', require('./routes/flags'));
```

### 1.4 `shared/api.js` — wrapper-funktioner

Tilføj i samme stil som eksisterende CRM-wrappers:

```javascript
async function fetchFlags(entity_type, entity_id, includeDismissed = false) {
    const params = new URLSearchParams({ entity_type, entity_id });
    if (includeDismissed) params.set('include_dismissed', '1');
    const r = await fetch('/api/flags?' + params);
    if (!r.ok) throw new Error('Kunne ikke hente flag');
    return r.json();
}

async function createFlag(entity_type, entity_id, title, body) {
    const r = await fetch('/api/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity_type, entity_id, title, body })
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Kunne ikke oprette');
    return r.json();
}

async function dismissFlagApi(flagId, bonId, note) {
    const r = await fetch(`/api/flags/${flagId}/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bon_id: bonId, note })
    });
    if (!r.ok) throw new Error('Kunne ikke dismiss');
    return r.json();
}

async function ackFlagApi(flagId, bonId, note) {
    const r = await fetch(`/api/flags/${flagId}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bon_id: bonId, note })
    });
    if (!r.ok) throw new Error('Kunne ikke ack');
    return r.json();
}
```

### Test-spec for fase 1

| Test | Forventet resultat |
|------|-------------------|
| Migration kører på frisk DB | 0 flags, 0 acks |
| Migration er idempotent | Migrationssystem afviser re-kørsel |
| `GET /api/flags?entity_type=customer&entity_id=X` | Returnerer aktive flag, sorteret med aktive først, så nyeste først |
| `GET` med `include_dismissed=1` | Inkluderer historik |
| `POST` med ukendt `entity_id` | 404 |
| `POST` med tom title | 400 |
| `POST` med invalid `entity_type` | 400 |
| `PATCH` på dismissed flag | 400 "Flag er dismissed" |
| `POST /:id/ack` to gange på samme bon | UPSERT — én ack-row, opdateret timestamp |
| `POST /:id/dismiss` to gange | 400 "Allerede dismissed" |
| Alle mutationer | logChange skrevet med korrekt entityType/entityId |
| Alle mutationer | SSE-event broadcastet |

---

## FASE 2 — Integration i bon-API

### 2.1 `GET /api/bons/:id` — vedhæft `flags`-array

Lige før `res.json(bon)` (i `routes/bons.js`):

```javascript
// Aktive flag på både kunden og firmaet (XOR i datamodellen, men begge kan have flag)
bon.flags = [];
if (bon.customer_id || bon.company_id) {
    const conds = [];
    const args  = [bon.id];   // første ? er for EXISTS subquery
    if (bon.customer_id) {
        conds.push("(entity_type = 'customer' AND entity_id = ?)");
        args.push(bon.customer_id);
    }
    if (bon.company_id) {
        conds.push("(entity_type = 'company' AND entity_id = ?)");
        args.push(bon.company_id);
    }
    bon.flags = db.prepare(`
        SELECT f.id, f.entity_type, f.entity_id, f.title, f.body, f.created_at,
               u.name AS created_by_name,
               EXISTS(SELECT 1 FROM flag_acks
                      WHERE flag_id = f.id AND bon_id = ?) AS acked_on_this_bon
        FROM entity_flags f
        LEFT JOIN users u ON f.created_by_user_id = u.id
        WHERE f.dismissed_at IS NULL AND (${conds.join(' OR ')})
        ORDER BY f.created_at DESC
    `).all(...args);
}
```

### 2.2 `GET /api/bons` (listview) — `flag_count` pr. række

Tilføj som korreleret sub-query i SELECT-listen:

```sql
(SELECT COUNT(*) FROM entity_flags ef
 WHERE ef.dismissed_at IS NULL
   AND (
       (ef.entity_type = 'customer' AND ef.entity_id = b.customer_id) OR
       (ef.entity_type = 'company'  AND ef.entity_id = b.company_id)
   )
) AS flag_count
```

### Test-spec for fase 2

| Test | Forventet resultat |
|------|-------------------|
| `GET /api/bons/:id` på bon uden kunde/firma | `flags: []` |
| `GET /api/bons/:id` med kundeflag | `flags` indeholder kun aktive |
| `GET /api/bons/:id` med både kunde- og firmaflag | Begge inkluderet, sorteret efter created_at DESC |
| `acked_on_this_bon` korrekt | 1 hvis flag har ack-row med denne bon_id, 0 ellers |
| Dismissed flag | Ikke i array |
| `GET /api/bons` `flag_count` | Tæller både kunde- og firma-flag korrekt, kun aktive |

---

## FASE 3 — Drawer-strip-komponent

### 3.1 Ny komponent: `shared/flag_strip.js`

```javascript
/**
 * shared/flag_strip.js
 * ════════════════════════════════════════════════════════════
 * Renderer aktive flag for en bons kunde/firma som collapsible strip.
 *
 * API:
 *   const strip = new FlagStrip(containerEl, {
 *       bonId: 1234,
 *       onChange: () => drawer.load(bonId)
 *   });
 *   strip.setFlags(bon.flags);   // fra GET /api/bons/:id
 *   strip.forceExpand();         // når åbnet via 🚩-klik i listview
 * ════════════════════════════════════════════════════════════
 */
class FlagStrip {
    constructor(container, opts) {
        this.el       = container;
        this.bonId    = opts.bonId;
        this.onChange = opts.onChange || (() => {});
        this.flags    = [];
        this.expanded = null;  // null = auto, true/false = tvunget
    }

    setFlags(flags) {
        this.flags = flags || [];
        this.render();
    }

    forceExpand() { this.expanded = true; this.render(); }

    render() {
        if (!this.flags || this.flags.length === 0) {
            this.el.innerHTML = '';
            return;
        }
        const pending = this.flags.filter(f => !f.acked_on_this_bon);
        const open    = this.expanded !== null ? this.expanded : this.flags.length === 1;

        const label = pending.length === 0
            ? '✓ Alle påmindelser håndteret'
            : `${pending.length} påmindels${pending.length === 1 ? 'e' : 'er'} på kunden`;

        this.el.innerHTML = `
            <div class="flag-strip ${open ? 'open' : ''} ${pending.length === 0 ? 'all-handled' : ''}">
                <div class="flag-strip-head" data-act="toggle">
                    <span class="flag-strip-icon">🚩</span>
                    <span class="flag-strip-text">${label}</span>
                    <span class="flag-strip-toggle">${open ? '▴' : '▾'}</span>
                </div>
                <div class="flag-strip-body" ${open ? '' : 'style="display:none"'}>
                    ${this.flags.map(f => this._renderItem(f)).join('')}
                </div>
            </div>
        `;
        this._bind();
    }

    _renderItem(f) {
        const acked = !!f.acked_on_this_bon;
        const targetLabel = f.entity_type === 'company' ? 'firmaet' : 'kunden';
        return `
            <div class="flag-item ${acked ? 'flag-acked' : ''}" data-flag-id="${f.id}">
                <div class="flag-item-text">
                    <div class="flag-item-title">${esc(f.title)}</div>
                    ${f.body ? `<div class="flag-item-body">${esc(f.body)}</div>` : ''}
                    <div class="flag-item-meta">
                        På ${targetLabel} · Tilføjet af ${esc(f.created_by_name || '—')}
                        ${acked ? ' · ✓ Set på denne bon' : ''}
                    </div>
                </div>
                ${acked ? '' : `
                    <div class="flag-actions">
                        <button class="flag-btn"          data-act="ack"     data-flag-id="${f.id}">Set</button>
                        <button class="flag-btn primary"  data-act="dismiss" data-flag-id="${f.id}">Gjort</button>
                    </div>
                `}
            </div>
        `;
    }

    _bind() {
        this.el.querySelectorAll('[data-act="toggle"]').forEach(el => {
            el.addEventListener('click', () => {
                this.expanded = !this.el.querySelector('.flag-strip').classList.contains('open');
                this.render();
            });
        });
        this.el.querySelectorAll('[data-act="ack"]').forEach(el => {
            el.addEventListener('click', async e => {
                try {
                    await ackFlagApi(parseInt(e.target.dataset.flagId), this.bonId);
                    this.onChange();
                } catch (err) { alert('Fejl: ' + err.message); }
            });
        });
        this.el.querySelectorAll('[data-act="dismiss"]').forEach(el => {
            el.addEventListener('click', async e => {
                if (!confirm('Markér som færdig — fjernes permanent fra alle fremtidige bonner?')) return;
                try {
                    await dismissFlagApi(parseInt(e.target.dataset.flagId), this.bonId);
                    this.onChange();
                } catch (err) { alert('Fejl: ' + err.message); }
            });
        });
    }
}
```

### 3.2 CSS — tilføjes i `shared/components.css`

Kopier de relevante regler fra mockup'en (`kunde_flags_mockup.html`):
- `.flag-strip` + `.flag-strip-head` + `.flag-strip-body` + `.flag-strip-foot`
- `.flag-item` + `.flag-item-title` + `.flag-item-body` + `.flag-item-meta`
- `.flag-btn` + `.flag-btn.primary`
- `.flag-acked` (gråtonet)
- `.all-handled` (grøn baggrund når alle håndteret)

### 3.3 Patch i `shared/bon_drawer.js`

**A) DOM** — efter `drawer-header`, før `drawer-body` (omkring linje 61):

```html
<div class="drawer-header">...</div>

<!-- NY -->
<div class="drawer-flags"></div>

<div class="drawer-body">
```

**B) Initialiser i constructor** (efter `this._buildDOM()`):

```javascript
this.flagStrip = new FlagStrip(this.el.querySelector('.drawer-flags'), {
    bonId: null,
    onChange: () => this.load(this.bonId)
});
```

**C) Opdatér load-method** — tilføj options-parameter og kald setFlags:

```javascript
load(bonId, opts = {}) {
    // ... eksisterende fetch-logik ...
    this.flagStrip.bonId = d.id;
    this.flagStrip.setFlags(d.flags || []);
    if (opts.expandFlags) this.flagStrip.forceExpand();
}
```

**D) Zone-isolation** — CSS i `shared/components.css`:

```css
.zone-kitchen .drawer-flags { display: none; }
```

Drawer-DOM'en findes — den er bare skjult når body har `zone-kitchen`.

### Test-spec for fase 3

| Test | Forventet resultat |
|------|-------------------|
| Bon uden flag | `drawer-flags` er tom, ingen DOM |
| Bon med 1 aktivt flag | Strip rendres expanded by default |
| Bon med 2+ aktive flag | Strip rendres collapsed by default |
| Klik på strip-head | Toggler open/closed |
| Klik på `Set` | Flag får `flag-acked`-klasse, count opdateres til "X påmindelser håndteret" |
| Klik på `Gjort` (efter confirm) | Flag forsvinder fra strip, drawer reloader |
| Alle håndteret | Strip viser "✓ Alle påmindelser håndteret" med grøn baggrund |
| `forceExpand()` | Strip åbnes selv ved 2+ flag |
| Zone-kitchen | `.drawer-flags` er `display: none` (CSS-test) |

---

## FASE 4 — Listview-badge

### 4.1 Patch i `office/views/bons-list.js` — render-loop omkring linje 530

```javascript
case 'customer':
    var name = (bon.contact_name_full || '').trim();
    var html = esc(name);
    if (bon.unread_mail_count > 0) {
        html += ' <span class="bl-mail-icon">\u2709'
            + (bon.unread_mail_count > 1 ? bon.unread_mail_count : '') + '</span>';
    }
    if (bon.flag_count > 0) {
        html += ' <span class="bl-flag-badge" data-bon-id="' + bon.id
            + '" title="' + bon.flag_count + ' påmindels'
            + (bon.flag_count > 1 ? 'er' : 'e') + ' på kunden">🚩'
            + (bon.flag_count > 1 ? bon.flag_count : '') + '</span>';
    }
    td1.innerHTML = html;
    break;
```

### 4.2 Klik-handler — efter `tbody.appendChild(tr1)` i samme loop

```javascript
var flagBadge = tr1.querySelector('.bl-flag-badge');
if (flagBadge) {
    flagBadge.addEventListener('click', function(e) {
        e.stopPropagation();
        var bonId = parseInt(this.dataset.bonId);
        if (_blOptions.openDrawer) _blOptions.openDrawer(bonId, { expandFlags: true });
    });
}
```

### 4.3 Opdater `openDrawer`-signatur i `office/index.html`

Find hvor `BonDrawer` instantieres og hvor `openDrawer` defineres som callback. Propagér `opts`-parameter til `drawer.load(id, opts)`.

### 4.4 CSS — `shared/components.css`

```css
.bl-flag-badge {
    display: inline-block;
    background: var(--color-orange, #e8a832);
    color: white;
    font-size: 11px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 3px;
    margin-left: 4px;
    cursor: pointer;
    line-height: 1.3;
}
.bl-flag-badge:hover { filter: brightness(0.9); }
```

### Test-spec for fase 4

| Test | Forventet resultat |
|------|-------------------|
| Bon-række hvor `flag_count = 0` | Ingen badge |
| Bon-række med `flag_count = 1` | Vises som "🚩" (uden tal) |
| Bon-række med `flag_count > 1` | Vises som "🚩N" |
| Klik på badge | Drawer åbner med flag-strip force-expanded |
| Klik på rest af rækken | Drawer åbner som normalt (strip default-collapse for 2+) |

---

## FASE 5 — Kunde 360° integration

### 5.1 Ombyg `.k3-quick-note` i `crm-kunde360.js` (linje 994–999)

Erstat den eksisterende sektion med en kombineret "AKTIVE PÅMINDELSER" + "TILFØJ"-sektion:

```javascript
// Aktive påmindelser (vises kun hvis der er nogle)
if (_k3Data.flags && _k3Data.flags.length) {
    html += '<div class="k3-flags-section">' +
        '<h4>Aktive påmindelser</h4>' +
        _k3Data.flags.map(f =>
            '<div class="k3-flag-card" data-flag-id="' + f.id + '">' +
                '<div class="k3-flag-title">🚩 ' + esc(f.title) + '</div>' +
                (f.body ? '<div class="k3-flag-body">' + esc(f.body) + '</div>' : '') +
                '<div class="k3-flag-meta">Tilføjet ' + formatDanishDate(f.created_at) +
                    (f.ack_bons && f.ack_bons.length ? ' · Set på ' + f.ack_bons.length + ' bon(er)' : '') +
                '</div>' +
                '<button class="k3-flag-remove" onclick="_k3RemoveFlag(' + f.id + ')">×</button>' +
            '</div>'
        ).join('') +
    '</div>';
}

// Kombineret tilføj-input (erstatter den gamle Hurtig note)
html += '<div class="k3-quick-add">' +
    '<h4>Tilføj</h4>' +
    '<div class="k3-qa-type">' +
        '<label><input type="radio" name="k3qaType" value="flag" checked> Påmindelse <span class="k3-qa-hint">(hejses på fremtidige bonner)</span></label>' +
        '<label><input type="radio" name="k3qaType" value="note"> Note <span class="k3-qa-hint">(gemmes i aktivitet)</span></label>' +
    '</div>' +
    '<input type="text" id="k3QaTitle" class="k3-qa-title" placeholder="Titel">' +
    '<textarea id="k3QaBody" class="k3-qa-body" placeholder="Detalje (valgfri)"></textarea>' +
    '<button class="k3-qa-btn" onclick="_k3SubmitQuickAdd()">Gem</button>' +
'</div>';
```

### 5.2 Submit-handler (erstatter `_k3SubmitQuickNote`)

```javascript
async function _k3SubmitQuickAdd() {
    const type  = document.querySelector('input[name="k3qaType"]:checked').value;
    const title = document.getElementById('k3QaTitle').value.trim();
    const body  = document.getElementById('k3QaBody').value.trim();
    if (!title) { alert('Skriv en titel'); return; }

    try {
        if (type === 'flag') {
            await createFlag('customer', _k3CustomerId, title, body);
        } else {
            // Bevarer eksisterende crm_activities-flow — title + body kombineres
            await postCrmActivity({
                customer_id: _k3CustomerId,
                type: 'note',
                text: body ? title + '\n\n' + body : title,
            });
        }
        document.getElementById('k3QaTitle').value = '';
        document.getElementById('k3QaBody').value = '';
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}

async function _k3RemoveFlag(flagId) {
    if (!confirm('Fjern denne påmindelse permanent?')) return;
    try {
        await dismissFlagApi(flagId, null, 'Fjernet fra kundekortet');
        _k3LoadData();
    } catch (err) {
        alert('Fejl: ' + err.message);
    }
}
```

### 5.3 Backend — udvid `GET /api/crm/customer/:id` med `flags`-array

Den eksisterende kunde-detalje endpoint skal returnere aktive flag. Tilføj før `res.json(...)`:

```javascript
customer.flags = db.prepare(`
    SELECT f.*,
           (SELECT COUNT(*) FROM flag_acks WHERE flag_id = f.id) AS ack_count
    FROM entity_flags f
    WHERE f.entity_type = 'customer' AND f.entity_id = ? AND f.dismissed_at IS NULL
    ORDER BY f.created_at DESC
`).all(customer.id);

// Ack-bons per flag (kun seneste 10 til display)
for (const f of customer.flags) {
    f.ack_bons = db.prepare(`
        SELECT b.id, b.bon_number, fa.acked_at
        FROM flag_acks fa JOIN bons b ON fa.bon_id = b.id
        WHERE fa.flag_id = ? ORDER BY fa.acked_at DESC LIMIT 10
    `).all(f.id);
}
```

### 5.4 Klikbart firmanavn i `shared/kunde_soeg.js`

I `renderSelected()` (linje 371) — gør `personRow` og `compRow` klikbare, kun i office:

```javascript
// Person
const name = document.createElement('div');
name.className = 'ks-sel-name';
name.textContent = this.selected.customer_name || '—';
if (document.body.classList.contains('zone-office') && this.selected.customer_id) {
    name.classList.add('ks-sel-name-link');
    name.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = new URL(window.location);
        url.searchParams.set('view', 'kontakter');
        url.searchParams.set('tab', 'personer');
        url.searchParams.set('customer', this.selected.customer_id);
        history.pushState({}, '', url);
        if (window.switchView) window.switchView('kontakter');
    });
}
```

Tilsvarende for `cname` med `tab=firmaer` og `company=...`.

CSS:
```css
.ks-sel-name-link {
    cursor: pointer;
    text-decoration: underline dotted;
    text-underline-offset: 3px;
}
.ks-sel-name-link:hover { color: var(--brand-primary); }
```

### Test-spec for fase 5

| Test | Forventet resultat |
|------|-------------------|
| Kundekort uden flag | Ingen "Aktive påmindelser"-sektion, kun "Tilføj" |
| Kundekort med flag | Sektion vises med liste, hver flag har × til fjern |
| Toggle = `Påmindelse`, submit | POST `/api/flags`, kortet reloader, flaget vises |
| Toggle = `Note`, submit | POST `/api/crm/activity` med type=note, går i timeline |
| Klik × på flag | Confirm → POST `/api/flags/:id/dismiss` |
| Klik kundenavn i bon-drawer | URL bliver `?view=kontakter&tab=personer&customer=ID`, view skifter |
| Klik kundenavn i kitchen (zone-kitchen) | Intet sker (handler ikke bundet) |

---

## FASE 6 — Firma 360° integration + listview-badge

### 6.1 Samme sidebar-integration i `crm-firma360.js`

Spejl §5.1–5.2 med `'company'` i stedet for `'customer'`, og firmakort-state i stedet for `_k3CustomerId`. Backend: udvid `GET /api/crm/company/:id` (jf. `CLAUDE_KONTAKTER.md` §6.2) med samme `flags`-array.

### 6.2 🚩-badge i `crm-firmaer.js` listview

I `cfRender()`, tilføj badge ved firma-navnet (kræver at `GET /api/crm/companies` returnerer `flag_count`):

```javascript
// I cf-name-row, efter firmanavnet:
${co.flag_count > 0 ? `<span class="cf-flag-badge" title="${co.flag_count} påmindelse${co.flag_count > 1 ? 'r' : ''}">🚩${co.flag_count > 1 ? co.flag_count : ''}</span>` : ''}
```

Backend: tilføj subquery til `GET /api/crm/companies`:

```sql
(SELECT COUNT(*) FROM entity_flags ef
 WHERE ef.entity_type = 'company' AND ef.entity_id = co.id
   AND ef.dismissed_at IS NULL
) AS flag_count
```

### 6.3 Samme for Personer-listview

Hvis der findes en personer-listview (sandsynligvis i `crm-kunde360.js` ved tab-skift, eller separat fil — verificér mod faktisk struktur), tilføj samme `flag_count`-mønster.

### Test-spec for fase 6

| Test | Forventet resultat |
|------|-------------------|
| Firma 360° med firma-flag | "Aktive påmindelser"-sektion synlig |
| Klik × på firma-flag | Dismissed permanent |
| `crm-firmaer.js` listview-række med `flag_count > 0` | 🚩-badge vises |
| Hover på 🚩 i firmaliste | Title-tooltip viser antal |

---

## FASE 7 — Dismissed flag i Aktivitet-fanen

### 7.1 Backend — udvid Aktivitet-endpoint

Inkludér dismissed flag som "syntetiske" aktivitets-rows:

```javascript
// Eksisterende: hent fra crm_activities
const activities = db.prepare(`SELECT ... FROM crm_activities WHERE customer_id = ?`).all(customerId);

// Tilføj dismissed flags som læse-only entries
const dismissedFlags = db.prepare(`
    SELECT f.id, f.title AS text, f.dismiss_note AS note,
           f.dismissed_at AS created_at,
           f.dismissed_by_user_id AS owner_user_id,
           'dismissed_flag' AS type,
           f.dismissed_on_bon_id AS bon_id
    FROM entity_flags f
    WHERE f.entity_type = 'customer' AND f.entity_id = ?
      AND f.dismissed_at IS NOT NULL
`).all(customerId);

// Merge og sortér på timestamp
const merged = [...activities, ...dismissedFlags].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
);

res.json(merged);
```

Tilsvarende for firma-aktivitet (aggregeret via kunder under firmaet jf. `CLAUDE_KONTAKTER.md` designbeslutning).

### 7.2 Frontend — udvid typeIcons og labels i `crm-kunde360.js`

Linje 1140–1142:

```javascript
const typeIcons       = { ..., dismissed_flag: '🚩' };
const typeLabels      = { ..., dismissed_flag: 'Påmindelse afsluttet' };
const typeIconClasses = { ..., dismissed_flag: 'type-flag' };
```

Tilføj læse-only styling så de adskiller sig fra aktive aktiviteter (gråtonet baggrund, ingen redigér-knapper).

### Test-spec for fase 7

| Test | Forventet resultat |
|------|-------------------|
| Aktivitet-fanen viser dismissed flag | Vises med 🚩-icon og "Påmindelse afsluttet" label |
| Sortering korrekt | Blandes med øvrige aktiviteter på `dismissed_at` timestamp |
| Aktive flag | Vises IKKE i Aktivitet-fanen (kun sidebar) |
| Filter-chip "Med smiley" | Filtrerer dismissed flag væk (de har ingen sentiment) |

---

## SSE-events

| Event | Payload | Trigger refresh i |
|-------|---------|-------------------|
| `flag_created`   | `{ id, entity_type, entity_id }` | Bon-drawer hvis åben på relevant entity · Kunde 360°/Firma 360° |
| `flag_updated`   | `{ id, entity_type, entity_id }` | Samme |
| `flag_dismissed` | `{ id, entity_type, entity_id, bon_id }` | Samme + listview flag_count opdateres |
| `flag_acked`     | `{ id, bon_id, entity_type, entity_id }` | Bon-drawer hvis åben på `bon_id` |

---

## Filer der ændres

| Fil | Type ændring |
|-----|--------------|
| `db/migrations/0XX_entity_flags.sql` | NY |
| `routes/flags.js` | NY |
| `server.js` | Mount route |
| `routes/bons.js` | Tilføj flags-array og flag_count |
| `routes/crm.js` | Tilføj flags til customer/:id endpoint, dismissed_flags til activity |
| `routes/companies.js` | Tilføj flags til company/:id endpoint, flag_count til listview |
| `shared/api.js` | Wrapper-funktioner |
| `shared/flag_strip.js` | NY |
| `shared/bon_drawer.js` | DOM + integration |
| `shared/kunde_soeg.js` | Klikbart navn → cross-link |
| `shared/components.css` | Flag-strip + badge styling |
| `office/views/bons-list.js` | Badge i customer-kolonne + klik-handler |
| `office/views/crm-kunde360.js` | Sidebar ombygning + dismissed_flag i activity |
| `office/views/crm-firma360.js` | Samme |
| `office/views/crm-firmaer.js` | Badge i firmaliste |
| `office/index.html` | `openDrawer`-signatur med `opts`-parameter |

---

## Skema-opdatering i `bon_v2_datamodel_v2.md`

Tilføj under "CRM"-sektion:

```mermaid
entity_flags {
    int id PK
    text entity_type "company | customer"
    int entity_id
    text title
    text body "valgfri"
    int created_by_user_id FK
    datetime created_at
    datetime dismissed_at "null = aktiv"
    int dismissed_by_user_id FK
    int dismissed_on_bon_id FK
    text dismiss_note
}

flag_acks {
    int id PK
    int flag_id FK
    int bon_id FK
    datetime acked_at
    int acked_by_user_id FK
    text note "valgfri"
}
```

---

## Åbne tekniske noter

- **Backfill ikke nødvendig** — feature er ny, eksisterende data berøres ikke
- **`crm_activities` med type=`note`** beholdes som er — "Note"-toggle i sidebar-input går stadig dertil
- **Polymorfi-mønstret matcher `contact_points`** — ingen ny stil indført
- **Cutover-prioritet** — denne spec er kvalitets-tilføjelse, ikke cutover-blokker. Bygges efter T_V1_AFSTEMNING er passeret
- **Whiteboard-integration** — ikke relevant; flag er internt office-værktøj
- **Mobile-zone** — ingen flag-synlighed på mobil (matchet med decisionen at mobil = kitchen-lite)

---

*Spec klar til Claude Code · maj 2026 · v2*
