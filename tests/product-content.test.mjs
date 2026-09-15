import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function login(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password })
  });
  assert.equal(response.status, 302);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

const jsonRequest = (baseUrl, cookie, method, path, body) => fetch(`${baseUrl}${path}`, {
  method,
  headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-ReliaCode-Request': 'same-origin' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

test('product content stays tenant-scoped and only published reviewed content is public', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reliacode-product-content-'));
  const previousDataDir = process.env.RELIACODE_DATA_DIR;
  process.env.RELIACODE_DATA_DIR = dataDir;
  const databasePath = require.resolve('../database.js');
  delete require.cache[databasePath];
  const { db, initDatabase, hashPassword } = require('../database.js');
  initDatabase();

  const ownBrand = Number(db.prepare('INSERT INTO brands (name,enabled) VALUES (?,1)').run('内容品牌').lastInsertRowid);
  const foreignBrand = Number(db.prepare('INSERT INTO brands (name,enabled) VALUES (?,1)').run('其他品牌').lastInsertRowid);
  const ownProduct = Number(db.prepare('INSERT INTO products (name,spec,brand_id) VALUES (?,?,?)').run('草原牛肉','500g',ownBrand).lastInsertRowid);
  const foreignProduct = Number(db.prepare('INSERT INTO products (name,brand_id) VALUES (?,?)').run('其他产品',foreignBrand).lastInsertRowid);
  const password = 'ProductContent1!';
  db.prepare('INSERT INTO users (username,password_hash,display_name,role,brand_id,enabled) VALUES (?,?,?,?,?,1)')
    .run('product_content_brand',hashPassword(password),'内容管理员','brand',ownBrand);

  const port = await unusedPort();
  const child = spawn(process.execPath, [new URL('../server.js', import.meta.url).pathname], {
    cwd: root.pathname,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RELIACODE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const cookie = await login(baseUrl, 'product_content_brand', password);

    const crossTenant = await jsonRequest(baseUrl,cookie,'GET',`/api/products/${foreignProduct}/content`);
    assert.equal(crossTenant.status,404);

    const media = await jsonRequest(baseUrl,cookie,'PUT',`/api/products/${ownProduct}/media`,{media:[
      {url:'/uploads/beef-cover.webp',alt_text:'牛肉产品封面',is_cover:true},
      {url:'/uploads/beef-origin.webp',alt_text:'原料产地'}
    ]});
    assert.equal(media.status,200);
    assert.equal((await media.json()).media.length,2);

    const template = await jsonRequest(baseUrl,cookie,'PUT',`/api/products/${ownProduct}/trace-template`,{stages:[
      {stage_key:'origin',title:'原料来源',public_label:'内蒙古草原'},
      {stage_key:'quality',title:'质量检验',public_label:'出厂检验'}
    ]});
    assert.equal(template.status,200);

    const batchResponse = await jsonRequest(baseUrl,cookie,'POST',`/api/products/${ownProduct}/batches`,{batch_no:'BATCH-PC-001',production_date:'2026-08-31'});
    assert.equal(batchResponse.status,201);
    const batch = await batchResponse.json();
    const trace = await jsonRequest(baseUrl,cookie,'POST',`/api/batches/${batch.id}/trace`,{
      stage_key:'origin',title:'原料入厂',public_location:'内蒙古',occurred_at:'2026-08-30T08:00:00+08:00',detail:'来自已审核供应商'
    });
    assert.equal(trace.status,201);

    const marketing = await jsonRequest(baseUrl,cookie,'PUT',`/api/products/${ownProduct}/marketing`,{
      image_url:'/uploads/beef-campaign.webp',title:'产地故事',description:'了解本批次原料故事',target_url:'https://example.com/beef',enabled:true
    });
    assert.equal(marketing.status,200);
    await jsonRequest(baseUrl,cookie,'PUT',`/api/products/${ownProduct}/marketing/review`,{status:'approved'});
    await jsonRequest(baseUrl,cookie,'PUT',`/api/batches/${batch.id}/publish`,{version:batch.version});

    db.prepare('INSERT INTO items (item_code,product_id,brand_id,batch_no) VALUES (?,?,?,?)')
      .run('SPRODUCTCONTENT1',ownProduct,ownBrand,'BATCH-PC-001');
    const verify = await fetch(`${baseUrl}/api/verify/SPRODUCTCONTENT1`);
    assert.equal(verify.status,200);
    const body = await verify.json();
    assert.equal(body.success,true);
    assert.equal(body.product_media.length,2);
    assert.equal(body.trace_timeline.length,1);
    assert.equal(body.trace_timeline[0].title,'原料入厂');
    assert.equal(body.promotion.title,'产地故事');
    assert.equal(body.promotion.target_url,'https://example.com/beef');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    db.close();
    if (previousDataDir === undefined) delete process.env.RELIACODE_DATA_DIR;
    else process.env.RELIACODE_DATA_DIR = previousDataDir;
    await rm(dataDir,{recursive:true,force:true});
  }
});
