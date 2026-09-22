import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
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
    const timeout = setTimeout(() => reject(new Error('server startup timeout')), 30000);
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

async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123' }),
  });
  assert.equal(response.status, 302);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  return cookie;
}

async function requestJson(baseUrl, cookie, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-ReliaCode-Request': 'same-origin',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test('brand create and edit maintain multiple factory relationships in both directions', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reliacode-brand-factories-'));
  const previousDataDir = process.env.RELIACODE_DATA_DIR;
  process.env.RELIACODE_DATA_DIR = dataDir;
  const databasePath = require.resolve('../database.js');
  delete require.cache[databasePath];
  const { db, initDatabase } = require('../database.js');
  const savedLog = console.log;
  console.log = () => {};
  try { initDatabase(); } finally { console.log = savedLog; }

  const port = await unusedPort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    cwd: rootPath,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RELIACODE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const cookie = await login(baseUrl);

    const brandA = await requestJson(baseUrl, cookie, 'POST', '/api/brands', { name: '品牌甲', contact: '甲联系人', factory_ids: [] });
    const brandB = await requestJson(baseUrl, cookie, 'POST', '/api/brands', { name: '品牌乙', contact: '乙联系人', factory_ids: [] });
    assert.equal(brandA.response.status, 201);
    assert.equal(brandB.response.status, 201);

    const factoryOne = await requestJson(baseUrl, cookie, 'POST', '/api/factories', {
      name: '一号工厂', contact: '工厂联系人一', brand_id: brandA.data.id, brand_ids: [brandA.data.id],
    });
    const factoryTwo = await requestJson(baseUrl, cookie, 'POST', '/api/factories', {
      name: '二号工厂', contact: '工厂联系人二', brand_id: brandA.data.id, brand_ids: [brandA.data.id],
    });
    assert.equal(factoryOne.data.success, true);
    assert.equal(factoryTwo.data.success, true);

    const assignBoth = await requestJson(baseUrl, cookie, 'PUT', `/api/brands/${brandB.data.id}`, {
      name: '品牌乙', contact: '新联系人', factory_ids: [factoryOne.data.id, factoryTwo.data.id],
    });
    assert.equal(assignBoth.response.status, 200);
    assert.deepEqual(assignBoth.data.factory_ids, [factoryOne.data.id, factoryTwo.data.id]);

    const brandsResponse = await fetch(`${baseUrl}/api/brands`, { headers: { Cookie: cookie } });
    const brandsData = await brandsResponse.json();
    const savedBrand = brandsData.brands.find(brand => brand.id === brandB.data.id);
    assert.equal(savedBrand.contact, '新联系人');
    assert.deepEqual(savedBrand.factories.map(factory => factory.name).sort(), ['一号工厂', '二号工厂']);

    const factoriesResponse = await fetch(`${baseUrl}/api/factories`, { headers: { Cookie: cookie } });
    const factoriesData = await factoriesResponse.json();
    for (const factory of factoriesData.factories.filter(item => [factoryOne.data.id, factoryTwo.data.id].includes(item.id))) {
      assert.deepEqual(factory.brand_ids.slice().sort((a, b) => a - b), [brandA.data.id, brandB.data.id].sort((a, b) => a - b));
    }

    const keepOne = await requestJson(baseUrl, cookie, 'PUT', `/api/brands/${brandB.data.id}`, {
      factory_ids: [factoryTwo.data.id],
    });
    assert.equal(keepOne.response.status, 200);
    assert.deepEqual(keepOne.data.factory_ids, [factoryTwo.data.id]);

    const wouldOrphan = await requestJson(baseUrl, cookie, 'PUT', `/api/brands/${brandA.data.id}`, { factory_ids: [] });
    assert.equal(wouldOrphan.response.status, 409);
    assert.equal(wouldOrphan.data.code, 'FACTORY_REQUIRES_BRAND');
    assert.deepEqual(
      db.prepare('SELECT factory_id FROM factory_brands WHERE brand_id=? ORDER BY factory_id').all(brandA.data.id).map(row => row.factory_id),
      [factoryOne.data.id, factoryTwo.data.id],
    );

    const page = await fetch(`${baseUrl}/users`, { headers: { Cookie: cookie } });
    const html = await page.text();
    assert.match(html, /id="brandMask"/);
    assert.match(html, /class="brand-factory-select"/);
    assert.match(html, /factory_ids/);
    assert.match(html, />编辑<\/button>/);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    db.close();
    if (previousDataDir === undefined) delete process.env.RELIACODE_DATA_DIR;
    else process.env.RELIACODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
