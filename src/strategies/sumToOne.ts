/**
 * STRATEGY: Sum-to-One Arbitrage (Polymarket only)
 *
 * THESIS:
 *   For any binary market, the price of YES + the price of NO must equal $1.00
 *   at settlement. When briefly, due to thin liquidity or stale orders,
 *   BEST_ASK(YES) + BEST_ASK(NO) < 1.00, we can buy both sides at a
 *   guaranteed locked-in profit equal to (1.00 - sum_of_asks - fees).
 *
 * EXECUTION:
 *   1. Stream order books for both YES and NO tokens of a market
 *   2. On every update, check: best_ask(YES) + best_ask(NO) < threshold?
 *   3. If yes, fire FOK orders for both sides simultaneously
 *   4. Profit booked as soon as both fill
 *
 * IMPORTANT NOTES:
 *   - On Polymarket, YES and NO are SEPARATE token IDs in the same condition
 *   - We use taker fees here, so the spread must beat fees (~1-2%)
 *   - Strict size matching: must fill identical size on both sides
 *   - Race risk: if only one side fills, hold inventory until next opportunity
 */

import { PolymarketConnector } from '../connectors/polymarket.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { isPermissive, getConfig } from '../utils/config.js';
import { upsertMarket, recordSignal, recordOrder, recordHeartbeat } from '../db/supabase.js';
import type { OrderBook } from '../connectors/types.js';

const log = createStrategyLogger('sum_to_one');

// Production thresholds: tight, only fire on real edge
const TRIGGER_SUM_PROD = 0.97;          // 3% gross edge minimum
const MIN_EDGE_AFTER_FEES_PROD = 0.015; // 1.5% minimum net edge
// Permissive thresholds for accelerated paper-trading discovery
const TRIGGER_SUM_PERMISSIVE = 0.995;          // 0.5% gross edge
const MIN_EDGE_AFTER_FEES_PERMISSIVE = 0.002;  // 0.2% net edge

const TAKER_FEE_BPS = 0;   // Polymarket sports/event taker fees vary; calibrate from live data

const getTriggerSum = () => (isPermissive() ? TRIGGER_SUM_PERMISSIVE : TRIGGER_SUM_PROD);
const getMinEdge = () => (isPermissive() ? MIN_EDGE_AFTER_FEES_PERMISSIVE : MIN_EDGE_AFTER_FEES_PROD);

interface MarketPair {
  conditionId: string;
  yesToken: string;
  noToken: string;
  question: string;
  yesBook?: OrderBook;
  noBook?: OrderBook;
  yesMarketDbId?: string;   // Supabase markets.id
  noMarketDbId?: string;
  closesAt?: Date;
}

export class SumToOneStrategy {
  private pairs = new Map<string, MarketPair>();
  private bookUpdateCount = 0;
  private opportunitiesSeen = 0;
  private bestSumSeen = 2;          // running minimum of (yesAsk + noAsk)
  private bestSumQuestion = '';
  // Rolling tightest-sum tracker reset on each Discord ping interval
  private intervalBestSum = 2;
  private intervalBestQuestion = '';
  private intervalBestYesAsk = 0;
  private intervalBestNoAsk = 0;
  private intervalBookUpdates = 0;

  constructor(private polymarket: PolymarketConnector) {}

  async start(): Promise<void> {
    log.info('Sum-to-one strategy starting');
    await this.discoverAndSubscribe();
    setInterval(() => this.discoverAndSubscribe(), 15 * 60 * 1000); // refresh every 15 min

    // Periodic visibility into how alive the strategy is + persist heartbeat
    setInterval(() => {
      const pairsWithBooks = [...this.pairs.values()].filter(
        (p) => p.yesBook?.bestAsk || p.noBook?.bestAsk
      ).length;
      const pairsWithBothSides = [...this.pairs.values()].filter(
        (p) => p.yesBook?.bestAsk && p.noBook?.bestAsk
      ).length;
      const payload = {
        totalPairs: this.pairs.size,
        pairsWithAnyBook: pairsWithBooks,
        pairsWithBothSides,
        bookUpdates: this.bookUpdateCount,
        opportunitiesAboveThreshold: this.opportunitiesSeen,
        bestSumSeen: Number(this.bestSumSeen.toFixed(4)),
        bestMarket: this.bestSumQuestion.slice(0, 100),
      };
      void recordHeartbeat('sum_to_one', getConfig().TRADING_MODE, payload);
    }, 60_000);

    // Hourly "liveness" Discord ping with the tightest spread we saw this hour
    setInterval(() => this.sendActivityPing(), 60 * 60 * 1000);
  }

