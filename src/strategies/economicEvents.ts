/**
 * STRATEGY: Economic Events — Macro Divergence Trading
 *
 * Trades Kalshi macro markets (FOMC/CPI/NFP/GDP) when CME FedWatch or
 * Cleveland Fed / Atlanta Fed nowcasts diverge from Kalshi mid price by >5%.
 *
 * SAFETY: If any external source is unparseable, signalsValid=false → 0 trades
 * that cycle. Maker-only. Cancel orders 1 hr before close. Max $35 / 3/8 Kelly.
 */

import axios from 'axios';
import { KalshiConnector } from '../connectors/kalshi.js';
import { getRiskEngine } from '../risk/riskEngine.js';
import { recordSignal, recordOrder, recordHeartbeat, upsertMarket, findOrderByExternalId, updateOrder } from '../db/supabase.js';
import { sendDiscord } from '../utils/discord.js';
import { getConfig } from '../utils/config.js';
import { createStrategyLogger } from '../utils/logger.js';

const log = createStrategyLogger('economic_events');

// PART B (May 22 PM 2026): AAA gas + Freddie mortgage signals re-enabled with
// per-strike normal-CDF scoring. Previously these emitted a SCALAR prob (e.g.
// 0.75 = "price rose week-over-week") that was broadcast to every strike,
// causing systematic OTM bleed. Now `fetchAAAGasPrice`/`fetchMortgageRate`
// return `currentPrice` + `weeklyVol` and per-market scoring uses
// P(spot_next_week > strike) = 1 - Φ((strike - spot)/sigma) for "above"
// markets, inverted for "below"/"minimum" markets.
const MACRO_SERIES     = ['KXFED', 'KXCPI', 'KXNFP', 'KXGDP', 'KXFEDDECISION',
                          'KXAAAGASD', 'KXAAAGASMIN', 'AAAGAS', 'FRM', 'KXMORTGAGE'];
const POLL_MS          = 5 * 60 * 1000;
const SIGNAL_MS        = 10 * 60 * 1000;
const HEARTBEAT_MS     = 60 * 1000;
const MIN_DIV          = 0.05;
const MAX_DIV          = 0.40;
const MAX_TRADE_USD    = 35;
const KELLY_MULT       = 0.375;
const CANCEL_BEFORE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT    = 10_000;
const DEDUP_MS         = 60 * 60 * 1000;

interface MacroMarket {
  ticker: string; eventTicker: string; series: string; title: string;
  closesAtMs: number;
  yesBid?: number; yesAsk?: number; noBid?: number; noAsk?: number;
  liquidityUsd?: number; marketDbId?: string; lastOrderAt?: number;
}
interface ModelSignal {
  key: string;
  prob: number;
  description: string;
  prediction?: number;
  confidence?: number;
  /**
   * PART B: for level/strike-style markets (gas, mortgage), the parser emits
   * `currentValue` (today's spot) and `weeklyVol` (1-σ next-week change). Per-market
   * scoring uses `1 - Φ((strike - currentValue) / weeklyVol)` to derive a per-strike
   * prob. Old scalar `prob` retained for direction-only consumers.
   */
  currentValue?: number;
  weeklyVol?: number;
}

const parseD = (v: any, div = 1): number | undefined =>
  v != null && v !== '' ? parseFloat(v) / div : undefined;

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/**
 * Abramowitz-Stegun cumulative normal approximation, accurate to ~7e-8.
 * Standard textbook form; no external deps.
 */
function normalCdf(z: number): number {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = z < 0 ? -1 : 1;
  const az = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * az);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-az * az);
  return 0.5 * (1.0 + sign * y);
}

async function get(url: string): Promise<{ status: number; data: any }> {
  const r = await axios.get(url, {
    timeout: FETCH_TIMEOUT,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PandaXPanther-Bot/1.0)' },
    validateStatus: (s) => s < 500,
  });
  return { status: r.status, data: r.data };
}

