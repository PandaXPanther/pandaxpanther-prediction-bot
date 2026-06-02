/**
 * STRATEGY: Kalshi Hourly Crypto Price-Level Arbitrage
 *
 * THESIS:
 *   Kalshi runs hundreds of hourly crypto contracts on BTC, ETH, SOL, XRP, DOGE:
 *     - "BTC ≥ $X at 3pm EDT?"            (strike_type=greater)
 *     - "BTC ≤ $X at 3pm EDT?"            (strike_type=less)
 *     - "BTC in [X, Y] at 3pm EDT?"       (strike_type=between)
 *
 *   The true probability of each outcome is computable from real-time public
 *   price feeds + recent realized volatility (log-normal / Black-Scholes-style
 *   binary digital option pricing). Most Kalshi crypto market liquidity is on
 *   BTC — XRP/SOL/DOGE markets often trade with $0 volume and wide spreads
 *   simply because most retail bots don't bother with them.
 *
 *   Our bot streams Coinbase + Binance ticks, computes a 5-min realized vol,
 *   prices each open Kalshi crypto contract, and fires when |model − market|
 *   exceeds a divergence threshold AND time-to-resolve is in the sweet spot
 *   (5–55 minutes — far enough for vol to matter, close enough for stable
 *   forecasts and immediate settlement after fill).
 *
 * MODEL:
 *   Under geometric Brownian motion with annualized vol σ and time T (years):
 *     P(S_T > K) = N( (ln(S_t/K) − ½σ²T) / (σ√T) )
 *   For "between" markets: P(K1 ≤ S_T ≤ K2) = P(S_T ≤ K2) − P(S_T ≤ K1)
 *
 * SAFETY:
 *   - Per-market cap clamped via risk engine (currently $60).
 *   - Skip markets resolving in <5 min (manipulation / late-cancel risk).
 *   - Skip markets resolving in >55 min (vol forecast degrades).
 *   - Skip if realized vol < 0.05 annualized (not enough samples yet).
 *   - Require min liquidity via canTrade.
 *   - Reject if divergence > 30pp (model is broken, not market).
 */

import { KalshiConnector } from '../connectors/kalshi.js';
import { PriceFeedAggregator } from '../connectors/priceFeeds.js';
import { empiricalYesProb } from './cryptoEmpiricalModel.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig, isAggressive, getTradingMode } from '../utils/config.js';
import { upsertMarket, recordHeartbeat, recordSignal, recordOrder, getRecentCryptoFiresByEvent, updateOrder, findOrderByExternalId, getRecentTradeGrades } from '../db/supabase.js';
import { touchHeartbeat } from '../utils/watchdog.js';
import { getAdaptiveController } from './adaptiveController.js';
import { startFundingRateFilter, getFundingThresholdAdjustment, getFundingSnapshot, getFundingBias } from './fundingRateFilter.js';
import { scanCrossStrikeArb, ArbCandidate } from './crossStrikeArb.js';

const log = createStrategyLogger('kalshi_hourly_crypto');

// === TUNABLES ===
// 2026-05-23: NARROWED to BTC only. Research-backed: BTC fill rate is 100%
// (deepest book, lowest adverse selection). ETH only fills 33% of maker orders
// per May 2026 audit, and SOL/XRP/DOGE markets are even thinner. Trading those
// is essentially gambling against better-informed takers.
// 2026-05-23 v3.1: expanded from BTC-only to all 5 coins. Previously SERIES was
// ['KXBTC', 'KXBTCD'] which ignored ~30+ in-band priced markets across ETH/SOL/XRP/DOGE.
// Each coin uses its own GARCH-fit vol prior (set in start()) and price feed.
// Doubles the addressable crypto market without changing any other parameter.
const SERIES = ['KXBTC', 'KXBTCD', 'KXETH', 'KXETHD', 'KXSOL', 'KXSOLD', 'KXXRP', 'KXXRPD', 'KXDOGE', 'KXDOGED'];

const UNDERLYING_MAP: Record<string, string> = {
  KXBTC: 'BTC', KXBTCD: 'BTC',
  KXETH: 'ETH', KXETHD: 'ETH',
  KXSOL: 'SOL', KXSOLD: 'SOL',
  KXXRP: 'XRP', KXXRPD: 'XRP',
  KXDOGE: 'DOGE', KXDOGED: 'DOGE',
};

// RESEARCH-BACKED CALIBRATION (May 2026):
// TTR window: 10-50 min (was 5-55). Below 10min = settlement manipulation risk. Above 50min = vol forecast quality drops.
const RECENT_VOL_WINDOW_MS = 5 * 60 * 1000;     // 5 min for vol estimation
const MIN_TICKS_FOR_VOL = 30;                    // need 30 ticks before pricing
const MIN_TT_SECONDS = 10 * 60;                  // 10 min (was 5) - settlement manipulation buffer
const MAX_TT_SECONDS = 40 * 60;                  // 40 min (was 50) - Deep research May 2026: TTR>40 spans 2 vol regimes at BTC 75% IV
const DISCOVERY_INTERVAL_MS = 60 * 1000;         // rediscover markets every 60s (new hourly batch every 30-60min)
// 2026-05-23: bumped from 5s→10s to 2s→5s now that we're on Chicago VPS
// (1.97ms vs 60-300ms latency). Faster polling catches market-maker updates
// before they propagate to others. WebSocket migration is the next step
// (eliminates polling entirely — push-based updates within ms).
const PRICE_REFRESH_MS = 2 * 1000;               // refresh Kalshi book every 2s per tracked market
const EVAL_INTERVAL_MS = 5 * 1000;               // re-evaluate all every 5s
const MAX_TRACKED = 600;                         // hard cap on tracked markets - need headroom for many series × strikes

// RESEARCH-BACKED THRESHOLDS by TTR bucket and price regime (probability points).
// Source: kalshi_crypto_research.pplx.md (May 2026)
// Components: fee breakeven + adverse-selection premium + model-uncertainty buffer + price-regime adjustment
/**
 * Deep research May 2026: asset-specific threshold tiers.
 * BTC/ETH have deeper books and lower adverse-selection → 5pp
 * SOL mid-depth → 6pp
 * XRP/DOGE thin → 7pp (was 6pp, raised to compensate for fill-rate degradation)
 */
function getThresholdForTrade(ttSec: number, marketMid: number, underlying?: string): number {
  const ttMin = ttSec / 60;
  // Bucket: TTR
  let row: 'short' | 'med' | 'long';
  if (ttMin <= 15) row = 'short';
  else if (ttMin <= 30) row = 'med';
  else row = 'long';
  // Bucket: price regime - distance from $0.50 (ATM is hardest)
  const dist = Math.abs(marketMid - 0.5);
  let col: 'extreme' | 'mid' | 'atm';
  if (dist >= 0.35) col = 'extreme';   // P≤0.15 or P≥0.85
  else if (dist >= 0.15) col = 'mid';  // P~0.20-0.35 or 0.65-0.80
  else col = 'atm';                     // P~0.40-0.60
  // Asset-specific matrices (deep research validated)
  // 2026-05-23 v2 (kalshi_crypto_model_v2.pplx.md): MAKER-FIRST thresholds.
  // Since we post limit orders (maker fee 0.0175×P(1-P), 4× lower than taker 0.07),
  // breakeven edge requirement drops from ~3.25pp to ~0.5pp at ATM. The model error
  // is the binding constraint, not fees — GARCH(1,1) calibration noise is ~3–5pp.
  // We hold above noise: 5.5pp short → 7.5pp long. Becker 2026 + GWU 46k-contract
  // study — maker rebate + structural edge from NO buyers means 53–56% WR achievable.
  // Old v174 BTC 4–6.6pp was trading inside the noise band.
  // 2026-05-23 v3 (strategy_v3_optimization.pplx.md): thresholds dropped 1.5–3pp.
  // Vol-prior recalibration (60→42% BTC etc.) shrinks GBM probability spread, so
  // legitimate ATM divergences are now SMALLER. Old thresholds (5.5–7.5pp) would
  // never fire under new model.
  // Maker breakeven at $0.50 = 0.44pp; v3 uses 4.0–5.5pp = ~9-12× margin.
  // GWU paper: makers >$0.50 earn +2.6% post-fee on average.
  const matrices: Record<string, Record<string, Record<string, number>>> = {
    BTC: {
      short: { extreme: 0.045, mid: 0.045, atm: 0.040 },  // 20–10min TTR
      med:   { extreme: 0.050, mid: 0.045, atm: 0.040 },  // 30–20min TTR
      long:  { extreme: 0.055, mid: 0.050, atm: 0.045 },  // 60–40min TTR
    },
    ETH: {
      short: { extreme: 0.045, mid: 0.045, atm: 0.040 },
      med:   { extreme: 0.050, mid: 0.045, atm: 0.040 },
      long:  { extreme: 0.055, mid: 0.050, atm: 0.045 },
    },
    SOL: {
      short: { extreme: 0.072, mid: 0.066, atm: 0.078 },
      med:   { extreme: 0.062, mid: 0.056, atm: 0.066 },
      long:  { extreme: 0.054, mid: 0.048, atm: 0.058 },
    },
    XRP: {
      short: { extreme: 0.082, mid: 0.076, atm: 0.088 },
      med:   { extreme: 0.072, mid: 0.066, atm: 0.078 },
      long:  { extreme: 0.064, mid: 0.058, atm: 0.068 },
    },
    DOGE: {
      short: { extreme: 0.082, mid: 0.076, atm: 0.088 },
      med:   { extreme: 0.072, mid: 0.066, atm: 0.078 },
      long:  { extreme: 0.064, mid: 0.058, atm: 0.068 },
    },
  };
  const matrix = (underlying && matrices[underlying]) || matrices.BTC;
  let base = matrix[row][col];
  // AGGRESSIVE mode (paper only): drop threshold by 50% to maximize fire count for testing.
  if (isAggressive()) base = Math.max(0.025, base * 0.5);
  return base;
}

/**
 * UPGRADE #3: Time-of-day threshold gating.
 * Research shows 01:00-07:00 UTC ("Asian dead zone") has materially worse fill quality
 * and more adverse selection (thinner books, news-gap risk). We harden the threshold by
 * +1.5pp during this window. Outside this window: 0.
 */
// =============================================================================
// SINGLE SOURCE OF TRUTH for "overnight / low-vol" UTC windows.
//
// Two layered windows derived from Amberdata BTC 2018-2023 vol study:
//
//   - ASIAN_DEAD_ZONE  01:00-06:59 UTC  (worst microstructure; +1.5pp threshold,
//                                        +1pp minDiv bump)
//   - LOW_VOL_WINDOW   01:00-07:59 UTC  (0.65x GBM prior; documented 0.68-0.80x
//                                        median realized vol)
//
// Before this consolidation the code had three different windows (01-06, 01-07,
// 00-12) used inconsistently. They now derive from these two helpers only.
// =============================================================================
function inAsianDeadZone(d: Date = new Date()): boolean {
  const h = d.getUTCHours();
  return h >= 1 && h <= 6;
}
function inLowVolWindow(d: Date = new Date()): boolean {
  const h = d.getUTCHours();
  return h >= 1 && h < 8;
}

function getTimeOfDayPenalty(): number {
  return inAsianDeadZone() ? 0.015 : 0;
}
// 2026-05-23 v3: raised 12pp → 15pp. The 12pp ceiling was blocking the legitimate
// 11–12pp divergences the bot was seeing. With v3 vol priors (lower), real ATM
// divergences will be 4–7pp; 11+pp signals at in-band prices are now rare enough
// to trust. Far-OTM blow-ups still filtered by price band ($0.25–$0.80).
const MAX_REASONABLE_DIVERGENCE = 0.15;



