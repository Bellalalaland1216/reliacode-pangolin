import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const SQLiteSessionStore = require('../sqlite-session-store');

const call = (store, method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => error ? reject(error) : resolve(value));
});

test('SQLite session store persists, refreshes, expires and destroys sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reliacode-session-test-'));
  const database = new Database(join(directory, 'sessions.db'));
  const store = new SQLiteSessionStore(database, { defaultTtlMs: 60_000, cleanupIntervalMs: 60_000 });
  try {
    const session = { cookie: { maxAge: 60_000 }, user: { id: 7, role: 'admin' } };
    await call(store, 'set', 'alpha', session);
    assert.deepEqual(await call(store, 'get', 'alpha'), session);
    await call(store, 'touch', 'alpha', { cookie: { maxAge: 120_000 } });
    assert.ok(database.prepare('SELECT expires FROM app_sessions WHERE sid=?').get('alpha').expires > Date.now() + 100_000);
    await call(store, 'destroy', 'alpha');
    assert.equal(await call(store, 'get', 'alpha'), null);

    await call(store, 'set', 'expired', { cookie: { expires: new Date(Date.now() - 1000) } });
    assert.equal(await call(store, 'get', 'expired'), null);
    assert.equal(database.prepare('SELECT 1 FROM app_sessions WHERE sid=?').get('expired'), undefined);
  } finally {
    store.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
