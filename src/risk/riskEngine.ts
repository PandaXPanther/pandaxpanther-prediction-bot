import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getSupabase } from '../db/supabase.js';
import { sendDiscord } from '../utils/discord.js';

/**
 * Risk engine.
 *
 * Owns:
 *  - Kelly-criterion position sizing
 *  - Per-strategy capital caps
 *  - Daily loss cap with hard kill switch
 *  - Per-market position concentration limits
 *
 * Every strategy must call canTrade() before placing orders.
 */
export class RiskEngine {
  private bankroll: number;
  private dailyPnl = 0;
  private dailyResetDay = new Date().toUTCString().slice(0, 16); // "Tue, 19 May 2026"
  private killed = false;
  private positionsByMarket = new Map<string, number>(); // marketId -> notional USD
  private strategyDeployed = new Map<string, number>();   // strategy -> deployed USD

  constructor(bankroll: number) {
    this.bankroll = bankroll;
  }

  setBankroll(b: number): void {
    this.bankroll = b;
  }

  private rolloverIfNeeded(): void {
    const today = new Date().toUTCString().slice(0, 16);
    if (today !== this.dailyResetDay) {
      logger.info({ prevPnl: this.dailyPnl }, 'Daily PnL reset');
      this.dailyResetDay = today;
      this.dailyPnl = 0;
      this.killed = false;
    }
  }

  /**
   * Kelly sizing — fraction of bankroll = (edge / odds) clipped.
   *
   * For binary contracts priced p (0..1) with true probability q:
   *   Kelly fraction f* = (q - p) / (1 - p) for YES bets at price p.
   *
   * We use a "fractional Kelly" — 25% of full Kelly — for safety.
   */
  kellySize(modelProb: number, marketPrice: number, side: 'YES' | 'NO'): number {
    if (marketPrice <= 0 || marketPrice >= 1) return 0;
    const p = side === 'YES' ? marketPrice : 1 - marketPrice;
    const q = side === 'YES' ? modelProb : 1 - modelProb;
    if (q <= p) return 0;
    const fullKelly = (q - p) / (1 - p);
    const fractionalKelly = fullKelly * 0.25;
    return Math.max(0, Math.min(fractionalKelly, 0.05)); // cap at 5% of bankroll
  }

  /**
   * Check whether a proposed trade should proceed.
   * Returns the maximum allowed size (USD), or 0 if blocked.
   */
  canTrade(
    strategy: string,
    marketId: string,
    proposedSizeUsd: number
  ): { allowed: boolean; sizeUsd: number; reason?: string } {
    this.rolloverIfNeeded();

    const config = getConfig();

    if (this.killed) {
      return { allowed: false, sizeUsd: 0, reason: 'Daily loss cap breached - bot killed' };
    }

    if (this.dailyPnl <= -config.DAILY_LOSS_CAP_USD) {
      this.killSwitch('Daily loss cap breached');
      return { allowed: false, sizeUsd: 0, reason: 'Daily loss cap breached' };
    }

    // Per-strategy allocation
    const allocPct = this.getStrategyAllocation(strategy);
    const strategyCap = this.bankroll * allocPct;
    const strategyDeployed = this.strategyDeployed.get(strategy) ?? 0;
    if (strategyDeployed + proposedSizeUsd > strategyCap) {
      const remaining = Math.max(0, strategyCap - strategyDeployed);
      if (remaining < 5) {
        return { allowed: false, sizeUsd: 0, reason: 'Strategy allocation exhausted' };
      }
      proposedSizeUsd = remaining;
    }

    // Per-market concentration limit
    const marketDeployed = this.positionsByMarket.get(marketId) ?? 0;
    if (marketDeployed + proposedSizeUsd > config.MAX_POSITION_PER_MARKET_USD) {
      const remaining = Math.max(0, config.MAX_POSITION_PER_MARKET_USD - marketDeployed);
      if (remaining < 5) {
        return { allowed: false, sizeUsd: 0, reason: 'Per-market position limit hit' };
      }
      proposedSizeUsd = remaining;
    }

    return { allowed: true, sizeUsd: proposedSizeUsd };
  }

  private getStrategyAllocation(strategy: string): number {
    const config = getConfig();
    switch (strategy) {
      case 'sum_to_one': return config.ALLOC_SUM_TO_ONE;
      case 'cross_platform': return config.ALLOC_CROSS_PLATFORM;
      case 'crypto_latency': return config.ALLOC_CRYPTO_LATENCY;
      case 'weather': return config.ALLOC_WEATHER;
      default: return 0.10;
    }
  }

  /** Record that capital was deployed (call after a successful order). */
  recordDeployment(strategy: string, marketId: string, usd: number): void {
    this.strategyDeployed.set(strategy, (this.strategyDeployed.get(strategy) ?? 0) + usd);
    this.positionsByMarket.set(marketId, (this.positionsByMarket.get(marketId) ?? 0) + usd);
  }

  /** Record a realized PnL update (call when a position closes). */
  async recordPnl(strategy: string, pnlUsd: number, marketId?: string): Promise<void> {
    this.rolloverIfNeeded();
    this.dailyPnl += pnlUsd;
    const config = getConfig();

    logger.info({ strategy, pnlUsd, dailyPnl: this.dailyPnl }, 'PnL update');

    // Persist to Supabase
    const sb = getSupabase();
    const today = new Date().toISOString().slice(0, 10);
    await sb.rpc('increment_daily_pnl', {
      p_date: today,
      p_strategy: strategy,
      p_mode: config.TRADING_MODE,
      p_pnl: pnlUsd,
    }).then(() => {}, () => {
      // Fallback to direct upsert if RPC doesn't exist
      sb.from('pnl_daily').upsert({
        date: today,
        strategy,
        mode: config.TRADING_MODE,
        realized_pnl: pnlUsd,
      }, { onConflict: 'date,strategy,mode' });
    });

    // Free up market allocation if position closed
    if (marketId) {
      const current = this.positionsByMarket.get(marketId) ?? 0;
      this.positionsByMarket.set(marketId, Math.max(0, current - Math.abs(pnlUsd)));
    }

    // Check daily loss cap
    if (this.dailyPnl <= -config.DAILY_LOSS_CAP_USD) {
      this.killSwitch(`Daily loss cap of $${config.DAILY_LOSS_CAP_USD} breached`);
    }
  }

  private async killSwitch(reason: string): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    logger.error({ reason, dailyPnl: this.dailyPnl }, 'KILL SWITCH ACTIVATED');
    await sendDiscord(
      '🛑 KILL SWITCH ACTIVATED',
      reason,
      'error',
      [
        { name: 'Daily PnL', value: `$${this.dailyPnl.toFixed(2)}`, inline: true },
        { name: 'Bankroll', value: `$${this.bankroll.toFixed(2)}`, inline: true },
      ]
    );
  }

  getStats() {
    return {
      bankroll: this.bankroll,
      dailyPnl: this.dailyPnl,
      killed: this.killed,
      strategyDeployed: Object.fromEntries(this.strategyDeployed),
      marketDeployed: Object.fromEntries(this.positionsByMarket),
    };
  }
}

// Module-level singleton
let _riskEngine: RiskEngine | null = null;
export function getRiskEngine(): RiskEngine {
  if (!_riskEngine) _riskEngine = new RiskEngine(5000);
  return _riskEngine;
}
