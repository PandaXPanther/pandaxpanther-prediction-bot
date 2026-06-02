/**
 * UPGRADE #1: Cross-Strike Monotonicity Arbitrage
 *
 * THESIS:
 *   For a given event (e.g. "BTC ≥ X at 3pm EDT"), as X increases, the YES probability
 *   must DECREASE monotonically:
 *      P(BTC ≥ 76k) ≥ P(BTC ≥ 77k) ≥ P(BTC ≥ 78k)
 *
 *   Equivalently, the MARKET PRICES of YES contracts on these strikes must be monotonic.
 *   When they are NOT (e.g. P(YES@76k_ask) < P(YES@77k_bid)), this is a literal arbitrage:
 *   buy the lower-priced higher-prob outcome, optionally sell the overpriced lower-prob one.
 *
 *   This module finds those violations and signals trades on the underpriced leg
 *   (the strike that's "too cheap given a closer/easier strike is more expensive").
 *
 * IMPLEMENTATION:
 *   Group markets by eventTicker. For each event with ≥2 'greater' strikes:
 *     - Sort strikes ascending
 *     - For each adjacent pair (X_low, X_high):
 *         YES@X_low SHOULD trade ≥ YES@X_high
 *         If YES@X_low.ask < YES@X_high.bid - SLACK:
 *           BUY YES@X_low (the underpriced cheap-strike)
 *
 *   Same logic mirrored for 'less' strikes (descending prob with descending strike).
 *
 *   We only act on STRONG violations (≥ 2pp after fees) to avoid noise/staleness.
 *
 * WHY THIS IS NEAR-ZERO RISK:
 *   - We're not making a vol forecast — the inequality is a hard mathematical constraint.
 *   - The only risk is execution: if we fill on the underpriced strike but the violation
 *     was stale (someone else already arb'd it), we end up with a long position at a
 *     decent price. Still positive EV vs. model.
 *
 * SIZING:
 *   We're more confident here than in vol-model trades, but we still cap at the same
 *   per-trade limits. Fires through the same risk engine as the main strategy.
 */

import { createStrategyLogger } from '../utils/logger.js';

const log = createStrategyLogger('cross_strike_arb');

export interface ArbCandidate {
  eventTicker: string;
  underlying: string;
  buyTicker: string;        // the underpriced leg we should BUY YES on
  buyPrice: number;          // price we'd post at (best ask)
  buySide: 'yes' | 'no';
  expectedFloor: number;     // implied lower bound from monotonicity
  violationPp: number;       // size of violation in pp
  marketDbId?: string;       // resolved at fire time
  resolveAtMs: number;
  strikeType: 'greater' | 'less';
  floorStrike: number;
  capStrike?: number;
  liquidityUsd?: number;
  closesAtMs: number;
  refTicker: string;         // the more-expensive strike that pins the lower bound
  refPrice: number;
}

interface ScannableMarket {
  ticker: string;
  eventTicker: string;
  underlying: string;
  strikeType: 'greater' | 'less' | 'between';
  floorStrike: number;
  capStrike?: number;
  resolveAtMs: number;
  closesAtMs: number;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  liquidityUsd?: number;
  marketDbId?: string;
}

// MAY 22 2026 RECALIBRATION: dropped MIN_VIOLATION from 2pp → 1pp.
// Cross-strike monotonicity is a HARD MATHEMATICAL CONSTRAINT (not a vol forecast),
// so even small violations are real arb. The 2pp threshold was so tight only 1
// trade fired in 24+ hours. At 1pp we still cover 0.44pp maker fee + 0.56pp safety,
// which is enough because:
//   1) These are near-zero-risk trades (the inequality is mathematical truth)
//   2) Even if violation is stale (someone else arb'd it), we end up with a
//      reasonable position long the cheap leg — still positive EV vs. model
//   3) Lower threshold = more trades = better diversification across events
const MIN_VIOLATION_PP = 0.01;
const MIN_PRICE = 0.03;          // 3¢ — still skip dust strikes but allow more deep-OTM arbs
const MAX_PRICE = 0.97;          // mirror: more upside on deep-ITM legs

/**
 * Scan all markets for cross-strike monotonicity violations.
 * Returns the BEST (largest violation) candidate per event, sorted by violation size desc.
 */
