import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForServer(child) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    const onData = chunk => {
      if (!String(chunk).includes('溯源码系统已启动')) return;
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      resolve();
    };
    child.stdout.on('data', onData);
    child.once('exit', code => reject(new Error(`server exited before startup: ${code}`)));
  });
}

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password })
  });
  assert.equal(response.status, 302);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function command(baseUrl, cookie, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-ReliaCode-Request': 'same-origin'
    },
    body: JSON.stringify(body)
  });
}

async function requestWithHost(port, path, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.once('error', reject);
    request.end();
  });
}

test('cross-tenant bind, pack and ship attempts are rejected without mutation', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reliacode-tenant-test-'));
  const previousDataDir = process.env.RELIACODE_DATA_DIR;
  process.env.RELIACODE_DATA_DIR = dataDir;
  const databasePath = require.resolve('../database.js');
  delete require.cache[databasePath];
  const { db, initDatabase, hashPassword } = require('../database.js');
  initDatabase();

  const ownBrand = Number(db.prepare('INSERT INTO brands (name, enabled) VALUES (?,1)').run('品牌甲').lastInsertRowid);
  const foreignBrand = Number(db.prepare('INSERT INTO brands (name, enabled) VALUES (?,1)').run('品牌乙').lastInsertRowid);
  const ownProduct = Number(db.prepare('INSERT INTO products (name, brand_id, box_size) VALUES (?,?,?)').run('甲产品', ownBrand, 12).lastInsertRowid);
  const foreignProduct = Number(db.prepare('INSERT INTO products (name, brand_id, box_size) VALUES (?,?,?)').run('乙产品', foreignBrand, 12).lastInsertRowid);
  const ownBox = Number(db.prepare('INSERT INTO boxes (box_code, product_id, brand_id) VALUES (?,?,?)').run('BOWNTEST1', ownProduct, ownBrand).lastInsertRowid);
  db.prepare('INSERT INTO items (item_code, product_id, brand_id) VALUES (?,?,?)').run('SFOREIGN1', foreignProduct, foreignBrand);
  const ownDistributor = Number(db.prepare('INSERT INTO distributors (name, brand_id) VALUES (?,?)').run('甲代理商', ownBrand).lastInsertRowid);
  db.prepare('INSERT INTO invitations (code, role, note, brand_id) VALUES (?,?,?,?)').run('INVCONCURRENCYTEST', 'distributor', '并发测试', ownBrand);
  const password = 'TenantTest1!';
  db.prepare('INSERT INTO users (username, password_hash, display_name, role, brand_id, enabled) VALUES (?,?,?,?,?,1)')
    .run('brand_staff_test', hashPassword(password), '品牌工作账号', 'brand_staff', ownBrand);
  db.prepare('INSERT INTO users (username, password_hash, display_name, role, brand_id, enabled) VALUES (?,?,?,?,?,1)')
    .run('warehouse_test', hashPassword(password), '仓库账号', 'warehouse', ownBrand);

  const port = await unusedPort();
  const child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    cwd: root.pathname,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RELIACODE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    assert.equal(health.headers.get('set-cookie'), null);
    const ready = await fetch(`${baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { status: 'ready' });
    assert.equal(ready.headers.get('set-cookie'), null);
    const rejectedHost = await requestWithHost(port, '/healthz', 'unauthorized.example');
    assert.equal(rejectedHost.status, 421);
    assert.equal(rejectedHost.body.code, 'UNRECOGNIZED_HOST');
    assert.equal(rejectedHost.headers['set-cookie'], undefined);
    const staffCookie = await login(baseUrl, 'brand_staff_test', password);

    const bind = await command(baseUrl, staffCookie, '/api/codes/bind', { box_code: 'BOWNTEST1', item_codes: ['SFOREIGN1'] });
    assert.equal(bind.status, 404);
    assert.equal((await bind.json()).code, 'ITEM_NOT_FOUND');

    const pack = await command(baseUrl, staffCookie, '/api/factory/pack/scan', { box_code: 'BOWNTEST1', item_code: 'SFOREIGN1', box_size: 12 });
    assert.equal(pack.status, 404);
    assert.equal((await pack.json()).code, 'ITEM_NOT_FOUND');

    const warehouseCookie = await login(baseUrl, 'warehouse_test', password);
    const ship = await command(baseUrl, warehouseCookie, '/api/shipments/ship', { code: 'SFOREIGN1', distributor_id: ownDistributor });
    assert.equal(ship.status, 404);
    assert.equal((await ship.json()).code, 'ITEM_NOT_FOUND');

    const verify = await fetch(`${baseUrl}/api/verify/BOWNTEST1?location=${encodeURIComponent('广东省深圳市南山区')}`);
    assert.equal(verify.status, 200);
    const publicResult = await verify.json();
    assert.equal(publicResult.success, true);
    assert.equal(publicResult.type, 'box');
    assert.equal(publicResult.brand_name, '品牌甲');
    assert.equal(publicResult.scan_region, '广东省');
    assert.equal(publicResult.item_count, 0);
    assert.equal(publicResult.verified_count, 0);
    for (const privateKey of ['items', 'distributor', 'region', 'resolved_location', 'first_scan_location', 'box_code']) {
      assert.equal(Object.hasOwn(publicResult, privateKey), false, `public response exposed ${privateKey}`);
    }
    const storedSource = db.prepare("SELECT scan_ip FROM scan_logs WHERE item_code='BOWNTEST1' ORDER BY id DESC LIMIT 1").get().scan_ip;
    assert.match(storedSource, /^[a-f0-9]{20}$/);
    assert.doesNotMatch(storedSource, /127\.0\.0\.1/);

    let limitedResponse;
    for (let attempt = 1; attempt <= 60; attempt += 1) {
      limitedResponse = await fetch(`${baseUrl}/api/verify/UNKNOWN-${attempt}`);
    }
    assert.equal(limitedResponse.status, 429);
    assert.equal((await limitedResponse.json()).code, 'VERIFY_RATE_LIMITED');
    assert.ok(Number(limitedResponse.headers.get('retry-after')) >= 1);

    const anonymousQr = await fetch(`${baseUrl}/api/qr?data=test`, { redirect: 'manual' });
    assert.equal(anonymousQr.status, 401);

    const registerBody = username => new URLSearchParams({
      code: 'INVCONCURRENCYTEST', username, password: 'RegisterTest1!', company: `代理商-${username}`,
      country: '中国', province: '广东省', city: '广州市', contact: '联系人', phone: '13800138000'
    });
    const registrationResponses = await Promise.all(['invite_user_a', 'invite_user_b'].map(username => fetch(`${baseUrl}/api/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: registerBody(username)
    })));
    const registrationResults = await Promise.all(registrationResponses.map(response => response.json()));
    assert.equal(registrationResults.filter(result => result.success).length, 1);
    assert.equal(registrationResults.filter(result => result.code === 'INVITATION_ALREADY_USED').length, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE username IN ('invite_user_a','invite_user_b')").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM distributors WHERE name LIKE '代理商-invite_user_%'").get().count, 1);
    assert.equal(db.prepare("SELECT status FROM invitations WHERE code='INVCONCURRENCYTEST'").get().status, 1);

    const item = db.prepare('SELECT box_id, status, distributor_id FROM items WHERE item_code=?').get('SFOREIGN1');
    assert.deepEqual(item, { box_id: null, status: 'in_stock', distributor_id: null });
    assert.equal(db.prepare('SELECT item_count FROM boxes WHERE id=?').get(ownBox).item_count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM shipments').get().count, 0);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    db.close();
    if (previousDataDir === undefined) delete process.env.RELIACODE_DATA_DIR;
    else process.env.RELIACODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
