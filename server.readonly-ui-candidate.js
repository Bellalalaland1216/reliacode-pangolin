const express = require('express');
const readOnlyAccess = require('./readonly-access.cjs');
const session = require('express-session');
const SQLiteSessionStore = require('./sqlite-session-store');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const multer = require('multer');
const crypto = require('crypto');
const sharp = require('sharp');
const { db, initDatabase, hashPassword, verifyPassword } = require('./database');
const { CHINA_REGIONS, normalizeRegionSelection } = require('./region-catalog');

const app = express();
const PORT = process.env.PORT || 3000;
let httpServer;
let shutdownStarted = false;

// 初始化数据库
initDatabase();

// 中间件
app.set('trust proxy', 1); // Nginx 反代：仅用于限流和不可逆来源标识。
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  const forwardedRequestId = String(req.get('x-request-id') || '');
  const requestId = /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/i.test(forwardedRequestId)
    ? forwardedRequestId
    : crypto.randomUUID();
  const cspNonce = crypto.randomBytes(18).toString('base64');
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.locals.cspNonce = cspNonce;
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' 'nonce-${cspNonce}'; script-src-attr 'none'; style-src 'self' 'nonce-${cspNonce}'; style-src-attr 'none'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  next();
});

const allowedHosts = new Set(
  String(process.env.ALLOWED_HOSTS || '127.0.0.1,localhost')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
);
const normalizedRequestHost = req => {
  try { return new URL(`http://${String(req.get('host') || '')}`).hostname.toLowerCase(); }
  catch { return ''; }
};
app.use((req, res, next) => {
  const hostname = normalizedRequestHost(req);
  if (hostname && allowedHosts.has(hostname)) return next();
  res.status(421).json({ success: false, code: 'UNRECOGNIZED_HOST', msg: '请求主机未获授权', requestId: req.requestId });
});

// Supervisor/load-balancer probes stay public, cheap and session-free.
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok' });
});

app.get('/readyz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    db.prepare('SELECT 1 AS ready').get();
    res.json({ status: 'ready' });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'readiness_failed', requestId: req.requestId, message: error.message }));
    res.status(503).json({ status: 'unavailable', requestId: req.requestId });
  }
});

app.get('/js/readonly-ui.js', (req,res) => res.sendFile("/root/traceability-system/backups/20260909-readonly-ui-k1xwqxfp/public/js/readonly-ui.js"));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: '1h',
  fallthrough: true,
  setHeaders: res => res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate')
}));

// ===================== 登录会话 =====================
const SESSION_SECRET = db.prepare("SELECT value FROM settings WHERE key='session_secret'").get()?.value;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error('session_secret is missing or too short');
const sessionStore = new SQLiteSessionStore(db, { defaultTtlMs: 12 * 60 * 60 * 1000 });
sessionStore.on('error', error => console.error('[SESSION] SQLite store error:', error));
app.use(session({
  name: process.env.NODE_ENV === 'production' ? '__Host-reliacode.sid' : 'reliacode.sid',
  secret: SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: 'auto',
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000 // 12小时免登录
  }
}));

// Refresh role/tenant scope from authoritative records, never the cached cookie snapshot.
app.use((req, res, next) => {
  if (!req.session.user) return next();
  const row = db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.enabled,u.brand_id,u.factory_id,u.distributor_id,
    b.enabled AS brand_enabled,b.name AS brand_name FROM users u LEFT JOIN brands b ON b.id=u.brand_id WHERE u.id=?`).get(req.session.user.id);
  if (!row || !row.enabled || (row.brand_id && !row.brand_enabled)) {
    return req.session.destroy(() => res.status(401).json({success:false,needLogin:true,msg:'登录状态已失效'}));
  }
  req.session.user = {...req.session.user,id:row.id,username:row.username,display_name:row.display_name,
    role:row.role,brand_id:row.brand_id,factory_id:row.factory_id,distributor_id:row.distributor_id,brand_name:row.brand_name};
  if (row.role === readOnlyAccess.ROLE && !readOnlyAccess.allowed(req.method,req.path)) {
    return res.status(403).json({success:false,code:'READ_ONLY_ACCOUNT',msg:'当前账号仅供只读体验，请使用独立管理员账号执行操作。'});
  }
  next();
});

const CSRF_EXEMPT_PATHS = new Set(['/login', '/api/register/check-code', '/api/register', '/api/agent/login']);
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || CSRF_EXEMPT_PATHS.has(req.path)) return next();
  // Bearer credentials are attached explicitly by an Agent and are not sent
  // automatically by a browser, so these requests do not need cookie-CSRF protection.
  if (req.path.startsWith('/api/agent/') && /^Bearer\s+rca_[A-Za-z0-9_-]{43}$/.test(String(req.get('authorization') || ''))) return next();
  const expectedOrigin = `${req.protocol}://${req.get('host')}`;
  const origin = req.get('origin');
  const fetchSite = req.get('sec-fetch-site');
  const agentHeader = req.get('x-reliacode-request');
  const browserSameOrigin = origin === expectedOrigin && (!fetchSite || fetchSite === 'same-origin');
  const explicitSameOriginClient = agentHeader === 'same-origin' && (!origin || origin === expectedOrigin);
  if (browserSameOrigin || explicitSameOriginClient) return next();
  return res.status(403).json({ success: false, code: 'CSRF_REJECTED', msg: '请求来源校验失败' });
});

const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
db.exec(`
  CREATE TABLE IF NOT EXISTS login_rate_limits (
    source_hash TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_rate_limits_reset_at ON login_rate_limits(reset_at);
`);
const readLoginLimit = db.prepare('SELECT attempt_count, reset_at FROM login_rate_limits WHERE source_hash=?');
const writeLoginLimit = db.prepare(`
  INSERT INTO login_rate_limits (source_hash, attempt_count, reset_at, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(source_hash) DO UPDATE SET attempt_count=excluded.attempt_count, reset_at=excluded.reset_at, updated_at=excluded.updated_at
`);
const deleteLoginLimit = db.prepare('DELETE FROM login_rate_limits WHERE source_hash=?');
const cleanupLoginLimits = db.prepare('DELETE FROM login_rate_limits WHERE reset_at<=?');
const loginSourceHash = req => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`ip:${String(req.ip || req.socket.remoteAddress || 'unknown')}`)
  .digest('hex');
const loginAccountHash = req => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`account:${String(req.body?.username || '').trim().toLowerCase() || 'unknown'}`)
  .digest('hex');
const recordLoginAttempt = db.transaction((sourceHash, now) => {
  cleanupLoginLimits.run(now);
  const current = readLoginLimit.get(sourceHash);
  const attemptCount = current && current.reset_at > now ? current.attempt_count + 1 : 1;
  const resetAt = current && current.reset_at > now ? current.reset_at : now + LOGIN_WINDOW_MS;
  writeLoginLimit.run(sourceHash, attemptCount, resetAt, now);
  return { attemptCount, resetAt };
});
function loginRateLimit(req, res, next) {
  const now = Date.now();
  const entries = [loginSourceHash(req), loginAccountHash(req)].map(key => recordLoginAttempt(key, now));
  const limited = entries.find(entry => entry.attemptCount > LOGIN_MAX_ATTEMPTS);
  if (limited) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limited.resetAt - now) / 1000))));
    return res.status(429).render('login', { brand: '穿山甲溯源大师', error: '登录尝试过多，请稍后再试' });
  }
  next();
}
const registrationSourceHash = req => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`register:${String(req.ip || req.socket.remoteAddress || 'unknown')}`)
  .digest('hex');
function registrationRateLimit(req, res, next) {
  const now = Date.now();
  const limit = recordLoginAttempt(registrationSourceHash(req), now);
  if (limit.attemptCount > 30) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - now) / 1000))));
    return res.status(429).json({ success: false, code: 'REGISTER_RATE_LIMITED', msg: '注册请求过于频繁，请稍后再试' });
  }
  next();
}

// ===================== Agent API authentication =====================
const AGENT_TOKEN_TTL_MS = 60 * 60 * 1000;
const AGENT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT UNIQUE NOT NULL,
    client_name TEXT NOT NULL DEFAULT 'agent',
    scope TEXT NOT NULL DEFAULT 'codes:generate',
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_id, expires_at);
  CREATE TABLE IF NOT EXISTS agent_idempotency (
    user_id INTEGER NOT NULL,
    route TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_json TEXT,
    status_code INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, route, idempotency_key),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_idempotency_expiry ON agent_idempotency(expires_at);
`);
const agentTokenHash = token => crypto.createHmac('sha256', SESSION_SECRET).update(`agent-token:${token}`).digest('hex');
const agentRequestHash = req => crypto.createHash('sha256')
  .update(`${req.path}\n${JSON.stringify(req.body || {})}`).digest('hex');
const readAgentToken = db.prepare(`
  SELECT t.id AS token_id, t.user_id, t.scope, t.expires_at,
    u.username, u.display_name, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled,
    b.name AS brand_name, b.enabled AS brand_enabled
  FROM agent_tokens t
  JOIN users u ON u.id=t.user_id
  LEFT JOIN brands b ON b.id=u.brand_id
  WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?
`);
const touchAgentToken = db.prepare('UPDATE agent_tokens SET last_used_at=? WHERE id=?');
function requireAgentToken(req, res, next) {
  const match = String(req.get('authorization') || '').match(/^Bearer\s+(rca_[A-Za-z0-9_-]{43})$/);
  if (!match) return res.status(401).json({ success: false, code: 'AGENT_AUTH_REQUIRED', msg: '需要 Agent Bearer 令牌', requestId: req.requestId });
  const now = Date.now();
  const record = readAgentToken.get(agentTokenHash(match[1]), now);
  if (!record || !record.enabled || (record.brand_id && !record.brand_enabled)) {
    return res.status(401).json({ success: false, code: 'AGENT_TOKEN_INVALID', msg: 'Agent 令牌无效、已过期或账号已停用', requestId: req.requestId });
  }
  if (record.role === readOnlyAccess.ROLE) return res.status(403).json({success:false,code:'READ_ONLY_ACCOUNT',msg:'只读体验账号不能使用 Agent 令牌'});
  req.agentTokenId = record.token_id;
  req.agentUser = {
    id: record.user_id,
    username: record.username,
    display_name: record.display_name || record.username,
    role: record.role,
    distributor_id: record.distributor_id || null,
    factory_id: record.factory_id || null,
    brand_id: record.brand_id || null,
    brand_name: record.brand_name || null
  };
  touchAgentToken.run(now, record.token_id);
  next();
}
function requireAgentRole(...roles) {
  return (req, res, next) => {
    if (!req.agentUser) return res.status(401).json({ success: false, code: 'AGENT_AUTH_REQUIRED', msg: '需要 Agent Bearer 令牌', requestId: req.requestId });
    if (!roles.includes(req.agentUser.role)) return res.status(403).json({ success: false, code: 'AGENT_ROLE_FORBIDDEN', msg: '该账号没有生码权限', requestId: req.requestId });
    next();
  };
}
function requireAgentIdempotency(req, res, next) {
  const key = String(req.get('idempotency-key') || '').trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    return res.status(400).json({ success: false, code: 'IDEMPOTENCY_KEY_REQUIRED', msg: '需要 8-128 位 Idempotency-Key', requestId: req.requestId });
  }
  const now = Date.now();
  db.prepare('DELETE FROM agent_idempotency WHERE expires_at<=?').run(now);
  const route = req.path;
  const requestHash = agentRequestHash(req);
  const read = db.prepare('SELECT request_hash, response_json, status_code FROM agent_idempotency WHERE user_id=? AND route=? AND idempotency_key=?');
  const existing = read.get(req.agentUser.id, route, key);
  if (existing) {
    if (existing.request_hash !== requestHash) return res.status(409).json({ success: false, code: 'IDEMPOTENCY_CONFLICT', msg: '同一幂等键不能用于不同请求', requestId: req.requestId });
    if (existing.response_json) {
      res.setHeader('Idempotency-Replayed', 'true');
      return res.status(existing.status_code || 200).json(JSON.parse(existing.response_json));
    }
    return res.status(409).json({ success: false, code: 'IDEMPOTENCY_IN_PROGRESS', msg: '相同请求正在处理中', requestId: req.requestId });
  }
  db.prepare(`INSERT INTO agent_idempotency (user_id, route, idempotency_key, request_hash, created_at, expires_at)
    VALUES (?,?,?,?,?,?)`).run(req.agentUser.id, route, key, requestHash, now, now + AGENT_IDEMPOTENCY_TTL_MS);
  const originalJson = res.json.bind(res);
  let persisted = false;
  res.json = body => {
    const statusCode = res.statusCode || 200;
    db.prepare(`UPDATE agent_idempotency SET response_json=?, status_code=?
      WHERE user_id=? AND route=? AND idempotency_key=?`).run(JSON.stringify(body), statusCode, req.agentUser.id, route, key);
    persisted = true;
    return originalJson(body);
  };
  res.on('finish', () => {
    if (!persisted) db.prepare('DELETE FROM agent_idempotency WHERE user_id=? AND route=? AND idempotency_key=?').run(req.agentUser.id, route, key);
  });
  next();
}

const AGENT_READ_API_PATHS = [
  /^\/products$/,
  /^\/products\/\d+\/content$/,
  /^\/batches\/\d+\/trace$/,
  /^\/codes$/,
  /^\/codes\/unbound$/,
  /^\/codes\/box\/[^/]+$/,
  /^\/operation_logs$/,
  /^\/distributors$/,
  /^\/shipments$/,
  /^\/alerts$/,
  /^\/users$/,
  /^\/factories$/,
  /^\/stats$/,
  /^\/invitations$/,
  /^\/brands$/,
  /^\/campaigns$/,
  /^\/prizes$/
];
const currentUser = req => req.agentUser || req.session.user || null;

// Explicit read-only bridge to existing domain APIs. This expands what an
// Agent can inspect without silently granting destructive browser actions.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' || !AGENT_READ_API_PATHS.some(pattern => pattern.test(req.path))) return next();
  if (!String(req.get('authorization') || '').startsWith('Bearer ')) return next();
  return requireAgentToken(req, res, next);
});

// 所有视图可用的公共变量：当前用户、未处理预警数
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.alertsUnread = 0;
  res.locals.brand = '穿山甲溯源大师';
  res.locals.icon = (name, className = '') => {
    const allowed = new Set(['tag','home','grid','alert','user','box','camera','download','print','trash','lock','clipboard','bell','settings','truck','handshake','location','refresh','check','search','gift','ticket','database','video','cart','chevron-right','chevron-left','arrow-right','arrow-left','plus','xmark']);
    const safeName = allowed.has(name) ? name : 'grid';
    const safeClass = String(className).replace(/[^a-zA-Z0-9 _-]/g, '');
    return `<svg class="ui-icon ${safeClass}" aria-hidden="true"><use href="/icons/ui.svg#${safeName}"></use></svg>`;
  };
  if (req.session.user) {
    try {
      const scope = brandScope(req);
      if (scope === null) {
        res.locals.alertsUnread = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0').get().c;
      } else if (scope) {
        res.locals.alertsUnread = db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0 AND brand_id=?').get(scope).c;
      }
    } catch (e) {}
  }
  // 品牌名（顶栏 logo 文字，所有页面统一显示）
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('brand_name');
    if (row && row.value) res.locals.brand = row.value;
  } catch (e) {}
  next();
});

// ===================== 全局禁用浏览器缓存（强制刷新 iOS 风格新版） =====================
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// ===================== 认证守卫 =====================
// 页面守卫：未登录跳登录页；API 守卫：返回 401
function requireLogin(req, res, next) {
  if (currentUser(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, msg: '请先登录', needLogin: true });
  return res.redirect('/login');
}
// 角色守卫：requireRole('admin') / requireRole('admin','warehouse')
function requireRole(...roles) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) {
      if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, msg: '请先登录', needLogin: true });
      return res.redirect('/login');
    }
    if (!readOnlyAccess.roleAllowed(roles, user.role, req.method)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ success: false, msg: '没有权限执行此操作' });
      return res.status(403).send('没有权限访问该页面，<a href="/">返回首页</a>');
    }
    next();
  };
}
// 401 时前端跳登录页（供 fetch 全局处理）
const ROLE_NAMES = { AUDIT_VIEWER: '只读体验账号', admin: '平台管理员', brand: '品牌管理员', brand_staff: '品牌方工作账号', factory: '工厂装箱', warehouse: '品牌方', distributor: '代理商' };
const PASSWORD_POLICY_MESSAGE = '密码至少12位，包含大小写字母、数字和符号';
function passwordMeetsPolicy(value) {
  const password = String(value || '');
  return password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9\s]/.test(password);
}

// ===================== 品牌数据隔离（SaaS 多租户） =====================
// brandScope(req)：返回 null 表示平台管理员（不限制，看全部品牌）；
// 返回数字表示该账号归属的品牌（所有查询只看该品牌数据）
function brandScope(req) {
  const u = req.agentUser || req.session.user;
  if (!u) return undefined;
  if (u.role === 'admin' || u.role === readOnlyAccess.ROLE) return null;
  const brandId = Number(u.brand_id);
  return Number.isInteger(brandId) && brandId > 0 ? brandId : 0;
}
// 校验某个 brand_id 是否在当前账号的数据范围内
function brandAllowed(scope, brand_id) {
  return scope === null || Number(brand_id) === Number(scope);
}
app.set('view engine', 'ejs');
app.set('views', "/root/traceability-system/backups/20260909-readonly-ui-k1xwqxfp/views");

// async 路由包装器：捕获 Promise 拒绝，交给全局错误中间件，避免请求挂死
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const scanSourceId = value => crypto.createHmac('sha256', SESSION_SECRET)
  .update(`scan:${String(value || 'unknown')}`).digest('hex').slice(0, 20);
const displayScanSource = value => /^[a-f0-9]{20}$/i.test(String(value || '')) ? String(value) : (value ? '历史记录已隐藏' : '');

// ===================== 登录 / 登出 =====================

app.get('/.well-known/reliacode-agent.json', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    service: 'ReliaCode Agent API',
    version: '1.2',
    authentication: {
      type: 'password_exchange',
      endpoint: '/api/agent/login',
      token_type: 'Bearer',
      token_ttl_seconds: AGENT_TOKEN_TTL_MS / 1000
    },
    endpoints: {
      discovery: '/.well-known/reliacode-agent.json',
      login: '/api/agent/login',
      current_identity: '/api/agent/me',
      capabilities: '/api/agent/capabilities',
      generate_boxes: '/api/agent/codes/boxes',
      generate_items: '/api/agent/codes/items',
      product_media: '/api/agent/products/:id/media',
      product_trace_template: '/api/agent/products/:id/trace-template',
      product_batches: '/api/agent/products/:id/batches',
      batch_trace: '/api/agent/batches/:batchId/trace',
      product_marketing: '/api/agent/products/:id/marketing',
      logout: '/api/agent/logout'
    },
    requirements: {
      content_type: 'application/json',
      mutation_header: 'Idempotency-Key',
      allowed_roles: ['admin', 'brand', 'brand_staff'],
      authorization: 'Every endpoint retains the account role and tenant boundary'
    },
    inspection: {
      products: 'GET /api/products',
      codes: 'GET /api/codes',
      unbound_codes: 'GET /api/codes/unbound',
      box_contents: 'GET /api/codes/box/:code',
      shipments: 'GET /api/shipments',
      alerts: 'GET /api/alerts',
      operation_logs: 'GET /api/operation_logs',
      distributors: 'GET /api/distributors',
      users: 'GET /api/users',
      factories: 'GET /api/factories',
      stats: 'GET /api/stats'
    }
  });
});

app.get('/api/agent/capabilities', requireAgentToken, (req, res) => {
  const role = req.agentUser.role;
  const can = roles => roles.includes(role);
  const reads = [
    can(['admin', 'factory', 'brand', 'brand_staff']) && 'GET /api/products',
    can(['admin', 'factory', 'brand', 'brand_staff']) && 'GET /api/products/:id/content',
    can(['admin', 'factory', 'brand', 'brand_staff']) && 'GET /api/batches/:batchId/trace',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/codes',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/codes/unbound',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/codes/box/:code',
    can(['admin', 'warehouse', 'brand']) && 'GET /api/shipments',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/alerts',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/operation_logs',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/distributors',
    can(['admin', 'brand']) && 'GET /api/users',
    can(['admin', 'brand']) && 'GET /api/factories',
    can(['admin', 'brand', 'brand_staff']) && 'GET /api/stats'
  ].filter(Boolean);
  const mutations = [
    can(['admin', 'brand_staff']) && 'POST /api/agent/codes/items',
    can(['admin', 'brand_staff']) && 'POST /api/agent/codes/boxes',
    can(['admin', 'brand', 'brand_staff']) && 'PUT /api/agent/products/:id/media',
    can(['admin', 'brand', 'brand_staff']) && 'PUT /api/agent/products/:id/trace-template',
    can(['admin', 'brand', 'brand_staff']) && 'POST /api/agent/products/:id/batches',
    can(['admin', 'brand', 'brand_staff']) && 'POST /api/agent/batches/:batchId/trace',
    can(['admin', 'brand', 'brand_staff']) && 'PUT /api/agent/products/:id/marketing'
  ].filter(Boolean);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, role, reads, mutations, mutation_header: 'Idempotency-Key' });
});

function agentLoginRateLimit(req, res, next) {
  const now = Date.now();
  const entries = [loginSourceHash(req), loginAccountHash(req)].map(key => recordLoginAttempt(key, now));
  const limited = entries.find(entry => entry.attemptCount > LOGIN_MAX_ATTEMPTS);
  if (!limited) return next();
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limited.resetAt - now) / 1000))));
  return res.status(429).json({ success: false, code: 'AGENT_LOGIN_RATE_LIMITED', msg: '登录尝试过多，请稍后再试', requestId: req.requestId });
}

app.post('/api/agent/login', agentLoginRateLimit, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const clientName = String(req.body.client_name || 'agent').trim().slice(0, 80) || 'agent';
  const user = username ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ success: false, code: 'AGENT_LOGIN_FAILED', msg: '账号或密码错误', requestId: req.requestId });
  }
  if (!['admin', 'brand', 'brand_staff'].includes(user.role)) {
    return res.status(403).json({ success: false, code: 'AGENT_ROLE_FORBIDDEN', msg: '该账号没有生码权限', requestId: req.requestId });
  }
  let brandInfo = null;
  if (user.brand_id) {
    brandInfo = db.prepare('SELECT id, name, enabled FROM brands WHERE id=?').get(user.brand_id);
    if (!brandInfo || !brandInfo.enabled) return res.status(403).json({ success: false, code: 'AGENT_TENANT_DISABLED', msg: '所属品牌不存在或已停用', requestId: req.requestId });
  }
  if (['brand', 'brand_staff'].includes(user.role) && !brandInfo) {
    return res.status(403).json({ success: false, code: 'AGENT_TENANT_REQUIRED', msg: '该账号未绑定品牌', requestId: req.requestId });
  }
  const now = Date.now();
  db.prepare('DELETE FROM agent_tokens WHERE expires_at<=? OR revoked_at IS NOT NULL').run(now);
  const token = `rca_${crypto.randomBytes(32).toString('base64url')}`;
  const result = db.prepare(`INSERT INTO agent_tokens (user_id, token_hash, client_name, scope, created_at, expires_at)
    VALUES (?,?,?,?,?,?)`).run(user.id, agentTokenHash(token), clientName, 'codes:generate', now, now + AGENT_TOKEN_TTL_MS);
  req.agentUser = {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    role: user.role,
    brand_id: user.brand_id || null,
    brand_name: brandInfo ? brandInfo.name : null
  };
  req.agentTokenId = Number(result.lastInsertRowid);
  deleteLoginLimit.run(loginSourceHash(req));
  deleteLoginLimit.run(loginAccountHash(req));
  logOperation(req, 'agent_login', 'agent_token', req.agentTokenId, `Agent 客户端「${clientName}」取得短期生码令牌`);
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    success: true,
    access_token: token,
    token_type: 'Bearer',
    expires_in: AGENT_TOKEN_TTL_MS / 1000,
    scope: 'codes:generate',
    user: { username: user.username, role: user.role, brand_id: user.brand_id || null, brand_name: brandInfo ? brandInfo.name : null }
  });
});

app.get('/api/agent/me', requireAgentToken, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, user: req.agentUser, scope: 'codes:generate' });
});

app.post('/api/agent/logout', requireAgentToken, (req, res) => {
  db.prepare('UPDATE agent_tokens SET revoked_at=? WHERE id=?').run(Date.now(), req.agentTokenId);
  logOperation(req, 'agent_logout', 'agent_token', req.agentTokenId, 'Agent 短期令牌已撤销');
  res.json({ success: true });
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const brand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '穿山甲溯源大师';
  res.render('login', { brand, error: '' });
});

app.post('/login', loginRateLimit, (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const rememberLogin = req.body.remember === '1';
  if (!username || !password) {
    return res.status(401).render('login', { brand: '穿山甲溯源大师', error: '请输入账号和密码' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).render('login', { brand: '穿山甲溯源大师', error: '账号或密码错误' });
  }
  // 代理商账号：绑定代理商信息快照
  let distributor = null;
  if (user.role === 'distributor') {
    distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(user.distributor_id);
    if (!distributor) return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该账号未绑定代理商，请联系管理员' });
  }
  // 工厂账号：绑定工厂信息快照
  let factory = null;
  if (user.role === 'factory') {
    factory = db.prepare('SELECT * FROM factories WHERE id=?').get(user.factory_id);
    if (!factory) return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该账号未绑定工厂，请联系管理员' });
  }
  // 品牌信息快照（brand/warehouse/factory/distributor 均按品牌隔离）
  let brandInfo = null;
  if (user.brand_id) {
    brandInfo = db.prepare('SELECT * FROM brands WHERE id=?').get(user.brand_id);
    if (brandInfo && !brandInfo.enabled) {
      return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该品牌已被停用，请联系平台管理员' });
    }
  }
  if (['brand', 'brand_staff'].includes(user.role) && !brandInfo) {
    return res.status(403).render('login', { brand: '穿山甲溯源大师', error: '该账号未绑定品牌，请联系平台管理员' });
  }
  db.prepare(`UPDATE users SET last_login_at=datetime('now','localtime') WHERE id=?`).run(user.id);
  const sessionUser = {
    id: user.id,
    username: user.username,
    display_name: user.display_name || user.username,
    role: user.role,
    distributor_id: user.distributor_id || null,
    distributor_name: distributor ? distributor.name : null,
    factory_id: user.factory_id || null,
    factory_name: factory ? factory.name : null,
    brand_id: user.brand_id || null,
    brand_name: brandInfo ? brandInfo.name : null
  };
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = sessionUser;
    req.session.cookie.maxAge = rememberLogin ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    deleteLoginLimit.run(loginSourceHash(req));
    deleteLoginLimit.run(loginAccountHash(req));
    const home = user.role === 'distributor' ? '/portal' : '/';
    res.redirect(home);
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});
app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect(303, '/login'));
});
app.get('/logout', (req, res) => {
  res.setHeader('Allow', 'POST');
  res.redirect(303, req.session.user ? '/' : '/login');
});

// ===================== 邀请码自助注册 =====================

// 注册页（公开，凭邀请码注册工厂/代理商账号）
app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const brand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '穿山甲溯源大师';
  res.render('register', { brand, code: String(req.query.code || ''), error: '' });
});

// 邀请码校验（注册页输入邀请码后回显角色）
app.post('/api/register/check-code', registrationRateLimit, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const inv = db.prepare('SELECT * FROM invitations WHERE code=?').get(code);
  if (!inv || inv.status !== 0) return res.status(409).json({ success: false, code: 'INVITATION_ALREADY_USED', msg: '邀请码无效或已被使用' });
  let factory_name = null;
  if (inv.role === 'factory' && inv.factory_id) {
    factory_name = db.prepare('SELECT name FROM factories WHERE id=?').get(inv.factory_id)?.name || null;
  }
  res.json({ success: true, role: inv.role, note: inv.note, factory_name });
});

// 凭邀请码注册
app.post('/api/register', registrationRateLimit, (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const company = String(req.body.company || '').trim();
  const contact = String(req.body.contact || '').trim();

  const inv = db.prepare('SELECT * FROM invitations WHERE code=?').get(code);
  if (!inv || inv.status !== 0) return res.status(409).json({ success: false, code: 'INVITATION_ALREADY_USED', msg: '邀请码无效或已被使用' });
  const selectedRegion = inv.role === 'distributor'
    ? normalizeRegionSelection(req.body.country, req.body.province, req.body.city)
    : null;
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.json({ success: false, msg: '账号需为3-20位字母/数字/下划线' });
  if (!passwordMeetsPolicy(password)) return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
  // 工厂角色：工厂由邀请码固定，无需自填工厂名；其他角色（代理商/品牌）仍需 company
  if (!company && inv.role !== 'factory') return res.json({ success: false, msg: '请填写公司/工厂名称' });
  const phone = String(req.body.phone || '').trim();
  if (inv.role === 'factory') {
    // 工厂注册：联系人（人名）+ 11位手机号 必填；工厂由邀请码固定，无需填工厂名
    if (!contact) return res.json({ success: false, msg: '请填写联系人姓名' });
    if (!/^1\d{10}$/.test(phone)) return res.json({ success: false, msg: '请填写正确的11位手机号' });
  }
  if (inv.role === 'distributor' && !selectedRegion) return res.status(400).json({ success: false, code: 'INVALID_REGION_SELECTION', msg: '请选择有效的国家、省和市' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) {
    return res.json({ success: false, msg: '该账号已被占用，请换一个' });
  }

  const register = db.transaction(() => {
    const claim = db.prepare(`UPDATE invitations SET status=1, used_by=?, used_at=datetime('now','localtime') WHERE id=? AND status=0`)
      .run(username, inv.id);
    if (claim.changes !== 1) throw new Error('INVITATION_ALREADY_USED');
    if (inv.role === 'factory') {
      // 工厂注册：绑定邀请码指定的已建档工厂（固定项）；人名存 display_name，手机号存 phone
      if (!inv.factory_id) throw new Error('INVITATION_FACTORY_INVALID');
      const fac = db.prepare('SELECT * FROM factories WHERE id=?').get(inv.factory_id);
      if (!fac) throw new Error('INVITATION_FACTORY_INVALID');
      db.prepare('INSERT INTO users (username, password_hash, display_name, phone, role, factory_id, brand_id) VALUES (?,?,?,?,?,?,?)')
        .run(username, hashPassword(password), contact, phone, 'factory', inv.factory_id, inv.brand_id || null);
    } else if (inv.role === 'distributor') {
      // 代理商注册：创建代理商实体并绑定账号（归属邀请码对应品牌）
      const d = db.prepare('INSERT INTO distributors (name, phone, region, brand_id, country, province, city) VALUES (?,?,?,?,?,?,?)')
        .run(company, phone || contact, selectedRegion.region, inv.brand_id || null, selectedRegion.country, selectedRegion.province, selectedRegion.city);
      db.prepare('INSERT INTO users (username, password_hash, display_name, role, distributor_id, brand_id) VALUES (?,?,?,?,?,?)')
        .run(username, hashPassword(password), company, 'distributor', d.lastInsertRowid, inv.brand_id || null);
    } else if (inv.role === 'brand') {
      if (!inv.brand_id || !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(inv.brand_id)) {
        throw new Error('INVITATION_BRAND_INVALID');
      }
      db.prepare('INSERT INTO users (username, password_hash, display_name, role, brand_id) VALUES (?,?,?,?,?)')
        .run(username, hashPassword(password), company, 'brand', inv.brand_id);
    } else {
      throw new Error('INVITATION_ROLE_INVALID');
    }
  });
  try {
    register();
    deleteLoginLimit.run(registrationSourceHash(req));
    res.json({ success: true, msg: '注册成功，请使用新账号登录', username });
  } catch (e) {
    if (e.message === 'INVITATION_ALREADY_USED') return res.status(409).json({ success: false, code: 'INVITATION_ALREADY_USED', msg: '邀请码无效或已被使用' });
    if (e.message === 'INVITATION_BRAND_INVALID' || e.message === 'INVITATION_ROLE_INVALID' || e.message === 'INVITATION_FACTORY_INVALID') return res.status(409).json({ success: false, code: e.message, msg: '邀请码工厂配置无效，请联系平台管理员' });
    if (String(e.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ success: false, code: 'REGISTRATION_CONFLICT', msg: '账号或企业信息已存在' });
    console.error(JSON.stringify({ level: 'error', event: 'registration_failed', requestId: req.requestId, message: e.message }));
    res.status(500).json({ success: false, code: 'REGISTRATION_FAILED', msg: '注册失败，请稍后重试', requestId: req.requestId });
  }
});

// 邀请码列表（admin/brand；brand 只看自己品牌的邀请码）
app.get('/api/invitations', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const invitations = scope === null
    ? db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        ORDER BY i.id DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        WHERE i.brand_id=? ORDER BY i.id DESC LIMIT 200
      `).all(scope);
  res.json({ success: true, invitations });
});

