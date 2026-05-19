/**
 * STRATEGY: Cross-Platform Arbitrage (Kalshi ↔ Polymarket)
 *
 * THESIS:
 *   The same real-world event (e.g., "Fed cuts rates in June", "BTC > $200K
 *   by year-end") often lists on both Kalshi and Polymarket. Because the
 *   user bases are different (Kalshi = US retail with debit cards, Polymarket
 *   = crypto natives), price discovery drifts between platforms and creates
 *   arb opportunities. Top arbitrageur generated $2.01M across 4,049 trades
 *   doing exactly this.
 *
 *   Specifically: if YES on Kalshi is $0.30 and YES on Polymarket is $0.40,
 *   we buy YES on Kalshi (cheap) and buy NO on Polymarket (which is $0.60).
 *   Combined cost: $0.90. Settlement: one of them pays $1.00. Locked profit.
 *
 * EXECUTION:
 *   1. Match markets across platforms by question similarity + time horizon
 *   2. Stream order books on matched pairs
 *   3. Detect when KALSHI_YES_ASK + POLYMARKET_NO_ASK < threshold OR vice versa
 *   4. Fire orders on both platforms simultaneously
 *
 * CHALLENGES:
 *   - Settlement timing must align (one closes before the other = bad)
 *   - Settlement criteria can differ subtly (e.g., what counts as a Fed cut)
 *   - This V1 uses a small whitelisted set of known-good pairs; later versions
 *     should add LLM-powered semantic matching across the full market list.
 */

import axios from 'axios';
import { PolymarketConnector } from '../connectors/polymarket.js';
import { KalshiConnector } from '../connectors/kalshi.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { isPermissive } from '../utils/config.js';
import type { OrderBook } from '../connectors/types.js';

const log = createStrategyLogger('cross_platform');

const MIN_EDGE_PROD = 0.02;        // 2% minimum in production
const MIN_EDGE_PERMISSIVE = 0.003; // 0.3% minimum in permissive paper
const getMinEdge = () => (isPermissive() ? MIN_EDGE_PERMISSIVE : MIN_EDGE_PROD);
const FOK_TIMEOUT_MS = 800;

interface CrossPair {
  id: string;
  description: string;
  kalshiTicker: string;
  polymarketYesToken: string;
  polymarketNoToken: string;
  kalshiBook?: OrderBook;
  polyYesBook?: OrderBook;
  polyNoBook?: OrderBook;
}

/**
 * V1 manual pair registry. Use this for any pairs where you've manually
 * verified identical resolution criteria.
 *
 * The auto-discovery routine below ALSO populates pairs at runtime by
 * matching Polymarket weather contracts to Kalshi tickers via a known
 * city/threshold convention. That's far more reliable than hand-curating
 * because tomorrow's contracts get listed daily.
 */
const PAIRS: Omit<CrossPair, 'kalshiBook' | 'polyYesBook' | 'polyNoBook'>[] = [
  // Manual high-confidence pairs go here. None at present - all current
  // pairs come from auto-discovery.
];

// Polymarket city name -> Kalshi series ticker prefix
// Verified by querying https://api.elections.kalshi.com/trade-api/v2/series
const KALSHI_WEATHER_SERIES: Record<string, string> = {
  'NYC': 'KXHIGHNY',
  'New York': 'KXHIGHNY',
  'Chicago': 'KXHIGHCHI',
  'LA': 'KXHIGHLAX',
  'Los Angeles': 'KXHIGHLAX',
  'Miami': 'KXHIGHMIA',
  'Denver': 'KXHIGHDEN',
  'Seattle': 'KXHIGHTSEA',
  'Phoenix': 'KXHIGHTPHX',
  'San Francisco': 'KXHIGHTSFO',
  'Houston': 'KXHIGHHOU',
  'Atlanta': 'KXHIGHATL',
  'Boston': 'KXHIGHBOS',
  'Philadelphia': 'KXHIGHPHI',
  'Austin': 'KXHIGHAUS',
};

const MONTH_ABBR: Record<string, string> = {
  Jan: 'JAN', Feb: 'FEB', Mar: 'MAR', Apr: 'APR',
  May: 'MAY', Jun: 'JUN', Jul: 'JUL', Aug: 'AUG',
  Sep: 'SEP', Oct: 'OCT', Nov: 'NOV', Dec: 'DEC',
  January: 'JAN', February: 'FEB', March: 'MAR', April: 'APR',
  June: 'JUN', July: 'JUL', August: 'AUG',
  September: 'SEP', October: 'OCT', November: 'NOV', December: 'DEC',
};

export class CrossPlatformStrategy {
  private pairs = new Map<string, CrossPair>();
  private inFlight = new Set<string>();

  constructor(
    private polymarket: PolymarketConnector,
    private kalshi: KalshiConnector
  ) {}

