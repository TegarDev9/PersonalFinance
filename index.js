const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const vader = require('vader-sentiment');
const JSZip = require('jszip');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Swagger UI
try {
  const swaggerUi = require('swagger-ui-express');
  const openapi = require(path.join(__dirname, 'docs', 'openapi.json'));
  app.get('/openapi.json', (req, res) => res.json(openapi));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapi, { explorer: true }));
} catch (e) {
  // swagger is optional; ignore if missing
}

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// Optional KV persistence (Vercel KV / Upstash)
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = process.env.KV_DB_KEY || 'fin:db';
const HOOKS_LIST_KEY = process.env.KV_HOOKS_KEY || 'fin:hooks';
const LOGS_AUTH_TOKEN = process.env.LOGS_AUTH_TOKEN || '';
const kvEnabled = () => !!(KV_URL && KV_TOKEN);
async function kvCmd(cmdArr) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KV_TOKEN}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(cmdArr)
  });
  try { return await r.json(); } catch { return {}; }
}

// Optional auth + simple rate limit for logs endpoints
function extractLogsToken(req) {
  const ah = req.headers['authorization'] || '';
  if (ah.toLowerCase().startsWith('bearer ')) return ah.slice(7).trim();
  const hdr = req.headers['x-logs-token'];
  if (hdr) return String(hdr);
  if (req.query && req.query.token) return String(req.query.token);
  return '';
}
function logsAuthOk(req) {
  if (!LOGS_AUTH_TOKEN) return true;
  const tok = extractLogsToken(req);
  return tok && tok === LOGS_AUTH_TOKEN;
}
const logsRate = new Map();
function logsRateOk(req) {
  const key = (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || 'ip';
  const now = Date.now();
  const win = 60_000; // 60s window
  const max = 60; // 60 requests per window per IP
  let rec = logsRate.get(key);
  if (!rec || (now - rec.start) > win) {
    rec = { start: now, count: 0 };
  }
  if (rec.count >= max) {
    logsRate.set(key, rec);
    return false;
  }
  rec.count += 1;
  logsRate.set(key, rec);
  return true;
}

async function kvGet(key) {
  const data = await kvCmd(['GET', key]);
  return data && data.result !== undefined ? data.result : null;
}
async function kvSet(key, val) {
  await kvCmd(['SET', key, val]);
}
async function kvListPush(key, val) {
  await kvCmd(['RPUSH', key, val]);
}
async function kvListLen(key) {
  const r = await kvCmd(['LLEN', key]);
  return (r && typeof r.result === 'number') ? r.result : 0;
}
async function kvListRange(key, start, stop) {
  const r = await kvCmd(['LRANGE', key, start, stop]);
  return (r && Array.isArray(r.result)) ? r.result : [];
}

// Deno KV (for Deno Deploy/local Deno)
const denoKvAvailable = () => typeof globalThis !== 'undefined' && typeof globalThis.Deno !== 'undefined' && typeof globalThis.Deno.openKv === 'function';
let denoKvInstance = null;
async function getDenoKv() {
  if (!denoKvAvailable()) return null;
  if (!denoKvInstance) {
    denoKvInstance = await globalThis.Deno.openKv();
  }
  return denoKvInstance;
}

const DEFAULT_DB = {
  accounts: [
    { id: 'acc_cash', name: 'Cash', type: 'cash', balance: 1000 }
  ],
  transactions: [],
  holdings: [
    { id: 'hold_aapl', symbol: 'AAPL', quantity: 5, avgPrice: 150 }
  ],
  settings: { baseCurrency: 'USD' },
  categories: [
    { id: 'cat_food', name: 'Food & Dining', type: 'expense' },
    { id: 'cat_transport', name: 'Transport', type: 'expense' },
    { id: 'cat_entertain', name: 'Entertainment', type: 'expense' },
    { id: 'cat_rent', name: 'Rent', type: 'expense' },
    { id: 'cat_salary', name: 'Salary', type: 'income' }
  ],
  budgets: [],
  rules: []
};

const KEYWORD_MAP = {
  'Food & Dining': ['food','restaurant','cafe','coffee','eat','warung','makan','grabfood','gofood','indomaret','alfamart'],
  'Transport': ['uber','grab','gojek','transport','bus','train','fuel','gas','tol','parking','taxi','angkot','ojek','bensin','bbm'],
  'Entertainment': ['netflix','disney','spotify','movie','game','cinema','hiburan','steam','psn'],
  'Rent': ['rent','sewa','kontrakan','kos','kost','apartemen','apartment'],
  'Salary': ['salary','gaji','payroll','income','penghasilan']
};

async function ensureDataFile() {
  if (kvEnabled() || denoKvAvailable()) return;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch {
    // likely read-only FS (e.g., Vercel). proceed without persisting.
  }
  try {
    if (!fs.existsSync(DB_FILE)) {
      await fsp.writeFile(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
    }
  } catch {
    // read-only FS; fall back to in-memory DEFAULT_DB
  }
}

function normalizeDB(db) {
  if (!Array.isArray(db.accounts)) db.accounts = DEFAULT_DB.accounts.slice();
  if (!Array.isArray(db.transactions)) db.transactions = [];
  if (!Array.isArray(db.holdings)) db.holdings = [];
  if (!db.settings) db.settings = { baseCurrency: 'USD' };
  if (!Array.isArray(db.categories)) db.categories = DEFAULT_DB.categories.slice();
  if (!Array.isArray(db.budgets)) db.budgets = [];
  if (!Array.isArray(db.rules)) db.rules = [];
  return db;
}

async function readDB() {
  if (kvEnabled()) {
    let raw = await kvGet(KV_KEY);
    if (!raw) {
      await kvSet(KV_KEY, JSON.stringify(DEFAULT_DB));
      raw = await kvGet(KV_KEY);
    }
    try {
      const parsed = JSON.parse(raw || '{}');
      return normalizeDB(parsed);
    } catch {
      return normalizeDB(DEFAULT_DB);
    }
  } else if (denoKvAvailable()) {
    const kv = await getDenoKv();
    const res = await kv.get(['fin', 'db']);
    let raw = res && res.value;
    if (!raw) {
      await kv.set(['fin', 'db'], JSON.stringify(DEFAULT_DB));
      const again = await kv.get(['fin', 'db']);
      raw = again && again.value;
    }
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      return normalizeDB(parsed);
    } catch {
      return normalizeDB(DEFAULT_DB);
    }
  } else {
    await ensureDataFile();
    const raw = await fsp.readFile(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw || '{}');
    return normalizeDB(parsed);
  }
}

async function writeDB(db) {
  if (kvEnabled()) {
    await kvSet(KV_KEY, JSON.stringify(db));
  } else if (denoKvAvailable()) {
    const kv = await getDenoKv();
    await kv.set(['fin', 'db'], JSON.stringify(db));
  } else {
    try {
      await ensureDataFile();
      await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2));
    } catch {
      // likely read-only FS (serverless). In this mode, data won't persist.
    }
  }
}

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function monthKey(d) {
  const iso = (d || '').toString();
  const parts = iso.split('T')[0].split('-');
  if (parts.length >= 2) return `${parts[0]}-${parts[1]}`;
  return iso.slice(0, 7);
}

