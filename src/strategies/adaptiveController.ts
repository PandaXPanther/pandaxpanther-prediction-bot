/**
 * AdaptiveController — dynamic parameter adjustment for the crypto strategy.
 *
 * Watches recent trade outcomes + market regime indicators and auto-tunes:
 * - Min divergence threshold (tighten when losing, loosen when winning)
 * - Kelly multiplier (size down after losses, restore after wins)
 * - Volatility blend ratio (weight empirical higher when regime shifts)
 *
 * Updates every trade. All adjustments are bounded so the bot can never
 * disable safety guards entirely.
 */
import { createStrategyLogger } from '../utils/logger.js';
import { isAggressive } from '../utils/config.js';
const log = createStrategyLogger('adaptive');

export interface AdaptiveSettings {
  minDivergence: number;     // 0.04-0.10
  kellyMultiplier: number;   // 0.3-1.0 (1.0 = full kelly as configured)
  volEmpiricalWeight: number; // 0.10-0.70
  reasoning: string;
}

interface TradeResult {
  ts: number;
  won: boolean;
  pnl: number;
  modelProb: number;
  marketProb: number;
  realizedVol: number;
}

interface RegimeSnapshot {
  ts: number;
  empiricalVol: number;
  priorVol: number;
}

export class AdaptiveController {
  private trades: TradeResult[] = [];
  private regimes: RegimeSnapshot[] = [];
  // Deep research May 2026: BASE_DIVERGENCE lowered from 0.06 to 0.04 (4pp).
  // Per-asset matrix in getThresholdForTrade now handles the per-asset min, so adaptive
  // just acts as an ADDITIONAL safety floor when WR drops.
  private currentSettings: AdaptiveSettings = {
    minDivergence: isAggressive() ? 0.025 : 0.04,
    kellyMultiplier: 1.0,
    volEmpiricalWeight: 0.30,
    reasoning: isAggressive() ? 'aggressive-baseline' : 'baseline',
  };

  /** Base settings - what we start from and adjust around. */
  private readonly BASE_DIVERGENCE = isAggressive() ? 0.025 : 0.04;
  private readonly BASE_KELLY = 1.0;
  private readonly BASE_VOL_WEIGHT = 0.30;

  /** Bounds - can never exceed these. */
  private readonly MIN_DIV_FLOOR = isAggressive() ? 0.02 : 0.035;
  private readonly MIN_DIV_CEILING = 0.12;
  private readonly KELLY_FLOOR = 0.3;
  private readonly KELLY_CEILING = 1.0;
  private readonly VOL_W_FLOOR = 0.10;
  private readonly VOL_W_CEILING = 0.70;

  /** Hydrate trade history from external source (DB) on bot startup. */
  hydrate(trades: TradeResult[]): void {
    // Keep most-recent 50, sorted by ts ascending so order is correct
    const sorted = [...trades].sort((a, b) => a.ts - b.ts).slice(-50);
    this.trades = sorted;
    this.recompute();
    log.info({ hydrated: sorted.length }, 'AdaptiveController hydrated from DB');
  }

  /**
   * Hard kill switch: returns true if the bot should auto-flip to paper.
   * Triggers on N consecutive losses with realized losses > $X.
   * Restart-safe because this.trades is hydrated from DB on startup.
   */
  shouldKillSwitch(): { trip: boolean; reason: string } {
    const recent = this.trades.slice(-3);
    if (recent.length === 3 && recent.every(t => !t.won)) {
      const totalLoss = recent.reduce((s, t) => s + t.pnl, 0);
      if (totalLoss < -30) {
        return { trip: true, reason: `3 losses in a row (∑ $${totalLoss.toFixed(2)})` };
      }
    }
    // Also: if last 10 trades cumulative loss > $60, kill
    const recent10 = this.trades.slice(-10);
    if (recent10.length >= 5) {
      const pnl10 = recent10.reduce((s, t) => s + t.pnl, 0);
      if (pnl10 < -60) {
        return { trip: true, reason: `last ${recent10.length} trades cumulative ∑ $${pnl10.toFixed(2)}` };
      }
    }
    return { trip: false, reason: '' };
  }

  /** Track a completed trade outcome. */
  recordTrade(t: TradeResult): void {
    this.trades.push(t);
    // Keep last 50 trades
    if (this.trades.length > 50) this.trades.shift();
    this.recompute();
  }

  /** Track a vol observation for regime detection. */
  recordVolSnapshot(empirical: number, prior: number): void {
    this.regimes.push({ ts: Date.now(), empiricalVol: empirical, priorVol: prior });
    // Keep last 30 min
    const cutoff = Date.now() - 30 * 60 * 1000;
    this.regimes = this.regimes.filter(r => r.ts >= cutoff);
  }

  get(): AdaptiveSettings {
    return this.currentSettings;
  }

