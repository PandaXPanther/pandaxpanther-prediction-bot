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
import { recordSignal, recordOrder } from '../db/supabase.js';
// 4-ensemble probability model (GFS + ECMWF IFS + ECMWF AIFS + GEFS)
import { computeWeatherProbability } from './weatherModel.js';
import type { WeatherProbability } from './weatherModel.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig, isPermissive, isAggressive } from '../utils/config.js';
import { recordHeartbeat } from '../db/supabase.js';
import type { OrderBook } from '../connectors/types.js';

const log = createStrategyLogger('weather');

// 4-ensemble model produces higher-quality signal, so we can use a tighter divergence threshold.
// 4pp (0.04) gives a meaningful edge while filtering noise from a single-model source.
const MIN_PROB_DIVERGENCE = 0.04;        // 4pp — tightened from 2.5pp; valid because 4-model ensemble has much lower RMSE
const MAX_REASONABLE_DIVERGENCE = 0.25;  // Reject extreme divergences (model broken)
const getMinDivergence = () => MIN_PROB_DIVERGENCE;
const POLL_INTERVAL_MS = 2 * 60 * 1000; // re-evaluate every 2 minutes (was 5)

interface WeatherContract {
  ticker: string;
  question: string;
  station: string;
  metric: 'high_temp_f' | 'low_temp_f' | 'precip_in';
  threshold: number;
  direction: 'above' | 'below';
  targetDate: string; // YYYY-MM-DD
  closesAt?: Date;
  eventTicker?: string;
  fractional?: boolean;
  liquidityUsd?: number;
  // REST-polled best bid/ask (replaces WS-based book)
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  book?: OrderBook;  // kept for backwards-compat with evaluateContract
  lastModelProb?: number;
  lastModelTs?: number;
}

// EXPANDED station coverage - 25 US cities for Kalshi weather contracts
const STATION_KEYWORDS: Record<string, string> = {
  'new york': 'KNYC', 'nyc': 'KNYC',
  'la ': 'KLAX', 'los angeles': 'KLAX',
  'chicago': 'KORD',
  'miami': 'KMIA',
  'denver': 'KDEN',
  'seattle': 'KSEA',
  'atlanta': 'KATL',
  'boston': 'KBOS',
  'houston': 'KHOU',
  'phoenix': 'KPHX',
  'dallas': 'KDFW',
  'philadelphia': 'KPHL', 'philly': 'KPHL',
  'san francisco': 'KSFO', 'sf ': 'KSFO',
  'washington': 'KDCA', 'dc ': 'KDCA',
  'minneapolis': 'KMSP',
  'detroit': 'KDTW',
  'orlando': 'KMCO',
  'tampa': 'KTPA',
  'las vegas': 'KLAS', 'vegas': 'KLAS',
  'austin': 'KAUS',
  'san diego': 'KSAN',
  'portland': 'KPDX',
  'baltimore': 'KBWI',
  'charlotte': 'KCLT',
  'nashville': 'KBNA',
  'st louis': 'KSTL', 'saint louis': 'KSTL',
  'cleveland': 'KCLE',
  'pittsburgh': 'KPIT',
};

export class WeatherStrategy {
  private contracts = new Map<string, WeatherContract>();
  private inFlight = new Set<string>();

  constructor(private kalshi: KalshiConnector) {}

  private opportunitiesSeen = 0;

  async start(): Promise<void> {
    log.info('Weather strategy starting (REST polling mode)');
    // First-time discovery wrapped in try so a failure doesn't kill strategy startup
    try { await this.discoverWeatherMarkets(); }
    catch (err: any) { log.error({ err: err.message }, 'Initial weather discovery failed - will retry'); }
    setInterval(() => this.discoverWeatherMarkets().catch(e => log.error({ err: e.message }, 'discoverWeatherMarkets error')), 10 * 60 * 1000);  // every 10 min
    setInterval(() => this.refreshLivePrices().catch(e => log.error({ err: e.message }, 'refreshLivePrices error')), 30_000);                     // prices every 30s
    setInterval(() => this.refreshAllModels().catch(e => log.error({ err: e.message }, 'refreshAllModels error')), POLL_INTERVAL_MS);             // models every 2 min
    setInterval(() => this.heartbeat().catch(e => log.error({ err: e.message }, 'heartbeat error')), 60_000);                                     // heartbeat every 60s
  }

