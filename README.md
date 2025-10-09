# FinDash — Personal Finance, Trading & AI Dashboard (2025)

A modern dashboard with:
- Dompet (Wallet): accounts, transactions, holdings, net worth
- Budgets & Categories: monthly budget per category with progress and overspending alerts
- Keyboard actions: edit/delete budgets via icons or hotkeys (E, Delete)
- Undo/Redo for category/budget deletions (Ctrl+Z / Ctrl+Y)
- Auto-categorization engine with custom rules
- Sentiment: VADER (free), Google Cloud Natural Language, FinBERT (HuggingFace), Finnhub Social/News
- Economic Calendar: TradingEconomics (guest and key support), Alpha Vantage macro indicators
- Trading: Embedded TradingView chart
- AI Chat: OpenAI, Claude Sonnet (Anthropic), Gemini, Deepseek, Qwen
- n8n integration: inbound webhook and forwarder

This is a single Node.js app serving an SPA UI with Tailwind, Chart.js and TradingView.

## What's new in this update

- Rules UI builder:
  - Account selector as a multi-select (choose multiple local accounts to scope a rule)
  - Live regex tester (pattern + flags + test text) to validate your regex instantly
- OFX import account mapping:
  - Map OFX ACCTID to your local accounts, stored in server settings
  - UI lists detected OFX accounts on upload; map once and reuse
- Export enhancements:
  - Preview export: filter and preview transactions in-table before downloading
  - Bulk export as ZIP: group by month or by category and export CSV/QIF/OFX multiple files in one ZIP
- Deployability:
  - Vercel: included /api serverless wrapper and vercel.json rewrite
  - Deno: deno.jsonc task to run with Node-compat locally (note: Deploy’s filesystem is ephemeral)

## Quick start

1) Install dependencies
- npm install

2) Set environment variables (create a .env file in project root)
- PORT=3000
- OPENAI_API_KEY=...
- OPENAI_MODEL=gpt-4o-mini
- ANTHROPIC_API_KEY=...
- ANTHROPIC_MODEL=claude-3-5-sonnet-20240620
- GEMINI_API_KEY=...
- DEEPSEEK_API_KEY=...
- QWEN_API_KEY=...           # or DASHSCOPE_API_KEY
- QWEN_COMPAT_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
- GOOGLE_CLOUD_API_KEY=...   # for Google NLP sentiment
- HUGGINGFACE_API_KEY=...    # for FinBERT (ProsusAI/finbert)
- FINNHUB_API_KEY=...
- TRADINGECONOMICS_CLIENT=yourUser
- TRADINGECONOMICS_SECRET=yourPass
- ALPHA_VANTAGE_API_KEY=...
- N8N_WEBHOOK_URL=https://your-n8n-host/webhook/your-id  # optional (for overspending alerts)

Note: The request for “ChatGPT 5” is implemented via the OpenAI provider. Set OPENAI_MODEL to the latest model you prefer.

3) Run
- npm start
- Open http://localhost:3000

## UI Sections

- Dompet (Wallet)
  - Create accounts and transactions
  - Doughnut chart shows balance distribution
  - Summary bar shows cash, invested, net worth
  - Budget panel:
    - Select month, add/edit/delete budgets
    - Keyboard shortcuts on a budget row: E to edit, Delete to delete
    - Summary totals: total budget, total spent, remaining, % used
    - Overspending list
  - Categories panel: add, inline edit and delete category
  - Rules panel:
    - Add rules with keywords, amount range, accounts (multi-select), regex + flags, priority
    - Live regex test box shows Match/No match

- Trading
  - TradingView chart widget
  - Enter symbols like NASDAQ:AAPL or NYSE:TSLA

- Sentiment
  - Providers:
    - VADER (local, free)
    - Google Cloud Natural Language
    - FinBERT (HuggingFace Inference API: ProsusAI/finbert)
    - Finnhub Social Sentiment (60 calls/min free tier) or News Sentiment
  - For Finnhub, set symbol and choose "social" vs "news"

- Calendar
  - TradingEconomics calendar (supports guest:guest if no key set)
  - Alpha Vantage macro indicator endpoint included for reference

- AI Chat
  - Provider dropdown: OpenAI, Anthropic, Gemini, Deepseek, Qwen
  - Model box optional — leave blank to use defaults

- Import
  - CSV/OFX/QIF import
  - Auto-categorize toggle
  - Column mapping for date, type, amount, etc.
  - OFX account mapping UI (map ACCTID ➜ local account)

- Export
  - Single-file export: CSV/QIF/OFX with filters
  - Preview table with Account/Month/Category filters
  - Bulk ZIP export grouped by Month or by Category (CSV/QIF/OFX)

## REST Endpoints

