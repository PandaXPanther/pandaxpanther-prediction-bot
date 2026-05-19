import 'dotenv/config';
import { z } from 'zod';

// Treat empty strings as undefined so blank .env values fall through to defaults
for (const k of Object.keys(process.env)) {
  if (process.env[k] === '') delete process.env[k];
}

const ConfigSchema = z.object({
  // Mode
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  PERMISSIVE_PAPER: z.coerce.boolean().default(false),
  PING_PAPER_FILLS: z.coerce.boolean().default(false),  // Discord-ping paper fills too (verbose - testing only)
  DAILY_LOSS_CAP_USD: z.coerce.number().positive().default(200),
  MAX_POSITION_PER_MARKET_USD: z.coerce.number().positive().default(250),

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
  return getConfig().TRADING_MODE === 'paper';
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
