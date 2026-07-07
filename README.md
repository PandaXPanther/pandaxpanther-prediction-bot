<div align="center">

# Prediction Market Trading Bot

**An autonomous multi-strategy trading system across Polymarket and Kalshi — latency arbitrage, cross-venue pricing, sum-to-one structural edges, and a NOAA-ensemble weather model.**

[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/Node-20+-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB-6F2DD4?style=for-the-badge)](https://polymarket.com)
[![Kalshi](https://img.shields.io/badge/Kalshi-CFTC-1B998B?style=for-the-badge)](https://kalshi.com)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres-3FCF8E?style=for-the-badge&logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-Source--Available-red?style=for-the-badge)](#license)

</div>

---

## About

This is an autonomous prediction-market trading bot that runs four independent strategies concurrently across Polymarket (CLOB on Polygon) and Kalshi (CFTC-regulated). It streams live order books from both venues plus Binance and Coinbase, prices opportunities in real time, routes every signal through a Kelly-fraction risk engine with hard caps and a daily-loss kill switch, and persists positions, fills, and PnL to Postgres.

Everything runs in **paper mode by default** — real accounts, KYC, and a validated paper-trading track record are prerequisites for live execution. The bot is architected to go live without code changes; the switch is an environment variable gated behind proven paper performance.

---

## What this project demonstrates

For reviewers evaluating quantitative, systems, and product judgment:

- **Strategy design** — four distinct, theoretically-grounded edges: structural arbitrage (YES + NO mispricing below $1.00), cross-venue price discovery between two regulated prediction markets, crypto latency arbitrage (Polymarket lagging centralized exchanges by 2–5s), and a meteorological model (NOAA NBM ensemble vs. retail-traded weather contracts).
- **Real-time engineering** — a Node/TypeScript orchestrator multiplexing four WebSocket streams (Binance, Coinbase, Polymarket, Kalshi) through a price-feed aggregator into concurrent strategy engines, with a Python FastAPI quant sidecar for the weather model.
- **Risk management** — a Kelly-fraction sizing engine (25% of full Kelly, hard 5%-of-bankroll ceiling), per-strategy capital allocation, per-market position caps, and an automatic daily-loss kill switch that halts all trading until midnight UTC.
- **Full-stack ownership** — Supabase Postgres schema for markets, orders, positions, and daily PnL; Zod-validated configuration; structured Pino logging; Discord alerting; Dockerized services deployed on Fly.io.
- **Scientific discipline** — paper-first validation, per-strategy PnL/slippage/calibration queries, and an explicit checklist a strategy must pass (signals firing, fees modeled, calibration within band, kill switch verified) before any live capital is committed.

---

## Strategies

| Strategy | Platforms | Edge source | Capital |
|---|---|---|---|
| **sum_to_one** | Polymarket | best-ask(YES) + best-ask(NO) < $1.00 = structural arb | 25% |
| **cross_platform** | Kalshi ↔ Polymarket | same event, different price discovery | 30% |
| **crypto_latency** | Polymarket | Polymarket lags Binance/Coinbase by 2–5s | 30% |
| **weather** | Kalshi | NOAA NBM ensemble vs. retail-traded contracts | 15% |

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

## Risk controls

The risk engine enforces hard limits **before** any order is sent:

| Control | Default | Where to change |
|---|---|---|
| Daily loss cap (USD) | $200 | `DAILY_LOSS_CAP_USD` |
| Max position per market | $250 | `MAX_POSITION_PER_MARKET_USD` |
| Per-strategy allocation | 25/30/30/15% | `ALLOC_*` env vars |
| Kelly fraction | 25% of full Kelly | hardcoded in `riskEngine.ts` |
| Hard position cap | 5% of bankroll | hardcoded ceiling on Kelly |

If daily PnL hits -$200, the kill switch fires and **all trading stops until midnight UTC**. A Discord alert is sent immediately.

---

## Quick start (paper mode)

Paper trading runs without any exchange accounts — only Supabase and Discord (both free).

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

Start the Python quant service (required for the weather strategy):

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

Live mode requires KYC'd Polymarket and Kalshi accounts, funded balances, approved exchange contracts, and — critically — a paper-trading track record of at least two weeks confirming: sum-to-one signals are firing and theoretically profitable, crypto-latency signals survive fees, weather signals match real outcomes within a calibration band, and the risk-engine kill switch works (verified by intentionally injecting a loss).

The switch itself is a single environment variable (`TRADING_MODE=live`), by design — the goal is that no code changes between paper and live, only configuration and conviction.

---

## Roadmap

- [ ] LLM-powered market matcher for cross-platform pairs (auto-discovery)
- [ ] HGEFS ensemble integration for weather (full distribution, not Gaussian approx)
- [ ] Box-office / earnings models in the quant service
- [ ] Maker-mode order-book provider on Polymarket (USDC rebates)
- [ ] CEX-perp delta hedging for crypto contracts > 1 day duration
- [ ] Web dashboard (Next.js on Netlify) for live PnL monitoring

---

## Stack

| Layer | Choice |
|-------|--------|
| Bot runtime | Node `20+` / TypeScript `5` |
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

This is research / educational infrastructure. Prediction-market contracts can lose their full value. Nothing here is financial advice. Do not deploy real capital based on paper results alone.

---

## License

This project is **source-available for portfolio and educational review only** — it is not open source. No rights are granted to copy, redistribute, deploy, run, or commercially exploit this software. The operational configuration, tuned strategy parameters, and infrastructure credentials that make the system run are intentionally not included in this repository, so the code as published will not run as-is. See [`LICENSE`](LICENSE) for the full terms.
