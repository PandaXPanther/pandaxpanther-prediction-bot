/**
 * STRATEGY: Sports Latency (Kalshi) — V2 with ESPN model wiring
 *
 * NOW LIVE:
 *   - Pulls live games from ESPN scoreboard for NBA/MLB/NFL/NHL/WNBA
 *   - For each game, queries Python quant service /sports/win-prob
 *     (pre-game: ESPN Matchup Predictor; in-game: live winprobability)
 *   - Matches each ESPN game to its Kalshi market by team abbreviation
 *   - Bets when divergence > threshold
 *
 * EDGE:
 *   ESPN's in-game win probability is genuinely accurate (calibrated against
 *   millions of games). Kalshi sports markets often lag by 30s-2min during
 *   active games. Pre-game, ESPN's matchup predictor is "medium" quality —
 *   we use a higher threshold to compensate.
 */

import { KalshiConnector } from '../connectors/kalshi.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig, isPermissive, shouldPingPaperFills, isAggressive } from '../utils/config.js';
import { upsertMarket, recordHeartbeat, recordSignal, recordOrder } from '../db/supabase.js';
import axios from 'axios';

const log = createStrategyLogger('sports_latency');

// Higher minimums than weather/nowcast because ESPN pregame model is OK but not great
const MIN_DIVERGENCE_PROD_PRE = 0.12;        // 12pp pre-game
const MIN_DIVERGENCE_PROD_IN = 0.06;         // 6pp in-game (ESPN WP is much sharper live)
const MIN_DIVERGENCE_PERMISSIVE = 0.04;      // 4pp in permissive

function minDivergence(state: 'pre' | 'in' | 'post'): number {
  if (isPermissive() || isAggressive()) return MIN_DIVERGENCE_PERMISSIVE;
  return state === 'in' ? MIN_DIVERGENCE_PROD_IN : MIN_DIVERGENCE_PROD_PRE;
}

const SPORTS_SERIES = [
  'KXNBAGAME', 'KXMLBGAME', 'KXNFLGAME', 'KXNHLGAME', 'KXSOCCERGAME',
  'KXNBASPREAD', 'KXMLBSPREAD',
];

const SERIES_TO_LEAGUE: Record<string, 'nba' | 'mlb' | 'nfl' | 'nhl' | 'wnba'> = {
  KXNBAGAME: 'nba',
  KXMLBGAME: 'mlb',
  KXNFLGAME: 'nfl',
  KXNHLGAME: 'nhl',
};

interface SportsMarket {
  ticker: string;
  title: string;
  seriesTicker: string;
  league?: 'nba' | 'mlb' | 'nfl' | 'nhl' | 'wnba';
  yesAsk: number | null;
  noAsk: number | null;
  marketDbId?: string;
  // Linked to an ESPN game once matched
  espnEventId?: string;
  espnHomeTeam?: string;
  espnAwayTeam?: string;
  // Side mapping: which Kalshi outcome (YES/NO) maps to which ESPN team
  yesIsHome?: boolean;
}

interface GameInfo {
  event_id: string;
  name: string;
  state: 'pre' | 'in' | 'post';
  home: string;
  away: string;
  home_score: number;
  away_score: number;
}

