# Strategy Deep Dive

Detailed mechanics, edge sources, and known failure modes for each strategy.

---

## 1. Sum-to-One Arbitrage

**File:** `src/strategies/sumToOne.ts`

### Mechanism

Polymarket binary markets have two complementary tokens: YES and NO. At settlement, exactly one pays $1.00 and the other pays $0. Therefore:

```
fair_price(YES) + fair_price(NO) = 1.00
```

When the best ask on YES + best ask on NO < $1.00, you can buy both and lock in profit.

### Failure modes

| Failure | Mitigation |
|---|---|
| Only one leg fills (one-legged) | Use FOK orders only; tight timeout; immediate alert |
| Spread closes between check and order | Check size = min(yes_depth, no_depth); 2s cooldown |
| Fees eat the edge | `MIN_EDGE_AFTER_FEES = 1.5%` minimum |
| Market is about to resolve | Trade closes 5 minutes before settlement |

### Tuning knobs

- `TRIGGER_SUM` (default 0.97): how low the combined ask must go before we consider firing
- `MIN_EDGE_AFTER_FEES` (default 0.015): net profit floor after Polymarket fees

---

## 2. Cross-Platform Arbitrage (Kalshi ↔ Polymarket)

**File:** `src/strategies/crossPlatform.ts`

### Mechanism

Two paths to profit from the same event listing on both platforms:

**Path A:** Kalshi YES is cheap, Polymarket NO is cheap
- Buy YES on Kalshi at price `kY`
- Buy NO on Polymarket at price `pN`
- If `kY + pN < 0.98`, locked profit = `1.00 - (kY + pN)` minus fees

**Path B:** Kalshi NO is cheap (= YES is expensive), Polymarket YES is cheap
- Buy NO on Kalshi at price `1 - kY_bid`
- Buy YES on Polymarket at price `pY`
- Similar logic

### Critical caveat: pair matching

The two markets must resolve identically. This is non-trivial:
- "Will Fed cut rates in June 2026?" might resolve on different dates
- "Will it rain in NYC on May 20?" — does "in NYC" mean Central Park or LaGuardia?

V1 uses a **manual pair registry** in `PAIRS` constant. You add a pair only after you've manually verified resolution criteria match.

V2 (roadmap): LLM-powered automated pair matching with similarity threshold.

### Failure modes

| Failure | Mitigation |
|---|---|
| Slight difference in resolution criteria | Manual whitelist only |
| One platform settles before the other | Check `closes_at` difference < 24h |
| Currency / asset transfer delay | Keep capital sitting on both platforms |
| One leg rejects | FOK on PM side, IOC on Kalshi side |

---

## 3. Crypto Latency Arbitrage

**File:** `src/strategies/cryptoLatency.ts`

### Mechanism

Polymarket runs "Will BTC close above $X at 4pm ET?" markets (and similar for ETH/SOL). The market price reflects what human traders think. Bitcoin's true price ticks 10x per second on Binance/Coinbase. When BTC spikes 2% and Polymarket hasn't updated, the implied probability is stale.

We compute the true probability using a Black-Scholes-style binary option model:

```
d2 = (ln(S/K) - 0.5*σ²*T) / (σ*√T)
P(S_T > K) = N(d2)
```

Where:
- `S` = current spot from Binance
- `K` = the strike in the contract
- `σ` = realized volatility from the last 5 minutes of ticks
- `T` = time to settlement (in years)

If `|model_prob - market_mid| > 6%`, we fire.

### Failure modes

| Failure | Mitigation |
|---|---|
| GBM model wrong (jumps, news) | Lower divergence threshold; longer cooldowns |
| Vol estimate stale during news | Drop bets when 5-min vol > 2x historical |
| Polymarket price moves between detection and order | IOC orders only |
| Markets near settlement: gamma blowup | Skip if T-t < 30s |

### Tuning knobs

- `MIN_PROB_DIVERGENCE` (default 0.06): how far off the market must be
- `RECENT_VOL_WINDOW_MS` (default 5 minutes): vol estimation lookback

---

## 4. Weather Quant Model

**File:** `src/strategies/weatherSignal.ts` + `services/quant/main.py`

### Mechanism

Kalshi lists daily weather contracts. The Python sidecar pulls NOAA NBM (National Blend of Models) forecasts from `api.weather.gov` — free, no key, well-documented.

For "high temp in NYC > 85°F on May 20":
1. Pull NBM hourly temperatures for KNYC for May 20
2. Daily max = max of hourly values
3. Estimate uncertainty σ from NBM RMSE benchmarks (~3°F for 1-day-ahead high temp)
4. Inflate σ by 25% per day-ahead beyond 1
5. P(temp > 85) = 1 - Φ((85 - point_estimate) / σ)

### Why this works

- NBM is the U.S. government's flagship operational ensemble - very accurate but underused by retail
- Most Kalshi weather traders eyeball the forecast at weather.com and bet 50/50 close to even
- A calibrated probability beats noise

### Failure modes

| Failure | Mitigation |
|---|---|
| Forecast bust (rare extreme weather) | Daily loss cap stops bleeding |
| Wrong station mapping (e.g. NYC=KNYC vs KLGA) | Manual STATION_KEYWORDS table in strategy file |
| σ underestimated → over-confident bets | Conservative fractional Kelly (25%) |
| Forecast updates after our bet | Re-evaluate on POLL_INTERVAL_MS; exit if model flips |

### V2 enhancement: HGEFS ensemble

NBM provides point forecast + RMSE band. HGEFS provides the full 62-member ensemble, which lets you compute the EXACT probability mass above threshold instead of a Gaussian approximation. HGEFS data is on NOAA NOMADS THREDDS — bulkier (GB-per-day) but strictly better signal. Add as `services/quant/fetch_hgefs.py`.

---

## Allocation Logic

The risk engine enforces per-strategy capital caps:

| Strategy | Default | Rationale |
|---|---|---|
| sum_to_one | 25% | Truly risk-free if both legs fill, but opportunities are rare |
| cross_platform | 30% | Highest documented per-trade ROI; needs manual pair curation |
| crypto_latency | 30% | Highest scaling ceiling; most consistent stream of opportunities |
| weather | 15% | Slowest cadence (daily bets), but most reliable model edge |

Adjust via `ALLOC_*` env vars (must sum ≤ 1.0).