  /**
   * Periodic Discord ping showing the bot is alive and what the markets
   * looked like in the past interval. Helps you see activity even when
   * nothing's actionable.
   */
  private async sendActivityPing(): Promise<void> {
    const pairsWithBoth = [...this.pairs.values()].filter(
      (p) => p.yesBook?.bestAsk && p.noBook?.bestAsk
    ).length;
    const overspread = this.intervalBestSum - 1.0;
    const label = overspread <= 0
      ? `🟢 ARB! ${(-overspread * 100).toFixed(2)}% under fair`
      : `⚪ Tightest seen: ${(overspread * 100).toFixed(2)}% over fair`;

    await sendDiscord(
      '📊 Sum-to-one hourly report',
      `Monitoring **${this.pairs.size} markets** (${pairsWithBoth} with both sides live).\n\n${label}`,
      overspread <= 0 ? 'success' : 'info',
      [
        { name: 'Tightest market', value: this.intervalBestQuestion.slice(0, 120) || 'none yet', inline: false },
        { name: 'YES ask', value: this.intervalBestYesAsk ? this.intervalBestYesAsk.toFixed(4) : '-', inline: true },
        { name: 'NO ask', value: this.intervalBestNoAsk ? this.intervalBestNoAsk.toFixed(4) : '-', inline: true },
        { name: 'Sum', value: this.intervalBestSum.toFixed(4), inline: true },
        { name: 'Book updates / hr', value: this.intervalBookUpdates.toLocaleString(), inline: true },
        { name: 'Mode', value: getConfig().TRADING_MODE.toUpperCase(), inline: true },
      ]
    );

    // Reset interval trackers
    this.intervalBestSum = 2;
    this.intervalBestQuestion = '';
    this.intervalBestYesAsk = 0;
    this.intervalBestNoAsk = 0;
    this.intervalBookUpdates = 0;
  }

  private async discoverAndSubscribe(): Promise<void> {
    const markets = await this.polymarket.listActiveMarkets();
    log.info({ count: markets.length }, 'Discovered Polymarket markets');

    // Filter for high-volume / liquid markets only (binary markets with both tokens)
    const viable = markets.filter(
      (m) => m.yes_token && m.no_token && m.closesAt && m.closesAt.getTime() > Date.now()
    );

    let newCount = 0;
    for (const m of viable.slice(0, 100)) { // cap subscriptions to top-volume markets
      if (this.pairs.has(m.externalId)) continue;
      const pair: MarketPair = {
        conditionId: m.externalId,
        yesToken: m.yes_token!,
        noToken: m.no_token!,
        question: m.question,
        closesAt: m.closesAt,
      };
      this.pairs.set(m.externalId, pair);

      // Persist both market sides to Supabase
      pair.yesMarketDbId = await upsertMarket({
        platform: 'polymarket',
        external_id: m.yes_token!,
        question: m.question,
        outcome: 'YES',
        closes_at: m.closesAt,
        metadata: { conditionId: m.externalId },
      }) ?? undefined;
      pair.noMarketDbId = await upsertMarket({
        platform: 'polymarket',
        external_id: m.no_token!,
        question: m.question,
        outcome: 'NO',
        closes_at: m.closesAt,
        metadata: { conditionId: m.externalId },
      }) ?? undefined;

      await this.polymarket.subscribeOrderBook(m.yes_token!, (book) => {
        pair.yesBook = book;
        this.bookUpdateCount++;
        this.checkArbitrage(pair);
      });
      await this.polymarket.subscribeOrderBook(m.no_token!, (book) => {
        pair.noBook = book;
        this.bookUpdateCount++;
        this.checkArbitrage(pair);
      });
      newCount++;
    }
    if (newCount > 0) log.info({ newCount }, 'Subscribed to new market pairs');
  }

  private inFlight = new Set<string>();

