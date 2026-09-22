const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.RELIACODE_DATA_DIR
  ? path.resolve(process.env.RELIACODE_DATA_DIR)
  : path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'traceability.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
const db = new Database(DB_PATH);

// 开启 WAL 模式，提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDatabase() {
  // 产品表
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      spec TEXT DEFAULT '',
      batch_no TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 箱码表（父码）
  // product_id 允许为空：可先生成空白箱码，装箱时再选择产品绑定
  db.exec(`
    CREATE TABLE IF NOT EXISTS boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_code TEXT UNIQUE NOT NULL,
      product_id INTEGER,
      brand_id INTEGER,
      batch_no TEXT DEFAULT '',
      item_count INTEGER DEFAULT 0,
      box_size INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_stock',  -- in_stock(在库) / shipped(已发货)
      distributor_id INTEGER,
      shipped_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (distributor_id) REFERENCES distributors(id)
    )
  `);

  // 子码表（单品码）
  // box_id 允许为空：子码可独立生成，后续再绑定到任意箱码
  // product_id 允许为空：可先生成空白子码，装箱绑定时跟随箱码产品
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT UNIQUE NOT NULL,
      box_id INTEGER,
      product_id INTEGER,
      brand_id INTEGER,
      batch_no TEXT DEFAULT '',
      status TEXT DEFAULT 'in_stock',  -- in_stock / shipped / scanned
      distributor_id INTEGER,
      scanned_at TEXT,
      scan_location TEXT,
      scan_ip TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (box_id) REFERENCES boxes(id),
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (distributor_id) REFERENCES distributors(id)
    )
  `);

  // 代理商表
  db.exec(`
    CREATE TABLE IF NOT EXISTS distributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      region TEXT DEFAULT '',  -- 负责区域，如"广东省深圳市"
      address TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 发货记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id INTEGER NOT NULL,
      distributor_id INTEGER NOT NULL,
      shipped_at TEXT DEFAULT (datetime('now','localtime')),
      operator TEXT DEFAULT '',
      FOREIGN KEY (box_id) REFERENCES boxes(id),
      FOREIGN KEY (distributor_id) REFERENCES distributors(id)
    )
  `);

  // 扫码日志表
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL,
      box_code TEXT,
      product_name TEXT,
      distributor_name TEXT,
      assigned_region TEXT,
      scan_location TEXT,
      scan_ip TEXT,
      is_diversion INTEGER DEFAULT 0,  -- 0=正常 1=轻度串货(同省跨市) 2=重度串货(跨省)
      scanned_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 品牌设置表（key-value）
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // 营销活动表
  db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT DEFAULT '',
      end_date TEXT DEFAULT '',
      win_rate INTEGER DEFAULT 0,          -- 中奖率（百分比）
      prize_type TEXT DEFAULT 'thanks',    -- red_packet红包 / coupon优惠券 / goods实物 / thanks谢谢参与
      prize_name TEXT DEFAULT '',
      prize_min REAL DEFAULT 0,
      prize_max REAL DEFAULT 0,
      enabled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 中奖记录表
  db.exec(`
    CREATE TABLE IF NOT EXISTS prize_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL,
      campaign_id INTEGER,
      prize_type TEXT,
      prize_name TEXT,
      prize_value TEXT,
      scan_location TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 系统用户表（登录认证 + 角色权限）
  // role: admin(平台管理员) / brand(品牌管理员) / brand_staff(品牌方工作账号) / factory(工厂装箱) / warehouse(品牌方) / distributor(代理商自助)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      role TEXT DEFAULT 'admin',
      distributor_id INTEGER,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      last_login_at TEXT
    )
  `);
  // 迁移：旧库无 phone 列，动态添加
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('phone')) {
    try { db.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''"); } catch (e) {}
  }

  // 工厂表（多工厂数据隔离：每个工厂账号绑定一个工厂实体）
  db.exec(`
    CREATE TABLE IF NOT EXISTS factories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.exec(`ALTER TABLE factories ADD COLUMN enabled INTEGER DEFAULT 1`); } catch(e) {}

  // 邀请码表（admin 生成，合作工厂/代理商凭码自助注册账号）
  db.exec(`
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,                -- factory / distributor
      note TEXT DEFAULT '',              -- 备注（发给哪家工厂/代理商）
      status INTEGER DEFAULT 0,          -- 0=未使用 1=已使用 2=已作废
      used_by TEXT DEFAULT '',           -- 注册成功的账号名
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 串货预警表（验证接口检测到串货自动生成，后台预警中心展示）
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT NOT NULL,
      box_code TEXT DEFAULT '',
      product_name TEXT DEFAULT '',
      distributor_name TEXT DEFAULT '',
      assigned_region TEXT DEFAULT '',
      scan_location TEXT DEFAULT '',
      level INTEGER DEFAULT 1,           -- 1=轻度串货 2=重度串货(跨省)
      handled INTEGER DEFAULT 0,         -- 0=未处理 1=已处理
      handled_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // 兼容升级：发货记录表增加 item_code 列（支持散件发货记录）
  try { db.exec(`ALTER TABLE shipments ADD COLUMN item_code TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE distributors ADD COLUMN country TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE distributors ADD COLUMN province TEXT DEFAULT ''`); } catch(e) {}
  try { db.exec(`ALTER TABLE distributors ADD COLUMN city TEXT DEFAULT ''`); } catch(e) {}
  // 兼容升级：子码表增加 shipped_at 列（记录散件发货时间）
  try { db.exec(`ALTER TABLE items ADD COLUMN shipped_at TEXT`); } catch(e) {}
  // 兼容升级：子码表增加 boxed_at 列（记录装箱绑定时间，取消绑定/重新绑定后刷新）
  try { db.exec(`ALTER TABLE items ADD COLUMN boxed_at TEXT`); } catch(e) {}
  // 兼容升级：产品表增加 box_size 列（默认箱规，工厂装箱自动带出）
  try { db.exec(`ALTER TABLE products ADD COLUMN box_size INTEGER DEFAULT 0`); } catch(e) {}
  // 兼容升级：箱码表增加 box_size 列（装箱时固化箱规，发货时校验少扫）
  try { db.exec(`ALTER TABLE boxes ADD COLUMN box_size INTEGER DEFAULT 0`); } catch(e) {}
  // 兼容升级：产品表增加 ena13 条形码编号列（EAN-13 全球商品条码）
  try { db.exec(`ALTER TABLE products ADD COLUMN ena13 TEXT DEFAULT ''`); } catch(e) {}
  // 兼容升级：扫码日志增加经纬度列（浏览器定位，HTTPS 环境下生效，留存备查）
  try { db.exec(`ALTER TABLE scan_logs ADD COLUMN latitude REAL`); } catch(e) {}
  try { db.exec(`ALTER TABLE scan_logs ADD COLUMN longitude REAL`); } catch(e) {}
  // 兼容升级：用户表增加工厂归属列（工厂数据隔离）
  try { db.exec(`ALTER TABLE users ADD COLUMN factory_id INTEGER`); } catch(e) {}
  // 兼容升级：产品表增加工厂归属列（NULL=总部产品，仅管理员可见）
  try { db.exec(`ALTER TABLE products ADD COLUMN factory_id INTEGER`); } catch(e) {}
  // 操作留痕表（关键操作记录到数据库，便于审计）
  db.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_products_factory ON products(factory_id)`); } catch(e) {}

  // 工厂装箱记录：装箱成功/扫错都记一条，供「扫码记录」统计查询
  db.exec(`
    CREATE TABLE IF NOT EXISTS pack_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      username TEXT,
      factory_id INTEGER,
      brand_id INTEGER,
      box_code TEXT,
      item_code TEXT,
      product_name TEXT,
      spec TEXT DEFAULT '',
      box_size INTEGER DEFAULT 0,
      item_count INTEGER DEFAULT 0,
      action TEXT NOT NULL,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pack_records_user ON pack_records(user_id, created_at)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_pack_records_factory ON pack_records(factory_id)`); } catch(e) {}

  // 兼容升级：放宽 shipments.box_id 约束（允许 NULL，支持散件发货无箱记录）
  {
    const cols = db.prepare("PRAGMA table_info(shipments)").all();
    const boxIdCol = cols.find(c => c.name === 'box_id');
    if (boxIdCol && boxIdCol.notnull === 1) {
      db.exec(`
        CREATE TABLE shipments_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          box_id INTEGER,
          distributor_id INTEGER NOT NULL,
          item_code TEXT DEFAULT '',
          shipped_at TEXT DEFAULT (datetime('now','localtime')),
          operator TEXT DEFAULT ''
        );
        INSERT INTO shipments_new (id, box_id, distributor_id, item_code, shipped_at, operator)
          SELECT id, box_id, distributor_id, COALESCE(item_code,''), shipped_at, operator FROM shipments;
        DROP TABLE shipments;
        ALTER TABLE shipments_new RENAME TO shipments;
      `);
      console.log('[DB] shipments 表已升级（box_id 允许 NULL）');
    }
  }

  // ===================== 多品牌（SaaS 多租户）架构 =====================
  // 品牌表：平台管理员创建，每个品牌一个独立数据空间
  db.exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);
  // 各表挂 brand_id（NULL=平台级，仅平台管理员可见）
  try { db.exec(`ALTER TABLE factories ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE products ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE distributors ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE invitations ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE invitations ADD COLUMN factory_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE scan_logs ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE alerts ADD COLUMN brand_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE operation_logs ADD COLUMN brand_id INTEGER`); } catch(e) {}

  // 存量数据迁移：创建默认品牌，把所有旧数据归入，保证升级后老功能不受影响
  {
    const bCount = db.prepare('SELECT COUNT(*) as c FROM brands').get().c;
    if (bCount === 0) {
      const r = db.prepare('INSERT INTO brands (name, contact) VALUES (?,?)').run('默认品牌', '');
      const bid = r.lastInsertRowid;
      db.prepare(`UPDATE factories SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE products SET brand_id=(SELECT brand_id FROM factories WHERE id=products.factory_id) WHERE brand_id IS NULL AND factory_id IS NOT NULL`).run();
      db.prepare(`UPDATE products SET brand_id=? WHERE brand_id IS NULL`).run(bid); // 无工厂的旧产品也归默认品牌
      db.prepare(`UPDATE distributors SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE users SET brand_id=(SELECT brand_id FROM factories WHERE id=users.factory_id) WHERE role='factory' AND brand_id IS NULL AND factory_id IS NOT NULL`).run();
      db.prepare(`UPDATE users SET brand_id=(SELECT brand_id FROM distributors WHERE id=users.distributor_id) WHERE role='distributor' AND brand_id IS NULL AND distributor_id IS NOT NULL`).run();
      db.prepare(`UPDATE users SET brand_id=? WHERE role IN ('warehouse') AND brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE invitations SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      // 扫码日志/预警按码反查品牌归档
      db.prepare(`UPDATE scan_logs SET brand_id=COALESCE(
        (SELECT p.brand_id FROM items i JOIN products p ON i.product_id=p.id WHERE i.item_code=scan_logs.item_code),
        (SELECT p.brand_id FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.box_code=scan_logs.box_code)
      ) WHERE brand_id IS NULL`).run();
      db.prepare(`UPDATE scan_logs SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE alerts SET brand_id=COALESCE(
        (SELECT p.brand_id FROM items i JOIN products p ON i.product_id=p.id WHERE i.item_code=alerts.item_code),
        (SELECT p.brand_id FROM boxes b JOIN products p ON b.product_id=p.id WHERE b.box_code=alerts.box_code)
      ) WHERE brand_id IS NULL`).run();
      db.prepare(`UPDATE alerts SET brand_id=? WHERE brand_id IS NULL`).run(bid);
      db.prepare(`UPDATE operation_logs SET brand_id=(SELECT brand_id FROM users WHERE id=operation_logs.user_id) WHERE brand_id IS NULL`).run();
      console.log('[DB] 已创建默认品牌，存量数据已全部归入（多品牌架构升级完成）');
    }
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_boxes_product ON boxes(product_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_items_product ON items(product_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_scan_logs_brand ON scan_logs(brand_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_brand ON alerts(brand_id)`); } catch(e) {}

  // 兼容升级：放宽 boxes/items 的 product_id 约束（允许 NULL=空白码，装箱时再绑产品）
  // 并直接挂 brand_id 列（空白码没有产品可 JOIN，品牌隔离改用自身 brand_id）
  // 注意：外键约束开着时 DROP 父表会失败，重建期间临时关闭
  {
    const boxCols = db.prepare("PRAGMA table_info(boxes)").all();
    const boxPid = boxCols.find(c => c.name === 'product_id');
    const boxHasBrand = boxCols.some(c => c.name === 'brand_id');
    if ((boxPid && boxPid.notnull === 1) || !boxHasBrand) {
      // 旧表可能还没有 brand_id 列，动态取值
      const boxBrandExpr = boxHasBrand
        ? 'COALESCE(b.brand_id, (SELECT p.brand_id FROM products p WHERE p.id = b.product_id), NULL)'
        : '(SELECT p.brand_id FROM products p WHERE p.id = b.product_id)';
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE boxes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          box_code TEXT UNIQUE NOT NULL,
          product_id INTEGER,
          brand_id INTEGER,
          batch_no TEXT DEFAULT '',
          item_count INTEGER DEFAULT 0,
          status TEXT DEFAULT 'in_stock',
          distributor_id INTEGER,
          shipped_at TEXT,
          created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO boxes_new (id, box_code, product_id, brand_id, batch_no, item_count, status, distributor_id, shipped_at, created_at)
          SELECT b.id, b.box_code, b.product_id,
            ${boxBrandExpr},
            b.batch_no, b.item_count, b.status, b.distributor_id, b.shipped_at, b.created_at
          FROM boxes b;
        DROP TABLE boxes;
        ALTER TABLE boxes_new RENAME TO boxes;
      `);
      db.pragma('foreign_keys = ON');
      console.log('[DB] boxes 表已升级（product_id 允许 NULL，支持空白箱码）');
    }

    const itemCols = db.prepare("PRAGMA table_info(items)").all();
    const itemPid = itemCols.find(c => c.name === 'product_id');
    const itemHasBrand = itemCols.some(c => c.name === 'brand_id');
    if ((itemPid && itemPid.notnull === 1) || !itemHasBrand) {
      const itemBrandExpr = itemHasBrand
        ? 'COALESCE(i.brand_id, (SELECT p.brand_id FROM products p WHERE p.id = i.product_id), NULL)'
        : '(SELECT p.brand_id FROM products p WHERE p.id = i.product_id)';
      db.pragma('foreign_keys = OFF');
      db.exec(`
        CREATE TABLE items_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          item_code TEXT UNIQUE NOT NULL,
          box_id INTEGER,
          product_id INTEGER,
          brand_id INTEGER,
          batch_no TEXT DEFAULT '',
          status TEXT DEFAULT 'in_stock',
          distributor_id INTEGER,
          scanned_at TEXT,
          scan_location TEXT,
          scan_ip TEXT,
          shipped_at TEXT,
          created_at TEXT DEFAULT (datetime('now','localtime'))
        );
        INSERT INTO items_new (id, item_code, box_id, product_id, brand_id, batch_no, status, distributor_id, scanned_at, scan_location, scan_ip, shipped_at, created_at)
          SELECT i.id, i.item_code, i.box_id, i.product_id,
            ${itemBrandExpr},
            i.batch_no, i.status, i.distributor_id, i.scanned_at, i.scan_location, i.scan_ip, i.shipped_at, i.created_at
          FROM items i;
        DROP TABLE items;
        ALTER TABLE items_new RENAME TO items;
      `);
      db.pragma('foreign_keys = ON');
      console.log('[DB] items 表已升级（product_id 允许 NULL，支持空白子码）');
    }
  }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_boxes_brand ON boxes(brand_id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_items_brand ON items(brand_id)`); } catch(e) {}

  // 生产码包：一次生成任务对应一组可精确复现、可审计导出的码。
  // package_id 使用可空列兼容历史码；历史码仍可通过原有筛选 ZIP 导出。
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_no TEXT UNIQUE NOT NULL,
      code_type TEXT NOT NULL CHECK(code_type IN ('box','item')),
      brand_id INTEGER NOT NULL,
      product_id INTEGER,
      batch_no TEXT DEFAULT '',
      quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50000),
      base_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'generating' CHECK(status IN ('generating','ready','failed')),
      first_code TEXT DEFAULT '',
      last_code TEXT DEFAULT '',
      error_message TEXT DEFAULT '',
      download_count INTEGER NOT NULL DEFAULT 0,
      last_downloaded_at TEXT,
      created_by INTEGER,
      created_by_name TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      completed_at TEXT,
      FOREIGN KEY(product_id) REFERENCES products(id)
    );
    CREATE INDEX IF NOT EXISTS idx_code_packages_brand ON code_packages(brand_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_code_packages_product_batch ON code_packages(product_id, batch_no, id DESC);
  `);
  try { db.exec(`ALTER TABLE boxes ADD COLUMN package_id INTEGER`); } catch(e) {}
  try { db.exec(`ALTER TABLE items ADD COLUMN package_id INTEGER`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_boxes_package ON boxes(package_id, id)`); } catch(e) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_items_package ON items(package_id, id)`); } catch(e) {}
  // 迁移：码包改为「品牌通用码包」——以品牌方为主体，不再强制绑定单个产品；
  // product_id / batch_no 允许为空（通用空白码，装箱/发货时再绑定具体产品与批次）。
  {
    const cpCols = db.prepare("PRAGMA table_info(code_packages)").all();
    const pCol = cpCols.find(c => c.name === 'product_id');
    const bCol = cpCols.find(c => c.name === 'batch_no');
    if (pCol && pCol.notnull === 1) {
      db.exec(`
        CREATE TABLE code_packages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          package_no TEXT UNIQUE NOT NULL,
          code_type TEXT NOT NULL CHECK(code_type IN ('box','item')),
          brand_id INTEGER NOT NULL,
          product_id INTEGER,
          batch_no TEXT DEFAULT '',
          quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 50000),
          base_url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'generating' CHECK(status IN ('generating','ready','failed')),
          first_code TEXT DEFAULT '',
          last_code TEXT DEFAULT '',
          error_message TEXT DEFAULT '',
          download_count INTEGER NOT NULL DEFAULT 0,
          last_downloaded_at TEXT,
          created_by INTEGER,
          created_by_name TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now','localtime')),
          completed_at TEXT
        );
        INSERT INTO code_packages_new
          (id,package_no,code_type,brand_id,product_id,batch_no,quantity,base_url,status,first_code,last_code,error_message,download_count,last_downloaded_at,created_by,created_by_name,created_at,completed_at)
          SELECT id,package_no,code_type,brand_id,product_id,batch_no,quantity,base_url,status,first_code,last_code,error_message,download_count,last_downloaded_at,created_by,created_by_name,created_at,completed_at FROM code_packages;
        DROP TABLE code_packages;
        ALTER TABLE code_packages_new RENAME TO code_packages;
        CREATE INDEX IF NOT EXISTS idx_code_packages_brand ON code_packages(brand_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_code_packages_product_batch ON code_packages(product_id, batch_no, id DESC);
      `);
      console.log('[DB] code_packages 表已升级为品牌通用码包（product_id/batch_no 允许为空）');
    }
  }
  // 进程中断时事务会自动回滚；将残留的生成中任务标为失败，避免永久假进度。
  try {
    db.prepare(`UPDATE code_packages SET status='failed', error_message='生成过程因服务重启中断' WHERE status='generating'`).run();
  } catch(e) {}

  // 产品级公开内容：媒体、溯源模板、批次履历与营销信息全部显式携带品牌边界。
  // 历史产品以 version=1 起步，供管理端执行乐观并发控制。
  try { db.exec(`ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1`); } catch(e) {}
  try { db.exec(`ALTER TABLE products ADD COLUMN description TEXT DEFAULT ''`); } catch(e) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      alt_text TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_cover INTEGER NOT NULL DEFAULT 0 CHECK(is_cover IN (0,1)),
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(product_id, url),
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_media_tenant ON product_media(brand_id, product_id, sort_order);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_product_media_one_cover ON product_media(product_id) WHERE is_cover=1;

    CREATE TABLE IF NOT EXISTS product_trace_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      stage_key TEXT NOT NULL,
      title TEXT NOT NULL,
      public_label TEXT DEFAULT '',
      content TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(product_id, stage_key),
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_trace_templates_tenant ON product_trace_templates(brand_id, product_id, sort_order);

    CREATE TABLE IF NOT EXISTS product_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      batch_no TEXT NOT NULL,
      production_date TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
      published_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(brand_id, product_id, batch_no),
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_batches_tenant ON product_batches(brand_id, product_id, batch_no);

    CREATE TABLE IF NOT EXISTS product_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      batch_no TEXT DEFAULT '',
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_reports_tenant ON product_reports(brand_id, product_id, sort_order);

    CREATE TABLE IF NOT EXISTS batch_trace_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      template_id INTEGER,
      stage_key TEXT NOT NULL,
      title TEXT NOT NULL,
      public_location TEXT DEFAULT '',
      occurred_at TEXT NOT NULL,
      detail TEXT DEFAULT '',
      evidence_url TEXT DEFAULT '',
      revision_of INTEGER,
      published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(batch_id) REFERENCES product_batches(id) ON DELETE CASCADE,
      FOREIGN KEY(template_id) REFERENCES product_trace_templates(id),
      FOREIGN KEY(revision_of) REFERENCES batch_trace_entries(id)
    );
    CREATE INDEX IF NOT EXISTS idx_batch_trace_public ON batch_trace_entries(brand_id, batch_id, published, occurred_at);

    CREATE TABLE IF NOT EXISTS product_marketing (
      product_id INTEGER PRIMARY KEY,
      brand_id INTEGER NOT NULL,
      image_url TEXT DEFAULT '',
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      target_url TEXT DEFAULT '',
      starts_at TEXT DEFAULT '',
      ends_at TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      review_status TEXT NOT NULL DEFAULT 'draft' CHECK(review_status IN ('draft','pending','approved','rejected')),
      reviewed_by INTEGER,
      reviewed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now','localtime')),
      FOREIGN KEY(product_id) REFERENCES products(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_marketing_tenant ON product_marketing(brand_id, product_id, review_status);
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_boxes_code ON boxes(box_code);
    CREATE INDEX IF NOT EXISTS idx_items_code ON items(item_code);
    CREATE INDEX IF NOT EXISTS idx_items_box_id ON items(box_id);
    CREATE INDEX IF NOT EXISTS idx_scan_logs_code ON scan_logs(item_code);
    CREATE INDEX IF NOT EXISTS idx_scan_logs_diversion ON scan_logs(is_diversion);
    CREATE INDEX IF NOT EXISTS idx_alerts_handled ON alerts(handled);
  `);

  // 默认品牌设置
  const defaultSettings = {
    brand_name: '正品溯源',
    logo_text: 'RC',
    welcome_msg: '正品验证 · 一扫溯源',
    theme_color: '#1a73e8',
    contact_phone: '',
    product_images: '',      // 产品图片URL，换行分隔，验证页轮播展示
    promo_video: '',         // 宣传视频URL，验证页展示
    show_scan_count: '1'     // 验证页是否展示累计扫码统计
  };
  const upsertSetting = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING');
  for (const [k, v] of Object.entries(defaultSettings)) {
    upsertSetting.run(k, v);
  }
  // 一次性兼容迁移：旧版全局产品图复制到每个存量产品，之后由产品级接口维护。
  // 仅接受历史上由本系统上传的相对 URL，避免把任意外链带入公开扫码页。
  if (!db.prepare("SELECT 1 FROM settings WHERE key='product_media_migrated_v1'").get()) {
    const legacyImages = String(db.prepare("SELECT value FROM settings WHERE key='product_images'").get()?.value || '')
      .split(/\r?\n/).map(value => value.trim()).filter(value => /^\/uploads\/[A-Za-z0-9._-]+$/.test(value)).slice(0, 6);
    if (legacyImages.length) {
      const insertLegacyMedia = db.prepare(`INSERT OR IGNORE INTO product_media
        (brand_id,product_id,url,alt_text,sort_order,is_cover) VALUES (?,?,?,?,?,?)`);
      for (const product of db.prepare('SELECT id,brand_id,name FROM products WHERE brand_id IS NOT NULL').all()) {
        legacyImages.forEach((url, index) => insertLegacyMedia.run(product.brand_id, product.id, url, product.name || '', index, index === 0 ? 1 : 0));
      }
    }
    db.prepare("INSERT INTO settings (key,value) VALUES ('product_media_migrated_v1','1')").run();
  }

  // 会话密钥：首次生成后持久化在 settings 表（服务重启不失效）
  {
    const row = db.prepare("SELECT value FROM settings WHERE key='session_secret'").get();
    if (!row) {
      db.prepare("INSERT INTO settings (key,value) VALUES ('session_secret',?)")
        .run(require('crypto').randomBytes(32).toString('hex'));
    }
  }

  // 初始账号：生产环境必须显式提供强密码，禁止创建可预测的示例账号。
  {
    const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    if (count === 0) {
      const isProduction = process.env.NODE_ENV === 'production';
      const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || (isProduction ? '' : 'admin123');
      if (isProduction && initialPassword.length < 12) {
        throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters for first production startup');
      }
      const insertUser = db.prepare('INSERT INTO users (username, password_hash, display_name, role, distributor_id) VALUES (?,?,?,?,?)');
      insertUser.run('admin', hashPassword(initialPassword), '总部管理员', 'admin', null);
      console.log(isProduction ? '[DB] 已创建生产管理员账号' : '[DB] 已创建本地开发管理员账号：admin/admin123');
    }
  }

  // 兼容升级：首次引入工厂体系时，创建默认工厂并把存量数据归入，保证旧功能不受影响
  {
    const fCount = db.prepare('SELECT COUNT(*) as c FROM factories').get().c;
    if (fCount === 0) {
      const defaultBrandId = db.prepare('SELECT id FROM brands WHERE enabled=1 ORDER BY id LIMIT 1').get()?.id || null;
      const r = db.prepare('INSERT INTO factories (name, contact, brand_id) VALUES (?,?,?)').run('默认工厂', '', defaultBrandId);
      const fid = r.lastInsertRowid;
      db.prepare(`UPDATE users SET factory_id=? WHERE role='factory' AND factory_id IS NULL`).run(fid);
      db.prepare(`UPDATE products SET factory_id=? WHERE factory_id IS NULL`).run(fid);
      console.log('[DB] 已创建默认工厂，存量产品与工厂账号已归入');
    }
  }

  // 工厂可同时服务多个品牌。factories.brand_id 继续保留为兼容旧接口的主品牌，
  // 新增/编辑品牌与权限判断以本关联表为准。
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_brands (
      factory_id INTEGER NOT NULL,
      brand_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (factory_id, brand_id),
      FOREIGN KEY (factory_id) REFERENCES factories(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_factory_brands_brand ON factory_brands(brand_id, factory_id);
  `);
  db.prepare(`INSERT OR IGNORE INTO factory_brands (factory_id, brand_id)
    SELECT id, brand_id FROM factories WHERE brand_id IS NOT NULL`).run();

  // 产品可由同一品牌下的多个工厂共同生产。保留 products.factory_id 作为
  // 旧客户端兼容的“主工厂”，实际授权与展示以本关联表为准。
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_factories (
      product_id INTEGER NOT NULL,
      factory_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (product_id, factory_id),
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
      FOREIGN KEY (factory_id) REFERENCES factories(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_product_factories_factory ON product_factories(factory_id, product_id);
    DROP TRIGGER IF EXISTS product_factories_brand_guard_insert;
    DROP TRIGGER IF EXISTS product_factories_brand_guard_update;
    CREATE TRIGGER product_factories_brand_guard_insert
      BEFORE INSERT ON product_factories
      WHEN NOT EXISTS (
        SELECT 1 FROM products p JOIN factories f ON f.id=NEW.factory_id
        WHERE p.id=NEW.product_id AND p.brand_id IS NOT NULL AND (
          p.brand_id=f.brand_id OR EXISTS (
            SELECT 1 FROM factory_brands fb WHERE fb.factory_id=f.id AND fb.brand_id=p.brand_id
          )
        )
      )
      BEGIN SELECT RAISE(ABORT, 'PRODUCT_FACTORY_BRAND_CONFLICT'); END;
    CREATE TRIGGER product_factories_brand_guard_update
      BEFORE UPDATE OF product_id, factory_id ON product_factories
      WHEN NOT EXISTS (
        SELECT 1 FROM products p JOIN factories f ON f.id=NEW.factory_id
        WHERE p.id=NEW.product_id AND p.brand_id IS NOT NULL AND (
          p.brand_id=f.brand_id OR EXISTS (
            SELECT 1 FROM factory_brands fb WHERE fb.factory_id=f.id AND fb.brand_id=p.brand_id
          )
        )
      )
      BEGIN SELECT RAISE(ABORT, 'PRODUCT_FACTORY_BRAND_CONFLICT'); END;
  `);
  // 幂等回填：升级前每个产品的单一归属工厂自动成为第一家授权工厂。
  db.prepare(`INSERT OR IGNORE INTO product_factories (product_id, factory_id)
    SELECT id, factory_id FROM products WHERE factory_id IS NOT NULL`).run();

  console.log('[DB] 数据库初始化完成');
}

// ===================== 密码哈希（scrypt） =====================

function hashPassword(password) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const crypto = require('crypto');
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
  } catch (e) {
    return false;
  }
}

module.exports = { db, initDatabase, hashPassword, verifyPassword };
