/**
 * STRATEGY: Weather Quant Model (Kalshi)
 *
 * THESIS:
 *   Kalshi lists daily weather contracts ("Will NYC high temp be > 85°F
 *   tomorrow?", "Will it rain in LAX next Tuesday?"). The market is dominated
 *   by retail traders who don't have access to NOAA's high-resolution
 *   ensemble forecasts. The data is FREE — anyone can pull NBM/HGEFS forecasts
 *   from api.weather.gov — but few participants actually integrate it
 *   into automated trading.
 *
 *   A data engineer publicly documented running a bot using NOAA HGEFS ensemble
 *   data vs. Kalshi temperature contracts, earning consistent passive income.
 *
 * EXECUTION:
 *   1. Discover all open Kalshi weather contracts via the markets API
 *   2. Parse each to extract station, metric, threshold, direction, target_date
 *   3. Query the Python quant service (services/quant/) for the model
 *      probability for that (station, metric, threshold, direction, date)
 *   4. Compare model_prob to market_mid; bet if |divergence| > threshold
 *   5. Use Kelly sizing with conservative 25% fractional Kelly
 *
 * EXPECTED EDGE:
 *   Weather contracts are notably mispriced 1-2 days out when ensemble
 *   forecasts show low uncertainty but the market hasn't moved away from
 *   50/50. We target high-confidence model predictions (model_prob >= 0.65
 *   or <= 0.35) against market prices near 0.5.
 */

import axios from 'axios';
import { KalshiConnector } from '../connectors/kalshi.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig, isPermissive, isAggressive } from '../utils/config.js';
import type { OrderBook } from '../connectors/types.js';

const log = createStrategyLogger('weather');

const MIN_PROB_DIVERGENCE_PROD = 0.08;       // 8pp in production
const MIN_PROB_DIVERGENCE_PERMISSIVE = 0.03; // 3pp in permissive paper
const getMinDivergence = () => (isPermissive() || isAggressive() ? MIN_PROB_DIVERGENCE_PERMISSIVE : MIN_PROB_DIVERGENCE_PROD);
const POLL_INTERVAL_MS = 5 * 60 * 1000; // re-evaluate every 5 minutes

interface WeatherContract {
  ticker: string;
  question: string;
  station: string;
  metric: 'high_temp_f' | 'low_temp_f' | 'precip_in';
  threshold: number;
  direction: 'above' | 'below';
  targetDate: string; // YYYY-MM-DD
  book?: OrderBook;
  lastModelProb?: number;
  lastModelTs?: number;
}

const STATION_KEYWORDS: Record<string, string> = {
  'new york': 'KNYC',
  'nyc': 'KNYC',
  'la ': 'KLAX',
  'los angeles': 'KLAX',
  'chicago': 'KORD',
  'miami': 'KMIA',
  'denver': 'KDEN',
  'seattle': 'KSEA',
  'atlanta': 'KATL',
  'boston': 'KBOS',
  'houston': 'KHOU',
  'phoenix': 'KPHX',
};

