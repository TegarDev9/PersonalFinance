/**
 * Minimal unit tests for server-side filters.
 * Run: node scripts/test_filters.js
 */
const assert = require('assert');

const app = require('../index.js');
const { filterTransactions, monthKey } = app._utils || {};

assert(filterTransactions, 'filterTransactions utility not exposed');

const db = {
  accounts: [
    { id: 'a1', name: 'Cash', type: 'cash' },
    { id: 'a2', name: 'Bank', type: 'bank' }
  ],
  transactions: [
    { id: 't1', date: '2025-01-01', accountId: 'a1', type: 'income', category: 'Salary', amount: 1000, note: '' },
    { id: 't2', date: '2025-01-05', accountId: 'a1', type: 'expense', category: 'Food & Dining', amount: -50, note: '' },
    { id: 't3', date: '2025-01-10', accountId: 'a2', type: 'expense', category: 'Transport', amount: -20, note: '' },
    { id: 't4', date: '2025-02-02', accountId: 'a2', type: 'expense', category: 'Food & Dining', amount: -30, note: '' }
  ],
  categories: [],
  budgets: [],
  rules: []
};

// month filter
let out = filterTransactions(db, { month: '2025-01' });
assert.strictEqual(out.length, 3, 'Month 2025-01 should return 3 rows');

// type filter
out = filterTransactions(db, { type: 'expense' });
assert.strictEqual(out.length, 3, 'Type expense should return 3 rows');

// account filter
out = filterTransactions(db, { accountId: 'a1' });
assert.strictEqual(out.length, 2, 'Account a1 should return 2 rows');

// date range filter
out = filterTransactions(db, { startDate: '2025-01-03', endDate: '2025-01-10' });
assert.strictEqual(out.length, 2, 'Date range 2025-01-03..2025-01-10 should return 2 rows');

// amount filters
out = filterTransactions(db, { minAmount: 0 });
assert.strictEqual(out.length, 1, 'minAmount=0 should return only non-negative (income) rows');

out = filterTransactions(db, { maxAmount: -25 });
assert.strictEqual(out.length, 2, 'maxAmount=-25 should return expenses <= -25');

console.log('test_filters: OK');