/**
 * UPGRADE #4: Funding Rate Filter
 *
 * Perpetual funding rates signal directional pressure:
 *   - Positive funding (longs paying shorts) => crowded long => mean-reversion bias DOWN
 *   - Negative funding (shorts paying longs) => crowded short => mean-reversion bias UP
 *
 * We use this as a SECONDARY signal to bias thresholds:
 *   - When funding is extreme (|funding| > 0.02% per 8h ~= 21.9% annualized), penalize
 *     the side that's already crowded.
 *
 * Source: OKX perp funding rate API (US-accessible, unlike Binance fapi).
 * Polls every 30 minutes. Cached in memory. Failsafe: if API fails, returns 0
 * (neutral bias, no effect on threshold).
 *
 * Public API:
 *   - startFundingRateFilter(): begin 30-min poll loop
 *   - getFundingBias(underlying): returns funding rate (e.g. 0.0001 = +0.01% per 8h)
 *   - getFundingThresholdAdjustment(underlying, side): pp adjustment to apply to threshold
 *     (positive => HARDER to fire on this side, negative => EASIER)
 */

import axios from 'axios';
import { createStrategyLogger } from '../utils/logger.js';

const log = createStrategyLogger('funding_rate');

const OKX_FUNDING_URL = 'https://www.okx.com/api/v5/public/funding-rate';
const POLL_INTERVAL_MS = 30 * 60 * 1000;  // 30 min

// OKX perp symbols
const SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTC-USDT-SWAP',
  ETH: 'ETH-USDT-SWAP',
  SOL: 'SOL-USDT-SWAP',
  XRP: 'XRP-USDT-SWAP',
  DOGE: 'DOGE-USDT-SWAP',
};

interface FundingState {
  lastFundingRate: number;  // current funding rate (e.g. 0.0001 = 0.01% per 8h)
  lastUpdate: number;       // ms timestamp
}

const fundingCache = new Map<string, FundingState>();
let started = false;

async function pollOnce(): Promise<void> {
  for (const [underlying, symbol] of Object.entries(SYMBOL_MAP)) {
    try {
      const { data } = await axios.get(OKX_FUNDING_URL, {
        params: { instId: symbol },
        timeout: 5000,
      });
      const entry = data?.data?.[0];
      if (!entry) continue;
      const rate = parseFloat(entry.fundingRate);
      if (isFinite(rate)) {
        fundingCache.set(underlying, { lastFundingRate: rate, lastUpdate: Date.now() });
      }
    } catch (e: any) {
      // Failsafe: don't break the bot if OKX is unreachable
      log.debug({ underlying, err: e.message }, 'funding rate fetch failed');
    }
    // Small delay between symbols to be polite
    await new Promise(r => setTimeout(r, 200));
  }
  const snapshot = Array.from(fundingCache.entries()).map(([u, s]) =>
    `${u}=${(s.lastFundingRate * 100).toFixed(4)}%`).join(' ');
  log.info({ snapshot, source: 'okx' }, 'funding rates refreshed');
}

export function startFundingRateFilter(): void {
  if (started) return;
  started = true;
  // Fire immediately (non-blocking), then every 30 min
  void pollOnce();
  setInterval(() => { void pollOnce(); }, POLL_INTERVAL_MS);
  log.info('funding rate filter started');
}

export function getFundingBias(underlying: string): number {
  const state = fundingCache.get(underlying);
  if (!state) return 0;
  // Stale gate: if older than 2 hours, return 0 (failsafe)
  if (Date.now() - state.lastUpdate > 2 * 60 * 60 * 1000) return 0;
  return state.lastFundingRate;
}

/**
 * Returns probability-point (pp) adjustment to ADD to the threshold for a given side.
 * Positive => harder to fire (we want MORE edge before betting against the funding bias).
 * Negative => easier (the funding tailwind helps us, but we still want some edge).
 *
 * Magnitude scales with funding extremity. Capped at ±1.5pp.
 */
export function getFundingThresholdAdjustment(underlying: string, side: 'yes' | 'no'): number {
  const funding = getFundingBias(underlying);
  if (funding === 0) return 0;

  // Funding rate is per 8h. Annualize: ~3 funding payments per day.
  // 0.01% per 8h = 0.03% per day = ~10.95% annualized.
  // We care about extreme funding: |funding| > 0.02% per 8h (~21.9% annualized) is meaningful.
  const FUNDING_THRESHOLD = 0.0002;  // 0.02% per 8h
  const absFunding = Math.abs(funding);
  if (absFunding < FUNDING_THRESHOLD) return 0;

  // Scaled penalty: at threshold = 0.5pp, at 5x threshold = 1.5pp (cap)
  const intensity = Math.min(absFunding / FUNDING_THRESHOLD, 5);
  const penalty = 0.005 * intensity;  // 0.5pp..2.5pp
  const cappedPenalty = Math.min(penalty, 0.015);

  // Positive funding => longs crowded => bearish bias for next period
  // YES on "BTC > X" is a long-equivalent bet; NO is short-equivalent.
  // So positive funding makes YES harder (penalty++) and NO easier (penalty--).
  if (funding > 0) {
    return side === 'yes' ? cappedPenalty : -cappedPenalty / 2;
  } else {
    return side === 'no' ? cappedPenalty : -cappedPenalty / 2;
  }
}

/** Snapshot for heartbeat / dashboard */
export function getFundingSnapshot(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [u, s] of fundingCache) {
    if (Date.now() - s.lastUpdate <= 2 * 60 * 60 * 1000) {
      out[u] = s.lastFundingRate;
    }
  }
  return out;
}
