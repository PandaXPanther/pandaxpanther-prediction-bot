/**
 * Raw REST client for Supabase. We bypass @supabase/supabase-js entirely
 * because its constructor tries to spin up a Realtime WebSocket that
 * doesn't work cleanly in Node without a polyfill. We only do REST writes
 * here, so a thin wrapper around axios is simpler and more reliable.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { attachRetryInterceptor } from '../utils/httpResilience.js';
import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

// Track Supabase write failures so the watchdog can react (>5 consecutive = wedged).
let consecutiveInsertFailures = 0;
let lastSuccessfulInsertAt = 0;
export function getSupabaseHealth(): { consecutiveFailures: number; lastSuccessAt: number } {
  return { consecutiveFailures: consecutiveInsertFailures, lastSuccessAt: lastSuccessfulInsertAt };
}

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
  attachRetryInterceptor(_http, 'supabase');
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
    // Track success for watchdog.
    consecutiveInsertFailures = 0;
    lastSuccessfulInsertAt = Date.now();
    if (Array.isArray(data) && data.length > 0) return data[0] as T;
    return null;
  } catch (err) {
    consecutiveInsertFailures++;
    const ae = err as AxiosError;
    // Include full error body + row sample for debugging (truncated to avoid log spam)
    const rowSample: Record<string, unknown> = {};
    for (const k of Object.keys(row).slice(0, 20)) {
      const v = (row as any)[k];
      rowSample[k] = typeof v === 'object' ? '[obj]' : v;
    }
    logger.error(
      {
        table,
        status: ae.response?.status,
        body: ae.response?.data,
        errMsg: ae.message,
        rowKeys: Object.keys(row),
        rowSample,
      },
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
  mode?: 'paper' | 'live';
  payload?: Record<string, unknown>;
}

export async function recordSignal(s: SignalRecord): Promise<string | null> {
  // signals table does NOT have a top-level 'mode' column. Always inject into payload
  // and strip the top-level field before insert. (Prevents spurious schema-cache errors
  // in logs that previously fired on every signal.)
  const { mode, ...rest } = s;
  const enriched = {
    ...rest,
    payload: { ...(s.payload || {}), mode: mode ?? (s.payload as any)?.mode },
  };
  const row = await pgInsert<{ id: string }>('signals', enriched as unknown as Record<string, unknown>);
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
    // v1 LOW-13: bump from debug to warn. Missing market_id silently drops the order
    // out of the audit trail (and out of reconcile dedup queries). At least surface it.
    logger.warn({ strategy: o.strategy, externalOrderId: o.external_order_id }, 'Skipping order persistence - no market_id (order will not appear in DB audit trail)');
    return null;
  }
  const row = await pgInsert<{ id: string }>('orders', o as unknown as Record<string, unknown>);
  return row?.id ?? null;
}

/**
 * Update an existing orders row — used by reconciler to update status/filled_size
 * once Kalshi reports actual fill outcome.
 */
export async function updateOrder(
  orderId: string,
  updates: Partial<Pick<OrderRecord, 'status' | 'filled_size' | 'avg_fill_price' | 'error' | 'fees'>>
): Promise<boolean> {
  const http = getHttp();
  if (!http) return false;
  try {
    await http.patch(`/orders?id=eq.${orderId}`, updates, {
      headers: { Prefer: 'return=minimal' },
    });
    return true;
  } catch (err) {
    const ae = err as AxiosError;
    logger.warn({ orderId, status: ae.response?.status, body: ae.response?.data }, 'updateOrder failed');
    return false;
  }
}

/**
 * Mark an order row as cancelled by its Kalshi external_order_id.
 * Used by strategies when they cancel orders to keep the DB in sync.
 * Returns true if a row was matched (even if already cancelled), false on hard failure.
 * Audit M-5 (LIP cancel → DB update gap).
 */
export async function markOrderCancelledByExternalId(externalOrderId: string, reason?: string): Promise<boolean> {
  const http = getHttp();
  if (!http) return false;
  try {
    await http.patch(`/orders?external_order_id=eq.${encodeURIComponent(externalOrderId)}&status=eq.open`, {
      status: 'cancelled',
      error: reason ? `cancelled: ${reason}` : 'cancelled',
    }, {
      headers: { Prefer: 'return=minimal' },
    });
    return true;
  } catch (err) {
    const ae = err as AxiosError;
    logger.debug({ externalOrderId, status: ae.response?.status, body: ae.response?.data }, 'markOrderCancelledByExternalId failed');
    return false;
  }
}

/** Lookup orders.external_order_id → id. Used by reconciler. */
export async function findOrderByExternalId(externalOrderId: string): Promise<{ id: string; status: string } | null> {
  const http = getHttp();
  if (!http) return null;
  try {
    const { data } = await http.get('/orders', {
      params: {
        select: 'id,status',
        external_order_id: `eq.${externalOrderId}`,
        limit: '1',
      },
    });
    return data?.[0] ?? null;
  } catch (err: any) {
    // v1 LOW-14: was indistinguishable from `not found` — log at debug so a DB outage
    // doesn't pretend there are no matching rows. Caller still gets null (compatible).
    logger.debug({ externalOrderId, err: err?.message ?? String(err), status: err?.response?.status }, 'findOrderByExternalId query failed');
    return null;
  }
}