Wallet
- GET /api/wallet/summary
- GET /api/wallet/accounts
- POST /api/wallet/accounts { name, type, balance }
- PATCH /api/wallet/accounts/:id
- DELETE /api/wallet/accounts/:id
- GET /api/wallet/transactions?accountId=&month=&startMonth=&endMonth=&category=&limit=
- POST /api/wallet/transactions { date, accountId, type, category, amount, note }
- GET /api/wallet/holdings
- POST /api/wallet/holdings { symbol, quantity, avgPrice }

Categories & Budgets
- GET /api/categories
- POST /api/categories { name, type }
- PATCH /api/categories/:id
- DELETE /api/categories/:id
- POST /api/categories/restore { category, budgets? }   # undo restore

- GET /api/budgets?month=YYYY-MM
- POST /api/budgets { categoryId, month: 'YYYY-MM', amount }
- PATCH /api/budgets/:id
- DELETE /api/budgets/:id
- POST /api/budgets/restore { budget }                 # undo restore

- GET /api/reports/budget?month=YYYY-MM  -> { month, items: [{ id, categoryId, categoryName, budget, spent, remaining, percent }] }
- GET /api/budget/overspend?month=YYYY-MM -> overspending items

Rules (auto-categorization)
- GET /api/rules
- POST /api/rules
  - body: {
      name,
      keywords?: string|array,
      categoryId,
      type?: 'expense'|'income'|'transfer',
      priority?: number,
      amountMin?: number,
      amountMax?: number,
      accounts?: string|array,   # account IDs or names (comma separated allowed)
      regex?: string,            # JS regex pattern
      regexFlags?: string        # e.g., 'i'
    }
- PATCH /api/rules/:id   # accepts same fields as POST for updates
- DELETE /api/rules/:id

Import
- POST /api/import/transactions
  - body: { records: Array<Object>, mapping?: { date, account, accountId?, type, amount, category, note, description }, autoCategorize?: boolean }
  - Supports CSV/OFX/QIF (CSV parsed in browser, OFX/QIF parsed in browser to records, then posted here). OFX multi-statement is supported (account detected from each STMTRS).
- Settings (OFX mapping):
  - GET /api/settings/ofx-map -> { map, accounts }
  - POST /api/settings/ofx-map { map: { [ofxAcctId]: accountId } }

Export
- GET /api/export/transactions.csv?month=YYYY-MM&accountId=ACC_ID&category=...
- GET /api/export/transactions.qif?month=YYYY-MM&accountId=ACC_ID&category=...
- GET /api/export/transactions.ofx?month=YYYY-MM&accountId=ACC_ID&category=...
- GET /api/export/bulk.zip?mode=month|category&format=csv|qif|ofx&accountId=&month=&startMonth=&endMonth=&category=

Sentiment
- POST /api/sentiment/analyze
  - body: { provider: 'vader'|'google'|'finbert'|'finnhub', text?, symbol?, from?, type? }

Calendar / Macro
- GET /api/calendar/tradingeconomics?country=&start=&end=&importance=
- GET /api/indicators/alphavantage?func=REAL_GDP&interval=annual

AI Chat
- POST /api/ai/chat
  - body: { provider, model?, messages: [{role, content}] }  // OpenAI-style messages

n8n
- POST /webhooks/n8n (receive)  -> appends JSON lines to data/hooks.log
- POST /n8n/forward { url?, data } -> forwards JSON to an n8n webhook (uses N8N_WEBHOOK_URL if url omitted)
- Automatic overspending alert: when a new expense pushes a category above its monthly budget, the server sends a JSON payload to N8N_WEBHOOK_URL (if set)

## Deploy

- Vercel
  - Files added: api/index.js (serverless handler), vercel.json (rewrite all traffic to /api/index.js)
  - Steps:
    1. vercel login
    2. vercel deploy
  - Note: Vercel filesystem is ephemeral; file-based DB (data/db.json) won't persist across invocations. For persistence, use a managed KV (e.g., Vercel KV/Upstash) and adapt readDB/writeDB accordingly.

- Deno
  - Local run with Node-compat: deno task start
    - deno.jsonc contains: { \"tasks\": { \"start\": \"deno run --compat -A index.js\" } }
  - Deno Deploy has an ephemeral filesystem; to persist data, use Deno KV or another external store and adapt readDB/writeDB.

## Notes

- FinBERT: this uses the HuggingFace Inference API for ProsusAI/finbert to avoid heavy local installs.
- VADER is implemented with the NPM vader-sentiment package (free).
- TextBlob is Python-only; if you need TextBlob specifically, connect it via n8n or a small Python sidecar and call it from a custom node. The VADER and FinBERT providers here cover common sentiment needs without Python.
- TradingEconomics: if you don’t set keys, the server will default to guest:guest which is rate-limited.

## Security

- Keep your API keys in environment variables; the UI does not expose them.
- Rate limit or protect /api routes if you plan a public deployment.

## License

ISC
