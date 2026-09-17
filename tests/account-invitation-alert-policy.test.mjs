import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('remember login extends only the server session and never stores a password client-side', async () => {
  const [server, login] = await Promise.all([read('server.js'), read('views/login.ejs')]);
  assert.match(server, /const rememberLogin = req\.body\.remember === '1'/);
  assert.match(server, /req\.session\.cookie\.maxAge = rememberLogin \? 30 \* 24 \* 60 \* 60 \* 1000 : 12 \* 60 \* 60 \* 1000/);
  assert.match(login, /name="remember" value="1"/);
  assert.doesNotMatch(login, /localStorage|sessionStorage|indexedDB|document\.cookie/);
});

test('alert deletion is tenant-scoped, audited and restricted to administrators', async () => {
  const [server, alerts] = await Promise.all([read('server.js'), read('views/alerts.ejs')]);
  assert.match(server, /app\.delete\('\/api\/alerts\/:id', requireRole\('admin', 'brand'\)/);
  assert.match(server, /!alert \|\| !brandAllowed\(scope, alert\.brand_id\)/);
  assert.match(server, /logOperation\(req, 'delete_alert', 'alert'/);
  assert.match(alerts, /delete-alert-btn/);
  assert.match(alerts, /user\.role === 'admin' \|\| user\.role === 'brand'/);
});

test('one-time brand administrator invitations are platform-only and brand-bound', async () => {
  const [server, register, users] = await Promise.all([read('server.js'), read('public/js/register-glass.js'), read('views/users.ejs')]);
  assert.match(server, /\['factory', 'distributor', 'brand'\]\.includes\(role\)/);
  assert.match(server, /role === 'brand' && scope !== null/);
  assert.match(server, /role === 'brand' && !brand_id/);
  assert.match(server, /INSERT INTO users \(username, password_hash, display_name, role, brand_id\)/);
  assert.match(register, /品牌管理员注册/);
  assert.match(users, /value="brand">品牌管理员注册码/);
});

test('brand deletion is restored but cannot erase tenant business history', async () => {
  const [server, users] = await Promise.all([read('server.js'), read('views/users.ejs')]);
  assert.match(server, /app\.delete\('\/api\/brands\/:id', requireRole\('admin'\)/);
  assert.match(server, /code: 'BRAND_NOT_EMPTY'/);
  assert.match(server, /'operation_logs'.*'product_media'.*'product_marketing'/s);
  assert.match(users, /delete-brand-btn danger-action/);
  assert.match(users, /method: 'DELETE'/);
  assert.match(users, /已有账号或业务历史的品牌不会被删除，只能停用/);
});
