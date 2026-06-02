// Shared types for all connectors

export type Platform = 'polymarket' | 'kalshi';
export type Outcome = 'YES' | 'NO';
export type Side = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'FOK' | 'IOC';

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  platform: Platform;
  externalId: string;          // token_id (Polymarket) or ticker (Kalshi)
  outcome: Outcome;
  bestBid?: OrderBookLevel;
  bestAsk?: OrderBookLevel;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  ts: number;                  // ms epoch
}

export interface PlaceOrderRequest {
  externalId: string;
  outcome: Outcome;
  side: Side;
  orderType: OrderType;
  price: number;
  size: number;
  /** Optional client_order_id prefix for strategy identification (e.g., 'lip', 'crypto-tp'). Default 'bot'. */
  clientOrderIdPrefix?: string;
  /** If false, allow taker fills. Default true for BUYs (post-only — reject if would cross). */
  postOnly?: boolean;
}

export interface PlaceOrderResult {
  ok: boolean;
  externalOrderId?: string;
  filled?: number;
  avgPrice?: number;
  error?: string;
}

export interface MarketInfo {
  platform: Platform;
  externalId: string;
  question: string;
  category?: string;
  closesAt?: Date;
  eventTicker?: string;
  fractional?: boolean;
  liquidityUsd?: number;       // total bid+ask depth in dollars
  yes_token?: string;          // for Polymarket two-token markets
  no_token?: string;
}

export interface MarketConnector {
  readonly platform: Platform;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Discovery
  listActiveMarkets(category?: string): Promise<MarketInfo[]>;

  // Real-time data
  subscribeOrderBook(externalId: string, cb: (book: OrderBook) => void): Promise<() => void>;

  // Trading
  placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult>;
  cancelOrder(orderId: string): Promise<boolean>;
  getOpenOrders(): Promise<unknown[]>;
  getBalance(): Promise<number>;
}
