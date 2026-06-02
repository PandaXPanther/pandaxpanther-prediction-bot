import axios, { AxiosInstance } from 'axios';
import { attachRetryInterceptor } from '../utils/httpResilience.js';
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
  private orderHttp!: AxiosInstance;
  private ws: WebSocket | null = null;
  private privateKey: string | null = null;
  private apiKeyId: string | null = null;
  private subscribers = new Map<string, ((book: OrderBook) => void)[]>();
  private bookState = new Map<string, { bids: Map<number, number>; asks: Map<number, number> }>();
  private msgId = 1;
  private subIdToTicker = new Map<number, string>();

  constructor() {
    const config = getConfig();
    this.orderHttp = axios.create({
      baseURL: process.env.KALSHI_ORDER_HOST || 'https://external-api.kalshi.com/trade-api/v2',
      timeout: 10_000,
    });
    this.http = axios.create({
      baseURL: config.KALSHI_HOST,
      timeout: 10000,
    });
    // Attach retry interceptors. Note: orderHttp retries are SAFE because Kalshi
    // dedupes by client_order_id on POST. GETs retry by default; POSTs only on
    // connect-level failure (no response = server never saw it).
    attachRetryInterceptor(this.orderHttp, 'kalshi-order');
    attachRetryInterceptor(this.http, 'kalshi-data');
  }

  // True if we have full API credentials loaded
  private hasCredentials = false;

  async connect(): Promise<void> {
    const config = getConfig();
    // Try env var first (Fly secrets pattern), then file path (local dev pattern)
    let pemContent: string | null = null;
    if (config.KALSHI_PRIVATE_KEY) {
      pemContent = config.KALSHI_PRIVATE_KEY;
    } else if (fs.existsSync(config.KALSHI_PRIVATE_KEY_PATH)) {
      try {
        pemContent = fs.readFileSync(config.KALSHI_PRIVATE_KEY_PATH, 'utf8');
      } catch (err) {
        log.warn({ err }, 'Failed to read Kalshi private key file');
      }
    }

    if (config.KALSHI_API_KEY_ID && pemContent) {
      this.apiKeyId = config.KALSHI_API_KEY_ID;
      this.privateKey = pemContent;
      this.hasCredentials = true;
      log.info({ keyId: config.KALSHI_API_KEY_ID.slice(0, 8) + '...' }, 'Kalshi client initialized with credentials');
    } else {
      log.info({ hasKeyId: !!config.KALSHI_API_KEY_ID, hasKey: !!pemContent }, 'Kalshi connector running without credentials (public market data only)');
    }

    if (!isPaperMode() && !this.hasCredentials) {
      throw new Error('Kalshi credentials required for live mode');
    }

    // ENABLE WS - signed with /trade-api/ws/v2 (different from REST /trade-api/v2 prefix)
    if (this.hasCredentials) {
      try {
        await this.openWebSocket();
        log.info('Kalshi WS authenticated and connected');
      } catch (err: any) {
        log.warn({ err: err.message }, 'Kalshi WS connect failed - strategies will fall back to REST polling');
      }
    } else {
      log.info('Kalshi WS skipped - no credentials');
    }
  }

  /**
   * Sign a request. CRITICAL: path must NOT include query string - Kalshi
   * signs only the base path. REST paths use /trade-api/v2; WS uses /trade-api/ws/v2.
   * We auto-prefix REST paths but accept WS paths verbatim.
   */
  // Clock offset between local time and Kalshi server time (in ms).
  // Updated from `Date` response header on every API call. Positive = server is ahead of us.
  private serverClockOffsetMs = 0;

  /** Update server clock offset from a response Date header. */
  private updateClockOffset(dateHeader?: string): void {
    if (!dateHeader) return;
    const serverMs = Date.parse(dateHeader);
    if (!isNaN(serverMs)) {
      const newOffset = serverMs - Date.now();
      if (Math.abs(newOffset - this.serverClockOffsetMs) > 1000) {
        log.info({ oldOffset: this.serverClockOffsetMs, newOffset, dateHeader }, 'Kalshi clock offset updated');
      }
      this.serverClockOffsetMs = newOffset;
    }
  }

  /** Expose offset for diagnostics */
  getClockOffsetMs(): number { return this.serverClockOffsetMs; }

  /** Get a timestamp synced to Kalshi's server clock. */
  private syncedNow(): number {
    return Date.now() + this.serverClockOffsetMs;
  }

  private sign(method: string, fullPath: string, ts: number): Record<string, string> {
    // v1 LOW-12: previously returned `{}` silently, producing 401 downstream that
    // looked like a server issue. For authenticated endpoints, return empty so paper
    // mode still works for public-data calls, but log once at debug so it's visible.
    if (!this.privateKey || !this.apiKeyId) {
      log.debug({ method, fullPath }, 'Kalshi sign() called without credentials — returning empty headers (401 expected if endpoint requires auth)');
      return {};
    }
    const path = fullPath.split('?')[0];
    // WS path is a special case - sign exactly as given (no /trade-api/v2 prefix injection)
    const isWsPath = path.startsWith('/trade-api/ws/');
    const signedPath = isWsPath
      ? path
      : (path.startsWith('/trade-api/v2') ? path : `/trade-api/v2${path}`);
    const message = `${ts}${method}${signedPath}`;
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
      // Sign with WS path (different from REST!)
      const ts = Date.now();
      const headers = this.sign('GET', '/trade-api/ws/v2', ts);

      this.ws = new WebSocket(config.KALSHI_WSS, { headers });
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; reject(new Error('Kalshi WS connect timeout')); }
      }, 12000);

      this.ws.on('open', () => {
        log.info({ url: config.KALSHI_WSS }, 'Kalshi WebSocket open');
        // H-16 fix: stale id → ticker mappings accumulate every reconnect and can
        // mis-route subsequent acks. Clear before re-subscribing.
        this.subIdToTicker.clear();
        // Re-subscribe to all previously-subscribed tickers (on reconnect)
        for (const ticker of this.subscribers.keys()) {
          const id = this.msgId++;
          this.subIdToTicker.set(id, ticker);
          this.ws!.send(JSON.stringify({
            id, cmd: 'subscribe',
            params: { channels: ['orderbook_delta'], market_tickers: [ticker] },
          }));
        }
        if (!resolved) { resolved = true; clearTimeout(timeout); resolve(); }
      });
      this.ws.on('message', (data) => this.handleMessage(data.toString()));
      this.ws.on('error', (err: any) => log.warn({ err: err.message || String(err) }, 'Kalshi WS error'));
      this.ws.on('close', (code, reason) => {
        log.warn({ code, reason: reason?.toString() }, 'Kalshi WS closed — reconnecting in 5s');
        setTimeout(() => {
          this.openWebSocket().catch((err) => log.warn({ err: err.message }, 'WS reconnect attempt failed'));
        }, 5000);
      });
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

    // Kalshi WS quotes can come as either:
    //   - Integer cents (legacy): msg.msg.yes = [[45, 100], ...]  (price 45 = $0.45)
    //   - String dollars (new):   msg.msg.yes_dollars_fp = [["0.45", "100.00"], ...]
    // We accept both formats.
    const parsePriceSize = (entry: any): [number, number] | null => {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const rawPrice = entry[0];
      const rawSize = entry[1];
      let price: number;
      if (typeof rawPrice === 'string') price = parseFloat(rawPrice);
      else price = rawPrice > 1 ? rawPrice / 100 : rawPrice;  // cents -> dollars
      const size = typeof rawSize === 'string' ? parseFloat(rawSize) : rawSize;
      // v2 L-4: accept the full Kalshi price range $0.01-$0.99 inclusive (was strict
      // `>= 1` which silently dropped $0.99 asks/bids). Anything >= 1 truly is invalid.
      if (!isFinite(price) || !isFinite(size) || price < 0.01 || price > 0.99) return null;
      return [price, size];
    };

    if (msg.type === 'orderbook_snapshot') {
      state.bids.clear();
      state.asks.clear();
      const yesArr = msg.msg.yes_dollars_fp ?? msg.msg.yes_dollars ?? msg.msg.yes ?? [];
      const noArr = msg.msg.no_dollars_fp ?? msg.msg.no_dollars ?? msg.msg.no ?? [];
      for (const entry of yesArr) {
        const parsed = parsePriceSize(entry);
        if (parsed) state.bids.set(parsed[0], parsed[1]);
      }
      for (const entry of noArr) {
        const parsed = parsePriceSize(entry);
        // NO bid at $X implies YES ask at $(1 - X)
        if (parsed) state.asks.set(1 - parsed[0], parsed[1]);
      }
    } else if (msg.type === 'orderbook_delta') {
      const rawPrice = msg.msg.price ?? msg.msg.price_dollars;
      const rawDelta = msg.msg.delta ?? msg.msg.delta_fp;
      const side = msg.msg.side; // 'yes' or 'no'
      const price = typeof rawPrice === 'string' ? parseFloat(rawPrice) : (rawPrice > 1 ? rawPrice / 100 : rawPrice);
      const delta = typeof rawDelta === 'string' ? parseFloat(rawDelta) : rawDelta;
      if (!isFinite(price) || !isFinite(delta)) return;
      if (side === 'yes') {
        const current = state.bids.get(price) ?? 0;
        const next = current + delta;
        if (next <= 0) state.bids.delete(price);
        else state.bids.set(price, next);
      } else {
        const askPrice = 1 - price;
        const current = state.asks.get(askPrice) ?? 0;
        const next = current + delta;
        if (next <= 0) state.asks.delete(askPrice);
        else state.asks.set(askPrice, next);
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
    // Register callback regardless of WS state (will be replayed on next open)
    const list = this.subscribers.get(ticker) ?? [];
    list.push(cb);
    this.subscribers.set(ticker, list);

    // Try to send subscribe immediately if WS is ready
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const id = this.msgId++;
      this.subIdToTicker.set(id, ticker);
      try {
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
      } catch (err: any) {
        log.debug({ err: err.message, ticker }, 'WS send failed - will retry on reconnect');
      }
    }
    // If WS not ready, subscription will be sent automatically when WS opens (see openWebSocket)
    return () => {
      const arr = this.subscribers.get(ticker) ?? [];
      this.subscribers.set(ticker, arr.filter((c) => c !== cb));
    };
  }

  /**
   * Authenticated orderbook fetch.
   *
   * Kalshi response shape:
   *   orderbook_fp: {
   *     yes_dollars: [["0.45", "123.45"], ...]    YES BIDS sorted asc by price
   *     no_dollars:  [["0.55", "50.00"], ...]     NO BIDS sorted asc by price
   *   }
   * Prices are STRINGS in dollars (0.01-0.99). Quantities are dollar amounts
   * of liquidity at that level.
   *
   * Best YES ask = 1 - max(NO_BID) since selling NO at $X = buying YES at $(1-X)
   * Best NO ask  = 1 - max(YES_BID)
   *
   * Returns prices in CENTS (1-99) for consistency with the rest of the codebase.
   */
  async getMarketOrderbook(ticker: string): Promise<{ yesAsk: number | null; noAsk: number | null; yesAskQty: number; noAskQty: number } | null> {
    if (!this.hasCredentials) return null;
    try {
      const ts = Date.now();
      const headers = this.sign('GET', `/markets/${ticker}/orderbook`, ts);
      const { data } = await this.http.get(`/markets/${ticker}/orderbook`, { headers });
      const ob = data?.orderbook_fp ?? data?.orderbook;
      if (!ob) return null;

      const yesBids = (ob.yes_dollars ?? ob.yes ?? []) as [string, string][];
      const noBids = (ob.no_dollars ?? ob.no ?? []) as [string, string][];
      const parseEntries = (arr: [string, string][]) =>
        arr.map(([p, q]) => [parseFloat(p), parseFloat(q)] as [number, number]).filter(([p]) => !isNaN(p));
      const yesParsed = parseEntries(yesBids);
      const noParsed = parseEntries(noBids);
      const maxYesBid = yesParsed.length > 0 ? Math.max(...yesParsed.map((b) => b[0])) : null;
      const maxNoBid = noParsed.length > 0 ? Math.max(...noParsed.map((b) => b[0])) : null;
      // Convert dollars to cents
      const yesAsk = maxNoBid != null ? Math.round((1 - maxNoBid) * 100) : null;
      const noAsk = maxYesBid != null ? Math.round((1 - maxYesBid) * 100) : null;
      const yesAskQty = maxNoBid != null ? (noParsed.find((b) => b[0] === maxNoBid)?.[1] ?? 0) : 0;
      const noAskQty = maxYesBid != null ? (yesParsed.find((b) => b[0] === maxYesBid)?.[1] ?? 0) : 0;
      return { yesAsk, noAsk, yesAskQty, noAskQty };
    } catch (err: any) {
      if (err.response?.status && err.response.status !== 404) {
        log.debug({ ticker, status: err.response.status, body: JSON.stringify(err.response.data).slice(0, 150) }, 'Orderbook fetch error');
      }
      return null;
    }
  }

  /**
   * Get a market's settlement result. Returns 'yes' if YES side won, 'no' if NO won,
   * null if not yet settled or lookup failed.
   *
   * IMPORTANT: We MUST use this instead of comparing our local price feed against
   * the strike. Kalshi crypto markets settle on the CME CF Bitcoin Reference Rate
   * (BRR), which differs from Coinbase/OKX spot by $5-50 routinely. Local grading
   * was producing false losses that Kalshi recorded as wins — dashboard balance
   * drifted ~$50 below true Kalshi balance.
   */
  async getMarketResult(ticker: string): Promise<'yes' | 'no' | null> {
    if (!ticker) return null;
    try {
      const ts = Date.now();
      const headers = this.hasCredentials ? this.sign('GET', `/trade-api/v2/markets/${ticker}`, ts) : {};
      const { data } = await this.http.get(`/markets/${ticker}`, { headers });
      const m = data?.market;
      if (!m) return null;
      const result = (m.result || '').toLowerCase();
      if (result === 'yes' || result === 'no') return result;
      return null;
    } catch (err: any) {
      if (err.response?.status && err.response.status !== 404) {
        log.debug({ ticker, status: err.response.status }, 'getMarketResult error');
      }
      return null;
    }
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
        eventTicker: m.event_ticker,
        fractional: m.fractional_trading_enabled === true,
        liquidityUsd: m.liquidity_dollars ? parseFloat(m.liquidity_dollars) : (m.liquidity != null ? m.liquidity / 100 : undefined),
      }));
    } catch (err: any) {
      log.error({ err: err.message }, 'Kalshi listActiveMarkets error');
      return [];
    }
  }

  async placeOrder(req: PlaceOrderRequest): Promise<PlaceOrderResult> {
    if (isPaperMode()) {
      // PAPER MODE: always fake-fill at the requested price.
      // We don't have a fully-populated bookState for crypto strategy markets
      // (it only fills via WS subscriptions; crypto strategy uses REST).
      // The strategy only places at executable prices anyway, so we trust it.
      log.info({ ticker: req.externalId, outcome: req.outcome, side: req.side, count: req.size, price: req.price }, 'Paper Kalshi order — fake-fill');
      return {
        ok: true,
        externalOrderId: `paper-kalshi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filled: req.size,
        avgPrice: req.price,
      };
    }

    // H-9: validate caller-supplied client_order_id prefix. Reject anything outside
    // `^[a-z][a-z0-9-]{1,15}$` to keep the LIP reconciler's `startsWith('lip-')` check
    // (and similar prefix-keyed scans) honest — a typo like `'lip2'` would silently
    // un-tag the order.
    if (req.clientOrderIdPrefix !== undefined && !/^[a-z][a-z0-9-]{1,15}$/.test(req.clientOrderIdPrefix)) {
      throw new Error(`Kalshi placeOrder: invalid clientOrderIdPrefix '${req.clientOrderIdPrefix}' — must match ^[a-z][a-z0-9-]{1,15}$`);
    }

    // Kalshi expects integer cents. For NO orders we still pass yes_price (the implied YES price).
    const priceCents = Math.max(1, Math.min(99, Math.round(req.price * 100)));
    const yesPriceCents = req.outcome === 'YES' ? priceCents : 100 - priceCents;
    const payload: any = {
      ticker: req.externalId,
      action: req.side.toLowerCase(),
      side: req.outcome.toLowerCase(),
      count: Math.round(req.size),
      type: req.orderType.toLowerCase(),
      yes_price: yesPriceCents,
      // v2 M-8: use crypto.randomUUID for the random suffix. Math.random has tiny but
      // non-zero collision probability; Kalshi rejects duplicates as errors, which
      // surface as ambiguous-failure (not silent merge), but UUIDv4 is essentially free.
      client_order_id: `${req.clientOrderIdPrefix ?? 'bot'}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      // omit expiration_ts entirely — GTC by default. Including 0 has been rejected by Kalshi.
    };
    // 2026-05-23: POST-ONLY by default for entries (configurable via flag).
    // GWU research: makers earn +2.6% on contracts >$0.50, takers lose -31% on average.
    // Reasoning: setting post_only=true means Kalshi rejects the order if it would
    // cross the spread and become a taker. That's good — we WANT to be a maker.
    // If the order rejects (would cross), we just skip the trade. Better to miss
    // a fill than to pay taker fees.
    // Only entries (BUYs) are post-only; exits (SELLs, TP/SL) take whatever fills.
    if (req.side === 'BUY' && req.orderType === 'LIMIT' && req.postOnly !== false) {
      payload.post_only = true;
    }
    // CRITICAL: NO RETRIES on order placement. EXPIRED_TIMESTAMP is misleading
    // — Kalshi often accepts the order then sends EXPIRED on a duplicate retry,
    // causing double-exposure. Single-shot only. Caller decides whether to re-fire.
    try {
      // H-14: dropped synchronous clock-offset probe (50-3000ms latency on every order
      // POST, failure was swallowed anyway). Passive updates from response Date headers
      // on prior calls are sufficient; if they get stale, the next POST will refresh on
      // success or surface the issue on failure.

      const ts = this.syncedNow();
      const headers = this.sign('POST', '/trade-api/v2/portfolio/orders', ts);
      // Timeout was 5s but Kalshi's order endpoint has periodic 5-10s slow moments.
      // Bumped to 12s. Per the comment above, NO retries on order placement
      // (Kalshi quirk: retried orders can double-fill). A longer first-try timeout
      // is the safe way to absorb transient slowness.
      const resp = await this.orderHttp.post('/portfolio/orders', payload, { headers, timeout: 12000 });
      this.updateClockOffset(resp.headers?.date as string);
      const data = resp.data;
      const filled = data.order?.taker_fill_count ?? 0;
      log.info({ ticker: req.externalId, side: payload.side, count: payload.count, filled, orderId: data.order?.order_id }, 'Kalshi order placed');
      return {
        ok: true,
        externalOrderId: data.order?.order_id,
        filled,
        avgPrice: req.price,
      };
    } catch (err: any) {
      const respBody = err.response?.data;
      const code = respBody?.error?.code;
      const status = err.response?.status;
      log.error({
        err: err.message,
        status,
        body: respBody,
        code,
        sentTicker: req.externalId,
        sentSide: req.outcome.toLowerCase(),
        sentPrice: req.price,
        clockOffsetMs: this.serverClockOffsetMs,
        payloadSent: payload,
      }, 'Kalshi order error');

      // C-7 fix (v1 CRIT-4): on ambiguous failure (timeout, 5xx, network error)
      // the POST may have landed despite our seeing an error. Look up by
      // client_order_id to reconcile. Only do this for ambiguous cases —
      // explicit 4xx errors mean Kalshi rejected the order, no order exists.
      const isAmbiguous =
        !status ||  // network error / timeout (no HTTP response)
        status >= 500 ||  // server-side error
        err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
      if (isAmbiguous) {
        try {
          const lookupTs = this.syncedNow();
          const lookupHeaders = this.sign('GET', '/trade-api/v2/portfolio/orders', lookupTs);
          const lookupResp = await this.orderHttp.get('/portfolio/orders', {
            headers: lookupHeaders,
            params: { client_order_id: payload.client_order_id, limit: 5 },
            timeout: 5000,
          });
          const orders = lookupResp.data?.orders ?? [];
          if (orders.length > 0) {
            const found = orders[0];
            const filled = found?.taker_fill_count_fp ?? found?.taker_fill_count ?? 0;
            log.warn({
              orderId: found.order_id,
              client_order_id: payload.client_order_id,
              filled,
              sentTicker: req.externalId,
            }, 'Kalshi order RECONCILED — ambiguous error but order landed');
            return {
              ok: true,
              externalOrderId: found.order_id,
              filled: Number(filled),
              avgPrice: req.price,
            };
          }
        } catch (lookupErr: any) {
          log.warn({ err: lookupErr.message, client_order_id: payload.client_order_id },
            'Kalshi order ambiguous-error reconciliation lookup FAILED');
        }
      }

      return { ok: false, error: code || err.message };
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

  /**
   * Get all current positions on Kalshi. Returns array of {ticker, position, market_exposure, ...}.
   * Used as pre-flight check to avoid stacking exposure on an event we already have skin in.
   */
  async getPositions(): Promise<any[]> {
    if (isPaperMode()) return [];
    // 2026-05-22 v4: previously this swallowed errors and returned []. That caused
    // getTotalEquity() to silently misreport equity as cash-only whenever the
    // positions endpoint had a transient failure — firing false kill switches.
    // Now we throw on actual errors so callers can decide how to handle.
    const ts = Date.now();
    const headers = this.sign('GET', '/trade-api/v2/portfolio/positions', ts);
    const { data } = await this.http.get('/portfolio/positions', { headers, params: { limit: 200 } });
    const positions = data?.market_positions ?? [];
    return positions;
  }

  /** Soft variant: returns [] on error. Use when failures are non-critical. */
  async tryGetPositions(): Promise<any[]> {
    try { return await this.getPositions(); }
    catch (err: any) { log.warn({ err: err.message }, 'tryGetPositions: error swallowed'); return []; }
  }

  /** Look up a specific order by ID. Returns null if not found. */
  async getOrder(orderId: string): Promise<any | null> {
    if (isPaperMode()) return null;
    try {
      const ts = Date.now();
      const headers = this.sign('GET', `/trade-api/v2/portfolio/orders/${orderId}`, ts);
      const { data } = await this.http.get(`/portfolio/orders/${orderId}`, { headers });
      return data?.order ?? null;
    } catch (err) {
      log.warn({ err, orderId }, 'Kalshi getOrder error');
      return null;
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
    // Even in paper mode, return REAL balance if we have credentials - that
    // way risk engine bankroll matches actual capital available for live mode.
    if (!this.hasCredentials) return isPaperMode() ? 5000 : 0;
    try {
      const ts = this.syncedNow();
      // H-12 fix: sign the FULL path like every other call site. The auto-prefix in
      // sign() makes this work today, but the inconsistency is a latent break if the
      // auto-prefix logic is tightened.
      const headers = this.sign('GET', '/trade-api/v2/portfolio/balance', ts);
      const resp = await this.http.get('/portfolio/balance', { headers });
      // Update server clock offset from Date header (used for future order POSTs)
      this.updateClockOffset(resp.headers?.date as string);
      const data = resp.data;
      // Schema migrated: prefer the new `balance_dollars` string field, fall back to legacy cents `balance`
      const dollars = data.balance_dollars != null && data.balance_dollars !== ''
        ? parseFloat(data.balance_dollars)
        : (data.balance ?? 0) / 100;
      return dollars;
    } catch (err: any) {
      log.error({ err: err.message, status: err.response?.status }, 'Kalshi getBalance error');
      return 0;
    }
  }

  /**
   * Total account equity = cash balance + mark-to-market value of all open positions.
   *
   * CRITICAL: Use this instead of getBalance() for drawdown/kill-switch checks.
   * When the bot buys shares, cash drops but those shares have value (mark-to-market
   * = position_count * last_trade_price_cents / 100). Drawdown circuit breakers that
   * watch cash-only will false-positive every time a LIP fill or limit order locks in shares.
   *
   * Position valuation: Kalshi's /portfolio/positions returns `market_exposure` which is
   * the cents-value of the position at last fill price. For a worst-case mark, we use
   * the position count * the most-recently-known bid (conservative). If neither is
   * available we fall back to `total_traded` (cost basis), which is fine because that's
   * what the cash already accounts for.
   *
   * Added 2026-05-22: kill switch was tripping at 16% "drawdown" because cash dropped
   * $143 from LIP fills, but those shares are worth $48 — net true equity drop was ~$0.
   */
  async getTotalEquity(): Promise<number> {
    if (!this.hasCredentials) return isPaperMode() ? 5000 : 0;
    const cash = await this.getBalance();
    if (isPaperMode()) return cash;  // paper mode: positions are virtual, just use cash
    // 2026-05-22 v4: cache the last-known total equity. If positions endpoint fails
    // (transient API hiccup) we return the cached value rather than collapsing to
    // cash-only — cash-only on a heavily-invested account is a fake $900 drawdown
    // that trips the kill switch every time. The cache lives on the connector instance.
    try {
      const positions = await this.getPositions();
      let exposureUsd = 0;
      let countedPositions = 0;
      for (const p of positions) {
        // Kalshi current schema returns `market_exposure_dollars` as a STRING
        // (e.g. "286.700000"). Older docs reference numeric `market_exposure` (cents)
        // — keep that as a fallback for safety.
        let dollars = 0;
        if (typeof p.market_exposure_dollars === 'string' && p.market_exposure_dollars !== '') {
          dollars = parseFloat(p.market_exposure_dollars);
        } else if (typeof p.market_exposure === 'number') {
          dollars = p.market_exposure / 100;
        } else if (typeof p.total_traded_dollars === 'string' && p.total_traded_dollars !== '') {
          // Fall back to cost basis if no mark-to-market is available
          dollars = parseFloat(p.total_traded_dollars);
        } else if (typeof p.total_traded === 'number') {
          dollars = p.total_traded / 100;
        }
        if (Number.isFinite(dollars) && dollars > 0) {
          exposureUsd += dollars;
          countedPositions++;
        }
      }
      const total = cash + exposureUsd;
      log.info({ cash, exposureUsd, totalEquity: total, positions: positions.length, countedPositions }, 'getTotalEquity');
      this.lastKnownEquity = total;
      this.lastKnownEquityAt = Date.now();
      return total;
    } catch (err: any) {
      // Positions endpoint failed. If we have a recent cached equity (< 30 min old),
      // return it. Otherwise fall back to cash + 0. This prevents false drawdown alerts
      // from a single bad sync.
      const cacheAge = Date.now() - this.lastKnownEquityAt;
      if (this.lastKnownEquity > 0 && cacheAge < 30 * 60 * 1000) {
        log.warn({ err: err.message, cacheAgeSec: (cacheAge / 1000).toFixed(0), cached: this.lastKnownEquity }, 'getTotalEquity: positions fetch failed, returning cached equity');
        return this.lastKnownEquity;
      }
      log.warn({ err: err.message }, 'getTotalEquity: positions fetch failed AND no recent cache, using cash only');
      return cash;
    }
  }

  private lastKnownEquity = 0;
  private lastKnownEquityAt = 0;

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}
