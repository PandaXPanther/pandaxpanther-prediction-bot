/**
 * DRIP (Dividend Reinvestment Plan) Engine
 *
 * Every 5 minutes: fetch real Kalshi balance, update the risk engine's
 * bankroll. Wins automatically grow future trade sizing. Losses shrink it.
 * Track a high-water mark so drawdowns are visible.
 */

import { KalshiConnector } from '../connectors/kalshi.js';
import { getRiskEngine } from './riskEngine.js';
import { createStrategyLogger } from '../utils/logger.js';
import { sendDiscord } from '../utils/discord.js';
import { recordSignal } from '../db/supabase.js';

const log = createStrategyLogger('drip');

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PROFIT_PING_THRESHOLD = 1.0; // notify on every $1+ gain

export class DripEngine {
  private highWaterMark = 0;
  private lastBalance = 0;
  private startingBalance = 0;
  private totalProfitReinvested = 0;
  private syncCount = 0;

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    const initial = await this.fetchBalance();
    if (initial > 0) {
      this.startingBalance = initial;
      this.highWaterMark = initial;
      this.lastBalance = initial;
      getRiskEngine().setBankroll(initial);
      log.info({ startingBalance: initial }, 'DRIP engine started');
      // No Discord ping on startup - Fly restarts spam the channel.
      // Only ping on actual profit events.
    } else {
      log.warn('DRIP engine: starting balance is 0 - check Kalshi credentials');
    }
    setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
  }

  private async fetchBalance(): Promise<number> {
    try {
      return await this.kalshi.getBalance();
    } catch (err) {
      log.error({ err }, 'DRIP balance fetch failed');
      return this.lastBalance;
    }
  }

  private async sync(): Promise<void> {
    this.syncCount++;
    const balance = await this.fetchBalance();
    if (balance <= 0) return;

    const risk = getRiskEngine();
    const previousBankroll = risk.getStats().bankroll;
    const delta = balance - previousBankroll;

    risk.setBankroll(balance);

    if (balance > this.highWaterMark) {
      const newProfitChunk = balance - this.highWaterMark;
      this.totalProfitReinvested += newProfitChunk;
      this.highWaterMark = balance;

      if (newProfitChunk >= PROFIT_PING_THRESHOLD) {
        const pctReturn = ((balance / this.startingBalance) - 1) * 100;
        await sendDiscord(
          '📈 DRIP: profit reinvested',
          `New high-water mark. Bankroll grown to $${balance.toFixed(2)}.`,
          'success',
          [
            { name: 'This sync gain', value: `+$${newProfitChunk.toFixed(2)}`, inline: true },
            { name: 'Total profit', value: `+$${(balance - this.startingBalance).toFixed(2)}`, inline: true },
            { name: 'Total return', value: `${pctReturn >= 0 ? '+' : ''}${pctReturn.toFixed(2)}%`, inline: true },
            { name: 'Trade sizing bankroll', value: `$${balance.toFixed(2)}`, inline: true },
          ],
        );
      }
    }

    void recordSignal({
      strategy: 'drip',
      reason: 'sync',
      payload: {
        balance,
        previousBankroll,
        delta,
        highWaterMark: this.highWaterMark,
        totalProfitReinvested: this.totalProfitReinvested,
        startingBalance: this.startingBalance,
        syncCount: this.syncCount,
      },
    });

    if (Math.abs(delta) > 0.01) {
      log.info({
        balance,
        previousBankroll,
        delta: delta.toFixed(2),
        highWaterMark: this.highWaterMark,
        totalProfit: (balance - this.startingBalance).toFixed(2),
      }, 'DRIP sync');
    }

    this.lastBalance = balance;
  }

  getStats() {
    return {
      startingBalance: this.startingBalance,
      currentBalance: this.lastBalance,
      highWaterMark: this.highWaterMark,
      totalProfit: this.lastBalance - this.startingBalance,
      totalProfitReinvested: this.totalProfitReinvested,
      syncCount: this.syncCount,
    };
  }
}
