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

const postJson = (url, body, headers = {}) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
});

test('any visitor can create a role-locked member account and use the member workspace', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'reliacode-public-registration-'));
  const previousDataDir = process.env.RELIACODE_DATA_DIR;
  process.env.RELIACODE_DATA_DIR = dataDir;
  const databasePath = require.resolve('../database.js');
  delete require.cache[databasePath];
  const { db, initDatabase } = require('../database.js');
  initDatabase();
  db.prepare("INSERT INTO settings (key,value) VALUES ('contact_phone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run('010-12345678');
  const defaultBrand = db.prepare('SELECT id FROM brands ORDER BY id LIMIT 1').get();
  db.prepare('INSERT INTO invitations (code,role,note,brand_id) VALUES (?,?,?,?)')
    .run('OPENPARTNERQA', 'distributor', '开放注册回归测试', defaultBrand.id);

  const port = await unusedPort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
    cwd: rootPath,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', RELIACODE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);
    const baseUrl = `http://127.0.0.1:${port}`;
    const loginPage = await fetch(`${baseUrl}/login`);
    assert.equal(loginPage.status, 200);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /登录企业工作台/);
    assert.match(loginHtml, /商品溯源查询 · 无需登录/);
    assert.match(loginHtml, /收到合作邀请？使用邀请码注册/);
    assert.match(loginHtml, /href="tel:01012345678"/);
    assert.doesNotMatch(loginHtml, /id="rememberLogin"[^>]*checked/);

    const registrationPage = await fetch(`${baseUrl}/register`);
    assert.equal(registrationPage.status, 200);
    assert.match(await registrationPage.text(), /普通用户注册/);
    const publicRegions = await fetch(`${baseUrl}/api/regions`);
    assert.equal(publicRegions.status, 200);
    assert.equal((await publicRegions.json()).success, true);

    const weakPassword = await postJson(`${baseUrl}/api/register/public`, {
      username: 'open_member', display_name: '开放用户', password: 'too-short', role: 'admin'
    });
    assert.equal(weakPassword.status, 400);
    assert.equal((await weakPassword.json()).code, 'WEAK_PASSWORD');

    const password = 'OpenMember12!';
    const registration = await postJson(`${baseUrl}/api/register/public`, {
      username: 'open_member', display_name: '开放用户', phone: '13800138000', password,
      role: 'admin', brand_id: 1, factory_id: 1, distributor_id: 1
    });
    assert.equal(registration.status, 201);
    assert.equal((await registration.json()).success, true);
    assert.deepEqual(
      { ...db.prepare('SELECT username,display_name,phone,role,brand_id,factory_id,distributor_id FROM users WHERE username=?').get('open_member') },
      { username: 'open_member', display_name: '开放用户', phone: '13800138000', role: 'member', brand_id: null, factory_id: null, distributor_id: null }
    );

    const duplicate = await postJson(`${baseUrl}/api/register/public`, {
      username: 'open_member', display_name: '另一用户', password
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, 'USERNAME_TAKEN');

    const invitationCheck = await postJson(`${baseUrl}/api/register/check-code`, { code: 'OPENPARTNERQA' });
    assert.equal(invitationCheck.status, 200);
    assert.equal((await invitationCheck.json()).role, 'distributor');
    const partnerRegistration = await postJson(`${baseUrl}/api/register`, {
      code: 'OPENPARTNERQA', username: 'partner_member', password,
      company: '回归测试代理商', country: '中国', province: '广东省', city: '广州市', contact: '测试联系人'
    });
    assert.equal(partnerRegistration.status, 200);
    assert.equal((await partnerRegistration.json()).success, true);
    assert.equal(db.prepare('SELECT role FROM users WHERE username=?').get('partner_member').role, 'distributor');

    const invalidLogin = await fetch(`${baseUrl}/login`, {
      method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'open_member', password: 'WrongPassword12!' })
    });
    assert.equal(invalidLogin.status, 401);
    assert.deepEqual(await invalidLogin.json(), { success: false, code: 'INVALID_CREDENTIALS', msg: '账号或密码有误' });

    const login = await fetch(`${baseUrl}/login`, {
      method: 'POST', headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'open_member', password })
    });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { success: true, redirect: '/member' });
    const cookie = login.headers.get('set-cookie').split(';', 1)[0];

    const memberPage = await fetch(`${baseUrl}/member`, { headers: { Cookie: cookie } });
    assert.equal(memberPage.status, 200);
    assert.match(await memberPage.text(), /开放用户，欢迎回来/);

    const adminPage = await fetch(`${baseUrl}/users`, { headers: { Cookie: cookie } });
    assert.equal(adminPage.status, 403);
    const adminMutation = await postJson(`${baseUrl}/api/products`, { name: '越权产品' }, {
      Cookie: cookie, 'X-ReliaCode-Request': 'same-origin'
    });
    assert.equal(adminMutation.status, 403);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM products WHERE name='越权产品'").get().count, 0);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    db.close();
    if (previousDataDir === undefined) delete process.env.RELIACODE_DATA_DIR;
    else process.env.RELIACODE_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  }
});