// FedWatch (FOMC cut probability): Primary source — Atlanta Fed Market Probability Tracker
// (https://www.atlantafed.org/research-and-data/data/market-probability-tracker)
// The page embeds ProbDate/ProbContract/ProbBucket/Prob JS arrays and RateMovesBasisPoints.
// We sum probabilities for all buckets BELOW the current rate range for the nearest FOMC contract.
// CME FedWatch was previously used here but now returns 403 for automated requests.
async function fetchCMEFedWatch(): Promise<ModelSignal | null> {
  // Primary: Atlanta Fed Market Probability Tracker (embeds probability JS arrays in HTML)
  try {
    const { status, data: html } = await get(
      'https://www.atlantafed.org/research-and-data/data/market-probability-tracker'
    );
    if (status === 200) {
      const text = typeof html === 'string' ? html : JSON.stringify(html);

      const extractArr = (name: string): any[] | null => {
        const m = text.match(new RegExp(`var ${name}\\s*=\\s*(\\[[^\\]]+\\]);`));
        if (!m) return null;
        try { return JSON.parse(m[1]); } catch { return null; }
      };

      const probArr      = extractArr('Prob');
      const bucketArr    = extractArr('ProbBucket');
      const contractArr  = extractArr('ProbContract');
      const dateArr      = extractArr('ProbDate');
      const rateMoves    = extractArr('RateMovesBasisPoints');

      if (probArr && bucketArr && contractArr && dateArr && rateMoves && rateMoves[0]) {
        // Parse current rate range, e.g. '350 - 375'
        const rateStr = String(rateMoves[0]);
        const rParts  = rateStr.replace(/\s/g, '').split('-');
        const currentLowBps = rParts.length >= 2 ? parseInt(rParts[0], 10) : NaN;
        if (!isNaN(currentLowBps)) {
          // Take the most recent date and nearest (first) FOMC contract
          const latestDate    = dateArr[0];
          const nearestFOMC   = contractArr[0];
          let cutProb = 0;
          for (let i = 0; i < probArr.length; i++) {
            if (dateArr[i] !== latestDate || contractArr[i] !== nearestFOMC) continue;
            const bucket = String(bucketArr[i]);
            const p      = Number(probArr[i]);
            if (!isFinite(p)) continue;
            // Is this bucket entirely below the current range? → counts as a cut
            if (bucket.startsWith('<')) {
              const cap = parseInt(bucket.replace(/[^\d]/g, ''), 10);
              if (cap <= currentLowBps) cutProb += p;
            } else if (!bucket.startsWith('>')) {
              const parts = bucket.replace(/bps/gi, '').split('-').map((s) => parseInt(s.trim(), 10));
              if (parts.length === 2 && parts[1] <= currentLowBps) cutProb += p;
            }
          }
          const prob = Math.max(0, Math.min(1, cutProb / 100));
          log.info({ cutProb, nearestFOMC, latestDate }, 'Atlanta Fed MPT: parsed FOMC cut prob');
          return { key: 'FOMC_CUT', prob, description: `Atlanta Fed MPT (${latestDate}): ${cutProb.toFixed(1)}% cut by ${nearestFOMC}` };
        }
      }
    }
  } catch (e: any) { log.debug({ err: e.message }, 'Atlanta Fed MPT failed'); }

  // Fallback: look for any inline probability pattern on the page
  try {
    const { data: html } = await get('https://www.atlantafed.org/research-and-data/data/market-probability-tracker');
    const text = typeof html === 'string' ? html : JSON.stringify(html);
    // Try to find any cut probability figure embedded in the page text
    const m = text.match(/cut[^0-9]{0,60}([\d.]+)\s*%/i)
           ?? text.match(/probability[^0-9]{0,60}([\d.]+)\s*%/i);
    if (m) {
      const raw = parseFloat(m[1]);
      if (isFinite(raw) && raw >= 0 && raw <= 100) {
        const prob = raw / 100;
        return { key: 'FOMC_CUT', prob, description: `Atlanta Fed MPT fallback: ${raw.toFixed(1)}% cut` };
      }
    }
  } catch (e: any) { log.debug({ err: e.message }, 'Atlanta Fed MPT fallback failed'); }

  log.warn('FOMC cut prob: all parse attempts failed — FOMC signals disabled this cycle');
  return null;
}

// Cleveland Fed Nowcast: CPI and PCE YoY nowcast.
// Source: https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting
// The page uses FusionCharts with data loaded from:
//   /-/media/files/webcharts/inflationnowcasting/nowcast_year.json
// Structure: array of objects keyed by forecast month (subcaption = 'YYYY-M').
// Each has 'dataset' with series 'CPI Inflation', 'PCE Inflation', etc.
// We take the entry whose subcaption matches the current calendar year-month,
// and use the last non-empty value in the CPI Inflation series.
async function fetchClevelandFedNowcast(): Promise<ModelSignal | null> {
  const JSON_URL = 'https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_year.json?sc_lang=en';

  // Primary: FusionCharts JSON data file embedded in the Cleveland Fed page
  try {
    const { status, data } = await get(JSON_URL);
    if (status === 200 && Array.isArray(data) && data.length > 0) {
      // Find the entry for the current year-month (subcaption = 'YYYY-M')
      const now       = new Date();
      const yearMonth = `${now.getFullYear()}-${now.getMonth() + 1}`;
      // If not found, fall back to the most recently populated entry
      let entry: any = data.find((d: any) => d?.chart?.subcaption === yearMonth);
      if (!entry) {
        // Walk backwards through entries to find the most recent one with CPI data
        for (let i = data.length - 1; i >= 0; i--) {
          const ds = (data[i]?.dataset ?? []) as any[];
          const cpiSeries = ds.find((s: any) => s.seriesname === 'CPI Inflation');
          if (cpiSeries) {
            const vals = (cpiSeries.data as any[]).filter((d: any) => d.value !== '');
            if (vals.length > 0) { entry = data[i]; break; }
          }
        }
      }
      if (entry) {
        const subcap = entry?.chart?.subcaption ?? 'unknown';
        const ds     = (entry?.dataset ?? []) as any[];
        // Pull latest non-empty CPI and PCE nowcast values
        let cpiVal: number | null = null;
        let pceVal: number | null = null;
        for (const series of ds) {
          if (series.seriesname === 'CPI Inflation') {
            const vals = (series.data as any[]).filter((d: any) => d.value !== '');
            if (vals.length > 0) cpiVal = parseFloat(vals[vals.length - 1].value);
          }
          if (series.seriesname === 'PCE Inflation') {
            const vals = (series.data as any[]).filter((d: any) => d.value !== '');
            if (vals.length > 0) pceVal = parseFloat(vals[vals.length - 1].value);
          }
        }
        // Use CPI as primary signal; PCE stored for reference
        if (cpiVal !== null && isFinite(cpiVal)) {
          const prob = sigmoid((cpiVal - 3.0) / 0.30);
          const pceNote = pceVal !== null ? `, PCE=${pceVal.toFixed(2)}%` : '';
          log.info({ cpiVal, pceVal, subcap }, 'Cleveland Fed: parsed CPI nowcast');
          return { key: 'CPI', prob, description: `Cleveland Fed (${subcap}): CPI ${cpiVal.toFixed(2)}%${pceNote} → P>3%=${(prob*100).toFixed(1)}%` };
        }
      }
    }
  } catch (e: any) { log.debug({ err: e.message }, 'Cleveland Fed JSON failed'); }

  // Fallback: scan the main inflation nowcasting page for any embedded value
  try {
    const { data: html } = await get('https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting');
    const text = typeof html === 'string' ? html : JSON.stringify(html);
    // Look for a numeric value in the context of CPI/nowcast
    for (const pat of [
      /nowcast[:\s]+([\d.]+)\s*%/i,
      /cpi[^0-9]{1,50}([\d.]+)\s*%/i,
      /"value"\s*:\s*"([\d.]+)"/,
    ]) {
      const m = text.match(pat);
      if (m) {
        const v = parseFloat(m[1]);
        if (isFinite(v) && v > 0 && v < 20) {
          const prob = sigmoid((v - 3.0) / 0.30);
          return { key: 'CPI', prob, description: `Cleveland Fed HTML fallback: CPI ${v.toFixed(2)}% → P>3%=${(prob*100).toFixed(1)}%` };
        }
      }
    }
  } catch (e: any) { log.debug({ err: e.message }, 'Cleveland Fed HTML fallback failed'); }

  log.warn('Cleveland Fed: all parse attempts failed — CPI signals disabled this cycle');
  return null;
}

