/**
 * STRATEGY: Economic Nowcast (Kalshi) — V2 with real model wiring
 *
 * NOW LIVE:
 *   - GDP markets: queries Python quant service /macro/gdp-prob which uses
 *     Atlanta Fed GDPNow via FRED. Documented forecast error ~0.6pp = real edge.
 *   - CPI markets: queries /macro/cpi-prob with persistence model
 *     (3-month-trend extension of last YoY reading).
 *
 * Both endpoints return a model probability. We compare to Kalshi's market
 * price; if divergence > threshold, fire a Kelly-sized bet through the
 * risk engine.
 *
 * NOTE: The CPI model is intentionally conservative (persistence + trend).
 * It's not as good as Cleveland Fed's real nowcaster, but it's a solid
 * baseline that beats retail noise on Kalshi.
 */

import { KalshiConnector } from '../connectors/kalshi.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig, isPermissive, shouldPingPaperFills, isAggressive } from '../utils/config.js';
import { upsertMarket, recordHeartbeat, recordSignal, recordOrder } from '../db/supabase.js';
import axios from 'axios';

const log = createStrategyLogger('nowcast');

/**
 * Kalshi returns prices in two possible formats depending on market type:
 *   - yes_ask_dollars: string like "0.3900" (dollar amount as string)
 *   - yes_ask: integer cents (e.g. 39)
 * This helper normalizes both into a probability in [0,1].
 */
function parsePriceField(dollarsStr: string | undefined | null, centsInt: number | undefined | null): number | null {
  if (dollarsStr != null && dollarsStr !== '') {
    const v = parseFloat(dollarsStr);
    if (!isNaN(v) && v > 0 && v < 1) return v;
  }
  if (centsInt != null && typeof centsInt === 'number' && centsInt > 0 && centsInt < 100) {
    return centsInt / 100;
  }
  return null;
}

// CALIBRATED: persistence-trend CPI model isn't great. Raise threshold back up.
const MIN_DIVERGENCE = 0.07;             // 7pp - need real edge to overcome model uncertainty
// Reject divergences > 25pp - that means our model is broken or seeing stale data
const MAX_REASONABLE_DIVERGENCE = 0.25;
const getMinDivergence = () => MIN_DIVERGENCE;

// Kalshi series tickers for macro markets - EXPANDED
const MACRO_SERIES = [
  // Inflation
  'KXCPI', 'KXCPIYOY', 'KXCPIYOYM', 'KXCORECPI', 'KXPCE', 'KXCOREPCE', 'KXPPI',
  // Growth
  'KXGDP', 'KXGDPNOW', 'KXGDPQOQ',
  // Labor
  'KXJOBS', 'KXNFP', 'KXUNEMP', 'KXUNEMPRATE', 'KXJOBLESS',
  // Fed / rates
  'KXFEDDECISION', 'KXFEDRATE', 'KXFED', 'KXRATE',
  // Other
  'KXRETAIL', 'KXHOUSING', 'KXISM', 'KXCONSUMER',
];

interface MacroMarket {
  ticker: string;
  title: string;
  seriesTicker: string;
  eventTicker?: string;
  fractional?: boolean;
  liquidityUsd?: number;
  yesAsk: number | null;
  noAsk: number | null;
  closesAt?: Date;
  marketDbId?: string;
  // Last model assessment
  lastModelProb?: number;
  lastModelTs?: number;
}

