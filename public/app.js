/* Simple SPA controller */
const views = ['wallet', 'trading', 'sentiment', 'calendar', 'ai'];
const state = {
  messages: [{ role: 'system', content: 'You are an AI assistant for finance and trading analysis.' }],
  chart: null,
  categories: [],
  month: null,
  csvRecords: [],
  csvHeaders: []
};

function show(view) {
  views.forEach(v => {
    document.getElementById(`view_${v}`)?.classList.toggle('hidden', v !== view);
  });
  const titleEl = document.getElementById('viewTitle');
  if (titleEl) {
    titleEl.textContent = ({
      wallet: 'Dompet',
      trading: 'Trading',
      sentiment: 'Sentiment',
      calendar: 'Economic Calendar',
      ai: 'AI Chat'
    })[view];
  }
}

document.getElementById('sidebar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  show(btn.dataset.view);
  if (btn.dataset.view === 'wallet') {
    refreshSummary();
    loadAccounts();
    loadTransactions();
    loadCategories();
    initBudgetMonth();
    loadBudgetReport();
  }
});

async function jsonFetch(url, opts = {}) {
  const r = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...opts
  });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

function monthVal(d = new Date()) {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${y}-${m}`;
}

/* Summary bar */
async function refreshSummary() {
  const data = await jsonFetch('/api/wallet/summary');
  const el = document.getElementById('summaryBar');
  if (el && data && data.totals) {
    const c = data.currency || 'USD';
    el.textContent = `Cash: ${data.totals.cash.toFixed(2)} ${c} • Invested: ${data.totals.invested.toFixed(2)} ${c} • Net Worth: ${data.totals.netWorth.toFixed(2)} ${c}`;
  }
}

/* Accounts */
async function loadAccounts() {
  const list = document.getElementById('accountsList');
  const sel = document.getElementById('txAccount');
  const accounts = await jsonFetch('/api/wallet/accounts');
  if (!list || !sel) return;
  list.innerHTML = '';
  sel.innerHTML = '';
  accounts.forEach(a => {
    const li = document.createElement('li');
    li.className = 'flex items-center justify-between border rounded-lg px-3 py-2';
    li.innerHTML = `<div>
      <div class="font-medium text-slate-800">${a.name}</div>
      <div class="text-xs text-slate-500">${a.type}</div>
    </div>
    <div class="font-semibold">${(a.balance || 0).toFixed(2)}</div>`;
    list.appendChild(li);

    const option = document.createElement('option');
    option.value = a.id;
    option.textContent = `${a.name} (${a.type})`;
    sel.appendChild(option);
  });

  // fill export account select
  const expSel = document.getElementById('expAccount');
  if (expSel) {
    expSel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Accounts';
    expSel.appendChild(allOpt);
    accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      expSel.appendChild(opt);
    });
  }

  // fill rule accounts multiselect
  const ruleAccSel = document.getElementById('ruleAccounts');
  if (ruleAccSel) {
    ruleAccSel.innerHTML = '';
    accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = `${a.name} (${a.type})`;
      ruleAccSel.appendChild(opt);
    });
  }

  renderOverview(accounts);
}

document.getElementById('addAccountForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.balance = Number(body.balance || 0);
  const res = await jsonFetch('/api/wallet/accounts', { method: 'POST', body: JSON.stringify(body) });
  if (res && !res.error) {
    e.target.reset();
    loadAccounts();
    refreshSummary();
  } else {
    alert(res.error || 'Failed');
  }
});

/* Transactions */
async function loadTransactions() {
  const data = await jsonFetch('/api/wallet/transactions?limit=50');
  const dbAccounts = await jsonFetch('/api/wallet/accounts');
  const accMap = Object.fromEntries(dbAccounts.map(a => [a.id, a]));
  const tbody = document.getElementById('txTable');
  if (!tbody) return;
  tbody.innerHTML = '';
  (data || []).forEach(t => {
    const tr = document.createElement('tr');
    tr.className = 'border-t';
    tr.innerHTML = `
      <td class="py-2">${t.date}</td>
      <td>${accMap[t.accountId]?.name || t.accountId}</td>
      <td class="${t.type === 'income' ? 'text-green-600' : t.type === 'expense' ? 'text-red-600' : 'text-slate-600'}">${t.type}</td>
      <td>${t.category || ''}</td>
      <td class="text-right font-medium">${Number(t.amount).toFixed(2)}</td>
    `;
    tbody.appendChild(tr);
  });
}

document.getElementById('addTxForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.amount = Number(body.amount || 0);
  const res = await jsonFetch('/api/wallet/transactions', { method: 'POST', body: JSON.stringify(body) });
  if (res && !res.error) {
    e.target.reset();
    loadTransactions();
    refreshSummary();
    loadBudgetReport(); // update budgets if needed
  } else {
    alert(res.error || 'Failed');
  }
});

/* Overview chart */
function renderOverview(accounts) {
  const ctx = document.getElementById('overviewChart');
  const labels = accounts.map(a => a.name);
  const data = accounts.map(a => a.balance || 0);
  if (!ctx) return;
  if (state.chart) {
    state.chart.data.labels = labels;
    state.chart.data.datasets[0].data = data;
    state.chart.update();
    return;
  }
  state.chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4']
      }]
    },
    options: {
      plugins: {
        legend: { position: 'bottom' }
      }
    }
  });
}

/* Undo/Redo */
state.undoStack = state.undoStack || [];
state.redoStack = state.redoStack || [];

function saveUndoRedo() {
  try {
    localStorage.setItem('finUndo', JSON.stringify(state.undoStack));
    localStorage.setItem('finRedo', JSON.stringify(state.redoStack));
  } catch {}
}

function pushUndo(action) {
  state.undoStack.push(action);
  state.redoStack = [];
  saveUndoRedo();
  updateUndoBar();
}

async function doUndo() {
  const a = state.undoStack.pop();
  if (!a) return;
  if (a.type === 'delete_category') {
    await jsonFetch('/api/categories/restore', {
      method: 'POST',
      body: JSON.stringify({ category: a.item, budgets: a.removedBudgets || [] })
    });
    await loadCategories();
    await loadBudgetReport();
  } else if (a.type === 'delete_budget') {
    await jsonFetch('/api/budgets/restore', {
      method: 'POST',
      body: JSON.stringify({ budget: a.item })
    });
    await loadBudgetReport();
  }
  state.redoStack.push(a);
  saveUndoRedo();
  updateUndoBar();
}

async function doRedo() {
  const a = state.redoStack.pop();
  if (!a) return;
  if (a.type === 'delete_category') {
    await jsonFetch(`/api/categories/${encodeURIComponent(a.item.id)}`, { method: 'DELETE' });
    await loadCategories();
    await loadBudgetReport();
  } else if (a.type === 'delete_budget') {
    await jsonFetch(`/api/budgets/${encodeURIComponent(a.item.id)}`, { method: 'DELETE' });
    await loadBudgetReport();
  }
  state.undoStack.push(a);
  saveUndoRedo();
  updateUndoBar();
}

function updateUndoBar() {
  const bar = document.getElementById('undoBar');
  if (!bar) return;
  const has = state.undoStack.length > 0 || state.redoStack.length > 0;
  bar.classList.toggle('hidden', !has);
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    doUndo();
  } else if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    doRedo();
  }
});
document.getElementById('undoBtn')?.addEventListener('click', doUndo);
document.getElementById('redoBtn')?.addEventListener('click', doRedo);

/* Categories & Budgets */
function initBudgetMonth() {
  const m = document.getElementById('budMonth');
  if (m && !m.value) m.value = monthVal();
  const em = document.getElementById('expMonth');
  if (em && !em.value) em.value = m?.value || monthVal();
  state.month = m?.value || monthVal();
}

async function loadCategories() {
  const data = await jsonFetch('/api/categories');
  state.categories = Array.isArray(data) ? data : [];
  // datalist for tx form
  const dl = document.getElementById('catList');
  if (dl) {
    dl.innerHTML = '';
    state.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name;
      dl.appendChild(opt);
    });
  }
  // budget category select
  const sel = document.getElementById('budCategory');
  if (sel) {
    sel.innerHTML = '';
    state.categories
      .filter(c => c.type === 'expense')
      .forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.name;
        sel.appendChild(opt);
      });
  }
  // rule category select
  const ruleSel = document.getElementById('ruleCategory');
  if (ruleSel) {
    ruleSel.innerHTML = '';
    state.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.type})`;
      ruleSel.appendChild(opt);
    });
  }
  // export category
  const expCatSel = document.getElementById('expCategory');
  if (expCatSel) {
    expCatSel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = 'All Categories';
    expCatSel.appendChild(allOpt);
    state.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      expCatSel.appendChild(opt);
    });
  }
  renderCategoryList();
  loadRules();
}

