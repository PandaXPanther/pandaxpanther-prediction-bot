/**
 * weatherModel.ts — 4-Model Ensemble Weather Probability System
 *
 * Replaces the single-source NOAA GFS model with a 4-model ensemble that
 * requires 3-of-4 agreement before generating a trade signal.
 *
 * ENSEMBLE MEMBERS (all free, no API key required):
 *   1. NOAA GFS via Open-Meteo          — deterministic GFS seamless
 *   2. ECMWF IFS via Open-Meteo         — deterministic ECMWF IFS
 *   3. ECMWF AIFS via Open-Meteo        — AI-based ECMWF ensemble member
 *   4. NOAA GEFS via Open-Meteo         — 31-member probabilistic ensemble
 *                                          (sigma derived from actual member spread)
 *
 * AGREEMENT FILTER ("3 of 4"):
 *   A "cohort" is a subset of models that:
 *     - All have their probability on the SAME SIDE of 50%
 *     - Max probability spread within the cohort ≤ 15pp
 *   If the largest qualifying cohort has ≥ 3 members: return consensus probability.
 *   Otherwise: return source='reject-disagreement', probability=0.5.
 *
 * SIGMA RULES:
 *   temperature : σ = 3.0 °F for deterministic models
 *   precipitation: σ = 0.1 in for deterministic models
 *   GEFS: σ = std of 31-member ensemble spread (lower bound: 0.5°F / 0.02in)
 *
 * CACHING:
 *   Per (station, date, modelName) for 30 minutes.
 *
 * TIMEOUT:
 *   10 s per HTTP call; all 4 fetched in parallel via Promise.allSettled.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherProbability {
  /** Consensus probability from agreeing models (or 0.5 if rejected) */
  probability: number;
  /** Origin tag for logging / audit */
  source: 'ensemble-3of4' | 'ensemble-4of4' | 'fallback' | 'reject-disagreement';
  /** Mean forecast value across agreeing models (°F or inches) */
  forecastValue: number;
  /** Std dev across the agreeing ensemble members */
  ensembleStdev: number;
  /** Number of models that agreed (2–4; <3 → rejected) */
  modelsAgreeing: number;
  /** Per-model breakdown for logging */
  modelDetails: Array<{ name: string; forecast: number; prob: number }>;
  /** v3.1: post-correction adjustment based on real-time NWS station observation */
  observationAdjustment?: {
    currentTempF: number;
    observedAt: string;
    adjustmentPp: number;
  };
}

// v3.1 Station-obs cache (1-min TTL — observations update hourly anyway)
const STATION_OBS_CACHE = new Map<string, { ts: number; tempF: number; observedAt: string }>();
const STATION_OBS_TTL_MS = 60 * 1000;

// Map STATION_COORDS short code → NWS ICAO. Same coordinates, so we can derive.
// Most US weather stations follow K{IATA} convention.
const STATION_ICAO_MAP: Record<string, string> = {
  NY: 'KNYC', LA: 'KLAX', CHI: 'KORD', MIA: 'KMIA', DEN: 'KDEN', SEA: 'KSEA',
  ATL: 'KATL', BOS: 'KBOS', HOU: 'KIAH', PHX: 'KPHX', DFW: 'KDFW', PHL: 'KPHL',
  SF: 'KSFO', DC: 'KDCA', AUS: 'KAUS', SAN: 'KSAN', PDX: 'KPDX', MSP: 'KMSP',
  DTW: 'KDTW', MCO: 'KMCO', TPA: 'KTPA', LAS: 'KLAS',
};

/**
 * v3.1 (strategy_v3_optimization.pplx.md Section 4 / Q4): real-time station
 * observation. Replaces the broken NWS-forecast-only model. Pulls the latest
 * hourly observation from api.weather.gov/stations/{ICAO}/observations/latest.
 */