  private async heartbeat(): Promise<void> {
    const modeled = [...this.contracts.values()].filter(c => c.lastModelProb != null).length;
    const priced = [...this.contracts.values()].filter(c => c.book?.bestBid != null).length;
    void recordHeartbeat('weather', getConfig().TRADING_MODE, {
      totalContracts: this.contracts.size,
      withModelProb: modeled,
      withLivePrices: priced,
      opportunitiesSeen: this.opportunitiesSeen,
    });
  }

  /**
   * Map Kalshi city code (from ticker prefix) to NOAA station code.
   */
  private cityCodeToStation(ticker: string): string | null {
    // FIXED 2026-05-22 (v2): Kalshi runs BOTH old-format (KXHIGH<CITY>) and
    // new-format (KXHIGHT<CITY>) weather series simultaneously. Examples:
    //   Old: KXHIGHCHI, KXHIGHNY, KXHIGHMIA, KXHIGHAUS, KXLOWNY, KXLOWDEN
    //   New: KXHIGHTATL, KXLOWTLAX, KXHIGHTHOU, KXLOWTNYC, KXLOWTPHIL
    //   Edge: KXHIGHTEMPDEN, KXLOWTEMP* (uses HIGHTEMP/LOWTEMP prefix)
    //   Rain: KXRAIN<CITY> and KXRAIN<CITY>M (monthly suffix)
    // Strategy: try multiple regex patterns, pick the first whose captured
    // code resolves in the codeMap.
    const codeMap: Record<string, string> = {
      // Single/double letter codes
      NY: 'KNYC', LA: 'KLAX', CHI: 'KORD', MIA: 'KMIA', DEN: 'KDEN', SEA: 'KSEA',
      ATL: 'KATL', BOS: 'KBOS', HOU: 'KHOU', PHX: 'KPHX', DFW: 'KDFW', PHL: 'KPHL',
      SF: 'KSFO', DC: 'KDCA', MSP: 'KMSP', DTW: 'KDTW', MCO: 'KMCO', TPA: 'KTPA',
      LAS: 'KLAS', LV: 'KLAS', AUS: 'KAUS', SAN: 'KSAN', PDX: 'KPDX',
      // Actual Kalshi codes observed in /incentive_programs + /series:
      LAX:  'KLAX',  // LA
      NYC:  'KNYC',  // NY
      NYD:  'KNYC',  // NY (alt)
      PHIL: 'KPHL',  // Philadelphia
      NOLA: 'KMSY',  // New Orleans (Louis Armstrong)
      SATX: 'KSAT',  // San Antonio
      OKC:  'KOKC',  // Oklahoma City
      DAL:  'KDFW',  // Dallas
      MIN:  'KMSP',  // Minneapolis short form
      SFO:  'KSFO',  // San Francisco
    };

    // Try a sequence of patterns, longest-prefix-first so KXHIGHTEMP doesn't
    // get misparsed as KXHIGHT+EMP.
    const patterns: RegExp[] = [
      /^KX(?:HIGHTEMP|LOWTEMP)([A-Z]+)-/,   // KXHIGHTEMPDEN -> DEN
      /^KX(?:HIGHT|LOWT)([A-Z]+?)M?-/,       // KXHIGHTATL -> ATL, KXLOWTLAX -> LAX
      /^KXTEMP([A-Z]+?)H?-/,                 // KXTEMPNYCH -> NYC, KXTEMPLAXH -> LAX
      /^KX(?:RAIN|SNOW|PRECIP)([A-Z]+?)M?-/, // KXRAINNYC, KXRAINMIAM (M=monthly)
      /^KX(?:HIGH|LOW)([A-Z]+?)D?-/,         // KXHIGHCHI, KXLOWNY, KXHIGHNYD
    ];
    for (const re of patterns) {
      const m = ticker.match(re);
      if (m && codeMap[m[1]]) return codeMap[m[1]];
    }
    return null;
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

    // Station - try ticker code first (most reliable), then keyword fallback
    let station: string | null = this.cityCodeToStation(ticker);
    if (!station) {
      for (const [kw, s] of Object.entries(STATION_KEYWORDS)) {
        if (lc.includes(kw)) {
          station = s;
          break;
        }
      }
    }
    if (!station) return null;

    // Metric - infer from ticker prefix first, then question text.
    // Order matters: check HIGHTEMP/LOWTEMP/HIGHT/LOWT before HIGH/LOW.
    let metric: WeatherContract['metric'];
    if (ticker.startsWith('KXHIGHTEMP')) metric = 'high_temp_f';
    else if (ticker.startsWith('KXLOWTEMP')) metric = 'low_temp_f';
    else if (ticker.startsWith('KXHIGHT') || ticker.startsWith('KXHIGH') || /high temp|maximum temp|max temp/.test(lc)) metric = 'high_temp_f';
    else if (ticker.startsWith('KXLOWT') || ticker.startsWith('KXLOW') || /low temp|minimum temp|min temp/.test(lc)) metric = 'low_temp_f';
    else if (ticker.startsWith('KXRAIN') || ticker.startsWith('KXPRECIP') || /rain|precip|inches/.test(lc)) metric = 'precip_in';
    else if (ticker.startsWith('KXSNOW')) metric = 'precip_in'; // treat snow as precip approximation
    else if (ticker.startsWith('KXTEMP')) metric = 'high_temp_f';
    else return null;

    // Threshold - prefer the explicit -T<num> suffix in the ticker (e.g. KXHIGHNY-26MAY20-T96)
    let threshold: number | null = null;
    const ticketThreshold = ticker.match(/-T(-?\d+(?:\.\d+)?)$/);
    if (ticketThreshold) {
      threshold = parseFloat(ticketThreshold[1]);
    } else {
      const numMatch = q.match(/(-?\d+(?:\.\d+)?)\s*(°|f|degrees|inch)/i);
      if (numMatch) threshold = parseFloat(numMatch[1]);
    }
    if (threshold == null) return null;

    // Direction - check question text + ticker hints
    let direction: 'above' | 'below' = 'above';
    if (/below|under|less|fewer|<|cooler/.test(lc)) direction = 'below';
    // Also check for the actual symbol in the question (Kalshi uses > and <)
    if (q.includes('<') && !q.includes('>')) direction = 'below';

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
    const config = getConfig();
    // FIXED 2026-05-22 (v2): Instead of guessing prefix×city combos and praying,
    // pull the live series list from /v2/series?category=Climate%20and%20Weather
    // and iterate every series that starts with KXHIGH/KXLOW/KXRAIN/KXSNOW/KXTEMP/KXPRECIP.
    // This auto-adapts when Kalshi adds new cities and avoids the 429 rate limit
    // from probing 100+ non-existent series tickers every cycle.
    const TARGET_PREFIXES = ['KXHIGH', 'KXLOW', 'KXRAIN', 'KXSNOW', 'KXTEMP', 'KXPRECIP'];
    let activeSeries: string[] = [];
    try {
      const sr = await axios.get(`${config.KALSHI_HOST}/series`, {
        params: { category: 'Climate and Weather', include_product_metadata: false, limit: 200 },
        timeout: 8000,
        headers: { 'User-Agent': 'panda-bot' },
      });
      const allSeries = (sr.data?.series ?? []).map((s: any) => s.ticker as string);
      activeSeries = allSeries.filter((t: string) => TARGET_PREFIXES.some((p) => t.startsWith(p)));
      log.info({ totalSeries: allSeries.length, weatherSeries: activeSeries.length }, 'Weather series discovery');
    } catch (e: any) {
      log.warn({ err: e?.message }, 'Failed to fetch weather series list; falling back to hardcoded set');
      // Fallback list captured 2026-05-22 in case /series endpoint is unreachable
      activeSeries = [
        'KXHIGHAUS','KXHIGHCHI','KXHIGHDEN','KXHIGHHOU','KXHIGHLAX','KXHIGHMIA','KXHIGHNY','KXHIGHPHIL',
        'KXHIGHTATL','KXHIGHTBOS','KXHIGHTDAL','KXHIGHTDC','KXHIGHTHOU','KXHIGHTLV','KXHIGHTMIN','KXHIGHTNOLA','KXHIGHTOKC','KXHIGHTPHX','KXHIGHTSATX','KXHIGHTSEA','KXHIGHTSFO',
        'KXHIGHTEMPDEN',
        'KXLOWAUS','KXLOWCHI','KXLOWDEN','KXLOWLAX','KXLOWMIA','KXLOWNY','KXLOWNYC','KXLOWPHIL',
        'KXLOWTATL','KXLOWTAUS','KXLOWTBOS','KXLOWTCHI','KXLOWTDAL','KXLOWTDC','KXLOWTDEN','KXLOWTHOU','KXLOWTLAX','KXLOWTLV','KXLOWTMIA','KXLOWTMIN','KXLOWTNOLA','KXLOWTNYC','KXLOWTOKC','KXLOWTPHIL','KXLOWTPHX','KXLOWTSATX','KXLOWTSEA','KXLOWTSFO',
      ];
    }

    const weatherCandidates: Array<{externalId: string; question: string; closesAt?: Date; eventTicker?: string; fractional?: boolean; liquidityUsd?: number}> = [];

    // Throttle requests: 8 concurrent batches with small delay between batches
    const BATCH = 8;
    for (let i = 0; i < activeSeries.length; i += BATCH) {
      const slice = activeSeries.slice(i, i + BATCH);
      const results = await Promise.allSettled(slice.map((series) =>
        axios.get(`${config.KALSHI_HOST}/markets`, {
          params: { series_ticker: series, status: 'open', limit: 200 },
          timeout: 8000,
          headers: { 'User-Agent': 'panda-bot' },
        })
      ));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        for (const m of r.value.data?.markets ?? []) {
          weatherCandidates.push({
            externalId: m.ticker,
            question: m.title ?? m.subtitle ?? m.ticker,
            closesAt: m.close_time ? new Date(m.close_time) : undefined,
            eventTicker: m.event_ticker,
            fractional: m.fractional_trading_enabled === true,
            liquidityUsd: m.liquidity_dollars ? parseFloat(m.liquidity_dollars) : (m.liquidity != null ? m.liquidity / 100 : undefined),
          });
        }
      }
      // Small delay between batches to avoid 429
      if (i + BATCH < activeSeries.length) await new Promise((r) => setTimeout(r, 200));
    }
    log.info({ candidates: weatherCandidates.length, series: activeSeries.length }, 'Weather discovery sweep');

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
        closesAt: m.closesAt,
        eventTicker: m.eventTicker,
        fractional: m.fractional,
        liquidityUsd: m.liquidityUsd,
        ...parsed,
      };
      this.contracts.set(m.externalId, contract);
      // NOTE: WS subscription removed to avoid flooding Kalshi WS. REST polling every 30s is sufficient
      // for weather (forecast updates are hourly anyway).
    }
    log.info({ tracked: this.contracts.size, candidates: weatherCandidates.length }, 'Weather contract sweep complete (WS + REST hybrid)');
  }

  /**
   * Refresh live YES/NO bid/ask prices for all tracked contracts via REST batch.
   * Replaces the broken WS subscribe path (Kalshi WS auth disabled).
   */
  private async refreshLivePrices(): Promise<void> {
    const config = getConfig();
    const tickers = [...this.contracts.keys()];
    const batchSize = 50;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      try {
        const r = await axios.get(`${config.KALSHI_HOST}/markets`, {
          params: { tickers: batch.join(','), limit: batchSize },
          timeout: 10000,
          headers: { 'User-Agent': 'panda-bot' },
        });
        for (const m of r.data?.markets ?? []) {
          const c = this.contracts.get(m.ticker);
          if (!c) continue;
          const parsePrice = (s: string | undefined, n: number | undefined): number | undefined => {
            if (s != null && s !== '') { const v = parseFloat(s); if (!isNaN(v) && v > 0 && v < 1) return v; }
            if (n != null && typeof n === 'number' && n > 0 && n < 100) return n / 100;
            return undefined;
          };
          c.yesAsk = parsePrice(m.yes_ask_dollars, m.yes_ask);
          c.yesBid = parsePrice(m.yes_bid_dollars, m.yes_bid);
          c.noAsk = parsePrice(m.no_ask_dollars, m.no_ask);
          c.noBid = parsePrice(m.no_bid_dollars, m.no_bid);
          if (m.liquidity_dollars) c.liquidityUsd = parseFloat(m.liquidity_dollars);
          else if (m.liquidity != null) c.liquidityUsd = m.liquidity / 100;
          // Build a fake OrderBook so the existing evaluateContract logic works
          if (c.yesAsk != null && c.yesBid != null) {
            c.book = {
              platform: 'kalshi',
              externalId: c.ticker,
              bestBid: { price: c.yesBid, size: 0 },
              bestAsk: { price: c.yesAsk, size: 0 },
            } as any;
          }
        }
      } catch (err: any) {
        log.debug({ err: err.message }, 'Weather price refresh batch failed');
      }
    }
    // After prices refresh, re-evaluate all contracts
    for (const c of this.contracts.values()) {
      void this.evaluateContract(c);
    }
  }

  /** Cached ensemble result (holds modelsAgreeing for the disagreement filter) */
  private ensembleCache = new Map<string, WeatherProbability>();

  private async getModelProb(c: WeatherContract): Promise<number | null> {
    // Cache: skip re-computation within POLL_INTERVAL_MS (2 min)
    if (c.lastModelProb != null && c.lastModelTs != null && Date.now() - c.lastModelTs < POLL_INTERVAL_MS) {
      return c.lastModelProb;
    }

    // -----------------------------------------------------------------------
    // PRIMARY PATH: 4-model ensemble (GFS + ECMWF IFS + ECMWF AIFS + GEFS)
    //
    // computeWeatherProbability fetches all 4 sources in parallel, applies
    // the 3-of-4 agreement filter, and returns a consensus probability.
    // When models disagree it returns source='reject-disagreement' with
    // probability=0.5 — evaluateContract will discard that signal.
    // -----------------------------------------------------------------------
    try {
      const targetDateObj = new Date(c.targetDate + 'T12:00:00Z'); // noon UTC on the target day
      const result = await computeWeatherProbability(
        c.station,
        c.metric,
        c.threshold,
        c.direction,
        targetDateObj,
      );

      if (result !== null) {
        // Store full ensemble result for the disagreement filter below
        this.ensembleCache.set(c.ticker, result);

        // ENSEMBLE DISAGREEMENT FILTER: 2026-05-23 lowered from 3 to 2.
        // Old 3-of-4 was rejecting essentially every contract (withModelProb=0
        // out of 494 tracked). 2-of-4 within 15pp is still a meaningful signal.
        if (result.modelsAgreeing < 2) {
          log.debug(
            {
              ticker: c.ticker,
              modelsAgreeing: result.modelsAgreeing,
              source: result.source,
              models: result.modelDetails,
            },
            'Weather ensemble: rejected (< 3 models agree)',
          );
          // Return 0.5 so evaluateContract's near-0.5 check will discard it
          return 0.5;
        }

        log.debug(
          {
            ticker: c.ticker,
            source: result.source,
            forecastValue: result.forecastValue,
            ensembleStdev: result.ensembleStdev,
            modelsAgreeing: result.modelsAgreeing,
            prob: result.probability,
            models: result.modelDetails,
          },
          'Weather ensemble forecast',
        );
        c.lastModelProb = result.probability;
        c.lastModelTs = Date.now();
        return result.probability;
      }
      // result === null means station unknown OR all 4 APIs failed
    } catch (err: any) {
      log.debug({ err: err.message, ticker: c.ticker }, 'computeWeatherProbability error — skipping contract');
    }

    // All ensemble sources failed — return null so evaluateContract skips
    return null;
  }

  /**
   * Refresh all model probs with rate limiting - quant service can't handle 60 concurrent calls.
   * Sleeps 200ms between calls = 5/sec max = fits comfortably in 60s cycle for 60 contracts.
   */
  private async refreshAllModels(): Promise<void> {
    // FIXED 2026-05-22 (v3): With 458 weather contracts, the serialized
    // 200ms loop took 5-15+ minutes per cycle, so withModelProb stayed at 0.
    // Filter to actionable contracts (closing within 10 days) and process
    // in parallel batches. Open-Meteo allows ~10k req/day = ~7 RPS sustained,
    // and our 4 sources share aggressive in-process caching keyed by
    // station+date, so 458 contracts collapse to ~25 unique (lat,lon,date)
    // tuples — mostly cache hits after the first contract per city/date.
    const now = Date.now();
    // 2026-05-23: Same-day only per latest research.
    // "Temperature forecast errors have fat tails (real 2-sigma = 10-12% not 5%)
    // beyond T+1". Models calibrated for 24h forecasts; longer horizons unreliable.
    const HORIZON_MS = 1 * 24 * 3600 * 1000;  // same-day only
    const all = [...this.contracts.values()];
    const contracts = all.filter((c) => !c.closesAt || c.closesAt.getTime() - now < HORIZON_MS);

    let modeled = 0;
    let failed = 0;
    const BATCH = 8;
    for (let i = 0; i < contracts.length; i += BATCH) {
      const slice = contracts.slice(i, i + BATCH);
      await Promise.allSettled(slice.map(async (c) => {
        try {
          const p = await this.getModelProb(c);
          if (p != null) modeled++; else failed++;
          await this.evaluateContract(c);
        } catch (err: any) {
          failed++;
          log.debug({ err: err.message, ticker: c.ticker }, 'Eval cycle error');
        }
      }));
    }
    log.info({ total: contracts.length, modeled, failed, skipped: all.length - contracts.length }, 'Weather model refresh complete');
  }

  private async evaluateContract(c: WeatherContract): Promise<void> {
    if (this.inFlight.has(c.ticker)) return;
    if (!c.book?.bestBid || !c.book?.bestAsk) return;

    const modelProb = await this.getModelProb(c);
    if (modelProb == null) return;

    // Reject default-fallback model probabilities
    if (Math.abs(modelProb - 0.5) < 0.005) {
      log.debug({ ticker: c.ticker, modelProb }, 'Rejected: weather model returned ~0.5 default');
      return;
    }

    // Reject model returning near-certain outcomes (within 5pp of 0/1)
    // - Means contract is effectively resolved (current temp already past threshold)
    // - OR model has way too much confidence given measurement noise
    if (modelProb >= 0.95 || modelProb <= 0.05) {
      log.debug({ ticker: c.ticker, modelProb }, 'Rejected: model near-certain (likely resolved or overconfident)');
      return;
    }

    // LIQUIDITY GUARD: Many weather contracts on Kalshi have no real orderbook
    // (yesBid/yesAsk null or 0.01/0.99 placeholder spreads). Without this guard
    // the bot computed massive fake divergences (e.g. model 90%, marketMid 5%)
    // and spammed 'divergence too extreme' rejection logs all night.
    // Skip if: bid-ask spread > 30c (no real market) OR market depth/liquidity is zero.
    const spread = c.book.bestAsk.price - c.book.bestBid.price;
    if (spread > 0.30) {
      log.debug({ ticker: c.ticker, spread, bid: c.book.bestBid.price, ask: c.book.bestAsk.price }, 'Skipped: weather contract too illiquid (>30c spread)');
      return;
    }
    if (c.liquidityUsd != null && c.liquidityUsd < 50) {
      log.debug({ ticker: c.ticker, liquidityUsd: c.liquidityUsd }, 'Skipped: weather contract <$50 liquidity');
      return;
    }

    const marketMid = (c.book.bestBid.price + c.book.bestAsk.price) / 2;
    const divergence = modelProb - marketMid;
    if (Math.abs(divergence) < getMinDivergence()) return;
    if (Math.abs(divergence) > MAX_REASONABLE_DIVERGENCE) {
      // Was log.warn (spammy). Demoted to debug since most are illiquid markets.
      log.debug({ ticker: c.ticker, divergence, modelProb, marketMid }, 'Rejected: weather divergence too extreme');
      return;
    }

    const risk = getRiskEngine();
    const side: 'YES' | 'NO' = divergence > 0 ? 'YES' : 'NO';
    const entryPrice = side === 'YES' ? c.book.bestAsk.price : 1 - c.book.bestBid.price;
    // 2026-05-23 v2: PRICE FLOOR raised to $0.50 per GWU 46k-contract study.
    // Only contracts >$0.50 with maker fills show positive EV (+2.6% avg).
    // Below $0.50 systematically loses to taker fees + adverse selection.
    if (entryPrice < 0.50 || entryPrice > 0.88) {
      log.debug({ ticker: c.ticker, entryPrice, side }, 'skipped: price outside $0.50-$0.88 profitable zone (GWU research)');
      return;
    }

    const kellyFrac = risk.kellySize(modelProb, marketMid, side);
    if (kellyFrac < 0.002) return;

    const sizeUsd = kellyFrac * risk.getStats().bankroll;
    const check = risk.canTrade('weather', c.ticker, sizeUsd, {
      closesAt: c.closesAt,
      eventTicker: c.eventTicker,
      fractional: c.fractional,
      liquidityUsd: c.liquidityUsd,
    });
    if (!check.allowed) return;

    const sizeContracts = Math.floor(check.sizeUsd / entryPrice);
    if (sizeContracts < 1) return;  // aggressive: even 1-contract orders are valid

    this.opportunitiesSeen++;
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
        clientOrderIdPrefix: 'weather',
      });
      if (result.ok) {
        risk.recordDeployment('weather', c.ticker, check.sizeUsd, c.eventTicker);
        await sendDiscord(
          '\u{1F324}\uFE0F Weather signal entry',
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

        // -----------------------------------------------------------------------
        // TAKE-PROFIT: post a 70% take-profit limit-sell immediately after fill.
        // Target price = entryPrice + 70% of (1 - entryPrice) for YES side, or
        // entryPrice + 70% of (1 - entryPrice) for NO side (mirrored).
        // Clamp to [0.01, 0.99] to stay within Kalshi bounds.
        // -----------------------------------------------------------------------
        const tpPrice = Math.max(0.01, Math.min(0.99,
          entryPrice + 0.70 * (1 - entryPrice)
        ));
        try {
          await this.kalshi.placeOrder({
            externalId: c.ticker,
            outcome: side,
            side: 'SELL',
            orderType: 'LIMIT',
            price: tpPrice,
            size: sizeContracts,
            clientOrderIdPrefix: 'weather-tp',
          });
          log.info(
            { ticker: c.ticker, side, tpPrice: tpPrice.toFixed(2), sizeContracts },
            'Weather TP limit-sell posted',
          );
        } catch (tpErr: any) {
          log.warn({ err: tpErr.message, ticker: c.ticker }, 'Failed to post weather TP order');
        }
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