// 生成邀请码（admin 可指定品牌；brand 只能生成自己品牌的工厂/代理商邀请码）
app.post('/api/invitations', requireRole('admin', 'brand'), (req, res) => {
  const role = req.body.role;
  const note = String(req.body.note || '').trim();
  const scope = brandScope(req);
  if (!['factory', 'distributor', 'brand'].includes(role)) return res.json({ success: false, msg: '角色不合法' });
  if (role === 'brand' && scope !== null) return res.status(403).json({ success: false, msg: '只有平台管理员可以生成品牌管理员邀请码' });
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (role === 'brand' && !brand_id) return res.status(400).json({ success: false, msg: '品牌管理员邀请码必须指定归属品牌' });
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  // 工厂注册码必须绑定已建档工厂（固定项，防止装箱人员乱填工厂名）
  let factory_id = null;
  if (role === 'factory') {
    factory_id = parseInt(req.body.factory_id) || null;
    if (!factory_id) return res.json({ success: false, msg: '工厂注册码必须选择归属工厂（请先在工厂管理建档）' });
    const fac = db.prepare('SELECT * FROM factories WHERE id=?').get(factory_id);
    if (!fac) return res.json({ success: false, msg: '所选工厂不存在，请刷新后重试' });
    if (!brandAllowed(scope, fac.brand_id)) return res.json({ success: false, msg: '所选工厂不在你的品牌范围内' });
  }

  let code;
  do {
    code = 'INV' + crypto.randomBytes(12).toString('hex').toUpperCase();
  } while (db.prepare('SELECT 1 FROM invitations WHERE code=?').get(code));
  db.prepare('INSERT INTO invitations (code, role, note, brand_id, factory_id) VALUES (?,?,?,?,?)').run(code, role, note, brand_id, factory_id);
  const invitationRoleName = role === 'factory' ? '工厂' : (role === 'distributor' ? '代理商' : '品牌管理员');
  logOperation(req, 'create_invitation', 'invitation', code, `生成${invitationRoleName}邀请码「${code}」${brand_id ? '（品牌：' + (db.prepare('SELECT name FROM brands WHERE id=?').get(brand_id)?.name || '') + '）' : ''}`);
  res.json({ success: true, code, msg: '邀请码已生成' });
});

// 作废/删除邀请码（admin/brand；brand 只能操作自己品牌的邀请码）
app.delete('/api/invitations/:id', requireRole('admin', 'brand'), (req, res) => {
  const inv = db.prepare('SELECT * FROM invitations WHERE id=?').get(req.params.id);
  if (!inv) return res.json({ success: false, msg: '邀请码不存在' });
  if (!brandAllowed(brandScope(req), inv.brand_id)) return res.json({ success: false, msg: '没有权限操作该邀请码' });
  const roleText = inv.role === 'factory' ? '工厂' : '代理商';
  if (req.query.hard === '1') {
    db.prepare('DELETE FROM invitations WHERE id=?').run(inv.id);
    logOperation(req, 'delete_invitation', 'invitation', inv.code, `邀请码「${inv.code}」（${roleText}）记录已删除` + (inv.used_by ? `，已注册账号 ${inv.used_by} 不受影响` : ''));
    return res.json({ success: true, msg: '邀请码记录已删除' });
  }
  if (inv.status === 1) return res.json({ success: false, msg: '该邀请码已被使用，不能作废；如不需要可删除记录' });
  db.prepare('UPDATE invitations SET status=2 WHERE id=?').run(inv.id);
  logOperation(req, 'revoke_invitation', 'invitation', inv.code, `邀请码「${inv.code}」（${roleText}）已作废`);
  res.json({ success: true, msg: '已作废' });
});

// ===================== 品牌管理（平台管理员） =====================

