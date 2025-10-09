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
  settings: { baseCurrency: 'USD' }
};

async function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    await fsp.writeFile(DB_FILE, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

async function readDB() {
  await ensureDataFile();
  const raw = await fsp.readFile(DB_FILE, 'utf-8');
  return JSON.parse(raw || '{}');
}

async function writeDB(db) {
  await ensureDataFile();
  await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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

app.post('/api/wallet/transactions', async (req, res) => {
  const { date, accountId, type, category, amount, note = '' } = req.body || {};
  if (!date || !accountId || !type || typeof amount === 'undefined') {
    return res.status(400).json({ error: 'date, accountId, type, amount required' });
  }
  const db = await readDB();
  const account = db.accounts.find(a => a.id === accountId);
  if (!account) return res.status(400).json({ error: 'invalid accountId' });
  const tx = { id: genId('tx'), date, accountId, type, category: category || '', amount: Number(amount), note };
  db.transactions.push(tx);
  // Simple balance update
  account.balance = Number(account.balance || 0) + Number(amount);
  await writeDB(db);
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
 * Sentiment routes
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
 * Economic Calendar and Indicators
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
 * AI chat providers
 */
function toAnthropicMessages(openaiMessages) {
  // Convert OpenAI format to Anthropic
  const messages = [];
  let system = undefined;
  for (const m of openaiMessages || []) {
    if (m.role === 'system') {
      system = (system ? system + '\n' : '') + m.content;
    } else if (m.role === 'user' || m.role === 'assistant') {
      messages.push({
        role: m.role,
        content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
      });
    }
  }
  return { system, messages };
}

function toGeminiContents(openaiMessages) {
  const contents = [];
  let systemInstruction = undefined;
  for (const m of openaiMessages || []) {
    if (m.role === 'system') {
      systemInstruction = (systemInstruction ? systemInstruction + '\n' : '') + (m.content || '');
    } else {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
      });
    }
  }
  return { contents, systemInstruction };
}

async function aiChat({ provider, model, messages }) {
  if (provider === 'openai') {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY not set');
    const url = 'https://api.openai.com/v1/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages
      })
    });
    if (!r.ok) throw new Error(`OpenAI error: ${r.status}`);
    const data = await r.json();
    return { content: data.choices?.[0]?.message?.content || '', raw: data };
  }

  if (provider === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    const { system, messages: anthropicMsgs } = toAnthropicMessages(messages);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20240620',
        max_tokens: 1024,
        system,
        messages: anthropicMsgs
      })
    });
    if (!r.ok) throw new Error(`Anthropic error: ${r.status}`);
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    return { content: text, raw: data };
  }

  if (provider === 'gemini') {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set');
    const { contents, systemInstruction } = toGeminiContents(messages);
    const mdl = encodeURIComponent(model || process.env.GEMINI_MODEL || 'gemini-1.5-flash');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(key)}`;
    const body = {
      contents
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Gemini error: ${r.status}`);
    const data = await r.json();
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || '';
    return { content: text, raw: data };
  }

  if (provider === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY not set');
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model || process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages
      })
    });
    if (!r.ok) throw new Error(`Deepseek error: ${r.status}`);
    const data = await r.json();
    return { content: data.choices?.[0]?.message?.content || '', raw: data };
  }

  if (provider === 'qwen') {
    const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
    if (!key) throw new Error('QWEN_API_KEY not set');
    const base = process.env.QWEN_COMPAT_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model || process.env.QWEN_MODEL || 'qwen2.5-72b-instruct',
        messages
      })
    });
    if (!r.ok) throw new Error(`Qwen error: ${r.status}`);
    const data = await r.json();
    return { content: data.choices?.[0]?.message?.content || '', raw: data };
  }

  throw new Error('Unsupported provider');
}

app.post('/api/ai/chat', async (req, res) => {
  try {
    const { provider = 'openai', model, messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages[] required' });
    }
    const result = await aiChat({ provider, model, messages });
    res.json({ provider, model, ...result });
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