export class SportsLatencyStrategy {
  private markets = new Map<string, SportsMarket>();
  private gameCache = new Map<string, GameInfo[]>();  // league -> games
  private opportunitiesSeen = 0;
  private inFlight = new Set<string>();

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    log.info({ series: SPORTS_SERIES.length }, 'Sports latency strategy V2 starting');
    await this.discoverMarkets();
    await this.refreshGames();
    setInterval(() => this.discoverMarkets(), 5 * 60 * 1000);
    setInterval(() => this.refreshGames(), 60_000);  // games refresh every 60s
    setInterval(() => this.evaluateAll(), 90_000);   // evaluate every 90s
    setInterval(() => this.heartbeat(), 60_000);
    setInterval(() => this.sendActivityPing(), 15 * 60 * 1000)  // 15 min for permissive paper visibility;
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
        for (const m of r.data?.markets ?? []) {
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
              category: 'sports',
              outcome: 'YES',
              closes_at: m.close_time ? new Date(m.close_time) : undefined,
              metadata: { series_ticker: series, event_ticker: m.event_ticker },
            }) ?? undefined;
            this.markets.set(m.ticker, {
              ticker: m.ticker,
              title: m.title ?? m.subtitle ?? m.ticker,
              seriesTicker: series,
              league: SERIES_TO_LEAGUE[series],
              yesAsk, noAsk,
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
  }

  private async refreshGames(): Promise<void> {
    const config = getConfig();
    const leagues: ('nba' | 'mlb' | 'nfl' | 'nhl')[] = ['nba', 'mlb', 'nfl', 'nhl'];
    for (const league of leagues) {
      try {
        const { data } = await axios.get(`${config.QUANT_SERVICE_URL}/sports/games`, {
          params: { league },
          timeout: 10000,
        });
        this.gameCache.set(league, data.games ?? []);
      } catch (err: any) {
        log.debug({ league, err: err.message }, 'ESPN games refresh failed');
      }
    }
    // Re-link markets to games
    this.linkMarketsToGames();
  }

  /**
   * Try to match each Kalshi market to an ESPN game.
   * Kalshi ticker example: KXNBAGAME-26MAY19NYKCLE-NYK
   * We extract team codes and find the ESPN game with matching abbreviations.
   */
  private linkMarketsToGames(): void {
    for (const market of this.markets.values()) {
      if (market.espnEventId) continue;  // already linked
      if (!market.league) continue;
      const games = this.gameCache.get(market.league) ?? [];

      // Parse team codes from the ticker
      // Kalshi tickers like KXNBAGAME-26MAY19NYKCLE-NYK
      const m = market.ticker.match(/-\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})-([A-Z]{3})/);
      if (!m) continue;
      const teamA = m[1], teamB = m[2], yesTeam = m[3];

      // Find matching ESPN game
      const game = games.find((g) =>
        (g.home === teamA && g.away === teamB) || (g.home === teamB && g.away === teamA)
      );
      if (!game) continue;

      market.espnEventId = game.event_id;
      market.espnHomeTeam = game.home;
      market.espnAwayTeam = game.away;
      market.yesIsHome = (yesTeam === game.home);
      log.info({ ticker: market.ticker, espn: game.event_id, home: game.home, away: game.away, yesIsHome: market.yesIsHome }, 'Linked Kalshi <-> ESPN');
    }
  }

  private async evaluateAll(): Promise<void> {
    for (const m of this.markets.values()) {
      await this.evaluate(m);
    }
  }

  private async evaluate(market: SportsMarket): Promise<void> {
    if (this.inFlight.has(market.ticker)) return;
    if (!market.espnEventId || !market.league) return;
    if (market.yesAsk == null || market.noAsk == null) return;
    if (market.yesIsHome == null) return;

    // Get model win probability from ESPN
    const config = getConfig();
    let modelHomeProb: number;
    let state: 'pre' | 'in' | 'post';
    try {
      const { data } = await axios.get(`${config.QUANT_SERVICE_URL}/sports/win-prob`, {
        params: { league: market.league, event_id: market.espnEventId },
        timeout: 10000,
      });
      modelHomeProb = data.home_win_prob;
      state = data.state;
    } catch (err: any) {
      log.debug({ ticker: market.ticker, err: err.message }, 'ESPN win-prob lookup failed');
      return;
    }

    // Don't bet on post-game resolved markets
    if (state === 'post') return;

    // Convert to YES-team probability (the Kalshi YES outcome)
    const modelYesProb = market.yesIsHome ? modelHomeProb : (1 - modelHomeProb);
    const marketMid = (market.yesAsk + (1 - market.noAsk)) / 2;
    const divergence = modelYesProb - marketMid;

    if (Math.abs(divergence) < minDivergence(state)) return;

    this.opportunitiesSeen++;

    const side: 'YES' | 'NO' = divergence > 0 ? 'YES' : 'NO';
    const entryPrice = side === 'YES' ? market.yesAsk : market.noAsk;
    if (entryPrice >= 0.98 || entryPrice <= 0.02) return;

    const risk = getRiskEngine();
    const kellyFrac = risk.kellySize(modelYesProb, marketMid, side);
    if (kellyFrac < 0.002) return;
    const sizeUsd = kellyFrac * risk.getStats().bankroll;
    const check = risk.canTrade('sports_latency', market.ticker, sizeUsd);
    if (!check.allowed) return;
    const sizeContracts = Math.floor(check.sizeUsd / entryPrice);
    if (sizeContracts < 1) return;

    const signalId = await recordSignal({
      strategy: 'sports_latency',
      market_id: market.marketDbId,
      edge_bps: Math.round(Math.abs(divergence) * 10000),
      model_prob: modelYesProb,
      market_prob: marketMid,
      recommended_size_usd: sizeUsd,
      side,
      reason: `model_divergence_${state}`,
      payload: {
        ticker: market.ticker,
        title: market.title,
        league: market.league,
        state,
        divergence,
        sizeContracts,
      },
    });

    this.inFlight.add(market.ticker);
    log.info({ ticker: market.ticker, state, modelYesProb, marketMid, divergence, side, sizeContracts }, 'Sports signal');

    if (shouldPingPaperFills()) {
      await sendDiscord(
        `🔔 Sports signal (${state})`,
        market.title,
        'success',
        [
          { name: 'ESPN home WP', value: market.yesIsHome ? modelYesProb.toFixed(3) : (1 - modelYesProb).toFixed(3), inline: true },
          { name: 'Kalshi mid', value: marketMid.toFixed(3), inline: true },
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
        orderType: 'IOC',
        price: entryPrice,
        size: sizeContracts,
      });
      const mode = getConfig().TRADING_MODE;
      void recordOrder({
        signal_id: signalId ?? undefined,
        market_id: market.marketDbId,
        strategy: 'sports_latency',
        mode, side: 'BUY', order_type: 'IOC',
        price: entryPrice, size: sizeContracts, outcome: side,
        external_order_id: result.externalOrderId,
        status: result.ok ? 'open' : 'rejected',
        filled_size: result.filled ?? 0,
      });
      if (result.ok) {
        risk.recordDeployment('sports_latency', market.ticker, check.sizeUsd);
        await sendDiscord(
          '🏀 Sports bet placed',
          `${market.title} (${state})`,
          'info',
          [
            { name: 'Model (YES)', value: modelYesProb.toFixed(3), inline: true },
            { name: 'Market mid', value: marketMid.toFixed(3), inline: true },
            { name: 'Side', value: side, inline: true },
            { name: 'Size', value: `${sizeContracts} @ ${entryPrice.toFixed(2)}`, inline: true },
          ]
        );
      }
    } catch (err) {
      log.error({ err }, 'Sports order error');
    } finally {
      setTimeout(() => this.inFlight.delete(market.ticker), 30_000);
    }
  }

  private async heartbeat(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    const linked = [...this.markets.values()].filter((m) => m.espnEventId != null).length;
    void recordHeartbeat('sports_latency', getConfig().TRADING_MODE, {
      totalSportsMarkets: this.markets.size,
      withLivePrices: livePriced,
      linkedToESPN: linked,
      opportunitiesSeen: this.opportunitiesSeen,
      activeGames: [...this.gameCache.values()].flat().filter((g) => g.state === 'in').length,
    });
  }

  private async sendActivityPing(): Promise<void> {
    const livePriced = [...this.markets.values()].filter((m) => m.yesAsk != null).length;
    const linked = [...this.markets.values()].filter((m) => m.espnEventId != null).length;
    const activeGames = [...this.gameCache.values()].flat().filter((g) => g.state === 'in').length;
    await sendDiscord(
      '🏀 Sports latency hourly report',
      `Tracking **${this.markets.size} Kalshi sports markets** across NBA/MLB/NFL/NHL.`,
      'info',
      [
        { name: 'Markets with prices', value: livePriced.toString(), inline: true },
        { name: 'Linked to ESPN game', value: linked.toString(), inline: true },
        { name: 'Active games now', value: activeGames.toString(), inline: true },
        { name: 'Signals fired', value: this.opportunitiesSeen.toString(), inline: true },
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