export class WeatherStrategy {
  private contracts = new Map<string, WeatherContract>();
  private inFlight = new Set<string>();

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    log.info('Weather strategy starting');
    await this.discoverWeatherMarkets();
    setInterval(() => this.discoverWeatherMarkets(), 30 * 60 * 1000);
    setInterval(() => this.refreshAllModels(), POLL_INTERVAL_MS);
  }

  /**
   * Parse a Kalshi weather contract question.
   * Examples it handles:
   *   "Will the high temperature in NYC be above 85°F on May 20?"
   *   "Will it rain more than 0.5 inches in LAX tomorrow?"
   *   "Will Chicago low temp be below 50°F on 2026-05-20?"
   */
  private parseWeatherQuestion(q: string, ticker: string): Omit<WeatherContract, 'ticker' | 'question' | 'book'> | null {
    const lc = q.toLowerCase();

    // Station
    let station: string | null = null;
    for (const [kw, s] of Object.entries(STATION_KEYWORDS)) {
      if (lc.includes(kw)) {
        station = s;
        break;
      }
    }
    if (!station) return null;

    // Metric
    let metric: WeatherContract['metric'];
    if (/high temp|maximum temp|max temp/.test(lc)) metric = 'high_temp_f';
    else if (/low temp|minimum temp|min temp/.test(lc)) metric = 'low_temp_f';
    else if (/rain|precip|inches/.test(lc)) metric = 'precip_in';
    else return null;

    // Threshold
    const numMatch = q.match(/(-?\d+(?:\.\d+)?)\s*(°|f|degrees|inch)/i);
    if (!numMatch) return null;
    const threshold = parseFloat(numMatch[1]);

    // Direction
    let direction: 'above' | 'below' = 'above';
    if (/below|under|less|fewer|<|cooler/.test(lc)) direction = 'below';

    // Target date - prefer explicit, else infer from ticker or default to tomorrow
    let targetDate: string;
    const dateMatch = q.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      targetDate = dateMatch[1];
    } else {
      // Kalshi tickers often contain date codes; try to extract YYMMDD
      const tickerDate = ticker.match(/(\d{2})(\d{2})(\d{2})/);
      if (tickerDate) {
        targetDate = `20${tickerDate[1]}-${tickerDate[2]}-${tickerDate[3]}`;
      } else {
        const t = new Date();
        t.setDate(t.getDate() + 1);
        targetDate = t.toISOString().slice(0, 10);
      }
    }

    return { station, metric, threshold, direction, targetDate };
  }

  private async discoverWeatherMarkets(): Promise<void> {
    const all = await this.kalshi.listActiveMarkets();
    const weatherCandidates = all.filter((m) =>
      /weather|temp|rain|snow|precip|degrees/i.test(m.question)
    );

    for (const m of weatherCandidates) {
      if (this.contracts.has(m.externalId)) continue;
      const parsed = this.parseWeatherQuestion(m.question, m.externalId);
      if (!parsed) {
        log.debug({ q: m.question }, 'Could not parse weather contract');
        continue;
      }
      const contract: WeatherContract = {
        ticker: m.externalId,
        question: m.question,
        ...parsed,
      };
      this.contracts.set(m.externalId, contract);
      await this.kalshi.subscribeOrderBook(m.externalId, (book) => {
        contract.book = book;
        this.evaluateContract(contract);
      });
      log.info({ ticker: m.externalId, ...parsed }, 'Subscribed weather contract');
    }
  }

  private async getModelProb(c: WeatherContract): Promise<number | null> {
    // Cache: refresh model prob every 5 minutes
    if (c.lastModelProb != null && c.lastModelTs != null && Date.now() - c.lastModelTs < POLL_INTERVAL_MS) {
      return c.lastModelProb;
    }
    try {
      const config = getConfig();
      const { data } = await axios.get(`${config.QUANT_SERVICE_URL}/weather/prob`, {
        params: {
          station: c.station,
          metric: c.metric,
          threshold: c.threshold,
          direction: c.direction,
          target_date: c.targetDate,
        },
        timeout: 15000,
      });
      c.lastModelProb = data.prob;
      c.lastModelTs = Date.now();
      return data.prob;
    } catch (err: any) {
      log.error({ err: err.message, ticker: c.ticker }, 'Quant service error');
      return null;
    }
  }

  private async refreshAllModels(): Promise<void> {
    for (const c of this.contracts.values()) {
      await this.getModelProb(c);
      this.evaluateContract(c);
    }
  }

  private async evaluateContract(c: WeatherContract): Promise<void> {
    if (this.inFlight.has(c.ticker)) return;
    if (!c.book?.bestBid || !c.book?.bestAsk) return;

    const modelProb = await this.getModelProb(c);
    if (modelProb == null) return;

    const marketMid = (c.book.bestBid.price + c.book.bestAsk.price) / 2;
    const divergence = modelProb - marketMid;
    if (Math.abs(divergence) < getMinDivergence()) return;

    const risk = getRiskEngine();
    const side: 'YES' | 'NO' = divergence > 0 ? 'YES' : 'NO';
    const entryPrice = side === 'YES' ? c.book.bestAsk.price : 1 - c.book.bestBid.price;
    if (entryPrice >= 0.98 || entryPrice <= 0.02) return;

    const kellyFrac = risk.kellySize(modelProb, marketMid, side);
    if (kellyFrac < 0.002) return;

    const sizeUsd = kellyFrac * risk.getStats().bankroll;
    const check = risk.canTrade('weather', c.ticker, sizeUsd);
    if (!check.allowed) return;

    const sizeContracts = Math.floor(check.sizeUsd / entryPrice);
    if (sizeContracts < 5) return;

    this.inFlight.add(c.ticker);
    log.info(
      { q: c.question, modelProb, marketMid, side, sizeContracts, entryPrice },
      'Weather signal'
    );

    try {
      const result = await this.kalshi.placeOrder({
        externalId: c.ticker,
        outcome: side,
        side: 'BUY',
        orderType: 'LIMIT',
        price: entryPrice,
        size: sizeContracts,
      });
      if (result.ok) {
        risk.recordDeployment('weather', c.ticker, check.sizeUsd);
        await sendDiscord(
          '🌤️ Weather signal entry',
          c.question,
          'info',
          [
            { name: 'Station', value: c.station, inline: true },
            { name: 'Model prob', value: modelProb.toFixed(3), inline: true },
            { name: 'Market mid', value: marketMid.toFixed(3), inline: true },
            { name: 'Side', value: side, inline: true },
            { name: 'Size', value: `${sizeContracts} @ ${entryPrice.toFixed(2)}`, inline: true },
          ]
        );
      }
    } catch (err) {
      log.error({ err }, 'Weather order error');
    } finally {
      setTimeout(() => this.inFlight.delete(c.ticker), 10000);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const k = new KalshiConnector();
  await k.connect();
  const strat = new WeatherStrategy(k);
  await strat.start();
  log.info('Weather strategy running.');
}