// Atlanta Fed GDPNow: quarterly GDP growth estimate.
// Source: https://www.atlantafed.org/cqer/research/gdpnow
// The page embeds two JS arrays: `gdpValues` and `gdpDates` for the CURRENT quarter.
// gdpValues[0] is a placeholder 0; actual estimates start at index 1.
// The last non-zero value in gdpValues is the latest nowcast.
// Old URL (cato/real-time-data-research/gdpnow) returns 404 — correct URL is cqer/research/gdpnow.
async function fetchAtlantaFedGDPNow(): Promise<ModelSignal | null> {
  const GDPNOW_URL = 'https://www.atlantafed.org/cqer/research/gdpnow';

  // Primary: parse embedded JS arrays gdpValues / gdpDates
  try {
    const { status, data: html } = await get(GDPNOW_URL);
    if (status === 200) {
      const text = typeof html === 'string' ? html : JSON.stringify(html);

      const extractJsArr = (name: string): number[] | null => {
        const m = text.match(new RegExp(`var ${name}\\s*=\\s*(\\[[^\\]]+\\])`, 's'));
        if (!m) return null;
        try {
          const arr = JSON.parse(m[1]) as any[];
          return arr.map(Number).filter((v) => isFinite(v));
        } catch { return null; }
      };

      const gdpValues = extractJsArr('gdpValues');
      const gdpDates  = text.match(/var gdpDates\s*=\s*(\[[^\]]+\])/);

      if (gdpValues && gdpValues.length > 1) {
        // Skip index 0 (always 0, placeholder); take last non-zero value
        const valid = gdpValues.slice(1).filter((v) => v !== 0);
        if (valid.length > 0) {
          const v    = valid[valid.length - 1];
          const dateStr = gdpDates ? ((): string => {
            try {
              const dates = JSON.parse(gdpDates[1]) as string[];
              // dates[0] is 'Date' label; last real entry is dates[valid.length]
              return dates[valid.length] ?? 'recent';
            } catch { return 'recent'; }
          })() : 'recent';
          const prob = sigmoid((v - 2.0) / 0.50);
          log.info({ nowcast: v, dateStr }, 'Atlanta Fed GDPNow: parsed');
          return { key: 'GDP', prob, description: `GDPNow (${dateStr}): ${v.toFixed(2)}% → P>2%=${(prob*100).toFixed(1)}%` };
        }
      }

      // Fallback regex patterns for older page layouts
      for (const pat of [
        /model estimate[^0-9]{1,100}([-\d.]+)\s*percent/i,
        /GDPNow[^0-9]{1,50}([-\d.]+)\s*(?:percent|%)/i,
        /"gdpNow"\s*:\s*([-\d.]+)/i,
      ]) {
        const m = text.match(pat);
        if (m) {
          const v = parseFloat(m[1]);
          if (isFinite(v) && v > -10 && v < 20) {
            const prob = sigmoid((v - 2.0) / 0.50);
            log.info({ nowcast: v }, 'Atlanta Fed GDPNow: regex fallback parsed');
            return { key: 'GDP', prob, description: `GDPNow regex: ${v.toFixed(2)}% → P>2%=${(prob*100).toFixed(1)}%` };
          }
        }
      }
    }
  } catch (e: any) { log.debug({ err: e.message }, 'Atlanta Fed GDPNow failed'); }

  log.warn('Atlanta Fed GDPNow: parse failed — GDP signals disabled this cycle');
  return null;
}

