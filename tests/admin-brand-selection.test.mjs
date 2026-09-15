import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('platform admin account modal requires a brand for every brand-side role', async () => {
  const [view, server] = await Promise.all([read('views/users.ejs'), read('server.js')]);
  assert.match(view, /const BRAND_BOUND_ROLES = \['brand', 'brand_staff', 'warehouse'\]/);
  assert.match(view, /bg\.classList\.toggle\('is-hidden', !requiresBrand\(this\.value\)\)/);
  assert.match(view, /brand_id: requiresBrand\(role\)/);
  assert.match(view, /requiresBrand\(role\) && !body\.brand_id/);
  assert.match(server, /\['brand', 'brand_staff', 'warehouse'\]\.includes\(role\) && !brand_id/);
  assert.match(server, /\['brand', 'brand_staff', 'warehouse'\]\.includes\(newRole\)/);
  assert.match(server, /所选品牌不存在或已停用/);
  assert.match(server, /\['brand', 'brand_staff'\]\.includes\(role\) && user\.brand_id/);
});
