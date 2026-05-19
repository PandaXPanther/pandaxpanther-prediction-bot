import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import { getConfig, isPaperMode } from '../utils/config.js';
import { createStrategyLogger } from '../utils/logger.js';
import type {
  MarketConnector,
  MarketInfo,
  OrderBook,
  PlaceOrderRequest,
  PlaceOrderResult,
} from './types.js';

const log = createStrategyLogger('polymarket');

/**
 * Polymarket CLOB connector.
 *
 * Uses the official @polymarket/clob-client SDK for signed order placement,
 * and a raw WebSocket connection to wss://ws-subscriptions-clob.polymarket.com/ws/market
 * for real-time orderbook updates.
 *
 * In paper mode, no actual orders are placed; we simulate fills against the
 * best bid/ask we observe via the WebSocket.
 *
 * Docs: https://docs.polymarket.com
 */
export class PolymarketConnector implements MarketConnector {
  readonly platform = 'polymarket' as const;

  private http: AxiosInstance;
  private ws: WebSocket | null = null;
  private clobClient: any = null;
  private subscribers = new Map<string, ((book: OrderBook) => void)[]>();
  private bookState = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();

  constructor() {
    const config = getConfig();
    this.http = axios.create({
      baseURL: config.POLYMARKET_HOST,
      timeout: 10000,
    });
  }

  async connect(): Promise<void> {
    if (!isPaperMode()) {
      // Lazy import to avoid pulling in ethers/wallet code unnecessarily
      const { ClobClient } = await import('@polymarket/clob-client');
      const config = getConfig();
      if (!config.POLYMARKET_PRIVATE_KEY) {
        throw new Error('POLYMARKET_PRIVATE_KEY required for live mode');
      }
      const { Wallet } = await import('ethers');
      const wallet = new Wallet(config.POLYMARKET_PRIVATE_KEY);
      this.clobClient = new ClobClient(
        config.POLYMARKET_HOST,
        config.POLYMARKET_CHAIN_ID,
        wallet as any,
        {
          key: config.POLYMARKET_API_KEY!,
          secret: config.POLYMARKET_API_SECRET!,
          passphrase: config.POLYMARKET_API_PASSPHRASE!,
        }
      );
      log.info('Polymarket CLOB client initialized');
    } else {
      log.info('Polymarket connector running in PAPER mode (no signed orders)');
    }

    await this.openWebSocket();
  }

