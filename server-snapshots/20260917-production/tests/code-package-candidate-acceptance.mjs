import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const origin = process.env.CANDIDATE_ORIGIN || 'http://127.0.0.1:13001';
const username = process.env.CANDIDATE_USERNAME;
const password = process.env.CANDIDATE_PASSWORD;
assert.ok(username && password, 'candidate credentials are required');

const login = await fetch(`${origin}/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username, password }),
  redirect: 'manual'
});
assert.equal(login.status, 302, await login.text());
const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
assert.ok(cookie.includes('='), 'login did not return a session cookie');

const headers = { cookie, 'x-reliacode-request': 'same-origin' };
const productsResponse = await fetch(`${origin}/api/products`, { headers });
const productsBody = await productsResponse.json();
assert.equal(productsResponse.status, 200, JSON.stringify(productsBody));
assert.ok(productsBody.products.length > 0, 'candidate database has no product');
const product = productsBody.products[0];

const batchNo = `CANDIDATE-50000-${Date.now()}`;
const beforeQr = new Set(fs.readdirSync(path.join(process.cwd(), 'public', 'qr')));
const startedAt = performance.now();
const createResponse = await fetch(`${origin}/api/code-packages`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({
    product_id: product.id,
    batch_no: batchNo,
    quantity: 50000,
    code_type: 'item',
    origin_title: '候选环境原料入厂',
    origin_location: '候选环境',
    occurred_at: new Date().toISOString()
  })
});
const createBody = await createResponse.json();
assert.equal(createResponse.status, 201, JSON.stringify(createBody));
assert.equal(createBody.package.quantity, 50000);
assert.equal(createBody.package.status, 'ready');
const generationMs = Math.round(performance.now() - startedAt);

const overLimitResponse = await fetch(`${origin}/api/code-packages`, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ product_id: product.id, batch_no: batchNo, quantity: 50001, code_type: 'item' })
});
assert.equal(overLimitResponse.status, 400);

const urlDownload = await fetch(`${origin}${createBody.download_url}`, { headers });
assert.equal(urlDownload.status, 200);
assert.match(String(urlDownload.headers.get('content-type')), /^text\/plain; charset=utf-8/i);
assert.equal(urlDownload.headers.get('x-code-package-count'), '50000');
const urlText = Buffer.from(await urlDownload.arrayBuffer()).toString('utf8');
assert.ok(urlText.endsWith('\r\n'), 'TXT must end with CRLF');
assert.equal(urlText.replace(/\r\n/g, '').includes('\n'), false, 'TXT contains a non-CRLF newline');
const urlLines = urlText.split('\r\n').filter(Boolean);
assert.equal(urlLines.length, 50000);
assert.equal(new Set(urlLines).size, 50000);
assert.ok(urlLines.every(line => line.startsWith(`${origin}/v/S`)));

const rawDownload = await fetch(`${origin}/api/code-packages/${createBody.package.id}/download?mode=code`, { headers });
assert.equal(rawDownload.status, 200);
const rawText = Buffer.from(await rawDownload.arrayBuffer()).toString('utf8');
const rawLines = rawText.split('\r\n').filter(Boolean);
assert.equal(rawLines.length, 50000);
assert.equal(new Set(rawLines).size, 50000);
assert.ok(rawLines.every(line => /^S[A-F0-9]{24}$/.test(line)));

const { db } = await import('../database.js');
await new Promise(resolve => setTimeout(resolve, 100));
const packageRow = db.prepare('SELECT * FROM code_packages WHERE id=?').get(createBody.package.id);
const actualCount = db.prepare('SELECT COUNT(*) AS c FROM items WHERE package_id=?').get(createBody.package.id).c;
assert.equal(packageRow.status, 'ready');
assert.equal(packageRow.download_count, 2);
assert.equal(actualCount, 50000);
assert.ok(db.prepare(`SELECT 1 FROM product_batches WHERE product_id=? AND batch_no=? AND status='published'`).get(product.id, batchNo));
assert.ok(db.prepare(`SELECT 1 FROM batch_trace_entries bte JOIN product_batches pb ON pb.id=bte.batch_id
  WHERE pb.product_id=? AND pb.batch_no=? AND bte.stage_key='origin' AND bte.published=1`).get(product.id, batchNo));
assert.equal(fs.existsSync(path.join(process.cwd(), 'public', 'qr', `${rawLines[0]}.png`)), false, 'bulk generation must not pre-render QR PNG files');
const afterQr = new Set(fs.readdirSync(path.join(process.cwd(), 'public', 'qr')));
assert.equal(afterQr.size, beforeQr.size);

console.log(JSON.stringify({
  packageNo: createBody.package.package_no,
  quantity: actualCount,
  generationMs,
  urlTxtBytes: Buffer.byteLength(urlText),
  rawTxtBytes: Buffer.byteLength(rawText),
  uniqueUrlLines: new Set(urlLines).size,
  uniqueRawLines: new Set(rawLines).size,
  downloadAuditCount: packageRow.download_count,
  batchStatus: 'published',
  preRenderedQrFiles: afterQr.size - beforeQr.size
}));
