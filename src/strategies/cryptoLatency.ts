/**
 * STRATEGY: Crypto Latency Arbitrage on Polymarket
 *
 * THESIS:
 *   Polymarket runs short-window (15-min, 1-hour, daily) "Will BTC close
 *   above $X at time T?" markets. Bitcoin's true price updates in real-time
 *   on Binance/Coinbase, but Polymarket's market price lags by 2-5 seconds
 *   because most traders are humans clicking buttons. A bot streaming Binance
 *   ticks can compute the implied true probability faster than the market and
 *   pick off stale prices.
 *
 *   Documented case: one wallet turned $300 → $400K in a month doing this on
 *   BTC contracts during a volatile week. Outlier but mechanism is real.
 *
 * MODEL:
 *   For an event "X > Y at time T", under geometric Brownian motion the true
 *   probability is the Black-Scholes-style cumulative normal:
 *
 *     P(S_T > Y) = N( (ln(S_t/Y) + (r - σ²/2)(T-t)) / (σ * sqrt(T-t)) )
 *
 *   In practice for short windows (<= 1 hour), we approximate with a simple
 *   normal distribution model on log-returns, calibrated to recent realized
 *   volatility.
 *
 *   We bet when |model_prob - market_mid| > THRESHOLD.
 */

import { PolymarketConnector } from '../connectors/polymarket.js';
import { PriceFeedAggregator } from '../connectors/priceFeeds.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import type { OrderBook } from '../connectors/types.js';

const log = createStrategyLogger('crypto_latency');

const MIN_PROB_DIVERGENCE = 0.06; // 6 percentage points - quite strict, raises bar
const RECENT_VOL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes of price history

interface CryptoMarket {
  conditionId: string;
  yesToken: string;
  noToken: string;
  question: string;
  underlying: 'BTC' | 'ETH' | 'SOL';
  strike: number;            // price threshold
  direction: 'above' | 'below';
  resolveAt: number;         // ms epoch when this contract settles
  yesBook?: OrderBook;
  noBook?: OrderBook;
}

interface PriceHistory {
  ticks: { price: number; ts: number }[];
  realizedVol: number;
}

export class CryptoLatencyStrategy {
  private markets = new Map<string, CryptoMarket>();
  private priceHistory = new Map<string, PriceHistory>();
  private inFlight = new Set<string>();

  constructor(
    private polymarket: PolymarketConnector,
    private priceFeed: PriceFeedAggregator
  ) {}

