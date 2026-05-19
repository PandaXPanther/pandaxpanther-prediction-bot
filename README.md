# 🐼 PandaXPanther Prediction Bot

Fully autonomous prediction market trading bot for **Polymarket** + **Kalshi**.

Four independent strategies running concurrently, all in **paper mode by default** until you (a) have real accounts, (b) have validated profitability for at least 2 weeks of paper trading.

---

## Strategies

| Strategy | Platforms | Edge Source | Capital | Build Status |
|---|---|---|---|---|
| **sum_to_one** | Polymarket | Best-ask(YES) + best-ask(NO) < $1.00 = arb | $1,000 (25%) | ✅ |
| **cross_platform** | Kalshi ↔ Polymarket | Same event, different price discovery | $1,500 (30%) | ✅ (needs pair registry) |
| **crypto_latency** | Polymarket | Polymarket lags Binance/Coinbase by 2-5s | $1,500 (30%) | ✅ |
| **weather** | Kalshi | NOAA NBM ensemble vs retail-traded contracts | $750 (15%) | ✅ |

Allocations are configurable via `.env`.

---

## Architecture

```
                    ┌──────────────────────────────────────┐
                    │   Main Bot (Node.js / TypeScript)    │
                    │   Fly.io · Denver region             │
                    │                                       │
  ┌────────────┐    │   ┌─────────────────────────────┐    │    ┌────────────┐
  │ Binance WS │───→│   │   Price Feed Aggregator     │    │    │ Polymarket │
  │ Coinbase WS│───→│   │   (BTC / ETH / SOL ticks)   │    │    │ CLOB +     │
  └────────────┘    │   └──────────────┬──────────────┘    │←───│ WebSocket  │
                    │                  ↓                    │    └────────────┘
                    │   ┌─────────────────────────────┐    │    ┌────────────┐
                    │   │  Strategy Engines           │    │←───│ Kalshi REST│
                    │   │  ├ sum_to_one               │    │    │ + WS       │
                    │   │  ├ cross_platform           │    │    └────────────┘
                    │   │  ├ crypto_latency           │    │
                    │   │  └ weather                  │    │
                    │   └──────────────┬──────────────┘    │
                    │                  ↓                    │
                    │   ┌─────────────────────────────┐    │    ┌────────────┐
                    │   │  Risk Engine                │────┼───→│ Discord    │
                    │   │  (Kelly · loss caps · kill) │    │    │ alerts     │
                    │   └──────────────┬──────────────┘    │    └────────────┘
                    │                  ↓                    │
                    └─────────────┬────────────────────────┘
                                  ↓
                          ┌───────────────┐         ┌──────────────────────┐
                          │  Supabase     │←───────→│ Python Quant Service │
                          │  (Postgres)   │  HTTP   │ Fly.io · NOAA models │
                          │  positions    │         │ (FastAPI · scipy)    │
                          │  fills · PnL  │         └──────────────────────┘
                          └───────────────┘
```

---

## Quick Start (Paper Mode)

You can run paper trading WITHOUT any accounts. Set up Supabase + Discord first (both free).

### 1. Clone & install

```bash
git clone git@github.com:PandaXPanther/pandaxpanther-prediction-bot.git
cd pandaxpanther-prediction-bot
npm install
```

### 2. Set up Supabase

