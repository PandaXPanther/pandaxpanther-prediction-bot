/**
 * cryptoEmpiricalModel.ts
 * ========================
 * Empirical logistic regression replacement for the GBM-based yesProb()
 * in kalshiHourlyCrypto.ts.
 *
 * BACKGROUND
 * ----------
 * The GBM pricer (normCDF-based probAbove) has a systematic bias: it assigns
 * 25–50% probability to YES bets on slightly-OTM "greater" contracts where the
 * true win rate is ~12% and market MMs price them at 15–30%.  After 34/34 YES
 * bets lost and $152 was leaked on May 22 2026, this module replaces the pricer
 * with a logistic regression trained on 54 resolved Kalshi signals.
 *
 * MODEL SUMMARY (trained 2026-05-22)
 * ------------------------------------
 * • Training data   : 54 crypto-divergence signals, 2026-05-21 to 2026-05-22
 * • Overall YES win rate: 37.0% (but for bot's YES bets only: 11.8%)
 * • Train log-loss  : 0.4419  (vs GBM raw 0.5744, vs GBM 30/70 blend 0.5062)
 * • Train accuracy  : 75.9%   (vs GBM raw 81.5%†)
 *   †GBM accuracy appears high because it predicts ~50% for everything → 63%
 *    base rate is close to 50-50 threshold. Log-loss reveals the calibration gap.
 * • Brier score     : 0.1410  (vs GBM raw 0.1921 — 26.6% improvement)
 *
 * FEATURES
 * --------
 *   log_moneyness         = ln(spot / floorStrike)
 *   z_score               = log_moneyness / (sigma * sqrt(ttSec/3600))
 *   gbm_logit             = logit(GBM_prob_raw)   [meta-feature: recalibrate GBM]
 *   is_btc                = 1 if underlying='BTC', else 0
 *   is_greater            = 1 if strikeType='greater', else 0
 *
 * COEFFICIENTS (L2 λ=0.5, Adam optimizer, 3000 iterations)
 * ----------------------------------------------------------
 *   intercept       : -0.69533554
 *   log_moneyness   : +369.78260691   [dominant: +1 std = +0.97 logit units]
 *   z_score         : +67.09755346    [secondary]
 *   gbm_logit       :  +0.86883217   [recalibration weight on GBM]
 *   is_btc          :  +0.02943833   [negligible BTC/ETH split]
 *   is_greater      :   0.00000000   [all train data was 'greater'; degenerate]
 *
 * CAVEATS (READ BEFORE USE)
 * -------------------------
 *  1. TINY SAMPLE: n=54 across 2 calendar days.  Variance is enormous.
 *  2. The log_moneyness coefficient (369) looks large but acts on values
 *     ~0.001–0.005, so a 1bp change in moneyness shifts logit by ~0.37.
 *  3. is_greater collapses to 0 because all training signals were 'greater'.
 *     The model has no empirical basis for 'less' or 'between' contracts.
 *  4. Resolution grading used Coinbase 1-min close; Kalshi's settlement
 *     formula may differ by ±$5–30.
 *  5. All in-sample metrics (no held-out test set possible at n<60).
 *
 * USAGE
 * -----
 *   import { empiricalYesProb } from './cryptoEmpiricalModel';
 *   // Drop-in replacement for `this.yesProb(m, spot, sigma, ttSec)`:
 *   const modelProb = empiricalYesProb(m, spot, sigma, ttSec);
 *
 * The function returns -1 for 'between' markets (same as the GBM pricer) since
 * there is no training data for that contract type.
 */

// ── Trained coefficients ─────────────────────────────────────────────────────

export const COEFFICIENTS = {
  intercept:     -0.69533554,
  log_moneyness: 369.78260691,   // coefficient on log(spot/strike)
  z_score:        67.09755346,   // coefficient on vol-scaled moneyness
  gbm_logit:       0.86883217,   // recalibration weight on raw GBM logit
  is_btc:          0.02943833,   // BTC vs ETH offset
  is_greater:      0.00000000,   // degenerate in training data
} as const;

// ── Helper functions ─────────────────────────────────────────────────────────

