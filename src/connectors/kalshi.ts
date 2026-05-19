import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import { getConfig, isPaperMode } from '../utils/config.js';
import { createStrategyLogger } from '../utils/logger.js';
import type {
  MarketConnector,
  MarketInfo,
  OrderBook,
  PlaceOrderRequest,
  PlaceOrderResult,
} from './types.js';

const log = createStrategyLogger('kalshi');

/**
 * Kalshi connector.
 *
 * Auth: API Key ID + RSA private key. Each request is signed with timestamp+method+path.
 *
 * Docs: https://trading-api.readme.io
 * WebSocket: https://trading-api.readme.io/reference/websocket-channels
 */
export class KalshiConnector implements MarketConnector {
  readonly platform = 'kalshi' as const;

  private http: AxiosInstance;
  private ws: WebSocket | null = null;
  private privateKey: string | null = null;
  private apiKeyId: string | null = null;
  private subscribers = new Map<string, ((book: OrderBook) => void)[]>();
  private bookState = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();
  private msgId = 1;
  private subIdToTicker = new Map<number, string>();

  constructor() {
    const config = getConfig();
    this.http = axios.create({
      baseURL: config.KALSHI_HOST,
      timeout: 10000,
    });
  }

  // True if we have full API credentials loaded
  private hasCredentials = false;

  async connect(): Promise<void> {
    const config = getConfig();
    if (config.KALSHI_API_KEY_ID && fs.existsSync(config.KALSHI_PRIVATE_KEY_PATH)) {
      try {
        this.apiKeyId = config.KALSHI_API_KEY_ID;
        this.privateKey = fs.readFileSync(config.KALSHI_PRIVATE_KEY_PATH, 'utf8');
        this.hasCredentials = true;
        log.info('Kalshi client initialized with credentials');
      } catch (err) {
        log.warn({ err }, 'Failed to load Kalshi credentials - degrading to read-only public data');
      }
    } else {
      log.info('Kalshi connector running in PAPER mode (no credentials - public market data only)');
    }

    if (!isPaperMode() && !this.hasCredentials) {
      throw new Error('Kalshi credentials required for live mode');
    }

    // Only attempt WebSocket if we have creds (Kalshi WSS requires auth)
    if (this.hasCredentials) {
      try {
        await this.openWebSocket();
      } catch (err) {
        log.warn({ err }, 'Kalshi WS connect failed - continuing without real-time book');
      }
    } else {
      log.info('Skipping Kalshi WS (requires auth) - will poll REST for market data');
    }
  }

