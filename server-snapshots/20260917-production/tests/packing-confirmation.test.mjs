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
      if (!String(chunk).includes('系统已启动')) return;
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
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'admin123' }),
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie')?.split(';', 1)[0];
}

async function json(baseUrl, cookie, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-ReliaCode-Request': 'same-origin' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test('admin packing selects brand and factory, then explicitly confirms inbound stock', { timeout: 70000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reliacode-pack-confirm-'));
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
    assert.ok(cookie);

    const page = await fetch(`${baseUrl}/factory`, { headers: { Cookie: cookie } });
    const html = await page.text();
    assert.match(html, /id="selBrand"/);
    assert.match(html, /id="selFactory"/);
    assert.match(html, /id="confirmReceiptBtn"/);

    const brand = await json(baseUrl, cookie, 'POST', '/api/brands', { name: 'Pack Brand', contact: '', factory_ids: [] });
    assert.equal(brand.response.status, 201);
    const factory = await json(baseUrl, cookie, 'POST', '/api/factories', { name: 'Pack Factory', contact: '', brand_id: brand.data.id });
    assert.equal(factory.response.status, 201);
    const product = await json(baseUrl, cookie, 'POST', '/api/products', {
      name: 'Pack Product', spec: '2/unit', batch_no: 'LOT-1', box_size: 2,
      brand_id: brand.data.id, factory_ids: [factory.data.id],
    });
    assert.equal(product.data.success, true);

    db.prepare(`INSERT INTO boxes (box_code,brand_id,batch_no,item_count,box_size) VALUES ('BPACKCONFIRM1',?,'',0,0)`).run(brand.data.id);
    db.prepare(`INSERT INTO boxes (box_code,brand_id,batch_no,item_count,box_size) VALUES ('BPACKNOFACTORY',?,'',0,0)`).run(brand.data.id);
    db.prepare(`INSERT INTO items (item_code,brand_id,batch_no) VALUES ('SPACKCONFIRM1',?,'')`).run(brand.data.id);
    db.prepare(`INSERT INTO items (item_code,brand_id,batch_no) VALUES ('SPACKCONFIRM2',?,'')`).run(brand.data.id);

    const missingFactory = await json(baseUrl, cookie, 'POST', '/api/factory/pack/set-product', {
      box_code: 'BPACKNOFACTORY', product_id: product.data.id, brand_id: brand.data.id, box_size: 2, batch_no: 'LOT-1',
    });
    assert.equal(missingFactory.response.status, 403);
    assert.equal(missingFactory.data.code, 'PACKING_FACTORY_FORBIDDEN');

    const setProduct = await json(baseUrl, cookie, 'POST', '/api/factory/pack/set-product', {
      box_code: 'BPACKCONFIRM1', product_id: product.data.id, brand_id: brand.data.id,
      factory_id: factory.data.id, box_size: 2, batch_no: 'LOT-1',
    });
    assert.equal(setProduct.data.success, true);

    const first = await json(baseUrl, cookie, 'POST', '/api/factory/pack/scan', {
      box_code: 'BPACKCONFIRM1', item_code: 'SPACKCONFIRM1', box_size: 2,
      brand_id: brand.data.id, factory_id: factory.data.id,
    });
    assert.equal(first.data.success, true);
    assert.equal(first.data.full, false);
    const second = await json(baseUrl, cookie, 'POST', '/api/factory/pack/scan', {
      box_code: 'BPACKCONFIRM1', item_code: 'SPACKCONFIRM2', box_size: 2,
      brand_id: brand.data.id, factory_id: factory.data.id,
    });
    assert.equal(second.data.success, true);
    assert.equal(second.data.full, true);
    assert.equal(second.data.awaiting_confirmation, true);

    const before = await fetch(`${baseUrl}/api/factory/pack/summary?factory_id=${factory.data.id}`, { headers: { Cookie: cookie } });
    const beforeData = await before.json();
    assert.equal(beforeData.total.box_count, 0);

    const confirmed = await json(baseUrl, cookie, 'POST', '/api/factory/pack/confirm', {
      box_code: 'BPACKCONFIRM1', brand_id: brand.data.id, factory_id: factory.data.id,
    });
    assert.equal(confirmed.data.success, true);
    assert.equal(confirmed.data.item_count, 2);

    const after = await fetch(`${baseUrl}/api/factory/pack/summary?factory_id=${factory.data.id}`, { headers: { Cookie: cookie } });
    const afterData = await after.json();
    assert.equal(afterData.total.box_count, 1);
    assert.equal(afterData.total.item_count, 2);

    const repeated = await json(baseUrl, cookie, 'POST', '/api/factory/pack/confirm', {
      box_code: 'BPACKCONFIRM1', brand_id: brand.data.id, factory_id: factory.data.id,
    });
    assert.equal(repeated.response.status, 409);
    assert.equal(repeated.data.code, 'RECEIPT_ALREADY_CONFIRMED');

    const saved = db.prepare(`SELECT receipt_factory_id,receipt_confirmed_at,receipt_confirmed_by FROM boxes WHERE box_code='BPACKCONFIRM1'`).get();
    assert.equal(saved.receipt_factory_id, factory.data.id);
    assert.ok(saved.receipt_confirmed_at);
    assert.ok(saved.receipt_confirmed_by);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    db.close();
    if (previousDataDir === undefined) delete process.env.RELIACODE_DATA_DIR;
    else process.env.RELIACODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