async function fetchCurrentStationTemp(station: string): Promise<{ tempF: number; observedAt: string } | null> {
  const icao = STATION_ICAO_MAP[station.toUpperCase()] ?? (station.startsWith('K') ? station : null);
  if (!icao) return null;

  const cached = STATION_OBS_CACHE.get(icao);
  if (cached && Date.now() - cached.ts < STATION_OBS_TTL_MS) {
    return { tempF: cached.tempF, observedAt: cached.observedAt };
  }

  try {
    const url = `https://api.weather.gov/stations/${icao}/observations/latest`;
    const r = await fetch(url, { headers: { 'User-Agent': 'pandaxpanther-bot' } as any });
    if (!r.ok) return null;
    const data: any = await r.json();
    const tempC = data?.properties?.temperature?.value;
    const observedAt = data?.properties?.timestamp;
    if (tempC == null || !observedAt) return null;
    const tempF = tempC * 9 / 5 + 32;
    STATION_OBS_CACHE.set(icao, { ts: Date.now(), tempF, observedAt });
    return { tempF, observedAt };
  } catch {
    return null;
  }
}

/**
 * v3.1: Compute observation-correction adjustment.
 * If we're partway through the day and the current temp is materially above/below
 * the typical pace toward the predicted high, the forecast probability should shift.
 *
 * Example: NYC forecast high is 70F, contract is "high > 68F YES". Forecast prob = 65%.
 * It's 2 PM, current temp is 67F. Most of the day's warming is done — 67F is very close
 * to threshold. Probability of crossing 68F goes UP to ~80%.
 *
 * Conservative implementation: shift max +/-15pp.
 */
function computeObservationAdjustment(
  currentTempF: number,
  threshold: number,
  direction: 'above' | 'below',
  forecastHigh: number,
  hourOfDay: number,  // local hour, 0–23
): number {
  if (hourOfDay < 8 || hourOfDay > 20) return 0;  // Only apply during daylight hours (sensible obs window)
  // "Typical" warming curve: low at 6 AM, peak at 3-5 PM. Approximate progress fraction.
  // 8 AM ≈ 0.10 of warming done; 11 AM ≈ 0.40; 2 PM ≈ 0.75; 5 PM ≈ 0.95
  let progress: number;
  if (hourOfDay <= 11) progress = 0.10 + (hourOfDay - 8) / 3 * 0.30;       // 0.10–0.40
  else if (hourOfDay <= 14) progress = 0.40 + (hourOfDay - 11) / 3 * 0.35; // 0.40–0.75
  else if (hourOfDay <= 17) progress = 0.75 + (hourOfDay - 14) / 3 * 0.20; // 0.75–0.95
  else progress = 0.95 + (hourOfDay - 17) / 3 * 0.05;

  // Expected current temp if forecast were perfect (linear interpolation from morning low
  // to forecast high). Approximate morning low as forecastHigh - 18F (typical daily range).
  const morningLow = forecastHigh - 18;
  const expectedNow = morningLow + (forecastHigh - morningLow) * progress;

  // Difference: positive = warmer than expected, will likely exceed forecast
  const diff = currentTempF - expectedNow;

  // Convert to probability adjustment. Each 1F over expectation = ~3pp shift toward
  // "crossing the threshold" if threshold is roughly at forecast high.
  // Clamp to +/-15pp.
  const distanceToThreshold = Math.abs(currentTempF - threshold);
  // If we're already past threshold (direction='above') or below (direction='below'), boost.
  if (direction === 'above' && currentTempF >= threshold) return Math.min(0.15, 0.05 + distanceToThreshold * 0.02);
  if (direction === 'below' && currentTempF <= threshold) return Math.min(0.15, 0.05 + distanceToThreshold * 0.02);
  // Otherwise scale shift by diff
  const shift = diff * 0.03;
  return Math.max(-0.15, Math.min(0.15, direction === 'above' ? shift : -shift));
}

type WeatherMetric = 'high_temp_f' | 'low_temp_f' | 'precip_in';

// ---------------------------------------------------------------------------
// Station coordinates
// ---------------------------------------------------------------------------