  private sign(method: string, path: string, ts: number): Record<string, string> {
    if (!this.privateKey || !this.apiKeyId) return {};
    const message = `${ts}${method}${path}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(message);
    signer.end();
    const signature = signer.sign({ key: this.privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }, 'base64');
    return {
      'KALSHI-ACCESS-KEY': this.apiKeyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': ts.toString(),
    };
  }

  private async openWebSocket(): Promise<void> {
    const config = getConfig();
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (!isPaperMode()) {
        const ts = Date.now();
        Object.assign(headers, this.sign('GET', '/trade-api/ws/v2', ts));
      }
      this.ws = new WebSocket(config.KALSHI_WSS, { headers });
      this.ws.on('open', () => {
        log.info('Kalshi WebSocket open');
        resolve();
      });
      this.ws.on('message', (data) => this.handleMessage(data.toString()));
      this.ws.on('error', (err) => log.error({ err }, 'Kalshi WS error'));
      this.ws.on('close', () => {
        log.warn('Kalshi WS closed — reconnecting in 5s');
        setTimeout(() => this.openWebSocket(), 5000);
      });
      setTimeout(() => reject(new Error('Kalshi WS connect timeout')), 10000);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'orderbook_snapshot' || msg.type === 'orderbook_delta') {
        this.applyBookUpdate(msg);
      }
    } catch (err) {
      log.debug({ err, raw }, 'WS parse error');
    }
  }

  private applyBookUpdate(msg: any): void {
    const ticker: string | undefined = msg.msg?.market_ticker;
    if (!ticker) return;
    if (!this.bookState.has(ticker)) {
      this.bookState.set(ticker, { bids: new Map(), asks: new Map() });
    }
    const state = this.bookState.get(ticker)!;

    // Kalshi quotes in CENTS (1-99). We normalize to dollars (0.01-0.99)
    if (msg.type === 'orderbook_snapshot') {
      state.bids.clear();
      state.asks.clear();
      for (const [priceCents, size] of msg.msg.yes ?? []) {
        state.bids.set(priceCents / 100, size);
      }
      for (const [priceCents, size] of msg.msg.no ?? []) {
        // NO bid implies YES ask at (100 - price_cents)
        state.asks.set((100 - priceCents) / 100, size);
      }
    } else if (msg.type === 'orderbook_delta') {
      const priceCents = msg.msg.price;
      const delta = msg.msg.delta;
      const side = msg.msg.side; // 'yes' or 'no'
      if (side === 'yes') {
        const price = priceCents / 100;
        const current = state.bids.get(price) ?? 0;
        const next = current + delta;
        if (next <= 0) state.bids.delete(price);
        else state.bids.set(price, next);
      } else {
        const price = (100 - priceCents) / 100;
        const current = state.asks.get(price) ?? 0;
        const next = current + delta;
        if (next <= 0) state.asks.delete(price);
        else state.asks.set(price, next);
      }
    }

    const sortedBids = [...state.bids.entries()].sort((a, b) => b[0] - a[0]);
    const sortedAsks = [...state.asks.entries()].sort((a, b) => a[0] - b[0]);
    const book: OrderBook = {
      platform: 'kalshi',
      externalId: ticker,
      outcome: 'YES',
      bestBid: sortedBids[0] ? { price: sortedBids[0][0], size: sortedBids[0][1] } : undefined,
      bestAsk: sortedAsks[0] ? { price: sortedAsks[0][0], size: sortedAsks[0][1] } : undefined,
      bids: sortedBids.map(([price, size]) => ({ price, size })),
      asks: sortedAsks.map(([price, size]) => ({ price, size })),
      ts: Date.now(),
    };
    const subs = this.subscribers.get(ticker) ?? [];
    for (const cb of subs) {
      try {
        cb(book);
      } catch (err) {
        log.error({ err }, 'Subscriber callback error');
      }
    }
  }

  async subscribeOrderBook(
    ticker: string,
    cb: (book: OrderBook) => void
  ): Promise<() => void> {
    if (!this.ws) throw new Error('WebSocket not connected');
    const list = this.subscribers.get(ticker) ?? [];
    list.push(cb);
    this.subscribers.set(ticker, list);

    const id = this.msgId++;
    this.subIdToTicker.set(id, ticker);
    this.ws.send(
      JSON.stringify({
        id,
        cmd: 'subscribe',
        params: {
          channels: ['orderbook_delta'],
          market_tickers: [ticker],
        },
      })
    );
    return () => {
      const arr = this.subscribers.get(ticker) ?? [];
      this.subscribers.set(ticker, arr.filter((c) => c !== cb));
    };
  }

  async listActiveMarkets(category?: string): Promise<MarketInfo[]> {
    // Kalshi /markets endpoint is PUBLIC - no auth needed for read
    const params: Record<string, string | number> = { status: 'open', limit: 200 };
    if (category) params.series_ticker = category;
    try {
      const headers = this.hasCredentials ? this.sign('GET', '/trade-api/v2/markets', Date.now()) : {};
      const { data } = await this.http.get('/markets', { params, headers });
      return (data.markets ?? []).map((m: any) => ({
        platform: 'kalshi' as const,
        externalId: m.ticker,
        question: m.title ?? m.subtitle ?? m.ticker,
        category: m.event_ticker?.split('-')[0]?.toLowerCase(),
        closesAt: m.close_time ? new Date(m.close_time) : undefined,
      }));
    } catch (err: any) {
      log.error({ err: err.message }, 'Kalshi listActiveMarkets error');
      return [];
    }
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    if (isPaperMode()) {
      const state = this.bookState.get(req.externalId);
      const bestPrice =
        req.side === 'BUY'
          ? state ? [...state.asks.keys()].sort((a, b) => a - b)[0] : undefined
          : state ? [...state.bids.keys()].sort((a, b) => b - a)[0] : undefined;
      const filled = bestPrice != null && (
        (req.side === 'BUY' && req.price >= bestPrice) ||
        (req.side === 'SELL' && req.price <= bestPrice)
      );
      log.info({ req, filled, bestPrice }, 'Paper Kalshi order');
      return {
        ok: true,
        externalOrderId: `paper-kalshi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filled: filled ? req.size : 0,
        avgPrice: filled ? bestPrice : undefined,
      };
    }

    try {
      const ts = Date.now();
      const headers = this.sign('POST', '/trade-api/v2/portfolio/orders', ts);
      // Kalshi expects integer cents
      const yesPriceCents = req.outcome === 'YES' ? Math.round(req.price * 100) : 100 - Math.round(req.price * 100);
      const { data } = await this.http.post(
        '/portfolio/orders',
        {
          ticker: req.externalId,
          action: req.side.toLowerCase(),
          side: req.outcome.toLowerCase(),
          count: Math.round(req.size),
          type: req.orderType.toLowerCase(),
          yes_price: req.outcome === 'YES' ? yesPriceCents : undefined,
          no_price: req.outcome === 'NO' ? 100 - yesPriceCents : undefined,
        },
        { headers }
      );
      return {
        ok: true,
        externalOrderId: data.order?.order_id,
        filled: data.order?.taker_fill_count ?? 0,
        avgPrice: req.price,
      };
    } catch (err: any) {
      log.error({ err: err.message }, 'Kalshi order error');
      return { ok: false, error: err.message };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (isPaperMode()) {
      log.info({ orderId }, 'Paper Kalshi cancel');
      return true;
    }
    try {
      const ts = Date.now();
      const headers = this.sign('DELETE', `/trade-api/v2/portfolio/orders/${orderId}`, ts);
      await this.http.delete(`/portfolio/orders/${orderId}`, { headers });
      return true;
    } catch (err) {
      log.error({ err }, 'Kalshi cancel error');
      return false;
    }
  }

  async getOpenOrders(): Promise<unknown[]> {
    if (isPaperMode()) return [];
    try {
      const ts = Date.now();
      const headers = this.sign('GET', '/trade-api/v2/portfolio/orders', ts);
      const { data } = await this.http.get('/portfolio/orders', { headers, params: { status: 'resting' } });
      return data.orders ?? [];
    } catch (err) {
      log.error({ err }, 'Kalshi getOpenOrders error');
      return [];
    }
  }

  async getBalance(): Promise<number> {
    if (isPaperMode()) return 5000;
    try {
      const ts = Date.now();
      const headers = this.sign('GET', '/trade-api/v2/portfolio/balance', ts);
      const { data } = await this.http.get('/portfolio/balance', { headers });
      // Kalshi returns balance in cents
      return (data.balance ?? 0) / 100;
    } catch (err) {
      log.error({ err }, 'Kalshi getBalance error');
      return 0;
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}
