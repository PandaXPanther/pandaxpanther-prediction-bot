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
import { getConfig, isPermissive, shouldPingPaperFills } from '../utils/config.js';
import { upsertMarket, recordHeartbeat, recordSignal, recordOrder } from '../db/supabase.js';
import axios from 'axios';

const log = createStrategyLogger('nowcast');

const MIN_DIVERGENCE_PROD = 0.10;        // 10pp prod
const MIN_DIVERGENCE_PERMISSIVE = 0.04;  // 4pp permissive
const getMinDivergence = () => (isPermissive() ? MIN_DIVERGENCE_PERMISSIVE : MIN_DIVERGENCE_PROD);

// Kalshi series tickers for macro markets
const MACRO_SERIES = [
  'KXCPI', 'KXCPIYOY', 'KXPCE',
  'KXJOBS', 'KXFEDDECISION', 'KXGDP', 'KXUNEMP',
];

interface MacroMarket {
  ticker: string;
  title: string;
  seriesTicker: string;
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
    setInterval(() => this.discoverMarkets(), 30 * 60 * 1000);
    setInterval(() => this.evaluateAll(), 5 * 60 * 1000);  // re-evaluate every 5 min
    setInterval(() => this.heartbeat(), 60_000);
    setInterval(() => this.sendActivityPing(), 15 * 60 * 1000)  // 15 min for permissive paper visibility;
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
            const yesAsk = m.yes_ask != null ? m.yes_ask / 100 : null;
            const noAsk = m.no_ask != null ? m.no_ask / 100 : null;
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
      log.debug({ err: err.message, ticker: market.ticker }, 'Model lookup failed');
      return null;
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

    const marketMid = (market.yesAsk + (1 - market.noAsk)) / 2;
    const divergence = modelProb - marketMid;

    if (Math.abs(divergence) < getMinDivergence()) return;

    this.opportunitiesSeen++;

    const side: 'YES' | 'NO' = divergence > 0 ? 'YES' : 'NO';
    const entryPrice = side === 'YES' ? market.yesAsk : market.noAsk;
    if (entryPrice >= 0.98 || entryPrice <= 0.02) return;

    const risk = getRiskEngine();
    const kellyFrac = risk.kellySize(modelProb, marketMid, side);
    if (kellyFrac < 0.002) return;
    const sizeUsd = kellyFrac * risk.getStats().bankroll;
    const check = risk.canTrade('nowcast', market.ticker, sizeUsd);
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
    if (shouldPingPaperFills()) {
      await sendDiscord(
        '🔔 Nowcast signal detected',
        market.title,
        'success',
        [
          { name: 'Model prob', value: modelProb.toFixed(3), inline: true },
          { name: 'Market mid', value: marketMid.toFixed(3), inline: true },
          { name: 'Divergence', value: `${(divergence * 100).toFixed(1)}pp`, inline: true },
          { name: 'Side', value: side, inline: true },
          { name: 'Size', value: `${sizeContracts} @ \$${entryPrice.toFixed(2)}`, inline: true },
          { name: 'Mode', value: 'PAPER', inline: true },
        ]
      );
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
        risk.recordDeployment('nowcast', market.ticker, check.sizeUsd);
        await sendDiscord(
          '📈 Nowcast bet placed',
          market.title,
          'info',
          [
            { name: 'Model prob', value: modelProb.toFixed(3), inline: true },
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