  async start(): Promise<void> {
    log.info({ count: PAIRS.length }, 'Cross-platform strategy starting');

    // Manual pairs first
    for (const p of PAIRS) {
      await this.registerPair({ ...p });
    }

    // Auto-discover weather pairs (Polymarket weather contracts that have
    // matching Kalshi tickers)
    await this.discoverWeatherPairs();
    // Refresh daily - new contracts list each day
    setInterval(() => this.discoverWeatherPairs(), 6 * 60 * 60 * 1000);
  }

  private async registerPair(p: Omit<CrossPair, 'kalshiBook' | 'polyYesBook' | 'polyNoBook'>): Promise<void> {
    if (this.pairs.has(p.id)) return;
    const pair: CrossPair = { ...p };
    this.pairs.set(p.id, pair);

    try {
      await this.kalshi.subscribeOrderBook(p.kalshiTicker, (book) => {
        pair.kalshiBook = book;
        this.checkArbitrage(pair);
      });
      await this.polymarket.subscribeOrderBook(p.polymarketYesToken, (book) => {
        pair.polyYesBook = book;
        this.checkArbitrage(pair);
      });
      await this.polymarket.subscribeOrderBook(p.polymarketNoToken, (book) => {
        pair.polyNoBook = book;
        this.checkArbitrage(pair);
      });
      log.info({ id: p.id, description: p.description }, 'Cross-platform pair registered');
    } catch (err) {
      log.error({ err, pair: p.id }, 'Failed to register pair');
    }
  }

  /**
   * Auto-discover weather pairs.
   *
   * Polymarket lists weather questions like:
   *   "Will the highest temperature in NYC be between 89-90°F on May 20?"
   * Kalshi lists the same as ticker:
   *   KXHIGHNY-26MAY20-B89.5  (B = bucket, midpoint of range)
   *
   * We pull all Polymarket weather contracts, parse them, and verify each
   * matching Kalshi ticker exists via the public /markets endpoint.
   */
  private async discoverWeatherPairs(): Promise<void> {
    try {
      const pmMarkets = await this.polymarket.listActiveMarkets();
      let discovered = 0;
      let verified = 0;

      for (const m of pmMarkets) {
        const lc = m.question.toLowerCase();
        if (!lc.includes('highest temperature in')) continue;
        if (!m.yes_token || !m.no_token) continue;

        // Match patterns like "in NYC be between 89-90°F on May 20"
        const rng = m.question.match(/in ([\w ]+?) be between (\d+)-(\d+).F on (\w+) (\d+)/i);
        if (!rng) continue;
        const city = rng[1].trim();
        const lo = parseInt(rng[2], 10);
        const hi = parseInt(rng[3], 10);
        const monthRaw = rng[4];
        const day = parseInt(rng[5], 10);

        const series = KALSHI_WEATHER_SERIES[city];
        if (!series) continue;
        const monthShort = MONTH_ABBR[monthRaw];
        if (!monthShort) continue;

        // Build Kalshi ticker - bucket markets use midpoint
        const midpoint = (lo + hi) / 2;
        const year = new Date().getFullYear() % 100;
        const ticker = `${series}-${year}${monthShort}${String(day).padStart(2, '0')}-B${midpoint % 1 === 0 ? midpoint : midpoint.toFixed(1)}`;
        discovered++;

        // Verify the Kalshi ticker exists
        try {
          const url = `${process.env.KALSHI_HOST ?? 'https://api.elections.kalshi.com/trade-api/v2'}/markets/${ticker}`;
          const r = await axios.get(url, { timeout: 5000, headers: { 'User-Agent': 'panda-bot' } });
          if (!r.data?.market) continue;
          verified++;
          await this.registerPair({
            id: `weather-${city.toLowerCase().replace(/\s+/g, '-')}-${lo}-${hi}-${monthShort}-${day}`,
            description: `${city} ${lo}-${hi}°F on ${monthRaw} ${day}`,
            kalshiTicker: ticker,
            polymarketYesToken: m.yes_token,
            polymarketNoToken: m.no_token,
          });
        } catch {
          // Kalshi ticker doesn't exist - skip silently
        }
      }

      log.info(
        { discovered, verified, totalPairs: this.pairs.size },
        'Weather pair auto-discovery complete'
      );
      if (verified > 0) {
        await sendDiscord(
          '🌤️ Cross-platform pairs activated',
          `Auto-discovered **${verified} matching weather contracts** across Kalshi and Polymarket.`,
          'success',
          [
            { name: 'Polymarket weather questions found', value: discovered.toString(), inline: true },
            { name: 'Kalshi tickers verified', value: verified.toString(), inline: true },
            { name: 'Total cross-platform pairs', value: this.pairs.size.toString(), inline: true },
          ]
        );
      }
    } catch (err) {
      log.error({ err }, 'Weather pair discovery error');
    }
  }