  async start(): Promise<void> {
    log.info('Crypto latency strategy starting');
    await this.discoverCryptoMarkets();
    setInterval(() => this.discoverCryptoMarkets(), 5 * 60 * 1000);

    // Subscribe to all underlyings; recompute on every tick
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
      this.priceHistory.set(sym, { ticks: [], realizedVol: 0.02 });
      this.priceFeed.subscribe(sym, (tick) => {
        this.updatePriceHistory(sym, tick.price);
        this.evaluateAll(sym);
      });
    }
  }

  private async discoverCryptoMarkets(): Promise<void> {
    const all = await this.polymarket.listActiveMarkets();
    const cryptoKeywords = ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol'];
    const candidates = all.filter((m) => {
      const q = m.question.toLowerCase();
      return cryptoKeywords.some((k) => q.includes(k)) && m.closesAt;
    });

    for (const m of candidates) {
      if (this.markets.has(m.externalId)) continue;
      const parsed = this.parseCryptoQuestion(m.question);
      if (!parsed) continue;
      if (!m.yes_token || !m.no_token) continue;
      // Only short-dated (within 24h) for latency edge to matter
      const timeToResolve = (m.closesAt?.getTime() ?? 0) - Date.now();
      if (timeToResolve > 24 * 60 * 60 * 1000 || timeToResolve < 30_000) continue;

      const market: CryptoMarket = {
        conditionId: m.externalId,
        yesToken: m.yes_token,
        noToken: m.no_token,
        question: m.question,
        underlying: parsed.underlying,
        strike: parsed.strike,
        direction: parsed.direction,
        resolveAt: m.closesAt!.getTime(),
      };
      this.markets.set(m.externalId, market);
      await this.polymarket.subscribeOrderBook(m.yes_token, (book) => {
        market.yesBook = book;
        this.evaluateMarket(market);
      });
      await this.polymarket.subscribeOrderBook(m.no_token, (book) => {
        market.noBook = book;
        this.evaluateMarket(market);
      });
      log.info({ question: m.question, strike: parsed.strike, direction: parsed.direction }, 'Subscribed crypto market');
    }
  }

  /**
   * Parse questions like:
   *   "Will BTC close above $105,000 at 4pm ET?"
   *   "Bitcoin above 105K on May 20?"
   *
   * Skips question patterns we can't reliably interpret. Notably, the
   * "Crypto Up or Down" hourly markets don't have an absolute price strike
   * (they resolve relative to open), so we exclude them.
   */
  private parseCryptoQuestion(q: string): { underlying: 'BTC' | 'ETH' | 'SOL'; strike: number; direction: 'above' | 'below' } | null {
    const lc = q.toLowerCase();

    // Skip "Up or Down" markets - they resolve relative to interval open price,
    // not an absolute strike, and need a different strategy entirely
    if (/up or down|up\/down|higher or lower/.test(lc)) return null;

    let underlying: 'BTC' | 'ETH' | 'SOL';
    if (lc.includes('bitcoin') || /\bbtc\b/.test(lc)) underlying = 'BTC';
    else if (lc.includes('ethereum') || /\beth\b/.test(lc)) underlying = 'ETH';
    else if (lc.includes('solana') || /\bsol\b/.test(lc)) underlying = 'SOL';
    else return null;

    // Strike: explicit dollar sign OR number with K/M suffix
    // Examples we want to match: $105,000  $200K  $1.2M  105000
    const dollarMatch = q.match(/\$([\d,]+(?:\.\d+)?)\s*([kKmM]?)\b/);
    const kMatch = q.match(/\b(\d[\d,]*(?:\.\d+)?)\s*([kKmM])\b/);
    let strike: number | null = null;
    if (dollarMatch) {
      const base = parseFloat(dollarMatch[1].replace(/,/g, ''));
      const mult = dollarMatch[2].toLowerCase() === 'k' ? 1000 : dollarMatch[2].toLowerCase() === 'm' ? 1_000_000 : 1;
      strike = base * mult;
    } else if (kMatch) {
      const base = parseFloat(kMatch[1].replace(/,/g, ''));
      const mult = kMatch[2].toLowerCase() === 'k' ? 1000 : 1_000_000;
      strike = base * mult;
    }
    if (strike == null) return null;

    // Sanity check by underlying - reject obviously wrong values
    const reasonable = {
      BTC: [10_000, 1_000_000],
      ETH: [500, 20_000],
      SOL: [10, 2000],
    }[underlying];
    if (strike < reasonable[0] || strike > reasonable[1]) return null;

    let direction: 'above' | 'below' = 'above';
    if (/below|under|less than|<\s/.test(lc)) direction = 'below';

    return { underlying, strike, direction };
  }

  private updatePriceHistory(symbol: string, price: number): void {
    const hist = this.priceHistory.get(symbol);
    if (!hist) return;
    const now = Date.now();
    hist.ticks.push({ price, ts: now });
    // Prune
    hist.ticks = hist.ticks.filter((t) => now - t.ts < RECENT_VOL_WINDOW_MS);
    // Recompute realized vol (annualized log-return std)
    if (hist.ticks.length >= 30) {
      const logReturns: number[] = [];
      for (let i = 1; i < hist.ticks.length; i++) {
        const r = Math.log(hist.ticks[i].price / hist.ticks[i - 1].price);
        logReturns.push(r);
      }
      const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
      const stdPerTick = Math.sqrt(variance);
      // Approximate annualization assuming ticks at ~1s
      const yearsPerTick = 1 / (365 * 24 * 60 * 60);
      hist.realizedVol = stdPerTick / Math.sqrt(yearsPerTick);
    }
  }

  private evaluateAll(symbol: string): void {
    const underlying = symbol.replace('USDT', '') as 'BTC' | 'ETH' | 'SOL';
    for (const m of this.markets.values()) {
      if (m.underlying === underlying) this.evaluateMarket(m);
    }
  }

  /**
   * Black-Scholes-style binary digital option pricing:
   *   d2 = (ln(S/K) + (r - σ²/2)T) / (σ√T)
   *   P(S_T > K) = N(d2)
   * We assume r=0 for short windows.
   */
  private binaryProb(spot: number, strike: number, sigma: number, ttSeconds: number, direction: 'above' | 'below'): number {
    if (ttSeconds <= 0) {
      return direction === 'above' ? (spot > strike ? 1 : 0) : (spot < strike ? 1 : 0);
    }
    const T = ttSeconds / (365 * 24 * 60 * 60);
    const d2 = (Math.log(spot / strike) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
    const probAbove = this.cnd(d2);
    return direction === 'above' ? probAbove : 1 - probAbove;
  }

  // Standard cumulative normal distribution (Abramowitz & Stegun)
  private cnd(x: number): number {
    const a1 = 0.31938153;
    const a2 = -0.356563782;
    const a3 = 1.781477937;
    const a4 = -1.821255978;
    const a5 = 1.330274429;
    const L = Math.abs(x);
    const K = 1.0 / (1.0 + 0.2316419 * L);
    let w = 1.0 - (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-L * L / 2) *
      (a1 * K + a2 * K ** 2 + a3 * K ** 3 + a4 * K ** 4 + a5 * K ** 5);
    if (x < 0) w = 1.0 - w;
    return w;
  }

  private async evaluateMarket(market: CryptoMarket): Promise<void> {
    if (this.inFlight.has(market.conditionId)) return;
    if (!market.yesBook?.bestBid || !market.yesBook?.bestAsk) return;

    const spot = this.priceFeed.getLatestPrice(`${market.underlying}USDT`);
    if (!spot) return;

    const hist = this.priceHistory.get(`${market.underlying}USDT`);
    if (!hist || hist.ticks.length < 30) return;

    const ttSeconds = (market.resolveAt - Date.now()) / 1000;
    if (ttSeconds <= 0) return;

    const modelProb = this.binaryProb(spot, market.strike, hist.realizedVol, ttSeconds, market.direction);
    const marketMid = (market.yesBook.bestBid.price + market.yesBook.bestAsk.price) / 2;

    const divergence = modelProb - marketMid;
    if (Math.abs(divergence) < MIN_PROB_DIVERGENCE) return;

    const risk = getRiskEngine();
    let side: 'YES' | 'NO';
    let entryPrice: number;
    let token: string;
    if (divergence > 0) {
      // Model says higher prob - market is too low - BUY YES
      side = 'YES';
      entryPrice = market.yesBook.bestAsk.price;
      token = market.yesToken;
    } else {
      // Model says lower prob - market is too high - BUY NO
      side = 'NO';
      entryPrice = market.noBook?.bestAsk?.price ?? 1 - market.yesBook.bestBid.price;
      token = market.noToken;
    }

    const kellyFrac = risk.kellySize(modelProb, marketMid, side);
    if (kellyFrac < 0.001) return;

    const sizeUsd = kellyFrac * risk.getStats().bankroll;
    const check = risk.canTrade('crypto_latency', market.conditionId, sizeUsd);
    if (!check.allowed) return;

    const sizeContracts = check.sizeUsd / entryPrice;
    if (sizeContracts < 5) return;

    this.inFlight.add(market.conditionId);
    log.info(
      { q: market.question, spot, modelProb, marketMid, divergence, side, sizeContracts },
      'Crypto latency signal'
    );

    try {
      const result = await this.polymarket.placeOrder({
        externalId: token,
        outcome: 'YES',
        side: 'BUY',
        orderType: 'IOC',
        price: entryPrice,
        size: sizeContracts,
      });
      if (result.ok && (result.filled ?? 0) > 0) {
        risk.recordDeployment('crypto_latency', market.conditionId, check.sizeUsd);
        await sendDiscord(
          '📈 Crypto latency entry',
          market.question,
          'info',
          [
            { name: 'Side', value: side, inline: true },
            { name: 'Model prob', value: modelProb.toFixed(3), inline: true },
            { name: 'Market mid', value: marketMid.toFixed(3), inline: true },
            { name: 'Size', value: `${sizeContracts.toFixed(2)} @ ${entryPrice.toFixed(3)}`, inline: false },
          ]
        );
      }
    } catch (err) {
      log.error({ err }, 'Crypto latency order error');
    } finally {
      setTimeout(() => this.inFlight.delete(market.conditionId), 5000);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pm = new PolymarketConnector();
  const pf = new PriceFeedAggregator();
  await Promise.all([pm.connect(), pf.start()]);
  const strat = new CryptoLatencyStrategy(pm, pf);
  await strat.start();
  log.info('Crypto latency strategy running.');
}