/** Standard normal CDF — Abramowitz & Stegun approximation, max error 7.5e-8. */
function stdNormalCdf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.2316419 * ax);
  const poly =
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t *
            (1.781477937 +
              t * (-1.821255978 + t * 1.330274429))));
  const cdfPos =
    1.0 - (1.0 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * ax * ax) * poly;
  return sign > 0 ? cdfPos : 1.0 - cdfPos;
}

/** Sigmoid / logistic function, numerically stable. */
function sigmoid(z: number): number {
  if (z >= 0) return 1.0 / (1.0 + Math.exp(-Math.min(z, 500)));
  const ex = Math.exp(Math.max(z, -500));
  return ex / (1.0 + ex);
}

/**
 * Raw GBM probability (no market blend) — replicates the core of
 * kalshiHourlyCrypto.ts :: probAbove() including the effectiveTt(+90s) and
 * skew adjustment for OTM calls.
 */
function gbmYesProb(
  spot: number,
  floorStrike: number,
  sigma: number,
  ttSec: number,
  strikeType: 'greater' | 'less' | 'between',
  underlying: string,
): number {
  const teff = ttSec + 90; // effectiveTt adds 90s settlement window
  const T = Math.max(teff, 1) / (365 * 24 * 3600);
  const eps = 1e-9;
  const d2 =
    (Math.log(Math.max(spot, eps) / Math.max(floorStrike, eps)) -
      0.5 * sigma * sigma * T) /
    Math.max(sigma * Math.sqrt(T), eps);

  if (strikeType === 'greater') {
    let raw = stdNormalCdf(d2);
    // Skew adjustment for OTM call (strike above spot)
    const strikeDist = (floorStrike - spot) / spot;
    if (strikeDist > 0 && (underlying === 'BTC' || underlying === 'ETH')) {
      const distPct = strikeDist * 100;
      const baseSkew = -Math.min(0.05, 0.02 + 0.025 * Math.min(distPct, 1.2));
      const ttFactor = Math.min(1, ttSec / (15 * 60));
      raw = Math.max(0, raw + baseSkew * ttFactor);
    }
    return raw;
  } else if (strikeType === 'less') {
    return 1.0 - stdNormalCdf(d2);
  }
  return 0.5; // 'between' — no empirical basis, return neutral
}

// ── Market interface (subset of CryptoMarket in kalshiHourlyCrypto.ts) ───────

