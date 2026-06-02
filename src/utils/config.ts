import 'dotenv/config';
import { z } from 'zod';

// Treat empty strings as undefined so blank .env values fall through to defaults
for (const k of Object.keys(process.env)) {
  if (process.env[k] === '') delete process.env[k];
}

// Proper string→boolean: 'false'/'0'/'no' → false; 'true'/'1'/'yes' → true
// (z.coerce.boolean treats any non-empty string as true — not what we want)
const BoolFromString = z.union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    return !(s === '' || s === 'false' || s === '0' || s === 'no' || s === 'off');
  });

const ConfigSchema = z.object({
  // Mode
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  PERMISSIVE_PAPER: BoolFromString.default(false),
  PING_PAPER_FILLS: BoolFromString.default(false),  // Discord-ping paper fills too (verbose - testing only)
  AGGRESSIVE: BoolFromString.default(false),  // Drop signal thresholds for maximum firings
  DAILY_LOSS_CAP_USD: z.coerce.number().positive().default(200),
  MAX_POSITION_PER_MARKET_USD: z.coerce.number().positive().default(250),
  MAX_POSITION_PER_EVENT_USD: z.coerce.number().positive().default(30),  // total exposure across all strikes of one event
  MAX_DAYS_TO_RESOLUTION: z.coerce.number().positive().default(7),       // refuse contracts that resolve more than N days out
  ALLOW_FRACTIONAL_MARKETS: BoolFromString.default(false),               // refuse fractional-trading markets until we can liquidate them
  MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(100),       // skip markets with < $X total bid+ask depth (exit liquidity)
  NOWCAST_PAPER_ONLY: BoolFromString.default(true),                      // force nowcast strategy to paper mode even when bot is live

  // Platform mode - 'both' (original) or 'kalshi_only'
  PLATFORM_MODE: z.enum(['both', 'kalshi_only']).default('both'),

  // Allocations - 'both' platform mode
  ALLOC_SUM_TO_ONE: z.coerce.number().min(0).max(1).default(0.25),
  ALLOC_CROSS_PLATFORM: z.coerce.number().min(0).max(1).default(0.30),
  ALLOC_CRYPTO_LATENCY: z.coerce.number().min(0).max(1).default(0.30),
  ALLOC_WEATHER: z.coerce.number().min(0).max(1).default(0.15),
  // Allocations - 'kalshi_only' platform mode
  ALLOC_KALSHI_SUM_TO_ONE: z.coerce.number().min(0).max(1).default(0.20),
  ALLOC_NOWCAST: z.coerce.number().min(0).max(1).default(0.20),
  ALLOC_SPORTS_LATENCY: z.coerce.number().min(0).max(1).default(0.10),
  ALLOC_HOURLY_CRYPTO: z.coerce.number().min(0).max(1).default(0.30),

  // Polymarket
  POLYMARKET_PRIVATE_KEY: z.string().optional(),
  POLYMARKET_FUNDER_ADDRESS: z.string().optional(),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_API_PASSPHRASE: z.string().optional(),
  POLYMARKET_HOST: z.string().url().default('https://clob.polymarket.com'),
  POLYMARKET_CHAIN_ID: z.coerce.number().default(137),

  // Kalshi
  KALSHI_API_KEY_ID: z.string().optional(),
  KALSHI_PRIVATE_KEY: z.string().optional(),  // RSA PEM content (Fly secrets pattern)
  KALSHI_PRIVATE_KEY_PATH: z.string().default('./secrets/kalshi_private_key.pem'),
  KALSHI_HOST: z.string().url().default('https://api.elections.kalshi.com/trade-api/v2'),
  KALSHI_WSS: z.string().default('wss://api.elections.kalshi.com/trade-api/ws/v2'),

  // Data feeds
  BINANCE_WS_URL: z.string().default('wss://stream.binance.com:9443/ws'),
  COINBASE_WS_URL: z.string().default('wss://ws-feed.exchange.coinbase.com'),
  NOAA_FORECAST_URL: z.string().url().default('https://api.weather.gov'),

  // Supabase
  SUPABASE_URL: z.union([z.string().url(), z.literal('')]).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Alerts
  DISCORD_WEBHOOK_URL: z.union([z.string().url(), z.literal('')]).optional(),
  DISCORD_NOTIFY_USER_ID: z.string().optional(),  // Discord user ID to @mention on trade events
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // Quant
  QUANT_SERVICE_URL: z.string().url().default('http://localhost:8000'),

  // Sports CLV strategy — The Odds API (theoddsapi.com)
  // Free tier: 500 req/month. Optional — strategy no-ops if unset.
  ODDS_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  _config = parsed.data;
  return _config;
}

export function isPaperMode(): boolean {
  // C-1 fix (May 22 PM 2026): always read live env var so runtime mutations
  // by dripEngine/forceKill (process.env.TRADING_MODE = 'paper') take effect
  // immediately. The cached config is otherwise correct for static fields.
  if (process.env.TRADING_MODE === 'paper') return true;
  return getConfig().TRADING_MODE === 'paper';
}

export function getTradingMode(): 'live' | 'paper' {
  // Always reflect runtime overrides.
  if (process.env.TRADING_MODE === 'paper') return 'paper';
  if (process.env.TRADING_MODE === 'live') return 'live';
  return getConfig().TRADING_MODE as 'live' | 'paper';
}

export function isKalshiOnly(): boolean {
  return getConfig().PLATFORM_MODE === 'kalshi_only';
}

/**
 * Is permissive paper mode on?
 * - Forces FALSE if we're in live mode (safety guard, even if user accidentally
 *   set PERMISSIVE_PAPER=true while flipping to live)
 * - Used by strategies to drop signal thresholds for accelerated discovery
 */
export function isPermissive(): boolean {
  const c = getConfig();
  if (c.TRADING_MODE === 'live') return false;
  return c.PERMISSIVE_PAPER;
}

/** Should we Discord-ping every paper fill? Verbose - intended for early testing only. */
export function shouldPingPaperFills(): boolean {
  return getConfig().PING_PAPER_FILLS;
}

/** Is aggressive mode on? Drops thresholds + raises Kelly fraction. */
export function isAggressive(): boolean {
  return getConfig().AGGRESSIVE;
}
