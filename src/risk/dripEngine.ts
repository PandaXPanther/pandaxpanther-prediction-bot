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

// Sync every 2 min instead of 5 — keeps dashboard balance closer to Kalshi truth
// during settlement-heavy hours. Cost: 30 extra API calls/hr, well under rate limit.
const SYNC_INTERVAL_MS = 2 * 60 * 1000;
const PROFIT_PING_THRESHOLD = 1.0; // notify on every $1+ gain

export class DripEngine {
  private highWaterMark = 0;
  // intradayHigh resets at 00:00 UTC each day. Tracks high since today started.
  private intradayHigh = 0;
  // v1 MED-13: ISO YYYY-MM-DD instead of UTC day-of-month (1-31), which collides
  // every 28-31 days and falsely held the prior month's intradayHigh on day-of-month
  // rollover-without-change-detection.
  private intradayHighDay = '';
  private lastBalance = 0;
  private startingBalance = 0;
  private totalProfitReinvested = 0;
  private syncCount = 0;
  // 2026-05-22 v3: counter that increments each time we observe a drawdown > $100
  // and resets to 0 when equity recovers. Kill switch only fires after the counter
  // hits CONSECUTIVE_DROPS_REQUIRED, so a single sync glitch (Kalshi positions
  // endpoint returning partial data, transient network failure, etc.) can't trip it.
  private consecutiveDrawdownCycles = 0;

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    // H-7 fix: refuse to arm drawdown checks until we have a real non-zero balance.
    // Otherwise getBalance() returning 0 on transient auth/network error would
    // bootstrap startingBalance=0 and the next sync would either divide-by-zero
    // on pctReturn or report Infinity% on the first profit ping. Retry up to a
    // few times before giving up and letting sync() take over.
    let initial = 0;
    for (let attempt = 1; attempt <= 3; attempt++) {
      initial = await this.fetchBalance();
      if (initial > 0) break;
      log.warn({ attempt }, 'DRIP engine: starting balance is 0 — retrying in 5s');
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (initial > 0) {
      this.startingBalance = initial;
      this.highWaterMark = initial;
      this.lastBalance = initial;
      getRiskEngine().setBankroll(initial);
      log.info({ startingBalance: initial }, 'DRIP engine started');
      // No Discord ping on startup - Fly restarts spam the channel.
      // Only ping on actual profit events.
    } else {
      log.error('DRIP engine: starting balance still 0 after retries — drawdown breaker WILL NOT arm until first non-zero sync');
    }
    setInterval(() => void this.sync(), SYNC_INTERVAL_MS);
  }

  private async fetchBalance(): Promise<number> {
    // CRITICAL 2026-05-22: switched from getBalance() (cash only) to getTotalEquity()
    // (cash + mark-to-market positions). Cash-only tracking caused the drawdown
    // kill switch to trip every time a LIP/limit order filled, because cash dropped
    // ~$50-150 but the equivalent value moved into shares (not lost). Now
    // "balance" reflects true bot equity; LIP fills are equity-neutral.
    try {
      return await this.kalshi.getTotalEquity();
    } catch (err) {
      log.error({ err }, 'DRIP equity fetch failed');
      return this.lastBalance;
    }
  }

  private async sync(): Promise<void> {
    this.syncCount++;
    const balance = await this.fetchBalance();
    if (balance <= 0) return;

    // H-7 fix: bootstrap startingBalance / highWaterMark on the first non-zero sync
    // if start() couldn't arm them (e.g. Kalshi auth transient on boot). Without this,
    // pctReturn = (balance / 0 - 1) * 100 = Infinity% on the first profit ping.
    if (this.startingBalance === 0) {
      this.startingBalance = balance;
      this.highWaterMark = balance;
      this.lastBalance = balance;
      getRiskEngine().setBankroll(balance);
      log.info({ startingBalance: balance }, 'DRIP engine: late-bootstrap on first non-zero sync');
    }

    // Reset intradayHigh at UTC midnight (v1 MED-13: ISO date, not day-of-month).
    const utcDay = new Date().toISOString().slice(0, 10);
    if (utcDay !== this.intradayHighDay) {
      this.intradayHighDay = utcDay;
      this.intradayHigh = balance;
    }
    if (balance > this.intradayHigh) this.intradayHigh = balance;

    const risk = getRiskEngine();
    const previousBankroll = risk.getStats().bankroll;
    const delta = balance - previousBankroll;

    risk.setBankroll(balance);

    // DRAWDOWN KILL SWITCH (Kalshi-truth-based, not trade-grade-based).
    // The trade-grading kill switch in adaptiveController has had bugs (false
    // negatives where losses were marked as wins). This is a backup that watches
    // actual Kalshi TOTAL EQUITY (cash + position value).
    //
    // 2026-05-22 v2: raised from $50 to $100 because LIP/sports strategies routinely
    // lock in $30-80 of shares which causes brief equity swings that aren't losses.
    // True drawdown > $100 of marked-to-market value is the real warning threshold.
    // 2026-05-22 v3: require 2 CONSECUTIVE sync cycles with drawdown > $100 before
    // firing. A single bad sync can show $300+ false drawdown when Kalshi's
    // /portfolio/positions returns partial pagination data. Real drawdowns persist.
    const CONSECUTIVE_DROPS_REQUIRED = 2;
    const DRAWDOWN_THRESHOLD = 100;
    const intradayDrawdown = this.intradayHigh - balance;
    if (intradayDrawdown > DRAWDOWN_THRESHOLD) {
      this.consecutiveDrawdownCycles++;
      log.warn({
        intradayHigh: this.intradayHigh,
        currentBalance: balance,
        drawdown: intradayDrawdown.toFixed(2),
        consecutiveCycles: this.consecutiveDrawdownCycles,
        threshold: CONSECUTIVE_DROPS_REQUIRED,
      }, 'Drawdown observed — waiting for confirmation before kill switch');
      if (this.consecutiveDrawdownCycles >= CONSECUTIVE_DROPS_REQUIRED && process.env.TRADING_MODE === 'live') {
        log.fatal({
          intradayHigh: this.intradayHigh,
          currentBalance: balance,
          drawdown: intradayDrawdown.toFixed(2),
          confirmedCycles: this.consecutiveDrawdownCycles,
        }, '🚨 DRAWDOWN KILL SWITCH — confirmed over multiple cycles, forcing paper mode');
        process.env.TRADING_MODE = 'paper';
        getRiskEngine().forceKill(
          `drip-drawdown $${intradayDrawdown.toFixed(2)} (high $${this.intradayHigh.toFixed(2)} → $${balance.toFixed(2)}, ${this.consecutiveDrawdownCycles} cycles)`,
        );
      }
    } else {
      // Equity recovered — reset the counter
      if (this.consecutiveDrawdownCycles > 0) {
        log.info({ recovered: balance, prevDrops: this.consecutiveDrawdownCycles }, 'Drawdown recovered, resetting counter');
      }
      this.consecutiveDrawdownCycles = 0;
    }

    if (balance > this.highWaterMark) {
      const newProfitChunk = balance - this.highWaterMark;
      this.totalProfitReinvested += newProfitChunk;
      this.highWaterMark = balance;
      this.intradayHigh = balance;

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
