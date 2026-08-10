/**
 * routes/attachments.js
 * Upload + download af vedhæftninger
 */

const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const Busboy  = require('busboy');

const { getDb }       = require('../db/database');
const { handle }      = require('../db/helpers');
const { requireAuth } = require('../shared/auth');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_RE = /^(application\/pdf|image\/|application\/vnd\.openxmlformats)/;
const DATA_DIR = path.join(__dirname, '..', 'data', 'attachments');

function sanitizeFilename(name) {
    return (name || 'file')
        .replace(/[\/\\:*?"<>|]/g, '_')
        .replace(/\s+/g, '_')
        .slice(0, 200);
}

function mimeToFileType(mime) {
    if (!mime) return 'document';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('image/')) return 'image';
    return 'document';
}

// Content-Type til inline-visning udledes af filendelsen (attachments-tabellen
// gemmer kun file_type = image|pdf|document, ikke den fulde MIME).
function extToMime(fileName) {
    const ext = path.extname(fileName || '').toLowerCase();
    const map = {
        '.pdf': 'application/pdf',
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        '.heic': 'image/heic',
    };
    return map[ext] || 'application/octet-stream';
}

// ─── POST /upload ─────────────────────────────────────────────────────────────
// multipart/form-data: file + optional entity_type + entity_id

router.post('/upload', requireAuth(), (req, res) => {
    const bb = Busboy({
        headers: req.headers,
        limits: { fileSize: MAX_FILE_SIZE, files: 1 }
    });

    let entityType = null;
    let entityId   = null;
    let fileData   = null; // { filename, mime, buffer, truncated }

    bb.on('field', (name, val) => {
        if (name === 'entity_type') entityType = val;
        if (name === 'entity_id')   entityId = parseInt(val) || null;
    });

    bb.on('file', (name, stream, info) => {
        const { filename, mimeType } = info;

        if (!ALLOWED_MIME_RE.test(mimeType)) {
            stream.resume(); // drain
            fileData = { error: `MIME-type '${mimeType}' ikke tilladt. Tilladte: PDF, billeder, Office-dokumenter.` };
            return;
        }

        const chunks = [];
        let size = 0;
        let truncated = false;

        stream.on('data', (chunk) => {
            size += chunk.length;
            chunks.push(chunk);
        });

        stream.on('limit', () => { truncated = true; });

        stream.on('end', () => {
            fileData = {
                filename: sanitizeFilename(filename),
                mime: mimeType,
                buffer: Buffer.concat(chunks),
                size,
                truncated
            };
        });
    });

    bb.on('close', () => {
        try {
            if (!fileData) {
                return res.status(400).json({ error: 'Ingen fil modtaget' });
            }
            if (fileData.error) {
                return res.status(400).json({ error: fileData.error });
            }
            if (fileData.truncated) {
                return res.status(413).json({ error: `Fil overstiger grænsen på ${MAX_FILE_SIZE / 1024 / 1024} MB` });
            }

            // Build storage path
            const subDir = entityType && entityId
                ? path.join(entityType, String(entityId))
                : 'temp';
            const dir = path.join(DATA_DIR, subDir);
            fs.mkdirSync(dir, { recursive: true });

            const storedName = `${Date.now()}-${fileData.filename}`;
            const filePath = path.join(dir, storedName);
            fs.writeFileSync(filePath, fileData.buffer);

            // Insert in DB
            const db = getDb();
            const result = db.prepare(`
                INSERT INTO attachments (entity_type, entity_id, file_name, file_path, file_type, uploaded_by_user_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `).run(
                entityType || 'temp',
                entityId || 0,
                fileData.filename,
                filePath,
                mimeToFileType(fileData.mime),
                req.session?.userId || null
            );

            res.json({
                attachment_id: Number(result.lastInsertRowid),
                filename: fileData.filename,
                size_bytes: fileData.size,
                mime_type: fileData.mime
            });
        } catch (err) {
            console.error('[attachments] Upload fejl:', err.message);
            res.status(500).json({ error: 'Upload fejlede' });
        }
    });

    bb.on('error', (err) => {
        console.error('[attachments] Busboy fejl:', err.message);
        res.status(500).json({ error: 'Upload fejlede' });
    });

    req.pipe(bb);
});

// ─── GET / ───────────────────────────────────────────────────────────────────
// Liste over vedhæftninger for en entitet: ?entity_type=&entity_id=
// (fx entity_type=event&entity_id=12)

router.get('/', requireAuth(), handle(async (req, res) => {
    const entityType = req.query.entity_type;
    const entityId   = parseInt(req.query.entity_id);
    if (!entityType || !entityId) {
        return res.status(400).json({ error: 'entity_type og entity_id kræves' });
    }
    const db = getDb();
    const rows = db.prepare(`
        SELECT a.id, a.file_name, a.file_type, a.description, a.created_at,
               a.uploaded_by_user_id, u.name AS uploaded_by_name
          FROM attachments a
          LEFT JOIN users u ON u.id = a.uploaded_by_user_id
         WHERE a.entity_type = ? AND a.entity_id = ?
         ORDER BY a.created_at DESC, a.id DESC
    `).all(entityType, entityId);
    res.json({ attachments: rows });
}));

// ─── DELETE /:id ───────────────────────────────────────────────────────────────
// Slet en vedhæftning (fil på disk + DB-række).

router.delete('/:id', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT id, file_path FROM attachments WHERE id = ?')
        .get(parseInt(req.params.id));
    if (!row) return res.status(404).json({ error: 'Vedhæftning ikke fundet' });
    try { if (fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); }
    catch (err) { console.error('[attachments] Kunne ikke slette fil:', err.message); }
    db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
    res.json({ ok: true });
}));

