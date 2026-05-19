import 'dotenv/config';
import { z } from 'zod';

// Treat empty strings as undefined so blank .env values fall through to defaults
for (const k of Object.keys(process.env)) {
  if (process.env[k] === '') delete process.env[k];
}

const ConfigSchema = z.object({
  // Mode
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  DAILY_LOSS_CAP_USD: z.coerce.number().positive().default(200),
  MAX_POSITION_PER_MARKET_USD: z.coerce.number().positive().default(250),

  // Allocations
  ALLOC_SUM_TO_ONE: z.coerce.number().min(0).max(1).default(0.25),
  ALLOC_CROSS_PLATFORM: z.coerce.number().min(0).max(1).default(0.30),
  ALLOC_CRYPTO_LATENCY: z.coerce.number().min(0).max(1).default(0.30),
  ALLOC_WEATHER: z.coerce.number().min(0).max(1).default(0.15),

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
