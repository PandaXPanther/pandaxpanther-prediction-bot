/**
 * STRATEGY: Economic Nowcast (Kalshi)
 *
 * THESIS:
 *   Kalshi lists contracts on macroeconomic releases — CPI, jobs reports,
 *   GDP, Fed rate decisions. These markets are dominated by retail traders
 *   who guess from headlines. Meanwhile, the Federal Reserve banks publish
 *   FREE nowcasting data that predicts these numbers within tight bounds:
 *
 *   - Cleveland Fed Inflation Nowcasting (clevelandfed.org/indicators-and-data/inflation-nowcasting)
 *     Updated daily, predicts next CPI/PCE print with documented RMSE
 *   - Atlanta Fed GDPNow (atlantafed.org/cqer/research/gdpnow)
 *     Real-time GDP nowcast
 *   - ADP National Employment Report (private payrolls, 2 days before BLS)
 *
 *   A Reddit user documented running EXACTLY this strategy on Kalshi
 *   for steady passive income with no real ML — just systematic data
 *   integration + Kelly sizing.
 *
 * V1 IMPLEMENTATION:
 *   - Discover all Kalshi economic markets (CPI, PCE, jobs, GDP, Fed rate)
 *   - Persist them + heartbeat their state to Supabase
 *   - The data-feed integration to compute model probabilities is V2
 *     (requires us to scrape Cleveland Fed PDF + Atlanta Fed JSON)
 *   - In V1, the strategy just observes and records — no orders fired
 *
 *   Once your bot has been running and collecting market state for a few
 *   weeks, we wire the Cleveland Fed scraper and you have a working
 *   nowcast strategy with real backtest data.
 */

import { KalshiConnector } from '../connectors/kalshi.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig } from '../utils/config.js';
import { upsertMarket, recordHeartbeat, recordSignal } from '../db/supabase.js';
import axios from 'axios';

const log = createStrategyLogger('nowcast');

// Kalshi series tickers for macro markets. Verified via the /series endpoint.
const MACRO_SERIES = [
  'KXCPI',          // CPI monthly print
  'KXCPIYOY',       // CPI year-over-year
  'KXPCE',          // PCE monthly
  'KXJOBS',         // Jobs report (NFP)
  'KXFEDDECISION',  // FOMC rate decisions
  'KXGDP',          // GDP releases
  'KXUNEMP',        // Unemployment rate
];

interface MacroMarket {
  ticker: string;
  title: string;
  seriesTicker: string;
  yesAsk: number | null;
  noAsk: number | null;
  closesAt?: Date;
  marketDbId?: string;
}

export class NowcastStrategy {
  private markets = new Map<string, MacroMarket>();

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    log.info({ series: MACRO_SERIES.length }, 'Nowcast strategy starting (V1: observe + persist)');
    await this.discoverMarkets();
    setInterval(() => this.discoverMarkets(), 30 * 60 * 1000); // refresh every 30 min
    setInterval(() => this.heartbeat(), 60_000);
    setInterval(() => this.sendActivityPing(), 60 * 60 * 1000);
  }

  private async discoverMarkets(): Promise<void> {
    const config = getConfig();
    let totalFound = 0;

    for (const series of MACRO_SERIES) {
      try {
        // List events for this series
        const r = await axios.get(`${config.KALSHI_HOST}/events`, {
          params: { series_ticker: series, status: 'open', limit: 50 },
          timeout: 10000,
          headers: { 'User-Agent': 'panda-bot' },
        });
        const events = r.data?.events ?? [];

        for (const ev of events) {
          // Get markets for this event
          const mr = await axios.get(`${config.KALSHI_HOST}/markets`, {
            params: { event_ticker: ev.event_ticker, limit: 100 },
            timeout: 10000,
            headers: { 'User-Agent': 'panda-bot' },
          });
          const markets = mr.data?.markets ?? [];

          for (const m of markets) {
            if (this.markets.has(m.ticker)) {
              // Update prices on existing market
              const snap = this.markets.get(m.ticker)!;
              snap.yesAsk = m.yes_ask != null ? m.yes_ask / 100 : null;
              snap.noAsk = m.no_ask != null ? m.no_ask / 100 : null;
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
                yesAsk: m.yes_ask != null ? m.yes_ask / 100 : null,
                noAsk: m.no_ask != null ? m.no_ask / 100 : null,
                closesAt: m.close_time ? new Date(m.close_time) : undefined,
                marketDbId: dbId,
              });
            }
            totalFound++;
          }
        }
      } catch (err: any) {
        // Some series may not exist - skip silently in info, warn only on systemic errors
        if (err.response?.status !== 404) {
          log.debug({ series, status: err.response?.status }, 'Series fetch error');
        }
      }
    }

    log.info({ totalMacroMarkets: this.markets.size, scannedSeries: MACRO_SERIES.length }, 'Nowcast market discovery');
  }

  private async heartbeat(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    void recordHeartbeat('nowcast', getConfig().TRADING_MODE, {
      totalMacroMarkets: this.markets.size,
      withLivePrices: livePriced,
      seriesCovered: MACRO_SERIES.length,
    });
    // Also record a peek signal so we have a time series of current macro market state
    if (this.markets.size > 0) {
      const sample = [...this.markets.values()][0];
      void recordSignal({
        strategy: 'nowcast',
        market_id: sample.marketDbId,
        market_prob: sample.yesAsk ?? undefined,
        reason: 'observation',
        payload: { ticker: sample.ticker, title: sample.title, yesAsk: sample.yesAsk, noAsk: sample.noAsk },
      });
    }
  }

  private async sendActivityPing(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    const upcomingClose = [...this.markets.values()]
      .filter((m) => m.closesAt && m.closesAt.getTime() > Date.now())
      .sort((a, b) => (a.closesAt!.getTime() - b.closesAt!.getTime()))[0];

    await sendDiscord(
      '📈 Nowcast hourly report',
      `Tracking **${this.markets.size} macro markets** across ${MACRO_SERIES.length} series (CPI, PCE, Jobs, GDP, Fed, Unemp).\n\nV1 is observing-only - data feed integration in V2.`,
      'info',
      [
        { name: 'Markets with live prices', value: livePriced.toString(), inline: true },
        { name: 'Series covered', value: MACRO_SERIES.length.toString(), inline: true },
        { name: 'Next close', value: upcomingClose?.title?.slice(0, 60) ?? 'none', inline: false },
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