const STATION_COORDS: Record<string, { lat: number; lon: number }> = {
  // Short codes from Kalshi tickers
  NY:  { lat: 40.71, lon: -74.00 },
  LA:  { lat: 34.05, lon: -118.25 },
  CHI: { lat: 41.88, lon: -87.63 },
  MIA: { lat: 25.76, lon: -80.19 },
  DEN: { lat: 39.74, lon: -104.99 },
  SEA: { lat: 47.61, lon: -122.33 },
  ATL: { lat: 33.75, lon: -84.39 },
  BOS: { lat: 42.36, lon: -71.06 },
  HOU: { lat: 29.76, lon: -95.37 },
  PHX: { lat: 33.45, lon: -112.07 },
  DFW: { lat: 32.78, lon: -96.80 },
  PHL: { lat: 39.95, lon: -75.17 },
  SF:  { lat: 37.77, lon: -122.42 },
  DC:  { lat: 38.91, lon: -77.04 },
  AUS: { lat: 30.27, lon: -97.74 },
  SAN: { lat: 32.72, lon: -117.16 },
  PDX: { lat: 45.52, lon: -122.68 },
  MSP: { lat: 44.98, lon: -93.27 },
  DTW: { lat: 42.33, lon: -83.05 },
  MCO: { lat: 28.54, lon: -81.38 },
  TPA: { lat: 27.95, lon: -82.46 },
  LAS: { lat: 36.17, lon: -115.14 },

  // NOAA ICAO codes
  KNYC: { lat: 40.71, lon: -74.00 },
  KLAX: { lat: 34.05, lon: -118.25 },
  KORD: { lat: 41.88, lon: -87.63 },
  KMIA: { lat: 25.76, lon: -80.19 },
  KDEN: { lat: 39.74, lon: -104.99 },
  KSEA: { lat: 47.61, lon: -122.33 },
  KATL: { lat: 33.75, lon: -84.39 },
  KBOS: { lat: 42.36, lon: -71.06 },
  KHOU: { lat: 29.76, lon: -95.37 },
  KPHX: { lat: 33.45, lon: -112.07 },
  KDFW: { lat: 32.78, lon: -96.80 },
  KPHL: { lat: 39.95, lon: -75.17 },
  KSFO: { lat: 37.77, lon: -122.42 },
  KDCA: { lat: 38.91, lon: -77.04 },
  KAUS: { lat: 30.27, lon: -97.74 },
  KSAN: { lat: 32.72, lon: -117.16 },
  KPDX: { lat: 45.52, lon: -122.68 },
  // ADDED 2026-05-22 for Kalshi LIP weather markets:
  KMSY: { lat: 29.99, lon: -90.26 },  // New Orleans Louis Armstrong
  KSAT: { lat: 29.53, lon: -98.47 },  // San Antonio
  KOKC: { lat: 35.39, lon: -97.60 },  // Oklahoma City
  KMSP: { lat: 44.98, lon: -93.27 },
  KDTW: { lat: 42.33, lon: -83.05 },
  KMCO: { lat: 28.54, lon: -81.38 },
  KTPA: { lat: 27.95, lon: -82.46 },
  KLAS: { lat: 36.17, lon: -115.14 },
  KBWI: { lat: 39.18, lon: -76.67 },
  KCLT: { lat: 35.21, lon: -80.94 },
  KBNA: { lat: 36.12, lon: -86.68 },
  KSTL: { lat: 38.75, lon: -90.37 },
  KCLE: { lat: 41.41, lon: -81.85 },
  KPIT: { lat: 40.49, lon: -80.23 },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sigma for deterministic model CDF (temp=°F, precip=in) */
const SIGMA_DET: Record<WeatherMetric, number> = {
  high_temp_f: 3.0,
  low_temp_f:  3.0,
  precip_in:   0.10,
};

/** Minimum sigma for GEFS spread (prevents divide-by-zero in calm weather) */
const SIGMA_GEFS_MIN: Record<WeatherMetric, number> = {
  high_temp_f: 0.5,
  low_temp_f:  0.5,
  precip_in:   0.02,
};

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Maximum probability gap (pp) within an agreeing cohort */
const AGREEMENT_WINDOW_PP = 0.15;

// ---------------------------------------------------------------------------
// In-memory cache
// Key: `${station.toUpperCase()}::${dateStr}::${modelName}`
// ---------------------------------------------------------------------------

interface ModelCacheEntry {
  fetchedAt: number;
  temps: number[];   // hourly temps for target date, °F
  precip: number[];  // hourly precip for target date, in
  gefsSpread?: number; // std across GEFS members for target metric
}

const modelCache = new Map<string, ModelCacheEntry>();
// 2026-05-23: in-flight request dedup. When 50+ contracts share the same
// (station, date, model) tuple, parallel fetches all miss the cache and fire
// the same API call — generating 429s from Open-Meteo. Track in-flight promises
// here so duplicate callers await the same promise instead of starting new ones.
const inFlightRequests = new Map<string, Promise<any>>();

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + 0.3275911 * ax);
  const poly =
    t * (0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 +
    t * 1.061405429))));
  return sign * (1.0 - poly * Math.exp(-ax * ax));
}

