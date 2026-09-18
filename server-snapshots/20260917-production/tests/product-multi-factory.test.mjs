import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('product factories use an idempotent many-to-many schema with legacy backfill', () => {
  const database = read('database.js');
  assert.match(database, /CREATE TABLE IF NOT EXISTS product_factories/);
  assert.match(database, /PRIMARY KEY \(product_id, factory_id\)/);
  assert.match(database, /FOREIGN KEY \(product_id\) REFERENCES products\(id\) ON DELETE CASCADE/);
  assert.match(database, /INSERT OR IGNORE INTO product_factories[\s\S]*SELECT id, factory_id FROM products/);
});

test('product create, update and factory visibility use all selected factories', () => {
  const server = read('server.js');
  assert.match(server, /normalizedFactoryIds\(req\.body\)/);
  assert.match(server, /replaceProductFactories\(created\.lastInsertRowid, factoryIds\)/);
  assert.match(server, /replaceProductFactories\(product\.id, factoryIds\)/);
  assert.match(server, /EXISTS \(SELECT 1 FROM product_factories pf WHERE pf\.product_id=products\.id AND pf\.factory_id=\?\)/);
  assert.match(server, /PRODUCT_FACTORY_FORBIDDEN/);
  assert.match(server, /factory_ids: rows\.map\(row => row\.id\)/);
});

test('product editor exposes discoverable multi-factory choices and submits an array', () => {
  const view = read('views/generate.ejs');
  const css = read('public/css/clawmaster.css');
  assert.match(view, /归属工厂（可多选）/);
  assert.match(view, /type="checkbox" name="pFactory"/);
  assert.match(view, /const factory_ids = selectedFactoryIds\(\)/);
  assert.match(view, /JSON\.stringify\(\{name, spec, ena13, batch_no: '', box_size: boxSize, factory_ids, brand_id/);
  assert.match(view, /data-factories=/);
  assert.match(css, /\.product-factory-choices/);
  assert.match(css, /\.product-factory-choice/);
});
