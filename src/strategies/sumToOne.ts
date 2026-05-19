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
import type { OrderBook } from '../connectors/types.js';

const log = createStrategyLogger('sum_to_one');

// Trigger threshold: combined best ask must be at or below this for a trade
const TRIGGER_SUM = 0.97;  // 3% gross edge minimum
const TAKER_FEE_BPS = 0;   // Polymarket sports/event taker fees vary; calibrate from live data
const MIN_EDGE_AFTER_FEES = 0.015; // 1.5% minimum net edge

interface MarketPair {
  conditionId: string;
  yesToken: string;
  noToken: string;
  question: string;
  yesBook?: OrderBook;
  noBook?: OrderBook;
}

export class SumToOneStrategy {
  private pairs = new Map<string, MarketPair>();

  constructor(private polymarket: PolymarketConnector) {}

  async start(): Promise<void> {
    log.info('Sum-to-one strategy starting');
    await this.discoverAndSubscribe();
    setInterval(() => this.discoverAndSubscribe(), 15 * 60 * 1000); // refresh every 15 min
  }

  private async discoverAndSubscribe(): Promise<void> {
    const markets = await this.polymarket.listActiveMarkets();
    log.info({ count: markets.length }, 'Discovered Polymarket markets');

    // Filter for high-volume / liquid markets only (binary markets with both tokens)
    const viable = markets.filter(
      (m) => m.yes_token && m.no_token && m.closesAt && m.closesAt.getTime() > Date.now()
    );

    let newCount = 0;
    for (const m of viable.slice(0, 200)) { // cap subscriptions
      if (this.pairs.has(m.externalId)) continue;
      const pair: MarketPair = {
        conditionId: m.externalId,
        yesToken: m.yes_token!,
        noToken: m.no_token!,
        question: m.question,
      };
      this.pairs.set(m.externalId, pair);

      await this.polymarket.subscribeOrderBook(m.yes_token!, (book) => {
        pair.yesBook = book;
        this.checkArbitrage(pair);
      });
      await this.polymarket.subscribeOrderBook(m.no_token!, (book) => {
        pair.noBook = book;
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

    if (sum >= TRIGGER_SUM) return;

    // We have a candidate. Compute size and check fees.
    const grossEdge = 1.0 - sum;
    const fees = (TAKER_FEE_BPS / 10000) * 2; // both sides
    const netEdge = grossEdge - fees;
    if (netEdge < MIN_EDGE_AFTER_FEES) return;

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