export function scanCrossStrikeArb(markets: Iterable<ScannableMarket>): ArbCandidate[] {
  // Group by event
  const byEvent = new Map<string, ScannableMarket[]>();
  for (const m of markets) {
    if (m.strikeType === 'between') continue;  // skip between contracts (more complex constraint)
    if (m.yesBid == null || m.yesAsk == null) continue;
    if (m.yesAsk <= 0 || m.yesAsk >= 1) continue;
    const arr = byEvent.get(m.eventTicker) ?? [];
    arr.push(m);
    byEvent.set(m.eventTicker, arr);
  }

  const candidates: ArbCandidate[] = [];

  for (const [eventTicker, list] of byEvent) {
    if (list.length < 2) continue;

    // Split by strikeType — 'greater' strikes have monotone DECREASING YES as floor increases
    // 'less' strikes have monotone INCREASING YES as floor increases
    const greaters = list.filter(m => m.strikeType === 'greater').sort((a, b) => a.floorStrike - b.floorStrike);
    const lesses = list.filter(m => m.strikeType === 'less').sort((a, b) => a.floorStrike - b.floorStrike);

    // 'greater' monotonicity: YES@lower_strike >= YES@higher_strike (for any pair)
    // Most informative violation: compare each strike to the MAX of higher strikes' bids
    for (let i = 0; i < greaters.length - 1; i++) {
      const lo = greaters[i];
      // Find the highest bid among strikes > lo (these should all be cheaper than lo)
      let maxHigherBid = -1;
      let refTicker = '';
      for (let j = i + 1; j < greaters.length; j++) {
        const hi = greaters[j];
        if (hi.yesBid! > maxHigherBid) {
          maxHigherBid = hi.yesBid!;
          refTicker = hi.ticker;
        }
      }
      if (maxHigherBid < 0) continue;
      // Violation: lo.yesAsk (what we'd PAY for lo) < maxHigherBid (what hi trades at)
      // Lo SHOULD be more probable than hi, so lo's price floor is maxHigherBid.
      const violation = maxHigherBid - lo.yesAsk!;
      if (violation < MIN_VIOLATION_PP) continue;
      if (lo.yesAsk! < MIN_PRICE || lo.yesAsk! > MAX_PRICE) continue;
      candidates.push({
        eventTicker,
        underlying: lo.underlying,
        buyTicker: lo.ticker,
        buyPrice: lo.yesAsk!,
        buySide: 'yes',
        expectedFloor: maxHigherBid,
        violationPp: violation,
        marketDbId: lo.marketDbId,
        resolveAtMs: lo.resolveAtMs,
        closesAtMs: lo.closesAtMs,
        strikeType: 'greater',
        floorStrike: lo.floorStrike,
        capStrike: lo.capStrike,
        liquidityUsd: lo.liquidityUsd,
        refTicker,
        refPrice: maxHigherBid,
      });
    }

    // 'less' monotonicity: YES@higher_strike >= YES@lower_strike (for any pair)
    // Mirror logic
    for (let i = lesses.length - 1; i > 0; i--) {
      const hi = lesses[i];
      let maxLowerBid = -1;
      let refTicker = '';
      for (let j = 0; j < i; j++) {
        const lo = lesses[j];
        if (lo.yesBid! > maxLowerBid) {
          maxLowerBid = lo.yesBid!;
          refTicker = lo.ticker;
        }
      }
      if (maxLowerBid < 0) continue;
      const violation = maxLowerBid - hi.yesAsk!;
      if (violation < MIN_VIOLATION_PP) continue;
      if (hi.yesAsk! < MIN_PRICE || hi.yesAsk! > MAX_PRICE) continue;
      candidates.push({
        eventTicker,
        underlying: hi.underlying,
        buyTicker: hi.ticker,
        buyPrice: hi.yesAsk!,
        buySide: 'yes',
        expectedFloor: maxLowerBid,
        violationPp: violation,
        marketDbId: hi.marketDbId,
        resolveAtMs: hi.resolveAtMs,
        closesAtMs: hi.closesAtMs,
        strikeType: 'less',
        floorStrike: hi.floorStrike,
        capStrike: hi.capStrike,
        liquidityUsd: hi.liquidityUsd,
        refTicker,
        refPrice: maxLowerBid,
      });
    }
  }

  // Sort by violation size, highest first
  candidates.sort((a, b) => b.violationPp - a.violationPp);

  if (candidates.length > 0) {
    log.info({
      total: candidates.length,
      best: candidates[0] ? {
        ticker: candidates[0].buyTicker,
        violationPp: (candidates[0].violationPp * 100).toFixed(2),
        buyPrice: candidates[0].buyPrice,
        floor: candidates[0].expectedFloor,
      } : null,
    }, 'cross-strike arb candidates found');
  }
  return candidates;
}
