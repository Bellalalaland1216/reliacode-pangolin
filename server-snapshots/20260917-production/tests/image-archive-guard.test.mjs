import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const downloads = fs.readFileSync(path.join(root, 'views', 'downloads.ejs'), 'utf8');
const warehouse = fs.readFileSync(path.join(root, 'views', 'warehouse.ejs'), 'utf8');
const clawmasterCss = fs.readFileSync(path.join(root, 'public', 'css', 'clawmaster.css'), 'utf8');
const workflowCss = fs.readFileSync(path.join(root, 'public', 'css', 'workflow-layout.css'), 'utf8');

test('large image archives are rejected before QR buffers are allocated', () => {
  const guard = server.indexOf("if (mode === 'zip' && actual > IMAGE_ARCHIVE_MAX_CODES)");
  const rows = server.indexOf('const rows = db.prepare(`SELECT ${column} AS code');
  const qr = server.indexOf('const png = await getQrBuffer(code, width, baseUrl)');
  assert.ok(guard > 0);
  assert.ok(rows > guard, 'package rows must be loaded after the limit guard');
  assert.ok(qr > rows, 'QR buffers must be allocated after the limit guard');
  assert.match(server, /IMAGE_ARCHIVE_MAX_CONCURRENT/);
  assert.match(server, /IMAGE_ARCHIVE_BUSY/);
});

test('download UI steers large packages to streaming TXT', () => {
  assert.match(downloads, /Number\(pkg\.quantity\) <= archiveLimit/);
  assert.match(downloads, /工厂批量印刷请使用 TXT/);
  assert.match(downloads, /await fetch\('\/api\/codes\/package\?'/);
});

test('shipment code trees do not emit duplicate global ids', () => {
  assert.doesNotMatch(warehouse, /id="shipBoxBody_\$\{index\}"/);
  assert.match(warehouse, /head\.nextElementSibling/);
});

test('dark workflow cards and primary actions keep readable foregrounds', () => {
  assert.match(workflowCss, /@media \(prefers-color-scheme: dark\)/);
  assert.match(workflowCss, /\.package-mobile-card,[\s\S]*background: var\(--cm-surface, #181c19\) !important/);
  assert.match(workflowCss, /\.package-mobile-meta span,[\s\S]*background: var\(--workflow-canvas\) !important/);
  assert.match(clawmasterCss, /\.btn-primary,[\s\S]*color: var\(--cm-canvas\) !important/);
});