function findCategoryById(db, id) {
  return db.categories.find(c => c.id === id);
}

function findCategoryByName(db, name) {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return db.categories.find(c => c.name.toLowerCase() === n);
}

function ensureCategory(db, name, type = 'expense') {
  let c = findCategoryByName(db, name);
  if (!c) {
    c = { id: genId('cat'), name, type };
    db.categories.push(c);
  }
  return c;
}

function autoCategorize(db, rec) {
  if (rec.category) {
    const existing = findCategoryByName(db, rec.category);
    if (existing) return { categoryName: existing.name, categoryId: existing.id };
  }
  const text = [
    rec.description, rec.note, rec.merchant, rec.payee, rec.category
  ].filter(Boolean).join(' ').toLowerCase();

  const absAmt = Math.abs(Number(rec.amount) || 0);
  const expType = rec.type || ((Number(rec.amount) || 0) < 0 ? 'expense' : 'income');

  function ruleMatches(rule) {
    if (!rule || !rule.categoryId) return false;
    if (rule.type && rec.type && rule.type !== rec.type) return false;
    if (rule.amountMin !== undefined && Number.isFinite(Number(rule.amountMin))) {
      if (absAmt < Number(rule.amountMin)) return false;
    }
    if (rule.amountMax !== undefined && Number.isFinite(Number(rule.amountMax))) {
      if (absAmt > Number(rule.amountMax)) return false;
    }
    if (Array.isArray(rule.accounts) && rule.accounts.length > 0) {
      const accVals = rule.accounts.map(x => String(x).toLowerCase());
      const recAcc = (rec.accountId || '').toString().toLowerCase();
      const recAccName = (rec.accountName || '').toString().toLowerCase();
      const accOk = accVals.includes(recAcc) || accVals.includes(recAccName);
      if (!accOk) return false;
    }
    if (rule.regex) {
      try {
        const re = new RegExp(rule.regex, rule.regexFlags || '');
        if (!re.test(text)) return false;
      } catch {}
    }
    if (Array.isArray(rule.keywords) && rule.keywords.length > 0) {
      const kws = rule.keywords.map(k => (k || '').toString().toLowerCase()).filter(Boolean);
      if (!kws.some(k => text.includes(k))) return false;
    }
    return true;
  }

  const rules = Array.isArray(db.rules) ? db.rules.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0)) : [];
  for (const r of rules) {
    if (!r || !r.categoryId) continue;
    if (ruleMatches(r)) {
      const cat = findCategoryById(db, r.categoryId);
      if (cat) {
        return { categoryName: cat.name, categoryId: cat.id };
      }
    }
  }

  for (const [catName, keys] of Object.entries(KEYWORD_MAP)) {
    if (keys.some(k => text.includes(k))) {
      const cat = ensureCategory(db, catName, expType === 'income' ? 'income' : 'expense');
      return { categoryName: cat.name, categoryId: cat.id };
    }
  }

  const unc = ensureCategory(db, 'Uncategorized', expType === 'income' ? 'income' : 'expense');
  return { categoryName: unc.name, categoryId: unc.id };
}

