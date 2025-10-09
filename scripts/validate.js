/**
 * Quick validation script for FinDash data.
 * - Works with local file (data/db.json) or KV (Vercel KV/Upstash) if env is set.
 *
 * Usage:
 *   node scripts/validate.js
 *
 * Env (optional):
 *   KV_REST_API_URL / KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
 *   KV_DB_KEY (default: fin:db)
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
require('dotenv').config();

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = process.env.KV_DB_KEY || 'fin:db';
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
async function kvGet(key) {
  const data = await kvCmd(['GET', key]);
  return data && data.result !== undefined ? data.result : null;
}

async function readDB() {
  if (kvEnabled()) {
    const raw = await kvGet(KV_KEY);
    if (!raw) throw new Error('No data in KV. Start the server once to seed.');
    return JSON.parse(raw);
  } else {
    const raw = await fsp.readFile(DB_FILE, 'utf-8');
    return JSON.parse(raw || '{}');
  }
}

function error(msg) {
  console.error(`ERROR: ${msg}`);
}
function warn(msg) {
  console.warn(`WARN: ${msg}`);
}
function info(msg) {
  console.log(`INFO: ${msg}`);
}

(async () => {
  try {
    const db = await readDB();
    const categories = db.categories || [];
    const budgets = db.budgets || [];
    const txs = db.transactions || [];
    const rules = db.rules || [];

    info(`Counts: accounts=${(db.accounts || []).length}, tx=${txs.length}, categories=${categories.length}, budgets=${budgets.length}, rules=${rules.length}`);

    // 1) Duplicate budgets by categoryId+month
    let dupErr = 0;
    const seen = new Set();
    for (const b of budgets) {
      const key = `${b.categoryId}|${b.month}`;
      if (seen.has(key)) {
        error(`Duplicate budget for categoryId=${b.categoryId} month=${b.month}`);
        dupErr++;
      } else {
        seen.add(key);
      }
    }

    // 2) Budgets reference missing category
    let missBudCat = 0;
    for (const b of budgets) {
      if (!categories.find(c => c.id === b.categoryId)) {
        error(`Budget ${b.id} references missing categoryId=${b.categoryId}`);
        missBudCat++;
      }
    }

    // 3) Transactions category check (warn-level)
    let missTxCat = 0;
    for (const t of txs) {
      if (t.categoryId && !categories.find(c => c.id === t.categoryId)) {
        warn(`Tx ${t.id} has unknown categoryId=${t.categoryId}`);
        missTxCat++;
      }
    }

    // 4) Rule regex validation
let regexErr = 0;
for (const r of rules) {
  if (r.regex) {
    try {
      new RegExp(r.regex, r.regexFlags || '');
    } catch (e) {
      error(`Rule ${r.id} invalid regex: /${r.regex}/${r.regexFlags || ''} -> ${e.message}`);
      regexErr++;
    }
  }
}

// 5) Rules reference missing category
let ruleCatErr = 0;
for (const r of rules) {
  if (r.categoryId && !categories.find(c => c.id === r.categoryId)) {
    error(`Rule ${r.id} references missing categoryId=${r.categoryId}`);
    ruleCatErr++;
  }
}

// 6) Orphaned accounts in transactions
let orphanAccErr = 0;
const accounts = db.accounts || [];
for (const t of txs) {
  if (!accounts.find(a => a.id === t.accountId)) {
    error(`Tx ${t.id} references missing accountId=${t.accountId}`);
    orphanAccErr++;
  }
}

// 7) Type-sign mismatch (negative expenses detection)
let typeSignErr = 0;
for (const t of txs) {
  const amt = Number(t.amount);
  if (t.type === 'expense' && amt > 0) {
    error(`Tx ${t.id} is expense but amount > 0 (${amt})`);
    typeSignErr++;
  } else if (t.type === 'income' && amt < 0) {
    error(`Tx ${t.id} is income but amount < 0 (${amt})`);
    typeSignErr++;
  }
}

// 8) Date format warnings
let dateWarn = 0;
for (const t of txs) {
  const d = String(t.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    warn(`Tx ${t.id} has non-ISO date ${d}`);
    dateWarn++;
  }
}

// 9) Duplicate account names (warn)
let dupAccWarn = 0;
const nameCounts = {};
for (const a of accounts) {
  const key = (a.name || '').toLowerCase();
  nameCounts[key] = (nameCounts[key] || 0) + 1;
}
for (const [k, cnt] of Object.entries(nameCounts)) {
  if (k && cnt > 1) {
    warn(`Duplicate account name "${k}" x${cnt}`);
    dupAccWarn++;
  }
}

if (dupErr || missBudCat || regexErr || ruleCatErr || orphanAccErr || typeSignErr) {
  error(`Validation failed. duplicateBudgets=${dupErr}, missingBudgetCategory=${missBudCat}, invalidRegex=${regexErr}, missingRuleCategory=${ruleCatErr}, orphanAccounts=${orphanAccErr}, typeSignMismatch=${typeSignErr}`);
  process.exit(1);
} else {
  info('Validation passed.');
  if (missTxCat) warn(`There are ${missTxCat} transactions with unknown categoryId (warning only).`);
  if (dateWarn) warn(`${dateWarn} transactions have non-ISO dates (warning).`);
  if (dupAccWarn) warn(`${dupAccWarn} duplicated account names detected (warning).`);
  process.exit(0);
} transactions with unknown categoryId (warning only).`);
      process.exit(0);
    }
  } catch (e) {
    error(e.message);
    process.exit(1);
  }
})();