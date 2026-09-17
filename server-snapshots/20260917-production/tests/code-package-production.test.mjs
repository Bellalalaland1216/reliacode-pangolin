import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('production code packages are persisted and each generated code is bound to one package', () => {
  const database = read('database.js');
  assert.match(database, /CREATE TABLE IF NOT EXISTS code_packages/);
  assert.match(database, /quantity INTEGER NOT NULL CHECK\(quantity BETWEEN 1 AND 50000\)/);
  assert.match(database, /ALTER TABLE boxes ADD COLUMN package_id INTEGER/);
  assert.match(database, /ALTER TABLE items ADD COLUMN package_id INTEGER/);
  assert.match(database, /idx_items_package/);
});

test('only authorized generation roles can create a product-bound or brand-generic package capped at 50000', () => {
  const server = read('server.js');
  assert.match(server, /app\.post\('\/api\/code-packages', requireRole\('admin', 'brand_staff'\)/);
  assert.match(server, /quantity > 50000/);
  assert.match(server, /const brandId = scope !== null \? scope : Number\(req\.body\.brand_id\)/);
  assert.match(server, /PACKAGE_BRAND_CONFLICT/);
  assert.match(server, /品牌通用码包/);
  assert.match(server, /BATCH_ORIGIN_REQUIRED/);
  assert.match(server, /随生产码包创建并发布批次/);
  assert.match(server, /INSERT INTO items \(item_code,box_id,product_id,brand_id,batch_no,package_id\)/);
});

test('TXT downloads are tenant scoped, package exact, CRLF delimited and audited', () => {
  const server = read('server.js');
  assert.match(server, /app\.get\('\/api\/code-packages\/:id\/download', requireRole\('admin', 'brand', 'brand_staff'\)/);
  assert.match(server, /WHERE id=\? AND brand_id=\?/);
  assert.match(server, /WHERE package_id=\?/);
  assert.match(server, /value \+ '\\r\\n'/);
  assert.match(server, /download_count=download_count\+1/);
  assert.match(server, /download_code_package/);
});

test('download center presents the factory workflow and retains the small ZIP archive tool', () => {
  const view = read('views/downloads.ejs');
  const css = read('public/css/clawmaster.css');
  assert.match(view, /创建码包任务/);
  assert.match(view, /value="50000"/);
  assert.match(view, /UTF-8/);
  assert.match(view, /Windows CRLF/);
  assert.match(view, /码包记录/);
  assert.match(view, /链接 TXT/);
  assert.match(view, /纯码 TXT/);
  assert.match(view, /archiveLimit/);
  assert.match(view, /downloadPackageBtn/);
  assert.match(css, /\.package-form-grid/);
  assert.match(css, /\.package-download-actions/);
  assert.match(css, /\.package-archive-limit/);
});

test('production code package download validates integrity and bounds image archive memory', () => {
  const server = read('server.js');
  assert.match(server, /actual !== pkg\.quantity/);
  assert.match(server, /PACKAGE_COUNT_MISMATCH/);
  assert.match(server, /IMAGE_ARCHIVE_TOO_LARGE/);
  assert.match(server, /value \+ '\\r\\n'/);
  assert.match(server, /WHERE id=\? AND brand_id=\?/);
});
