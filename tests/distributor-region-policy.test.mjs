import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('country province and city selections come from a fixed server catalog', () => {
  const { CHINA_REGIONS, normalizeRegionSelection } = require('../region-catalog.js');
  assert.ok(Object.keys(CHINA_REGIONS).length >= 34);
  assert.ok(CHINA_REGIONS['广东省'].includes('深圳市'));
  assert.deepEqual(normalizeRegionSelection('中国', '广东省', '深圳市'), {
    country: '中国', province: '广东省', city: '深圳市', region: '广东省深圳市'
  });
  assert.equal(normalizeRegionSelection('中国', '手工省', '手工市'), null);
  assert.equal(normalizeRegionSelection('其他', '广东省', '深圳市'), null);
});

test('distributor create edit and invitation registration reject free-text regions', async () => {
  const [server, database, view, register] = await Promise.all([
    read('server.js'), read('database.js'), read('views/distributors.ejs'), read('views/register.ejs')
  ]);
  assert.match(server, /normalizeRegionSelection\(req\.body\.country, req\.body\.province, req\.body\.city\)/);
  assert.match(server, /code: 'INVALID_REGION_SELECTION'/);
  assert.match(server, /INSERT INTO distributors \(name, phone, region, address, brand_id, country, province, city\)/);
  assert.match(database, /ALTER TABLE distributors ADD COLUMN country/);
  assert.doesNotMatch(view, /id="distRegion"|id="editRegion"/);
  assert.match(view, /id="distCountry"/);
  assert.match(view, /id="distProvince"/);
  assert.match(view, /id="distCity"/);
  assert.doesNotMatch(register, /id="fRegion"/);
  assert.match(register, /id="fCountry"/);
  assert.match(register, /id="fProvince"/);
  assert.match(register, /id="fCity"/);
});