// ============================================================================
// v3.1 (strategy_v3_optimization.pplx.md Q4): Deribit DVOL implied-vol feed.
// Per arXiv crypto options study (2025), Black-Scholes/GBM has highest pricing
// error of 6 models tested; jump-diffusion (Kou/Bates) significantly outperforms.
// Implied vol from Deribit options reflects JUMP RISK that realized vol misses.
// When DVOL > GARCH realized, the market is pricing jump premium — we should
// widen our vol to match, reducing false divergence signals at OTM strikes.
// ============================================================================
const DVOL_CACHE = new Map<string, { ts: number; dvol: number }>();
const DVOL_TTL_MS = 5 * 60 * 1000;  // 5 min — DVOL doesn't change fast
async function fetchDvol(currency: 'BTC' | 'ETH'): Promise<number | null> {
  const cached = DVOL_CACHE.get(currency);
  if (cached && Date.now() - cached.ts < DVOL_TTL_MS) return cached.dvol;
  try {
    const end = Date.now();
    const start = end - 30 * 60 * 1000;  // last 30 min
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${start}&end_timestamp=${end}&resolution=60`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const d: any = await r.json();
    const points = d?.result?.data ?? [];
    if (points.length === 0) return null;
    const latest = points[points.length - 1];
    const dvolPct = latest[4];  // close
    if (typeof dvolPct !== 'number' || dvolPct <= 0) return null;
    const dvolFrac = dvolPct / 100;  // 37.55 → 0.3755
    DVOL_CACHE.set(currency, { ts: Date.now(), dvol: dvolFrac });
    return dvolFrac;
  } catch {
    return null;
  }
}

// Cached current DVOL for the priceHistory blend. Updated by setInterval below.
const CURRENT_DVOL: Record<string, number | undefined> = {};

// Reasonable price ranges per asset (reject obviously-wrong strikes/spots)
const PRICE_RANGE: Record<string, [number, number]> = {
  BTC: [10_000, 1_000_000],
  ETH: [500, 20_000],
  SOL: [5, 2_000],
  XRP: [0.1, 50],
  DOGE: [0.01, 10],
};

interface CryptoMarket {
  ticker: string;
  eventTicker: string;
  underlying: string;
  strikeType: 'greater' | 'less' | 'between';
  floorStrike: number;
  capStrike?: number;
  resolveAtMs: number;
  closesAtMs: number;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  liquidityUsd?: number;
  lastBookUpdate?: number;
  marketDbId?: string;
  title?: string;
  lastOrderAt?: number;  // for dedup
  lastOrderSide?: 'yes' | 'no';
  // v3.4 stale-book gate fields
  volume24h?: number;
  yesBidSize?: number;
  yesAskSize?: number;
  updatedTimeMs?: number;
}

/** Pending trade waiting for market resolution to grade. */
interface PendingTrade {
  ticker: string;
  underlying: string;
  side: 'yes' | 'no';
  size: number;
  entryPrice: number;
  resolveAtMs: number;
  modelProb: number;
  marketProb: number;
  realizedVol: number;
  graded: boolean;
}

interface PriceHistory {
  ticks: { price: number; ts: number }[];
  realizedVol: number;
}

export class KalshiHourlyCryptoStrategy {
  private markets = new Map<string, CryptoMarket>();
  private priceHistory = new Map<string, PriceHistory>();
  private inFlight = new Set<string>();
  private heartbeatStats = { opportunitiesSeen: 0, fires: 0, wsUpdates: 0, restRefreshes: 0 };
  // v175 WS migration: track active WS subscriptions to avoid duplicates and clean up on prune.
  private wsUnsubscribe = new Map<string, () => void>();
  private wsLastUpdate = new Map<string, number>();

  constructor(
    private kalshi: KalshiConnector,
    private priceFeed: PriceFeedAggregator
  ) {}

  async start(): Promise<void> {
    log.info('Kalshi hourly crypto strategy starting');

    // RESEARCH-BACKED VOL PRIORS (May 2026, annualized):
    // BTC 55-65%, ETH 65-80%, SOL 80-100%, XRP 70-90%, DOGE 85-110%
    // Old values (30/45/55/55/70) were way too low → model overconfidence
    for (const u of ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE']) {
      const sym = `${u}USDT`;
      // 2026-05-23 v3 (strategy_v3_optimization.pplx.md): vol priors recalibrated
      // against 30-day Kraken hourly GARCH(1,1) fit. Previous priors were 18–30pp
      // too high vs realized vol, inflating GBM probabilities at far-OTM strikes
      // and creating fake 11–12pp divergences the bot couldn't act on.
      // Source: 721 hourly Kraken candles, GARCH(1,1) with ω=2×10⁻⁶, α=0.1, β=0.85
      const seedVol = u === 'BTC' ? 0.42 : u === 'ETH' ? 0.50 : u === 'SOL' ? 0.61 : u === 'XRP' ? 0.48 : 0.60;
      this.priceHistory.set(sym, { ticks: [], realizedVol: seedVol });
      this.priceFeed.subscribe(sym, (tick) => {
        this.updatePriceHistory(sym, tick.price);
      });
    }

    // CRITICAL: Load recent fires from DB to persist firedEvents across deploys.
    // This fixes the stacking bug — in-memory map was wiped on each redeploy.
    const hydrate = async () => {
      try {
        const recent = await getRecentCryptoFiresByEvent(6);
        for (const [event, ts] of recent) {
          // Only widen the cap, never narrow (in-memory is the source of truth for this session)
          const existing = this.firedEvents.get(event);
          if (!existing || existing < ts) this.firedEvents.set(event, ts);
        }
        // v1 LOW-2: prune events older than 24h. firedEvents is a 1-fire-per-event lock
        // that prevents stacking exposure; once the event resolved (1-3 hours typical), the
        // lock is no longer needed and the entry just consumes memory. 24h is a safe margin.
        const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
        let pruned = 0;
        for (const [event, ts] of this.firedEvents) {
          if (ts < cutoffMs) { this.firedEvents.delete(event); pruned++; }
        }
        log.info({ loaded: recent.size, mapSize: this.firedEvents.size, prunedOver24h: pruned }, 'Hydrated firedEvents from DB');
      } catch (e: any) {
        log.warn({ err: e.message }, 'firedEvents hydration failed');
      }
    };
    await hydrate();
    // 2026-05-23 v2: re-hydrate every 60 min (was 5 min). The 5-min cadence was
    // burning ~3-9 MB/day of Supabase egress (~100 MB/month). The boot hydrate is
    // sufficient — in-memory map is the source of truth during a session; we only
    // need re-hydrate as a safety net against eventual-consistency lag, which 60 min
    // catches just as well.
    setInterval(hydrate, 60 * 60 * 1000);

    // v3.1: poll Deribit DVOL for BTC + ETH every 5 min. Used to widen vol in the
    // GBM blend when implied vol > realized vol (market is pricing jump risk).
    const pollDvol = async () => {
      try {
        const [btc, eth] = await Promise.all([fetchDvol('BTC'), fetchDvol('ETH')]);
        if (btc != null) CURRENT_DVOL['BTC'] = btc;
        if (eth != null) CURRENT_DVOL['ETH'] = eth;
        log.debug({ btcDvol: btc, ethDvol: eth }, 'DVOL refreshed');
      } catch (e: any) {
        log.warn({ err: e.message }, 'DVOL poll failed');
      }
    };
    pollDvol();
    setInterval(pollDvol, 5 * 60 * 1000);

    // Hydrate adaptive controller from DB: load recent trade-graded signals so
    // the kill switch + rolling win rate work across restarts. Without this,
    // every restart wipes adaptive memory → losses never accumulate → strategy
    // never throttles itself.
    try {
      const recentTrades = await getRecentTradeGrades(50);
      if (recentTrades.length > 0) {
        const adaptive = getAdaptiveController();
        adaptive.hydrate(recentTrades);
        const ks = adaptive.shouldKillSwitch();
        if (ks.trip && getTradingMode() === 'live') {
          log.fatal({ reason: ks.reason }, '🚨 KILL SWITCH TRIPPED ON BOOT — forcing paper mode');
          process.env.TRADING_MODE = 'paper';
          // H-8 fix: also flip the risk engine kill switch so strategies that gate on
          // canTrade() (not isPaperMode()) also stop firing.
          getRiskEngine().forceKill(`boot-adaptive: ${ks.reason}`);
          try {
            await sendDiscord(
              '🚨 KILL SWITCH on boot — forced paper',
              `<@572590897150296083>\nReason: ${ks.reason}\nBot hydrated losing trades from DB — won't trade live until manual reset.`,
              'error',
              []
            );
          } catch {}
        }
      }
    } catch (e: any) {
      log.warn({ err: e.message }, 'adaptive hydration failed');
    }

    // UPGRADE #4: Start funding-rate filter (polls Binance every 30 min)
    startFundingRateFilter();

    await this.discoverMarkets();
    setInterval(() => this.discoverMarkets(), DISCOVERY_INTERVAL_MS);
    // v175: WebSocket pushes book updates in real-time. REST refresh is now a stale-WS fallback only.
    // We slow it from 10s → 60s — it catches markets where the WS never sent a snapshot
    // (subscription race, server-side filter) or went silent (illiquid books with no trades).
    setInterval(() => this.refreshStaleBooks(), 60_000);
    setInterval(() => this.evaluateAll(), EVAL_INTERVAL_MS);
    // UPGRADE #1: Cross-strike monotonicity arb scanner (every 15s)
    setInterval(() => this.scanAndFireArb(), 15_000);
    setInterval(() => this.heartbeat(), 60_000);
    setInterval(() => this.pruneExpired(), 60_000);
    setInterval(() => this.gradePendingTrades(), 60_000);  // grade resolved trades every 1min
    setInterval(() => this.reconcileRestingOrders(), 15_000);  // cancel stale maker orders + sync fills
  }

  private async discoverMarkets(): Promise<void> {
    let totalDiscovered = 0;
    // First, prune any market that's already past resolve - free up slots
    const now = Date.now();
    for (const [k, m] of this.markets) {
      if (m.resolveAtMs < now + 60_000) {
        this.markets.delete(k);
        this.unsubscribeMarketWs(k);  // v175
      }
    }
    for (const series of SERIES) {
      try {
        const headers = (this.kalshi as any).hasCredentials
          ? (this.kalshi as any).sign('GET', '/trade-api/v2/markets', Date.now()) : {};
        const { data } = await (this.kalshi as any).http.get('/markets', {
          params: { status: 'open', limit: 200, series_ticker: series },
          headers,
        });
        const markets = data.markets || [];
        // Sort closest-to-resolution first so we capture the upcoming hour batches before the cap kicks in
        markets.sort((a: any, b: any) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());
        for (const m of markets) {
          if (this.markets.size >= MAX_TRACKED) break;
          if (this.markets.has(m.ticker)) continue;
          const parsed = this.parseMarket(m, series);
          if (!parsed) continue;
          this.markets.set(m.ticker, parsed);
          totalDiscovered++;
          // v175: subscribe to WS orderbook_delta for the new market.
          // Fire-and-forget — subscription happens on next WS open if WS is reconnecting.
          this.subscribeMarketWs(parsed).catch(() => {});
        }
      } catch (e: any) {
        if (!String(e.message).includes('429')) {
          log.debug({ series, err: e.message }, 'discoverMarkets series failed');
        }
      }
      await new Promise(r => setTimeout(r, 150)); // rate limit safety
    }
    if (totalDiscovered > 0) {
      log.info({ added: totalDiscovered, tracked: this.markets.size }, 'crypto market discovery');
    }
  }

  /**
   * v175 — Subscribe to Kalshi WS orderbook_delta for a single ticker.
   * Populates m.yesBid / m.yesAsk / m.noBid / m.noAsk in real-time (sub-50ms vs old 10s REST poll).
   * Idempotent: skips if already subscribed. Stale-WS fallback handled by refreshStaleBooks().
   */
  private async subscribeMarketWs(m: CryptoMarket): Promise<void> {
    if (this.wsUnsubscribe.has(m.ticker)) return;  // already subscribed
    try {
      const unsub = await this.kalshi.subscribeOrderBook(m.ticker, (book) => {
        // book.bestBid = highest YES bid, book.bestAsk = lowest YES ask (NO bid mirror)
        const yesBid = book.bestBid?.price;
        const yesAsk = book.bestAsk?.price;
        const yesBidSz = book.bestBid?.size ?? 0;
        const yesAskSz = book.bestAsk?.size ?? 0;
        m.yesBid = yesBid;
        m.yesAsk = yesAsk;
        // NO side is the mirror: noBid = 1 - yesAsk, noAsk = 1 - yesBid
        m.noBid = yesAsk != null ? +(1 - yesAsk).toFixed(2) : undefined;
        m.noAsk = yesBid != null ? +(1 - yesBid).toFixed(2) : undefined;
        // Liquidity proxy: top-of-book on both sides (in dollars)
        const tobLiq = yesBidSz + yesAskSz;
        if (tobLiq > 0) m.liquidityUsd = tobLiq;
        m.lastBookUpdate = Date.now();
        this.wsLastUpdate.set(m.ticker, Date.now());
        this.heartbeatStats.wsUpdates++;
      });
      this.wsUnsubscribe.set(m.ticker, unsub);
    } catch (e: any) {
      log.debug({ ticker: m.ticker, err: e.message }, 'WS subscribe failed — will rely on REST fallback');
    }
  }

  private unsubscribeMarketWs(ticker: string): void {
    const unsub = this.wsUnsubscribe.get(ticker);
    if (unsub) {
      try { unsub(); } catch {}
      this.wsUnsubscribe.delete(ticker);
      this.wsLastUpdate.delete(ticker);
    }
  }

  private parseMarket(m: any, series: string): CryptoMarket | null {
    const underlying = UNDERLYING_MAP[series];
    if (!underlying) return null;
    const floor = parseFloat(m.floor_strike);
    if (!isFinite(floor)) return null;
    const cap = m.cap_strike != null ? parseFloat(m.cap_strike) : undefined;
    const range = PRICE_RANGE[underlying];
    if (floor < range[0] || floor > range[1]) return null;
    const closeMs = m.close_time ? new Date(m.close_time).getTime() : 0;
    if (!closeMs) return null;
    const tt = (closeMs - Date.now()) / 1000;
    if (tt < 0 || tt > 24 * 60 * 60) return null; // skip stale & long-dated
    const strikeType = m.strike_type;
    if (!['greater', 'less', 'between'].includes(strikeType)) return null;

    return {
      ticker: m.ticker,
      eventTicker: m.event_ticker || m.ticker.split('-').slice(0, 2).join('-'),
      underlying,
      strikeType,
      floorStrike: floor,
      capStrike: cap,
      resolveAtMs: closeMs,
      closesAtMs: closeMs,
      liquidityUsd: m.liquidity_dollars ? parseFloat(m.liquidity_dollars) : (m.liquidity != null ? m.liquidity / 100 : undefined),
    };
  }

  private async refreshAllBooks(): Promise<void> {
    const now = Date.now();
    // Widen the refresh window - we want to know quotes for the upcoming hour even before
    // we'd actually trade. Books are refreshed independent of trading window.
    const candidates = [...this.markets.values()].filter(m => {
      const tt = (m.resolveAtMs - now) / 1000;
      return tt > 60 && tt < 90 * 60;  // 1min - 90min window for refresh
    });
    // Sort by closeness to spot (cheap proxy for likelihood of having quotes + an edge)
    // then by closest-to-resolution. Skip markets where spot is null (alts overnight).
    candidates.sort((a, b) => {
      const spotA = this.priceFeed.getLatestPrice(`${a.underlying}USDT`);
      const spotB = this.priceFeed.getLatestPrice(`${b.underlying}USDT`);
      if (!spotA && !spotB) return a.resolveAtMs - b.resolveAtMs;
      if (!spotA) return 1;
      if (!spotB) return -1;
      // Distance from spot in pct of spot
      const distA = Math.abs(a.floorStrike - spotA) / spotA;
      const distB = Math.abs(b.floorStrike - spotB) / spotB;
      // Prioritize within 5% of spot (the only strikes that get quoted anyway)
      const aBucket = distA < 0.05 ? 0 : distA < 0.15 ? 1 : 2;
      const bBucket = distB < 0.05 ? 0 : distB < 0.15 ? 1 : 2;
      if (aBucket !== bBucket) return aBucket - bBucket;
      return a.resolveAtMs - b.resolveAtMs;
    });
    const batch = candidates.slice(0, 150);
    let refreshed = 0;
    for (const m of batch) {
      const ok = await this.refreshBook(m);
      if (ok) refreshed++;
      await new Promise(r => setTimeout(r, 20));
    }
    if (candidates.length > 0) {
      log.debug({ candidates: candidates.length, refreshed, withPrices: [...this.markets.values()].filter(m => m.yesBid != null).length }, 'book refresh cycle');
    }
  }

  private async refreshBook(m: CryptoMarket): Promise<boolean> {
    try {
      const headers = (this.kalshi as any).hasCredentials
        ? (this.kalshi as any).sign('GET', `/trade-api/v2/markets/${m.ticker}`, Date.now()) : {};
      const { data } = await (this.kalshi as any).http.get(`/markets/${m.ticker}`, { headers });
      const mk = data.market;
      if (mk) {
        // Kalshi new schema uses `_dollars` string fields; fall back to legacy cents fields
        const parseD = (v: any, divisor = 1): number | undefined =>
          v != null && v !== '' ? parseFloat(v) / divisor : undefined;
        m.yesBid = parseD(mk.yes_bid_dollars) ?? parseD(mk.yes_bid, 100);
        m.yesAsk = parseD(mk.yes_ask_dollars) ?? parseD(mk.yes_ask, 100);
        m.noBid = parseD(mk.no_bid_dollars) ?? parseD(mk.no_bid, 100);
        m.noAsk = parseD(mk.no_ask_dollars) ?? parseD(mk.no_ask, 100);
        m.liquidityUsd = parseD(mk.liquidity_dollars) ?? parseD(mk.liquidity, 100) ?? m.liquidityUsd;
        m.lastBookUpdate = Date.now();
        // v3.4: capture stale-book gate inputs
        m.volume24h = parseFloat(mk.volume_24h_fp ?? mk.volume_24h ?? '0') || 0;
        m.yesBidSize = parseFloat(mk.yes_bid_size_fp ?? mk.yes_bid_size ?? '0') || 0;
        m.yesAskSize = parseFloat(mk.yes_ask_size_fp ?? mk.yes_ask_size ?? '0') || 0;
        if (mk.updated_time) m.updatedTimeMs = new Date(mk.updated_time).getTime();
        return true;
      }
      return false;
    } catch (e: any) {
      return false;
    }
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [k, m] of this.markets) {
      if (m.resolveAtMs < now) {
        this.markets.delete(k);
        this.unsubscribeMarketWs(k);  // v175: clean up WS subscription on prune
      }
    }
  }

  /**
   * v175 — Stale-WS fallback. Only refreshes markets where:
   *   1. We've never received a WS update (subscription pending or failed), OR
   *   2. WS hasn't pushed an update in 90s (book genuinely idle or subscription dropped silently)
   * Calls existing refreshBook() which hits the per-market REST endpoint.
   */
  private async refreshStaleBooks(): Promise<void> {
    const now = Date.now();
    const candidates = [...this.markets.values()].filter(m => {
      const tt = (m.resolveAtMs - now) / 1000;
      if (tt < 60 || tt > 90 * 60) return false;
      const lastWs = this.wsLastUpdate.get(m.ticker) ?? 0;
      return now - lastWs > 90_000;  // 90s since last WS push → fall back to REST
    });
    // Cap to 50 per cycle to avoid REST burst (down from 150 since WS handles the rest)
    const batch = candidates.slice(0, 50);
    let refreshed = 0;
    for (const m of batch) {
      const ok = await this.refreshBook(m);
      if (ok) { refreshed++; this.heartbeatStats.restRefreshes++; }
      await new Promise(r => setTimeout(r, 20));
    }
    if (candidates.length > 0) {
      log.debug({
        candidates: candidates.length,
        refreshed,
        wsSubscribed: this.wsUnsubscribe.size,
        tracked: this.markets.size,
      }, 'v175 stale-WS REST fallback cycle');
    }
  }

  private updatePriceHistory(symbol: string, price: number): void {
    const hist = this.priceHistory.get(symbol);
    if (!hist) return;
    const now = Date.now();
    hist.ticks.push({ price, ts: now });
    hist.ticks = hist.ticks.filter(t => now - t.ts < RECENT_VOL_WINDOW_MS);
    if (hist.ticks.length >= MIN_TICKS_FOR_VOL) {
      const logReturns: number[] = [];
      for (let i = 1; i < hist.ticks.length; i++) {
        const r = Math.log(hist.ticks[i].price / hist.ticks[i - 1].price);
        logReturns.push(r);
      }
      const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
      // Average dt per tick in seconds
      const totalSec = (hist.ticks[hist.ticks.length - 1].ts - hist.ticks[0].ts) / 1000;
      const avgDtSec = totalSec / Math.max(1, hist.ticks.length - 1);
      // Annualize: vol per sqrt(year) = stdPerTick / sqrt(secPerTick / secPerYear)
      const stdPerTick = Math.sqrt(variance);
      const secPerYear = 365 * 24 * 60 * 60;
      const annualVol = stdPerTick * Math.sqrt(secPerYear / Math.max(0.5, avgDtSec));
      // RESEARCH-BACKED priors (higher than before):
      const u = symbol.replace('USDT','');
      // CALM-REGIME PRIOR: reduce prior during 00-13 UTC when realized vol
      // is consistently lower than the all-day average. Pure GBM with all-day
      // priors overconfidently expects bigger moves than overnight markets deliver.
      // Tightened from 0.7 to 0.65 per research (Amberdata BTC 2018-2023 study):
    // 03:00-07:00 UTC documented as 0.68-0.80x median vol; use 0.65x for safety.
    // Source of truth: inLowVolWindow() above.
    const calmMultiplier = inLowVolWindow() ? 0.65 : 1.0;
      // 2026-05-23 v3: same GARCH-fit prior here for vol prior fallback inside
      // updatePriceHistory (low-data regime). Calm-multiplier still applies for
      // overnight/Asian dead-zone windows.
      const fullDayPrior = u === 'BTC' ? 0.42 : u === 'ETH' ? 0.50 : u === 'SOL' ? 0.61 : u === 'XRP' ? 0.48 : 0.60;
      const prior = fullDayPrior * calmMultiplier;
      const empirical = Math.max(0.05, Math.min(2.0, annualVol));
      const adaptive = getAdaptiveController();
      // POST-LOSS-PATTERN FIX (May 2026): All 4 paper/backtest losses had model overconfident
      // because GBM vol was too high → probabilities pulled too far from spot → false divergence.
      // Lean MORE on empirical (60-70% weight, was 30-50%) and let realized go lower than prior.
      const baseEmpWeight = adaptive.get().volEmpiricalWeight;
      const empWeight = Math.max(baseEmpWeight, 0.65);  // ≥ 65% weight on empirical
      let blended = empWeight * empirical + (1 - empWeight) * prior;

      // v3.1: blend in Deribit DVOL (implied vol) when available, 30% weight.
      // Implied vol captures jump risk that GARCH realized vol underprices.
      // If DVOL > our blended, widen our vol to match (market knows about upcoming
      // events we don't). If DVOL < blended, ignore (market thinks the recent move
      // was an anomaly — trust the realized).
      const dvol = CURRENT_DVOL[u];
      if (dvol != null && dvol > blended) {
        blended = 0.7 * blended + 0.3 * dvol;
      }

      // FLOOR lowered: was prior*0.7 (which kept vol artificially high in calm regimes).
      // Now floor at prior*0.4 — let calm markets price correctly.
      hist.realizedVol = Math.max(prior * 0.4, Math.min(prior * 2.0, blended));
      // Feed regime detection (empirical vs prior comparison)
      adaptive.recordVolSnapshot(empirical, prior);
    }
  }

  // CND via Abramowitz & Stegun
  private cnd(x: number): number {
    const a1 = 0.31938153, a2 = -0.356563782, a3 = 1.781477937, a4 = -1.821255978, a5 = 1.330274429;
    const L = Math.abs(x);
    const K = 1.0 / (1.0 + 0.2316419 * L);
    let w = 1.0 - (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-L * L / 2) *
      (a1 * K + a2 * K ** 2 + a3 * K ** 3 + a4 * K ** 4 + a5 * K ** 5);
    if (x < 0) w = 1.0 - w;
    return w;
  }

  private probAbove(
    spot: number,
    strike: number,
    sigma: number,
    ttSec: number,
    skewAdjustmentPp: number = 0,
  ): number {
    if (ttSec <= 0) return spot > strike ? 1 : 0;
    const T = ttSec / (365 * 24 * 60 * 60);
    // v3.4 (strategy_v3_optimization.pplx.md Tier 1 #1): Merton jump-diffusion
    // (a Bates simplification). Per arXiv 2025 crypto-options study, pure GBM has
    // the worst pricing error of 6 models tested. Merton-jump adds fat-tail risk
    // that GBM misses — specifically the sudden 1-2% adverse moves that bit us
    // on today's ETH > $2,119.99 loss (ETH dumped from $2,140 → $2,114 in 40min).
    //
    // Bates(σ, λ, m_J, s_J) where:
    //   λ (jump rate, jumps/year): 24 — ~2 jumps/month for BTC (Yan-Zelenov 2025)
    //   m_J (mean log jump): 0 — symmetric jumps (we already do skew correction separately)
    //   s_J (jump stdev): 0.012 — 1.2% std jump for BTC, common-research consensus
    //
    // Method: sum over k=0..6 Poisson-weighted GBM probabilities at jump-inflated vol.
    const lambda = 24;   // jumps/year (~2/month)
    const sJ = 0.012;    // jump stdev (log-scale)
    const lambdaT = lambda * T;
    let prob = 0;
    let kFact = 1;
    for (let k = 0; k <= 6; k++) {
      if (k > 0) kFact *= k;
      const poisson = Math.exp(-lambdaT) * Math.pow(lambdaT, k) / kFact;
      if (poisson < 1e-8) continue;
      // Jump-inflated effective variance for k jumps:
      const varK = sigma * sigma * T + k * sJ * sJ;
      const sigK = Math.sqrt(varK / T);
      const d2 = (Math.log(spot / strike) - 0.5 * sigK * sigK * T) / (sigK * Math.sqrt(T));
      prob += poisson * this.cnd(d2);
    }
    // Apply vol-skew correction. BTC May 2026 has persistent negative 25-delta
    // risk reversal (put IV > call IV). Symmetric GBM overstates upside probability.
    return Math.max(0, Math.min(1, prob + skewAdjustmentPp));
  }

  /**
   * Computes the YES-probability skew adjustment (in fractional probability units).
   * Returns NEGATIVE values for OTM call bets (strike above spot) to compensate
   * for symmetric GBM ignoring BTC's negative 25-delta risk reversal in current regime.
   * Sources: CME Group BTC options Feb 2026, Deribit Insights Week-7 2026.
   */
  private getSkewAdjustment(underlying: string, strikeDist: number, ttSec: number): number {
    if (strikeDist <= 0) return 0; // only correct for strikes ABOVE spot
    const distPct = strikeDist * 100;
    const baseSkewPp = (underlying === 'BTC' || underlying === 'ETH')
      ? -Math.min(0.05, 0.02 + 0.025 * Math.min(distPct, 1.2))
      : -Math.min(0.04, 0.015 + 0.02 * Math.min(distPct, 1.2));
    const ttFactor = Math.min(1, ttSec / (15 * 60));
    return baseSkewPp * ttFactor;
  }

  /**
   * Settlement-window correction.
   *
   * Kalshi crypto markets settle on a ~60-second average of prices RIGHT BEFORE
   * resolution, not on the closing tick. This means actual settlement uncertainty
   * is HIGHER than a pure GBM model suggests, especially for between-strike bets
   * where spot is already near-center.
   *
   * We add a small extra effective time-to-resolve to account for the averaging
   * window. This shrinks model probabilities away from the extremes (0/1) toward
   * the true settlement distribution.
   */
  private effectiveTt(ttSec: number): number {
    // Add 90s of "settlement window" noise on top of remaining time
    return ttSec + 90;
  }

  private yesProb(m: CryptoMarket, spot: number, sigma: number, ttSec: number): number {
    const teff = this.effectiveTt(ttSec);
    const strikeDist = (m.floorStrike - spot) / spot;
    const skewAdj = this.getSkewAdjustment(m.underlying, strikeDist, ttSec);

    let raw: number;
    if (m.strikeType === 'greater') {
      raw = this.probAbove(spot, m.floorStrike, sigma, teff, skewAdj);
    } else if (m.strikeType === 'less') {
      // For "BTC ≤ K": YES = P(BTC < K). Put skew makes this side more likely; no negative adj.
      raw = 1 - this.probAbove(spot, m.floorStrike, sigma, teff, 0);
    } else {
      return -1; // skip 'between'
    }
    // POST-LOSS RECALIBRATION May 22 2026: 70% market / 30% model (was 50/50).
    // Kalshi KXBTC has institutional MMs (SIG, Citadel-affiliated, Jump-affiliated)
    // quoting 98% of contracts. When MMs price 17% and our retail GBM says 30%,
    // the MMs are right ~95% of the time. Model gets 30% weight only.
    if (m.yesBid != null && m.yesAsk != null) {
      const marketPrior = (m.yesBid + m.yesAsk) / 2;
      raw = 0.30 * raw + 0.70 * marketPrior;
    }
    // Settlement averaging correction (unchanged)
    if (ttSec < 15 * 60) {
      raw = 0.5 + 0.987 * (raw - 0.5);
    }
    return raw;
  }

  private pendingTrades: PendingTrade[] = [];
  /** Maker orders we placed that haven't filled yet. orderId -> details */
  private restingOrders = new Map<string, {
    orderId: string;
    postedAt: number;
    ticker: string;
    side: 'yes' | 'no';
    size: number;
    entryPrice: number;
    eventTicker: string;
    marketDbId?: string;
    dbOrderId?: string;
    /** C-4 fix: True if immediate-fill branch already posted TP/SL for partial fill. */
    tpSlPosted?: boolean;
    /** H-4: discriminator so reconciler can cancel sibling exit when one side fills. */
    kind?: 'entry' | 'tp' | 'sl';
    /** H-4: for kind='tp'|'sl', the orderId of the sibling exit to cancel on fill. */
    siblingExitId?: string;
  }>();
  private readonly MAKER_TIMEOUT_MS = 90_000;  // cancel after 90s if not filled (was 60s; BTC books slow at 12-15min TTR)
  private bestDivergenceSeen: { ticker?: string; div?: number; mid?: number; model?: number; spread?: number } = {};
  private lastFireAt = 0;
  // Paper-test pacing - looser to capture more visibility
  private readonly MIN_TIME_BETWEEN_FIRES_MS = isAggressive() ? 2_000 : 5_000;
  private readonly MIN_TIME_PER_TICKER_MS = isAggressive() ? 60_000 : 300_000;
  private firedEvents = new Map<string, number>(); // event_ticker -> last fire time. Strict 1-fire-per-event cap (KEEP THIS - prevents stacked exposure even in paper)
  private consecutiveLosses = 0;  // for live-override 5-loss kill switch

  // Position cache (30s TTL) to avoid hammering Kalshi getPositions on every fire attempt
  private _positionsCache: { ts: number; data: any[] } | null = null;
  private async getCachedPositions(): Promise<any[]> {
    const now = Date.now();
    if (this._positionsCache && (now - this._positionsCache.ts) < 30_000) {
      return this._positionsCache.data;
    }
    const positions = await this.kalshi.tryGetPositions();
    this._positionsCache = { ts: now, data: positions };
    return positions;
  }
  /** Invalidate position cache after a successful fire so next pre-flight sees fresh data. */
  private invalidatePositionCache(): void { this._positionsCache = null; }

  /**
   * UPGRADE #1: Cross-strike monotonicity arbitrage.
   * Scans current books for arb violations and fires on the best one each cycle.
   * Respects all existing risk + per-event caps.
   */
  private async scanAndFireArb(): Promise<void> {
    // ========== HARD DISABLE (May 22 PM 2026) ==========
    // Cross-strike monotonicity arb places YES bets that have been losing.
    // Confirmed earlier audit: 0 actual violations in the live Kalshi book.
    // To re-enable, set CROSS_STRIKE_ARB_ENABLED=true. Default OFF.
    if (process.env.CROSS_STRIKE_ARB_ENABLED !== 'true') return;

    const candidates = scanCrossStrikeArb(this.markets.values());
    if (candidates.length === 0) return;
    // Take best candidate that hasn't already fired its event
    const best = candidates.find(c => !this.firedEvents.has(c.eventTicker));
    if (!best) return;
    // TT-min sanity
    const ttSec = (best.resolveAtMs - Date.now()) / 1000;
    if (ttSec < MIN_TT_SECONDS || ttSec > MAX_TT_SECONDS) return;
    if (this.inFlight.has(best.buyTicker)) return;
    // Lookup the actual market object for full context
    const m = this.markets.get(best.buyTicker);
    if (!m) return;

    const risk = getRiskEngine();
    // MAY 22 2026 RECALIBRATION (Option B): cross-strike arb gets its own larger cap
    // because it's mathematically lower-risk than vol-divergence (catches market
    // mistakes, not making forecasts). Size scales with VIOLATION SIZE so we bet
    // proportional to confidence:
    //   1pp violation  → base $20
    //   2pp violation  → $40
    //   3pp+ violation → $80 (capped)
    // Subject to orderbook depth and a $80 hard cap (vs. crypto-divergence's $35).
    const violationScaling = Math.min(80, Math.max(20, best.violationPp * 100 * 20));
    let sizeUsd = violationScaling;
    const adaptiveMult = getAdaptiveController().get().kellyMultiplier;
    sizeUsd *= adaptiveMult;
    // Larger cap for cross-strike: $80 (vs. crypto-divergence $35).
    // Bankroll-relative ceiling: 8% of bankroll, whichever is smaller.
    const maxPerTrade = Math.min(80, 0.08 * risk.getStats().bankroll);
    if (sizeUsd > maxPerTrade) sizeUsd = maxPerTrade;
    // Option A: hard cap disabled by default
    const liveHardCapArb = parseFloat(process.env.LIVE_HARD_CAP_USD ?? '0');
    if (liveHardCapArb > 0 && sizeUsd > liveHardCapArb) sizeUsd = liveHardCapArb;

    const check = risk.canTrade('kalshi_hourly_crypto', best.buyTicker, sizeUsd, {
      closesAt: new Date(best.closesAtMs),
      eventTicker: best.eventTicker,
      fractional: false,
      liquidityUsd: Math.max(best.liquidityUsd ?? 0, 50),
    });
    if (!check.allowed) return;
    const sizeContracts = Math.floor(check.sizeUsd / best.buyPrice);
    if (sizeContracts < 5) return;

    // Pacing/dedupe (reuse same logic as main strategy)
    const now2 = Date.now();
    if (now2 - this.lastFireAt < this.MIN_TIME_BETWEEN_FIRES_MS) return;
    if (m.lastOrderAt && now2 - m.lastOrderAt < this.MIN_TIME_PER_TICKER_MS) return;
    // Race-free atomic check
    if (this.firedEvents.has(best.eventTicker)) return;

    this.lastFireAt = now2;
    m.lastOrderAt = now2;
    m.lastOrderSide = 'yes';
    this.firedEvents.set(best.eventTicker, now2);
    this.inFlight.add(best.buyTicker);

    // Ensure market exists in DB
    if (!m.marketDbId) {
      try {
        const id = await upsertMarket({
          platform: 'kalshi',
          external_id: m.ticker,
          question: m.title || `${m.underlying} ${m.strikeType} ${m.floorStrike}${m.capStrike ? '/' + m.capStrike : ''}`,
          category: 'crypto',
          outcome: 'YES',
          closes_at: new Date(m.closesAtMs),
        });
        if (id) m.marketDbId = id;
      } catch {}
    }

    let signalId: string | null = null;
    try {
      signalId = await recordSignal({
        strategy: 'kalshi_hourly_crypto',
        market_id: m.marketDbId,
        mode: getConfig().TRADING_MODE,
        reason: 'cross-strike-arb',
        side: 'YES',
        model_prob: best.expectedFloor,  // monotonicity floor is our "model"
        market_prob: best.buyPrice,
        edge_bps: Math.round(best.violationPp * 10000),
        recommended_size_usd: check.sizeUsd,
        acted: true,
        payload: {
          ticker: best.buyTicker,
          underlying: best.underlying,
          refTicker: best.refTicker,
          refPrice: best.refPrice,
          violationPp: best.violationPp,
          floor: best.floorStrike,
          cap: best.capStrike,
          strikeType: best.strikeType,
          arbType: 'cross-strike-monotonicity',
        },
      });
    } catch {}

    log.info({
      ticker: best.buyTicker, underlying: best.underlying,
      buyPrice: best.buyPrice, expectedFloor: best.expectedFloor,
      violationPp: (best.violationPp * 100).toFixed(2),
      refTicker: best.refTicker, refPrice: best.refPrice,
      sizeContracts, signalId,
    }, 'CROSS-STRIKE ARB fire');

    try {
      const result = await this.kalshi.placeOrder({
        platform: 'kalshi',
        externalId: best.buyTicker,
        outcome: 'YES',
        side: 'BUY',
        orderType: 'limit',
        price: best.buyPrice,
        size: sizeContracts,
        clientOrderIdPrefix: 'crypto-arb',
      } as any);

      const filled = result.filled ?? 0;
      const orderOk = result.ok && filled > 0;
      risk.recordOrderAttempt(best.eventTicker, orderOk);

      if (m.marketDbId) {
        try {
          await recordOrder({
            signal_id: signalId ?? undefined,
            market_id: m.marketDbId,
            strategy: 'kalshi_hourly_crypto',
            mode: getConfig().TRADING_MODE,
            side: 'BUY',
            order_type: 'LIMIT',
            price: best.buyPrice,
            size: sizeContracts,
            filled_size: filled,
            outcome: 'YES',
            external_order_id: result.externalOrderId,
            status: orderOk ? (filled === sizeContracts ? 'filled' : 'partial') : 'rejected',
          });
        } catch {}
      }

      if (orderOk) {
        risk.recordDeployment('kalshi_hourly_crypto', best.buyTicker, filled * best.buyPrice);
        // Discord ping (PAPER vs LIVE)
        try {
          const arrow = best.strikeType === 'greater' ? '≥' : '≤';
          await sendDiscord(
            `🔗 ARB ${best.underlying} ${arrow} ${best.floorStrike}`,
            `${getConfig().TRADING_MODE.toUpperCase()} · cross-strike monotonicity violation · resolves in ${(ttSec / 60).toFixed(1)} min`,
            'success',
            [
              { name: 'Side', value: 'YES', inline: true },
              { name: 'Floor', value: best.expectedFloor.toFixed(3), inline: true },
              { name: 'Paid', value: best.buyPrice.toFixed(3), inline: true },
              { name: 'Violation', value: `${(best.violationPp * 100).toFixed(2)}pp`, inline: true },
              { name: 'Size', value: `${filled} @ $${best.buyPrice.toFixed(3)} = $${(filled * best.buyPrice).toFixed(2)}`, inline: false },
              { name: 'Ref Strike', value: `${best.refTicker} @ ${best.refPrice.toFixed(3)}`, inline: false },
            ],
          );
        } catch {}
      }
    } catch (err: any) {
      log.error({ err: err.message, ticker: best.buyTicker }, 'cross-strike arb order error');
    } finally {
      this.inFlight.delete(best.buyTicker);
    }
  }

  private evaluateAll(): void {
    this.heartbeatStats.opportunitiesSeen = 0;
    this.bestDivergenceSeen = {};
    let scannedWithQuotes = 0;
    let bestAbsDiv = 0;
    for (const m of this.markets.values()) {
      // Pre-screen scan for diagnostic visibility BEFORE filters apply
      if (m.yesBid != null && m.yesAsk != null && m.strikeType !== 'between') {
        const sym = `${m.underlying}USDT`;
        const spot = this.priceFeed.getLatestPrice(sym);
        const hist = this.priceHistory.get(sym);
        const ttSec = (m.resolveAtMs - Date.now()) / 1000;
        if (spot && hist && ttSec > MIN_TT_SECONDS && ttSec < MAX_TT_SECONDS) {
          const modelP = this.yesProb(m, spot, hist.realizedVol, ttSec);
          if (modelP >= 0 && modelP <= 1) {
            const mid = (m.yesBid + m.yesAsk) / 2;
            const div = modelP - mid;
            const absDiv = Math.abs(div);
            scannedWithQuotes++;
            if (absDiv > bestAbsDiv) {
              bestAbsDiv = absDiv;
              this.bestDivergenceSeen = {
                ticker: m.ticker, div, mid, model: modelP, spread: m.yesAsk - m.yesBid,
              };
            }
          }
        }
      }
      this.evaluateMarket(m);
    }
    if (scannedWithQuotes > 0 && bestAbsDiv > 0.02) {
      log.info({ scannedWithQuotes, bestAbsDiv: bestAbsDiv.toFixed(3), best: this.bestDivergenceSeen }, 'diagnostic: best edge seen this cycle');
    }
  }

  private async evaluateMarket(m: CryptoMarket): Promise<void> {
    if (this.inFlight.has(m.ticker)) return;

    // v3.4 STALE-BOOK GATE: skip markets with no real two-sided MM activity.
    // This is the exact failure mode that lost us $3.10 on ETH today — the book
    // had a wide spread (35¢) with no fresh trades, and our maker bid sat in a void.
    // Gate: skip if BOTH (volume_24h is 0 OR very low) AND (one side has zero depth)
    //       OR if updated_time > 30 min ago (no MM is actively quoting).
    // Note: we only apply this gate when we HAVE the data — WS-only markets won't have
    // volume24h until REST fallback fills it in (~60s).
    if (m.volume24h != null) {
      const noVolume = m.volume24h < 5;       // <5 contracts traded in 24h = essentially dead
      const oneSidedBook = (m.yesBidSize ?? 0) === 0 || (m.yesAskSize ?? 0) === 0;
      const noFreshUpdate = m.updatedTimeMs != null && (Date.now() - m.updatedTimeMs) > 30 * 60 * 1000;
      if ((noVolume && oneSidedBook) || noFreshUpdate) {
        // Silent skip — these are common (most far-OTM strikes have no volume)
        return;
      }
    }

    const sym = `${m.underlying}USDT`;
    // v3.4: prefer BRTI-style cross-exchange median for BTC/ETH (Kalshi's actual
    // settle source is BRTI). Falls back to single-source latest price otherwise.
    let spot: number | null;
    if (m.underlying === 'BTC' || m.underlying === 'ETH') {
      const brti = this.priceFeed.getBrtiEstimate(sym);
      spot = brti?.price ?? this.priceFeed.getLatestPrice(sym);
    } else {
      spot = this.priceFeed.getLatestPrice(sym);
    }
    if (!spot) return;
    const hist = this.priceHistory.get(sym);
    if (!hist || hist.ticks.length < MIN_TICKS_FOR_VOL) return;

    const ttSec = (m.resolveAtMs - Date.now()) / 1000;
    if (ttSec < MIN_TT_SECONDS || ttSec > MAX_TT_SECONDS) return;

    // MAY 22 PM 2026: switched to empirical logistic regression (Option 3).
    // Trained on 54 graded signals, log-loss –23% vs GBM, Brier –27%.
    // CRIT-10 fix: empirical model only trained on 'greater' contracts. Returns -1
    // for 'less'/'between' so we fall back to the GBM pricer for those.
    let modelProb = empiricalYesProb(m, spot, hist.realizedVol, ttSec);
    if (modelProb === -1) {
      // Fall back to GBM-derived probability for non-call contracts.
      modelProb = this.yesProb(m, spot, hist.realizedVol, ttSec);
    }
    if (modelProb < 0 || modelProb > 1) return;

    // Require both bid + ask present to compute mid
    if (m.yesBid == null || m.yesAsk == null) return;
    // RESEARCH-BACKED spread filter: 8¢ max (was 20¢ — too loose, insufficient liquidity)
    const spread = m.yesAsk - m.yesBid;
    if (spread > 0.08) return;
    if (m.yesAsk >= 0.97 && m.yesBid >= 0.95) return; // both sides near-certain YES
    if (m.yesBid <= 0.03 && m.yesAsk <= 0.05) return; // both sides near-certain NO
    const marketMid = (m.yesBid + m.yesAsk) / 2;
    // RESEARCH-BACKED: skip longshot YES at $0.05-$0.15 (favorite-longshot bias documented)
    // Bot may still go NO on longshot strikes which is the favorable side.
    // We only filter the YES-buying side here; NO can still fire.

    const divergence = modelProb - marketMid;
    const absDiv = Math.abs(divergence);

    // ============ MAY 22 2026 DEEP RECALIBRATION: DISABLE YES BETS ============
    // EMPIRICAL FINDING: All 34 YES-bet divergence signals in the DB have spot < strike
    // (model betting price will rise above strike). Raw GBM assigns 40-60% probability
    // to these OTM calls; market assigns 15-30%. After the 70/30 blend, blended model
    // STILL reads 6-14pp above market — because no finite blend fixes a 15-30pp
    // systematic overestimate from a GBM that cannot price jump-risk / fat tails.
    //
    // Back-calculated market-implied sigma for these strikes is >10.0 annualized
    // (GBM formula hits the ceiling), confirming the market embeds non-GBM jump
    // premiums that our model structurally ignores.
    //
    // The 4 graded live YES bets won 1/4 (25% win rate) — consistent with market
    // being right at ~20% and us overpaying. Disable YES bets until a calibrated
    // jump-diffusion model (or empirical logistic regression on realized outcomes)
    // replaces the GBM pricer.
    // ========== YES BET POLICY (May 23 2026 v2 recalibration) ==========
    // History: 34/34 YES bets LOST under the OLD regime (taker orders, $40 trades,
    // Kelly 0.20, no price-band gating, GBM model untuned). The losses came from
    // far-OTM YES bets at extreme strikes ($0.05–$0.20) where the GBM pricer
    // structurally underestimates jump premium that MMs correctly embed.
    //
    // v176 changed: maker-only, Kelly 0.075, $15 cap, $0.25–$0.80 band, 5.5–7.5pp
    // thresholds. The structural reasons for the original losses are largely
    // addressed. But — we have ZERO live wins to prove the new model. So:
    //
    //   • ALLOW YES bets in the ATM band ($0.35–$0.65) where GBM is most reliable.
    //     This is where market-implied sigma matches realized sigma most closely.
    //   • BLOCK YES at extremes ($0.25–$0.35 OTM, $0.65–$0.80 ITM-favorite)
    //     because that's exactly where the 34/34 loss happened (far-OTM longshots).
    //   • Hard block restored automatically if first 10 YES fires settle with WR<30%
    //     (via adaptive controller's killSwitch path).
    //
    // Env override: CRYPTO_YES_FULL_BLOCK=true restores the May 22 hard block.
    if (divergence > 0) {
      const yesFullBlock = process.env.CRYPTO_YES_FULL_BLOCK === 'true';
      const inSafeBand = marketMid >= 0.35 && marketMid <= 0.65;
      if (yesFullBlock || !inSafeBand) {
        log.info({ ticker: m.ticker, divergence: divergence.toFixed(3), marketMid, reason: yesFullBlock ? 'env-block' : 'outside-ATM-band' },
          'YES BLOCK: crypto YES bet skipped (jump-risk band)');
        return;
      }
      log.info({ ticker: m.ticker, divergence: divergence.toFixed(3), marketMid },
        'YES OK: ATM band, allowing v2 YES bet');
    }
    // ==========================================================================

    // Research-backed threshold: tiered by TTR + price regime
    let minDiv = getThresholdForTrade(ttSec, marketMid, m.underlying);
    // Adaptive controller can override (after losses tighten further)
    const adaptiveDiv = getAdaptiveController().get().minDivergence;
    if (adaptiveDiv > minDiv) minDiv = adaptiveDiv;
    // UPGRADE #3: Time-of-day gating (harder during Asian dead zone 01:00-06:59 UTC)
    minDiv += getTimeOfDayPenalty();
    // UPGRADE #4: Funding-rate bias adjustment
    // Direction matches the side we'd take given divergence sign
    const tentativeSide: 'yes' | 'no' = divergence > 0 ? 'yes' : 'no';
    minDiv += getFundingThresholdAdjustment(m.underlying, tentativeSide);

    // HARD STOP: don't trade against strong funding bias.
    // BTC funding has been -0.03 to -0.05% per 8hr for 46+ days = structural
    // bearish positioning. Betting YES into negative funding caused 12+hrs of
    // losses. Skip trades where funding strongly opposes the direction.
    const fundingRaw = getFundingBias(m.underlying);
    const HARD_FUNDING_THRESHOLD = 0.0003;
    if (fundingRaw < -HARD_FUNDING_THRESHOLD && tentativeSide === 'yes') {
      log.debug({ ticker: m.ticker, funding: fundingRaw }, 'SKIP: funding negative, would bet YES against bearish flow');
      return;
    }
    if (fundingRaw > HARD_FUNDING_THRESHOLD && tentativeSide === 'no') {
      log.debug({ ticker: m.ticker, funding: fundingRaw }, 'SKIP: funding positive, would bet NO against bullish flow');
      return;
    }

    // POST-MAY-22-LOSSES CALIBRATION FIX:
    // Empirical evidence from 6+ hrs of live losses: bot is overconfident when strike
    // is within ~0.3% of spot. Model probability diverges 10-15pp from market, but
    // actual outcomes match market (not model). Fix: tighten threshold proportionally
    // to (1 / strike_distance_pct) so near-money strikes need bigger edge.
    const strikeDist = Math.abs(m.floorStrike - spot) / spot;  // fraction
    // 0.30% away = +2pp threshold. 0.10% away = +6pp. 1%+ away = no penalty.
    const proximityPenalty = strikeDist < 0.01
      ? Math.min(0.06, 0.02 / Math.max(0.001, strikeDist) * 0.001)
      : 0;
    minDiv += proximityPenalty;
    // Also: in overnight/calm hours (00-13 UTC), add additional 1pp.
    // Overnight realized vol is consistently lower than the GBM model assumes.
    // Use the SAME window as calmMultiplier (01:00-07:59 UTC) instead of the
    // old too-broad 00:00-12:59 window that conflicted with the other two.
    if (inAsianDeadZone()) minDiv += 0.01;

    // ============ MAY 22 2026: NO-BET ITM PROXIMITY FILTER ============
    // All 19 NO-bet signals have spot > strike (we're betting price drops back through).
    // Signals with dist_above < 0.15% (near-money) show the worst risk/reward:
    // market prices NO at 25-37c there (high uncertainty), yet raw GBM only gives
    // ~40-45% to YES — the GBM is wrong in BOTH directions near ATM.
    // Require spot to be at least 0.15% above strike before allowing NO bets,
    // so we're only trading ITM positions where price has genuinely moved away.
    if (tentativeSide === 'no') {
      const spotAboveStrikePct = (spot - m.floorStrike) / spot;
      if (spotAboveStrikePct < 0.0015) {
        log.debug({ ticker: m.ticker, spotAboveStrikePct: spotAboveStrikePct.toFixed(4) },
          'SKIP: NO bet too near-money (spot < 0.15% above strike; near-ATM NO bets have no edge)');
        return;
      }
    }
    // ===================================================================

    // Floor: 4pp normally (was 3pp), 2.5pp in aggressive paper test mode
    const minDivFloor = isAggressive() ? 0.025 : 0.04;
    if (minDiv < minDivFloor) minDiv = minDivFloor;
    if (absDiv < minDiv) return;
    if (absDiv > MAX_REASONABLE_DIVERGENCE) return; // model broken safeguard

    // ============ NO-BET CAP (v2 narrowed May 23 2026) ============
    // Original (May 22) cap: any NO bet with absDiv > 10pp blocked.
    // That was overly broad — blocked all NO bets even at ATM where the
    // model performs well. The original concern was specifically DEEP-ITM
    // (market >$0.85 YES = $0.15 NO): GBM systematically underestimates
    // jump risk on contracts deep in the money.
    //
    // v2 narrows the cap to deep-ITM only: when marketMid > 0.80 (= we'd
    // buy NO at <$0.20). Outside that band, allow up to MAX_REASONABLE_DIVERGENCE (12pp).
    // Env override: CRYPTO_NO_HARD_CAP=true restores the broad 10pp cap.
    if (tentativeSide === 'no') {
      const broadCap = process.env.CRYPTO_NO_HARD_CAP === 'true';
      if (broadCap && absDiv > 0.10) {
        log.debug({ ticker: m.ticker, absDiv: absDiv.toFixed(3) },
          'SKIP: NO bet >10pp — env CRYPTO_NO_HARD_CAP forced');
        return;
      }
      // Narrow deep-ITM block: only block at market > $0.80
      if (marketMid > 0.80 && absDiv > 0.10) {
        log.info({ ticker: m.ticker, absDiv: absDiv.toFixed(3), marketMid: marketMid.toFixed(3) },
          'SKIP: NO bet on deep-ITM (market>$0.80) with >10pp divergence — jump-risk premium territory');
        return;
      }
    }
    // =====================================================================

    this.heartbeatStats.opportunitiesSeen++;

    const risk = getRiskEngine();
    // MAKER ORDER STRATEGY (research-backed):
    // Post at the BEST BID to capture the maker rebate. BUT: empirical data
    // (May 2026 audit) showed BTC fill rate 100%, ETH only 33% — ETH maker
    // orders time out 2/3 of the time because the book is thinner and other
    // makers don't lift our bid. Fix: for ETH/SOL/XRP/DOGE, post 1 cent INSIDE
    // the spread (bestBid + 0.01) so we're at the front of the queue. Costs
    // ~1c per trade but converts timeouts → fills. BTC keeps pure maker bid.
    let side: 'yes' | 'no';
    let entryPrice: number;
    const thinBookAsset = m.underlying !== 'BTC';
    const insideSpreadTick = thinBookAsset ? 0.01 : 0;
    // v3.3 (wide-spread fill fix): when bid-ask spread is wider than 5¢, post HALFWAY
    // between the bid and our model's fair price (which we know is above the bid).
    // This catches fills in markets like KXETHD where the spread is 35¢ wide and
    // best-bid+1¢ is too far from fair to ever fill. Caps so we never cross spread.
    const yesSpread = (m.yesAsk ?? 1) - (m.yesBid ?? 0);
    const isWideSpread = yesSpread > 0.05;

    if (divergence > 0) {
      side = 'yes';
      const fairBid = isWideSpread
        ? Math.min(modelProb - 0.02, (m.yesBid ?? 0) + yesSpread / 2)  // halfway between bid and fair, capped to keep edge
        : (m.yesBid ?? 0) + insideSpreadTick;
      entryPrice = Math.min(
        fairBid,
        (m.yesAsk ?? 0.99) - 0.01,  // never cross the spread
      );
      entryPrice = Math.max(entryPrice, (m.yesBid ?? 0) + 0.01);  // never under-bid the book
    } else {
      side = 'no';
      const noBidEff = m.noBid ?? (1 - (m.yesAsk ?? 1));
      const noAskEff = m.noAsk ?? (1 - (m.yesBid ?? 0));
      const noSpread = noAskEff - noBidEff;
      const isWideNoSpread = noSpread > 0.05;
      const fairBid = isWideNoSpread
        ? Math.min((1 - modelProb) - 0.02, noBidEff + noSpread / 2)
        : noBidEff + insideSpreadTick;
      entryPrice = Math.min(
        fairBid,
        noAskEff - 0.01,
      );
      entryPrice = Math.max(entryPrice, noBidEff + 0.01);
    }
    if (entryPrice <= 0.01 || entryPrice >= 0.99) return;
    // Sanity: divergence must still hold AT the bid we're posting at
    // (recompute since we're not crossing the spread anymore)
    const sideForCheck = side === 'yes' ? marketMid : 1 - marketMid;
    const ourEdge = side === 'yes'
      ? modelProb - entryPrice  // we want yes_prob > yes_bid
      : (1 - modelProb) - entryPrice;  // we want no_prob > no_bid
    if (ourEdge < minDiv) return;  // edge gone after no-cross

    // 2026-05-23 v2 (kalshi_crypto_model_v2.pplx.md): PRICE BAND $0.25–$0.80.
    // Below $0.25: GWU 46k-contract study — longshot-favorite bias devastating, fee/stake
    //   ratio at $0.25 is 1.31% maker (workable) vs catastrophic at $0.15 (5.25% taker).
    // Above $0.80: payout asymmetry too steep, maker structural edge collapses on favorites.
    // Sweet spot: $0.40–$0.65 — fee math is most favorable + maximum genuine uncertainty.
    // This widens v174 ($0.50–$0.88) to capture more maker fills while staying safe.
    if (entryPrice < 0.25) {
      log.debug({ ticker: m.ticker, price: entryPrice, side }, 'skipped: price below $0.25 (longshot bias zone)');
      return;
    }
    if (entryPrice > 0.80) {
      log.debug({ ticker: m.ticker, price: entryPrice, side }, 'skipped: price above $0.80 (favorite payout asymmetry)');
      return;
    }

    const kellyFracFull = risk.kellySize(modelProb, marketMid, side.toUpperCase() as 'YES' | 'NO');
    if (kellyFracFull < 0.001) return;
    // 2026-05-23 v2 (kalshi_crypto_model_v2.pplx.md): Kelly cut 0.15 → 0.075.
    // Rationale (Nick Yoder Kelly analysis + Navnoor Bawa prediction market guide):
    //   • 7.5% Kelly retains ~15% of max growth with ~1/180 the variance
    //   • Full Kelly assumes perfectly calibrated model — we have ZERO live wins
    //   • Bump back to 0.15 only after 200+ trades show positive WR > 52%
    //   • At $1,012 bankroll with 10pp edge at P=0.45, this caps bet at $13.80
    const kellyFrac = kellyFracFull * 0.075;
    // Apply adaptive multiplier (shrinks during losing streaks, full size when winning)
    const adaptiveMult = getAdaptiveController().get().kellyMultiplier;
    let sizeUsd = kellyFrac * adaptiveMult * risk.getStats().bankroll;

    // 2026-05-23 v3 (strategy_v3_optimization.pplx.md): MAX_TRADE $15 → $12.
    // Rationale: zero validated trades under new v3 model parameters. Bring back
    // to $15 after 20 winning trades. Earlier rationale (Kalshi BTC hourly depth
    // ~$28) still applies — we stay well under visible book depth.
    let dynamicCap = 12;
    if (side === 'no') {
      const absDivLocal = Math.abs(divergence);
      const isCalls = m.strikeType === 'greater';
      const spotDistancePct = isCalls && m.floorStrike != null
        ? (spot - m.floorStrike) / m.floorStrike
        : 0;
      // v3 conviction tiers also reduced: $25 → $18, $20 → $15
      if (absDivLocal >= 0.12 && spotDistancePct >= 0.0040) {
        dynamicCap = 18;
      } else if (absDivLocal >= 0.08 && spotDistancePct >= 0.0025) {
        dynamicCap = 15;
      }
    }
    const maxPerTrade = Math.min(dynamicCap, 0.08 * risk.getStats().bankroll);
    if (sizeUsd > maxPerTrade) sizeUsd = maxPerTrade;
    // Option A (May 2026): Hard cap REMOVED — trusting deep research's 8% pct cap.
    // Env override available if needed: LIVE_HARD_CAP_USD>0 enables; 0/unset disables.
    const liveHardCap = parseFloat(process.env.LIVE_HARD_CAP_USD ?? '0');
    if (liveHardCap > 0 && sizeUsd > liveHardCap) sizeUsd = liveHardCap;

    // NOTE: Kalshi marks all crypto markets as `fractional_trading_enabled=true`,
    // but unlike CPI N/A contracts these ARE liquidatable - they have deep open interest
    // and resolve in <1hr so we don't need to exit early. Override fractional flag.
    const check = risk.canTrade('kalshi_hourly_crypto', m.ticker, sizeUsd, {
      closesAt: new Date(m.closesAtMs),
      eventTicker: m.eventTicker,
      fractional: false,  // crypto fractional is safe - short-dated, deep OI
      liquidityUsd: Math.max(m.liquidityUsd ?? 0, 50),  // crypto liquidity_dollars often reports 0 even when OI is huge
    });
    if (!check.allowed) return;

    const sizeContracts = Math.floor(check.sizeUsd / entryPrice);
    if (sizeContracts < 5) return; // too small to bother

    // Rate limit + dedup
    const now2 = Date.now();
    if (now2 - this.lastFireAt < this.MIN_TIME_BETWEEN_FIRES_MS) return;
    if (m.lastOrderAt && now2 - m.lastOrderAt < this.MIN_TIME_PER_TICKER_MS) return;

    // ============ ATOMIC RACE-FREE LOCK (May 2026 stacking fix) ============
    // PRIOR BUG: async DB/position checks let 4 fires race past the lock in 600ms.
    // FIX: Claim the lock SYNCHRONOUSLY before any await. Node.js is single-threaded,
    // so synchronous code is atomic. Once we set firedEvents, no other in-flight
    // evaluation of any other ticker in this event can pass the check.
    const existingLock = this.firedEvents.get(m.eventTicker);
    if (existingLock) {
      log.debug({ event: m.eventTicker, ticker: m.ticker, lastFireAgo: now2 - existingLock }, 'blocked: event already fired this session');
      return;
    }
    // CLAIM the lock atomically NOW (synchronously, before any await)
    this.firedEvents.set(m.eventTicker, now2);
    this.lastFireAt = now2;
    m.lastOrderAt = now2;
    m.lastOrderSide = side;
    this.inFlight.add(m.ticker);

    // ============ ASYNC VALIDATION (after lock is claimed) ============
    // If any of these checks fail, we RELEASE the lock so a different ticker on
    // the same event could try later. But during the await, no other fire can race in.
    let releaseLock = () => {
      this.firedEvents.delete(m.eventTicker);
      this.inFlight.delete(m.ticker);
    };

    // DB check (DEFENSE-IN-DEPTH #1)
    try {
      const recent = await getRecentCryptoFiresByEvent(6);
      if (recent.has(m.eventTicker) && recent.get(m.eventTicker)! < now2 - 1000) {
        // Only block if the DB row is OLDER than our claim by >1s (avoids self-block from our own pending insert)
        log.warn({ event: m.eventTicker, ticker: m.ticker }, 'BLOCKED by DB lock (older order found)');
        releaseLock();
        // Re-set with the DB time so it stays locked
        this.firedEvents.set(m.eventTicker, recent.get(m.eventTicker)!);
        return;
      }
    } catch (e: any) {
      log.warn({ err: e.message, event: m.eventTicker }, 'DB check failed — keeping lock, NOT firing');
      // Lock stays claimed; releasing would create the same race
      this.firedEvents.set(m.eventTicker, now2);
      this.inFlight.delete(m.ticker);
      return;
    }

    // Kalshi positions pre-flight (DEFENSE-IN-DEPTH #2)
    if (getTradingMode() === 'live') {
      try {
        const positions = await this.getCachedPositions();
        const eventPrefix = m.eventTicker;
        const conflicting = positions.find((p: any) => {
          const t = p.ticker || '';
          return t.startsWith(eventPrefix) && (p.position !== 0 || (p.market_exposure || 0) > 0);
        });
        if (conflicting) {
          log.warn({
            event: m.eventTicker, conflictTicker: conflicting.ticker,
            position: conflicting.position, exposure: conflicting.market_exposure,
          }, 'BLOCKED by Kalshi-position pre-flight');
          // Keep lock so we don't try again
          this.firedEvents.set(m.eventTicker, Date.now());
          this.inFlight.delete(m.ticker);
          return;
        }
      } catch (e: any) {
        log.warn({ err: e.message, event: m.eventTicker }, 'Kalshi position check failed — keeping lock, NOT firing');
        this.firedEvents.set(m.eventTicker, now2);
        this.inFlight.delete(m.ticker);
        return;
      }
    }

    this.invalidatePositionCache();  // force fresh positions on next fire-attempt

    // Ensure market exists in DB for FK-valid recordSignal/recordOrder
    if (!m.marketDbId) {
      try {
        const id = await upsertMarket({
          platform: 'kalshi',
          external_id: m.ticker,
          question: m.title || `${m.underlying} ${m.strikeType} ${m.floorStrike}${m.capStrike ? '/' + m.capStrike : ''}`,
          category: 'crypto',
          outcome: side === 'yes' ? 'YES' : 'NO',
          closes_at: new Date(m.closesAtMs),
        });
        if (id) m.marketDbId = id;
      } catch (e: any) {
        log.debug({ err: e.message }, 'upsertMarket failed (non-fatal)');
      }
    }

    let signalId: string | null = null;
    try {
      signalId = await recordSignal({
        strategy: 'kalshi_hourly_crypto',
        market_id: m.marketDbId,
        mode: getConfig().TRADING_MODE,
        reason: 'crypto-divergence',
        side: side === 'yes' ? 'YES' : 'NO',
        model_prob: modelProb,
        market_prob: marketMid,
        edge_bps: Math.round(divergence * 10000),
        recommended_size_usd: check.sizeUsd,
        acted: true,
        payload: {
          ticker: m.ticker,
          underlying: m.underlying, spot, sigma: hist.realizedVol,
          ttSec: Math.round(ttSec), strikeType: m.strikeType,
          floor: m.floorStrike, cap: m.capStrike,
          yesBid: m.yesBid, yesAsk: m.yesAsk, noAsk: m.noAsk,
        },
      });
    } catch (err: any) {
      log.warn({ err: err.message }, 'recordSignal failed - continuing to placeOrder anyway');
    }

    log.info({
      ticker: m.ticker, underlying: m.underlying, spot, sigma: hist.realizedVol,
      ttMin: (ttSec / 60).toFixed(1), modelProb: modelProb.toFixed(3),
      marketMid: marketMid.toFixed(3), divergence: divergence.toFixed(3),
      side, sizeContracts, entryPrice, signalId,
    }, 'Kalshi hourly crypto signal');

    // 2026-05-23: REMOVED blanket YES block. It was killing half of all valid
    // signals — the model emits 'yes' when divergence > 0 (model thinks price
    // will hit strike) and 'no' when it won't. Blocking ALL YES means the bot
    // only ever acts on 'price won't hit' signals, which is half the market.
    // The longshot-YES filter at line 1028 (price <= 0.10) still protects
    // against the favorite-longshot bias trap.

    try {
      const result = await this.kalshi.placeOrder({
        platform: 'kalshi',
        externalId: m.ticker,
        outcome: side === 'yes' ? 'YES' : 'NO',
        side: 'BUY',
        orderType: 'limit',
        price: entryPrice,
        size: sizeContracts,
        clientOrderIdPrefix: 'crypto',
      } as any);

      const filled = result.filled ?? 0;
      const orderOk = result.ok && filled > 0;

      // Feed circuit-breaker tracker (every attempt, success or fail)
      risk.recordOrderAttempt(m.eventTicker, orderOk);

      // Record order regardless (filled or not) for visibility
      // CRITICAL: for maker orders that posted but haven't filled yet, status should be 'open'
      // (NOT 'rejected') so reconciler can update it later when Kalshi reports fill.
      let recordedDbOrderId: string | null = null;
      if (m.marketDbId) {
        let initialStatus: 'filled' | 'partial' | 'open' | 'rejected';
        if (!result.ok) initialStatus = 'rejected';
        else if (filled >= sizeContracts) initialStatus = 'filled';
        else if (filled > 0) initialStatus = 'partial';
        else initialStatus = 'open';  // maker order resting on book
        try {
          recordedDbOrderId = await recordOrder({
            signal_id: signalId ?? undefined,
            market_id: m.marketDbId,
            strategy: 'kalshi_hourly_crypto',
            mode: getConfig().TRADING_MODE,
            side: 'BUY',
            order_type: 'LIMIT',
            price: entryPrice,
            size: sizeContracts,
            filled_size: filled,
            outcome: side === 'yes' ? 'YES' : 'NO',
            external_order_id: result.externalOrderId,
            status: initialStatus,
          });
        } catch (e: any) {
          log.warn({ err: e.message }, 'recordOrder failed');
        }
      }

      // ALWAYS ping Discord on every attempt — wrapped in try/catch.
      // Distinguish 3 outcomes:
      //   FILLED       — result.ok && filled>0  (best case)
      //   POSTED       — result.ok && filled==0 (maker order resting; will fill or 60s timeout)
      //   REJECTED     — result.ok==false (Kalshi actually said no)
      let statusEmoji: string;
      let level: 'info' | 'warn' | 'error';
      // Detect transient network/timeout errors and label them differently
      // so they don't look like a real strategy/Kalshi rejection.
      const errMsg = (result.error || '').toString().toLowerCase();
      const isTransient =
        errMsg.includes('timeout') ||
        errMsg.includes('etimedout') ||
        errMsg.includes('econnreset') ||
        errMsg.includes('socket hang up') ||
        errMsg.includes('network');
      if (result.ok && filled > 0) {
        statusEmoji = '🟢 FILLED';
        level = 'info';
      } else if (result.ok) {
        statusEmoji = '📥 POSTED (waiting)';
        level = 'info';
      } else if (isTransient) {
        statusEmoji = '⚠️ NETWORK BLIP (no order placed)';
        level = 'warn';
      } else {
        statusEmoji = '🔴 REJECTED';
        level = 'warn';
      }
      const title = `${statusEmoji} ${m.underlying} ${m.strikeType === 'greater' ? '≥' : m.strikeType === 'less' ? '≤' : 'in'} ${m.floorStrike}${m.capStrike ? '/' + m.capStrike : ''}`;
      try {
        await sendDiscord(
          title,
          `<@572590897150296083> ${getConfig().TRADING_MODE.toUpperCase()} · resolves in ${(ttSec/60).toFixed(1)}min`,
          level,
          [
            { name: 'Side', value: side.toUpperCase(), inline: true },
            { name: 'Model', value: modelProb.toFixed(3), inline: true },
            { name: 'Market', value: marketMid.toFixed(3), inline: true },
            { name: 'Edge', value: `${(divergence * 100).toFixed(1)}pp`, inline: true },
            { name: 'Spot', value: spot.toFixed(2), inline: true },
            { name: 'Vol', value: hist.realizedVol.toFixed(2), inline: true },
            { name: 'Size', value: `${sizeContracts} @ $${entryPrice.toFixed(3)} = $${(sizeContracts * entryPrice).toFixed(2)}`, inline: false },
            ...(result.ok ? [{ name: 'Filled', value: `${filled}/${sizeContracts}${filled === 0 ? ' (maker order resting on book)' : ''}`, inline: true }] : [{ name: 'Error', value: result.error || 'unknown', inline: false }]),
          ]
        );
      } catch (e: any) {
        log.warn({ err: e.message }, 'Discord ping failed');
      }

      if (result.ok && result.externalOrderId) {
        const filled = result.filled ?? 0;
        // If immediately filled (paper mode or our bid happened to be the best ask),
        // record as a regular fill. Otherwise track as resting.
        if (filled > 0) {
          this.heartbeatStats.fires++;
          risk.recordDeployment('kalshi_hourly_crypto', m.ticker, filled * entryPrice);
          this.pendingTrades.push({
            ticker: m.ticker,
            underlying: m.underlying,
            side,
            size: filled,
            entryPrice,
            resolveAtMs: m.resolveAtMs,
            modelProb,
            marketProb: marketMid,
            realizedVol: hist.realizedVol,
            graded: false,
          });

          // ACTIVE POSITION MANAGEMENT (research-backed, May 22 2026):
          // Immediately post BOTH:
          //   1) TAKE-PROFIT at 70% of max gain  (locks in wins when mark rises fast)
          //   2) STOP-LOSS at -25% of entry      (caps losses when mark drops fast)
          // Whichever fills first wins; the other can be canceled by the reconciler
          // when settlement approaches. Both posted as half-size each so we don't
          // double-sell. The leftover 50% rides to settlement (or also exits if SL/TP hit).
          // Source: research/path_to_profit.pplx.md Section F1+F2.
          // 2026-05-23 v2 (kalshi_crypto_model_v2.pplx.md): TP DISABLED by default.
          // Research finding: TP at 70% forces a TAKER exit, paying maker entry fee + taker
          // exit fee = effectively double-fees. Kalshi settles binary at $1 or $0 with NO
          // settlement fee — holding to settle is the lowest-fee path. Only exit early
          // on dramatic model reversal (>15pp swing) or black-swan moves — not at fixed %.
          // Override: CRYPTO_TP_ENABLED=true to restore old behavior.
          const TP_ENABLED = process.env.CRYPTO_TP_ENABLED === 'true';  // off by default
          if (TP_ENABLED && getTradingMode() === 'live' && filled >= 10) {
            const TP_FRACTION = 0.70;
            // SL also disabled (was bleeding from orderbook noise per prior research).
            const SL_ENABLED = process.env.CRYPTO_SL_ENABLED === 'true'; // off by default
            const SL_FRACTION = 0.25;
            const tpPrice = Math.min(0.97, Math.max(entryPrice + 0.02, entryPrice + (1 - entryPrice) * TP_FRACTION));
            const slPrice = Math.max(0.03, entryPrice * (1 - SL_FRACTION));
            const halfSize = Math.max(5, Math.floor(filled / 2));
            const outcome = side === 'yes' ? 'YES' : 'NO';
            let tpOk = false, slOk = false;
            let tpOrderId: string | undefined, slOrderId: string | undefined;

            try {
              const tpResult = await this.kalshi.placeOrder({
                externalId: m.ticker, outcome, side: 'SELL', size: halfSize,
                price: tpPrice, orderType: 'LIMIT',
                clientOrderIdPrefix: 'crypto-tp',
              } as any);
              if (tpResult.ok) {
                tpOk = true;
                tpOrderId = tpResult.externalOrderId;
                log.info({ ticker: m.ticker, entryPrice, tpPrice, size: halfSize, tpOrderId }, '💰 TAKE-PROFIT posted');
                // CRIT-1 fix: persist exit order to DB so reconciler can update + grading is accurate
                if (m.marketDbId) {
                  try {
                    await recordOrder({
                      market_id: m.marketDbId, strategy: 'kalshi_hourly_crypto', mode: 'live',
                      side: 'SELL', order_type: 'LIMIT', price: tpPrice, size: halfSize,
                      filled_size: 0, outcome, external_order_id: tpOrderId, status: 'open',
                    });
                  } catch {}
                }
              } else {
                log.warn({ ticker: m.ticker, err: tpResult.error }, 'TP post failed');
              }
            } catch (e: any) {
              log.warn({ ticker: m.ticker, err: e.message }, 'TP post exception');
            }

            try {
              if (!SL_ENABLED) {
                log.debug({ ticker: m.ticker }, 'SL skipped — disabled (CRYPTO_SL_ENABLED=false)');
                slOk = false;
              } else {
              const slResult = await this.kalshi.placeOrder({
                externalId: m.ticker, outcome, side: 'SELL', size: halfSize,
                price: slPrice, orderType: 'LIMIT',
                clientOrderIdPrefix: 'crypto-sl',
              } as any);
              if (slResult.ok) {
                slOk = true;
                slOrderId = slResult.externalOrderId;
                log.info({ ticker: m.ticker, entryPrice, slPrice, size: halfSize, slOrderId }, '🛡️ STOP-LOSS posted');
                if (m.marketDbId) {
                  try {
                    await recordOrder({
                      market_id: m.marketDbId, strategy: 'kalshi_hourly_crypto', mode: 'live',
                      side: 'SELL', order_type: 'LIMIT', price: slPrice, size: halfSize,
                      filled_size: 0, outcome, external_order_id: slOrderId, status: 'open',
                    });
                  } catch {}
                }
              } else {
                log.warn({ ticker: m.ticker, err: slResult.error }, 'SL post failed');
              }
              }  // close else (SL_ENABLED)
            } catch (e: any) {
              log.warn({ ticker: m.ticker, err: e.message }, 'SL post exception');
            }

            // CRIT-2 / H-1 / H-2 fix: handle both single-sided exit failures.
            // 2026-05-23: when SL_ENABLED=false this branch should NOT cancel TP.
            // Skipping SL is intentional, not a failure.
            if (tpOk && !slOk && SL_ENABLED) {
              // SL post failed → position would have TP only (no downside protection).
              // Cancel the TP so the position is fully unhedged and obvious in monitoring.
              log.error({ ticker: m.ticker, tpOrderId }, 'SL failed but TP posted — canceling TP to avoid naked downside');
              let cancelOk = false;
              if (tpOrderId) {
                try { cancelOk = await this.kalshi.cancelOrder(tpOrderId); } catch { cancelOk = false; }
              }
              try {
                await sendDiscord(
                  '⚠️ Naked position alert (SL failed)',
                  `<@572590897150296083> Crypto entry filled on ${m.ticker} but SL post FAILED. TP cancel: ${cancelOk ? 'OK' : `FAILED — manually cancel ${tpOrderId ?? '<no id>'}`}. Position has NO stop-loss protection until next reconcile cycle.`,
                  'warn', [],
                );
              } catch {}
            } else if (!tpOk && slOk) {
              // TP post failed → position has SL only (no upside exit). Cancel SL so monitoring
              // notices the missing exit pair, then alert. Choosing to cancel matches the symmetric
              // case above (treat partial exit as worse than no exit).
              log.error({ ticker: m.ticker, slOrderId }, 'TP failed but SL posted — canceling SL to avoid uncapped upside');
              let cancelOk = false;
              if (slOrderId) {
                try { cancelOk = await this.kalshi.cancelOrder(slOrderId); } catch { cancelOk = false; }
              }
              try {
                await sendDiscord(
                  '⚠️ Naked position alert (TP failed)',
                  `<@572590897150296083> Crypto entry filled on ${m.ticker} but TP post FAILED. SL cancel: ${cancelOk ? 'OK' : `FAILED — manually cancel ${slOrderId ?? '<no id>'}`}. Position has NO take-profit exit until next reconcile cycle.`,
                  'warn', [],
                );
              } catch {}
            } else if (tpOk && slOk) {
              // H-4: both exits posted — track them in restingOrders so the reconciler can
              // (a) update DB rows on fill, (b) cancel the sibling exit when one side fills.
              if (tpOrderId && slOrderId) {
                this.restingOrders.set(tpOrderId, {
                  orderId: tpOrderId,
                  postedAt: Date.now(),
                  ticker: m.ticker,
                  side,
                  size: halfSize,
                  entryPrice: tpPrice,
                  eventTicker: m.eventTicker,
                  marketDbId: m.marketDbId,
                  kind: 'tp',
                  siblingExitId: slOrderId,
                });
                this.restingOrders.set(slOrderId, {
                  orderId: slOrderId,
                  postedAt: Date.now(),
                  ticker: m.ticker,
                  side,
                  size: halfSize,
                  entryPrice: slPrice,
                  eventTicker: m.eventTicker,
                  marketDbId: m.marketDbId,
                  kind: 'sl',
                  siblingExitId: tpOrderId,
                });
              }
            }
          }
        }
        // Track as resting if not fully filled (maker order waiting)
        if (filled < sizeContracts && getTradingMode() === 'live') {
          this.restingOrders.set(result.externalOrderId, {
            orderId: result.externalOrderId,
            postedAt: Date.now(),
            ticker: m.ticker,
            side,
            size: sizeContracts - filled,
            entryPrice,
            eventTicker: m.eventTicker,
            marketDbId: m.marketDbId,
            dbOrderId: recordedDbOrderId ?? undefined,
            // C-4 fix: if immediate-fill TP/SL was just posted, don't re-post on later fill.
            tpSlPosted: filled >= 10,
          });
        }
      }
    } catch (err: any) {
      log.error({ err: err.message, ticker: m.ticker }, 'Kalshi hourly crypto order error');
    } finally {
      // Keep inFlight lock longer to suppress rapid re-eval
      setTimeout(() => this.inFlight.delete(m.ticker), 10_000);
    }
  }

  /** Cancel stale maker orders + sync fills from open-orders endpoint. */
  private async reconcileRestingOrders(): Promise<void> {
    if (this.restingOrders.size === 0) return;
    if (getConfig().TRADING_MODE !== 'live') {
      // Paper mode: don't track resting (paper fills instantly)
      this.restingOrders.clear();
      return;
    }
    const now = Date.now();
    // Get current open orders from Kalshi
    let openByOrderId = new Map<string, any>();
    try {
      const open = await this.kalshi.getOpenOrders();
      for (const o of (open as any[])) {
        if (o?.order_id) openByOrderId.set(o.order_id, o);
      }
    } catch (e: any) {
      log.warn({ err: e.message }, 'getOpenOrders failed during reconcile');
      return;
    }
    for (const [orderId, r] of [...this.restingOrders.entries()]) {
      const stillOpen = openByOrderId.get(orderId);
      if (!stillOpen) {
        // Order no longer open — lookup actual status from Kalshi to know if filled or canceled
        log.info({ orderId, ticker: r.ticker }, 'maker order no longer in open list — fetching final status');
        this.restingOrders.delete(orderId);
        let actuallyFilled = 0;
        let avgFillPrice: number | undefined;
        try {
          const o: any = await this.kalshi.getOrder(orderId);
          if (o) {
            // CRITICAL FIX (May 2026): Kalshi v2 order shape uses fill_count_fp / remaining_count_fp,
            // NOT yes_filled/no_filled. Previous code returned 0 for all fills, marking everything
            // as 'canceled' in DB even when fully executed. This bug hid the ETH NO $2,139.99 fill
            // that was actually +$56 paper profit.
            actuallyFilled = parseFloat(o.fill_count_fp ?? '0') || 0;
            // Avg fill price: maker_fill_cost / fill_count. dollars format.
            const fillCost = parseFloat(o.maker_fill_cost_dollars ?? '0') + parseFloat(o.taker_fill_cost_dollars ?? '0');
            if (actuallyFilled > 0) avgFillPrice = fillCost / actuallyFilled;
            // Sanity check: if status is 'executed' or 'filled', force the count from initial - remaining
            if ((o.status === 'executed' || o.status === 'filled') && actuallyFilled === 0) {
              const initial = parseFloat(o.initial_count_fp ?? '0') || 0;
              const remaining = parseFloat(o.remaining_count_fp ?? '0') || 0;
              actuallyFilled = initial - remaining;
              if (!avgFillPrice) avgFillPrice = r.entryPrice;
            }
          }
        } catch (e: any) {
          log.warn({ err: e.message, orderId }, 'getOrder failed during reconcile');
        }
        const finalStatus: 'filled' | 'partial' | 'canceled' = actuallyFilled >= r.size ? 'filled' : actuallyFilled > 0 ? 'partial' : 'canceled';
        // Update DB row — try by dbOrderId, fall back to external lookup
        let dbId = r.dbOrderId;
        if (!dbId) {
          const found = await findOrderByExternalId(orderId);
          dbId = found?.id;
        }
        if (dbId) {
          await updateOrder(dbId, {
            status: finalStatus,
            filled_size: actuallyFilled,
            ...(avgFillPrice ? { avg_fill_price: avgFillPrice } : {}),
          });
          log.info({ orderId, dbId, finalStatus, filled: actuallyFilled }, 'DB order row updated post-reconcile');
        }

        // H-4: if this is a TP or SL leg and it filled, cancel the sibling exit so the
        // remaining position isn't double-exited (e.g. TP fills 15, then SL also fires
        // for another 15 → bot goes short by 15). Then short-circuit the entry-only logic
        // below (pendingTrades / recordDeployment / late-fill TP/SL — those only apply to
        // entry orders, not exit orders).
        if ((r.kind === 'tp' || r.kind === 'sl') && actuallyFilled > 0 && r.siblingExitId) {
          log.info({ filled: r.kind, siblingId: r.siblingExitId, ticker: r.ticker }, 'H-4: exit leg filled — canceling sibling');
          try {
            const ok = await this.kalshi.cancelOrder(r.siblingExitId);
            log.info({ siblingId: r.siblingExitId, cancelOk: ok }, 'H-4: sibling exit cancel result');
          } catch (e: any) {
            log.warn({ err: e.message, siblingId: r.siblingExitId }, 'H-4: sibling exit cancel failed');
          }
          this.restingOrders.delete(r.siblingExitId);
          try {
            const emoji = r.kind === 'tp' ? '💰' : '🛡️';
            await sendDiscord(
              `${emoji} ${r.kind.toUpperCase()} FILLED · ${r.ticker}`,
              `<@572590897150296083> ${r.kind.toUpperCase()} leg filled ${actuallyFilled}/${r.size}. Sibling exit canceled.`,
              r.kind === 'tp' ? 'success' : 'warn',
              [
                { name: 'Side', value: r.side.toUpperCase(), inline: true },
                { name: 'Fill Price', value: avgFillPrice ? `$${avgFillPrice.toFixed(3)}` : `$${r.entryPrice.toFixed(3)}`, inline: true },
              ],
            );
          } catch {}
        }
        if (r.kind === 'tp' || r.kind === 'sl') {
          continue; // exit orders don't go through entry-only pendingTrades/late-fill TP/SL logic
        }

        // If filled, add to pendingTrades so adaptive controller learns from outcome
        if (actuallyFilled > 0) {
          const m = this.markets.get(r.ticker);
          if (m) {
            const sym2 = `${m.underlying}USDT`;
            const hist2 = this.priceHistory.get(sym2);
            this.pendingTrades.push({
              ticker: r.ticker,
              underlying: m.underlying,
              side: r.side,
              size: actuallyFilled,
              entryPrice: avgFillPrice ?? r.entryPrice,
              resolveAtMs: m.resolveAtMs,
              modelProb: 0,  // best-effort — we don't have model snapshot here
              marketProb: 0,
              realizedVol: hist2?.realizedVol ?? 0,
              graded: false,
            });
            this.heartbeatStats.fires++;
            getRiskEngine().recordDeployment('kalshi_hourly_crypto', r.ticker, actuallyFilled * (avgFillPrice ?? r.entryPrice));

            // ========== POST TP/SL ON LATE-FILLED MAKER ORDERS (May 22 PM 2026) ==========
            // Bug fix: previously TP/SL only fired on immediate-fill branch. Maker orders
            // that fill AFTER posting (the normal case) had no protective exits.
            // C-4 fix: skip if immediate-fill branch already posted TP/SL (avoid double exit).
            // 2026-05-23 v2 (kalshi_crypto_model_v2.pplx.md): TP DISABLED by default on post-fill path too.
            // Override: CRYPTO_TP_ENABLED=true. See immediate-fill block for full rationale.
            const TP_ENABLED_LATE = process.env.CRYPTO_TP_ENABLED === 'true';
            if (TP_ENABLED_LATE && getTradingMode() === 'live' && actuallyFilled >= 10 && !r.tpSlPosted) {
              const entry = avgFillPrice ?? r.entryPrice;
              const TP_FRACTION = 0.70;
              const SL_ENABLED = process.env.CRYPTO_SL_ENABLED === 'true';
              const SL_FRACTION = 0.25;
              const tpPrice = Math.min(0.97, Math.max(entry + 0.02, entry + (1 - entry) * TP_FRACTION));
              const slPrice = Math.max(0.03, entry * (1 - SL_FRACTION));
              const halfSize = Math.max(5, Math.floor(actuallyFilled / 2));
              const outcome = r.side === 'yes' ? 'YES' : 'NO';
              let tpOkLate = false, slOkLate = false;
              let tpOrderIdLate: string | undefined, slOrderIdLate: string | undefined;
              try {
                const tpResult = await this.kalshi.placeOrder({
                  externalId: r.ticker, outcome, side: 'SELL', size: halfSize,
                  price: tpPrice, orderType: 'LIMIT',
                  // H-3: tag with prefix for reconciliation symmetry with immediate-fill block
                  clientOrderIdPrefix: 'crypto-tp',
                } as any);
                if (tpResult.ok) {
                  tpOkLate = true;
                  tpOrderIdLate = tpResult.externalOrderId;
                  log.info({ ticker: r.ticker, entry, tpPrice, size: halfSize, tpOrderId: tpOrderIdLate }, '💰 TAKE-PROFIT posted (post-fill)');
                  if (r.marketDbId) {
                    try {
                      await recordOrder({
                        market_id: r.marketDbId,
                        strategy: 'kalshi_hourly_crypto',
                        mode: 'live',
                        side: 'SELL',
                        order_type: 'LIMIT',
                        price: tpPrice,
                        size: halfSize,
                        filled_size: 0,
                        outcome,
                        external_order_id: tpOrderIdLate,
                        status: 'open',
                      });
                    } catch {}
                  }
                } else {
                  log.warn({ ticker: r.ticker, err: tpResult.error }, 'TP post failed (post-fill)');
                }
              } catch (e: any) {
                log.warn({ ticker: r.ticker, err: e.message }, 'TP post exception (post-fill)');
              }
              try {
                if (!SL_ENABLED) {
                  log.debug({ ticker: r.ticker }, 'SL skipped (post-fill) — disabled');
                  slOkLate = false;
                } else {
                const slResult = await this.kalshi.placeOrder({
                  externalId: r.ticker, outcome, side: 'SELL', size: halfSize,
                  price: slPrice, orderType: 'LIMIT',
                  // H-3: tag with prefix for reconciliation symmetry with immediate-fill block
                  clientOrderIdPrefix: 'crypto-sl',
                } as any);
                if (slResult.ok) {
                  slOkLate = true;
                  slOrderIdLate = slResult.externalOrderId;
                  log.info({ ticker: r.ticker, entry, slPrice, size: halfSize, slOrderId: slOrderIdLate }, '🛡️ STOP-LOSS posted (post-fill)');
                  if (r.marketDbId) {
                    try {
                      await recordOrder({
                        market_id: r.marketDbId,
                        strategy: 'kalshi_hourly_crypto',
                        mode: 'live',
                        side: 'SELL',
                        order_type: 'LIMIT',
                        price: slPrice,
                        size: halfSize,
                        filled_size: 0,
                        outcome,
                        external_order_id: slOrderIdLate,
                        status: 'open',
                      });
                    } catch {}
                  }
                } else {
                  log.warn({ ticker: r.ticker, err: slResult.error }, 'SL post failed (post-fill)');
                }
                }  // close else (SL_ENABLED)
              } catch (e: any) {
                log.warn({ ticker: r.ticker, err: e.message }, 'SL post exception (post-fill)');
              }

              // H-1 / H-2 / H-4: handle single-sided exit failures + track both sides for reconciliation.
              // 2026-05-23: gated on SL_ENABLED so disabled-SL doesn't trigger naked-position alert.
              if (tpOkLate && !slOkLate && SL_ENABLED) {
                log.error({ ticker: r.ticker, tpOrderId: tpOrderIdLate }, 'SL failed but TP posted (post-fill) — canceling TP');
                let cancelOk = false;
                if (tpOrderIdLate) {
                  try { cancelOk = await this.kalshi.cancelOrder(tpOrderIdLate); } catch { cancelOk = false; }
                }
                try {
                  await sendDiscord(
                    '⚠️ Naked position alert (post-fill, SL failed)',
                    `<@572590897150296083> Late-fill on ${r.ticker} but SL post FAILED. TP cancel: ${cancelOk ? 'OK' : `FAILED — manually cancel ${tpOrderIdLate ?? '<no id>'}`}. Position has NO stop-loss protection.`,
                    'warn', [],
                  );
                } catch {}
              } else if (!tpOkLate && slOkLate) {
                log.error({ ticker: r.ticker, slOrderId: slOrderIdLate }, 'TP failed but SL posted (post-fill) — canceling SL');
                let cancelOk = false;
                if (slOrderIdLate) {
                  try { cancelOk = await this.kalshi.cancelOrder(slOrderIdLate); } catch { cancelOk = false; }
                }
                try {
                  await sendDiscord(
                    '⚠️ Naked position alert (post-fill, TP failed)',
                    `<@572590897150296083> Late-fill on ${r.ticker} but TP post FAILED. SL cancel: ${cancelOk ? 'OK' : `FAILED — manually cancel ${slOrderIdLate ?? '<no id>'}`}. Position has NO take-profit exit.`,
                    'warn', [],
                  );
                } catch {}
              } else if (tpOkLate && slOkLate) {
                if (tpOrderIdLate && slOrderIdLate) {
                  this.restingOrders.set(tpOrderIdLate, {
                    orderId: tpOrderIdLate,
                    postedAt: Date.now(),
                    ticker: r.ticker,
                    side: r.side,
                    size: halfSize,
                    entryPrice: tpPrice,
                    eventTicker: r.eventTicker,
                    marketDbId: r.marketDbId,
                    kind: 'tp',
                    siblingExitId: slOrderIdLate,
                  });
                  this.restingOrders.set(slOrderIdLate, {
                    orderId: slOrderIdLate,
                    postedAt: Date.now(),
                    ticker: r.ticker,
                    side: r.side,
                    size: halfSize,
                    entryPrice: slPrice,
                    eventTicker: r.eventTicker,
                    marketDbId: r.marketDbId,
                    kind: 'sl',
                    siblingExitId: tpOrderIdLate,
                  });
                }
              }
            }
          }
        }

        // Ping Discord with HONEST status
        try {
          const emoji = finalStatus === 'filled' ? '✅' : finalStatus === 'partial' ? '🟡' : '⚫';
          await sendDiscord(
            `${emoji} ${finalStatus.toUpperCase()} · ${r.ticker}`,
            `<@572590897150296083> Maker order ${finalStatus} on Kalshi. Filled: ${actuallyFilled}/${r.size}`,
            'info',
            [
              { name: 'Posted Price', value: `$${r.entryPrice.toFixed(3)}`, inline: true },
              { name: 'Filled Size', value: `${actuallyFilled}/${r.size}`, inline: true },
              { name: 'Side', value: r.side.toUpperCase(), inline: true },
              ...(avgFillPrice ? [{ name: 'Avg Fill', value: `$${avgFillPrice.toFixed(3)}`, inline: true }] : []),
            ]
          );
        } catch {}
        continue;
      }
      // Still open — check age. Cancel if too old.
      const age = now - r.postedAt;
      if (age > this.MAKER_TIMEOUT_MS) {
        log.info({ orderId, ticker: r.ticker, ageMs: age }, 'maker order timeout, canceling');
        try {
          await this.kalshi.cancelOrder(orderId);
        } catch (e: any) {
          log.warn({ err: e.message, orderId }, 'cancel failed');
        }
        this.restingOrders.delete(orderId);
        // CRITICAL BUG FIX (May 2026): DO NOT unlock firedEvents on cancel.
        // The May 20 stacking bug happened because: order 1 fills async on Kalshi side,
        // we attempt cancel (no-op since already filled), then unlock event → order 2
        // fires on same event, stacking exposure. Once we fire on an event, lock it FOREVER
        // for this session. The 6-hour DB hydration also enforces this across deploys.
        // (Previously: this.firedEvents.delete(r.eventTicker) — REMOVED for safety.)

        // Ping Discord: timeout expired without fill
        try {
          await sendDiscord(
            `⏱️ EXPIRED · ${r.ticker}`,
            `Maker order didn't fill in ${(this.MAKER_TIMEOUT_MS/1000).toFixed(0)}s. Cancelled. Event ·${r.eventTicker}· stays LOCKED.`,
            'info',
            [
              { name: 'Posted Price', value: `$${r.entryPrice.toFixed(3)}`, inline: true },
              { name: 'Size', value: `${r.size}`, inline: true },
              { name: 'Side', value: r.side.toUpperCase(), inline: true },
            ]
          );
        } catch {}
      }
    }
  }

  /** Grade pending trades whose resolution time has passed using current spot prices. */
  private async gradePendingTrades(): Promise<void> {
    const now = Date.now();
    const adaptive = getAdaptiveController();
    const newlyGraded: PendingTrade[] = [];
    for (const t of this.pendingTrades) {
      if (t.graded) continue;
      // Wait 90s after resolveAtMs so Kalshi has time to publish settlement.
      // (Was 30s but Kalshi sometimes takes 60s+ to set market.result.)
      if (now < t.resolveAtMs + 90_000) continue;

      // CRITICAL FIX: Use Kalshi's settlement result as ground truth.
      // Previously: compared our local Coinbase/OKX spot vs strike. But Kalshi
      // crypto markets settle on CME CF Bitcoin Reference Rate (BRR), which
      // diverges from spot by $5-50. Local grading produced false losses that
      // Kalshi recorded as wins — caused dashboard balance to drift ~$50 below
      // true Kalshi balance.
      const kalshiResult = await this.kalshi.getMarketResult(t.ticker);
      let yesWon: boolean | null = null;
      if (kalshiResult === 'yes') yesWon = true;
      else if (kalshiResult === 'no') yesWon = false;
      else {
        // Kalshi hasn't published a result yet — fall back to local approx so we
        // don't block adaptive forever. Mark with a flag so we can re-grade later.
        const sym = `${t.underlying}USDT`;
        const settlementPrice = this.priceFeed.getLatestPrice(sym);
        if (settlementPrice == null) continue;
        const m = this.markets.get(t.ticker);
        if (m) {
          if (m.strikeType === 'greater') yesWon = settlementPrice >= m.floorStrike;
          else if (m.strikeType === 'less') yesWon = settlementPrice < m.floorStrike;
        } else {
          const strikeMatch = t.ticker.match(/-T([\d.]+)/);
          if (strikeMatch) {
            const strike = parseFloat(strikeMatch[1]);
            yesWon = settlementPrice >= strike;
          }
        }
        if (yesWon == null) continue;
        // Only grade with local fallback if we're > 10 min past resolve
        // (Kalshi should have published by then; if not, our local is best-effort)
        if (now < t.resolveAtMs + 10 * 60 * 1000) continue;
        log.warn({ ticker: t.ticker, side: t.side, localApprox: yesWon }, 'Kalshi result missing — using local approx');
      }

      const won = (t.side === 'yes' && yesWon) || (t.side === 'no' && !yesWon);
      const pnl = won ? t.size * (1 - t.entryPrice) : -t.size * t.entryPrice;
      t.graded = true;
      newlyGraded.push(t);

      const tradeResult = {
        ts: now,
        won,
        pnl,
        modelProb: t.modelProb,
        marketProb: t.marketProb,
        realizedVol: t.realizedVol,
      };
      adaptive.recordTrade(tradeResult);

      // CRITICAL: persist trade result to DB so adaptive state survives restarts.
      // Without this, every restart wipes the rolling window → kill switch never trips.
      try {
        await recordSignal({
          strategy: 'kalshi_hourly_crypto',
          reason: 'trade-graded',
          acted: false,
          payload: { ...tradeResult, ticker: t.ticker, side: t.side, mode: getConfig().TRADING_MODE },
        });
      } catch (e: any) {
        log.warn({ err: e.message }, 'failed to persist trade-graded signal');
      }

      // HARD KILL SWITCH: if we've hit a loss pattern, flip to paper mode immediately.
      // This persists because the next restart re-hydrates adaptive from DB.
      const ks = adaptive.shouldKillSwitch();
      if (ks.trip && getConfig().TRADING_MODE === 'live') {
        log.fatal({ reason: ks.reason }, '🚨 KILL SWITCH TRIPPED — strategy is losing, flipping to paper');
        try {
          await sendDiscord(
            '🚨 KILL SWITCH — flipping to paper',
            `<@572590897150296083>\nReason: ${ks.reason}\nBot has been auto-disabled from live trading. Manual review required before re-enabling.`,
            'error',
            []
          );
        } catch {}
        // Force env var so subsequent loop iterations behave as paper.
        // Note: Fly secret isn't changed here (would require token); but in-process
        // config will reflect paper from this point. On next restart, secret still
        // shows 'live' — but adaptive hydrates and trips kill switch again, paper persists.
        process.env.TRADING_MODE = 'paper';
        // H-8 fix: also flip the risk engine kill switch so strategies that gate on
        // canTrade() (not isPaperMode()) also stop firing.
        getRiskEngine().forceKill(`adaptive: ${ks.reason}`);
      }

      // OPTION B: 5-loss auto-kill DISABLED per user override. Trust deep research.
      if (won) {
        this.consecutiveLosses = 0;
      } else {
        this.consecutiveLosses += 1;
      }

      log.info({
        ticker: t.ticker, side: t.side, won, pnl: pnl.toFixed(2),
        modelProb: t.modelProb.toFixed(3), marketProb: t.marketProb.toFixed(3),
        kalshiResult,
        consecutiveLosses: this.consecutiveLosses,
      }, won ? 'TRADE WON' : 'TRADE LOST');
    }
    if (newlyGraded.length > 0) {
      // Send Discord summary
      const wins = newlyGraded.filter(t => t.modelProb > t.marketProb === (t.side === 'yes')).length;
      const totalPnl = newlyGraded.reduce((s, t) => {
        const yesWon = t.modelProb > 0; // placeholder — already used pnl above
        return s;
      }, 0);
      const summary = newlyGraded.map(t => {
        const won = (this.markets.get(t.ticker)?.strikeType === 'greater'
          ? this.priceFeed.getLatestPrice(`${t.underlying}USDT`)! >= this.markets.get(t.ticker)!.floorStrike
          : false) === (t.side === 'yes');
        const pnl = won ? t.size * (1 - t.entryPrice) : -t.size * t.entryPrice;
        return `${won ? '✅' : '❌'} ${t.underlying} ${t.side} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
      }).join('\n');
      try {
        await sendDiscord(
          `📊 Trades resolved (${newlyGraded.length})`,
          `<@572590897150296083>\n${summary}\n\nAdaptive: ${JSON.stringify(adaptive.stats())}`,
          'info',
          []
        );
      } catch {}
    }
    // Drop graded trades older than 1 hour
    this.pendingTrades = this.pendingTrades.filter(t => !t.graded || now - t.resolveAtMs < 3600_000);
  }

  private heartbeat(): void {
    // Touch watchdog FIRST so even if the rest of this function fails,
    // the watchdog knows the loop is alive.
    touchHeartbeat();
    const payload = {
      mode: getConfig().TRADING_MODE,
      tracked: this.markets.size,
      withPrices: [...this.markets.values()].filter(m => m.yesBid != null).length,
      btcSpot: this.priceFeed.getLatestPrice('BTCUSDT'),
      btcVol: this.priceHistory.get('BTCUSDT')?.realizedVol.toFixed(2),
      ethSpot: this.priceFeed.getLatestPrice('ETHUSDT'),
      ethVol: this.priceHistory.get('ETHUSDT')?.realizedVol.toFixed(2),
      opportunitiesSeen: this.heartbeatStats.opportunitiesSeen,
      fires: this.heartbeatStats.fires,
      // v175: WS migration telemetry
      wsSubscribed: this.wsUnsubscribe.size,
      wsUpdates: this.heartbeatStats.wsUpdates,
      restFallbacks: this.heartbeatStats.restRefreshes,
      bestEdge: this.bestDivergenceSeen,
      adaptive: getAdaptiveController().stats(),
      pendingTrades: this.pendingTrades.filter(t => !t.graded).length,
      restingMakerOrders: this.restingOrders.size,
      funding: getFundingSnapshot(),
      timeOfDayPenalty: getTimeOfDayPenalty(),
    };
    log.info(payload, '📊 heartbeat');
    void recordHeartbeat('kalshi_hourly_crypto', getConfig().TRADING_MODE, payload);
    // v175: reset per-cycle WS counters so we see RATE per minute
    this.heartbeatStats.wsUpdates = 0;
    this.heartbeatStats.restRefreshes = 0;
  }
}
