<div align="center">

# Prediction Market Trading Bot

**A bot that trades prediction markets on Polymarket and Kalshi using four different strategies at once. Latency arbitrage, cross-venue pricing, structural edges, and a weather model built off NOAA data.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-6F2DD4?style=for-the-badge)](https://polymarket.com)
[![Kalshi](https://img.shields.io/badge/Kalshi-CFTC-1B998B?style=for-the-badge)](https://kalshi.com)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-Source--Available-red?style=for-the-badge)](#license)

</div>

---

## What it is

This is a bot I built that trades prediction markets on Polymarket and Kalshi. It runs four strategies at the same time: structural arbitrage (when the YES and NO prices on Polymarket add up to less than $1), cross-venue arbitrage (same event priced differently on Kalshi vs Polymarket), crypto latency arbitrage (Polymarket lags Binance and Coinbase by 2 to 5 seconds, so you can front-run the move), and a weather model that prices Kalshi weather contracts against NOAA NBM ensemble data.

It streams live order books from both venues plus Binance and Coinbase, prices opportunities in real time, routes every signal through a risk engine that uses Kelly fraction sizing with hard caps and a daily loss kill switch, and saves positions, fills, and PnL to Postgres.

Everything runs in paper mode by default. You need real KYC'd accounts and a validated paper track record before going live, and even then the switch is just an environment variable. The whole point is that going live doesn't require code changes, just configuration and enough confidence in the paper results.

---

## What I learned building it

- **Strategy design.** Four different edges, each with its own logic. Sum-to-one is a structural arb that fires when best-ask(YES) plus best-ask(NO) is under $1.00. Cross-platform is the same event priced differently across two regulated prediction markets. Crypto latency is Polymarket lagging behind centralized exchanges. Weather is a NOAA NBM ensemble model priced against retail-traded Kalshi contracts.
- **Real-time engineering.** The main bot is Node and TypeScript, multiplexing four WebSocket streams (Binance, Coinbase, Polymarket, Kalshi) through a price feed aggregator into the strategy engines. The weather model runs in a separate Python FastAPI service.
- **Risk management.** Kelly fraction sizing at 25% of full Kelly with a hard 5%-of-bankroll ceiling, per-strategy capital allocation, per-market position caps, and an automatic daily-loss kill switch that halts all trading until midnight UTC.
- **Full stack.** Supabase Postgres schema for markets, orders, positions, and daily PnL. Zod-validated config. Structured logging with Pino. Discord alerts. Dockerized services on Fly.io.
- **Scientific discipline.** Paper first, always. Before any strategy goes live it has to pass a checklist: signals are firing, fees are properly modeled, weather signals match real outcomes within a calibration band, and the kill switch actually works (I verify that one by intentionally injecting a loss and watching it trip).

---

## Strategies

| Strategy | Platforms | Edge source | Capital |
|---|---|---|---|
| **sum_to_one** | Polymarket | best-ask(YES) + best-ask(NO) < $1.00 = structural arb | 25% |
| **cross_platform** | Kalshi and Polymarket | same event, different price discovery | 30% |
| **crypto_latency** | Polymarket | Polymarket lags Binance/Coinbase by 2-5s | 30% |
| **weather** | Kalshi | NOAA NBM ensemble vs. retail-traded contracts | 15% |

Allocations are configurable in `.env`.

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
                    │   │  (Kelly · loss caps · kill)  │    │    │ alerts     │
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

## Project structure

```
src/
  connectors/
    types.ts             # shared MarketConnector interface
    polymarket.ts        # Polymarket CLOB WS + REST
    kalshi.ts            # Kalshi WS + REST + RSA signing
    priceFeeds.ts        # Binance/Coinbase ticker aggregator
  strategies/
    sumToOne.ts          # Polymarket YES+NO < $1 arb
    crossPlatform.ts     # Kalshi and Polymarket arb
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

## Risk controls

The risk engine enforces hard limits before any order gets sent:

| Control | Default | Where to change |
|---|---|---|
| Daily loss cap (USD) | $200 | `DAILY_LOSS_CAP_USD` |
| Max position per market | $250 | `MAX_POSITION_PER_MARKET_USD` |
| Per-strategy allocation | 25/30/30/15% | `ALLOC_*` env vars |
| Kelly fraction | 25% of full Kelly | hardcoded in `riskEngine.ts` |
| Hard position cap | 5% of bankroll | hardcoded ceiling on Kelly |

If daily PnL hits -$200, the kill switch fires and all trading stops until midnight UTC. A Discord alert goes out immediately.

---

## Quick start (paper mode)

Paper trading runs without any exchange accounts. You just need Supabase and Discord, both free.

```bash
git clone https://github.com/PandaXPanther/pandaxpanther-prediction-bot.git
cd pandaxpanther-prediction-bot
npm install

# 1. Create a Supabase project, run supabase/migrations/0001_initial_schema.sql
# 2. cp .env.example .env and fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
# 3. (optional) add a Discord webhook to DISCORD_WEBHOOK_URL

# Run one strategy:
npm run strategy:sum-to-one

# Or all four:
npm run dev
```

Start the Python quant service (needed for the weather strategy):

```bash
cd services/quant
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# Sanity check:
curl 'http://localhost:8000/weather/prob?station=KDEN&metric=high_temp_f&threshold=85&direction=above'
```

---

## Going live

Live mode needs KYC'd Polymarket and Kalshi accounts, funded balances, approved exchange contracts, and a paper track record of at least two weeks confirming: sum-to-one signals are firing and theoretically profitable, crypto-latency signals survive fees, weather signals match real outcomes within a calibration band, and the risk-engine kill switch works (verified by injecting a loss on purpose and watching it trip).

The switch itself is one environment variable, `TRADING_MODE=live`. That's on purpose. The goal is that nothing changes between paper and live except config and how much you trust the results.

---

## Roadmap

- [ ] LLM-powered market matcher for cross-platform pairs (auto-discovery)
- [ ] HGEFS ensemble integration for weather (full distribution, not Gaussian approx)
- [ ] Box office / earnings models in the quant service
- [ ] Maker-mode order book provider on Polymarket (USDC rebates)
- [ ] CEX-perp delta hedging for crypto contracts longer than 1 day
- [ ] Web dashboard (Next.js on Netlify) for live PnL monitoring

---

## Stack

| Layer | Choice |
|-------|--------|
| Bot runtime | Node 20+ / TypeScript 5 |
| Bot hosting | Fly.io (Denver region) |
| Quant service | Python / FastAPI / scipy |
| Database | Supabase Postgres |
| Venues | Polymarket CLOB, Kalshi REST+WS |
| Price feeds | Binance WS, Coinbase WS |
| Weather data | NOAA NBM / api.weather.gov |
| Config validation | Zod |
| Logging | Pino |
| Alerts | Discord webhooks |

---

## Disclaimer

This is research and educational infrastructure. Prediction-market contracts can lose their full value. Nothing here is financial advice. Don't deploy real capital based on paper results alone.

---

## License

This code is **source-available for portfolio and educational review only**, not open source. You can read it to see what I built, but you can't copy, redistribute, deploy, run, or make money off it. The config, tuned strategy parameters, and infrastructure credentials that make it actually run aren't in this repo, so the code as published won't run as-is. See [`LICENSE`](LICENSE) for the full terms.