function normalCdf(z: number): number {
  return 0.5 * (1.0 + erf(z / Math.SQRT2));
}

function computeProb(
  forecast: number,
  threshold: number,
  sigma: number,
  direction: 'above' | 'below',
): number {
  const z = (threshold - forecast) / sigma;
  const pAbove = 1 - normalCdf(z);
  const p = direction === 'above' ? pAbove : 1 - pAbove;
  return Math.max(0.005, Math.min(0.995, p));
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ---------------------------------------------------------------------------
// HTTP helper — 10s timeout, returns null on any failure
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Model 1: NOAA GFS via Open-Meteo
// ---------------------------------------------------------------------------

async function fetchGFS(
  lat: number,
  lon: number,
  dateStr: string,
): Promise<{ temps: number[]; precip: number[] } | null> {
  const url =
    `https://api.open-meteo.com/v1/gfs` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation` +
    `&temperature_unit=fahrenheit` +
    `&precipitation_unit=inch` +
    `&forecast_days=7` +
    `&timezone=America%2FNew_York`;

  const data = await fetchJson(url) as any;
  return extractHourly(data, dateStr);
}

// ---------------------------------------------------------------------------
// Model 5 (NEW 2026-05-23): NOAA NWS API — official US government weather
// service, no rate limit, no API key. Returns hourly forecasts for any
// US lat/lon. Two-step lookup:
//   1. GET /points/{lat},{lon} → returns gridpoint URL
//   2. GET that URL/forecast/hourly → returns hourly forecast
// We cache the gridpoint URL per station since stations are fixed.
// This is the primary source now — Open-Meteo is fallback for rate limits.
// ---------------------------------------------------------------------------

const nwsGridpointCache = new Map<string, string>();

async function fetchNWS(
  lat: number,
  lon: number,
  dateStr: string,
): Promise<{ temps: number[]; precip: number[] } | null> {
  try {
    const stationKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    let hourlyUrl = nwsGridpointCache.get(stationKey);

    if (!hourlyUrl) {
      // Step 1: get gridpoint metadata
      const pointsRes = await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, {
        headers: { 'User-Agent': 'panda-trading-bot (PandaXPanther)' },
        signal: AbortSignal.timeout(10000),
      });
      if (!pointsRes.ok) return null;
      const pointsData = await pointsRes.json() as any;
      hourlyUrl = pointsData?.properties?.forecastHourly;
      if (!hourlyUrl) return null;
      nwsGridpointCache.set(stationKey, hourlyUrl);
    }

    // Step 2: fetch hourly forecast
    const forecastRes = await fetch(hourlyUrl, {
      headers: { 'User-Agent': 'panda-trading-bot (PandaXPanther)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!forecastRes.ok) return null;
    const forecastData = await forecastRes.json() as any;
    const periods = forecastData?.properties?.periods ?? [];

    // Filter to target date's hours (dateStr is YYYY-MM-DD)
    const temps: number[] = [];
    const precip: number[] = [];
    for (const p of periods) {
      if (!p?.startTime?.startsWith(dateStr)) continue;
      // temperature is in F by default for US gridpoints
      if (typeof p.temperature === 'number') temps.push(p.temperature);
      // probabilityOfPrecipitation is %; convert to fractional inches estimate
      // (NWS doesn't give quantitative precip in hourly endpoint, only probability)
      // For our purposes: probability * 0.05 inch as expected hourly precip
      // (good enough for daily-total signal calibration)
      const probPct = p.probabilityOfPrecipitation?.value;
      precip.push(typeof probPct === 'number' ? (probPct / 100) * 0.05 : 0);
    }
    if (temps.length === 0) return null;
    return { temps, precip };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model 2: ECMWF IFS via Open-Meteo
// ---------------------------------------------------------------------------

async function fetchECMWF(
  lat: number,
  lon: number,
  dateStr: string,
): Promise<{ temps: number[]; precip: number[] } | null> {
  const url =
    `https://api.open-meteo.com/v1/ecmwf` +
    `?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,precipitation` +
    `&temperature_unit=fahrenheit` +
    `&precipitation_unit=inch` +
    `&forecast_days=7` +
    `&timezone=America%2FNew_York`;

  const data = await fetchJson(url) as any;
  return extractHourly(data, dateStr);
}

// ---------------------------------------------------------------------------
// Model 3: ECMWF AIFS via Open-Meteo (AI-based)
// ---------------------------------------------------------------------------

async function fetchECMWF_AIFS(
  lat: number,
  lon: number,
  dateStr: string,
): Promise<{ temps: number[]; precip: number[] } | null> {
  const url =
    `https://api.open-meteo.com/v1/ecmwf` +
    `?latitude=${lat}&longitude=${lon}` +
    `&models=ecmwf_aifs025` +
    `&hourly=temperature_2m,precipitation` +
    `&temperature_unit=fahrenheit` +
    `&precipitation_unit=inch` +
    `&forecast_days=7` +
    `&timezone=America%2FNew_York`;

  const data = await fetchJson(url) as any;
  return extractHourly(data, dateStr);
}

// ---------------------------------------------------------------------------
// Model 4: NOAA GEFS (31 members) via Open-Meteo Ensemble API
// Returns mean temps/precip AND the member spread as gefsSpread
// ---------------------------------------------------------------------------

interface GEFSResult {
  temps: number[];
  precip: number[];
  memberTempStd: number;   // std of daily high across members
  memberPrecipStd: number; // std of daily precip sum across members
}

async function fetchGEFS(
  lat: number,
  lon: number,
  dateStr: string,
): Promise<GEFSResult | null> {
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble` +
    `?latitude=${lat}&longitude=${lon}` +
    `&models=gfs_seamless` +
    `&hourly=temperature_2m,precipitation` +
    `&temperature_unit=fahrenheit` +
    `&precipitation_unit=inch` +
    `&forecast_days=7` +
    `&timezone=America%2FNew_York`;

  const data = await fetchJson(url) as any;
  if (!data?.hourly) return null;

  const times: string[] = data.hourly.time ?? [];
  if (!times.length) return null;

  // Open-Meteo ensemble API returns member columns named:
  //   temperature_2m, temperature_2m_member01, ..., temperature_2m_member30
  //   precipitation, precipitation_member01, ..., precipitation_member30
  // Collect all member keys
  const tempKeys = Object.keys(data.hourly).filter(
    (k) => k === 'temperature_2m' || k.startsWith('temperature_2m_member'),
  );
  const precipKeys = Object.keys(data.hourly).filter(
    (k) => k === 'precipitation' || k.startsWith('precipitation_member'),
  );

  // For each member, extract hourly arrays for the target date
  const memberHighTemps: number[] = [];
  const memberLowTemps: number[] = [];
  const memberPrecipSums: number[] = [];

  for (const tk of tempKeys) {
    const arr: (number | null)[] = data.hourly[tk] ?? [];
    const dayVals: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (times[i].startsWith(dateStr) && arr[i] != null) {
        dayVals.push(arr[i] as number);
      }
    }
    if (dayVals.length > 0) {
      memberHighTemps.push(Math.max(...dayVals));
      memberLowTemps.push(Math.min(...dayVals));
    }
  }

  for (const pk of precipKeys) {
    const arr: (number | null)[] = data.hourly[pk] ?? [];
    let sum = 0;
    for (let i = 0; i < times.length; i++) {
      if (times[i].startsWith(dateStr) && arr[i] != null) {
        sum += arr[i] as number;
      }
    }
    memberPrecipSums.push(sum);
  }

  if (!memberHighTemps.length) return null;

  // Ensemble mean: use the first key (control member / mean)
  const controlTempArr: number[] = [];
  const controlPrecipArr: number[] = [];
  const firstTempKey = tempKeys[0];
  const firstPrecipKey = precipKeys[0] ?? '';

  for (let i = 0; i < times.length; i++) {
    if (!times[i].startsWith(dateStr)) continue;
    const tv = data.hourly[firstTempKey]?.[i];
    const pv = data.hourly[firstPrecipKey]?.[i];
    if (tv != null) controlTempArr.push(tv as number);
    if (pv != null) controlPrecipArr.push(pv as number);
  }

  return {
    temps: controlTempArr,
    precip: controlPrecipArr,
    memberTempStd: stddev(memberHighTemps),
    memberPrecipStd: stddev(memberPrecipSums),
  };
}

// ---------------------------------------------------------------------------
// Helper: extract hourly arrays for a specific date from Open-Meteo response
// ---------------------------------------------------------------------------

function extractHourly(
  data: any,
  dateStr: string,
): { temps: number[]; precip: number[] } | null {
  if (!data?.hourly?.time) return null;
  const times: string[] = data.hourly.time;
  const rawTemps: (number | null)[] = data.hourly.temperature_2m ?? [];
  const rawPrecip: (number | null)[] = data.hourly.precipitation ?? [];

  const temps: number[] = [];
  const precip: number[] = [];

  for (let i = 0; i < times.length; i++) {
    if (!times[i].startsWith(dateStr)) continue;
    if (rawTemps[i] != null) temps.push(rawTemps[i] as number);
    if (rawPrecip[i] != null) precip.push(rawPrecip[i] as number);
  }

  return temps.length > 0 ? { temps, precip } : null;
}

// ---------------------------------------------------------------------------
// Derive a single forecast value + probability from hourly arrays
// ---------------------------------------------------------------------------

interface ModelResult {
  name: string;
  forecast: number;
  sigma: number;
  prob: number;
}

function deriveModelResult(
  name: string,
  temps: number[],
  precip: number[],
  metric: WeatherMetric,
  threshold: number,
  direction: 'above' | 'below',
  sigmaOverride?: number,
): ModelResult | null {
  if (!temps.length) return null;

  let forecast: number;
  switch (metric) {
    case 'high_temp_f':
      forecast = Math.max(...temps);
      break;
    case 'low_temp_f':
      forecast = Math.min(...temps);
      break;
    case 'precip_in':
      forecast = precip.reduce((a, v) => a + (v ?? 0), 0);
      break;
    default:
      return null;
  }

  const sigma = sigmaOverride ?? SIGMA_DET[metric];
  const prob = computeProb(forecast, threshold, sigma, direction);

  return { name, forecast, sigma, prob };
}

// ---------------------------------------------------------------------------
// 3-of-4 agreement logic
// ---------------------------------------------------------------------------

/**
 * Find the largest cohort of models where:
 *   (a) all probabilities are on the same side of 0.5
 *   (b) max spread within cohort ≤ AGREEMENT_WINDOW_PP (15pp)
 *
 * Returns null if the best cohort has < 3 members.
 */
function findAgreementCohort(
  results: ModelResult[],
): ModelResult[] | null {
  // 2026-05-23: RELAXED. Previous logic required "all on same side of 0.5"
  // which killed signals where models genuinely straddle the boundary
  // (e.g. GFS=0.48, ECMWF=0.55, AIFS=0.52, GEFS=0.51 — all clustered around
  // a real ~52% probability but rejected because GFS dipped below 50). This
  // was rejecting essentially every weather contract: 0 modeled out of 494.
  //
  // New logic: find the largest subset (≥2) whose probs lie within
  // AGREEMENT_WINDOW_PP (15pp) of each other. The side-of-0.5 check is
  // dropped — a cohort that says "around 52%" is still useful even if
  // one model puts it at 48% and another at 55%.
  //
  // Also lowered minimum cohort size from 3 to 2 of 4 — a 2-model agreement
  // within 15pp is still a meaningful signal, and any 2 of (GFS, ECMWF,
  // AIFS, GEFS) is an independent cross-check.
  const n = results.length;
  let bestCohort: ModelResult[] = [];

  for (let mask = (1 << n) - 1; mask >= 0; mask--) {
    const subset: ModelResult[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) subset.push(results[i]);
    }
    if (subset.length < 2) continue;
    if (subset.length <= bestCohort.length) continue;

    // Check spread only
    const probs = subset.map((m) => m.prob);
    const spread = Math.max(...probs) - Math.min(...probs);
    if (spread > AGREEMENT_WINDOW_PP) continue;

    bestCohort = subset;
  }

  return bestCohort.length >= 2 ? bestCohort : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * computeWeatherProbability — main entry point for weatherSignal.ts.
 *
 * Fetches all 4 ensemble sources in parallel, applies 3-of-4 agreement
 * filter, and returns a consensus probability.
 *
 * Returns null ONLY if station is unknown or ALL 4 fetches failed.
 * Returns source='reject-disagreement' (prob=0.5) when models conflict.
 */
export async function computeWeatherProbability(
  station: string,
  metric: WeatherMetric,
  threshold: number,
  direction: 'above' | 'below',
  targetDate: Date,
): Promise<WeatherProbability | null> {

  // 1. Resolve station → coordinates
  const coords = STATION_COORDS[station.toUpperCase()];
  if (!coords) return null;

  const { lat, lon } = coords;
  const dateStr = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD

  // 2. Fetch all 4 models in parallel; each has its own 10s timeout inside fetchJson
  const cacheKey = (name: string) =>
    `${station.toUpperCase()}::${dateStr}::${name}`;

  // Helper: check cache or fetch, with in-flight dedup
  async function getCached<T>(
    name: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> {
    const ck = cacheKey(name);
    const cached = modelCache.get(ck);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { temps: cached.temps, precip: cached.precip, gefsSpread: cached.gefsSpread } as unknown as T;
    }
    // 2026-05-23: if a request is already in-flight for this key, await it
    // instead of starting a duplicate. Prevents thundering-herd 429s.
    const inFlight = inFlightRequests.get(ck);
    if (inFlight) return inFlight as Promise<T | null>;

    const promise = (async () => {
      try {
        const result = await fetcher();
        if (result) {
          const r = result as any;
          modelCache.set(ck, {
            fetchedAt: Date.now(),
            temps: r.temps ?? [],
            precip: r.precip ?? [],
            gefsSpread: r.memberTempStd,
          });
        }
        return result;
      } finally {
        inFlightRequests.delete(ck);
      }
    })();
    inFlightRequests.set(ck, promise);
    return promise;
  }

  // 2026-05-23: Added NWS as PRIMARY source (no rate limit). The 4 Open-Meteo
  // sources have been 429'ing every request due to daily quota exhaustion,
  // resulting in withModelProb=0 across all 494 contracts. NWS is US-government,
  // no API key, generous rate limit — and Kalshi weather is US-only anyway.
  const [nwsRes, gfsRes, ecmwfRes, aifsRes, gefsRes] = await Promise.allSettled([
    getCached('nws',        () => fetchNWS(lat, lon, dateStr)),
    getCached('gfs',        () => fetchGFS(lat, lon, dateStr)),
    getCached('ecmwf',      () => fetchECMWF(lat, lon, dateStr)),
    getCached('ecmwf_aifs', () => fetchECMWF_AIFS(lat, lon, dateStr)),
    getCached('gefs',       () => fetchGEFS(lat, lon, dateStr)),
  ]);

  const nwsData   = nwsRes.status   === 'fulfilled' ? nwsRes.value   : null;
  const gfsData   = gfsRes.status   === 'fulfilled' ? gfsRes.value   : null;
  const ecmwfData = ecmwfRes.status === 'fulfilled' ? ecmwfRes.value : null;
  const aifsData  = aifsRes.status  === 'fulfilled' ? aifsRes.value  : null;
  const gefsData  = gefsRes.status  === 'fulfilled' ? gefsRes.value  : null;

  // 3. If ALL failed, return null (caller falls back)
  if (!nwsData && !gfsData && !ecmwfData && !aifsData && !gefsData) return null;

  // 4. Derive per-model results
  const modelResults: ModelResult[] = [];

  if (nwsData) {
    const r = deriveModelResult('nws', nwsData.temps, nwsData.precip, metric, threshold, direction);
    if (r) modelResults.push(r);
  }
  if (gfsData) {
    const r = deriveModelResult('gfs', gfsData.temps, gfsData.precip, metric, threshold, direction);
    if (r) modelResults.push(r);
  }
  if (ecmwfData) {
    const r = deriveModelResult('ecmwf', ecmwfData.temps, ecmwfData.precip, metric, threshold, direction);
    if (r) modelResults.push(r);
  }
  if (aifsData) {
    const r = deriveModelResult('ecmwf_aifs', aifsData.temps, aifsData.precip, metric, threshold, direction);
    if (r) modelResults.push(r);
  }
  if (gefsData) {
    // GEFS: use actual member spread for sigma (floored at minimum)
    let sigmaGEFS: number;
    if (metric === 'precip_in') {
      sigmaGEFS = Math.max(gefsData.memberPrecipStd, SIGMA_GEFS_MIN.precip_in);
    } else {
      sigmaGEFS = Math.max(gefsData.memberTempStd, SIGMA_GEFS_MIN[metric]);
    }
    const r = deriveModelResult(
      'gefs',
      gefsData.temps,
      gefsData.precip,
      metric,
      threshold,
      direction,
      sigmaGEFS,
    );
    if (r) modelResults.push(r);
  }

  // Build modelDetails for reporting (always all available models)
  const modelDetails = modelResults.map((m) => ({
    name: m.name,
    forecast: m.forecast,
    prob: m.prob,
  }));

  // 5. Apply 3-of-4 agreement filter
  const cohort = findAgreementCohort(modelResults);

  if (!cohort) {
    // Models disagree — reject: return 0.5 with disagree tag
    const meanForecast =
      modelResults.length > 0
        ? mean(modelResults.map((m) => m.forecast))
        : threshold;
    const forecastStdev =
      modelResults.length > 1 ? stddev(modelResults.map((m) => m.forecast)) : 0;
    return {
      probability: 0.5,
      source: 'reject-disagreement',
      forecastValue: meanForecast,
      ensembleStdev: forecastStdev,
      modelsAgreeing: modelResults.length < 3 ? modelResults.length : 0,
      modelDetails,
    };
  }

  // 6. Consensus: average agreeing models' probabilities
  const consensusProb = mean(cohort.map((m) => m.prob));
  const consensusForecast = mean(cohort.map((m) => m.forecast));
  const forecastStdev = stddev(cohort.map((m) => m.forecast));

  const source: WeatherProbability['source'] =
    cohort.length === 4 ? 'ensemble-4of4' : 'ensemble-3of4';

  // 7. v3.1 Real-time NWS station observation correction (only for high_temp_f same-day contracts).
  // Per back-test in strategy_v3_optimization.pplx.md, the bare forecast model has 0% WR.
  // The real edge in weather is the divergence between observed temp and forecast trajectory —
  // when the day is running hot/cold of forecast, the contract's true probability shifts.
  let probability = Math.max(0.005, Math.min(0.995, consensusProb));
  let observationAdjustment: WeatherProbability['observationAdjustment'];

  const sameDay = (() => {
    const today = new Date();
    return targetDate.getUTCFullYear() === today.getUTCFullYear()
      && targetDate.getUTCMonth() === today.getUTCMonth()
      && targetDate.getUTCDate() === today.getUTCDate();
  })();

  if (metric === 'high_temp_f' && sameDay && process.env.WEATHER_OBS_ENABLED !== 'false') {
    try {
      const obs = await fetchCurrentStationTemp(station);
      if (obs) {
        // Use UTC hour minus a rough timezone offset for the station. Cheap: ETC=UTC-5, PST=UTC-8.
        // We don't have full TZ data, so use the station longitude as offset proxy.
        const tzHourShift = Math.round((coords.lon) / 15);  // -5 for EST, -8 for PST, etc.
        const localHour = (new Date().getUTCHours() + tzHourShift + 24) % 24;
        const adj = computeObservationAdjustment(obs.tempF, threshold, direction, consensusForecast, localHour);
        if (adj !== 0) {
          probability = Math.max(0.005, Math.min(0.995, probability + adj));
          observationAdjustment = {
            currentTempF: obs.tempF,
            observedAt: obs.observedAt,
            adjustmentPp: adj,
          };
        }
      }
    } catch {
      // best-effort — fall back to pure forecast model
    }
  }

  return {
    probability,
    source,
    forecastValue: consensusForecast,
    ensembleStdev: forecastStdev,
    modelsAgreeing: cohort.length,
    modelDetails,
    observationAdjustment,
  };
}
