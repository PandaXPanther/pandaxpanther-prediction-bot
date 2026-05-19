/**
 * STRATEGY: Sports Latency (Kalshi)
 *
 * THESIS:
 *   Kalshi lists live sports markets ("Will Lakers win tonight?", spreads,
 *   totals). Most Kalshi sports traders are casuals who follow betting
 *   intuition, not real probability models. Meanwhile, ESPN GameCast, MLB
 *   Stats API, NBA Stats API, and other free feeds provide real-time game
 *   state (score, time remaining, possession). A simple win-probability
 *   model from game state often diverges from Kalshi's market price.
 *
 * V1 IMPLEMENTATION:
 *   - Discover all Kalshi sports markets (NBA, NFL, MLB, NHL, MLS series)
 *   - Persist them + observe price evolution
 *   - The ESPN GameCast integration to compute win-probability is V2
 *
 *   Like the nowcast strategy, V1 builds the muscle. V2 wires in the data
 *   feed and the bot starts firing real bets.
 */

import { KalshiConnector } from '../connectors/kalshi.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig } from '../utils/config.js';
import { upsertMarket, recordHeartbeat, recordSignal } from '../db/supabase.js';
import axios from 'axios';

const log = createStrategyLogger('sports_latency');

// Kalshi series tickers for live sports markets
const SPORTS_SERIES = [
  'KXNBAGAME',      // NBA game winners
  'KXMLBGAME',      // MLB game winners
  'KXNFLGAME',      // NFL game winners
  'KXNHLGAME',      // NHL game winners
  'KXSOCCERGAME',   // MLS and international soccer
  'KXNBASPREAD',    // NBA spreads
  'KXMLBSPREAD',
];

interface SportsMarket {
  ticker: string;
  title: string;
  seriesTicker: string;
  yesAsk: number | null;
  noAsk: number | null;
  marketDbId?: string;
}

export class SportsLatencyStrategy {
  private markets = new Map<string, SportsMarket>();

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    log.info({ series: SPORTS_SERIES.length }, 'Sports latency strategy starting (V1: observe + persist)');
    await this.discoverMarkets();
    setInterval(() => this.discoverMarkets(), 5 * 60 * 1000); // refresh every 5 min
    setInterval(() => this.heartbeat(), 60_000);
    setInterval(() => this.sendActivityPing(), 60 * 60 * 1000);
  }

  private async discoverMarkets(): Promise<void> {
    const config = getConfig();
    for (const series of SPORTS_SERIES) {
      try {
        const r = await axios.get(`${config.KALSHI_HOST}/markets`, {
          params: { series_ticker: series, status: 'open', limit: 200 },
          timeout: 10000,
          headers: { 'User-Agent': 'panda-bot' },
        });
        const markets = r.data?.markets ?? [];

        for (const m of markets) {
          if (this.markets.has(m.ticker)) {
            const snap = this.markets.get(m.ticker)!;
            snap.yesAsk = m.yes_ask != null ? m.yes_ask / 100 : null;
            snap.noAsk = m.no_ask != null ? m.no_ask / 100 : null;
          } else {
            const dbId = await upsertMarket({
              platform: 'kalshi',
              external_id: m.ticker,
              question: m.title ?? m.subtitle ?? m.ticker,
              category: 'sports',
              outcome: 'YES',
              closes_at: m.close_time ? new Date(m.close_time) : undefined,
              metadata: { series_ticker: series, event_ticker: m.event_ticker },
            }) ?? undefined;

            this.markets.set(m.ticker, {
              ticker: m.ticker,
              title: m.title ?? m.subtitle ?? m.ticker,
              seriesTicker: series,
              yesAsk: m.yes_ask != null ? m.yes_ask / 100 : null,
              noAsk: m.no_ask != null ? m.no_ask / 100 : null,
              marketDbId: dbId,
            });
          }
        }
      } catch (err: any) {
        if (err.response?.status !== 404) {
          log.debug({ series, status: err.response?.status }, 'Sports series fetch error');
        }
      }
    }
    log.info({ totalSportsMarkets: this.markets.size }, 'Sports market discovery');
  }

  private async heartbeat(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    void recordHeartbeat('sports_latency', getConfig().TRADING_MODE, {
      totalSportsMarkets: this.markets.size,
      withLivePrices: livePriced,
      seriesCovered: SPORTS_SERIES.length,
    });
    if (this.markets.size > 0) {
      const sample = [...this.markets.values()][0];
      void recordSignal({
        strategy: 'sports_latency',
        market_id: sample.marketDbId,
        market_prob: sample.yesAsk ?? undefined,
        reason: 'observation',
        payload: { ticker: sample.ticker, title: sample.title, yesAsk: sample.yesAsk, noAsk: sample.noAsk },
      });
    }
  }

  private async sendActivityPing(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    const samples = [...this.markets.values()]
      .filter((m) => m.yesAsk != null)
      .slice(0, 3)
      .map((m) => `• ${m.title.slice(0, 50)} — YES ${m.yesAsk!.toFixed(2)}`)
      .join('\n');

    await sendDiscord(
      '🏀 Sports latency hourly report',
      `Tracking **${this.markets.size} Kalshi sports markets** across ${SPORTS_SERIES.length} series.\n\nV1 is observing-only - ESPN GameCast integration in V2.`,
      'info',
      [
        { name: 'Markets with live prices', value: livePriced.toString(), inline: true },
        { name: 'Series covered', value: SPORTS_SERIES.length.toString(), inline: true },
        { name: 'Sample markets', value: samples || 'no live markets yet', inline: false },
      ]
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const k = new KalshiConnector();
  await k.connect();
  const strat = new SportsLatencyStrategy(k);
  await strat.start();
  log.info('Sports latency strategy running.');
}