function sumSpentForCategoryMonth(db, categoryId, m) {
  const cat = findCategoryById(db, categoryId);
  if (!cat) return 0;
  return db.transactions.reduce((sum, t) => {
    if (t.type !== 'expense') return sum;
    if (monthKey(t.date) !== m) return sum;
    const matchById = t.categoryId && t.categoryId === categoryId;
    const matchByName = t.category && cat && t.category.toLowerCase() === cat.name.toLowerCase();
    if (!matchById && !matchByName) return sum;
    const amt = Math.abs(Number(t.amount) || 0);
    return sum + amt;
  }, 0);
}

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Summary
app.get('/api/wallet/summary', async (req, res) => {
  try {
    const db = await readDB();
    const totalBalance = db.accounts.reduce((sum, a) => sum + Number(a.balance || 0), 0);
    const totalInvested = db.holdings.reduce((sum, h) => sum + Number(h.quantity || 0) * Number(h.avgPrice || 0), 0);
    const txCount = db.transactions.length;
    res.json({
      currency: db.settings?.baseCurrency || 'USD',
      totals: { cash: totalBalance, invested: totalInvested, netWorth: totalBalance + totalInvested },
      counts: { accounts: db.accounts.length, transactions: txCount, holdings: db.holdings.length }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Accounts
app.get('/api/wallet/accounts', async (req, res) => {
  const db = await readDB();
  res.json(db.accounts);
});

app.post('/api/wallet/accounts', async (req, res) => {
  const { name, type = 'cash', balance = 0 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const db = await readDB();
  const account = { id: genId('acc'), name, type, balance: Number(balance) || 0 };
  db.accounts.push(account);
  await writeDB(db);
  res.json(account);
});

app.patch('/api/wallet/accounts/:id', async (req, res) => {
  const db = await readDB();
  const idx = db.accounts.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  db.accounts[idx] = { ...db.accounts[idx], ...req.body };
  await writeDB(db);
  res.json(db.accounts[idx]);
});

app.delete('/api/wallet/accounts/:id', async (req, res) => {
  const db = await readDB();
  const before = db.accounts.length;
  db.accounts = db.accounts.filter(a => a.id !== req.params.id);
  if (db.accounts.length === before) return res.status(404).json({ error: 'not found' });
  await writeDB(db);
  res.json({ ok: true });
});

// Transactions
app.get('/api/wallet/transactions', async (req, res) => {
  const { accountId, month, startMonth, endMonth, startDate, endDate, category, type, minAmount, maxAmount, limit = 100 } = req.query;
  const db = await readDB();
  let tx = db.transactions.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  if (accountId) tx = tx.filter(t => t.accountId === accountId);
  if (category) {
    const catLower = String(category).toLowerCase();
    tx = tx.filter(t => (t.category || '').toLowerCase() === catLower || t.categoryId === category);
  }
  if (type) {
    const typ = String(type).toLowerCase();
    tx = tx.filter(t => String(t.type).toLowerCase() === typ);
  }
  if (month) {
    tx = tx.filter(t => monthKey(t.date) === month);
  } else if (startMonth || endMonth) {
    const start = startMonth || '0000-00';
    const end = endMonth || '9999-99';
    tx = tx.filter(t => {
      const m = monthKey(t.date);
      return m >= start && m <= end;
    });
  }
  if (startDate) {
    tx = tx.filter(t => String(t.date).slice(0,10) >= String(startDate));
  }
  if (endDate) {
    tx = tx.filter(t => String(t.date).slice(0,10) <= String(endDate));
  }
  const minA = minAmount !== undefined && minAmount !== '' ? Number(minAmount) : undefined;
  const maxA = maxAmount !== undefined && maxAmount !== '' ? Number(maxAmount) : undefined;
  if (Number.isFinite(minA)) tx = tx.filter(t => Number(t.amount) >= minA);
  if (Number.isFinite(maxA)) tx = tx.filter(t => Number(t.amount) <= maxA);
  res.json(tx.slice(0, Number(limit)));
});

async function maybeOverspendNotify(db, tx) {
  try {
    const webhook = process.env.N8N_WEBHOOK_URL;
    if (!webhook) return;
    const m = monthKey(tx.date);
    const cat = findCategoryByName(db, tx.category) || (tx.categoryId ? findCategoryById(db, tx.categoryId) : undefined);
    if (!cat) return;
    const bud = db.budgets.find(b => b.categoryId === cat.id && b.month === m);
    if (!bud) return;
    const spent = sumSpentForCategoryMonth(db, cat.id, m);
    if (spent <= Number(bud.amount || 0)) return;
    const payload = {
      type: 'overspend_alert',
      month: m,
      category: { id: cat.id, name: cat.name },
      budget: Number(bud.amount || 0),
      spent,
      transaction: tx
    };
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch {}
}

app.post('/api/wallet/transactions', async (req, res) => {
  const { date, accountId, type, category, categoryId, amount, note = '' } = req.body || {};
  if (!date || !accountId || !type || typeof amount === 'undefined') {
    return res.status(400).json({ error: 'date, accountId, type, amount required' });
  }
  const db = await readDB();
  const account = db.accounts.find(a => a.id === accountId);
  if (!account) return res.status(400).json({ error: 'invalid accountId' });
  const tx = { id: genId('tx'), date, accountId, type, category: category || '', categoryId: categoryId || undefined, amount: Number(amount), note };
  db.transactions.push(tx);
  account.balance = Number(account.balance || 0) + Number(amount);
  await writeDB(db);
  if (type === 'expense') {
    await maybeOverspendNotify(db, tx);
  }
  res.json(tx);
});

// Holdings
app.get('/api/wallet/holdings', async (req, res) => {
  const db = await readDB();
  res.json(db.holdings);
});

app.post('/api/wallet/holdings', async (req, res) => {
  const { symbol, quantity, avgPrice } = req.body || {};
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const db = await readDB();
  const holding = { id: genId('hold'), symbol, quantity: Number(quantity) || 0, avgPrice: Number(avgPrice) || 0 };
  db.holdings.push(holding);
  await writeDB(db);
  res.json(holding);
});

// Categories
app.get('/api/categories', async (req, res) => {
  const db = await readDB();
  res.json(db.categories);
});

app.post('/api/categories', async (req, res) => {
  const { name, type = 'expense', parentId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const db = await readDB();
  const exists = db.categories.find(c => c.name.toLowerCase() === name.toLowerCase());
  if (exists) return res.status(400).json({ error: 'category exists' });
  const cat = { id: genId('cat'), name, type, parentId: parentId || null };
  db.categories.push(cat);
  await writeDB(db);
  res.json(cat);
});

app.patch('/api/categories/:id', async (req, res) => {
  const db = await readDB();
  const idx = db.categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  db.categories[idx] = { ...db.categories[idx], ...req.body };
  await writeDB(db);
  res.json(db.categories[idx]);
});

app.delete('/api/categories/:id', async (req, res) => {
  const db = await readDB();
  const before = db.categories.length;
  const removed = db.categories.find(c => c.id === req.params.id);
  db.categories = db.categories.filter(c => c.id !== req.params.id);
  if (db.categories.length === before) return res.status(404).json({ error: 'not found' });
  const removedBudgets = db.budgets.filter(b => b.categoryId === req.params.id);
  db.budgets = db.budgets.filter(b => b.categoryId !== req.params.id);
  await writeDB(db);
  res.json({ ok: true, removed, removedBudgets });
});

app.post('/api/categories/restore', async (req, res) => {
  const { category, budgets = [] } = req.body || {};
  if (!category || !category.id || !category.name) return res.status(400).json({ error: 'category{id,name} required' });
  const db = await readDB();
  const exists = db.categories.find(c => c.id === category.id);
  if (exists) return res.status(400).json({ error: 'category id already exists' });
  db.categories.push({ id: category.id, name: category.name, type: category.type || 'expense', parentId: category.parentId || null });
  for (const b of budgets || []) {
    if (!b || !b.id || !b.categoryId || !b.month) continue;
    if (db.budgets.find(x => x.id === b.id)) continue;
    db.budgets.push({ id: b.id, categoryId: b.categoryId, month: b.month, amount: Number(b.amount) || 0 });
  }
  await writeDB(db);
  res.json({ ok: true });
});

// Budgets
app.get('/api/budgets', async (req, res) => {
  const db = await readDB();
  const { month } = req.query;
  if (month) return res.json(db.budgets.filter(b => b.month === month));
  res.json(db.budgets);
});

app.post('/api/budgets', async (req, res) => {
  const { categoryId, month, amount } = req.body || {};
  if (!categoryId || !month) return res.status(400).json({ error: 'categoryId and month required' });
  const db = await readDB();
  const cat = findCategoryById(db, categoryId);
  if (!cat) return res.status(400).json({ error: 'invalid categoryId' });
  const exists = db.budgets.find(b => b.categoryId === categoryId && b.month === month);
  if (exists) return res.status(400).json({ error: 'budget exists for this category & month' });
  const bud = { id: genId('bud'), categoryId, month, amount: Number(amount) || 0 };
  db.budgets.push(bud);
  await writeDB(db);
  res.json(bud);
});

app.patch('/api/budgets/:id', async (req, res) => {
  const db = await readDB();
  const idx = db.budgets.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (req.body.amount !== undefined) db.budgets[idx].amount = Number(req.body.amount) || 0;
  if (req.body.month) db.budgets[idx].month = req.body.month;
  if (req.body.categoryId) db.budgets[idx].categoryId = req.body.categoryId;
  await writeDB(db);
  res.json(db.budgets[idx]);
});

app.delete('/api/budgets/:id', async (req, res) => {
  const db = await readDB();
  const before = db.budgets.length;
  const removed = db.budgets.find(b => b.id === req.params.id);
  db.budgets = db.budgets.filter(b => b.id !== req.params.id);
  if (db.budgets.length === before) return res.status(404).json({ error: 'not found' });
  await writeDB(db);
  res.json({ ok: true, removed });
});

app.post('/api/budgets/restore', async (req, res) => {
  const { budget } = req.body || {};
  if (!budget || !budget.id || !budget.categoryId || !budget.month) return res.status(400).json({ error: 'budget{id,categoryId,month} required' });
  const db = await readDB();
  if (db.budgets.find(b => b.id === budget.id)) return res.status(400).json({ error: 'budget id already exists' });
  if (db.budgets.find(b => b.categoryId === budget.categoryId && b.month === budget.month)) {
    return res.status(400).json({ error: 'budget exists for this category & month' });
  }
  const cat = findCategoryById(db, budget.categoryId);
  if (!cat) return res.status(400).json({ error: 'invalid categoryId' });
  db.budgets.push({ id: budget.id, categoryId: budget.categoryId, month: budget.month, amount: Number(budget.amount) || 0 });
  await writeDB(db);
  res.json({ ok: true });
});

// Rules
app.get('/api/rules', async (req, res) => {
  const db = await readDB();
  res.json(db.rules);
});

app.post('/api/rules', async (req, res) => {
  const { name, keywords, categoryId, type, priority = 0, amountMin, amountMax, accounts, regex, regexFlags } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!categoryId) return res.status(400).json({ error: 'categoryId required' });
  const db = await readDB();
  const cat = findCategoryById(db, categoryId);
  if (!cat) return res.status(400).json({ error: 'invalid categoryId' });

  let kws = keywords;
  if (typeof kws === 'string') {
    kws = kws.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (kws && !Array.isArray(kws)) return res.status(400).json({ error: 'keywords must be string or array' });

  let accs = accounts;
  if (typeof accs === 'string') {
    accs = accs.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (accs && !Array.isArray(accs)) return res.status(400).json({ error: 'accounts must be string or array' });

  const rule = {
    id: genId('rule'),
    name,
    keywords: Array.isArray(kws) ? kws : [],
    categoryId,
    type: type || undefined,
    priority: Number(priority) || 0,
    amountMin: amountMin !== undefined ? Number(amountMin) : undefined,
    amountMax: amountMax !== undefined ? Number(amountMax) : undefined,
    accounts: Array.isArray(accs) ? accs : [],
    regex: regex || undefined,
    regexFlags: regexFlags || undefined
  };
  db.rules.push(rule);
  await writeDB(db);
  res.json(rule);
});

app.patch('/api/rules/:id', async (req, res) => {
  const db = await readDB();
  const idx = db.rules.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const payload = { ...db.rules[idx], ...req.body };
  if (payload.keywords && typeof payload.keywords === 'string') {
    payload.keywords = payload.keywords.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (payload.accounts && typeof payload.accounts === 'string') {
    payload.accounts = payload.accounts.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (payload.amountMin !== undefined) payload.amountMin = Number(payload.amountMin);
  if (payload.amountMax !== undefined) payload.amountMax = Number(payload.amountMax);
  db.rules[idx] = payload;
  await writeDB(db);
  res.json(db.rules[idx]);
});

app.delete('/api/rules/:id', async (req, res) => {
  const db = await readDB();
  const before = db.rules.length;
  db.rules = db.rules.filter(r => r.id !== req.params.id);
  if (db.rules.length === before) return res.status(404).json({ error: 'not found' });
  await writeDB(db);
  res.json({ ok: true });
});

// Reports
app.get('/api/reports/budget', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = await readDB();
    const items = db.budgets
      .filter(b => b.month === month)
      .map(b => {
        const cat = findCategoryById(db, b.categoryId);
        const spent = sumSpentForCategoryMonth(db, b.categoryId, month);
        const budget = Number(b.amount || 0);
        const remaining = budget - spent;
        const percent = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : (spent > 0 ? 100 : 0);
        return {
          id: b.id,
          categoryId: b.categoryId,
          categoryName: cat ? cat.name : b.categoryId,
          month,
          budget,
          spent,
          remaining,
          percent
        };
      });
    res.json({ month, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/budget/overspend', async (req, res) => {
  try {
    const { month } = req.query;
    if (!month) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = await readDB();
    const overs = db.budgets
      .filter(b => b.month === month)
      .map(b => {
        const spent = sumSpentForCategoryMonth(db, b.categoryId, month);
        return { budgetId: b.id, categoryId: b.categoryId, month, budget: Number(b.amount || 0), spent };
      })
      .filter(x => x.spent > x.budget);
    res.json({ month, overs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Import (records prepared on client)
app.post('/api/import/transactions', async (req, res) => {
  try {
    const { records, mapping = {}, autoCategorize: doAuto = true } = req.body || {};
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records[] required' });
    }
    const db = await readDB();

    function pick(obj, names = []) {
      for (const n of names) {
        if (!n) continue;
        if (obj[n] !== undefined && obj[n] !== null && String(obj[n]).length > 0) return obj[n];
      }
      return undefined;
    }

    const defaults = {
      date: mapping.date,
      account: mapping.account || mapping.accountName,
      accountId: mapping.accountId,
      type: mapping.type,
      amount: mapping.amount,
      category: mapping.category,
      note: mapping.note,
      description: mapping.description
    };

    let imported = 0;
    let createdAccounts = 0;
    let autoCatzd = 0;
    const sample = [];

    for (const row of records) {
      const dateStr = pick(row, [defaults.date, 'date', 'Date', 'tanggal', 'Tanggal', 'DTPOSTED', 'D']);
      const accountName = pick(row, [defaults.account, 'account', 'Account', 'akun', 'Akun']);
      let accountId = pick(row, [defaults.accountId, 'accountId', 'AccountId']);
      const ofxAcctId = pick(row, ['ofxAcctId', 'OFXACCTID', 'ACCTID']);
      const typeRaw = (pick(row, [defaults.type, 'type', 'Type', 'TRNTYPE']) || '').toString().toLowerCase();
      let amountRaw = pick(row, [defaults.amount, 'amount', 'Amount', 'nominal', 'Nominal', 'value', 'Value', 'TRNAMT', 'T']);
      const categoryRaw = pick(row, [defaults.category, 'category', 'Category', 'kategori', 'Kategori', 'L']);
      const noteRaw = pick(row, [defaults.note, 'note', 'Note', 'catatan', 'Catatan', 'MEMO', 'M']);
      const descriptionRaw = pick(row, [defaults.description, 'description', 'Description', 'desc', 'Desc', 'merchant', 'Merchant', 'payee', 'Payee', 'NAME', 'P']);

      if (!dateStr) continue;

      let amt = 0;
      if (typeof amountRaw === 'number') {
        amt = amountRaw;
      } else if (typeof amountRaw === 'string') {
        amt = parseFloat(amountRaw.replace(/[^0-9\-.,]/g, '').replace(',', '.'));
      } else {
        amt = 0;
      }
      if (!Number.isFinite(amt)) amt = 0;

      let type = typeRaw;
      if (!type) {
        type = amt < 0 ? 'expense' : 'income';
      } else if (type.startsWith('exp') || type === 'debit') type = 'expense';
      else if (type.startsWith('inc') || type === 'credit') type = 'income';
      else if (type.startsWith('tran')) type = 'transfer';

      if (!accountId && ofxAcctId && db.settings && db.settings.ofxMap && db.settings.ofxMap[ofxAcctId]) {
        accountId = db.settings.ofxMap[ofxAcctId];
      }
      if (!accountId) {
        let acc = db.accounts.find(a => a.name.toLowerCase() === String(accountName || '').toLowerCase());
        if (!acc) {
          const fallbackName = accountName || (ofxAcctId ? `OFX ${ofxAcctId}` : 'Imported');
          acc = { id: genId('acc'), name: fallbackName, type: 'cash', balance: 0 };
          db.accounts.push(acc);
          createdAccounts++;
        }
        accountId = acc.id;
      }

      let categoryName = categoryRaw || '';
      let categoryId = undefined;
      if (!categoryName && doAuto) {
        const auto = autoCategorize(db, { type, amount: amt, category: categoryRaw, note: noteRaw, description: descriptionRaw, accountId, accountName });
        categoryName = auto.categoryName;
        categoryId = auto.categoryId;
        autoCatzd++;
      } else if (categoryName) {
        const c = findCategoryByName(db, categoryName);
        if (c) categoryId = c.id;
      }

      let d = String(dateStr);
      if (/^\d{8,14}$/.test(d)) {
        d = `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
      }
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(d)) {
        const parts = d.split(/[\/']/);
        const mm = parts[0].padStart(2,'0');
        const dd = parts[1].padStart(2,'0');
        let yy = parts[2];
        if (yy.length === 2) yy = `20${yy}`;
        d = `${yy}-${mm}-${dd}`;
      }

      const tx = {
        id: genId('tx'),
        date: d.slice(0, 10),
        accountId,
        type,
        category: categoryName || '',
        categoryId,
        amount: Number(amt),
        note: noteRaw || descriptionRaw || ''
      };
      db.transactions.push(tx);
      const account = db.accounts.find(a => a.id === accountId);
      if (account) account.balance = Number(account.balance || 0) + Number(amt);

      if (sample.length < 5) sample.push(tx);
      imported++;
    }

    await writeDB(db);
    res.json({ imported, createdAccounts, autoCategorized: autoCatzd, sample });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sentiment
async function googleSentiment(text) {
  const key = process.env.GOOGLE_CLOUD_API_KEY;
  if (!key) throw new Error('GOOGLE_CLOUD_API_KEY not set');
  const url = `https://language.googleapis.com/v1/documents:analyzeSentiment?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      document: { type: 'PLAIN_TEXT', content: text },
      encodingType: 'UTF8'
    })
  });
  if (!resp.ok) throw new Error(`Google NLP error: ${resp.status}`);
  return resp.json();
}

async function finnhubSocialSentiment({ symbol, from }) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY not set');
  const url = new URL('https://finnhub.io/api/v1/stock/social-sentiment');
  if (symbol) url.searchParams.set('symbol', symbol);
  if (from) url.searchParams.set('from', from);
  url.searchParams.set('token', key);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub error: ${r.status}`);
  return r.json();
}

async function finnhubNewsSentiment({ symbol }) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY not set');
  const url = new URL('https://finnhub.io/api/v1/news-sentiment');
  if (symbol) url.searchParams.set('symbol', symbol);
  url.searchParams.set('token', key);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub news error: ${r.status}`);
  return r.json();
}

async function finbertSentiment(text) {
  const key = process.env.HUGGINGFACE_API_KEY;
  if (!key) throw new Error('HUGGINGFACE_API_KEY not set');
  const r = await fetch('https://api-inference.huggingface.co/models/ProsusAI/finbert', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ inputs: text })
  });
  if (!r.ok) throw new Error(`FinBERT error: ${r.status}`);
  return r.json();
}

app.post('/api/sentiment/analyze', async (req, res) => {
  try {
    const { provider = 'vader', text = '', symbol, from, type = 'social' } = req.body || {};
    if (provider === 'vader') {
      if (!text) return res.status(400).json({ error: 'text required for VADER' });
      const scores = vader.SentimentIntensityAnalyzer.polarity_scores(text);
      return res.json({ provider: 'vader', scores });
    }
    if (provider === 'google') {
      if (!text) return res.status(400).json({ error: 'text required for Google' });
      const result = await googleSentiment(text);
      return res.json({ provider: 'google', result });
    }
    if (provider === 'finbert') {
      if (!text) return res.status(400).json({ error: 'text required for FinBERT' });
      const result = await finbertSentiment(text);
      return res.json({ provider: 'finbert', result });
    }
    if (provider === 'finnhub') {
      if (!symbol) return res.status(400).json({ error: 'symbol required for Finnhub' });
      const result = type === 'news'
        ? await finnhubNewsSentiment({ symbol })
        : await finnhubSocialSentiment({ symbol, from });
      return res.json({ provider: 'finnhub', result });
    }
    return res.status(400).json({ error: 'unknown provider' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// n8n
app.post('/webhooks/n8n', async (req, res) => {
  try {
    const entry = { at: new Date().toISOString(), body: req.body };
    const line = JSON.stringify(entry);
    if (kvEnabled()) {
      await kvListPush(HOOKS_LIST_KEY, line);
    } else if (denoKvAvailable()) {
      const kv = await getDenoKv();
      const key = ['fin', 'hooks', `${Date.now()}_${Math.random().toString(36).slice(2,8)}`];
      await kv.set(key, line);
    } else {
      await ensureDataFile();
      const logPath = path.join(DATA_DIR, 'hooks.log');
      await fsp.appendFile(logPath, line + '\n');
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/n8n/forward', async (req, res) => {
  try {
    const { url, data } = req.body || {};
    const webhook = url || process.env.N8N_WEBHOOK_URL;
    if (!webhook) return res.status(400).json({ error: 'n8n webhook url missing' });
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data || {})
    });
    const text = await r.text();
    res.json({ status: r.status, ok: r.ok, body: text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read n8n hook logs with paging (limit/offset)
app.get('/webhooks/n8n/logs', async (req, res) => {
  try {
    if (!logsAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
    if (!logsRateOk(req)) return res.status(429).json({ error: 'rate_limited' });

    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    // KV list (Upstash/Vercel)
    if (kvEnabled()) {
      const total = await kvListLen(HOOKS_LIST_KEY);
      if (total === 0) return res.json({ total: 0, items: [] });
      // Compute range to get latest first
      const lastIdx = total - 1 - offset;
      const firstIdx = Math.max(0, lastIdx - (limit - 1));
      if (firstIdx > lastIdx) return res.json({ total, items: [] });
      const arr = await kvListRange(HOOKS_LIST_KEY, firstIdx, lastIdx);
      const items = arr.reverse().map(line => {
        try { return JSON.parse(line); } catch { return { raw: line }; }
      });
      return res.json({ total, items });
    }

    // Deno KV: list keys under ['fin','hooks']
    if (denoKvAvailable()) {
      const kv = await getDenoKv();
      const all = [];
      for await (const entry of kv.list({ prefix: ['fin', 'hooks'] })) {
        all.push(entry);
      }
      const total = all.length;
      const withTs = all.map(e => {
        const k = e.key?.[2] || '';
        const ts = parseInt(String(k).split('_')[0], 10);
        let val = e.value;
        if (typeof val === 'string') {
          try { val = JSON.parse(val); } catch {}
        }
        return { ts: Number.isFinite(ts) ? ts : 0, val };
      }).sort((a, b) => b.ts - a.ts); // latest first
      const items = withTs.slice(offset, offset + limit).map(x => x.val);
      return res.json({ total, items });
    }

    // File-based: data/hooks.log
    await ensureDataFile();
    const logPath = path.join(DATA_DIR, 'hooks.log');
    if (!fs.existsSync(logPath)) return res.json({ total: 0, items: [] });
    const raw = await fsp.readFile(logPath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const total = lines.length;
    const slice = lines.slice().reverse().slice(offset, offset + limit);
    const items = slice.map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    return res.json({ total, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Download logs as JSONL (NDJSON)
app.get('/webhooks/n8n/logs.jsonl', async (req, res) => {
  try {
    if (!logsAuthOk(req)) return res.status(401).end('unauthorized');
    if (!logsRateOk(req)) return res.status(429).end('rate_limited');

    const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 1000));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    let lines = [];
    let total = 0;

    if (kvEnabled()) {
      total = await kvListLen(HOOKS_LIST_KEY);
      if (total > 0) {
        const lastIdx = total - 1 - offset;
        const firstIdx = Math.max(0, lastIdx - (limit - 1));
        if (firstIdx <= lastIdx) {
          const arr = await kvListRange(HOOKS_LIST_KEY, firstIdx, lastIdx);
          lines = arr.reverse(); // newest first
        }
      }
    } else if (denoKvAvailable()) {
      const kv = await getDenoKv();
      const all = [];
      for await (const entry of kv.list({ prefix: ['fin', 'hooks'] })) {
        all.push(entry);
      }
      total = all.length;
      const sorted = all.map(e => {
        const k = e.key?.[2] || '';
        const ts = parseInt(String(k).split('_')[0], 10);
        const val = e.value;
        const str = typeof val === 'string' ? val : JSON.stringify(val);
        return { ts: Number.isFinite(ts) ? ts : 0, str };
      }).sort((a, b) => b.ts - a.ts); // newest first
      lines = sorted.slice(offset, offset + limit).map(x => x.str);
    } else {
      await ensureDataFile();
      const logPath = path.join(DATA_DIR, 'hooks.log');
      if (fs.existsSync(logPath)) {
        const raw = await fsp.readFile(logPath, 'utf-8');
        const arr = raw.split(/\r?\n/).filter(Boolean).reverse(); // newest first
        total = arr.length;
        lines = arr.slice(offset, offset + limit);
      }
    }

    const now = new Date();
    const ts = now.toISOString().replace(/[-:]/g, '').slice(0,15);
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="n8n-logs-${ts}.jsonl"`);
    res.send(lines.join('\n'));
  } catch (e) {
    res.status(500).end('error');
  }
});

// Live SSE stream for n8n hook logs
app.get('/webhooks/n8n/logs/stream', async (req, res) => {
  try {
    if (!logsAuthOk(req)) { res.status(401).end('unauthorized'); return; }
    if (!logsRateOk(req)) { res.status(429).end('rate_limited'); return; }

    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');

    // suggest client retry (ms)
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');

    let timer = null;

    // KV backend
    if (kvEnabled()) {
      let total = await kvListLen(HOOKS_LIST_KEY);
      const initCount = Math.min(10, total);
      if (initCount > 0) {
        const arr = await kvListRange(HOOKS_LIST_KEY, total - initCount, total - 1);
        arr.forEach(line => res.write(`data: ${line}\n\n`));
      }
      let lastIdx = total - 1;
      timer = setInterval(async () => {
        try {
          const newTotal = await kvListLen(HOOKS_LIST_KEY);
          if (newTotal > lastIdx + 1) {
            const arr = await kvListRange(HOOKS_LIST_KEY, lastIdx + 1, newTotal - 1);
            arr.forEach(line => res.write(`data: ${line}\n\n`));
            lastIdx = newTotal - 1;
          } else {
            res.write(': keepalive\n\n');
          }
        } catch {}
      }, 2000);
    }
    // Deno KV backend
    else if (denoKvAvailable()) {
      const kv = await getDenoKv();
      const scan = async () => {
        const all = [];
        for await (const entry of kv.list({ prefix: ['fin', 'hooks'] })) {
          all.push(entry);
        }
        return all.map(e => {
          const k = e.key?.[2] || '';
          const ts = parseInt(String(k).split('_')[0], 10);
          let val = e.value;
          if (typeof val === 'string') {
            try { val = JSON.parse(val); } catch {}
          }
          return { ts: Number.isFinite(ts) ? ts : 0, val, raw: typeof e.value === 'string' ? e.value : JSON.stringify(e.value) };
        }).sort((a, b) => a.ts - b.ts); // oldest first
      };
      let arr = await scan();
      const init = arr.slice(-10);
      init.forEach(x => res.write(`data: ${JSON.stringify(x.val)}\n\n`));
      let lastTs = init.length ? init[init.length - 1].ts : 0;
      timer = setInterval(async () => {
        try {
          const next = await scan();
          const news = next.filter(x => x.ts > lastTs);
          if (news.length) {
            news.forEach(x => res.write(`data: ${JSON.stringify(x.val)}\n\n`));
            lastTs = news[news.length - 1].ts;
          } else {
            res.write(': keepalive\n\n');
          }
        } catch {}
      }, 2000);
    }
    // File backend
    else {
      await ensureDataFile();
      const logPath = path.join(DATA_DIR, 'hooks.log');
      const readLines = async () => {
        if (!fs.existsSync(logPath)) return [];
        const raw = await fsp.readFile(logPath, 'utf-8');
        return raw.split(/\r?\n/).filter(Boolean);
      };
      let lines = await readLines();
      const init = lines.slice(-10);
      init.forEach(l => res.write(`data: ${l}\n\n`));
      let lastCount = lines.length;
      timer = setInterval(async () => {
        try {
          const now = await readLines();
          if (now.length > lastCount) {
            now.slice(lastCount).forEach(l => res.write(`data: ${l}\n\n`));
            lastCount = now.length;
          } else {
            res.write(': keepalive\n\n');
          }
        } catch {}
      }, 2000);
    }

    req.on('close', () => {
      if (timer) clearInterval(timer);
      try { res.end(); } catch {}
    });
  } catch (e) {
    try { res.status(500).end(); } catch {}
  }
});

// Clear n8n logs
app.post('/webhooks/n8n/logs/clear', async (req, res) => {
  try {
    if (!logsAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
    if (!logsRateOk(req)) return res.status(429).json({ error: 'rate_limited' });
    if (kvEnabled()) {
      await kvCmd(['DEL', HOOKS_LIST_KEY]);
      return res.json({ ok: true, backend: 'kv' });
    }
    if (denoKvAvailable()) {
      const kv = await getDenoKv();
      for await (const entry of kv.list({ prefix: ['fin', 'hooks'] })) {
        await kv.delete(entry.key);
      }
      return res.json({ ok: true, backend: 'deno_kv' });
    }
    await ensureDataFile();
    const logPath = path.join(DATA_DIR, 'hooks.log');
    await fsp.writeFile(logPath, '');
    res.json({ ok: true, backend: 'file' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Optional DELETE for clearing logs
app.delete('/webhooks/n8n/logs', async (req, res) => {
  try {
    if (!logsAuthOk(req)) return res.status(401).json({ error: 'unauthorized' });
    if (!logsRateOk(req)) return res.status(429).json({ error: 'rate_limited' });
    if (kvEnabled()) {
      await kvCmd(['DEL', HOOKS_LIST_KEY]);
      return res.json({ ok: true, backend: 'kv' });
    }
    if (denoKvAvailable()) {
      const kv = await getDenoKv();
      for await (const entry of kv.list({ prefix: ['fin', 'hooks'] })) {
        await kv.delete(entry.key);
      }
      return res.json({ ok: true, backend: 'deno_kv' });
    }
    await ensureDataFile();
    const logPath = path.join(DATA_DIR, 'hooks.log');
    await fsp.writeFile(logPath, '');
    res.json({ ok: true, backend: 'file' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Export helpers and endpoints
function filterTransactions(db, query) {
  const { month, startMonth, endMonth, startDate, endDate, accountId, category, type, minAmount, maxAmount } = query;
  let arr = db.transactions.slice().sort((a, b) => (a.date > b.date ? 1 : -1));
  if (accountId) arr = arr.filter(t => t.accountId === accountId);
  if (category) {
    const catLower = String(category).toLowerCase();
    arr = arr.filter(t => (t.category || '').toLowerCase() === catLower || t.categoryId === category);
  }
  if (type) {
    const typ = String(type).toLowerCase();
    arr = arr.filter(t => String(t.type).toLowerCase() === typ);
  }
  if (month) {
    arr = arr.filter(t => monthKey(t.date) === month);
  } else if (startMonth || endMonth) {
    const start = startMonth || '0000-00';
    const end = endMonth || '9999-99';
    arr = arr.filter(t => {
      const m = monthKey(t.date);
      return m >= start && m <= end;
    });
  }
  if (startDate) {
    arr = arr.filter(t => String(t.date).slice(0,10) >= String(startDate));
  }
  if (endDate) {
    arr = arr.filter(t => String(t.date).slice(0,10) <= String(endDate));
  }
  const minA = minAmount !== undefined && minAmount !== '' ? Number(minAmount) : undefined;
  const maxA = maxAmount !== undefined && maxAmount !== '' ? Number(maxAmount) : undefined;
  if (Number.isFinite(minA)) arr = arr.filter(t => Number(t.amount) >= minA);
  if (Number.isFinite(maxA)) arr = arr.filter(t => Number(t.amount) <= maxA);
  return arr;
}

function toCSV(db, txs) {
  const accMap = Object.fromEntries(db.accounts.map(a => [a.id, a]));
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const rows = [];
  rows.push(['date','account','accountId','type','category','amount','note'].map(esc).join(','));
  for (const t of txs) {
    rows.push([
      t.date,
      accMap[t.accountId]?.name || t.accountId,
      t.accountId,
      t.type,
      t.category || '',
      Number(t.amount).toFixed(2),
      t.note || ''
    ].map(esc).join(','));
  }
  return rows.join('\n');
}

function fmtDateMDY(d) {
  const [y, m, day] = String(d).slice(0,10).split('-');
  return `${m}/${day}/${y}`;
}

function toQIF(db, txs) {
  const accMap = Object.fromEntries(db.accounts.map(a => [a.id, a]));
  const lines = ['!Type:Bank'];
  for (const t of txs) {
    lines.push(`D${fmtDateMDY(t.date)}`);
    lines.push(`T${Number(t.amount).toFixed(2)}`);
    const payee = t.category || '';
    lines.push(`P${payee}`);
    if (t.category) lines.push(`L${t.category}`);
    const accName = accMap[t.accountId]?.name || t.accountId || '';
    const memo = t.note ? `${t.note} [${accName}]` : `[${accName}]`;
    if (memo) lines.push(`M${memo}`);
    lines.push('^');
  }
  return lines.join('\n');
}

function fmtDateYYYYMMDD(d) {
  const s = String(d).slice(0,10);
  return s.replace(/-/g, '');
}

function toOFX(db, txs) {
  const accMap = Object.fromEntries(db.accounts.map(a => [a.id, a]));
  const groups = {};
  for (const t of txs) {
    if (!groups[t.accountId]) groups[t.accountId] = [];
    groups[t.accountId].push(t);
  }
  const cur = (db.settings && db.settings.baseCurrency) || 'USD';
  const body = [];
  body.push('<OFX>');
  body.push('<BANKMSGSRSV1>');
  for (const [accId, arr] of Object.entries(groups)) {
    const acc = accMap[accId] || { id: accId, name: accId, type: 'bank' };
    const acctType = acc.type === 'credit' ? 'CREDITLINE' : 'CHECKING';
    body.push('<STMTTRNRS>');
    body.push('<STMTRS>');
    body.push(`<CURDEF>${cur}`);
    body.push('<BANKACCTFROM>');
    body.push('<BANKID>FINDASH');
    body.push(`<ACCTID>${acc.id}`);
    body.push(`<ACCTTYPE>${acctType}`);
    body.push('</BANKACCTFROM>');
    body.push('<BANKTRANLIST>');
    for (const t of arr) {
      const trnType = Number(t.amount) >= 0 ? 'CREDIT' : 'DEBIT';
      const name = (t.category || '').slice(0,32) || 'Transaction';
      const memo = (t.note || '').slice(0,80);
      body.push('<STMTTRN>');
      body.push(`<TRNTYPE>${trnType}`);
      body.push(`<DTPOSTED>${fmtDateYYYYMMDD(t.date)}`);
      body.push(`<TRNAMT>${Number(t.amount).toFixed(2)}`);
      body.push(`<FITID>${t.id}`);
      body.push(`<NAME>${name}`);
      if (memo) body.push(`<MEMO>${memo}`);
      body.push('</STMTTRN>');
    }
    body.push('</BANKTRANLIST>');
    body.push('</STMTRS>');
    body.push('</STMTTRNRS>');
  }
  body.push('</BANKMSGSRSV1>');
  body.push('</OFX>');
  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    ''
  ].join('\n');
  return header + body.join('\n');
}

function sanitizeFile(name) {
  return String(name).replace(/[^a-z0-9._-]+/gi, '_');
}

app.get('/api/export/transactions.csv', async (req, res) => {
  const db = await readDB();
  const txs = filterTransactions(db, req.query);
  const out = toCSV(db, txs);
  const accountId = req.query.accountId;
  const accountName = accountId ? (db.accounts.find(a => a.id === accountId)?.name || accountId) : 'all';
  let timePart = 'all';
  if (req.query.month) timePart = req.query.month;
  else if (req.query.startMonth || req.query.endMonth) timePart = `${req.query.startMonth || 'start'}_${req.query.endMonth || 'end'}`;
  const fname = `transactions-${sanitizeFile(accountName)}-${sanitizeFile(timePart)}.csv`;
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${fname}"`);
  res.send(out);
});

app.get('/api/export/transactions.qif', async (req, res) => {
  const db = await readDB();
  const txs = filterTransactions(db, req.query);
  const out = toQIF(db, txs);
  const accountId = req.query.accountId;
  const accountName = accountId ? (db.accounts.find(a => a.id === accountId)?.name || accountId) : 'all';
  let timePart = 'all';
  if (req.query.month) timePart = req.query.month;
  else if (req.query.startMonth || req.query.endMonth) timePart = `${req.query.startMonth || 'start'}_${req.query.endMonth || 'end'}`;
  const fname = `transactions-${sanitizeFile(accountName)}-${sanitizeFile(timePart)}.qif`;
  res.setHeader('content-type', 'application/x-qif; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${fname}"`);
  res.send(out);
});

app.get('/api/export/transactions.ofx', async (req, res) => {
  const db = await readDB();
  const txs = filterTransactions(db, req.query);
  const out = toOFX(db, txs);
  const accountId = req.query.accountId;
  const accountName = accountId ? (db.accounts.find(a => a.id === accountId)?.name || accountId) : 'all';
  let timePart = 'all';
  if (req.query.month) timePart = req.query.month;
  else if (req.query.startMonth || req.query.endMonth) timePart = `${req.query.startMonth || 'start'}_${req.query.endMonth || 'end'}`;
  const fname = `transactions-${sanitizeFile(accountName)}-${sanitizeFile(timePart)}.ofx`;
  res.setHeader('content-type', 'application/x-ofx; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="${fname}"`);
  res.send(out);
});

// Bulk ZIP
app.get('/api/export/bulk.zip', async (req, res) => {
  const db = await readDB();
  const { mode = 'month', format = 'csv' } = req.query;
  const txs = filterTransactions(db, req.query);
  const zip = new JSZip();

  function sanitize(name) {
    return String(name).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 64);
  }

  if (mode === 'account') {
    const groups = {};
    for (const t of txs) {
      const acc = db.accounts.find(a => a.id === t.accountId);
      const key = acc ? acc.name : t.accountId || 'Account';
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [accName, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = `${sanitize(accName)}.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'account_day') {
    const groups = {};
    for (const t of txs) {
      const acc = db.accounts.find(a => a.id === t.accountId);
      const accName = acc ? acc.name : t.accountId || 'Account';
      const d = String(t.date).slice(0, 10);
      const key = `${accName}__${d}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [key, arr] of Object.entries(groups)) {
      const [accName, d] = key.split('__');
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = `${sanitize(accName)}-${sanitize(d)}.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'account_month') {
    const groups = {};
    for (const t of txs) {
      const acc = db.accounts.find(a => a.id === t.accountId);
      const accName = acc ? acc.name : t.accountId || 'Account';
      const m = monthKey(t.date);
      const key = `${accName}__${m}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [key, arr] of Object.entries(groups)) {
      const [accName, m] = key.split('__');
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = `${sanitize(accName)}-${sanitize(m)}.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'account_month_category') {
    const groups = {};
    for (const t of txs) {
      const acc = db.accounts.find(a => a.id === t.accountId);
      const accName = acc ? acc.name : t.accountId || 'Account';
      const m = monthKey(t.date);
      const cat = t.category || (t.categoryId || 'Uncategorized');
      const key = `${accName}/${m}/${cat}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [key, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = key.split('/').map(sanitize).join('/') + `.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'type_month') {
    const groups = {};
    for (const t of txs) {
      const typ = t.type || 'unknown';
      const m = monthKey(t.date);
      const key = `${typ}/${m}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [key, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = key.split('/').map(sanitize).join('/') + `.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'type_account_month') {
    const groups = {};
    for (const t of txs) {
      const typ = t.type || 'unknown';
      const acc = db.accounts.find(a => a.id === t.accountId);
      const accName = acc ? acc.name : t.accountId || 'Account';
      const m = monthKey(t.date);
      const key = `${typ}/${accName}/${m}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [key, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = key.split('/').map(sanitize).join('/') + `.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'category_month') {
    const groups = {};
    for (const t of txs) {
      const cat = t.category || (t.categoryId || 'Uncategorized');
      const m = monthKey(t.date);
      const key = `${cat}/${m}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [key, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = key.split('/').map(sanitize).join('/') + `.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'category_account_month') {
    const groups = {};
    for (const t of txs) {
      const cat = t.category || (t.categoryId || 'Uncategorized');
      const acc = db.accounts.find(a => a.id === t.accountId);
      const accName = acc ? acc.name : t.accountId || 'Account';
      const m = monthKey(t.date);
      const key = `${cat}/${accName}/${m}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    for (const [key, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = key.split('/').map(sanitize).join('/') + `.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'category') {
    const groups = {};
    for (const t of txs) {
      const cat = t.category || (t.categoryId || 'Uncategorized');
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(t);
    }
    for (const [cat, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = `${sanitize(cat)}.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else if (mode === 'day') {
    const groups = {};
    for (const t of txs) {
      const d = String(t.date).slice(0, 10);
      if (!groups[d]) groups[d] = [];
      groups[d].push(t);
    }
    for (const [d, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = `${sanitize(d)}.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  } else {
    const groups = {};
    for (const t of txs) {
      const m = monthKey(t.date);
      if (!groups[m]) groups[m] = [];
      groups[m].push(t);
    }
    for (const [m, arr] of Object.entries(groups)) {
      let content = '';
      if (format === 'csv') content = toCSV(db, arr);
      else if (format === 'qif') content = toQIF(db, arr);
      else content = toOFX(db, arr);
      const fname = `${sanitize(m)}.${format === 'csv' ? 'csv' : format}`;
      zip.file(fname, content);
    }
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', 'attachment; filename="export.zip"');
  res.send(buffer);
});

// Favicon and SPA fallback
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get(/^\/(?!api|webhooks|n8n).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

// Expose small utils for tests
app._utils = { monthKey, filterTransactions };

module.exports = app;