function renderCategoryList() {
  const wrap = document.getElementById('categoryList');
  if (!wrap) return;
  wrap.innerHTML = '';
  state.categories.forEach(c => {
    const row = document.createElement('div');
    row.className = 'py-2';
    row.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <div class="font-medium text-slate-800">${c.name}</div>
          <div class="text-xs text-slate-500">${c.type}</div>
        </div>
        <div class="flex gap-2">
          <button class="px-2 py-1 border rounded text-xs cat-edit" title="Edit (E)">Edit</button>
          <button class="px-2 py-1 border rounded text-xs cat-delete" title="Delete (Del)">Delete</button>
        </div>
      </div>
      <div class="mt-2 hidden cat-edit-form">
        <div class="flex items-center gap-2">
          <input type="text" class="border rounded px-2 py-1 text-sm cat-name" value="${c.name}">
          <select class="border rounded px-2 py-1 text-sm cat-type">
            <option value="expense" ${c.type === 'expense' ? 'selected' : ''}>Expense</option>
            <option value="income" ${c.type === 'income' ? 'selected' : ''}>Income</option>
            <option value="transfer" ${c.type === 'transfer' ? 'selected' : ''}>Transfer</option>
          </select>
          <button class="px-2 py-1 bg-brand-600 text-white rounded text-xs cat-save">Save</button>
          <button class="px-2 py-1 border rounded text-xs cat-cancel">Cancel</button>
        </div>
      </div>
    `;
    const btnEdit = row.querySelector('.cat-edit');
    const btnDelete = row.querySelector('.cat-delete');
    const editForm = row.querySelector('.cat-edit-form');
    const btnSave = row.querySelector('.cat-save');
    const btnCancel = row.querySelector('.cat-cancel');
    const nameInput = row.querySelector('.cat-name');
    const typeSel = row.querySelector('.cat-type');

    row.tabIndex = 0;
    row.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'e') {
        editForm.classList.remove('hidden');
      } else if (e.key === 'Delete') {
        btnDelete.click();
      }
    });

    btnEdit.addEventListener('click', () => {
      editForm.classList.remove('hidden');
    });
    btnCancel.addEventListener('click', () => {
      editForm.classList.add('hidden');
      nameInput.value = c.name;
      typeSel.value = c.type;
    });
    btnSave.addEventListener('click', async () => {
      const body = { name: nameInput.value.trim(), type: typeSel.value };
      const res = await jsonFetch(`/api/categories/${encodeURIComponent(c.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      });
      if (res && !res.error) {
        await loadCategories();
      } else {
        alert(res.error || 'Failed to update category');
      }
    });
    btnDelete.addEventListener('click', async () => {
      if (!confirm(`Delete category "${c.name}"? This will also remove budgets for it.`)) return;
      const res = await jsonFetch(`/api/categories/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (res && !res.error) {
        pushUndo({ type: 'delete_category', item: res.removed, removedBudgets: res.removedBudgets || [] });
        await loadCategories();
        await loadBudgetReport();
      } else {
        alert(res.error || 'Failed to delete category');
      }
    });

    wrap.appendChild(row);
  });
}

/* Add category */
document.getElementById('addCategoryForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  const res = await jsonFetch('/api/categories', { method: 'POST', body: JSON.stringify(body) });
  if (res && !res.error) {
    e.target.reset();
    await loadCategories();
  } else {
    alert(res.error || 'Failed to add category');
  }
});

document.getElementById('budMonth')?.addEventListener('change', () => {
  state.month = document.getElementById('budMonth').value || monthVal();
  loadBudgetReport();
});

/* Add budget */
document.getElementById('addBudgetForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.month = state.month || monthVal();
  body.amount = Number(body.amount || 0);
  const res = await jsonFetch('/api/budgets', { method: 'POST', body: JSON.stringify(body) });
  if (res && !res.error) {
    e.target.reset();
    loadBudgetReport();
  } else {
    alert(res.error || 'Failed to add budget');
  }
});

/* Budget report */
async function loadBudgetReport() {
  const month = state.month || monthVal();
  const res = await jsonFetch(`/api/reports/budget?month=${encodeURIComponent(month)}`);
  const list = document.getElementById('budgetList');
  const oversEl = document.getElementById('overspendList');
  const summaryEl = document.getElementById('budgetSummary');
  if (!list) return;
  list.innerHTML = '';
  const items = res?.items || [];

  // Summary
  if (summaryEl) {
    const totalBudget = items.reduce((s, it) => s + (it.budget || 0), 0);
    const totalSpent = items.reduce((s, it) => s + (it.spent || 0), 0);
    const remaining = totalBudget - totalSpent;
    const pct = totalBudget > 0 ? Math.min(100, Math.round((totalSpent / totalBudget) * 100)) : (totalSpent > 0 ? 100 : 0);
    summaryEl.textContent = `This month: Spent ${totalSpent.toFixed(2)} / Budget ${totalBudget.toFixed(2)} • Remaining ${remaining.toFixed(2)} • ${pct}% used`;
  }

  // Rows
  items.forEach(it => {
    const pct = it.percent || 0;
    const row = document.createElement('div');
    row.className = 'p-3 bg-white border rounded-lg';
    row.tabIndex = 0;
    row.dataset.bid = it.id;
    row.innerHTML = `
      <div class="flex items-center justify-between">
        <div class="font-medium text-slate-800">${it.categoryName}</div>
        <div class="flex items-center gap-2">
          <div class="text-sm text-slate-600"><span class="spent-val">${it.spent.toFixed(2)}</span> / <span class="budget-val">${it.budget.toFixed(2)}</span></div>
          <button class="px-2 py-1 border rounded text-xs bud-edit" title="Edit (E)">Edit</button>
          <button class="px-2 py-1 border rounded text-xs bud-delete" title="Delete (Del)">Delete</button>
        </div>
      </div>
      <div class="w-full h-2 bg-slate-100 rounded mt-2 overflow-hidden">
        <div class="h-2 ${it.spent > it.budget ? 'bg-red-500' : 'bg-brand-600'}" style="width: ${pct}%;"></div>
      </div>
      <div class="text-xs text-slate-500 mt-1">${pct}% used · Remaining ${it.remaining.toFixed(2)}</div>
      <div class="mt-2 hidden bud-edit-form">
        <div class="flex items-center gap-2">
          <input type="number" step="0.01" class="border rounded px-2 py-1 text-sm bud-amount" value="${it.budget.toFixed(2)}">
          <button class="px-2 py-1 bg-brand-600 text-white rounded text-xs bud-save">Save</button>
          <button class="px-2 py-1 border rounded text-xs bud-cancel">Cancel</button>
        </div>
      </div>
    `;
    const editBtn = row.querySelector('.bud-edit');
    const delBtn = row.querySelector('.bud-delete');
    const form = row.querySelector('.bud-edit-form');
    const amountInput = row.querySelector('.bud-amount');
    const saveBtn = row.querySelector('.bud-save');
    const cancelBtn = row.querySelector('.bud-cancel');

    row.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'e') {
        form.classList.remove('hidden');
        amountInput.focus();
      } else if (e.key === 'Delete') {
        delBtn.click();
      }
    });

    editBtn.addEventListener('click', () => {
      form.classList.remove('hidden');
      amountInput.focus();
    });
    cancelBtn.addEventListener('click', () => {
      form.classList.add('hidden');
      amountInput.value = it.budget.toFixed(2);
    });
    saveBtn.addEventListener('click', async () => {
      const amt = Number(amountInput.value || 0);
      const r = await jsonFetch(`/api/budgets/${encodeURIComponent(it.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ amount: amt })
      });
      if (r && !r.error) {
        form.classList.add('hidden');
        loadBudgetReport();
      } else {
        alert(r.error || 'Failed to update budget');
      }
    });
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete budget for "${it.categoryName}" (${month})?`)) return;
      const r = await jsonFetch(`/api/budgets/${encodeURIComponent(it.id)}`, { method: 'DELETE' });
      if (r && !r.error) {
        pushUndo({ type: 'delete_budget', item: r.removed });
        loadBudgetReport();
      } else {
        alert(r.error || 'Failed to delete budget');
      }
    });

    list.appendChild(row);
  });

  if (oversEl) {
    const overs = await jsonFetch(`/api/budget/overspend?month=${encodeURIComponent(month)}`);
    oversEl.innerHTML = '';
    if (overs?.overs?.length) {
      const wrap = document.createElement('div');
      wrap.className = 'p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700';
      wrap.innerHTML = `<div class="font-medium mb-1">Overspending Alerts</div>
        <ul class="list-disc ml-5">${overs.overs.map(o => {
          const cat = state.categories.find(c => c.id === o.categoryId);
          const name = cat ? cat.name : o.categoryId;
          return `<li>${name}: spent ${o.spent.toFixed(2)} > budget ${o.budget.toFixed(2)}</li>`;
        }).join('')}</ul>`;
      oversEl.appendChild(wrap);
    }
  }
}

/* Rules */
async function loadRules() {
  const data = await jsonFetch('/api/rules');
  state.rules = Array.isArray(data) ? data : [];
  renderRulesList();
}

function renderRulesList() {
  const list = document.getElementById('rulesList');
  if (!list) return;
  list.innerHTML = '';
  (state.rules || []).forEach(r => {
    const cat = state.categories.find(c => c.id === r.categoryId);
    const infoParts = [];
    if (r.keywords && r.keywords.length) infoParts.push(`Keywords: ${r.keywords.join(', ')}`);
    if (r.amountMin !== undefined || r.amountMax !== undefined) {
      const min = r.amountMin !== undefined ? r.amountMin : '';
      const max = r.amountMax !== undefined ? r.amountMax : '';
      infoParts.push(`Amount: [${min} .. ${max}]`);
    }
    if (r.accounts && r.accounts.length) infoParts.push(`Accounts: ${r.accounts.join(', ')}`);
    if (r.regex) infoParts.push(`Regex: /${r.regex}/${r.regexFlags || ''}`);
    infoParts.push(`Category: ${cat ? cat.name : r.categoryId}`);
    infoParts.push(`Priority: ${r.priority || 0}`);
    const row = document.createElement('div');
    row.className = 'py-2';
    row.innerHTML = `
      <div class="flex items-center justify-between">
        <div>
          <div class="font-medium text-slate-800">${r.name}</div>
          <div class="text-xs text-slate-500">${infoParts.join(' • ')}</div>
        </div>
        <div class="flex gap-2">
          <button class="px-2 py-1 border rounded text-xs rule-edit">Edit</button>
          <button class="px-2 py-1 border rounded text-xs rule-delete">Delete</button>
        </div>
      </div>
      <div class="mt-2 hidden rule-edit-form">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
          <input type="text" class="border rounded px-2 py-1 text-sm rule-name" value="${r.name}">
          <input type="text" class="border rounded px-2 py-1 text-sm rule-kws" value="${(r.keywords || []).join(', ')}">
          <select class="border rounded px-2 py-1 text-sm rule-cat">${state.categories.map(c => `<option value="${c.id}" ${c.id===r.categoryId?'selected':''}>${c.name}</option>`).join('')}</select>
          <input type="number" step="1" class="border rounded px-2 py-1 text-sm rule-pri" value="${r.priority || 0}" placeholder="Priority">
          <input type="number" step="0.01" class="border rounded px-2 py-1 text-sm rule-min" value="${r.amountMin !== undefined ? r.amountMin : ''}" placeholder="Amount min">
          <input type="number" step="0.01" class="border rounded px-2 py-1 text-sm rule-max" value="${r.amountMax !== undefined ? r.amountMax : ''}" placeholder="Amount max">
          <input type="text" class="border rounded px-2 py-1 text-sm rule-accs" value="${(r.accounts || []).join(', ')}" placeholder="Accounts (comma sep)">
          <div class="grid grid-cols-2 gap-2">
            <input type="text" class="border rounded px-2 py-1 text-sm rule-rex" value="${r.regex || ''}" placeholder="Regex">
            <input type="text" class="border rounded px-2 py-1 text-sm rule-rflg" value="${r.regexFlags || ''}" placeholder="Flags">
          </div>
        </div>
        <div class="mt-2 flex gap-2">
          <button class="px-2 py-1 bg-brand-600 text-white rounded text-xs rule-save">Save</button>
          <button class="px-2 py-1 border rounded text-xs rule-cancel">Cancel</button>
        </div>
      </div>
    `;
    const btnEdit = row.querySelector('.rule-edit');
    const btnDelete = row.querySelector('.rule-delete');
    const form = row.querySelector('.rule-edit-form');
    const btnSave = row.querySelector('.rule-save');
    const btnCancel = row.querySelector('.rule-cancel');
    const nameInput = row.querySelector('.rule-name');
    const kwInput = row.querySelector('.rule-kws');
    const catSel = row.querySelector('.rule-cat');
    const priInput = row.querySelector('.rule-pri');
    const minInput = row.querySelector('.rule-min');
    const maxInput = row.querySelector('.rule-max');
    const accsInput = row.querySelector('.rule-accs');
    const rexInput = row.querySelector('.rule-rex');
    const rflgInput = row.querySelector('.rule-rflg');

    btnEdit.addEventListener('click', () => form.classList.remove('hidden'));
    btnCancel.addEventListener('click', () => form.classList.add('hidden'));
    btnSave.addEventListener('click', async () => {
      const payload = {
        name: nameInput.value.trim(),
        keywords: kwInput.value,
        categoryId: catSel.value,
        priority: Number(priInput.value || 0),
        amountMin: minInput.value !== '' ? Number(minInput.value) : undefined,
        amountMax: maxInput.value !== '' ? Number(maxInput.value) : undefined,
        accounts: accsInput.value,
        regex: rexInput.value || undefined,
        regexFlags: rflgInput.value || undefined
      };
      const res = await jsonFetch(`/api/rules/${encodeURIComponent(r.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      if (res && !res.error) {
        await loadRules();
      } else {
        alert(res.error || 'Failed to update rule');
      }
    });
    btnDelete.addEventListener('click', async () => {
      if (!confirm(`Delete rule "${r.name}"?`)) return;
      const res = await jsonFetch(`/api/rules/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
      if (res && !res.error) {
        await loadRules();
      } else {
        alert(res.error || 'Failed to delete rule');
      }
    });

    list.appendChild(row);
  });
}

document.getElementById('addRuleForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.priority = Number(body.priority || 0);
  const accSel = document.getElementById('ruleAccounts');
  if (accSel) {
    const selected = Array.from(accSel.options).filter(o => o.selected).map(o => o.value);
    if (selected.length) body.accounts = selected;
  }
  const res = await jsonFetch('/api/rules', { method: 'POST', body: JSON.stringify(body) });
  if (res && !res.error) {
    e.target.reset();
    await loadRules();
  } else {
    alert(res.error || 'Failed to add rule');
  }
});

// Regex tester
function updateRegexTest() {
  const pat = document.getElementById('ruleRegex')?.value || '';
  const flags = document.getElementById('ruleRegexFlags')?.value || '';
  const text = document.getElementById('regexTestText')?.value || '';
  const out = document.getElementById('regexTestResult');
  if (!out) return;
  if (!pat) {
    out.textContent = '';
    out.className = 'text-xs';
    return;
  }
  try {
    const re = new RegExp(pat, flags);
    const ok = re.test(text);
    out.textContent = ok ? 'Match' : 'No match';
    out.className = `text-xs ${ok ? 'text-green-600' : 'text-red-600'}`;
  } catch (err) {
    out.textContent = `Invalid regex: ${err.message}`;
    out.className = 'text-xs text-red-600';
  }
}
['ruleRegex', 'ruleRegexFlags', 'regexTestText'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', updateRegexTest);
});

/* Import CSV/OFX/QIF */
function fillMappingOptions(headers = []) {
  const ids = ['mapDate','mapAccount','mapType','mapAmount','mapCategory','mapNote','mapDescription'];
  ids.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value=""></option>';
    headers.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      sel.appendChild(opt);
    });
  });
  const trySet = (id, names) => {
    const sel = document.getElementById(id);
    if (!sel) return;
    for (const n of names) {
      const opt = Array.from(sel.options).find(o => o.value.toLowerCase() === n.toLowerCase());
      if (opt) { sel.value = opt.value; break; }
    }
  };
  trySet('mapDate', ['date','Date','DTPOSTED','D']);
  trySet('mapAmount', ['amount','Amount','TRNAMT','T']);
  trySet('mapType', ['type','Type','TRNTYPE']);
  trySet('mapAccount', ['account','Account']);
  trySet('mapCategory', ['category','Category','L']);
  trySet('mapNote', ['note','Note','MEMO','M']);
  trySet('mapDescription', ['description','Description','NAME','P']);
}

function parseOFX(text) {
  const recs = [];
  const getTag = (src, tag) => {
    const m = src.match(new RegExp(`<${tag}>([^<\\n\\r]+)`, 'i'));
    return m ? m[1].trim() : '';
  };
  const stmts = text.match(/<STMTRS>[\s\S]*?<\/STMTRS>/gi);
  if (stmts && stmts.length) {
    for (const s of stmts) {
      const acctId = getTag(s, 'ACCTID') || '';
      const bankId = getTag(s, 'BANKID') || '';
      const account = `OFX ${acctId || bankId || 'Account'}`;
      const trs = s.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
      for (const b of trs) {
        const dt = getTag(b, 'DTPOSTED');
        const amt = getTag(b, 'TRNAMT');
        const name = getTag(b, 'NAME');
        const memo = getTag(b, 'MEMO');
        const type = getTag(b, 'TRNTYPE');
        let date = dt && /^\d{8,14}$/.test(dt) ? `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}` : '';
        recs.push({
          date,
          amount: amt,
          type,
          description: name || memo || '',
          note: memo || '',
          account,
          ofxAcctId: acctId || bankId || ''
        });
      }
    }
  } else {
    const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
    for (const b of blocks) {
      const dt = getTag(b, 'DTPOSTED');
      const amt = getTag(b, 'TRNAMT');
      const name = getTag(b, 'NAME');
      const memo = getTag(b, 'MEMO');
      const type = getTag(b, 'TRNTYPE');
      let date = dt && /^\d{8,14}$/.test(dt) ? `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}` : '';
      recs.push({
        date,
        amount: amt,
        type,
        description: name || memo || '',
        note: memo || '',
        account: 'OFX',
        ofxAcctId: ''
      });
    }
  }
  return recs;
}

function parseQIF(text) {
  const recs = [];
  const lines = text.split(/\r?\n/);
  let cur = {};
  for (const line of lines) {
    if (line === '^') {
      if (cur.D || cur.date) {
        let d = cur.D || cur.date;
        if (d && /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(d)) {
          const parts = d.split(/[\/']/);
          const mm = parts[0].padStart(2,'0');
          const dd = parts[1].padStart(2,'0');
          let yy = parts[2];
          if (yy.length === 2) yy = `20${yy}`;
          d = `${yy}-${mm}-${dd}`;
        }
        recs.push({
          date: d || '',
          amount: cur.T || cur.amount || '',
          type: cur.type || '',
          description: cur.P || cur.NAME || '',
          note: cur.M || '',
          category: cur.L || '',
          account: 'QIF'
        });
      }
      cur = {};
      continue;
    }
    if (!line) continue;
    const ch = line[0];
    const val = line.slice(1);
    cur[ch] = val;
  }
  return recs;
}

async function renderOfxMapUI(detectedIds = []) {
  const cont = document.getElementById('ofxMapContainer');
  if (!cont) return;
  const data = await jsonFetch('/api/settings/ofx-map');
  const map = data?.map || {};
  const accounts = data?.accounts || [];
  const accOpts = accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  cont.innerHTML = '';
  detectedIds.forEach(id => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2';
    row.innerHTML = `
      <div class="text-sm w-40">${id}</div>
      <select data-ofx="${id}" class="border rounded px-2 py-1 text-sm">
        <option value="">-- Select account --</option>
        ${accOpts}
      </select>
    `;
    const sel = row.querySelector('select');
    sel.value = map[id] || '';
    cont.appendChild(row);
  });
}

document.getElementById('saveOfxMapBtn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const cont = document.getElementById('ofxMapContainer');
  if (!cont) return;
  const sels = Array.from(cont.querySelectorAll('select[data-ofx]'));
  const map = {};
  sels.forEach(s => {
    if (s.value) map[s.getAttribute('data-ofx')] = s.value;
  });
  const res = await jsonFetch('/api/settings/ofx-map', { method: 'POST', body: JSON.stringify({ map }) });
  if (res && !res.error) {
    alert('OFX mapping saved');
  } else {
    alert(res.error || 'Failed to save mapping');
  }
});

document.getElementById('csvFile')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'csv') {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        state.csvRecords = res.data || [];
        state.csvHeaders = res.meta?.fields || Object.keys(state.csvRecords[0] || {});
        fillMappingOptions(state.csvHeaders);
        document.getElementById('csvPreview').textContent = JSON.stringify(state.csvRecords.slice(0, 10), null, 2);
      }
    });
  } else {
    const text = await file.text();
    let recs = [];
    if (ext === 'ofx') recs = parseOFX(text);
    else if (ext === 'qif') recs = parseQIF(text);
    else {
      alert('Unsupported file type. Use CSV, OFX, or QIF.');
      return;
    }
    state.csvRecords = recs;
    state.csvHeaders = Object.keys(recs[0] || {});
    fillMappingOptions(state.csvHeaders);
    document.getElementById('csvPreview').textContent = JSON.stringify(state.csvRecords.slice(0, 10), null, 2);
    if (ext === 'ofx') {
      const ids = Array.from(new Set((recs.map(r => r.ofxAcctId).filter(Boolean))));
      await renderOfxMapUI(ids);
    }
  }
});

document.getElementById('csvPreviewBtn')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('csvPreview').textContent = JSON.stringify(state.csvRecords.slice(0, 10), null, 2);
});

document.getElementById('csvImportBtn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!state.csvRecords.length) {
    alert('No records to import');
    return;
  }
  const mapping = {
    date: document.getElementById('mapDate')?.value || '',
    account: document.getElementById('mapAccount')?.value || '',
    type: document.getElementById('mapType')?.value || '',
    amount: document.getElementById('mapAmount')?.value || '',
    category: document.getElementById('mapCategory')?.value || '',
    note: document.getElementById('mapNote')?.value || '',
    description: document.getElementById('mapDescription')?.value || ''
  };
  const autoCategorize = !!document.getElementById('csvAutoCategorize')?.checked;
  const res = await jsonFetch('/api/import/transactions', {
    method: 'POST',
    body: JSON.stringify({ records: state.csvRecords, mapping, autoCategorize })
  });
  if (res && !res.error) {
    alert(`Imported ${res.imported} transactions`);
    state.csvRecords = [];
    state.csvHeaders = [];
    document.getElementById('csvFile').value = '';
    document.getElementById('csvPreview').textContent = '';
    loadTransactions();
    refreshSummary();
    loadBudgetReport();
  } else {
    alert(res.error || 'Import failed');
  }
});

/* Export & Preview */
function buildTxQuery(limit = 1000) {
  const params = new URLSearchParams();
  const acc = document.getElementById('expAccount')?.value || '';
  const month = document.getElementById('expMonth')?.value || '';
  const cat = document.getElementById('expCategory')?.value || '';
  const start = document.getElementById('expStartMonth')?.value || '';
  const end = document.getElementById('expEndMonth')?.value || '';
  const startDate = document.getElementById('expStartDate')?.value || '';
  const endDate = document.getElementById('expEndDate')?.value || '';
  const txType = document.getElementById('expType')?.value || '';
  const minAmt = document.getElementById('expMinAmount')?.value || '';
  const maxAmt = document.getElementById('expMaxAmount')?.value || '';
  if (acc) params.set('accountId', acc);
  if (cat) params.set('category', cat);
  if (txType) params.set('type', txType);
  if (month) params.set('month', month);
  if (!month && (start || end)) {
    if (start) params.set('startMonth', start);
    if (end) params.set('endMonth', end);
  }
  if (startDate) params.set('startDate', startDate);
  if (endDate) params.set('endDate', endDate);
  if (minAmt !== '') params.set('minAmount', minAmt);
  if (maxAmt !== '') params.set('maxAmount', maxAmt);
  params.set('limit', String(limit));
  return params.toString();
}

document.getElementById('expPreviewBtn')?.addEventListener('click', async (e) => {
  e.preventDefault();
  const qs = buildTxQuery(2000);
  const rows = await jsonFetch(`/api/wallet/transactions?${qs}`);
  const accounts = await jsonFetch('/api/wallet/accounts');
  const accMap = Object.fromEntries((accounts || []).map(a => [a.id, a.name]));
  const table = document.getElementById('expPreviewTable');
  if (!table) return;
  table.innerHTML = '';
  const head = document.createElement('thead');
  head.innerHTML = `<tr class="text-left text-slate-500">
    <th class="py-2">Date</th><th>Account</th><th>Type</th><th>Category</th><th class="text-right">Amount</th><th>Note</th>
  </tr>`;
  table.appendChild(head);
  const body = document.createElement('tbody');
  (rows || []).forEach(t => {
    const tr = document.createElement('tr');
    tr.className = 'border-t';
    tr.innerHTML = `<td class="py-1">${t.date}</td>
      <td>${accMap[t.accountId] || t.accountId}</td>
      <td>${t.type}</td>
      <td>${t.category || ''}</td>
      <td class="text-right">${Number(t.amount).toFixed(2)}</td>
      <td>${t.note || ''}</td>`;
    body.appendChild(tr);
  });
  table.appendChild(body);
});

document.getElementById('expCsvBtn')?.addEventListener('click', () => {
  const qs = buildTxQuery();
  window.open(`/api/export/transactions.csv?${qs}`, '_blank');
});
document.getElementById('expQifBtn')?.addEventListener('click', () => {
  const qs = buildTxQuery();
  window.open(`/api/export/transactions.qif?${qs}`, '_blank');
});
document.getElementById('expOfxBtn')?.addEventListener('click', () => {
  const qs = buildTxQuery();
  window.open(`/api/export/transactions.ofx?${qs}`, '_blank');
});
document.getElementById('expZipBtn')?.addEventListener('click', () => {
  const params = new URLSearchParams(buildTxQuery());
  const fmt = document.getElementById('expFormat')?.value || 'csv';
  const mode = document.getElementById('expMode')?.value || 'month';
  params.set('format', fmt);
  params.set('mode', mode);
  window.open(`/api/export/bulk.zip?${params.toString()}`, '_blank');
});

/* TradingView */
function loadTradingView(sym) {
  const containerId = 'tv_container';
  const el = document.getElementById(containerId);
  if (!el || typeof TradingView === 'undefined') return;
  el.innerHTML = '';
  new TradingView.widget({
    autosize: true,
    symbol: sym || 'NASDAQ:AAPL',
    interval: '60',
    timezone: 'Etc/UTC',
    theme: 'light',
    style: '1',
    locale: 'en',
    toolbar_bg: '#f1f3f6',
    enable_publishing: false,
    hide_top_toolbar: false,
    hide_legend: false,
    container_id: containerId
  });
}
document.getElementById('tvLoad')?.addEventListener('click', () => {
  const symbol = document.getElementById('tvSymbol').value || 'NASDAQ:AAPL';
  loadTradingView(symbol);
});

/* Sentiment */
document.getElementById('runSent')?.addEventListener('click', async () => {
  const provider = document.getElementById('sentProvider').value;
  const text = document.getElementById('sentText').value;
  const symbol = document.getElementById('sentSymbol').value;
  const from = document.getElementById('sentFrom').value;
  const type = document.getElementById('sentType').value;
  const body = { provider, text, symbol, from, type };
  const res = await jsonFetch('/api/sentiment/analyze', { method: 'POST', body: JSON.stringify(body) });
  const out = document.getElementById('sentOut');
  if (out) out.textContent = JSON.stringify(res, null, 2);
});

/* Calendar */
document.getElementById('loadCal')?.addEventListener('click', async () => {
  const country = document.getElementById('calCountry').value;
  const start = document.getElementById('calStart').value;
  const end = document.getElementById('calEnd').value;
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const res = await jsonFetch('/api/calendar/tradingeconomics' + (params.toString() ? `?${params.toString()}` : ''));
  const list = document.getElementById('calList');
  if (!list) return;
  list.innerHTML = '';
  (res || []).slice(0, 200).forEach(ev => {
    const row = document.createElement('div');
    row.className = 'py-3 grid grid-cols-12 gap-3 text-sm';
    row.innerHTML = `
      <div class="col-span-2 text-slate-500">${(ev.Date || ev.DateUTC || '').toString().replace('T', ' ').slice(0, 16)}</div>
      <div class="col-span-3 font-medium">${ev.Event || ev.EventName || ev.Category || ''}</div>
      <div class="col-span-2">${ev.Country || ev.CountryCode || ''}</div>
      <div class="col-span-3">${ev.Actual || ''} <span class="text-slate-400">prev ${ev.Previous || ''}</span></div>
      <div class="col-span-2 text-right">${ev.Importance || ev.Last || ''}</div>
    `;
    list.appendChild(row);
  });
});

/* AI Chat */
function appendChat(role, content) {
  const box = document.getElementById('chatBox');
  if (!box) return;
  const wrap = document.createElement('div');
  wrap.className = `max-w-[80%] ${role === 'user' ? 'ml-auto' : ''}`;
  wrap.innerHTML = `
    <div class="${role === 'user' ? 'bg-brand-600 text-white' : 'bg-white border'} px-3 py-2 rounded-lg shadow-sm whitespace-pre-wrap">${content}</div>
  `;
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}
document.getElementById('chatSend')?.addEventListener('click', async () => {
  const input = document.getElementById('chatInput');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  state.messages.push({ role: 'user', content });
  appendChat('user', content);

  const provider = document.getElementById('aiProvider').value;
  const model = document.getElementById('aiModel').value || undefined;

  const res = await jsonFetch('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ provider, model, messages: state.messages })
  });
  const text = res?.content || res?.error || '(no response)';
  state.messages.push({ role: 'assistant', content: text });
  appendChat('assistant', text);
});

/* Initialize */
(function init() {
  try {
    const u = JSON.parse(localStorage.getItem('finUndo') || '[]');
    const r = JSON.parse(localStorage.getItem('finRedo') || '[]');
    if (Array.isArray(u)) state.undoStack = u;
    if (Array.isArray(r)) state.redoStack = r;
    updateUndoBar();
  } catch {}
  show('wallet');
  refreshSummary();
  loadAccounts();
  loadTransactions();
  loadCategories();
  initBudgetMonth();
  loadBudgetReport();
  loadTradingView(document.getElementById('tvSymbol')?.value);
})();