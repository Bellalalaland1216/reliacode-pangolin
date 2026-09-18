import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(import.meta.dirname, '..');

test('multi-factory permissions keep product authorization and physical receipt ownership separate', { timeout: 30000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reliacode-factory-boundaries-'));
  const password = `Boundary-${crypto.randomBytes(10).toString('hex')}!`;
  const databasePath = path.join(appRoot, 'database.js');
  process.env.RELIACODE_DATA_DIR = dataDir;
  delete require.cache[require.resolve(databasePath)];
  const { db, initDatabase, hashPassword } = require(databasePath);
  let server;

  try {
    initDatabase();
    for (const table of ['items', 'boxes', 'pack_records']) {
      const columns = db.pragma(`table_info(${table})`).map(column => column.name);
      if (!columns.includes('receipt_factory_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN receipt_factory_id INTEGER`);
    }
    const packColumns = db.pragma('table_info(pack_records)').map(column => column.name);
    if (!packColumns.includes('product_id')) db.exec('ALTER TABLE pack_records ADD COLUMN product_id INTEGER');
    if (!packColumns.includes('batch_no')) db.exec('ALTER TABLE pack_records ADD COLUMN batch_no TEXT');

    const brandA = Number(db.prepare('INSERT INTO brands(name,enabled) VALUES(?,1)').run('边界品牌甲').lastInsertRowid);
    const brandB = Number(db.prepare('INSERT INTO brands(name,enabled) VALUES(?,1)').run('边界品牌乙').lastInsertRowid);
    const addFactory = (name, brandId) => Number(db.prepare('INSERT INTO factories(name,brand_id) VALUES(?,?)').run(name, brandId).lastInsertRowid);
    const factoryA = addFactory('工厂甲', brandA);
    const factoryB = addFactory('工厂乙', brandA);
    const factoryC = addFactory('工厂丙', brandA);
    const archiveFactory = addFactory('历史工厂', brandA);
    const activeFactory = addFactory('在库工厂', brandA);
    const foreignFactory = addFactory('其他品牌工厂', brandB);

    const addUser = (username, role, factoryId = null, brandId = brandA) => db.prepare(`INSERT INTO users
      (username,password_hash,display_name,role,factory_id,brand_id,enabled) VALUES(?,?,?,?,?,?,1)`)
      .run(username, hashPassword(password), username, role, factoryId, brandId);
    addUser('factory_boundary_a', 'factory', factoryA);
    addUser('factory_boundary_b', 'factory', factoryB);
    addUser('brand_boundary', 'brand_staff');
    addUser('admin_boundary', 'admin', null, null);

    const addProduct = (name, primaryFactory) => Number(db.prepare(`INSERT INTO products
      (name,spec,box_size,factory_id,brand_id) VALUES(?,'10kg',2,?,?)`).run(name, primaryFactory, brandA).lastInsertRowid);
    const sharedProduct = addProduct('甲乙共用产品', factoryA);
    const exclusiveProduct = addProduct('仅甲产品', factoryA);
    const activeProduct = addProduct('在库工厂产品', activeFactory);
    const link = db.prepare('INSERT INTO product_factories(product_id,factory_id) VALUES(?,?)');
    link.run(sharedProduct, factoryA); link.run(sharedProduct, factoryB);
    link.run(exclusiveProduct, factoryA);
    link.run(activeProduct, activeFactory);
    assert.throws(() => link.run(sharedProduct, foreignFactory), /PRODUCT_FACTORY_BRAND_CONFLICT/);
    assert.equal(factoryC > 0, true);

    const batchId = Number(db.prepare(`INSERT INTO product_batches
      (brand_id,product_id,batch_no,status) VALUES(?,?,?,'published')`).run(brandA, exclusiveProduct, 'EXCLUSIVE-001').lastInsertRowid);
    db.prepare(`INSERT INTO batch_trace_entries
      (brand_id,batch_id,stage_key,title,occurred_at,published) VALUES(?,?,'origin','甲工厂履历',?,1)`)
      .run(brandA, batchId, new Date().toISOString());

    const exclusiveItem = 'SBOUNDARYEXCLUSIVE';
    db.prepare(`INSERT INTO items
      (item_code,product_id,brand_id,batch_no,status,boxed_at,receipt_factory_id)
      VALUES(?,?,?,'EXCLUSIVE-001','scanned',datetime('now','localtime'),?)`)
      .run(exclusiveItem, exclusiveProduct, brandA, factoryA);
    const sharedBox = 'BBOUNDARYSHARED';
    const sharedItem = 'SBOUNDARYSHARED';
    const sharedBoxId = Number(db.prepare(`INSERT INTO boxes
      (box_code,product_id,brand_id,batch_no,box_size,item_count,status,receipt_factory_id)
      VALUES(?,?,?,'SHARED-001',2,1,'in_stock',?)`).run(sharedBox, sharedProduct, brandA, factoryA).lastInsertRowid);
    db.prepare(`INSERT INTO items
      (item_code,box_id,product_id,brand_id,batch_no,status,boxed_at,receipt_factory_id)
      VALUES(?,?,?,?,?,'scanned',datetime('now','localtime'),?)`)
      .run(sharedItem, sharedBoxId, sharedProduct, brandA, 'SHARED-001', factoryA);
    const blankItem = 'SBOUNDARYBLANK';
    db.prepare(`INSERT INTO items(item_code,brand_id,status) VALUES(?,?,'in_stock')`).run(blankItem, brandA);
    const bulkBox = 'BBOUNDARYBULK';
    db.prepare(`INSERT INTO boxes(box_code,product_id,brand_id,batch_no,box_size,status)
      VALUES(?,?,?,'SHARED-BULK',2,'in_stock')`).run(bulkBox, sharedProduct, brandA);
    db.prepare(`INSERT INTO items(item_code,brand_id,status) VALUES('SBOUNDARYBULK',?,'in_stock')`).run(brandA);
    db.prepare(`INSERT INTO items(item_code,brand_id,status) VALUES('SBOUNDARYFACTORYA',?,'in_stock')`).run(brandA);
    db.prepare(`INSERT INTO items(item_code,brand_id,status) VALUES('SBOUNDARYFACTORYB',?,'in_stock')`).run(brandA);
    db.prepare(`INSERT INTO items(item_code,product_id,brand_id,batch_no,status,boxed_at,receipt_factory_id)
      VALUES('SBOUNDARYACTIVE',?,?,?,'scanned',datetime('now','localtime'),?)`)
      .run(activeProduct, brandA, 'ACTIVE-001', activeFactory);
    db.prepare(`INSERT INTO pack_records(factory_id,receipt_factory_id,brand_id,action,detail)
      VALUES(?,?,?,'nobox','历史记录')`).run(archiveFactory, archiveFactory, brandA);

    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const output = [];
    server = spawn(process.execPath, ['server.js'], {
      cwd: appRoot,
      env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RELIACODE_DATA_DIR: dataDir, ALLOWED_HOSTS: '127.0.0.1,localhost' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', chunk => output.push(chunk.toString()));
    server.stderr.on('data', chunk => output.push(chunk.toString()));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${base}/readyz`)).ok) break; } catch {}
      if (attempt === 99) throw new Error(`server not ready: ${output.slice(-20).join('')}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    async function login(username) {
      const response = await fetch(`${base}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ username, password, remember: '0' }), redirect: 'manual',
      });
      assert.equal(response.status, 302);
      return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    }
    async function request(cookie, route, body, method = body === undefined ? 'GET' : 'POST') {
      const response = await fetch(`${base}${route}`, {
        method,
        headers: { Cookie: cookie, Origin: base, 'X-ReliaCode-Request': 'same-origin', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = null; }
      return { status: response.status, data, text };
    }

    const factoryBSession = await login('factory_boundary_b');
    const factoryBProfile = await request(factoryBSession, '/profile');
    assert.equal(factoryBProfile.status, 200);
    assert.match(factoryBProfile.text, /data-profile-factory-name[^>]+value="工厂乙"/);
    assert.match(factoryBProfile.text, /data-profile-brand-name[^>]+value="边界品牌甲"/);
    const products = await request(factoryBSession, '/api/products');
    assert.equal(products.data.products.some(product => product.id === exclusiveProduct), false);
    assert.equal((await request(factoryBSession, `/api/batches/${batchId}/trace`)).status, 404);
    assert.equal((await request(factoryBSession, '/api/factory/pack/start', { box_code: sharedBox })).status, 404);
    assert.equal((await request(factoryBSession, '/api/codes/cancel-stock', { code: exclusiveItem, expected_mode: 'nobox' })).status, 404);
    assert.equal(db.prepare('SELECT product_id FROM items WHERE item_code=?').get(exclusiveItem).product_id, exclusiveProduct);
    const factoryBReceipt = await request(factoryBSession, '/api/factory/pack/scan-nobox', {
      item_code: 'SBOUNDARYFACTORYB', product_id: sharedProduct, batch_no: 'SHARED-B',
    });
    assert.equal(factoryBReceipt.data.success, true);
    assert.equal(db.prepare("SELECT receipt_factory_id FROM items WHERE item_code='SBOUNDARYFACTORYB'").get().receipt_factory_id, factoryB);

    const factoryASession = await login('factory_boundary_a');
    const factoryAReceipt = await request(factoryASession, '/api/factory/pack/scan-nobox', {
      item_code: 'SBOUNDARYFACTORYA', product_id: sharedProduct, batch_no: 'SHARED-A',
    });
    assert.equal(factoryAReceipt.data.success, true);
    assert.equal(db.prepare("SELECT receipt_factory_id FROM items WHERE item_code='SBOUNDARYFACTORYA'").get().receipt_factory_id, factoryA);

    const brandSession = await login('brand_boundary');
    const missingFactory = await request(brandSession, '/api/factory/pack/scan-nobox', {
      item_code: blankItem, product_id: sharedProduct, batch_no: 'SHARED-002',
    });
    assert.equal(missingFactory.status, 400);
    assert.equal(missingFactory.data.code, 'RECEIPT_FACTORY_REQUIRED');
    const assignedFactory = await request(brandSession, '/api/factory/pack/scan-nobox', {
      item_code: blankItem, product_id: sharedProduct, batch_no: 'SHARED-002', operation_factory_id: factoryB,
    });
    assert.equal(assignedFactory.data.success, true);
    assert.equal(db.prepare('SELECT receipt_factory_id FROM items WHERE item_code=?').get(blankItem).receipt_factory_id, factoryB);
    const bulkMissingFactory = await request(brandSession, '/api/codes/bind', {
      box_code: bulkBox, item_codes: ['SBOUNDARYBULK'],
    });
    assert.equal(bulkMissingFactory.status, 400);
    assert.equal(bulkMissingFactory.data.code, 'RECEIPT_FACTORY_REQUIRED');
    const bulkAssignedFactory = await request(brandSession, '/api/codes/bind', {
      box_code: bulkBox, item_codes: ['SBOUNDARYBULK'], operation_factory_id: factoryB,
    });
    assert.equal(bulkAssignedFactory.data.success, true);
    assert.equal(db.prepare("SELECT receipt_factory_id FROM boxes WHERE box_code='BBOUNDARYBULK'").get().receipt_factory_id, factoryB);
    assert.equal(db.prepare("SELECT receipt_factory_id FROM items WHERE item_code='SBOUNDARYBULK'").get().receipt_factory_id, factoryB);
    const recordsB = await request(brandSession, `/api/factory/pack/records?factory_id=${factoryB}`);
    const recordsA = await request(brandSession, `/api/factory/pack/records?factory_id=${factoryA}`);
    assert.equal(recordsB.data.records.some(row => row.item_code === 'SBOUNDARYBULK'), true);
    assert.equal(recordsA.data.records.some(row => row.item_code === 'SBOUNDARYBULK'), false);

    const product = db.prepare('SELECT * FROM products WHERE id=?').get(exclusiveProduct);
    const blockedUnassign = await request(brandSession, `/api/products/${exclusiveProduct}`, {
      name: product.name, spec: product.spec, box_size: product.box_size, brand_id: brandA, factory_ids: [], version: product.version,
    }, 'PUT');
    assert.equal(blockedUnassign.status, 409);
    assert.equal(blockedUnassign.data.code, 'PRODUCT_FACTORY_HAS_ACTIVE_STOCK');

    const adminSession = await login('admin_boundary');
    const activeDelete = await request(adminSession, `/api/factories/${activeFactory}`, undefined, 'DELETE');
    assert.equal(activeDelete.status, 409);
    assert.equal(activeDelete.data.code, 'FACTORY_HAS_ACTIVE_STOCK');
    const archive = await request(adminSession, `/api/factories/${archiveFactory}`, undefined, 'DELETE');
    assert.equal(archive.status, 200);
    assert.equal(archive.data.archived, true);
    assert.equal(db.prepare('SELECT enabled FROM factories WHERE id=?').get(archiveFactory).enabled, 0);
    const sharedBeforeArchiveAssignment = db.prepare('SELECT * FROM products WHERE id=?').get(sharedProduct);
    const archivedAssignment = await request(adminSession, `/api/products/${sharedProduct}`, {
      name: sharedBeforeArchiveAssignment.name, spec: sharedBeforeArchiveAssignment.spec,
      box_size: sharedBeforeArchiveAssignment.box_size, brand_id: brandA,
      factory_ids: [factoryA, archiveFactory], version: sharedBeforeArchiveAssignment.version,
    }, 'PUT');
    assert.equal(archivedAssignment.status, 400);
    assert.equal(archivedAssignment.data.code, 'PRODUCT_FACTORY_INVALID');
  } finally {
    if (server && server.exitCode == null) {
      server.kill('SIGTERM');
      await new Promise(resolve => server.once('exit', resolve));
    }
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
