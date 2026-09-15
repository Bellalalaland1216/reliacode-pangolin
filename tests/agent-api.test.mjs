import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';

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

const postJson = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

async function browserLogin(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password })
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('vendor-neutral Agent API authenticates, scopes, deduplicates and revokes generation', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reliacode-agent-test-'));
  const previousDataDir = process.env.RELIACODE_DATA_DIR;
  process.env.RELIACODE_DATA_DIR = dataDir;
  const databasePath = require.resolve('../database.js');
  delete require.cache[databasePath];
  const { db, initDatabase, hashPassword } = require('../database.js');
  initDatabase();

  const ownBrand = Number(db.prepare('INSERT INTO brands (name, enabled) VALUES (?,1)').run('Agent 品牌').lastInsertRowid);
  const foreignBrand = Number(db.prepare('INSERT INTO brands (name, enabled) VALUES (?,1)').run('其他品牌').lastInsertRowid);
  const ownProduct = Number(db.prepare('INSERT INTO products (name, brand_id) VALUES (?,?)').run('Agent 产品', ownBrand).lastInsertRowid);
  const foreignProduct = Number(db.prepare('INSERT INTO products (name, brand_id) VALUES (?,?)').run('其他产品', foreignBrand).lastInsertRowid);
  db.prepare('INSERT INTO product_batches (brand_id,product_id,batch_no,status,published_at) VALUES (?,?,?,\'published\',datetime(\'now\'))')
    .run(ownBrand, ownProduct, 'AGENT-1');
  db.prepare('INSERT INTO product_batches (brand_id,product_id,batch_no,status,published_at) VALUES (?,?,?,\'published\',datetime(\'now\'))')
    .run(ownBrand, ownProduct, 'AGENT-BOX');
  db.prepare('INSERT INTO distributors (name, brand_id) VALUES (?,?)').run('Agent 代理商', ownBrand);
  db.prepare('INSERT INTO distributors (name, brand_id) VALUES (?,?)').run('其他代理商', foreignBrand);
  const password = 'AgentAccess1!';
  db.prepare('INSERT INTO users (username,password_hash,display_name,role,brand_id,enabled) VALUES (?,?,?,?,?,1)')
    .run('agent_brand_user', hashPassword(password), 'Agent 品牌账号', 'brand', ownBrand);
  db.prepare('INSERT INTO users (username,password_hash,display_name,role,brand_id,enabled) VALUES (?,?,?,?,?,1)')
    .run('agent_staff_user', hashPassword(password), 'Agent 品牌工作账号', 'brand_staff', ownBrand);
  db.prepare('INSERT INTO users (username,password_hash,display_name,role,brand_id,enabled) VALUES (?,?,?,?,?,1)')
    .run('agent_forbidden_user', hashPassword(password), '无生码权限账号', 'warehouse', ownBrand);

  const port = await unusedPort();
  const child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    cwd: root.pathname,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RELIACODE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const generatedFiles = [];
  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const discovery = await fetch(`${baseUrl}/.well-known/reliacode-agent.json`);
    assert.equal(discovery.status, 200);
    const capabilities = await discovery.json();
    assert.equal(capabilities.version, '1.2');
    assert.equal(capabilities.authentication.token_type, 'Bearer');
    assert.equal(capabilities.endpoints.generate_items, '/api/agent/codes/items');
    assert.equal(capabilities.endpoints.capabilities, '/api/agent/capabilities');

    const badLogin = await postJson(`${baseUrl}/api/agent/login`, { username: 'agent_staff_user', password: 'wrong-password' });
    assert.equal(badLogin.status, 401);
    assert.equal((await badLogin.json()).code, 'AGENT_LOGIN_FAILED');
    const forbiddenLogin = await postJson(`${baseUrl}/api/agent/login`, { username: 'agent_forbidden_user', password });
    assert.equal(forbiddenLogin.status, 403);
    assert.equal((await forbiddenLogin.json()).code, 'AGENT_ROLE_FORBIDDEN');

    const brandLogin = await postJson(`${baseUrl}/api/agent/login`, { username: 'agent_brand_user', password, client_name: 'brand-policy-check' });
    assert.equal(brandLogin.status, 200);
    const brandAuthorization = { Authorization: `Bearer ${(await brandLogin.json()).access_token}` };
    const brandCapabilities = await fetch(`${baseUrl}/api/agent/capabilities`, { headers: brandAuthorization });
    assert.equal(brandCapabilities.status, 200);
    assert.equal((await brandCapabilities.json()).mutations.includes('POST /api/agent/codes/items'), false);
    const brandGeneration = await postJson(`${baseUrl}/api/agent/codes/items`, { product_id: ownProduct, batch_no: 'AGENT-1', item_count: 1 }, {
      ...brandAuthorization, 'Idempotency-Key': 'brand-must-not-generate-001'
    });
    assert.equal(brandGeneration.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items WHERE brand_id=?').get(ownBrand).count, 0);
    await postJson(`${baseUrl}/api/agent/logout`, {}, brandAuthorization);

    const login = await postJson(`${baseUrl}/api/agent/login`, { username: 'agent_staff_user', password, client_name: 'integration-agent' });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('set-cookie'), null);
    const loginBody = await login.json();
    assert.match(loginBody.access_token, /^rca_[A-Za-z0-9_-]{43}$/);
    assert.equal(loginBody.expires_in, 3600);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_tokens WHERE token_hash=?').get(loginBody.access_token).count, 0);
    const authorization = { Authorization: `Bearer ${loginBody.access_token}` };

    const identity = await fetch(`${baseUrl}/api/agent/me`, { headers: authorization });
    assert.equal(identity.status, 200);
    assert.equal((await identity.json()).user.brand_id, ownBrand);

    const roleCapabilities = await fetch(`${baseUrl}/api/agent/capabilities`, { headers: authorization });
    assert.equal(roleCapabilities.status, 200);
    const roleCapabilitiesBody = await roleCapabilities.json();
    assert.ok(roleCapabilitiesBody.reads.includes('GET /api/products'));
    assert.ok(roleCapabilitiesBody.reads.includes('GET /api/codes'));
    assert.ok(roleCapabilitiesBody.mutations.includes('POST /api/agent/codes/items'));

    const products = await fetch(`${baseUrl}/api/products`, { headers: authorization });
    assert.equal(products.status, 200);
    const productRows = (await products.json()).products;
    assert.deepEqual(productRows.map(row => row.id), [ownProduct]);

    const stats = await fetch(`${baseUrl}/api/stats`, { headers: authorization });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json()).success, true);

    const users = await fetch(`${baseUrl}/api/users`, { headers: authorization });
    assert.equal(users.status, 403);

    const distributors = await fetch(`${baseUrl}/api/distributors`, { headers: authorization });
    assert.equal(distributors.status, 200);
    const distributorRows = (await distributors.json()).distributors;
    assert.deepEqual(distributorRows.map(row => row.name), ['Agent 代理商']);

    const blockedBrowserMutation = await postJson(`${baseUrl}/api/products`, { name: '不应创建' }, authorization);
    assert.equal(blockedBrowserMutation.status, 403);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM products WHERE name='不应创建'").get().count, 0);

    const missingKey = await postJson(`${baseUrl}/api/agent/codes/items`, { product_id: ownProduct, item_count: 2 }, authorization);
    const missingKeyBody = await missingKey.json();
    assert.equal(missingKey.status, 400, JSON.stringify(missingKeyBody));
    assert.equal(missingKeyBody.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const requestHeaders = { ...authorization, 'Idempotency-Key': 'agent-test-items-001' };
    const first = await postJson(`${baseUrl}/api/agent/codes/items`, { product_id: ownProduct, batch_no: 'AGENT-1', item_count: 2 }, requestHeaders);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.success, true);
    assert.equal(firstBody.count, 2);
    generatedFiles.push(...firstBody.generated.map(row => new URL(`../public${row.qr_url}`, import.meta.url).pathname));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items WHERE brand_id=? AND batch_no=?').get(ownBrand, 'AGENT-1').count, 2);

    const replay = await postJson(`${baseUrl}/api/agent/codes/items`, { product_id: ownProduct, batch_no: 'AGENT-1', item_count: 2 }, requestHeaders);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual((await replay.json()).generated, firstBody.generated);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items WHERE brand_id=? AND batch_no=?').get(ownBrand, 'AGENT-1').count, 2);

    const conflict = await postJson(`${baseUrl}/api/agent/codes/items`, { product_id: ownProduct, batch_no: 'AGENT-1', item_count: 3 }, requestHeaders);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'IDEMPOTENCY_CONFLICT');

    const crossTenant = await postJson(`${baseUrl}/api/agent/codes/items`, { product_id: foreignProduct, item_count: 1 }, {
      ...authorization, 'Idempotency-Key': 'agent-test-foreign-001'
    });
    assert.equal(crossTenant.status, 200);
    assert.equal((await crossTenant.json()).success, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM items WHERE brand_id=?').get(foreignBrand).count, 0);

    const box = await postJson(`${baseUrl}/api/agent/codes/boxes`, { product_id: ownProduct, batch_no: 'AGENT-BOX', box_count: 1 }, {
      ...authorization, 'Idempotency-Key': 'agent-test-boxes-001'
    });
    assert.equal(box.status, 200);
    const boxBody = await box.json();
    assert.equal(boxBody.count, 1);
    generatedFiles.push(...boxBody.generated.map(row => new URL(`../public${row.qr_url}`, import.meta.url).pathname));
    assert.equal(db.prepare('SELECT brand_id FROM boxes WHERE box_code=?').get(boxBody.generated[0].box_code).brand_id, ownBrand);

    const logout = await postJson(`${baseUrl}/api/agent/logout`, {}, authorization);
    assert.equal(logout.status, 200);
    const afterLogout = await fetch(`${baseUrl}/api/agent/me`, { headers: authorization });
    assert.equal(afterLogout.status, 401);
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM operation_logs WHERE action IN ('agent_login','generate_items','generate_boxes','agent_logout')").get().count >= 4);

    const cookie = await browserLogin(baseUrl, 'agent_brand_user', password);
    const generatedRows = [
      ...firstBody.generated.map(row => ({ type: 'item', ...row })),
      { type: 'box', ...boxBody.generated[0] }
    ];
    for (const generated of generatedRows) {
      const deletion = await fetch(`${baseUrl}/api/codes/${generated.type}/${generated.id}`, {
        method: 'DELETE', headers: { Cookie: cookie, 'X-ReliaCode-Request': 'same-origin' }
      });
      assert.equal(deletion.status, 200);
      assert.equal((await deletion.json()).success, true);
    }
    for (const file of generatedFiles) await assert.rejects(access(file));
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    for (const file of generatedFiles) await unlink(file).catch(() => {});
    db.close();
    if (previousDataDir === undefined) delete process.env.RELIACODE_DATA_DIR;
    else process.env.RELIACODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
