const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const vader = require('vader-sentiment');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

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
  budgets: [
    // { id: 'bud_xxx', categoryId: 'cat_food', month: '2025-01', amount: 200 }
  ]
};

const KEYWORD_MAP = {
  'Food & Dining': ['food','restaurant','cafe','coffee','eat','warung','makan','grabfood','gofood','indomaret','alfamart'],
  'Transport': ['uber','grab','gojek','transport','bus','train','fuel','gas','tol','parking','taxi','angkot','ojek','bensin','bbm'],
  'Entertainment': ['netflix','disney','spotify','movie','game','cinema','hiburan','steam','psn'],
  'Rent': ['rent','sewa','kontrakan','kos','kost','apartemen','apartment'],
  'Salary': ['salary','gaji','payroll','income','penghasilan']
};

async function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    await fsp.writeFile(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

function normalizeDB(db) {
  if (!Array.isArray(db.accounts)) db.accounts = DEFAULT_DB.accounts.slice();
  if (!Array.isArray(db.transactions)) db.transactions = [];
  if (!Array.isArray(db.holdings)) db.holdings = [];
  if (!db.settings) db.settings = { baseCurrency: 'USD' };
  if (!Array.isArray(db.categories)) db.categories = DEFAULT_DB.categories.slice();
  if (!Array.isArray(db.budgets)) db.budgets = [];
  return db;
}

async function readDB() {
  await ensureDataFile();
  const raw = await fsp.readFile(DB_FILE, 'utf-8');
  const parsed = JSON.parse(raw || '{}');
  return normalizeDB(parsed);
}

async function writeDB(db) {
  await ensureDataFile();
  await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2));
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
  // rec: { type, amount, category, note, description, merchant, payee }
  if (rec.category) {
    const existing = findCategoryByName(db, rec.category);
    if (existing) return { categoryName: existing.name, categoryId: existing.id };
  }
  const text = [
    rec.description, rec.note, rec.merchant, rec.payee, rec.category
  ].filter(Boolean).join(' ').toLowerCase();

  // decide expected type
  const expType = rec.type || ((Number(rec.amount) || 0) < 0 ? 'expense' : 'income');

  // Check keywords map
  for (const [catName, keys] of Object.entries(KEYWORD_MAP)) {
    if (keys.some(k => text.includes(k))) {
      const cat = ensureCategory(db, catName, expType === 'income' ? 'income' : 'expense');
      return { categoryName: cat.name, categoryId: cat.id };
    }
  }

  // Fallback Uncategorized
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

// Root route serves the SPA
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Wallet (Dompet) routes
 */

// Summary: balances and PnL snapshot (simple)
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

// Accounts CRUD
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
  const { accountId, limit = 100 } = req.query;
  const db = await readDB();
  let tx = db.transactions.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
  if (accountId) tx = tx.filter(t => t.accountId === accountId);
  res.json(tx.slice(0, Number(limit)));
});

async function maybeOverspendNotify(db, tx) {
  try {
    const webhook = process.env.N8N_WEBHOOK_URL;
    if (!webhook) return;
    const m = monthKey(tx.date);
    const cat = findCategoryByName(db, tx.category) || (tx.categoryId ? findCategoryById(db, tx.categoryId) : undefined);
    if (!cat) return;
    // Find a budget for this category in this month
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
  } catch {
    // ignore notify errors
  }
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
  // Simple balance update
  account.balance = Number(account.balance || 0) + Number(amount);
  await writeDB(db);
  // trigger overspend notification if applicable
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

/**
 * Categories
 */
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
  db.categories = db.categories.filter(c => c.id !== req.params.id);
  if (db.categories.length === before) return res.status(404).json({ error: 'not found' });
  // remove budgets referencing this category
  db.budgets = db.budgets.filter(b => b.categoryId !== req.params.id);
  await writeDB(db);
  res.json({ ok: true });
});

/**
 * Budgets
 */
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
  db.budgets = db.budgets.filter(b => b.id !== req.params.id);
  if (db.budgets.length === before) return res.status(404).json({ error: 'not found' });
  await writeDB(db);
  res.json({ ok: true });
});

// Budget report and overspend
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

