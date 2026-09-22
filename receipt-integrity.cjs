'use strict';

// A single transaction owns receipt state, counters and the durable business log.
module.exports = function receiptIntegrity(db) {
  db.transaction(() => {
    for (const table of ['items', 'boxes', 'pack_records']) {
      const cols = db.pragma(`table_info(${table})`).map(c => c.name);
      if (!cols.includes('receipt_factory_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN receipt_factory_id INTEGER`);
    }
    const boxCols = db.pragma('table_info(boxes)').map(c => c.name);
    if (!boxCols.includes('receipt_confirmed_at')) db.exec('ALTER TABLE boxes ADD COLUMN receipt_confirmed_at TEXT');
    if (!boxCols.includes('receipt_confirmed_by')) db.exec('ALTER TABLE boxes ADD COLUMN receipt_confirmed_by INTEGER');
    const cols = db.pragma('table_info(pack_records)').map(c => c.name);
    if (!cols.includes('product_id')) db.exec('ALTER TABLE pack_records ADD COLUMN product_id INTEGER');
    if (!cols.includes('batch_no')) db.exec('ALTER TABLE pack_records ADD COLUMN batch_no TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pack_item_history ON pack_records(item_code,id);
      CREATE INDEX IF NOT EXISTS idx_pack_receipt_scope ON pack_records(brand_id,receipt_factory_id,id);
      CREATE INDEX IF NOT EXISTS idx_boxes_receipt_confirmed ON boxes(receipt_confirmed_at,receipt_factory_id);`);
    db.exec('CREATE TABLE IF NOT EXISTS receipt_schema_migrations (version TEXT PRIMARY KEY)');
    // Freeze current receipt ownership once. Do not change historical product/brand/batch values.
    if (!db.prepare('SELECT 1 FROM receipt_schema_migrations WHERE version=?').get('20260917-owner-v1')) db.exec(`UPDATE items SET receipt_factory_id=COALESCE(
      (SELECT r.factory_id FROM pack_records r WHERE r.item_code=items.item_code
       AND r.action IN ('bind','box_full','nobox') AND datetime(r.created_at)=datetime(items.boxed_at)
       ORDER BY r.id DESC LIMIT 1), (SELECT p.factory_id FROM products p WHERE p.id=items.product_id))
      WHERE boxed_at IS NOT NULL AND receipt_factory_id IS NULL;
      UPDATE boxes SET receipt_factory_id=(SELECT i.receipt_factory_id FROM items i WHERE i.box_id=boxes.id ORDER BY i.id LIMIT 1)
      WHERE receipt_factory_id IS NULL AND EXISTS(SELECT 1 FROM items i WHERE i.box_id=boxes.id);
      UPDATE pack_records SET receipt_factory_id=(SELECT i.receipt_factory_id FROM items i WHERE i.item_code=pack_records.item_code),
       product_id=(SELECT i.product_id FROM items i WHERE i.item_code=pack_records.item_code),
       batch_no=(SELECT i.batch_no FROM items i WHERE i.item_code=pack_records.item_code)
      WHERE receipt_factory_id IS NULL AND action IN ('bind','box_full','nobox')
       AND EXISTS(SELECT 1 FROM items i WHERE i.item_code=pack_records.item_code AND i.boxed_at IS NOT NULL
         AND datetime(i.boxed_at)=datetime(pack_records.created_at));
      INSERT INTO receipt_schema_migrations(version) VALUES('20260917-owner-v1');`);
    // Existing bound boxes were considered inbound before the explicit confirmation step existed.
    // Mark them once so deployment does not hide or block historical stock.
    if (!db.prepare('SELECT 1 FROM receipt_schema_migrations WHERE version=?').get('20260922-confirm-v1')) db.exec(`
      UPDATE boxes SET receipt_confirmed_at=COALESCE(
        (SELECT MAX(i.boxed_at) FROM items i WHERE i.box_id=boxes.id), created_at)
      WHERE receipt_confirmed_at IS NULL AND EXISTS(SELECT 1 FROM items i WHERE i.box_id=boxes.id);
      INSERT INTO receipt_schema_migrations(version) VALUES('20260922-confirm-v1');
    `);
    for (const table of ['items', 'boxes']) {
      for (const event of ['INSERT', 'UPDATE OF product_id,brand_id,batch_no' + (table === 'items' ? ',box_id' : '')]) {
        const suffix = event.startsWith('INSERT') ? 'insert' : 'update';
        db.exec(`CREATE TRIGGER IF NOT EXISTS receipt_${table}_${suffix} BEFORE ${event} ON ${table}
        BEGIN
          SELECT CASE WHEN NEW.product_id IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM products p WHERE p.id=NEW.product_id AND p.brand_id IS NEW.brand_id)
            THEN RAISE(ABORT,'RECEIPT_BRAND_CONFLICT') END;
          ${table === 'items' ? `SELECT CASE WHEN NEW.box_id IS NOT NULL AND NOT EXISTS
            (SELECT 1 FROM boxes b WHERE b.id=NEW.box_id AND b.product_id IS NEW.product_id
              AND b.brand_id IS NEW.brand_id AND COALESCE(b.batch_no,'')=COALESCE(NEW.batch_no,''))
            THEN RAISE(ABORT,'RECEIPT_BOX_CONFLICT') END;` : `SELECT CASE WHEN EXISTS
            (SELECT 1 FROM items i WHERE i.box_id=NEW.id AND (i.product_id IS NOT NEW.product_id
              OR i.brand_id IS NOT NEW.brand_id OR COALESCE(i.batch_no,'')!=COALESCE(NEW.batch_no,'')))
            THEN RAISE(ABORT,'RECEIPT_BOX_CONFLICT') END;`}
        END;`);
      }
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS receipt_product_brand_guard BEFORE UPDATE OF brand_id ON products
      WHEN OLD.brand_id IS NOT NEW.brand_id AND
       (EXISTS(SELECT 1 FROM items WHERE product_id=OLD.id) OR EXISTS(SELECT 1 FROM boxes WHERE product_id=OLD.id))
      BEGIN SELECT RAISE(ABORT,'RECEIPT_BRAND_CONFLICT'); END;`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS receipt_item_ship_guard BEFORE UPDATE OF status ON items WHEN NEW.status='shipped'
      BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM products p WHERE p.id=NEW.product_id AND p.brand_id IS NEW.brand_id)
        OR (NEW.box_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM boxes b WHERE b.id=NEW.box_id
         AND b.product_id IS NEW.product_id AND b.brand_id IS NEW.brand_id AND COALESCE(b.batch_no,'')=COALESCE(NEW.batch_no,'')))
        THEN RAISE(ABORT,'RECEIPT_BOX_CONFLICT') END; END;`);
  }).immediate();

  function atomic(handler) {
    return (req, res) => {
      let body, status = 200;
      const reply = { status(n) { status = n; return this; }, json(value) { body = value; return this; } };
      try {
        db.transaction(() => {
          const result = handler(req, reply);
          if (result && typeof result.then === 'function') throw new Error('ASYNC_RECEIPT_HANDLER');
          if (body === undefined) throw new Error('MISSING_RECEIPT_RESPONSE');
        }).immediate();
        return res.status(status).json(body);
      } catch (error) {
        const conflict = /RECEIPT_.*CONFLICT/.test(error.message);
        console.error(JSON.stringify({ event: 'receipt_transaction_rolled_back', code: error.code || 'ERROR', requestId: req.requestId }));
        return res.status(conflict ? 409 : 500).json({ success: false,
          code: conflict ? 'RECEIPT_DATA_CONFLICT' : 'RECEIPT_WRITE_FAILED',
          msg: conflict ? '商品、品牌或批次存在冲突，本次未修改，请核对码的原始资料' : '保存失败，本次操作已回滚，请核对记录后重试' });
      }
    };
  }
  function owner(req, product, box) {
    return box?.receipt_factory_id || (req.session.user?.role === 'factory' ? req.session.user.factory_id : null) || product?.factory_id || null;
  }
  function boxConflict(id) {
    return !!db.prepare(`SELECT 1 FROM items i JOIN boxes b ON b.id=i.box_id WHERE b.id=? AND
      (i.product_id IS NOT b.product_id OR i.brand_id IS NOT b.brand_id OR COALESCE(i.batch_no,'')!=COALESCE(b.batch_no,'')) LIMIT 1`).get(id);
  }
  return { atomic, owner, boxConflict };
};