// 品牌列表（含各品牌数据量统计）
app.get('/api/brands', requireRole('admin'), (req, res) => {
  const brands = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM products p WHERE p.brand_id=b.id) as product_count,
      (SELECT COUNT(*) FROM factories f WHERE f.brand_id=b.id) as factory_count,
      (SELECT COUNT(*) FROM distributors d WHERE d.brand_id=b.id) as distributor_count,
      (SELECT COUNT(*) FROM users u WHERE u.brand_id=b.id) as user_count
    FROM brands b ORDER BY b.id
  `).all();
  res.json({ success: true, brands });
});

// 新建品牌
app.post('/api/brands', requireRole('admin'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact || '').trim();
  if (!name) return res.json({ success: false, msg: '品牌名称不能为空' });
  if (db.prepare('SELECT 1 FROM brands WHERE name=?').get(name)) return res.json({ success: false, msg: '品牌名称已存在' });
  const r = db.prepare('INSERT INTO brands (name, contact) VALUES (?,?)').run(name, contact);
  logOperation(req, 'create_brand', 'brand', r.lastInsertRowid, `品牌「${name}」已创建`);
  res.json({ success: true, id: r.lastInsertRowid, msg: '品牌已创建' });
});

// 修改品牌（改名/联系人/启停）
app.put('/api/brands/:id', requireRole('admin'), (req, res) => {
  const b = db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id);
  if (!b) return res.json({ success: false, msg: '品牌不存在' });
  const { name, contact, enabled } = req.body;
  if (name !== undefined && String(name).trim()) db.prepare('UPDATE brands SET name=? WHERE id=?').run(String(name).trim(), b.id);
  if (contact !== undefined) db.prepare('UPDATE brands SET contact=? WHERE id=?').run(String(contact).trim(), b.id);
  if (enabled !== undefined) {
    db.prepare('UPDATE brands SET enabled=? WHERE id=?').run(enabled ? 1 : 0, b.id);
    logOperation(req, 'toggle_brand', 'brand', b.id, `品牌「${b.name}」已${enabled ? '启用' : '停用'}`);
  }
  res.json({ success: true, msg: '品牌已更新' });
});

// 删除空品牌。存在任何业务、账号或审计数据时必须停用，禁止级联抹除历史。
app.delete('/api/brands/:id', requireRole('admin'), (req, res) => {
  const brand = db.prepare('SELECT * FROM brands WHERE id=?').get(req.params.id);
  if (!brand) return res.status(404).json({ success: false, msg: '品牌不存在' });
  const dependentTables = [
    'users', 'factories', 'products', 'distributors', 'invitations', 'boxes', 'items',
    'scan_logs', 'alerts', 'operation_logs', 'product_media', 'product_trace_templates',
    'product_batches', 'batch_trace_entries', 'product_marketing', 'code_packages'
  ];
  const dependency = dependentTables.find(table => db.prepare(`SELECT 1 FROM ${table} WHERE brand_id=? LIMIT 1`).get(brand.id));
  if (dependency) return res.status(409).json({ success: false, code: 'BRAND_NOT_EMPTY', msg: '该品牌已有账号或业务历史，不能删除；请改为停用' });
  db.prepare('DELETE FROM brands WHERE id=?').run(brand.id);
  logOperation(req, 'delete_brand', 'brand', brand.id, `空品牌「${brand.name}」已删除`);
  res.json({ success: true, msg: '品牌已删除' });
});

// ===================== 页面路由 =====================

// 管理后台首页（按角色分流：工厂→装箱页，仓库→发货页，代理商→自助端；品牌管理员→品牌版首页）
app.get('/', requireLogin, (req, res) => {
  const role = req.session.user.role;
  if (role === 'factory') return res.redirect('/factory');
  if (role === 'warehouse') return res.redirect('/warehouse');
  if (role === 'distributor') return res.redirect('/portal');
  // admin 看全局，brand 只看自己品牌
  const scope = brandScope(req);
  const bp = scope === null ? '' : ' AND p.brand_id=?';
  const bcond = scope === null ? '' : ' AND b.brand_id=?';
  const bparam = scope === null ? [] : [scope];
  const pparam = scope === null ? [] : [scope];
  const p2param = scope === null ? [] : [scope];
  const stats = {
    products: db.prepare(`SELECT COUNT(*) as c FROM products p WHERE 1=1 ${bp}`).get(...pparam).c,
    boxes: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE 1=1 ${bp}`).get(...pparam).c,
    items: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE 1=1 ${bp}`).get(...pparam).c,
    distributors: db.prepare(`SELECT COUNT(*) as c FROM distributors WHERE 1=1 ${scope === null ? '' : ' AND brand_id=?'}`).get(...bparam).c,
    shipped: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='shipped' ${bp}`).get(...pparam).c,
    scanned: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.status='scanned' ${bp}`).get(...pparam).c,
    inStockBoxes: db.prepare(`SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='in_stock' ${bp}`).get(...pparam).c,
    inStockItems: db.prepare(`SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.status='in_stock' ${bp}`).get(...pparam).c,
    diversions: db.prepare(`SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 ${scope === null ? '' : ' AND brand_id=?'}`).get(...bparam).c,
  };
  const recentScans = scope === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 10').all()
    : db.prepare('SELECT * FROM scan_logs WHERE brand_id=? ORDER BY scanned_at DESC LIMIT 10').all(scope);
  // 扫码地区排行榜（仪表盘看板）：按扫码位置统计次数
  const scanRegions = scope === null
    ? db.prepare("SELECT COALESCE(NULLIF(scan_location,''),'未知') as region, COUNT(*) as count FROM scan_logs GROUP BY region ORDER BY count DESC LIMIT 12").all()
    : db.prepare("SELECT COALESCE(NULLIF(scan_location,''),'未知') as region, COUNT(*) as count FROM scan_logs WHERE brand_id=? GROUP BY region ORDER BY count DESC LIMIT 12").all(scope);
  const totalScans = scope === null
    ? db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c
    : db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE brand_id=?').get(scope).c;
  // 仓库手机入口 + 工厂手机入口（工人手机扫码直接打开）
  const baseUrl = getBaseUrl(req);
  const entryUrl = `${baseUrl}/warehouse`;
  const factoryUrl = `${baseUrl}/factory`;
  res.render('admin', { stats, recentScans, scanRegions, totalScans, entryUrl, factoryUrl });
});

// 业务导航页（admin/brand 专用 - 移动端底部「业务」Tab 入口）
app.get('/admin/business', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('admin-business');
});

// 我的导航页（admin/brand 专用 - 移动端底部「我的」Tab 入口）
app.get('/admin/me', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('admin-me');
});

// 码生成页面（brand 只看自己品牌的产品和工厂）
app.get('/generate', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const products = scope === null
    ? db.prepare(`
        SELECT p.*, f.name as factory_name, b.name as brand_name FROM products p
        LEFT JOIN factories f ON p.factory_id = f.id
        LEFT JOIN brands b ON p.brand_id = b.id
        ORDER BY p.id DESC
      `).all()
    : db.prepare(`
        SELECT p.*, f.name as factory_name, b.name as brand_name FROM products p
        LEFT JOIN factories f ON p.factory_id = f.id
        LEFT JOIN brands b ON p.brand_id = b.id
        WHERE p.brand_id = ?
        ORDER BY p.id DESC
      `).all(scope);
  const factories = scope === null
    ? db.prepare('SELECT id, name, brand_id FROM factories ORDER BY id DESC').all()
    : db.prepare('SELECT id, name, brand_id FROM factories WHERE brand_id=? ORDER BY id DESC').all(scope);
  const brands = scope === null
    ? db.prepare('SELECT id, name FROM brands WHERE enabled=1 ORDER BY id').all()
    : [];
  res.render('generate', { products, factories, brands });
});

// 仓库发货扫码页面（brand 发货时只能选自己品牌的代理商）
app.get('/warehouse', requireRole('admin', 'warehouse', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const distributors = scope === null
    ? db.prepare('SELECT * FROM distributors ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM distributors WHERE brand_id=? ORDER BY id DESC').all(scope);
  res.render('warehouse', { distributors });
});

// 工厂装箱扫码页面（数据隔离：工厂只见自己工厂的产品；品牌管理员见本品牌全部产品）
app.get('/factory', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  const role = req.session.user.role;
  if (role === 'factory' && req.session.user.factory_id) {
    sql += ' AND factory_id=?';
    params.push(req.session.user.factory_id);
  } else if (role === 'brand' && req.session.user.brand_id) {
    sql += ' AND brand_id=?';
    params.push(req.session.user.brand_id);
  }
  sql += ' ORDER BY id DESC';
  const products = db.prepare(sql).all(...params);
  res.render('factory', { products });
});

// 代理商管理页面（brand 只看自己品牌；admin 建代理商时可选归属品牌）
app.get('/distributors', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const distributors = scope === null
    ? db.prepare('SELECT d.*, b.name as brand_name FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id ORDER BY d.id DESC').all()
    : db.prepare('SELECT d.*, b.name as brand_name FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id WHERE d.brand_id=? ORDER BY d.id DESC').all(scope);
  const brands = scope === null
    ? db.prepare('SELECT id, name FROM brands WHERE enabled=1 ORDER BY id').all()
    : [];
  res.render('distributors', { distributors, brands });
});

// 扫码日志页面（brand 只看自己品牌）
app.get('/logs', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const logs = scope === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 200').all()
    : db.prepare('SELECT * FROM scan_logs WHERE brand_id=? ORDER BY scanned_at DESC LIMIT 200').all(scope);
  res.render('logs', { logs: logs.map(log => ({ ...log, scan_ip: displayScanSource(log.scan_ip) })) });
});

// 删除单条扫码日志（admin/brand；brand 只能删自己品牌的）
app.delete('/api/scan-logs/:id', requireRole('admin', 'brand'), (req, res) => {
  const log = db.prepare('SELECT * FROM scan_logs WHERE id=?').get(req.params.id);
  if (!log) return res.json({ success: false, msg: '记录不存在或已删除' });
  if (!brandAllowed(brandScope(req), log.brand_id)) return res.json({ success: false, msg: '没有权限删除该记录' });
  db.prepare('DELETE FROM scan_logs WHERE id=?').run(log.id);
  logOperation(req, 'delete_scan_log', 'scan_log', log.item_code, `删除扫码记录：${log.item_code}（${log.scan_location || '位置未知'}）`);
  res.json({ success: true, msg: '已删除' });
});

// 批量删除扫码日志（ids 数组；brand 只能删自己品牌的）
app.post('/api/scan-logs/batch-delete', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.json({ success: false, msg: '请先勾选要删除的记录' });
  const del = db.transaction(() => {
    let n = 0;
    for (const id of ids) {
      const log = db.prepare('SELECT id, brand_id FROM scan_logs WHERE id=?').get(id);
      if (!log || !brandAllowed(scope, log.brand_id)) continue;
      db.prepare('DELETE FROM scan_logs WHERE id=?').run(id);
      n++;
    }
    return n;
  });
  const n = del();
  if (!n) return res.json({ success: false, msg: '没有可删除的记录' });
  logOperation(req, 'batch_delete_scan_logs', 'scan_log', '', `批量删除扫码日志 ${n} 条`);
  res.json({ success: true, msg: `已删除 ${n} 条记录`, deleted: n });
});

// 品牌营销设置页面
app.get('/settings', requireRole('admin'), (req, res) => {
  const settings = readOnlyAccess.publicSettings(db.prepare('SELECT key, value FROM settings').all());
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  const prizes = db.prepare(`
    SELECT p.*, c.name as campaign_name
    FROM prize_records p LEFT JOIN campaigns c ON p.campaign_id = c.id
    ORDER BY p.id DESC LIMIT 50
  `).all();
  res.render('settings', { settings, campaigns, prizes });
});

// 标签打印页面
app.get('/print', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const codes = (req.query.codes || '').split(',').map(s => s.trim()).filter(Boolean);
  const type = req.query.type || 'item';
  const product = req.query.product || '';
  // 全局品牌名（兜底，用于未匹配到品牌时显示）
  const defaultBrand = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '';
  // 按每个码的实际品牌归属查询品牌名
  const labelInfo = codes.map(code => {
    let brandName = defaultBrand;
    try {
      if (type === 'box') {
        const row = db.prepare('SELECT COALESCE(br.name, ?) as bn FROM boxes b LEFT JOIN brands br ON br.id=COALESCE(b.brand_id,(SELECT p.brand_id FROM products p WHERE p.id=b.product_id)) WHERE b.box_code=?').get(defaultBrand, code);
        if (row && row.bn) brandName = row.bn;
      } else {
        const row = db.prepare('SELECT COALESCE(br.name, ?) as bn FROM items i LEFT JOIN brands br ON br.id=COALESCE(i.brand_id,(SELECT p.brand_id FROM products p WHERE p.id=i.product_id)) WHERE i.item_code=?').get(defaultBrand, code);
        if (row && row.bn) brandName = row.bn;
      }
    } catch (e) { /* 忽略，用默认品牌名 */ }
    return { code, brand_name: brandName };
  });
  res.render('print', { codes, type, product, labelInfo, brand: defaultBrand });
});

// 码查询页面
app.get('/codes', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('codes');
});

// 下载中心：下载属于独立交付动作，不与码查询、删除或打印混放
app.get('/downloads', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const products = scope === null
    ? db.prepare(`SELECT p.id,p.name,p.spec,p.brand_id,b.name AS brand_name
        FROM products p LEFT JOIN brands b ON b.id=p.brand_id
        WHERE p.brand_id IS NOT NULL ORDER BY b.name,p.name,p.id`).all()
    : db.prepare(`SELECT p.id,p.name,p.spec,p.brand_id,b.name AS brand_name
        FROM products p LEFT JOIN brands b ON b.id=p.brand_id
        WHERE p.brand_id=? ORDER BY p.name,p.id`).all(scope);
  const packages = scope === null
    ? db.prepare(`SELECT cp.*,p.name AS product_name,b.name AS brand_name
        FROM code_packages cp
        LEFT JOIN products p ON p.id=cp.product_id
        LEFT JOIN brands b ON b.id=cp.brand_id
        ORDER BY cp.id DESC LIMIT 100`).all()
    : db.prepare(`SELECT cp.*,p.name AS product_name,b.name AS brand_name
        FROM code_packages cp
        LEFT JOIN products p ON p.id=cp.product_id
        LEFT JOIN brands b ON b.id=cp.brand_id
        WHERE cp.brand_id=? ORDER BY cp.id DESC LIMIT 100`).all(scope);
  res.render('downloads', { products, packages });
});

// 品牌方扫码查串货页面
app.get('/brand-check', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  res.render('brand-check');
});

// 消费者验证页面（H5，嵌入公众号）：/v 为无码入口（手动输码/摄像头扫码），/v/:code 为二维码直达
app.get(['/v', '/v/:code'], (req, res) => {
  const code = req.params.code || '';
  const settings = readOnlyAccess.publicSettings(db.prepare('SELECT key, value FROM settings').all());
  const brandStats = {
    total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c,
    verified_items: db.prepare("SELECT COUNT(*) as c FROM items WHERE status='scanned'").get().c
  };
  res.render('verify', { code, settings, brandStats });
});

// ===================== API 路由 =====================

// API 全局登录守卫：除消费者验证、动态二维码外，所有 /api 接口均需登录
app.use('/api', (req, res, next) => {
  const open = req.path === '/qr' || req.path.startsWith('/verify/') || req.path === '/login' || req.path === '/logout';
  const agentApi = req.path.startsWith('/agent/');
  if (open || agentApi || currentUser(req)) return next();
  return res.status(401).json({ success: false, msg: '登录已过期，请重新登录', needLogin: true });
});

// --- 产品管理 ---

const asId = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
const cleanText = (value, max = 500) => String(value || '').trim().slice(0, max);
const localMediaUrl = value => /^\/uploads\/[A-Za-z0-9._-]+$/.test(String(value || ''));
const safeHttpsUrl = value => {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return null;
    return url.toString();
  } catch { return null; }
};
function scopedProduct(req, id) {
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(asId(id));
  return product && brandAllowed(brandScope(req), product.brand_id) ? product : null;
}
function productContent(productId, brandId, batchNo, includeDraft = false) {
  const media = db.prepare(`SELECT id, url, alt_text, sort_order, is_cover FROM product_media
    WHERE product_id=? AND brand_id=? ORDER BY is_cover DESC, sort_order, id`).all(productId, brandId);
  let batch = null;
  let trace = [];
  if (batchNo) {
    batch = db.prepare(`SELECT id, batch_no, production_date, status, published_at FROM product_batches
      WHERE product_id=? AND brand_id=? AND batch_no=? ${includeDraft ? '' : "AND status='published'"}`).get(productId, brandId, batchNo);
    if (batch) trace = db.prepare(`SELECT e.id, e.stage_key, e.title, e.public_location, e.occurred_at, e.detail, e.evidence_url
      FROM batch_trace_entries e WHERE e.batch_id=? AND e.brand_id=? ${includeDraft ? '' : 'AND e.published=1'}
      AND NOT EXISTS (SELECT 1 FROM batch_trace_entries newer WHERE newer.revision_of=e.id)
      ORDER BY e.occurred_at, e.id`).all(batch.id, brandId);
  }
  const now = new Date().toISOString();
  const marketing = db.prepare(`SELECT image_url, title, description, target_url, starts_at, ends_at
    FROM product_marketing WHERE product_id=? AND brand_id=? AND enabled=1 AND review_status='approved'
      AND (starts_at='' OR starts_at<=?) AND (ends_at='' OR ends_at>=?)`).get(productId, brandId, now, now) || null;
  return { media, batch, trace, marketing };
}
const publicContentFields = content => ({
  product_media: content.media,
  trace_timeline: content.trace.map(entry => ({ ...entry, description: entry.detail })),
  promotion: content.marketing
});

// 新增产品（admin 可指定工厂；brand 只能建自己品牌的产品，可选工厂限本品牌）
app.post('/api/products', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { name, spec, batch_no } = req.body;
  const box_size = parseInt(req.body.box_size) || 0;
  const scope = brandScope(req);
  let factory_id = parseInt(req.body.factory_id) || null;
  let brand_id = null;
  if (!name) return res.json({ success: false, msg: '产品名称不能为空' });
  if (factory_id) {
    const factory = db.prepare('SELECT * FROM factories WHERE id=?').get(factory_id);
    if (!factory) return res.json({ success: false, msg: '所选工厂不存在' });
    if (!brandAllowed(scope, factory.brand_id)) return res.json({ success: false, msg: '所选工厂不属于你的品牌' });
    brand_id = factory.brand_id;
  }
  if (scope !== null) brand_id = scope;
  // 平台管理员可显式指定品牌（未指定工厂，或工厂本身未归属品牌时生效）
  if (scope === null && (!factory_id || !brand_id) && req.body.brand_id) brand_id = parseInt(req.body.brand_id) || null;
  if (!brand_id) return res.status(400).json({ success: false, code: 'PRODUCT_BRAND_REQUIRED', msg: '请选择「归属品牌」或「归属工厂」后再保存' });
  if (!db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.status(400).json({ success: false, code: 'PRODUCT_BRAND_INVALID', msg: '所选品牌不存在或已停用' });
  }
  const description = cleanText(req.body.description, 2000);
  const ena13 = cleanText(req.body.ena13, 32);
  const result = db.prepare('INSERT INTO products (name, spec, batch_no, box_size, factory_id, brand_id, description, ena13) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, spec || '', batch_no || '', box_size, factory_id, brand_id, description, ena13);
  logOperation(req, 'create_product', 'product', result.lastInsertRowid, `创建产品「${cleanText(name, 120)}」`);
  res.json({ success: true, id: result.lastInsertRowid, version: 1 });
});

// 修改产品（含箱规）
app.put('/api/products/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { id } = req.params;
  const { name, spec, batch_no } = req.body;
  const box_size = parseInt(req.body.box_size) || 0;
  if (!name) return res.json({ success: false, msg: '产品名称不能为空' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!product || !brandAllowed(brandScope(req), product.brand_id)) return res.status(404).json({ success: false, msg: '产品不存在' });
  const expectedVersion = req.body.version == null ? product.version : Number(req.body.version);
  const result = db.prepare(`UPDATE products SET name=?, spec=?, batch_no=?, box_size=?, description=?, ena13=?, version=version+1
    WHERE id=? AND version=?`).run(name, spec || '', batch_no || '', box_size, cleanText(req.body.description, 2000), cleanText(req.body.ena13, 32), id, expectedVersion);
  if (!result.changes) return res.status(409).json({ success: false, code: 'VERSION_CONFLICT', msg: '产品已被其他用户修改，请刷新后重试' });
  logOperation(req, 'update_product', 'product', id, `更新产品「${cleanText(name, 120)}」`);
  res.json({ success: true, version: expectedVersion + 1 });
});

// 删除产品（admin/brand；该产品下没有任何未删除的箱码/子码时才能删除）
app.delete('/api/products/:id', requireRole('admin', 'brand'), (req, res) => {
  const { id } = req.params;
  const pid = parseInt(id);
  if (!pid) return res.json({ success: false, msg: '无效的产品 ID' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(pid);
  if (!product) return res.json({ success: false, msg: '产品不存在' });
  if (!brandAllowed(brandScope(req), product.brand_id)) return res.json({ success: false, msg: '没有权限操作该产品' });
  const boxCount = db.prepare("SELECT COUNT(*) c FROM boxes WHERE product_id=?").get(pid).c;
  if (boxCount > 0) return res.json({ success: false, msg: '该产品下还有 ' + boxCount + ' 个箱码，请先删除/作废所有码' });
  const itemCount = db.prepare("SELECT COUNT(*) c FROM items WHERE product_id=?").get(pid).c;
  if (itemCount > 0) return res.json({ success: false, msg: '该产品下还有 ' + itemCount + ' 个子码，请先删除/作废所有码' });
  db.prepare('DELETE FROM products WHERE id=?').run(pid);
  logOperation(req, 'delete_product', 'product', pid, '产品「' + product.name + '」已物理删除');
  res.json({ success: true, msg: '产品已删除' });
});

// 获取产品列表（工厂角色只看自己工厂；品牌管理员只看自己品牌）
app.get('/api/products', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  const user = currentUser(req);
  const role = user.role;
  if (role === 'factory') {
    if (!user.factory_id || !user.brand_id) sql += ' AND 1=0';
    else {
      sql += ' AND factory_id=? AND brand_id=?';
      params.push(user.factory_id, user.brand_id);
    }
  } else if (['brand', 'brand_staff'].includes(role) && user.brand_id) {
    sql += ' AND brand_id=?';
    params.push(user.brand_id);
  }
  sql += ' ORDER BY id DESC';
  const products = db.prepare(sql).all(...params);
  res.json({ success: true, products });
});

// 产品内容详情（草稿仅对所属租户后台可见）
app.get('/api/products/:id/content', requireRole('admin', 'brand', 'brand_staff', 'factory'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const templates = db.prepare(`SELECT id, stage_key, title, public_label, content, image_url, sort_order, enabled FROM product_trace_templates
    WHERE product_id=? AND brand_id=? ORDER BY sort_order,id`).all(product.id, product.brand_id);
  const batches = db.prepare(`SELECT id, batch_no, production_date, status, published_at, version, created_at, updated_at
    FROM product_batches WHERE product_id=? AND brand_id=? ORDER BY id DESC`).all(product.id, product.brand_id);
  const marketing = db.prepare('SELECT * FROM product_marketing WHERE product_id=? AND brand_id=?').get(product.id, product.brand_id) || null;
  res.json({ success: true, product, templates, batches, marketing, ...productContent(product.id, product.brand_id, '', true) });
});

function replaceProductMedia(req, res) {
  const product = scopedProduct(req, req.params.id || req.body.product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const media = Array.isArray(req.body.media) ? req.body.media : [];
  if (media.length > 6 || media.some(row => !localMediaUrl(row?.url))) return res.status(400).json({ success: false, code: 'INVALID_PRODUCT_MEDIA', msg: '产品图片必须来自本系统且不能超过6张' });
  const normalized = media.map((row, index) => ({ url: row.url, alt: cleanText(row.alt_text, 160), cover: row.is_cover ? 1 : 0, order: index }));
  if (normalized.filter(row => row.cover).length > 1) return res.status(400).json({ success: false, code: 'MULTIPLE_COVERS', msg: '只能设置一张封面' });
  if (normalized.length && !normalized.some(row => row.cover)) normalized[0].cover = 1;
  db.transaction(() => {
    db.prepare('DELETE FROM product_media WHERE product_id=? AND brand_id=?').run(product.id, product.brand_id);
    const insert = db.prepare(`INSERT INTO product_media (brand_id,product_id,url,alt_text,sort_order,is_cover,created_by) VALUES (?,?,?,?,?,?,?)`);
    normalized.forEach(row => insert.run(product.brand_id, product.id, row.url, row.alt, row.order, row.cover, currentUser(req).id || null));
  })();
  logOperation(req, 'replace_product_media', 'product', product.id, `更新产品图片，共 ${normalized.length} 张`);
  res.json({ success: true, media: productContent(product.id, product.brand_id, '', true).media });
}
app.put('/api/products/:id/media', requireRole('admin', 'brand', 'brand_staff'), replaceProductMedia);

function replaceTraceTemplate(req, res) {
  const product = scopedProduct(req, req.params.id || req.body.product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const stages = Array.isArray(req.body.stages) ? req.body.stages : [];
  if (stages.length > 30) return res.status(400).json({ success: false, msg: '溯源阶段不能超过30项' });
  const rows = stages.map((stage, index) => ({ key: cleanText(stage.stage_key, 40), title: cleanText(stage.title, 100), label: cleanText(stage.public_label, 100), content: cleanText(stage.content, 5000), image_url: cleanText(stage.image_url, 2048), enabled: stage.enabled === false ? 0 : 1, order: index }));
  if (rows.some(row => !/^[a-z][a-z0-9_-]{1,39}$/.test(row.key) || !row.title) || new Set(rows.map(row => row.key)).size !== rows.length) return res.status(400).json({ success: false, code: 'INVALID_TRACE_TEMPLATE', msg: '阶段标识或标题无效、重复' });
  db.transaction(() => {
    db.prepare('DELETE FROM product_trace_templates WHERE product_id=? AND brand_id=? AND id NOT IN (SELECT template_id FROM batch_trace_entries WHERE template_id IS NOT NULL)').run(product.id, product.brand_id);
    const upsert = db.prepare(`INSERT INTO product_trace_templates (brand_id,product_id,stage_key,title,public_label,content,image_url,sort_order,enabled)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id,stage_key) DO UPDATE SET title=excluded.title,public_label=excluded.public_label,content=excluded.content,image_url=excluded.image_url,sort_order=excluded.sort_order,enabled=excluded.enabled`);
    rows.forEach(row => upsert.run(product.brand_id, product.id, row.key, row.title, row.label, row.content, row.image_url, row.order, row.enabled));
    if (rows.length) db.prepare(`UPDATE product_trace_templates SET enabled=0 WHERE product_id=? AND brand_id=? AND stage_key NOT IN (${rows.map(() => '?').join(',')})`).run(product.id, product.brand_id, ...rows.map(row => row.key));
    else db.prepare('UPDATE product_trace_templates SET enabled=0 WHERE product_id=? AND brand_id=?').run(product.id, product.brand_id);
  })();
  logOperation(req, 'replace_trace_template', 'product', product.id, `更新溯源模板，共 ${rows.length} 个阶段`);
  res.json({ success: true });
}
app.put('/api/products/:id/trace-template', requireRole('admin', 'brand', 'brand_staff'), replaceTraceTemplate);

function createProductBatch(req, res) {
  const product = scopedProduct(req, req.params.id || req.body.product_id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const batchNo = cleanText(req.body.batch_no, 80);
  if (!batchNo) return res.status(400).json({ success: false, msg: '批次号不能为空' });
  try {
    const result = db.prepare(`INSERT INTO product_batches (brand_id,product_id,batch_no,production_date,created_by) VALUES (?,?,?,?,?)`)
      .run(product.brand_id, product.id, batchNo, cleanText(req.body.production_date, 20), currentUser(req).id || null);
    logOperation(req, 'create_product_batch', 'product_batch', result.lastInsertRowid, `创建批次「${batchNo}」`);
    res.status(201).json({ success: true, id: result.lastInsertRowid, version: 1 });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ success: false, code: 'BATCH_EXISTS', msg: '该批次已存在' });
    throw error;
  }
}
app.post('/api/products/:id/batches', requireRole('admin', 'brand', 'brand_staff'), createProductBatch);

function scopedBatch(req, id) {
  const row = db.prepare(`SELECT pb.*,p.name product_name FROM product_batches pb JOIN products p ON p.id=pb.product_id WHERE pb.id=?`).get(asId(id));
  return row && brandAllowed(brandScope(req), row.brand_id) ? row : null;
}
function appendTraceEntry(req, res) {
  const batch = scopedBatch(req, req.params.batchId || req.body.batch_id);
  if (!batch) return res.status(404).json({ success: false, msg: '批次不存在' });
  const stageKey = cleanText(req.body.stage_key, 40), title = cleanText(req.body.title, 100), occurredAt = cleanText(req.body.occurred_at, 40);
  if (!stageKey || !title || !occurredAt || Number.isNaN(Date.parse(occurredAt))) return res.status(400).json({ success: false, msg: '阶段、标题和有效发生时间不能为空' });
  const evidence = cleanText(req.body.evidence_url, 300);
  if (evidence && !localMediaUrl(evidence)) return res.status(400).json({ success: false, msg: '凭证图片必须来自本系统上传' });
  const template = db.prepare('SELECT id FROM product_trace_templates WHERE product_id=? AND brand_id=? AND stage_key=?').get(batch.product_id, batch.brand_id, stageKey);
  const revisionOf = asId(req.body.revision_of) || null;
  if (revisionOf && !db.prepare('SELECT id FROM batch_trace_entries WHERE id=? AND batch_id=? AND brand_id=?').get(revisionOf, batch.id, batch.brand_id)) return res.status(404).json({ success: false, msg: '被修订的履历不存在' });
  const result = db.prepare(`INSERT INTO batch_trace_entries (brand_id,batch_id,template_id,stage_key,title,public_location,occurred_at,detail,evidence_url,revision_of,published,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(batch.brand_id,batch.id,template?.id||null,stageKey,title,cleanText(req.body.public_location,120),new Date(occurredAt).toISOString(),cleanText(req.body.detail,2000),evidence,revisionOf,req.body.published?1:0,currentUser(req).id||null);
  logOperation(req, revisionOf ? 'revise_trace_entry' : 'append_trace_entry', 'batch_trace_entry', result.lastInsertRowid, `批次「${batch.batch_no}」新增履历「${title}」`);
  res.status(201).json({ success: true, id: result.lastInsertRowid });
}
app.post('/api/batches/:batchId/trace', requireRole('admin', 'brand', 'brand_staff'), appendTraceEntry);
app.get('/api/batches/:batchId/trace', requireRole('admin', 'brand', 'brand_staff', 'factory'), (req,res) => {
  const batch=scopedBatch(req,req.params.batchId); if(!batch) return res.status(404).json({success:false,msg:'批次不存在'});
  res.json({success:true,batch,trace:db.prepare('SELECT * FROM batch_trace_entries WHERE batch_id=? AND brand_id=? ORDER BY occurred_at,id').all(batch.id,batch.brand_id)});
});
function publishBatch(req, res) {
  const batch = scopedBatch(req, req.params.batchId || req.body.batch_id);
  if (!batch) return res.status(404).json({ success: false, msg: '批次不存在' });
  const expected = req.body.version == null ? batch.version : Number(req.body.version);
  const result = db.prepare(`UPDATE product_batches SET status='published',published_at=datetime('now','localtime'),version=version+1,updated_at=datetime('now','localtime') WHERE id=? AND version=?`).run(batch.id, expected);
  if (!result.changes) return res.status(409).json({ success:false,code:'VERSION_CONFLICT',msg:'批次已被修改' });
  db.prepare('UPDATE batch_trace_entries SET published=1 WHERE batch_id=? AND brand_id=?').run(batch.id,batch.brand_id);
  logOperation(req,'publish_product_batch','product_batch',batch.id,`发布批次「${batch.batch_no}」`);
  res.json({success:true,version:expected+1});
}
app.put('/api/batches/:batchId/publish', requireRole('admin','brand'), publishBatch);

function saveMarketing(req,res) {
  const product=scopedProduct(req,req.params.id||req.body.product_id); if(!product) return res.status(404).json({success:false,msg:'产品不存在'});
  const image=cleanText(req.body.image_url,300), target=safeHttpsUrl(req.body.target_url);
  if((image&&!localMediaUrl(image))||target===null) return res.status(400).json({success:false,code:'INVALID_MARKETING_CONTENT',msg:'广告图片或HTTPS链接无效'});
  db.prepare(`INSERT INTO product_marketing (product_id,brand_id,image_url,title,description,target_url,starts_at,ends_at,enabled,review_status)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET image_url=excluded.image_url,title=excluded.title,description=excluded.description,target_url=excluded.target_url,starts_at=excluded.starts_at,ends_at=excluded.ends_at,enabled=excluded.enabled,review_status='pending',version=product_marketing.version+1,updated_at=datetime('now','localtime')`)
    .run(product.id,product.brand_id,image,cleanText(req.body.title,120),cleanText(req.body.description,1000),target||'',cleanText(req.body.starts_at,40),cleanText(req.body.ends_at,40),req.body.enabled?1:0,'pending');
  logOperation(req,'save_product_marketing','product',product.id,'保存产品营销内容，等待审核'); res.json({success:true,review_status:'pending'});
}
app.put('/api/products/:id/marketing',requireRole('admin','brand','brand_staff'),saveMarketing);
app.put('/api/products/:id/marketing/review',requireRole('admin','brand'),(req,res)=>{
  const product=scopedProduct(req,req.params.id); if(!product)return res.status(404).json({success:false,msg:'产品不存在'});
  const status=req.body.status; if(!['approved','rejected'].includes(status))return res.status(400).json({success:false,msg:'审核状态无效'});
  const result=db.prepare(`UPDATE product_marketing SET review_status=?,reviewed_by=?,reviewed_at=datetime('now','localtime'),version=version+1 WHERE product_id=? AND brand_id=?`).run(status,currentUser(req).id||null,product.id,product.brand_id);
  if(!result.changes)return res.status(404).json({success:false,msg:'营销内容不存在'}); logOperation(req,'review_product_marketing','product',product.id,`营销内容审核：${status}`); res.json({success:true});
});

// Agent 使用同一租户/角色校验与业务处理器；所有写命令必须带幂等键。
app.put('/api/agent/products/:id/media',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,replaceProductMedia);
app.put('/api/agent/products/:id/trace-template',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,replaceTraceTemplate);
app.post('/api/agent/products/:id/batches',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,createProductBatch);
app.post('/api/agent/batches/:batchId/trace',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,appendTraceEntry);
app.put('/api/agent/products/:id/marketing',requireAgentToken,requireAgentRole('admin','brand','brand_staff'),requireAgentIdempotency,saveMarketing);

// --- 码生成 ---

// 生成码函数
const genCode = (prefix) => {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}${ts}${rand}`;
};

// 扫码枪可能扫出完整URL（http://host/v/BMSSR...）或纯码值，统一提取码值
const extractCode = (input) => {
  if (!input) return input;
  const s = String(input).trim();
  const m = s.match(/\/v\/([A-Z0-9]+)/i);
  if (m) return m[1];
  return s;
};

// 二维码只使用已通过应用级白名单校验的访问地址。
const getBaseUrl = (req) => `${req.protocol}://${req.get('host')}`;
const ensureQrOutputDirectory = () => fs.mkdirSync(path.join(__dirname, 'public', 'qr'), { recursive: true, mode: 0o750 });

// 大批量 TXT 码包不预生成图片，后台首次查看某个码时再按需生成二维码。
// 仅为数据库中真实存在的码生成，避免把本服务变成任意文本二维码生成器。
app.get('/qr/:code.png', wrap(async (req, res) => {
  const code = extractCode(req.params.code);
  if (!/^[A-Z0-9]+$/i.test(String(code || ''))) return res.status(404).end();
  const exists = db.prepare('SELECT 1 FROM boxes WHERE box_code=? UNION ALL SELECT 1 FROM items WHERE item_code=? LIMIT 1').get(code, code);
  if (!exists) return res.status(404).end();
  ensureQrOutputDirectory();
  const buffer = await getQrBuffer(code, String(code).startsWith('B') ? 300 : 200, getBaseUrl(req));
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  res.send(buffer);
}));

function requireRegisteredBatch(product, batchNo, res) {
  const normalized = String(batchNo || '').trim();
  if (!normalized) {
    res.status(400).json({ success: false, code: 'BATCH_REQUIRED', msg: '选择产品后必须填写已登记批次号' });
    return null;
  }
  const batch = db.prepare(`SELECT id,batch_no,status FROM product_batches
    WHERE product_id=? AND brand_id=? AND batch_no=?`).get(product.id, product.brand_id, normalized);
  if (!batch) {
    res.status(404).json({ success: false, code: 'BATCH_NOT_FOUND', msg: '该产品批次不存在，请先创建批次' });
    return null;
  }
  return batch;
}

// 单独生成箱码（父码，暂不绑定子码）
// product_id 可选：不选产品=空白箱码，装箱时扫箱码再选择产品；选了产品则码自带产品信息
const generateBoxes = wrap(async (req, res) => {
  ensureQrOutputDirectory();
  const { product_id, batch_no, box_count } = req.body;
  const bCount = Math.min(parseInt(box_count) || 1, 1000);
  const scope = brandScope(req);

  let pid = null, brandId = null;
  if (product_id) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!product) return res.json({ success: false, msg: '产品不存在' });
    if (!brandAllowed(scope, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });
    if (!requireRegisteredBatch(product, batch_no, res)) return;
    pid = product.id;
    brandId = product.brand_id;
  } else {
    if (scope !== null) {
      // 品牌方账号：空白码归自己品牌
      brandId = scope;
    } else {
      // 平台管理员（总管理员）：必须显式指定归属品牌
      const bid = parseInt(req.body.brand_id);
      if (!bid) return res.json({ success: false, msg: '请选择这批码的归属品牌' });
      brandId = bid;
    }
  }

  const insertBox = db.prepare('INSERT INTO boxes (box_code, product_id, brand_id, batch_no, item_count) VALUES (?,?,?,?,0)');
  const generated = [];
  const baseUrl = getBaseUrl(req);

  for (let b = 0; b < bCount; b++) {
    let boxCode = genCode('B');
    // 防重
    while (db.prepare('SELECT 1 FROM boxes WHERE box_code=?').get(boxCode)) {
      boxCode = genCode('B');
    }
    const boxResult = insertBox.run(boxCode, pid, brandId, String(batch_no || '').trim());
    const boxUrl = `${baseUrl}/v/${boxCode}`;
    const boxQrPath = path.join(__dirname, 'public', 'qr', `${boxCode}.png`);
    await QRCode.toFile(boxQrPath, boxUrl, { width: 300, margin: 1 });
    generated.push({ id: Number(boxResult.lastInsertRowid), box_code: boxCode, qr_url: `/qr/${boxCode}.png` });
  }

  logOperation(req, 'generate_boxes', 'box', generated[0]?.box_code || '', `生成箱码 ${generated.length} 个${req.agentUser ? '（Agent API）' : ''}`);
  res.json({ success: true, generated, count: generated.length, requestId: req.requestId });
});
app.post('/api/codes/generate/boxes', requireRole('admin', 'brand_staff'), generateBoxes);
app.post('/api/agent/codes/boxes', requireAgentToken, requireAgentRole('admin', 'brand_staff'), requireAgentIdempotency, generateBoxes);

// 单独生成子码（未绑定箱码）
// product_id 可选：不选产品=空白子码，装箱绑定箱码时自动跟随箱码产品
const generateItems = wrap(async (req, res) => {
  ensureQrOutputDirectory();
  const { product_id, batch_no, item_count } = req.body;
  const iCount = Math.min(parseInt(item_count) || 1, 5000);
  const scope = brandScope(req);

  let pid = null, brandId = null;
  if (product_id) {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
    if (!product) return res.json({ success: false, msg: '产品不存在' });
    if (!brandAllowed(scope, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });
    if (!requireRegisteredBatch(product, batch_no, res)) return;
    pid = product.id;
    brandId = product.brand_id;
  } else {
    if (scope !== null) {
      brandId = scope;
    } else {
      const bid = parseInt(req.body.brand_id);
      if (!bid) return res.json({ success: false, msg: '请选择这批码的归属品牌' });
      brandId = bid;
    }
  }

  const insertItem = db.prepare('INSERT INTO items (item_code, box_id, product_id, brand_id, batch_no) VALUES (?,NULL,?,?,?)');
  const generated = [];
  const baseUrl = getBaseUrl(req);

  for (let i = 0; i < iCount; i++) {
    let itemCode = genCode('S');
    while (db.prepare('SELECT 1 FROM items WHERE item_code=?').get(itemCode)) {
      itemCode = genCode('S');
    }
    const itemResult = insertItem.run(itemCode, pid, brandId, String(batch_no || '').trim());
    const itemUrl = `${baseUrl}/v/${itemCode}`;
    const itemQrPath = path.join(__dirname, 'public', 'qr', `${itemCode}.png`);
    await QRCode.toFile(itemQrPath, itemUrl, { width: 200, margin: 1 });
    generated.push({ id: Number(itemResult.lastInsertRowid), item_code: itemCode, qr_url: `/qr/${itemCode}.png` });
  }

  logOperation(req, 'generate_items', 'item', generated[0]?.item_code || '', `生成子码 ${generated.length} 个${req.agentUser ? '（Agent API）' : ''}`);
  res.json({ success: true, generated, count: generated.length, requestId: req.requestId });
});
app.post('/api/codes/generate/items', requireRole('admin', 'brand_staff'), generateItems);
app.post('/api/agent/codes/items', requireAgentToken, requireAgentRole('admin', 'brand_staff'), requireAgentIdempotency, generateItems);

