import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

function sourceFiles(dir) {
  const absolute = new URL(dir, root);
  return readdirSync(absolute).flatMap(name => {
    const item = join(absolute.pathname, name);
    if (statSync(item).isDirectory()) return sourceFiles(relative(root.pathname, item) + '/');
    return /\.(?:ejs|js|svg|css)$/.test(name) ? [item] : [];
  });
}

test('codes template cannot terminate its main script from print HTML', () => {
  const source = read('views/codes.ejs');
  assert.equal((source.match(/<script(?:\s|>)/g) || []).length, 1);
  assert.equal((source.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(source, /<script\\x3e|<\\\/script>/);
  assert.match(source, /w\.document\.querySelector\('\.tip'\)\.addEventListener/);
  assert.match(source, /image\.addEventListener\('load', done/);
  assert.match(source, /const siteBrand = <%\- JSON\.stringify/);
});

test('login page never persists a password in browser storage', () => {
  const source = read('views/login.ejs');
  assert.doesNotMatch(source, /localStorage|trace_saved_login|saved\.p|btoa\(/);
  assert.match(source, /autocomplete="current-password"/);
  assert.match(source, /name="remember" value="1"/);
  assert.match(source, /在此设备保持登录/);
  assert.match(source, /选择后保持 30 天；未选择时最长 12 小时/);
  assert.doesNotMatch(source, /id="rememberLogin"[^>]*checked/);
  assert.match(source, /id="passwordToggle"/);
});

test('production sessions persist in SQLite instead of process memory', () => {
  const server = read('server.js');
  const store = read('sqlite-session-store.js');
  assert.match(server, /new SQLiteSessionStore\(db/);
  assert.match(server, /store: sessionStore/);
  assert.match(store, /CREATE TABLE IF NOT EXISTS app_sessions/);
  assert.match(store, /idx_app_sessions_expires/);
  assert.match(store, /ON CONFLICT\(sid\) DO UPDATE/);
  assert.match(store, /cleanupTimer\.unref/);
});

test('database location can be isolated for integration tests and recovery drills', () => {
  const database = read('database.js');
  assert.match(database, /process\.env\.RELIACODE_DATA_DIR/);
  assert.match(database, /path\.resolve\(process\.env\.RELIACODE_DATA_DIR\)/);
  assert.match(database, /path\.join\(DATA_DIR, 'traceability\.db'\)/);
});

test('authenticated mutations require a same-origin browser or explicit agent header', () => {
  const server = read('server.js');
  const nav = read('views/partials/nav.ejs');
  assert.match(server, /CSRF_EXEMPT_PATHS/);
  assert.match(server, /origin === expectedOrigin/);
  assert.match(server, /agentHeader === 'same-origin'/);
  assert.match(server, /code: 'CSRF_REJECTED'/);
  assert.match(nav, /X-ReliaCode-Request/);
  assert.match(nav, /url\.origin === location\.origin/);
});

test('login throttling persists in SQLite without storing raw source addresses', () => {
  const server = read('server.js');
  assert.match(server, /CREATE TABLE IF NOT EXISTS login_rate_limits/);
  assert.match(server, /idx_login_rate_limits_reset_at/);
  assert.match(server, /createHmac\('sha256', SESSION_SECRET\)/);
  assert.match(server, /`ip:\$\{String\(req\.ip/);
  assert.match(server, /`account:\$\{String\(req\.body\?\.username/);
  assert.match(server, /\[loginSourceHash\(req\), loginAccountHash\(req\)\]/);
  assert.match(server, /const recordLoginAttempt = db\.transaction/);
  assert.match(server, /deleteLoginLimit\.run\(loginSourceHash\(req\)\)/);
  assert.match(server, /deleteLoginLimit\.run\(loginAccountHash\(req\)\)/);
  assert.doesNotMatch(server, /const loginAttempts = new Map/);
});

test('registration is rate limited, invitation claims are atomic and codes are cryptographically random', () => {
  const server = read('server.js');
  assert.match(server, /app\.post\('\/api\/register\/check-code', registrationRateLimit/);
  assert.match(server, /app\.post\('\/api\/register', registrationRateLimit/);
  assert.match(server, /code: 'REGISTER_RATE_LIMITED'/);
  assert.match(server, /WHERE id=\? AND status=0/);
  assert.match(server, /claim\.changes !== 1/);
  assert.match(server, /code: 'INVITATION_ALREADY_USED'/);
  assert.match(server, /crypto\.randomBytes\(12\)\.toString\('hex'\)\.toUpperCase\(\)/);
  assert.doesNotMatch(server, /'INV' \+ Math\.random/);
  assert.doesNotMatch(server, /注册失败：' \+ e\.message/);
});

test('responses expose an opaque request id for production diagnostics', () => {
  const server = read('server.js');
  assert.match(server, /const forwardedRequestId = String\(req\.get\('x-request-id'\)/);
  assert.match(server, /\[a-f0-9\]\{32\}/);
  assert.match(server, /: crypto\.randomUUID\(\)/);
  assert.match(server, /res\.setHeader\('X-Request-ID', requestId\)/);
  assert.match(server, /code: 'NOT_FOUND', requestId: req\.requestId/);
  assert.match(server, /code: 'INTERNAL_ERROR', requestId: req\.requestId/);
  assert.match(server, /req\.requestId, req\.method, req\.url, err\.message/);
});

test('production exposes session-free liveness and database readiness probes', () => {
  const server = read('server.js');
  const healthIndex = server.indexOf("app.get('/healthz'");
  const readyIndex = server.indexOf("app.get('/readyz'");
  const sessionIndex = server.indexOf('app.use(session({');
  assert.ok(healthIndex > 0 && readyIndex > healthIndex && readyIndex < sessionIndex);
  assert.match(server, /db\.prepare\('SELECT 1 AS ready'\)\.get\(\)/);
  assert.match(server, /res\.status\(503\)\.json\(\{ status: 'unavailable', requestId: req\.requestId \}\)/);
  assert.match(server, /event: 'readiness_failed'/);
});

test('fatal process errors drain resources and let the supervisor restart cleanly', () => {
  const server = read('server.js');
  assert.match(server, /function shutdown\(reason, exitCode\)/);
  assert.match(server, /httpServer\.close\(finish\)/);
  assert.match(server, /sessionStore\.close\(\)/);
  assert.match(server, /db\.close\(\)/);
  assert.match(server, /process\.once\('SIGTERM'/);
  assert.match(server, /process\.once\('SIGINT'/);
  assert.match(server, /shutdown\('uncaughtException', 1\)/);
  assert.match(server, /shutdown\('unhandledRejection', 1\)/);
  assert.match(server, /httpServer = app\.listen\(PORT, '127\.0\.0\.1'/);
  assert.doesNotMatch(server, /未捕获异常不直接崩溃/);
});

test('static assets bypass session storage and use bounded revalidation caching', () => {
  const server = read('server.js');
  const staticIndex = server.indexOf("app.use(express.static(path.join(__dirname, 'public'), {");
  const sessionIndex = server.indexOf('app.use(session({');
  const noStoreIndex = server.indexOf("res.setHeader('Cache-Control', 'no-store, no-cache");
  assert.ok(staticIndex > 0 && staticIndex < sessionIndex && sessionIndex < noStoreIndex);
  assert.match(server, /maxAge: '1h'/);
  assert.match(server, /Cache-Control', 'public, max-age=3600, must-revalidate'/);
  assert.equal((server.match(/app\.use\(express\.static/g) || []).length, 1);
});

test('logout mutates sessions only through a same-origin POST', () => {
  const server = read('server.js');
  const nav = read('views/partials/nav.ejs');
  const me = read('views/admin-me.ejs');
  assert.match(server, /app\.post\('\/logout'/);
  const getLogout = server.slice(server.indexOf("app.get('/logout'"), server.indexOf('// ===================== 邀请码', server.indexOf("app.get('/logout'")));
  assert.doesNotMatch(getLogout, /session\.destroy/);
  assert.match(getLogout, /res\.redirect\(303/);
  assert.match(nav, /<form method="POST" action="\/logout"/);
  assert.match(me, /<form method="POST" action="\/logout"/);
  assert.doesNotMatch(nav, /href="\/logout"/);
  assert.doesNotMatch(me, /href="\/logout"/);
});

test('uploads verify file signatures and backups use POST with private permissions', () => {
  const server = read('server.js');
  const settings = read('views/settings.ejs');
  assert.match(server, /function uploadMagicMatches/);
  assert.match(server, /INVALID_FILE_CONTENT/);
  assert.match(server, /removeUploadedFiles\(req\.files\)/);
  assert.match(server, /app\.post\('\/api\/backup\/download'/);
  assert.match(server, /fs\.chmodSync\(backupDir, 0o700\)/);
  assert.match(server, /fs\.chmodSync\(file, 0o600\)/);
  assert.match(server, /fs\.lstatSync\(file\)\.isFile\(\)/);
  assert.match(settings, /<form method="POST" action="\/api\/backup\/download"/);
  assert.doesNotMatch(settings, /location\.href='\/api\/backup\/download'/);
});

test('every inline script is prepared for a per-request CSP nonce', () => {
  const server = read('server.js');
  assert.match(server, /const cspNonce = crypto\.randomBytes\(18\)\.toString\('base64'\)/);
  assert.match(server, /script-src 'self' 'nonce-\$\{cspNonce\}'/);
  assert.match(server, /script-src-attr 'none'/);
  assert.doesNotMatch(server, /script-src 'self' 'unsafe-inline'/);
  assert.match(server, /style-src 'self' 'nonce-\$\{cspNonce\}'/);
  assert.match(server, /style-src-attr 'none'/);
  for (const file of sourceFiles('views/').filter(file => file.endsWith('.ejs'))) {
    const source = readFileSync(file, 'utf8');
    const inlineCount = (source.match(/<script(?=[\s>])(?![^\n]*\bsrc=)/g) || []).length;
    const nonceCount = (source.match(/<script nonce="<%= cspNonce %>">/g) || []).length;
    assert.equal(nonceCount, inlineCount, `${file} has an un-nonced inline script`);
    const inlineStyleCount = (source.match(/<style(?=[\s>])/g) || []).length;
    const styleNonceCount = (source.match(/<style nonce="<%= cspNonce %>">/g) || []).length;
    assert.equal(styleNonceCount, inlineStyleCount, `${file} has an un-nonced inline style block`);
  }
});

test('views do not depend on inline event attributes', () => {
  const inlineEvent = /\son(?:click|change|input|submit|error|load)\s*=/i;
  for (const file of sourceFiles('views/').filter(file => file.endsWith('.ejs'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), inlineEvent, `${file} still contains an inline event attribute`);
  }
});

test('views do not depend on style attributes or style property mutations', () => {
  const inlineStyle = /\sstyle\s*=/i;
  for (const file of sourceFiles('views/').filter(file => file.endsWith('.ejs'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, inlineStyle, `${file} still contains a style attribute`);
    assert.doesNotMatch(source, /\.style\./, `${file} still mutates element.style`);
  }
});

test('first-party scanner overlay is CSP-safe, white-first and injection-resistant', () => {
  const scanner = read('public/js/scanner.js');
  const css = read('public/css/style.css');
  assert.doesNotMatch(scanner, /\.style\.|style\.cssText|\.onclick\s*=|innerHTML\s*=/);
  assert.match(scanner, /headingText\.textContent = String\(title/);
  assert.match(scanner, /closeBtn\.addEventListener\('click', closeScanner\)/);
  assert.match(scanner, /createElementNS\('http:\/\/www\.w3\.org\/2000\/svg', 'svg'\)/);
  assert.match(css, /\.scanner-mask \{[^}]*background:#fff;/s);
  assert.match(css, /\.scanner-panel \{[^}]*background:#fff;[^}]*border:1px solid #000;/s);
  assert.match(css, /\.scanner-region \{[^}]*background:#fff;[^}]*border:1px solid #000;/s);
  assert.match(scanner, /new Html5Qrcode\('scannerRegion'\)/);
  assert.doesNotMatch(scanner, /Html5QrcodeScanner/);
});

test('scanner vendor stays local and the third-party colored control panel is never mounted', () => {
  const templates = sourceFiles('views/').filter(file => file.endsWith('.ejs')).map(file => readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(templates, /<(?:script|link)[^>]+(?:src|href)=["']https?:\/\//i);
  assert.match(templates, /\/js\/html5-qrcode\.min\.js/);
  assert.doesNotMatch(templates, /Html5QrcodeScanner/);
});

test('dynamic management tables escape API data and media URLs stay same-origin', () => {
  const server = read('server.js');
  const settings = read('views/settings.ejs');
  const warehouse = read('views/warehouse.ejs');
  const users = read('views/users.ejs');
  const generate = read('views/generate.ejs');
  assert.ok(server.includes("const isLocalUpload = value => !value || /^\\/uploads"));
  assert.match(server, /code: 'INVALID_MEDIA_URL'/);
  assert.ok(settings.includes("const safeLocalMedia = value => /^\\/uploads"));
  assert.match(settings, /escapeHtml\(b\.name\)/);
  assert.match(settings, /escapeHtml\(safeLocalMedia\(u\)\)/);
  assert.match(warehouse, /escapeHtml\(s\.distributor_name\)/);
  assert.match(warehouse, /escapeHtml\(s\.operator \|\| '-'\)/);
  assert.match(users, /esc\(b\.name\)/);
  assert.match(users, /esc\(b\.contact \|\| '-'\)/);
  assert.ok(generate.includes("const safeQrUrl = value => /^\\/qr"));
  assert.match(generate, /escapeHtml\(c\.box_code \|\| c\.item_code\)/);
});

test('existing product editor remains operable in embedded and legacy mobile browsers', () => {
  const generate = read('views/generate.ejs');
  assert.match(generate, /\.edit-product-btn'[\s\S]*addEventListener\('click',[\s\S]*editProduct\(button\.dataset\.productId\)/);
  assert.match(generate, /typeof previewMedia\.addEventListener === 'function'/);
  assert.match(generate, /typeof previewMedia\.addListener === 'function'/);
  assert.match(generate, /产品内容加载失败，请检查网络后重试/);
});

test('views do not contain duplicate class attributes', () => {
  const duplicateClass = /<[^>]*\bclass="[^"]*"[^>]*\bclass\s*=/i;
  for (const file of sourceFiles('views/').filter(file => file.endsWith('.ejs'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), duplicateClass, `${file} contains duplicate class attributes`);
  }
});

test('production networking and QR generation retain required safety invariants', () => {
  const source = read('server.js');
  assert.match(source, /secure: 'auto'/);
  assert.match(source, /const getBaseUrl = \(req\) => `\$\{req\.protocol\}:\/\/\$\{req\.get\('host'\)\}`/);
  assert.match(source, /generated\.push\(\{ id: Number\(boxResult\.lastInsertRowid\)/);
  assert.match(source, /generated\.push\(\{ id: Number\(itemResult\.lastInsertRowid\)/);
  assert.match(source, /app\.listen\(PORT, '127\.0\.0\.1'/);
  assert.doesNotMatch(source, /reqHostCache|trace-fallback-secret/);
  assert.match(source, /app\.get\('\/api\/qr', requireLogin/);
  assert.match(source, /data\.length > 2048/);
  assert.match(source, /code: 'QR_DATA_TOO_LARGE'/);
});

test('vendor-neutral Agent generation requires short-lived hashed tokens and idempotency', () => {
  const server = read('server.js');
  const docs = read('docs/agent-api.md');
  assert.match(server, /app\.get\('\/.well-known\/reliacode-agent\.json'/);
  assert.match(server, /app\.post\('\/api\/agent\/login', agentLoginRateLimit/);
  assert.match(server, /crypto\.randomBytes\(32\)\.toString\('base64url'\)/);
  assert.match(server, /agentTokenHash\(token\)/);
  assert.doesNotMatch(server, /INSERT INTO agent_tokens[^;]+access_token/s);
  assert.match(server, /requireAgentIdempotency/);
  assert.match(server, /Idempotency-Replayed/);
  assert.match(server, /app\.post\('\/api\/agent\/codes\/boxes'/);
  assert.match(server, /app\.post\('\/api\/agent\/codes\/items'/);
  assert.match(server, /app\.post\('\/api\/agent\/logout'/);
  assert.match(server, /const agentApi = req\.path\.startsWith\('\/agent\/'\)/);
  assert.match(server, /function removeGeneratedQr\(code\)/);
  assert.match(server, /for \(const code of deleted\) removeGeneratedQr\(code\)/);
  assert.match(docs, /GET \/\.well-known\/reliacode-agent\.json/);
  assert.match(docs, /Idempotency-Key/);
  assert.match(docs, /Do not place passwords or tokens in URLs/);
});

test('the application rejects unrecognized Host headers before sessions and QR generation', () => {
  const source = read('server.js');
  const hostGuardIndex = source.indexOf("const allowedHosts = new Set(");
  const sessionIndex = source.indexOf('app.use(session({');
  assert.ok(hostGuardIndex > 0 && hostGuardIndex < sessionIndex);
  assert.match(source, /process\.env\.ALLOWED_HOSTS \|\| '8\.140\.52\.117,127\.0\.0\.1,localhost'/);
  assert.match(source, /new URL\(`http:\/\/\$\{String\(req\.get\('host'\)/);
  assert.match(source, /status\(421\).*code: 'UNRECOGNIZED_HOST'/s);
  assert.match(source, /const getBaseUrl = \(req\) => `\$\{req\.protocol\}:\/\/\$\{req\.get\('host'\)\}`/);
});

test('public verification is persistently rate limited and validates coordinates', () => {
  const source = read('server.js');
  assert.match(source, /CREATE TABLE IF NOT EXISTS verification_rate_limits/);
  assert.match(source, /idx_verification_rate_limits_reset_at/);
  assert.match(source, /const recordVerificationAttempt = db\.transaction/);
  assert.match(source, /app\.get\('\/api\/verify\/:code', verificationRateLimit/);
  assert.match(source, /code: 'VERIFY_RATE_LIMITED'/);
  assert.match(source, /lat >= -90 && lat <= 90/);
  assert.match(source, /lng >= -180 && lng <= 180/);
});

test('consumer verification does not disclose IP addresses or request location automatically', () => {
  const server = read('server.js');
  const verify = read('views/verify.ejs');
  const logs = read('views/logs.ejs');
  assert.doesNotMatch(server, /ip-api\.com|async function ipLocate|ipLocCache/);
  assert.match(server, /const scanSourceId = value => crypto\.createHmac/);
  assert.match(server, /\.digest\('hex'\)\.slice\(0, 20\)/);
  assert.match(server, /displayScanSource/);
  assert.match(server, /geolocation=\(\)/);
  assert.doesNotMatch(verify, /navigator\.geolocation|getCurrentPosition|geoCoords/);
  assert.doesNotMatch(verify, /自动按IP定位/);
  assert.match(verify, /仅在主动填写时用于串货检测/);
  assert.match(logs, /来源标识/);
  assert.doesNotMatch(logs, /<th>IP<\/th>/);
});

test('brand staff cannot reach account, invitation, or destructive code routes', () => {
  const source = read('server.js');
  for (const route of [
    "app.get('/api/invitations'", "app.post('/api/invitations'",
    "app.delete('/api/invitations/:id'", "app.get('/users'",
    "app.get('/api/users'", "app.post('/api/users'",
    "app.delete('/api/codes/:type/:id'", "app.post('/api/codes/batch-delete'"
  ]) {
    const start = source.indexOf(route);
    assert.notEqual(start, -1, `missing route ${route}`);
    assert.doesNotMatch(source.slice(start, source.indexOf('\n', start)), /brand_staff/, route);
  }
});

test('packing, binding and shipping enforce one tenant scope for every non-admin role', () => {
  const server = read('server.js');
  const routeBlock = (start, end) => server.slice(server.indexOf(start), server.indexOf(end, server.indexOf(start)));
  const bind = routeBlock("app.post('/api/codes/bind'", "app.post('/api/codes/unbind'");
  assert.match(bind, /requestedItems\.some\(item => !item \|\| !brandAllowed\(scope, item\.eff_brand_id\)\)/);
  assert.match(bind, /status\(404\).*code: 'ITEM_NOT_FOUND'/s);
  assert.match(bind, /requestedCodes\.length > 5000/);
  const packStart = routeBlock("app.post('/api/factory/pack/start'", "app.post('/api/factory/pack/set-product'");
  const setProduct = routeBlock("app.post('/api/factory/pack/set-product'", "app.post('/api/factory/pack/scan'");
  const packScan = routeBlock("app.post('/api/factory/pack/scan'", '// --- 仓库发货 ---');
  for (const block of [packStart, setProduct, packScan]) {
    assert.match(block, /const scope = brandScope\(req\)/);
    assert.doesNotMatch(block, /role === 'factory'|role === 'brand'/);
  }
  assert.match(setProduct, /brandAllowed\(scope, box\.brand_id\)/);
  assert.match(setProduct, /brandAllowed\(scope, product\.brand_id\)/);
  assert.match(packScan, /COALESCE\(i\.brand_id, p\.brand_id\) as eff_brand_id/);
  assert.match(packScan, /brandAllowed\(scope, item\.eff_brand_id\)/);
  const shipping = routeBlock("app.post('/api/shipments/ship'", "app.get('/api/shipments'");
  assert.match(shipping, /COALESCE\(b\.brand_id, p\.brand_id\) as eff_brand_id/);
  assert.match(shipping, /COALESCE\(i\.brand_id, p\.brand_id\) as eff_brand_id/);
  assert.match(shipping, /code: 'BOX_NOT_FOUND'/);
  assert.match(shipping, /code: 'ITEM_NOT_FOUND'/);
});

test('factory deletion follows product ownership without querying missing code columns', () => {
  const server = read('server.js');
  assert.doesNotMatch(server, /FROM boxes WHERE factory_id=/);
  assert.doesNotMatch(server, /FROM items WHERE factory_id=/);
  assert.doesNotMatch(server, /UPDATE boxes SET factory_id=/);
  assert.doesNotMatch(server, /UPDATE items SET factory_id=/);
  assert.match(server, /FROM boxes b JOIN products p ON p\.id=b\.product_id WHERE p\.factory_id=/);
  assert.match(server, /FROM items i JOIN products p ON p\.id=i\.product_id WHERE p\.factory_id=/);
});

test('all account creation and password reset routes enforce the pilot password policy', () => {
  const server = read('server.js');
  assert.match(server, /PASSWORD_POLICY_MESSAGE = '密码至少12位/);
  assert.match(server, /password\.length >= 12/);
  assert.match(server, /\/\[A-Za-z\]\//);
  assert.match(server, /\/\\d\//);
  assert.doesNotMatch(server, /密码至少6位|新密码至少6位/);
});

test('active first-party runtime sources contain no emoji icons', () => {
  const files = [
    new URL('server.js', root).pathname,
    new URL('database.js', root).pathname,
    ...sourceFiles('views/'),
    new URL('public/js/scanner.js', root).pathname
  ];
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  const failures = files.filter(file => emoji.test(readFileSync(file, 'utf8')));
  assert.deepEqual(failures, []);
});

test('monochrome SVG sprite and responsive UI contracts exist', () => {
  const icons = read('public/icons/ui.svg');
  const css = read('public/css/style.css');
  assert.match(icons, /<symbol id="camera"/);
  assert.match(icons, /<symbol id="box"/);
  assert.match(css, /\.ui-icon/);
  assert.match(css, /@media \(max-width: 768px\)/);
  assert.match(css, /overflow-x:auto/);
});