1. Create a new project at [supabase.com](https://supabase.com) (free tier)
2. Go to SQL Editor → paste contents of `supabase/migrations/0001_initial_schema.sql` → run
3. Copy the project URL and the **service_role** key
4. `cp .env.example .env` and fill in `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`

### 3. Set up Discord webhook (optional but recommended)

In any Discord server: Server Settings → Integrations → Webhooks → New Webhook. Copy URL into `DISCORD_WEBHOOK_URL`.

### 4. Run

```bash
# Just one strategy at a time
npm run strategy:sum-to-one

# Or all four
npm run dev
```

Bot will connect to Polymarket + Kalshi via WebSocket, stream order books, and log paper "fills" to console + Supabase. Real money is NEVER at risk in paper mode.

### 5. Start the Python quant service (required for weather strategy)

```bash
cd services/quant
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Test it:

```bash
curl 'http://localhost:8000/weather/prob?station=KDEN&metric=high_temp_f&threshold=85&direction=above'
```

---

## Going Live (When Ready)

### Polymarket account setup

1. **Parent creates account** at [polymarket.com](https://polymarket.com) - requires KYC, 18+
2. Deposit USDC (USDC.e on Polygon) - bridge from Coinbase via Polymarket's onramp
3. In the Polymarket UI: Profile → API Keys → Create (sign with wallet)
4. You'll receive:
   - `api_key`, `secret`, `passphrase` → store in `.env`
   - The funder address (your proxy wallet) → store in `.env`
   - Export the wallet private key (Settings → Export) → store in `.env`
5. **Approve the CTF Exchange contract** to spend USDC (one-time, done via the UI)

### Kalshi account setup

1. **Parent creates account** at [kalshi.com](https://kalshi.com) - requires KYC, 18+
2. ACH-fund the account (instant for verified bank accounts)
3. In Profile → API: generate an API key. You get:
   - `api_key_id` (string) → store as `KALSHI_API_KEY_ID`
   - Private key download (PEM file) → save to `secrets/kalshi_private_key.pem`
4. Make sure `secrets/` is in `.gitignore` (it is by default)

### Flip the switch

```bash
# Locally
sed -i 's/TRADING_MODE=paper/TRADING_MODE=live/' .env

# Or on Fly.io
fly secrets set TRADING_MODE=live
```

**Do NOT do this until you've watched paper trading for at least 2 weeks and confirmed:**
- Sum-to-one signals are firing and theoretically profitable
- Crypto latency signals are firing and not getting eaten by fees
- Weather signals match real outcomes within calibration band
- The risk engine kill switch works (intentionally inject a loss and verify it kicks in)

---

## Deploy to Fly.io

```bash
# Install flyctl, sign in
brew install flyctl
fly auth login

# Deploy main bot
fly launch  # creates pandaxpanther-prediction-bot app
fly secrets set $(cat .env | xargs)  # bulk push env vars
fly deploy

# Deploy quant service
cd services/quant
fly launch  # creates pandaxpanther-quant app
fly deploy

# Then back in root .env / fly secrets: set QUANT_SERVICE_URL=https://pandaxpanther-quant.fly.dev
fly secrets set QUANT_SERVICE_URL=https://pandaxpanther-quant.fly.dev -a pandaxpanther-prediction-bot
```

Cost: ~$5–8/month for both machines on Fly's shared-cpu tier.

---

## Project Structure

```
src/
  connectors/
    types.ts             # shared MarketConnector interface
    polymarket.ts        # Polymarket CLOB WS + REST
    kalshi.ts            # Kalshi WS + REST + RSA signing
    priceFeeds.ts        # Binance/Coinbase ticker aggregator
  strategies/
    sumToOne.ts          # Polymarket YES+NO < $1 arb
    crossPlatform.ts     # Kalshi ↔ Polymarket arb
    cryptoLatency.ts     # BTC/ETH lag arbitrage on PM
    weatherSignal.ts     # Kalshi weather quant model
  risk/
    riskEngine.ts        # Kelly sizing + caps + kill switch
  db/
    supabase.ts          # DB client + repo functions
  utils/
    config.ts            # Zod-validated env config
    logger.ts            # Pino structured logging
    discord.ts           # Discord webhook alerts
  index.ts               # main orchestrator

services/
  quant/                 # Python FastAPI sidecar for weather modeling
    main.py
    requirements.txt
    Dockerfile
    fly.toml

supabase/
  migrations/
    0001_initial_schema.sql  # markets, orders, positions, pnl_daily, etc.

scripts/
  seed-paper.ts          # connectivity smoke test
```

---

## Risk Controls (Read This)

The risk engine enforces hard limits BEFORE any order is sent:

| Control | Default | Where to change |
|---|---|---|
| Daily loss cap (USD) | $200 | `DAILY_LOSS_CAP_USD` |
| Max position per market | $250 | `MAX_POSITION_PER_MARKET_USD` |
| Per-strategy allocation | 25/30/30/15% | `ALLOC_*` env vars |
| Kelly fraction | 25% of full Kelly | hardcoded in `riskEngine.ts` |
| Hard position cap | 5% of bankroll | hardcoded ceiling on Kelly |

**If daily PnL hits -$200, the kill switch fires and ALL trading stops until midnight UTC.** Discord alert sent immediately.

---

## What to Watch in Paper Mode

After 1 week of paper trading, query Supabase to evaluate each strategy:

```sql
-- Per-strategy paper PnL
SELECT strategy, sum(realized_pnl) as pnl, sum(num_trades) as trades
FROM pnl_daily WHERE mode = 'paper' GROUP BY strategy;

-- Which markets are firing the most signals?
SELECT m.question, count(*) FROM signals s
JOIN markets m ON m.id = s.market_id
WHERE s.ts > now() - interval '7 days'
GROUP BY m.question ORDER BY count(*) DESC LIMIT 20;

-- Slippage analysis (paper fills vs theoretical)
SELECT strategy, avg(filled_size / size) as fill_rate, avg(avg_fill_price - price) as slippage
FROM orders WHERE mode = 'paper' AND status IN ('filled', 'partial')
GROUP BY strategy;
```

If a strategy is losing money in paper, **figure out why before going live**. Common causes:
- Threshold too loose (firing on noise)
- Fees not properly modeled
- Stale book data triggering false signals

---

## Roadmap (V2+)

- [ ] LLM-powered market matcher for cross_platform pairs (auto-discover)
- [ ] HGEFS ensemble integration for weather (full distribution, not Gaussian approx)
- [ ] Box office / earnings models in the quant service
- [ ] Maker-mode order book provider on Polymarket (USDC rebates)
- [ ] CEX-perp delta hedging for crypto contracts > 1 day duration
- [ ] Web dashboard (Next.js on Netlify) for live PnL monitoring

---

## License

Private — do not redistribute.

---

Built by Computer for [@PandaXPanther](https://github.com/PandaXPanther). Designed to slot into the same Fly.io + Supabase stack as your CSFloat sniper.