// ─── GET /:id/inline ───────────────────────────────────────────────────────────
// Servér til VISNING (billede/PDF i ny fane) frem for download.

router.get('/:id/inline', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT file_name, file_path FROM attachments WHERE id = ?')
        .get(parseInt(req.params.id));
    if (!row) return res.status(404).end();
    if (!fs.existsSync(row.file_path)) return res.status(404).end();
    res.setHeader('Content-Type', extToMime(row.file_name));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(row.file_path).pipe(res);
}));

// ─── GET /:id/download ───────────────────────────────────────────────────────
// Download fra generisk attachments-tabel

router.get('/:id/download', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT file_name, file_path FROM attachments WHERE id = ?')
        .get(parseInt(req.params.id));

    if (!row) return res.status(404).json({ error: 'Vedhæftning ikke fundet' });
    if (!fs.existsSync(row.file_path)) return res.status(404).json({ error: 'Fil ikke fundet på disk' });

    res.download(row.file_path, row.file_name);
}));

// ─── GET /mail/:id/download ──────────────────────────────────────────────────
// Download fra mail_attachments-tabel (ind- og udgående mail)

router.get('/mail/:id/download', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT filename, file_path FROM mail_attachments WHERE id = ?')
        .get(parseInt(req.params.id));

    if (!row) return res.status(404).json({ error: 'Vedhæftning ikke fundet' });
    if (!fs.existsSync(row.file_path)) return res.status(404).json({ error: 'Fil ikke fundet på disk' });

    res.download(row.file_path, row.filename);
}));

// ─── GET /mail/:id/inline ────────────────────────────────────────────────────
// Servér en mail-vedhæftning til VISNING (ikke download) — bruges af inline
// (CID-refererede) billeder i HTML-mails. Vises i en sandboxed iframe der deler
// origin, så session-cookien følger med og requireAuth kan beskytte den.

// Filtyper browseren selv kan vise forsvarligt. Alt andet sendes som download
// — en vedhæftning er fremmed input, og fx en .html-fil vist inline ville køre
// afsenderens script på VORES origin, med brugerens session.
const INLINE_VIEWABLE = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|application\/pdf|text\/plain)$/i;
// SVG er et billede, men også et dokument der kan indeholde script. Den vises
// stadig (så signatur-logoer i mails virker), men med sandbox-CSP så et
// direkte opslag i en fane ikke kan køre noget.
const INLINE_SANDBOXED = /^image\/svg\+xml$/i;

router.get('/mail/:id/inline', requireAuth(), handle(async (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT filename, file_path, mime_type FROM mail_attachments WHERE id = ?')
        .get(parseInt(req.params.id));

    if (!row) return res.status(404).end();
    if (!fs.existsSync(row.file_path)) return res.status(404).end();

    const mime = row.mime_type || 'application/octet-stream';
    const viewable = INLINE_VIEWABLE.test(mime);
    const sandboxed = INLINE_SANDBOXED.test(mime);

    res.setHeader('Content-Type', mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (sandboxed) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");

    if (viewable || sandboxed) {
        // filename gør at browserens "Gem som" foreslår det rigtige navn.
        res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(row.filename || 'fil') + '"');
        return fs.createReadStream(row.file_path).pipe(res);
    }

    return res.download(row.file_path, row.filename);
}));

module.exports = router;
