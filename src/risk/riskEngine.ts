import { getConfig, isAggressive } from '../utils/config.js';
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
  private eventDeployed = new Map<string, number>();      // event_ticker -> deployed USD

  constructor(bankroll: number) {
    this.bankroll = bankroll;
    // H-7 fix v2 (May 22 2026 14:30 MDT): the constructor receives a hardcoded
    // placeholder ($5000) BEFORE any real balance sync. If we anchor peakBankroll
    // here, the first real sync (e.g. $1,194) computes a 76% drawdown and trips
    // the kill switch immediately. Instead: leave peakBankroll at 0 here. The
    // FIRST call to setBankroll() bootstraps both bankroll AND peakBankroll from
    // the real value. Subsequent calls then track the actual high-water mark.
    this.peakBankroll = 0;
    this.bankrollInitialized = false;
    // H-15: hydrate kill state from Supabase singleton row (best-effort, non-blocking).
    this.hydrateKillState();
  }

  /**
   * H-15: load persisted kill switch state from Supabase on construction. If the
   * `risk_state` table doesn't exist (migration not applied), log a warning and
   * proceed with killed=false. Never crashes — risk engine must always boot.
   */
  private async hydrateKillState(): Promise<void> {
    try {
      const sb = getSupabase();
      const { data, error } = await sb.from('risk_state').select('killed, reason').eq('id', 'singleton').maybeSingle();
      if (error) {
        // Table missing or RPC failure — best-effort only.
        logger.warn({ err: error.message ?? error }, 'risk_state hydrate failed (table may not exist yet) — continuing with killed=false');
        return;
      }
      if (data?.killed === true) {
        this.killed = true;
        logger.warn({ reason: data.reason }, 'KILL SWITCH state hydrated from Supabase — bot will refuse trades');
      }
    } catch (err: any) {
      logger.warn({ err: err.message ?? String(err) }, 'risk_state hydrate threw — continuing with killed=false');
    }
  }

  setBankroll(b: number): void {
    this.updateBankroll(b);
  }

  private rolloverIfNeeded(): void {
    const today = new Date().toUTCString().slice(0, 16);
    if (today !== this.dailyResetDay) {
      logger.info({ prevPnl: this.dailyPnl, killedBefore: this.killed }, 'Daily PnL reset');
      this.dailyResetDay = today;
      this.dailyPnl = 0;
      // CRIT-5 fix: do NOT auto-clear the kill switch. Once tripped, requires
      // manual reset (Fly secret unset or admin endpoint). The whole point of
      // a kill switch is that it stays killed until investigated.
      // H-6 fix: reset per-event fire counter at the daily rollover. Otherwise long-lived
      // tickers accumulate fires across days and eventually self-kill on the 3-fire safety.
      this.eventFireCount.clear();
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
    // v1 MED-11: guard against NaN/Infinity inputs before any arithmetic. A bad
    // modelProb (e.g. from a parser bug that emits NaN) would otherwise propagate
    // into a sized order via fullKelly = NaN, which is then min/max'd to 0 silently —
    // we'd never know the model is broken. Explicit guard + log.
    if (!isFinite(modelProb) || !isFinite(marketPrice)) {
      logger.warn({ modelProb, marketPrice, side }, 'kellySize: non-finite input — returning 0');
      return 0;
    }
    if (marketPrice <= 0 || marketPrice >= 1) return 0;
    if (modelProb < 0 || modelProb > 1) return 0;
    const p = side === 'YES' ? marketPrice : 1 - marketPrice;
    const q = side === 'YES' ? modelProb : 1 - modelProb;
    if (q <= p) return 0;
    const fullKelly = (q - p) / (1 - p);
    if (fullKelly > 1) {
      // Implausible — would mean our prob model is asserting near-certainty against
      // a contrary market mid. Log so we notice mis-calibration; sizer still clips.
      logger.warn({ modelProb, marketPrice, side, fullKelly }, 'kellySize: fullKelly > 1 — clipping to cap');
    }
    // Aggressive: 50% Kelly with 15% bankroll cap. Conservative: 25% Kelly with 5% cap.
    const fraction = isAggressive() ? 0.50 : 0.25;
    const cap = isAggressive() ? 0.15 : 0.05;
    return Math.max(0, Math.min(fullKelly * fraction, cap));
  }

  /**
   * Check whether a proposed trade should proceed.
   * Returns the maximum allowed size (USD), or 0 if blocked.
   */
  canTrade(
    strategy: string,
    marketId: string,
    proposedSizeUsd: number,
    opts?: { closesAt?: Date | string; eventTicker?: string; fractional?: boolean; liquidityUsd?: number }
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

    // HARD GATE 1: refuse fractional-trading markets - we can't liquidate them reliably
    if (opts?.fractional === true) {
      return { allowed: false, sizeUsd: 0, reason: 'Fractional-trading market - cannot liquidate, refusing' };
    }

    // HARD GATE 1b: minimum liquidity - skip thin markets we couldn't exit
    if (opts?.liquidityUsd != null && opts.liquidityUsd < config.MIN_LIQUIDITY_USD) {
      return { allowed: false, sizeUsd: 0, reason: `Liquidity $${opts.liquidityUsd.toFixed(0)} < min $${config.MIN_LIQUIDITY_USD}` };
    }

    // HARD GATE 2: refuse contracts that resolve more than MAX_DAYS_TO_RESOLUTION away
    if (opts?.closesAt) {
      const closesTs = (opts.closesAt instanceof Date ? opts.closesAt : new Date(opts.closesAt)).getTime();
      if (!isNaN(closesTs)) {
        const daysOut = (closesTs - Date.now()) / (1000 * 60 * 60 * 24);
        if (daysOut > config.MAX_DAYS_TO_RESOLUTION) {
          return { allowed: false, sizeUsd: 0, reason: `Resolves in ${Math.round(daysOut)}d (>${config.MAX_DAYS_TO_RESOLUTION}d cap)` };
        }
        if (daysOut < 0) {
          return { allowed: false, sizeUsd: 0, reason: 'Already resolved/closed' };
        }
      }
    }

    // HARD GATE 3: per-event exposure cap (prevent spamming 5 strikes on same CPI event)
    if (opts?.eventTicker) {
      const eventDeployed = this.eventDeployed.get(opts.eventTicker) ?? 0;
      if (eventDeployed + proposedSizeUsd > config.MAX_POSITION_PER_EVENT_USD) {
        const remaining = Math.max(0, config.MAX_POSITION_PER_EVENT_USD - eventDeployed);
        if (remaining < 5) {
          return { allowed: false, sizeUsd: 0, reason: `Per-event cap hit ($${eventDeployed.toFixed(0)} on ${opts.eventTicker})` };
        }
        proposedSizeUsd = remaining;
      }
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
      // Original 'both' mode strategies
      case 'sum_to_one': return config.ALLOC_SUM_TO_ONE;
      case 'cross_platform': return config.ALLOC_CROSS_PLATFORM;
      case 'crypto_latency': return config.ALLOC_CRYPTO_LATENCY;
      // Kalshi-only mode strategies
      case 'weather': return config.ALLOC_WEATHER;
      case 'kalshi_sum_to_one': return config.ALLOC_KALSHI_SUM_TO_ONE;
      case 'nowcast': return config.ALLOC_NOWCAST;
      case 'sports_latency': return config.ALLOC_SPORTS_LATENCY;
      case 'kalshi_hourly_crypto': return config.ALLOC_HOURLY_CRYPTO ?? 0.30;
      default: return 0.10;
    }
  }

  /** Record that capital was deployed (call after a successful order). */
  recordDeployment(strategy: string, marketId: string, usd: number, eventTicker?: string): void {
    this.strategyDeployed.set(strategy, (this.strategyDeployed.get(strategy) ?? 0) + usd);
    this.positionsByMarket.set(marketId, (this.positionsByMarket.get(marketId) ?? 0) + usd);
    if (eventTicker) {
      this.eventDeployed.set(eventTicker, (this.eventDeployed.get(eventTicker) ?? 0) + usd);
    }
  }

  /** Returns current deployment stats for a single event ticker (for visibility). */
  getEventDeployed(eventTicker: string): number {
    return this.eventDeployed.get(eventTicker) ?? 0;
  }

  /** Record a realized PnL update (call when a position closes). */
  /**
   * Record realized P&L for a closed position.
   * @param deploymentUsd Original deployment USD that's being freed (caller knows this).
   *                      If omitted, falls back to the buggy `Math.abs(pnlUsd)` behavior.
   *                      CRIT-9 fix: callers should always pass deploymentUsd.
   */
  async recordPnl(strategy: string, pnlUsd: number, marketId?: string, deploymentUsd?: number): Promise<void> {
    this.rolloverIfNeeded();
    this.dailyPnl += pnlUsd;
    const config = getConfig();

    logger.info({ strategy, pnlUsd, dailyPnl: this.dailyPnl }, 'PnL update');

    // Persist to Supabase
    const sb = getSupabase();
    const today = new Date().toISOString().slice(0, 10);
    // v1 MED-10 fix: await both the RPC and the fallback upsert. Previously the
    // fallback's promise was discarded inside `.then(success, failure)`, so a
    // missing-RPC environment got a fire-and-forget upsert with no error visibility.
    try {
      await sb.rpc('increment_daily_pnl', {
        p_date: today,
        p_strategy: strategy,
        p_mode: config.TRADING_MODE,
        p_pnl: pnlUsd,
      });
    } catch {
      try {
        await sb.from('pnl_daily').upsert({
          date: today,
          strategy,
          mode: config.TRADING_MODE,
          realized_pnl: pnlUsd,
        }, { onConflict: 'date,strategy,mode' });
      } catch (e: any) {
        logger.warn({ err: e?.message ?? String(e), strategy, pnlUsd }, 'recordPnl fallback upsert failed');
      }
    }

    // Free up market allocation if position closed
    if (marketId) {
      const current = this.positionsByMarket.get(marketId) ?? 0;
      // CRIT-9 fix: free the full deployment USD, not Math.abs(pnl). Wins (small pnl)
      // were freeing tiny amounts, leaving stale exposure that strangled trade frequency.
      const toFree = deploymentUsd ?? Math.abs(pnlUsd);
      this.positionsByMarket.set(marketId, Math.max(0, current - toFree));
    }

    // Check daily loss cap
    if (this.dailyPnl <= -config.DAILY_LOSS_CAP_USD) {
      this.killSwitch(`Daily loss cap of $${config.DAILY_LOSS_CAP_USD} breached`);
    }
  }

  /** Public-callable kill switch for strategy code (5-consec-loss, model issues, etc.) */
  forceKill(reason: string): void {
    // v2 M-10: surface async failures instead of fire-and-forget. `this.killed = true`
    // is set synchronously inside killSwitch so the kill itself is durable; this only
    // matters for the Discord alert + Supabase persist sub-tasks.
    void this.killSwitch(reason).catch((err) => {
      logger.error({ err: err.message ?? String(err), reason }, 'forceKill async tail failed');
    });
  }

  private async killSwitch(reason: string): Promise<void> {
    if (this.killed) return;
    this.killed = true;
    logger.error({ reason, dailyPnl: this.dailyPnl }, 'KILL SWITCH ACTIVATED');
    // H-15: persist to Supabase so the kill survives a Fly restart. If the table
    // doesn't exist or the write fails, log and continue — the in-process kill is
    // still in effect for the rest of this session.
    try {
      const sb = getSupabase();
      const { error } = await sb.from('risk_state').upsert({
        id: 'singleton',
        killed: true,
        reason,
        ts: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (error) {
        logger.warn({ err: error.message ?? error }, 'risk_state persist failed (table may not exist yet) — in-process kill still applies');
      }
    } catch (err: any) {
      logger.warn({ err: err.message ?? String(err) }, 'risk_state persist threw — in-process kill still applies');
    }
    await sendDiscord(
      '🛑 KILL SWITCH ACTIVATED',
      `<@572590897150296083> ${reason}`,
      'error',
      [
        { name: 'Daily PnL', value: `$${this.dailyPnl.toFixed(2)}`, inline: true },
        { name: 'Bankroll', value: `$${this.bankroll.toFixed(2)}`, inline: true },
        { name: 'Action', value: 'Bot stopped placing orders. Manual review required.', inline: false },
      ]
    );
  }

  // ===== AUTO CIRCUIT BREAKERS =====
  // Tracking for additional safety triggers
  private orderAttempts: { ts: number; ok: boolean }[] = [];
  private peakBankroll = 0;
  private bankrollInitialized = false;
  private eventFireCount = new Map<string, number>();

  /** Track every order attempt; auto-kill on bad patterns. */
  recordOrderAttempt(eventTicker: string, ok: boolean): void {
    const now = Date.now();
    this.orderAttempts.push({ ts: now, ok });
    // Keep only last 10 minutes
    this.orderAttempts = this.orderAttempts.filter(a => now - a.ts < 10 * 60 * 1000);

    // Track per-event fires - any event firing 3+ times = bug, kill it
    const c = (this.eventFireCount.get(eventTicker) || 0) + 1;
    this.eventFireCount.set(eventTicker, c);
    if (c >= 3) {
      void this.killSwitch(`Event ${eventTicker} fired ${c} times — stacked-exposure bug detected`);
      return;
    }

    // High rejection rate over 10+ orders = something broken, kill
    if (this.orderAttempts.length >= 10) {
      const rejected = this.orderAttempts.filter(a => !a.ok).length;
      const rejectRate = rejected / this.orderAttempts.length;
      if (rejectRate > 0.5) {
        void this.killSwitch(`Order rejection rate ${(rejectRate * 100).toFixed(0)}% over last ${this.orderAttempts.length} attempts — API issue or bug`);
        return;
      }
    }
  }

  /** Track bankroll for drawdown circuit breaker */
  updateBankroll(newBankroll: number): void {
    this.bankroll = newBankroll;
    // H-7 fix v2: first real balance sync sets the baseline, no drawdown check
    if (!this.bankrollInitialized) {
      this.peakBankroll = newBankroll;
      this.bankrollInitialized = true;
      logger.info({ peakBankroll: newBankroll }, 'Bankroll baseline initialized');
      return;
    }
    if (newBankroll > this.peakBankroll) this.peakBankroll = newBankroll;
    if (this.peakBankroll > 0) {
      const drawdown = (this.peakBankroll - newBankroll) / this.peakBankroll;
      // 2026-05-22: raised from 15% to 20% because dripEngine now feeds total equity
      // (cash + positions), so drawdown is real loss not just position lock-up.
      // A 20% true-equity drop is still aggressive and warrants a hard stop.
      if (drawdown >= 0.20 && !this.killed) {
        void this.killSwitch(`Bankroll drawdown ${(drawdown * 100).toFixed(1)}% from peak $${this.peakBankroll.toFixed(2)} → $${newBankroll.toFixed(2)}`);
      }
    }
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