  private async checkArbitrage(pair: CrossPair): Promise<void> {
    if (this.inFlight.has(pair.id)) return;
    if (!pair.kalshiBook || !pair.polyYesBook || !pair.polyNoBook) return;
    if (!pair.kalshiBook.bestAsk || !pair.polyNoBook.bestAsk) return;

    // Path A: Buy YES on Kalshi, buy NO on Polymarket
    const kYes = pair.kalshiBook.bestAsk.price;
    const pNo = pair.polyNoBook.bestAsk.price;
    const sumA = kYes + pNo;

    // Path B: Buy NO on Kalshi (i.e. sell YES at bid+1 ... shorthand: 1 - YES_BID),
    //         buy YES on Polymarket
    const pYes = pair.polyYesBook.bestAsk?.price ?? 1;
    const kYesBid = pair.kalshiBook.bestBid?.price ?? 0;
    const kNoAsk = 1 - kYesBid;
    const sumB = kNoAsk + pYes;

    const minEdge = getMinEdge();
    let path: 'A' | 'B' | null = null;
    let edge = 0;
    if (sumA < 1 - minEdge) {
      path = 'A';
      edge = 1 - sumA;
    } else if (sumB < 1 - minEdge) {
      path = 'B';
      edge = 1 - sumB;
    }
    if (!path) return;

    const sizeContracts = Math.min(
      pair.kalshiBook.bestAsk?.size ?? 0,
      Math.min(pair.polyYesBook.bestAsk?.size ?? 0, pair.polyNoBook.bestAsk?.size ?? 0),
      50
    );
    if (sizeContracts < 5) return;

    const notional = sizeContracts * 0.5; // approx avg

    const risk = getRiskEngine();
    const check = risk.canTrade('cross_platform', pair.id, notional);
    if (!check.allowed) return;

    this.inFlight.add(pair.id);
    log.info({ pair: pair.description, path, edge, sizeContracts }, 'Cross-platform arb detected');

    try {
      const orders =
        path === 'A'
          ? Promise.all([
              this.kalshi.placeOrder({
                externalId: pair.kalshiTicker,
                outcome: 'YES',
                side: 'BUY',
                orderType: 'IOC',
                price: kYes,
                size: sizeContracts,
              }),
              this.polymarket.placeOrder({
                externalId: pair.polymarketNoToken,
                outcome: 'YES',
                side: 'BUY',
                orderType: 'FOK',
                price: pNo,
                size: sizeContracts,
              }),
            ])
          : Promise.all([
              this.kalshi.placeOrder({
                externalId: pair.kalshiTicker,
                outcome: 'NO',
                side: 'BUY',
                orderType: 'IOC',
                price: kNoAsk,
                size: sizeContracts,
              }),
              this.polymarket.placeOrder({
                externalId: pair.polymarketYesToken,
                outcome: 'YES',
                side: 'BUY',
                orderType: 'FOK',
                price: pYes,
                size: sizeContracts,
              }),
            ]);

      const [kRes, pRes] = await Promise.race([
        orders,
        new Promise<[any, any]>((_, rej) => setTimeout(() => rej(new Error('Order timeout')), FOK_TIMEOUT_MS)),
      ]);

      const kOk = kRes.ok && (kRes.filled ?? 0) > 0;
      const pOk = pRes.ok && (pRes.filled ?? 0) > 0;

      if (kOk && pOk) {
        const profit = sizeContracts * edge;
        risk.recordDeployment('cross_platform', pair.id, notional);
        await risk.recordPnl('cross_platform', profit, pair.id);
        await sendDiscord(
          '💰 Cross-platform arb filled',
          pair.description,
          'success',
          [
            { name: 'Path', value: path, inline: true },
            { name: 'Edge', value: `${(edge * 100).toFixed(2)}%`, inline: true },
            { name: 'Profit', value: `$${profit.toFixed(2)}`, inline: true },
          ]
        );
      } else if (kOk !== pOk) {
        log.error({ pair: pair.description, kOk, pOk }, 'CROSS-PLATFORM ONE-LEG FILL!');
        await sendDiscord(
          '⚠️ Cross-platform one-legged fill',
          `${pair.description}\nKalshi: ${kOk} / Polymarket: ${pOk}`,
          'error'
        );
      }
    } catch (err) {
      log.error({ err }, 'Cross-platform order error');
    } finally {
      setTimeout(() => this.inFlight.delete(pair.id), 3000);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pm = new PolymarketConnector();
  const k = new KalshiConnector();
  await Promise.all([pm.connect(), k.connect()]);
  const strat = new CrossPlatformStrategy(pm, k);
  await strat.start();
  log.info('Cross-platform strategy running.');
}