// 生产码包：一次生成 1～50,000 个码并绑定到唯一任务，供工厂精确导出 TXT。
// 与页面即时生码不同，此流程不预生成数万张 PNG，避免阻塞服务和占满磁盘。
app.post('/api/code-packages', requireRole('admin', 'brand_staff'), wrap(async (req, res) => {
  const codeType = req.body.code_type === 'box' ? 'box' : req.body.code_type === 'item' ? 'item' : '';
  const quantity = Number(req.body.quantity);
  const productId = Number(req.body.product_id);
  const batchNo = cleanText(req.body.batch_no, 80);
  if (!codeType) return res.status(400).json({ success: false, code: 'CODE_TYPE_INVALID', msg: '请选择码类型' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50000) {
    return res.status(400).json({ success: false, code: 'QUANTITY_INVALID', msg: '码包数量必须是 1 至 50,000 的整数' });
  }
  if (!Number.isInteger(productId) || productId < 1) {
    return res.status(400).json({ success: false, code: 'PRODUCT_REQUIRED', msg: '生产码包必须选择产品' });
  }
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  const scope = brandScope(req);
  if (!product || !brandAllowed(scope, product.brand_id)) {
    return res.status(404).json({ success: false, code: 'PRODUCT_NOT_FOUND', msg: '产品不存在或无权访问' });
  }
  if (!batchNo) return res.status(400).json({ success: false, code: 'BATCH_REQUIRED', msg: '批次号不能为空' });
  let registeredBatch = db.prepare(`SELECT * FROM product_batches WHERE product_id=? AND brand_id=? AND batch_no=?`)
    .get(product.id, product.brand_id, batchNo);
  const existingOrigin = registeredBatch
    ? db.prepare(`SELECT id FROM batch_trace_entries WHERE batch_id=? AND brand_id=? AND stage_key='origin' ORDER BY id LIMIT 1`).get(registeredBatch.id, product.brand_id)
    : null;
  const needsOrigin = !registeredBatch || !existingOrigin;
  const originTitle = cleanText(req.body.origin_title, 100);
  const originLocation = cleanText(req.body.origin_location, 120);
  const occurredAtInput = cleanText(req.body.occurred_at, 40);
  if (needsOrigin && (!originTitle || !originLocation || !occurredAtInput || Number.isNaN(Date.parse(occurredAtInput)))) {
    return res.status(400).json({ success: false, code: 'BATCH_ORIGIN_REQUIRED', msg: '新批次必须填写原料来源标题、公开地区和有效发生时间' });
  }

  const now = new Date();
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const packageNo = `PKG-${datePart}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const user = currentUser(req);
  const packageResult = db.prepare(`INSERT INTO code_packages
    (package_no,code_type,brand_id,product_id,batch_no,quantity,base_url,status,created_by,created_by_name)
    VALUES (?,?,?,?,?,?,?,'generating',?,?)`)
    .run(packageNo, codeType, product.brand_id, product.id, batchNo, quantity, getBaseUrl(req), user.id || null, user.username || '');
  const packageId = Number(packageResult.lastInsertRowid);

  let firstCode = '';
  let lastCode = '';
  let createdBatch = false;
  const insertCode = codeType === 'box'
    ? db.prepare(`INSERT INTO boxes (box_code,product_id,brand_id,batch_no,item_count,package_id) VALUES (?,?,?,?,0,?)`)
    : db.prepare(`INSERT INTO items (item_code,box_id,product_id,brand_id,batch_no,package_id) VALUES (?,NULL,?,?,?,?)`);
  const createPackageCodes = db.transaction(() => {
    if (!registeredBatch) {
      const batchResult = db.prepare(`INSERT INTO product_batches
        (brand_id,product_id,batch_no,production_date,status,created_by)
        VALUES (?,?,?,?,'draft',?)`)
        .run(product.brand_id, product.id, batchNo, occurredAtInput.slice(0, 10), user.id || null);
      registeredBatch = db.prepare('SELECT * FROM product_batches WHERE id=?').get(batchResult.lastInsertRowid);
      createdBatch = true;
    }
    if (!existingOrigin) {
      const template = db.prepare(`SELECT id FROM product_trace_templates WHERE product_id=? AND brand_id=? AND stage_key='origin'`).get(product.id, product.brand_id);
      db.prepare(`INSERT INTO batch_trace_entries
        (brand_id,batch_id,template_id,stage_key,title,public_location,occurred_at,published,created_by)
        VALUES (?,?,?,'origin',?,?,?,1,?)`)
        .run(product.brand_id, registeredBatch.id, template?.id || null, originTitle, originLocation, new Date(occurredAtInput).toISOString(), user.id || null);
    }
    if (registeredBatch.status !== 'published') {
      db.prepare(`UPDATE product_batches SET status='published',published_at=datetime('now','localtime'),version=version+1,updated_at=datetime('now','localtime') WHERE id=?`).run(registeredBatch.id);
      db.prepare('UPDATE batch_trace_entries SET published=1 WHERE batch_id=? AND brand_id=?').run(registeredBatch.id, product.brand_id);
    }
    for (let index = 0; index < quantity; index++) {
      let code = '';
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
        code = `${codeType === 'box' ? 'B' : 'S'}${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
        try {
          if (codeType === 'box') insertCode.run(code, product.id, product.brand_id, batchNo, packageId);
          else insertCode.run(code, product.id, product.brand_id, batchNo, packageId);
          inserted = true;
        } catch (error) {
          if (!String(error.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) throw error;
        }
      }
      if (!inserted) throw new Error('无法生成唯一溯源码');
      if (!firstCode) firstCode = code;
      lastCode = code;
    }
    db.prepare(`UPDATE code_packages SET status='ready',first_code=?,last_code=?,completed_at=datetime('now','localtime') WHERE id=?`)
      .run(firstCode, lastCode, packageId);
  });

  try {
    createPackageCodes();
  } catch (error) {
    db.prepare(`UPDATE code_packages SET status='failed',error_message=?,completed_at=datetime('now','localtime') WHERE id=?`)
      .run('生成失败，请联系平台管理员', packageId);
    console.error(JSON.stringify({ level: 'error', event: 'code_package_generation_failed', requestId: req.requestId, packageId, message: error.message }));
    logOperation(req, 'generate_code_package_failed', 'code_package', packageId, `码包 ${packageNo} 生成失败`);
    return res.status(500).json({ success: false, code: 'PACKAGE_GENERATION_FAILED', msg: '码包生成失败，未产生不完整码数据', requestId: req.requestId });
  }

  if (createdBatch) {
    logOperation(req, 'create_product_batch', 'product_batch', registeredBatch.id, `随生产码包创建并发布批次「${batchNo}」`);
  }
  logOperation(req, 'generate_code_package', 'code_package', packageId,
    `生成${codeType === 'box' ? '箱码' : '子码'}码包 ${packageNo}，产品「${product.name}」，批次「${batchNo}」，共 ${quantity} 个`);
  res.status(201).json({
    success: true,
    package: { id: packageId, package_no: packageNo, code_type: codeType, quantity, status: 'ready' },
    download_url: `/api/code-packages/${packageId}/download?mode=url`
  });
}));

// 获取未绑定箱码的子码（用于绑定界面；brand 只看自己品牌；空白码用自身 brand_id 隔离）
app.get('/api/codes/unbound', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const cond = scope === null ? '' : ' AND COALESCE(i.brand_id, p.brand_id)=?';
  const params = scope === null ? [] : [scope];
  const items = db.prepare(`
    SELECT i.item_code, p.name as product_name, i.batch_no, i.created_at
    FROM items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.box_id IS NULL ${cond}
    ORDER BY i.id DESC
    LIMIT 200
  `).all(...params);
  const total = db.prepare(`
    SELECT COUNT(*) as c FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.box_id IS NULL ${cond}
  `).get(...params).c;
  res.json({ success: true, items, total });
});

// 查询箱码的详情（含已绑定子码；brand 只能查自己品牌，空白码用自身 brand_id）
app.get('/api/codes/box/:code', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const code = extractCode(req.params.code);
  const box = db.prepare(`
    SELECT b.*, p.name as product_name, COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (!brandAllowed(brandScope(req), box.eff_brand_id)) return res.json({ success: false, msg: '没有权限查看该箱码' });

  const items = db.prepare(`
    SELECT i.item_code, i.status, i.created_at
    FROM items i WHERE i.box_id = ?
  `).all(box.id);

  res.json({
    success: true,
    box,
    items,
    bound_count: items.length
  });
});

// 绑定子码到箱码（可绑定任意数量；brand 只能操作自己品牌的码）
app.post('/api/codes/bind', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { item_codes } = req.body;
  const box_code = extractCode(req.body.box_code);
  const scope = brandScope(req);
  if (!box_code) return res.json({ success: false, msg: '请输入箱码' });
  if (!Array.isArray(item_codes) || item_codes.length === 0) return res.json({ success: false, msg: '请选择要绑定的子码' });
  const requestedCodes = [...new Set(item_codes.map(extractCode).filter(Boolean))];
  if (requestedCodes.length === 0 || requestedCodes.length > 5000) return res.status(400).json({ success: false, code: 'INVALID_ITEM_CODES', msg: '子码数量不合法' });

  const box = db.prepare(`
    SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (!brandAllowed(scope, box.eff_brand_id)) return res.json({ success: false, msg: '该箱码不属于你的品牌' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能继续绑定' });

  const readBindableItem = db.prepare(`
    SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id
    FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?
  `);
  const requestedItems = requestedCodes.map(code => readBindableItem.get(code));
  if (requestedItems.some(item => !item || !brandAllowed(scope, item.eff_brand_id))) {
    return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '部分子码不存在或无权访问' });
  }

  const tx = db.transaction(() => {
    for (const item of requestedItems) {
      if (item.box_id) continue; // 已绑定的跳过
      if (item.status === 'shipped') continue;
      // 箱码有产品则子码跟随箱码产品；箱码为空白码时保留子码自身产品；装箱后状态置为 scanned
      db.prepare("UPDATE items SET box_id=?, product_id=COALESCE(?, product_id), brand_id=COALESCE(?, brand_id), status='scanned' WHERE id=?")
        .run(box.id, box.product_id, box.eff_brand_id, item.id);
    }
    const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
    db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, box.id);
  });
  tx();

  const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
  res.json({ success: true, msg: `绑定成功，该箱现有 ${count} 个子码`, count });
});

// 解绑子码（从箱码中移出；brand 只能操作自己品牌）
app.post('/api/codes/unbind', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const item_code = extractCode(req.body.item_code);
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });

  const item = db.prepare(`
    SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?
  `).get(item_code);
  if (!item) return res.json({ success: false, msg: '子码不存在' });
  if (!brandAllowed(brandScope(req), item.eff_brand_id)) return res.json({ success: false, msg: '该子码不属于你的品牌' });
  if (!item.box_id) return res.json({ success: false, msg: '该子码未绑定任何箱码' });
  if (item.status === 'shipped' || item.status === 'scanned') {
    return res.json({ success: false, msg: '该子码已发货/已扫码，不能解绑' });
  }

  const boxId = item.box_id;
  const tx = db.transaction(() => {
    db.prepare('UPDATE items SET box_id=NULL WHERE id=?').run(item.id);
    const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(boxId).c;
    db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, boxId);
  });
  tx();

  res.json({ success: true, msg: '解绑成功' });
});

// 获取码列表（brand 只看自己品牌的码）
app.get('/api/codes', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { type, page, keyword, status } = req.query;
  const all = req.query.all === '1';   // 全量模式（批量打印用，上限5000条）
  const pageNum = all ? 1 : (parseInt(page) || 1);
  const pageSize = all ? 5000 : 20;
  const offset = (pageNum - 1) * pageSize;
  const scope = brandScope(req);

  if (type === 'box') {
    const conds = [];
    const params = [];
    if (scope !== null) { conds.push('COALESCE(b.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'shipped') conds.push("b.status = 'shipped'");
    else if (status === 'in_stock') conds.push("b.status = 'in_stock'");
    else if (status === 'invalid') conds.push("b.status = 'invalid'");
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) as c FROM boxes b LEFT JOIN products p ON b.product_id=p.id ${where}`).get(...params).c;
    const boxes = db.prepare(`
      SELECT b.*, p.name as product_name, br.name as brand_name,
        (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.status='scanned') as scanned_count
      FROM boxes b
      LEFT JOIN products p ON b.product_id = p.id
      LEFT JOIN brands br ON br.id = COALESCE(b.brand_id, p.brand_id)
      ${where}
      ORDER BY b.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json({ success: true, boxes, total, pages: Math.ceil(total / pageSize) });
  } else {
    const conds = [];
    const params = [];
    if (scope !== null) { conds.push('COALESCE(i.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'scanned') conds.push("i.status = 'scanned'");
    else if (status === 'shipped') conds.push("i.status = 'shipped'");
    else if (status === 'in_stock') conds.push("i.status = 'in_stock'");
    else if (status === 'invalid') conds.push("i.status = 'invalid'");
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const total = db.prepare(`SELECT COUNT(*) as c FROM items i LEFT JOIN products p ON i.product_id=p.id ${where}`).get(...params).c;
    const items = db.prepare(`
      SELECT i.*, p.name as product_name, br.name as brand_name, b.box_code,
        d.name as distributor_name
      FROM items i
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN brands br ON br.id = COALESCE(i.brand_id, p.brand_id)
      LEFT JOIN boxes b ON i.box_id = b.id
      LEFT JOIN distributors d ON i.distributor_id = d.id
      ${where}
      ORDER BY i.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, pageSize, offset);
    res.json({ success: true, items, total, pages: Math.ceil(total / pageSize) });
  }
});

// --- 代理商管理接口见下方（多品牌版） ---

// ===================== 码删除/作废接口 =====================
// 关键操作留痕（写到 operation_logs 表，便于审计）
function logOperation(req, action, targetType, targetId, detail) {
  try {
    const u = req.agentUser || req.session.user || {};
    db.prepare(`INSERT INTO operation_logs (user_id, username, role, action, target_type, target_id, detail, ip, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(u.id || null, u.username || null, u.role || null, action, targetType || null, String(targetId || ''), detail || null, req.ip || null, u.brand_id || null);
  } catch (e) { console.error('[logOperation]', e.message); }
}

// 工厂装箱记录：持久化装箱成功/扫错事件，供「扫码记录」统计
function logPackRecord(req, action, box_code, item_code, product_name, detail, spec, box_size, item_count) {
  try {
    const u = req.agentUser || req.session.user || {};
    db.prepare(`INSERT INTO pack_records (user_id, username, factory_id, brand_id, box_code, item_code, product_name, spec, box_size, item_count, action, detail)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(u.id || null, u.username || null, u.factory_id || null, u.brand_id || null,
        box_code || null, item_code || null, product_name || null, spec || null, box_size || null, item_count || null, action, detail || null);
  } catch (e) { console.error('[logPackRecord]', e.message); }
}

function removeGeneratedQr(code) {
  const safeCode = String(code || '');
  if (!/^[A-Z0-9]+$/.test(safeCode)) return;
  try {
    fs.unlinkSync(path.join(__dirname, 'public', 'qr', `${safeCode}.png`));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(JSON.stringify({ level: 'error', event: 'qr_cleanup_failed', code: safeCode, message: error.message }));
  }
}

// 删除码（admin/brand；未发货/未扫码的码可物理删除）
app.delete('/api/codes/:type/:id', requireRole('admin', 'brand'), (req, res) => {
  const { type, id } = req.params;
  const codeId = parseInt(id);
  const scope = brandScope(req);
  if (!codeId) return res.json({ success: false, msg: '无效的 ID' });
  if (type === 'box') {
    const box = db.prepare(`
      SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
    `).get(codeId);
    if (!box) return res.json({ success: false, msg: '箱码不存在' });
    if (!brandAllowed(scope, box.brand_id)) return res.json({ success: false, msg: '没有权限操作该箱码' });
    if (box.status === 'shipped') return res.json({ success: false, msg: '已发货的箱码不能删除（如需作废请用「标记作废」）' });
    const childCount = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(codeId).c;
    if (childCount > 0) return res.json({ success: false, msg: `该箱下还有 ${childCount} 个子码，请先删除子码` });
    db.prepare('DELETE FROM boxes WHERE id=?').run(codeId);
    removeGeneratedQr(box.box_code);
    logOperation(req, 'delete_box', 'box', box.box_code, `箱码「${box.box_code}」已物理删除`);
    return res.json({ success: true, msg: '箱码已删除' });
  } else if (type === 'item') {
    const item = db.prepare(`
      SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
    `).get(codeId);
    if (!item) return res.json({ success: false, msg: '子码不存在' });
    if (!brandAllowed(scope, item.brand_id)) return res.json({ success: false, msg: '没有权限操作该子码' });
    if (item.status === 'shipped') return res.json({ success: false, msg: '已发货的子码不能删除' });
    if (item.status === 'scanned') return res.json({ success: false, msg: '已扫码的子码不能删除（溯源数据需要保留）' });
    db.prepare('DELETE FROM items WHERE id=?').run(codeId);
    removeGeneratedQr(item.item_code);
    logOperation(req, 'delete_item', 'item', item.item_code, `子码「${item.item_code}」已物理删除`);
    return res.json({ success: true, msg: '子码已删除' });
  }
  return res.json({ success: false, msg: '不支持的码类型' });
});

// 批量删除码（admin/brand；只删可物理删除的码，其余跳过并返回原因）
app.post('/api/codes/batch-delete', requireRole('admin', 'brand'), (req, res) => {
  const { type, ids } = req.body || {};
  const scope = brandScope(req);
  if (!['box', 'item'].includes(type)) return res.json({ success: false, msg: '不支持的码类型' });
  if (!Array.isArray(ids) || ids.length === 0) return res.json({ success: false, msg: '请先勾选要删除的码' });
  if (ids.length > 500) return res.json({ success: false, msg: '单次最多删除 500 个' });

  const deleted = [];
  const skipped = [];

  const run = db.transaction(() => {
    for (const rawId of ids) {
      const codeId = parseInt(rawId);
      if (!codeId) { skipped.push({ code: String(rawId), msg: '无效 ID' }); continue; }
      if (type === 'box') {
        const box = db.prepare(`
          SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
        `).get(codeId);
        if (!box) { skipped.push({ code: String(rawId), msg: '不存在' }); continue; }
        if (!brandAllowed(scope, box.brand_id)) { skipped.push({ code: box.box_code, msg: '无权限' }); continue; }
        if (box.status === 'shipped') { skipped.push({ code: box.box_code, msg: '已发货' }); continue; }
        const childCount = db.prepare('SELECT COUNT(*) c FROM items WHERE box_id=?').get(codeId).c;
        if (childCount > 0) { skipped.push({ code: box.box_code, msg: `箱下还有 ${childCount} 个子码` }); continue; }
        db.prepare('DELETE FROM boxes WHERE id=?').run(codeId);
        logOperation(req, 'delete_box', 'box', box.box_code, `箱码「${box.box_code}」批量删除`);
        deleted.push(box.box_code);
      } else {
        const item = db.prepare(`
          SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
        `).get(codeId);
        if (!item) { skipped.push({ code: String(rawId), msg: '不存在' }); continue; }
        if (!brandAllowed(scope, item.brand_id)) { skipped.push({ code: item.item_code, msg: '无权限' }); continue; }
        if (item.status === 'shipped') { skipped.push({ code: item.item_code, msg: '已发货' }); continue; }
        if (item.status === 'scanned') { skipped.push({ code: item.item_code, msg: '已扫码' }); continue; }
        db.prepare('DELETE FROM items WHERE id=?').run(codeId);
        logOperation(req, 'delete_item', 'item', item.item_code, `子码「${item.item_code}」批量删除`);
        deleted.push(item.item_code);
      }
    }
  });
  run();
  for (const code of deleted) removeGeneratedQr(code);

  let msg = `已删除 ${deleted.length} 个${type === 'box' ? '箱码' : '子码'}`;
  if (skipped.length) msg += `，跳过 ${skipped.length} 个（已发货/已扫码/箱下有子码的不可删除）`;
  res.json({ success: true, deleted: deleted.length, skipped, msg });
});

// 标记作废（admin/brand；任何状态的码都可作废，作废后视为失效，仍保留溯源记录）
app.patch('/api/codes/:type/:id/invalidate', requireRole('admin', 'brand'), (req, res) => {
  const { type, id } = req.params;
  const codeId = parseInt(id);
  const scope = brandScope(req);
  if (!codeId) return res.json({ success: false, msg: '无效的 ID' });
  const { reason } = req.body || {};
  if (type === 'box') {
    const box = db.prepare(`
      SELECT b.*, COALESCE(b.brand_id, p.brand_id) as brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.id=?
    `).get(codeId);
    if (!box) return res.json({ success: false, msg: '箱码不存在' });
    if (!brandAllowed(scope, box.brand_id)) return res.json({ success: false, msg: '没有权限操作该箱码' });
    if (box.status === 'invalid') return res.json({ success: false, msg: '该箱已是作废状态' });
    db.prepare("UPDATE boxes SET status='invalid' WHERE id=?").run(codeId);
    logOperation(req, 'invalidate_box', 'box', box.box_code, `箱码「${box.box_code}」已标记作废${reason ? '，原因：' + reason : ''}`);
    return res.json({ success: true, msg: '箱码已标记作废' });
  } else if (type === 'item') {
    const item = db.prepare(`
      SELECT i.*, COALESCE(i.brand_id, p.brand_id) as brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.id=?
    `).get(codeId);
    if (!item) return res.json({ success: false, msg: '子码不存在' });
    if (!brandAllowed(scope, item.brand_id)) return res.json({ success: false, msg: '没有权限操作该子码' });
    if (item.status === 'invalid') return res.json({ success: false, msg: '该子码已是作废状态' });
    db.prepare("UPDATE items SET status='invalid' WHERE id=?").run(codeId);
    logOperation(req, 'invalidate_item', 'item', item.item_code, `子码「${item.item_code}」已标记作废${reason ? '，原因：' + reason : ''}`);
    return res.json({ success: true, msg: '子码已标记作废' });
  }
  return res.json({ success: false, msg: '不支持的码类型' });
});

// 操作日志查询接口（brand 只看自己品牌的操作）
app.get('/api/operation_logs', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const scope = brandScope(req);
  const rows = scope === null
    ? db.prepare('SELECT * FROM operation_logs ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM operation_logs WHERE brand_id=? ORDER BY id DESC LIMIT ?').all(scope, limit);
  res.json({ success: true, logs: rows });
});

// --- 代理商管理（brand 只能管理自己品牌的代理商） ---

// 解析代理商覆盖区域（多选：省级/市级）。regions: [{province, city}]
function parseCoveredRegions(regions) {
  const list = Array.isArray(regions) ? regions : [];
  const cleaned = [];
  const displayParts = [];
  for (const r of list) {
    const province = String(r && r.province || '').trim();
    const city = String(r && r.city || '').trim();
    if (!province || !Object.hasOwn(CHINA_REGIONS, province)) continue;
    if (city && !CHINA_REGIONS[province].includes(city)) continue;
    cleaned.push({ p: province, c: city });
    displayParts.push(city ? `${province}${city}` : `${province}（全省）`);
  }
  if (!cleaned.length) return null;
  const primary = cleaned[0];
  return {
    covered_regions: JSON.stringify(cleaned),
    region: displayParts.join('；'),
    country: '中国',
    province: primary.c,
    region_province: primary.p,      // 首个区域所在的省（用于兼容单省展示/导出）
    city: primary.c || ''
  };
}

app.get('/api/regions', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json({ success: true, countries: [{ name: '中国', provinces: CHINA_REGIONS }] });
});

app.get('/api/distributors', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const distributors = scope === null
    ? db.prepare('SELECT d.*, b.name AS brand_name FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id ORDER BY d.id DESC').all()
    : db.prepare('SELECT d.*, b.name AS brand_name FROM distributors d LEFT JOIN brands b ON d.brand_id=b.id WHERE d.brand_id=? ORDER BY d.id DESC').all(scope);
  res.json({ success: true, distributors });
});

// 新增代理商
app.post('/api/distributors', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { name, phone, address, regions } = req.body;
  const scope = brandScope(req);
  if (!name) return res.json({ success: false, msg: '代理商名称不能为空' });
  let covered = parseCoveredRegions(regions);
  if (!covered) {
    // 兼容旧单省市提交
    const sr = normalizeRegionSelection(req.body.country, req.body.province, req.body.city);
    if (!sr) return res.status(400).json({ success: false, code: 'INVALID_REGION_SELECTION', msg: '请选择有效的覆盖区域（省或市）' });
    covered = { covered_regions: JSON.stringify([{ p: sr.province, c: sr.city }]), region: sr.region, country: sr.country, province: sr.city, region_province: sr.province, city: sr.city };
  }
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  const result = db.prepare('INSERT INTO distributors (name, phone, region, address, brand_id, country, province, covered_regions) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, phone || '', covered.region, address || '', brand_id, covered.country, covered.region_province, covered.covered_regions);
  res.json({ success: true, id: result.lastInsertRowid });
});

// 删除代理商（brand 只能删自己品牌的）
app.delete('/api/distributors/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { id } = req.params;
  const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(id);
  if (!d) return res.json({ success: false, msg: '代理商不存在' });
  if (!brandAllowed(brandScope(req), d.brand_id)) return res.json({ success: false, msg: '没有权限操作该代理商' });
  db.prepare('DELETE FROM distributors WHERE id=?').run(id);
  res.json({ success: true });
});

// 更新代理商（brand 只能改自己品牌的）
app.put('/api/distributors/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const { id } = req.params;
  const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(id);
  if (!d) return res.json({ success: false, msg: '代理商不存在' });
  if (!brandAllowed(brandScope(req), d.brand_id)) return res.json({ success: false, msg: '没有权限操作该代理商' });
  const { name, phone, address, regions } = req.body;
  let covered = parseCoveredRegions(regions);
  if (!covered) {
    const sr = normalizeRegionSelection(req.body.country, req.body.province, req.body.city);
    if (!sr) return res.status(400).json({ success: false, code: 'INVALID_REGION_SELECTION', msg: '请选择有效的覆盖区域（省或市）' });
    covered = { covered_regions: JSON.stringify([{ p: sr.province, c: sr.city }]), region: sr.region, country: sr.country, province: sr.city, region_province: sr.province, city: sr.city };
  }
  db.prepare('UPDATE distributors SET name=?, phone=?, region=?, address=?, country=?, province=?, covered_regions=? WHERE id=?')
    .run(name, phone || '', covered.region, address || '', covered.country, covered.region_province, covered.covered_regions, id);
  res.json({ success: true });
});

// --- 工厂装箱 ---

// 扫箱码开始装箱：返回箱信息 + 已绑子码列表
// 空白箱码（未绑产品）返回 need_product=true，前端引导选择产品+箱规
app.post('/api/factory/pack/start', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const box_code = extractCode(req.body.box_code);
  if (!box_code) return res.json({ success: false, msg: '请输入箱码' });

  const box = db.prepare(`
    SELECT b.*, p.name as product_name, p.spec as product_spec, p.box_size as product_box_size, p.factory_id as product_factory_id,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能继续装箱' });
  if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废，无法装箱' });
  // 数据隔离：码只归属品牌，品牌旗下任意工厂账号都能扫；只看品牌归属
  // 空白箱码没有产品，用箱码自身 brand_id 判断归属
  const scope = brandScope(req);
  if (!brandAllowed(scope, box.eff_brand_id)) {
    return res.json({ success: false, msg: '该箱码不属于你的品牌，无法装箱' });
  }

  const items = db.prepare(`
    SELECT i.item_code, i.created_at FROM items i WHERE i.box_id = ? ORDER BY i.id
  `).all(box.id);

  res.json({
    success: true,
    box,
    items,
    bound_count: items.length,
    box_size: box.product_box_size || 0,   // 产品默认箱规，前端自动带出
    need_product: !box.product_id          // 空白箱码：需先选择产品
  });
});

// 为箱码选择产品+箱规（空白箱码装箱第一步；也可中途换产品）
app.post('/api/factory/pack/set-product', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const box_code = extractCode(req.body.box_code);
  const product_id = parseInt(req.body.product_id);
  const box_size = parseInt(req.body.box_size) || 0;
  const batch_no = (req.body.batch_no || '').trim();
  if (!box_code) return res.json({ success: false, msg: '请输入箱码' });
  if (!product_id) return res.json({ success: false, msg: '请选择产品' });

  const box = db.prepare('SELECT * FROM boxes WHERE box_code=?').get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能修改' });
  if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废' });

  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.json({ success: false, msg: '产品不存在' });

  const scope = brandScope(req);
  if (!brandAllowed(scope, box.brand_id)) return res.json({ success: false, msg: '该箱码不属于你的品牌' });
  if (!brandAllowed(scope, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });

  // 该箱已绑定的子码若属于其他产品，禁止切换（防止混装数据错乱）
  const conflict = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=? AND product_id IS NOT NULL AND product_id != ?')
    .get(box.id, product_id).c;
  if (conflict > 0) {
    return res.json({ success: false, msg: `该箱已绑定 ${conflict} 个其他产品的子码，不能切换产品，请先联系管理员解绑` });
  }

  const effectiveSize = box_size || product.box_size || 0;
  db.prepare('UPDATE boxes SET product_id=?, brand_id=COALESCE(?, ?), batch_no=?, box_size=? WHERE id=?')
    .run(product_id, product.brand_id, box.brand_id, batch_no || box.batch_no, effectiveSize, box.id);
  logOperation(req, 'pack_set_product', 'box', box.box_code, `箱码「${box.box_code}」设置产品：${product.name}${box_size ? `，箱规 ${box_size}` : ''}`);

  res.json({ success: true, msg: `已选择产品：${product.name}`, box_size: box_size || product.box_size || 0 });
});

// 扫子码绑定到当前箱（带防错）
app.post('/api/factory/pack/scan', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const box_code = extractCode(req.body.box_code);
  const item_code = extractCode(req.body.item_code);
  if (!box_code) return res.json({ success: false, msg: '请先扫箱码' });
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });

  const box = db.prepare(`
    SELECT b.*, p.box_size as product_box_size, p.spec as product_spec,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id
    FROM boxes b LEFT JOIN products p ON b.product_id = p.id
    WHERE b.box_code = ?
  `).get(box_code);
  if (!box) return res.json({ success: false, msg: '箱码不存在' });
  if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，不能继续绑定' });
  if (box.status === 'invalid') return res.json({ success: false, msg: '该箱码已作废，不能绑定' });
  // 数据隔离：码只归属品牌，品牌旗下任意工厂账号都能扫
  const scope = brandScope(req);
  if (!brandAllowed(scope, box.eff_brand_id)) {
    return res.json({ success: false, msg: '该箱码不属于你的品牌，无法装箱' });
  }

  // 空白箱码必须先选产品再扫子码
  if (!box.product_id) {
    return res.json({ success: false, msg: '该箱还未选择产品，请先在上方选择产品并确认箱规' });
  }

  // 箱规：优先用前端传的（工人可临时改），否则用产品默认箱规
  const boxSize = parseInt(req.body.box_size) || box.product_box_size || 0;

  const item = db.prepare(`
    SELECT i.*, p.name as product_name, p.spec as product_spec, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i
    LEFT JOIN products p ON i.product_id = p.id
    WHERE i.item_code = ?
  `).get(item_code);
  if (!item) return res.json({ success: false, msg: '子码不存在' });
  if (!brandAllowed(scope, item.eff_brand_id)) return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '子码不存在或无权访问' });

  const curBound = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;

  // 防错1：已绑定本箱（重复扫）——先于满箱判断，给出更精确的提示
  if (item.box_id === box.id) {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '重复扫码', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `该子码已在本箱（已绑 ${curBound} 个），请勿重复扫码`, bound_count: curBound });
  }
  // 防错0：已扫满箱规，拒绝继续绑定
  if (boxSize > 0 && curBound >= boxSize) {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '箱已满', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `本箱已装满（${curBound}/${boxSize}），请扫下一个箱码开始新箱`, bound_count: curBound, box_size: boxSize, full: true });
  }
  // 防错2：已绑定其他箱
  if (item.box_id) {
    const otherBox = db.prepare('SELECT box_code FROM boxes WHERE id=?').get(item.box_id);
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '已绑其他箱', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `该子码已绑定箱码 ${otherBox?.box_code || ''}，不能重复装箱`, bound_count: curBound });
  }
  // 防错3：已发货
  if (item.status === 'shipped') {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '已发货', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `该子码已发货，不能装箱`, bound_count: curBound });
  }
  // 防错4：产品不符（空白子码 product_id 为空，绑定时自动跟随箱码产品，不算不符）
  if (box.product_id && item.product_id && box.product_id !== item.product_id) {
    logPackRecord(req, 'error', box.box_code, item_code, item.product_name, '产品不符', item.product_spec || box.product_spec, boxSize, curBound);
    return res.json({ success: false, msg: `产品不符！箱码产品与子码产品不一致`, bound_count: curBound });
  }

  // 绑定：空白子码自动跟随箱码产品/品牌；装箱后子码状态置为「已装箱 scanned」
  db.prepare("UPDATE items SET box_id=?, product_id=COALESCE(?, product_id), brand_id=COALESCE(?, brand_id), status='scanned' WHERE id=?")
    .run(box.id, box.product_id, box.eff_brand_id, item.id);
  const count = curBound + 1;
  db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, box.id);

  const items = db.prepare('SELECT item_code, created_at FROM items WHERE box_id=? ORDER BY id').all(box.id);

  // 记录装箱（绑子码 / 装箱完成）
  const packedFull = boxSize > 0 && count >= boxSize;
  logPackRecord(req, packedFull ? 'box_full' : 'bind', box.box_code, item_code, item.product_name, packedFull ? `装箱完成 ${count}/${boxSize}` : '绑定子码', item.product_spec || box.product_spec, boxSize, count);

  res.json({
    success: true,
    msg: `绑定成功`,
    item_code: item_code,
    item_product_name: item.product_name,
    bound_count: count,
    box_size: boxSize,
    full: boxSize > 0 && count >= boxSize,   // 扫满标记，前端自动提示完成
    items: items
  });
});

