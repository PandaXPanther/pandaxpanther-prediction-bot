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

/**
 * Kalshi prices come in two formats - normalize both.
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

// MAX-AGGRESSIVE (push to noise floor for small-portfolio variance capture):
// Pre-game 6pp (just above ESPN matchup predictor RMSE ~5pp)
// In-game 3pp (ESPN live WP is genuinely sharp, 3pp = real signal)
const MIN_DIVERGENCE_PRE = 0.05;         // half-send: 6pp -> 5pp pre-game
const MIN_DIVERGENCE_IN = 0.02;          // half-send: 3pp -> 2pp in-game

// Reject any bet where divergence > 25pp - that means the model is broken, not the market
const MAX_REASONABLE_DIVERGENCE = 0.25;

function minDivergence(state: 'pre' | 'in' | 'post'): number {
  return state === 'in' ? MIN_DIVERGENCE_IN : MIN_DIVERGENCE_PRE;
}

// EXPANDED sports series coverage
const SPORTS_SERIES = [
  // Game winners
  'KXNBAGAME', 'KXMLBGAME', 'KXNFLGAME', 'KXNHLGAME', 'KXSOCCERGAME',
  'KXWNBAGAME', 'KXNCAAGAME', 'KXNCAAMGAME', 'KXNCAAFGAME',
  // Spreads & totals
  'KXNBASPREAD', 'KXMLBSPREAD', 'KXNFLSPREAD', 'KXNHLSPREAD',
  'KXNBATOTAL', 'KXMLBTOTAL', 'KXNFLTOTAL',
  // Series / playoffs
  'KXNBASERIES', 'KXMLBSERIES', 'KXNHLSERIES',
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
  eventTicker?: string;
  closesAt?: Date;
  fractional?: boolean;
  liquidityUsd?: number;
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
    setInterval(() => this.refreshGames(), 20_000);     // games refresh every 20s (was 30s) - faster for in-game alpha
    setInterval(() => this.refreshLivePrices(), 15_000); // refresh Kalshi prices every 15s (was 20s)
    setInterval(() => this.evaluateAll(), 15_000);       // evaluate every 15s - max actionable cadence
    setInterval(() => this.heartbeat(), 60_000);
    // Activity pings disabled - too noisy. Use dashboard for status.
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
          // HARD FILTER: skip contracts resolving more than MAX_DAYS_TO_RESOLUTION away
          if (m.close_time) {
            const daysOut = (new Date(m.close_time).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
            if (daysOut > config.MAX_DAYS_TO_RESOLUTION) continue;
          }
          if (m.fractional_trading_enabled === true && !config.ALLOW_FRACTIONAL_MARKETS) continue;
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
              category: 'sports',
              outcome: 'YES',
              closes_at: m.close_time ? new Date(m.close_time) : undefined,
              metadata: { series_ticker: series, event_ticker: m.event_ticker },
            }) ?? undefined;
            this.markets.set(m.ticker, {
              ticker: m.ticker,
              title: m.title ?? m.subtitle ?? m.ticker,
              seriesTicker: series,
              eventTicker: m.event_ticker,
              closesAt: m.close_time ? new Date(m.close_time) : undefined,
              fractional: m.fractional_trading_enabled === true,
              liquidityUsd: m.liquidity_dollars ? parseFloat(m.liquidity_dollars) : (m.liquidity != null ? m.liquidity / 100 : undefined),
              league: SERIES_TO_LEAGUE[series],
              yesAsk, noAsk,
              marketDbId: dbId,
            });
            // NOTE: WS subscription removed - was flooding Kalshi WS (449+ markets at once).
            // Sports uses REST polling every 15s which is fine for catching ESPN-vs-Kalshi latency.
          }
        }
      } catch (err: any) {
        if (err.response?.status !== 404) {
          log.debug({ series, status: err.response?.status }, 'Sports series fetch error');
        }
      }
    }
  }

  /**
   * Refresh live YES/NO prices for all known sports markets every ~20s.
   * Crucial for in-game latency arb where ESPN updates win prob continuously.
   */
  private async refreshLivePrices(): Promise<void> {
    const config = getConfig();
    const tickers = [...this.markets.keys()];
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
        log.debug({ err: err.message }, 'Sports price refresh batch failed');
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
   * Kalshi ticker examples:
   *   KXNBAGAME-26MAY19NYKCLE-NYK   (2-digit day, 3+3 team codes)
   *   KXMLBGAME-26MAY222140COLAZ-COL (date + game-id, then 3+2 team codes)
   *   KXNFLGAME-26SEP13DALNYG-NYG    (3+3 team codes)
   * Team codes are 2-4 chars and variable. We split by the LAST team code (after final '-')
   * and try to find the other team code by suffix-matching against the date-stripped middle.
   */
  private linkMarketsToGames(): void {
    let newlyLinked = 0;
    for (const market of this.markets.values()) {
      if (market.espnEventId) continue;  // already linked
      if (!market.league) continue;
      const games = this.gameCache.get(market.league) ?? [];
      if (games.length === 0) continue;

      // Parse YES team (last segment after final '-')
      const parts = market.ticker.split('-');
      if (parts.length < 3) continue;
      const yesTeam = parts[parts.length - 1];
      const middle = parts[1]; // e.g. "26MAY19NYKCLE" or "26MAY222140COLAZ"

      // Try matching against all NON-FINISHED games where both teams appear in the middle string.
      // CRITICAL: skip games in 'post' state - the ESPN API returns 1.0/0.0 (winner) which creates fake huge edges
      const game = games.find((g) => {
        if (g.state === 'post') return false;  // finished game, no live edge
        const upMiddle = middle.toUpperCase();
        const home = g.home.toUpperCase();
        const away = g.away.toUpperCase();
        return upMiddle.includes(home) && upMiddle.includes(away);
      });
      if (!game) continue;

      market.espnEventId = game.event_id;
      market.espnHomeTeam = game.home;
      market.espnAwayTeam = game.away;
      // YES team matches home if yesTeam string matches game.home (case-insensitive, allow prefix)
      market.yesIsHome = yesTeam.toUpperCase() === game.home.toUpperCase()
        || game.home.toUpperCase().startsWith(yesTeam.toUpperCase())
        || yesTeam.toUpperCase().startsWith(game.home.toUpperCase());
      newlyLinked++;
      log.info({ ticker: market.ticker, espn: game.event_id, home: game.home, away: game.away, yesTeam, yesIsHome: market.yesIsHome }, 'Linked Kalshi <-> ESPN');
    }
    if (newlyLinked > 0) log.info({ newlyLinked, totalLinked: [...this.markets.values()].filter(m => m.espnEventId).length }, 'ESPN linking sweep');
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

    // Don't bet on post-game resolved markets (defense-in-depth - linkMarketsToGames also skips them)
    if (state === 'post') return;

    // CRITICAL: reject when ESPN returns near-certain outcomes (within 2pp of 0/1)
    // These are either resolved games or near-resolved with no real edge worth chasing
    if (modelHomeProb >= 0.98 || modelHomeProb <= 0.02) {
      log.debug({ ticker: market.ticker, modelHomeProb }, 'Rejected: ESPN near-certain (likely stale resolved game)');
      return;
    }

    // CRITICAL: reject zero-liquidity markets - no real counterparty
    if (market.liquidityUsd != null && market.liquidityUsd <= 0) {
      log.debug({ ticker: market.ticker, liquidityUsd: market.liquidityUsd }, 'Rejected: zero liquidity (no real market)');
      return;
    }

    // CRITICAL: Reject when ESPN has no real signal (returned 0.500 default)
    // The matchup predictor returns 0.500 exactly when missing data - we'd be betting blind.
    if (Math.abs(modelHomeProb - 0.5) < 0.005) {
      log.debug({ ticker: market.ticker, modelHomeProb }, 'Rejected: ESPN returned 50/50 default - no real signal');
      return;
    }

    // Convert to YES-team probability (the Kalshi YES outcome)
    const modelYesProb = market.yesIsHome ? modelHomeProb : (1 - modelHomeProb);
    const marketMid = (market.yesAsk + (1 - market.noAsk)) / 2;
    const divergence = modelYesProb - marketMid;

    if (Math.abs(divergence) < minDivergence(state)) return;

    // CRITICAL: cap max divergence - anything over 25pp means our model is wrong, not the market.
    if (Math.abs(divergence) > MAX_REASONABLE_DIVERGENCE) {
      log.warn({ ticker: market.ticker, divergence, modelYesProb, marketMid }, 'Rejected: divergence too extreme, model likely broken');
      return;
    }

    this.opportunitiesSeen++;

    const side: 'YES' | 'NO' = divergence > 0 ? 'YES' : 'NO';
    const entryPrice = side === 'YES' ? market.yesAsk : market.noAsk;
    if (entryPrice >= 0.98 || entryPrice <= 0.02) return;

    const risk = getRiskEngine();
    const kellyFrac = risk.kellySize(modelYesProb, marketMid, side);
    if (kellyFrac < 0.002) return;
    const sizeUsd = kellyFrac * risk.getStats().bankroll;
    const check = risk.canTrade('sports_latency', market.ticker, sizeUsd, {
      closesAt: market.closesAt,
      eventTicker: market.eventTicker,
      fractional: market.fractional,
      liquidityUsd: market.liquidityUsd,
    });
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

    // Don't ping on signal - only ping on actual fills (below)
    if (false && shouldPingPaperFills()) {
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
        risk.recordDeployment('sports_latency', market.ticker, check.sizeUsd, market.eventTicker);
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