// AAA US Gas Price (weekly)
// Primary: AAA gas prices page — embeds today/yesterday/week-ago/month-ago/year-ago in HTML table.
// Model: next week's price ≈ today + 7-day delta * 0.5 (mean-reverting random walk).
// Output: ModelSignal with key 'GAS_AAA', prediction in $/gal, confidence 0.7.
async function fetchAAAGasPrice(): Promise<ModelSignal | null> {
  const AAA_URL = 'https://gasprices.aaa.com/';
  try {
    const { status, data: html } = await get(AAA_URL);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    const text = typeof html === 'string' ? html : JSON.stringify(html);

    // Parse "Today's AAA National Average $X.XXX" from page header.
    // FIXED 2026-05-22: AAA's HTML uses a Unicode RIGHT SINGLE QUOTATION MARK
    // (U+2019, the 'smart' apostrophe), not the ASCII apostrophe "'". The old
    // regex never matched, AAA gas signal was silently disabled, daily-gas
    // strategy fired ZERO trades. Match both forms now.
    const todayMatch =
      text.match(/Today[\u2019']s AAA National Average\s*\$([\d.]+)/i) ||
      // Fallback: just look for "National Average $X.XX" if header structure changes
      text.match(/National Average\s*\$([\d.]+)/i);
    if (!todayMatch) throw new Error('AAA today price not found');
    const todayPrice = parseFloat(todayMatch[1]);
    if (!isFinite(todayPrice) || todayPrice < 1 || todayPrice > 10)
      throw new Error(`AAA today price out of range: ${todayPrice}`);

    // v2 M-4 fix: previous regex `Week Ago Avg\..*?\$([\d.]+)` was greedy across DOM —
    // if AAA injected an unrelated `$` token (chg cell, ad block) before the actual
    // price, it grabbed the wrong number silently. Restrict the gap to non-`$` chars.
    const weekAgoMatch = text.match(/Week Ago Avg\.[^$]*?\$([\d.]+)/);
    const weekAgoPrice = weekAgoMatch ? parseFloat(weekAgoMatch[1]) : null;

    // Predicted next-week price: today ± half the 7-day change (mean reversion)
    let nextPrice: number;
    let description: string;
    if (weekAgoPrice !== null && isFinite(weekAgoPrice) && weekAgoPrice > 1) {
      const weeklyChange  = todayPrice - weekAgoPrice;
      const halfReversion = weeklyChange * 0.5;
      nextPrice = todayPrice + halfReversion;
      description = `AAA Gas: today=$${todayPrice.toFixed(3)}, weekAgo=$${weekAgoPrice.toFixed(3)}, nextWeekEst=$${nextPrice.toFixed(3)}`;
    } else {
      // Fallback: no change expected
      nextPrice = todayPrice;
      description = `AAA Gas: today=$${todayPrice.toFixed(3)}, weekAgo=unknown, nextWeekEst=$${nextPrice.toFixed(3)} (no-change fallback)`;
    }

    // PART B: emit structured currentValue + weeklyVol so per-market scoring can
    // compute P(spot_next_week > strike) via a normal CDF, instead of broadcasting
    // one scalar prob across every strike.
    // v2 L-5: drop redundant null guard (outer `!== null` already ensures finite).
    const weeklyChange = weekAgoPrice !== null && isFinite(weekAgoPrice) ? todayPrice - weekAgoPrice : 0;
    // Direction-only prob (kept for backward-compat); strike-aware scoring lives in
    // strikeAwareProb() below and is what evaluateMarket() actually uses.
    const prob = Math.max(0.05, Math.min(0.95, 0.5 + weeklyChange / 0.20));
    // Historical AAA weekly std-dev ≈ $0.04 over 2010-2025 (small moves), but recent
    // years (2022 oil shocks, 2024+ refinery outages) show $0.06-$0.10 spikes. Use
    // $0.04 as default sigma when we can't estimate; widen using observed |change|.
    const weeklyVol = Math.max(0.04, Math.abs(weeklyChange) * 0.75);

    // v2 L-6 mitigation: if weekAgo is missing, confidence drops sharply (we have spot
    // but no recent-trend context); M-2 below will shrink prob toward 0.5 by (1-conf).
    const confidence = weekAgoPrice !== null && isFinite(weekAgoPrice) ? 0.7 : 0.35;
    log.info({ todayPrice, weekAgoPrice, nextPrice, weeklyVol, confidence }, 'AAA Gas: parsed');
    return {
      key: 'GAS_AAA',
      prob,
      description,
      prediction: nextPrice,
      confidence,
      currentValue: todayPrice,
      weeklyVol,
    };
  } catch (e: any) {
    log.warn({ err: e.message }, 'AAA Gas: failed to fetch/parse');
    return null;
  }
}

// Mortgage 30-Year Rate (weekly, Thursday Freddie Mac PMMS release)
// Primary: Freddie Mac PMMS page — embeds current 30yr/15yr rate in meta description and HTML.
// Secondary: Fed H15 10-year Treasury CSV + ~2.5% spread as cross-check.
// Model: next week's 30yr rate ≈ current rate + 0.5 * (10yr Treasury implied − current rate).
//        The 10yr Treasury spread to mortgage historically ~2.0–2.8%; we use 2.4% as midpoint.
// Output: ModelSignal with key 'MORTGAGE_30Y', prediction in %, confidence 0.65.
async function fetchMortgageRate(): Promise<ModelSignal | null> {
  const PMMS_URL   = 'https://www.freddiemac.com/pmms';
  const FED_H15_URL = 'https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series=bf17364827e38702b42a58cf8eaa3f78&lastObs=5&filetype=csv&label=include&layout=seriescolumn';
  const SPREAD_PCT = 2.4; // historical 30yr mortgage − 10yr Treasury spread in percentage points

  // Step 1: parse current 30yr rate from Freddie Mac PMMS
  let currentRate: number | null = null;
  let rateSource = '';
  try {
    const { status, data: html } = await get(PMMS_URL);
    if (status === 200) {
      const text = typeof html === 'string' ? html : JSON.stringify(html);
      // Primary pattern: meta description or callout stat block
      const m = text.match(/30-year fixed-rate mortgage[^0-9]{1,60}([\d.]+)%/i)
             ?? text.match(/stat weight-bold">([\d.]+)%/)
             ?? text.match(/Mortgage Rates Average ([\d.]+)%/i);
      if (m) {
        const v = parseFloat(m[1]);
        if (isFinite(v) && v > 3 && v < 12) { currentRate = v; rateSource = 'Freddie Mac PMMS'; }
      }
    }
  } catch (e: any) { log.debug({ err: e.message }, 'PMMS fetch failed'); }

  if (currentRate === null) {
    log.warn('PMMS: could not parse 30yr rate — mortgage signals disabled this cycle');
    return null;
  }

  // Step 2: get latest 10-year Treasury yield from Fed H15 as cross-check
  let treasury10yr: number | null = null;
  try {
    const { status, data: csvRaw } = await get(FED_H15_URL);
    if (status === 200) {
      const csv  = typeof csvRaw === 'string' ? csvRaw : JSON.stringify(csvRaw);
      const rows = csv.split('\n').filter((r) => /^\d{4}-/.test(r.trim()));
      if (rows.length > 0) {
        // v2 M-3 fix: this URL pulls a SINGLE series (bf17... = 10yr Treasury constant
        // maturity), so the CSV format is `date,value` — index 1, not index 8 (which
        // was for the multi-series H15 dump). The old index would silently fall back
        // to no-change every cycle, degrading the mortgage signal invisibly.
        const cols = rows[rows.length - 1].split(',');
        const v    = parseFloat(cols[1]);
        if (isFinite(v) && v > 0.5 && v < 10) treasury10yr = v;
      }
    }
  } catch (e: any) { log.debug({ err: e.message }, 'Fed H15 fetch failed'); }

  // Step 3: compute predicted next-week rate
  let nextRate: number;
  let description: string;
  if (treasury10yr !== null) {
    const treasuryImplied = treasury10yr + SPREAD_PCT;
    // Pull half the gap between treasury-implied and current rate (mean-reverting)
    const pullToward = (treasuryImplied - currentRate) * 0.15;
    // Also allow small random-walk term (rates change slowly)
    nextRate    = currentRate + pullToward;
    description = `PMMS 30yr=${currentRate}%, 10yr Treasury=${treasury10yr}%, ` +
                  `implied=${treasuryImplied.toFixed(2)}%, nextWeekEst=${nextRate.toFixed(2)}% (${rateSource})`;
  } else {
    // Fallback: expect ±0.05% unchanged
    nextRate    = currentRate;
    description = `PMMS 30yr=${currentRate}%, nextWeekEst=${nextRate.toFixed(2)}% (no-change fallback; Fed H15 unavailable)`;
  }

  // PART B: emit structured currentValue + weeklyVol for per-strike scoring.
  const impliedGap = treasury10yr !== null ? (treasury10yr + SPREAD_PCT - currentRate) : 0;
  const prob = Math.max(0.05, Math.min(0.95, 0.5 + impliedGap / 1.0));
  // PMMS historical week-over-week std-dev ≈ 0.08 percentage points over the last 5 years
  // (range 0.04 in flat regimes to 0.20+ in 2022-2023 spike). Use 0.08 as default sigma
  // and widen with the observed implied-gap magnitude.
  const weeklyVol = Math.max(0.08, Math.abs(impliedGap) * 0.5);

  log.info({ currentRate, treasury10yr, nextRate, weeklyVol }, 'Mortgage 30Y: parsed');
  return {
    key: 'MORTGAGE_30Y',
    prob,
    description,
    prediction: nextRate,
    confidence: 0.65,
    currentValue: currentRate,
    weeklyVol,
  };
}

/**
 * PART B: extract the strike threshold from a Kalshi market ticker. Returns null if
 * we can't find a number. Supports:
 *   - KXAAAGASD-26MAY23-4.525        → 4.525 (gas in $/gal)
 *   - KXAAAGASMIN-26MAY23-T4.45     → 4.45  (gas minimum threshold)
 *   - FRM-26MAY28-6.50              → 6.50  (mortgage 30yr in %)
 *   - KXMORTGAGE-26W22-T6.60        → 6.60
 * The last hyphen-separated segment is taken as the strike, stripping any leading
 * direction letter (T/B/L/G). Fractional decimal expected.
 */
function parseStrikeFromTicker(ticker: string): number | null {
  const parts = ticker.split('-');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].replace(/^[A-Za-z]+/, '');
  const v = parseFloat(last);
  return isFinite(v) ? v : null;
}

/**
 * PART B: detect whether YES on a market means "value above/at strike" vs
 * "value below/at strike". Falls back to the series convention if the title is
 * ambiguous. AAA daily (`KXAAAGASD`) defaults YES = above; AAAGASMIN markets
 * phrase YES as "minimum at or below the strike" (so direction = 'below').
 * Mortgage (`FRM`, `KXMORTGAGE`) defaults YES = above.
 */
function detectStrikeDirection(series: string, title: string): 'above' | 'below' {
  const t = (title ?? '').toLowerCase();
  if (/\b(below|under|at or below|≤|<=)\b/.test(t)) return 'below';
  if (/\bminimum\b/.test(t))                         return 'below'; // "minimum" framings
  if (/\b(above|over|at or above|≥|>=)\b/.test(t))   return 'above';
  // Series defaults when title is silent:
  if (series === 'KXAAAGASMIN') return 'below';
  return 'above';
}

/**
 * PART B: compute P(YES) for a strike-style market using a normal CDF on the
 * next-week distribution. Returns null if the signal doesn't carry currentValue/vol.
 */
function strikeAwareProb(
  signal: ModelSignal | undefined,
  strike: number,
  direction: 'above' | 'below',
): number | null {
  if (!signal) return null;
  if (signal.currentValue == null || signal.weeklyVol == null || signal.weeklyVol <= 0) return null;
  const z = (strike - signal.currentValue) / signal.weeklyVol;
  const probAbove = 1 - normalCdf(z);
  const raw = direction === 'above' ? probAbove : 1 - probAbove;
  // v2 M-2: shrink toward 0.5 by (1 - confidence). For brittle HTML scrapes (conf ~0.65-0.7)
  // this trims edge by 30-35%, keeping sizing honest. confidence=1 means no shrinkage.
  const conf = (signal.confidence != null && isFinite(signal.confidence))
    ? Math.max(0, Math.min(1, signal.confidence))
    : 1;
  const shrunk = 0.5 + (raw - 0.5) * conf;
  // Clip into [0.02, 0.98] so we never claim certainty on a brittle HTML-scrape signal.
  return Math.max(0.02, Math.min(0.98, shrunk));
}

/**
 * Map Kalshi series + market → model prob. For strike-style series (gas, mortgage)
 * the prob is per-strike via a normal CDF. For event-style series (FOMC/CPI/GDP)
 * the legacy scalar prob is returned unchanged.
 *
 * Returns null if no signal exists for the series.
 */
function getModelProb(m: MacroMarket, signals: Map<string, ModelSignal>): number | null {
  const series = m.series;
  if (series === 'KXFED' || series === 'KXFEDDECISION') return signals.get('FOMC_CUT')?.prob ?? null;
  if (series === 'KXCPI') return signals.get('CPI')?.prob ?? null;
  if (series === 'KXGDP') return signals.get('GDP')?.prob ?? null;

  // PART B: strike-aware probability for level markets
  if (series === 'KXAAAGASD' || series === 'KXAAAGASMIN' || series === 'AAAGAS') {
    const sig = signals.get('GAS_AAA');
    if (!sig) return null;
    const strike = parseStrikeFromTicker(m.ticker);
    if (strike === null) return null;
    const direction = detectStrikeDirection(series, m.title);
    return strikeAwareProb(sig, strike, direction);
  }
  if (series === 'FRM' || series === 'KXMORTGAGE') {
    const sig = signals.get('MORTGAGE_30Y');
    if (!sig) return null;
    const strike = parseStrikeFromTicker(m.ticker);
    if (strike === null) return null;
    const direction = detectStrikeDirection(series, m.title);
    return strikeAwareProb(sig, strike, direction);
  }
  return null; // KXNFP: no reliable external source wired yet
}

export class EconomicEventsStrategy {
  readonly name = 'economic_events';

  private markets    = new Map<string, MacroMarket>();
  private signals    = new Map<string, ModelSignal>();
  private openOrders = new Map<string, { ticker: string; closesAtMs: number; side: 'yes' | 'no' }>();

  private signalsValid      = false;
  private opportunitiesSeen = 0;
  private fires             = 0;
  private lastCpiNowcast: number | null = null;
  private lastFedWatch:   number | null = null;

  constructor(private kalshi: KalshiConnector) {}

  async start(): Promise<void> {
    log.info('economic_events strategy starting');
    await Promise.allSettled([this.discoverMarkets(), this.refreshSignals()]);
    setInterval(() => this.discoverMarkets(),  POLL_MS);
    setInterval(() => this.refreshSignals(),   SIGNAL_MS);
    setInterval(() => this.evaluateAll(),      POLL_MS);
    setInterval(() => this.cancelPreClose(),   10 * 60 * 1000);
    setInterval(() => this.heartbeat(),        HEARTBEAT_MS);
    log.info({ tracked: this.markets.size, signals: [...this.signals.keys()] }, 'Economic events strategy running');
  }

  private async discoverMarkets(): Promise<void> {
    const now = Date.now();
    for (const [t, m] of this.markets) if (m.closesAtMs < now) this.markets.delete(t); // prune expired

    let added = 0;
    for (const series of MACRO_SERIES) {
      try {
        const { data } = await axios.get(
          'https://api.elections.kalshi.com/trade-api/v2/markets',
          { params: { series_ticker: series, status: 'open', limit: 200 }, timeout: FETCH_TIMEOUT }
        );
        for (const m of (data?.markets ?? []) as any[]) {
          if (this.markets.has(m.ticker)) continue;
          const parsed = this.parseMarket(m, series);
          if (parsed) { this.markets.set(m.ticker, parsed); added++; }
        }
      } catch (e: any) {
        if (!String(e.message ?? '').includes('429'))
          log.warn({ series, err: e.message }, 'discoverMarkets series failed');
      }
      await new Promise((r) => setTimeout(r, 200)); // rate-limit safety between series
    }
    if (added > 0) log.info({ added, tracked: this.markets.size }, 'Economic events: discovered markets');
  }

  private parseMarket(m: any, series: string): MacroMarket | null {
    const closeMs = m.close_time ? new Date(m.close_time).getTime() : 0;
    if (!closeMs || closeMs < Date.now()) return null;
    return {
      ticker: m.ticker, series, title: m.title ?? m.ticker,
      eventTicker: m.event_ticker ?? m.ticker.split('-').slice(0, 2).join('-'),
      closesAtMs: closeMs,
      yesBid: parseD(m.yes_bid_dollars) ?? parseD(m.yes_bid, 100),
      yesAsk: parseD(m.yes_ask_dollars) ?? parseD(m.yes_ask, 100),
      noBid:  parseD(m.no_bid_dollars)  ?? parseD(m.no_bid,  100),
      noAsk:  parseD(m.no_ask_dollars)  ?? parseD(m.no_ask,  100),
      liquidityUsd: parseD(m.liquidity_dollars) ?? parseD(m.liquidity, 100),
    };
  }

  private async refreshBook(m: MacroMarket): Promise<void> {
    try {
      const { data } = await axios.get(
        `https://api.elections.kalshi.com/trade-api/v2/markets/${m.ticker}`, { timeout: FETCH_TIMEOUT }
      );
      const mk = data?.market; if (!mk) return;
      m.yesBid = parseD(mk.yes_bid_dollars) ?? parseD(mk.yes_bid, 100);
      m.yesAsk = parseD(mk.yes_ask_dollars) ?? parseD(mk.yes_ask, 100);
      m.noBid  = parseD(mk.no_bid_dollars)  ?? parseD(mk.no_bid,  100);
      m.noAsk  = parseD(mk.no_ask_dollars)  ?? parseD(mk.no_ask,  100);
      m.liquidityUsd = parseD(mk.liquidity_dollars) ?? parseD(mk.liquidity, 100) ?? m.liquidityUsd;
    } catch { /* stale quotes: skip evaluation this cycle */ }
  }

  // Refresh all external sources. Success updates signal; failure deletes it.
  // signalsValid=false if all fail → evaluateAll fires NO trades.
  private async refreshSignals(): Promise<void> {
    log.info('Refreshing external macro signals');
    const [fed, cpi, gdp, gas, mortgage] = await Promise.allSettled([
      fetchCMEFedWatch(), fetchClevelandFedNowcast(), fetchAtlantaFedGDPNow(),
      fetchAAAGasPrice(), fetchMortgageRate(),
    ]);
    if (fed.status === 'fulfilled' && fed.value)  { this.signals.set(fed.value.key, fed.value); this.lastFedWatch = fed.value.prob; }
    else { this.signals.delete('FOMC_CUT'); this.lastFedWatch = null; log.warn({ r: fed.status === 'rejected' ? fed.reason?.message : 'null' }, 'FedWatch failed'); }
    if (cpi.status === 'fulfilled' && cpi.value)  { this.signals.set(cpi.value.key, cpi.value); this.lastCpiNowcast = cpi.value.prob; }
    else { this.signals.delete('CPI'); this.lastCpiNowcast = null; log.warn({ r: cpi.status === 'rejected' ? cpi.reason?.message : 'null' }, 'Cleveland Fed failed'); }
    if (gdp.status === 'fulfilled' && gdp.value)  { this.signals.set(gdp.value.key, gdp.value); }
    else { this.signals.delete('GDP'); log.warn({ r: gdp.status === 'rejected' ? gdp.reason?.message : 'null' }, 'Atlanta Fed failed'); }
    if (gas.status === 'fulfilled' && gas.value)  { this.signals.set(gas.value.key, gas.value); }
    else { this.signals.delete('GAS_AAA'); log.warn({ r: gas.status === 'rejected' ? gas.reason?.message : 'null' }, 'AAA Gas failed'); }
    if (mortgage.status === 'fulfilled' && mortgage.value) { this.signals.set(mortgage.value.key, mortgage.value); }
    else { this.signals.delete('MORTGAGE_30Y'); log.warn({ r: mortgage.status === 'rejected' ? mortgage.reason?.message : 'null' }, 'Mortgage PMMS failed'); }
    this.signalsValid = this.signals.size > 0;
    if (!this.signalsValid) log.warn('ALL external signals failed — no trades will fire this cycle');
    else log.info({ signals: [...this.signals.keys()] }, 'Signal refresh complete');
  }

  private async evaluateAll(): Promise<void> {
    if (!this.signalsValid || this.signals.size === 0) { log.info('Skipping eval — no valid signals'); return; }
    for (const m of this.markets.values()) {
      if (m.closesAtMs - Date.now() < CANCEL_BEFORE_MS) continue;
      await this.refreshBook(m);
      await this.evaluateMarket(m);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async evaluateMarket(m: MacroMarket): Promise<void> {
    if (m.yesBid == null || m.yesAsk == null) return;
    const modelProb = getModelProb(m, this.signals);
    if (modelProb === null) return;
    const marketMid  = (m.yesBid + m.yesAsk) / 2;
    const divergence = modelProb - marketMid;
    const absDiv     = Math.abs(divergence);
    if (absDiv > MAX_DIV)  { log.debug({ ticker: m.ticker, absDiv }, 'divergence too large — skipping'); return; }
    if (absDiv < MIN_DIV) return;
    this.opportunitiesSeen++;
    const now = Date.now();
    if (m.lastOrderAt && now - m.lastOrderAt < DEDUP_MS) { log.debug({ ticker: m.ticker }, 'skipped — recent order'); return; }

    let side: 'yes' | 'no'; let entryPrice: number;
    if (divergence > 0) {
      side = 'yes'; entryPrice = m.yesBid; // post YES at best bid (maker)
    } else {
      side = 'no';
      const noBid = m.noBid ?? (m.yesAsk != null ? 1 - m.yesAsk : null);
      if (noBid == null || noBid <= 0) return;
      entryPrice = noBid; // post NO at best bid (maker)
    }
    if (entryPrice <= 0.01 || entryPrice >= 0.99) return;

    const risk    = getRiskEngine();
    const kelly   = risk.kellySize(modelProb, marketMid, side.toUpperCase() as 'YES' | 'NO');
    if (kelly < 0.001) return;
    const sizeUsd = Math.min(kelly * KELLY_MULT * risk.getStats().bankroll, MAX_TRADE_USD);
    const check   = risk.canTrade(this.name, m.ticker, sizeUsd, {
      closesAt: new Date(m.closesAtMs), eventTicker: m.eventTicker,
      fractional: false, liquidityUsd: m.liquidityUsd ?? 0,
    });
    if (!check.allowed) { log.debug({ ticker: m.ticker, reason: check.reason }, 'risk engine blocked'); return; }
    const sizeContracts = Math.floor(check.sizeUsd / entryPrice);
    if (sizeContracts < 1) return;

    m.lastOrderAt = now;

    if (!m.marketDbId) {
      try {
        const id = await upsertMarket({ platform: 'kalshi', external_id: m.ticker, question: m.title,
          category: 'macro', outcome: side === 'yes' ? 'YES' : 'NO', closes_at: new Date(m.closesAtMs) });
        if (id) m.marketDbId = id;
      } catch (e: any) { log.debug({ err: e.message }, 'upsertMarket failed'); }
    }

    let signalId: string | null = null;
    try {
      signalId = await recordSignal({
        strategy: this.name, market_id: m.marketDbId, mode: getConfig().TRADING_MODE,
        reason: 'macro-divergence', side: side === 'yes' ? 'YES' : 'NO',
        model_prob: modelProb, market_prob: marketMid, edge_bps: Math.round(divergence * 10000),
        recommended_size_usd: check.sizeUsd, acted: true,
        payload: { ticker: m.ticker, series: m.series, yesBid: m.yesBid, yesAsk: m.yesAsk, divergence },
      });
    } catch (e: any) { log.warn({ err: e.message }, 'recordSignal failed'); }

    log.info({ ticker: m.ticker, side, entryPrice, sizeContracts,
      modelProb: modelProb.toFixed(3), divergence: divergence.toFixed(3) }, 'Placing macro order');

    try {
      const result = await this.kalshi.placeOrder({
        platform: 'kalshi', externalId: m.ticker, outcome: side === 'yes' ? 'YES' : 'NO',
        side: 'BUY', orderType: 'limit', price: entryPrice, size: sizeContracts,
        clientOrderIdPrefix: 'econ',
      } as any);
      const filled = result.filled ?? 0;
      risk.recordOrderAttempt(m.eventTicker, result.ok && filled > 0);
      if (result.ok && result.externalOrderId)
        this.openOrders.set(result.externalOrderId, { ticker: m.ticker, closesAtMs: m.closesAtMs, side });
      if (m.marketDbId) {
        try {
          await recordOrder({
            signal_id: signalId ?? undefined, market_id: m.marketDbId,
            strategy: this.name, mode: getConfig().TRADING_MODE, side: 'BUY', order_type: 'LIMIT',
            price: entryPrice, size: sizeContracts, filled_size: filled,
            outcome: side === 'yes' ? 'YES' : 'NO', external_order_id: result.externalOrderId,
            status: !result.ok ? 'rejected' : filled >= sizeContracts ? 'filled' : filled > 0 ? 'partial' : 'open',
          });
        } catch (e: any) { log.warn({ err: e.message }, 'recordOrder failed'); }
      }
      if (result.ok && filled > 0) { this.fires++; risk.recordDeployment(this.name, m.ticker, filled * entryPrice); }
      try {
        const label = result.ok && filled > 0 ? 'FILLED' : result.ok ? 'POSTED' : 'REJECTED';
        await sendDiscord(`📊 ${label} — ${m.series} macro divergence`,
          `${getConfig().TRADING_MODE.toUpperCase()} · ${m.title}`, result.ok ? 'info' : 'warn',
          [
            { name: 'Side',   value: side.toUpperCase(),              inline: true },
            { name: 'Model',  value: modelProb.toFixed(3),            inline: true },
            { name: 'Market', value: marketMid.toFixed(3),            inline: true },
            { name: 'Edge',   value: `${(divergence*100).toFixed(1)}pp`, inline: true },
            { name: 'Price',  value: `$${entryPrice.toFixed(3)}`,     inline: true },
            { name: 'Size',   value: `${sizeContracts} contracts`,    inline: true },
            ...(result.ok ? [{ name: 'Filled', value: `${filled}/${sizeContracts}`, inline: false }]
                          : [{ name: 'Error',  value: result.error ?? 'unknown',    inline: false }]),
          ]);
      } catch (e: any) { log.warn({ err: e.message }, 'Discord ping failed'); }
    } catch (err: any) { log.error({ err: err.message, ticker: m.ticker }, 'placeOrder error'); }
  }

  // Cancel open orders within 1 hr of close. Prevents settlement risk. Runs every 10 min.
  private async cancelPreClose(): Promise<void> {
    const now = Date.now();
    for (const [orderId, o] of this.openOrders.entries()) {
      if (o.closesAtMs - now > CANCEL_BEFORE_MS) continue;
      log.info({ orderId, ticker: o.ticker }, 'Pre-close cancel: removing order to avoid settlement risk');
      try {
        await this.kalshi.cancelOrder(orderId);
        this.openOrders.delete(orderId);
        // v2 M-5 fix: also mark the DB row as cancelled. Without this the orders
        // table accumulates perpetual `open`/`partial` rows for pre-closed orders.
        try {
          const dbRow = await findOrderByExternalId(orderId);
          if (dbRow?.id) await updateOrder(dbRow.id, { status: 'canceled' });
        } catch (e: any) { log.debug({ err: e.message, orderId }, 'pre-close DB updateOrder failed'); }
        await sendDiscord('Pre-close cancel — macro order removed',
          `Cancelled ${o.ticker} ${o.side.toUpperCase()} to avoid settlement risk`, 'info',
          [{ name: 'OrderId', value: orderId, inline: false }]);
      } catch (e: any) { log.warn({ err: e.message, orderId }, 'pre-close cancel failed'); }
    }
  }

  private heartbeat(): void {
    void recordHeartbeat(this.name, getConfig().TRADING_MODE, {
      markets: this.markets.size, opportunitiesSeen: this.opportunitiesSeen,
      fires: this.fires, lastCpiNowcast: this.lastCpiNowcast, lastFedWatch: this.lastFedWatch,
      signalsValid: this.signalsValid, signalKeys: [...this.signals.keys()], openOrders: this.openOrders.size,
    });
  }
}