// 无箱码直接扫子码入库：不扫箱码，直接把子码关联到产品+批次号，状态置为已入库（scanned）
// 适用于大包粮等无需装箱的单品（如 10kg 大包），直接扫子码完成产品绑定入库
app.post('/api/factory/pack/scan-nobox', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const item_code = extractCode(req.body.item_code);
  const product_id = parseInt(req.body.product_id);
  const batch_no = (req.body.batch_no || '').trim();
  if (!item_code) return res.json({ success: false, msg: '请输入子码' });
  if (!product_id) return res.json({ success: false, msg: '请先选择产品' });

  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.json({ success: false, msg: '产品不存在' });

  const scope = brandScope(req);
  if (!brandAllowed(scope, product.brand_id)) return res.json({ success: false, msg: '该产品不属于你的品牌' });

  const item = db.prepare(`
    SELECT i.*, p.name as product_name, p.spec as product_spec, COALESCE(i.brand_id, p.brand_id) as eff_brand_id
    FROM items i LEFT JOIN products p ON i.product_id = p.id
    WHERE i.item_code = ?
  `).get(item_code);
  if (!item) return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '子码不存在或无权访问' });
  if (!brandAllowed(scope, item.eff_brand_id)) return res.status(404).json({ success: false, code: 'ITEM_NOT_FOUND', msg: '子码不存在或无权访问' });
  if (item.status === 'shipped') return res.json({ success: false, msg: '该子码已发货，不能入库' });

  // 防错1：已绑定箱码，走正常装箱流程，不能无箱码入库
  if (item.box_id) {
    const b = db.prepare('SELECT box_code FROM boxes WHERE id=?').get(item.box_id);
    return res.json({ success: false, msg: `该子码已绑定箱码 ${b?.box_code || ''}，请走正常装箱或先解绑`, bound_count: 0 });
  }
  // 防错2：已无箱码入库（重复扫）
  if (item.status === 'scanned') {
    return res.json({ success: false, msg: '该子码已入库（无箱码），请勿重复扫码', bound_count: 0 });
  }

  // 无箱码入库：关联产品 + 品牌 + 批次号，状态置为已入库 scanned
  const effectiveBatch = batch_no || product.batch_no || item.batch_no || '';
  db.prepare("UPDATE items SET product_id=?, brand_id=COALESCE(?, brand_id), batch_no=?, status='scanned' WHERE id=?")
    .run(product.id, product.brand_id, effectiveBatch, item.id);

  logPackRecord(req, 'nobox', null, item_code, product.name, `无箱码入库：${product.name}${product.spec ? '（'+product.spec+'）' : ''}${effectiveBatch ? ' · 批次 '+effectiveBatch : ''}`, product.spec, 0, 1);

  res.json({
    success: true,
    msg: `入库成功：${product.name}${product.spec ? '（'+product.spec+'）' : ''}`,
    item_code: item_code,
    product_name: product.name,
    product_spec: product.spec || '',
    batch_no: effectiveBatch
  });
});