// Import transactions from parsed CSV records
app.post('/api/import/transactions', async (req, res) => {
  try {
    const { records, mapping = {}, autoCategorize: doAuto = true } = req.body || {};
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ error: 'records[] required' });
    }
    const db = await readDB();

    function pick(obj, names = []) {
      for (const n of names) {
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
      // Try to match columns
      const dateStr = pick(row, [defaults.date, 'date', 'Date', 'tanggal', 'Tanggal']);
      const accountName = pick(row, [defaults.account, 'account', 'Account', 'akun', 'Akun']);
      const accountId = pick(row, [defaults.accountId, 'accountId', 'AccountId']);
      const typeRaw = (pick(row, [defaults.type, 'type', 'Type']) || '').toString().toLowerCase();
      let amountRaw = pick(row, [defaults.amount, 'amount', 'Amount', 'nominal', 'Nominal', 'value', 'Value']);
      const categoryRaw = pick(row, [defaults.category, 'category', 'Category', 'kategori', 'Kategori']);
      const noteRaw = pick(row, [defaults.note, 'note', 'Note', 'catatan', 'Catatan']);
      const descriptionRaw = pick(row, [defaults.description, 'description', 'Description', 'desc', 'Desc', 'merchant', 'Merchant', 'payee', 'Payee']);

      if (!dateStr) continue;

      // Parse amount
      let amt = 0;
      if (typeof amountRaw === 'number') {
        amt = amountRaw;
      } else if (typeof amountRaw === 'string') {
        amt = parseFloat(amountRaw.replace(/[^0-9\-.,]/g, '').replace(',', '.'));
      } else {
        amt = 0;
      }
      if (!Number.isFinite(amt)) amt = 0;

      // Determine type
      let type = typeRaw;
      if (!type) {
        type = amt < 0 ? 'expense' : 'income';
      } else if (type.startsWith('exp')) type = 'expense';
      else if (type.startsWith('inc')) type = 'income';
      else if (type.startsWith('tran')) type = 'transfer';

      // Account
      let accId = accountId;
      if (!accId) {
        let acc = db.accounts.find(a => a.name.toLowerCase() === String(accountName || 'Cash').toLowerCase());
        if (!acc) {
          acc = { id: genId('acc'), name: accountName || 'Imported', type: 'cash', balance: 0 };
          db.accounts.push(acc);
          createdAccounts++;
        }
        accId = acc.id;
      }

      // Category
      let categoryName = categoryRaw || '';
      let categoryId = undefined;
      if (!categoryName && doAuto) {
        const auto = autoCategorize(db, { type, amount: amt, category: categoryRaw, note: noteRaw, description: descriptionRaw });
        categoryName = auto.categoryName;
        categoryId = auto.categoryId;
        autoCatzd++;
      } else if (categoryName) {
        const c = findCategoryByName(db, categoryName);
        if (c) categoryId = c.id;
      }

      // Build transaction
      const tx = {
        id: genId('tx'),
        date: String(dateStr).slice(0, 10),
        accountId: accId,
        type,
        category: categoryName || '',
        categoryId,
        amount: Number(amt),
        note: noteRaw || descriptionRaw || ''
      };
      db.transactions.push(tx);

      // Update balance
      const account = db.accounts.find(a => a.id === accId);
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

/**
 * Sentiment routes (existing)
 */
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

/**
 * Economic Calendar and Indicators (existing)
 */
app.get('/api/calendar/tradingeconomics', async (req, res) => {
  try {
    const { country, start, end, importance } = req.query;
    const client = process.env.TRADINGECONOMICS_CLIENT || 'guest';
    const secret = process.env.TRADINGECONOMICS_SECRET || 'guest';
    const auth = `${client}:${secret}`;
    const url = new URL('https://api.tradingeconomics.com/calendar');
    url.searchParams.set('format', 'json');
    url.searchParams.set('c', auth);
    if (country) url.searchParams.set('country', country);
    if (start) url.searchParams.set('d1', start);
    if (end) url.searchParams.set('d2', end);
    if (importance) url.searchParams.set('importance', importance);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`TradingEconomics error: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Alpha Vantage Macro Indicators (not calendar events, but useful)
app.get('/api/indicators/alphavantage', async (req, res) => {
  try {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    if (!key) return res.status(400).json({ error: 'ALPHA_VANTAGE_API_KEY not set' });
    const { func = 'REAL_GDP', interval = 'annual' } = req.query;
    const url = new URL('https://www.alphavantage.co/query');
    url.searchParams.set('function', func);
    if (interval) url.searchParams.set('interval', interval);
    url.searchParams.set('apikey', key);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Alpha Vantage error: ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * n8n integration
 * - Receive webhooks from n8n
 * - Forward to n8n webhook
 */
app.post('/webhooks/n8n', async (req, res) => {
  try {
    await ensureDataFile();
    const logPath = path.join(DATA_DIR, 'hooks.log');
    const entry = { at: new Date().toISOString(), body: req.body };
    await fsp.appendFile(logPath, JSON.stringify(entry) + '\n');
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

// Handle favicon to avoid 404 noise
app.get('/favicon.ico', (req, res) => res.status(204).end());

// SPA history fallback for non-API routes
app.get(/^\/(?!api|webhooks|n8n).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