export class NowcastStrategy {
  private markets = new Map<string, MacroMarket>();
  private opportunitiesSeen = 0;
  private inFlight = new Set<string>();

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    log.info({ series: MACRO_SERIES.length }, 'Nowcast strategy V2 starting');
    await this.discoverMarkets();
    setInterval(() => this.discoverMarkets(), 15 * 60 * 1000);  // rediscover every 15 min
    setInterval(() => this.refreshLivePrices(), 30_000);          // refresh prices every 30s
    setInterval(() => this.evaluateAll(), 60_000);                // re-evaluate every 1 min (was 5 min)
    setInterval(() => this.heartbeat(), 60_000);
    // Activity pings disabled - too noisy. Use dashboard for status.
  }

  private async discoverMarkets(): Promise<void> {
    const config = getConfig();
    for (const series of MACRO_SERIES) {
      try {
        const r = await axios.get(`${config.KALSHI_HOST}/events`, {
          params: { series_ticker: series, status: 'open', limit: 50 },
          timeout: 10000,
          headers: { 'User-Agent': 'panda-bot' },
        });
        for (const ev of r.data?.events ?? []) {
          const mr = await axios.get(`${config.KALSHI_HOST}/markets`, {
            params: { event_ticker: ev.event_ticker, limit: 100 },
            timeout: 10000,
            headers: { 'User-Agent': 'panda-bot' },
          });
          for (const m of mr.data?.markets ?? []) {
            // HARD FILTER 1: skip contracts resolving more than MAX_DAYS_TO_RESOLUTION away (skip discovery + eval entirely)
            if (m.close_time) {
              const daysOut = (new Date(m.close_time).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
              if (daysOut > config.MAX_DAYS_TO_RESOLUTION) continue;
            }
            // HARD FILTER 2: skip fractional-trading markets - we can't reliably liquidate them
            if (m.fractional_trading_enabled === true && !config.ALLOW_FRACTIONAL_MARKETS) continue;
            // Kalshi returns prices in either yes_ask (cents int) OR yes_ask_dollars (string) depending on market type.
            const yesAsk = parsePriceField(m.yes_ask_dollars, m.yes_ask);
            const noAsk = parsePriceField(m.no_ask_dollars, m.no_ask);
            if (this.markets.has(m.ticker)) {
              const snap = this.markets.get(m.ticker)!;
              snap.yesAsk = yesAsk;
              snap.noAsk = noAsk;
            } else {
              const dbId = await upsertMarket({
                platform: 'kalshi',
                external_id: m.ticker,
                question: m.title ?? m.subtitle ?? m.ticker,
                category: 'macro',
                outcome: 'YES',
                closes_at: m.close_time ? new Date(m.close_time) : undefined,
                metadata: { event_ticker: ev.event_ticker, series_ticker: series },
              }) ?? undefined;
              this.markets.set(m.ticker, {
                ticker: m.ticker,
                title: m.title ?? m.subtitle ?? m.ticker,
                seriesTicker: series,
                eventTicker: ev.event_ticker,
                fractional: m.fractional_trading_enabled === true,
                liquidityUsd: m.liquidity_dollars ? parseFloat(m.liquidity_dollars) : (m.liquidity != null ? m.liquidity / 100 : undefined),
                yesAsk, noAsk,
                closesAt: m.close_time ? new Date(m.close_time) : undefined,
                marketDbId: dbId,
              });
            }
          }
        }
      } catch (err: any) {
        if (err.response?.status !== 404) {
          log.debug({ series, status: err.response?.status }, 'Series fetch error');
        }
      }
    }
    log.info({ totalMacroMarkets: this.markets.size }, 'Nowcast market discovery');
  }

  /**
   * Parse a Kalshi macro market question into a (metric, threshold, direction).
   * Examples handled:
   *   "Will CPI YoY be above 3.0% in May 2026?"           -> cpi, 3.0, above
   *   "Will Q2 GDP growth be above 2.5%?"                 -> gdp, 2.5, above
   *   "Will the unemployment rate be below 4.0% in May?"  -> unemp, 4.0, below (skip - no model)
   */
  private parseMacroQuestion(q: string, seriesTicker: string): { metric: 'cpi' | 'gdp'; threshold: number; direction: 'above' | 'below' } | null {
    const lc = q.toLowerCase();
    let metric: 'cpi' | 'gdp' | null = null;
    if (seriesTicker.includes('CPI') || lc.includes('cpi') || lc.includes('inflation')) metric = 'cpi';
    else if (seriesTicker.includes('GDP') || lc.includes('gdp')) metric = 'gdp';
    if (!metric) return null;

    // Find number + percent
    const m = q.match(/(\d+\.\d+|\d+)\s*%/);
    if (!m) return null;
    const threshold = parseFloat(m[1]);

    let direction: 'above' | 'below' = 'above';
    if (/below|less than|under|<\s/.test(lc)) direction = 'below';

    return { metric, threshold, direction };
  }

  private async getModelProb(market: MacroMarket): Promise<number | null> {
    const config = getConfig();
    const parsed = this.parseMacroQuestion(market.title, market.seriesTicker);
    if (!parsed) return null;

    try {
      const path = parsed.metric === 'gdp' ? '/macro/gdp-prob' : '/macro/cpi-prob';
      const { data } = await axios.get(`${config.QUANT_SERVICE_URL}${path}`, {
        params: { threshold: parsed.threshold, direction: parsed.direction },
        timeout: 15000,
      });
      market.lastModelProb = data.prob;
      market.lastModelTs = Date.now();
      return data.prob;
    } catch (err: any) {
      // v1 MED-7: was `log.debug` — a sustained quant-service outage silently disabled
      // the strategy. Bump to warn so an outage is visible in logs without spamming.
      log.warn({ err: err.message, ticker: market.ticker }, 'Nowcast quant-service lookup failed — model probs unavailable this cycle');
      return null;
    }
  }

  /**
   * Refresh live YES/NO ask prices for all tracked markets every 30s.
   * This is the critical loop - without it, markets only get prices at discovery time.
   */
  private async refreshLivePrices(): Promise<void> {
    const config = getConfig();
    const tickers = [...this.markets.keys()];
    // Batch in groups of 20 tickers using the markets endpoint with comma-separated tickers
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
          const snap = this.markets.get(m.ticker);
          if (!snap) continue;
          snap.yesAsk = parsePriceField(m.yes_ask_dollars, m.yes_ask);
          snap.noAsk = parsePriceField(m.no_ask_dollars, m.no_ask);
          if (m.liquidity_dollars) snap.liquidityUsd = parseFloat(m.liquidity_dollars);
          else if (m.liquidity != null) snap.liquidityUsd = m.liquidity / 100;
        }
      } catch (err: any) {
        log.debug({ err: err.message }, 'Price refresh batch failed');
      }
    }
  }

  private async evaluateAll(): Promise<void> {
    for (const m of this.markets.values()) {
      await this.evaluate(m);
    }
  }

  private async evaluate(market: MacroMarket): Promise<void> {
    if (this.inFlight.has(market.ticker)) return;
    if (market.yesAsk == null || market.noAsk == null) return;

    const modelProb = await this.getModelProb(market);
    if (modelProb == null) return;

    // CRITICAL: Reject default-fallback model probabilities (0.5 ± 0.005 means the model has no signal)
    if (Math.abs(modelProb - 0.5) < 0.005) {
      log.debug({ ticker: market.ticker, modelProb }, 'Rejected: model returned ~0.5 default, no real signal');
      return;
    }

    const marketMid = (market.yesAsk + (1 - market.noAsk)) / 2;
    const divergence = modelProb - marketMid;

    if (Math.abs(divergence) < getMinDivergence()) return;

    // CRITICAL: cap divergence - extreme divergences mean model is broken, not market is wrong
    if (Math.abs(divergence) > MAX_REASONABLE_DIVERGENCE) {
      log.warn({ ticker: market.ticker, divergence, modelProb, marketMid }, 'Rejected: divergence too extreme');
      return;
    }

    this.opportunitiesSeen++;

    const side: 'YES' | 'NO' = divergence > 0 ? 'YES' : 'NO';
    const entryPrice = side === 'YES' ? market.yesAsk : market.noAsk;
    if (entryPrice >= 0.98 || entryPrice <= 0.02) return;

    const risk = getRiskEngine();
    const kellyFrac = risk.kellySize(modelProb, marketMid, side);
    if (kellyFrac < 0.002) return;
    const sizeUsd = kellyFrac * risk.getStats().bankroll;
    const check = risk.canTrade('nowcast', market.ticker, sizeUsd, {
      closesAt: market.closesAt,
      eventTicker: market.eventTicker,
      fractional: market.fractional,
      liquidityUsd: market.liquidityUsd,
    });
    if (!check.allowed) return;
    const sizeContracts = Math.floor(check.sizeUsd / entryPrice);
    if (sizeContracts < 1) return;

    const signalId = await recordSignal({
      strategy: 'nowcast',
      market_id: market.marketDbId,
      edge_bps: Math.round(Math.abs(divergence) * 10000),
      model_prob: modelProb,
      market_prob: marketMid,
      recommended_size_usd: sizeUsd,
      side,
      reason: 'model_divergence',
      payload: { ticker: market.ticker, title: market.title, divergence, sizeContracts, entryPrice },
    });

    this.inFlight.add(market.ticker);
    log.info({ ticker: market.ticker, modelProb, marketMid, divergence, side, sizeContracts }, 'Nowcast signal');

    // Ping on the SIGNAL (before order placement) when paper-fill pings are on
    // Don't ping on signal - only ping on actual fills (after order placement below)
    if (false && shouldPingPaperFills()) {
      await sendDiscord(
        '🔔 Nowcast signal detected',
        market.title,
        'success',
        [
          { name: 'Model prob', value: (modelProb ?? 0).toFixed(3), inline: true },
          { name: 'Market mid', value: marketMid.toFixed(3), inline: true },
          { name: 'Divergence', value: `${(divergence * 100).toFixed(1)}pp`, inline: true },
          { name: 'Side', value: side, inline: true },
          { name: 'Size', value: `${sizeContracts} @ \$${entryPrice.toFixed(2)}`, inline: true },
          { name: 'Mode', value: 'PAPER', inline: true },
        ]
      );
    }

    // SAFETY: nowcast runs paper-only until model accuracy is proven (post-incident guard)
    if (getConfig().NOWCAST_PAPER_ONLY && getConfig().TRADING_MODE === 'live') {
      log.info({ ticker: market.ticker, side, sizeContracts, entryPrice }, 'Nowcast signal (PAPER-ONLY: skipping live placement)');
      this.inFlight.delete(market.ticker);
      return;
    }

    try {
      const result = await this.kalshi.placeOrder({
        externalId: market.ticker,
        outcome: side,
        side: 'BUY',
        orderType: 'LIMIT',
        price: entryPrice,
        size: sizeContracts,
      });
      const mode = getConfig().TRADING_MODE;
      void recordOrder({
        signal_id: signalId ?? undefined,
        market_id: market.marketDbId,
        strategy: 'nowcast',
        mode, side: 'BUY', order_type: 'LIMIT',
        price: entryPrice, size: sizeContracts, outcome: side,
        external_order_id: result.externalOrderId,
        status: result.ok ? 'open' : 'rejected',
        filled_size: result.filled ?? 0,
      });
      if (result.ok) {
        risk.recordDeployment('nowcast', market.ticker, check.sizeUsd, market.eventTicker);
        await sendDiscord(
          '📈 Nowcast bet placed',
          market.title,
          'info',
          [
            { name: 'Model prob', value: (modelProb ?? 0).toFixed(3), inline: true },
            { name: 'Market mid', value: marketMid.toFixed(3), inline: true },
            { name: 'Side', value: side, inline: true },
            { name: 'Size', value: `${sizeContracts} @ ${entryPrice.toFixed(2)}`, inline: true },
          ]
        );
      }
    } catch (err) {
      log.error({ err }, 'Nowcast order error');
    } finally {
      setTimeout(() => this.inFlight.delete(market.ticker), 30_000);
    }
  }

  private async heartbeat(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    const modeled = [...this.markets.values()].filter((m) => m.lastModelProb != null).length;
    void recordHeartbeat('nowcast', getConfig().TRADING_MODE, {
      totalMacroMarkets: this.markets.size,
      withLivePrices: livePriced,
      withModelProb: modeled,
      opportunitiesSeen: this.opportunitiesSeen,
    });
  }

  private async sendActivityPing(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    const modeled = [...this.markets.values()].filter((m) => m.lastModelProb != null).length;
    await sendDiscord(
      '📈 Nowcast hourly report',
      `Tracking **${this.markets.size} macro markets** (CPI · GDP · Jobs · Fed · PCE · Unemp).`,
      'info',
      [
        { name: 'Markets with prices', value: livePriced.toString(), inline: true },
        { name: 'Markets with model prob', value: modeled.toString(), inline: true },
        { name: 'Signals fired', value: this.opportunitiesSeen.toString(), inline: true },
      ]
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const k = new KalshiConnector();
  await k.connect();
  const strat = new NowcastStrategy(k);
  await strat.start();
  log.info('Nowcast strategy running.');
}