// 工厂装箱 · 扫码记录查询（工厂账号可查自己的装箱统计/明细）
app.get('/api/factory/pack/records', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const u = req.session.user || {};
  const scope = brandScope(req);
  const factoryId = u.factory_id || (parseInt(req.query.factory_id) || 0);
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);

  // 工厂账号：只看自己的记录；品牌/管理员：可看本品牌/全部
  let where = '1=1';
  const params = [];
  if (u.role === 'factory') {
    where = 'factory_id = ?';
    params.push(factoryId);
  } else if (scope !== null) {
    where = 'brand_id = ?';
    params.push(scope);
  } else if (factoryId > 0) {
    where = 'factory_id = ?';
    params.push(factoryId);
  }

  // 明细
  const rows = db.prepare(
    `SELECT id, username, box_code, item_code, product_name, spec, box_size, item_count, action, detail, created_at
     FROM pack_records WHERE ${where} ORDER BY id DESC LIMIT ${limit}`
  ).all(...params);

  // 统计：装过哪些产品、扫多少码、装多少箱、扫错多少次
  const bindCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND action='bind'`).get(...params).c;
  const fullCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND action='box_full'`).get(...params).c;
  const noBoxCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND action='nobox'`).get(...params).c;
  const errCount = db.prepare(`SELECT COUNT(*) c FROM pack_records WHERE ${where} AND action='error'`).get(...params).c;
  const productStats = db.prepare(
    `SELECT product_name, spec, MAX(box_size) box_size, COUNT(*) c FROM pack_records WHERE ${where} AND action IN ('bind','box_full','nobox') AND product_name IS NOT NULL GROUP BY product_name ORDER BY c DESC`
  ).all(...params);

  res.json({
    success: true,
    stats: { scan_count: bindCount + fullCount + noBoxCount, box_count: fullCount, error_count: errCount },
    products: productStats,
    records: rows
  });
});

// --- 仓库发货 ---

// 发货核心：处理单个码（箱码→整箱，子码→散件），返回 { ok, msg, code, type, product_name, item_count }
// 不做 res 响应，纯逻辑，供单码/批量接口复用
function shipOneCode(code, distributor_id, operator, scope, distributor, order_no, remark) {
  code = extractCode(code);
  order_no = (order_no == null ? '' : String(order_no)).trim();
  remark = (remark == null ? '' : String(remark)).trim();
  if (!code) return { ok: false, msg: '请输入箱码或子码', code: '' };

  // 先查箱码 → 整箱发货
  const box = db.prepare(`
    SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id, p.name as product_name FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?
  `).get(code);
  if (box) {
    if (!brandAllowed(scope, box.eff_brand_id)) return { ok: false, msg: '箱码不存在或无权访问', code };
    if (box.status === 'shipped') return { ok: false, msg: '该箱已发货，请勿重复发货', code };
    if (box.status === 'invalid') return { ok: false, msg: '该箱已作废，不能发货', code };
    const itemCount = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(box.id).c;
    const boxSize = Number(box.box_size) || 0;
    if (boxSize > 0 && itemCount < boxSize) {
      return { ok: false, msg: `该箱未装满，缺 ${boxSize - itemCount} 个子码（已扫 ${itemCount}/${boxSize}）`, code };
    }
    try {
      const tx = db.transaction(() => {
        db.prepare(`UPDATE boxes SET status=?, distributor_id=?, shipped_at=datetime('now','localtime') WHERE id=?`).run('shipped', distributor_id, box.id);
        db.prepare('UPDATE items SET status=?, distributor_id=? WHERE box_id=?').run('shipped', distributor_id, box.id);
        db.prepare('INSERT INTO shipments (box_id, distributor_id, operator, order_no, remark) VALUES (?,?,?,?,?)').run(box.id, distributor_id, operator || '', order_no, remark);
      });
      tx();
    } catch (e) { return { ok: false, msg: '发货写入失败：' + e.message, code }; }
    return { ok: true, msg: `整箱发货成功（${itemCount}个产品）`, code, type: 'box', product_name: box.product_name || '', item_count: itemCount };
  }

  // 再查子码 → 散件发货
  const item = db.prepare(`
    SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id, p.name as product_name FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?
  `).get(code);
  if (item) {
    if (!brandAllowed(scope, item.eff_brand_id)) return { ok: false, msg: '子码不存在或无权访问', code };
    if (item.status === 'shipped') return { ok: false, msg: '该子码已发货，请勿重复发货', code };
    if (item.status === 'invalid') return { ok: false, msg: '该子码已作废，不能发货', code };
    if (item.status === 'scanned' && item.box_id) {
      // 已扫码装箱的子码：散件发货同时要处理箱内扣除？这里保持原逻辑，仅按子码发货
    }
    try {
      const tx = db.transaction(() => {
        db.prepare(`UPDATE items SET status=?, distributor_id=?, shipped_at=datetime('now','localtime') WHERE id=?`).run('shipped', distributor_id, item.id);
        db.prepare('INSERT INTO shipments (box_id, distributor_id, operator, item_code, order_no, remark) VALUES (?,?,?,?,?,?)')
          .run(item.box_id || null, distributor_id, operator || '', code, order_no, remark);
      });
      tx();
    } catch (e) { return { ok: false, msg: '发货写入失败：' + e.message, code }; }
    return { ok: true, msg: '散件发货成功', code, type: 'item', product_name: item.product_name || '', item_count: 1 };
  }

  return { ok: false, msg: '码不存在，请核实是箱码还是子码', code };
}

// 扫码发货（单码，向后兼容）
app.post('/api/shipments/ship', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const code = extractCode(req.body.box_code || req.body.code);
  const distributor_id = req.body.distributor_id;
  const scope = brandScope(req);
  const operator = req.session.user.display_name || req.session.user.username;
  const order_no = req.body.order_no;
  const remark = req.body.remark;
  if (!code) return res.json({ success: false, msg: '请输入箱码或子码' });
  if (!distributor_id) return res.json({ success: false, msg: '请选择代理商' });
  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
  if (!distributor) return res.json({ success: false, msg: '代理商不存在' });
  if (!brandAllowed(scope, distributor.brand_id)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });

  const r = shipOneCode(code, distributor_id, operator, scope, distributor, order_no, remark);
  if (!r.ok) return res.json({ success: false, msg: r.msg });
  res.json({ success: true, msg: `${r.msg} → ${distributor.name}（${distributor.region || ''}）` });
});

// 批量扫码发货：一次性提交多个码（箱码/子码混扫），统一发往同一代理商
app.post('/api/shipments/batch-ship', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const codes = Array.isArray(req.body.codes) ? req.body.codes : [];
  const distributor_id = req.body.distributor_id;
  const order_no = req.body.order_no;
  const remark = req.body.remark;
  const scope = brandScope(req);
  const operator = req.session.user.display_name || req.session.user.username;
  if (!codes.length) return res.json({ success: false, msg: '请先扫码添加要发货的码' });
  if (!distributor_id) return res.json({ success: false, msg: '请选择代理商' });
  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
  if (!distributor) return res.json({ success: false, msg: '代理商不存在' });
  if (!brandAllowed(scope, distributor.brand_id)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });

  // 去重
  const uniqueCodes = [...new Set(codes.map(c => extractCode(c)).filter(Boolean))];
  const successList = [];
  const failedList = [];
  for (const c of uniqueCodes) {
    const r = shipOneCode(c, distributor_id, operator, scope, distributor, order_no, remark);
    if (r.ok) successList.push({ code: r.code, type: r.type, product_name: r.product_name, item_count: r.item_count });
    else failedList.push({ code: r.code, msg: r.msg });
  }
  res.json({
    success: true,
    msg: `批量发货完成：成功 ${successList.length} 个，失败 ${failedList.length} 个`,
    shipped: successList,
    failed: failedList,
    total: uniqueCodes.length,
    distributor_name: distributor.name,
    distributor_region: distributor.region || ''
  });
});

// 取消发货：将已发货的箱码/子码回退为在库状态，并删除对应发货记录
app.post('/api/shipments/cancel', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const code = extractCode(req.body.code || req.body.box_code || '');
  const scope = brandScope(req);
  const operator = req.session.user.display_name || req.session.user.username;
  if (!code) return res.json({ success: false, msg: '请输入要取消发货的箱码或子码' });

  // 先判断是箱码还是子码
  const box = db.prepare(`SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?`).get(code);
  if (box) {
    if (!brandAllowed(scope, box.eff_brand_id)) return res.json({ success: false, msg: '该箱码不存在或无权访问' });
    if (box.status !== 'shipped') return res.json({ success: false, msg: '该箱码未发货，无需取消' });
    const tx = db.transaction(() => {
      db.prepare("UPDATE boxes SET status='in_stock', distributor_id=NULL, shipped_at=NULL WHERE id=?").run(box.id);
      db.prepare("UPDATE items SET status='scanned', distributor_id=NULL, shipped_at=NULL WHERE box_id=? AND status='shipped'").run(box.id);
      db.prepare('DELETE FROM shipments WHERE box_id=?').run(box.id);
    });
    tx();
    logOperation(req, 'cancel_ship', 'box', box.box_code, `取消发货：箱码「${box.box_code}」`);
    return res.json({ success: true, msg: `已取消发货：箱码 ${box.box_code}` });
  }

  const item = db.prepare(`SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?`).get(code);
  if (!item) return res.json({ success: false, msg: '码不存在，请核实是箱码还是子码' });
  if (!brandAllowed(scope, item.eff_brand_id)) return res.json({ success: false, msg: '该子码不存在或无权访问' });
  if (item.status !== 'shipped') return res.json({ success: false, msg: '该子码未发货，无需取消' });
  const tx = db.transaction(() => {
    db.prepare("UPDATE items SET status=?, distributor_id=NULL, shipped_at=NULL WHERE id=?").run(item.box_id ? 'scanned' : 'in_stock', item.id);
    db.prepare('DELETE FROM shipments WHERE item_code=?').run(item.item_code);
  });
  tx();
  logOperation(req, 'cancel_ship', 'item', item.item_code, `取消发货：子码「${item.item_code}」`);
  return res.json({ success: true, msg: `已取消发货：子码 ${item.item_code}` });
});

// 取消入库：将已装箱绑定的子码从箱中解绑，回到在库状态（可打包成其他箱）
app.post('/api/codes/cancel-stock', requireRole('admin', 'factory', 'brand', 'brand_staff'), (req, res) => {
  const code = extractCode(req.body.code || req.body.item_code || '');
  const scope = brandScope(req);
  if (!code) return res.json({ success: false, msg: '请输入要取消入库的箱码或子码' });

  // 箱码：整箱取消入库（箱内子码全部解绑）
  const box = db.prepare(`SELECT b.*, COALESCE(b.brand_id, p.brand_id) as eff_brand_id FROM boxes b LEFT JOIN products p ON b.product_id=p.id WHERE b.box_code=?`).get(code);
  if (box) {
    if (!brandAllowed(scope, box.eff_brand_id)) return res.json({ success: false, msg: '该箱码不存在或无权访问' });
    if (box.status === 'shipped') return res.json({ success: false, msg: '该箱已发货，请先「取消发货」再取消入库' });
    const tx = db.transaction(() => {
      // 解绑箱内所有子码（不分状态，只要绑定在本箱且未发货的都解绑回在库状态）
      db.prepare("UPDATE items SET box_id=NULL, status='in_stock' WHERE box_id=? AND status!='shipped'").run(box.id);
      db.prepare('UPDATE boxes SET item_count=0 WHERE id=?').run(box.id);
    });
    tx();
    logOperation(req, 'cancel_stock', 'box', box.box_code, `取消入库：箱码「${box.box_code}」整箱子码解绑`);
    return res.json({ success: true, msg: `已取消入库：箱码 ${box.box_code} 下的子码全部解绑` });
  }

  // 子码：单个取消入库（解绑）
  const item = db.prepare(`SELECT i.*, COALESCE(i.brand_id, p.brand_id) as eff_brand_id FROM items i LEFT JOIN products p ON i.product_id=p.id WHERE i.item_code=?`).get(code);
  if (!item) return res.json({ success: false, msg: '码不存在，请核实是箱码还是子码' });
  if (!brandAllowed(scope, item.eff_brand_id)) return res.json({ success: false, msg: '该子码不存在或无权访问' });
  if (item.status === 'shipped') return res.json({ success: false, msg: '该子码已发货，请先「取消发货」再取消入库' });
  if (!item.box_id && item.status !== 'scanned') return res.json({ success: false, msg: '该子码未绑定箱码，无需取消入库' });

  const boxId = item.box_id;
  const tx = db.transaction(() => {
    db.prepare("UPDATE items SET box_id=NULL, status='in_stock' WHERE id=?").run(item.id);
    if (boxId) {
      const count = db.prepare('SELECT COUNT(*) as c FROM items WHERE box_id=?').get(boxId).c;
      db.prepare('UPDATE boxes SET item_count=? WHERE id=?').run(count, boxId);
    }
  });
  tx();
  logOperation(req, 'cancel_stock', 'item', item.item_code, `取消入库：子码「${item.item_code}」解绑`);
  return res.json({ success: true, msg: `已取消入库：子码 ${item.item_code} 已解绑` });
});

// 获取发货记录（brand 只看自己品牌）
app.get('/api/shipments', requireRole('admin', 'warehouse', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const date = (req.query.date || '').trim();   // 可选：按日期过滤 YYYY-MM-DD
  let brandFilter = scope === null ? '' : ' WHERE COALESCE(p_box.brand_id, p_item.brand_id, d.brand_id)=?';
  const params = scope === null ? [] : [scope];
  if (date) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      brandFilter += (brandFilter ? ' AND' : ' WHERE') + " date(s.shipped_at)=?";
      params.push(date);
    } else {
      return res.json({ success: false, msg: '日期格式错误，应为 YYYY-MM-DD' });
    }
  }
  const shipments = db.prepare(`
    SELECT s.*,
      b.box_code, b.item_count,
      COALESCE(p_box.name, p_item.name) as product_name,
      COALESCE(p_box.spec, p_item.spec) as product_spec,
      d.name as distributor_name, d.region as distributor_region,
      CASE WHEN s.item_code IS NOT NULL AND s.item_code != '' THEN 1 ELSE COALESCE(b.item_count, 0) END as product_qty,
      CASE WHEN s.item_code IS NOT NULL AND s.item_code != '' THEN 0 ELSE 1 END as box_qty
    FROM shipments s
    LEFT JOIN boxes b ON s.box_id = b.id
    LEFT JOIN items i ON s.item_code = i.item_code
    LEFT JOIN products p_box ON b.product_id = p_box.id
    LEFT JOIN products p_item ON i.product_id = p_item.id
    LEFT JOIN distributors d ON s.distributor_id = d.id
    ${brandFilter}
    ORDER BY s.shipped_at DESC
    LIMIT 500
  `).all(...params);

  // 以「产品名称」为主要登记依据，按 订单编号 + 产品 + 代理商 聚合成发货明细
  const groupsMap = new Map();
  for (const s of shipments) {
    const key = [
      s.order_no || '_无订单',
      s.product_name || '_未命名产品',
      s.distributor_name || '_无代理商',
      s.shipped_at || ''
    ].join('\u0001');
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        product_name: s.product_name || '',
        product_spec: s.product_spec || '',
        distributor_name: s.distributor_name || '',
        distributor_region: s.distributor_region || '',
        order_no: s.order_no || '',
        operator: s.operator || '',
        shipped_at: s.shipped_at || '',
        remark: s.remark || '',
        product_qty: 0,
        box_qty: 0,
        codes: []
      });
    }
    const g = groupsMap.get(key);
    g.product_qty += s.product_qty || 0;
    g.box_qty += s.box_qty || 0;
    if (s.item_code) g.codes.push({ code: s.item_code, type: 'item' });
    else if (s.box_code) g.codes.push({ code: s.box_code, type: 'box' });
  }
  const groups = Array.from(groupsMap.values());

  res.json({ success: true, shipments, groups });
});

// --- 消费者验证 ---

function normalizeLocation(value) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 120);
}

// IP → 地区（省级+市级），用于串货自动判定（消费者扫码时无需手动填位置）
// 使用 ip2region 离线库（本地 xdb 数据，覆盖国内 IP，无外部网络依赖，不会拖垮服务）
const ipRegionCache = new Map();
const IP_REGION_CACHE_MAX = 10000;

function ipToRegion(ip) {
  if (!ip) return '';
  const ipStr = String(ip).replace(/^::ffff:/, '').trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ipStr)) return '';
  if (/^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ipStr)) return '';
  if (ipRegionCache.has(ipStr)) return ipRegionCache.get(ipStr);
  let region = '';
  try {
    region = require('./ip2region').ipRegionName(ipStr);
  } catch (e) {
    region = '';
  }
  if (ipRegionCache.size >= IP_REGION_CACHE_MAX) ipRegionCache.clear();
  ipRegionCache.set(ipStr, region);
  return region;
}

function publicRegion(value) {
  const location = normalizeLocation(value);
  if (!location) return '';
  const province = location.match(/^(.{2,12}?(?:省|自治区|特别行政区))/);
  if (province) return province[1];
  const city = location.match(/^(.{2,8}?市)/);
  if (city) return city[1];
  return location.length <= 2 ? location : `${location.slice(0, 2)}***`;
}

const VERIFY_WINDOW_MS = 60 * 1000;
const VERIFY_MAX_ATTEMPTS = 60;
db.exec(`
  CREATE TABLE IF NOT EXISTS verification_rate_limits (
    source_hash TEXT PRIMARY KEY,
    attempt_count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_verification_rate_limits_reset_at ON verification_rate_limits(reset_at);
`);
const readVerificationLimit = db.prepare('SELECT attempt_count, reset_at FROM verification_rate_limits WHERE source_hash=?');
const writeVerificationLimit = db.prepare(`
  INSERT INTO verification_rate_limits (source_hash, attempt_count, reset_at, updated_at) VALUES (?, ?, ?, ?)
  ON CONFLICT(source_hash) DO UPDATE SET attempt_count=excluded.attempt_count, reset_at=excluded.reset_at, updated_at=excluded.updated_at
`);
const cleanupVerificationLimits = db.prepare('DELETE FROM verification_rate_limits WHERE reset_at<=?');
const recordVerificationAttempt = db.transaction((sourceHash, now) => {
  cleanupVerificationLimits.run(now);
  const current = readVerificationLimit.get(sourceHash);
  const attemptCount = current && current.reset_at > now ? current.attempt_count + 1 : 1;
  const resetAt = current && current.reset_at > now ? current.reset_at : now + VERIFY_WINDOW_MS;
  writeVerificationLimit.run(sourceHash, attemptCount, resetAt, now);
  return { attemptCount, resetAt };
});
function verificationRateLimit(req, res, next) {
  const now = Date.now();
  const sourceHash = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`verify:${String(req.ip || req.socket.remoteAddress || 'unknown')}`)
    .digest('hex');
  const limit = recordVerificationAttempt(sourceHash, now);
  if (limit.attemptCount > VERIFY_MAX_ATTEMPTS) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((limit.resetAt - now) / 1000))));
    return res.status(429).json({ success: false, code: 'VERIFY_RATE_LIMITED', msg: '查询过于频繁，请稍后再试' });
  }
  next();
}

// 验证码
app.get('/api/verify/:code', verificationRateLimit, wrap(async (req, res) => {
  const code = extractCode(req.params.code);
  const scanIp = req.ip || req.connection?.remoteAddress || '';
  const sourceId = scanSourceId(scanIp);
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const latitude = Number.isFinite(lat) && lat >= -90 && lat <= 90 ? lat : null;
  const longitude = Number.isFinite(lng) && lng >= -180 && lng <= 180 ? lng : null;

  // 串货判定位置：优先消费者主动填写的区域；为空时用 IP 自动定位（消费者无感）
  let scanLocation = normalizeLocation(req.query.location);
  if (!scanLocation) {
    scanLocation = ipToRegion(scanIp);
  }

  // 该码历史扫码信息（用于多次扫码提醒）
  const historyCount = db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE item_code=?').get(code).c;
  const firstScan = db.prepare(`
    SELECT scanned_at, scan_location FROM scan_logs
    WHERE item_code=? ORDER BY id ASC LIMIT 1
  `).get(code);

  // 先查箱码
  const brandName = db.prepare("SELECT value FROM settings WHERE key='brand_name'").get()?.value || '';
  let box = db.prepare(`
    SELECT b.*, p.name as product_name, p.spec as product_spec,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
      d.name as distributor_name, d.region as distributor_region, d.covered_regions as distributor_covered_regions
    FROM boxes b
    LEFT JOIN products p ON b.product_id = p.id
    LEFT JOIN brands br ON br.id = COALESCE(b.brand_id, p.brand_id)
    LEFT JOIN distributors d ON b.distributor_id = d.id
    WHERE b.box_code = ?
  `).get(code);

  if (box) {
    const publicContent = box.product_id && box.eff_brand_id ? productContent(box.product_id, box.eff_brand_id, box.batch_no, false) : { media: [], batch: null, trace: [], marketing: null };
    const itemSummary = db.prepare(`SELECT COUNT(*) as item_count,
      SUM(CASE WHEN status='scanned' THEN 1 ELSE 0 END) as verified_count FROM items WHERE box_id=?`).get(box.id);
    const isShipped = box.status === 'shipped';
    // 记录扫码日志（含分级 + 品牌归属）
    let isDiversion = 0;
    if (isShipped) {
      isDiversion = detectDiversion(box.distributor_region, scanLocation, box.distributor_covered_regions);
    }
    db.prepare(`INSERT INTO scan_logs (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, scan_ip, is_diversion, latitude, longitude, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, code, box.product_name, box.distributor_name || '', box.distributor_region || '', scanLocation, sourceId, isDiversion, latitude, longitude, box.eff_brand_id || null);
    // 串货预警：自动进入预警中心
    if (isDiversion > 0) {
      db.prepare(`INSERT INTO alerts (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, level, brand_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(code, code, box.product_name || '', box.distributor_name || '', box.distributor_region || '', scanLocation, isDiversion, box.eff_brand_id || null);
    }

    return res.json({
      success: true,
      type: 'box',
      brand_name: box.tenant_brand_name || brandName,
      product_name: box.product_name,
      product_spec: box.product_spec,
      batch_no: box.batch_no,
      status: box.status,
      status_text: isShipped ? '已发货' : '在库',
      assigned_region: publicRegion(box.distributor_region),
      is_diversion: isDiversion,
      scan_count: historyCount + 1,
      first_scanned_at: firstScan?.scanned_at || '',
      first_scan_region: publicRegion(firstScan?.scan_location),
      scan_region: publicRegion(scanLocation),
      item_count: Number(itemSummary.item_count) || 0,
      verified_count: Number(itemSummary.verified_count) || 0,
      created_at: box.created_at,
      shipped_at: box.shipped_at || ''
      ,...publicContentFields(publicContent)
      ,product_content: publicContent
    });
  }

  // 再查子码
  let item = db.prepare(`
    SELECT i.*, b.box_code, p.name as product_name, p.spec as product_spec,
      COALESCE(i.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
      d.name as distributor_name, d.region as distributor_region, d.covered_regions as distributor_covered_regions
    FROM items i
    LEFT JOIN boxes b ON i.box_id = b.id
    LEFT JOIN products p ON i.product_id = p.id
    LEFT JOIN brands br ON br.id = COALESCE(i.brand_id, p.brand_id)
    LEFT JOIN distributors d ON i.distributor_id = d.id
    WHERE i.item_code = ?
  `).get(code);

  if (item) {
    const publicContent = item.product_id && item.eff_brand_id ? productContent(item.product_id, item.eff_brand_id, item.batch_no, false) : { media: [], batch: null, trace: [], marketing: null };
    // 更新子码扫码状态
    db.prepare(`UPDATE items SET status=?, scanned_at=datetime('now','localtime'), scan_location=?, scan_ip=? WHERE id=?`)
      .run('scanned', scanLocation, sourceId, item.id);

    // 是否发货：只要绑定过代理商即视为已发货（避免被扫后状态变scanned导致串货检测失效）
    const isShipped = item.distributor_id != null;

    // 串货分级检测
    let isDiversion = 0;
    if (isShipped) {
      isDiversion = detectDiversion(item.distributor_region, scanLocation, item.distributor_covered_regions);
    }

    db.prepare(`INSERT INTO scan_logs (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, scan_ip, is_diversion, latitude, longitude, brand_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, item.box_code, item.product_name, item.distributor_name || '', item.distributor_region || '', scanLocation, sourceId, isDiversion, latitude, longitude, item.eff_brand_id || null);
    // 串货预警：自动进入预警中心
    if (isDiversion > 0) {
      db.prepare(`INSERT INTO alerts (item_code, box_code, product_name, distributor_name, assigned_region, scan_location, level, brand_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(code, item.box_code || '', item.product_name || '', item.distributor_name || '', item.distributor_region || '', scanLocation, isDiversion, item.eff_brand_id || null);
    }

    // 未绑定箱码的情况
    const isBound = !!item.box_code;

    // 扫码抽奖（仅已发货正品首次扫码参与）
    let prize = null;
    if (isBound && isShipped && historyCount === 0) {
      prize = drawPrize(code, scanLocation);
    }

    return res.json({
      success: true,
      type: 'item',
      brand_name: item.tenant_brand_name || brandName,
      product_name: item.product_name,
      product_spec: item.product_spec,
      batch_no: item.batch_no,
      status: 'scanned',
      status_text: !isBound ? '产品尚未出库，请联系厂家核实' : (isShipped ? '正品已验证' : '产品未发货，请联系厂家'),
      assigned_region: publicRegion(item.distributor_region),
      is_diversion: isDiversion,
      scan_count: historyCount + 1,
      first_scanned_at: firstScan?.scanned_at || '',
      first_scan_region: publicRegion(firstScan?.scan_location),
      scan_region: publicRegion(scanLocation),
      prize: prize,
      created_at: item.created_at,
      scanned_at: new Date().toLocaleString('zh-CN')
      ,...publicContentFields(publicContent)
      ,product_content: publicContent
    });
  }

  res.json({ success: false, msg: '溯源码不存在，请核实！' });
}));

// 动态生成二维码（用于入口二维码等）
app.get('/api/qr', requireLogin, wrap(async (req, res) => {
  const data = String(req.query.data || '');
  if (!data) return res.json({ success: false, msg: '缺少data参数' });
  if (data.length > 2048) return res.status(413).json({ success: false, code: 'QR_DATA_TOO_LARGE', msg: '二维码内容过长' });
  try {
    const buf = await QRCode.toBuffer(data, { width: 300, margin: 1 });
    res.type('png').send(buf);
  } catch (e) {
    res.status(500).json({ success: false, msg: '二维码生成失败' });
  }
}));

// --- 品牌设置 & 营销活动 API ---

// 读取品牌设置
app.get('/api/settings', requireRole('admin'), (req, res) => {
  const settings = readOnlyAccess.publicSettings(db.prepare('SELECT key, value FROM settings').all());
  res.json({ success: true, settings });
});

// 保存品牌设置
app.post('/api/settings', requireRole('admin'), (req, res) => {
  const { brand_name, brand_subtitle, logo_text, logo_image, welcome_msg, theme_color, contact_phone, product_images, promo_video, show_scan_count } = req.body;
  const isLocalUpload = value => !value || /^\/uploads\/[A-Za-z0-9._-]+$/.test(String(value));
  const imageList = String(product_images || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!isLocalUpload(logo_image) || !isLocalUpload(promo_video) || imageList.length > 6 || imageList.some(value => !isLocalUpload(value))) {
    return res.status(400).json({ success: false, code: 'INVALID_MEDIA_URL', msg: '品牌素材必须来自本系统上传且图片不能超过6张' });
  }
  const allowed = { brand_name, brand_subtitle, logo_text, logo_image, welcome_msg, theme_color, contact_phone, product_images, promo_video, show_scan_count };
  const upsert = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  for (const [k, v] of Object.entries(allowed)) {
    if (v !== undefined) upsert.run(k, String(v));
  }
  res.json({ success: true, msg: '品牌设置已保存' });
});

// --- 品牌素材上传（产品图片 / 宣传视频） ---

const uploadDir = path.join(__dirname, 'public', 'uploads');
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const extensions = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
      'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm',
      'video/quicktime': '.mov'
    };
    const ext = extensions[file.mimetype];
    if (!ext) return cb(new Error('不支持的文件类型'));
    cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`);
  }
});
const imageUpload = multer({
  storage: uploadStorage,
  limits: { files: 6, fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype))
});
const videoUpload = multer({
  storage: uploadStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(video\/mp4|video\/webm|video\/quicktime)$/.test(file.mimetype))
});
const productImageUpload = multer({
  storage: uploadStorage,
  limits: { files: 6, fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype))
});

function uploadMagicMatches(file) {
  const fd = fs.openSync(file.path, 'r');
  const head = Buffer.alloc(16);
  let bytesRead = 0;
  try { bytesRead = fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const data = head.subarray(0, bytesRead);
  const ascii = data.toString('ascii');
  const signatures = {
    'image/jpeg': () => data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
    'image/png': () => data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])),
    'image/gif': () => ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a'),
    'image/webp': () => ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP',
    'video/mp4': () => ascii.slice(4, 8) === 'ftyp',
    'video/quicktime': () => ascii.slice(4, 8) === 'ftyp',
    'video/webm': () => data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
  };
  return Boolean(signatures[file.mimetype]?.());
}
function removeUploadedFiles(files) {
  for (const file of files || []) {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

const PRODUCT_IMAGE_MAX_PIXELS = 40 * 1000 * 1000;
const PRODUCT_IMAGE_MAX_DIMENSION = 2400;
async function normalizeProductImage(file) {
  const outputName = `${Date.now()}-${crypto.randomBytes(12).toString('hex')}.webp`;
  const outputPath = path.join(uploadDir, outputName);
  try {
    const pipeline = sharp(file.path, { failOn: 'error', limitInputPixels: PRODUCT_IMAGE_MAX_PIXELS, sequentialRead: true });
    const metadata = await pipeline.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || !metadata.width || !metadata.height || metadata.width * metadata.height > PRODUCT_IMAGE_MAX_PIXELS) {
      const error = new Error('图片像素尺寸或解码格式不符合要求');
      error.code = 'INVALID_IMAGE_DIMENSIONS';
      throw error;
    }
    // rotate() 根据 EXIF 方向归正；不调用 withMetadata() 即移除 EXIF、GPS、ICC 等元数据。
    await pipeline.rotate().resize({
      width: PRODUCT_IMAGE_MAX_DIMENSION,
      height: PRODUCT_IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true
    }).webp({ quality: 82, effort: 4 }).toFile(outputPath);
    fs.chmodSync(outputPath, 0o640);
    return { path: outputPath, url: `/uploads/${outputName}` };
  } catch (error) {
    try { fs.unlinkSync(outputPath); } catch {}
    throw error;
  } finally {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

// 上传产品图片（多张，返回URL列表）
app.post('/api/upload/images', requireRole('admin'), (req, res) => {
  imageUpload.array('files', 6)(req, res, (err) => {
    if (err) {
      removeUploadedFiles(req.files);
      return res.json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过5MB' : '图片上传失败：' + err.message });
    }
    if (!req.files || req.files.length === 0) return res.json({ success: false, msg: '请选择图片文件（jpg/png/gif/webp）' });
    if (req.files.some(file => !uploadMagicMatches(file))) {
      removeUploadedFiles(req.files);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '图片内容与文件类型不一致' });
    }
    res.json({ success: true, urls: req.files.map(f => `/uploads/${f.filename}`) });
  });
});

// 上传宣传视频（单个）
app.post('/api/upload/video', requireRole('admin'), (req, res) => {
  videoUpload.single('file')(req, res, (err) => {
    if (err) {
      removeUploadedFiles(req.file ? [req.file] : []);
      return res.json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '视频不能超过100MB' : '视频上传失败：' + err.message });
    }
    if (!req.file) return res.json({ success: false, msg: '请选择视频文件' });
    if (!uploadMagicMatches(req.file)) {
      removeUploadedFiles([req.file]);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '视频内容与文件类型不一致' });
    }
    res.json({ success: true, url: `/uploads/${req.file.filename}` });
  });
});

// --- Excel 导出 ---

// 公共：生成并发送 xlsx
async function sendWorkbook(res, wb, filename) {
  const buf = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(Buffer.from(buf));
}
const diversionText = (v) => v >= 2 ? '重度串货(跨省)' : v === 1 ? '轻度串货' : '正常';

// 导出码表（箱码/子码，支持关键词；brand 只导自己品牌）
app.get('/api/export/codes', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const type = req.query.type === 'box' ? 'box' : 'item';
  const keyword = (req.query.keyword || '').trim();
  const scope = brandScope(req);
  const wb = new ExcelJS.Workbook();
  const today = new Date().toISOString().slice(0, 10);

  if (type === 'box') {
    const conds = [];
    const params = [];
    if (scope !== null) { conds.push('COALESCE(b.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT b.*, p.name as product_name, d.name as distributor_name, d.region as distributor_region,
        (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.status='scanned') as scanned_count
      FROM boxes b
      LEFT JOIN products p ON b.product_id = p.id
      LEFT JOIN distributors d ON b.distributor_id = d.id
      ${where} ORDER BY b.id DESC
    `).all(...params);
    const ws = wb.addWorksheet('箱码表');
    ws.columns = [
      { header: '箱码', key: 'c1', width: 24 }, { header: '产品', key: 'c2', width: 20 },
      { header: '批次号', key: 'c3', width: 14 }, { header: '箱内数量', key: 'c4', width: 10 },
      { header: '已扫码数', key: 'c5', width: 10 }, { header: '状态', key: 'c6', width: 10 },
      { header: '代理商', key: 'c7', width: 16 }, { header: '代理区域', key: 'c8', width: 16 },
      { header: '发货时间', key: 'c9', width: 20 }, { header: '创建时间', key: 'c10', width: 20 }
    ];
    rows.forEach(r => ws.addRow([r.box_code, r.product_name || '', r.batch_no || '', r.item_count, r.scanned_count || 0,
      r.status === 'shipped' ? '已发货' : '在库', r.distributor_name || '', r.distributor_region || '', r.shipped_at || '', r.created_at]));
    await sendWorkbook(res, wb, `箱码表-${today}.xlsx`);
  } else {
    const conds = [];
    const params = [];
    if (scope !== null) { conds.push('COALESCE(i.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = db.prepare(`
      SELECT i.*, p.name as product_name, b.box_code, d.name as distributor_name, d.region as distributor_region
      FROM items i
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN boxes b ON i.box_id = b.id
      LEFT JOIN distributors d ON i.distributor_id = d.id
      ${where} ORDER BY i.id DESC
    `).all(...params);
    const ws = wb.addWorksheet('子码表');
    ws.columns = [
      { header: '子码', key: 'c1', width: 24 }, { header: '所属箱码', key: 'c2', width: 24 },
      { header: '产品', key: 'c3', width: 20 }, { header: '批次号', key: 'c4', width: 14 },
      { header: '状态', key: 'c5', width: 10 }, { header: '代理商', key: 'c6', width: 16 },
      { header: '代理区域', key: 'c7', width: 16 }, { header: '发货时间', key: 'c8', width: 20 },
      { header: '扫码时间', key: 'c9', width: 20 }, { header: '创建时间', key: 'c10', width: 20 }
    ];
    rows.forEach(r => ws.addRow([r.item_code, r.box_code || '未绑定', r.product_name || '', r.batch_no || '',
      r.status === 'scanned' ? '已扫码' : r.status === 'shipped' ? '已发货' : '在库',
      r.distributor_name || '', r.distributor_region || '', r.shipped_at || '', r.scanned_at || '', r.created_at]));
    await sendWorkbook(res, wb, `子码表-${today}.xlsx`);
  }
}));

// ===================== 码包下载 / 批量打印 =====================

// 极简 ZIP 打包器（STORE 不压缩模式，零依赖；QR PNG 本身已压缩）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function buildZip(entries) { // entries: [{name, data:Buffer}]
  const parts = []; const central = []; let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 文件名标志
    local.writeUInt16LE(0, 8);           // STORE
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, e.data);
    central.push({ nameBuf, crc, size: e.data.length, offset });
    offset += 30 + nameBuf.length + e.data.length;
  }
  const centralParts = []; let centralSize = 0;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.size, 20); ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt32LE(c.offset, 42);
    centralParts.push(ch, c.nameBuf);
    centralSize += 46 + c.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...centralParts, end]);
}

// 构造箱/子码查询条件（码列表/码包/打印共用）
function buildCodeConds(type, scope, { keyword, status, ids } = {}) {
  const conds = []; const params = [];
  if (type === 'box') {
    if (scope !== null) { conds.push('COALESCE(b.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(b.box_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'shipped') conds.push("b.status='shipped'");
    else if (status === 'in_stock') conds.push("b.status='in_stock'");
    else if (status === 'invalid') conds.push("b.status='invalid'");
    if (ids && ids.length) { conds.push('b.id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
  } else {
    if (scope !== null) { conds.push('COALESCE(i.brand_id, p.brand_id)=?'); params.push(scope); }
    if (keyword) { conds.push('(i.item_code LIKE ? OR p.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`); }
    if (status === 'scanned') conds.push("i.status='scanned'");
    else if (status === 'shipped') conds.push("i.status='shipped'");
    else if (status === 'in_stock') conds.push("i.status='in_stock'");
    else if (status === 'invalid') conds.push("i.status='invalid'");
    if (ids && ids.length) { conds.push('i.id IN (' + ids.map(() => '?').join(',') + ')'); params.push(...ids); }
  }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params };
}

// 读取码的 QR 图（不存在则现场生成，保证老码也能出包）
async function getQrBuffer(code, width, baseUrl) {
  const qrPath = path.join(__dirname, 'public', 'qr', `${code}.png`);
  try { return fs.readFileSync(qrPath); } catch (e) {}
  const buf = await QRCode.toBuffer(`${baseUrl}/v/${code}`, { width, margin: 1 });
  try { fs.writeFileSync(qrPath, buf); } catch (e) {}
  return buf;
}
// XML 转义
function xmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 生成「二维码 + 品牌名 + 码值」标签 SVG（矢量图，印刷制版推荐用）
async function buildLabelSvg(code, brandName, isBox, baseUrl) {
  const url = `${baseUrl}/v/${code}`;
  let qrSvg = await QRCode.toString(url, { type: 'svg', margin: 0 });
  qrSvg = qrSvg.replace(/<\?xml[^>]*\?>\s*/i, '').trim();
  // 给内层 svg 加定位与尺寸（箱码大标签 260x340，子码 210x280）
  const W = isBox ? 260 : 210, QR = isBox ? 212 : 168, X = Math.round((W - QR) / 2), Y = 16;
  qrSvg = qrSvg.replace(/<svg /i, `<svg x="${X}" y="${Y}" width="${QR}" height="${QR}" `);
  const brand = brandName || '';
  const brandFs = isBox ? 30 : 24;
  const brandY = isBox ? 268 : 218;
  const codeY = isBox ? 308 : 252;
  const codeFs = isBox ? 17 : 14;
  const H = isBox ? 330 : 270;
  const brandText = brand
    ? `<text x="${W / 2}" y="${brandY}" text-anchor="middle" font-family="Microsoft YaHei, SimHei, sans-serif" font-size="${brandFs}" font-weight="bold" fill="#111">${xmlEsc(brand)}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
${qrSvg}
${brandText}
<text x="${W / 2}" y="${codeY}" text-anchor="middle" font-family="Consolas, monospace" font-size="${codeFs}" fill="#333">${xmlEsc(code)}</text>
</svg>`;
}

