const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { DataTypes, Sequelize } = require('sequelize');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(cors());

const [dbHost, dbPort] = String(process.env.MYSQL_ADDRESS || '').split(':');
if (!dbHost || !process.env.MYSQL_USERNAME || !process.env.MYSQL_PASSWORD) {
  console.error('Missing MYSQL_ADDRESS, MYSQL_USERNAME, or MYSQL_PASSWORD');
}
const sequelize = new Sequelize(process.env.MYSQL_DATABASE || 'nodejs_demo', process.env.MYSQL_USERNAME || '', process.env.MYSQL_PASSWORD || '', {
  host: dbHost || '127.0.0.1', port: Number(dbPort) || 3306, dialect: 'mysql', logging: false,
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 }
});

const User = sequelize.define('LedgerUser', {
  openid: { type: DataTypes.STRING(128), primaryKey: true },
  displayName: { type: DataTypes.STRING(40), allowNull: false },
  role: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'user' },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
  createdAt: { type: DataTypes.DATE, allowNull: false }, updatedAt: { type: DataTypes.DATE, allowNull: false }
}, { tableName: 'ledger_users', timestamps: false });

const Transaction = sequelize.define('LedgerTransaction', {
  id: { type: DataTypes.STRING(64), primaryKey: true },
  ownerOpenid: { type: DataTypes.STRING(128), allowNull: false },
  date: { type: DataTypes.STRING(10), allowNull: false }, type: { type: DataTypes.STRING(8), allowNull: false },
  category: { type: DataTypes.STRING(80), allowNull: false }, amount: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  discount: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
  transport: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0 },
  payment: { type: DataTypes.STRING(24), allowNull: false, defaultValue: '' }, note: { type: DataTypes.STRING(300), allowNull: false, defaultValue: '' },
  lines: { type: DataTypes.JSON, allowNull: false }, costTotal: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
  profit: { type: DataTypes.DECIMAL(12, 2), allowNull: true }, profitComplete: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  createdAt: { type: DataTypes.DATE, allowNull: false }, updatedAt: { type: DataTypes.DATE, allowNull: false }
}, { tableName: 'ledger_transactions', timestamps: false, indexes: [{ fields: ['ownerOpenid', 'date'] }] });

const Catalog = sequelize.define('LedgerCatalog', {
  id: { type: DataTypes.STRING(32), primaryKey: true },
  catalog: { type: DataTypes.JSON, allowNull: false }, updatedAt: { type: DataTypes.DATE, allowNull: false },
  updatedBy: { type: DataTypes.STRING(128), allowNull: false }
}, { tableName: 'ledger_catalog', timestamps: false });

const ADMIN_OPENID = process.env.ADMIN_OPENID || '';
const now = () => new Date();
const ok = data => ({ ok: true, data: data === undefined ? null : data });
const fail = (message, code = 'ERR') => ({ ok: false, error: message, code });
const id = () => crypto.randomBytes(16).toString('hex');

function openidFrom(req) {
  // CloudRun injects these headers for calls made through the trusted WeChat channel.
  return req.headers['x-wx-source'] ? String(req.headers['x-wx-openid'] || '') : '';
}
async function currentUser(openid) { return User.findByPk(openid); }
async function requireActive(openid) {
  const user = await currentUser(openid);
  if (!user) throw new Error('USER_NOT_REGISTERED');
  if (user.status !== 'active') throw new Error(user.status === 'disabled' ? 'USER_DISABLED' : 'USER_PENDING');
  return user;
}
async function requireAdmin(openid) {
  if (!ADMIN_OPENID || openid !== ADMIN_OPENID) throw new Error('ADMIN_ONLY');
  const user = await currentUser(openid);
  if (!user || user.status !== 'active') throw new Error('ADMIN_ONLY');
  return user;
}

