'use strict';

const session = require('express-session');

class SQLiteSessionStore extends session.Store {
  constructor(db, options = {}) {
    super();
    if (!db || typeof db.prepare !== 'function') throw new TypeError('A better-sqlite3 database is required');
    this.db = db;
    this.defaultTtlMs = options.defaultTtlMs || 12 * 60 * 60 * 1000;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_app_sessions_expires ON app_sessions(expires);
    `);
    this.readStatement = this.db.prepare('SELECT sess, expires FROM app_sessions WHERE sid=?');
    this.writeStatement = this.db.prepare(`
      INSERT INTO app_sessions (sid, sess, expires, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires, updated_at=excluded.updated_at
    `);
    this.touchStatement = this.db.prepare('UPDATE app_sessions SET expires=?, updated_at=? WHERE sid=?');
    this.deleteStatement = this.db.prepare('DELETE FROM app_sessions WHERE sid=?');
    this.cleanupStatement = this.db.prepare('DELETE FROM app_sessions WHERE expires<=?');
    this.cleanup();
    const cleanupIntervalMs = options.cleanupIntervalMs || 15 * 60 * 1000;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  expiry(sessionValue, now = Date.now()) {
    const cookie = sessionValue?.cookie || {};
    const absolute = cookie.expires ? new Date(cookie.expires).getTime() : NaN;
    if (Number.isFinite(absolute)) return absolute;
    const maxAge = Number(cookie.maxAge);
    return now + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.defaultTtlMs);
  }

  get(sid, callback) {
    try {
      const row = this.readStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        this.deleteStatement.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      try { this.deleteStatement.run(sid); } catch {}
      callback(error);
    }
  }

  set(sid, sessionValue, callback = () => {}) {
    try {
      const now = Date.now();
      this.writeStatement.run(sid, JSON.stringify(sessionValue), this.expiry(sessionValue, now), now);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.deleteStatement.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sessionValue, callback = () => {}) {
    try {
      const now = Date.now();
      this.touchStatement.run(this.expiry(sessionValue, now), now, sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  cleanup() {
    try {
      this.cleanupStatement.run(Date.now());
    } catch (error) {
      this.emit('error', error);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}

module.exports = SQLiteSessionStore;