export interface EmpiricalMarketInput {
  underlying: string;
  strikeType: 'greater' | 'less' | 'between';
  floorStrike: number;
  capStrike?: number;
  yesBid?: number;
  yesAsk?: number;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * empiricalYesProb
 * ----------------
 * Drop-in replacement for `this.yesProb(m, spot, sigma, ttSec)` in
 * kalshiHourlyCrypto.ts.
 *
 * Returns P(YES wins) in [0, 1], or -1 for 'between' markets.
 *
 * Algorithm:
 *   1. Compute raw GBM probability (same formula as existing code).
 *   2. Compute logistic regression features.
 *   3. Apply trained coefficients → sigmoid → empirical probability.
 *   4. If market bid/ask are available, blend: 70% market mid + 30% empirical
 *      (same blend ratio as the existing 30/70 recalibration introduced May 22).
 *   5. Apply near-expiry damping for ttSec < 15 min.
 *
 * @param m       - Market object (needs floorStrike, strikeType, underlying, yesBid, yesAsk)
 * @param spot    - Current spot price
 * @param sigma   - Annualized realized volatility
 * @param ttSec   - Seconds to resolution
 */
export function empiricalYesProb(
  m: EmpiricalMarketInput,
  spot: number,
  sigma: number,
  ttSec: number,
): number {
  // CRIT-10 fix: only 'greater' (call) contracts were in training data.
  // 'less' (put) and 'between' contracts have no empirical basis. Return -1
  // sentinel to force the caller to fall back to GBM (or skip entirely).
  if (m.strikeType !== 'greater') return -1;

  const eps = 1e-9;
  const floorStrike = m.floorStrike;

  // ── Feature computation ──────────────────────────────────────────────────
  const log_moneyness = Math.log(Math.max(spot, eps) / Math.max(floorStrike, eps));
  const ttHrs = Math.max(ttSec, 1) / 3600.0;
  const z_score = log_moneyness / Math.max(sigma * Math.sqrt(ttHrs), eps);

  // Raw GBM probability as a meta-feature (logit-transformed)
  const gbmP = gbmYesProb(spot, floorStrike, sigma, ttSec, m.strikeType, m.underlying);
  const gbmPClipped = Math.max(Math.min(gbmP, 1 - 1e-6), 1e-6);
  const gbm_logit = Math.log(gbmPClipped / (1 - gbmPClipped));

  const is_btc = m.underlying === 'BTC' ? 1.0 : 0.0;
  const is_greater = m.strikeType === 'greater' ? 1.0 : 0.0;

  // ── Logistic regression prediction ──────────────────────────────────────
  const z =
    COEFFICIENTS.intercept +
    COEFFICIENTS.log_moneyness * log_moneyness +
    COEFFICIENTS.z_score * z_score +
    COEFFICIENTS.gbm_logit * gbm_logit +
    COEFFICIENTS.is_btc * is_btc +
    COEFFICIENTS.is_greater * is_greater;

  let empirical = sigmoid(z);

  // ── Blend with market mid (70/30: market wins, empirical calibrates) ─────
  // Mirror the 30/70 blend already in the GBM code.
  if (m.yesBid != null && m.yesAsk != null) {
    const marketMid = (m.yesBid + m.yesAsk) / 2;
    empirical = 0.30 * empirical + 0.70 * marketMid;
  }

  // ── Near-expiry damping (same as GBM pricer) ─────────────────────────────
  if (ttSec < 15 * 60) {
    empirical = 0.5 + 0.987 * (empirical - 0.5);
  }

  return Math.max(0, Math.min(1, empirical));
}

/**
 * Convenience: compute the raw empirical probability WITHOUT any market blend.
 * Useful for diagnostics and logging the model's standalone estimate.
 */
export function empiricalYesProbRaw(
  m: EmpiricalMarketInput,
  spot: number,
  sigma: number,
  ttSec: number,
): number {
  // v2 L-2: match the live-path guard. Empirical coefficients were fit on `'greater'`
  // (call) data only; `'less'` (put) and `'between'` would silently produce a biased
  // logit if we let the formula run.
  if (m.strikeType !== 'greater') return -1;

  const eps = 1e-9;
  const floorStrike = m.floorStrike;
  const log_moneyness = Math.log(Math.max(spot, eps) / Math.max(floorStrike, eps));
  const ttHrs = Math.max(ttSec, 1) / 3600.0;
  const z_score = log_moneyness / Math.max(sigma * Math.sqrt(ttHrs), eps);

  const gbmP = gbmYesProb(spot, floorStrike, sigma, ttSec, m.strikeType, m.underlying);
  const gbmPClipped = Math.max(Math.min(gbmP, 1 - 1e-6), 1e-6);
  const gbm_logit = Math.log(gbmPClipped / (1 - gbmPClipped));

  const is_btc = m.underlying === 'BTC' ? 1.0 : 0.0;
  const is_greater = m.strikeType === 'greater' ? 1.0 : 0.0;

  const z =
    COEFFICIENTS.intercept +
    COEFFICIENTS.log_moneyness * log_moneyness +
    COEFFICIENTS.z_score * z_score +
    COEFFICIENTS.gbm_logit * gbm_logit +
    COEFFICIENTS.is_btc * is_btc +
    COEFFICIENTS.is_greater * is_greater;

  return Math.max(0, Math.min(1, sigmoid(z)));
}

/**
 * Minimal sanity check for the coefficients and sigmoid.
 * Call this once on startup if you want a quick self-test.
 */
export function selfTest(): void {
  // BTC spot=77500, strike=77600 (OTM call), sigma=1.0, ttSec=2400
  // GBM would give ~30-40%; empirical should give <20%
  const m: EmpiricalMarketInput = {
    underlying: 'BTC',
    strikeType: 'greater',
    floorStrike: 77600,
    yesBid: 0.15,
    yesAsk: 0.19,
  };
  const prob = empiricalYesProb(m, 77500, 1.0, 2400);
  const raw  = empiricalYesProbRaw(m, 77500, 1.0, 2400);
  // With market mid=0.17 and 70/30 blend, result should be ~0.17
  const ok = prob >= 0.10 && prob <= 0.30;
  console.log(
    `[cryptoEmpiricalModel] selfTest: prob=${prob.toFixed(4)} raw=${raw.toFixed(4)} ${ok ? 'PASS' : 'WARN: unexpected range'}`,
  );
}
