import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('code package download is located in the dedicated download center', () => {
  const server = read('server.js');
  const codes = read('views/codes.ejs');
  const downloads = read('views/downloads.ejs');
  const business = read('views/admin-business.ejs');

  assert.match(server, /app\.get\('\/downloads', requireRole\('admin', 'brand', 'brand_staff'\)/);
  assert.doesNotMatch(codes, /downloadPackageBtn|\/api\/codes\/package/);
  assert.match(downloads, /downloadPackageBtn/);
  assert.match(downloads, /\/api\/codes\/package\?/);
  assert.match(business, /href="\/downloads"/);
});

test('scan-log deletion UI follows the same headquarters-admin roles as the API', () => {
  const server = read('server.js');
  const logs = read('views/logs.ejs');

  assert.match(server, /app\.delete\('\/api\/scan-logs\/:id', requireRole\('admin', 'brand'\)/);
  assert.match(server, /app\.post\('\/api\/scan-logs\/batch-delete', requireRole\('admin', 'brand'\)/);
  assert.match(logs, /user\.role === 'admin' \|\| user\.role === 'brand'/);
  assert.match(logs, /if \(canDeleteLogs\)/);
  assert.match(server, /logOperation\(req, 'delete_scan_log'/);
  assert.match(server, /logOperation\(req, 'batch_delete_scan_logs'/);
});