/** Get recent fires per event_ticker prefix for crypto strategy.
 *  Used to seed in-memory dedup map across deploys. */
export async function getRecentCryptoFiresByEvent(hoursBack: number = 6): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const http = getHttp();
  if (!http) return map;
  try {
    const sinceTs = new Date(Date.now() - hoursBack * 3600 * 1000).toISOString();
    // 1) Get recent crypto orders via raw PostgREST (no JS SDK join — the proxy stub returns nothing)
    // CRITICAL: include ALL statuses (not just filled/partial). The May 20 stacking bug exposed
    // a case where 'rejected' was logged but Kalshi actually accepted/filled. Any attempt counts.
    const ordersResp = await http.get('/orders', {
      params: {
        select: 'ts_created,market_id',
        strategy: 'eq.kalshi_hourly_crypto',
        ts_created: `gte.${sinceTs}`,
        limit: '500',
      },
    });
    const rows: { ts_created: string; market_id: string | null }[] = ordersResp.data ?? [];
    if (rows.length === 0) {
      logger.info({ count: 0, hoursBack }, 'loaded recent crypto fires from DB');
      return map;
    }
    // 2) Look up markets in bulk by id
    const marketIds = Array.from(new Set(rows.map(r => r.market_id).filter(Boolean) as string[]));
    const idToExt = new Map<string, string>();
    if (marketIds.length > 0) {
      const inList = `(${marketIds.map(id => `"${id}"`).join(',')})`;
      const marketsResp = await http.get('/markets', {
        params: {
          select: 'id,external_id',
          id: `in.${inList}`,
          limit: String(marketIds.length),
        },
      });
      for (const m of (marketsResp.data ?? []) as { id: string; external_id: string }[]) {
        idToExt.set(m.id, m.external_id);
      }
    }
    // 3) Derive event tickers and dedupe to newest
    for (const r of rows) {
      if (!r.market_id) continue;
      const ext = idToExt.get(r.market_id) ?? '';
      const parts = ext.split('-');
      if (parts.length >= 2) {
        const eventTicker = parts.slice(0, 2).join('-');
        const ts = new Date(r.ts_created).getTime();
        if (!map.has(eventTicker) || (map.get(eventTicker) ?? 0) < ts) {
          map.set(eventTicker, ts);
        }
      }
    }
    logger.info({ count: map.size, rows: rows.length, hoursBack }, 'loaded recent crypto fires from DB');
  } catch (e: any) {
    const ae = e as AxiosError;
    logger.warn({ err: e.message, status: ae?.response?.status, body: ae?.response?.data }, 'getRecentCryptoFiresByEvent error');
  }
  return map;
}

/**
 * Track a heartbeat. We persist these as signals with a reason='heartbeat'
 * so we get a full time-series view of the bot's health in Supabase, not
 * just the daily aggregate.
 */
/**
 * Fetch recent graded trade outcomes from signals table so the adaptive
 * controller can re-hydrate its rolling window after a restart. Without this,
 * every restart wipes adaptive memory → kill switch never accumulates losses.
 */
export async function getRecentTradeGrades(limit: number = 50): Promise<Array<{
  ts: number; won: boolean; pnl: number; modelProb: number; marketProb: number; realizedVol: number;
}>> {
  const http = getHttp();
  if (!http) return [];
  try {
    const resp = await http.get('/signals', {
      params: {
        select: 'ts,payload',
        strategy: 'eq.kalshi_hourly_crypto',
        reason: 'eq.trade-graded',
        order: 'ts.desc',
        limit: String(limit),
      },
    });
    const rows = (resp.data ?? []) as Array<{ ts: string; payload: any }>;
    const out = rows.map(r => ({
      ts: new Date(r.ts).getTime(),
      won: !!r.payload?.won,
      pnl: Number(r.payload?.pnl ?? 0),
      modelProb: Number(r.payload?.modelProb ?? 0),
      marketProb: Number(r.payload?.marketProb ?? 0),
      realizedVol: Number(r.payload?.realizedVol ?? 0),
    }));
    logger.info({ loaded: out.length }, 'loaded recent trade grades from DB');
    return out;
  } catch (e: any) {
    logger.warn({ err: e.message }, 'getRecentTradeGrades failed');
    return [];
  }
}

export async function recordHeartbeat(strategy: string, mode: 'paper' | 'live', payload: Record<string, unknown>): Promise<void> {
  await pgInsert('signals', {
    strategy,
    acted: false,
    reason: 'heartbeat',
    payload: { mode, ...payload },
  }, { returning: 'minimal' });
  logger.info({ strategy, mode, ...payload }, '📊 heartbeat');
}