  private async checkArbitrage(pair: MarketPair): Promise<void> {
    if (!pair.yesBook?.bestAsk || !pair.noBook?.bestAsk) return;
    if (this.inFlight.has(pair.conditionId)) return;

    const yesAsk = pair.yesBook.bestAsk.price;
    const noAsk = pair.noBook.bestAsk.price;
    const sum = yesAsk + noAsk;

    // Track tightest sum even when not actionable - useful for understanding markets
    if (sum < this.bestSumSeen) {
      this.bestSumSeen = sum;
      this.bestSumQuestion = pair.question;
    }
    if (sum < this.intervalBestSum) {
      this.intervalBestSum = sum;
      this.intervalBestQuestion = pair.question;
      this.intervalBestYesAsk = yesAsk;
      this.intervalBestNoAsk = noAsk;
    }
    this.intervalBookUpdates++;

    if (sum >= getTriggerSum()) return;

    this.opportunitiesSeen++;

    // We have a candidate. Compute size and check fees.
    const grossEdge = 1.0 - sum;
    const fees = (TAKER_FEE_BPS / 10000) * 2; // both sides
    const netEdge = grossEdge - fees;

    // Record EVERY opportunity (acted or not) for backtest / analysis
    const signalId = await recordSignal({
      strategy: 'sum_to_one',
      market_id: pair.yesMarketDbId,
      cross_market_id: pair.noMarketDbId,
      edge_bps: Math.round(grossEdge * 10000),
      market_prob: yesAsk,
      recommended_size_usd: Math.min(pair.yesBook.bestAsk.size, pair.noBook.bestAsk.size) * Math.max(yesAsk, noAsk),
      side: 'ARB_BUY_BOTH',
      reason: netEdge < getMinEdge() ? 'below_min_edge' : 'actionable',
      payload: { yesAsk, noAsk, sum, grossEdge, netEdge, question: pair.question },
    });

    if (netEdge < getMinEdge()) return;

    // Determine size = min(yes ask depth, no ask depth)
    const maxSize = Math.min(pair.yesBook.bestAsk.size, pair.noBook.bestAsk.size);
    const notional = maxSize * Math.max(yesAsk, noAsk); // approx USD at risk per side

    const risk = getRiskEngine();
    const check = risk.canTrade('sum_to_one', pair.conditionId, notional);
    if (!check.allowed) {
      log.debug({ reason: check.reason }, 'Risk check failed');
      return;
    }

    // Scale size to risk-allowed notional
    const sizeToTrade = Math.min(maxSize, check.sizeUsd / Math.max(yesAsk, noAsk));
    if (sizeToTrade < 5) return; // dust filter

    this.inFlight.add(pair.conditionId);
    log.info(
      { question: pair.question, yesAsk, noAsk, sum, netEdge, size: sizeToTrade },
      'Sum-to-one opportunity detected'
    );

    try {
      // Fire both sides as FOK simultaneously
      const [yesResult, noResult] = await Promise.all([
        this.polymarket.placeOrder({
          externalId: pair.yesToken,
          outcome: 'YES',
          side: 'BUY',
          orderType: 'FOK',
          price: yesAsk,
          size: sizeToTrade,
        }),
        this.polymarket.placeOrder({
          externalId: pair.noToken,
          outcome: 'YES', // NO token's "YES" outcome
          side: 'BUY',
          orderType: 'FOK',
          price: noAsk,
          size: sizeToTrade,
        }),
      ]);

      const mode = getConfig().TRADING_MODE;
      // Persist both orders
      void recordOrder({
        signal_id: signalId ?? undefined,
        market_id: pair.yesMarketDbId,
        strategy: 'sum_to_one',
        mode,
        side: 'BUY',
        order_type: 'FOK',
        price: yesAsk,
        size: sizeToTrade,
        outcome: 'YES',
        external_order_id: yesResult.externalOrderId,
        status: (yesResult.filled ?? 0) > 0 ? 'filled' : 'rejected',
        filled_size: yesResult.filled ?? 0,
        avg_fill_price: yesResult.avgPrice,
      });
      void recordOrder({
        signal_id: signalId ?? undefined,
        market_id: pair.noMarketDbId,
        strategy: 'sum_to_one',
        mode,
        side: 'BUY',
        order_type: 'FOK',
        price: noAsk,
        size: sizeToTrade,
        outcome: 'NO',
        external_order_id: noResult.externalOrderId,
        status: (noResult.filled ?? 0) > 0 ? 'filled' : 'rejected',
        filled_size: noResult.filled ?? 0,
        avg_fill_price: noResult.avgPrice,
      });

      const yesFilled = yesResult.ok && (yesResult.filled ?? 0) > 0;
      const noFilled = noResult.ok && (noResult.filled ?? 0) > 0;

      if (yesFilled && noFilled) {
        const profit = sizeToTrade * netEdge;
        risk.recordDeployment('sum_to_one', pair.conditionId, notional);
        await risk.recordPnl('sum_to_one', profit, pair.conditionId);
        await sendDiscord(
          '💰 Sum-to-one arb filled',
          pair.question,
          'success',
          [
            { name: 'YES ask', value: yesAsk.toFixed(4), inline: true },
            { name: 'NO ask', value: noAsk.toFixed(4), inline: true },
            { name: 'Size', value: sizeToTrade.toFixed(2), inline: true },
            { name: 'Profit', value: `$${profit.toFixed(2)}`, inline: true },
          ]
        );
      } else if (yesFilled !== noFilled) {
        log.warn({ yesFilled, noFilled }, 'One-legged fill - exposure!');
        await sendDiscord(
          '⚠️ Sum-to-one one-legged fill',
          `${pair.question}\nYES: ${yesFilled} / NO: ${noFilled}`,
          'warn'
        );
      }
    } catch (err) {
      log.error({ err }, 'Order placement error');
    } finally {
      // Brief cooldown to avoid duplicate fires on same opportunity
      setTimeout(() => this.inFlight.delete(pair.conditionId), 2000);
    }
  }
}

// Stand-alone entry point: `npm run strategy:sum-to-one`
if (import.meta.url === `file://${process.argv[1]}`) {
  const pm = new PolymarketConnector();
  await pm.connect();
  const strat = new SumToOneStrategy(pm);
  await strat.start();
  log.info('Sum-to-one strategy running. Ctrl+C to stop.');
}
