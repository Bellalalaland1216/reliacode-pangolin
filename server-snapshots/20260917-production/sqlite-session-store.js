const { Store } = require('express-session');

// Local visual-fixture dependency only. Production uses the deployed session store.
class SQLiteSessionStore extends Store {
  constructor(db, options = {}) {
    super();
    this.db = db;
    this.defaultTtlMs = Number(options.defaultTtlMs || 12 * 60 * 60 * 1000);
    this.db.exec(`CREATE TABLE IF NOT EXISTS __visual_fixture_sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
    this.getStmt = this.db.prepare("SELECT sess, expires_at FROM __visual_fixture_sessions WHERE sid = ?");
    this.setStmt = this.db.prepare("INSERT INTO __visual_fixture_sessions(sid,sess,expires_at) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires_at=excluded.expires_at");
    this.destroyStmt = this.db.prepare("DELETE FROM __visual_fixture_sessions WHERE sid = ?");
  }

  get(sid, callback) {
    try {
      const row = this.getStmt.get(sid);
      if (!row || row.expires_at <= Date.now()) return callback(null, null);
      return callback(null, JSON.parse(row.sess));
    } catch (error) { return callback(error); }
  }

  set(sid, session, callback = () => {}) {
    try {
      const maxAge = Number(session?.cookie?.maxAge);
      const expiresAt = Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.defaultTtlMs);
      this.setStmt.run(sid, JSON.stringify(session), expiresAt);
      return callback(null);
    } catch (error) { return callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try { this.destroyStmt.run(sid); return callback(null); } catch (error) { return callback(error); }
  }

  touch(sid, session, callback = () => {}) { return this.set(sid, session, callback); }

  regenerate(req, callback = () => {}) {
    const previousSid = req.sessionID;
    try {
      if (previousSid) this.destroyStmt.run(previousSid);
      if (typeof this.generate !== 'function') throw new Error('session_store_generate_missing');
      this.generate(req);
      return callback(null);
    } catch (error) { return callback(error); }
  }

  close(callback = () => {}) { return callback(null); }
}

module.exports = SQLiteSessionStore;