function scopedCodePackage(req, packageId) {
  const scope = brandScope(req);
  return scope === null
    ? db.prepare('SELECT * FROM code_packages WHERE id=?').get(packageId)
    : db.prepare('SELECT * FROM code_packages WHERE id=? AND brand_id=?').get(packageId, scope);
}

// 工厂 TXT：UTF-8、CRLF、一行一码。默认输出完整扫码链接，也可输出纯码值。
// 文件内容由 package_id 精确绑定，不受后续筛选条件或新增码影响。
app.get('/api/code-packages/:id/download', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const packageId = Number(req.params.id);
  if (!Number.isInteger(packageId) || packageId < 1) {
    return res.status(400).json({ success: false, code: 'PACKAGE_ID_INVALID', msg: '码包编号无效' });
  }
  const pkg = scopedCodePackage(req, packageId);
  if (!pkg) return res.status(404).json({ success: false, code: 'PACKAGE_NOT_FOUND', msg: '码包不存在或无权访问' });
  if (pkg.status !== 'ready') {
    return res.status(409).json({ success: false, code: 'PACKAGE_NOT_READY', msg: '码包尚未生成完成' });
  }
  const mode = req.query.mode === 'code' ? 'code' : 'url';
  const table = pkg.code_type === 'box' ? 'boxes' : 'items';
  const column = pkg.code_type === 'box' ? 'box_code' : 'item_code';
  const actual = db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE package_id=?`).get(packageId).c;
  if (actual !== pkg.quantity) {
    console.error(JSON.stringify({ level: 'error', event: 'code_package_count_mismatch', requestId: req.requestId, packageId, expected: pkg.quantity, actual }));
    return res.status(409).json({ success: false, code: 'PACKAGE_COUNT_MISMATCH', msg: '码包完整性校验失败，请联系平台管理员' });
  }

  const suffix = mode === 'code' ? '纯码值' : '扫码链接';
  const filename = `${pkg.code_type === 'box' ? '箱码' : '子码'}码包-${pkg.package_no}-${pkg.quantity}-${suffix}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Code-Package-No', pkg.package_no);
  res.setHeader('X-Code-Package-Count', String(pkg.quantity));

  res.on('finish', () => {
    try {
      db.prepare(`UPDATE code_packages SET download_count=download_count+1,last_downloaded_at=datetime('now','localtime') WHERE id=?`).run(packageId);
      logOperation(req, 'download_code_package', 'code_package', packageId,
        `下载码包 ${pkg.package_no}（${suffix} TXT，${pkg.quantity} 个）`);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', event: 'code_package_download_audit_failed', requestId: req.requestId, packageId, message: error.message }));
    }
  });
  const statement = db.prepare(`SELECT ${column} AS code FROM ${table} WHERE package_id=? ORDER BY id ASC`);
  for (const row of statement.iterate(packageId)) {
    const value = mode === 'code' ? row.code : `${pkg.base_url}/v/${row.code}`;
    res.write(value + '\r\n');
  }
  res.end();
});

// 码包下载：按筛选条件打包（QR PNG 每码一张 + 清单.csv），发印刷厂直接可用
app.get('/api/codes/package', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const type = req.query.type === 'box' ? 'box' : 'item';
  const keyword = (req.query.keyword || '').trim();
  const status = (req.query.status || '').trim();
  const ids = (req.query.ids || '').split(',').map(s => parseInt(s)).filter(n => Number.isInteger(n) && n > 0);
  const scope = brandScope(req);
  const baseUrl = getBaseUrl(req);
  const { where, params } = buildCodeConds(type, scope, { keyword, status, ids });

  const rows = type === 'box'
    ? db.prepare(`SELECT b.*, p.name as product_name, br.name as brand_name FROM boxes b LEFT JOIN products p ON b.product_id=p.id LEFT JOIN brands br ON br.id=COALESCE(b.brand_id,p.brand_id) ${where} ORDER BY b.id ASC LIMIT 5000`).all(...params)
    : db.prepare(`SELECT i.*, p.name as product_name, br.name as brand_name FROM items i LEFT JOIN products p ON i.product_id=p.id LEFT JOIN brands br ON br.id=COALESCE(i.brand_id,p.brand_id) ${where} ORDER BY i.id ASC LIMIT 5000`).all(...params);

  if (!rows.length) return res.json({ success: false, msg: '没有符合条件的码' });

  const entries = [];
  const csvLines = [type === 'box' ? '\uFEFF箱码,品牌,产品,批次号,数量,状态,创建时间' : '\uFEFF子码,品牌,产品,批次号,所属箱码,状态,创建时间'];
  for (const r of rows) {
    const code = r.box_code || r.item_code;
    const png = await getQrBuffer(code, type === 'box' ? 300 : 200, baseUrl);
    entries.push({ name: `${type === 'box' ? '箱码' : '子码'}/${code}.png`, data: png });
    // 带品牌名+码值的矢量标签（印刷制版推荐）
    const svg = await buildLabelSvg(code, r.brand_name || '', type === 'box', baseUrl);
    entries.push({ name: `带品牌标签/${code}.svg`, data: Buffer.from(svg, 'utf8') });
    const st = r.status === 'shipped' ? '已发货' : r.status === 'scanned' ? '已扫码' : r.status === 'invalid' ? '已作废' : '在库';
    if (type === 'box') {
      csvLines.push([code, r.brand_name || '', r.product_name || '未绑定', r.batch_no || '', r.item_count || 0, st, r.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    } else {
      let boxCode = '';
      if (r.box_id) boxCode = (db.prepare('SELECT box_code FROM boxes WHERE id=?').get(r.box_id) || {}).box_code || '';
      csvLines.push([code, r.brand_name || '', r.product_name || '未绑定', r.batch_no || '', boxCode, st, r.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    }
  }
  // 纯文本链接清单：每行一个扫码链接，对齐旧码包格式，工厂直接印刷用
  const urlLines = rows.map(r => {
    const code = r.box_code || r.item_code;
    return baseUrl + '/v/' + code;
  });
  entries.push({ name: '链接清单.txt', data: Buffer.from(urlLines.join('\r\n') + '\r\n', 'utf8') });

  entries.push({ name: '清单.csv', data: Buffer.from(csvLines.join('\r\n'), 'utf8') });
  entries.push({ name: '使用说明.txt', data: Buffer.from(
    `${type === 'box' ? '箱码' : '子码'}码包\r\n` +
    `共 ${rows.length} 个二维码。\r\n\r\n` +
    `【带品牌标签/】推荐使用：矢量 SVG 标签图（二维码+品牌名+码值），制版清晰无锯齿，可直接用于包装印刷。文件以码值命名（如 ABC123.svg）。\r\n` +
    `【${type === 'box' ? '箱码' : '子码'}/】纯二维码 PNG 图（${type === 'box' ? 300 : 200}x${type === 'box' ? 300 : 200}px），以码值命名，仅含二维码。\r\n` +
    `【链接清单.txt】纯文本、每行一个扫码链接（可直接复制给印刷厂制版二维码）。\r\n` +
    `【清单.csv】可用 Excel 打开核对（含品牌、产品、批次、状态）。\r\n` +
    `生成时间：${new Date().toLocaleString('zh-CN')}\r\n`, 'utf8') });

  const zip = buildZip(entries);
  const today = new Date().toISOString().slice(0, 10);
  const fname = `${type === 'box' ? '箱码' : '子码'}码包-${today}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(zip);
}));

// 导出扫码日志（brand 只导自己品牌）
app.get('/api/export/logs', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const scope = brandScope(req);
  const rows = scope === null
    ? db.prepare('SELECT * FROM scan_logs ORDER BY scanned_at DESC LIMIT 50000').all()
    : db.prepare('SELECT * FROM scan_logs WHERE brand_id=? ORDER BY scanned_at DESC LIMIT 50000').all(scope);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('扫码日志');
  ws.columns = [
    { header: '扫码时间', key: 'c1', width: 20 }, { header: '溯源码', key: 'c2', width: 24 },
    { header: '箱码', key: 'c3', width: 24 }, { header: '产品', key: 'c4', width: 20 },
    { header: '代理商', key: 'c5', width: 16 }, { header: '指定区域', key: 'c6', width: 16 },
    { header: '扫码位置', key: 'c7', width: 20 }, { header: '纬度', key: 'c8', width: 10 },
    { header: '经度', key: 'c9', width: 10 }, { header: '来源标识', key: 'c10', width: 22 },
    { header: '串货状态', key: 'c11', width: 16 }
  ];
  rows.forEach(r => ws.addRow([r.scanned_at, r.item_code, r.box_code || '', r.product_name || '', r.distributor_name || '',
    r.assigned_region || '', r.scan_location || '', r.latitude ?? '', r.longitude ?? '', displayScanSource(r.scan_ip), diversionText(r.is_diversion)]));
  const today = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, wb, `扫码日志-${today}.xlsx`);
}));

// 导出发货记录（brand 只导自己品牌）
app.get('/api/export/shipments', requireRole('admin', 'brand', 'brand_staff'), wrap(async (req, res) => {
  const scope = brandScope(req);
  const brandFilter = scope === null ? '' : ' WHERE COALESCE(p_box.brand_id, p_item.brand_id, d.brand_id)=?';
  const params = scope === null ? [] : [scope];
  const rows = db.prepare(`
    SELECT s.*,
      b.box_code, b.item_count,
      COALESCE(p_box.name, p_item.name) as product_name,
      COALESCE(p_box.spec, p_item.spec) as product_spec,
      d.name as distributor_name, d.region as distributor_region
    FROM shipments s
    LEFT JOIN boxes b ON s.box_id = b.id
    LEFT JOIN items i ON s.item_code = i.item_code
    LEFT JOIN products p_box ON b.product_id = p_box.id
    LEFT JOIN products p_item ON i.product_id = p_item.id
    LEFT JOIN distributors d ON s.distributor_id = d.id
    ${brandFilter}
    ORDER BY s.shipped_at DESC
    LIMIT 50000
  `).all(...params);

  // 以「产品名称」为主要登记依据，按 订单编号 + 产品 + 代理商 聚合成发货明细（保留码值追溯）
  const groupsMap = new Map();
  for (const r of rows) {
    const key = [r.order_no || '', r.product_name || '', r.distributor_name || '', r.shipped_at || ''].join('\u0001');
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        shipped_at: r.shipped_at, operator: r.operator || '', order_no: r.order_no || '',
        remark: r.remark || '', product_name: r.product_name || '', product_spec: r.product_spec || '',
        distributor_name: r.distributor_name || '', distributor_region: r.distributor_region || '',
        product_qty: 0, box_qty: 0, codes: []
      });
    }
    const g = groupsMap.get(key);
    g.product_qty += r.item_code ? 1 : (r.item_count || 0);
    g.box_qty += r.item_code ? 0 : 1;
    g.codes.push(r.item_code || r.box_code || '');
  }
  const groups = Array.from(groupsMap.values());

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('发货记录');
  ws.columns = [
    { header: '产品名称', key: 'c1', width: 22 }, { header: '产品件数', key: 'c2', width: 10 },
    { header: '箱数', key: 'c3', width: 8 }, { header: '订单编号', key: 'c4', width: 18 },
    { header: '代理商', key: 'c5', width: 16 }, { header: '区域', key: 'c6', width: 14 },
    { header: '操作人', key: 'c7', width: 12 }, { header: '发货时间', key: 'c8', width: 20 },
    { header: '备注', key: 'c9', width: 20 }, { header: '码值明细', key: 'c10', width: 40 }
  ];
  groups.forEach(g => ws.addRow([
    g.product_name + (g.product_spec ? '（' + g.product_spec + '）' : ''),
    g.product_qty, g.box_qty, g.order_no, g.distributor_name, g.distributor_region,
    g.operator, g.shipped_at, g.remark, g.codes.join('、')
  ]));
  const today = new Date().toISOString().slice(0, 10);
  await sendWorkbook(res, wb, `发货记录-${today}.xlsx`);
}));

// 获取营销活动列表
app.get('/api/campaigns', requireRole('admin'), (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all();
  res.json({ success: true, campaigns });
});

// 创建/更新营销活动
app.post('/api/campaigns', requireRole('admin'), (req, res) => {
  const { id, name, start_date, end_date, win_rate, prize_type, prize_name, prize_min, prize_max, enabled } = req.body;
  if (!name) return res.json({ success: false, msg: '请输入活动名称' });
  const rate = Math.min(Math.max(parseInt(win_rate) || 0, 0), 100);
  const min = parseFloat(prize_min) || 0;
  const max = parseFloat(prize_max) || 0;

  if (id) {
    db.prepare(`UPDATE campaigns SET name=?, start_date=?, end_date=?, win_rate=?, prize_type=?, prize_name=?, prize_min=?, prize_max=?, enabled=? WHERE id=?`)
      .run(name, start_date || '', end_date || '', rate, prize_type || 'thanks', prize_name || '', min, max, enabled ? 1 : 0, id);
    res.json({ success: true, msg: '活动已更新' });
  } else {
    const r = db.prepare(`INSERT INTO campaigns (name, start_date, end_date, win_rate, prize_type, prize_name, prize_min, prize_max, enabled)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(name, start_date || '', end_date || '', rate, prize_type || 'thanks', prize_name || '', min, max, enabled ? 1 : 0);
    res.json({ success: true, msg: '活动已创建', id: r.lastInsertRowid });
  }
});

// 启用/停用活动
app.post('/api/campaigns/:id/toggle', requireRole('admin'), (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id=?').get(req.params.id);
  if (!c) return res.json({ success: false, msg: '活动不存在' });
  db.prepare('UPDATE campaigns SET enabled=? WHERE id=?').run(c.enabled ? 0 : 1, c.id);
  res.json({ success: true, enabled: !c.enabled });
});

// 删除活动
app.delete('/api/campaigns/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM campaigns WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// 获取中奖记录
app.get('/api/prizes', requireRole('admin'), (req, res) => {
  const prizes = db.prepare(`
    SELECT p.*, c.name as campaign_name
    FROM prize_records p LEFT JOIN campaigns c ON p.campaign_id = c.id
    ORDER BY p.id DESC LIMIT 100
  `).all();
  res.json({ success: true, prizes });
});

// 省级关键词（供串货判定与多区域匹配复用）
const PROVINCE_KEYS = ['北京', '上海', '天津', '重庆', '黑龙江', '内蒙古', '新疆', '西藏', '广西', '宁夏',
  '河北', '山西', '辽宁', '吉林', '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '香港', '澳门'];

function getProvinceName(str) {
  const s = String(str || '').trim();
  for (const p of PROVINCE_KEYS) if (s.includes(p)) return p;
  const m = s.match(/([\u4e00-\u9fa5]{2})省/);
  return m ? m[1] : '';
}

// 串货分级检测：返回 0=正常 1=轻度(同省跨市) 2=重度(跨省)
// coveredRegionsJson 为代理商多区域覆盖（可选，JSON 数组 [{p:省, c:市}]），有值则按多区域判定
function detectDiversion(assignedRegion, scanLocation, coveredRegionsJson) {
  if (!scanLocation) return 0;
  const s = String(scanLocation).trim();

  // 多区域覆盖判定
  let regions = [];
  try { regions = JSON.parse(coveredRegionsJson || '[]'); } catch (e) { regions = []; }
  if (Array.isArray(regions) && regions.length) {
    const ps = getProvinceName(s);
    for (const r of regions) {
      const rp = getProvinceName(r && r.p || '');
      if (!rp || rp !== ps) continue;          // 省不同 → 继续下一个区域
      if (!r.c) return 0;                       // 覆盖全省 → 正常
      const rc = String(r.c || '').replace(/市|地区|自治州|盟/g, '');
      if (rc && s.includes(rc)) return 0;       // 覆盖某市且城市匹配 → 正常
    }
    // 所有覆盖区域都不匹配 → 串货：同省跨市=轻度，跨省=重度
    const sameProvince = regions.some(r => r && r.p && getProvinceName(r.p) === ps);
    return sameProvince ? 1 : 2;
  }

  // 回退：单区域（旧逻辑）
  if (!assignedRegion) return 0;
  const a = String(assignedRegion).trim();
  if (a.includes(s) || s.includes(a)) return 0;
  const pa = getProvinceName(a), ps2 = getProvinceName(s);
  if (pa && ps2 && pa !== ps2) return 2;
  return 1;
}

// 扫码抽奖：在有效启用活动中抽一次
function drawPrize(code, scanLocation) {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(0, 10);
  const campaign = db.prepare(`
    SELECT * FROM campaigns WHERE enabled=1 AND start_date<=? AND end_date>=?
    ORDER BY id DESC LIMIT 1
  `).get(today, now);
  if (!campaign) return null;

  // 该码是否已中过奖
  const already = db.prepare('SELECT 1 FROM prize_records WHERE item_code=? AND campaign_id=?').get(code, campaign.id);
  if (already) return null;

  const roll = Math.random() * 100;
  if (roll > campaign.win_rate) return null;

  let prizeValue = '';
  if (campaign.prize_type === 'red_packet') {
    const v = campaign.prize_max > campaign.prize_min
      ? (campaign.prize_min + Math.random() * (campaign.prize_max - campaign.prize_min)).toFixed(2)
      : campaign.prize_min.toFixed(2);
    prizeValue = v;
  } else if (campaign.prize_type === 'coupon') {
    prizeValue = campaign.prize_min > 0 ? `${campaign.prize_min}元` : campaign.prize_name;
  }

  db.prepare(`INSERT INTO prize_records (item_code, campaign_id, prize_type, prize_name, prize_value, scan_location)
    VALUES (?,?,?,?,?,?)`).run(code, campaign.id, campaign.prize_type, campaign.prize_name || '', prizeValue, scanLocation);

  return {
    prize_type: campaign.prize_type,
    prize_name: campaign.prize_name || '',
    prize_value: prizeValue,
    campaign_name: campaign.name
  };
}

// ===================== 串货预警中心 =====================

// 预警列表页（brand 只看自己品牌）
app.get('/alerts', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const alerts = scope === null
    ? db.prepare('SELECT * FROM alerts ORDER BY handled ASC, id DESC LIMIT 500').all()
    : db.prepare('SELECT * FROM alerts WHERE brand_id=? ORDER BY handled ASC, id DESC LIMIT 500').all(scope);
  res.render('alerts', { alerts });
});

// 预警列表 API（brand 只看自己品牌）
app.get('/api/alerts', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const alerts = scope === null
    ? db.prepare('SELECT * FROM alerts ORDER BY handled ASC, id DESC LIMIT 500').all()
    : db.prepare('SELECT * FROM alerts WHERE brand_id=? ORDER BY handled ASC, id DESC LIMIT 500').all(scope);
  const unread = scope === null
    ? db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0').get().c
    : db.prepare('SELECT COUNT(*) as c FROM alerts WHERE handled=0 AND brand_id=?').get(scope).c;
  res.json({ success: true, alerts, unread });
});

// 品牌方扫码查串货：扫码/输码查询自己品牌码的串货状态与历史扫码记录
app.get('/api/brand/check-code/:code', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const code = extractCode(req.params.code);
  if (!code) return res.json({ success: false, msg: '请输入溯源码' });
  const scope = brandScope(req);

  // 查箱码
  let target = null, codeType = '';
  const box = db.prepare(`
    SELECT b.*, p.name as product_name, p.spec as product_spec,
      COALESCE(b.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
      d.name as distributor_name, d.region as distributor_region
    FROM boxes b
    LEFT JOIN products p ON b.product_id = p.id
    LEFT JOIN brands br ON br.id = COALESCE(b.brand_id, p.brand_id)
    LEFT JOIN distributors d ON b.distributor_id = d.id
    WHERE b.box_code = ?
  `).get(code);
  if (box) { codeType = 'box'; target = box; }
  else {
    const item = db.prepare(`
      SELECT i.*, b.box_code, p.name as product_name, p.spec as product_spec,
        COALESCE(i.brand_id, p.brand_id) as eff_brand_id, br.name as tenant_brand_name,
        d.name as distributor_name, d.region as distributor_region
      FROM items i
      LEFT JOIN boxes b ON i.box_id = b.id
      LEFT JOIN products p ON i.product_id = p.id
      LEFT JOIN brands br ON br.id = COALESCE(i.brand_id, p.brand_id)
      LEFT JOIN distributors d ON i.distributor_id = d.id
      WHERE i.item_code = ?
    `).get(code);
    if (item) { codeType = 'item'; target = item; }
  }

  if (!target) return res.json({ success: false, msg: '溯源码不存在' });

  // 品牌权限校验：只能查自己品牌的码（admin 可查全部）
  if (!brandAllowed(scope, target.eff_brand_id)) {
    return res.status(403).json({ success: false, code: 'NOT_YOUR_BRAND', msg: '该溯源码不属于你的品牌，无权查询' });
  }

  // 该码历史扫码记录（含串货标记）
  const scanLogs = db.prepare(`
    SELECT scan_location, is_diversion, scanned_at
    FROM scan_logs WHERE item_code=? OR box_code=?
    ORDER BY id DESC LIMIT 200
  `).all(code, code);

  const diversionLogs = scanLogs.filter(l => l.is_diversion > 0);
  const maxDiversion = diversionLogs.length ? Math.max(...diversionLogs.map(l => l.is_diversion)) : 0;

  logOperation(req, 'brand_check_diversion', codeType, code, `查询溯源码${code}串货状态`);

  res.json({
    success: true,
    code_type: codeType,
    code: code,
    box_code: codeType === 'box' ? target.box_code : (target.box_code || ''),
    item_code: codeType === 'item' ? target.item_code : '',
    product_name: target.product_name || '',
    product_spec: target.product_spec || '',
    batch_no: target.batch_no || '',
    distributor_name: target.distributor_name || '',
    assigned_region: publicRegion(target.distributor_region),
    brand_name: target.tenant_brand_name || '',
    has_diversion: maxDiversion > 0,
    diversion_level: maxDiversion,
    scan_logs: scanLogs.map(l => ({
      location: l.scan_location || '',
      is_diversion: l.is_diversion,
      scanned_at: l.scanned_at || ''
    }))
  });
});

// 扫码地域分布（全国地图）：按省份聚合扫码数与串货数
app.get('/api/alerts/geo-map', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const rows = scope === null
    ? db.prepare('SELECT scan_location, latitude, longitude, is_diversion FROM scan_logs').all()
    : db.prepare('SELECT scan_location, latitude, longitude, is_diversion FROM scan_logs WHERE brand_id=?').all(scope);

  // 省份关键词 → 标准省名（覆盖 31 省级行政区）
  const PROVINCES = [
    '北京','天津','上海','重庆','河北','山西','辽宁','吉林','黑龙江','江苏','浙江','安徽','福建','江西','山东','河南','湖北','湖南','广东','海南','四川','贵州','云南','陕西','甘肃','青海','内蒙古','广西','西藏','宁夏','新疆','香港','澳门','台湾'
  ];
  function extractProvince(loc) {
    if (!loc) return null;
    const l = String(loc).trim();
    for (const p of PROVINCES) {
      if (l.includes(p)) return p;
    }
    return null;
  }

  const agg = {}; // province -> { total, diversion, points: [{name, value}] }
  rows.forEach(r => {
    const prov = extractProvince(r.scan_location);
    if (!prov) return;
    if (!agg[prov]) agg[prov] = { total: 0, diversion: 0, points: [] };
    agg[prov].total += 1;
    if (r.is_diversion) agg[prov].diversion += 1;
    // 有经纬度的点，用于地图上的散点定位
    if (r.latitude != null && r.longitude != null) {
      agg[prov].points.push({ name: r.scan_location || prov, value: [Number(r.longitude), Number(r.latitude)] });
    }
  });

  const list = Object.keys(agg).map(prov => ({
    name: prov,
    total: agg[prov].total,
    diversion: agg[prov].diversion,
    points: agg[prov].points
  }));

  res.json({ success: true, list, total: rows.length });
});

// 标记已处理
app.post('/api/alerts/:id/handle', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  const a = db.prepare('SELECT * FROM alerts WHERE id=?').get(req.params.id);
  if (!a) return res.json({ success: false, msg: '预警不存在' });
  if (!brandAllowed(scope, a.brand_id)) return res.json({ success: false, msg: '没有权限处理该预警' });
  db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});
