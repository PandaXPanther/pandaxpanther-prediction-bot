/**
 * Raw REST client for Supabase. We bypass @supabase/supabase-js entirely
 * because its constructor tries to spin up a Realtime WebSocket that
 * doesn't work cleanly in Node without a polyfill. We only do REST writes
 * here, so a thin wrapper around axios is simpler and more reliable.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

let _http: AxiosInstance | null = null;
let _enabled = false;

function getHttp(): AxiosInstance | null {
  if (_http !== null) return _enabled ? _http : null;
  const config = getConfig();
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    logger.warn('Supabase not configured — running without persistence');
    _enabled = false;
    _http = axios.create(); // dummy so we don't re-check
    return null;
  }
  _http = axios.create({
    baseURL: `${config.SUPABASE_URL}/rest/v1`,
    timeout: 10000,
    headers: {
      apikey: config.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'x-client-info': 'pandaxpanther-prediction-bot/0.1',
    },
  });
  _enabled = true;
  return _http;
}

/** Shim kept for any existing `getSupabase()` callers - returns a no-op so they don't crash. */
export function getSupabase(): any {
  return new Proxy({}, {
    get: () => () => Promise.resolve({ data: null, error: null }),
  });
}

async function pgInsert<T = any>(table: string, row: Record<string, unknown>, options: { upsertOn?: string; returning?: string } = {}): Promise<T | null> {
  const http = getHttp();
  if (!http) return null;
  try {
    const headers: Record<string, string> = {
      Prefer: options.returning === 'minimal' ? 'return=minimal' : 'return=representation',
    };
    if (options.upsertOn) {
      headers.Prefer = `resolution=merge-duplicates,${headers.Prefer}`;
    }
    const params: Record<string, string> = {};
    if (options.upsertOn) params.on_conflict = options.upsertOn;
    const { data } = await http.post(`/${table}`, [row], { headers, params });
    if (Array.isArray(data) && data.length > 0) return data[0] as T;
    return null;
  } catch (err) {
    const ae = err as AxiosError;
    logger.error(
      { table, status: ae.response?.status, body: ae.response?.data, row: Object.keys(row) },
      'Supabase insert failed'
    );
    return null;
  }
}

export interface MarketRecord {
  platform: 'polymarket' | 'kalshi';
  external_id: string;
  question: string;
  category?: string;
  outcome?: 'YES' | 'NO';
  closes_at?: Date;
  metadata?: Record<string, unknown>;
}

export async function upsertMarket(market: MarketRecord): Promise<string | null> {
  const row = await pgInsert<{ id: string }>(
    'markets',
    {
      platform: market.platform,
      external_id: market.external_id,
      question: market.question,
      category: market.category,
      outcome: market.outcome,
      closes_at: market.closes_at?.toISOString(),
      metadata: market.metadata ?? {},
      updated_at: new Date().toISOString(),
    },
    { upsertOn: 'platform,external_id,outcome' }
  );
  return row?.id ?? null;
}

export async function recordOrderBookSnapshot(
  marketId: string,
  bestBid: number | null,
  bestAsk: number | null,
  bidSize?: number,
  askSize?: number,
  raw?: unknown
): Promise<void> {
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  await pgInsert('order_book_snapshots', {
    market_id: marketId,
    best_bid: bestBid,
    best_ask: bestAsk,
    bid_size: bidSize,
    ask_size: askSize,
    mid,
    raw,
  }, { returning: 'minimal' });
}

export interface SignalRecord {
  strategy: string;
  market_id?: string;
  cross_market_id?: string;
  edge_bps?: number;
  model_prob?: number;
  market_prob?: number;
  recommended_size_usd?: number;
  side?: 'YES' | 'NO' | 'ARB_BUY_BOTH';
  acted?: boolean;
  reason?: string;
  payload?: Record<string, unknown>;
}

export async function recordSignal(s: SignalRecord): Promise<string | null> {
  const row = await pgInsert<{ id: string }>('signals', s as unknown as Record<string, unknown>);
  return row?.id ?? null;
}

export interface OrderRecord {
  signal_id?: string;
  market_id?: string;
  strategy: string;
  mode: 'paper' | 'live';
  side: 'BUY' | 'SELL';
  order_type: 'LIMIT' | 'MARKET' | 'FOK' | 'IOC';
  price: number;
  size: number;
  outcome: 'YES' | 'NO';
  external_order_id?: string;
  status: 'pending' | 'open' | 'filled' | 'partial' | 'canceled' | 'rejected';
  filled_size?: number;
  avg_fill_price?: number;
  fees?: number;
  rebate?: number;
  error?: string;
  raw?: Record<string, unknown>;
}

export async function recordOrder(o: OrderRecord): Promise<string | null> {
  if (!o.market_id) {
    logger.debug({ strategy: o.strategy }, 'Skipping order persistence - no market_id');
    return null;
  }
  const row = await pgInsert<{ id: string }>('orders', o as unknown as Record<string, unknown>);
  return row?.id ?? null;
}

/**
 * Track a heartbeat. We persist these as signals with a reason='heartbeat'
 * so we get a full time-series view of the bot's health in Supabase, not
 * just the daily aggregate.
 */
export async function recordHeartbeat(strategy: string, mode: 'paper' | 'live', payload: Record<string, unknown>): Promise<void> {
  await pgInsert('signals', {
    strategy,
    acted: false,
    reason: 'heartbeat',
    payload: { mode, ...payload },
  }, { returning: 'minimal' });
  logger.info({ strategy, mode, ...payload }, '📊 heartbeat');
}
