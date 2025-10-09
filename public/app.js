/* Simple SPA controller */
const views = ['wallet', 'trading', 'sentiment', 'calendar', 'ai'];
const state = {
  messages: [{ role: 'system', content: 'You are an AI assistant for finance and trading analysis.' }],
  chart: null
};

function show(view) {
  views.forEach(v => {
    document.getElementById(`view_${v}`).classList.toggle('hidden', v !== view);
  });
  document.getElementById('viewTitle').textContent = ({
    wallet: 'Dompet',
    trading: 'Trading',
    sentiment: 'Sentiment',
    calendar: 'Economic Calendar',
    ai: 'AI Chat'
  })[view];
}

document.getElementById('sidebar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  show(btn.dataset.view);
  if (btn.dataset.view === 'wallet') {
    refreshSummary();
    loadAccounts();
    loadTransactions();
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

/* Summary bar */
async function refreshSummary() {
  const data = await jsonFetch('/api/wallet/summary');
  const el = document.getElementById('summaryBar');
  if (data && data.totals) {
    const c = data.currency || 'USD';
    el.textContent = `Cash: ${data.totals.cash.toFixed(2)} ${c} • Invested: ${data.totals.invested.toFixed(2)} ${c} • Net Worth: ${data.totals.netWorth.toFixed(2)} ${c}`;
  }
}

/* Accounts */
async function loadAccounts() {
  const list = document.getElementById('accountsList');
  const sel = document.getElementById('txAccount');
  const accounts = await jsonFetch('/api/wallet/accounts');
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

  renderOverview(accounts);
}

document.getElementById('addAccountForm').addEventListener('submit', async (e) => {
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

document.getElementById('addTxForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.amount = Number(body.amount || 0);
  const res = await jsonFetch('/api/wallet/transactions', { method: 'POST', body: JSON.stringify(body) });
  if (res && !res.error) {
    e.target.reset();
    loadTransactions();
    refreshSummary();
  } else {
    alert(res.error || 'Failed');
  }
});

/* Overview chart */
function renderOverview(accounts) {
  const ctx = document.getElementById('overviewChart');
  const labels = accounts.map(a => a.name);
  const data = accounts.map(a => a.balance || 0);
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

/* TradingView */
function loadTradingView(sym) {
  const containerId = 'tv_container';
  document.getElementById(containerId).innerHTML = '';
  // TradingView widget requires global constructor
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

document.getElementById('tvLoad').addEventListener('click', () => {
  const symbol = document.getElementById('tvSymbol').value || 'NASDAQ:AAPL';
  loadTradingView(symbol);
});

/* Sentiment */
document.getElementById('runSent').addEventListener('click', async () => {
  const provider = document.getElementById('sentProvider').value;
  const text = document.getElementById('sentText').value;
  const symbol = document.getElementById('sentSymbol').value;
  const from = document.getElementById('sentFrom').value;
  const type = document.getElementById('sentType').value;
  const body = { provider, text, symbol, from, type };
  const res = await jsonFetch('/api/sentiment/analyze', { method: 'POST', body: JSON.stringify(body) });
  document.getElementById('sentOut').textContent = JSON.stringify(res, null, 2);
});

/* Calendar */
document.getElementById('loadCal').addEventListener('click', async () => {
  const country = document.getElementById('calCountry').value;
  const start = document.getElementById('calStart').value;
  const end = document.getElementById('calEnd').value;
  const params = new URLSearchParams();
  if (country) params.set('country', country);
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const res = await jsonFetch('/api/calendar/tradingeconomics' + (params.toString() ? `?${params.toString()}` : ''));
  const list = document.getElementById('calList');
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
  const wrap = document.createElement('div');
  wrap.className = `max-w-[80%] ${role === 'user' ? 'ml-auto' : ''}`;
  wrap.innerHTML = `
    <div class="${role === 'user' ? 'bg-brand-600 text-white' : 'bg-white border'} px-3 py-2 rounded-lg shadow-sm whitespace-pre-wrap">${content}</div>
  `;
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
}

document.getElementById('chatSend').addEventListener('click', async () => {
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
  show('wallet');
  refreshSummary();
  loadAccounts();
  loadTransactions();
  loadTradingView(document.getElementById('tvSymbol').value);
})();