  private async openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market');
      this.ws.on('open', () => {
        log.info('Polymarket WebSocket open');
        resolve();
      });
      this.ws.on('message', (data) => this.handleMessage(data.toString()));
      this.ws.on('error', (err) => log.error({ err }, 'Polymarket WS error'));
      this.ws.on('close', () => {
        log.warn('Polymarket WS closed — reconnecting in 5s');
        setTimeout(() => this.openWebSocket(), 5000);
      });
      setTimeout(() => reject(new Error('Polymarket WS connect timeout')), 10000);
    });
  }

  private handleMessage(raw: string): void {
    try {
      const msgs = JSON.parse(raw);
      const list = Array.isArray(msgs) ? msgs : [msgs];
      for (const msg of list) {
        if (msg.event_type === 'book' || msg.event_type === 'price_change') {
          this.applyBookUpdate(msg);
        }
      }
    } catch (err) {
      log.debug({ err, raw }, 'WS parse error');
    }
  }

  private applyBookUpdate(msg: any): void {
    const assetId: string | undefined = msg.asset_id;
    if (!assetId) return;
    if (!this.bookState.has(assetId)) {
      this.bookState.set(assetId, { bids: new Map(), asks: new Map() });
    }
    const state = this.bookState.get(assetId)!;

    if (msg.event_type === 'book') {
      state.bids.clear();
      state.asks.clear();
      for (const b of msg.bids ?? []) state.bids.set(parseFloat(b.price), parseFloat(b.size));
      for (const a of msg.asks ?? []) state.asks.set(parseFloat(a.price), parseFloat(a.size));
    } else if (msg.event_type === 'price_change') {
      for (const ch of msg.changes ?? []) {
        const price = parseFloat(ch.price);
        const size = parseFloat(ch.size);
        const side = ch.side === 'BUY' ? state.bids : state.asks;
        if (size === 0) side.delete(price);
        else side.set(price, size);
      }
    }

    // Build OrderBook view and dispatch
    const sortedBids = [...state.bids.entries()].sort((a, b) => b[0] - a[0]);
    const sortedAsks = [...state.asks.entries()].sort((a, b) => a[0] - b[0]);
    const book: OrderBook = {
      platform: 'polymarket',
      externalId: assetId,
      outcome: 'YES',
      bestBid: sortedBids[0] ? { price: sortedBids[0][0], size: sortedBids[0][1] } : undefined,
      bestAsk: sortedAsks[0] ? { price: sortedAsks[0][0], size: sortedAsks[0][1] } : undefined,
      bids: sortedBids.map(([price, size]) => ({ price, size })),
      asks: sortedAsks.map(([price, size]) => ({ price, size })),
      ts: Date.now(),
    };
    const subs = this.subscribers.get(assetId) ?? [];
    for (const cb of subs) {
      try {
        cb(book);
      } catch (err) {
        log.error({ err }, 'Subscriber callback error');
      }
    }
  }

  async subscribeOrderBook(
    externalId: string,
    cb: (book: OrderBook) => void
  ): Promise<() => void> {
    if (!this.ws) throw new Error('WebSocket not connected');
    const list = this.subscribers.get(externalId) ?? [];
    list.push(cb);
    this.subscribers.set(externalId, list);
    this.ws.send(
      JSON.stringify({
        type: 'MARKET',
        assets_ids: [externalId],
      })
    );
    return () => {
      const arr = this.subscribers.get(externalId) ?? [];
      this.subscribers.set(externalId, arr.filter((c) => c !== cb));
    };
  }

  async listActiveMarkets(category?: string): Promise<MarketInfo[]> {
    // Gamma API for market discovery
    const url = 'https://gamma-api.polymarket.com/markets';
    const params: Record<string, string | number> = {
      active: 'true',
      closed: 'false',
      limit: 500,
    };
    if (category) params.tag = category;
    const { data } = await axios.get(url, { params });
    return (data as any[]).map((m) => {
      const tokens = JSON.parse(m.clobTokenIds ?? '[]');
      return {
        platform: 'polymarket' as const,
        externalId: m.id?.toString() ?? m.conditionId,
        question: m.question,
        category: m.category,
        closesAt: m.endDate ? new Date(m.endDate) : undefined,
        yes_token: tokens[0],
        no_token: tokens[1],
      };
    });
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    if (isPaperMode()) {
      // Simulate against current book
      const state = this.bookState.get(req.externalId);
      const bestPrice =
        req.side === 'BUY'
          ? state ? [...state.asks.keys()].sort((a, b) => a - b)[0] : undefined
          : state ? [...state.bids.keys()].sort((a, b) => b - a)[0] : undefined;
      const filled = bestPrice != null && (
        (req.side === 'BUY' && req.price >= bestPrice) ||
        (req.side === 'SELL' && req.price <= bestPrice)
      );
      log.info({ req, filled, bestPrice }, 'Paper order');
      return {
        ok: true,
        externalOrderId: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filled: filled ? req.size : 0,
        avgPrice: filled ? bestPrice : undefined,
      };
    }

    if (!this.clobClient) {
      return { ok: false, error: 'CLOB client not initialized' };
    }

    try {
      const order = await this.clobClient.createOrder({
        tokenID: req.externalId,
        price: req.price,
        side: req.side,
        size: req.size,
        feeRateBps: 0,
      });
      const resp = await this.clobClient.postOrder(order, req.orderType);
      return {
        ok: !!resp.success,
        externalOrderId: resp.orderID,
        filled: parseFloat(resp.makingAmount ?? '0'),
        avgPrice: req.price,
      };
    } catch (err: any) {
      log.error({ err: err.message }, 'Polymarket order error');
      return { ok: false, error: err.message };
    }
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    if (isPaperMode()) {
      log.info({ orderId }, 'Paper cancel');
      return true;
    }
    if (!this.clobClient) return false;
    try {
      const resp = await this.clobClient.cancelOrder({ orderID: orderId });
      return !!resp.success;
    } catch (err) {
      log.error({ err }, 'Polymarket cancel error');
      return false;
    }
  }

  async getOpenOrders(): Promise<unknown[]> {
    if (!this.clobClient) return [];
    try {
      return await this.clobClient.getOpenOrders();
    } catch (err) {
      log.error({ err }, 'Polymarket getOpenOrders error');
      return [];
    }
  }

  async getBalance(): Promise<number> {
    if (isPaperMode()) {
      return 5000; // simulated $5K paper bankroll
    }
    if (!this.clobClient) return 0;
    try {
      const bal = await this.clobClient.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      return parseFloat(bal.balance ?? '0') / 1e6; // USDC has 6 decimals
    } catch (err) {
      log.error({ err }, 'Polymarket getBalance error');
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
