import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import net from 'node:net';

const root = new URL('../', import.meta.url);
const require = createRequire(import.meta.url);
const sharp = require('sharp');

async function unusedPort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function waitForServer(child) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('溯源码系统已启动')) return;
      clearTimeout(timer); resolve();
    });
    child.once('exit', code => reject(new Error(`server exited before startup: ${code}`)));
  });
}
async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/login`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }) });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';', 1)[0];
}
const jsonRequest = (baseUrl, cookie, path, body) => fetch(`${baseUrl}${path}`, {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-ReliaCode-Request': 'same-origin' }, body: JSON.stringify(body)
});

test('image normalization and registered-batch gates remain explicit production contracts', async () => {
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(source, /const sharp = require\('sharp'\)/);
  assert.match(source, /PRODUCT_IMAGE_MAX_PIXELS = 40 \* 1000 \* 1000/);
  assert.match(source, /\.rotate\(\)\.resize\(/);
  assert.match(source, /\.webp\(\{ quality: 82/);
  assert.match(source, /function requireRegisteredBatch/);
  assert.match(source, /code: 'BATCH_REQUIRED'/);
  assert.match(source, /code: 'BATCH_NOT_FOUND'/);
  assert.ok(manifest.dependencies.sharp);
});

test('product upload normalizes to metadata-free bounded WebP and product code generation requires a registered batch', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reliacode-image-batch-'));
  process.env.RELIACODE_DATA_DIR = dataDir;
  const databasePath = require.resolve('../database.js');
  delete require.cache[databasePath];
  const { db, initDatabase, hashPassword } = require('../database.js');
  initDatabase();
  const brandId = Number(db.prepare('INSERT INTO brands (name,enabled) VALUES (?,1)').run('图片测试品牌').lastInsertRowid);
  const productId = Number(db.prepare('INSERT INTO products (name,brand_id) VALUES (?,?)').run('测试产品', brandId).lastInsertRowid);
  db.prepare('INSERT INTO users (username,password_hash,role,brand_id,enabled) VALUES (?,?,?,?,1)').run('image_brand', hashPassword('ImageBatch1!'), 'brand_staff', brandId);
  const port = await unusedPort();
  const child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], { cwd: root.pathname, env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RELIACODE_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let childErrors = '';
  child.stderr.on('data', chunk => { childErrors += String(chunk); });
  let normalizedPath = '';
  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const cookie = await login(baseUrl, 'image_brand', 'ImageBatch1!');
    const jpeg = await sharp({ create: { width: 2600, height: 1200, channels: 3, background: '#888' } })
      .jpeg().withMetadata({ exif: { IFD0: { Copyright: 'must-not-survive' } } }).toBuffer();
    const form = new FormData();
    form.append('files', new Blob([jpeg], { type: 'image/jpeg' }), 'source.jpg');
    const upload = await fetch(`${baseUrl}/api/products/${productId}/upload-images`, { method: 'POST', headers: { Cookie: cookie, 'X-ReliaCode-Request': 'same-origin' }, body: form });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.match(uploaded.urls[0], /^\/uploads\/[A-Za-z0-9-]+\.webp$/);
    normalizedPath = join(root.pathname, 'public', uploaded.urls[0]);
    const output = await readFile(normalizedPath);
    const metadata = await sharp(output).metadata();
    assert.equal(metadata.format, 'webp');
    assert.ok(metadata.width <= 2400 && metadata.height <= 2400);
    assert.equal(metadata.exif, undefined);

    db.prepare('INSERT INTO boxes (box_code,product_id,brand_id,batch_no) VALUES (?,?,?,?)').run('BVERIFYNOBATCH1', productId, brandId, 'LEGACY');
    const legacyVerify = await fetch(`${baseUrl}/api/verify/BVERIFYNOBATCH1`);
    const legacyBody = await legacyVerify.json();
    assert.equal(legacyVerify.status, 200, `${JSON.stringify(legacyBody)}\n${childErrors}`);
    assert.equal(legacyBody.success, true);
    assert.deepEqual(legacyBody.product_media, []);

    const missingBatch = await jsonRequest(baseUrl, cookie, '/api/codes/generate/items', { product_id: productId, batch_no: 'UNKNOWN', item_count: 1 });
    assert.equal(missingBatch.status, 404);
    assert.equal((await missingBatch.json()).code, 'BATCH_NOT_FOUND');
    assert.equal(db.prepare('SELECT COUNT(*) count FROM items WHERE product_id=?').get(productId).count, 0);
    db.prepare('INSERT INTO product_batches (brand_id,product_id,batch_no) VALUES (?,?,?)').run(brandId, productId, 'KNOWN');
    const generated = await jsonRequest(baseUrl, cookie, '/api/codes/generate/items', { product_id: productId, batch_no: 'KNOWN', item_count: 1 });
    assert.equal(generated.status, 200);
    assert.equal((await generated.json()).count, 1);
    const blank = await jsonRequest(baseUrl, cookie, '/api/codes/generate/items', { item_count: 1 });
    assert.equal(blank.status, 200);
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve));
    if (normalizedPath) await unlink(normalizedPath).catch(() => {});
    db.close(); delete process.env.RELIACODE_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});