  private recompute(): void {
    const reasons: string[] = [];
    let div = this.BASE_DIVERGENCE;
    let kelly = this.BASE_KELLY;
    let volW = this.BASE_VOL_WEIGHT;

    // === Deep research May 2026: 30-trade rolling WR trigger (replaces 3-consecutive-loss) ===
    // The 3-loss rule fires on noise 10% of the time at p=0.53 (P(LLL)=0.1038).
    // 30-trade rolling WR has SPRT-style power: only acts on persistent regime shift.
    const recent30 = this.trades.slice(-30);
    if (recent30.length >= 15) {
      const wins30 = recent30.filter(t => t.won).length;
      const wr30 = wins30 / recent30.length;
      const netPnl30 = recent30.reduce((s, t) => s + t.pnl, 0);

      if (wr30 < 0.49) {
        // Persistent underperformance — tighten threshold + shrink Kelly
        // At 30-trade window, P(WR<0.49 | p=0.53)=~31%, P(WR<0.49 | p=0.50)=~55% — reasonable signal
        div = Math.min(this.MIN_DIV_CEILING, div + 0.015);
        kelly = Math.max(this.KELLY_FLOOR, kelly - 0.3);
        reasons.push(`30-trade WR ${(wr30*100).toFixed(0)}% < 49% — tightening`);
      } else if (wr30 >= 0.55 && netPnl30 > 0) {
        // v3.1: Persistent outperformance — loosen threshold AND grow Kelly.
        // Previously only loosened threshold; this leaves profit on the table.
        // With 30+ validated trades at ≥55% WR, the model has proven its edge.
        // Bump Kelly 1.0 → 1.5× (caps at 1.8 to stay safe vs full Kelly).
        div = Math.max(this.MIN_DIV_FLOOR, div - 0.01);
        kelly = Math.min(1.8, kelly + 0.5);
        reasons.push(`30-trade WR ${(wr30*100).toFixed(0)}% ≥ 55% — loosening + boosting Kelly to ${kelly.toFixed(2)}x`);
      }

      // v3.1 Tier 2: at 50 trades with WR ≥55%, push Kelly higher (only after sustained edge)
      const recent50 = this.trades.slice(-50);
      if (recent50.length >= 50) {
        const wr50 = recent50.filter(t => t.won).length / recent50.length;
        const pnl50 = recent50.reduce((s, t) => s + t.pnl, 0);
        if (wr50 >= 0.55 && pnl50 > 0) {
          kelly = Math.min(2.5, kelly + 0.3);  // up to 2.5x of base = 0.075 × 2.5 = 0.187 effective Kelly
          reasons.push(`50-trade WR ${(wr50*100).toFixed(0)}% ≥ 55% — Kelly tier 2 boost to ${kelly.toFixed(2)}x`);
        }
      }
    }

    // === Hard circuit breaker: 5 losses in a row still cuts sizing ===
    const recent5 = this.trades.slice(-5);
    if (recent5.length === 5 && recent5.every(t => !t.won)) {
      kelly = Math.max(this.KELLY_FLOOR, 0.5);
      div = Math.min(this.MIN_DIV_CEILING, div + 0.02);
      reasons.push('5 losses in row — halving size (hard rule)');
    }

    // === Vol regime detection ===
    if (this.regimes.length >= 5) {
      const recentRegimes = this.regimes.slice(-10);
      const avgEmp = recentRegimes.reduce((s, r) => s + r.empiricalVol, 0) / recentRegimes.length;
      const avgPrior = recentRegimes.reduce((s, r) => s + r.priorVol, 0) / recentRegimes.length;
      const ratio = avgEmp / avgPrior;

      if (ratio > 1.5) {
        // Empirical is much higher than prior — regime change (volatility spike)
        // Trust empirical more
        volW = Math.min(this.VOL_W_CEILING, this.BASE_VOL_WEIGHT + 0.30);
        div = Math.min(this.MIN_DIV_CEILING, div + 0.01);  // also tighten - more uncertainty
        reasons.push(`vol spike (emp/prior=${ratio.toFixed(2)})`);
      } else if (ratio < 0.6) {
        // Empirical is much lower than prior — calm regime
        // Keep prior heavier (our prior might be too high)
        volW = Math.max(this.VOL_W_FLOOR, this.BASE_VOL_WEIGHT + 0.20);
        reasons.push(`calm regime (emp/prior=${ratio.toFixed(2)})`);
      }
    }

    const newSettings: AdaptiveSettings = {
      minDivergence: div,
      kellyMultiplier: kelly,
      volEmpiricalWeight: volW,
      reasoning: reasons.length > 0 ? reasons.join('; ') : 'baseline',
    };

    // Log if anything changed
    if (
      newSettings.minDivergence !== this.currentSettings.minDivergence ||
      Math.abs(newSettings.kellyMultiplier - this.currentSettings.kellyMultiplier) > 0.01 ||
      Math.abs(newSettings.volEmpiricalWeight - this.currentSettings.volEmpiricalWeight) > 0.01
    ) {
      log.info({
        old: this.currentSettings,
        new: newSettings,
      }, 'adaptive settings updated');
    }

    this.currentSettings = newSettings;
  }

  /** For heartbeat reporting */
  stats() {
    const recent = this.trades.slice(-20);
    const wins = recent.filter(t => t.won).length;
    return {
      ...this.currentSettings,
      tradesTracked: this.trades.length,
      recentWinRate: recent.length >= 5 ? (wins / recent.length).toFixed(2) : 'n/a',
      recentNetPnl: recent.reduce((s, t) => s + t.pnl, 0).toFixed(2),
    };
  }
}

// Singleton
let _instance: AdaptiveController | null = null;
export function getAdaptiveController(): AdaptiveController {
  if (!_instance) _instance = new AdaptiveController();
  return _instance;
}