async function handle(action, event, openid) {
  if (!openid) throw new Error('AUTH_REQUIRED');
  if (action === 'whoAmI') return { openid, isConfiguredAdmin: !!ADMIN_OPENID && openid === ADMIN_OPENID };
  if (action === 'ensureUser') {
    let user = await currentUser(openid);
    const admin = !!ADMIN_OPENID && openid === ADMIN_OPENID;
    if (!user) user = await User.create({ openid, displayName: '用户' + openid.slice(-4), role: admin ? 'admin' : 'user', status: admin ? 'active' : 'pending', createdAt: now(), updatedAt: now() });
    else if (admin && (user.role !== 'admin' || user.status !== 'active')) {
      await user.update({ role: 'admin', status: 'active', updatedAt: now() });
    }
    return { profile: user.get({ plain: true }), configuredAdmin: !!ADMIN_OPENID };
  }
  if (action === 'adminListUsers') {
    await requireAdmin(openid);
    return User.findAll({ order: [['createdAt', 'DESC']], limit: 1000, raw: true });
  }
  if (action === 'adminSetUserStatus') {
    await requireAdmin(openid);
    const { userId, status } = event;
    if (!userId || !['active', 'pending', 'disabled'].includes(status)) throw new Error('BAD_INPUT');
    if (userId === openid) throw new Error('SELF_CHANGE');
    const target = await currentUser(userId);
    if (!target) throw new Error('NOT_FOUND');
    if (target.role === 'admin') throw new Error('ADMIN_PROTECTED');
    await target.update({ status, updatedAt: now() });
    return { userId, status };
  }
  if (action === 'adminSetUserName') {
    await requireAdmin(openid);
    const { userId, displayName } = event;
    if (!userId || !String(displayName || '').trim()) throw new Error('BAD_INPUT');
    const target = await currentUser(userId);
    if (!target) throw new Error('NOT_FOUND');
    await target.update({ displayName: String(displayName).trim().slice(0, 40), updatedAt: now() });
    return null;
  }
  if (action === 'getCatalog') {
    await requireActive(openid);
    const row = await Catalog.findByPk('shared');
    return row ? row.catalog : { brands: [] };
  }
  if (action === 'saveCatalog') {
    await requireAdmin(openid);
    const catalog = event.catalog;
    if (!catalog || !Array.isArray(catalog.brands)) throw new Error('BAD_INPUT');
    await Catalog.upsert({ id: 'shared', catalog, updatedAt: now(), updatedBy: openid });
    return catalog;
  }
  if (action === 'listTransactions') {
    const user = await requireActive(openid);
    const target = user.role === 'admin' && event.userId ? event.userId : openid;
    return Transaction.findAll({ where: { ownerOpenid: target }, order: [['date', 'DESC'], ['createdAt', 'DESC']], limit: 1000, raw: true });
  }
  if (action === 'saveTransaction') {
    await requireActive(openid);
    const tx = event.transaction || {};
    if (!tx.date || !['收入', '支出'].includes(tx.type) || !tx.category || !(Number(tx.amount) > 0)) throw new Error('BAD_INPUT');
    const timestamp = now();
    let lines = Array.isArray(tx.lines) ? tx.lines : [];
    let costTotal = 0, salesGross = null, profitComplete = tx.type === '收入' && lines.length > 0;
    let old = null;
    if (tx.id) {
      old = await Transaction.findByPk(tx.id);
      if (!old || old.ownerOpenid !== openid) throw new Error('NOT_FOUND');
    }
    if (tx.type === '收入' && lines.length) {
      const catalogRow = await Catalog.findByPk('shared');
      const brands = catalogRow && catalogRow.catalog && catalogRow.catalog.brands || [];
      const oldLines = old && Array.isArray(old.lines) ? old.lines : [];
      lines = lines.map((line, index) => {
        const quantity = Number(line.quantity) || 0, unitPrice = Number(line.unitPrice);
        if (!(quantity > 0) || !(unitPrice >= 0)) throw new Error('BAD_INPUT');
        salesGross = (salesGross || 0) + quantity * unitPrice;
        const previous = oldLines[index];
        const same = previous && previous.brandId === line.brandId && previous.productId === line.productId;
        let unitCost = same && previous.purchaseUnitCost !== undefined && previous.purchaseUnitCost !== null && Number.isFinite(Number(previous.purchaseUnitCost)) ? Number(previous.purchaseUnitCost) : null;
        if (unitCost === null) {
          const brand = brands.find(x => x.id === line.brandId) || brands.find(x => x.name === line.brand);
          const product = brand && (brand.products || []).find(x => x.id === line.productId) || brand && (brand.products || []).find(x => x.name === line.product);
          if (product && product.purchasePrice !== undefined && product.purchasePrice !== null && Number.isFinite(Number(product.purchasePrice))) unitCost = Number(product.purchasePrice);
        }
        const costSubtotal = unitCost === null ? null : Math.round(quantity * unitCost * 100) / 100;
        if (costSubtotal === null) profitComplete = false; else costTotal += costSubtotal;
        return { brand: String(line.brand || ''), brandId: String(line.brandId || ''), product: String(line.product || ''), productId: String(line.productId || ''), quantity, unitPrice, subtotal: Math.round(quantity * unitPrice * 100) / 100, purchaseUnitCost: unitCost, costSubtotal };
      });
      const discount = Number(tx.discount || 0);
      if (!Number.isFinite(discount) || discount < 0 || discount > salesGross) throw new Error('BAD_DISCOUNT');
      if (Math.abs(Number(tx.amount) - Math.round((salesGross - discount) * 100) / 100) > 0.01) throw new Error('AMOUNT_MISMATCH');
    }
    const amount = Math.round(Number(tx.amount) * 100) / 100;
    const profit = profitComplete ? Math.round((amount - costTotal) * 100) / 100 : null;
    const body = { id: tx.id || id(), ownerOpenid: openid, date: String(tx.date), type: tx.type, category: String(tx.category), amount,
      discount: Number(tx.discount || 0), transport: Number(tx.transport || 0), payment: String(tx.payment || ''), note: String(tx.note || '').slice(0, 300), lines,
      costTotal: tx.type === '收入' && profitComplete ? Math.round(costTotal * 100) / 100 : null, profit, profitComplete,
      createdAt: old ? old.createdAt : timestamp, updatedAt: timestamp };
    await Transaction.upsert(body);
    return { id: body.id };
  }
  if (action === 'deleteTransaction') {
    await requireActive(openid);
    const row = await Transaction.findByPk(event.id);
    if (!row || row.ownerOpenid !== openid) throw new Error('NOT_FOUND');
    await row.destroy();
    return null;
  }
  throw new Error('UNKNOWN_ACTION');
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'qingzhang-ledger' }));
app.get('/api/wx_openid', (req, res) => {
  if (!req.headers['x-wx-source'] || !req.headers['x-wx-openid']) return res.status(401).json(fail('微信身份校验失败', 'AUTH_REQUIRED'));
  res.json({ openid: String(req.headers['x-wx-openid']) });
});
app.post('/api/ledger', async (req, res) => {
  try {
    const data = await handle(String(req.body && req.body.action || ''), req.body || {}, openidFrom(req));
    res.json(ok(data));
  } catch (error) {
    const message = error && error.message || 'SERVER_ERROR';
    const known = {
      AUTH_REQUIRED: ['无法确认微信身份', 401], USER_NOT_REGISTERED: ['账号尚未登记，请重新进入小程序', 403],
      USER_PENDING: ['账号等待管理员启用', 403], USER_DISABLED: ['账号已停用，请联系管理员', 403],
      ADMIN_ONLY: ['只有管理员可以执行此操作', 403], BAD_INPUT: ['提交信息不完整或无效', 400],
      BAD_DISCOUNT: ['优惠金额不能大于产品总额', 400], AMOUNT_MISMATCH: ['收入金额与产品明细不一致，请重新保存', 400],
      NOT_FOUND: ['找不到记录或无权操作', 404], SELF_CHANGE: ['不能修改管理员自己的状态', 400],
      ADMIN_PROTECTED: ['不能在此处停用管理员', 400], UNKNOWN_ACTION: ['未知操作', 400]
    };
    const [text, status] = known[message] || ['服务器处理失败，请检查云托管日志', 500];
    if (status === 500) console.error('[ledgerApi]', req.body && req.body.action, error);
    res.status(status).json(fail(text, message));
  }
});

const port = Number(process.env.PORT) || 80;
async function start() {
  await sequelize.authenticate();
  await Promise.all([User.sync(), Transaction.sync(), Catalog.sync()]);
  app.listen(port, () => console.log('轻账云托管 API 已启动，端口', port));
}
start().catch(error => { console.error('云托管启动失败', error); process.exit(1); });
