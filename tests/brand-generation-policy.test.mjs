import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('brand administrators cannot generate codes through browser or Agent routes', async () => {
  const server = await read('server.js');
  assert.match(server, /app\.post\('\/api\/codes\/generate\/boxes', requireRole\('admin', 'brand_staff'\), generateBoxes\)/);
  assert.match(server, /app\.post\('\/api\/codes\/generate\/items', requireRole\('admin', 'brand_staff'\), generateItems\)/);
  assert.match(server, /app\.post\('\/api\/agent\/codes\/boxes', requireAgentToken, requireAgentRole\('admin', 'brand_staff'\)/);
  assert.match(server, /app\.post\('\/api\/agent\/codes\/items', requireAgentToken, requireAgentRole\('admin', 'brand_staff'\)/);
  assert.match(server, /app\.get\('\/api\/products', requireRole\('admin', 'factory', 'brand', 'brand_staff'\)/);
  assert.match(server, /can\(\['admin', 'brand_staff'\]\) && 'POST \/api\/agent\/codes\/items'/);
  assert.doesNotMatch(server, /require(?:Agent)?Role\('admin', 'brand', 'brand_staff'\)[^\n]*generate(?:Boxes|Items)/);
});

test('brand administrators see an explicit policy notice instead of generation controls', async () => {
  const view = await read('views/generate.ejs');
  const css = await read('public/css/style.css');
  assert.match(view, /user\.role === 'brand'/);
  assert.match(view, /生码权限已关闭/);
  assert.match(view, /brand-generation-disabled/);
  assert.match(view, /hidden aria-hidden="true"/);
  assert.match(view, /已授权的品牌工作账号或平台管理员生成/);
  assert.match(css, /\.brand-generation-disabled\[hidden\] \{ display:none !important; \}/);
});
