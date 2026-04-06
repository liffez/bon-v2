// db/session-store.js
// ==========================================
// Express session store baseret på node:sqlite.
// Erstatter connect-sqlite3 (som kræver native
// sqlite3-binding).
// ==========================================

const { openDb } = require('./compat');
const path = require('path');

module.exports = function(session) {
    const Store = session.Store;

    class SqliteSessionStore extends Store {
        constructor(options = {}) {
            super(options);
            const dbFile = path.join(options.dir || '.', options.db || 'sessions.db');
            this.db = openDb(dbFile);

            this.db.exec(`
                CREATE TABLE IF NOT EXISTS sessions (
                    sid  TEXT PRIMARY KEY,
                    sess TEXT NOT NULL,
                    expired INTEGER NOT NULL
                )
            `);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)`);

            // Ryd udløbne sessions hvert 15. minut
            this._cleanupInterval = setInterval(() => this._cleanup(), 15 * 60 * 1000);
            if (this._cleanupInterval.unref) this._cleanupInterval.unref();
        }

        get(sid, callback) {
            try {
                const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expired > ?').get(sid, Date.now());
                if (!row) return callback(null, null);
                callback(null, JSON.parse(row.sess));
            } catch (e) {
                callback(e);
            }
        }

        set(sid, sess, callback) {
            try {
                const maxAge = sess.cookie?.maxAge || 86400000;
                const expired = Date.now() + maxAge;
                this.db.prepare(
                    'INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)'
                ).run(sid, JSON.stringify(sess), expired);
                callback?.(null);
            } catch (e) {
                callback?.(e);
            }
        }

        destroy(sid, callback) {
            try {
                this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
                callback?.(null);
            } catch (e) {
                callback?.(e);
            }
        }

        touch(sid, sess, callback) {
            try {
                const maxAge = sess.cookie?.maxAge || 86400000;
                const expired = Date.now() + maxAge;
                this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expired, sid);
                callback?.(null);
            } catch (e) {
                callback?.(e);
            }
        }

        _cleanup() {
            try {
                this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
            } catch (e) {
                // Ignorer fejl i cleanup
            }
        }
    }

    return SqliteSessionStore;
};
