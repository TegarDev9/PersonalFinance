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

Optional: persistence for serverless (Vercel KV / Upstash)
- KV_REST_API_URL=...
- KV_REST_API_TOKEN=...
- KV_DB_KEY=fin:db             # optional, default fin:db
  (or use UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)

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
  - Rules panel: define custom keyword rules to auto-categorize

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

## REST Endpoints

Wallet
- GET /api/wallet/summary
- GET /api/wallet/accounts
- POST /api/wallet/accounts { name, type, balance }
- PATCH /api/wallet/accounts/:id
- DELETE /api/wallet/accounts/:id
- GET /api/wallet/transactions?accountId=&month=&startMonth=&endMonth=&startDate=&endDate=&category=&type=&minAmount=&maxAmount=&limit=
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
- POST /api/rules { name, keywords: string|array, categoryId, type?, priority?, amountMin?, amountMax?, accounts?: string|array, regex?, regexFlags? }
- PATCH /api/rules/:id
- DELETE /api/rules/:id

Import
- POST /api/import/transactions
  - body: { records: Array<Object>, mapping?: { date, account, accountId?, type, amount, category, note, description }, autoCategorize?: boolean }
  - Supports CSV/OFX/QIF (CSV parsed in browser, OFX/QIF parsed in browser to records, then posted here)

Export
- GET /api/export/transactions.csv (same query filters as /transactions)
- GET /api/export/transactions.qif
- GET /api/export/transactions.ofx
- GET /api/export/bulk.zip?mode=month|day|category|account|account_day&format=csv|qif|ofx&...filters
  - Group by:
    - Month (YYYY-MM)
    - Day (YYYY-MM-DD)
    - Category
    - Account
    - Account + Day (per-account daily files)
  - File names include grouping context, e.g. 2025-01.csv, 2025-01-10.csv, Cash-2025-01-10.csv
  - Additional filters supported: minAmount, maxAmount, startDate/endDate (YYYY-MM-DD), type=income|expense|transfer

Sentiment
- POST /api/sentiment/analyze
  - body: { provider: 'vader'|'google'|'finbert'|'finnhub', text?, symbol?, from?, type? }

Calendar / Macro
- GET /api/calendar/tradingeconomics?country=&start=&end=&importance=
- GET /api/indicators/alphavantage?func=REAL_GDP&interval=annual

AI Chat
- POST /api/ai/chat
  - body: { provider, model?, messages: [{role, content}] }

n8n
- POST /webhooks/n8n (receive) -> persists JSON-line logs:
  - If KV (Vercel/Upstash) configured: RPUSH to KV list key (KV_HOOKS_KEY, default fin:hooks)
  - If Deno KV available: set entries under ['fin','hooks' <ptimestamp_random>]
  - Else: append to local file data/hooks.log
- POST /n8n/forward { url?, data } -> forwards N8N_WEBHOOK_URL (if set)

## Persistence in serverless (Vercel KV / Upstash / Deno KV)

Options:
- Vercel KV: set KV_REST_API_URL and KV_REST_API_TOKEN (and optionally KV_DB_KEY)
- Upstash: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (and optionally KV_DB_KEY)
- Deno KV (Deno Deploy / local Deno): auto-detected at runtime (no env needed). The app will use Deno.openKv() when available.

When a KV provider is active, the app stores the entire db.json content in a single KV key (default fin:db).

## Validation script

Run quick data checks:
- npm run validate

Checks include:
- Duplicate budgets for the same category/month
- Budgets referencing missing categories
- Rules with invalid regex or missing category
- Orphaned accounts in transactions
- Type/sign mismatches (expense with amount > 0, income with amount < 0)
- Warnings for unknown transaction categoryId, non-ISO dates, duplicate account names

It will read KV if configured, otherwise data/db.json.

## Notes

- FinBERT: uses the HuggingFace Inference API for ProsusAI/finbert.
- VADER: NPM vader-sentiment package (free).
- TextBlob: Python-only; integrate via n8n or a small Python sidecar if needed.
- TradingEconomics: if you don’t set keys, defaults to guest:guest (rate-limited).

## Security

- Keep your API keys in environment variables; the UI does not expose them.
- Rate limit or protect /api routes if you plan a public deployment.

## License

ISC