// 全部标记已处理（brand 只处理自己品牌的）
app.post('/api/alerts/handle-all', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  if (scope === null) {
    db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE handled=0`).run();
  } else {
    db.prepare(`UPDATE alerts SET handled=1, handled_at=datetime('now','localtime') WHERE handled=0 AND brand_id=?`).run(scope);
  }
  res.json({ success: true });
});

// 删除预警仅限平台/品牌管理员；删除动作保留审计记录。
app.delete('/api/alerts/:id', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const alert = db.prepare('SELECT * FROM alerts WHERE id=?').get(req.params.id);
  if (!alert || !brandAllowed(scope, alert.brand_id)) return res.status(404).json({ success: false, msg: '预警不存在' });
  db.prepare('DELETE FROM alerts WHERE id=?').run(alert.id);
  logOperation(req, 'delete_alert', 'alert', alert.id, `删除预警：${alert.item_code || '未知溯源码'}，级别 ${alert.level || 1}`);
  res.json({ success: true });
});

// ===================== 账号管理（admin） =====================

// 账号管理页（admin 看全部；brand 只看自己品牌的账号，不能管理 admin/brand 角色）
app.get('/users', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const baseUserSql = `
    SELECT u.id, u.username, u.display_name, u.phone, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled, u.created_at, u.last_login_at,
      d.name as distributor_name, f.name as factory_name, b.name as brand_name
    FROM users u
    LEFT JOIN distributors d ON u.distributor_id = d.id
    LEFT JOIN factories f ON u.factory_id = f.id
    LEFT JOIN brands b ON u.brand_id = b.id
  `;
  const users = scope === null
    ? db.prepare(baseUserSql + ' ORDER BY u.id').all()
    : db.prepare(baseUserSql + ' WHERE u.brand_id=? ORDER BY u.id').all(scope);
  const distributors = scope === null
    ? db.prepare('SELECT id, name, region FROM distributors ORDER BY id DESC').all()
    : db.prepare('SELECT id, name, region FROM distributors WHERE brand_id=? ORDER BY id DESC').all(scope);
  const factories = scope === null
    ? db.prepare('SELECT id, name FROM factories ORDER BY id DESC').all()
    : db.prepare('SELECT id, name FROM factories WHERE brand_id=? ORDER BY id DESC').all(scope);
  const invitations = scope === null
    ? db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        ORDER BY i.id DESC LIMIT 200
      `).all()
    : db.prepare(`
        SELECT i.id, i.code, i.role, i.note, i.status, i.used_by, i.used_at, i.created_at, b.name as brand_name, f.name as factory_name, u.display_name as user_name
        FROM invitations i LEFT JOIN brands b ON i.brand_id=b.id LEFT JOIN factories f ON i.factory_id=f.id LEFT JOIN users u ON i.used_by = u.username
        WHERE i.brand_id=? ORDER BY i.id DESC LIMIT 200
      `).all(scope);
  const brands = scope === null
    ? db.prepare('SELECT id, name, contact, enabled, created_at FROM brands ORDER BY id').all()
    : [];
  res.render('users', { users, distributors, factories, invitations: currentUser(req).role === readOnlyAccess.ROLE ? invitations.map(row => ({...row,code:'仅管理员可见'})) : invitations, brands, roleNames: ROLE_NAMES });
});

// 账号列表（同页面过滤规则）
app.get('/api/users', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const baseUserSql = `
    SELECT u.id, u.username, u.display_name, u.phone, u.role, u.distributor_id, u.factory_id, u.brand_id, u.enabled, u.created_at, u.last_login_at,
      d.name as distributor_name, f.name as factory_name, b.name as brand_name
    FROM users u
    LEFT JOIN distributors d ON u.distributor_id = d.id
    LEFT JOIN factories f ON u.factory_id = f.id
    LEFT JOIN brands b ON u.brand_id = b.id
  `;
  const users = scope === null
    ? db.prepare(baseUserSql + ' ORDER BY u.id').all()
    : db.prepare(baseUserSql + ' WHERE u.brand_id=? ORDER BY u.id').all(scope);
  res.json({ success: true, users });
});

// 新建账号（admin 可建任意角色并指定品牌；brand 只能建本品牌的工厂/代理商/品牌方账号）
app.post('/api/users', requireRole('admin', 'brand'), (req, res) => {
  const { username, password, display_name, role, distributor_id, factory_id } = req.body;
  const phone = String(req.body.phone || '').trim();
  const scope = brandScope(req);
  const uname = String(username || '').trim();
  if (!uname || !password) return res.json({ success: false, msg: '账号和密码不能为空' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname)) return res.json({ success: false, msg: '账号需为3-20位字母/数字/下划线' });
  if (!passwordMeetsPolicy(password)) return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
  if (!ROLE_NAMES[role]) return res.json({ success: false, msg: '角色不合法' });
  if (scope !== null && !['factory', 'warehouse', 'distributor', 'brand_staff'].includes(role)) {
    return res.json({ success: false, msg: '品牌方只能创建工厂装箱/仓库/代理商/品牌工作账号' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(uname)) return res.json({ success: false, msg: '该账号已存在' });
  // 品牌归属：brand 固定自己品牌；admin 按表单选择或从所绑实体带出
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (['brand', 'brand_staff', 'warehouse'].includes(role) && !brand_id) return res.json({ success: false, msg: '品牌方账号必须指定所属品牌' });
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  if (role === 'distributor') {
    if (!distributor_id) return res.json({ success: false, msg: '代理商账号必须绑定代理商' });
    const d = db.prepare('SELECT * FROM distributors WHERE id=?').get(distributor_id);
    if (!d) return res.json({ success: false, msg: '代理商不存在' });
    if (!brandAllowed(scope, d.brand_id)) return res.json({ success: false, msg: '该代理商不属于你的品牌' });
    brand_id = d.brand_id || brand_id;
  }
  if (role === 'factory') {
    // 工厂端装箱子账号：人名 + 11位手机号 + 绑定工厂 三项必填
    if (!String(display_name || '').trim()) return res.json({ success: false, msg: '工厂账号必须填写人名' });
    if (!/^1\d{10}$/.test(phone)) return res.json({ success: false, msg: '工厂账号必须填写11位手机号' });
    if (!factory_id) return res.json({ success: false, msg: '工厂账号必须绑定工厂' });
    const f = db.prepare('SELECT * FROM factories WHERE id=?').get(factory_id);
    if (!f) return res.json({ success: false, msg: '工厂不存在' });
    if (!brandAllowed(scope, f.brand_id)) return res.json({ success: false, msg: '该工厂不属于你的品牌' });
    brand_id = f.brand_id || brand_id;
  }
  db.prepare('INSERT INTO users (username, password_hash, display_name, phone, role, distributor_id, factory_id, brand_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(uname, hashPassword(password), String(display_name || '').trim(), phone, role,
      role === 'distributor' ? distributor_id : null,
      role === 'factory' ? factory_id : null,
      brand_id || null);
  logOperation(req, 'create_user', 'user', uname, `账号「${uname}」（${ROLE_NAMES[role]}）已创建`);
  res.json({ success: true, msg: '账号已创建' });
});

// 工厂列表/新建（admin 手动管理工厂实体；brand 只能看/建自己品牌的工厂）
app.get('/api/factories', requireRole('admin', 'brand'), (req, res) => {
  const scope = brandScope(req);
  const factories = scope === null
    ? db.prepare('SELECT f.id, f.name, f.contact, f.created_at, b.name as brand_name FROM factories f LEFT JOIN brands b ON f.brand_id=b.id ORDER BY f.id DESC').all()
    : db.prepare('SELECT f.id, f.name, f.contact, f.created_at, b.name as brand_name FROM factories f LEFT JOIN brands b ON f.brand_id=b.id WHERE f.brand_id=? ORDER BY f.id DESC').all(scope);
  res.json({ success: true, factories });
});
app.post('/api/factories', requireRole('admin', 'brand'), (req, res) => {
  const name = String(req.body.name || '').trim();
  const contact = String(req.body.contact || '').trim();
  const scope = brandScope(req);
  if (!name) return res.json({ success: false, msg: '工厂名称不能为空' });
  let brand_id = scope !== null ? scope : (parseInt(req.body.brand_id) || null);
  if (brand_id && !db.prepare('SELECT 1 FROM brands WHERE id=? AND enabled=1').get(brand_id)) {
    return res.json({ success: false, msg: '所选品牌不存在或已停用' });
  }
  const r = db.prepare('INSERT INTO factories (name, contact, brand_id) VALUES (?,?,?)').run(name, contact, brand_id || null);
  res.json({ success: true, id: r.lastInsertRowid, msg: '工厂已创建' });
});

// 删除工厂（admin/brand/brand_staff）：
//   有账号绑定的工厂必须先解绑；箱码和子码通过产品关联工厂，不直接保存 factory_id。
app.delete('/api/factories/:id', requireRole('admin', 'brand'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json({ success: false, msg: '工厂不存在' });
  const f = db.prepare('SELECT * FROM factories WHERE id=?').get(id);
  if (!f) return res.json({ success: false, msg: '工厂不存在' });
  if (!brandAllowed(brandScope(req), f.brand_id)) return res.json({ success: false, msg: '没有权限操作该工厂' });
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users WHERE factory_id=?').get(id).c;
  if (userCount > 0) {
    return res.json({ success: false, msg: `该工厂下还有 ${userCount} 个账号，请先到账号管理中解除绑定后再删除` });
  }
  const productCount = db.prepare('SELECT COUNT(*) as c FROM products WHERE factory_id=?').get(id).c;
  const boxCount = db.prepare('SELECT COUNT(*) as c FROM boxes b JOIN products p ON p.id=b.product_id WHERE p.factory_id=?').get(id).c;
  const itemCount = db.prepare('SELECT COUNT(*) as c FROM items i JOIN products p ON p.id=i.product_id WHERE p.factory_id=?').get(id).c;
  const tx = db.transaction(() => {
    if (productCount > 0) db.prepare('UPDATE products SET factory_id=NULL WHERE factory_id=?').run(id);
    db.prepare('DELETE FROM factories WHERE id=?').run(id);
  });
  tx();
  logOperation(req, 'delete_factory', 'factory', id, `工厂「${f.name}」已删除（清理 ${productCount} 产品/${boxCount} 箱码/${itemCount} 子码的归属）`);
  res.json({ success: true, msg: `工厂「${f.name}」已删除` });
});

// 修改账号（重置密码 / 启停 / 改角色；brand 只能操作本品牌账号且不能改成 admin/brand）
app.put('/api/users/:id', requireRole('admin', 'brand'), (req, res) => {
  const id = req.params.id;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!user) return res.json({ success: false, msg: '账号不存在' });
  const scope = brandScope(req);
  if (!brandAllowed(scope, user.brand_id)) return res.json({ success: false, msg: '没有权限操作该账号' });
  const { password, display_name, role, distributor_id, factory_id, enabled, brand_id } = req.body;
  const phone = String(req.body.phone || '').trim();
  if (password !== undefined && String(password).length > 0) {
    if (!passwordMeetsPolicy(password)) return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(password), id);
  }
  if (display_name !== undefined) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(String(display_name).trim(), id);
  if (req.body.phone !== undefined) {
    // 工厂账号编辑时手机号同样必填且格式校验
    const targetRole = role !== undefined && ROLE_NAMES[role] ? role : user.role;
    if (targetRole === 'factory' && !/^1\d{10}$/.test(phone)) {
      return res.json({ success: false, msg: '工厂账号必须填写11位手机号' });
    }
    db.prepare('UPDATE users SET phone=? WHERE id=?').run(phone, id);
  }
  if (role !== undefined && ROLE_NAMES[role]) {
    // 品牌管理员编辑平台/品牌管理员账号：角色保持不变（无权修改），仅允许改姓名/密码/启停
    const keepRole = scope !== null && ['admin', 'brand'].includes(user.role);
    const newRole = keepRole ? user.role : role;
    if (user.username === 'admin' && newRole !== 'admin') return res.json({ success: false, msg: '内置 admin 账号不能降级' });
    if (scope !== null && !['factory', 'warehouse', 'distributor'].includes(newRole)) {
      return res.json({ success: false, msg: '品牌管理员不能设置该角色' });
    }
    if (newRole === 'distributor' && !distributor_id && user.distributor_id === null) {
      return res.json({ success: false, msg: '代理商账号必须绑定代理商' });
    }
    if (newRole === 'factory' && !factory_id && user.factory_id === null) {
      return res.json({ success: false, msg: '工厂账号必须绑定工厂' });
    }
    // 品牌归属：admin 可为品牌管理员改绑品牌；工厂/代理商账号从所绑实体带出
    let newBrandId = user.brand_id;
    if (['brand', 'brand_staff', 'warehouse'].includes(newRole)) {
      if (scope === null && brand_id !== undefined && brand_id !== null) {
        const b = db.prepare('SELECT id FROM brands WHERE id=?').get(brand_id);
        if (!b) return res.json({ success: false, msg: '品牌不存在' });
        newBrandId = b.id;
      }
      if (!newBrandId) return res.json({ success: false, msg: '品牌方账号必须绑定品牌' });
    } else if (newRole === 'distributor' && (distributor_id || user.distributor_id)) {
      const d = db.prepare('SELECT brand_id FROM distributors WHERE id=?').get(distributor_id || user.distributor_id);
      if (d && d.brand_id) newBrandId = d.brand_id;
    } else if (newRole === 'factory' && (factory_id || user.factory_id)) {
      const f = db.prepare('SELECT brand_id FROM factories WHERE id=?').get(factory_id || user.factory_id);
      if (f && f.brand_id) newBrandId = f.brand_id;
    } else if (newRole === 'admin') {
      newBrandId = null;
    }
    db.prepare('UPDATE users SET role=?, distributor_id=?, factory_id=?, brand_id=? WHERE id=?')
      .run(newRole,
        newRole === 'distributor' ? (distributor_id || user.distributor_id) : null,
        newRole === 'factory' ? (factory_id || user.factory_id) : null,
        newBrandId,
        id);
  }
  if (enabled !== undefined) {
    if (user.username === 'admin' && !enabled) return res.json({ success: false, msg: '内置 admin 账号不能停用' });
    db.prepare('UPDATE users SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
  }
  res.json({ success: true, msg: '账号已更新' });
});

// 删除账号
app.delete('/api/users/:id', requireRole('admin', 'brand'), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.json({ success: false, msg: '账号不存在' });
  if (user.username === 'admin') return res.json({ success: false, msg: '内置 admin 账号不能删除' });
  if (!brandAllowed(brandScope(req), user.brand_id)) return res.json({ success: false, msg: '没有权限删除该账号' });
  db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  res.json({ success: true, msg: '账号已删除' });
});

// ===================== 个人资料 / 修改密码 =====================

app.get('/profile', requireLogin, (req, res) => {
  res.render('profile', { user: req.session.user, roleNames: ROLE_NAMES });
});

app.post('/api/profile/password', requireLogin, (req, res) => {
  const { old_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  if (!user || !verifyPassword(String(old_password || ''), user.password_hash)) {
    return res.json({ success: false, msg: '原密码错误' });
  }
  if (!passwordMeetsPolicy(new_password)) return res.json({ success: false, msg: PASSWORD_POLICY_MESSAGE });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(new_password), user.id);
  res.json({ success: true, msg: '密码已修改' });
});

// ===================== 代理商自助端 =====================

app.get('/portal', requireRole('distributor', 'admin', 'brand'), (req, res) => {
  // admin/brand 可带 ?distributor_id= 查看任意代理商视角（brand 限本品牌）
  const scope = brandScope(req);
  const did = req.session.user.role === 'distributor'
    ? req.session.user.distributor_id
    : (parseInt(req.query.distributor_id) || null);
  if (!did) return res.status(400).send('缺少代理商参数，<a href="/distributors">返回代理商管理</a>');
  const distributor = db.prepare('SELECT * FROM distributors WHERE id=?').get(did);
  if (!distributor) return res.status(404).send('代理商不存在');
  if (!brandAllowed(scope, distributor.brand_id)) return res.status(403).send('该代理商不属于你的品牌');

  const stats = {
    boxes: db.prepare('SELECT COUNT(*) as c FROM boxes WHERE distributor_id=?').get(did).c,
    items: db.prepare('SELECT COUNT(*) as c FROM items WHERE distributor_id=?').get(did).c,
    scanned: db.prepare("SELECT COUNT(*) as c FROM items WHERE distributor_id=? AND status='scanned'").get(did).c,
    diversions: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 AND distributor_name=?').get(distributor.name).c
  };
  const boxes = db.prepare(`
    SELECT b.*, p.name as product_name,
      (SELECT COUNT(*) FROM items i WHERE i.box_id=b.id AND i.status='scanned') as scanned_count
    FROM boxes b LEFT JOIN products p ON b.product_id=p.id
    WHERE b.distributor_id=? ORDER BY b.shipped_at DESC LIMIT 200
  `).all(did);
  const scans = db.prepare(`
    SELECT * FROM scan_logs WHERE distributor_name=? ORDER BY id DESC LIMIT 100
  `).all(distributor.name);
  res.render('portal', { distributor, stats, boxes, scans, isSelf: req.session.user.role === 'distributor' });
});

// ===================== 数据库备份 =====================

const backupDir = path.join(__dirname, 'data', 'backups');
function secureBackupDirectory() {
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
}

// 立即备份并下载（admin，POST 防止跨站 GET 触发写入）
app.post('/api/backup/download', requireRole('admin'), wrap(async (req, res) => {
  secureBackupDirectory();
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(backupDir, `traceability-${stamp}.db`);
  await db.backup(file);
  fs.chmodSync(file, 0o600);
  res.download(file, `溯源系统备份-${stamp}.db`, (err) => {
    if (err && !res.headersSent) res.status(500).json({ success: false, msg: '备份下载失败' });
  });
}));
app.get('/api/backup/download', requireRole('admin'), (req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ success: false, code: 'METHOD_NOT_ALLOWED', msg: '请使用备份按钮创建备份' });
});

// 产品授权上传：只允许产品所属租户的管理角色上传，文件随后需通过 media 接口绑定。
app.post('/api/products/:id/upload-images', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  productImageUpload.array('files', 6)(req, res, async err => {
    if (err) {
      removeUploadedFiles(req.files);
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过5MB' : `图片上传失败：${err.message}` });
    }
    if (!req.files?.length) return res.status(400).json({ success: false, msg: '请选择 JPEG、PNG 或 WebP 图片' });
    if (req.files.some(file => !uploadMagicMatches(file))) {
      removeUploadedFiles(req.files);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '图片内容与文件类型不一致' });
    }
    const normalized = [];
    try {
      for (const file of req.files) normalized.push(await normalizeProductImage(file));
    } catch (error) {
      removeUploadedFiles(normalized);
      removeUploadedFiles(req.files);
      const pixels = error.code === 'INVALID_IMAGE_DIMENSIONS' || /pixel|dimension|Input image exceeds/i.test(error.message);
      return res.status(422).json({ success: false, code: pixels ? 'IMAGE_PIXEL_LIMIT' : 'IMAGE_DECODE_FAILED', msg: pixels ? '图片像素不能超过4000万且尺寸必须有效' : '图片解码或规范化失败' });
    }
    logOperation(req, 'upload_product_media', 'product', product.id, `上传并规范化产品图片 ${normalized.length} 张`);
    res.status(201).json({ success: true, urls: normalized.map(file => file.url), format: 'webp', max_dimension: PRODUCT_IMAGE_MAX_DIMENSION });
  });
});

// ===== 检测报告（按产品挂报告图片，消费者验证页展示） =====

// 列出产品的检测报告（含空批次）
app.get('/api/products/:id/reports', requireRole('admin', 'brand', 'brand_staff', 'factory'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const reports = db.prepare('SELECT id, batch_no, url, title, created_at FROM product_reports WHERE brand_id=? AND product_id=? ORDER BY batch_no DESC, sort_order, id').all(product.brand_id, product.id);
  res.json({ success: true, reports });
});

// 上传检测报告图片（复用产品图片上传的规范化）
app.post('/api/products/:id/reports', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const product = scopedProduct(req, req.params.id);
  if (!product) return res.status(404).json({ success: false, msg: '产品不存在' });
  const batch_no = cleanText(req.body.batch_no || req.query.batch_no, 64) || '';
  productImageUpload.array('files', 9)(req, res, async err => {
    if (err) {
      removeUploadedFiles(req.files);
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, msg: err.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过5MB' : `报告上传失败：${err.message}` });
    }
    if (!req.files?.length) return res.status(400).json({ success: false, msg: '请选择 JPEG、PNG 或 WebP 图片' });
    if (req.files.some(file => !uploadMagicMatches(file))) {
      removeUploadedFiles(req.files);
      return res.status(415).json({ success: false, code: 'INVALID_FILE_CONTENT', msg: '图片内容与文件类型不一致' });
    }
    const urls = [];
    try {
      for (const file of req.files) urls.push((await normalizeProductImage(file)).url);
    } catch (error) {
      removeUploadedFiles(urls); removeUploadedFiles(req.files);
      return res.status(422).json({ success: false, msg: '图片解码或规范化失败' });
    }
    const insert = db.prepare('INSERT INTO product_reports (brand_id, product_id, batch_no, url, title, sort_order, created_by) VALUES (?,?,?,?,?,?,?)');
    const createdBy = currentUser(req)?.id || null;
    let seq = db.prepare('SELECT COALESCE(MAX(sort_order),0) as m FROM product_reports WHERE brand_id=? AND product_id=?').get(product.brand_id, product.id).m;
    const inserted = [];
    for (const url of urls) {
      seq += 1;
      const r = insert.run(product.brand_id, product.id, batch_no, url, '', seq, createdBy);
      inserted.push({ id: r.lastInsertRowid, batch_no, url });
    }
    logOperation(req, 'upload_product_report', 'product', product.id, `上传检测报告 ${urls.length} 张（批次 ${batch_no || '未填'}）`);
    res.status(201).json({ success: true, reports: inserted });
  });
});

// 删除检测报告
app.delete('/api/reports/:id', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, msg: '无效的报告 ID' });
  const report = db.prepare('SELECT * FROM product_reports WHERE id=?').get(id);
  if (!report) return res.status(404).json({ success: false, msg: '报告不存在' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(report.product_id);
  if (!product || !brandAllowed(brandScope(req), product.brand_id)) return res.status(403).json({ success: false, msg: '没有权限操作该报告' });
  db.prepare('DELETE FROM product_reports WHERE id=?').run(id);
  logOperation(req, 'delete_product_report', 'product', product.id, '删除检测报告');
  res.json({ success: true, msg: '报告已删除' });
});

// 消费者端：公开检测报告（供验证页展示，无需登录）
app.get('/api/public/reports/:code', (req, res) => {
  const code = String(req.params.code || '');
  const item = db.prepare('SELECT * FROM items WHERE item_code=?').get(code);
  const box = item ? null : db.prepare('SELECT * FROM boxes WHERE box_code=?').get(code);
  let product = null;
  if (item && item.product_id) product = db.prepare('SELECT * FROM products WHERE id=?').get(item.product_id);
  if (!product && box && box.product_id) product = db.prepare('SELECT * FROM products WHERE id=?').get(box.product_id);
  if (!product) return res.json({ success: true, reports: [] });
  const reports = db.prepare('SELECT id, batch_no, url, title FROM product_reports WHERE product_id=? ORDER BY batch_no DESC, sort_order, id').all(product.id);
  res.json({ success: true, reports, product_name: product.name });
});

// 备份列表（admin）
app.get('/api/backups', requireRole('admin'), (req, res) => {
  let files = [];
  try {
    secureBackupDirectory();
    files = fs.readdirSync(backupDir).filter(f => f.endsWith('.db') && fs.lstatSync(path.join(backupDir, f)).isFile())
      .map(f => {
        const st = fs.statSync(path.join(backupDir, f));
        return { name: f, size: st.size, created_at: st.mtime.toISOString().replace('T', ' ').slice(0, 19) };
      }).sort((a, b) => b.name.localeCompare(a.name));
  } catch (e) {}
  res.json({ success: true, backups: files });
});
// 下载指定备份
app.get('/api/backups/download/:name', requireRole('admin'), (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.db$/.test(name)) return res.status(400).json({ success: false, msg: '文件名不合法' });
  const file = path.join(backupDir, name);
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return res.status(404).json({ success: false, msg: '备份不存在' });
  res.download(file, name);
});

// --- 统计 API ---
app.get('/api/stats', requireRole('admin', 'brand', 'brand_staff'), (req, res) => {
  const scope = brandScope(req);
  if (scope === null) {
    const stats = {
      total_boxes: db.prepare('SELECT COUNT(*) as c FROM boxes').get().c,
      total_items: db.prepare('SELECT COUNT(*) as c FROM items').get().c,
      shipped_boxes: db.prepare("SELECT COUNT(*) as c FROM boxes WHERE status='shipped'").get().c,
      scanned_items: db.prepare("SELECT COUNT(*) as c FROM items WHERE status='scanned'").get().c,
      diversions: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0').get().c,
      total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs').get().c,
    };
    return res.json({ success: true, stats });
  }
  const stats = {
    total_boxes: db.prepare('SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE p.brand_id=?').get(scope).c,
    total_items: db.prepare('SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE p.brand_id=?').get(scope).c,
    shipped_boxes: db.prepare("SELECT COUNT(*) as c FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.status='shipped' AND p.brand_id=?").get(scope).c,
    scanned_items: db.prepare("SELECT COUNT(*) as c FROM items i JOIN products p ON i.product_id=p.id WHERE i.status='scanned' AND p.brand_id=?").get(scope).c,
    diversions: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE is_diversion>0 AND brand_id=?').get(scope).c,
    total_scans: db.prepare('SELECT COUNT(*) as c FROM scan_logs WHERE brand_id=?').get(scope).c,
  };
  res.json({ success: true, stats });
});

// ===================== 全局错误处理 =====================

// 404 兜底
app.use((req, res) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', requestId: req.requestId, msg: '接口不存在' });
});

// 全局错误中间件：任何路由抛出的异常都会到这里，不会让进程崩溃
app.use((err, req, res, next) => {
  console.error(`[${new Date().toLocaleString('zh-CN')}] 接口错误:`, req.requestId, req.method, req.url, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ success: false, code: 'INTERNAL_ERROR', requestId: req.requestId, msg: '服务器繁忙，请稍后重试' });
});

function shutdown(reason, exitCode) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.error(JSON.stringify({ level: exitCode ? 'error' : 'info', event: 'shutdown', reason, at: new Date().toISOString() }));
  const forceExit = setTimeout(() => process.exit(exitCode), 5000);
  forceExit.unref();
  const finish = () => {
    sessionStore.close();
    try { db.close(); } catch {}
    process.exit(exitCode);
  };
  if (httpServer) httpServer.close(finish);
  else finish();
}

process.once('SIGTERM', () => shutdown('SIGTERM', 0));
process.once('SIGINT', () => shutdown('SIGINT', 0));
process.once('uncaughtException', err => {
  console.error(err);
  shutdown('uncaughtException', 1);
});
process.once('unhandledRejection', reason => {
  console.error(reason);
  shutdown('unhandledRejection', 1);
});

// 启动服务
httpServer = app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n====================================`);
  console.log(`  溯源码系统已启动`);
  console.log(`  管理后台: http://localhost:${PORT}`);
  console.log(`  消费者验证: http://localhost:${PORT}/v/溯源码`);
  console.log(`====================================\n`);
});
