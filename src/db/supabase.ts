import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const config = getConfig();
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    logger.warn('Supabase not configured — running without persistence');
    // Return a no-op proxy so calls in paper mode don't crash
    return new Proxy({} as SupabaseClient, {
      get: () => () => ({ data: null, error: null }),
    });
  }
  _client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return _client;
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
  const sb = getSupabase();
  const { data, error } = await sb
    .from('markets')
    .upsert(
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
      { onConflict: 'platform,external_id,outcome' }
    )
    .select('id')
    .single();
  if (error) {
    logger.error({ error, market }, 'Failed to upsert market');
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

export async function recordOrderBookSnapshot(
  marketId: string,
  bestBid: number | null,
  bestAsk: number | null,
  bidSize?: number,
  askSize?: number,
  raw?: unknown
): Promise<void> {
  const sb = getSupabase();
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  await sb.from('order_book_snapshots').insert({
    market_id: marketId,
    best_bid: bestBid,
    best_ask: bestAsk,
    bid_size: bidSize,
    ask_size: askSize,
    mid,
    raw: raw as Record<string, unknown> | undefined,
  });
}
